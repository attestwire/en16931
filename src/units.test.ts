import { describe, expect, it } from "vitest";

import { UNIT_CODES_SET, resolveUnitCode, validateInput } from "./index.js";
import { withLine } from "./testkit.js";
import { RESOLVABLE_UNIT_CODES } from "./units.js";

/** Every alias the build brief asked for, and the code it must resolve to. */
const REQUIRED: [string, string][] = [
  ...["Stk", "Stück", "St.", "pcs", "pc", "piece", "pieces", "pièce", "pièces"].map((w): [string, string] => [w, "H87"]),
  ...["Std", "Stunde", "Stunden", "h", "hr", "hrs", "hour", "hours", "heure", "heures"].map((w): [string, string] => [w, "HUR"]),
  ...["Tag", "Tage", "day", "days", "jour", "jours"].map((w): [string, string] => [w, "DAY"]),
  ...["Woche", "Wochen", "week", "weeks", "semaine", "semaines"].map((w): [string, string] => [w, "WEE"]),
  ...["Monat", "Monate", "month", "months", "mois"].map((w): [string, string] => [w, "MON"]),
  ...["Jahr", "Jahre", "year", "years", "an", "ans", "année", "années"].map((w): [string, string] => [w, "ANN"]),
  ...["min", "Minute", "Minuten", "minute", "minutes"].map((w): [string, string] => [w, "MIN"]),
  ["kg", "KGM"],
  ["g", "GRM"],
  ...["t", "Tonne", "Tonnen"].map((w): [string, string] => [w, "TNE"]),
  ["km", "KMT"],
  ...["m", "Meter"].map((w): [string, string] => [w, "MTR"]),
  ["cm", "CMT"],
  ["mm", "MMT"],
  ...["m2", "m²", "qm"].map((w): [string, string] => [w, "MTK"]),
  ...["m3", "m³", "cbm"].map((w): [string, string] => [w, "MTQ"]),
  ...["l", "L", "Liter", "litre", "litres"].map((w): [string, string] => [w, "LTR"]),
  ["kWh", "KWH"],
  ...["pauschal", "Pauschale", "flat", "lump sum", "forfait"].map((w): [string, string] => [w, "LS"]),
  ...["Einheit", "unit", "units", "unité", "unités"].map((w): [string, string] => [w, "C62"]),
];

describe("resolveUnitCode", () => {
  it("resolves every English, German and French alias it promises", () => {
    for (const [word, code] of REQUIRED) {
      expect(resolveUnitCode(word)?.code, word).toBe(code);
    }
  });

  it("returns only codes that are in the shipped UN/ECE Rec 20/21 list", () => {
    expect(RESOLVABLE_UNIT_CODES.length).toBe(20);
    for (const code of RESOLVABLE_UNIT_CODES) expect(UNIT_CODES_SET.has(code), code).toBe(true);
  });

  it("names each code as Rec 20 does", () => {
    expect(resolveUnitCode("Stk")).toEqual({ code: "H87", name: "piece" });
    expect(resolveUnitCode("Einheit")).toEqual({ code: "C62", name: "one" });
    expect(resolveUnitCode("hours")).toEqual({ code: "HUR", name: "hour" });
    expect(resolveUnitCode("Tonne")).toEqual({ code: "TNE", name: "tonne (metric ton)" });
    expect(resolveUnitCode("min")).toEqual({ code: "MIN", name: "minute [unit of time]" });
  });

  it("reads Stück as a piece (H87) and a generic unit as one (C62)", () => {
    expect(resolveUnitCode("Stück")?.code).toBe("H87");
    expect(resolveUnitCode("piece")?.code).toBe("H87");
    expect(resolveUnitCode("unit")?.code).toBe("C62");
  });

  it("ignores case, surrounding punctuation and whitespace, and a plural in brackets", () => {
    for (const word of ["STK", "stk.", " Stk. ", "(Stk)", "Stk,", "Stück(e)", "piece(s)", "PIECES", "Pièce(s)"]) {
      expect(resolveUnitCode(word)?.code, word).toBe("H87");
    }
    for (const word of ["Std.", "Stunde(n)", "HOURS", "hour(s)", "heure(s)"]) {
      expect(resolveUnitCode(word)?.code, word).toBe("HUR");
    }
    expect(resolveUnitCode("Tag(e)")?.code).toBe("DAY");
    expect(resolveUnitCode("an(s)")?.code).toBe("ANN");
    expect(resolveUnitCode("Einheit(en)")?.code).toBe("C62");
    expect(resolveUnitCode("lump  sum")?.code).toBe("LS");
    // "Stück" typed as u + combining diaeresis is the same word.
    expect(resolveUnitCode("Stück")?.code).toBe("H87");
  });

  it("resolves the code itself in any case", () => {
    expect(resolveUnitCode("hur")?.code).toBe("HUR");
    expect(resolveUnitCode("h87")?.code).toBe("H87");
    expect(resolveUnitCode("ls")?.code).toBe("LS");
  });

  it("does not guess", () => {
    for (const word of ["", "   ", "Palette", "xyz", "ms", "tags", "ton", "d", "mo", "each", "Stunde n", "HURR"]) {
      expect(resolveUnitCode(word), word).toBeUndefined();
    }
    expect(resolveUnitCode(42 as unknown as string)).toBeUndefined();
  });
});

describe("BR-CL-23 names the code a unit word stands for", () => {
  const brCl23 = (unitCode: string, quantity = 10) =>
    validateInput(withLine({ unitCode, quantity })).errors.find((f) => f.rule === "BR-CL-23")!;

  it("puts the resolved code in the fix and in the example", () => {
    const finding = brCl23("Stk", 3);
    expect(finding.severity).toBe("fatal");
    expect(finding.fix).toMatch(/^Set line\.unitCode to "H87" \(Rec 20: "piece"\), which is what "Stk" stands for\./);
    expect(finding.fix).toMatch(/resolveUnitCode\(\)/);
    expect(finding.example).toBe(`"quantity": 3, "unitCode": "H87"`);

    expect(brCl23("Stunden").fix).toMatch(/"HUR" \(Rec 20: "hour"\)/);
    expect(brCl23("Stunden").example).toBe(`"quantity": 10, "unitCode": "HUR"`);
    expect(brCl23("m²").example).toBe(`"quantity": 10, "unitCode": "MTK"`);
    expect(brCl23("pièces").example).toContain(`"unitCode": "H87"`);
  });

  it("says why pieces are H87 when the answer is H87 or C62", () => {
    expect(brCl23("Stk").fix).toMatch(/"H87" \(piece\) and "C62" \(one\) are both valid for a count/);
    expect(brCl23("Einheit").fix).toMatch(/"C62" \(Rec 20: "one"\)/);
    expect(brCl23("hours").fix).not.toMatch(/both valid for a count/);
  });

  it("keeps the general advice for a unit it cannot name", () => {
    const finding = brCl23("Palette");
    expect(finding.fix).toMatch(/^Set line\.unitCode to the Rec 20 code\. The ones you will actually use: "H87" piece, "C62" one/);
    expect(finding.example).toBe(`"quantity": 10, "unitCode": "HUR"`);
  });

  it("still names the upper-case form of a code written in lower case, and now the fix agrees", () => {
    const finding = brCl23("hur");
    expect(finding.message).toContain("case-sensitive");
    expect(finding.fix).toMatch(/^Set line\.unitCode to "HUR"/);
  });

  it("does not fire on a valid code, alias table or not", () => {
    for (const code of ["H87", "C62", "HUR", "LS", "XBX"]) {
      expect(validateInput(withLine({ unitCode: code })).errors.map((f) => f.rule), code).not.toContain("BR-CL-23");
    }
  });
});
