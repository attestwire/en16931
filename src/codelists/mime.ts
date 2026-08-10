/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:  ConnectingEurope/eInvoicing-EN16931
 *          ubl/schematron/codelist/EN16931-UBL-codes.sch
 * Ref:     validation-1.3.16
 * Lists:   BR-CL-24 (MIMEMediaType, EN 16931 restriction)
 * Emitted: 2026-08-10 by scripts/build-codelists.mjs
 *
 * This is the same artefact the KoSIT validator evaluates, so a BR-CL finding
 * here and a BR-CL finding from KoSIT are drawn from one source of truth.
 * Regenerate with: node scripts/build-codelists.mjs
 */

/**
 * Mime codes admitted by BR-CL-24 for an embedded attachment (BT-125-1).
 *
 * Six values, and the shortness is deliberate: an invoice attachment has to
 * be something a receiving system can open without executing it, years
 * later, without the sender's software. Anything outside this list —
 * `application/zip`, `application/msword`, `image/svg+xml` — is rejected
 * however legitimate the file is.
 *
 * 6 codes.
 */
export const MIME_CODES: readonly string[] = Object.freeze([
  "application/pdf", "image/png", "image/jpeg", "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

/** Membership lookup for {@link MIME_CODES}. */
export const MIME_CODES_SET: ReadonlySet<string> = new Set(MIME_CODES);
