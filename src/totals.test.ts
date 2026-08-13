import { describe, expect, it } from "vitest";
import {
  MAX_PRICE_DECIMALS,
  computeTotals,
  effectiveRate,
  formatAmount,
  formatNumber,
  formatPrice,
  lineNetAmount,
  round2,
  roundTo,
} from "./totals.js";
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

// ---------------------------------------------------------------------------
// The full EN 16931 amount model: allowances, charges, prepayment, rounding.
// ---------------------------------------------------------------------------

describe("BT-131 with line allowances and charges (BG-27 / BG-28)", () => {
  it("subtracts line allowances and adds line charges", () => {
    // BT-131 = BT-129 x (BT-146 / BT-149) − Σ BT-136 + Σ BT-141
    const totals = computeTotals(
      invoiceWith([
        line({
          id: "1",
          quantity: 1,
          unitPrice: 300,
          allowances: [{ amount: 30 }],
          charges: [{ amount: 5 }],
        }),
      ]),
    );
    expect(totals.lineNetAmounts[0]).toBe(275);
    expect(totals.lineExtensionAmount).toBe(275);
  });

  it("sums several allowances and charges on one line", () => {
    expect(
      lineNetAmount(
        line({
          id: "1",
          quantity: 2,
          unitPrice: 100,
          allowances: [{ amount: 10 }, { amount: 5.5 }],
          charges: [{ amount: 1.25 }, { amount: 2.25 }],
        }),
      ),
    ).toBe(188);
  });

  it("rounds the line amount once, at the end, not its constituents", () => {
    // 3 x 33.333 = 99.999, less an allowance of 0.004 → 99.995 → 100.00.
    // Rounding the gross first would give 100.00 − 0.00 = 100.00 by luck;
    // rounding each constituent to 2dp first gives 100.00 − 0.00 too, so the
    // case that separates them is the one below.
    expect(
      lineNetAmount(
        line({ id: "1", quantity: 3, unitPrice: 33.333, allowances: [{ amount: 0.004 }] }),
      ),
    ).toBe(100);
  });

  it("ignores a non-finite allowance amount rather than poisoning the line", () => {
    // BR-41 reports the missing amount; the arithmetic must still produce a
    // number, or every other finding for the document is lost with it.
    expect(
      lineNetAmount(
        line({
          id: "1",
          quantity: 1,
          unitPrice: 100,
          allowances: [{ amount: Number.NaN }],
        }),
      ),
    ).toBe(100);
  });

  it("still divides by the price base quantity before applying the allowance", () => {
    expect(
      lineNetAmount(
        line({
          id: "1",
          quantity: 500,
          unitPrice: 12.5,
          baseQuantity: 100,
          allowances: [{ amount: 2.5 }],
        }),
      ),
    ).toBe(60);
  });
});

describe("BT-107 / BT-108 / BT-109: document allowances and charges", () => {
  const withDocument = (
    allowances: InvoiceInput["allowances"],
    charges: InvoiceInput["charges"],
  ): InvoiceInput => ({
    ...invoiceWith([line({ id: "1", quantity: 1, unitPrice: 1000, vatRate: 19 })]),
    allowances,
    charges,
  });

  it("BT-107 is the sum of allowance amounts and BT-108 the sum of charges", () => {
    const totals = computeTotals(
      withDocument(
        [
          { amount: 50, vatCategory: "S", vatRate: 19 },
          { amount: 25.5, vatCategory: "S", vatRate: 19 },
        ],
        [{ amount: 10, vatCategory: "S", vatRate: 19 }],
      ),
    );
    expect(totals.allowanceTotalAmount).toBe(75.5);
    expect(totals.chargeTotalAmount).toBe(10);
  });

  it("BT-109 = BT-106 − BT-107 + BT-108", () => {
    const totals = computeTotals(
      withDocument(
        [{ amount: 50, vatCategory: "S", vatRate: 19 }],
        [{ amount: 10, vatCategory: "S", vatRate: 19 }],
      ),
    );
    expect(totals.lineExtensionAmount).toBe(1000);
    expect(totals.taxExclusiveAmount).toBe(960);
  });

  it("keeps BT-107 and BT-108 as separate sums even when they cancel", () => {
    // They are disclosures, not a net figure. An allowance and a charge of the
    // same size leave BT-109 unchanged and must both still be reported.
    const totals = computeTotals(
      withDocument(
        [{ amount: 40, vatCategory: "S", vatRate: 19 }],
        [{ amount: 40, vatCategory: "S", vatRate: 19 }],
      ),
    );
    expect(totals.allowanceTotalAmount).toBe(40);
    expect(totals.chargeTotalAmount).toBe(40);
    expect(totals.taxExclusiveAmount).toBe(1000);
  });

  it("both are zero, not absent, when the document has neither", () => {
    const totals = computeTotals(withDocument(undefined, undefined));
    expect(totals.allowanceTotalAmount).toBe(0);
    expect(totals.chargeTotalAmount).toBe(0);
  });
});

describe("BG-23 with document allowances and charges", () => {
  it("nets an allowance out of the taxable amount of its own group only", () => {
    const totals = computeTotals({
      ...invoiceWith([
        line({ id: "1", quantity: 1, unitPrice: 1000, vatRate: 19 }),
        line({ id: "2", quantity: 1, unitPrice: 100, vatRate: 7 }),
      ]),
      allowances: [{ amount: 100, vatCategory: "S", vatRate: 19 }],
      charges: [{ amount: 20, vatCategory: "S", vatRate: 7 }],
    });
    const standard = totals.subtotals.find((s) => s.rate === 19)!;
    const reduced = totals.subtotals.find((s) => s.rate === 7)!;
    expect(standard.taxableAmount).toBe(900);
    expect(standard.taxAmount).toBe(171);
    expect(reduced.taxableAmount).toBe(120);
    expect(reduced.taxAmount).toBe(8.4);
    expect(totals.taxAmount).toBe(179.4);
  });

  it("opens a new breakdown group for a category that only an allowance uses", () => {
    const totals = computeTotals({
      ...invoiceWith([line({ id: "1", quantity: 1, unitPrice: 1000, vatRate: 19 })]),
      allowances: [{ amount: 50, vatCategory: "Z", vatRate: 0 }],
    });
    expect(totals.subtotals.map((s) => s.category)).toEqual(["S", "Z"]);
    const zero = totals.subtotals.find((s) => s.category === "Z")!;
    expect(zero.taxableAmount).toBe(-50);
    expect(zero.taxAmount).toBe(0);
  });

  it("normalises an allowance rate the same way it normalises a line rate", () => {
    // A stray 19% on a reverse-charge allowance must not split the AE group.
    const totals = computeTotals({
      ...invoiceWith([line({ id: "1", quantity: 1, unitPrice: 1000, vatCategory: "AE", vatRate: 0 })]),
      allowances: [{ amount: 50, vatCategory: "AE", vatRate: 19 }],
    });
    expect(totals.subtotals.length).toBe(1);
    expect(totals.subtotals[0]!.taxableAmount).toBe(950);
    expect(totals.subtotals[0]!.taxAmount).toBe(0);
  });

  it("gives a category-O allowance no rate at all", () => {
    const totals = computeTotals({
      ...invoiceWith([
        line({ id: "1", quantity: 1, unitPrice: 100, vatCategory: "O", vatRate: undefined }),
      ]),
      allowances: [{ amount: 10, vatCategory: "O" }],
    });
    expect(totals.subtotals.length).toBe(1);
    expect(totals.subtotals[0]!.rate).toBeUndefined();
    expect(totals.subtotals[0]!.taxableAmount).toBe(90);
  });
});

describe("BT-112 / BT-113 / BT-114 / BT-115: the payable chain", () => {
  const base = invoiceWith([line({ id: "1", quantity: 1, unitPrice: 1000, vatRate: 19 })]);

  it("BT-115 = BT-112 when there is no prepayment and no rounding", () => {
    const totals = computeTotals(base);
    expect(totals.taxInclusiveAmount).toBe(1190);
    expect(totals.paidAmount).toBe(0);
    expect(totals.roundingAmount).toBe(0);
    expect(totals.payableAmount).toBe(1190);
  });

  it("subtracts the paid amount (BT-113)", () => {
    expect(computeTotals({ ...base, paidAmount: 500 }).payableAmount).toBe(690);
  });

  it("adds the rounding amount (BT-114), which is signed", () => {
    expect(computeTotals({ ...base, roundingAmount: 0.4 }).payableAmount).toBe(1190.4);
    expect(computeTotals({ ...base, roundingAmount: -0.4 }).payableAmount).toBe(1189.6);
  });

  it("applies both in the order the rule states: BT-112 − BT-113 + BT-114", () => {
    const totals = computeTotals({ ...base, paidAmount: 190.37, roundingAmount: 0.37 });
    expect(totals.payableAmount).toBe(1000);
  });

  it("rounds a prepayment and a rounding amount to two decimals", () => {
    const totals = computeTotals({ ...base, paidAmount: 100.005, roundingAmount: 0.004 });
    expect(totals.paidAmount).toBe(100.01);
    expect(totals.roundingAmount).toBe(0);
  });

  it("treats a non-finite prepayment as zero rather than throwing", () => {
    const totals = computeTotals({ ...base, paidAmount: Number.NaN });
    expect(totals.paidAmount).toBe(0);
    expect(totals.payableAmount).toBe(1190);
  });

  it("holds the whole chain together on a document that uses every term", () => {
    const totals = computeTotals({
      ...invoiceWith([
        line({ id: "1", quantity: 10, unitPrice: 150, vatRate: 19 }),
        line({ id: "2", quantity: 4, unitPrice: 24.95, vatRate: 7 }),
        line({
          id: "3",
          quantity: 1,
          unitPrice: 300,
          vatRate: 19,
          allowances: [{ amount: 30 }],
        }),
      ]),
      allowances: [{ amount: 53.1, vatCategory: "S", vatRate: 19 }],
      charges: [{ amount: 24.9, vatCategory: "S", vatRate: 19 }],
      paidAmount: 500,
      roundingAmount: 0.47,
    });
    expect(totals.lineExtensionAmount).toBe(1869.8);
    expect(totals.allowanceTotalAmount).toBe(53.1);
    expect(totals.chargeTotalAmount).toBe(24.9);
    expect(totals.taxExclusiveAmount).toBe(1841.6);
    expect(totals.subtotals.map((s) => [s.rate, s.taxableAmount, s.taxAmount])).toEqual([
      [19, 1741.8, 330.94],
      [7, 99.8, 6.99],
    ]);
    expect(totals.taxAmount).toBe(337.93);
    expect(totals.taxInclusiveAmount).toBe(2179.53);
    expect(totals.payableAmount).toBe(1680);
    // BR-CO-15 and BR-CO-16 as identities, not as spot values.
    expect(totals.taxInclusiveAmount).toBe(
      round2(totals.taxExclusiveAmount + totals.taxAmount),
    );
    expect(totals.payableAmount).toBe(
      round2(totals.taxInclusiveAmount - totals.paidAmount + totals.roundingAmount),
    );
  });
});

describe("BT-121: the VAT exemption reason code", () => {
  const exempt = (patch: Partial<InvoiceInput>): InvoiceInput => ({
    ...invoiceWith([
      line({ id: "1", quantity: 1, unitPrice: 100, vatCategory: "E", vatRate: 0 }),
    ]),
    ...patch,
  });

  it("carries a supplied code onto the breakdown", () => {
    const totals = computeTotals(
      exempt({ vatExemptionReasonCodes: { E: "VATEX-EU-132-1I" } }),
    );
    expect(totals.subtotals[0]!.exemptionReasonCode).toBe("VATEX-EU-132-1I");
  });

  it("suppresses both the code and the text on S and Z, as BR-S-10 and BR-Z-10 require", () => {
    const totals = computeTotals({
      ...invoiceWith([line({ id: "1", quantity: 1, unitPrice: 100, vatCategory: "Z", vatRate: 0 })]),
      vatExemptionReasons: { Z: "no VAT" },
      vatExemptionReasonCodes: { Z: "VATEX-EU-132-1I" },
    });
    expect(totals.subtotals[0]!.exemptionReason).toBeUndefined();
    expect(totals.subtotals[0]!.exemptionReasonCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Finding 7: BT-146/147/148 were force-rounded to two decimals.
// ---------------------------------------------------------------------------

describe("formatPrice: a unit price is not a monetary amount (finding 7)", () => {
  it("keeps the decimals a per-unit price actually needs", () => {
    // The reproduction: 10000 x 0.0345 = 345.00. `formatAmount` wrote 0.03,
    // so the document said 10000 x 0.03 = 345.00 — a price wrong by 71%, on a
    // document KoSIT accepts, because no rule ties BT-146 to BT-131.
    expect(formatAmount(0.0345)).toBe("0.03");
    expect(formatPrice(0.0345)).toBe("0.0345");
    expect(formatPrice(0.00125)).toBe("0.00125");
    expect(formatPrice(0.000001)).toBe("0.000001");
  });

  it("keeps two decimals as a floor, so the ordinary case is unchanged", () => {
    expect(formatPrice(150)).toBe("150.00");
    expect(formatPrice(150.5)).toBe("150.50");
    expect(formatPrice(150.55)).toBe("150.55");
    expect(formatPrice(0)).toBe("0.00");
    expect(formatPrice(-12.5)).toBe("-12.50");
  });

  it("does not leak floating-point noise into the document", () => {
    expect(formatPrice(0.1 + 0.2)).toBe("0.30");
    expect(formatPrice(1 / 3)).toBe(`0.${"3".repeat(MAX_PRICE_DECIMALS)}`);
  });

  it("never emits exponent notation, which xs:decimal does not accept", () => {
    for (const value of [1e-9, 1e-7, 1e20, -1e20, 0.0000001, 123456789012345]) {
      expect(formatPrice(value)).not.toMatch(/[eE]/);
    }
    // Below the last decimal kept, the honest answer is zero, not "1e-9".
    expect(formatPrice(1e-9)).toBe("0.00");
    // At or above 1e21 `toFixed` itself goes exponential. Caught while
    // reviewing this fix: `formatPrice(1e22)` returned the string "1e+22.",
    // which is not a number in any syntax. Refused rather than written.
    expect(() => formatPrice(1e21)).toThrow(RangeError);
    expect(() => formatPrice(1e22)).toThrow(RangeError);
    expect(() => formatPrice(-1.5e21)).toThrow(RangeError);
  });

  it("refuses a non-finite price rather than writing one", () => {
    expect(() => formatPrice(Number.NaN)).toThrow(RangeError);
    expect(() => formatPrice(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Finding 8: BT-119 truncated by toFixed while BT-117 came from the full rate.
// ---------------------------------------------------------------------------

describe("VAT rate normalisation (finding 8)", () => {
  it("rounds half-up instead of truncating, which toFixed does not", () => {
    // The trap round2's own docblock warns about, six lines above the function
    // that fell into it.
    expect((16.665).toFixed(2)).toBe("16.66");
    expect(formatNumber(16.665)).toBe("16.67");
    expect((2.675).toFixed(2)).toBe("2.67");
    expect(formatNumber(2.675)).toBe("2.68");
    expect(formatNumber(1.0049, 2)).toBe("1.00");
  });

  it("normalises the rate before the breakdown is computed from it", () => {
    // BT-119 and BT-117 must come from one number. Emitting 16.66 against a
    // CalculatedAmount computed at 16.665% was a KoSIT REJECT under BR-CO-17
    // and BR-S-09 in both syntaxes, once the base cleared the ±1 tolerance.
    expect(effectiveRate({
      id: "1",
      description: "x",
      quantity: 1,
      unitCode: "C62",
      unitPrice: 100000,
      vatCategory: "S",
      vatRate: 16.665,
    })).toBe(16.67);

    const totals = computeTotals(
      invoiceWith([
        line({ id: "1", quantity: 1, unitPrice: 100000, vatCategory: "S", vatRate: 16.665 }),
      ]),
    );
    expect(totals.subtotals[0]!.rate).toBe(16.67);
    // 100000 x 16.67% = 16670.00, which is what BT-119 now says too.
    expect(totals.subtotals[0]!.taxAmount).toBe(16670);
    expect(formatNumber(totals.subtotals[0]!.rate!)).toBe("16.67");
  });

  it("keeps a zero-rated category at zero however the caller writes it", () => {
    expect(effectiveRate({
      id: "1",
      description: "x",
      quantity: 1,
      unitCode: "C62",
      unitPrice: 10,
      vatCategory: "E",
      vatRate: 19,
    })).toBe(0);
  });

  it("rounds to arbitrary precision without the binary-representation error", () => {
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(-1.005, 2)).toBe(-1.01);
    expect(roundTo(2.6755, 3)).toBe(2.676);
    expect(roundTo(0, 4)).toBe(0);
    expect(() => roundTo(Number.NaN, 2)).toThrow(RangeError);
  });
});
