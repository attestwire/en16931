import { describe, expect, it } from "vitest";
import { computeTotals, lineNetAmount, round2 } from "./totals.js";
import type { InvoiceInput, InvoiceLine, VatCategory } from "./types.js";

const line = (patch: Partial<InvoiceLine> & { id: string }): InvoiceLine => ({
  description: "Item",
  quantity: 1,
  unitCode: "C62",
  unitPrice: 0,
  vatCategory: "S",
  vatRate: 19,
  ...patch,
});

const invoiceWith = (lines: InvoiceLine[]): InvoiceInput => ({
  profile: "xrechnung-ubl",
  invoiceNumber: "T-1",
  issueDate: "2026-08-09",
  currency: "EUR",
  buyerReference: "ref",
  seller: {
    name: "S",
    vatId: "DE123456789",
    address: { city: "Berlin", postalCode: "10115", countryCode: "DE" },
  },
  buyer: {
    name: "B",
    vatId: "DE987654321",
    address: { city: "Köln", postalCode: "50667", countryCode: "DE" },
  },
  lines,
});

describe("round2", () => {
  it("rounds half away from zero", () => {
    expect(round2(2.675)).toBe(2.68);
    expect(round2(1.005)).toBe(1.01);
    expect(round2(-2.675)).toBe(-2.68);
    expect(round2(0.125)).toBe(0.13);
  });

  it("survives the binary traps that break Math.round(x*100)/100", () => {
    // 1.005 * 100 === 100.49999999999999, so the naive version rounds down.
    expect(Math.round(1.005 * 100) / 100).toBe(1);
    expect(round2(1.005)).toBe(1.01);

    for (const [input, expected] of [
      [1.005, 1.01],
      [8.165, 8.17],
      [8.575, 8.58],
      [10.075, 10.08],
      [0.145, 0.15],
    ] as const) {
      expect(Math.round(input * 100) / 100, `naive(${input})`).not.toBe(expected);
      expect(round2(input), `round2(${input})`).toBe(expected);
    }
  });

  it("also beats toFixed, which rounds half-to-even-ish on binary boundaries", () => {
    // (2.675).toFixed(2) === "2.67" even though 2.675 * 100 is exactly 267.5.
    expect((2.675).toFixed(2)).toBe("2.67");
    expect(round2(2.675)).toBe(2.68);
  });

  it("normalises negative zero and passes through exact values", () => {
    expect(Object.is(round2(-0), 0)).toBe(true);
    expect(round2(1500)).toBe(1500);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  it("rejects non-finite input rather than emitting NaN into a tax document", () => {
    expect(() => round2(NaN)).toThrow(RangeError);
    expect(() => round2(Infinity)).toThrow(RangeError);
  });
});

describe("lineNetAmount (BT-131)", () => {
  it("multiplies quantity by net price and rounds to 2dp", () => {
    expect(lineNetAmount(line({ id: "1", quantity: 10, unitPrice: 150 }))).toBe(
      1500,
    );
    expect(
      lineNetAmount(line({ id: "1", quantity: 3, unitPrice: 33.333 })),
    ).toBe(100);
  });

  it("divides by the price base quantity (BT-149)", () => {
    expect(
      lineNetAmount(
        line({ id: "1", quantity: 500, unitPrice: 12.5, baseQuantity: 100 }),
      ),
    ).toBe(62.5);
  });

  it("refuses a zero base quantity instead of dividing by zero", () => {
    expect(() =>
      lineNetAmount(line({ id: "1", quantity: 1, unitPrice: 1, baseQuantity: 0 })),
    ).toThrow(RangeError);
  });
});

describe("computeTotals arithmetic (BR-CO-10/13/14/15/17)", () => {
  it("computes a single standard-rated line", () => {
    const t = computeTotals(
      invoiceWith([line({ id: "1", quantity: 10, unitPrice: 150 })]),
    );
    expect(t.lineExtensionAmount).toBe(1500);
    expect(t.taxExclusiveAmount).toBe(1500);
    expect(t.taxAmount).toBe(285);
    expect(t.taxInclusiveAmount).toBe(1785);
    expect(t.payableAmount).toBe(1785);
    expect(t.subtotals).toEqual([
      { category: "S", rate: 19, taxableAmount: 1500, taxAmount: 285 },
    ]);
  });

  it("groups lines by category AND rate, not by category alone", () => {
    const t = computeTotals(
      invoiceWith([
        line({ id: "1", quantity: 1, unitPrice: 100, vatRate: 19 }),
        line({ id: "2", quantity: 1, unitPrice: 200, vatRate: 7 }),
        line({ id: "3", quantity: 1, unitPrice: 50, vatRate: 19 }),
      ]),
    );
    expect(t.subtotals).toHaveLength(2);
    const standard = t.subtotals.find((s) => s.rate === 19)!;
    const reduced = t.subtotals.find((s) => s.rate === 7)!;
    expect(standard.taxableAmount).toBe(150);
    expect(standard.taxAmount).toBe(28.5);
    expect(reduced.taxableAmount).toBe(200);
    expect(reduced.taxAmount).toBe(14);
    expect(t.taxAmount).toBe(42.5);
    expect(t.taxInclusiveAmount).toBe(392.5);
  });

  it("sums ROUNDED line amounts, not the rounded sum of raw amounts", () => {
    // Three lines of 0.005 each: rounded per line they are 0.01 each (0.03),
    // whereas rounding the raw sum 0.015 would give 0.02. EN 16931 mandates
    // the former; a validator will reject the latter under BR-CO-10.
    const t = computeTotals(
      invoiceWith([
        line({ id: "1", quantity: 1, unitPrice: 0.005, vatRate: 19 }),
        line({ id: "2", quantity: 1, unitPrice: 0.005, vatRate: 19 }),
        line({ id: "3", quantity: 1, unitPrice: 0.005, vatRate: 19 }),
      ]),
    );
    expect(t.lineNetAmounts).toEqual([0.01, 0.01, 0.01]);
    expect(t.lineExtensionAmount).toBe(0.03);
    expect(round2(0.015)).toBe(0.02); // what the wrong approach would yield
  });

  it("keeps BR-CO-17 per-group: VAT is computed on the group, not the document", () => {
    // 1.11 and 2.22 at 19%: per-group VAT on 3.33 is 0.63.
    // Rounding per line first (0.21 + 0.42) would also give 0.63 here, but on
    // 0.05 + 0.05 at 19% the two approaches diverge — per line 0.01+0.01=0.02,
    // per group round(0.10 * 0.19) = 0.02. The group figure is normative.
    const t = computeTotals(
      invoiceWith([
        line({ id: "1", quantity: 1, unitPrice: 1.11 }),
        line({ id: "2", quantity: 1, unitPrice: 2.22 }),
      ]),
    );
    expect(t.subtotals[0]!.taxableAmount).toBe(3.33);
    expect(t.subtotals[0]!.taxAmount).toBe(0.63);
  });

  it("satisfies BR-CO-13/14/15/16 as identities on random multi-line invoices", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const rates = [19, 7, 0];
    const categories: VatCategory[] = ["S", "S", "Z"];

    for (let trial = 0; trial < 300; trial += 1) {
      const count = 1 + Math.floor(rand() * 8);
      const lines: InvoiceLine[] = [];
      for (let i = 0; i < count; i += 1) {
        const pick = Math.floor(rand() * rates.length);
        lines.push(
          line({
            id: String(i + 1),
            quantity: round2(1 + rand() * 20),
            unitPrice: round2(rand() * 500),
            vatCategory: categories[pick]!,
            vatRate: rates[pick]!,
          }),
        );
      }
      const t = computeTotals(invoiceWith(lines));

      // BR-CO-10: BT-106 = Σ BT-131 (of the rounded line amounts)
      expect(t.lineExtensionAmount).toBe(
        round2(t.lineNetAmounts.reduce((a, b) => a + b, 0)),
      );
      // BR-CO-13: no document allowances/charges yet, so BT-109 = BT-106
      expect(t.taxExclusiveAmount).toBe(t.lineExtensionAmount);
      // BR-CO-14: BT-110 = Σ BT-117
      expect(t.taxAmount).toBe(
        round2(t.subtotals.reduce((a, s) => a + s.taxAmount, 0)),
      );
      // BR-CO-17: BT-117 = round2(BT-116 x BT-119 / 100)
      for (const sub of t.subtotals) {
        expect(sub.taxAmount).toBe(round2((sub.taxableAmount * (sub.rate ?? 0)) / 100));
      }
      // BR-CO-15: BT-112 = BT-109 + BT-110
      expect(t.taxInclusiveAmount).toBe(
        round2(t.taxExclusiveAmount + t.taxAmount),
      );
      // BR-CO-16: BT-115 = BT-112
      expect(t.payableAmount).toBe(t.taxInclusiveAmount);
      // Every amount is a clean 2dp value.
      for (const amount of [
        t.lineExtensionAmount,
        t.taxExclusiveAmount,
        t.taxAmount,
        t.taxInclusiveAmount,
        t.payableAmount,
      ]) {
        expect(Number(amount.toFixed(2))).toBe(amount);
      }
      // BR-S-08 and siblings: each group's taxable amount is the sum of its lines.
      const bySubtotal = round2(
        t.subtotals.reduce((a, s) => a + s.taxableAmount, 0),
      );
      expect(bySubtotal).toBe(t.lineExtensionAmount);
    }
  });

  it("forces zero-rate categories to zero even if the caller supplies a rate", () => {
    const t = computeTotals(
      invoiceWith([
        line({ id: "1", quantity: 1, unitPrice: 100, vatCategory: "AE", vatRate: 19 }),
      ]),
    );
    expect(t.subtotals[0]!.rate).toBe(0);
    expect(t.subtotals[0]!.taxAmount).toBe(0);
    expect(t.taxInclusiveAmount).toBe(100);
  });

  it("omits the rate entirely for category O (BR-O-05)", () => {
    const t = computeTotals(
      invoiceWith([
        line({ id: "1", quantity: 1, unitPrice: 100, vatCategory: "O", vatRate: undefined }),
      ]),
    );
    expect(t.subtotals[0]!.rate).toBeUndefined();
    expect(t.subtotals[0]!.taxAmount).toBe(0);
  });

  it("attaches default exemption reasons only where a rule requires one", () => {
    const t = computeTotals(
      invoiceWith([
        line({ id: "1", unitPrice: 10, vatCategory: "AE", vatRate: 0 }),
        line({ id: "2", unitPrice: 10, vatCategory: "Z", vatRate: 0 }),
      ]),
    );
    const ae = t.subtotals.find((s) => s.category === "AE")!;
    const z = t.subtotals.find((s) => s.category === "Z")!;
    expect(ae.exemptionReason).toBe("Reverse charge"); // BR-AE-10
    expect(z.exemptionReason).toBeUndefined(); // BR-Z-10 forbids one
  });

  it("lets the caller override an exemption reason", () => {
    const inv = invoiceWith([
      line({ id: "1", unitPrice: 10, vatCategory: "AE", vatRate: 0 }),
    ]);
    inv.vatExemptionReasons = { AE: "Steuerschuldnerschaft des Leistungsempfängers" };
    const t = computeTotals(inv);
    expect(t.subtotals[0]!.exemptionReason).toBe(
      "Steuerschuldnerschaft des Leistungsempfängers",
    );
  });
});
