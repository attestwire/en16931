/**
 * Bookkeeping shared by the two document readers.
 *
 * `parse.ts` (UBL) and `parse-cii.ts` (CII) walk completely different element
 * vocabularies, but they owe the caller the same promise: **nothing is dropped
 * silently**. That promise is this class. It records which elements were read
 * into the model, which containers were walked into, and — at the end — reports
 * every element nobody claimed.
 *
 * It does no XML parsing of its own. Both readers get their tree from
 * `parseXml` in `xml-parse.ts`, which is the one hardened parser in this
 * package and the only place the security limits live.
 */

import { childrenNamed, firstChild, type XmlElement } from "./xml-parse.js";

/**
 * Something in the document that did not reach the invoice object.
 *
 * `kind` separates the two very different reasons for that:
 *   - `"unknown"` — this parser has no field for the element. Its content is
 *     gone from the model. If it mattered, you must handle it yourself.
 *   - `"recomputed"` — the element is understood, but the model derives the
 *     value rather than storing it (line net amounts, the VAT breakdown). The
 *     information is not lost; it is regenerated from the lines.
 */
export interface UnmappedElement {
  /** Path from the root, e.g. `/ubl:Invoice/cac:Delivery/cbc:TrackingID`. */
  path: string;
  /** Qualified name exactly as the document writes it. */
  name: string;
  /** Namespace URI of the element. */
  namespace: string;
  kind: "unknown" | "recomputed";
  reason: string;
  /** Text content, when the element has no children. Truncated to 200 characters. */
  text?: string;
}

/**
 * The lexical space of `xs:decimal`, as XML Schema Part 2 writes it:
 * `(\+|-)?([0-9]+(\.[0-9]*)?|\.[0-9]+)`.
 *
 * `12.` and `.5` really are valid — the fractional part may be empty on either
 * side of the dot, though only one side at a time — so they are accepted here
 * and turned into 12 and 0.5. An exponent is not; nor is a hex or binary
 * prefix, a leading `0o`, `Infinity`, `NaN`, a thousands separator, or a space
 * anywhere inside the value.
 */
const XS_DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Text from a document → a number, but only for text `xs:decimal` accepts.
 *
 * WHY NOT `Number()`. Every monetary amount, quantity, percentage and factor in
 * both EN 16931 syntaxes is typed `xs:decimal` in the XSD, and JavaScript's
 * `Number()` reads a strictly larger set of strings than that type does:
 * `Number("1e2")` is 100, `Number("0x1F")` is 31, `Number("0b101")` is 5,
 * `Number("Infinity")` is infinite, and `Number("")` is 0. None of those five
 * documents survives XML Schema validation — KoSIT rejects each of them as
 * `cvc-datatype-valid.1.2.1`, before a single schematron rule is evaluated —
 * so reading the value anyway produced the worst answer a validator can give:
 * clean arithmetic, `valid: true`, on a file the authority refuses. A value
 * this function turns down is left out of the model and reported, which lands
 * the document on the same side of the verdict as the official tool.
 *
 * A lexically valid decimal too large for a double (309 digits and up) is also
 * turned down. It is a real `xs:decimal` and XML Schema is happy with it, but
 * this library's arithmetic is IEEE-754 and `Infinity` would poison every total
 * it touches; refusing it is the honest failure, and `decimalRejectionReason`
 * says which of the two things went wrong.
 */
export function parseXsDecimal(raw: string): number | undefined {
  if (!XS_DECIMAL.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * How many digits an xs:decimal lexical form carries after the decimal point.
 *
 * ⚠ TRAILING ZEROS COUNT, and that is not an oversight. The BR-DEC rules test
 * `string-length(substring-after(., '.')) <= 2` on the serialised text, so
 * `1500.000000` is six decimals to the regulator even though it is numerically
 * identical to `1500`. Counting the "significant" decimals instead would make
 * the rule unable to fire on the one document shape it exists to catch — a
 * ledger that serialises everything at six places — which is exactly the
 * silent-accept our own benchmark corpus probes with
 * `adv-huge-decimal-precision.xml`.
 *
 * The value is expected to already be in the xs:decimal lexical space (no
 * exponent, one dot at most); a sign is skipped and anything else is measured
 * as written.
 */
export function countLexicalDecimals(lexical: string): number {
  const text = lexical.trim().replace(/^[+-]/, "");
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * Why `parseXsDecimal` turned this text down, in words for the person who wrote
 * the document.
 *
 * Three different mistakes, and the middle one is the reason this exists rather
 * than a single sentence: `1e2` and `0x1F` are numbers to JavaScript and not to
 * XML Schema, so "is not a number" would read as wrong to anyone who pasted the
 * value into a console. It is not that the text means nothing — it is that it
 * means nothing *here*, and the reader has to say which.
 *
 * It stops at the diagnosis and never says what was done about it. What was
 * done differs by call site — a total is left out, a quantity falls back to 0 —
 * so each one appends its own sentence, and none of them ends up claiming both.
 */
export function decimalRejectionReason(raw: string): string {
  const seen = JSON.stringify(raw.slice(0, 40));
  if (XS_DECIMAL.test(raw)) {
    return (
      `${seen} is a valid xs:decimal, but it has more digits than a 64-bit ` +
      `floating-point number can hold, so it would arrive as Infinity and poison every ` +
      `total computed from it.`
    );
  }
  if (Number.isFinite(Number(raw))) {
    return (
      `${seen} is not a valid xs:decimal. JavaScript would read it as ` +
      `${String(Number(raw))}, but XML Schema would not: an xs:decimal is an optional ` +
      `sign, digits, and at most one dot — no exponent, no 0x or 0b prefix, no ` +
      `Infinity. The official validator rejects this document at the XML Schema step ` +
      `as cvc-datatype-valid.1.2.1, so reading the value anyway would report clean ` +
      `arithmetic on a file the authority refuses.`
    );
  }
  return `${seen} is not a number.`;
}

/** The sentence every value-reading site appends when it turns a value down. */
export const VALUE_LEFT_OUT =
  "The value was left out of the invoice rather than guessed at.";

export class TreeReader {
  readonly unmapped: UnmappedElement[] = [];
  private readonly consumed = new WeakSet<XmlElement>();
  private readonly visited = new WeakSet<XmlElement>();

  /** Mark a container as walked into; its leftover children get reported. */
  enter<T extends XmlElement | undefined>(el: T): T {
    if (el) this.visited.add(el);
    return el;
  }

  /** Mark an element as read into the model. */
  use(el: XmlElement): XmlElement {
    this.consumed.add(el);
    return el;
  }

  /** Record an element as not carried over, and stop it being reported twice. */
  note(el: XmlElement, kind: UnmappedElement["kind"], reason: string): void {
    this.consumed.add(el);
    this.unmapped.push({
      path: el.path,
      name: el.qname,
      namespace: el.namespace,
      kind,
      reason,
      ...(el.children.length === 0 && el.text !== ""
        ? { text: el.text.slice(0, 200) }
        : {}),
    });
  }

  /**
   * A leaf that turns out to hold child elements.
   *
   * `el.text` is `""` for any element with children — `parseXml` refuses mixed
   * content and leaves a container's text empty — so reading such an element as
   * a value yields an empty string *and* loses everything inside it. Marking it
   * consumed used to stop `sweep` from ever mentioning the content:
   * `<ram:ID><x:real>2026-000142</x:real></ram:ID>` produced
   * `invoiceNumber === ""` with `x:real` reported nowhere, which is precisely
   * the "nothing is dropped silently" promise this class exists to keep.
   *
   * It is now reported twice over: once for the container, saying the value
   * came back empty, and once per child through the ordinary sweep.
   */
  private noteContainerReadAsLeaf(el: XmlElement): void {
    this.visited.add(el);
    this.unmapped.push({
      path: el.path,
      name: el.qname,
      namespace: el.namespace,
      kind: "unknown",
      reason:
        `<${el.qname}> was read as a text value, but it contains ${el.children.length} ` +
        `child element(s). An element with children has no text of its own, so the ` +
        `value read from it is empty. Neither EN 16931 syntax nests elements here; the ` +
        `content below is listed separately.`,
    });
  }

  /** First matching child element, marked as read — for attribute access. */
  leafEl(
    parent: XmlElement,
    namespace: string,
    local: string,
  ): XmlElement | undefined {
    this.visited.add(parent);
    const el = firstChild(parent, namespace, local);
    if (el) {
      this.consumed.add(el);
      if (el.children.length > 0) this.noteContainerReadAsLeaf(el);
    }
    return el;
  }

  /** Text of the first matching child, marked as read. Verbatim. */
  leaf(
    parent: XmlElement,
    namespace: string,
    local: string,
  ): string | undefined {
    return this.leafEl(parent, namespace, local)?.text;
  }

  /** Every matching child, each marked as read. */
  leafAll(
    parent: XmlElement,
    namespace: string,
    local: string,
  ): XmlElement[] {
    this.visited.add(parent);
    const found = childrenNamed(parent, namespace, local);
    for (const el of found) {
      this.consumed.add(el);
      if (el.children.length > 0) this.noteContainerReadAsLeaf(el);
    }
    return found;
  }

  /** First matching child, marked as walked into rather than read. */
  group(
    parent: XmlElement,
    namespace: string,
    local: string,
  ): XmlElement | undefined {
    this.visited.add(parent);
    const el = firstChild(parent, namespace, local);
    if (el) this.visited.add(el);
    return el;
  }

  /** Every matching child, each marked as walked into. */
  groupAll(
    parent: XmlElement,
    namespace: string,
    local: string,
  ): XmlElement[] {
    this.visited.add(parent);
    const found = childrenNamed(parent, namespace, local);
    for (const el of found) this.visited.add(el);
    return found;
  }

  /** A number, or `undefined` — an unreadable one is reported, never guessed. */
  number(
    parent: XmlElement,
    namespace: string,
    local: string,
  ): number | undefined {
    return this.numberAt(parent, namespace, local)?.value;
  }

  /**
   * The same read, with the document's own lexical form kept beside the value.
   *
   * The BR-DEC family is written against the *serialised* decimal —
   * `string-length(substring-after(., '.')) <= 2` — and a number cannot answer
   * that question. `1500.000000` and `1500` parse to the identical double, so
   * every caller that went through {@link number} lost the only evidence the
   * rule cares about, and a line net amount written with six decimal places
   * validated clean here while the CEN schematron rejected it under BR-DEC-23.
   * Callers that map an element to a business term with a BR-DEC rule use this
   * and record {@link countLexicalDecimals} of `lexical`.
   */
  numberAt(
    parent: XmlElement,
    namespace: string,
    local: string,
  ): { value: number; lexical: string; xpath: string } | undefined {
    const el = this.leafEl(parent, namespace, local);
    if (!el) return undefined;
    const raw = el.text.trim();
    if (raw === "") return undefined;
    // Trimmed, then measured against the xs:decimal lexical space rather than
    // handed to Number(). XML whitespace around a value is collapsed away by
    // the schema processor too, so the trim is faithful; everything inside the
    // value is not, and `1e2` or `0x1F` reaching the model was a silent
    // false-valid path. See `parseXsDecimal`.
    const value = parseXsDecimal(raw);
    if (value === undefined) {
      this.note(el, "unknown", `${decimalRejectionReason(raw)} ${VALUE_LEFT_OUT}`);
      return undefined;
    }
    return { value, lexical: raw, xpath: el.path };
  }

  /** Walk the tree and report every element nobody claimed. */
  sweep(root: XmlElement): void {
    const walk = (el: XmlElement): void => {
      if (!this.visited.has(el)) return;
      for (const child of el.children) {
        // `visited` is checked BEFORE `consumed`, so an element that is both —
        // a leaf read for its text that turned out to have children — still
        // gets walked into. The other order hid that content completely.
        if (this.visited.has(child)) {
          walk(child);
          continue;
        }
        if (this.consumed.has(child)) continue;
        this.unmapped.push({
          path: child.path,
          name: child.qname,
          namespace: child.namespace,
          kind: "unknown",
          reason:
            "This parser has no field for this element, so neither it nor anything " +
            "inside it reached the invoice object.",
          ...(child.children.length === 0 && child.text !== ""
            ? { text: child.text.slice(0, 200) }
            : {}),
        });
      }
    };
    walk(root);
  }
}

/** Drop a key rather than setting it to undefined, so objects stay comparable. */
export function set<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}
