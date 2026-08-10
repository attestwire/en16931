/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:  ConnectingEurope/eInvoicing-EN16931
 *          ubl/schematron/codelist/EN16931-UBL-codes.sch
 * Ref:     validation-1.3.16
 * Lists:   BR-CL-13 (UNTDID 7143)
 * Emitted: 2026-08-10 by scripts/build-codelists.mjs
 *
 * This is the same artefact the KoSIT validator evaluates, so a BR-CL finding
 * here and a BR-CL finding from KoSIT are drawn from one source of truth.
 * Regenerate with: node scripts/build-codelists.mjs
 */

/**
 * Item classification scheme identifiers (BT-158-1), admitted by BR-CL-13.
 *
 * The code names the classification system the BT-158 value is drawn from,
 * so a receiver can tell a CPV code from a UNSPSC code from a customs
 * tariff heading. Common values: `ST` UNSPSC, `SRV` GPC, `HS` Harmonised
 * System, `TSP` CPV, `MP` product/service identification number.
 *
 * 185 codes.
 */
export const ITEM_CLASSIFICATION_SCHEME_CODES: readonly string[] = Object.freeze([
  "AA", "AB", "AC", "AD", "AE", "AF", "AG", "AH", "AI", "AJ", "AK", "AL",
  "AM", "AN", "AO", "AP", "AQ", "AR", "AS", "AT", "AU", "AV", "AW", "AX",
  "AY", "AZ", "BA", "BB", "BC", "BD", "BE", "BF", "BG", "BH", "BI", "BJ",
  "BK", "BL", "BM", "BN", "BO", "BP", "BQ", "BR", "BS", "BT", "BU", "BV",
  "BW", "BX", "BY", "BZ", "CC", "CG", "CL", "CR", "CV", "DR", "DW", "EC",
  "EF", "EMD", "EN", "FS", "GB", "GN", "GMN", "GS", "HS", "IB", "IN", "IS",
  "IT", "IZ", "MA", "MF", "MN", "MP", "NB", "ON", "PD", "PL", "PO", "PPI",
  "PV", "QS", "RC", "RN", "RU", "RY", "SA", "SG", "SK", "SN", "SRS", "SRT",
  "SRU", "SRV", "SRW", "SRX", "SRY", "SRZ", "SS", "SSA", "SSB", "SSC", "SSD",
  "SSE", "SSF", "SSG", "SSH", "SSI", "SSJ", "SSK", "SSL", "SSM", "SSN",
  "SSO", "SSP", "SSQ", "SSR", "SSS", "SST", "SSU", "SSV", "SSW", "SSX",
  "SSY", "SSZ", "ST", "STA", "STB", "STC", "STD", "STE", "STF", "STG", "STH",
  "STI", "STJ", "STK", "STL", "STM", "STN", "STO", "STP", "STQ", "STR",
  "STS", "STT", "STU", "STV", "STW", "STX", "STY", "STZ", "SUA", "SUB",
  "SUC", "SUD", "SUE", "SUF", "SUG", "SUH", "SUI", "SUJ", "SUK", "SUL",
  "SUM", "TG", "TSN", "TSO", "TSP", "TSQ", "TSR", "TSS", "TST", "TSU", "UA",
  "UP", "VN", "VP", "VS", "VX", "ZZZ",
]);

/** Membership lookup for {@link ITEM_CLASSIFICATION_SCHEME_CODES}. */
export const ITEM_CLASSIFICATION_SCHEME_CODES_SET: ReadonlySet<string> = new Set(ITEM_CLASSIFICATION_SCHEME_CODES);
