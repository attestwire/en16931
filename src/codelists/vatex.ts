/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:  ConnectingEurope/eInvoicing-EN16931
 *          ubl/schematron/codelist/EN16931-UBL-codes.sch
 * Ref:     validation-1.3.16
 * Lists:   BR-CL-22 (CEF VATEX)
 * Emitted: 2026-08-10 by scripts/build-codelists.mjs
 *
 * This is the same artefact the KoSIT validator evaluates, so a BR-CL finding
 * here and a BR-CL finding from KoSIT are drawn from one source of truth.
 * Regenerate with: node scripts/build-codelists.mjs
 */

/**
 * VAT exemption reason codes (BT-121), admitted by BR-CL-22.
 *
 * Each code names the article of Directive 2006/112/EC (or a national
 * provision) the exemption rests on — `VATEX-EU-132-1I` for education,
 * `VATEX-EU-AE` for reverse charge, `VATEX-EU-IC` for an intra-community
 * supply. Supplying the code alongside the BT-120 text is what makes an
 * exemption machine-checkable rather than merely stated.
 *
 * 88 codes.
 */
export const VATEX_CODES: readonly string[] = Object.freeze([
  "VATEX-EU-79-C", "VATEX-EU-132", "VATEX-EU-132-1A", "VATEX-EU-132-1B",
  "VATEX-EU-132-1C", "VATEX-EU-132-1D", "VATEX-EU-132-1E", "VATEX-EU-132-1F",
  "VATEX-EU-132-1G", "VATEX-EU-132-1H", "VATEX-EU-132-1I", "VATEX-EU-132-1J",
  "VATEX-EU-132-1K", "VATEX-EU-132-1L", "VATEX-EU-132-1M", "VATEX-EU-132-1N",
  "VATEX-EU-132-1O", "VATEX-EU-132-1P", "VATEX-EU-132-1Q", "VATEX-EU-135-1",
  "VATEX-EU-143", "VATEX-EU-143-1A", "VATEX-EU-143-1B", "VATEX-EU-143-1C",
  "VATEX-EU-143-1D", "VATEX-EU-143-1E", "VATEX-EU-143-1F",
  "VATEX-EU-143-1FA", "VATEX-EU-143-1G", "VATEX-EU-143-1H",
  "VATEX-EU-143-1I", "VATEX-EU-143-1J", "VATEX-EU-143-1K", "VATEX-EU-143-1L",
  "VATEX-EU-144", "VATEX-EU-146-1E", "VATEX-EU-159", "VATEX-EU-309",
  "VATEX-EU-148", "VATEX-EU-148-A", "VATEX-EU-148-B", "VATEX-EU-148-C",
  "VATEX-EU-148-D", "VATEX-EU-148-E", "VATEX-EU-148-F", "VATEX-EU-148-G",
  "VATEX-EU-151", "VATEX-EU-151-1A", "VATEX-EU-151-1AA", "VATEX-EU-151-1B",
  "VATEX-EU-151-1C", "VATEX-EU-151-1D", "VATEX-EU-151-1E", "VATEX-EU-G",
  "VATEX-EU-O", "VATEX-EU-IC", "VATEX-EU-AE", "VATEX-EU-D", "VATEX-EU-F",
  "VATEX-EU-I", "VATEX-EU-J", "VATEX-FR-FRANCHISE", "VATEX-FR-CNWVAT",
  "VATEX-EU-153", "VATEX-FR-CGI261-1", "VATEX-FR-CGI261-2",
  "VATEX-FR-CGI261-3", "VATEX-FR-CGI261-4", "VATEX-FR-CGI261-5",
  "VATEX-FR-CGI261-7", "VATEX-FR-CGI261-8", "VATEX-FR-CGI261A",
  "VATEX-FR-CGI261B", "VATEX-FR-CGI261C-1", "VATEX-FR-CGI261C-2",
  "VATEX-FR-CGI261C-3", "VATEX-FR-CGI261D-1", "VATEX-FR-CGI261D-1BIS",
  "VATEX-FR-CGI261D-2", "VATEX-FR-CGI261D-3", "VATEX-FR-CGI261D-4",
  "VATEX-FR-CGI261E-1", "VATEX-FR-CGI261E-2", "VATEX-FR-CGI277A",
  "VATEX-FR-CGI275", "VATEX-FR-298SEXDECIESA", "VATEX-FR-CGI295",
  "VATEX-FR-AE",
]);

/** Membership lookup for {@link VATEX_CODES}. */
export const VATEX_CODES_SET: ReadonlySet<string> = new Set(VATEX_CODES);
