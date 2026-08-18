import {
  computeTotals,
  effectiveAllowanceChargeRate,
  effectiveRate,
  formatAmount,
  formatNumber,
  formatPrice,
} from "./totals.js";
import { document, el, group, groupAlways, type XmlNode } from "./xml.js";
import { taxPointCodeToCii } from "./cii-tax-point-code.js";
import { resolveTypeCode } from "./document-type.js";
import {
  CUSTOMIZATION_IDS,
  GenerationError,
  INVOICED_OBJECT_DOCUMENT_TYPE_CODE,
  PROFILE_IDS,
  type GenerateOptions,
} from "./generate.js";
import type {
  DocumentAllowanceCharge,
  InvoiceInput,
  InvoicingPeriod,
  LineAllowanceCharge,
  Party,
  PostalAddress,
  Profile,
  SupportingDocument,
} from "./types.js";

/**
 * JSON → UN/CEFACT Cross Industry Invoice (CII), D16B.
 *
 * This is the second syntax EN 16931 is expressed in, and the one Germany's
 * XRechnung CII and France's Factur-X are built on. It is not a re-skin of the
 * UBL generator: the namespaces, the element names and the whole document shape
 * are different, and — as in UBL — the XSD is `xsd:sequence`, so the order of
 * children is part of schema validity. Every builder below emits children in
 * the order given by `CrossIndustryInvoice_ReusableAggregateBusinessInformation
 * Entity_100pD16B.xsd`, and the sequence is quoted above each one.
 *
 * Two differences from UBL are worth stating up front, because they are where a
 * reader's UBL habits produce a rejected document:
 *
 *   - **Dates are not ISO dates.** A CII date is an element wrapping
 *     `udt:DateTimeString` with `format="102"`, whose content is `YYYYMMDD`.
 *   - **Amounts carry no currency.** Only BT-110 and BT-111 (the two
 *     `ram:TaxTotalAmount` elements) take a `currencyID`; the document currency
 *     is stated once, in `ram:InvoiceCurrencyCode`.
 *
 * What this does **not** do is produce a PDF. Factur-X and ZUGFeRD are this XML
 * embedded in a PDF/A-3 container; `generateCii` emits the XML half only. The
 * container is read (extraction) as of 0.7.0 — see `extractFacturX` in
 * `facturx-pdf.ts` — and it is still never built.
 */

const NS = {
  rsm: "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100",
  ram: "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100",
  qdt: "urn:un:unece:uncefact:data:standard:QualifiedDataType:100",
  udt: "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100",
} as const;

/** The four namespace URIs a CII invoice uses, for resolving by URI. */
export const CII_NAMESPACES = NS;

/**
 * Profiles this generator can emit.
 *
 * `xrechnung-cii` and `facturx-en16931` are CII by definition. `en16931` is
 * syntax-neutral — the core standard is expressed in both UBL and CII — so it
 * is generatable here as well as by `generateXRechnungUBL`, and you choose the
 * syntax by choosing the function.
 *
 * **`peppol-bis-3` is here as of 0.7.0, and was wrongly absent before it.** The
 * doc-comment used to say Peppol BIS Billing 3.0 was "a UBL-only CIUS". It is
 * not. OpenPEPPOL/peppol-bis-invoice-3 @ v3.0.20 ships
 * `rules/sch/PEPPOL-EN16931-CII.sch` (602 lines, 87 assertions),
 * `rules/buildconfig.xml` declares a `peppolbis-en16931-01-3.0-cii`
 * configuration, and `guide/bis/appendix/cii.adoc` describes CII **D16B** —
 * the same version this generator emits — as optional in the BIS: UBL is
 * mandatory for every receiver, CII is accepted by receivers who register for
 * it in the SMP. So the correct statement is that CII on Peppol is optional,
 * not absent, and refusing to emit it was refusing something the specification
 * allows. `scripts/peppol-check.md` records the run that settled it.
 *
 * `xrechnung-ubl` is still absent, and that one really is syntax-bound: it
 * names the UBL half of XRechnung, and `xrechnung-cii` is its CII sibling.
 */
export const CII_GENERATABLE_PROFILES = [
  "en16931",
  "xrechnung-cii",
  "facturx-en16931",
  "peppol-bis-3",
] as const satisfies readonly Profile[];

export type CiiGeneratableProfile = (typeof CII_GENERATABLE_PROFILES)[number];

/** Thrown when `profile` is not a syntax `generateCii` can emit. */
export class UnsupportedCiiProfileError extends GenerationError {
  readonly profile: string;
  readonly supportedProfiles: readonly Profile[] = CII_GENERATABLE_PROFILES;

  constructor(profile: string) {
    super(
      "unsupported_profile",
      `generateCii cannot generate the "${profile}" profile. ` +
        `It emits UN/CEFACT CII (D16B) syntax only, which covers: ` +
        `${CII_GENERATABLE_PROFILES.join(", ")}. ` +
        `"xrechnung-ubl" names the UBL binding of XRechnung specifically — use ` +
        `generateXRechnungUBL for it, or "xrechnung-cii" for the same rules in CII. ` +
        `Emitting CII under a UBL-bound profile name would produce a document that ` +
        `passes no validator, so this call refuses rather than returning ` +
        `silently-wrong XML.`,
    );
    this.profile = profile;
  }
}

/**
 * UNTDID 1001 code marking a `ram:AdditionalReferencedDocument` as a supporting
 * document (BG-24). CII, unlike UBL, tells the three uses of that one element
 * apart by a type code on every one of them, not just on BT-18.
 */
export const SUPPORTING_DOCUMENT_TYPE_CODE = "916";

/** UNTDID 1001 code marking a `ram:AdditionalReferencedDocument` as BT-17. */
export const TENDER_OR_LOT_DOCUMENT_TYPE_CODE = "50";

/**
 * ISO 8601 date → the CII `format="102"` form, `YYYYMMDD`.
 *
 * A value that is not a calendar date is passed through untouched rather than
 * mangled: `validateInput` already raises `ATW-DATE-NOT-A-CALENDAR-DATE` for
 * it, and silently rewriting a date on a tax document is worse than emitting
 * one a validator will reject out loud.
 */
export function toCiiDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  return match ? `${match[1]}${match[2]}${match[3]}` : iso;
}

/** `<ram:X><udt:DateTimeString format="102">…</udt:DateTimeString></ram:X>` */
function dateNode(name: string, iso: string | undefined): XmlNode | null {
  if (iso === undefined) return null;
  return groupAlways(name, [
    el("udt:DateTimeString", toCiiDate(iso), { format: "102" }),
  ]);
}

/**
 * The same date, in the *qualified* data type.
 *
 * `ram:FormattedIssueDateTime` is a `qdt:FormattedDateTimeType`, so its child
 * lives in the qualified namespace rather than the unqualified one. It is the
 * only place in an EN 16931 CII invoice where `qdt:` appears, and getting it
 * wrong is an XSD rejection rather than a business-rule finding.
 */
function formattedDateNode(name: string, iso: string | undefined): XmlNode | null {
  if (iso === undefined) return null;
  return groupAlways(name, [
    el("qdt:DateTimeString", toCiiDate(iso), { format: "102" }),
  ]);
}

/** `<ram:ChargeIndicator><udt:Indicator>true</udt:Indicator></ram:ChargeIndicator>` */
function indicatorNode(name: string, value: boolean): XmlNode {
  return groupAlways(name, [el("udt:Indicator", value ? "true" : "false")]);
}

/**
 * `ram:PostalTradeAddress` — schema order (TradeAddressType):
 *   ID, PostcodeCode, PostOfficeBox, BuildingName, LineOne, LineTwo, LineThree,
 *   LineFour, LineFive, StreetName, CityName, CitySubDivisionName, CountryID,
 *   CountryName, CountrySubDivisionID, CountrySubDivisionName, …
 *
 * Note the post code comes *first*, before the street. That is the opposite of
 * UBL's `cac:PostalAddress`, and it is the single easiest thing to get wrong
 * when porting a UBL mapping across.
 */
function addressNode(
  name: string,
  a: Pick<
    PostalAddress,
    "line1" | "line2" | "line3" | "city" | "postalCode" | "countrySubdivision" | "countryCode"
  >,
): XmlNode {
  return groupAlways(name, [
    el("ram:PostcodeCode", a.postalCode || undefined),
    el("ram:LineOne", a.line1),
    el("ram:LineTwo", a.line2),
    el("ram:LineThree", a.line3),
    el("ram:CityName", a.city || undefined),
    el("ram:CountryID", a.countryCode?.toUpperCase()),
    el("ram:CountrySubDivisionName", a.countrySubdivision),
  ]);
}

/**
 * A `ram:*TradeParty` — schema order (TradePartyType):
 *   ID, GlobalID, Name, RoleCode, Description, SpecifiedLegalOrganization,
 *   DefinedTradeContact, PostalTradeAddress, URIUniversalCommunication,
 *   SpecifiedTaxRegistration
 *
 * Three mappings differ from UBL and are worth naming:
 *   - BT-29/BT-46 goes in `ram:ID` when it has no scheme and in `ram:GlobalID`
 *     when it does. UBL uses one element with an optional `schemeID`.
 *   - BT-30/BT-47 (legal registration) is `SpecifiedLegalOrganization/ram:ID`,
 *     and BT-28/BT-45 (trading name) is `TradingBusinessName` beside it.
 *   - BT-31 and BT-32 are two `SpecifiedTaxRegistration` entries told apart by
 *     `schemeID` — `VA` for the VAT identifier, `FC` for the national tax
 *     registration. UBL uses `cac:TaxScheme/cbc:ID` with `VAT` and `FC`.
 */
function partyNode(name: string, party: Party): XmlNode {
  const identifier = party.identifier;
  const contact = party.contact;

  return groupAlways(name, [
    identifier && !identifier.schemeId ? el("ram:ID", identifier.value) : null,
    identifier?.schemeId
      ? el("ram:GlobalID", identifier.value, { schemeID: identifier.schemeId })
      : null,
    el("ram:Name", party.legalName ?? party.name),
    el("ram:Description", party.additionalLegalInformation),
    party.legalRegistrationId || party.tradingName
      ? groupAlways("ram:SpecifiedLegalOrganization", [
          el("ram:ID", party.legalRegistrationId, {
            schemeID: party.legalRegistrationSchemeId,
          }),
          el("ram:TradingBusinessName", party.tradingName),
        ])
      : null,
    contact
      ? groupAlways("ram:DefinedTradeContact", [
          el("ram:PersonName", contact.name),
          contact.phone
            ? groupAlways("ram:TelephoneUniversalCommunication", [
                el("ram:CompleteNumber", contact.phone),
              ])
            : null,
          contact.email
            ? groupAlways("ram:EmailURIUniversalCommunication", [
                el("ram:URIID", contact.email),
              ])
            : null,
        ])
      : null,
    addressNode("ram:PostalTradeAddress", party.address),
    party.electronicAddress
      ? groupAlways("ram:URIUniversalCommunication", [
          el("ram:URIID", party.electronicAddress.value, {
            schemeID: party.electronicAddress.schemeId,
          }),
        ])
      : null,
    party.vatId
      ? groupAlways("ram:SpecifiedTaxRegistration", [
          el("ram:ID", party.vatId, { schemeID: "VA" }),
        ])
      : null,
    party.taxRegistrationId
      ? groupAlways("ram:SpecifiedTaxRegistration", [
          el("ram:ID", party.taxRegistrationId, { schemeID: "FC" }),
        ])
      : null,
  ]);
}

/** `ram:BillingSpecifiedPeriod` — schema order: …, StartDateTime, EndDateTime, … */
function periodNode(name: string, period: InvoicingPeriod): XmlNode | null {
  return group(name, [
    dateNode("ram:StartDateTime", period.startDate),
    dateNode("ram:EndDateTime", period.endDate),
  ]);
}

/**
 * `ram:SpecifiedTradeAllowanceCharge` — schema order (TradeAllowanceChargeType):
 *   ChargeIndicator, ID, SequenceNumeric, CalculationPercent, BasisAmount,
 *   BasisQuantity, PrepaidIndicator, ActualAmount, UnitBasisAmount, ReasonCode,
 *   Reason, TypeCode, CategoryTradeTax
 *
 * Two order traps against UBL: the percentage and the base amount come *before*
 * the amount, and the reason **code** comes before the reason **text**. UBL has
 * both pairs the other way round.
 */
function allowanceChargeNode(
  entry: DocumentAllowanceCharge | LineAllowanceCharge,
  isCharge: boolean,
  taxCategory: { category: string; rate: number | undefined } | undefined,
): XmlNode {
  return groupAlways("ram:SpecifiedTradeAllowanceCharge", [
    indicatorNode("ram:ChargeIndicator", isCharge),
    entry.percentage === undefined
      ? null
      : el("ram:CalculationPercent", formatNumber(entry.percentage)),
    entry.baseAmount === undefined
      ? null
      : el("ram:BasisAmount", formatAmount(entry.baseAmount)),
    el("ram:ActualAmount", formatAmount(entry.amount)),
    el("ram:ReasonCode", entry.reasonCode),
    el("ram:Reason", entry.reason),
    taxCategory
      ? groupAlways("ram:CategoryTradeTax", [
          el("ram:TypeCode", "VAT"),
          el("ram:CategoryCode", taxCategory.category),
          taxCategory.rate === undefined
            ? null
            : el("ram:RateApplicablePercent", formatNumber(taxCategory.rate)),
        ])
      : null,
  ]);
}

/**
 * `ram:AdditionalReferencedDocument` — schema order (ReferencedDocumentType):
 *   IssuerAssignedID, URIID, StatusCode, CopyIndicator, LineID, TypeCode,
 *   GlobalID, RevisionID, Name, AttachmentBinaryObject, Information,
 *   ReferenceTypeCode, …, FormattedIssueDateTime, …
 *
 * `LineID` sitting between `URIID` and `TypeCode` is the surprise here.
 */
function supportingDocumentNode(doc: SupportingDocument): XmlNode {
  return groupAlways("ram:AdditionalReferencedDocument", [
    el("ram:IssuerAssignedID", doc.reference),
    el("ram:URIID", doc.externalUri),
    el("ram:TypeCode", SUPPORTING_DOCUMENT_TYPE_CODE),
    el("ram:Name", doc.description),
    doc.attachment
      ? el("ram:AttachmentBinaryObject", doc.attachment.content, {
          mimeCode: doc.attachment.mimeCode,
          filename: doc.attachment.filename,
        })
      : null,
  ]);
}

/** BT-18 / BT-128: the invoiced object, told apart by UNTDID 1001 code 130. */
function invoicedObjectNode(identifier: {
  value: string;
  schemeId?: string;
}): XmlNode {
  return groupAlways("ram:AdditionalReferencedDocument", [
    el("ram:IssuerAssignedID", identifier.value),
    el("ram:TypeCode", INVOICED_OBJECT_DOCUMENT_TYPE_CODE),
    el("ram:ReferenceTypeCode", identifier.schemeId),
  ]);
}

/**
 * Generate an EN 16931 CII (UN/CEFACT D16B) invoice document.
 *
 * ```ts
 * const xml = generateCii({ ...invoice, profile: "xrechnung-cii" });
 * ```
 *
 * Throws `UnsupportedCiiProfileError` for a UBL-only profile, rather than
 * emitting a document that would be rejected downstream. It extends
 * `GenerationError` and carries a stable `code`.
 *
 * **Credit notes need nothing special here.** CII has no separate credit-note
 * document: one root element, `rsm:CrossIndustryInvoice`, carries both, and the
 * type code goes into `ram:TypeCode` exactly as it always did. Setting
 * `invoiceTypeCode: "381"` produces a credit note, and the only difference in
 * the emitted XML is those three digits. That asymmetry with UBL — where the
 * same input produces a different root element, namespace and line element — is
 * the whole reason the document type lives on BT-3 in the input model rather
 * than in a syntax-specific option.
 *
 * Totals are always computed from the lines and the document allowances and
 * charges by the same `computeTotals` the UBL path uses — the function never
 * echoes caller-supplied totals into the XML.
 *
 * **This is XML, not a PDF.** `facturx-en16931` here means the Factur-X CII
 * payload. The PDF/A-3 container that makes it a Factur-X *file* is read
 * (extraction) as of 0.7.0 via `extractFacturX`; it is still never built, so
 * nothing in this module writes one.
 */
export function generateCii(
  inv: InvoiceInput,
  options: GenerateOptions = {},
): string {
  if (!(CII_GENERATABLE_PROFILES as readonly string[]).includes(inv?.profile)) {
    throw new UnsupportedCiiProfileError(String(inv?.profile));
  }
  const typeCode = resolveTypeCode(inv.invoiceTypeCode);

  const totals = computeTotals(inv);
  const currency = (inv.currency || "EUR").toUpperCase();
  const taxCurrency = inv.vatAccountingCurrency?.trim().toUpperCase();
  const indent = options.indent ?? "  ";

  const customizationId =
    options.customizationId ??
    CUSTOMIZATION_IDS[inv.profile] ??
    CUSTOMIZATION_IDS["xrechnung-cii"];
  const profileId =
    options.profileId ?? PROFILE_IDS[inv.profile] ?? PROFILE_IDS["xrechnung-cii"];

  // ram:IncludedSupplyChainTradeLineItem — schema order:
  //   AssociatedDocumentLineDocument, SpecifiedTradeProduct,
  //   SpecifiedLineTradeAgreement, SpecifiedLineTradeDelivery,
  //   SpecifiedLineTradeSettlement
  const lines = inv.lines.map((line, index) => {
    const net = totals.lineNetAmounts[index] ?? 0;
    // One source of truth for the rate. `effectiveRate` is what `computeTotals`
    // grouped and computed BT-117 from, and it normalises to the precision the
    // rate is written at — so BT-119 and BT-117 can no longer come from two
    // different numbers (finding 8).
    const rate = effectiveRate(line);
    const zeroRated = ["Z", "E", "AE", "K", "G"].includes(line.vatCategory);

    return groupAlways("ram:IncludedSupplyChainTradeLineItem", [
      groupAlways("ram:AssociatedDocumentLineDocument", [
        el("ram:LineID", line.id),
        line.note === undefined
          ? null
          : groupAlways("ram:IncludedNote", [el("ram:Content", line.note)]),
      ]),
      // ram:SpecifiedTradeProduct — schema order: ID, GlobalID,
      // SellerAssignedID, BuyerAssignedID, …, Name, …, Description, …,
      // ApplicableProductCharacteristic, …, DesignatedProductClassification,
      // …, OriginTradeCountry, …
      groupAlways("ram:SpecifiedTradeProduct", [
        line.standardItemId
          ? el("ram:GlobalID", line.standardItemId.value, {
              schemeID: line.standardItemId.schemeId,
            })
          : null,
        el("ram:SellerAssignedID", line.sellerItemId),
        el("ram:BuyerAssignedID", line.buyerItemId),
        el("ram:Name", line.description),
        el("ram:Description", line.longDescription),
        ...(line.itemAttributes ?? []).map((attribute) =>
          groupAlways("ram:ApplicableProductCharacteristic", [
            el("ram:Description", attribute.name),
            el("ram:Value", attribute.value),
          ]),
        ),
        ...(line.itemClassifications ?? []).map((classification) =>
          groupAlways("ram:DesignatedProductClassification", [
            el("ram:ClassCode", classification.code, {
              listID: classification.schemeId,
              listVersionID: classification.schemeVersion,
            }),
          ]),
        ),
        line.originCountryCode
          ? groupAlways("ram:OriginTradeCountry", [
              el("ram:ID", line.originCountryCode.toUpperCase()),
            ])
          : null,
      ]),
      // ram:SpecifiedLineTradeAgreement — schema order: …,
      // BuyerOrderReferencedDocument, …, GrossPriceProductTradePrice,
      // NetPriceProductTradePrice, …
      groupAlways("ram:SpecifiedLineTradeAgreement", [
        line.orderLineReference
          ? groupAlways("ram:BuyerOrderReferencedDocument", [
              el("ram:LineID", line.orderLineReference),
            ])
          : null,
        // BT-148/BT-147: the gross price and the discount off it are a separate
        // price element in CII, not an allowance hanging off one price as in
        // UBL. ram:TradePriceType order: TypeCode, ChargeAmount, BasisQuantity,
        // …, AppliedTradeAllowanceCharge, …
        line.grossUnitPrice === undefined
          ? null
          : groupAlways("ram:GrossPriceProductTradePrice", [
              // BT-148, a price: no two-decimal cap (finding 7).
              el("ram:ChargeAmount", formatPrice(line.grossUnitPrice)),
              line.baseQuantity === undefined
                ? null
                : el("ram:BasisQuantity", formatNumber(line.baseQuantity, 4), {
                    unitCode: line.unitCode,
                  }),
              groupAlways("ram:AppliedTradeAllowanceCharge", [
                indicatorNode("ram:ChargeIndicator", false),
                // BT-147, the discount off that price.
                el(
                  "ram:ActualAmount",
                  formatPrice(
                    line.priceDiscount ?? line.grossUnitPrice - line.unitPrice,
                  ),
                ),
              ]),
            ]),
        groupAlways("ram:NetPriceProductTradePrice", [
          // BT-146, the item net price.
          el("ram:ChargeAmount", formatPrice(line.unitPrice)),
          line.baseQuantity === undefined
            ? null
            : el("ram:BasisQuantity", formatNumber(line.baseQuantity, 4), {
                unitCode: line.unitCode,
              }),
        ]),
      ]),
      groupAlways("ram:SpecifiedLineTradeDelivery", [
        el("ram:BilledQuantity", formatNumber(line.quantity, 4), {
          unitCode: line.unitCode,
        }),
      ]),
      // ram:SpecifiedLineTradeSettlement — schema order: …, ApplicableTradeTax,
      // BillingSpecifiedPeriod, SpecifiedTradeAllowanceCharge, …,
      // SpecifiedTradeSettlementLineMonetarySummation, …,
      // AdditionalReferencedDocument, …, ReceivableSpecifiedTradeAccountingAccount
      groupAlways("ram:SpecifiedLineTradeSettlement", [
        groupAlways("ram:ApplicableTradeTax", [
          el("ram:TypeCode", "VAT"),
          el("ram:CategoryCode", line.vatCategory),
          rate === undefined
            ? null
            : el("ram:RateApplicablePercent", formatNumber(zeroRated ? 0 : rate)),
        ]),
        line.period ? periodNode("ram:BillingSpecifiedPeriod", line.period) : null,
        ...(line.allowances ?? []).map((entry) =>
          allowanceChargeNode(entry, false, undefined),
        ),
        ...(line.charges ?? []).map((entry) =>
          allowanceChargeNode(entry, true, undefined),
        ),
        groupAlways("ram:SpecifiedTradeSettlementLineMonetarySummation", [
          el("ram:LineTotalAmount", formatAmount(net)),
        ]),
        line.objectIdentifier ? invoicedObjectNode(line.objectIdentifier) : null,
        line.buyerAccountingReference
          ? groupAlways("ram:ReceivableSpecifiedTradeAccountingAccount", [
              el("ram:ID", line.buyerAccountingReference),
            ])
          : null,
      ]),
    ]);
  });

  // ram:ApplicableHeaderTradeAgreement — schema order: …, BuyerReference,
  // SellerTradeParty, BuyerTradeParty, …, SellerTaxRepresentativeTradeParty,
  // …, SellerOrderReferencedDocument, BuyerOrderReferencedDocument, …,
  // ContractReferencedDocument, …, AdditionalReferencedDocument, …,
  // SpecifiedProcuringProject, …
  const agreement = groupAlways("ram:ApplicableHeaderTradeAgreement", [
    el("ram:BuyerReference", inv.buyerReference),
    partyNode("ram:SellerTradeParty", inv.seller),
    partyNode("ram:BuyerTradeParty", inv.buyer),
    inv.taxRepresentative
      ? groupAlways("ram:SellerTaxRepresentativeTradeParty", [
          el("ram:Name", inv.taxRepresentative.name),
          addressNode("ram:PostalTradeAddress", inv.taxRepresentative.address),
          groupAlways("ram:SpecifiedTaxRegistration", [
            el("ram:ID", inv.taxRepresentative.vatId, { schemeID: "VA" }),
          ]),
        ])
      : null,
    inv.salesOrderReference
      ? groupAlways("ram:SellerOrderReferencedDocument", [
          el("ram:IssuerAssignedID", inv.salesOrderReference),
        ])
      : null,
    inv.orderReference
      ? groupAlways("ram:BuyerOrderReferencedDocument", [
          el("ram:IssuerAssignedID", inv.orderReference),
        ])
      : null,
    inv.contractReference
      ? groupAlways("ram:ContractReferencedDocument", [
          el("ram:IssuerAssignedID", inv.contractReference),
        ])
      : null,
    inv.invoicedObjectIdentifier
      ? invoicedObjectNode(inv.invoicedObjectIdentifier)
      : null,
    ...(inv.supportingDocuments ?? []).map(supportingDocumentNode),
    inv.tenderOrLotReference
      ? groupAlways("ram:AdditionalReferencedDocument", [
          el("ram:IssuerAssignedID", inv.tenderOrLotReference),
          el("ram:TypeCode", TENDER_OR_LOT_DOCUMENT_TYPE_CODE),
        ])
      : null,
    inv.projectReference
      ? groupAlways("ram:SpecifiedProcuringProject", [
          el("ram:ID", inv.projectReference),
          // ram:Name is mandatory in ProcuringProjectType. The reference is the
          // only project text the input model holds, so it carries both.
          el("ram:Name", inv.projectReference),
        ])
      : null,
  ]);

  // ram:ApplicableHeaderTradeDelivery — schema order: …, ShipToTradeParty, …,
  // ActualDeliverySupplyChainEvent, …, DespatchAdviceReferencedDocument,
  // ReceivingAdviceReferencedDocument, …
  const deliverTo = inv.deliverTo;
  const delivery = groupAlways("ram:ApplicableHeaderTradeDelivery", [
    deliverTo || inv.deliverToName || inv.deliverToLocationId
      ? groupAlways("ram:ShipToTradeParty", [
          inv.deliverToLocationId && !inv.deliverToLocationId.schemeId
            ? el("ram:ID", inv.deliverToLocationId.value)
            : null,
          inv.deliverToLocationId?.schemeId
            ? el("ram:GlobalID", inv.deliverToLocationId.value, {
                schemeID: inv.deliverToLocationId.schemeId,
              })
            : null,
          el("ram:Name", inv.deliverToName),
          deliverTo
            ? addressNode("ram:PostalTradeAddress", {
                ...deliverTo,
                city: deliverTo.city ?? "",
                postalCode: deliverTo.postalCode ?? "",
              })
            : null,
        ])
      : null,
    inv.deliveryDate
      ? groupAlways("ram:ActualDeliverySupplyChainEvent", [
          dateNode("ram:OccurrenceDateTime", inv.deliveryDate),
        ])
      : null,
    inv.despatchAdviceReference
      ? groupAlways("ram:DespatchAdviceReferencedDocument", [
          el("ram:IssuerAssignedID", inv.despatchAdviceReference),
        ])
      : null,
    inv.receivingAdviceReference
      ? groupAlways("ram:ReceivingAdviceReferencedDocument", [
          el("ram:IssuerAssignedID", inv.receivingAdviceReference),
        ])
      : null,
  ]);

  // ram:ApplicableTradeTax at header level — schema order (TradeTaxType):
  //   CalculatedAmount, TypeCode, ExemptionReason, …, BasisAmount, …,
  //   CategoryCode, …, ExemptionReasonCode, …, TaxPointDate, …,
  //   DueDateTypeCode, RateApplicablePercent, …
  //
  // BT-7 and BT-8 are document-level terms with no document-level element in
  // CII: the binding hangs them off a VAT breakdown group. Exactly one group,
  // not every group — `CII-SR-461` and its DueDateTypeCode twin both say "only
  // one shall be present", and an invoice with two VAT rates that states the
  // tax point date on both is rejected. KoSIT caught precisely that here.
  // BR-CO-03 makes BT-7 and BT-8 mutually exclusive, so at most one appears.
  const taxBreakdown = totals.subtotals.map((sub, position) =>
    groupAlways("ram:ApplicableTradeTax", [
      el("ram:CalculatedAmount", formatAmount(sub.taxAmount)),
      el("ram:TypeCode", "VAT"),
      el("ram:ExemptionReason", sub.exemptionReason),
      el("ram:BasisAmount", formatAmount(sub.taxableAmount)),
      el("ram:CategoryCode", sub.category),
      el("ram:ExemptionReasonCode", sub.exemptionReasonCode),
      inv.taxPointDate === undefined || position > 0
        ? null
        : groupAlways("ram:TaxPointDate", [
            el("udt:DateString", toCiiDate(inv.taxPointDate), { format: "102" }),
          ]),
      position > 0
        ? null
        : el(
            "ram:DueDateTypeCode",
            // BT-8's code list is syntax-specific: the model holds the EN
            // 16931 / UBL code and CII writes the UNTDID 2475 equivalent.
            taxPointCodeToCii(inv.invoicingPeriod?.descriptionCode),
          ),
      sub.rate === undefined
        ? null
        : el("ram:RateApplicablePercent", formatNumber(sub.rate)),
    ]),
  );

  // ram:SpecifiedTradeSettlementPaymentMeans — schema order:
  //   PaymentChannelCode, TypeCode, GuaranteeMethodCode, PaymentMethodCode,
  //   Information, ID, ApplicableTradeSettlementFinancialCard,
  //   PayerPartyDebtorFinancialAccount, PayeePartyCreditorFinancialAccount,
  //   PayerSpecifiedDebtorFinancialInstitution,
  //   PayeeSpecifiedCreditorFinancialInstitution
  const paymentMeans = inv.payment
    ? groupAlways("ram:SpecifiedTradeSettlementPaymentMeans", [
        el("ram:TypeCode", inv.payment.meansCode),
        el("ram:Information", inv.payment.meansName),
        inv.payment.card
          ? groupAlways("ram:ApplicableTradeSettlementFinancialCard", [
              el("ram:ID", inv.payment.card.primaryAccountNumber),
              el("ram:CardholderName", inv.payment.card.holderName),
            ])
          : null,
        inv.payment.directDebit?.debitedAccount
          ? groupAlways("ram:PayerPartyDebtorFinancialAccount", [
              el("ram:IBANID", inv.payment.directDebit.debitedAccount),
            ])
          : null,
        // Blank-aware, not truthy — the same trap as UBL's BG-17: an IBAN of
        // pure whitespace must not conjure the group BR-DE-24-b forbids.
        inv.payment.iban?.trim()
          ? groupAlways("ram:PayeePartyCreditorFinancialAccount", [
              el("ram:IBANID", inv.payment.iban),
              el("ram:AccountName", inv.payment.accountName),
            ])
          : null,
        inv.payment.bic
          ? groupAlways("ram:PayeeSpecifiedCreditorFinancialInstitution", [
              el("ram:BICID", inv.payment.bic),
            ])
          : null,
      ])
    : null;

  // ram:SpecifiedTradeSettlementHeaderMonetarySummation — schema order:
  //   LineTotalAmount, ChargeTotalAmount, AllowanceTotalAmount,
  //   TaxBasisTotalAmount, TaxTotalAmount, RoundingAmount, GrandTotalAmount,
  //   …, TotalPrepaidAmount, …, DuePayableAmount, …
  //
  // Charges before allowances, and the rounding amount before the grand total:
  // both are the reverse of the UBL sequence.
  const monetarySummation = groupAlways(
    "ram:SpecifiedTradeSettlementHeaderMonetarySummation",
    [
      el("ram:LineTotalAmount", formatAmount(totals.lineExtensionAmount)),
      (inv.charges ?? []).length > 0
        ? el("ram:ChargeTotalAmount", formatAmount(totals.chargeTotalAmount))
        : null,
      (inv.allowances ?? []).length > 0
        ? el("ram:AllowanceTotalAmount", formatAmount(totals.allowanceTotalAmount))
        : null,
      el("ram:TaxBasisTotalAmount", formatAmount(totals.taxExclusiveAmount)),
      el("ram:TaxTotalAmount", formatAmount(totals.taxAmount), {
        currencyID: currency,
      }),
      // BT-111: the same VAT total restated in the VAT accounting currency. In
      // CII it is a second TaxTotalAmount in the same summation, told apart
      // only by @currencyID — there is no second breakdown to hang it on.
      taxCurrency && inv.taxAmountInAccountingCurrency !== undefined
        ? el(
            "ram:TaxTotalAmount",
            formatAmount(inv.taxAmountInAccountingCurrency),
            { currencyID: taxCurrency },
          )
        : null,
      inv.roundingAmount === undefined
        ? null
        : el("ram:RoundingAmount", formatAmount(totals.roundingAmount)),
      el("ram:GrandTotalAmount", formatAmount(totals.taxInclusiveAmount)),
      inv.paidAmount === undefined
        ? null
        : el("ram:TotalPrepaidAmount", formatAmount(totals.paidAmount)),
      el("ram:DuePayableAmount", formatAmount(totals.payableAmount)),
    ],
  );

  // ram:ApplicableHeaderTradeSettlement — schema order: …, CreditorReferenceID,
  // PaymentReference, TaxCurrencyCode, InvoiceCurrencyCode, …, PayeeTradeParty,
  // …, SpecifiedTradeSettlementPaymentMeans, ApplicableTradeTax,
  // BillingSpecifiedPeriod, SpecifiedTradeAllowanceCharge, …,
  // SpecifiedTradePaymentTerms,
  // SpecifiedTradeSettlementHeaderMonetarySummation, …,
  // InvoiceReferencedDocument, …, ReceivableSpecifiedTradeAccountingAccount, …
  const settlement = groupAlways("ram:ApplicableHeaderTradeSettlement", [
    // BT-90 lives here in CII, not on the seller party as UBL's
    // schemeID="SEPA" PartyIdentification does.
    el("ram:CreditorReferenceID", inv.payment?.directDebit?.creditorIdentifier),
    el("ram:PaymentReference", inv.payment?.remittanceInformation),
    el("ram:TaxCurrencyCode", taxCurrency),
    el("ram:InvoiceCurrencyCode", currency),
    inv.payee
      ? groupAlways("ram:PayeeTradeParty", [
          inv.payee.identifier && !inv.payee.identifier.schemeId
            ? el("ram:ID", inv.payee.identifier.value)
            : null,
          inv.payee.identifier?.schemeId
            ? el("ram:GlobalID", inv.payee.identifier.value, {
                schemeID: inv.payee.identifier.schemeId,
              })
            : null,
          el("ram:Name", inv.payee.name),
          inv.payee.legalRegistrationId
            ? groupAlways("ram:SpecifiedLegalOrganization", [
                el("ram:ID", inv.payee.legalRegistrationId.value, {
                  schemeID: inv.payee.legalRegistrationId.schemeId,
                }),
              ])
            : null,
        ])
      : null,
    paymentMeans,
    ...taxBreakdown,
    inv.invoicingPeriod
      ? periodNode("ram:BillingSpecifiedPeriod", inv.invoicingPeriod)
      : null,
    // ⚠ `effectiveAllowanceChargeRate`, not `entry.vatRate ?? 0` (finding 11).
    // The line path already normalised; this one did not, so a document
    // allowance written `{ vatCategory: "E", vatRate: 19 }` emitted
    // `RateApplicablePercent 19.00` against an `E @ 0.00` breakdown — the
    // breakdown forces zero for Z/E/AE/K/G and the allowance did not, which is
    // a BR-E-06 violation the two halves of the document disagree about.
    ...(inv.allowances ?? []).map((entry) =>
      allowanceChargeNode(entry, false, {
        category: entry.vatCategory,
        rate: effectiveAllowanceChargeRate(entry),
      }),
    ),
    ...(inv.charges ?? []).map((entry) =>
      allowanceChargeNode(entry, true, {
        category: entry.vatCategory,
        rate: effectiveAllowanceChargeRate(entry),
      }),
    ),
    // ram:SpecifiedTradePaymentTerms — schema order: ID, FromEventCode,
    // SettlementPeriodMeasure, Description, DueDateDateTime, TypeCode,
    // InstructionTypeCode, DirectDebitMandateID, …
    inv.paymentTerms || inv.dueDate || inv.payment?.directDebit?.mandateReference
      ? groupAlways("ram:SpecifiedTradePaymentTerms", [
          el("ram:Description", inv.paymentTerms),
          dateNode("ram:DueDateDateTime", inv.dueDate),
          el(
            "ram:DirectDebitMandateID",
            inv.payment?.directDebit?.mandateReference,
          ),
        ])
      : null,
    monetarySummation,
    ...(inv.precedingInvoices ?? []).map((reference) =>
      groupAlways("ram:InvoiceReferencedDocument", [
        el("ram:IssuerAssignedID", reference.invoiceNumber),
        formattedDateNode("ram:FormattedIssueDateTime", reference.issueDate),
      ]),
    ),
    inv.buyerAccountingReference
      ? groupAlways("ram:ReceivableSpecifiedTradeAccountingAccount", [
          el("ram:ID", inv.buyerAccountingReference),
        ])
      : null,
  ]);

  const root = groupAlways(
    "rsm:CrossIndustryInvoice",
    [
      groupAlways("rsm:ExchangedDocumentContext", [
        groupAlways("ram:BusinessProcessSpecifiedDocumentContextParameter", [
          el("ram:ID", profileId),
        ]),
        groupAlways("ram:GuidelineSpecifiedDocumentContextParameter", [
          el("ram:ID", customizationId),
        ]),
      ]),
      // rsm:ExchangedDocument — schema order: ID, Name, TypeCode, IssueDateTime,
      // …, IncludedNote, …
      groupAlways("rsm:ExchangedDocument", [
        el("ram:ID", inv.invoiceNumber),
        el("ram:TypeCode", typeCode),
        dateNode("ram:IssueDateTime", inv.issueDate),
        // BT-21 has a real element here. UBL has none, which is why its binding
        // prefixes the code onto the note text as "#CODE#…"; CII does not, and
        // writing the prefix into ram:Content would corrupt BT-22.
        //
        // …except on Peppol, which forbids the element outright. The second
        // half of PEPPOL-EN16931-CII R002 —
        //   count(ram:IncludedNote) <= 1 and not(ram:IncludedNote/ram:SubjectCode)
        // — is fatal, and its title ("No more than one note is allowed on
        // document level") does not mention it, which is how the 2026-08-14
        // conformance run found three committed CII fixtures tripping a
        // cardinality rule while carrying exactly one note. So BT-21 is dropped
        // under peppol-bis-3 and only under peppol-bis-3: every other CII
        // profile keeps it, because EN 16931, XRechnung and Factur-X all admit
        // it and silently discarding a business term for them would lose data
        // the caller supplied.
        //
        // **This drop is not silent.** `validateInput` reports
        // PEPPOL-EN16931-R002 as a warning on any `peppol-bis-3` input carrying
        // `noteSubjectCode`, naming this omission, so a caller learns the rule
        // before they generate rather than finding a business term missing from
        // the XML afterwards. Dropping it here is the second half of that pair:
        // the finding teaches, and this keeps the emitted document conformant
        // for a caller who generated without validating first. Throwing instead
        // was considered and rejected — it would fail a document over a field
        // Peppol's own mandatory syntax accepts, and BT-21 is optional in EN
        // 16931.

        inv.note === undefined
          ? null
          : groupAlways("ram:IncludedNote", [
              el("ram:Content", inv.note),
              inv.profile === "peppol-bis-3"
                ? null
                : el("ram:SubjectCode", inv.noteSubjectCode),
            ]),
      ]),
      groupAlways("rsm:SupplyChainTradeTransaction", [
        ...lines,
        agreement,
        delivery,
        settlement,
      ]),
    ],
    {
      "xmlns:rsm": NS.rsm,
      "xmlns:ram": NS.ram,
      "xmlns:qdt": NS.qdt,
      "xmlns:udt": NS.udt,
    },
  );

  return document(root, indent);
}
