/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:  ConnectingEurope/eInvoicing-EN16931
 *          ubl/schematron/codelist/EN16931-UBL-codes.sch
 * Ref:     validation-1.3.16
 * Lists:   BR-CL-19 (UNCL 5189)
 * Emitted: 2026-08-10 by scripts/build-codelists.mjs
 *
 * This is the same artefact the KoSIT validator evaluates, so a BR-CL finding
 * here and a BR-CL finding from KoSIT are drawn from one source of truth.
 * Regenerate with: node scripts/build-codelists.mjs
 */

/**
 * Allowance reason codes (BT-98 document level, BT-140 line level),
 * admitted by BR-CL-19.
 *
 * Nineteen codes, and none of them is a free-text escape hatch: if none
 * fits, omit the code and give the reason as text (BT-97 / BT-139)
 * instead. BR-33 / BR-42 are satisfied by either.
 *
 * The list is *not* interchangeable with the charge list
 * (`CHARGE_REASON_CODES`, UNCL 7161): they overlap on codes that mean
 * different things, so an allowance carrying a charge reason code fails
 * BR-CL-19 and vice versa.
 *
 * 19 codes.
 */
export const ALLOWANCE_REASON_CODES: readonly string[] = Object.freeze([
  "41", "42", "60", "62", "63", "64", "65", "66", "67", "68", "70", "71",
  "88", "95", "100", "102", "103", "104", "105",
]);

/** Membership lookup for {@link ALLOWANCE_REASON_CODES}. */
export const ALLOWANCE_REASON_CODES_SET: ReadonlySet<string> = new Set(ALLOWANCE_REASON_CODES);
