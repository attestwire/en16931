/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:  ConnectingEurope/eInvoicing-EN16931
 *          ubl/schematron/codelist/EN16931-UBL-codes.sch
 * Ref:     validation-1.3.16
 * Lists:   BR-CL-25 (CEF Electronic Address Scheme (EAS))
 * Emitted: 2026-08-10 by scripts/build-codelists.mjs
 *
 * This is the same artefact the KoSIT validator evaluates, so a BR-CL finding
 * here and a BR-CL finding from KoSIT are drawn from one source of truth.
 * Regenerate with: node scripts/build-codelists.mjs
 */

/**
 * Electronic Address Scheme identifiers admitted by BR-CL-25 for the
 * `schemeID` on BT-34 (seller) and BT-49 (buyer) electronic addresses.
 *
 * Peppol routes on this pair. Common values: `0204` Leitweg-ID, `9930`
 * German VAT identifier, `0088` GLN, `0192` Norwegian organisation number,
 * `EM` email.
 *
 * 104 codes.
 */
export const EAS_SCHEME_CODES: readonly string[] = Object.freeze([
  "0002", "0007", "0009", "0037", "0060", "0088", "0096", "0097", "0106",
  "0130", "0135", "0142", "0147", "0151", "0154", "0158", "0170", "0177",
  "0183", "0184", "0188", "0190", "0191", "0192", "0193", "0194", "0195",
  "0196", "0198", "0199", "0200", "0201", "0202", "0203", "0204", "0205",
  "0208", "0209", "0210", "0211", "0212", "0213", "0215", "0216", "0217",
  "0218", "0219", "0220", "0221", "0225", "0230", "0235", "0240", "0244",
  "0242", "0245", "0246", "0248", "9910", "9913", "9914", "9915", "9918",
  "9919", "9920", "9922", "9923", "9924", "9925", "9926", "9927", "9928",
  "9929", "9930", "9931", "9932", "9933", "9934", "9935", "9936", "9937",
  "9938", "9939", "9940", "9941", "9942", "9943", "9944", "9945", "9946",
  "9947", "9948", "9949", "9950", "9951", "9952", "9953", "9957", "9959",
  "AN", "AQ", "AS", "AU", "EM",
]);

/** Membership lookup for {@link EAS_SCHEME_CODES}. */
export const EAS_SCHEME_CODES_SET: ReadonlySet<string> = new Set(EAS_SCHEME_CODES);
