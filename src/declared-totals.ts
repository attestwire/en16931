/**
 * The document totals as the *document* states them, and what to do when one of
 * them is not there.
 *
 * WHY THIS MODULE EXISTS. Both parsers used to read the monetary total block
 * with a line of the form `set(declared, "payableAmount", r.num(block, …))`,
 * and `set` skips `undefined`. That is exactly right for a value the model
 * derives and wrong for a value the document is *required* to state: an element
 * that was absent, empty, or written `12,34` produced no declared total, and a
 * rule cannot fire on a field that is not there. The document validated
 * `valid: true` with zero findings while KoSIT rejected the same file — under
 * `BR-12` for an absent BT-106, and under `cvc-datatype-valid.1.2.1` for
 * anything the XML Schema cannot read as a decimal (see the matrix in
 * `scripts/kosit-check.md`).
 *
 * So the readers now record the *absence* as a fact. `DeclaredTotals.defects`
 * carries one entry per total that did not arrive as a number, with which term
 * it was, why it did not arrive, and the exact text if there was any — and two
 * rules read that array: `BR-12`/`BR-13`/`BR-14`/`BR-15` in `rules-core.ts` for
 * the four mandatory terms, and `ATW-DECLARED-TOTAL-NOT-A-NUMBER` in
 * `rules-decimals.ts` for text no reader can turn into a number.
 *
 * NOTHING HERE CHANGES THE JSON PATH. A caller building an `InvoiceInput` by
 * hand never produces a defect — omitting `declaredTotals.payableAmount` means
 * "compute it for me", which is the whole point of the model, and the library
 * still does. Only a reader that has seen a document knows the difference
 * between "I did not supply this" and "the document does not contain it", and
 * only a reader writes this array.
 *
 * Term table and mandatory/optional split from EN 16931 and the two syntax
 * bindings; rule texts from `ubl/schematron/abstract/EN16931-model.sch`,
 * ConnectingEurope/eInvoicing-EN16931 @ validation-1.3.16.
 */

import type {
  DeclaredTotalDefect,
  DeclaredTotalKey,
  DeclaredTotalState,
  DeclaredTotals,
} from "./types.js";
import { TreeReader } from "./xml-reader.js";
import type { XmlElement } from "./xml-parse.js";

export interface DeclaredTotalTerm {
  key: DeclaredTotalKey;
  field: `BT-${number}`;
  /** The term's name in EN 16931, for a message a human reads. */
  label: string;
  /**
   * The presence rule, when EN 16931 makes the term mandatory. BT-107 and
   * BT-108 have none: a document with no allowances states no allowance total,
   * and that is correct rather than missing.
   */
  presenceRule?: "BR-12" | "BR-13" | "BR-14" | "BR-15";
  /** Local name inside `cac:LegalMonetaryTotal`. */
  ubl: string;
  /** Local name inside `ram:SpecifiedTradeSettlementHeaderMonetarySummation`. */
  cii: string;
  /** Why this figure matters, for the presence rule's message. */
  why: string;
}

/**
 * The six totals both monetary total blocks carry, in UBL document order.
 *
 * BT-113 (prepaid) and BT-114 (rounding) live in the same block and are NOT
 * here: they land on `invoice.paidAmount` / `invoice.roundingAmount`, are
 * optional in both syntaxes, and an unreadable one is still only reported as an
 * `unmapped` note. That is a narrower version of the same gap and it is named
 * in the CHANGELOG rather than quietly widened here.
 */
export const DECLARED_TOTAL_TERMS: DeclaredTotalTerm[] = [
  {
    key: "lineExtensionAmount",
    field: "BT-106",
    label: "Sum of Invoice line net amounts",
    presenceRule: "BR-12",
    ubl: "LineExtensionAmount",
    cii: "LineTotalAmount",
    why: "It is the anchor the rest of the totals are derived from: BT-109 starts here, and BR-CO-10 checks it against the lines.",
  },
  {
    key: "taxExclusiveAmount",
    field: "BT-109",
    label: "Invoice total amount without VAT",
    presenceRule: "BR-13",
    ubl: "TaxExclusiveAmount",
    cii: "TaxBasisTotalAmount",
    why: "It is the figure the buyer books as expenditure, separately from the VAT they may reclaim.",
  },
  {
    key: "taxInclusiveAmount",
    field: "BT-112",
    label: "Invoice total amount with VAT",
    presenceRule: "BR-14",
    ubl: "TaxInclusiveAmount",
    cii: "GrandTotalAmount",
    why: "It is the gross value of the supply, and BR-CO-15 ties it to BT-109 + BT-110.",
  },
  {
    key: "allowanceTotalAmount",
    field: "BT-107",
    label: "Sum of allowances on document level",
    ubl: "AllowanceTotalAmount",
    cii: "AllowanceTotalAmount",
    why: "It is optional: a document with no document-level allowance states no allowance total.",
  },
  {
    key: "chargeTotalAmount",
    field: "BT-108",
    label: "Sum of charges on document level",
    ubl: "ChargeTotalAmount",
    cii: "ChargeTotalAmount",
    why: "It is optional: a document with no document-level charge states no charge total.",
  },
  {
    key: "payableAmount",
    field: "BT-115",
    label: "Amount due for payment",
    presenceRule: "BR-15",
    ubl: "PayableAmount",
    cii: "DuePayableAmount",
    why: "It is the only figure on the document that says what to actually pay — it differs from BT-112 whenever a prepayment (BT-113) or a rounding amount (BT-114) applies.",
  },
];

/** The term for a declared total, by model key. */
export function declaredTotalTerm(
  key: DeclaredTotalKey,
): DeclaredTotalTerm | undefined {
  return DECLARED_TOTAL_TERMS.find((t) => t.key === key);
}

/** The longest text a defect will carry into a message. */
const MAX_DEFECT_TEXT = 200;

/** The three states a defect may be in. Anything else is not one of ours. */
const DEFECT_STATES = new Set<DeclaredTotalState>([
  "absent",
  "empty",
  "unreadable",
]);

/** A defect that has been checked, with the term it names resolved. */
export interface UsableDefect {
  defect: DeclaredTotalDefect;
  term: DeclaredTotalTerm;
  /** `defect.text`, truncated here as well as in the reader. */
  text: string;
  /** The last step of the XPath, or the term's UBL element name. */
  element: string;
}

/**
 * The defects a rule may act on, from an `InvoiceInput` that may be anything.
 *
 * WHY THIS IS DEFENSIVE AND NOT TRUSTING. `declaredTotals.defects` is written
 * by the two readers and documented as theirs, but `InvoiceInput` is a public
 * type and the JSON surfaces — `POST /v1/validate` with a JSON body, the MCP
 * `validate_invoice` tool — will hand `validateInput` whatever the caller
 * posted. Reading `defect.state` off a `null`, iterating a `defects` that is an
 * object with a `length`, or calling `.split()` on an absent `xpath` all threw a
 * `TypeError` out of `validateInput`, which is a 500 on a validation endpoint —
 * and this library's standing policy, written on `ATW-DECLARED-TOTAL-NOT-FINITE`
 * two rules down, is that bad input produces a finding rather than an
 * exception. A crash is the one answer a validator must never give.
 *
 * MALFORMED ENTRIES ARE IGNORED RATHER THAN REPORTED, and that is a decision
 * worth stating. The alternative was a finding of its own, which would follow
 * the NOT-FINITE precedent — but `NaN` in `payableAmount` is a plausible
 * accident of real arithmetic upstream, while a `defects` array with a `null` in
 * it is not something any pipeline produces: the field is parser-written, and
 * only a caller hand-building the model can get it wrong. The deciding argument
 * is consistency inside one field: an unrecognised `state` has to be ignored
 * (there is nothing true to say about `"banana"`), so a missing `key` and a
 * `null` entry are ignored too. One rule for the whole field, no rule id for a
 * mistake no invoice can make.
 *
 * What is checked, in order: the array itself, each entry being a plain object,
 * the state being one of the three, and the key naming a term this build knows.
 * `field` is deliberately NOT trusted — the term's own `field` is used, so a
 * hand-written `{ key: "payableAmount", field: "BT-999" }` cannot put a wrong
 * business term into a message. Duplicates are dropped, first entry wins: a
 * term is in exactly one state, the readers write each one once, and two
 * findings for one figure would read as the engine contradicting itself.
 */
export function usableDefects(
  declared: { defects?: unknown } | undefined,
): UsableDefect[] {
  const raw = declared?.defects;
  if (!Array.isArray(raw)) return [];
  const out: UsableDefect[] = [];
  const seen = new Set<DeclaredTotalKey>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const defect = entry as Partial<DeclaredTotalDefect>;
    if (
      typeof defect.state !== "string" ||
      !DEFECT_STATES.has(defect.state as DeclaredTotalState)
    ) {
      continue;
    }
    if (typeof defect.key !== "string") continue;
    const term = declaredTotalTerm(defect.key);
    if (!term || seen.has(term.key)) continue;
    seen.add(term.key);
    const xpath = typeof defect.xpath === "string" ? defect.xpath : "";
    const text =
      typeof defect.text === "string" ? defect.text.slice(0, MAX_DEFECT_TEXT) : "";
    out.push({
      defect: {
        key: term.key,
        field: term.field,
        state: defect.state as DeclaredTotalState,
        ...(text !== "" ? { text } : {}),
        xpath,
      },
      term,
      text,
      element: xpath.split("/").pop() || term.ubl,
    });
  }
  return out;
}

/**
 * Read one declared total out of a monetary total block, recording what went
 * wrong when it does not come back as a number.
 *
 * The three failures are kept apart because they are three different mistakes,
 * and the official validator treats them as two different *steps*: an absent
 * element reaches the schematron and fails a BR-* presence rule, while an empty
 * or unreadable one fails XML Schema validation first and never gets that far.
 *
 * The element is also noted as `unmapped` on the empty and unreadable paths, so
 * the reader's older promise — nothing is dropped silently — is kept for the
 * value as well as for the finding. `TreeReader.number` already did that for
 * unreadable text and not for empty text; this closes that half too.
 */
export function readDeclaredTotal(
  r: TreeReader,
  block: XmlElement | undefined,
  term: DeclaredTotalTerm,
  local: string,
  xpath: string,
  declared: DeclaredTotals,
  defects: DeclaredTotalDefect[],
  namespace: string,
): void {
  const el = block ? r.leafEl(block, namespace, local) : undefined;
  if (!el) {
    // An optional term that is not there is not a defect — it is a document
    // that has nothing to declare.
    if (term.presenceRule) {
      defects.push({ key: term.key, field: term.field, state: "absent", xpath });
    }
    return;
  }
  const raw = el.text.trim();
  if (raw === "") {
    r.note(
      el,
      "unknown",
      `<${el.qname}> is empty, so the ${term.label} (${term.field}) was left out of ` +
        `the invoice rather than read as zero. An empty element is not a zero: XML ` +
        `Schema rejects it as a value of type xs:decimal.`,
    );
    defects.push({ key: term.key, field: term.field, state: "empty", xpath });
    return;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    r.note(
      el,
      "unknown",
      `"${raw.slice(0, 40)}" is not a number, so this value was left out of the ` +
        `invoice rather than guessed at.`,
    );
    defects.push({
      key: term.key,
      field: term.field,
      state: "unreadable",
      text: raw.slice(0, 200),
      xpath,
    });
    return;
  }
  declared[term.key] = value;
}
