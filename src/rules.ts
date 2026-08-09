import { computeTotals, round2 } from "./totals.js";
import { DEFAULT_INVOICE_TYPE_CODE } from "./generate.js";
import type {
  InvoiceInput,
  Party,
  TeachingError,
  VatCategory,
} from "./types.js";

/**
 * Input-level business rules, evaluated before XML generation.
 *
 * Each rule mirrors an official EN 16931 / XRechnung CIUS / Peppol rule ID, and
 * the message paraphrases the *normative* text of that rule — so the same
 * identifiers appear in our errors, in a KoSIT report, and on our docs pages.
 * Rule text was taken from:
 *   - ConnectingEurope/eInvoicing-EN16931 `ubl/schematron/abstract/EN16931-model.sch`
 *   - itplr-kosit/xrechnung-schematron `src/validation/schematron/ubl/XRechnung-UBL-validation.sch`
 *   - OpenPEPPOL/peppol-bis-invoice-3 `rules/sch/PEPPOL-EN16931-UBL.sch`
 *
 * A rule returns one TeachingError, a list of them (for per-line rules), or null.
 */

type RuleResult = TeachingError | TeachingError[] | null;
type RuleFn = (inv: InvoiceInput) => RuleResult;

const DOCS = "https://attestwire.com/rules";

const XRECHNUNG_PROFILES = new Set(["xrechnung-ubl", "xrechnung-cii"]);
const isXRechnung = (inv: InvoiceInput) => XRECHNUNG_PROFILES.has(inv.profile);
const isPeppol = (inv: InvoiceInput) => inv.profile === "peppol-bis-3";

const blank = (v: string | undefined | null): boolean =>
  v === undefined || v === null || String(v).trim() === "";

/** ISO 3166-1 alpha-2 prefix, plus Greece's "EL" derogation (BR-CO-09). */
const VAT_PREFIX = /^(EL|[A-Z]{2})/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Human-readable names for the VAT categories, used in generated messages. */
const CATEGORY_NAMES: Record<VatCategory, string> = {
  S: "Standard rated",
  Z: "Zero rated",
  E: "Exempt from VAT",
  AE: "Reverse charge",
  K: "Intra-community supply",
  G: "Export outside the EU",
  O: "Not subject to VAT",
};

const err = (e: TeachingError): TeachingError => e;

const usesCategory = (inv: InvoiceInput, cat: VatCategory): boolean =>
  inv.lines.some((l) => l.vatCategory === cat);

/** BT-31 or BT-32 — either satisfies the "seller is tax-identified" family of rules. */
const sellerTaxIdentified = (seller: Party): boolean =>
  !blank(seller.vatId) || !blank(seller.taxRegistrationId);

// ---------------------------------------------------------------------------
// Data-driven rule families
// ---------------------------------------------------------------------------

/**
 * BR-{S,Z,E,IC,G}-02: a line in these categories requires the seller to be
 * tax-identified. Same shape, but each category fails for a different business
 * reason, so each carries its own message rather than a templated one.
 */
const SELLER_TAX_ID_RULES: {
  category: VatCategory;
  rule: string;
  why: string;
}[] = [
  {
    category: "S",
    rule: "BR-S-02",
    why: "You are charging VAT, so the tax authority must be able to trace the VAT you collected back to a registered taxable person.",
  },
  {
    category: "Z",
    rule: "BR-Z-02",
    why: "Zero-rating is a VAT treatment, not the absence of VAT — the supply is still inside the VAT system and the supplier must be identified.",
  },
  {
    category: "E",
    rule: "BR-E-02",
    why: "An exemption is claimed against a specific national provision, which only a registered taxable person can invoke.",
  },
  {
    category: "K",
    rule: "BR-IC-02",
    why: "An intra-community supply is zero-rated only if both parties are VAT-registered in different member states; your identifier is half of that proof.",
  },
  {
    category: "G",
    rule: "BR-G-02",
    why: "Export zero-rating must be attributable to a registered exporter for the customs/VAT reconciliation to work.",
  },
];

/**
 * BR-{Z,E,AE,IC,G}-05: these categories fix the line VAT rate (BT-152) at zero.
 * A non-zero rate here is almost always a copy-paste from a standard-rated line.
 */
const ZERO_RATE_LINE_RULES: { category: VatCategory; rule: string }[] = [
  { category: "Z", rule: "BR-Z-05" },
  { category: "E", rule: "BR-E-05" },
  { category: "AE", rule: "BR-AE-05" },
  { category: "K", rule: "BR-IC-05" },
  { category: "G", rule: "BR-G-05" },
];

/** BR-DE-3/4/8/9: XRechnung makes city and post code mandatory on both parties. */
const DE_ADDRESS_RULES: {
  rule: string;
  party: "seller" | "buyer";
  key: "city" | "postalCode";
  field: `BT-${number}`;
  label: string;
}[] = [
  { rule: "BR-DE-3", party: "seller", key: "city", field: "BT-37", label: "Seller city" },
  { rule: "BR-DE-4", party: "seller", key: "postalCode", field: "BT-38", label: "Seller post code" },
  { rule: "BR-DE-8", party: "buyer", key: "city", field: "BT-52", label: "Buyer city" },
  { rule: "BR-DE-9", party: "buyer", key: "postalCode", field: "BT-53", label: "Buyer post code" },
];

/** BR-DE-5/6/7: the seller contact group is mandatory in full, not in part. */
const DE_CONTACT_RULES: {
  rule: string;
  key: "name" | "phone" | "email";
  field: `BT-${number}`;
  label: string;
  fix: string;
  example: string;
}[] = [
  {
    rule: "BR-DE-5",
    key: "name",
    field: "BT-41",
    label: "Seller contact point",
    fix: 'Set seller.contact.name to the person or desk that answers invoice queries — a department name such as "Buchhaltung" is acceptable.',
    example: `"contact": { "name": "Buchhaltung" }`,
  },
  {
    rule: "BR-DE-6",
    key: "phone",
    field: "BT-42",
    label: "Seller contact telephone number",
    fix: "Set seller.contact.phone to a reachable number in international format.",
    example: `"contact": { "phone": "+49 30 1234567" }`,
  },
  {
    rule: "BR-DE-7",
    key: "email",
    field: "BT-43",
    label: "Seller contact email address",
    fix: "Set seller.contact.email to a monitored mailbox — this is where the authority sends invoice queries.",
    example: `"contact": { "email": "rechnungen@musterlieferant.example" }`,
  },
];

/** BR-DE-17: XRechnung narrows UNTDID 1001 to this set. */
const DE_INVOICE_TYPE_CODES = new Set([
  "326", // partial invoice
  "380", // commercial invoice
  "381", // credit note
  "384", // corrected invoice
  "389", // self-billed invoice
  "875", // partial construction invoice
  "876", // partial final construction invoice
  "877", // final construction invoice
]);

// ---------------------------------------------------------------------------
// Rule set
// ---------------------------------------------------------------------------

export const inputRules: RuleFn[] = [
  // --- BR-02..BR-16: mandatory document-level fields -----------------------

  // BR-02: An Invoice shall have an Invoice number (BT-1).
  (inv) =>
    blank(inv.invoiceNumber)
      ? err({
          rule: "BR-02",
          field: "BT-1",
          severity: "fatal",
          message:
            "An invoice must have an invoice number (BT-1). It is the identifier the buyer, your accounts-receivable ledger and the tax authority all use to refer to this one document, so it must be unique within your numbering sequence.",
          fix: "Set invoiceNumber to your next sequential invoice identifier. Do not reuse a number, even for a document you later cancel — issue a credit note instead.",
          example: `"invoiceNumber": "2026-000142"`,
          xpath: "/ubl:Invoice/cbc:ID",
          docsUrl: `${DOCS}/BR-02`,
        })
      : null,

  // BR-03: An Invoice shall have an Invoice issue date (BT-2).
  (inv) => {
    if (blank(inv.issueDate)) {
      return err({
        rule: "BR-03",
        field: "BT-2",
        severity: "fatal",
        message:
          "An invoice must have an issue date (BT-2). The issue date fixes the VAT period the invoice falls into and starts the payment clock.",
        fix: 'Set issueDate to the date you issued the document, as an ISO 8601 calendar date ("YYYY-MM-DD"). UBL forbids a time component here.',
          example: `"issueDate": "2026-08-09"`,
        xpath: "/ubl:Invoice/cbc:IssueDate",
        docsUrl: `${DOCS}/BR-03`,
      });
    }
    if (!ISO_DATE.test(inv.issueDate)) {
      return err({
        rule: "BR-03",
        field: "BT-2",
        severity: "fatal",
        message: `The issue date (BT-2) must be a plain ISO 8601 calendar date, but "${inv.issueDate}" is not in YYYY-MM-DD form. UBL types this element as xs:date, so a timestamp, a locale format such as 09.08.2026, or a trailing "Z" all fail schema validation before any business rule runs.`,
        fix: "Convert the value to YYYY-MM-DD before assigning it — e.g. new Date(x).toISOString().slice(0, 10).",
        example: `"issueDate": "2026-08-09"`,
        xpath: "/ubl:Invoice/cbc:IssueDate",
        docsUrl: `${DOCS}/BR-03`,
      });
    }
    return null;
  },

  // BR-05: An Invoice shall have an Invoice currency code (BT-5).
  (inv) =>
    blank(inv.currency) || !/^[A-Za-z]{3}$/.test(inv.currency)
      ? err({
          rule: "BR-05",
          field: "BT-5",
          severity: "fatal",
          message: `An invoice must have a currency code (BT-5) from ISO 4217, but ${
            blank(inv.currency) ? "none was provided" : `"${inv.currency}" is not a three-letter code`
          }. Every monetary amount in the document is interpreted against this code.`,
          fix: 'Set currency to the three-letter ISO 4217 alphabetic code, e.g. "EUR". Use the code, not the symbol.',
          example: `"currency": "EUR"`,
          xpath: "/ubl:Invoice/cbc:DocumentCurrencyCode",
          docsUrl: `${DOCS}/BR-05`,
        })
      : null,

  // BR-06: An Invoice shall contain the Seller name (BT-27).
  (inv) =>
    blank(inv.seller?.name)
      ? err({
          rule: "BR-06",
          field: "BT-27",
          severity: "fatal",
          message:
            "An invoice must contain the seller name (BT-27) — the name under which you are registered, not a brand or trading style, unless you also supply the registered name separately.",
          fix: "Set seller.name. If you invoice under a trading name, put the registered name in seller.legalName so both appear in the document.",
          example: `"seller": { "name": "Acme GmbH" }`,
          xpath: "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyName/cbc:Name",
          docsUrl: `${DOCS}/BR-06`,
        })
      : null,

  // BR-07: An Invoice shall contain the Buyer name (BT-44).
  (inv) =>
    blank(inv.buyer?.name)
      ? err({
          rule: "BR-07",
          field: "BT-44",
          severity: "fatal",
          message:
            "An invoice must contain the buyer name (BT-44). Without it the recipient cannot prove the invoice was addressed to them, which is a condition of deducting the input VAT.",
          fix: "Set buyer.name to the legal name of the organisation being billed, exactly as they gave it to you.",
          example: `"buyer": { "name": "Kunde GmbH" }`,
          xpath: "/ubl:Invoice/cac:AccountingCustomerParty/cac:Party/cac:PartyName/cbc:Name",
          docsUrl: `${DOCS}/BR-07`,
        })
      : null,

  // BR-08 / BR-10: postal address groups must be present.
  (inv) => {
    const out: TeachingError[] = [];
    if (!inv.seller?.address) {
      out.push({
        rule: "BR-08",
        field: "BG-5",
        severity: "fatal",
        message:
          "An invoice must contain the seller postal address (BG-5). It establishes the place of supply, which determines which country's VAT rules apply.",
        fix: "Set seller.address with at least city, postalCode and countryCode.",
        example: `"address": { "city": "Berlin", "postalCode": "10115", "countryCode": "DE" }`,
        xpath: "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PostalAddress",
        docsUrl: `${DOCS}/BR-08`,
      });
    }
    if (!inv.buyer?.address) {
      out.push({
        rule: "BR-10",
        field: "BG-8",
        severity: "fatal",
        message:
          "An invoice must contain the buyer postal address (BG-8). For cross-border supplies it is what distinguishes a domestic sale from a reverse-charge or intra-community one.",
        fix: "Set buyer.address with at least city, postalCode and countryCode.",
        example: `"address": { "city": "Wien", "postalCode": "1010", "countryCode": "AT" }`,
        xpath: "/ubl:Invoice/cac:AccountingCustomerParty/cac:Party/cac:PostalAddress",
        docsUrl: `${DOCS}/BR-10`,
      });
    }
    return out;
  },

  // BR-09 / BR-11: country codes are mandatory inside those addresses.
  (inv) => {
    const out: TeachingError[] = [];
    const check = (
      party: Party | undefined,
      rule: string,
      field: `BT-${number}`,
      who: string,
      path: string,
    ) => {
      const code = party?.address?.countryCode;
      if (!party?.address) return; // BR-08 / BR-10 already reported it
      if (blank(code) || !/^[A-Za-z]{2}$/.test(code!)) {
        out.push({
          rule,
          field,
          severity: "fatal",
          message: `The ${who} postal address must contain a ${who} country code (${field}) as an ISO 3166-1 alpha-2 code${
            blank(code) ? ", but none was provided" : `, but "${code}" is not a two-letter code`
          }. This code drives the place-of-supply and reverse-charge logic downstream.`,
          fix: `Set ${who === "seller" ? "seller" : "buyer"}.address.countryCode to the two-letter code, e.g. "DE" for Germany or "EL"/"GR" for Greece — note EN 16931 uses "GR" for the country and "EL" only as a VAT-number prefix.`,
          example: `"countryCode": "DE"`,
          xpath: path,
          docsUrl: `${DOCS}/${rule}`,
        });
      }
    };
    check(
      inv.seller,
      "BR-09",
      "BT-40",
      "seller",
      "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PostalAddress/cac:Country/cbc:IdentificationCode",
    );
    check(
      inv.buyer,
      "BR-11",
      "BT-55",
      "buyer",
      "/ubl:Invoice/cac:AccountingCustomerParty/cac:Party/cac:PostalAddress/cac:Country/cbc:IdentificationCode",
    );
    return out;
  },

  // BR-16: An Invoice shall have at least one Invoice line (BG-25).
  (inv) =>
    !inv.lines || inv.lines.length === 0
      ? err({
          rule: "BR-16",
          field: "BG-25",
          severity: "fatal",
          message:
            "An invoice must have at least one invoice line (BG-25). A document with no lines has no taxable supply to describe, so it cannot be an invoice — even if its totals are zero.",
          fix: "Add at least one entry to lines. To invoice a flat fee, use quantity 1 with unitCode \"C62\" (one/piece) and the fee as unitPrice.",
          example: `"lines": [{ "id": "1", "description": "Retainer", "quantity": 1, "unitCode": "C62", "unitPrice": 500, "vatCategory": "S", "vatRate": 19 }]`,
          xpath: "/ubl:Invoice/cac:InvoiceLine",
          docsUrl: `${DOCS}/BR-16`,
        })
      : null,

  // BR-CO-26: the seller must be identifiable.
  (inv) =>
    inv.seller &&
    blank(inv.seller.vatId) &&
    blank(inv.seller.taxRegistrationId) &&
    blank(inv.seller.legalRegistrationId)
      ? err({
          rule: "BR-CO-26",
          field: ["BT-30", "BT-31"],
          severity: "fatal",
          message:
            "In order for the buyer to automatically identify you, the invoice must carry at least one of the seller identifier (BT-29), seller legal registration identifier (BT-30) or seller VAT identifier (BT-31). A name and address alone are not machine-resolvable to a supplier record.",
          fix: "Set seller.vatId (BT-31) if you are VAT-registered, otherwise seller.legalRegistrationId (BT-30) such as your commercial-register number.",
          example: `"seller": { "vatId": "DE123456789", "legalRegistrationId": "HRB 12345" }`,
          docsUrl: `${DOCS}/BR-CO-26`,
        })
      : null,

  // --- BR-21..BR-27: per-line mandatory fields -----------------------------

  (inv) => {
    const out: TeachingError[] = [];
    for (const [index, line] of (inv.lines ?? []).entries()) {
      const at = `/ubl:Invoice/cac:InvoiceLine[${index + 1}]`;
      const where = `Line ${index + 1}${line.id ? ` (id "${line.id}")` : ""}`;

      if (blank(line.id)) {
        out.push({
          rule: "BR-21",
          field: "BT-126",
          severity: "fatal",
          message: `${where} has no invoice line identifier (BT-126). Every line needs an identifier that is unique within the document, because allowances, charges and dispute references all point at lines by this value.`,
          fix: 'Set line.id. Sequential strings ("1", "2", "3") are conventional and sufficient.',
          example: `"id": "1"`,
          xpath: `${at}/cbc:ID`,
          docsUrl: `${DOCS}/BR-21`,
        });
      }

      if (typeof line.quantity !== "number" || Number.isNaN(line.quantity)) {
        out.push({
          rule: "BR-22",
          field: "BT-129",
          severity: "fatal",
          message: `${where} has no invoiced quantity (BT-129). The quantity is a required factor of the line net amount, so it must be present even when it is 1.`,
          fix: "Set line.quantity to a number. For a flat fee or a subscription period, use 1.",
          example: `"quantity": 10`,
          xpath: `${at}/cbc:InvoicedQuantity`,
          docsUrl: `${DOCS}/BR-22`,
        });
      }

      if (blank(line.unitCode)) {
        out.push({
          rule: "BR-23",
          field: "BT-130",
          severity: "fatal",
          message: `${where} has no unit of measure code (BT-130). EN 16931 requires a code from UN/ECE Recommendation 20, not a free-text unit — "hours" is not valid, "HUR" is.`,
          fix: 'Set line.unitCode to the UN/ECE Rec 20 code: "HUR" hours, "DAY" days, "C62" one/piece, "MTR" metres, "KGM" kilograms, "MON" months.',
          example: `"unitCode": "HUR"`,
          xpath: `${at}/cbc:InvoicedQuantity/@unitCode`,
          docsUrl: `${DOCS}/BR-23`,
        });
      }

      if (blank(line.description)) {
        out.push({
          rule: "BR-25",
          field: "BT-153",
          severity: "fatal",
          message: `${where} has no item name (BT-153). The buyer must be able to tell what was supplied from the invoice alone; an internal SKU in place of a name does not satisfy this.`,
          fix: "Set line.description to a short human-readable item name, and put any longer explanation in line.longDescription (BT-154).",
          example: `"description": "Senior engineering consultancy"`,
          xpath: `${at}/cac:Item/cbc:Name`,
          docsUrl: `${DOCS}/BR-25`,
        });
      }

      if (typeof line.unitPrice !== "number" || Number.isNaN(line.unitPrice)) {
        out.push({
          rule: "BR-26",
          field: "BT-146",
          severity: "fatal",
          message: `${where} has no item net price (BT-146). The net price is the price after any line discount and excluding VAT.`,
          fix: "Set line.unitPrice to the net unit price, excluding VAT.",
          example: `"unitPrice": 150`,
          xpath: `${at}/cac:Price/cbc:PriceAmount`,
          docsUrl: `${DOCS}/BR-26`,
        });
      } else if (line.unitPrice < 0) {
        out.push({
          rule: "BR-27",
          field: "BT-146",
          severity: "fatal",
          message: `${where} has a negative item net price (BT-146: ${line.unitPrice}). The net price must never be negative — EN 16931 models reductions as allowances, not as negative prices.`,
          fix: "Make unitPrice positive. To bill less, reduce the price or (once supported) add a line allowance; to reverse a supply entirely, issue a credit note with invoiceTypeCode \"381\".",
          example: `"unitPrice": 150`,
          xpath: `${at}/cac:Price/cbc:PriceAmount`,
          docsUrl: `${DOCS}/BR-27`,
        });
      }
    }
    return out;
  },

  // --- BR-CO-09: VAT identifier country prefixes ---------------------------

  (inv) => {
    const out: TeachingError[] = [];
    const check = (
      value: string | undefined,
      field: `BT-${number}`,
      who: string,
      path: string,
    ) => {
      if (blank(value)) return;
      const normalised = value!.replace(/\s/g, "").toUpperCase();
      if (!VAT_PREFIX.test(normalised)) {
        out.push({
          rule: "BR-CO-09",
          field,
          severity: "fatal",
          message: `The ${who} VAT identifier (${field}) must start with a country prefix in accordance with ISO 3166-1 alpha-2, but "${value}" does not. Greece is the one exception: it uses the prefix "EL" rather than "GR".`,
          fix: `Prefix the number with the issuing country's two-letter code — a German number 123456789 becomes "DE123456789". Store it prefixed; do not add the prefix only at render time.`,
          example: `"vatId": "DE123456789"`,
          xpath: path,
          docsUrl: `${DOCS}/BR-CO-09`,
        });
      }
    };
    check(
      inv.seller?.vatId,
      "BT-31",
      "seller",
      "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID",
    );
    check(
      inv.buyer?.vatId,
      "BT-48",
      "buyer",
      "/ubl:Invoice/cac:AccountingCustomerParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID",
    );
    return out;
  },

  // --- VAT category consistency --------------------------------------------

  // BR-S-02 / BR-Z-02 / BR-E-02 / BR-IC-02 / BR-G-02: seller must be tax-identified.
  (inv) => {
    if (!inv.seller || sellerTaxIdentified(inv.seller)) return null;
    const out: TeachingError[] = [];
    for (const spec of SELLER_TAX_ID_RULES) {
      if (!usesCategory(inv, spec.category)) continue;
      out.push({
        rule: spec.rule,
        field: ["BT-31", "BT-32"],
        severity: "fatal",
        message: `A line uses VAT category ${spec.category} (${CATEGORY_NAMES[spec.category]}), so the invoice must carry the seller VAT identifier (BT-31), the seller tax registration identifier (BT-32), or a seller tax representative (BG-11). ${spec.why}`,
        fix: 'Set seller.vatId (e.g. "DE123456789"). If you are not VAT-registered but have a national tax number, set seller.taxRegistrationId instead.',
        example: `"seller": { "vatId": "DE123456789" }`,
        docsUrl: `${DOCS}/${spec.rule}`,
      });
    }
    return out;
  },

  // BR-AE-02: reverse charge requires identifiers on BOTH sides.
  (inv) => {
    if (!usesCategory(inv, "AE")) return null;
    const buyerIdentified =
      !blank(inv.buyer?.vatId) || !blank(inv.buyer?.legalRegistrationId);
    if (buyerIdentified) return null;
    return err({
      rule: "BR-AE-02",
      field: ["BT-48", "BT-47"],
      severity: "fatal",
      message:
        "A line uses VAT category AE (reverse charge), so the invoice must contain the buyer VAT identifier (BT-48) and/or the buyer legal registration identifier (BT-47). Under reverse charge the buyer accounts for the VAT themselves, and the tax authority matches your zero-rated output against their self-assessed input using that identifier.",
      fix: "Set buyer.vatId to your client's VAT number — validate it against VIES on the invoice date and keep the response. If the number is invalid at the time of supply, the liability stays with you.",
      example: `"buyer": { "vatId": "ATU12345678" }`,
      docsUrl: `${DOCS}/BR-AE-02`,
    });
  },

  // BR-IC-02: intra-community supply requires the buyer's VAT ID specifically.
  (inv) => {
    if (!usesCategory(inv, "K")) return null;
    if (!blank(inv.buyer?.vatId)) return null;
    return err({
      rule: "BR-IC-02",
      field: "BT-48",
      severity: "fatal",
      message:
        "A line uses VAT category K (intra-community supply), which requires the buyer VAT identifier (BT-48) — a legal registration number is not a substitute here. Zero-rating an intra-community supply is only lawful if the customer is VAT-registered in another member state and you can evidence that number.",
      fix: "Set buyer.vatId to the customer's VAT number in the destination member state, verify it via VIES, and retain the confirmation with the invoice.",
      example: `"buyer": { "vatId": "FR12345678901" }`,
      docsUrl: `${DOCS}/BR-IC-02`,
    });
  },

  // BR-IC-12: intra-community supply requires a deliver-to country code.
  (inv) =>
    usesCategory(inv, "K") && blank(inv.deliverTo?.countryCode)
      ? err({
          rule: "BR-IC-12",
          field: "BT-80",
          severity: "fatal",
          message:
            "An invoice with an intra-community supply (category K) must state the deliver-to country code (BT-80). The zero rate depends on the goods physically leaving your member state, so the destination has to be on the document.",
          fix: 'Set deliverTo.countryCode to the ISO 3166-1 alpha-2 code of the destination member state — it must differ from the seller country. Under XRechnung you must also supply deliverTo.city and deliverTo.postalCode (BR-DE-10, BR-DE-11).',
          example: `"deliverTo": { "city": "Lyon", "postalCode": "69001", "countryCode": "FR" }`,
          xpath: "/ubl:Invoice/cac:Delivery/cac:DeliveryLocation/cac:Address/cac:Country/cbc:IdentificationCode",
          docsUrl: `${DOCS}/BR-IC-12`,
        })
      : null,

  // BR-IC-11: intra-community supply requires a delivery date or invoicing period.
  (inv) =>
    usesCategory(inv, "K") && blank(inv.deliveryDate)
      ? err({
          rule: "BR-IC-11",
          field: "BT-72",
          severity: "fatal",
          message:
            "An invoice with an intra-community supply (category K) must state the actual delivery date (BT-72) or an invoicing period (BG-14). The delivery date determines the period in which the supply is reported on your recapitulative statement.",
          fix: 'Set deliveryDate to the date the goods left, as "YYYY-MM-DD".',
          example: `"deliveryDate": "2026-08-05"`,
          xpath: "/ubl:Invoice/cac:Delivery/cbc:ActualDeliveryDate",
          docsUrl: `${DOCS}/BR-IC-11`,
        })
      : null,

  // BR-S-05: standard-rated lines need a rate greater than zero.
  (inv) => {
    const out: TeachingError[] = [];
    for (const [index, line] of (inv.lines ?? []).entries()) {
      if (line.vatCategory !== "S") continue;
      const rate = line.vatRate;
      if (typeof rate === "number" && rate > 0) continue;
      out.push({
        rule: "BR-S-05",
        field: "BT-152",
        severity: "fatal",
        message: `Line ${index + 1} uses VAT category S (standard rated), so the invoiced item VAT rate (BT-152) must be greater than zero, but it is ${
          rate === undefined ? "missing" : rate
        }. A zero rate with category S is contradictory — if you genuinely charge no VAT, the category is Z, E, AE, K, G or O, and each of those has different evidencing requirements.`,
        fix: 'Set line.vatRate to the applicable percentage as a number (19 for the German standard rate, 7 for the reduced rate). If no VAT is due, change vatCategory instead of setting the rate to 0.',
        example: `"vatCategory": "S", "vatRate": 19`,
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent`,
        docsUrl: `${DOCS}/BR-S-05`,
      });
    }
    return out;
  },

  // BR-{Z,E,AE,IC,G}-05: these categories fix the rate at zero.
  (inv) => {
    const out: TeachingError[] = [];
    for (const [index, line] of (inv.lines ?? []).entries()) {
      const spec = ZERO_RATE_LINE_RULES.find(
        (s) => s.category === line.vatCategory,
      );
      if (!spec) continue;
      if (line.vatRate === undefined || line.vatRate === 0) continue;
      out.push({
        rule: spec.rule,
        field: "BT-152",
        severity: "fatal",
        message: `Line ${index + 1} uses VAT category ${spec.category} (${CATEGORY_NAMES[spec.category]}), so the invoiced item VAT rate (BT-152) must be 0, but it is ${line.vatRate}. No VAT is charged on this line, so any non-zero rate would make the document's VAT breakdown disagree with its totals.`,
        fix: `Set line.vatRate to 0 (or omit it) for category ${spec.category}. If you did mean to charge ${line.vatRate}% VAT, the category should be S instead.`,
        example: `"vatCategory": "${spec.category}", "vatRate": 0`,
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent`,
        docsUrl: `${DOCS}/${spec.rule}`,
      });
    }
    return out;
  },

  // BR-O-05 / BR-O-02: "not subject to VAT" is the strictest category.
  (inv) => {
    const out: TeachingError[] = [];
    if (!usesCategory(inv, "O")) return out;

    for (const [index, line] of (inv.lines ?? []).entries()) {
      if (line.vatCategory !== "O") continue;
      if (line.vatRate === undefined) continue;
      out.push({
        rule: "BR-O-05",
        field: "BT-152",
        severity: "fatal",
        message: `Line ${index + 1} uses VAT category O (not subject to VAT), so it must not carry an invoiced item VAT rate (BT-152) at all — not even 0. "Outside the scope of VAT" means the transaction has no rate, which is a different statement from "the rate is zero".`,
        fix: "Remove vatRate from this line. If the supply is inside the scope of VAT but taxed at 0%, use category Z instead.",
        example: `"vatCategory": "O"`,
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent`,
        docsUrl: `${DOCS}/BR-O-05`,
      });
    }

    if (!blank(inv.seller?.vatId) || !blank(inv.buyer?.vatId)) {
      out.push({
        rule: "BR-O-02",
        field: ["BT-31", "BT-48"],
        severity: "fatal",
        message:
          "This invoice uses VAT category O (not subject to VAT), so it must not contain the seller VAT identifier (BT-31), the seller tax representative VAT identifier (BT-63) or the buyer VAT identifier (BT-48). Quoting a VAT number on a transaction declared outside the scope of VAT is self-contradictory, and BR-O-11/BR-O-12 further forbid mixing category O with any other category on the same document.",
        fix: "Remove seller.vatId and buyer.vatId from an invoice that uses category O. If some lines really are within the scope of VAT, they belong on a separate invoice.",
        docsUrl: `${DOCS}/BR-O-02`,
      });
    }
    return out;
  },

  // BR-E-10: exempt breakdowns need a reason; there is no standard default text.
  (inv) =>
    usesCategory(inv, "E") && blank(inv.vatExemptionReasons?.E)
      ? err({
          rule: "BR-E-10",
          field: ["BT-120", "BT-121"],
          severity: "fatal",
          message:
            'A VAT breakdown with category E (exempt from VAT) must have a VAT exemption reason code (BT-121) or reason text (BT-120). Unlike reverse charge or export, "exempt" has no single standard wording — the exemption is granted by a specific provision, and the buyer and the auditor both need to know which one you are relying on.',
          fix: 'Set vatExemptionReasons.E to the statutory reason, ideally naming the provision, e.g. "Steuerbefreit nach §4 Nr. 21 UStG" or "Exempt under Article 132 of Directive 2006/112/EC".',
          example: `"vatExemptionReasons": { "E": "Exempt under Article 132(1)(i) of Directive 2006/112/EC" }`,
          xpath: "/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:TaxExemptionReason",
          docsUrl: `${DOCS}/BR-E-10`,
        })
      : null,

  // --- BR-CO-* arithmetic, checked against caller-declared totals -----------

  (inv) => {
    const declared = inv.declaredTotals;
    if (!declared || !inv.lines || inv.lines.length === 0) return null;

    let computed;
    try {
      computed = computeTotals(inv);
    } catch {
      return null; // a malformed line is already reported by BR-22 / BR-26
    }

    const out: TeachingError[] = [];
    const compare = (
      declaredValue: number | undefined,
      computedValue: number,
      rule: string,
      field: `BT-${number}`,
      formula: string,
      why: string,
    ) => {
      if (typeof declaredValue !== "number") return;
      if (round2(declaredValue) === computedValue) return;
      const delta = round2(round2(declaredValue) - computedValue);
      out.push({
        rule,
        field,
        severity: "fatal",
        message: `${rule} requires ${formula}. You declared ${round2(declaredValue).toFixed(2)} for ${field}, but the invoice lines compute to ${computedValue.toFixed(2)} — a difference of ${delta > 0 ? "+" : ""}${delta.toFixed(2)} ${inv.currency}. ${why}`,
        fix: `Either correct the line data so it sums to your declared figure, or drop declaredTotals.${field === "BT-106" ? "lineExtensionAmount" : field === "BT-109" ? "taxExclusiveAmount" : field === "BT-110" ? "taxAmount" : field === "BT-112" ? "taxInclusiveAmount" : "payableAmount"} and let the library compute it. Note that EN 16931 sums *rounded* line amounts: round each line to 2 decimals first, then add — rounding only the final sum drifts by a cent or two on long invoices.`,
        example: `"declaredTotals": { "${field === "BT-106" ? "lineExtensionAmount" : field === "BT-109" ? "taxExclusiveAmount" : field === "BT-110" ? "taxAmount" : field === "BT-112" ? "taxInclusiveAmount" : "payableAmount"}": ${computedValue.toFixed(2)} }`,
        docsUrl: `${DOCS}/${rule}`,
      });
    };

    compare(
      declared.lineExtensionAmount,
      computed.lineExtensionAmount,
      "BR-CO-10",
      "BT-106",
      "the sum of invoice line net amounts (BT-106) to equal Σ BT-131",
      "This is a pure addition check, so a mismatch means either a line is missing from your total or a line amount was rounded differently.",
    );
    compare(
      declared.taxExclusiveAmount,
      computed.taxExclusiveAmount,
      "BR-CO-13",
      "BT-109",
      "the invoice total without VAT (BT-109) to equal Σ BT-131 − document allowances (BT-107) + document charges (BT-108)",
      "This version of the library does not yet model document-level allowances or charges, so BT-109 must equal BT-106 exactly.",
    );
    compare(
      declared.taxAmount,
      computed.taxAmount,
      "BR-CO-14",
      "BT-110",
      "the invoice total VAT amount (BT-110) to equal Σ VAT category tax amounts (BT-117)",
      "VAT is computed per category-and-rate group and rounded there (BR-CO-17), then summed. Computing VAT on the document total instead of per group is the usual cause of a one-cent break.",
    );
    compare(
      declared.taxInclusiveAmount,
      computed.taxInclusiveAmount,
      "BR-CO-15",
      "BT-112",
      "the invoice total with VAT (BT-112) to equal BT-109 + BT-110",
      "Check whether one of BT-109 or BT-110 is also flagged above; BR-CO-15 often fails only as a consequence.",
    );
    compare(
      declared.payableAmount,
      computed.payableAmount,
      "BR-CO-16",
      "BT-115",
      "the amount due for payment (BT-115) to equal BT-112 − paid amount (BT-113) + rounding amount (BT-114)",
      "This version of the library does not yet model prepaid or rounding amounts, so BT-115 must equal BT-112.",
    );
    return out;
  },

  // --- Electronic addresses (Peppol / XRechnung transport) ------------------

  (inv) => {
    const out: TeachingError[] = [];
    const relevant = isPeppol(inv) || isXRechnung(inv);
    if (!relevant) return out;
    // Peppol makes these fatal; XRechnung's spec requires them by cardinality
    // rather than by a BR-DE rule, so we report the Peppol rule as a warning
    // there rather than invent an identifier.
    const severity = isPeppol(inv) ? "fatal" : "warning";

    const check = (
      party: Party | undefined,
      rule: string,
      field: `BT-${number}`,
      who: string,
      schemeRule: string,
      schemeField: `BT-${number}`,
      path: string,
    ) => {
      const addr = party?.electronicAddress;
      if (!addr || blank(addr.value)) {
        out.push({
          rule,
          field,
          severity,
          message: `The ${who} electronic address (${field}) must be provided. This is the routing identifier a Peppol access point uses to deliver the document — a postal address and an email are not substitutes, and without it the invoice cannot be addressed on the network.`,
          fix: `Set ${who}.electronicAddress to the participant identifier and its scheme, e.g. scheme "9930" (German VAT ID) or "0204" (Leitweg-ID). The full list is the Peppol EAS code list (ISO 6523 ICD).`,
          example: `"electronicAddress": { "schemeId": "9930", "value": "DE123456789" }`,
          xpath: path,
          docsUrl: `${DOCS}/${rule}`,
        });
        return;
      }
      if (blank(addr.schemeId)) {
        out.push({
          rule: schemeRule,
          field: schemeField,
          severity: "fatal",
          message: `The ${who} electronic address (${field}) must have a scheme identifier. The bare value "${addr.value}" is ambiguous — the same string can be a VAT number under one scheme and a GLN under another, and the receiving access point resolves it by scheme.`,
          fix: 'Set electronicAddress.schemeId to the Peppol EAS code, e.g. "9930" for a German VAT identifier, "0204" for a Leitweg-ID, "0088" for a GLN.',
          example: `"electronicAddress": { "schemeId": "9930", "value": "${addr.value}" }`,
          xpath: `${path}/@schemeID`,
          docsUrl: `${DOCS}/${schemeRule}`,
        });
      }
    };

    check(
      inv.seller,
      "PEPPOL-EN16931-R020",
      "BT-34",
      "seller",
      "BR-62",
      "BT-34",
      "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cbc:EndpointID",
    );
    check(
      inv.buyer,
      "PEPPOL-EN16931-R010",
      "BT-49",
      "buyer",
      "BR-63",
      "BT-49",
      "/ubl:Invoice/cac:AccountingCustomerParty/cac:Party/cbc:EndpointID",
    );
    return out;
  },

  // --- BR-DE-*: XRechnung CIUS --------------------------------------------

  // BR-DE-15: buyer reference (Leitweg-ID) required under XRechnung.
  (inv) =>
    isXRechnung(inv) && blank(inv.buyerReference)
      ? err({
          rule: "BR-DE-15",
          field: "BT-10",
          severity: "fatal",
          message:
            "XRechnung requires a buyer reference (BT-10). For German public-sector buyers this is the Leitweg-ID; business buyers may supply any reference, but the field must be present.",
          fix: "Ask your client for their Leitweg-ID (public sector) or an order/customer reference, and set buyerReference.",
          example: `"buyerReference": "04011000-1234512345-06"`,
          xpath: "/ubl:Invoice/cbc:BuyerReference",
          docsUrl: `${DOCS}/BR-DE-15`,
        })
      : null,

  // BR-DE-1: payment instructions (BG-16) are mandatory.
  (inv) => {
    if (!isXRechnung(inv)) return null;
    if (!inv.payment || blank(inv.payment.meansCode)) {
      return err({
        rule: "BR-DE-1",
        field: "BG-16",
        severity: "fatal",
        message:
          "XRechnung requires payment instructions (BG-16) with a payment means type code (BT-81). Core EN 16931 leaves this optional, but the German CIUS makes it mandatory so that a public-sector payer can settle the invoice without a phone call.",
        fix: 'Set payment.meansCode to a UNTDID 4461 code: "58" SEPA credit transfer, "30" credit transfer, "59" SEPA direct debit, "48" card, "57" standing order, "97" clearing between partners. For a credit transfer also set payment.iban.',
        example: `"payment": { "meansCode": "58", "iban": "DE02120300000000202051", "accountName": "Acme GmbH" }`,
        xpath: "/ubl:Invoice/cac:PaymentMeans",
        docsUrl: `${DOCS}/BR-DE-1`,
      });
    }
    return null;
  },

  // BR-61: credit-transfer payment means require an account identifier.
  (inv) => {
    const payment = inv.payment;
    if (!payment || blank(payment.meansCode)) return null;
    const creditTransfer = ["30", "58"].includes(payment.meansCode.trim());
    if (!creditTransfer || !blank(payment.iban)) return null;
    return err({
      rule: "BR-61",
      field: "BT-84",
      severity: "fatal",
      message: `The payment means type code (BT-81) is "${payment.meansCode}", which means a credit transfer, so the payment account identifier (BT-84) must be present. You have told the buyer to transfer money without saying where to.`,
      fix: "Set payment.iban to the receiving account (IBAN inside SEPA). Add payment.bic only if the account is outside SEPA or your bank requires it.",
      example: `"payment": { "meansCode": "58", "iban": "DE02120300000000202051" }`,
      xpath: "/ubl:Invoice/cac:PaymentMeans/cac:PayeeFinancialAccount/cbc:ID",
      docsUrl: `${DOCS}/BR-61`,
    });
  },

  // BR-DE-2 plus BR-DE-5/6/7: the seller contact group, in full.
  (inv) => {
    if (!isXRechnung(inv)) return null;
    const contact = inv.seller?.contact;
    const empty =
      !contact ||
      (blank(contact.name) && blank(contact.phone) && blank(contact.email));
    if (empty) {
      return err({
        rule: "BR-DE-2",
        field: "BG-6",
        severity: "fatal",
        message:
          "XRechnung requires the seller contact group (BG-6), and requires it complete: contact point (BT-41), telephone number (BT-42) and email address (BT-43) are each individually mandatory under BR-DE-5, BR-DE-6 and BR-DE-7. A public-sector payer must have a named human route to query the invoice.",
        fix: "Set seller.contact with all three of name, phone and email. A shared departmental identity is fine and usually preferable to a named individual.",
        example: `"contact": { "name": "Buchhaltung", "phone": "+49 30 1234567", "email": "rechnungen@musterlieferant.example" }`,
        xpath: "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:Contact",
        docsUrl: `${DOCS}/BR-DE-2`,
      });
    }
    const out: TeachingError[] = [];
    for (const spec of DE_CONTACT_RULES) {
      if (!blank(contact[spec.key])) continue;
      out.push({
        rule: spec.rule,
        field: spec.field,
        severity: "fatal",
        message: `XRechnung requires the element "${spec.label}" (${spec.field}). The seller contact group is present but incomplete — BR-DE-5, BR-DE-6 and BR-DE-7 each make one part of it mandatory, so supplying two of the three still fails.`,
        fix: spec.fix,
        example: spec.example,
        xpath: `/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:Contact/${
          spec.key === "name"
            ? "cbc:Name"
            : spec.key === "phone"
              ? "cbc:Telephone"
              : "cbc:ElectronicMail"
        }`,
        docsUrl: `${DOCS}/${spec.rule}`,
      });
    }
    return out;
  },

  // BR-DE-3/4/8/9: city and post code on both parties.
  (inv) => {
    if (!isXRechnung(inv)) return null;
    const out: TeachingError[] = [];
    for (const spec of DE_ADDRESS_RULES) {
      const party = spec.party === "seller" ? inv.seller : inv.buyer;
      if (!party?.address) continue; // BR-08 / BR-10 already reported it
      if (!blank(party.address[spec.key])) continue;
      out.push({
        rule: spec.rule,
        field: spec.field,
        severity: "fatal",
        message: `XRechnung requires the element "${spec.label}" (${spec.field}). Core EN 16931 only requires the country code, but the German CIUS additionally makes city and post code mandatory on both parties so that the address is deliverable, not merely jurisdictional.`,
        fix: `Set ${spec.party}.address.${spec.key}.`,
        example:
          spec.key === "city" ? `"city": "Berlin"` : `"postalCode": "10115"`,
        xpath: `/ubl:Invoice/cac:Accounting${spec.party === "seller" ? "Supplier" : "Customer"}Party/cac:Party/cac:PostalAddress/${spec.key === "city" ? "cbc:CityName" : "cbc:PostalZone"}`,
        docsUrl: `${DOCS}/${spec.rule}`,
      });
    }
    return out;
  },

  // BR-DE-10 / BR-DE-11: once BG-15 exists, it must be a complete address.
  // Caught in the wild by the KoSIT validator: emitting a deliver-to address
  // with only a country code passes core EN 16931 and is rejected by XRechnung.
  (inv) => {
    if (!isXRechnung(inv) || !inv.deliverTo) return null;
    const out: TeachingError[] = [];
    const checks = [
      {
        rule: "BR-DE-10",
        field: "BT-77" as const,
        label: "Deliver to city",
        key: "city" as const,
        example: `"deliverTo": { "city": "Lyon", "postalCode": "69001", "countryCode": "FR" }`,
      },
      {
        rule: "BR-DE-11",
        field: "BT-78" as const,
        label: "Deliver to post code",
        key: "postalCode" as const,
        example: `"deliverTo": { "city": "Lyon", "postalCode": "69001", "countryCode": "FR" }`,
      },
    ];
    for (const check of checks) {
      if (!blank(inv.deliverTo[check.key])) continue;
      out.push({
        rule: check.rule,
        field: check.field,
        severity: "fatal",
        message: `XRechnung requires the element "${check.label}" (${check.field}) whenever the deliver-to address group (BG-15) is present. BG-15 is optional, but it is all-or-nothing: a delivery address consisting only of a country code is rejected, even though core EN 16931 accepts it.`,
        fix: `Either set deliverTo.${check.key}, or drop deliverTo entirely and keep only deliveryDate (BT-72) — unless a rule such as BR-IC-12 requires the destination country, in which case you must supply the full address.`,
        example: check.example,
        xpath: `/ubl:Invoice/cac:Delivery/cac:DeliveryLocation/cac:Address/${check.key === "city" ? "cbc:CityName" : "cbc:PostalZone"}`,
        docsUrl: `${DOCS}/${check.rule}`,
      });
    }
    return out;
  },

  // BR-DE-16: at least one seller tax identifier when a tax code is used.
  (inv) => {
    if (!isXRechnung(inv)) return null;
    const taxed = (inv.lines ?? []).some((l) =>
      ["S", "Z", "E", "AE", "K", "G", "L", "M"].includes(l.vatCategory),
    );
    if (!taxed || !inv.seller || sellerTaxIdentified(inv.seller)) return null;
    return err({
      rule: "BR-DE-16",
      field: ["BT-31", "BT-32"],
      severity: "fatal",
      message:
        "XRechnung requires that, when the tax codes S, Z, E, AE, K, G, L or M are used, at least one of the seller VAT identifier (BT-31), the seller tax registration identifier (BT-32) or a seller tax representative party (BG-11) is present. This is stricter than core EN 16931, which only imposes it per category.",
      fix: 'Set seller.vatId (Umsatzsteuer-Identifikationsnummer, e.g. "DE123456789") or seller.taxRegistrationId (Steuernummer, e.g. "181/815/08155").',
      example: `"seller": { "vatId": "DE123456789" }`,
      docsUrl: `${DOCS}/BR-DE-16`,
    });
  },

  // BR-DE-17: restricted UNTDID 1001 code set.
  (inv) => {
    if (!isXRechnung(inv)) return null;
    const code = (inv.invoiceTypeCode ?? DEFAULT_INVOICE_TYPE_CODE).trim();
    if (DE_INVOICE_TYPE_CODES.has(code)) return null;
    return err({
      rule: "BR-DE-17",
      field: "BT-3",
      severity: "fatal",
      message: `XRechnung restricts the invoice type code (BT-3) to 326, 380, 381, 384, 389, 875, 876 and 877 from UNTDID 1001, but "${code}" was supplied. The wider UNTDID list is legal under core EN 16931 and will be rejected by a German receiving portal.`,
      fix: 'Use "380" for a commercial invoice, "381" for a credit note, "384" for a corrected invoice (and then also supply the preceding invoice reference, BR-DE-26), "326" for a partial invoice, "389" for self-billing.',
      example: `"invoiceTypeCode": "380"`,
      xpath: "/ubl:Invoice/cbc:InvoiceTypeCode",
      docsUrl: `${DOCS}/BR-DE-17`,
    });
  },

  // BR-DE-27: telephone number should contain at least three digits.
  (inv) => {
    if (!isXRechnung(inv)) return null;
    const phone = inv.seller?.contact?.phone;
    if (blank(phone)) return null; // BR-DE-6 covers absence
    const digits = (phone!.match(/\d/g) ?? []).length;
    if (digits >= 3) return null;
    return err({
      rule: "BR-DE-27",
      field: "BT-42",
      severity: "warning",
      message: `The seller contact telephone number (BT-42) should contain at least three digits, but "${phone}" contains ${digits}. KoSIT raises this as a warning rather than an error, so the invoice will be accepted — but the number as written cannot be dialled.`,
      fix: 'Write the full number in international format, e.g. "+49 30 1234567".',
      example: `"phone": "+49 30 1234567"`,
      xpath: "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:Contact/cbc:Telephone",
      docsUrl: `${DOCS}/BR-DE-27`,
    });
  },

  // BR-DE-28: email address shape.
  (inv) => {
    if (!isXRechnung(inv)) return null;
    const email = inv.seller?.contact?.email;
    if (blank(email)) return null; // BR-DE-7 covers absence
    const value = email!.trim();
    const parts = value.split("@");
    const ok =
      parts.length === 2 &&
      (parts[0]?.length ?? 0) >= 2 &&
      (parts[1]?.length ?? 0) >= 2 &&
      !/\s/.test(value) &&
      !value.startsWith(".") &&
      !value.endsWith(".") &&
      !parts[0]!.endsWith(".") &&
      !parts[1]!.startsWith(".");
    if (ok) return null;
    return err({
      rule: "BR-DE-28",
      field: "BT-43",
      severity: "warning",
      message: `The seller contact email address (BT-43) must contain exactly one "@", flanked by at least two characters on each side and by neither a space nor a dot, and must not begin or end with a dot. "${value}" does not satisfy that shape.`,
      fix: "Supply a single, plain email address — no display name, no angle brackets, no comma-separated list.",
      example: `"email": "rechnungen@musterlieferant.example"`,
      xpath: "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:Contact/cbc:ElectronicMail",
      docsUrl: `${DOCS}/BR-DE-28`,
    });
  },
];

export function runInputRules(inv: InvoiceInput): TeachingError[] {
  const out: TeachingError[] = [];
  for (const rule of inputRules) {
    const result = rule(inv);
    if (!result) continue;
    if (Array.isArray(result)) out.push(...result);
    else out.push(result);
  }
  return out;
}
