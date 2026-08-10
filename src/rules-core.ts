import { DEFAULT_INVOICE_TYPE_CODE } from "./generate.js";
import { computeTotals, lineNetAmount } from "./totals.js";
import {
  DOCS,
  LIMITS_DOCS,
  allowanceChargePath,
  blank,
  decimalPlaces,
  documentAllowanceCharges,
  err,
  isIsoDate,
  isPeppol,
  linesOf,
} from "./rule-kit.js";
import type { RuleFn } from "./rule-kit.js";
import type { InvoiceTotals, TeachingError } from "./types.js";

/**
 * Core EN 16931 rules (BR-*) that the current input model can express and that
 * `rules.ts` did not yet cover.
 *
 * Rule texts from `ubl/schematron/abstract/EN16931-model.sch`,
 * ConnectingEurope/eInvoicing-EN16931 @ validation-1.3.16.
 */

/** BT-106/BT-109/BT-112/BT-115 must each be present on the document. */
const TOTAL_SPECS: {
  rule: string;
  field: `BT-${number}`;
  key: keyof InvoiceTotals;
  label: string;
  xpath: string;
  why: string;
}[] = [
  {
    rule: "BR-12",
    field: "BT-106",
    key: "lineExtensionAmount",
    label: "Sum of Invoice line net amounts",
    xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:LineExtensionAmount",
    why: "It is the anchor the rest of the totals are derived from: BT-109 starts here, and BR-CO-10 checks it against the lines.",
  },
  {
    rule: "BR-13",
    field: "BT-109",
    key: "taxExclusiveAmount",
    label: "Invoice total amount without VAT",
    xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount",
    why: "It is the figure the buyer books as expenditure, separately from the VAT they may reclaim.",
  },
  {
    rule: "BR-14",
    field: "BT-112",
    key: "taxInclusiveAmount",
    label: "Invoice total amount with VAT",
    xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount",
    why: "It is the gross value of the supply, and BR-CO-15 ties it to BT-109 + BT-110.",
  },
  {
    rule: "BR-15",
    field: "BT-115",
    key: "payableAmount",
    label: "Amount due for payment",
    xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:PayableAmount",
    why: "It is the only figure on the document that says what to actually pay — it differs from BT-112 whenever a prepayment (BT-113) or a rounding amount (BT-114) applies.",
  },
];

export const coreRules: RuleFn[] = [
  // BR-04: An Invoice shall have an Invoice type code (BT-3).
  //
  // The model defaults BT-3 to "380", so this fires only when a caller sets the
  // field to an empty or whitespace value — which is a different mistake from
  // omitting it, and a more dangerous one, because it looks deliberate.
  (inv) => {
    if (inv.invoiceTypeCode === undefined) return null;
    if (!blank(inv.invoiceTypeCode)) return null;
    return err({
      rule: "BR-04",
      field: "BT-3",
      severity: "fatal",
      message: `An invoice must have an invoice type code (BT-3), but invoiceTypeCode was set to ${JSON.stringify(inv.invoiceTypeCode)}. The type code is what distinguishes a commercial invoice from a partial invoice, a correction or a self-billed document, and receiving systems branch on it before they read anything else. An empty string is not the same as omitting the field: omit it and this library supplies the default "${DEFAULT_INVOICE_TYPE_CODE}"; set it empty and you have explicitly asked for a document with no type.`,
      fix: `Remove invoiceTypeCode to accept the default "${DEFAULT_INVOICE_TYPE_CODE}" (commercial invoice), or set it to the UNTDID 1001 code you actually mean.`,
      example: `"invoiceTypeCode": "380"`,
      xpath: "/ubl:Invoice/cbc:InvoiceTypeCode",
      docsUrl: `${DOCS}/BR-04`,
    });
  },

  // BR-CO-04: Each Invoice line (BG-25) shall be categorized with an Invoiced
  // item VAT category code (BT-151).
  (inv) => {
    const out: TeachingError[] = [];
    for (const [index, line] of linesOf(inv).entries()) {
      if (!blank(line?.vatCategory as unknown as string)) continue;
      out.push({
        rule: "BR-CO-04",
        field: "BT-151",
        severity: "fatal",
        message: `Line ${index + 1}${line?.id ? ` (id "${line.id}")` : ""} has no invoiced item VAT category code (BT-151). Every invoice line must be categorized, without exception — there is no "default" VAT treatment in EN 16931, because the category is what determines whether VAT is charged, who accounts for it, and what evidence the exemption rests on. An uncategorized line also cannot be placed in any VAT breakdown group (BG-23).`,
        fix: 'Set line.vatCategory to one of "S" standard rated, "Z" zero rated, "E" exempt, "AE" reverse charge, "K" intra-community supply, "G" export outside the EU, "O" not subject to VAT, "L" IGIC (Canary Islands) or "M" IPSI (Ceuta and Melilla). If tax is charged, set line.vatRate alongside it.',
        example: `"vatCategory": "S", "vatRate": 19`,
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:Item/cac:ClassifiedTaxCategory/cbc:ID`,
        docsUrl: `${DOCS}/BR-CO-04`,
      });
    }
    return out;
  },

  // ATW-VAT-CATEGORY-UNSUPPORTED: a library limitation, not a regulation rule.
  //
  // Category `B` (split payment, Italy) is a legal EN 16931 code. BR-CL-17 and
  // BR-CL-18 admit it, so the code-list rules pass it; the model's `VatCategory`
  // union does not carry it, so no per-category family claims it either. Before
  // wave C that combination was a silent hole: a JavaScript caller, or a JSON
  // payload arriving over HTTP where TypeScript's union is not enforced, could
  // set `"B"` and receive a completely clean `ValidationResult` — and then a
  // generated document with a `B` breakdown group that no rule in this package
  // had checked and that Italy's own rules (BR-B-01, BR-B-02, and the IT-R-*
  // national set) would have had a great deal to say about.
  //
  // Refusing is the honest interim, exactly as for credit notes. The finding is
  // fatal and carries an `ATW-` id, because it is a statement about this
  // library rather than about the invoice: the document may be perfectly legal.
  //
  // Wave B gave document level allowances (BT-95) and charges (BT-102) their
  // own VAT category, and `computeTotals` builds a breakdown group from them —
  // so restricting this check to BT-151 reopened exactly the hole it was
  // written to close. A `"B"` allowance validated completely clean and reached
  // the emitted XML as an unchecked `B` breakdown group. All three sites are
  // checked here.
  (inv) => {
    const out: TeachingError[] = [];
    for (const tagged of documentAllowanceCharges(inv)) {
      if ((tagged.entry.vatCategory as unknown as string) !== "B") continue;
      out.push({
        rule: "ATW-VAT-CATEGORY-UNSUPPORTED",
        field: tagged.isCharge ? "BT-102" : "BT-95",
        severity: "fatal",
        message: `The ${tagged.label} at ${allowanceChargePath(tagged)} uses VAT category "B" (split payment), which this build does not support. "B" is a valid EN 16931 code — BR-CL-17 and BR-CL-18 both admit it — but this build's VatCategory union does not carry it, so no per-category rule family claims it, and the breakdown group it produces would reach the generated XML unchecked. Split payment ("scissione dei pagamenti") means the Italian public-sector buyer pays the net amount to you and the VAT directly to the Agenzia delle Entrate, so the invoice states VAT that you will never receive. Getting that wrong is not a formatting error, it is a payment that goes to the wrong party.`,
        fix: `Set ${allowanceChargePath(tagged)}.vatCategory to "S" and handle the split-payment mechanics outside this library, or produce the document with a tool that implements the Italian FatturaPA rules. Note that BR-B-02 forbids category B from sharing a document with any other category, so a "B" adjustment beside standard-rated lines is invalid under the Italian rules regardless.`,
        example: `"vatCategory": "S", "vatRate": 22`,
        xpath: `${tagged.xpath}/cac:TaxCategory/cbc:ID`,
        docsUrl: LIMITS_DOCS,
      });
    }
    for (const [index, line] of linesOf(inv).entries()) {
      const category = line?.vatCategory as unknown as string;
      if (category !== "B") continue;
      out.push({
        rule: "ATW-VAT-CATEGORY-UNSUPPORTED",
        field: "BT-151",
        severity: "fatal",
        message: `Line ${index + 1} uses VAT category "B" (split payment), which this build does not support. "B" is a valid EN 16931 code — BR-CL-17 and BR-CL-18 both admit it — but it is the one category of the ten with no rule family of its own beyond BR-B-01 and BR-B-02, and both of those exist only to confine it: BR-B-01 restricts it to domestic Italian invoices, and BR-B-02 forbids it from sharing a document with any other category. Split payment ("scissione dei pagamenti") means the Italian public-sector buyer pays the net amount to you and the VAT directly to the Agenzia delle Entrate, so the invoice states VAT that you will never receive. Getting that wrong is not a formatting error, it is a payment that goes to the wrong party.`,
        fix: 'Use category "S" and handle the split-payment mechanics outside this library, or produce the document with a tool that implements the Italian FatturaPA rules. If the supply is not Italian public-sector, "B" is the wrong code regardless.',
        example: `"vatCategory": "S", "vatRate": 22`,
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:Item/cac:ClassifiedTaxCategory/cbc:ID`,
        docsUrl: LIMITS_DOCS,
      });
    }
    return out;
  },

  // BR-24: Each Invoice line (BG-25) shall have an Invoice line net amount
  // (BT-131).
  //
  // BT-131 is derived — quantity x (net price / base quantity) — so the way it
  // goes missing is that it cannot be computed. Base quantity zero is the case
  // that matters: before this rule existed, `computeTotals` and
  // `generateXRechnungUBL` threw a bare RangeError, and `validateInput`
  // swallowed it and returned clean.
  (inv) => {
    const out: TeachingError[] = [];
    for (const [index, line] of linesOf(inv).entries()) {
      if (!line) continue;
      if (typeof line.quantity !== "number" || typeof line.unitPrice !== "number") {
        continue; // BR-22 / BR-26 report the missing factor
      }
      let amount: number | undefined;
      let reason: string | undefined;
      try {
        amount = lineNetAmount(line);
      } catch {
        reason = `the item price base quantity (BT-149) is ${line.baseQuantity}, and dividing by it is undefined`;
      }
      if (amount !== undefined && !Number.isFinite(amount)) {
        reason = `the computation ${line.quantity} x ${line.unitPrice}${line.baseQuantity !== undefined ? ` / ${line.baseQuantity}` : ""} does not produce a finite amount`;
      }
      if (!reason) continue;
      out.push({
        rule: "BR-24",
        field: "BT-131",
        severity: "fatal",
        message: `Line ${index + 1}${line.id ? ` (id "${line.id}")` : ""} has no invoice line net amount (BT-131), because ${reason}. BT-131 is not an input in this model — it is derived as invoiced quantity (BT-129) x item net price (BT-146) / item price base quantity (BT-149) — so a factor that makes the division impossible removes the line amount, and with it the document totals and the whole VAT breakdown.`,
        fix: 'Set line.baseQuantity to the number of units the price refers to, and never to zero. Use 1 (the default) when the price is per single unit; use 100 when you quote "€12.50 per 100 sheets" with quantity in sheets. Omit the field entirely if you are not pricing per bundle.',
        example: `"quantity": 500, "unitPrice": 12.5, "baseQuantity": 100`,
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cbc:LineExtensionAmount`,
        docsUrl: `${DOCS}/BR-24`,
      });
    }
    return out;
  },

  // BR-12 / BR-13 / BR-14 / BR-15: the document totals shall be present.
  //
  // This library always computes them, so these are invariants of the
  // arithmetic rather than checks on caller input. They are kept because they
  // are the rules a *reader* of a rejected KoSIT report will be looking up, and
  // because they fail loudly if computeTotals ever regresses.
  (inv) => {
    if (linesOf(inv).length === 0) return null; // BR-16 reports it
    let totals: InvoiceTotals;
    try {
      totals = computeTotals(inv);
    } catch {
      return null; // BR-22 / BR-24 / BR-26 report the underlying line defect
    }
    const out: TeachingError[] = [];
    for (const spec of TOTAL_SPECS) {
      const value = totals[spec.key];
      if (typeof value === "number" && Number.isFinite(value)) continue;
      out.push({
        rule: spec.rule,
        field: spec.field,
        severity: "fatal",
        message: `An invoice must have the ${spec.label} (${spec.field}). ${spec.why} This library computes all five document totals from the invoice lines, so an absent value means the arithmetic failed rather than that you omitted anything.`,
        fix: "This indicates a defect in this library's total computation. Please report it with the invoice payload; as a workaround, check the lines for a non-finite quantity, unit price or base quantity.",
        xpath: spec.xpath,
        docsUrl: `${DOCS}/${spec.rule}`,
      });
    }
    return out;
  },

  // BR-28: The Item gross price (BT-148) shall NOT be negative.
  //
  // BR-27's counterpart on the other price. A gross price is the price before
  // the BT-147 discount, so a negative one is not a discount expressed
  // awkwardly — it is a price that goes the wrong way before any reduction is
  // applied, and the discount then makes it worse.
  (inv) => {
    const out: TeachingError[] = [];
    for (const [index, line] of linesOf(inv).entries()) {
      if (typeof line?.grossUnitPrice !== "number") continue;
      if (!(line.grossUnitPrice < 0)) continue;
      out.push({
        rule: "BR-28",
        field: "BT-148",
        severity: "fatal",
        message: `Line ${index + 1}${line.id ? ` (id "${line.id}")` : ""} has a negative item gross price (BT-148: ${line.grossUnitPrice}). The gross price is the list price *before* the item price discount (BT-147) is taken off, so it is the larger of the two figures by construction — a negative one means the sign has been applied at the wrong end. EN 16931 models every reduction as an allowance or a discount, never as a negative price, and BR-27 says the same thing about the net price (BT-146).`,
        fix: "Set line.grossUnitPrice to the positive list price and line.priceDiscount to the reduction. If the price genuinely is the net price, omit grossUnitPrice entirely — this build derives the discount as grossUnitPrice − unitPrice when you do not state it.",
        example: `"grossUnitPrice": 200, "priceDiscount": 50, "unitPrice": 150`,
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:Price/cac:AllowanceCharge/cbc:BaseAmount`,
        docsUrl: `${DOCS}/BR-28`,
      });
    }
    return out;
  },

  // BR-50: A Payment account identifier (BT-84) shall be present if Credit
  // transfer (BG-17) information is provided in the Invoice.
  //
  // Not a duplicate of BR-61, though they fail together on most documents.
  // BR-61 is triggered by the *means code* — you said 58, so where is the
  // account? BR-50 is triggered by the *group* — you supplied credit-transfer
  // details, so the account identifier inside them is mandatory. An invoice
  // carrying an account name and a BIC but no IBAN trips BR-50 whatever its
  // means code says.
  (inv) => {
    const payment = inv.payment;
    if (!payment) return null;
    const groupPresent = !blank(payment.accountName) || !blank(payment.bic);
    if (!groupPresent || !blank(payment.iban)) return null;
    return err({
      rule: "BR-50",
      field: ["BG-17", "BT-84"],
      severity: "fatal",
      message: `The invoice supplies credit transfer information (BG-17) — ${
        blank(payment.accountName) ? "a payment service provider identifier (BT-86)" : "a payment account name (BT-85)"
      } — but no payment account identifier (BT-84). BT-84 is the only part of the group that actually receives money; the name and the BIC describe the account, they do not identify it. A payer's system reads BT-84 and nothing else.`,
      fix: "Set payment.iban to the receiving account. If you did not mean to give credit transfer details, remove payment.accountName and payment.bic as well — a half-filled BG-17 is worse than none, because it looks answered.",
      example: `"payment": { "meansCode": "58", "iban": "DE02120300000000202051", "accountName": "Acme GmbH" }`,
      xpath: "/ubl:Invoice/cac:PaymentMeans/cac:PayeeFinancialAccount/cbc:ID",
      docsUrl: `${DOCS}/BR-50`,
    });
  },

  // BR-DEC-19 / BR-DEC-20 / BR-DEC-23: two decimals on the amounts this
  // library derives rather than accepts — the VAT category taxable amount
  // (BT-116), the VAT category tax amount (BT-117) and the invoice line net
  // amount (BT-131).
  //
  // Invariants, in the same sense as BR-12..BR-15: everything here goes through
  // round2 and is written with formatAmount, so they cannot fail on any input.
  // They are kept for the same two reasons — a reader looking up a BR-DEC
  // number from a rejected KoSIT report finds it here, and a regression in the
  // rounding shows up as a finding rather than as a document nobody accepts.
  (inv) => {
    if (linesOf(inv).length === 0) return null;
    let totals: InvoiceTotals;
    try {
      totals = computeTotals(inv);
    } catch {
      return null;
    }
    const out: TeachingError[] = [];
    const advice =
      "This amount is computed and rounded by the library, so an over-precise value indicates a defect in its arithmetic rather than in your data. Please report it with the invoice payload.";

    for (const [index, amount] of totals.lineNetAmounts.entries()) {
      if (decimalPlaces(amount) <= 2) continue;
      out.push({
        rule: "BR-DEC-23",
        field: "BT-131",
        severity: "fatal",
        message: `The allowed maximum number of decimals for the invoice line net amount (BT-131) is 2, but line ${index + 1} computed to ${amount}. The rule is written against the serialised value, so what matters is the number of digits after the decimal point in the XML — and a line amount is exactly where they accumulate, because it is a quantity multiplied by a price and then adjusted by allowances and charges.`,
        fix: advice,
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cbc:LineExtensionAmount`,
        docsUrl: `${DOCS}/BR-DEC-23`,
      });
    }

    for (const [index, subtotal] of totals.subtotals.entries()) {
      const at = `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal[${index + 1}]`;
      if (decimalPlaces(subtotal.taxableAmount) > 2) {
        out.push({
          rule: "BR-DEC-19",
          field: "BT-116",
          severity: "fatal",
          message: `The allowed maximum number of decimals for the VAT category taxable amount (BT-116) is 2, but the ${subtotal.category} breakdown computed to ${subtotal.taxableAmount}. The taxable amount is a sum of already-rounded line amounts, less already-rounded document allowances, plus already-rounded document charges — so extra decimals here can only come from one of those having escaped rounding.`,
          fix: advice,
          xpath: `${at}/cbc:TaxableAmount`,
          docsUrl: `${DOCS}/BR-DEC-19`,
        });
      }
      if (decimalPlaces(subtotal.taxAmount) > 2) {
        out.push({
          rule: "BR-DEC-20",
          field: "BT-117",
          severity: "fatal",
          message: `The allowed maximum number of decimals for the VAT category tax amount (BT-117) is 2, but the ${subtotal.category} breakdown computed to ${subtotal.taxAmount}. Applying a percentage produces a long decimal nearly every time, which is why BR-CO-17 requires the multiplication to be rounded to two decimals at the group — once per breakdown group, not once per line.`,
          fix: advice,
          xpath: `${at}/cbc:TaxAmount`,
          docsUrl: `${DOCS}/BR-DEC-20`,
        });
      }
    }
    return out;
  },

  // BR-49: A Payment instruction (BG-16) shall specify the Payment means type
  // code (BT-81).
  //
  // BR-DE-1 already requires the whole group under XRechnung. BR-49 is the core
  // EN 16931 rule and applies to every profile: if you supply payment
  // instructions at all, they must say *how*.
  (inv) => {
    if (!inv.payment) return null; // BG-16 is optional in core EN 16931
    if (!blank(inv.payment.meansCode)) return null;
    return err({
      rule: "BR-49",
      field: "BT-81",
      severity: "fatal",
      message:
        "The invoice carries a payment instruction group (BG-16), so it must specify the payment means type code (BT-81). BG-16 is optional in core EN 16931 — but once present it has to be actionable, and the means code is the part a payment system reads. An IBAN with no means code does not tell the payer whether you expect them to push a credit transfer or whether you intend to collect by direct debit, which are opposite instructions.",
      fix: 'Set payment.meansCode to a UNTDID 4461 code: "58" SEPA credit transfer, "30" credit transfer, "59" SEPA direct debit, "48" bank card, "57" standing agreement, "97" clearing between partners. If you did not mean to give payment instructions at all, remove the payment object.',
      example: `"payment": { "meansCode": "58", "iban": "DE02120300000000202051" }`,
      xpath: "/ubl:Invoice/cac:PaymentMeans/cbc:PaymentMeansCode",
      docsUrl: `${DOCS}/BR-49`,
    });
  },

  // BR-57: Each Deliver to address (BG-15) shall contain a Deliver to country
  // code (BT-80).
  (inv) => {
    if (!inv.deliverTo) return null; // BG-15 is optional
    if (!blank(inv.deliverTo.countryCode)) return null;
    return err({
      rule: "BR-57",
      field: "BT-80",
      severity: "fatal",
      message:
        "The invoice carries a deliver-to address group (BG-15), so it must contain a deliver-to country code (BT-80). BG-15 is optional, but it is not partially optional: the country is the one element of a delivery address that carries tax consequence, because it is what separates a domestic supply from an export, an intra-community supply or a reverse-charge case.",
      fix: 'Set deliverTo.countryCode to the ISO 3166-1 alpha-2 code of the place of delivery, or remove deliverTo entirely if the goods or services were delivered to the buyer\'s own address. Under XRechnung, keeping BG-15 also obliges you to supply deliverTo.city and deliverTo.postalCode (BR-DE-10, BR-DE-11).',
      example: `"deliverTo": { "city": "Lyon", "postalCode": "69001", "countryCode": "FR" }`,
      xpath: "/ubl:Invoice/cac:Delivery/cac:DeliveryLocation/cac:Address/cac:Country/cbc:IdentificationCode",
      docsUrl: `${DOCS}/BR-57`,
    });
  },

  // --- Every date term is a real calendar date ------------------------------
  //
  // The most consequential hole wave D found. Before 0.2.0 only the invoicing
  // period (BT-73/BT-74, under BR-29/BR-30) was checked against the calendar.
  // BT-2 was matched against a *shape* regex — `^\d{4}-\d{2}-\d{2}$` — which
  // "2026-02-30" and "2026-13-01" both satisfy, and BT-9, BT-7, BT-72, BT-26
  // and the line periods were not checked at all. The consequence was not a
  // missing finding, it was a broken promise: `validateInput` returned clean,
  // `generateXRechnungUBL` wrote the value straight through, and the emitted
  // document failed the UBL 2.1 XSD, because every one of these elements is
  // typed `xs:date`. A library whose entire proposition is "JSON in, compliant
  // XML out" must never be the thing that produces schema-invalid XML.
  //
  // Peppol states the rule explicitly, so on that profile we report its id;
  // elsewhere the finding is ours, because core EN 16931 leaves it to the
  // schema and there is no BR-* to cite.
  (inv) => {
    const out: TeachingError[] = [];
    const check = (
      value: string | undefined,
      field: `BT-${number}`,
      label: string,
      setter: string,
      xpath: string,
    ) => {
      if (blank(value) || isIsoDate(value)) return;
      const peppol = isPeppol(inv);
      out.push({
        rule: peppol ? "PEPPOL-EN16931-F001" : "ATW-DATE-NOT-A-CALENDAR-DATE",
        field,
        severity: "fatal",
        message: `The ${label} (${field}) is ${JSON.stringify(value)}, which is not a calendar date. UBL types this element as xs:date, so the only accepted form is a zero-padded YYYY-MM-DD naming a day that actually exists: "31.07.2026" and "07/31/2026" fail on syntax, and "2026-02-30", "2026-13-01" and "2025-02-29" fail because no such day is on the calendar. ${
          peppol
            ? "Peppol states this as PEPPOL-EN16931-F001 (\"A date MUST be formatted YYYY-MM-DD\"), which tests both the ten-character length and that the value is castable as xs:date."
            : "Core EN 16931 has no BR-* rule for it because the XML schema already forbids it — which is exactly why it is worth catching here. Left alone, this value passes every business rule, is written into the document verbatim, and the document is then rejected by schema validation before any validator reaches the business rules at all."
        }`,
        fix: `Set ${setter} to an ISO 8601 calendar date — four-digit year, two-digit month, two-digit day, separated by hyphens, with no time part and no timezone. If you are formatting a JavaScript Date, note that toISOString() appends a time part that must be trimmed, and that it converts to UTC first, which can move the date by a day.`,
        example: `"${setter.split(".").pop()}": "2026-07-31"`,
        xpath,
        docsUrl: peppol ? `${DOCS}/PEPPOL-EN16931-F001` : LIMITS_DOCS,
      });
    };

    check(inv.issueDate, "BT-2", "invoice issue date", "issueDate", "/ubl:Invoice/cbc:IssueDate");
    check(inv.dueDate, "BT-9", "payment due date", "dueDate", "/ubl:Invoice/cbc:DueDate");
    check(inv.taxPointDate, "BT-7", "value added tax point date", "taxPointDate", "/ubl:Invoice/cbc:TaxPointDate");
    check(
      inv.deliveryDate,
      "BT-72",
      "actual delivery date",
      "deliveryDate",
      "/ubl:Invoice/cac:Delivery/cbc:ActualDeliveryDate",
    );
    for (const [index, reference] of (inv.precedingInvoices ?? []).entries()) {
      check(
        reference?.issueDate,
        "BT-26",
        `preceding invoice issue date on precedingInvoices[${index}]`,
        `precedingInvoices[${index}].issueDate`,
        `/ubl:Invoice/cac:BillingReference[${index + 1}]/cac:InvoiceDocumentReference/cbc:IssueDate`,
      );
    }
    for (const [index, line] of linesOf(inv).entries()) {
      const period = line?.period;
      if (!period) continue;
      check(
        period.startDate,
        "BT-134",
        `invoice line period start date on line ${index + 1}`,
        `lines[${index}].period.startDate`,
        `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:InvoicePeriod/cbc:StartDate`,
      );
      check(
        period.endDate,
        "BT-135",
        `invoice line period end date on line ${index + 1}`,
        `lines[${index}].period.endDate`,
        `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:InvoicePeriod/cbc:EndDate`,
      );
    }
    return out;
  },
];
