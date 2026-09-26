import { COUNTRY_CODES_SET } from "./codelists/country.js";

/**
 * Check digits and formats of the identifiers an invoice is routed and paid
 * on: the German Leitweg-ID, the IBAN and BIC, and the French SIREN and SIRET.
 *
 * None of these is a rule of EN 16931 or of a CIUS. The regulation asks for the
 * identifier and does not recompute its check digits, so an invoice carrying a
 * mistyped one validates clean everywhere and then fails where the identifier
 * is used: the portal cannot route it, the bank returns the payment, the
 * platform finds no such company. That is why the findings built on these
 * functions (`rules-identifiers.ts`) are `ATW-` warnings and never errors.
 *
 * Deliberately absent:
 *
 *  - **VAT identifiers.** Their check digits differ per member state, several
 *    states publish no algorithm, and the authority on whether a VAT number
 *    exists is VIES, not arithmetic. `BR-CO-09` checks the country prefix.
 *  - **The GLN (scheme 0088).** `PEPPOL-COMMON-R040` already checks its GS1
 *    check digit, at the severity Peppol gives it (see `rules-peppol.ts`), and
 *    a second finding about the same digit would say the same thing twice.
 *
 * Pure functions, no state: safe to call from a form that wants to check an
 * IBAN before the invoice exists.
 */

// ---------------------------------------------------------------------------
// ISO 7064 MOD 97-10
// ---------------------------------------------------------------------------

/**
 * The MOD 97-10 remainder of a string of digits and capital letters, with each
 * letter replaced by its position in the alphabet plus nine (A = 10 … Z = 35),
 * as ISO 13616 does for the IBAN and the Leitweg-ID specification does for the
 * Leitweg-ID. Null when the string holds anything else.
 *
 * Computed digit by digit: a 34-character IBAN expands to far more digits than
 * a JavaScript number holds exactly.
 */
function mod97(value: string): number | null {
  let remainder = 0;
  for (const char of value) {
    const code = char.charCodeAt(0);
    let digits: string;
    if (code >= 48 && code <= 57) digits = char;
    else if (code >= 65 && code <= 90) digits = String(code - 55);
    else return null;
    for (const digit of digits) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder;
}

// ---------------------------------------------------------------------------
// Leitweg-ID
// ---------------------------------------------------------------------------

/**
 * The form of a Leitweg-ID, per the Leitweg-ID format specification version
 * 2.0.2 (Koordinierungsstelle für IT-Standards, 28 July 2021), sections 2.1 to
 * 2.5: a coarse address (Grobadressierung) of 2 to 12 digits, an optional fine
 * address (Feinadressierung) of up to 30 letters and digits, and two check
 * digits, each part after the first introduced by a hyphen-minus (U+002D).
 * Letters are not case-sensitive (section 2.3).
 */
const LEITWEG_ID_FORM = /^([0-9]{2,12})(?:-([A-Za-z0-9]{1,30}))?-([0-9]{2})$/;

/**
 * The codes a coarse address begins with (section 2.2.1): 01 Schleswig-Holstein
 * to 16 Thüringen, and 99 for the federal level.
 */
const LEITWEG_ID_LAND_CODES: ReadonlySet<string> = new Set([
  "01", "02", "03", "04", "05", "06", "07", "08",
  "09", "10", "11", "12", "13", "14", "15", "16", "99",
]);

/**
 * The lengths a coarse address can have (section 2.1, table 1): the Land (2
 * digits), then the Regierungsbezirk (1), the Landkreis (2) and the Gemeinde-
 * verband or Gemeinde (3, 4 or 7), each required when a later one is given.
 */
const LEITWEG_ID_COARSE_LENGTHS: ReadonlySet<number> = new Set([2, 3, 5, 8, 9, 12]);

/** What is wrong with a Leitweg-ID. */
export type LeitwegIdProblem = "form" | "check-digits";

/**
 * Whether `value` is not a Leitweg-ID, and why; null when it is one.
 *
 * Section 2.4: the check digits are computed with ISO/IEC 7064 MOD 97-10 over
 * the coarse and fine address without the hyphens, letters replaced by their
 * position in the alphabet from A = 10 to Z = 35, and a Leitweg-ID is valid
 * when that string with the check digits appended leaves the remainder 1 on
 * division by 97. The specification's own example, 04011000-1234512345-06,
 * does. Surrounding whitespace is ignored; whitespace inside is not a hyphen.
 */
export function leitwegIdProblem(value: string): LeitwegIdProblem | null {
  const match = LEITWEG_ID_FORM.exec(value.trim());
  if (!match) return "form";
  const coarse = match[1]!;
  const fine = (match[2] ?? "").toUpperCase();
  const check = match[3]!;
  return mod97(`${coarse}${fine}${check}`) === 1 ? null : "check-digits";
}

/**
 * True when `value` is a Leitweg-ID: the form of the Leitweg-ID format
 * specification 2.0.2 (a coarse address of 2 to 12 digits, an optional fine
 * address of up to 30 letters and digits, two check digits, separated by
 * hyphens) with check digits that satisfy ISO/IEC 7064 MOD 97-10. It cannot
 * tell whether a Leitweg-ID was ever issued to anybody.
 */
export const isValidLeitwegId = (value: string): boolean => leitwegIdProblem(value) === null;

/**
 * True when a buyer reference (BT-10) has the complete form of a Leitweg-ID and
 * not merely something like it: the form above, a coarse address of one of the
 * lengths the specification's table 1 allows, and first two digits that name a
 * Land or the federal level. A business buyer may put any reference in BT-10,
 * and a date such as `2026-07-31` must not be checked as a Leitweg-ID.
 */
export function hasLeitwegIdForm(value: string): boolean {
  const match = LEITWEG_ID_FORM.exec(value.trim());
  if (!match) return false;
  const coarse = match[1]!;
  return LEITWEG_ID_COARSE_LENGTHS.has(coarse.length) && LEITWEG_ID_LAND_CODES.has(coarse.slice(0, 2));
}

// ---------------------------------------------------------------------------
// IBAN
// ---------------------------------------------------------------------------

/**
 * IBAN length per country, from the SWIFT IBAN Registry (ISO 13616).
 *
 * A country missing here is not refused: its IBAN is held to the check digits
 * alone, so a country that joins the registry later is never reported for a
 * length this table does not know.
 */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.freeze({
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27,
  BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
  GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27,
  JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25,
  MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28, NL: 18,
  NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33,
  SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28,
  TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
});

/**
 * What is wrong with an IBAN.
 *
 * - `form`: not two letters, two digits and up to 30 letters and digits.
 * - `length`: the country's IBAN has a different length (`expected`).
 * - `check-digits`: the ISO 7064 MOD 97-10 check fails.
 * - `case`: right in capitals, but written with lower-case letters. ISO
 *   13616's electronic form is upper case, and KoSIT's BR-DE-19 fails a
 *   lower-case one.
 */
export type IbanProblem =
  | { kind: "form" }
  | { kind: "length"; expected: number; actual: number }
  | { kind: "check-digits" }
  | { kind: "case" };

/** The IBAN with every whitespace character removed, which is how it is compared. */
export const compactIban = (value: string): string => value.replace(/\s/g, "");

/** True when `value` starts the way an IBAN does: two letters, two digits. */
export const looksLikeIban = (value: string): boolean => /^[A-Za-z]{2}[0-9]{2}/.test(compactIban(value));

/** Whether `value` is not an IBAN, and why; null when it is one. */
export function ibanProblem(value: string): IbanProblem | null {
  const compact = compactIban(value);
  const upper = compact.toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}$/.test(upper)) return { kind: "form" };
  const expected = IBAN_LENGTHS[upper.slice(0, 2)];
  if (expected !== undefined && upper.length !== expected) {
    return { kind: "length", expected, actual: upper.length };
  }
  if (mod97(upper.slice(4) + upper.slice(0, 4)) !== 1) return { kind: "check-digits" };
  return compact === upper ? null : { kind: "case" };
}

/**
 * True when `value` is an IBAN: two letters for the country, two check digits
 * and the account number, in capitals, as long as the SWIFT IBAN Registry says
 * that country's IBAN is, with check digits that satisfy ISO 7064 MOD 97-10.
 * Spaces between the groups of four are ignored.
 *
 * Stricter than `BR-DE-19`, which transcribes KoSIT's test and checks the form
 * and the check digits only: this also checks the length.
 */
export const isValidIban = (value: string): boolean => ibanProblem(value) === null;

// ---------------------------------------------------------------------------
// BIC
// ---------------------------------------------------------------------------

/** What is wrong with a BIC. */
export type BicProblem = "form" | "country" | "case";

/**
 * Whether `value` is not a BIC, and why; null when it is one.
 *
 * ISO 9362 as ISO 20022 writes it, `[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?`:
 * a four-character party prefix, the two-letter country, a two-character
 * location and an optional three-character branch, 8 or 11 characters in all.
 * The country must be an ISO 3166-1 code, or XK (Kosovo), which SWIFT uses.
 * Surrounding whitespace is ignored.
 */
export function bicProblem(value: string): BicProblem | null {
  const trimmed = value.trim();
  const upper = trimmed.toUpperCase();
  if (!/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(upper)) return "form";
  const country = upper.slice(4, 6);
  if (country !== "XK" && !COUNTRY_CODES_SET.has(country)) return "country";
  return trimmed === upper ? null : "case";
}

/**
 * True when `value` is a BIC: 8 or 11 capital letters and digits, of which the
 * fifth and sixth are the letters of a country code.
 */
export const isValidBic = (value: string): boolean => bicProblem(value) === null;

// ---------------------------------------------------------------------------
// SIREN and SIRET
// ---------------------------------------------------------------------------

/** The Luhn check over a string of digits: true when it passes. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    const digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      const doubled = digit * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += digit;
    }
  }
  return sum % 10 === 0;
}

/** La Poste's SIREN. Its establishments' SIRETs do not satisfy the Luhn check. */
const LA_POSTE_SIREN = "356000000";

/**
 * What is wrong with a SIREN or SIRET.
 *
 * - `form`: not nine digits (SIREN) or fourteen (SIRET).
 * - `check-digit`: the Luhn check fails (for a SIRET: over all fourteen
 *   digits, or over the SIREN it begins with).
 * - `spaces`: the digits are right, but written with spaces between them.
 */
export type FrenchIdProblem = "form" | "check-digit" | "spaces";

function frenchIdProblem(value: string, length: 9 | 14): FrenchIdProblem | null {
  const trimmed = value.trim();
  const compact = trimmed.replace(/\s/g, "");
  if (compact.length !== length || !/^[0-9]+$/.test(compact)) return "form";
  const valid =
    length === 9
      ? luhn(compact)
      : // INSEE: a SIRET is the SIREN and a five-digit establishment number
        // (NIC) whose last digit makes all fourteen pass the Luhn check. La
        // Poste's establishments are the exception: their SIRETs are built so
        // that the digit sum is a multiple of 5. Its head office, 356 000 000
        // 00048, passes the Luhn check as well, and either test is accepted.
        luhn(compact.slice(0, 9)) &&
        (luhn(compact) ||
          (compact.startsWith(LA_POSTE_SIREN) &&
            [...compact].reduce((sum, digit) => sum + Number(digit), 0) % 5 === 0));
  if (!valid) return "check-digit";
  return compact === trimmed ? null : "spaces";
}

/** Whether `value` is not a SIREN, and why; null when it is one. */
export const sirenProblem = (value: string): FrenchIdProblem | null => frenchIdProblem(value, 9);

/** Whether `value` is not a SIRET, and why; null when it is one. */
export const siretProblem = (value: string): FrenchIdProblem | null => frenchIdProblem(value, 14);

/**
 * True when `value` is a SIREN: the nine digits INSEE gives a French company,
 * the last a Luhn check digit, written without spaces.
 */
export const isValidSiren = (value: string): boolean => sirenProblem(value) === null;

/**
 * True when `value` is a SIRET: fourteen digits, a SIREN and the establishment
 * number, where the SIREN passes its own Luhn check and all fourteen digits
 * pass the Luhn check, or, for La Poste (SIREN 356000000), add up to a
 * multiple of 5. Written without spaces.
 */
export const isValidSiret = (value: string): boolean => siretProblem(value) === null;
