import { describe, expect, it } from "vitest";
import { validateInput } from "./index.js";
import { clean, cleanLine } from "./testkit.js";
import { AmountRangeError, MAX_MONETARY_AMOUNT, computeTotals } from "./totals.js";
import type { InvoiceInput } from "./types.js";

/**
 * Exact monetary accumulation, checked against an independent oracle.
 *
 * The oracle never touches a float: prices and quantities are parsed from their
 * decimal strings into integer ratios, and every rounding is half-up away from
 * zero in BigInt. If computeTotals agrees with it across line counts up to
 * 10,000 and the decimal boundaries that break float rounding (1.005, 2.675,
 * 999999.995), no cent is being lost to repeated float addition.
 */

/** "12.345" -> [12345n, 1000n] */
const ratio = (decimal: string): [bigint, bigint] => {
  const [whole, fraction = ""] = decimal.split(".");
  return [BigInt(whole + fraction), 10n ** BigInt(fraction.length)];
};

const halfUp = (numerator: bigint, denominator: bigint): bigint => {
  const sign = numerator < 0n ? -1n : 1n;
  const n = numerator < 0n ? -numerator : numerator;
  return sign * ((2n * n + denominator) / (2n * denominator));
};

const MAX_CENTS = 99_999_999_999_999n;

const invoiceOf = (count: number, unitPrice: number, quantity: number): InvoiceInput => ({
  ...clean,
  lines: Array.from({ length: count }, (_, i) =>
    cleanLine({ id: String(i + 1), unitPrice, quantity, vatCategory: "S", vatRate: 19 }),
  ),
});

describe("exact monetary accumulation", () => {
  it("matches a rational oracle across line counts and decimal boundaries", () => {
    const prices = ["0.005", "1.005", "2.675", "0.0345", "0.00000001", "0.12345678", "999999.995"];
    const quantities = ["0.001", "0.125", "1", "3", "10", "10000"];
    for (const count of [1, 2, 10, 100, 1000, 6000, 10000]) {
      for (const price of prices) {
        for (const quantity of quantities) {
          const [pn, pd] = ratio(price);
          const [qn, qd] = ratio(quantity);
          const net = halfUp(pn * qn * 100n, pd * qd) * BigInt(count);
          const vat = halfUp(net * 19n, 100n);
          const payable = net + vat;
          const inv = invoiceOf(count, Number(price), Number(quantity));
          const label = `${count} x ${price} x ${quantity}`;

          if (payable > MAX_CENTS) {
            expect(() => computeTotals(inv), label).toThrow(AmountRangeError);
            continue;
          }
          const totals = computeTotals(inv);
          expect(totals.lineExtensionAmount, label).toBe(Number(net) / 100);
          expect(totals.taxAmount, label).toBe(Number(vat) / 100);
          expect(totals.payableAmount, label).toBe(Number(payable) / 100);
        }
      }
    }
  });

  it("keeps negative totals and offsetting document adjustments exact", () => {
    const inv = invoiceOf(10000, 999999.995, -3);
    const totals = computeTotals(inv);
    expect(totals.lineExtensionAmount).toBe(-29999999900);
    expect(totals.payableAmount).toBe(-35699999881);

    const adjusted = computeTotals({
      ...inv,
      allowances: [{ amount: 0.01, vatCategory: "S", vatRate: 19, reason: "Discount" }],
      charges: [{ amount: 0.02, vatCategory: "S", vatRate: 19, reason: "Charge" }],
      paidAmount: 0.03,
      roundingAmount: 0.02,
    });
    expect(adjusted.taxExclusiveAmount).toBe(-29999999899.99);
    expect(adjusted.subtotals[0]!.taxableAmount).toBe(adjusted.taxExclusiveAmount);
    expect(adjusted.payableAmount).toBe(-35699999881);
  });
});

describe("MAX_MONETARY_AMOUNT", () => {
  const atLimit: InvoiceInput = {
    ...clean,
    lines: [cleanLine({ quantity: 1, unitPrice: MAX_MONETARY_AMOUNT, vatCategory: "Z", vatRate: 0 })],
  };
  const overLimit: InvoiceInput = {
    ...atLimit,
    lines: [{ ...atLimit.lines[0]!, unitPrice: MAX_MONETARY_AMOUNT + 0.01 }],
  };

  it("computes exactly at the limit and throws one cent past it", () => {
    expect(computeTotals(atLimit).payableAmount).toBe(MAX_MONETARY_AMOUNT);
    expect(() => computeTotals(overLimit)).toThrow(AmountRangeError);
    // A total can cross the limit even when every input is inside it.
    expect(() =>
      computeTotals({
        ...atLimit,
        charges: [{ amount: 0.01, vatCategory: "Z", vatRate: 0, reason: "Charge" }],
      }),
    ).toThrow(AmountRangeError);
  });

  it("names the offending amount on the error", () => {
    try {
      computeTotals(overLimit);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AmountRangeError);
      expect((error as AmountRangeError).amount).toBeGreaterThan(MAX_MONETARY_AMOUNT);
      expect((error as Error).message).toContain(String(MAX_MONETARY_AMOUNT));
    }
  });

  // Before ATW-AMOUNT-OUT-OF-RANGE, the totals-based rules swallowed the throw
  // like any arithmetic failure and an over-limit invoice came back valid.
  it("is a fatal finding from validateInput, never a throw and never valid", () => {
    const result = validateInput(overLimit);
    expect(result.valid).toBe(false);
    const findings = result.errors.filter((e) => e.rule === "ATW-AMOUNT-OUT-OF-RANGE");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("fatal");
    expect(findings[0]!.docsUrl).toBe("https://github.com/attestwire/en16931#not-implemented-yet");
  });

  // The credit-note idiom check is the one rule that rethrows arithmetic
  // failures; it must not rethrow this one.
  it("is a finding on a credit note too", () => {
    const result = validateInput({ ...overLimit, invoiceTypeCode: "381" });
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.rule)).toContain("ATW-AMOUNT-OUT-OF-RANGE");
  });

  it("is not reported on an ordinary invoice", () => {
    const rules = validateInput(clean).errors.map((e) => e.rule);
    expect(rules).not.toContain("ATW-AMOUNT-OUT-OF-RANGE");
    expect(validateInput(atLimit).errors.map((e) => e.rule)).not.toContain(
      "ATW-AMOUNT-OUT-OF-RANGE",
    );
  });
});
