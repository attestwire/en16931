import { usableDefects } from "./declared-totals.js";
import { DOCS, LIMITS_DOCS, decimalPlaces, err } from "./rule-kit.js";
import type { RuleFn } from "./rule-kit.js";
import type { DeclaredTotals, TeachingError } from "./types.js";

/**
 * BR-DEC-*: decimal precision.
 *
 * Each BR-DEC rule caps one business term at two decimal places. In the
 * schematron the test is on the *serialised* value —
 * `string-length(substring-after(x, '.')) <= 2` — which is worth internalising,
 * because it means the rule is about what you write, not about what the number
 * "really" is. `19.999999999999998`, the sort of value floating-point
 * arithmetic hands back from `169.49 * 0.118`, is a BR-DEC failure the moment
 * it reaches the XML.
 *
 * These rules can only fire against values the *caller* supplies, which on the
 * current model means `declaredTotals`. Everything the library computes goes
 * through `round2` and is written with `formatAmount`, so the emitted document
 * satisfies the whole BR-DEC family by construction. That is exactly why the
 * check belongs here: a caller whose own ledger carries an over-precise total
 * finds out from us, before their figure meets a validator that will only say
 * "BR-DEC-12".
 *
 * There is deliberately **no** rule capping the item net price (BT-146). EN
 * 16931 does not impose one — a unit price of 0.00125 per unit is legitimate
 * and common (per-kilo, per-kWh, per-thousand-impressions pricing), and it is
 * the derived line net amount (BT-131) that must land on two decimals. Adding
 * a BR-DEC rule for BT-146 would be inventing a constraint.
 *
 * Rule texts from `ubl/schematron/abstract/EN16931-model.sch`,
 * ConnectingEurope/eInvoicing-EN16931 @ validation-1.3.16.
 */

interface DecSpec {
  rule: string;
  field: `BT-${number}`;
  key: keyof DeclaredTotals;
  label: string;
  xpath: string;
  /** Why an over-precise value for *this* term usually happens. */
  why: string;
}

const DEC_SPECS: DecSpec[] = [
  {
    rule: "BR-DEC-09",
    field: "BT-106",
    key: "lineExtensionAmount",
    label: "Sum of Invoice line net amounts",
    xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:LineExtensionAmount",
    why: "A sum of line amounts only carries extra decimals if the lines were summed before they were rounded. EN 16931 requires the opposite order: round each line net amount (BT-131) to two decimals first, then add.",
  },
  {
    rule: "BR-DEC-12",
    field: "BT-109",
    key: "taxExclusiveAmount",
    label: "Invoice total amount without VAT",
    xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount",
    why: "This total inherits its precision from BT-106; check that one too.",
  },
  {
    rule: "BR-DEC-13",
    field: "BT-110",
    key: "taxAmount",
    label: "Invoice total VAT amount",
    xpath: "/ubl:Invoice/cac:TaxTotal/cbc:TaxAmount",
    why: "Applying a percentage produces a long decimal almost every time — 1 234.56 x 19% is 234.5664. VAT is rounded per VAT breakdown group (BR-CO-17) and the rounded group amounts are then summed, so the total should never carry more than two decimals.",
  },
  {
    rule: "BR-DEC-14",
    field: "BT-112",
    key: "taxInclusiveAmount",
    label: "Invoice total amount with VAT",
    xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount",
    why: "BT-112 is BT-109 + BT-110; if either of those is over-precise this one will be too.",
  },
  {
    rule: "BR-DEC-18",
    field: "BT-115",
    key: "payableAmount",
    label: "Amount due for payment",
    xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:PayableAmount",
    why: "This is the figure the buyer actually pays. No payment system can settle a fraction of a cent, which is why the rounding amount (BT-114) exists as a separate, disclosed business term rather than being hidden in the payable amount.",
  },
];

/**
 * The BR-DEC id, label and advice for a business term measured on its
 * *serialised* form. Keyed by BT number so the parsers never have to know a
 * rule id.
 */
const LEXICAL_SPECS: Record<
  string,
  { rule: string; label: string; xpath: string; why: string }
> = {
  "BT-106": {
    rule: "BR-DEC-09",
    label: "Sum of Invoice line net amounts",
    xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:LineExtensionAmount",
    why: DEC_SPECS[0]!.why,
  },
  "BT-107": {
    rule: "BR-DEC-10",
    label: "Sum of allowances on document level",
    xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:AllowanceTotalAmount",
    why: "It is a sum of already-rounded document allowance amounts (BT-92), so extra decimals here mean one of those escaped rounding, or the sum was taken before it.",
  },
  "BT-108": {
    rule: "BR-DEC-11",
    label: "Sum of charges on document level",
    xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:ChargeTotalAmount",
    why: "It is a sum of already-rounded document charge amounts (BT-99), so extra decimals here mean one of those escaped rounding, or the sum was taken before it.",
  },
  "BT-109": {
    rule: "BR-DEC-12",
    label: "Invoice total amount without VAT",
    xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount",
    why: DEC_SPECS[1]!.why,
  },
  "BT-110": {
    rule: "BR-DEC-13",
    label: "Invoice total VAT amount",
    xpath: "/ubl:Invoice/cac:TaxTotal/cbc:TaxAmount",
    why: DEC_SPECS[2]!.why,
  },
  "BT-112": {
    rule: "BR-DEC-14",
    label: "Invoice total amount with VAT",
    xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount",
    why: DEC_SPECS[3]!.why,
  },
  "BT-115": {
    rule: "BR-DEC-18",
    label: "Amount due for payment",
    xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:PayableAmount",
    why: DEC_SPECS[4]!.why,
  },
  "BT-116": {
    rule: "BR-DEC-19",
    label: "VAT category taxable amount",
    xpath: "/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount",
    why: "The taxable amount is a sum of already-rounded line amounts, less already-rounded document allowances, plus already-rounded document charges.",
  },
  "BT-117": {
    rule: "BR-DEC-20",
    label: "VAT category tax amount",
    xpath: "/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount",
    why: "Applying a percentage produces a long decimal nearly every time, which is why BR-CO-17 requires the multiplication to be rounded to two decimals at the group.",
  },
  "BT-131": {
    rule: "BR-DEC-23",
    label: "Invoice line net amount",
    xpath: "/ubl:Invoice/cac:InvoiceLine/cbc:LineExtensionAmount",
    why: "A line amount is exactly where decimals accumulate, because it is a quantity multiplied by a price and then adjusted by allowances and charges. EN 16931 requires the line to be rounded once, at the end, to two decimals.",
  },
};

export const decimalRules: RuleFn[] = [
  // ATW-DECLARED-TOTAL-NOT-FINITE: ours, not the regulator's.
  //
  // `typeof NaN === "number"`, so a NaN or Infinity in declaredTotals passed
  // every type guard and reached round2, which threw — taking the whole rule
  // run down with an unhandled RangeError rather than returning findings. It is
  // reported here instead. There is no EN 16931 rule for it because no XML can
  // express it: xs:decimal has no NaN.
  (inv) => {
    const declared = inv.declaredTotals;
    if (!declared) return null;
    const out: TeachingError[] = [];
    for (const spec of DEC_SPECS) {
      const value = declared[spec.key];
      if (typeof value !== "number" || Number.isFinite(value)) continue;
      out.push(
        err({
          rule: "ATW-DECLARED-TOTAL-NOT-FINITE",
          field: spec.field,
          severity: "fatal",
          message: `declaredTotals.${String(spec.key)} (${spec.field}, ${spec.label}) is ${String(value)}, which is not a finite number. This is not a rule of the regulation — no invoice can express it, because the XML type behind every monetary amount is xs:decimal and has no NaN or infinity. It is almost always the residue of an arithmetic slip upstream: dividing by a zero quantity, summing an array containing undefined, or parsing a total out of a string that was not one. Reported as a finding rather than thrown, so you get the rest of the findings for this document at the same time.`,
          fix: `Trace where declaredTotals.${String(spec.key)} is computed and guard the inputs — Number.isFinite() on the result before assigning it is usually enough. If you only wanted the library's own totals, drop declaredTotals entirely: generation always emits computed values regardless of what you declare.`,
          example: `"declaredTotals": { "${String(spec.key)}": 1785.00 }`,
          xpath: spec.xpath,
          docsUrl: LIMITS_DOCS,
        }),
      );
    }
    return out;
  },

  // ATW-DECLARED-TOTAL-NOT-A-NUMBER: ours, and the honest name for it.
  //
  // The sibling of the rule above, on the XML path. A document total that is
  // *present* but that no reader can turn into a number — an empty element, or
  // text like `12,34` or `notanumber` — used to be dropped by the parsers, and
  // dropping it meant BR-CO-16 and its family had nothing to compare, so the
  // document came back `valid: true` with zero findings. Since 0.6.0 the
  // readers record it in `declaredTotals.defects` and it is reported here.
  //
  // WHY NOT A BR ID. There is no EN 16931 business rule for this, and inventing
  // one would misrepresent what the regulator does. KoSIT rejects these files
  // at the XML Schema step, before any schematron runs: `'1891,79' is not a
  // valid value for 'decimal'` / `'' is not a valid value for 'decimal'`,
  // `cvc-datatype-valid.1.2.1` (verified 2026-08-14, validator 1.6.2 with the
  // XRechnung 3.0.2 configuration, on both syntaxes). This build is not a
  // schema validator, so it cannot quote that code as its own; an ATW id says
  // "this is our finding, about a datatype the regulation fixes elsewhere",
  // which is the true shape of the thing. The verdict matches: rejected.
  //
  // Read through `usableDefects` for the same reason as the presence rules: the
  // JSON endpoints hand `validateInput` whatever was posted, and a hand-written
  // `defects` entry that is `null`, or carries a state this build has never
  // heard of, must not become an exception or a nonsense finding. The state is
  // tested POSITIVELY here — `empty` and `unreadable`, not "anything that is not
  // absent" — because the negative test turned `state: "banana"` into a finding
  // claiming an unreadable value that nothing said was unreadable.
  (inv) => {
    const defects = usableDefects(inv.declaredTotals);
    if (defects.length === 0) return null;
    const out: TeachingError[] = [];
    for (const { defect, term, text, element } of defects) {
      if (defect.state !== "empty" && defect.state !== "unreadable") continue;
      const seen = defect.state === "empty" ? "" : text;
      const comma = /^[+-]?\d{1,3}(\.\d{3})*,\d+$|^[+-]?\d+,\d+$/.test(seen);
      out.push(
        err({
          rule: "ATW-DECLARED-TOTAL-NOT-A-NUMBER",
          field: term.field,
          severity: "fatal",
          message: `The ${term.label} (${term.field}) is present in this document but could not be read as a number: ${defect.state === "empty" ? "the element is empty" : `the element holds ${JSON.stringify(seen)}`}. ${comma ? "That is a decimal comma, which is how most of continental Europe writes an amount and is not how EN 16931 writes one: every monetary amount in both syntaxes is an xs:decimal, and xs:decimal has exactly one decimal separator, the dot. " : ""}The value was left out of the invoice rather than guessed at, so nothing further compares it — BR-CO-15 and BR-CO-16 need a number on both sides. This is a finding of ours, not a rule of the regulation: the official validator rejects the same document one step earlier, at XML Schema validation, as cvc-datatype-valid.1.2.1.`,
          fix: comma
            ? `Write the amount with a dot decimal separator and no thousands separator: ${JSON.stringify(seen.replace(/\./g, "").replace(",", "."))} rather than ${JSON.stringify(seen)}. Formatting for a human reader belongs in the rendered invoice, never in the XML.`
            : defect.state === "empty"
              ? `Give the element a value, or remove it. An empty element is not a zero — if the amount really is zero, write 0.00; if the figure is unknown at issuing time, the document is not ready to be sent.`
              : `Write the amount as a plain decimal number — digits, an optional leading minus, and at most one dot. No currency symbol, no thousands separator, no spaces; the currency is carried by @currencyID (UBL) or by BT-5 (CII), not by the amount.`,
          example: `<${element}>1891.79</${element}>`,
          xpath: defect.xpath,
          docsUrl: LIMITS_DOCS,
        }),
      );
    }
    return out;
  },

  // --- BR-DEC-*, on the value the DOCUMENT serialised ----------------------
  //
  // The gap this closes was found by the benchmark's own adversarial corpus
  // (adv-huge-decimal-precision.xml, 2026-08-16): a line net amount written
  // `1500.000000` — six decimal places, numerically identical to 1500.00, every
  // total still balancing. The CEN schematron rejects it under BR-DEC-23 and
  // UBL-DT-01. We reported nothing, because by the time any rule ran the value
  // was a JavaScript number and `1500.000000` and `1500` are the same double.
  //
  // The BR-DEC family is a LEXICAL family. It measures
  // `string-length(substring-after(., '.'))` on the text in the XML, so a
  // reader that keeps only the parsed number has thrown away the one thing the
  // rule looks at. The two parsers now count the digits at the point of
  // reading, into `declaredTotals.overPrecise`, and this reports them.
  //
  // The rule ids are the ones this build already ships, mapped by business
  // term. A term with no id here — BT-111, BT-113, BT-114 — records nothing
  // rather than borrowing a neighbour's id: a confidently wrong rule id sends
  // the reader to the wrong page of the standard, and is worse than silence
  // that the CHANGELOG names.
  (inv) => {
    const raw = inv.declaredTotals?.overPrecise;
    if (!Array.isArray(raw)) return null;
    const out: TeachingError[] = [];
    for (const entry of raw) {
      // Defensive for the same reason `usableDefects` is: `DeclaredTotals` is a
      // public type and the JSON surfaces hand `validateInput` whatever was
      // posted. A malformed entry is ignored, never thrown on.
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const spec = LEXICAL_SPECS[String(entry.field)];
      if (!spec) continue;
      const decimals = entry.decimals;
      if (typeof decimals !== "number" || !Number.isFinite(decimals) || decimals <= 2) {
        continue;
      }
      const text = typeof entry.text === "string" ? entry.text : "";
      const where =
        typeof entry.line === "number"
          ? ` on line ${entry.line}`
          : typeof entry.group === "number"
            ? ` in VAT breakdown group ${entry.group}`
            : "";
      out.push(
        err({
          rule: spec.rule,
          field: entry.field,
          severity: "fatal",
          message: `The allowed maximum number of decimals for the ${spec.label} (${entry.field}) is 2, but the document writes${where} ${JSON.stringify(text)}, which has ${decimals}. BR-DEC rules are measured on the serialised value, not on the number behind it: trailing zeros count, so ${JSON.stringify(text)} fails even though it is arithmetically identical to a two-decimal amount and every total in the document still balances. ${spec.why}`,
          fix: `Serialise the amount with exactly two decimal places. This is almost always a formatting setting rather than a data problem — a ledger or ORM emitting its native decimal scale (six places is the usual default) straight into the XML. Fixing it at the point of serialisation fixes every amount in the document at once.`,
          example: `<${(typeof entry.xpath === "string" ? entry.xpath : "").split("/").pop() || "Amount"}>${text.split(".")[0] ?? "0"}.00</${(typeof entry.xpath === "string" ? entry.xpath : "").split("/").pop() || "Amount"}>`,
          xpath: typeof entry.xpath === "string" ? entry.xpath : spec.xpath,
          docsUrl: `${DOCS}/${spec.rule}`,
        }),
      );
    }
    return out;
  },

  (inv) => {
    const declared = inv.declaredTotals;
    if (!declared) return null;
    // A term already reported from its serialised form is not reported again
    // from its parsed value: same defect, same rule id, two findings.
    const alreadyLexical = new Set(
      (Array.isArray(declared.overPrecise) ? declared.overPrecise : [])
        .map((entry) => (entry && typeof entry === "object" ? String(entry.field) : ""))
        .filter(Boolean),
    );
    const out: TeachingError[] = [];
    for (const spec of DEC_SPECS) {
      if (alreadyLexical.has(spec.field)) continue;
      const value = declared[spec.key];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const places = decimalPlaces(value);
      if (places <= 2) continue;
      const rounded = Math.round(value * 100) / 100;
      out.push(
        err({
          rule: spec.rule,
          field: spec.field,
          severity: "fatal",
          message: `The allowed maximum number of decimals for the ${spec.label} (${spec.field}) is 2, but you declared ${value}, which has ${places}. The rule is written against the serialised value — the schematron measures the digits after the decimal point in the XML — so a value that merely *displays* as two decimals still fails if the underlying number carries more. ${spec.why}`,
          fix: `Round declaredTotals.${String(spec.key)} to two decimals before assigning it (${rounded.toFixed(2)} here), using half-up rounding away from zero. This package exports round2() for exactly this, and it avoids the two JavaScript traps: Math.round(1.005 * 100) / 100 gives 1.00, and (2.675).toFixed(2) gives "2.67". Alternatively drop declaredTotals and let the library compute the totals, which it always rounds correctly.`,
          example: `"declaredTotals": { "${String(spec.key)}": ${rounded.toFixed(2)} }`,
          xpath: spec.xpath,
          docsUrl: `${DOCS}/${spec.rule}`,
        }),
      );
    }
    return out;
  },
];
