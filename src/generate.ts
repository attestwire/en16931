import {
  CREDIT_NOTE_TYPE_CODES,
  DEFAULT_INVOICE_TYPE_CODE,
  documentKindOf,
  resolveTypeCode,
} from "./document-type.js";
import {
  computeTotals,
  effectiveAllowanceChargeRate,
  effectiveRate,
  formatAmount,
  formatNumber,
  formatPrice,
} from "./totals.js";
import { document, el, group, groupAlways, type XmlNode } from "./xml.js";
import type {
  DocumentAllowanceCharge,
  InvoiceInput,
  InvoiceTotals,
  InvoicingPeriod,
  LineAllowanceCharge,
  Party,
  PostalAddress,
  Profile,
  SupportingDocument,
} from "./types.js";

/**
 * JSON → XRechnung UBL 2.1 Invoice or CreditNote.
 *
 * UBL uses an `xsd:sequence` content model, so the order of children is part of
 * schema validity. Every builder below emits children in the order given by
 * `UBL-Invoice-2.1.xsd`, `UBL-CreditNote-2.1.xsd` and
 * `UBL-CommonAggregateComponents-2.1.xsd`; the sequence is quoted in a comment
 * above each builder. Do not reorder them to make a diff read better — a
 * document whose children are alphabetical, or merely "logical", is rejected by
 * the schema before any business rule runs.
 *
 * The two root sequences are *not* the same sequence with one element renamed,
 * which is the trap in adding credit-note support. Diffed element by element
 * from the two `maindoc` schemas, `CreditNote` differs from `Invoice` in five
 * ways that matter to this generator:
 *
 *   1. there is no `cbc:DueDate` at all — BT-9 moves into
 *      `cac:PaymentMeans/cbc:PaymentDueDate`, which `UBL-CR-412` forbids on an
 *      invoice and permits on a credit note;
 *   2. `cbc:TaxPointDate` comes *before* the type code rather than after the
 *      note;
 *   3. the document references run OrderReference, BillingReference, Despatch,
 *      Receipt, **Contract, Additional**, Statement, Originator — where the
 *      invoice runs Despatch, Receipt, Statement, Originator, **Contract,
 *      Additional**;
 *   4. there is no `cac:ProjectReference`, so BT-11 has nowhere to go;
 *   5. lines are `cac:CreditNoteLine` carrying `cbc:CreditedQuantity`.
 */

const NS = {
  inv: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  cn: "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
} as const;

/** BT-24 Specification identifier, per profile. */
export const CUSTOMIZATION_IDS: Record<Profile, string> = {
  "xrechnung-ubl":
    "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0",
  "xrechnung-cii":
    "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0",
  "peppol-bis-3": "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0",
  en16931: "urn:cen.eu:en16931:2017",
  "facturx-en16931": "urn:cen.eu:en16931:2017",
};

/** BT-23 Business process type. */
export const PROFILE_IDS: Record<Profile, string> = {
  "xrechnung-ubl": "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
  "xrechnung-cii": "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
  "peppol-bis-3": "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
  en16931: "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
  "facturx-en16931": "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
};

/**
 * Re-exported from `document-type.ts`, which is where the document-type
 * decision now lives — both parsers and three rule families need it, and none
 * of them should have to import the generator to get it.
 */
export {
  CREDIT_NOTE_TYPE_CODES,
  DEFAULT_INVOICE_TYPE_CODE,
  documentKindOf,
  isCreditNote,
  type DocumentKind,
} from "./document-type.js";

/**
 * UNTDID 1153 code marking an `AdditionalDocumentReference` as the invoiced
 * object identifier (BT-18) rather than a supporting document (BG-24). The two
 * share one UBL element and are told apart only by this code, which is why
 * BR-CL-07 constrains the scheme on exactly `[cbc:DocumentTypeCode = '130']`.
 */
export const INVOICED_OBJECT_DOCUMENT_TYPE_CODE = "130";

/**
 * Profiles this package can actually emit.
 *
 * All three are UBL-syntax profiles that differ only in the CIUS applied on top
 * of the same document, so one generator serves them all. `xrechnung-cii` and
 * `facturx-en16931` are *not* here: those are CII (and, for Factur-X,
 * CII-embedded-in-PDF) documents. Emitting UBL under those names would produce
 * a file that passes no validator anywhere, so generation refuses instead.
 */
export const UBL_GENERATABLE_PROFILES = [
  "en16931",
  "xrechnung-ubl",
  "peppol-bis-3",
] as const satisfies readonly Profile[];

export type UblGeneratableProfile = (typeof UBL_GENERATABLE_PROFILES)[number];

/**
 * Base class for a document this build refuses to emit.
 *
 * Refusal is deliberate: the alternative is a syntactically plausible file that
 * every receiving portal rejects, hours later, with an error that points at the
 * wrong thing. `code` mirrors the hosted API's error codes so the two layers can
 * be handled uniformly.
 */
export class GenerationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Thrown when `profile` is not a syntax this build can generate. */
export class UnsupportedProfileError extends GenerationError {
  readonly profile: string;
  readonly supportedProfiles: readonly Profile[] = UBL_GENERATABLE_PROFILES;

  constructor(profile: string) {
    super(
      "unsupported_profile",
      `generateXRechnungUBL cannot generate the "${profile}" profile. ` +
        `It emits UBL 2.1 syntax only, which covers: ${UBL_GENERATABLE_PROFILES.join(", ")}. ` +
        `The profiles "xrechnung-cii" and "facturx-en16931" are CII documents, a ` +
        `different syntax with a different element vocabulary: call generateCii for ` +
        `those. Emitting UBL under a CII profile name would produce a document that ` +
        `passes no validator, so this call refuses rather than returning ` +
        `silently-wrong XML. Note that generateCii emits the CII **XML** — the ` +
        `PDF/A-3 container that makes Factur-X a Factur-X file is not implemented. ` +
        `Set profile to one of ${UBL_GENERATABLE_PROFILES.join(", ")} — "xrechnung-ubl" is ` +
        `the German public-sector default — or validate only with validateInput().`,
    );
    this.profile = profile;
  }
}

/**
 * Thrown when BT-3 asks for a document type that is not a UBL `Invoice`.
 *
 * ⚠ **Nothing throws this any more.** It existed for one reason — a credit-note
 * BT-3 — and 0.5.0 generates credit notes, so the refusal it announced is gone.
 * The class is kept, exported, and left in the union of things `GenerationError`
 * covers because removing an exported symbol breaks every `instanceof` and every
 * `import` a caller already wrote, and because a document type that cannot be
 * expressed in UBL 2.1 may well turn up again (a debit note, `UBL-DebitNote-2.1`,
 * is the obvious candidate and has no EN 16931 binding at all). A caller
 * branching on it will simply never take that branch.
 */
export class UnsupportedDocumentTypeError extends GenerationError {
  readonly invoiceTypeCode: string;

  constructor(invoiceTypeCode: string) {
    super(
      "unsupported_document_type",
      `invoiceTypeCode "${invoiceTypeCode}" asks for a document type this build cannot ` +
        `express in UBL 2.1. Note that credit notes are no longer in that category: since ` +
        `0.5.0 a credit-note BT-3 (381 and the rest of the UNTDID 1001 credit-note list) ` +
        `emits a ubl:CreditNote document, and nothing in this package raises this error.`,
    );
    this.invoiceTypeCode = invoiceTypeCode;
  }
}

export interface GenerateOptions {
  /** Indentation string. Pass "" for a compact single-line-per-element document. */
  indent?: string;
  /** Override the BT-24 specification identifier (e.g. to pin XRechnung 2.3). */
  customizationId?: string;
  /** Override the BT-23 business process identifier. */
  profileId?: string;
}

/**
 * cac:PostalAddress / cac:Address — schema order:
 *   StreetName, AdditionalStreetName, CityName, PostalZone, CountrySubentity,
 *   cac:AddressLine, cac:Country
 */
function addressNode(name: string, a: PostalAddress): XmlNode {
  return groupAlways(name, [
    el("cbc:StreetName", a.line1),
    el("cbc:AdditionalStreetName", a.line2),
    el("cbc:CityName", a.city),
    el("cbc:PostalZone", a.postalCode),
    el("cbc:CountrySubentity", a.countrySubdivision),
    a.line3 ? group("cac:AddressLine", [el("cbc:Line", a.line3)]) : null,
    group("cac:Country", [
      el("cbc:IdentificationCode", a.countryCode?.toUpperCase()),
    ]),
  ]);
}

/**
 * cac:Party — schema order: EndpointID, PartyIdentification, PartyName,
 * PostalAddress, PartyTaxScheme, PartyLegalEntity, Contact.
 *
 * Note the two distinct PartyTaxScheme entries: BT-31 (VAT identifier) carries
 * TaxScheme/ID "VAT", while BT-32 (national tax registration) carries the
 * scheme "FC". Collapsing them into one is a common source of BR-DE-16 noise.
 *
 * `sepaCreditorIdentifier` is BT-90, which EN 16931's UBL binding puts on the
 * *seller* party rather than in BG-19 — a `PartyIdentification` with
 * `schemeID="SEPA"`, which is exactly where BR-DE-30 looks for it.
 */
function partyNode(
  party: Party,
  options: { sepaCreditorIdentifier?: string } = {},
): XmlNode {
  const endpoint = party.electronicAddress
    ? el("cbc:EndpointID", party.electronicAddress.value, {
        schemeID: party.electronicAddress.schemeId,
      })
    : null;

  const contact = party.contact
    ? group("cac:Contact", [
        el("cbc:Name", party.contact.name),
        el("cbc:Telephone", party.contact.phone),
        el("cbc:ElectronicMail", party.contact.email),
      ])
    : null;

  return groupAlways("cac:Party", [
    endpoint,
    party.identifier
      ? group("cac:PartyIdentification", [
          el("cbc:ID", party.identifier.value, {
            schemeID: party.identifier.schemeId,
          }),
        ])
      : null,
    options.sepaCreditorIdentifier
      ? group("cac:PartyIdentification", [
          el("cbc:ID", options.sepaCreditorIdentifier, { schemeID: "SEPA" }),
        ])
      : null,
    group("cac:PartyName", [el("cbc:Name", party.tradingName ?? party.name)]),
    addressNode("cac:PostalAddress", party.address),
    party.vatId
      ? group("cac:PartyTaxScheme", [
          el("cbc:CompanyID", party.vatId),
          group("cac:TaxScheme", [el("cbc:ID", "VAT")]),
        ])
      : null,
    party.taxRegistrationId
      ? group("cac:PartyTaxScheme", [
          el("cbc:CompanyID", party.taxRegistrationId),
          group("cac:TaxScheme", [el("cbc:ID", "FC")]),
        ])
      : null,
    groupAlways("cac:PartyLegalEntity", [
      el("cbc:RegistrationName", party.legalName ?? party.name),
      el("cbc:CompanyID", party.legalRegistrationId, {
        schemeID: party.legalRegistrationSchemeId,
      }),
      el("cbc:CompanyLegalForm", party.additionalLegalInformation),
    ]),
    contact,
  ]);
}

/** cac:Period — schema order: StartDate, EndDate, DescriptionCode. */
function periodNode(name: string, period: InvoicingPeriod): XmlNode | null {
  return group(name, [
    el("cbc:StartDate", period.startDate),
    el("cbc:EndDate", period.endDate),
    el("cbc:DescriptionCode", period.descriptionCode),
  ]);
}

/**
 * cac:AllowanceCharge at document level — schema order:
 *   ChargeIndicator, AllowanceChargeReasonCode, AllowanceChargeReason,
 *   MultiplierFactorNumeric, Amount, BaseAmount, cac:TaxCategory
 *
 * `ChargeIndicator` is what makes the element an allowance or a charge, and it
 * must be the literal `true`/`false` — the schematron matches on
 * `cbc:ChargeIndicator = true()`, so "1" and "Y" both silently fall out of
 * every BG-21 rule.
 */
function documentAllowanceChargeNode(
  entry: DocumentAllowanceCharge,
  isCharge: boolean,
  currency: string,
): XmlNode {
  // Same normalisation the breakdown was computed with (finding 8, 11).
  const rate = effectiveAllowanceChargeRate(entry);
  return groupAlways("cac:AllowanceCharge", [
    el("cbc:ChargeIndicator", isCharge ? "true" : "false"),
    el("cbc:AllowanceChargeReasonCode", entry.reasonCode),
    el("cbc:AllowanceChargeReason", entry.reason),
    entry.percentage === undefined
      ? null
      : el("cbc:MultiplierFactorNumeric", formatNumber(entry.percentage)),
    el("cbc:Amount", formatAmount(entry.amount), { currencyID: currency }),
    entry.baseAmount === undefined
      ? null
      : el("cbc:BaseAmount", formatAmount(entry.baseAmount), {
          currencyID: currency,
        }),
    groupAlways("cac:TaxCategory", [
      el("cbc:ID", entry.vatCategory),
      rate === undefined ? null : el("cbc:Percent", formatNumber(rate)),
      group("cac:TaxScheme", [el("cbc:ID", "VAT")]),
    ]),
  ]);
}

/**
 * cac:AllowanceCharge inside an invoice line — same sequence, but with no
 * cac:TaxCategory: BG-27 and BG-28 inherit the VAT treatment of the line, and
 * an explicit category here would create a breakdown group the standard does
 * not recognise.
 */
function lineAllowanceChargeNode(
  entry: LineAllowanceCharge,
  isCharge: boolean,
  currency: string,
): XmlNode {
  return groupAlways("cac:AllowanceCharge", [
    el("cbc:ChargeIndicator", isCharge ? "true" : "false"),
    el("cbc:AllowanceChargeReasonCode", entry.reasonCode),
    el("cbc:AllowanceChargeReason", entry.reason),
    entry.percentage === undefined
      ? null
      : el("cbc:MultiplierFactorNumeric", formatNumber(entry.percentage)),
    el("cbc:Amount", formatAmount(entry.amount), { currencyID: currency }),
    entry.baseAmount === undefined
      ? null
      : el("cbc:BaseAmount", formatAmount(entry.baseAmount), {
          currencyID: currency,
        }),
  ]);
}

/**
 * cac:AdditionalDocumentReference — schema order (DocumentReferenceType):
 *   ID, IssueDate, DocumentTypeCode, DocumentDescription, cac:Attachment
 * cac:Attachment: EmbeddedDocumentBinaryObject, cac:ExternalReference
 * cac:ExternalReference: URI
 */
function supportingDocumentNode(doc: SupportingDocument): XmlNode {
  const attachment = doc.attachment
    ? el("cbc:EmbeddedDocumentBinaryObject", doc.attachment.content, {
        mimeCode: doc.attachment.mimeCode,
        filename: doc.attachment.filename,
      })
    : null;
  const external = doc.externalUri
    ? group("cac:ExternalReference", [el("cbc:URI", doc.externalUri)])
    : null;

  return groupAlways("cac:AdditionalDocumentReference", [
    el("cbc:ID", doc.reference),
    el("cbc:DocumentDescription", doc.description),
    attachment || external
      ? groupAlways("cac:Attachment", [attachment, external])
      : null,
  ]);
}

/** cac:TaxTotal with one cac:TaxSubtotal per BG-23 breakdown group. */
function taxTotalNode(totals: InvoiceTotals, currency: string): XmlNode {
  const subtotals = totals.subtotals.map((sub) =>
    groupAlways("cac:TaxSubtotal", [
      el("cbc:TaxableAmount", formatAmount(sub.taxableAmount), {
        currencyID: currency,
      }),
      el("cbc:TaxAmount", formatAmount(sub.taxAmount), {
        currencyID: currency,
      }),
      groupAlways("cac:TaxCategory", [
        el("cbc:ID", sub.category),
        // BR-O-05: category O carries no rate at all.
        sub.rate === undefined
          ? null
          : el("cbc:Percent", formatNumber(sub.rate)),
        // BR-S-10 / BR-Z-10 forbid a reason here; totals.ts already suppresses it.
        el("cbc:TaxExemptionReasonCode", sub.exemptionReasonCode),
        el("cbc:TaxExemptionReason", sub.exemptionReason),
        group("cac:TaxScheme", [el("cbc:ID", "VAT")]),
      ]),
    ]),
  );

  return groupAlways("cac:TaxTotal", [
    el("cbc:TaxAmount", formatAmount(totals.taxAmount), {
      currencyID: currency,
    }),
    ...subtotals,
  ]);
}

/**
 * Generate an XRechnung 3.0 UBL 2.1 `Invoice` — or `CreditNote`.
 *
 * Which one comes out is decided by BT-3 and by nothing else. Set
 * `invoiceTypeCode` to `"381"` and you get a `ubl:CreditNote`: different root
 * element, different namespace, `cbc:CreditNoteTypeCode`, `cac:CreditNoteLine`
 * and `cbc:CreditedQuantity`, with every other business term in the same place.
 * There is no `generateCreditNote` function and no second entry point, because
 * there is no second *input*: a credit note is the same semantic model with one
 * field changed, and a caller who has an invoice-shaped payload should be one
 * field away from a credit note rather than one API away.
 *
 * ```ts
 * const creditNote = generateXRechnungUBL({ ...invoice, invoiceTypeCode: "381" });
 * ```
 *
 * Throws `UnsupportedProfileError` for a non-UBL profile rather than emitting a
 * document that would be rejected downstream. It extends `GenerationError` and
 * carries a stable `code`.
 *
 * Totals are always computed from the lines and the document allowances and
 * charges — the function never echoes caller-supplied totals into the XML, so a
 * BR-CO arithmetic rejection cannot originate here. Use `validateInput` first if
 * you want to know whether your own accounting figures agree with ours
 * (BR-CO-10 through BR-CO-16).
 */
export function generateXRechnungUBL(
  inv: InvoiceInput,
  options: GenerateOptions = {},
): string {
  // Refuse before doing any work: a wrong syntax is not something the rest of
  // this function can compensate for.
  if (!(UBL_GENERATABLE_PROFILES as readonly string[]).includes(inv?.profile)) {
    throw new UnsupportedProfileError(String(inv?.profile));
  }
  const typeCode = resolveTypeCode(inv.invoiceTypeCode);
  const creditNote = documentKindOf(inv.invoiceTypeCode) === "credit-note";

  const totals = computeTotals(inv);
  const currency = (inv.currency || "EUR").toUpperCase();
  const taxCurrency = inv.vatAccountingCurrency?.trim().toUpperCase();
  const indent = options.indent ?? "  ";

  const customizationId =
    options.customizationId ??
    CUSTOMIZATION_IDS[inv.profile] ??
    CUSTOMIZATION_IDS["xrechnung-ubl"];
  const profileId =
    options.profileId ?? PROFILE_IDS[inv.profile] ?? PROFILE_IDS["xrechnung-ubl"];

  // BT-21: UBL has no element for the note subject code, so EN 16931's binding
  // prefixes it onto the note itself as "#CODE#text".
  const note =
    inv.note !== undefined && inv.noteSubjectCode
      ? `#${inv.noteSubjectCode}#${inv.note}`
      : inv.note;

  // cac:InvoiceLine — schema order: ID, Note, InvoicedQuantity,
  // LineExtensionAmount, AccountingCost, cac:InvoicePeriod,
  // cac:OrderLineReference, cac:DocumentReference, cac:AllowanceCharge,
  // cac:Item, cac:Price.
  //
  // cac:CreditNoteLine is the same sequence with cbc:CreditedQuantity in place
  // of cbc:InvoicedQuantity. (It also swaps cac:TaxTotal and
  // cac:AllowanceCharge relative to the invoice line, which costs nothing here:
  // EN 16931 has no line-level VAT total, so this generator emits none.)
  const lineElement = creditNote ? "cac:CreditNoteLine" : "cac:InvoiceLine";
  const quantityElement = creditNote
    ? "cbc:CreditedQuantity"
    : "cbc:InvoicedQuantity";
  const lines = inv.lines.map((line, index) => {
    const net = totals.lineNetAmounts[index] ?? 0;
    // One source of truth for the rate. `effectiveRate` is what `computeTotals`
    // grouped and computed BT-117 from, and it normalises to the precision the
    // rate is written at — so BT-119 and BT-117 can no longer come from two
    // different numbers (finding 8).
    const rate = effectiveRate(line);
    const zeroRated = ["Z", "E", "AE", "K", "G"].includes(line.vatCategory);

    // BT-147/BT-148: a gross price with a discount is expressed as an
    // allowance hanging off cac:Price, never as a second price element.
    const priceAllowance =
      line.grossUnitPrice === undefined
        ? null
        : groupAlways("cac:AllowanceCharge", [
            el("cbc:ChargeIndicator", "false"),
            // BT-147 and BT-148 are prices too, and carry no decimal cap.
            el(
              "cbc:Amount",
              formatPrice(line.priceDiscount ?? line.grossUnitPrice - line.unitPrice),
              { currencyID: currency },
            ),
            el("cbc:BaseAmount", formatPrice(line.grossUnitPrice), {
              currencyID: currency,
            }),
          ]);

    return groupAlways(lineElement, [
      el("cbc:ID", line.id),
      el("cbc:Note", line.note),
      el(quantityElement, formatNumber(line.quantity, 4), {
        unitCode: line.unitCode,
      }),
      el("cbc:LineExtensionAmount", formatAmount(net), {
        currencyID: currency,
      }),
      el("cbc:AccountingCost", line.buyerAccountingReference),
      line.period ? periodNode("cac:InvoicePeriod", line.period) : null,
      line.orderLineReference
        ? group("cac:OrderLineReference", [
            el("cbc:LineID", line.orderLineReference),
          ])
        : null,
      line.objectIdentifier
        ? groupAlways("cac:DocumentReference", [
            el("cbc:ID", line.objectIdentifier.value, {
              schemeID: line.objectIdentifier.schemeId,
            }),
            el("cbc:DocumentTypeCode", INVOICED_OBJECT_DOCUMENT_TYPE_CODE),
          ])
        : null,
      ...(line.allowances ?? []).map((entry) =>
        lineAllowanceChargeNode(entry, false, currency),
      ),
      ...(line.charges ?? []).map((entry) =>
        lineAllowanceChargeNode(entry, true, currency),
      ),
      // cac:Item — schema order: Description, Name, BuyersItemIdentification,
      // SellersItemIdentification, StandardItemIdentification, OriginCountry,
      // CommodityClassification, ClassifiedTaxCategory, AdditionalItemProperty.
      groupAlways("cac:Item", [
        el("cbc:Description", line.longDescription),
        el("cbc:Name", line.description),
        line.buyerItemId
          ? group("cac:BuyersItemIdentification", [
              el("cbc:ID", line.buyerItemId),
            ])
          : null,
        line.sellerItemId
          ? group("cac:SellersItemIdentification", [
              el("cbc:ID", line.sellerItemId),
            ])
          : null,
        line.standardItemId
          ? group("cac:StandardItemIdentification", [
              el("cbc:ID", line.standardItemId.value, {
                schemeID: line.standardItemId.schemeId,
              }),
            ])
          : null,
        line.originCountryCode
          ? group("cac:OriginCountry", [
              el("cbc:IdentificationCode", line.originCountryCode.toUpperCase()),
            ])
          : null,
        ...(line.itemClassifications ?? []).map((classification) =>
          groupAlways("cac:CommodityClassification", [
            el("cbc:ItemClassificationCode", classification.code, {
              listID: classification.schemeId,
              listVersionID: classification.schemeVersion,
            }),
          ]),
        ),
        groupAlways("cac:ClassifiedTaxCategory", [
          el("cbc:ID", line.vatCategory),
          rate === undefined
            ? null
            : el("cbc:Percent", formatNumber(zeroRated ? 0 : rate)),
          group("cac:TaxScheme", [el("cbc:ID", "VAT")]),
        ]),
        ...(line.itemAttributes ?? []).map((attribute) =>
          groupAlways("cac:AdditionalItemProperty", [
            el("cbc:Name", attribute.name),
            el("cbc:Value", attribute.value),
          ]),
        ),
      ]),
      // cac:Price — schema order: PriceAmount, BaseQuantity, cac:AllowanceCharge.
      groupAlways("cac:Price", [
        // BT-146. `formatPrice`, never `formatAmount`: EN 16931 puts no
        // two-decimal cap on a unit price (finding 7).
        el("cbc:PriceAmount", formatPrice(line.unitPrice), {
          currencyID: currency,
        }),
        line.baseQuantity === undefined
          ? null
          : el("cbc:BaseQuantity", formatNumber(line.baseQuantity, 4), {
              unitCode: line.unitCode,
            }),
        priceAllowance,
      ]),
    ]);
  });

  // cac:PaymentMeans — schema order: PaymentMeansCode, PaymentDueDate,
  // InstructionID, InstructionNote, PaymentID, cac:CardAccount,
  // cac:PayerFinancialAccount, cac:PayeeFinancialAccount, cac:PaymentMandate.
  const paymentMeans = inv.payment
    ? groupAlways("cac:PaymentMeans", [
        el("cbc:PaymentMeansCode", inv.payment.meansCode, {
          name: inv.payment.meansName,
        }),
        // BT-9 on a credit note. UBL's CreditNote has no cbc:DueDate of its
        // own, and EN 16931's UBL binding puts the payment due date here
        // instead — which is why UBL-CR-412 ("A UBL invoice should not include
        // the PaymentMeans PaymentDueDate") carries the explicit `or
        // ../cn:CreditNote` exemption. Emitting it on an invoice would trip
        // that rule; omitting it on a credit note would drop BT-9 on the floor.
        //
        // A due date with no payment instructions has nowhere to go at all,
        // because cbc:PaymentMeansCode is mandatory in UBL's PaymentMeansType,
        // so there is no lawful cac:PaymentMeans to hang it off. That case is
        // reported to the caller as ATW-CREDIT-NOTE-DUE-DATE-UNBOUND rather
        // than silently dropped.
        creditNote ? el("cbc:PaymentDueDate", inv.dueDate) : null,
        el("cbc:PaymentID", inv.payment.remittanceInformation),
        inv.payment.card
          ? groupAlways("cac:CardAccount", [
              el("cbc:PrimaryAccountNumberID", inv.payment.card.primaryAccountNumber),
              // cbc:NetworkID is mandatory in UBL's CardAccountType and carries
              // no EN 16931 business term; "NA" is what the Peppol and KoSIT
              // example documents use.
              el("cbc:NetworkID", "NA"),
              el("cbc:HolderName", inv.payment.card.holderName),
            ])
          : null,
        // Blank-aware, not truthy: `iban: "   "` is truthy, so this used to
        // emit a `cac:PayeeFinancialAccount` (BG-17) carrying nothing, while
        // BR-DE-24-b and BR-DE-25-b — which ask whether BG-17 is *present*, and
        // test it with `blank()` — saw no account and stayed silent. The result
        // was a document we validated clean and KoSIT rejected: payment means
        // 48 or 59 with a stray-whitespace IBAN emitted the group those rules
        // forbid. The generator and the rules must agree on what "present"
        // means, and `blank()` is the definition everywhere else.
        inv.payment.iban?.trim()
          ? groupAlways("cac:PayeeFinancialAccount", [
              el("cbc:ID", inv.payment.iban),
              el("cbc:Name", inv.payment.accountName),
              inv.payment.bic
                ? group("cac:FinancialInstitutionBranch", [
                    el("cbc:ID", inv.payment.bic),
                  ])
                : null,
            ])
          : null,
        inv.payment.directDebit
          ? groupAlways("cac:PaymentMandate", [
              el("cbc:ID", inv.payment.directDebit.mandateReference),
              inv.payment.directDebit.debitedAccount
                ? group("cac:PayerFinancialAccount", [
                    el("cbc:ID", inv.payment.directDebit.debitedAccount),
                  ])
                : null,
            ])
          : null,
      ])
    : null;

  // BG-15 is all-or-nothing under XRechnung (BR-DE-10 / BR-DE-11), so the
  // address carries city and post code alongside the country when supplied.
  // cac:Delivery — schema order: ActualDeliveryDate, cac:DeliveryLocation,
  // cac:DeliveryParty.
  const deliverTo = inv.deliverTo;
  const delivery =
    inv.deliveryDate || deliverTo || inv.deliverToName
      ? groupAlways("cac:Delivery", [
          el("cbc:ActualDeliveryDate", inv.deliveryDate),
          deliverTo || inv.deliverToLocationId
            ? groupAlways("cac:DeliveryLocation", [
                inv.deliverToLocationId
                  ? el("cbc:ID", inv.deliverToLocationId.value, {
                      schemeID: inv.deliverToLocationId.schemeId,
                    })
                  : null,
                deliverTo
                  ? group("cac:Address", [
                      el("cbc:StreetName", deliverTo.line1),
                      el("cbc:AdditionalStreetName", deliverTo.line2),
                      el("cbc:CityName", deliverTo.city),
                      el("cbc:PostalZone", deliverTo.postalCode),
                      el("cbc:CountrySubentity", deliverTo.countrySubdivision),
                      group("cac:Country", [
                        el(
                          "cbc:IdentificationCode",
                          deliverTo.countryCode?.toUpperCase(),
                        ),
                      ]),
                    ])
                  : null,
              ])
            : null,
          inv.deliverToName
            ? group("cac:DeliveryParty", [
                group("cac:PartyName", [el("cbc:Name", inv.deliverToName)]),
              ])
            : null,
        ])
      : null;

  const monetaryTotal = groupAlways("cac:LegalMonetaryTotal", [
    el("cbc:LineExtensionAmount", formatAmount(totals.lineExtensionAmount), {
      currencyID: currency,
    }),
    el("cbc:TaxExclusiveAmount", formatAmount(totals.taxExclusiveAmount), {
      currencyID: currency,
    }),
    el("cbc:TaxInclusiveAmount", formatAmount(totals.taxInclusiveAmount), {
      currencyID: currency,
    }),
    // BT-107 / BT-108 are emitted only when there is something to disclose.
    // BR-CO-13's schematron branches on their presence, and a 0.00 total for a
    // document that has no allowances asserts a fact rather than omitting one.
    (inv.allowances ?? []).length > 0
      ? el("cbc:AllowanceTotalAmount", formatAmount(totals.allowanceTotalAmount), {
          currencyID: currency,
        })
      : null,
    (inv.charges ?? []).length > 0
      ? el("cbc:ChargeTotalAmount", formatAmount(totals.chargeTotalAmount), {
          currencyID: currency,
        })
      : null,
    inv.paidAmount === undefined
      ? null
      : el("cbc:PrepaidAmount", formatAmount(totals.paidAmount), {
          currencyID: currency,
        }),
    inv.roundingAmount === undefined
      ? null
      : el("cbc:PayableRoundingAmount", formatAmount(totals.roundingAmount), {
          currencyID: currency,
        }),
    el("cbc:PayableAmount", formatAmount(totals.payableAmount), {
      currencyID: currency,
    }),
  ]);

  // The document references, built once and ordered per root element below.
  // The two sequences interleave these differently, and getting it wrong is an
  // XSD rejection rather than a business-rule finding — the schema check runs
  // first, so the report says "invalid content" and names no BT at all.
  const despatchReference = inv.despatchAdviceReference
    ? group("cac:DespatchDocumentReference", [
        el("cbc:ID", inv.despatchAdviceReference),
      ])
    : null;
  const receiptReference = inv.receivingAdviceReference
    ? group("cac:ReceiptDocumentReference", [
        el("cbc:ID", inv.receivingAdviceReference),
      ])
    : null;
  const originatorReference = inv.tenderOrLotReference
    ? group("cac:OriginatorDocumentReference", [
        el("cbc:ID", inv.tenderOrLotReference),
      ])
    : null;
  const contractReference = inv.contractReference
    ? group("cac:ContractDocumentReference", [
        el("cbc:ID", inv.contractReference),
      ])
    : null;
  // BT-18 shares cac:AdditionalDocumentReference with BG-24 and is told apart
  // by DocumentTypeCode 130.
  const additionalReferences = [
    inv.invoicedObjectIdentifier
      ? groupAlways("cac:AdditionalDocumentReference", [
          el("cbc:ID", inv.invoicedObjectIdentifier.value, {
            schemeID: inv.invoicedObjectIdentifier.schemeId,
          }),
          el("cbc:DocumentTypeCode", INVOICED_OBJECT_DOCUMENT_TYPE_CODE),
        ])
      : null,
    ...(inv.supportingDocuments ?? []).map(supportingDocumentNode),
  ];

  const commonHead = [
    el("cbc:CustomizationID", customizationId),
    el("cbc:ProfileID", profileId),
    el("cbc:ID", inv.invoiceNumber),
    el("cbc:IssueDate", inv.issueDate),
  ];

  const commonAfterTypeCode = [
    el("cbc:DocumentCurrencyCode", currency),
    el("cbc:TaxCurrencyCode", taxCurrency),
    el("cbc:AccountingCost", inv.buyerAccountingReference),
    el("cbc:BuyerReference", inv.buyerReference),
    inv.invoicingPeriod
      ? periodNode("cac:InvoicePeriod", inv.invoicingPeriod)
      : null,
    inv.orderReference || inv.salesOrderReference
      ? groupAlways("cac:OrderReference", [
          el("cbc:ID", inv.orderReference),
          el("cbc:SalesOrderID", inv.salesOrderReference),
        ])
      : null,
    // BG-3. The same element on both documents: EN 16931 binds the preceding
    // *invoice* reference to cac:BillingReference/cac:InvoiceDocumentReference
    // whichever document is doing the referencing, and UBL-CR-039 forbids the
    // CreditNoteDocumentReference sibling outright. A credit note pointing at
    // the invoice it corrects is the ordinary case, and this is where it goes.
    ...(inv.precedingInvoices ?? []).map((reference) =>
      groupAlways("cac:BillingReference", [
        groupAlways("cac:InvoiceDocumentReference", [
          el("cbc:ID", reference.invoiceNumber),
          el("cbc:IssueDate", reference.issueDate),
        ]),
      ]),
    ),
    despatchReference,
    receiptReference,
  ];

  // Root children, in the sequence order of whichever document this is.
  const root = groupAlways(
    creditNote ? "ubl:CreditNote" : "ubl:Invoice",
    [
      ...commonHead,
      // The credit note has no cbc:DueDate (BT-9 moved into cac:PaymentMeans
      // above) and puts cbc:TaxPointDate before the type code.
      creditNote ? null : el("cbc:DueDate", inv.dueDate),
      creditNote ? el("cbc:TaxPointDate", inv.taxPointDate) : null,
      el(creditNote ? "cbc:CreditNoteTypeCode" : "cbc:InvoiceTypeCode", typeCode),
      el("cbc:Note", note),
      creditNote ? null : el("cbc:TaxPointDate", inv.taxPointDate),
      ...commonAfterTypeCode,
      // Contract and Additional come before Originator on a credit note and
      // after it on an invoice. BT-11 (cac:ProjectReference) exists only on the
      // invoice: the credit note has no such element, so a project reference is
      // dropped and reported as ATW-CREDIT-NOTE-PROJECT-REFERENCE-UNBOUND.
      ...(creditNote
        ? [contractReference, ...additionalReferences, originatorReference]
        : [
            originatorReference,
            contractReference,
            ...additionalReferences,
            inv.projectReference
              ? group("cac:ProjectReference", [
                  el("cbc:ID", inv.projectReference),
                ])
              : null,
          ]),
      groupAlways("cac:AccountingSupplierParty", [
        partyNode(inv.seller, {
          sepaCreditorIdentifier: inv.payment?.directDebit?.creditorIdentifier,
        }),
      ]),
      groupAlways("cac:AccountingCustomerParty", [partyNode(inv.buyer)]),
      // cac:PayeeParty — BG-10. Not a full cac:Party wrapper: the element *is*
      // the party, so its children are PartyIdentification, PartyName,
      // PartyLegalEntity in that order.
      inv.payee
        ? groupAlways("cac:PayeeParty", [
            inv.payee.identifier
              ? group("cac:PartyIdentification", [
                  el("cbc:ID", inv.payee.identifier.value, {
                    schemeID: inv.payee.identifier.schemeId,
                  }),
                ])
              : null,
            group("cac:PartyName", [el("cbc:Name", inv.payee.name)]),
            inv.payee.legalRegistrationId
              ? group("cac:PartyLegalEntity", [
                  el("cbc:CompanyID", inv.payee.legalRegistrationId.value, {
                    schemeID: inv.payee.legalRegistrationId.schemeId,
                  }),
                ])
              : null,
          ])
        : null,
      // cac:TaxRepresentativeParty — BG-11.
      inv.taxRepresentative
        ? groupAlways("cac:TaxRepresentativeParty", [
            group("cac:PartyName", [
              el("cbc:Name", inv.taxRepresentative.name),
            ]),
            addressNode("cac:PostalAddress", inv.taxRepresentative.address),
            groupAlways("cac:PartyTaxScheme", [
              el("cbc:CompanyID", inv.taxRepresentative.vatId),
              group("cac:TaxScheme", [el("cbc:ID", "VAT")]),
            ]),
          ])
        : null,
      delivery,
      paymentMeans,
      inv.paymentTerms
        ? group("cac:PaymentTerms", [el("cbc:Note", inv.paymentTerms)])
        : null,
      ...(inv.allowances ?? []).map((entry) =>
        documentAllowanceChargeNode(entry, false, currency),
      ),
      ...(inv.charges ?? []).map((entry) =>
        documentAllowanceChargeNode(entry, true, currency),
      ),
      taxTotalNode(totals, currency),
      // BT-111: the same VAT total restated in the VAT accounting currency, as
      // a second cac:TaxTotal carrying nothing but the amount. It is a separate
      // element rather than an attribute because BR-53 and BR-DEC-15 both look
      // for a TaxAmount whose @currencyID equals BT-6.
      taxCurrency && inv.taxAmountInAccountingCurrency !== undefined
        ? groupAlways("cac:TaxTotal", [
            el(
              "cbc:TaxAmount",
              formatAmount(inv.taxAmountInAccountingCurrency),
              { currencyID: taxCurrency },
            ),
          ])
        : null,
      monetaryTotal,
      ...lines,
    ],
    {
      "xmlns:ubl": creditNote ? NS.cn : NS.inv,
      "xmlns:cac": NS.cac,
      "xmlns:cbc": NS.cbc,
    },
  );

  return document(root, indent);
}
