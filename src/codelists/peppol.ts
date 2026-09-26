/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:  OpenPEPPOL/peppol-bis-invoice-3
 *          rules/sch/PEPPOL-EN16931-UBL.sch
 * Release: Peppol BIS Billing 3.0.21
 * Ref:     806866bd2bd91d7e9623b68f08164e8fbe9e67a0
 * SHA-256: 62e5b67892f12755352d78b06f63229a02cc2eccc748677c56efbc8dbcb336e3
 * Lists:   PEPPOL-EN16931-CL008 (Peppol Participant Identifier Scheme)
 *          PEPPOL-EN16931-CL007 (ISO 4217 alpha-3, Peppol's copy)
 * Emitted: 2026-09-25 by scripts/build-peppol.mjs
 *
 * Regenerate with: node scripts/build-peppol.mjs
 */

/**
 * Electronic address scheme identifiers Peppol admits on BT-34 (seller)
 * and BT-49 (buyer), under PEPPOL-EN16931-CL008.
 *
 * Not the same list as `EAS_SCHEME_CODES`, which comes from the CEN
 * artefact under BR-CL-25, and the difference is not cosmetic: the CEN
 * list is the ISO/CEF Electronic Address Scheme register, while this one
 * is the set of schemes an *access point* will actually route on. A code
 * in the first and not the second produces a document that validates in a
 * CIUS checker and is refused at the network edge — which is the more
 * expensive failure, because it happens after you thought you had
 * shipped.
 *
 * 83 codes.
 */
export const PEPPOL_EAS_SCHEME_CODES: readonly string[] = Object.freeze([
  "0002", "0007", "0009", "0060", "0088", "0096", "0097", "0106", "0130",
  "0135", "0142", "0151", "0158", "0183", "0184", "0188", "0190", "0191",
  "0192", "0195", "0196", "0198", "0199", "0200", "0201", "0204", "0208",
  "0209", "0210", "0211", "0216", "0218", "0221", "0225", "0230", "0235",
  "0240", "0242", "0244", "0245", "0246", "0248", "9910", "9913", "9914",
  "9915", "9918", "9919", "9920", "9922", "9923", "9924", "9925", "9926",
  "9927", "9928", "9929", "9930", "9931", "9932", "9933", "9934", "9935",
  "9936", "9937", "9938", "9939", "9940", "9941", "9942", "9943", "9944",
  "9945", "9946", "9947", "9948", "9949", "9950", "9951", "9952", "9953",
  "9957", "9959",
]);

/** Membership lookup for {@link PEPPOL_EAS_SCHEME_CODES}. */
export const PEPPOL_EAS_SCHEME_CODES_SET: ReadonlySet<string> = new Set(
  PEPPOL_EAS_SCHEME_CODES,
);

/**
 * ISO 4217 currency codes Peppol admits on BT-5 and on every `currencyID`
 * attribute, under PEPPOL-EN16931-CL007.
 *
 * Carried separately from `CURRENCY_CODES` because the two have drifted:
 * Peppol's copy is refreshed on its own release cadence, so a currency
 * the CEN list has just added (or just retired) is admitted by one and
 * refused by the other for as long as the lag lasts. Validating a Peppol
 * document against the CEN list alone is how a perfectly legal invoice
 * gets bounced by an access point.
 *
 * 178 codes.
 */
export const PEPPOL_CURRENCY_CODES: readonly string[] = Object.freeze([
  "AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM",
  "BBD", "BDT", "BHD", "BIF", "BMD", "BND", "BOB", "BOV", "BRL", "BSD",
  "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CLF",
  "CLP", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK",
  "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL",
  "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF",
  "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES",
  "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP",
  "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT",
  "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN", "NAD",
  "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP",
  "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD",
  "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN",
  "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD",
  "TWD", "TZS", "UAH", "UGX", "USD", "USN", "UYI", "UYU", "UYW", "UZS",
  "VED", "VES", "VND", "VUV", "WST", "XAF", "XAG", "XAU", "XBA", "XBB",
  "XBC", "XBD", "XCD", "XDR", "XOF", "XPD", "XPF", "XPT", "XSU", "XTS",
  "XUA", "YER", "ZAR", "ZMW", "ZWG", "XXX", "CNH", "XCG",
]);

/** Membership lookup for {@link PEPPOL_CURRENCY_CODES}. */
export const PEPPOL_CURRENCY_CODES_SET: ReadonlySet<string> = new Set(
  PEPPOL_CURRENCY_CODES,
);
