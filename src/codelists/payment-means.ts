/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:  ConnectingEurope/eInvoicing-EN16931
 *          ubl/schematron/codelist/EN16931-UBL-codes.sch
 * Ref:     validation-1.3.16
 * Lists:   BR-CL-16 (UNTDID 4461 (UNCL4461))
 * Emitted: 2026-08-10 by scripts/build-codelists.mjs
 *
 * This is the same artefact the KoSIT validator evaluates, so a BR-CL finding
 * here and a BR-CL finding from KoSIT are drawn from one source of truth.
 * Regenerate with: node scripts/build-codelists.mjs
 */

/**
 * UNTDID 4461 payment means codes, as admitted by BR-CL-16 for BT-81.
 *
 * Membership is only the first hurdle: XRechnung's BR-DE-23-a/24-a/25-a
 * additionally require the payment group that matches the code (credit
 * transfer BG-17 for 30/58, card BG-18 for 48/54/55, direct debit BG-19
 * for 59).
 *
 * 84 codes.
 */
export const PAYMENT_MEANS_CODES: readonly string[] = Object.freeze([
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14",
  "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26",
  "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38",
  "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "50",
  "51", "52", "53", "54", "55", "56", "57", "58", "59", "60", "61", "62",
  "63", "64", "65", "66", "67", "68", "69", "70", "74", "75", "76", "77",
  "78", "91", "92", "93", "94", "95", "96", "97", "98", "ZZZ",
]);

/** Membership lookup for {@link PAYMENT_MEANS_CODES}. */
export const PAYMENT_MEANS_CODES_SET: ReadonlySet<string> = new Set(PAYMENT_MEANS_CODES);
