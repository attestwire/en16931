import type {
  DocumentAllowanceCharge,
  InvoiceInput,
  InvoiceLine,
  InvoiceTotals,
  LineAllowanceCharge,
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
 * Categories whose breakdown must NOT carry a VAT exemption reason
 * (BR-S-10, BR-Z-10, BR-AF-10, BR-AG-10).
 *
 * Exported because `rules-vat.ts` enforces the same list from the other side —
 * one definition, so a category added to the union cannot be classified
 * differently by the arithmetic and by the rule that checks it.
 */
export const REASON_FORBIDDEN_CATEGORIES: readonly VatCategory[] = [
  "S",
  "Z",
  "L",
  "M",
];

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

/**
 * The same normalisation for a document level allowance or charge (BT-96 /
 * BT-103). BG-20 and BG-21 carry their own category and rate, and the rules
 * that constrain them (BR-{S,Z,E,AE,IC,G,O}-06/-07) are the exact mirror of
 * the line rules, so the normalisation must be too — otherwise an allowance
 * and the line it discounts land in different VAT breakdown groups.
 */
export function effectiveAllowanceChargeRate(
  entry: DocumentAllowanceCharge,
): number | undefined {
  if (NO_RATE_CATEGORIES.includes(entry.vatCategory)) return undefined;
  if (ZERO_RATE_CATEGORIES.includes(entry.vatCategory)) return 0;
  return entry.vatRate ?? 0;
}

/** Σ of a line's BG-27 allowances or BG-28 charges, each rounded first. */
function sumLineAllowanceCharges(
  entries: LineAllowanceCharge[] | undefined,
): number {
  if (!entries || entries.length === 0) return 0;
  let sum = 0;
  for (const entry of entries) {
    const amount = entry?.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount)) continue;
    sum = round2(sum + round2(amount));
  }
  return sum;
}

/**
 * BT-131 invoice line net amount.
 *
 *   BT-131 = BT-129 x (BT-146 / BT-149) − Σ BT-136 + Σ BT-141
 *
 * i.e. quantity times the unit price scaled by the price base quantity, less
 * the line allowances, plus the line charges. Rounded half-up at the end, once:
 * EN 16931 rounds the line amount, not its constituents, which is why a line
 * discount of 33.333% on 100.00 produces 66.67 and not 66.66.
 */
export function lineNetAmount(line: InvoiceLine): number {
  const base = line.baseQuantity ?? 1;
  if (base === 0) {
    throw new RangeError(
      `Line ${line.id}: baseQuantity (BT-149) must not be zero.`,
    );
  }
  const gross = (line.quantity * line.unitPrice) / base;
  const allowances = sumLineAllowanceCharges(line.allowances);
  const charges = sumLineAllowanceCharges(line.charges);
  return round2(gross - allowances + charges);
}

/** Σ BT-92 or Σ BT-99 over the document level entries, each rounded first. */
function sumDocumentAllowanceCharges(
  entries: DocumentAllowanceCharge[] | undefined,
): number {
  if (!entries || entries.length === 0) return 0;
  let sum = 0;
  for (const entry of entries) {
    const amount = entry?.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount)) continue;
    sum = round2(sum + round2(amount));
  }
  return sum;
}

/** The (category, rate) pair a line or a document allowance/charge belongs to. */
const groupKey = (category: VatCategory, rate: number | undefined): string =>
  `${category}|${rate ?? ""}`;

/**
 * Compute BG-22 document totals and the BG-23 VAT breakdown.
 *
 * Arithmetic, in the order the BR-CO rules require it:
 *   BT-131 per line, rounded to 2dp, net of BG-27 allowances and BG-28 charges
 *   BT-106 = Σ BT-131                                       (BR-CO-10)
 *   BT-107 = Σ BT-92  (document allowances)                 (BR-CO-11)
 *   BT-108 = Σ BT-99  (document charges)                    (BR-CO-12)
 *   BT-109 = BT-106 − BT-107 + BT-108                       (BR-CO-13)
 *   BT-116 per (category, rate) = Σ BT-131 − Σ BT-92 + Σ BT-99 in that group
 *                                                           (BR-S-08 and siblings)
 *   BT-117 = round2(BT-116 x BT-119 / 100)                  (BR-CO-17)
 *   BT-110 = Σ BT-117                                       (BR-CO-14)
 *   BT-112 = BT-109 + BT-110                                (BR-CO-15)
 *   BT-115 = BT-112 − BT-113 + BT-114                       (BR-CO-16)
 *
 * A document allowance and a document charge in the same (category, rate) group
 * net against each other inside BT-116; they do *not* cancel in BT-107/BT-108,
 * which stay separate sums. That asymmetry is deliberate in the standard: the
 * two totals are disclosures, the breakdown is the tax base.
 */
export function computeTotals(inv: InvoiceInput): InvoiceTotals {
  const lineNetAmounts = inv.lines.map(lineNetAmount);

  const lineExtensionAmount = round2(
    lineNetAmounts.reduce((sum, amount) => sum + amount, 0),
  );
  const allowanceTotalAmount = sumDocumentAllowanceCharges(inv.allowances);
  const chargeTotalAmount = sumDocumentAllowanceCharges(inv.charges);
  const taxExclusiveAmount = round2(
    lineExtensionAmount - allowanceTotalAmount + chargeTotalAmount,
  );

  // Group by (category, rate). Insertion order is preserved, and lines are
  // visited before document allowances and charges, so the breakdown comes out
  // in the order the categories first appear on the invoice.
  const groups = new Map<
    string,
    { category: VatCategory; rate?: number; taxable: number }
  >();
  const add = (category: VatCategory, rate: number | undefined, amount: number) => {
    const key = groupKey(category, rate);
    const existing = groups.get(key);
    if (existing) existing.taxable = round2(existing.taxable + amount);
    else groups.set(key, { category, rate, taxable: amount });
  };

  for (const [index, line] of inv.lines.entries()) {
    add(line.vatCategory, effectiveRate(line), lineNetAmounts[index] ?? 0);
  }
  for (const entry of inv.allowances ?? []) {
    if (!entry) continue;
    const amount = typeof entry.amount === "number" && Number.isFinite(entry.amount)
      ? round2(entry.amount)
      : 0;
    add(entry.vatCategory, effectiveAllowanceChargeRate(entry), -amount);
  }
  for (const entry of inv.charges ?? []) {
    if (!entry) continue;
    const amount = typeof entry.amount === "number" && Number.isFinite(entry.amount)
      ? round2(entry.amount)
      : 0;
    add(entry.vatCategory, effectiveAllowanceChargeRate(entry), amount);
  }

  const subtotals: TaxSubtotal[] = [...groups.values()].map((group) => {
    const taxAmount = round2((group.taxable * (group.rate ?? 0)) / 100);
    const reason =
      inv.vatExemptionReasons?.[group.category] ??
      DEFAULT_EXEMPTION_REASONS[group.category];
    const reasonCode = inv.vatExemptionReasonCodes?.[group.category];
    const subtotal: TaxSubtotal = {
      category: group.category,
      taxableAmount: group.taxable,
      taxAmount,
    };
    if (group.rate !== undefined) subtotal.rate = group.rate;
    // BR-S-10, BR-Z-10, BR-AF-10 and BR-AG-10 forbid an exemption reason on
    // the breakdowns for S, Z, L and M — the four categories where tax is
    // actually charged (or, for Z, charged at nothing), and so nothing is
    // exempt and there is nothing to explain.
    if (!REASON_FORBIDDEN_CATEGORIES.includes(group.category)) {
      if (reason) subtotal.exemptionReason = reason;
      if (reasonCode) subtotal.exemptionReasonCode = reasonCode;
    }
    return subtotal;
  });

  const taxAmount = round2(
    subtotals.reduce((sum, subtotal) => sum + subtotal.taxAmount, 0),
  );
  const taxInclusiveAmount = round2(taxExclusiveAmount + taxAmount);

  const paidAmount =
    typeof inv.paidAmount === "number" && Number.isFinite(inv.paidAmount)
      ? round2(inv.paidAmount)
      : 0;
  const roundingAmount =
    typeof inv.roundingAmount === "number" && Number.isFinite(inv.roundingAmount)
      ? round2(inv.roundingAmount)
      : 0;
  const payableAmount = round2(taxInclusiveAmount - paidAmount + roundingAmount);

  return {
    lineNetAmounts,
    lineExtensionAmount,
    allowanceTotalAmount,
    chargeTotalAmount,
    taxExclusiveAmount,
    taxAmount,
    taxInclusiveAmount,
    paidAmount,
    roundingAmount,
    payableAmount,
    subtotals,
  };
}
