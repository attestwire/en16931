import { computeTotals } from "./totals.js";
import { documentKindOf, isCreditNote } from "./document-type.js";
import { LIMITS_DOCS, err, linesOf } from "./rule-kit.js";
import type { RuleFn } from "./rule-kit.js";
import type { InvoiceInput, TeachingError } from "./types.js";

/**
 * Credit notes: the findings that exist only because the document is one.
 *
 * There is deliberately almost nothing here, and that is the interesting part.
 * EN 16931 has **one** semantic model and one rule set: the standard binds the
 * same rule ids to the credit-note XPaths, so BR-CO-10 counts the same amounts,
 * BR-S-08 checks the same breakdown and BR-DE-16 asks the same question about
 * the seller's tax identifiers. Every one of those rules in this package runs on
 * the parsed model rather than on XPaths, so they were already correct for a
 * credit note before this file existed and needed no change to stay correct.
 *
 * What is left is two kinds of finding the regulation does not raise:
 *
 *   1. **A sign-convention mix-up.** EN 16931 credit notes state positive
 *      amounts; the document type carries the direction. Nothing in the
 *      schematron forbids negative ones, so this is a warning, not an error —
 *      but a credit note full of negative amounts is a document that will be
 *      booked twice in the wrong direction by whoever receives it.
 *   2. **Two business terms with no UBL CreditNote binding.** BT-9 and BT-11
 *      have no element on that document (BT-9 moves into `cac:PaymentMeans`;
 *      BT-11 has nowhere to go at all). Losing a term silently is the one thing
 *      this package will not do, in the generator or in the reader, so each gets
 *      a finding that says exactly what will be missing from the emitted file.
 *
 * All three carry `ATW-` ids: they are this library's findings about a binding,
 * not the regulator's about your data.
 */

/** Profiles whose emitted document is (or can be) UBL. */
const UBL_SYNTAX_PROFILES = new Set(["xrechnung-ubl", "peppol-bis-3", "en16931"]);

/**
 * True when this input can end up as a UBL document.
 *
 * `en16931` is in the set because it is syntax-neutral — the same input goes to
 * either generator — so a term that has no UBL CreditNote binding is a real risk
 * for it. Reporting it only for the two UBL-only profiles would stay silent for
 * exactly the caller who has not yet decided which syntax to emit. This is the
 * same reasoning that makes BR-CO-09 evaluate both syntaxes' prefix lists under
 * `en16931`.
 */
const emitsUbl = (inv: InvoiceInput): boolean =>
  UBL_SYNTAX_PROFILES.has(inv?.profile);

export const creditNoteRules: RuleFn[] = [
  // ATW-CREDIT-NOTE-NEGATIVE-AMOUNTS: the two idioms for a reversal, mixed.
  //
  // A credit note and a "negative invoice" are both lawful and they are not the
  // same document. BT-3 = 381 with positive amounts says "we owe you 500". BT-3
  // = 380 with negative amounts says the same thing in a different idiom, and is
  // legal under EN 16931 — BR-27 forbids a negative *price*, not a negative
  // amount, and the `-08` family's tolerance is signed precisely so that a
  // negative breakdown passes. Doing both at once says "we owe you −500", which
  // is an invoice with extra steps, and no validator will tell you.
  (inv) => {
    if (!isCreditNote(inv)) return null;
    const totals = computeTotals(inv);
    const negativeLines = totals.lineNetAmounts
      .map((amount, index) => ({ amount, index }))
      .filter((entry) => entry.amount < 0);
    const negativeTotal = totals.payableAmount < 0;
    if (negativeLines.length === 0 && !negativeTotal) return null;

    const where =
      negativeLines.length > 0
        ? `line ${negativeLines[0]!.index + 1} has a net amount (BT-131) of ${negativeLines[0]!.amount}`
        : `the amount due for payment (BT-115) is ${totals.payableAmount}`;

    return err({
      rule: "ATW-CREDIT-NOTE-NEGATIVE-AMOUNTS",
      field: ["BT-3", "BT-131"],
      severity: "warning",
      message: `This document is a credit note (BT-3 = "${(inv.invoiceTypeCode ?? "").trim()}") and states negative amounts: ${where}. EN 16931 credit notes carry **positive** amounts — the document type is what conveys the direction of the money, and stating it twice reverses it. A credit note for 500.00 says 500.00; a credit note for −500.00 says the buyer owes 500.00 more, which is an invoice. The two idioms are both lawful separately: a "negative invoice" (BT-3 = "380" with negative amounts) is a different, equally legal construct, and the schematron rejects neither, so no validator will stop this. That is exactly why it is worth saying here.`,
      fix: 'Make the amounts positive and leave invoiceTypeCode at "381". If you meant a negative invoice instead, set invoiceTypeCode to "380" and keep the negative amounts. Either is fine; both together is not. Whichever you pick, name the invoice being adjusted in precedingInvoices (BT-25) so the receiver can net the two documents.',
      example: `"invoiceTypeCode": "381", "lines": [{ "quantity": 2, "unitPrice": 250 }]`,
      xpath: "/ubl:CreditNote/cac:CreditNoteLine/cbc:LineExtensionAmount",
      docsUrl: LIMITS_DOCS,
    });
  },

  // ATW-CREDIT-NOTE-DUE-DATE-UNBOUND: BT-9 with nowhere to go.
  //
  // UBL's CreditNote has no cbc:DueDate. EN 16931's binding puts BT-9 in
  // cac:PaymentMeans/cbc:PaymentDueDate — which is why UBL-CR-412 ("A UBL
  // invoice should not include the PaymentMeans PaymentDueDate") carries an
  // explicit `or ../cn:CreditNote` exemption — and cbc:PaymentMeansCode is
  // mandatory inside that group, so with no payment instructions there is no
  // lawful element to write the date into.
  (inv) => {
    if (!isCreditNote(inv) || !emitsUbl(inv)) return null;
    if (inv.dueDate === undefined || String(inv.dueDate).trim() === "") return null;
    if (inv.payment !== undefined) return null;
    return err({
      rule: "ATW-CREDIT-NOTE-DUE-DATE-UNBOUND",
      field: ["BT-9", "BG-16"],
      severity: "warning",
      message: `This credit note states a payment due date (BT-9 = "${inv.dueDate}") and no payment instructions (BG-16). A UBL CreditNote has no cbc:DueDate element: EN 16931 binds BT-9 to cac:PaymentMeans/cbc:PaymentDueDate on that document, and UBL's PaymentMeans requires a payment means code (BT-81), so without BG-16 there is no lawful element to carry the date. It will be **absent from the generated UBL document**. In CII the same input is unaffected — BT-9 has its own element there — so this finding is about the UBL binding, not about your data.`,
      fix: 'Supply payment instructions: `payment: { meansCode: "58", iban: "…" }` for a SEPA credit transfer, or "1" if the code is genuinely unknown. XRechnung requires BG-16 anyway under BR-DE-1, so a document that hits this finding is usually one field short of two rules at once. If the credit note is settled by netting rather than by payment, drop dueDate — a date nobody will pay on is worse than no date.',
      example: `"dueDate": "2026-09-08", "payment": { "meansCode": "58", "iban": "DE02120300000000202051" }`,
      xpath: "/ubl:CreditNote/cac:PaymentMeans/cbc:PaymentDueDate",
      docsUrl: LIMITS_DOCS,
    });
  },

  // ATW-CREDIT-NOTE-PROJECT-REFERENCE-UNBOUND: BT-11 does not exist there.
  //
  // Not a limitation of this build: `cac:ProjectReference` is absent from
  // UBL-CreditNote-2.1.xsd altogether, so no conformant UBL credit note can
  // carry BT-11 by any means. CII can (ram:SpecifiedProcuringProject), which is
  // why the finding names the syntax rather than the standard.
  (inv) => {
    if (!isCreditNote(inv) || !emitsUbl(inv)) return null;
    const reference = inv.projectReference;
    if (reference === undefined || String(reference).trim() === "") return null;
    return err({
      rule: "ATW-CREDIT-NOTE-PROJECT-REFERENCE-UNBOUND",
      field: "BT-11",
      severity: "warning",
      message: `This credit note states a project reference (BT-11 = "${reference}"), and a UBL CreditNote cannot carry one. cac:ProjectReference is not in UBL-CreditNote-2.1.xsd at all — it exists on Invoice and on nothing else — so the reference will be **absent from the generated UBL document**. This is a hole in the syntax rather than in this library or in EN 16931: the CII binding has ram:SpecifiedProcuringProject and keeps it, so generateCii on this same input loses nothing.`,
      fix: 'Drop projectReference, or move the project identifier somewhere the document can hold it: buyerAccountingReference (BT-19, the buyer\'s cost centre) is the usual home, and contractReference (BT-12) or invoicedObjectIdentifier (BT-18) fit some processes better. If the project reference is load-bearing for your buyer, emit the credit note as CII instead — profile "xrechnung-cii" keeps it.',
      example: `"buyerAccountingReference": "PRJ-ERECHNUNG-2026"`,
      xpath: "/ubl:CreditNote",
      docsUrl: LIMITS_DOCS,
    });
  },

  // A guard, not a rule: BG-3 on a credit note.
  //
  // ⚠ This is `information`, and it is NOT BR-DE-26. That rule is often quoted
  // as requiring a preceding invoice reference on a credit note; it does not.
  // Verified against XRechnung 3.0.2 schematron 2.5.0, both syntaxes: BR-DE-26
  // tests `not(normalize-space(cbc:InvoiceTypeCode) = '384' or
  // normalize-space(cbc:CreditNoteTypeCode) = '384') or
  // (cac:BillingReference/cac:InvoiceDocumentReference)`. The trigger is the
  // *corrected invoice* code 384 — on either document — and 381 does not appear
  // in the test at all. Neither does any other credit-note rule in either
  // schematron: the string '381' occurs exactly once in the UBL one and twice in
  // the CII one, all three inside BR-DE-17's code list.
  //
  // So a credit note with no BG-3 is accepted everywhere, and this finding says
  // so while still pointing out that the receiver has no way to net the two
  // documents. `information` is the flag for "the regulator accepts this and you
  // should still read it" — the same level KoSIT gives BR-DE-TMP-32.
  (inv) => {
    if (documentKindOf(inv?.invoiceTypeCode) !== "credit-note") return null;
    if (linesOf(inv).length === 0) return null;
    const references = (inv.precedingInvoices ?? []).filter(Boolean);
    if (references.length > 0) return null;
    const finding: TeachingError = {
      rule: "ATW-CREDIT-NOTE-NO-PRECEDING-INVOICE",
      field: ["BG-3", "BT-25"],
      severity: "information",
      message:
        'This credit note names no preceding invoice (BG-3 / BT-25). No rule requires one: BR-DE-26 is often read as demanding it, and it does not — its test fires on the corrected-invoice code 384, on either document type, and never on 381. KoSIT accepts a credit note with no reference, and so does the EN 16931 schematron. What it leaves is a reconciliation problem: the buyer holds a credit with nothing to net it against, and your own VAT return cannot show which supply the adjustment belongs to. A credit note that says what it credits is the ordinary case, which is why this is worth one line of advice at the level the regulator uses for advice.',
      fix: 'Set precedingInvoices to the invoice being credited — [{ "invoiceNumber": "2026-000142", "issueDate": "2026-08-09" }]. BT-26, the issue date, is optional and worth supplying: it is what lets the buyer find the original after a numbering reset. If the credit note is genuinely standalone (a goodwill credit, a volume rebate over many invoices), leave it out — that is a real case and this finding is advisory for exactly that reason.',
      example: `"precedingInvoices": [{ "invoiceNumber": "2026-000142", "issueDate": "2026-08-09" }]`,
      xpath: "/ubl:CreditNote/cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID",
      docsUrl: LIMITS_DOCS,
    };
    return finding;
  },
];
