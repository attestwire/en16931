/**
 * Unit words to UN/ECE Recommendation 20 codes.
 *
 * `BR-CL-23` refuses a unit of measure (BT-130) that is not a Rec 20 code, and
 * the values it refuses are almost always words: "Stk", "Std.", "hours",
 * "pièces". This table says which code such a word means, so the finding can
 * hand back the code instead of a list to search, and a caller can convert its
 * own units before they reach an invoice.
 *
 * **H87 or C62.** Both are valid Rec 20 codes and every validator accepts
 * either. Rec 20 names H87 "piece" and C62 "one", a unit of count of anything.
 * This table follows the split XRechnung practice makes: "Stück", "piece" and
 * "pièce" are H87; "Einheit", "unit" and "unité", a generic unit, are C62.
 *
 * Deliberately small and literal. It holds words that mean one unit and
 * nothing else, in English, German and French, with their plurals written out
 * rather than derived by stripping an ending: a suffix rule reads the English
 * "tags" as the German "Tag", a day. An abbreviation that could be read two
 * ways ("d", "mo", "ton", whose US sense is not the tonne) is not in it,
 * because a wrong code is worse than none.
 */

/** A unit word's Rec 20 code and that code's Rec 20 name. */
export interface ResolvedUnitCode {
  code: string;
  name: string;
}

/** The Rec 20 name of each code this table resolves to. */
const UNIT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  H87: "piece",
  C62: "one",
  HUR: "hour",
  DAY: "day",
  WEE: "week",
  MON: "month",
  ANN: "year",
  MIN: "minute [unit of time]",
  KGM: "kilogram",
  GRM: "gram",
  TNE: "tonne (metric ton)",
  KMT: "kilometre",
  MTR: "metre",
  CMT: "centimetre",
  MMT: "millimetre",
  MTK: "square metre",
  MTQ: "cubic metre",
  LTR: "litre",
  KWH: "kilowatt hour",
  LS: "lump sum",
});

/** The words for each code, lower-cased, singular and plural. */
const WORDS: Readonly<Record<string, readonly string[]>> = {
  H87: ["stk", "stck", "st", "stück", "stücke", "stueck", "stuecke", "pc", "pcs", "pce", "piece", "pieces", "pièce", "pièces"],
  C62: ["einheit", "einheiten", "unit", "units", "unité", "unités"],
  HUR: ["std", "stunde", "stunden", "h", "hr", "hrs", "hour", "hours", "heure", "heures"],
  DAY: ["tag", "tage", "day", "days", "jour", "jours"],
  WEE: ["woche", "wochen", "week", "weeks", "wk", "wks", "semaine", "semaines"],
  MON: ["monat", "monate", "month", "months", "mois"],
  ANN: ["jahr", "jahre", "year", "years", "yr", "yrs", "an", "ans", "année", "années"],
  MIN: ["min", "mins", "minute", "minuten", "minutes"],
  KGM: ["kg", "kgs", "kilogramm", "kilogram", "kilograms", "kilogramme", "kilogrammes"],
  GRM: ["g", "gramm", "gram", "grams", "gramme", "grammes"],
  TNE: ["t", "tonne", "tonnen", "tonnes"],
  KMT: ["km", "kms", "kilometer", "kilometers", "kilometre", "kilometres", "kilomètre", "kilomètres"],
  MTR: ["m", "meter", "meters", "metre", "metres", "mètre", "mètres"],
  CMT: ["cm", "zentimeter", "centimeter", "centimeters", "centimetre", "centimetres", "centimètre", "centimètres"],
  MMT: ["mm", "millimeter", "millimeters", "millimetre", "millimetres", "millimètre", "millimètres"],
  MTK: ["m2", "m²", "qm", "sqm", "quadratmeter", "square metre", "square metres", "square meter", "square meters"],
  MTQ: ["m3", "m³", "cbm", "kubikmeter", "cubic metre", "cubic metres", "cubic meter", "cubic meters"],
  LTR: ["l", "liter", "liters", "litre", "litres"],
  KWH: ["kwh"],
  LS: ["pauschal", "pauschale", "psch", "flat", "flat rate", "lump sum", "forfait"],
};

/** Word, and each code itself lower-cased, to code. */
const ALIASES: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [code, words] of Object.entries(WORDS)) {
    map.set(code.toLowerCase(), code);
    for (const word of words) map.set(word, code);
  }
  return map;
})();

/** A plural written in brackets after the word: "piece(s)", "Stunde(n)", "Einheit(en)". */
const BRACKETED_PLURAL = /\((?:s|e|n|en|es)\)(?=[\s.,;:!?]*$)/;

/** Punctuation and whitespace around a unit word: "Std.", "(Stk)", "pcs,". */
const EDGE_PUNCTUATION = /^[\s.,;:!?'"()[\]{}]+|[\s.,;:!?'"()[\]{}]+$/g;

/**
 * The UN/ECE Recommendation 20 code a unit word stands for, or undefined when
 * the word is not one this table knows.
 *
 * Case-insensitive. Surrounding punctuation and whitespace are ignored, and so
 * is a plural written in brackets ("Stunde(n)", "piece(s)"); written-out
 * plurals are in the table ("Stunden", "units", "heures"). The code itself
 * resolves too, in any case: "hur" is HUR.
 *
 * ```ts
 * resolveUnitCode("Stk.")     // { code: "H87", name: "piece" }
 * resolveUnitCode("Stunden")  // { code: "HUR", name: "hour" }
 * resolveUnitCode("m²")       // { code: "MTK", name: "square metre" }
 * resolveUnitCode("Palette")  // undefined
 * ```
 */
export function resolveUnitCode(text: string): ResolvedUnitCode | undefined {
  if (typeof text !== "string") return undefined;
  const word = text
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(BRACKETED_PLURAL, "")
    .replace(EDGE_PUNCTUATION, "")
    .replace(/\s+/g, " ");
  const code = ALIASES.get(word);
  return code === undefined ? undefined : { code, name: UNIT_NAMES[code]! };
}

/** Every code {@link resolveUnitCode} can return, for the test that checks each is in the Rec 20 list. */
export const RESOLVABLE_UNIT_CODES: readonly string[] = Object.freeze(Object.keys(UNIT_NAMES));
