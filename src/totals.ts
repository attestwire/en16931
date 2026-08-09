import type {
  InvoiceInput,
  InvoiceLine,
  InvoiceTotals,
  TaxSubtotal,
  VatCategory,
} from "./types.js";

/**
 * Document rounding, per EN 16931 §"Rounding" and BR-DEC-*: monetary amounts
 * carry at most two decimals, and document-level sums are sums of the *already
 * rounded* line amounts — not the rounded sum of unrounded lines. Getting this
 * backwards is the single most common cause of a BR-CO-10 / BR-CO-13 rejection.
 */

/**
 * Half-up rounding to 2 decimals, away from zero.
 *
 * Neither `Math.round(x * 100) / 100` nor `toFixed(2)` is correct here:
 *   - `1.005 * 100` is 100.49999999999999 in IEEE 754, so `Math.round` yields
 *     1.00 where every tax authority expects 1.01 (same for 8.165, 8.575, …).
 *   - `(2.675).toFixed(2)` is "2.67", because toFixed works from the binary
 *     value rather than the decimal literal.
 * Re-normalising through `toPrecision(15)` discards the representation error
 * before the rounding decision is made, so half-up applies to the decimal the
 * caller actually wrote.
 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot round non-finite amount: ${value}`);
  }
  if (value === 0) return 0;
  const sign = value < 0 ? -1 : 1;
  const scaled = Number((Math.abs(value) * 100).toPrecision(15));
  return (sign * Math.round(scaled)) / 100;
}

/** Render an amount for XML: always exactly 2 decimals, no exponent, no `-0`. */
export function formatAmount(value: number): string {
  const rounded = round2(value);
  return (rounded === 0 ? 0 : rounded).toFixed(2);
}

/** Render a quantity or percentage: trims to at most 4 decimals, no exponent. */
export function formatNumber(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot format non-finite number: ${value}`);
  }
  return (value === 0 ? 0 : value).toFixed(decimals);
}

/** Categories whose VAT rate is fixed at zero (BR-AE-05, BR-Z-05, BR-E-05, BR-IC-05, BR-G-05). */
export const ZERO_RATE_CATEGORIES: readonly VatCategory[] = [
  "Z",
  "E",
  "AE",
  "K",
  "G",
];

/** Category O must not carry a VAT rate at all (BR-O-05). */
export const NO_RATE_CATEGORIES: readonly VatCategory[] = ["O"];

/**
 * Default BT-120 exemption reason texts. AE/K/G/O have standard wording named
 * directly in BR-AE-10 / BR-IC-10 / BR-G-10 / BR-O-10; category E deliberately
 * has none, because the reason depends on which national exemption you claim.
 */
export const DEFAULT_EXEMPTION_REASONS: Partial<Record<VatCategory, string>> = {
  AE: "Reverse charge",
  K: "Intra-Community supply",
  G: "Export outside the EU",
  O: "Not subject to VAT",
};

/** Effective VAT rate for a line: categories with a fixed zero rate ignore a stray input. */
export function effectiveRate(line: InvoiceLine): number | undefined {
  if (NO_RATE_CATEGORIES.includes(line.vatCategory)) return undefined;
  if (ZERO_RATE_CATEGORIES.includes(line.vatCategory)) return 0;
  return line.vatRate ?? 0;
}

/** BT-131 invoice line net amount = quantity x (net price / base quantity), rounded half-up. */
export function lineNetAmount(line: InvoiceLine): number {
  const base = line.baseQuantity ?? 1;
  if (base === 0) {
    throw new RangeError(
      `Line ${line.id}: baseQuantity (BT-149) must not be zero.`,
    );
  }
  return round2((line.quantity * line.unitPrice) / base);
}

/**
 * Compute BG-22 document totals and the BG-23 VAT breakdown from the lines.
 *
 * Arithmetic, in the order the BR-CO rules require it:
 *   BT-131 per line, rounded to 2dp
 *   BT-106 = Σ BT-131                                  (BR-CO-10)
 *   BT-109 = BT-106 (no document allowances/charges yet) (BR-CO-13)
 *   BT-116 per (category, rate) group = Σ BT-131 in group (BR-S-08 and siblings)
 *   BT-117 = round2(BT-116 x BT-119 / 100)               (BR-CO-17)
 *   BT-110 = Σ BT-117                                    (BR-CO-14)
 *   BT-112 = BT-109 + BT-110                             (BR-CO-15)
 *   BT-115 = BT-112 (no prepaid or rounding amount yet)  (BR-CO-16)
 */
export function computeTotals(inv: InvoiceInput): InvoiceTotals {
  const lineNetAmounts = inv.lines.map(lineNetAmount);

  const lineExtensionAmount = round2(
    lineNetAmounts.reduce((sum, amount) => sum + amount, 0),
  );
  const taxExclusiveAmount = lineExtensionAmount;

  // Group by (category, rate). Insertion order is preserved so the breakdown
  // comes out in the order the categories first appear in the document.
  const groups = new Map<string, { category: VatCategory; rate?: number; taxable: number }>();
  for (const [index, line] of inv.lines.entries()) {
    const rate = effectiveRate(line);
    const key = `${line.vatCategory}|${rate ?? ""}`;
    const existing = groups.get(key);
    const amount = lineNetAmounts[index] ?? 0;
    if (existing) {
      existing.taxable = round2(existing.taxable + amount);
    } else {
      groups.set(key, { category: line.vatCategory, rate, taxable: amount });
    }
  }

  const subtotals: TaxSubtotal[] = [...groups.values()].map((group) => {
    const taxAmount = round2((group.taxable * (group.rate ?? 0)) / 100);
    const reason =
      inv.vatExemptionReasons?.[group.category] ??
      DEFAULT_EXEMPTION_REASONS[group.category];
    const subtotal: TaxSubtotal = {
      category: group.category,
      taxableAmount: group.taxable,
      taxAmount,
    };
    if (group.rate !== undefined) subtotal.rate = group.rate;
    // BR-S-10 and BR-Z-10 forbid an exemption reason on S and Z breakdowns.
    if (reason && group.category !== "S" && group.category !== "Z") {
      subtotal.exemptionReason = reason;
    }
    return subtotal;
  });

  const taxAmount = round2(
    subtotals.reduce((sum, subtotal) => sum + subtotal.taxAmount, 0),
  );
  const taxInclusiveAmount = round2(taxExclusiveAmount + taxAmount);

  return {
    lineNetAmounts,
    lineExtensionAmount,
    taxExclusiveAmount,
    taxAmount,
    taxInclusiveAmount,
    payableAmount: taxInclusiveAmount,
    subtotals,
  };
}
