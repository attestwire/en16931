/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:  ConnectingEurope/eInvoicing-EN16931
 *          ubl/schematron/UBL/EN16931-UBL-model.sch
 * Ref:     validation-1.3.16
 * Lists:   BR-CL-08 (UNCL 4451)
 * Emitted: 2026-08-10 by scripts/build-codelists.mjs
 *
 * This is the same artefact the KoSIT validator evaluates, so a BR-CL finding
 * here and a BR-CL finding from KoSIT are drawn from one source of truth.
 * Regenerate with: node scripts/build-codelists.mjs
 */

/**
 * Invoice note subject codes (BT-21), admitted by BR-CL-08.
 *
 * UBL has no element for BT-21. The binding writes the code into the note
 * itself as `#CODE#text`, and the schematron only applies the membership
 * test when the note contains a `#` followed by exactly three characters
 * and another `#` — so a note that merely mentions a hash is left alone,
 * and a note beginning `#AB#` is left alone too. Common values: `AAI`
 * general information, `REG` regulatory information, `ABL` governing law,
 * `TXD` tax declaration, `PMT` payment information.
 *
 * 383 codes.
 */
export const NOTE_SUBJECT_CODES: readonly string[] = Object.freeze([
  "AAA", "AAB", "AAC", "AAD", "AAE", "AAF", "AAG", "AAI", "AAJ", "AAK",
  "AAL", "AAM", "AAN", "AAO", "AAP", "AAQ", "AAR", "AAS", "AAT", "AAU",
  "AAV", "AAW", "AAX", "AAY", "AAZ", "ABA", "ABB", "ABC", "ABD", "ABE",
  "ABF", "ABG", "ABH", "ABI", "ABJ", "ABK", "ABL", "ABM", "ABN", "ABO",
  "ABP", "ABQ", "ABR", "ABS", "ABT", "ABU", "ABV", "ABW", "ABX", "ABZ",
  "ACA", "ACB", "ACC", "ACD", "ACE", "ACF", "ACG", "ACH", "ACI", "ACJ",
  "ACK", "ACL", "ACM", "ACN", "ACO", "ACP", "ACQ", "ACR", "ACS", "ACT",
  "ACU", "ACV", "ACW", "ACX", "ACY", "ACZ", "ADA", "ADB", "ADC", "ADD",
  "ADE", "ADF", "ADG", "ADH", "ADI", "ADJ", "ADK", "ADL", "ADM", "ADN",
  "ADO", "ADP", "ADQ", "ADR", "ADS", "ADT", "ADU", "ADV", "ADW", "ADX",
  "ADY", "ADZ", "AEA", "AEB", "AEC", "AED", "AEE", "AEF", "AEG", "AEH",
  "AEI", "AEJ", "AEK", "AEL", "AEM", "AEN", "AEO", "AEP", "AEQ", "AER",
  "AES", "AET", "AEU", "AEV", "AEW", "AEX", "AEY", "AEZ", "AFA", "AFB",
  "AFC", "AFD", "AFE", "AFF", "AFG", "AFH", "AFI", "AFJ", "AFK", "AFL",
  "AFM", "AFN", "AFO", "AFP", "AFQ", "AFR", "AFS", "AFT", "AFU", "AFV",
  "AFW", "AFX", "AFY", "AFZ", "AGA", "AGB", "AGC", "AGD", "AGE", "AGF",
  "AGG", "AGH", "AGI", "AGJ", "AGK", "AGL", "AGM", "AGN", "AGO", "AGP",
  "AGQ", "AGR", "AGS", "AGT", "AGU", "AGV", "AGW", "AGX", "AGY", "AGZ",
  "AHA", "AHB", "AHC", "AHD", "AHE", "AHF", "AHG", "AHH", "AHI", "AHJ",
  "AHK", "AHL", "AHM", "AHN", "AHO", "AHP", "AHQ", "AHR", "AHS", "AHT",
  "AHU", "AHV", "AHW", "AHX", "AHY", "AHZ", "AIA", "AIB", "AIC", "AID",
  "AIE", "AIF", "AIG", "AIH", "AII", "AIJ", "AIK", "AIL", "AIM", "AIN",
  "AIO", "AIP", "AIQ", "AIR", "AIS", "AIT", "AIU", "AIV", "AIW", "AIX",
  "AIY", "AIZ", "AJA", "AJB", "ALC", "ALD", "ALE", "ALF", "ALG", "ALH",
  "ALI", "ALJ", "ALK", "ALL", "ALM", "ALN", "ALO", "ALP", "ALQ", "ARR",
  "ARS", "AUT", "AUU", "AUV", "AUW", "AUX", "AUY", "AUZ", "AVA", "AVB",
  "AVC", "AVD", "AVE", "AVF", "BAG", "BAH", "BAI", "BAJ", "BAK", "BAL",
  "BAM", "BAN", "BAO", "BAP", "BAQ", "BAR", "BAS", "BLC", "BLD", "BLE",
  "BLF", "BLG", "BLH", "BLI", "BLJ", "BLK", "BLL", "BLM", "BLN", "BLO",
  "BLP", "BLQ", "BLR", "BLS", "BLT", "BLU", "BLV", "BLW", "BLX", "BLY",
  "BLZ", "BMA", "BMB", "BMC", "BMD", "BME", "CCI", "CEX", "CHG", "CIP",
  "CLP", "CLR", "COI", "CUR", "CUS", "DAR", "DCL", "DEL", "DIN", "DOC",
  "DUT", "EUR", "FBC", "GBL", "GEN", "GS7", "HAN", "HAZ", "ICN", "IIN",
  "IMI", "IND", "INS", "INV", "IRP", "ITR", "ITS", "LAN", "LIN", "LOI",
  "MCO", "MDH", "MKS", "ORI", "OSI", "PAC", "PAI", "PAY", "PKG", "PKT",
  "PMD", "PMT", "PRD", "PRF", "PRI", "PUR", "QIN", "QQD", "QUT", "RAH",
  "REG", "RET", "REV", "RQR", "SAF", "SIC", "SIN", "SLR", "SPA", "SPG",
  "SPH", "SPP", "SPT", "SRN", "SSR", "SUR", "TCA", "TDT", "TRA", "TRR",
  "TXD", "WHI", "ZZZ",
]);

/** Membership lookup for {@link NOTE_SUBJECT_CODES}. */
export const NOTE_SUBJECT_CODES_SET: ReadonlySet<string> = new Set(NOTE_SUBJECT_CODES);
