import { describe, expect, it } from "vitest";

import {
  IBAN_LENGTHS,
  bicProblem,
  hasLeitwegIdForm,
  ibanProblem,
  leitwegIdProblem,
  sirenProblem,
  siretProblem,
} from "./identifiers.js";
// The yes/no forms are the package's public API.
import { isValidBic, isValidIban, isValidLeitwegId, isValidSiren, isValidSiret } from "./index.js";

describe("Leitweg-ID", () => {
  it("accepts the specification's own example, and computes its check digits the way section 2.4 does", () => {
    // Leitweg-ID-Formatspezifikation 2.0.2, section 2.4: 04011000123451234500
    // mod 97 = 92, 98 - 92 = 06, and 04011000123451234506 mod 97 = 1.
    expect(isValidLeitwegId("04011000-1234512345-06")).toBe(true);
    expect(leitwegIdProblem("04011000-1234512345-07")).toBe("check-digits");
    expect(leitwegIdProblem("04011000-1234512346-06")).toBe("check-digits");
  });

  it("converts letters as for an IBAN, and does not care about their case", () => {
    expect(isValidLeitwegId("991-33333TEST-33")).toBe(true);
    expect(isValidLeitwegId("991-33333test-33")).toBe(true);
    expect(leitwegIdProblem("991-33333TEST-34")).toBe("check-digits");
  });

  it("accepts a coarse address with no fine address", () => {
    expect(isValidLeitwegId("04011000-45")).toBe(true);
    expect(isValidLeitwegId("991-35")).toBe(true);
    expect(leitwegIdProblem("991-36")).toBe("check-digits");
  });

  it("ignores whitespace around the value, not inside it", () => {
    expect(isValidLeitwegId("  04011000-1234512345-06\n")).toBe(true);
    expect(leitwegIdProblem("04011000 1234512345 06")).toBe("form");
  });

  it("refuses what is not in the form: missing hyphens, wrong lengths, other characters", () => {
    for (const value of [
      "04011000123451234506", // no hyphens
      "0-1234512345-06", // a coarse address of one digit
      "0401100012345-1234512345-06", // of thirteen
      "04011000-1234512345123451234512345123451-06", // a fine address of 31
      "04011000-1234512345-6", // one check digit
      "04011000-12345_12345-06", // an underscore
      "04011000–1234512345–06", // en dashes
      "",
    ]) {
      expect(leitwegIdProblem(value), value).toBe("form");
    }
  });

  it("knows the complete form of a Leitweg-ID from things that merely resemble it", () => {
    // Coarse addresses of each length table 1 allows, under a Land code or 99.
    for (const value of ["04011000-1234512345-06", "991-33333TEST-33", "04-1234-56", "05315-12", "123456789012-X-01"]) {
      expect(hasLeitwegIdForm(value), value).toBe(true);
    }
    for (const value of [
      "2026-07-31", // a date: a four-digit coarse address is not in table 1
      "20-4711-01", // 20 is not a Land code
      "00-4711-01",
      "0401-1234512345-06",
      "PO-4711-01",
      "4711",
      "04011000123451234506",
    ]) {
      expect(hasLeitwegIdForm(value), value).toBe(false);
    }
  });
});

describe("IBAN", () => {
  it("accepts real IBANs of every length, with or without the spaces between groups", () => {
    for (const iban of [
      "DE02120300000000202051",
      "DE89 3704 0044 0532 0130 00",
      "GB29NWBK60161331926819",
      "NL91ABNA0417164300",
      "FR1420041010050500013M02606",
      "MT84MALT011000012345MTLCAST001S",
      "NO9386011117947", // the shortest, 15
      "LC55HEMM000100010012001200023015", // the longest, 32
      "CH9300762011623852957",
    ]) {
      expect(isValidIban(iban), iban).toBe(true);
    }
  });

  it("says which of the checks fails", () => {
    expect(ibanProblem("DE02120300000000202052")).toEqual({ kind: "check-digits" });
    expect(ibanProblem("DE0212030000000020205")).toEqual({ kind: "length", expected: 22, actual: 21 });
    expect(ibanProblem("DE021203000000002020511")).toEqual({ kind: "length", expected: 22, actual: 23 });
    expect(ibanProblem("12030000000020205")).toEqual({ kind: "form" });
    expect(ibanProblem("DE02-1203-0000-0000-2020-51")).toEqual({ kind: "form" });
  });

  it("wants capitals, as ISO 13616 writes them and KoSIT compares them", () => {
    expect(ibanProblem("de02120300000000202051")).toEqual({ kind: "case" });
    expect(ibanProblem("NL91abna0417164300")).toEqual({ kind: "case" });
    // A wrong length or check digit is the finding that matters more.
    expect(ibanProblem("de0212030000000020205")).toEqual({ kind: "length", expected: 22, actual: 21 });
  });

  it("holds a country missing from the registry table to the check digits alone", () => {
    expect(IBAN_LENGTHS.XA).toBeUndefined();
    expect(ibanProblem("XA12345")).toEqual({ kind: "check-digits" });
    // Any length passes for such a country, as long as MOD 97 does: the check
    // digits of XA??123456789 are computed over 123456789, X = 33, A = 10, 00.
    const check = String(98 - Number(BigInt("123456789" + "3310" + "00") % 97n)).padStart(2, "0");
    expect(isValidIban(`XA${check}123456789`)).toBe(true);
  });

  it("knows the length of every EU and EEA country's IBAN", () => {
    const EU_EEA: Record<string, number> = {
      AT: 20, BE: 16, BG: 22, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18,
      FR: 27, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20,
      LV: 21, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24,
    };
    for (const [country, length] of Object.entries(EU_EEA)) expect(IBAN_LENGTHS[country], country).toBe(length);
  });
});

describe("BIC", () => {
  it("accepts 8- and 11-character BICs, digits in the party prefix included (ISO 9362:2014)", () => {
    for (const bic of ["BYLADEM1001", "COBADEFFXXX", "DEUTDEFF", "1234DEFF", "ABCDXK22", " DEUTDEFF "]) {
      expect(isValidBic(bic), bic).toBe(true);
    }
  });

  it("says what is wrong", () => {
    expect(bicProblem("DEUTDEF")).toBe("form");
    expect(bicProblem("DEUTDEFF5")).toBe("form");
    expect(bicProblem("COBA DE FF")).toBe("form");
    expect(bicProblem("DEUT12FF")).toBe("form");
    expect(bicProblem("COBAXXFF")).toBe("country");
    expect(bicProblem("cobadeff")).toBe("case");
  });
});

describe("SIREN and SIRET", () => {
  it("accepts a SIREN whose ninth digit closes the Luhn check", () => {
    for (const siren of ["123456782", "732829320", "356000000"]) expect(isValidSiren(siren), siren).toBe(true);
    expect(sirenProblem("123456789")).toBe("check-digit");
    expect(sirenProblem("12345678")).toBe("form");
    expect(sirenProblem("12345678A")).toBe("form");
    expect(sirenProblem("123 456 782")).toBe("spaces");
    expect(sirenProblem("123 456 789")).toBe("check-digit");
  });

  it("accepts a SIRET when all fourteen digits and its SIREN pass the Luhn check", () => {
    for (const siret of ["12345678200010", "73282932000074"]) expect(isValidSiret(siret), siret).toBe(true);
    expect(siretProblem("12345678200011")).toBe("check-digit");
    // All fourteen pass, the SIREN they begin with (123456789) does not.
    expect(siretProblem("12345678900007")).toBe("check-digit");
    expect(siretProblem("123456782")).toBe("form");
    expect(siretProblem("123 456 782 00010")).toBe("spaces");
  });

  it("applies INSEE's La Poste exception: a digit sum divisible by 5 instead of the Luhn check", () => {
    // The head office passes the Luhn check as well.
    expect(isValidSiret("35600000000048")).toBe(true);
    // An establishment that fails Luhn but whose digits add up to 15.
    expect(isValidSiret("35600000000001")).toBe(true);
    expect(isValidSiret("35600000049837")).toBe(true);
    // Neither test passes.
    expect(siretProblem("35600000000000")).toBe("check-digit");
    expect(siretProblem("35600000049838")).toBe("check-digit");
    // The exception is La Poste's alone.
    expect(siretProblem("12345678200011")).toBe("check-digit");
  });
});
