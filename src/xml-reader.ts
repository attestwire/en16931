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

  /** First matching child element, marked as read — for attribute access. */
  leafEl(
    parent: XmlElement,
    namespace: string,
    local: string,
  ): XmlElement | undefined {
    this.visited.add(parent);
    const el = firstChild(parent, namespace, local);
    if (el) this.consumed.add(el);
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
    for (const el of found) this.consumed.add(el);
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
    const el = this.leafEl(parent, namespace, local);
    if (!el) return undefined;
    const raw = el.text.trim();
    if (raw === "") return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      this.note(
        el,
        "unknown",
        `"${raw.slice(0, 40)}" is not a number, so this value was left out of the ` +
          `invoice rather than guessed at.`,
      );
      return undefined;
    }
    return value;
  }

  /** Walk the tree and report every element nobody claimed. */
  sweep(root: XmlElement): void {
    const walk = (el: XmlElement): void => {
      if (!this.visited.has(el)) return;
      for (const child of el.children) {
        if (this.consumed.has(child)) continue;
        if (this.visited.has(child)) {
          walk(child);
          continue;
        }
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
