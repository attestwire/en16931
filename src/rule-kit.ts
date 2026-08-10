import type {
  DocumentAllowanceCharge,
  InvoiceInput,
  InvoiceLine,
  Party,
  TeachingError,
  VatCategory,
} from "./types.js";

/**
 * Shared vocabulary for the rule families.
 *
 * `rules.ts` grew a private copy of all of this while it was the only rule
 * file. Wave A splits the rule set into families (`rules-codelists.ts`,
 * `rules-decimals.ts`, `rules-vat.ts`, `rules-core.ts`, `rules-de.ts`), which
 * need the same helpers, the same `DOCS` base and — importantly — the same
 * *tone*: every finding names the rule, says what the regulation requires,
 * says why, and hands back a fix that works on this build's model.
 *
 * Nothing here is exported from the package's public entry point.
 */

export type RuleResult = TeachingError | TeachingError[] | null;
export type RuleFn = (inv: InvoiceInput) => RuleResult;

/** Base for the per-rule documentation pages. One page per rule id. */
export const DOCS = "https://attestwire.com/rules";

/**
 * Where a *library limitation* (as opposed to a regulation rule) is
 * documented. Findings carrying an `ATW-` rule id are ours, not the
 * regulator's.
 */
export const LIMITS_DOCS = "https://github.com/attestwire/en16931#not-implemented-yet";

const XRECHNUNG_PROFILES = new Set(["xrechnung-ubl", "xrechnung-cii"]);
export const isXRechnung = (inv: InvoiceInput): boolean =>
  XRECHNUNG_PROFILES.has(inv.profile);
export const isPeppol = (inv: InvoiceInput): boolean =>
  inv.profile === "peppol-bis-3";

export const blank = (v: string | undefined | null): boolean =>
  v === undefined || v === null || String(v).trim() === "";

export const err = (e: TeachingError): TeachingError => e;

/** Human-readable names for the VAT categories, used in generated messages. */
export const CATEGORY_NAMES: Record<VatCategory, string> = {
  S: "Standard rated",
  Z: "Zero rated",
  E: "Exempt from VAT",
  AE: "Reverse charge",
  K: "Intra-community supply",
  G: "Export outside the EU",
  O: "Not subject to VAT",
  L: "Canary Islands general indirect tax (IGIC)",
  M: "Tax on production, services and imports in Ceuta and Melilla (IPSI)",
};

/** The nine categories this build's `VatCategory` union can express. */
export const ALL_CATEGORIES: readonly VatCategory[] = [
  "S",
  "Z",
  "E",
  "AE",
  "K",
  "G",
  "O",
  "L",
  "M",
];

/**
 * Rule-id infix per category. Three of the nine have a rule id that does not
 * match the code: EN 16931 names the intra-community family `BR-IC-*` though
 * BT-151 carries `K`, the Canary Islands family `BR-AF-*` though BT-151 carries
 * `L`, and the Ceuta/Melilla family `BR-AG-*` though BT-151 carries `M`. Never
 * derive a rule id from a category code directly — go through this table, or
 * you will emit ids that resolve to nothing.
 */
export const CATEGORY_RULE_INFIX: Record<VatCategory, string> = {
  S: "S",
  Z: "Z",
  E: "E",
  AE: "AE",
  K: "IC",
  G: "G",
  O: "O",
  L: "AF",
  M: "AG",
};

/**
 * The categories that behave like `S`: a real rate, charged, greater than or
 * equal to zero, with a repeatable breakdown group and no exemption reason.
 *
 * `S` itself demands a rate strictly greater than zero (BR-S-05); `L` and `M`
 * admit zero as well (BR-AF-05, BR-AG-05 both read "shall be 0 (zero) or
 * greater than zero"), because IGIC has a genuine 0% band for goods and
 * services the Canarian regime relieves without moving them out of the tax.
 */
export const RATED_CATEGORIES: readonly VatCategory[] = ["S", "L", "M"];

/**
 * The invoice lines, always as a real array.
 *
 * `InvoiceInput.lines` is required by the type, but `validateInput` exists
 * precisely for payloads that have not been through a type checker — JSON off
 * an HTTP request, a hand-built object in a JavaScript caller. Before 0.2.0 a
 * missing `lines` took the whole rule run down with
 * `TypeError: Cannot read properties of undefined (reading 'some')` instead of
 * returning the BR-16 finding that says exactly what is wrong, which defeated
 * the package's central promise on its single most likely malformed input. A
 * non-array value (`"lines": "x"`) failed the same way one step later, at
 * `.entries()`.
 *
 * Everything that reads lines goes through here, so both cases degrade to "no
 * lines" and BR-16 reports them.
 */
export const linesOf = (inv: InvoiceInput): InvoiceLine[] =>
  Array.isArray(inv?.lines) ? inv.lines : [];

export const usesCategory = (inv: InvoiceInput, cat: VatCategory): boolean =>
  linesOf(inv).some((l) => l?.vatCategory === cat);

/** An ISO 8601 calendar date, which is what every EN 16931 date term is. */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a well-formed `YYYY-MM-DD` that also denotes a real calendar day. */
export const isIsoDate = (value: string | undefined | null): boolean => {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
};

/**
 * A document level allowance or charge, tagged with everything a message needs
 * to point at it.
 *
 * BG-20 and BG-21 are the same UBL element with a different `ChargeIndicator`,
 * and every rule on one has a mirror on the other, so the rule families walk
 * them through this one shape rather than duplicating the loop. `position` is
 * the 1-based index *within the merged sequence the generator emits* —
 * allowances first, then charges — because that is what the XPath in the
 * finding has to address.
 */
export interface TaggedAllowanceCharge {
  entry: DocumentAllowanceCharge;
  /** True for BG-21 (a charge), false for BG-20 (an allowance). */
  isCharge: boolean;
  /** Index within `inv.allowances` or `inv.charges`, 0-based. */
  index: number;
  /** 1-based index among all `cac:AllowanceCharge` elements on the document. */
  position: number;
  /** "document level allowance" / "document level charge". */
  label: string;
  /** The group id: "BG-20" or "BG-21". */
  group: "BG-20" | "BG-21";
  /** Absolute XPath of the element. */
  xpath: string;
}

/** Every BG-20 and BG-21 entry, in the order the generator emits them. */
export const documentAllowanceCharges = (
  inv: InvoiceInput,
): TaggedAllowanceCharge[] => {
  const out: TaggedAllowanceCharge[] = [];
  const push = (
    entries: DocumentAllowanceCharge[] | undefined,
    isCharge: boolean,
  ) => {
    for (const [index, entry] of (entries ?? []).entries()) {
      if (!entry) continue;
      const position = out.length + 1;
      out.push({
        entry,
        isCharge,
        index,
        position,
        label: isCharge ? "document level charge" : "document level allowance",
        group: isCharge ? "BG-21" : "BG-20",
        xpath: `/ubl:Invoice/cac:AllowanceCharge[${position}]`,
      });
    }
  };
  push(inv.allowances, false);
  push(inv.charges, true);
  return out;
};

/** Human-readable "allowances[0]" / "charges[1]" for a fix that names the field. */
export const allowanceChargePath = (tagged: TaggedAllowanceCharge): string =>
  `${tagged.isCharge ? "charges" : "allowances"}[${tagged.index}]`;

/**
 * True when the category is used anywhere the per-category `-01` rules look:
 * an invoice line (BT-151), a document level allowance (BT-95) or a document
 * level charge (BT-102). Before wave B only lines could carry a category, so
 * `usesCategory` was the whole answer; it no longer is.
 */
export const usesCategoryAnywhere = (
  inv: InvoiceInput,
  cat: VatCategory,
): boolean =>
  usesCategory(inv, cat) ||
  documentAllowanceCharges(inv).some((t) => t.entry.vatCategory === cat);

/** BT-31 or BT-32 — either satisfies the "seller is tax-identified" family. */
export const sellerTaxIdentified = (seller: Party): boolean =>
  !blank(seller.vatId) || !blank(seller.taxRegistrationId);

/**
 * Count the decimal places a caller's number actually carries.
 *
 * The BR-DEC rules are written against the *serialised* value
 * (`string-length(substring-after(x, '.')) <= 2`), so the question is how many
 * decimals the number will have once it is written into the XML. `toString()`
 * is the right lens for that — but it switches to exponent form below 1e-7
 * (`1e-8` rather than `0.00000001`), which would report 0 decimals for a value
 * that plainly has eight. `toFixed(20)` covers the small end without the
 * binary-representation noise that a naive string split would pick up.
 */
export const decimalPlaces = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (Number.isInteger(value)) return 0;
  const plain = Math.abs(value) < 1e-6 ? value.toFixed(20) : String(value);
  const [, fraction = ""] = plain.split(".");
  return fraction.replace(/0+$/, "").length;
};

/**
 * The tolerance EN 16931's schematron applies to the VAT arithmetic rules
 * (BR-CO-17 and the `-08` / `-09` families).
 *
 * It is not a rounding epsilon. The reference implementation writes
 *
 *     abs(actual) - 1 < expected  and  abs(actual) + 1 > expected
 *
 * i.e. a *whole unit of the invoice currency*, exclusive at both ends. That
 * looks absurdly loose until you notice what it is for: it lets a sender who
 * computed VAT per line and summed, and a sender who computed VAT on the group
 * total, both pass, without the standard having to legislate one of them out
 * of existence. We hold ourselves to the exact value and report the official
 * tolerance only when explaining the finding.
 */
export const VAT_TOLERANCE = 1;

/**
 * The `-08` form: `actual - 1 < expected and actual + 1 > expected`.
 *
 * Signed on both sides. A negative invoice line is legal in EN 16931 (BR-27
 * forbids a negative *price*, not a negative amount), so a credit line
 * produces a negative taxable amount and both sides of this comparison go
 * negative together.
 */
export const withinSignedTolerance = (actual: number, expected: number): boolean =>
  actual - VAT_TOLERANCE < expected && actual + VAT_TOLERANCE > expected;

/**
 * The `-09` / BR-CO-17 form: `abs(actual) - 1 < expected and abs(actual) + 1 >
 * expected`, where `expected` is itself computed from `abs(taxableAmount)`.
 *
 * The magnitudes on both sides are not a stylistic choice in the schematron —
 * they are the only reason the rule works for a negative breakdown. Take the
 * magnitude on one side only and a perfectly correct credit breakdown fails:
 * abs(-85.50) - 1 = 84.50 is not less than -85.50. Pass `expected` already
 * computed from the magnitude of the taxable amount.
 */
export const withinAbsoluteTolerance = (actual: number, expected: number): boolean =>
  Math.abs(actual) - VAT_TOLERANCE < expected &&
  Math.abs(actual) + VAT_TOLERANCE > expected;
