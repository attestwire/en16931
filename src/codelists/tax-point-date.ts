/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:  ConnectingEurope/eInvoicing-EN16931
 *          ubl/schematron/codelist/EN16931-UBL-codes.sch
 * Ref:     validation-1.3.16
 * Lists:   BR-CL-06 (UNTDID 2005, EN 16931 restriction)
 * Emitted: 2026-08-10 by scripts/build-codelists.mjs
 *
 * This is the same artefact the KoSIT validator evaluates, so a BR-CL finding
 * here and a BR-CL finding from KoSIT are drawn from one source of truth.
 * Regenerate with: node scripts/build-codelists.mjs
 */

/**
 * Value added tax point date codes (BT-8), admitted by BR-CL-06.
 *
 * A restriction of UNTDID 2005 down to three codes, and the restriction is
 * the whole point: BT-8 says *which event* fixes the tax point, and only
 * three events are recognised — `3` invoice date, `35` actual delivery
 * date, `432` payment date. BT-8 is mutually exclusive with BT-7, the
 * explicit tax point date (BR-CO-03).
 *
 * 3 codes.
 */
export const VAT_POINT_DATE_CODES: readonly string[] = Object.freeze([
  "3", "35", "432",
]);

/** Membership lookup for {@link VAT_POINT_DATE_CODES}. */
export const VAT_POINT_DATE_CODES_SET: ReadonlySet<string> = new Set(VAT_POINT_DATE_CODES);
