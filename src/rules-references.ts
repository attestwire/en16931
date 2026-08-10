import {
  COUNTRY_CODES_SET,
  CURRENCY_CODES_SET,
  ICD_SCHEME_CODES,
  ICD_SCHEME_CODES_SET,
  ITEM_CLASSIFICATION_SCHEME_CODES,
  ITEM_CLASSIFICATION_SCHEME_CODES_SET,
  MIME_CODES,
  MIME_CODES_SET,
  NOTE_SUBJECT_CODES,
  NOTE_SUBJECT_CODES_SET,
  OBJECT_SCHEME_CODES,
  OBJECT_SCHEME_CODES_SET,
  VATEX_CODES,
  VATEX_CODES_SET,
  VAT_POINT_DATE_CODES,
  VAT_POINT_DATE_CODES_SET,
} from "./codelists/index.js";
import { DOCS, blank, decimalPlaces, err, isIsoDate, linesOf } from "./rule-kit.js";
import type { RuleFn } from "./rule-kit.js";
import type { BusinessTerm, InvoiceInput, TeachingError } from "./types.js";

/**
 * References, parties, periods and the second currency.
 *
 * This family covers the terms that were added to `InvoiceInput` in wave B and
 * had no rules until now: the payee (BG-10) and tax representative (BG-11), the
 * preceding invoice references (BG-3), the supporting documents (BG-24), the
 * item's own identifiers and attributes (BT-157, BT-158, BG-32), the two
 * invoicing periods (BG-14 and BG-26), and the VAT accounting currency pair
 * (BT-6 / BT-111). What ties them together is that all of them are *optional
 * groups that stop being optional once you open them*: EN 16931 is content to
 * let you omit a payee, and merciless about a payee that says nothing useful.
 * A half-filled group is worse than an absent one, because the receiver has to
 * decide whether the missing half is an omission or a statement.
 *
 * Rule texts from `ubl/schematron/abstract/EN16931-model.sch` and
 * `ubl/schematron/UBL/EN16931-UBL-model.sch`; code lists from
 * `ubl/schematron/codelist/EN16931-UBL-codes.sch`.
 * ConnectingEurope/eInvoicing-EN16931 @ validation-1.3.16.
 *
 * ---
 *
 * BR-01 (an invoice shall have a specification identifier, BT-24) is
 * deliberately NOT implemented here.
 *
 * The rule is real and it is the first thing every validator checks — BT-24 is
 * what tells the receiver which CIUS the document claims to follow, and a
 * document without it is not an EN 16931 invoice at all. But there is nothing
 * in this model to check: `generateXRechnungUBL` writes BT-24 from
 * `CUSTOMIZATION_IDS[profile]` on every document it emits, and the only way a
 * caller can influence it is `GenerateOptions.customizationId`, which is a
 * generation-time override that `validateInput` never sees. A rule here would
 * either never fire or would fire on an input field that does not exist. It
 * belongs to a future document-validation entry point, which reads the XML
 * rather than the input model. See CHANGELOG, "Deferred".
 */

/**
 * Case handling, mirroring `rules-codelists.ts`.
 *
 * Deliberately re-declared rather than imported: the two files are separate
 * rule families and a shared private helper between them would make one
 * family's message wording depend on the other's. `normalise` trims and
 * nothing else, because the schematron compares element content literally
 * after `normalize-space`.
 */
const normalise = (value: string): string => value.trim();

const wrongCaseHint = (value: string, set: ReadonlySet<string>): string =>
  set.has(value.trim().toUpperCase()) && value.trim() !== value.trim().toUpperCase()
    ? ` The upper-case form "${value.trim().toUpperCase()}" *is* in the list — the code list is case-sensitive and the schematron compares the element content literally, so lower-case fails.`
    : "";

/** ISO 6523 ICD codes worth naming, so a fix is actionable without the spec. */
const COMMON_ICD =
  '"0088" GLN, "0060" D-U-N-S, "0037" Finnish OVT, "0106" Dutch KvK/OIN, "0198" Danish CVR, "0204" German Leitweg-ID, "0002" French SIRENE';

/** UNTDID 1153 codes worth naming for an object identifier scheme. */
const COMMON_OBJECT_SCHEMES =
  '"CT" contract number, "ON" order number, "AAJ" delivery order number, "VN" vendor order number, "MG" meter number, "IV" invoice number';

/** The scheme identifier the EN 16931 UBL binding admits alongside the ICD list. */
const SEPA_SCHEME = "SEPA";

/** Absolute XPath of the nth `cac:AdditionalDocumentReference`, 1-based. */
const additionalDocumentReferencePath = (position: number): string =>
  `/ubl:Invoice/cac:AdditionalDocumentReference[${position}]`;

/**
 * Where a BG-24 entry lands among the `cac:AdditionalDocumentReference`
 * siblings. BT-18 shares that element and is emitted first, so a document
 * carrying an invoiced object identifier shifts every supporting document down
 * by one — and an XPath that ignores this points at the wrong element.
 */
const supportingDocumentPosition = (inv: InvoiceInput, index: number): number =>
  (inv.invoicedObjectIdentifier ? 1 : 0) + index + 1;

/** A scheme-identifier check against a code list, shared by the BR-CL rules. */
interface SchemeCheck {
  value: string | undefined;
  field: BusinessTerm;
  /** The sub-term actually constrained, e.g. "BT-29-1". Named in the message. */
  subTerm: string;
  what: string;
  setter: string;
  xpath: string;
  /** True where the UBL binding also admits `SEPA` (seller and payee only). */
  allowSepa?: boolean;
}

export const referenceRules: RuleFn[] = [
  // BR-17: The Payee name (BT-59) shall be provided in the Invoice, if the
  // Payee (BG-10) is different from the Seller (BG-4).
  //
  // The UBL binding is stronger than the prose, and this is the rule where
  // that matters: it asserts the name exists *and* that neither the name nor
  // the identifier equals the seller's. "Different from the seller" is not a
  // precondition you get to decide — it is part of the test.
  (inv) => {
    const payee = inv.payee;
    if (!payee) return null; // BG-10 is optional
    const out: TeachingError[] = [];

    if (blank(payee.name)) {
      out.push({
        rule: "BR-17",
        field: "BT-59",
        severity: "fatal",
        message:
          "The invoice carries a payee group (BG-10), so it must carry a payee name (BT-59). BG-10 exists for exactly one purpose: to say that the money goes somewhere other than to the seller — to a factor, a parent company, an insolvency administrator. An empty name states that redirection without naming the recipient, which is the one thing the buyer's payment run cannot act on, and which a bank will not accept as a payment instruction.",
        fix: "Set payee.name to the legal name of the party that is to receive the payment, or remove the payee object entirely if payment goes to the seller.",
        example: `"payee": { "name": "Factoring Nord GmbH" }`,
        xpath: "/ubl:Invoice/cac:PayeeParty/cac:PartyName/cbc:Name",
        docsUrl: `${DOCS}/BR-17`,
      });
    }

    // The generator writes the seller's trading name (BT-28) into
    // cac:PartyName/cbc:Name when one is given, so that — not the legal name —
    // is what the schematron compares the payee against.
    const sellerPartyName = normalise(
      inv.seller?.tradingName ?? inv.seller?.name ?? "",
    );
    const payeeName = normalise(payee.name ?? "");
    if (payeeName !== "" && sellerPartyName !== "" && payeeName === sellerPartyName) {
      out.push({
        rule: "BR-17",
        field: "BT-59",
        severity: "fatal",
        message: `The payee name (BT-59) is "${payeeName}", which is the same name the invoice carries for the seller. BG-10 may only be used when the payee differs from the seller (BG-4), and the UBL binding tests that literally: a payee whose name equals the seller's asserts a redirection of payment to the party that is already being paid. It is not merely redundant — it makes an auditor ask which of the two statements is the mistake.`,
        fix: "Remove the payee object when payment goes to the seller. Keep it only when the receiving party genuinely differs, and set payee.name to that party's own name — note that the comparison is against seller.tradingName when you set one, because that is what lands in cac:PartyName.",
        example: `"payee": { "name": "Factoring Nord GmbH" }`,
        xpath: "/ubl:Invoice/cac:PayeeParty/cac:PartyName/cbc:Name",
        docsUrl: `${DOCS}/BR-17`,
      });
    }

    const payeeId = normalise(payee.identifier?.value ?? "");
    const sellerId = normalise(inv.seller?.identifier?.value ?? "");
    if (payeeId !== "" && sellerId !== "" && payeeId === sellerId) {
      out.push({
        rule: "BR-17",
        field: "BT-60",
        severity: "fatal",
        message: `The payee identifier (BT-60) is "${payeeId}", which is the same identifier the invoice carries for the seller (BT-29). The UBL binding of BR-17 compares both the name and the identifier, so a payee that is distinguishable only by its label still fails: two party records sharing one GLN or one organisation number are one party, whatever they are called, and downstream reconciliation will treat them as such.`,
        fix: "Set payee.identifier.value to the receiving party's own identifier, or drop payee.identifier and rely on the name alone. If the seller really is the recipient, remove the payee object.",
        example: `"payee": { "name": "Factoring Nord GmbH", "identifier": { "schemeId": "0088", "value": "4304171000002" } }`,
        xpath: "/ubl:Invoice/cac:PayeeParty/cac:PartyIdentification/cbc:ID",
        docsUrl: `${DOCS}/BR-17`,
      });
    }

    return out;
  },

  // BR-18: The Seller tax representative name (BT-62) shall be provided in the
  // Invoice, if the Seller has a tax representative (BG-11).
  (inv) => {
    if (!inv.taxRepresentative) return null; // BG-11 is optional
    if (!blank(inv.taxRepresentative.name)) return null;
    return err({
      rule: "BR-18",
      field: "BT-62",
      severity: "fatal",
      message:
        "The invoice carries a seller tax representative group (BG-11), so it must carry the tax representative's name (BT-62). A fiscal representative is the party that answers to the tax authority for this supply in a member state where the seller is not established — the name is what makes that liability attach to somebody. An unnamed representative leaves the VAT with nobody to account for it, which is the situation the whole group exists to prevent.",
      fix: "Set taxRepresentative.name to the legal name of the fiscal representative, or remove the taxRepresentative object if the seller is registered directly.",
      example: `"taxRepresentative": { "name": "Fiscal Rep France SARL", "vatId": "FR12345678901" }`,
      xpath: "/ubl:Invoice/cac:TaxRepresentativeParty/cac:PartyName/cbc:Name",
      docsUrl: `${DOCS}/BR-18`,
    });
  },

  // BR-19: The Seller tax representative postal address (BG-12) shall be
  // provided in the Invoice, if the Seller has a tax representative (BG-11).
  (inv) => {
    const rep = inv.taxRepresentative;
    if (!rep) return null;
    if (rep.address) return null;
    return err({
      rule: "BR-19",
      field: "BG-12",
      severity: "fatal",
      message:
        "The invoice carries a seller tax representative group (BG-11), so it must carry the representative's postal address (BG-12). The address is not contact decoration: it is the evidence of *where* the representative is established, and therefore which tax administration the representation is effective in. A representative with no address cannot be shown to be established in the member state whose VAT is being accounted for.",
      fix: "Set taxRepresentative.address with at least city, postalCode and countryCode — the same PostalAddress shape the seller and buyer use.",
      example: `"taxRepresentative": { "name": "Fiscal Rep France SARL", "vatId": "FR12345678901", "address": { "city": "Lyon", "postalCode": "69001", "countryCode": "FR" } }`,
      xpath: "/ubl:Invoice/cac:TaxRepresentativeParty/cac:PostalAddress",
      docsUrl: `${DOCS}/BR-19`,
    });
  },

  // BR-20: The Seller tax representative postal address (BG-12) shall contain
  // a Tax representative country code (BT-69).
  (inv) => {
    const rep = inv.taxRepresentative;
    if (!rep?.address) return null; // BR-19 reports the absent address
    if (!blank(rep.address.countryCode)) return null;
    return err({
      rule: "BR-20",
      field: "BT-69",
      severity: "fatal",
      message:
        "The seller tax representative's postal address (BG-12) has no country code (BT-69). Of everything in that address, the country is the only element with legal effect: it is what identifies the member state in which the representation is registered, and so which authority's rules govern the VAT this invoice reports. A street and a city without a country name a place that the receiving system cannot resolve to a tax jurisdiction.",
      fix: "Set taxRepresentative.address.countryCode to the ISO 3166-1 alpha-2 code of the member state where the representative is established — \"FR\", \"IT\", \"ES\" and so on. It is normally the country of the VAT identifier in taxRepresentative.vatId.",
      example: `"address": { "city": "Lyon", "postalCode": "69001", "countryCode": "FR" }`,
      xpath: "/ubl:Invoice/cac:TaxRepresentativeParty/cac:PostalAddress/cac:Country/cbc:IdentificationCode",
      docsUrl: `${DOCS}/BR-20`,
    });
  },

  // BR-56: Each Seller tax representative party (BG-11) shall have a Seller
  // tax representative VAT identifier (BT-63).
  (inv) => {
    const rep = inv.taxRepresentative;
    if (!rep) return null;
    if (!blank(rep.vatId)) return null;
    return err({
      rule: "BR-56",
      field: "BT-63",
      severity: "fatal",
      message:
        "The seller tax representative (BG-11) has no VAT identifier (BT-63). The representative's VAT number is the operative field of the whole group — it is the registration under which the VAT on this supply is declared and paid, and the number the buyer's own return will quote when reclaiming input tax. The name and address identify who they are; only the VAT identifier says what they are registered as, and the UBL binding looks for it specifically under a PartyTaxScheme whose scheme is VAT.",
      fix: "Set taxRepresentative.vatId to the representative's VAT identifier including its country prefix (\"FR12345678901\"), not to the seller's own VAT number.",
      example: `"taxRepresentative": { "name": "Fiscal Rep France SARL", "vatId": "FR12345678901" }`,
      xpath: "/ubl:Invoice/cac:TaxRepresentativeParty/cac:PartyTaxScheme/cbc:CompanyID",
      docsUrl: `${DOCS}/BR-56`,
    });
  },

  // BR-55: Each Preceding Invoice reference (BG-3) shall contain a Preceding
  // Invoice reference (BT-25).
  (inv) => {
    const out: TeachingError[] = [];
    for (const [index, reference] of (inv.precedingInvoices ?? []).entries()) {
      if (!reference) continue;
      if (!blank(reference.invoiceNumber)) continue;
      out.push({
        rule: "BR-55",
        field: "BT-25",
        severity: "fatal",
        message: `Preceding invoice reference ${index + 1} (BG-3) carries no invoice number (BT-25)${reference.issueDate ? `, only an issue date of "${reference.issueDate}"` : ""}. BG-3 is how a corrective or partial invoice says which document it adjusts, and the number is the only part of it that identifies one. A date alone does not: a seller who issued four invoices that day has said nothing. Without BT-25 the buyer cannot net the correction against the original, and your own VAT return cannot show which period the adjustment belongs to.`,
        fix: "Set precedingInvoices[].invoiceNumber to the BT-1 of the invoice being corrected or referenced, exactly as it was issued. Add issueDate (BT-26) alongside it when your numbering is not unique across years.",
        example: `"precedingInvoices": [{ "invoiceNumber": "2026-000141", "issueDate": "2026-07-31" }]`,
        xpath: `/ubl:Invoice/cac:BillingReference[${index + 1}]/cac:InvoiceDocumentReference/cbc:ID`,
        docsUrl: `${DOCS}/BR-55`,
      });
    }
    return out;
  },

  // BR-52: Each Additional supporting document (BG-24) shall contain a
  // Supporting document reference (BT-122).
  (inv) => {
    const out: TeachingError[] = [];
    for (const [index, doc] of (inv.supportingDocuments ?? []).entries()) {
      if (!doc) continue;
      if (!blank(doc.reference)) continue;
      const position = supportingDocumentPosition(inv, index);
      out.push({
        rule: "BR-52",
        field: "BT-122",
        severity: "fatal",
        message: `Supporting document ${index + 1} (BG-24) has no supporting document reference (BT-122)${doc.attachment?.filename ? `, although it does carry the attachment "${doc.attachment.filename}"` : ""}. BT-122 is the identifier the attachment is filed under — a timesheet number, a delivery note number, a contract reference — and it is what lets a reviewer years later connect the file to the thing it evidences. An attachment with a filename and no reference is a document nobody can cite.`,
        fix: "Set supportingDocuments[].reference to the identifier of the document you are attaching or pointing at. Use description (BT-123) for the human-readable label, not for the reference.",
        example: `"supportingDocuments": [{ "reference": "TS-2026-07", "description": "Timesheet July 2026" }]`,
        xpath: `${additionalDocumentReferencePath(position)}/cbc:ID`,
        docsUrl: `${DOCS}/BR-52`,
      });
    }
    return out;
  },

  // BR-51: In accordance with card payments security standards an invoice
  // should never include a full card primary account number (BT-87).
  //
  // Flagged `warning` in the reference schematron, and we keep it there: an
  // invoice carrying a full PAN is accepted by every validator and is still a
  // reportable incident.
  (inv) => {
    const pan = inv.payment?.card?.primaryAccountNumber;
    if (blank(pan)) return null; // BG-18 without a PAN is BR-DE-23's business
    const trimmed = normalise(pan!);
    if (trimmed.length <= 10) return null;
    return err({
      rule: "BR-51",
      field: "BT-87",
      severity: "warning",
      message: `The payment card primary account number (BT-87) is ${trimmed.length} characters long, and BR-51 admits at most 10. The PCI Security Standards Council permits an invoice to show the first six digits and the last four and nothing else, which is where the ten comes from. This is a warning rather than an error, so the document will be accepted — but an invoice is forwarded, archived, printed and emailed by people who never think of it as cardholder data, and a full PAN inside one puts every system it touches into PCI DSS scope. If it leaks, the disclosure obligation and the card-scheme fines are yours, not the validator's.`,
      fix: 'Truncate before you build the payload: set payment.card.primaryAccountNumber to the first six and last four digits only, e.g. "411111" + "1111" as "4111111111", or simply the last four. Never store or transmit the full number here.',
      example: `"card": { "primaryAccountNumber": "4111111111", "holderName": "M Mustermann" }`,
      xpath: "/ubl:Invoice/cac:PaymentMeans/cac:CardAccount/cbc:PrimaryAccountNumberID",
      docsUrl: `${DOCS}/BR-51`,
    });
  },

  // BR-54: Each Item attribute (BG-32) shall contain an Item attribute name
  // (BT-160) and an Item attribute value (BT-161).
  (inv) => {
    const out: TeachingError[] = [];
    for (const [lineIndex, line] of linesOf(inv).entries()) {
      for (const [attrIndex, attribute] of (line?.itemAttributes ?? []).entries()) {
        if (!attribute) continue;
        const nameMissing = blank(attribute.name);
        const valueMissing = blank(attribute.value);
        if (!nameMissing && !valueMissing) continue;
        const missing = nameMissing && valueMissing
          ? "neither a name (BT-160) nor a value (BT-161)"
          : nameMissing
            ? `no name (BT-160) — only the value "${normalise(attribute.value)}"`
            : `no value (BT-161) — only the name "${normalise(attribute.name)}"`;
        out.push({
          rule: "BR-54",
          field: ["BT-160", "BT-161"],
          severity: "fatal",
          message: `Item attribute ${attrIndex + 1} on line ${lineIndex + 1} has ${missing}. BG-32 is a name/value pair and EN 16931 requires both halves, because half a pair carries no information at all: a value with no name is a number nobody can interpret, and a name with no value is a question. These attributes are what a buyer's catalogue matching reads to confirm that the thing invoiced is the thing ordered — colour, capacity, licence term — so an unmatched half silently breaks that check rather than failing it visibly.`,
          fix: "Give every entry in line.itemAttributes both a name and a value, or drop the entry. Put unstructured detail in line.longDescription (BT-154) instead.",
          example: `"itemAttributes": [{ "name": "Farbe", "value": "anthrazit" }]`,
          xpath: `/ubl:Invoice/cac:InvoiceLine[${lineIndex + 1}]/cac:Item/cac:AdditionalItemProperty[${attrIndex + 1}]/cbc:Name`,
          docsUrl: `${DOCS}/BR-54`,
        });
      }
    }
    return out;
  },

  // BR-64: The Item standard identifier (BT-157) shall have a Scheme
  // identifier.
  (inv) => {
    const out: TeachingError[] = [];
    for (const [index, line] of linesOf(inv).entries()) {
      const standard = line?.standardItemId;
      if (!standard) continue;
      if (blank(standard.value)) continue; // nothing is emitted for an empty id
      if (!blank(standard.schemeId)) continue;
      out.push({
        rule: "BR-64",
        field: "BT-157",
        severity: "fatal",
        message: `Line ${index + 1} carries an item standard identifier (BT-157) of "${normalise(standard.value)}" with no scheme identifier (BT-157-1). A standard identifier is only "standard" relative to a registry: the same digits can be a GTIN, a national article number or a manufacturer's own code, and the receiver has no way to look the item up — or to detect that it has looked up the wrong one — without being told which registry to ask. EN 16931 therefore makes the scheme mandatory whenever the identifier is present, and the UBL binding asserts the @schemeID attribute directly.`,
        fix: `Set line.standardItemId.schemeId to the ISO 6523 ICD code of the registry — "0160" for a GTIN, "0088" for a GLN-based article number. Use line.sellerItemId (BT-155) or line.buyerItemId (BT-156) instead if the code is your own rather than a registered one.`,
        example: `"standardItemId": { "schemeId": "0160", "value": "04012345678901" }`,
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:Item/cac:StandardItemIdentification/cbc:ID/@schemeID`,
        docsUrl: `${DOCS}/BR-64`,
      });
    }
    return out;
  },

  // BR-65: The Item classification identifier (BT-158) shall have a Scheme
  // identifier.
  (inv) => {
    const out: TeachingError[] = [];
    for (const [lineIndex, line] of linesOf(inv).entries()) {
      for (const [classIndex, classification] of (
        line?.itemClassifications ?? []
      ).entries()) {
        if (!classification) continue;
        if (blank(classification.code)) continue;
        if (!blank(classification.schemeId)) continue;
        out.push({
          rule: "BR-65",
          field: "BT-158",
          severity: "fatal",
          message: `Classification ${classIndex + 1} on line ${lineIndex + 1} carries an item classification identifier (BT-158) of "${normalise(classification.code)}" with no scheme identifier (BT-158-1). Classification codes are not self-describing and they collide freely across systems — a bare "43211508" is a UNSPSC commodity to one reader and a customs heading to another. The scheme is what makes the code resolvable, and it is what a buyer's spend-analysis or a customs declaration reads before the code itself.`,
          fix: `Set line.itemClassifications[].schemeId to the UNTDID 7143 code of the classification system — "HS" harmonised system, "MP" product/service identification number, "SRV" GS1 product classification, "ZZZ" mutually defined. Add schemeVersion (BT-158-2) when the system is versioned.`,
          example: `"itemClassifications": [{ "code": "43211508", "schemeId": "MP" }]`,
          xpath: `/ubl:Invoice/cac:InvoiceLine[${lineIndex + 1}]/cac:Item/cac:CommodityClassification[${classIndex + 1}]/cbc:ItemClassificationCode/@listID`,
          docsUrl: `${DOCS}/BR-65`,
        });
      }
    }
    return out;
  },

  // BR-CO-19: If Invoicing period (BG-14) is used, the Invoicing period start
  // date (BT-73) or the Invoicing period end date (BT-74) shall be filled, or
  // both.
  //
  // The UBL binding adds an escape the abstract rule does not have: a period
  // carrying only a DescriptionCode (BT-8) and no dates satisfies it, because
  // that is how the tax point date code is bound in UBL — it has nowhere else
  // to live but cac:InvoicePeriod.
  (inv) => {
    const period = inv.invoicingPeriod;
    if (!period) return null; // BG-14 is optional
    if (!blank(period.startDate) || !blank(period.endDate)) return null;
    if (!blank(period.descriptionCode)) return null; // the BT-8-only form is legal
    return err({
      rule: "BR-CO-19",
      field: "BG-14",
      severity: "fatal",
      message:
        "The invoice carries an invoicing period (BG-14) with neither a start date (BT-73), an end date (BT-74) nor a tax point date code (BT-8). An empty period asserts that the supply relates to a timeframe and then declines to say which — and the timeframe is what a periodic invoice is *for*: it is how the buyer accrues the cost to the right month and how both sides detect a gap or an overlap between consecutive invoices. Note that a period carrying only the description code is legal in the UBL binding, because BT-8 has nowhere else to live; a period carrying nothing at all is not.",
      fix: "Set invoicingPeriod.startDate, invoicingPeriod.endDate, or both, as ISO dates. Remove the invoicingPeriod object entirely if the supply is a one-off with a delivery date (BT-72) rather than a period.",
      example: `"invoicingPeriod": { "startDate": "2026-07-01", "endDate": "2026-07-31" }`,
      xpath: "/ubl:Invoice/cac:InvoicePeriod",
      docsUrl: `${DOCS}/BR-CO-19`,
    });
  },

  // BR-29: If both Invoicing period start date (BT-73) and Invoicing period
  // end date (BT-74) are given, the end date shall be later or equal to the
  // start date.
  //
  // The schematron casts both with xs:date before comparing, so a value that
  // is not a well-formed calendar date is a validity failure in its own right
  // — the XPath raises rather than returning false, which is reported against
  // this same rule id.
  (inv) => {
    const period = inv.invoicingPeriod;
    if (!period) return null;
    const out: TeachingError[] = [];
    const checkFormat = (
      value: string | undefined,
      field: "BT-73" | "BT-74",
      label: string,
      setter: string,
      element: string,
    ): boolean => {
      if (blank(value)) return false;
      if (isIsoDate(value)) return true;
      out.push({
        rule: "BR-29",
        field,
        severity: "fatal",
        message: `The invoicing period ${label} (${field}) is "${normalise(value!)}", which is not a calendar date. UBL types cbc:${element} as xs:date, so the only accepted form is YYYY-MM-DD — "31.07.2026", "07/31/2026" and "2026-07-32" are all rejected, the first two because they are the wrong syntax and the last because it names a day that does not exist. BR-29 compares the two dates by casting them with xs:date, and a cast that fails takes the whole comparison down with it rather than returning a clean false.`,
        fix: `Set ${setter} to an ISO 8601 calendar date, zero-padded, with no time part and no timezone — "2026-07-31".`,
        example: `"invoicingPeriod": { "startDate": "2026-07-01", "endDate": "2026-07-31" }`,
        xpath: `/ubl:Invoice/cac:InvoicePeriod/cbc:${element}`,
        docsUrl: `${DOCS}/BR-29`,
      });
      return false;
    };

    const startOk = checkFormat(
      period.startDate,
      "BT-73",
      "start date",
      "invoicingPeriod.startDate",
      "StartDate",
    );
    const endOk = checkFormat(
      period.endDate,
      "BT-74",
      "end date",
      "invoicingPeriod.endDate",
      "EndDate",
    );

    if (startOk && endOk && normalise(period.endDate!) < normalise(period.startDate!)) {
      out.push({
        rule: "BR-29",
        field: ["BT-73", "BT-74"],
        severity: "fatal",
        message: `The invoicing period runs from "${normalise(period.startDate!)}" (BT-73) to "${normalise(period.endDate!)}" (BT-74), which ends before it starts. EN 16931 requires the end date to be later than or equal to the start date; equal is allowed, because a single-day period is a real thing. An inverted period is almost always two fields transposed, and it is worth catching here rather than downstream: a consumer that computes a duration from it gets a negative number and either books the accrual to the wrong period or divides by it.`,
        fix: "Swap invoicingPeriod.startDate and invoicingPeriod.endDate, or correct whichever of the two is wrong. Use the same date in both fields for a period of one day.",
        example: `"invoicingPeriod": { "startDate": "2026-07-01", "endDate": "2026-07-31" }`,
        xpath: "/ubl:Invoice/cac:InvoicePeriod/cbc:EndDate",
        docsUrl: `${DOCS}/BR-29`,
      });
    }
    return out;
  },

  // BR-CO-20: If Invoice line period (BG-26) is used, the Invoice line period
  // start date (BT-134) or the Invoice line period end date (BT-135) shall be
  // filled, or both.
  //
  // No description-code escape here: BT-8 is a document level term, so a line
  // period has nothing to carry but its dates.
  (inv) => {
    const out: TeachingError[] = [];
    for (const [index, line] of linesOf(inv).entries()) {
      const period = line?.period;
      if (!period) continue;
      if (!blank(period.startDate) || !blank(period.endDate)) continue;
      out.push({
        rule: "BR-CO-20",
        field: "BG-26",
        severity: "fatal",
        message: `Line ${index + 1} carries an invoice line period (BG-26) with neither a start date (BT-134) nor an end date (BT-135). Unlike the document level period (BG-14), a line period has no legal empty form: BT-8, the tax point date code that lets BG-14 exist without dates, is a document term and has no line equivalent, so a line period with no dates conveys nothing whatsoever. A line period exists to say that this line covers a different timeframe from the rest of the invoice — omit the group and the line simply inherits BG-14, which is usually what you want.`,
        fix: "Set line.period.startDate, line.period.endDate, or both, or remove line.period so the line falls back to the document level invoicing period. Note that line.period.descriptionCode is ignored at line level.",
        example: `"period": { "startDate": "2026-07-01", "endDate": "2026-07-15" }`,
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:InvoicePeriod`,
        docsUrl: `${DOCS}/BR-CO-20`,
      });
    }
    return out;
  },

  // BR-30: If both Invoice line period start date (BT-134) and Invoice line
  // period end date (BT-135) are given, the end date shall be later or equal
  // to the start date. Same xs:date cast, same consequence for a malformed
  // value, reported under this rule id.
  (inv) => {
    const out: TeachingError[] = [];
    for (const [index, line] of linesOf(inv).entries()) {
      const period = line?.period;
      if (!period) continue;
      const checkFormat = (
        value: string | undefined,
        field: "BT-134" | "BT-135",
        label: string,
        setter: string,
        element: string,
      ): boolean => {
        if (blank(value)) return false;
        if (isIsoDate(value)) return true;
        out.push({
          rule: "BR-30",
          field,
          severity: "fatal",
          message: `Line ${index + 1} has an invoice line period ${label} (${field}) of "${normalise(value!)}", which is not a calendar date. UBL types cbc:${element} as xs:date and accepts nothing but YYYY-MM-DD — a local format such as "31.07.2026", a timestamp, or a syntactically fine date naming a day that does not exist are all rejected. BR-30 casts both endpoints with xs:date before comparing them, so a malformed value fails the rule before the ordering is ever evaluated.`,
          fix: `Set ${setter} to an ISO 8601 calendar date, zero-padded, with no time part and no timezone — "2026-07-31".`,
          example: `"period": { "startDate": "2026-07-01", "endDate": "2026-07-15" }`,
          xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:InvoicePeriod/cbc:${element}`,
          docsUrl: `${DOCS}/BR-30`,
        });
        return false;
      };

      const startOk = checkFormat(
        period.startDate,
        "BT-134",
        "start date",
        "line.period.startDate",
        "StartDate",
      );
      const endOk = checkFormat(
        period.endDate,
        "BT-135",
        "end date",
        "line.period.endDate",
        "EndDate",
      );

      if (startOk && endOk && normalise(period.endDate!) < normalise(period.startDate!)) {
        out.push({
          rule: "BR-30",
          field: ["BT-134", "BT-135"],
          severity: "fatal",
          message: `Line ${index + 1} has an invoice line period running from "${normalise(period.startDate!)}" (BT-134) to "${normalise(period.endDate!)}" (BT-135), which ends before it starts. The end must be later than or equal to the start; a single-day period with both dates equal is fine. Line periods are the field most often built by slicing a billing run programmatically, which is exactly the code path where an off-by-one on the boundary produces an inverted period rather than an obviously wrong one.`,
          fix: "Swap line.period.startDate and line.period.endDate, or correct whichever is wrong. Check the loop that generates the slice if several lines are affected.",
          example: `"period": { "startDate": "2026-07-01", "endDate": "2026-07-15" }`,
          xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:InvoicePeriod/cbc:EndDate`,
          docsUrl: `${DOCS}/BR-30`,
        });
      }
    }
    return out;
  },

  // BR-CO-03: Value added tax point date (BT-7) and Value added tax point date
  // code (BT-8) are mutually exclusive.
  (inv) => {
    const hasDate = !blank(inv.taxPointDate);
    const hasCode = !blank(inv.invoicingPeriod?.descriptionCode);
    if (!hasDate || !hasCode) return null;
    return err({
      rule: "BR-CO-03",
      field: ["BT-7", "BT-8"],
      severity: "fatal",
      message: `The invoice states the VAT point both as an explicit date (BT-7 = "${normalise(inv.taxPointDate!)}") and as a code (BT-8 = "${normalise(inv.invoicingPeriod!.descriptionCode!)}"), and EN 16931 allows only one of the two. The tax point decides which VAT period the supply falls into and which rate applies if a rate changed — so two statements of it are two potentially different answers to a question that has one. The code form delegates the answer to a rule ("the invoice date", "the actual delivery date"); the date form states it outright. Pick the one your tax treatment actually rests on.`,
      fix: "Remove taxPointDate, or remove invoicingPeriod.descriptionCode — not both fields, one of them. Use the code when the tax point is derived by a standing rule, and the explicit date when it is not.",
      example: `"taxPointDate": "2026-07-31"`,
      xpath: "/ubl:Invoice/cbc:TaxPointDate",
      docsUrl: `${DOCS}/BR-CO-03`,
    });
  },

  // BR-53: If the VAT accounting currency code (BT-6) is present, then the
  // Invoice total VAT amount in accounting currency (BT-111) shall be
  // provided.
  //
  // The reverse — BT-111 with no BT-6 — is not a separate rule in the
  // schematron, because in UBL it cannot be expressed: BR-53's test looks for a
  // TaxTotal whose @currencyID equals the TaxCurrencyCode, and with no
  // TaxCurrencyCode there is nothing to match against. We report it here
  // anyway, under BR-53, because the input is meaningless and this build's
  // generator would silently drop the amount.
  (inv) => {
    const currency = inv.vatAccountingCurrency;
    const amount = inv.taxAmountInAccountingCurrency;
    if (!blank(currency) && amount === undefined) {
      return err({
        rule: "BR-53",
        field: "BT-111",
        severity: "fatal",
        message: `The invoice declares a VAT accounting currency (BT-6 = "${normalise(currency!)}"), so it must also state the invoice total VAT amount in that currency (BT-111). BT-6 exists for the case where VAT is invoiced in one currency and must be *accounted for* in another — a euro invoice from a seller who reports VAT in Polish złoty, say. Declaring the currency and omitting the amount tells the tax authority which currency the figure will be in without giving them the figure. This library cannot derive it: it depends on the exchange rate the authority prescribes for the tax point, which is not on the invoice.`,
        fix: "Set taxAmountInAccountingCurrency to the total VAT converted at the rate your tax authority prescribes for the tax point, rounded to 2 decimals. Remove vatAccountingCurrency if VAT is accounted for in the invoice currency.",
        example: `"vatAccountingCurrency": "PLN", "taxAmountInAccountingCurrency": 1218.45`,
        xpath: "/ubl:Invoice/cac:TaxTotal[2]/cbc:TaxAmount",
        docsUrl: `${DOCS}/BR-53`,
      });
    }
    if (blank(currency) && amount !== undefined) {
      return err({
        rule: "BR-53",
        field: "BT-6",
        severity: "fatal",
        message: `The invoice states a VAT amount in the accounting currency (BT-111 = ${amount}) but no VAT accounting currency code (BT-6), which leaves an amount denominated in nothing. This half of the pair is not a separate rule in the reference schematron — its BR-53 test looks for a TaxTotal whose currencyID equals BT-6, and with no BT-6 there is nothing to look for, so the omission passes silently — but it is reported here under BR-53 because the two terms are one statement. This build's generator emits the second TaxTotal only when both are present, so the amount you supplied would simply vanish from the document.`,
        fix: "Set vatAccountingCurrency to the ISO 4217 code the VAT is accounted for in, or remove taxAmountInAccountingCurrency. Do not reuse the invoice currency here — BT-6 is only meaningful when it differs from BT-5.",
        example: `"vatAccountingCurrency": "PLN", "taxAmountInAccountingCurrency": 1218.45`,
        xpath: "/ubl:Invoice/cbc:TaxCurrencyCode",
        docsUrl: `${DOCS}/BR-53`,
      });
    }
    return null;
  },

  // BR-CL-05: Tax currency code MUST be coded using ISO code list 4217
  // alpha-3.
  (inv) => {
    if (blank(inv.vatAccountingCurrency)) return null; // optional term
    const code = normalise(inv.vatAccountingCurrency!);
    if (CURRENCY_CODES_SET.has(code)) return null;
    return err({
      rule: "BR-CL-05",
      field: "BT-6",
      severity: "fatal",
      message: `The VAT accounting currency code (BT-6) must be an ISO 4217 alphabetic code, but "${code}" is not one.${wrongCaseHint(inv.vatAccountingCurrency!, CURRENCY_CODES_SET)} It is the same list BT-5 is drawn from and it is checked just as strictly — three letters is a shape, not a membership. This code is also load-bearing beyond its own field: the generator writes it into the @currencyID of the second cac:TaxTotal, and BR-53 and BR-DEC-15 both find BT-111 by matching that attribute against this value, so a code that fails here takes those two rules down with it.`,
      fix: `Set vatAccountingCurrency to the ISO 4217 alpha-3 code in upper case — "PLN", "SEK", "DKK", "CZK", "HUF", "RON". Use the code, never the symbol or the name, and only set the field at all when VAT is accounted for in a currency other than the invoice currency.`,
      example: `"vatAccountingCurrency": "PLN", "taxAmountInAccountingCurrency": 1218.45`,
      xpath: "/ubl:Invoice/cbc:TaxCurrencyCode",
      docsUrl: `${DOCS}/BR-CL-05`,
    });
  },

  // BR-DEC-15: The allowed maximum number of decimals for the Invoice total
  // VAT amount in accounting currency (BT-111) is 2.
  (inv) => {
    const amount = inv.taxAmountInAccountingCurrency;
    if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
    const places = decimalPlaces(amount);
    if (places <= 2) return null;
    return err({
      rule: "BR-DEC-15",
      field: "BT-111",
      severity: "fatal",
      message: `The invoice total VAT amount in accounting currency (BT-111) is ${amount}, which carries ${places} decimals; EN 16931 allows at most 2. The limit applies to the value as serialised, and it is not cosmetic — it is what makes the figure a *statement of tax due* rather than an intermediate result. Converted amounts are where this goes wrong most often: multiplying by an exchange rate produces as many decimals as the rate has, and the rounding has to happen before the amount reaches the document, not after.`,
      fix: "Round taxAmountInAccountingCurrency to 2 decimals yourself, using the rounding rule your tax authority prescribes for the conversion — which rounding is correct is a tax question rather than an arithmetic one, and only you know the answer. The generator will not let an over-precise value reach the XML (it writes every amount through formatAmount, which rounds half-up to 2 decimals), but that means it would silently substitute its own answer for yours, so fix the figure at source rather than relying on it.",
      example: `"vatAccountingCurrency": "PLN", "taxAmountInAccountingCurrency": 1218.45`,
      xpath: "/ubl:Invoice/cac:TaxTotal[2]/cbc:TaxAmount",
      docsUrl: `${DOCS}/BR-DEC-15`,
    });
  },

  // BR-DEC-16: The allowed maximum number of decimals for the Paid amount
  // (BT-113) is 2.
  (inv) => {
    const amount = inv.paidAmount;
    if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
    const places = decimalPlaces(amount);
    if (places <= 2) return null;
    return err({
      rule: "BR-DEC-16",
      field: "BT-113",
      severity: "fatal",
      message: `The paid amount (BT-113) is ${amount}, which carries ${places} decimals; EN 16931 allows at most 2. BT-113 is money that has already moved — a deposit, a prepayment, a part-settlement — so it is by definition a figure some bank has already booked to the cent, and a value with more precision than that describes a payment nobody made. It also feeds BT-115 directly (BR-CO-16 derives the amount due from it), so the extra digits propagate into the one number the buyer actually pays.`,
      fix: "Round paidAmount to 2 decimals, taking the value from the payment record rather than recomputing it from a percentage of the invoice total.",
      example: `"paidAmount": 500.00`,
      xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:PrepaidAmount",
      docsUrl: `${DOCS}/BR-DEC-16`,
    });
  },

  // BR-DEC-17: The allowed maximum number of decimals for the Rounding amount
  // (BT-114) is 2.
  (inv) => {
    const amount = inv.roundingAmount;
    if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
    const places = decimalPlaces(amount);
    if (places <= 2) return null;
    return err({
      rule: "BR-DEC-17",
      field: "BT-114",
      severity: "fatal",
      message: `The rounding amount (BT-114) is ${amount}, which carries ${places} decimals; EN 16931 allows at most 2. BT-114 is the small correction added to make the payable amount a convenient figure — a few cents up or down, or the five-cent rounding some cash regimes require — so a rounding amount that is itself unrounded is a contradiction in terms, and one that leaves BT-115 no rounder than it started. The value may be negative; only the precision is constrained.`,
      fix: "Round roundingAmount to 2 decimals. Derive it as the difference between the rounded payable figure and BT-112 minus BT-113, rather than carrying an unrounded remainder into the field.",
      example: `"roundingAmount": -0.03`,
      xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:PayableRoundingAmount",
      docsUrl: `${DOCS}/BR-DEC-17`,
    });
  },

  // BR-CL-06: Value added tax point date code MUST be coded using a
  // restriction of UNTDID 2005.
  (inv) => {
    const code = inv.invoicingPeriod?.descriptionCode;
    if (blank(code)) return null;
    if (VAT_POINT_DATE_CODES_SET.has(normalise(code!))) return null;
    return err({
      rule: "BR-CL-06",
      field: "BT-8",
      severity: "fatal",
      message: `The VAT point date code (BT-8) is "${normalise(code!)}", which is not one of the ${VAT_POINT_DATE_CODES.length} codes EN 16931 admits. UNTDID 2005 is a large list of date qualifiers and the standard restricts it to exactly three: "3" the invoice date, "35" the actual delivery date, and "432" paid to date. The code is not a label for the period — it says which event determines the tax point, and therefore which VAT period and which rate the supply falls under. Anything outside the three leaves that undetermined.`,
      fix: `Set invoicingPeriod.descriptionCode to "3" (tax point is the invoice issue date), "35" (the actual delivery date) or "432" (paid to date). If you know the tax point as a date rather than as a rule, use taxPointDate (BT-7) instead — but not both, which BR-CO-03 forbids.`,
      example: `"invoicingPeriod": { "descriptionCode": "35" }`,
      xpath: "/ubl:Invoice/cac:InvoicePeriod/cbc:DescriptionCode",
      docsUrl: `${DOCS}/BR-CL-06`,
    });
  },

  // BR-CL-07: Object identifier identification scheme identifier MUST be coded
  // using a restriction of UNTDID 1153. Bound to both the document level BT-18
  // and the line level BT-128.
  (inv) => {
    const out: TeachingError[] = [];
    const check = (
      schemeId: string | undefined,
      field: BusinessTerm,
      subTerm: string,
      where: string,
      setter: string,
      xpath: string,
    ) => {
      if (blank(schemeId)) return; // BR-CL-07 only binds cbc:ID[@schemeID]
      const code = normalise(schemeId!);
      if (OBJECT_SCHEME_CODES_SET.has(code)) return;
      out.push({
        rule: "BR-CL-07",
        field,
        severity: "fatal",
        message: `The scheme identifier on the ${where} object identifier (${subTerm}) is "${code}", which is not in the UNTDID 1153 restriction EN 16931 applies — ${OBJECT_SCHEME_CODES.length} codes, so a plausible-looking abbreviation is very unlikely to be one of them by accident. The object identifier says what the invoice is *about* when that is not a purchase order: a contract, a meter, a vehicle, a case file. Without a scheme the receiver has a string; with the wrong scheme it has a string it will confidently misinterpret.${wrongCaseHint(schemeId!, OBJECT_SCHEME_CODES_SET)}`,
        fix: `Set ${setter} to a UNTDID 1153 reference qualifier: ${COMMON_OBJECT_SCHEMES}. Omit the scheme entirely rather than inventing one — the identifier is then emitted without @schemeID, which this rule does not bind.`,
        example:
          field === "BT-18"
            ? `"invoicedObjectIdentifier": { "schemeId": "MG", "value": "1234567890" }`
            : `"lines": [{ "objectIdentifier": { "schemeId": "MG", "value": "1234567890" } }]`,
        xpath,
        docsUrl: `${DOCS}/BR-CL-07`,
      });
    };

    check(
      inv.invoicedObjectIdentifier?.schemeId,
      "BT-18",
      "BT-18-1",
      "invoiced",
      "invoicedObjectIdentifier.schemeId",
      "/ubl:Invoice/cac:AdditionalDocumentReference/cbc:ID/@schemeID",
    );
    for (const [index, line] of linesOf(inv).entries()) {
      check(
        line?.objectIdentifier?.schemeId,
        "BT-128",
        "BT-128-1",
        `line ${index + 1}`,
        "line.objectIdentifier.schemeId",
        `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:DocumentReference/cbc:ID/@schemeID`,
      );
    }
    return out;
  },

  // BR-CL-08: Invoiced note subject code shall be coded using UNCL4451.
  (inv) => {
    const code = inv.noteSubjectCode;
    if (blank(code)) return null;
    const value = normalise(code!);
    if (NOTE_SUBJECT_CODES_SET.has(value)) return null;
    const lengthNote =
      value.length === 3
        ? ""
        : ` Worse, it is ${value.length} characters rather than three: the schematron only applies its test when the code embedded in the note is exactly three characters long, so a code of this length is silently ignored by KoSIT and passes validation while still being wrong. A downstream reader that parses the prefix will take "${value}" as the subject qualifier and find nothing behind it.`;
    const emissionNote =
      inv.note === undefined
        ? " Note also that this build only emits the code when a note (BT-22) is present — with no note there is nothing for it to prefix, and the code is dropped entirely."
        : "";
    return err({
      rule: "BR-CL-08",
      field: "BT-21",
      severity: "fatal",
      message: `The invoice note subject code (BT-21) is "${value}", which is not in UNCL 4451 (${NOTE_SUBJECT_CODES.length} codes).${lengthNote} UBL has no element for BT-21 at all: EN 16931's binding prefixes the code onto the note itself, so this library writes cbc:Note as "#${value}#" followed by your note text, and the validator parses it back out of that string.${emissionNote}${wrongCaseHint(code!, NOTE_SUBJECT_CODES_SET)}`,
      fix: `Set noteSubjectCode to a three-letter UNCL 4451 qualifier — "AAI" general information, "REG" regulatory information, "ABL" governing law, "TXD" tax declaration, "PMT" payment information, "ACB" additional information. Leave it unset if the note needs no subject; a plain note is perfectly valid.`,
      example: `"note": "Leistungszeitraum Juli 2026", "noteSubjectCode": "AAI"`,
      xpath: "/ubl:Invoice/cbc:Note",
      docsUrl: `${DOCS}/BR-CL-08`,
    });
  },

  // BR-CL-10: Any identifier identification scheme identifier MUST be coded
  // using one of the ISO 6523 ICD list. Bound to cac:PartyIdentification/
  // cbc:ID[@schemeID] — seller (BT-29-1), buyer (BT-46-1), payee (BT-60-1).
  //
  // The UBL binding also admits "SEPA", but only under the supplier or the
  // payee: that is where the SEPA creditor identifier (BT-90) lives.
  (inv) => {
    const checks: SchemeCheck[] = [
      {
        value: inv.seller?.identifier?.schemeId,
        field: "BT-29",
        subTerm: "BT-29-1",
        what: "seller identifier",
        setter: "seller.identifier.schemeId",
        xpath: "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyIdentification/cbc:ID/@schemeID",
        allowSepa: true,
      },
      {
        value: inv.buyer?.identifier?.schemeId,
        field: "BT-46",
        subTerm: "BT-46-1",
        what: "buyer identifier",
        setter: "buyer.identifier.schemeId",
        xpath: "/ubl:Invoice/cac:AccountingCustomerParty/cac:Party/cac:PartyIdentification/cbc:ID/@schemeID",
      },
      {
        value: inv.payee?.identifier?.schemeId,
        field: "BT-60",
        subTerm: "BT-60-1",
        what: "payee identifier",
        setter: "payee.identifier.schemeId",
        xpath: "/ubl:Invoice/cac:PayeeParty/cac:PartyIdentification/cbc:ID/@schemeID",
        allowSepa: true,
      },
    ];

    const out: TeachingError[] = [];
    for (const check of checks) {
      if (blank(check.value)) continue;
      const code = normalise(check.value!);
      if (ICD_SCHEME_CODES_SET.has(code)) continue;
      if (check.allowSepa && code === SEPA_SCHEME) continue;
      const sepaNote =
        code.toUpperCase() === SEPA_SCHEME
          ? ` "SEPA" is admitted by the UBL binding, but only on the seller and the payee, where it carries the SEPA creditor identifier (BT-90) — and in this model that identifier belongs in payment.directDebit.creditorIdentifier, which the generator emits as its own PartyIdentification.`
          : "";
      out.push({
        rule: "BR-CL-10",
        field: check.field,
        severity: "fatal",
        message: `The scheme identifier on the ${check.what} (${check.subTerm}) is "${code}", which is not in the ISO 6523 ICD list (${ICD_SCHEME_CODES.length} codes).${sepaNote}${wrongCaseHint(check.value!, ICD_SCHEME_CODES_SET)} A party identifier without a resolvable scheme is a number in a namespace nobody can name: the receiver cannot tell a GLN from a national organisation number from an internal customer code, and automatic party matching either fails or matches the wrong record.`,
        fix: `Set ${check.setter} to an ISO 6523 ICD code: ${COMMON_ICD}. The ICD list is broader than the EAS list used for electronic addresses (BR-CL-25), so a valid endpoint scheme is not automatically valid here and vice versa.`,
        example: `"identifier": { "schemeId": "0088", "value": "4304171000002" }`,
        xpath: check.xpath,
        docsUrl: `${DOCS}/BR-CL-10`,
      });
    }
    return out;
  },

  // BR-CL-11: Any registration identifier identification scheme identifier
  // MUST be coded using one of the ISO 6523 ICD list. Bound to
  // cac:PartyLegalEntity/cbc:CompanyID[@schemeID] — seller (BT-30-1), buyer
  // (BT-47-1), payee (BT-61-1). No "SEPA" escape on this element.
  (inv) => {
    const checks: SchemeCheck[] = [
      {
        value: inv.seller?.legalRegistrationSchemeId,
        field: "BT-30",
        subTerm: "BT-30-1",
        what: "seller legal registration identifier",
        setter: "seller.legalRegistrationSchemeId",
        xpath: "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:CompanyID/@schemeID",
      },
      {
        value: inv.buyer?.legalRegistrationSchemeId,
        field: "BT-47",
        subTerm: "BT-47-1",
        what: "buyer legal registration identifier",
        setter: "buyer.legalRegistrationSchemeId",
        xpath: "/ubl:Invoice/cac:AccountingCustomerParty/cac:Party/cac:PartyLegalEntity/cbc:CompanyID/@schemeID",
      },
      {
        value: inv.payee?.legalRegistrationId?.schemeId,
        field: "BT-61",
        subTerm: "BT-61-1",
        what: "payee legal registration identifier",
        setter: "payee.legalRegistrationId.schemeId",
        xpath: "/ubl:Invoice/cac:PayeeParty/cac:PartyLegalEntity/cbc:CompanyID/@schemeID",
      },
    ];

    const out: TeachingError[] = [];
    for (const check of checks) {
      if (blank(check.value)) continue;
      const code = normalise(check.value!);
      if (ICD_SCHEME_CODES_SET.has(code)) continue;
      out.push({
        rule: "BR-CL-11",
        field: check.field,
        severity: "fatal",
        message: `The scheme identifier on the ${check.what} (${check.subTerm}) is "${code}", which is not in the ISO 6523 ICD list.${wrongCaseHint(check.value!, ICD_SCHEME_CODES_SET)} A legal registration identifier is the number a company is entered under in a commercial register, and every member state runs its own — a German HRB number, a French SIREN and a Dutch KvK number are all "the registration number" and none of them means anything without the register being named. The scheme is what names it. Note that the scheme is optional: if you cannot map your register to an ICD code, leave it unset and emit the bare number rather than guessing.`,
        fix: `Set ${check.setter} to an ISO 6523 ICD code: ${COMMON_ICD}. Do not put the register's name here as free text — the attribute is a code, and a name fails the list test however accurate it is.`,
        example: `"legalRegistrationId": "HRB 12345", "legalRegistrationSchemeId": "0198"`,
        xpath: check.xpath,
        docsUrl: `${DOCS}/BR-CL-11`,
      });
    }
    return out;
  },

  // BR-CL-13: Item classification identifier identification scheme identifier
  // MUST be coded using one of the UNTDID 7143 list.
  (inv) => {
    const out: TeachingError[] = [];
    for (const [lineIndex, line] of linesOf(inv).entries()) {
      for (const [classIndex, classification] of (
        line?.itemClassifications ?? []
      ).entries()) {
        if (!classification) continue;
        if (blank(classification.schemeId)) continue; // BR-65 reports absence
        const code = normalise(classification.schemeId);
        if (ITEM_CLASSIFICATION_SCHEME_CODES_SET.has(code)) continue;
        out.push({
          rule: "BR-CL-13",
          field: "BT-158",
          severity: "fatal",
          message: `Classification ${classIndex + 1} on line ${lineIndex + 1} declares the scheme "${code}" (BT-158-1), which is not in UNTDID 7143 (${ITEM_CLASSIFICATION_SCHEME_CODES.length} codes).${wrongCaseHint(classification.schemeId, ITEM_CLASSIFICATION_SCHEME_CODES_SET)} The scheme is carried as @listID on cbc:ItemClassificationCode and it is what turns the code into a lookup: customs, spend analysis and product-compliance checks all branch on it before reading the code. A scheme name invented for internal use — "UNSPSC", "eCl@ss", "internal" — is exactly the kind of value that fails here while looking entirely reasonable.`,
          fix: `Set line.itemClassifications[].schemeId to a UNTDID 7143 code: "HS" harmonised system, "MP" product/service identification number, "SRV" GS1 product classification, "TST" test specification, "ZZZ" mutually defined. Use "ZZZ" when the classification is one you and the buyer agreed bilaterally.`,
          example: `"itemClassifications": [{ "code": "43211508", "schemeId": "MP" }]`,
          xpath: `/ubl:Invoice/cac:InvoiceLine[${lineIndex + 1}]/cac:Item/cac:CommodityClassification[${classIndex + 1}]/cbc:ItemClassificationCode/@listID`,
          docsUrl: `${DOCS}/BR-CL-13`,
        });
      }
    }
    return out;
  },

  // BR-CL-15: Country codes in an invoice MUST be coded using ISO code list
  // 3166-1.
  //
  // A distinct rule id from BR-CL-14 on an identical code list, because it
  // binds a different element: cac:OriginCountry rather than cac:Country. The
  // two are reported separately by KoSIT and are separate docs pages here.
  (inv) => {
    const out: TeachingError[] = [];
    for (const [index, line] of linesOf(inv).entries()) {
      if (blank(line?.originCountryCode)) continue;
      const code = normalise(line.originCountryCode!);
      if (COUNTRY_CODES_SET.has(code)) continue;
      const greek =
        code.toUpperCase() === "EL"
          ? ' "EL" is the VAT-number prefix for Greece; the country code is "GR".'
          : "";
      const uk =
        code.toUpperCase() === "UK"
          ? ' The United Kingdom is "GB" in ISO 3166-1 — "UK" is a reserved code and is not in the list.'
          : "";
      out.push({
        rule: "BR-CL-15",
        field: "BT-159",
        severity: "fatal",
        message: `Line ${index + 1} declares an item country of origin (BT-159) of "${code}", which is not an ISO 3166-1 code.${greek}${uk}${wrongCaseHint(line.originCountryCode!, COUNTRY_CODES_SET)} Origin is a customs and trade-preference fact, not a shipping detail: it decides duty rates, preferential-origin claims and whether the goods fall under a sanctions or safeguard measure. It is checked under its own rule id, BR-CL-15, because it binds cac:OriginCountry — the same list as BR-CL-14 on a different element, so a report can show one failing while the other passes.`,
        fix: `Set line.originCountryCode to the two-letter ISO 3166-1 code of the country where the item was produced — not where it shipped from, which is a different fact. Omit the field when origin is not relevant to the supply, as it usually is not for services.`,
        example: `"originCountryCode": "CN"`,
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:Item/cac:OriginCountry/cbc:IdentificationCode`,
        docsUrl: `${DOCS}/BR-CL-15`,
      });
    }
    return out;
  },

  // BR-CL-21: Item standard identifier scheme identifier MUST belong to the
  // ISO 6523 ICD code list.
  (inv) => {
    const out: TeachingError[] = [];
    for (const [index, line] of linesOf(inv).entries()) {
      const standard = line?.standardItemId;
      if (!standard || blank(standard.schemeId)) continue; // BR-64 reports absence
      const code = normalise(standard.schemeId!);
      if (ICD_SCHEME_CODES_SET.has(code)) continue;
      out.push({
        rule: "BR-CL-21",
        field: "BT-157",
        severity: "fatal",
        message: `Line ${index + 1} declares the item standard identifier scheme "${code}" (BT-157-1), which is not in the ISO 6523 ICD list.${wrongCaseHint(standard.schemeId!, ICD_SCHEME_CODES_SET)} Note that the scheme here is an ICD code, not the name of the numbering system: "GTIN", "EAN" and "UPC" all fail, however unambiguous they read, because the attribute holds a registry code rather than a label. BR-64 checks that a scheme is present at all; this rule checks that the one you gave exists.`,
        fix: `Set line.standardItemId.schemeId to the ISO 6523 ICD code of the registry — "0160" for a GTIN, "0088" for a GLN-based article number, "0060" for a D-U-N-S-based one. If your identifier is not from a registered scheme, move it to line.sellerItemId (BT-155), which needs no scheme.`,
        example: `"standardItemId": { "schemeId": "0160", "value": "04012345678901" }`,
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:Item/cac:StandardItemIdentification/cbc:ID/@schemeID`,
        docsUrl: `${DOCS}/BR-CL-21`,
      });
    }
    return out;
  },

  // BR-CL-22: Tax exemption reason code identifier scheme identifier MUST
  // belong to the CEF VATEX code list.
  //
  // The schematron upper-cases the element content before testing, so this is
  // the one code-list rule in the standard that is genuinely case-insensitive.
  (inv) => {
    const codes = inv.vatExemptionReasonCodes;
    if (!codes) return null;
    const out: TeachingError[] = [];
    for (const [category, raw] of Object.entries(codes)) {
      if (blank(raw)) continue;
      const code = normalise(raw!);
      if (VATEX_CODES_SET.has(code.toUpperCase())) continue;
      // S, Z, L and M must carry no exemption reason at all: BR-S-10, BR-Z-10,
      // BR-AF-10 and BR-AG-10 forbid BT-120 and BT-121 on those breakdowns.
      // Telling the caller to "correct" the code there would hand them a
      // payload this same engine rejects under a different rule id, so the
      // advice has to be deletion rather than substitution.
      const reasonForbidden =
        category === "S" || category === "Z" || category === "L" || category === "M";
      const forbiddingRule =
        category === "L" ? "BR-AF-10" : category === "M" ? "BR-AG-10" : `BR-${category}-10`;
      const suggested =
        category === "AE"
          ? "VATEX-EU-AE"
          : category === "K"
            ? "VATEX-EU-IC"
            : category === "G"
              ? "VATEX-EU-G"
              : category === "O"
                ? "VATEX-EU-O"
                : "VATEX-EU-132-1B";
      out.push({
        rule: "BR-CL-22",
        field: "BT-121",
        severity: "fatal",
        message: `The VAT exemption reason code (BT-121) supplied for category "${category}" is "${code}", which is not in the CEF VATEX list (${VATEX_CODES.length} codes). BT-121 is the machine-readable half of the exemption: BT-120 tells a human why no VAT was charged, and this code tells a tax administration which article of the VAT Directive the exemption rests on. Free text, a directive article written out longhand, or a national code that is not in the VATEX list will all fail. Unusually, the comparison is case-insensitive — the schematron upper-cases the value first — so case is the one thing that cannot be the problem here.`,
        fix: reasonForbidden
          ? `Remove the "${category}" entry from vatExemptionReasonCodes entirely rather than correcting it. A breakdown in category ${category} must carry no exemption reason code (BT-121) and no reason text (BT-120) at all — ${forbiddingRule} forbids both — because ${
              category === "S"
                ? "a standard-rated supply is taxed, so there is no exemption to cite"
                : category === "Z"
                  ? "zero rating is a rate, not an exemption: the supply is inside the VAT system and taxed at 0%"
                  : `category ${category} charges ${category === "L" ? "IGIC in the Canary Islands" : "IPSI in Ceuta and Melilla"}, a tax actually levied on the supply, so claiming relief from it contradicts the breakdown`
            }. Substituting a valid VATEX code here would only trade this failure for that one. If you need to tell the buyer something about these amounts, use the invoice note (BT-22) or the line note (BT-127), which carry free text without making a VAT claim.`
          : `Set vatExemptionReasonCodes["${category}"] to a VATEX code — for category ${category} that is normally "${suggested}"${
              suggested === "VATEX-EU-132-1B"
                ? " or another article-specific code such as \"VATEX-EU-132-1A\", since an exempt supply is exempt under a named article"
                : ""
            }. Leave the code unset and supply only vatExemptionReasons text if none of the codes fits.`,
        example: reasonForbidden
          ? `"vatExemptionReasonCodes": { }, "lines": [{ "id": "1", "description": "Beratung", "quantity": 1, "unitCode": "C62", "unitPrice": 100, "vatCategory": "${category}", "vatRate": ${category === "S" ? 19 : category === "Z" ? 0 : category === "L" ? 7 : 10} }]`
          : `"vatExemptionReasonCodes": { "${category}": "${suggested}" }`,
        xpath: "/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:TaxExemptionReasonCode",
        docsUrl: `${DOCS}/BR-CL-22`,
      });
    }
    return out;
  },

  // BR-CL-24: For Mime code in attribute use MIMEMediaType.
  (inv) => {
    const out: TeachingError[] = [];
    for (const [index, doc] of (inv.supportingDocuments ?? []).entries()) {
      const attachment = doc?.attachment;
      if (!attachment || blank(attachment.mimeCode)) continue;
      const code = normalise(attachment.mimeCode);
      if (MIME_CODES_SET.has(code)) continue;
      const position = supportingDocumentPosition(inv, index);
      out.push({
        rule: "BR-CL-24",
        field: "BT-125",
        severity: "fatal",
        message: `The attachment on supporting document ${index + 1} declares the mime code "${code}" (BT-125-1), which EN 16931 does not admit. The list has exactly ${MIME_CODES.length} entries — "application/pdf", "image/png", "image/jpeg", "text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" and "application/vnd.oasis.opendocument.spreadsheet" — and the shortness is the point: an invoice attachment has to be openable by a receiver, without the sender's software, ten years from now, and without executing anything. That rules out archives (which can hide anything), word-processor formats with macro capability, and vector formats that carry script. A perfectly legitimate ZIP of evidence still fails.`,
        fix: `Set supportingDocuments[].attachment.mimeCode to one of the six admitted values — "application/pdf" is the safe default, and converting to PDF is usually easier than arguing with a receiving portal. Use externalUri (BT-124) to point at a document you cannot embed in an accepted format.`,
        example: `"attachment": { "filename": "timesheet.pdf", "mimeCode": "application/pdf", "content": "JVBERi0xLjQK" }`,
        xpath: `${additionalDocumentReferencePath(position)}/cac:Attachment/cbc:EmbeddedDocumentBinaryObject/@mimeCode`,
        docsUrl: `${DOCS}/BR-CL-24`,
      });
    }
    return out;
  },

  // BR-CL-26: Delivery location identifier scheme identifier MUST belong to
  // the ISO 6523 ICD code list.
  (inv) => {
    const schemeId = inv.deliverToLocationId?.schemeId;
    if (blank(schemeId)) return null;
    const code = normalise(schemeId!);
    if (ICD_SCHEME_CODES_SET.has(code)) return null;
    return err({
      rule: "BR-CL-26",
      field: "BT-71",
      severity: "fatal",
      message: `The scheme identifier on the deliver-to location identifier (BT-71-1) is "${code}", which is not in the ISO 6523 ICD list.${wrongCaseHint(schemeId!, ICD_SCHEME_CODES_SET)} BT-71 is how an invoice names a delivery point precisely enough to be matched automatically — a warehouse door, a ward, a store — where the postal address alone is ambiguous because several locations share it. That matching is only possible if the receiver knows which registry the identifier belongs to, which is what the scheme says.`,
      fix: `Set deliverToLocationId.schemeId to an ISO 6523 ICD code — "0088" for a GLN, which is what almost every delivery-point identifier in practice is. Drop the schemeId and keep the bare value if the identifier is one you and the buyer agreed privately.`,
      example: `"deliverToLocationId": { "schemeId": "0088", "value": "4304171000002" }`,
      xpath: "/ubl:Invoice/cac:Delivery/cac:DeliveryLocation/cbc:ID/@schemeID",
      docsUrl: `${DOCS}/BR-CL-26`,
    });
  },
];
