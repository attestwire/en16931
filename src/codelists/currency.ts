/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:  ConnectingEurope/eInvoicing-EN16931
 *          ubl/schematron/codelist/EN16931-UBL-codes.sch
 * Ref:     validation-1.3.16
 * Lists:   BR-CL-04 (ISO 4217 alpha-3)
 * Emitted: 2026-08-10 by scripts/build-codelists.mjs
 *
 * This is the same artefact the KoSIT validator evaluates, so a BR-CL finding
 * here and a BR-CL finding from KoSIT are drawn from one source of truth.
 * Regenerate with: node scripts/build-codelists.mjs
 */

/**
 * ISO 4217 alphabetic currency codes, as admitted by BR-CL-03/BR-CL-04.
 *
 * Includes the fund codes (BOV, CHE, CHW, CLF, COU, MXV, USN, UYI, …) and
 * the metals (XAU, XAG, XPD, XPT) — the schematron admits the whole list,
 * so we do too rather than second-guessing which are plausible on an
 * invoice.
 *
 * 178 codes.
 */
export const CURRENCY_CODES: readonly string[] = Object.freeze([
  "AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM",
  "BBD", "BDT", "BHD", "BIF", "BMD", "BND", "BOB", "BOV", "BRL", "BSD",
  "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CLF",
  "CLP", "CNH", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DJF",
  "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP",
  "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG",
  "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY",
  "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK",
  "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK",
  "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN",
  "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK",
  "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR",
  "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP",
  "STD", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY",
  "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "USN", "UYI", "UYU", "UYW",
  "UZS", "VES", "VED", "VND", "VUV", "WST", "XAF", "XAG", "XAU", "XBA",
  "XBB", "XBC", "XBD", "XCD", "XCG", "XDR", "XOF", "XPD", "XPF", "XPT",
  "XSU", "XTS", "XUA", "XXX", "YER", "ZAR", "ZMW", "ZWG",
]);

/** Membership lookup for {@link CURRENCY_CODES}. */
export const CURRENCY_CODES_SET: ReadonlySet<string> = new Set(CURRENCY_CODES);
