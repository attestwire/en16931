import { describe, expect, it } from "vitest";
import { computeTotals } from "./totals.js";
import { decimalPlaces } from "./rule-kit.js";
import { allIds, clean, findingFor, withInvoice } from "./testkit.js";
import type { DeclaredTotals } from "./types.js";
import { generateXRechnungUBL } from "./generate.js";
import { generateCii } from "./generate-cii.js";
import { parseUblInvoice } from "./parse.js";
import { parseCiiInvoice } from "./parse-cii.js";
import { validateInput } from "./index.js";
import { countLexicalDecimals } from "./xml-reader.js";

/** The totals `clean` actually computes to: 10 x 150 = 1500.00 net, 19% VAT. */
const exact = computeTotals(clean);

const declared = (o: Partial<DeclaredTotals>) =>
  withInvoice({
    declaredTotals: {
      lineExtensionAmount: exact.lineExtensionAmount,
      taxExclusiveAmount: exact.taxExclusiveAmount,
      taxAmount: exact.taxAmount,
      taxInclusiveAmount: exact.taxInclusiveAmount,
      payableAmount: exact.payableAmount,
      ...o,
    },
  });

describe("decimalPlaces", () => {
  it("counts what will be serialised, not what was typed", () => {
    expect(decimalPlaces(1500)).toBe(0);
    expect(decimalPlaces(1500.0)).toBe(0);
    expect(decimalPlaces(1500.5)).toBe(1);
    expect(decimalPlaces(1500.05)).toBe(2);
    expect(decimalPlaces(1500.005)).toBe(3);
    expect(decimalPlaces(-1500.005)).toBe(3);
  });

  it("does not miscount a value that arrived in exponent form", () => {
    // String(1e-8) is "1e-8", which naive splitting reads as zero decimals.
    expect(decimalPlaces(1e-8)).toBe(8);
  });

  it("counts the tail floating-point arithmetic leaves behind", () => {
    expect(decimalPlaces(0.1 + 0.2)).toBeGreaterThan(2);
    expect(decimalPlaces(285)).toBe(0);
  });

  it("is 0 for non-finite input rather than throwing", () => {
    expect(decimalPlaces(Number.NaN)).toBe(0);
    expect(decimalPlaces(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("BR-DEC-*", () => {
  it("says nothing when no totals are declared", () => {
    expect(allIds(withInvoice({ declaredTotals: undefined }))).toEqual([]);
  });

  it("accepts declared totals with exactly two decimals", () => {
    expect(allIds(declared({}))).toEqual([]);
  });

  it("accepts integers and one-decimal values", () => {
    // 1500 and 1500.0 serialise to "1500.00"; nothing to complain about.
    expect(allIds(declared({}))).toEqual([]);
  });

  const cases: [string, keyof DeclaredTotals, number][] = [
    ["BR-DEC-09", "lineExtensionAmount", 1500.001],
    ["BR-DEC-12", "taxExclusiveAmount", 1500.001],
    ["BR-DEC-13", "taxAmount", 285.0004],
    ["BR-DEC-14", "taxInclusiveAmount", 1785.0011],
    ["BR-DEC-18", "payableAmount", 1785.0011],
  ];

  for (const [rule, key, value] of cases) {
    it(`${rule} fires on a three-decimal ${key}`, () => {
      const inv = declared({ [key]: value } as Partial<DeclaredTotals>);
      expect(allIds(inv)).toContain(rule);
      const finding = findingFor(inv, rule)!;
      expect(finding.severity).toBe("fatal");
      expect(finding.fix).toContain(String(key));
      expect(finding.message).toContain("is 2");
    });
  }

  it("is a boundary at exactly two decimals, not a tolerance", () => {
    expect(allIds(declared({ payableAmount: 1785.0 }))).not.toContain("BR-DEC-18");
    // 1785.001 differs from a passing value by a tenth of a cent and still fails:
    // the rule is about the serialised precision, not about materiality.
    expect(allIds(declared({ payableAmount: 1785.001 }))).toContain("BR-DEC-18");
  });

  it("catches the float tail a percentage calculation leaves", () => {
    const value = 1500 * 0.19000000000000003;
    expect(decimalPlaces(value)).toBeGreaterThan(2);
    expect(allIds(declared({ taxAmount: value }))).toContain("BR-DEC-13");
  });

  it("reports every over-precise total, not just the first", () => {
    const ids = allIds(
      declared({
        lineExtensionAmount: 1500.001,
        taxExclusiveAmount: 1500.001,
        taxAmount: 285.0004,
        taxInclusiveAmount: 1785.0011,
        payableAmount: 1785.0011,
      }),
    );
    for (const [rule] of cases) expect(ids).toContain(rule);
  });

  it("reports a non-finite declared total instead of crashing the rule run", () => {
    // Regression: `typeof NaN === "number"` slipped past the type guard in
    // rules.ts and reached round2, which threw a RangeError out of
    // validateInput — so a caller with one bad total got no findings at all.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -Infinity]) {
      const ids = allIds(declared({ taxAmount: value }));
      expect(ids).toContain("ATW-DECLARED-TOTAL-NOT-FINITE");
      expect(ids).not.toContain("BR-DEC-13");
    }
    const finding = findingFor(
      declared({ taxAmount: Number.NaN }),
      "ATW-DECLARED-TOTAL-NOT-FINITE",
    )!;
    expect(finding.field).toBe("BT-110");
    expect(finding.docsUrl).not.toContain("/rules/");
  });

  it("suggests the rounded value in its example", () => {
    const finding = findingFor(declared({ taxAmount: 285.0004 }), "BR-DEC-13")!;
    expect(finding.example).toContain("285.00");
  });
});

// ---------------------------------------------------------------------------
// BR-DEC on the SERIALISED value.
//
// Found by the benchmark's adversarial corpus, 2026-08-16
// (adv-huge-decimal-precision.xml): a line net amount written `1500.000000` is
// numerically identical to 1500.00, so every total still balanced and every
// arithmetic rule stayed quiet — and we reported nothing at all, while the CEN
// schematron rejected the document under BR-DEC-23. The rules measure
// `string-length(substring-after(., '.'))` on the text, which a parsed number
// cannot answer, so the readers now count the digits and record them in
// `declaredTotals.overPrecise`.
describe("BR-DEC-* against the document's own serialised decimals", () => {
  // Every occurrence of the element, because BT-106 and BT-131 share the local
  // name `LineExtensionAmount` in UBL: the document total and the line amount
  // are the same tag in two places, and a first-match replace silently edits
  // the total when the test meant the line.
  const overPrecise = (xml: string, element: string, value: string) =>
    xml.replace(
      new RegExp(`(<(?:cbc|ram):${element}[^>]*>)[^<]+(</)`, "g"),
      `$1${value}$2`,
    );

  it("BR-DEC-23: a UBL line net amount serialised at six decimals is fatal", () => {
    const xml = overPrecise(
      generateXRechnungUBL(clean),
      "LineExtensionAmount",
      "1500.000000",
    );
    const { invoice } = parseUblInvoice(xml);
    const finding = validateInput(invoice).errors.find((e) => e.rule === "BR-DEC-23");
    expect(finding).toBeDefined();
    expect(finding!.field).toBe("BT-131");
    expect(finding!.message).toContain("1500.000000");
    expect(finding!.message).toContain("6");
  });

  it("BR-DEC-23: the same defect in CII produces the same rule id", () => {
    const xml = overPrecise(
      generateCii({ ...clean, profile: "xrechnung-cii" }),
      "LineTotalAmount",
      "1500.000000",
    );
    const { invoice } = parseCiiInvoice(xml);
    const ids = validateInput(invoice).errors.map((e) => e.rule);
    expect(ids).toContain("BR-DEC-23");
  });

  it("trailing zeros count: 1500.00 is fine, 1500.000 is not", () => {
    const ok = parseUblInvoice(generateXRechnungUBL(clean)).invoice;
    expect(validateInput(ok).errors.map((e) => e.rule)).not.toContain("BR-DEC-23");
    const bad = parseUblInvoice(
      overPrecise(generateXRechnungUBL(clean), "LineExtensionAmount", "1500.000"),
    ).invoice;
    expect(validateInput(bad).errors.map((e) => e.rule)).toContain("BR-DEC-23");
  });

  it("BR-DEC-12: a document total serialised at six decimals is fatal too", () => {
    const xml = overPrecise(
      generateXRechnungUBL(clean),
      "TaxExclusiveAmount",
      "1500.000000",
    );
    const { invoice } = parseUblInvoice(xml);
    const finding = validateInput(invoice).errors.find((e) => e.rule === "BR-DEC-12");
    expect(finding).toBeDefined();
    expect(finding!.field).toBe("BT-109");
  });

  it("reports one finding per term, not one from the text and one from the number", () => {
    const xml = overPrecise(
      generateXRechnungUBL(clean),
      "TaxExclusiveAmount",
      "1500.0000001",
    );
    const { invoice } = parseUblInvoice(xml);
    const hits = validateInput(invoice).errors.filter((e) => e.rule === "BR-DEC-12");
    expect(hits).toHaveLength(1);
  });

  it("counts the lexical form, sign and all", () => {
    expect(countLexicalDecimals("1500")).toBe(0);
    expect(countLexicalDecimals("1500.00")).toBe(2);
    expect(countLexicalDecimals("1500.000000")).toBe(6);
    expect(countLexicalDecimals("-1500.000")).toBe(3);
    expect(countLexicalDecimals("  1500.0001  ")).toBe(4);
  });
});
