/**
 * Minimal XML builder. Deliberately hand-rolled: this package ships with zero
 * runtime dependencies, and UBL only needs elements, attributes and text.
 *
 * UBL 2.1 documents are validated against a *sequence* content model, so
 * element order is part of correctness — the callers in `generate.ts` emit
 * children in schema order and this module never reorders anything.
 */

export type Attrs = Record<string, string | number | undefined>;

/** Escape text content. `>` is escaped too, so `]]>` can never appear by accident. */
export function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape an attribute value: text escaping plus both quote styles. */
export function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Strip characters that are not legal in XML 1.0 at all (control characters
 * other than tab/LF/CR). These cannot be escaped — they must be removed, or the
 * document is not well-formed no matter how it is encoded.
 */
export function stripInvalidXmlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, "");
}

function renderAttrs(attrs?: Attrs): string {
  if (!attrs) return "";
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => ` ${k}="${escapeAttr(stripInvalidXmlChars(String(v)))}"`)
    .join("");
}

export interface XmlNode {
  render(indent: string, level: number): string;
}

/** A leaf element with text content. Returns null-ish nodes for absent values. */
export function el(
  name: string,
  value: string | number | undefined | null,
  attrs?: Attrs,
): XmlNode | null {
  if (value === undefined || value === null) return null;
  const text = escapeText(stripInvalidXmlChars(String(value)));
  return {
    render(indent, level) {
      const pad = indent.repeat(level);
      return `${pad}<${name}${renderAttrs(attrs)}>${text}</${name}>`;
    },
  };
}

/** A container element. Emits nothing when it has no non-null children. */
export function group(
  name: string,
  children: (XmlNode | null | undefined)[],
  attrs?: Attrs,
): XmlNode | null {
  const kept = children.filter((c): c is XmlNode => Boolean(c));
  if (kept.length === 0) return null;
  return {
    render(indent, level) {
      const pad = indent.repeat(level);
      const inner = kept.map((c) => c.render(indent, level + 1)).join("\n");
      return `${pad}<${name}${renderAttrs(attrs)}>\n${inner}\n${pad}</${name}>`;
    },
  };
}

/** Like `group`, but kept even when empty — for elements whose presence is the signal. */
export function groupAlways(
  name: string,
  children: (XmlNode | null | undefined)[],
  attrs?: Attrs,
): XmlNode {
  const kept = children.filter((c): c is XmlNode => Boolean(c));
  return {
    render(indent, level) {
      const pad = indent.repeat(level);
      if (kept.length === 0) return `${pad}<${name}${renderAttrs(attrs)}/>`;
      const inner = kept.map((c) => c.render(indent, level + 1)).join("\n");
      return `${pad}<${name}${renderAttrs(attrs)}>\n${inner}\n${pad}</${name}>`;
    },
  };
}

/** Serialise a root node into a complete document with XML declaration. */
export function document(root: XmlNode, indent = "  "): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${root.render(indent, 0)}\n`;
}
