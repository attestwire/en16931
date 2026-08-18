/**
 * BT-8, the VAT point date code, is written with a different code list in each
 * syntax — and this module is the translation between them.
 *
 * WHY THIS EXISTS. EN 16931 names three events that can fix the tax point:
 * the invoice date, the actual delivery date, and the payment date. The UBL
 * binding writes them as a restriction of UNTDID 2005 — `3`, `35`, `432` — and
 * BR-CL-06 checks exactly that list. The CII binding writes the same three
 * events as a restriction of UNTDID 2475 — `5`, `29`, `72` — and the CII
 * schematron's BR-CL-06 checks *that* list instead. Same rule id, same business
 * term, two disjoint sets of legal values.
 *
 * ⚠ WE APPLIED THE UBL LIST TO BOTH until 0.7.3, so a perfectly conformant CII
 * invoice carrying `<ram:DueDateTypeCode>5</ram:DueDateTypeCode>` was rejected
 * here under BR-CL-06 and accepted by KoSIT. Found by the benchmark on
 * kosit-testsuite/cius/01.02_comprehensive_test_uncefact.xml, 2026-08-16.
 *
 * The fix is a translation at the syntax boundary rather than a second code
 * list in the rule. `InvoiceInput` is one model for both syntaxes — that is its
 * whole purpose — so the model carries the EN 16931 code, the CII reader
 * translates inbound, the CII writer translates outbound, and every rule keeps
 * asking one question of one list. A code the CII list does not contain is
 * passed through untranslated, so BR-CL-06 still reports it rather than being
 * silently repaired.
 */

/** CII (UNTDID 2475) → the EN 16931 / UBL code (UNTDID 2005) the model holds. */
const CII_TO_MODEL: Readonly<Record<string, string>> = Object.freeze({
  "5": "3", // invoice issue date
  "29": "35", // actual delivery date
  "72": "432", // paid to date
});

/** The inverse, for the CII generator. */
const MODEL_TO_CII: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(CII_TO_MODEL).map(([cii, model]) => [model, cii])),
);

/** Read a `ram:DueDateTypeCode` into the model's BT-8 value. */
export function taxPointCodeFromCii(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  return CII_TO_MODEL[code.trim()] ?? code;
}

/** Write the model's BT-8 value as a `ram:DueDateTypeCode`. */
export function taxPointCodeToCii(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  return MODEL_TO_CII[code.trim()] ?? code;
}
