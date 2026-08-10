/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:  ConnectingEurope/eInvoicing-EN16931
 *          ubl/schematron/codelist/EN16931-UBL-codes.sch
 * Ref:     validation-1.3.16
 * Lists:   BR-CL-17 (UNTDID 5305 (UNCL5305), EN 16931 subset)
 * Emitted: 2026-08-10 by scripts/build-codelists.mjs
 *
 * This is the same artefact the KoSIT validator evaluates, so a BR-CL finding
 * here and a BR-CL finding from KoSIT are drawn from one source of truth.
 * Regenerate with: node scripts/build-codelists.mjs
 */

/**
 * VAT category codes admitted by BR-CL-17 (BT-118) and BR-CL-18 (BT-151).
 *
 * Wider than this package's `VatCategory` union, which covers the seven
 * categories the generator can express. `L` (IGIC, Canary Islands), `M`
 * (IPSI, Ceuta/Melilla) and `B` (split payment, Italy) are legal EN 16931
 * codes with their own BR-AF-*, BR-AG-* and BR-B-* rule families, none of
 * which this build implements — so they pass BR-CL-17/18 and are then
 * refused by the model's own typing.
 *
 * 10 codes.
 */
export const VAT_CATEGORY_CODES: readonly string[] = Object.freeze([
  "AE", "L", "M", "E", "S", "Z", "G", "O", "K", "B",
]);

/** Membership lookup for {@link VAT_CATEGORY_CODES}. */
export const VAT_CATEGORY_CODES_SET: ReadonlySet<string> = new Set(VAT_CATEGORY_CODES);
