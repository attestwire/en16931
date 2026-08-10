/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:  ConnectingEurope/eInvoicing-EN16931
 *          ubl/schematron/codelist/EN16931-UBL-codes.sch
 * Ref:     validation-1.3.16
 * Lists:   BR-CL-20 (UNCL 7161)
 * Emitted: 2026-08-10 by scripts/build-codelists.mjs
 *
 * This is the same artefact the KoSIT validator evaluates, so a BR-CL finding
 * here and a BR-CL finding from KoSIT are drawn from one source of truth.
 * Regenerate with: node scripts/build-codelists.mjs
 */

/**
 * Charge reason codes (BT-105 document level, BT-145 line level), admitted
 * by BR-CL-20.
 *
 * Far larger than the allowance list, because a charge can be almost any
 * service added to a supply. Frequently wanted: `FC` freight service,
 * `PC` packing, `IN` insurance, `ABK` miscellaneous, `SH` handling.
 *
 * 178 codes.
 */
export const CHARGE_REASON_CODES: readonly string[] = Object.freeze([
  "AA", "AAA", "AAC", "AAD", "AAE", "AAF", "AAH", "AAI", "AAS", "AAT", "AAV",
  "AAY", "AAZ", "ABA", "ABB", "ABC", "ABD", "ABF", "ABK", "ABL", "ABN",
  "ABR", "ABS", "ABT", "ABU", "ACF", "ACG", "ACH", "ACI", "ACJ", "ACK",
  "ACL", "ACM", "ACS", "ADC", "ADE", "ADJ", "ADK", "ADL", "ADM", "ADN",
  "ADO", "ADP", "ADQ", "ADR", "ADT", "ADW", "ADY", "ADZ", "AEA", "AEB",
  "AEC", "AED", "AEF", "AEH", "AEI", "AEJ", "AEK", "AEL", "AEM", "AEN",
  "AEO", "AEP", "AES", "AET", "AEU", "AEV", "AEW", "AEX", "AEY", "AEZ", "AJ",
  "AU", "CA", "CAB", "CAD", "CAE", "CAF", "CAI", "CAJ", "CAK", "CAL", "CAM",
  "CAN", "CAO", "CAP", "CAQ", "CAR", "CAS", "CAT", "CAU", "CAV", "CAW",
  "CAX", "CAY", "CAZ", "CD", "CG", "CS", "CT", "DAB", "DAD", "DAC", "DAF",
  "DAG", "DAH", "DAI", "DAJ", "DAK", "DAL", "DAM", "DAN", "DAO", "DAP",
  "DAQ", "DL", "EG", "EP", "ER", "FAA", "FAB", "FAC", "FC", "FH", "FI",
  "GAA", "HAA", "HD", "HH", "IAA", "IAB", "ID", "IF", "IR", "IS", "KO", "L1",
  "LA", "LAA", "LAB", "LF", "MAE", "MI", "ML", "NAA", "OA", "PA", "PAA",
  "PC", "PL", "PRV", "RAB", "RAC", "RAD", "RAF", "RE", "RF", "RH", "RV",
  "SA", "SAA", "SAD", "SAE", "SAI", "SG", "SH", "SM", "SU", "TAB", "TAC",
  "TT", "TV", "V1", "V2", "WH", "XAA", "YY", "ZZZ",
]);

/** Membership lookup for {@link CHARGE_REASON_CODES}. */
export const CHARGE_REASON_CODES_SET: ReadonlySet<string> = new Set(CHARGE_REASON_CODES);
