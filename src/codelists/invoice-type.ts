/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:  ConnectingEurope/eInvoicing-EN16931
 *          ubl/schematron/codelist/EN16931-UBL-codes.sch
 * Ref:     validation-1.3.16
 * Lists:   BR-CL-01 (UNTDID 1001, invoice subset), BR-CL-01 (UNTDID 1001, credit-note subset)
 * Emitted: 2026-08-10 by scripts/build-codelists.mjs
 *
 * This is the same artefact the KoSIT validator evaluates, so a BR-CL finding
 * here and a BR-CL finding from KoSIT are drawn from one source of truth.
 * Regenerate with: node scripts/build-codelists.mjs
 */

/**
 * UNTDID 1001 document type codes admissible on an EN 16931 *invoice* (BT-3).
 *
 * This is the invoice half of BR-CL-01. The credit-note half is
 * `CREDIT_NOTE_TYPE_CODES_CL`: in UBL a credit note is a separate
 * `CreditNote` document with its own `cbc:CreditNoteTypeCode`, so the two
 * lists are never interchangeable on one document.
 *
 * 50 codes.
 */
export const INVOICE_TYPE_CODES: readonly string[] = Object.freeze([
  "71", "80", "81", "82", "84", "102", "130", "202", "203", "204", "211",
  "218", "219", "295", "325", "326", "331", "380", "382", "383", "384",
  "385", "386", "387", "388", "389", "390", "393", "394", "395", "456",
  "457", "471", "472", "473", "500", "501", "527", "553", "575", "623",
  "633", "751", "780", "817", "870", "875", "876", "877", "935",
]);

/** Membership lookup for {@link INVOICE_TYPE_CODES}. */
export const INVOICE_TYPE_CODES_SET: ReadonlySet<string> = new Set(INVOICE_TYPE_CODES);

/**
 * UNTDID 1001 document type codes admissible on an EN 16931 *credit note*
 * (`cbc:CreditNoteTypeCode`). Present for completeness and for validating
 * existing documents; this build does not generate credit notes.
 *
 * 13 codes.
 */
export const CREDIT_NOTE_TYPE_CODES_CL: readonly string[] = Object.freeze([
  "81", "83", "261", "262", "296", "308", "381", "396", "420", "458", "502",
  "503", "532",
]);

/** Membership lookup for {@link CREDIT_NOTE_TYPE_CODES_CL}. */
export const CREDIT_NOTE_TYPE_CODES_CL_SET: ReadonlySet<string> = new Set(CREDIT_NOTE_TYPE_CODES_CL);
