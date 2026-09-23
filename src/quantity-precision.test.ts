import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  computeTotals,
  generateCii,
  generateXRechnungUBL,
  parseCiiInvoice,
  parseUbl,
  validateInput,
} from "./index.js";
import { formatQuantity } from "./totals.js";

// From the 2026-09-23 fuzz run: a quantity with more than four decimals
// validated clean, then was written as `3.3333`, so the generated document's
// own line amounts no longer multiplied out (PEPPOL-EN16931-R120) and its
// payable amount drifted from the one validated.
const base = parseUbl(
  readFileSync(new URL("../fixtures/xrechnung-ubl-minimal.xml", import.meta.url), "utf8"),
).invoice;

describe("quantity precision", () => {
  it("keeps four decimals as a floor and up to twelve when present", () => {
    expect(formatQuantity(4)).toBe("4.0000");
    expect(formatQuantity(1.5)).toBe("1.5000");
    expect(formatQuantity(3.3333333333)).toBe("3.3333333333");
    expect(formatQuantity(0.000000000001)).toBe("0.000000000001");
    expect(formatQuantity(-0)).toBe("0.0000");
    expect(() => formatQuantity(Number.NaN)).toThrow(RangeError);
  });

  for (const [name, profile, generate, parse] of [
    ["UBL", "xrechnung-ubl", generateXRechnungUBL, (x: string) => parseUbl(x).invoice],
    ["CII", "xrechnung-cii", generateCii, (x: string) => parseCiiInvoice(x).invoice],
  ] as const) {
    it(`${name}: a 10-decimal quantity round-trips with identical totals`, () => {
      // declaredTotals are the fixture's own stated figures; with a new
      // quantity they would (rightly) disagree, so let the engine compute.
      const input = {
        ...base,
        declaredTotals: undefined,
        profile,
        lines: [{ ...base.lines[0]!, quantity: 3.3333333333, unitPrice: 1103.04 }],
      };
      expect(validateInput(input).errors).toEqual([]);
      const back = parse(generate(input));
      expect(back.lines[0]!.quantity).toBe(3.3333333333);
      expect(computeTotals(back)).toEqual(computeTotals(input));
      expect(validateInput(back).errors).toEqual([]);
    });
  }
});

// Same fuzz run: on a credit note (381), non-finite line values crashed
// validateInput instead of producing the findings an invoice (380) gets.
describe("credit notes with non-finite line values", () => {
  for (const patch of [
    { quantity: Number.NaN },
    { unitPrice: Number.POSITIVE_INFINITY },
    { vatRate: Number.NaN },
  ]) {
    it(`reports ${JSON.stringify(Object.keys(patch))} as findings, as on an invoice`, () => {
      const make = (invoiceTypeCode: string) => ({
        ...base,
        declaredTotals: undefined,
        invoiceTypeCode,
        lines: [{ ...base.lines[0]!, ...patch }],
      });
      const invoiceRules = validateInput(make("380")).errors.map((e) => e.rule);
      expect(invoiceRules.length).toBeGreaterThan(0);
      let credit: string[] = [];
      expect(() => (credit = validateInput(make("381")).errors.map((e) => e.rule))).not.toThrow();
      expect(credit.length).toBeGreaterThan(0);
    });
  }
});

// Same fuzz run: input validateInput passed and the generators then mangled
// or refused. Each is now a finding before generation.
describe("input the generators cannot write faithfully", () => {
  const rulesOf = (patch: object, linePatch: object = {}) =>
    validateInput({ ...base, declaredTotals: undefined, ...patch, lines: [{ ...base.lines[0]!, ...linePatch }] })
      .errors.concat(validateInput({ ...base, declaredTotals: undefined, ...patch, lines: [{ ...base.lines[0]!, ...linePatch }] }).warnings)
      .map((e) => `${e.rule}:${e.severity}`);

  it("text that is only a NUL or a lone surrogate is an error; mixed text is a warning", () => {
    expect(rulesOf({ buyer: { ...base.buyer, name: "\u0000" } })).toContain("ATW-TEXT-NOT-XML:fatal");
    expect(rulesOf({ invoiceNumber: "\uD800" })).toContain("ATW-TEXT-NOT-XML:fatal");
    expect(rulesOf({ note: "Danke\u0007" })).toContain("ATW-TEXT-NOT-XML:warning");
    expect(rulesOf({ note: "emoji 😀 is fine" }).join()).not.toMatch(/ATW-TEXT-NOT-XML/);
  });

  it("a VAT rate over 100% is an error, not a BigInt crash later", () => {
    expect(rulesOf({}, { vatRate: 1e308 })).toContain("ATW-VAT-RATE-OUT-OF-RANGE:fatal");
    expect(rulesOf({}, { vatRate: 100 }).join()).not.toMatch(/ATW-VAT-RATE-OUT-OF-RANGE/);
  });

  it("a NaN allowance percentage or base amount, and a 1e21 gross price, are errors", () => {
    expect(rulesOf({}, { allowances: [{ amount: 1, percentage: Number.NaN, reason: "x" }] })).toContain("ATW-NUMBER-NOT-FINITE:fatal");
    expect(rulesOf({}, { allowances: [{ amount: 1, baseAmount: Number.NaN, reason: "x" }] })).toContain("ATW-NUMBER-NOT-FINITE:fatal");
    expect(rulesOf({}, { grossUnitPrice: 1e21 })).toContain("ATW-NUMBER-TOO-LARGE:fatal");
  });

  it("a standard rate that is written as 0.00 fails BR-S-05 before generation", () => {
    expect(rulesOf({}, { vatCategory: "S", vatRate: 1e-300 })).toContain("BR-S-05:fatal");
    expect(rulesOf({}, { vatCategory: "S", vatRate: 0.001 })).toContain("BR-S-05:fatal");
    expect(rulesOf({}, { vatCategory: "S", vatRate: 0.005 }).join()).not.toMatch(/BR-S-05/);
  });

  it("a wrongly typed field is one finding, not a TypeError", () => {
    const input = { ...base, payment: { ...base.payment!, meansCode: 58 as unknown as string } };
    let rules: string[] = [];
    expect(() => (rules = validateInput(input).errors.map((e) => e.rule))).not.toThrow();
    expect(rules).toContain("ATW-INPUT-TYPE");
  });
});

// Found while pinning severities (2026-09-23): the official CEN schematron
// flags BR-S-10 / BR-Z-10 / BR-AF-10 / BR-AG-10 fatal, but the engine warned,
// so the CLI passed an XML file with an exemption reason on a standard-rated
// breakdown that KoSIT rejects.
describe("a forbidden exemption reason", () => {
  const xml = readFileSync(new URL("../fixtures/xrechnung-ubl-minimal.xml", import.meta.url), "utf8").replace(
    /(<cac:TaxSubtotal>[\s\S]*?<cac:TaxCategory>[\s\S]*?<cbc:Percent>[^<]*<\/cbc:Percent>)/,
    "$1<cbc:TaxExemptionReason>Not actually exempt</cbc:TaxExemptionReason>",
  );

  it("is fatal in a document that states it, as in the official schematron", () => {
    const fromXml = parseUbl(xml).invoice;
    const r = validateInput(fromXml);
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.rule)).toContain("BR-S-10");
  });

  it("is a warning on JSON input, where the generator drops it", () => {
    const r = validateInput({ ...base, declaredTotals: undefined, vatExemptionReasons: { S: "Not actually exempt" } });
    expect(r.warnings.map((e) => e.rule)).toContain("BR-S-10");
    expect(r.errors.map((e) => e.rule)).not.toContain("BR-S-10");
  });
});

// Second fuzz run (2026-09-23): validateInput must never throw, and anything
// it passes must generate.
describe("the object model, from a JavaScript or JSON caller", () => {
  const fromXml = () => structuredClone(base);
  const errs = (inv: unknown) => validateInput(inv as never).errors.map((e) => e.rule);

  it("reports absurd stated figures instead of throwing", () => {
    for (const [path, value] of [
      ["rate", Number.NaN],
      ["rate", Number.POSITIVE_INFINITY],
      ["taxableAmount", 1e308],
    ] as const) {
      const inv = fromXml();
      (inv.declaredTotals!.subtotals![0] as Record<string, unknown>)[path] = value;
      expect(() => errs(inv), `${path}=${value}`).not.toThrow();
      expect(errs(inv).some((r) => r.startsWith("ATW-")), `${path}=${value}`).toBe(true);
    }
    const inv = fromXml();
    inv.declaredTotals!.payableAmount = 1e308;
    expect(errs(inv)).toContain("ATW-NUMBER-TOO-LARGE");
  });

  it("reports null or text where a number belongs, and a number where text belongs", () => {
    const withLine = (patch: object) => ({ ...base, declaredTotals: undefined, lines: [{ ...base.lines[0]!, ...patch }] });
    expect(errs(withLine({ baseQuantity: null }))).toContain("ATW-INPUT-TYPE");
    expect(errs(withLine({ period: { startDate: "2026-08-01", endDate: null } }))).toContain("ATW-INPUT-TYPE");
    expect(errs(withLine({ allowances: [{ amount: 1, percentage: "5", reason: "x" }] }))).toContain("ATW-INPUT-TYPE");
    expect(errs({ ...base, supportingDocuments: [0] })).toContain("ATW-INPUT-TYPE");
    expect(errs({ ...base, seller: { ...base.seller, legalRegistrationSchemeId: null } })).toContain("ATW-INPUT-TYPE");
  });

  it("reports an unknown profile, which the generators would refuse", () => {
    for (const profile of ["S", "", null]) expect(errs({ ...base, profile })).toContain("ATW-PROFILE-UNKNOWN");
    expect(errs(base)).not.toContain("ATW-PROFILE-UNKNOWN");
  });
});
