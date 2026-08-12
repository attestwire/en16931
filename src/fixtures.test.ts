import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  generateCii,
  generateXRechnungUBL,
  validateInput,
  computeTotals,
} from "./index.js";
import {
  discountedXRechnung,
  discountedXRechnungCii,
  extendedXRechnungCii,
  minimalXRechnung,
  minimalXRechnungCii,
  reverseChargeXRechnung,
  reverseChargeXRechnungCii,
} from "./fixtures.js";
import type { InvoiceInput } from "./types.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const read = (name: string) => readFileSync(join(fixturesDir, name), "utf8");

const cases: [string, InvoiceInput][] = [
  ["xrechnung-ubl-minimal.xml", minimalXRechnung],
  ["xrechnung-ubl-reverse-charge.xml", reverseChargeXRechnung],
  ["xrechnung-ubl-discount.xml", discountedXRechnung],
];

const ciiCases: [string, InvoiceInput][] = [
  ["xrechnung-cii-minimal.xml", minimalXRechnungCii],
  ["xrechnung-cii-reverse-charge.xml", reverseChargeXRechnungCii],
  ["xrechnung-cii-discount.xml", discountedXRechnungCii],
  ["xrechnung-cii-extended.xml", extendedXRechnungCii],
];

describe("committed CII fixtures", () => {
  it.each(ciiCases)("%s is byte-identical to current output", (name, input) => {
    // If this fails, the generator changed: re-run
    //   npm run build && node scripts/emit-fixtures.mjs
    // and then re-run ./scripts/kosit-check.sh before committing the diff. The
    // recorded KoSIT verdict only covers the documents in fixtures/.
    expect(generateCii(input)).toBe(read(name));
  });

  it.each(ciiCases)("%s comes from an input with no findings at all", (_name, input) => {
    const result = validateInput(input);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.information).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("the CII and UBL fixtures are the same three invoices in two syntaxes", () => {
    // The point of the pairing: one InvoiceInput, two bindings. If these ever
    // diverge on anything but `profile`, the comparison stops meaning anything.
    const pairs: [InvoiceInput, InvoiceInput][] = [
      [minimalXRechnung, minimalXRechnungCii],
      [reverseChargeXRechnung, reverseChargeXRechnungCii],
      [discountedXRechnung, discountedXRechnungCii],
    ];
    for (const [ubl, cii] of pairs) {
      expect(cii).toEqual({ ...ubl, profile: "xrechnung-cii" });
      expect(computeTotals(cii)).toEqual(computeTotals(ubl));
    }
  });
});

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

  it.each(cases)("%s draws no advisory findings either", (_name, input) => {
    // Every release fixture states its time of supply, so BR-DE-TMP-32 stays
    // silent. A published example that trips even an `information` finding
    // teaches the wrong shape.
    expect(validateInput(input).information).toEqual([]);
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

describe("the discount fixture: the shape 0.1.x could not express", () => {
  it("nets the line allowance out of BT-131 on line 3 only", () => {
    const totals = computeTotals(discountedXRechnung);
    // 300.00 less a 10% line allowance of 30.00.
    expect(totals.lineNetAmounts).toEqual([1500, 99.8, 270]);
  });

  it("reports BT-107 and BT-108 separately and applies both to BT-109", () => {
    const totals = computeTotals(discountedXRechnung);
    expect(totals.lineExtensionAmount).toBe(1869.8);
    expect(totals.allowanceTotalAmount).toBe(53.1);
    expect(totals.chargeTotalAmount).toBe(24.9);
    expect(totals.taxExclusiveAmount).toBe(1841.6);
  });

  it("moves the document allowance and charge into the 19% group, not the 7% one", () => {
    const totals = computeTotals(discountedXRechnung);
    expect(totals.subtotals.map((s) => [s.rate, s.taxableAmount, s.taxAmount])).toEqual([
      [19, 1741.8, 330.94],
      [7, 99.8, 6.99],
    ]);
  });

  it("closes the payable chain through the prepayment and the rounding amount", () => {
    const totals = computeTotals(discountedXRechnung);
    expect(totals.taxInclusiveAmount).toBe(2179.53);
    expect(totals.paidAmount).toBe(500);
    expect(totals.roundingAmount).toBe(0.47);
    // The rounding amount exists so that the payable figure can be a round one
    // without any line or total being falsified to get there.
    expect(totals.payableAmount).toBe(1680);
  });

  it("references the partial invoice it settles", () => {
    expect(discountedXRechnung.precedingInvoices?.[0]?.invoiceNumber).toBe("2026-000118");
    const xml = read("xrechnung-ubl-discount.xml");
    expect(xml).toContain("<cac:BillingReference>");
    expect(xml).toContain("2026-000118");
  });

  it("states its time of supply through an invoicing period rather than a delivery date", () => {
    expect(discountedXRechnung.deliveryDate).toBeUndefined();
    expect(discountedXRechnung.invoicingPeriod?.startDate).toBe("2026-07-01");
    expect(validateInput(discountedXRechnung).information).toEqual([]);
  });
});
