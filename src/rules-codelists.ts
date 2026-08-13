import { DEFAULT_INVOICE_TYPE_CODE } from "./generate.js";
import { computeTotals } from "./totals.js";
import {
  COUNTRY_CODES_SET,
  CURRENCY_CODES_SET,
  EAS_SCHEME_CODES_SET,
  INVOICE_TYPE_CODES,
  INVOICE_TYPE_CODES_SET,
  PAYMENT_MEANS_CODES_SET,
  UNIT_CODES_SET,
  VAT_CATEGORY_CODES,
  VAT_CATEGORY_CODES_SET,
} from "./codelists/index.js";
import { DOCS, blank, err, linesOf } from "./rule-kit.js";
import type { RuleFn } from "./rule-kit.js";
import type { TeachingError } from "./types.js";

/**
 * BR-CL-*: code-list membership.
 *
 * These are the rules that turn "looks like a currency code" into "is a
 * currency code". Until this wave the library shape-checked coded fields —
 * three letters, two letters, non-empty — which accepts `"EURO"`,
 * `"XX"`, `"hours"` and every other near-miss a human or an LLM produces. The
 * lists themselves are generated from the same schematron KoSIT evaluates
 * (`scripts/build-codelists.mjs`), so a BR-CL finding here and a BR-CL finding
 * from the official validator cannot disagree about what is in the list.
 *
 * Rule texts from `ubl/schematron/codelist/EN16931-UBL-codes.sch`,
 * ConnectingEurope/eInvoicing-EN16931 @ validation-1.3.16.
 */

/** Codes worth naming in a message, so the fix is actionable without the spec. */
const COMMON_UNITS =
  '"C62" one/piece, "HUR" hour, "DAY" day, "MON" month, "ANN" year, "KGM" kilogram, "MTR" metre, "MTK" square metre, "LTR" litre, "KWH" kilowatt hour, "E48" service unit, "P1" percent';

const COMMON_CURRENCIES = '"EUR", "USD", "GBP", "CHF", "SEK", "DKK", "NOK", "PLN"';

/** A short, deterministic sample of a list, for messages. */
const sample = (codes: readonly string[], n: number): string =>
  codes.slice(0, n).map((c) => `"${c}"`).join(", ");

/**
 * Case handling. The schematron compares the *literal* element content: it
 * neither upper-cases nor trims beyond `normalize-space`. So `"eur"` fails
 * BR-CL-04 at KoSIT even though every human would read it as EUR. We match
 * that, and say so — silently upper-casing here would hide a defect that the
 * regulator's validator will find.
 */
const normalise = (value: string): string => value.trim();

const wrongCaseHint = (value: string, set: ReadonlySet<string>): string =>
  set.has(value.trim().toUpperCase()) && value.trim() !== value.trim().toUpperCase()
    ? ` The upper-case form "${value.trim().toUpperCase()}" *is* in the list — the code list is case-sensitive and the schematron compares the element content literally, so lower-case fails.`
    : "";

export const codelistRules: RuleFn[] = [
  // BR-CL-01: The document type code MUST be coded by the invoice and credit
  // note related code lists of UNTDID 1001.
  (inv) => {
    const code = normalise(inv.invoiceTypeCode ?? DEFAULT_INVOICE_TYPE_CODE);
    if (INVOICE_TYPE_CODES_SET.has(code)) return null;
    return err({
      rule: "BR-CL-01",
      field: "BT-3",
      severity: "fatal",
      message: `The invoice type code (BT-3) must be a code from the invoice-related subset of UNTDID 1001, but "${code}" is not in it. UNTDID 1001 splits into an invoice list (carried on cbc:InvoiceTypeCode) and a credit-note list (carried on cbc:CreditNoteTypeCode of a separate CreditNote document); a credit-note code on an invoice fails this rule even though the code itself is perfectly valid. The invoice list holds ${INVOICE_TYPE_CODES.length} codes, beginning ${sample(INVOICE_TYPE_CODES, 6)}.`,
      fix: 'Use "380" for an ordinary commercial invoice. Other codes you are likely to want: "326" partial invoice, "384" corrected invoice, "389" self-billed invoice, "875"/"876"/"877" construction invoices. Under XRechnung the list narrows further — BR-DE-17 admits only those plus "381".',
      example: `"invoiceTypeCode": "380"`,
      xpath: "/ubl:Invoice/cbc:InvoiceTypeCode",
      docsUrl: `${DOCS}/BR-CL-01`,
    });
  },

  // BR-CL-04: Invoice currency code MUST be coded using ISO code list 4217
  // alpha-3.  BR-CL-03: the same list, applied to the @currencyID attribute
  // that every monetary amount in the document carries.
  (inv) => {
    if (blank(inv.currency)) return null; // BR-05 reports absence
    const code = normalise(inv.currency);
    if (CURRENCY_CODES_SET.has(code)) return null;
    const hint = wrongCaseHint(inv.currency, CURRENCY_CODES_SET);
    const out: TeachingError[] = [
      {
        rule: "BR-CL-04",
        field: "BT-5",
        severity: "fatal",
        message: `The invoice currency code (BT-5) must be an ISO 4217 alphabetic code, but "${code}" is not one.${hint} A three-letter shape is not enough — the schematron tests membership of the list, so "XYZ" and "EURO" both fail.`,
        fix: `Set currency to the ISO 4217 alpha-3 code in upper case. Common values: ${COMMON_CURRENCIES}. Use the code, never the symbol or the name.`,
        example: `"currency": "EUR"`,
        xpath: "/ubl:Invoice/cbc:DocumentCurrencyCode",
        docsUrl: `${DOCS}/BR-CL-04`,
      },
      {
        // Reported once, not once per amount: the generator writes this single
        // value into @currencyID on every amount element, so the whole document
        // fails or none of it does. KoSIT will report one BR-CL-03 per element.
        rule: "BR-CL-03",
        field: "BT-5",
        severity: "fatal",
        message: `Every monetary amount in the document carries a currencyID attribute, and it must be an ISO 4217 alphabetic code. This library writes the invoice currency code (BT-5) into all of them, so "${code}" fails BR-CL-03 on each amount element — the line net amounts, the VAT breakdown amounts and all five document totals — as well as failing BR-CL-04 on the currency code itself.`,
        fix: "Fix the currency code once, at the document level. There is no per-amount currency in this model, and EN 16931 does not permit mixing currencies inside one invoice: the only second currency it recognises is the VAT accounting currency (BT-6), which reports the VAT total again in the currency your tax authority requires and changes no other amount on the document. Set vatAccountingCurrency together with taxAmountInAccountingCurrency (BT-111) if you need it — BR-53 requires both or neither.",
        example: `"currency": "EUR"`,
        xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:PayableAmount/@currencyID",
        docsUrl: `${DOCS}/BR-CL-03`,
      },
    ];
    return out;
  },

  // BR-CL-14: Country codes in an invoice MUST be coded using ISO code list
  // 3166-1.
  //
  // The schematron context is `cac:Country/cbc:IdentificationCode` — every one
  // of them, wherever it sits. In the documents this build generates that is
  // four elements, not three: seller (BT-40), buyer (BT-55), seller tax
  // representative (BT-69) and deliver-to (BT-80). BT-69 was missing until
  // 0.4.0, excused by a comment that listed the other three and called the
  // list complete. `taxRepresentative.address.countryCode` has been in the
  // model since 0.2.0 — BR-20 in rules-references.ts already reads it — and
  // KoSIT rejects a bad value there under this rule id. Verified against
  // XRechnung 3.0.2 (EN16931-UBL-validation.xsl).
  //
  // `cac:OriginCountry/cbc:IdentificationCode` (BT-159) is NOT here: the
  // schematron gives it a template of its own at a higher priority, which is
  // BR-CL-15.
  (inv) => {
    const out: TeachingError[] = [];
    const check = (
      value: string | undefined,
      field: `BT-${number}`,
      who: string,
      setter: string,
      path: string,
    ) => {
      if (blank(value)) return; // BR-09 / BR-11 / BR-57 report absence
      const code = normalise(value!);
      if (COUNTRY_CODES_SET.has(code)) return;
      const greek =
        code.toUpperCase() === "EL"
          ? ' "EL" is the VAT-number prefix Greece uses (BR-CO-09 allows it there and only there); the country code for Greece is "GR".'
          : "";
      const uk =
        code.toUpperCase() === "UK"
          ? ' The United Kingdom is "GB" in ISO 3166-1 — "UK" is a reserved code and is not in the list.'
          : "";
      out.push({
        rule: "BR-CL-14",
        field,
        severity: "fatal",
        message: `The ${who} country code (${field}) must be an ISO 3166-1 alpha-2 code, but "${code}" is not in the list.${greek}${uk}${wrongCaseHint(value!, COUNTRY_CODES_SET)} This code drives place-of-supply, reverse-charge and intra-community logic downstream, so a code the receiver cannot resolve stops the invoice at the door.`,
        fix: `Set ${setter} to the two-letter ISO 3166-1 code in upper case — "DE" Germany, "AT" Austria, "FR" France, "NL" Netherlands, "GR" Greece, "GB" United Kingdom.`,
        example: `"countryCode": "DE"`,
        xpath: path,
        docsUrl: `${DOCS}/BR-CL-14`,
      });
    };
    check(
      inv.seller?.address?.countryCode,
      "BT-40",
      "seller",
      "seller.address.countryCode",
      "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PostalAddress/cac:Country/cbc:IdentificationCode",
    );
    check(
      inv.buyer?.address?.countryCode,
      "BT-55",
      "buyer",
      "buyer.address.countryCode",
      "/ubl:Invoice/cac:AccountingCustomerParty/cac:Party/cac:PostalAddress/cac:Country/cbc:IdentificationCode",
    );
    check(
      inv.taxRepresentative?.address?.countryCode,
      "BT-69",
      "seller tax representative",
      "taxRepresentative.address.countryCode",
      "/ubl:Invoice/cac:TaxRepresentativeParty/cac:PostalAddress/cac:Country/cbc:IdentificationCode",
    );
    check(
      inv.deliverTo?.countryCode,
      "BT-80",
      "deliver-to",
      "deliverTo.countryCode",
      "/ubl:Invoice/cac:Delivery/cac:DeliveryLocation/cac:Address/cac:Country/cbc:IdentificationCode",
    );
    return out;
  },

  // BR-CL-16: Payment means in an invoice MUST be coded using UNCL4461.
  (inv) => {
    const code = inv.payment?.meansCode;
    if (blank(code)) return null; // BR-49 / BR-DE-1 report absence
    if (PAYMENT_MEANS_CODES_SET.has(normalise(code!))) return null;
    return err({
      rule: "BR-CL-16",
      field: "BT-81",
      severity: "fatal",
      message: `The payment means type code (BT-81) must come from UNTDID 4461, but "${normalise(code!)}" is not in that list. The code is what tells the payer's system how the money is meant to move; free text such as "bank transfer" or an invented code is not resolvable.`,
      fix: 'Use "58" SEPA credit transfer (the default for euro-area invoices), "30" credit transfer, "59" SEPA direct debit, "48" bank card, "57" standing agreement, "97" clearing between partners, or "1" instrument not defined. Note that XRechnung then requires the matching payment group: BG-17 for 30/58, BG-18 for 48/54/55, BG-19 for 59.',
      example: `"payment": { "meansCode": "58", "iban": "DE02120300000000202051" }`,
      xpath: "/ubl:Invoice/cac:PaymentMeans/cbc:PaymentMeansCode",
      docsUrl: `${DOCS}/BR-CL-16`,
    });
  },

  // BR-CL-18: Invoice tax categories MUST be coded using UNCL5305.
  // Bound in UBL to cac:ClassifiedTaxCategory/cbc:ID — the *line* category
  // (BT-151).
  (inv) => {
    const out: TeachingError[] = [];
    for (const [index, line] of linesOf(inv).entries()) {
      const raw = line?.vatCategory as unknown as string | undefined;
      if (blank(raw)) continue; // BR-CO-04 reports absence
      if (VAT_CATEGORY_CODES_SET.has(normalise(raw!))) continue;
      out.push({
        rule: "BR-CL-18",
        field: "BT-151",
        severity: "fatal",
        message: `Line ${index + 1} has an invoiced item VAT category code (BT-151) of "${normalise(raw!)}", which is not in UNTDID 5305. EN 16931 admits exactly ${VAT_CATEGORY_CODES.length} codes: ${sample(VAT_CATEGORY_CODES, VAT_CATEGORY_CODES.length)}. The category is not a label — it selects which BR-S/BR-Z/BR-E/BR-AE/BR-IC/BR-G/BR-O family of rules the line and its VAT breakdown are judged by.`,
        fix: 'Use "S" standard rated, "Z" zero rated, "E" exempt, "AE" reverse charge, "K" intra-community supply, "G" export outside the EU, "O" not subject to VAT, "L" IGIC (Canary Islands) or "M" IPSI (Ceuta and Melilla). The tenth code, "B" (split payment, Italy), is a valid EN 16931 code that this build does not express.',
        example: `"vatCategory": "S", "vatRate": 19`,
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:Item/cac:ClassifiedTaxCategory/cbc:ID`,
        docsUrl: `${DOCS}/BR-CL-18`,
      });
    }
    return out;
  },

  // BR-CL-17: the same code list, bound in UBL to cac:TaxCategory/cbc:ID —
  // the *VAT breakdown* category (BT-118). Reported separately because the
  // generated document carries both elements, and KoSIT reports both.
  (inv) => {
    if (linesOf(inv).length === 0) return null;
    let computed;
    try {
      computed = computeTotals(inv);
    } catch {
      return null; // malformed line data; BR-22 / BR-24 / BR-26 report it
    }
    const seen = new Set<string>();
    const out: TeachingError[] = [];
    for (const subtotal of computed.subtotals) {
      const code = String(subtotal.category ?? "").trim();
      if (!code || VAT_CATEGORY_CODES_SET.has(code) || seen.has(code)) continue;
      seen.add(code);
      out.push({
        rule: "BR-CL-17",
        field: "BT-118",
        severity: "fatal",
        message: `The VAT breakdown (BG-23) computed from your lines contains a VAT category code (BT-118) of "${code}", which is not in UNTDID 5305. The breakdown categories are taken straight from the line categories (BT-151), so this is the document-level consequence of the same bad code — KoSIT reports it against both elements, and so do we.`,
        fix: "Correct the offending line's vatCategory. The breakdown is always computed from the lines, so there is nothing to fix at document level.",
        example: `"vatCategory": "S", "vatRate": 19`,
        xpath: "/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID",
        docsUrl: `${DOCS}/BR-CL-17`,
      });
    }
    return out;
  },

  // BR-CL-23: Unit code MUST be coded according to UN/ECE Recommendation 20
  // with the Rec 21 extension.
  (inv) => {
    const out: TeachingError[] = [];
    for (const [index, line] of linesOf(inv).entries()) {
      if (blank(line?.unitCode)) continue; // BR-23 reports absence
      const code = normalise(line.unitCode);
      if (UNIT_CODES_SET.has(code)) continue;
      out.push({
        rule: "BR-CL-23",
        field: "BT-130",
        severity: "fatal",
        message: `Line ${index + 1} has a unit of measure code (BT-130) of "${code}", which is not in UN/ECE Recommendation 20 (with the Rec 21 extension).${wrongCaseHint(line.unitCode, UNIT_CODES_SET)} The unit is a code, not a word: "hours", "Stk", "each" and "pcs" are all rejected, and so is a valid code in the wrong case.`,
        fix: `Set line.unitCode to the Rec 20 code. The ones you will actually use: ${COMMON_UNITS}. The full list is large — if you cannot find your unit, "C62" (one/piece) with the unit named in the item description is the conventional fallback.`,
        example: `"quantity": 10, "unitCode": "HUR"`,
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cbc:InvoicedQuantity/@unitCode`,
        docsUrl: `${DOCS}/BR-CL-23`,
      });
    }
    return out;
  },

  // BR-CL-25: Endpoint identifier scheme identifier MUST belong to the CEF EAS
  // code list.
  (inv) => {
    const out: TeachingError[] = [];
    const check = (
      schemeId: string | undefined,
      field: `BT-${number}`,
      who: string,
      setter: string,
      path: string,
    ) => {
      if (blank(schemeId)) return; // BR-62 / BR-63 report absence
      const code = normalise(schemeId!);
      if (EAS_SCHEME_CODES_SET.has(code)) return;
      out.push({
        rule: "BR-CL-25",
        field,
        severity: "fatal",
        message: `The scheme identifier on the ${who} electronic address (${field}) is "${code}", which is not in the CEF Electronic Address Scheme (EAS) list. EAS is a narrower list than the ISO 6523 ICD list used for party identifiers, so a code that is valid as a party scheme can still be invalid here — the access point routes on this pair, and a scheme it does not know is an undeliverable address.`,
        fix: `Set ${setter}.schemeId to an EAS code: "0204" German Leitweg-ID, "9930" German VAT identifier, "0088" GLN, "0192" Norwegian organisation number, "0106" Dutch KvK/OIN, "EM" email address.`,
        example: `"electronicAddress": { "schemeId": "0204", "value": "04011000-1234512345-06" }`,
        xpath: `${path}/@schemeID`,
        docsUrl: `${DOCS}/BR-CL-25`,
      });
    };
    check(
      inv.seller?.electronicAddress?.schemeId,
      "BT-34",
      "seller",
      "seller.electronicAddress",
      "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cbc:EndpointID",
    );
    check(
      inv.buyer?.electronicAddress?.schemeId,
      "BT-49",
      "buyer",
      "buyer.electronicAddress",
      "/ubl:Invoice/cac:AccountingCustomerParty/cac:Party/cbc:EndpointID",
    );
    return out;
  },
];
