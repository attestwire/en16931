import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { generateXRechnungUBL, validateInput, computeTotals } from "./index.js";
import { minimalXRechnung, reverseChargeXRechnung } from "./fixtures.js";
import type { InvoiceInput } from "./types.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const read = (name: string) => readFileSync(join(fixturesDir, name), "utf8");

const cases: [string, InvoiceInput][] = [
  ["xrechnung-ubl-minimal.xml", minimalXRechnung],
  ["xrechnung-ubl-reverse-charge.xml", reverseChargeXRechnung],
];

describe("committed fixtures", () => {
  it.each(cases)("%s is byte-identical to current output", (name, input) => {
    // If this fails, the generator changed: re-run
    //   npm run build && node scripts/emit-fixtures.mjs
    // and review the diff before committing it.
    expect(generateXRechnungUBL(input)).toBe(read(name));
  });

  it.each(cases)("%s comes from an input with zero fatal errors", (_name, input) => {
    const result = validateInput(input);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it.each(cases)("%s comes from an input with zero warnings", (_name, input) => {
    expect(validateInput(input).warnings).toEqual([]);
  });
});

describe("round trip: input → XML → declared totals agree", () => {
  it.each(cases)(
    "%s totals in the XML match computeTotals, and re-declaring them validates",
    (name, input) => {
      const xml = read(name);
      const totals = computeTotals(input);

      const grab = (tag: string) =>
        new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`).exec(
          /<cac:LegalMonetaryTotal>[\s\S]*?<\/cac:LegalMonetaryTotal>/.exec(xml)![0],
        )![1];

      expect(grab("cbc:LineExtensionAmount")).toBe(
        totals.lineExtensionAmount.toFixed(2),
      );
      expect(grab("cbc:TaxExclusiveAmount")).toBe(
        totals.taxExclusiveAmount.toFixed(2),
      );
      expect(grab("cbc:TaxInclusiveAmount")).toBe(
        totals.taxInclusiveAmount.toFixed(2),
      );
      expect(grab("cbc:PayableAmount")).toBe(totals.payableAmount.toFixed(2));

      // Feeding the computed totals back in as declaredTotals must not trip
      // any BR-CO rule — the arithmetic has to be self-consistent.
      const rechecked = validateInput({
        ...input,
        declaredTotals: {
          lineExtensionAmount: totals.lineExtensionAmount,
          taxExclusiveAmount: totals.taxExclusiveAmount,
          taxAmount: totals.taxAmount,
          taxInclusiveAmount: totals.taxInclusiveAmount,
          payableAmount: totals.payableAmount,
        },
      });
      expect(rechecked.errors).toEqual([]);
    },
  );

  it("the minimal fixture carries two VAT rates and sums them correctly", () => {
    const totals = computeTotals(minimalXRechnung);
    // 10 x 150.00 = 1500.00 at 19%; 4 x 24.95 = 99.80 at 7%.
    expect(totals.lineNetAmounts).toEqual([1500, 99.8]);
    expect(totals.lineExtensionAmount).toBe(1599.8);
    expect(totals.subtotals.map((s) => [s.rate, s.taxableAmount, s.taxAmount])).toEqual(
      [
        [19, 1500, 285],
        [7, 99.8, 6.99],
      ],
    );
    expect(totals.taxAmount).toBe(291.99);
    expect(totals.taxInclusiveAmount).toBe(1891.79);
  });

  it("the reverse-charge fixture carries no VAT at all", () => {
    const totals = computeTotals(reverseChargeXRechnung);
    expect(totals.taxAmount).toBe(0);
    expect(totals.taxExclusiveAmount).toBe(totals.taxInclusiveAmount);
    expect(totals.subtotals).toHaveLength(1);
    expect(totals.subtotals[0]!.category).toBe("AE");
    expect(totals.subtotals[0]!.exemptionReason).toBe("Reverse charge");
  });
});
