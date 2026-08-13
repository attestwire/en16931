/**
 * Minimal, hardened XML reader for the UBL subset.
 *
 * This package ships with zero runtime dependencies, so it cannot pull in a
 * general XML parser — and it should not want to. A general parser accepts far
 * more than UBL needs (DTDs, entities, mixed content, notations), and every one
 * of those features is an attack surface when the document comes from a third
 * party.
 *
 * What this reader accepts:
 *   - one root element, with nested elements, attributes and text
 *   - namespace declarations (`xmlns` and `xmlns:prefix`), resolved to URIs
 *   - the five predefined entities (`&amp; &lt; &gt; &quot; &apos;`) and
 *     numeric character references
 *   - CDATA sections, comments and processing instructions
 *
 * What it refuses, loudly:
 *   - any document containing `<!DOCTYPE` or `<!ENTITY`
 *   - any entity reference that is not one of the five predefined ones
 *   - documents deeper, longer or larger than the limits below
 *   - mixed content: an element with both child elements and text
 *
 * Refusing is deliberate. A parser that guesses at a construct it does not
 * understand produces a wrong invoice, and a wrong invoice is a tax problem.
 */

/** Base class for every failure this reader and the UBL mapper raise. */
export class ParseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The document is not well-formed XML, or uses a construct outside the subset. */
export class XmlSyntaxError extends ParseError {}

/**
 * The document tripped one of the limits that exist to stop a hostile file
 * from exhausting memory or CPU. Never a comment on the invoice itself.
 */
export class XmlSecurityError extends ParseError {}

/** Limits applied to every parse. All are caller-overridable. */
export interface XmlLimits {
  /**
   * Maximum length of the input, in characters (UTF-16 code units).
   *
   * Stops a very large upload from being turned into an even larger object
   * graph before anything can reject it. The number is chosen from measured
   * retained memory, not from the input size: every element in the tree costs
   * roughly 250–400 bytes retained (the `XmlElement` object, its `qname`,
   * `local`, `namespace` and `path` strings, its attribute array, and its
   * children array), and the smallest element that can appear in a document is
   * four characters (`<x/>`). A document at the cap can therefore hold on the
   * order of 100,000 elements and retain roughly 25–40 MB.
   *
   * The earlier default of 10,000,000 was measured, on Node 22, to retain
   * about 81 MB of heap and about 306 MB of RSS for a document made entirely
   * of legal elements — well over the 128 MB a Cloudflare Workers isolate is
   * allowed, so a single such request would be killed rather than rejected.
   * A 785 KB body already retained about 47 MB.
   *
   * 400,000 characters is still far above any real invoice: the largest
   * fixture in this repository is under 10 KB, and an invoice with a thousand
   * line items lands around 300 KB. Raise it deliberately, with the memory
   * arithmetic above in mind, if you must parse something larger.
   */
  maxCharacters: number;
  /**
   * Maximum element nesting depth.
   *
   * Stops the "deeply nested elements" denial of service, where a file of a
   * few kilobytes holds hundreds of thousands of open tags. UBL 2.1 invoices
   * nest about eight levels deep; 100 leaves room for an unusual document and
   * still fails long before any stack or allocator does.
   */
  maxDepth: number;
  /**
   * Maximum number of elements in the document.
   *
   * A second, independent ceiling: a flat document of millions of tiny
   * elements passes both the size and the depth check but still builds an
   * object per element. At roughly 250–400 bytes retained per element, 50,000
   * elements is about 12–20 MB — comfortable inside a 128 MB isolate, and far
   * more than an invoice needs (a UBL line item is about twenty elements, so
   * this is a thousand-line invoice with room to spare).
   */
  maxElements: number;
  /**
   * Maximum number of attributes on a single element.
   *
   * Namespace declarations are attributes, and each one enters the in-scope
   * namespace map. Without a cap, a root element carrying tens of thousands of
   * `xmlns:` declarations builds a map that every descendant lookup walks.
   * A UBL or CII root declares under a dozen; 256 is generous.
   */
  maxAttributes: number;
}

export const DEFAULT_XML_LIMITS: XmlLimits = {
  maxCharacters: 400_000,
  maxDepth: 100,
  maxElements: 50_000,
  maxAttributes: 256,
};

export interface XmlAttribute {
  /**
   * Namespace URI. Empty for an unprefixed attribute: unlike elements,
   * unprefixed attributes are never in the default namespace.
   */
  namespace: string;
  local: string;
  /** The name exactly as written, prefix included. */
  qname: string;
  value: string;
}

export interface XmlElement {
  /** Namespace URI, resolved from the prefix (or the default declaration). */
  namespace: string;
  /** Local name, prefix stripped. */
  local: string;
  /** The name exactly as written, prefix included. */
  qname: string;
  /** Path from the root, with a `[n]` index on repeated siblings. */
  path: string;
  attributes: XmlAttribute[];
  children: XmlElement[];
  /**
   * Text content, verbatim and entity-decoded. Only meaningful for an element
   * with no children — mixed content is rejected, and for a container this is
   * the (ignored) whitespace between its children.
   */
  text: string;
}

/** Attribute lookup by namespace and local name. */
export function attr(
  el: XmlElement,
  local: string,
  namespace = "",
): string | undefined {
  for (const a of el.attributes) {
    if (a.local === local && a.namespace === namespace) return a.value;
  }
  return undefined;
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9._\-]/;

/**
 * Characters XML 1.0 does not permit at all. They cannot be escaped, so a
 * document containing one is not well-formed however it was produced. Checked
 * on decoded text and attribute values, which is also where a numeric
 * character reference to a control character would land.
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/;

const XMLNS_URI = "http://www.w3.org/2000/xmlns/";
const XML_URI = "http://www.w3.org/XML/1998/namespace";

interface Frame {
  el: XmlElement;
  /**
   * prefix → namespace URI, with "" holding the default namespace.
   *
   * Null-prototype, and chained to the parent's map with `Object.create`
   * rather than copied. Chaining keeps declaring a prefix O(1) instead of
   * O(declarations in scope); the null root keeps `Object.prototype` members
   * (`constructor`, `toString`, …) from resolving as if they were declared
   * namespace prefixes.
   */
  nsMap: Record<string, string>;
  /**
   * qname → number of children seen so far with that name, so the `[n]` path
   * index is O(1) per element instead of a rescan of every sibling.
   */
  counts: Map<string, number>;
  text: string[];
}

/** A namespace map with no prototype at all — see {@link Frame.nsMap}. */
function emptyNsMap(): Record<string, string> {
  const map: Record<string, string> = Object.create(null);
  map[""] = "";
  map["xml"] = XML_URI;
  return map;
}

/**
 * Parse a UBL-shaped XML document into a tree.
 *
 * @throws {XmlSecurityError} on a DOCTYPE, a non-predefined entity, or a
 *   document over any of the limits.
 * @throws {XmlSyntaxError} on anything that is not well-formed, or that uses a
 *   construct outside the accepted subset.
 */
export function parseXml(
  source: string,
  limits: Partial<XmlLimits> = {},
): XmlElement {
  const lim: XmlLimits = { ...DEFAULT_XML_LIMITS, ...limits };

  if (typeof source !== "string") {
    throw new XmlSyntaxError(
      "xml_not_a_string",
      "Expected the XML document as a string.",
    );
  }

  // Defence: input size cap. Refuses a hostile or accidental upload before any
  // allocation, rather than running out of memory building the tree.
  if (source.length > lim.maxCharacters) {
    throw new XmlSecurityError(
      "xml_too_large",
      `The document is ${source.length} characters, over the ${lim.maxCharacters} ` +
        `character limit. Raise it with the maxCharacters option if you really do ` +
        `need to parse a document this size, or check that you are not passing a ` +
        `whole archive where one invoice was expected.`,
    );
  }

  // Defence against XXE and against billion-laughs style entity expansion: no
  // DTD is processed at all, and a document that carries one is refused rather
  // than parsed with the declarations ignored. Ignoring them would silently
  // change the meaning of every entity reference in the body. The check runs on
  // the raw text, so it also fires for a DOCTYPE hidden inside a CDATA section
  // — a false positive we accept, because no invoice needs one.
  const doctypeAt = source.indexOf("<!DOCTYPE");
  if (doctypeAt >= 0) {
    throw new XmlSecurityError(
      "xml_doctype_forbidden",
      "This document contains a DOCTYPE declaration, which this parser refuses to " +
        "process. A DTD can declare external entities (the XXE attack, which reads " +
        "local files or makes network requests) and nested internal entities (the " +
        "billion-laughs attack, which exhausts memory). No EN 16931 invoice needs a " +
        "DOCTYPE. Remove the declaration and parse the document again.",
    );
  }
  const entityAt = source.indexOf("<!ENTITY");
  if (entityAt >= 0) {
    throw new XmlSecurityError(
      "xml_entity_declaration_forbidden",
      "This document declares an XML entity. Custom entities are never expanded by " +
        "this parser, because entity expansion is how the billion-laughs denial of " +
        "service works. Remove the declaration.",
    );
  }

  let i = 0;
  // A byte order mark is legal and invisible; drop it rather than treating it
  // as text before the root element.
  if (source.charCodeAt(0) === 0xfeff) i = 1;

  const stack: Frame[] = [];
  let root: XmlElement | undefined;
  let elementCount = 0;

  const fail = (code: string, message: string): never => {
    throw new XmlSyntaxError(code, `${message} (at character ${i})`);
  };

  const readName = (): string => {
    const start = i;
    if (i >= source.length || !NAME_START.test(source[i]!)) {
      fail("xml_bad_name", "Expected an element or attribute name");
    }
    i += 1;
    let colons = 0;
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === ":") {
        colons += 1;
        if (colons > 1) {
          fail("xml_bad_name", "A qualified name may contain at most one colon");
        }
        i += 1;
        if (i >= source.length || !NAME_START.test(source[i]!)) {
          fail("xml_bad_name", "Expected a local name after the namespace prefix");
        }
        i += 1;
        continue;
      }
      if (!NAME_CHAR.test(ch)) break;
      i += 1;
    }
    return source.slice(start, i);
  };

  const skipSpace = (): void => {
    while (i < source.length && /[\s]/.test(source[i]!)) i += 1;
  };

  const decode = (raw: string, where: string): string => {
    const decoded = raw.includes("&") ? decodeEntities(raw, where) : raw;
    if (ILLEGAL_XML_CHARS.test(decoded)) {
      throw new XmlSyntaxError(
        "xml_illegal_character",
        `${where} contains a control character that XML 1.0 does not permit. ` +
          `Such a character cannot be escaped: the document is not well-formed.`,
      );
    }
    return decoded;
  };

  const current = (): Frame | undefined => stack[stack.length - 1];

  while (i < source.length) {
    const lt = source.indexOf("<", i);

    if (lt < 0) {
      // Trailing text after the last tag.
      const rest = source.slice(i);
      if (rest.trim() !== "") {
        fail("xml_text_outside_root", "Text after the root element");
      }
      break;
    }

    if (lt > i) {
      const raw = source.slice(i, lt);
      const frame = current();
      if (!frame) {
        if (raw.trim() !== "") {
          fail("xml_text_outside_root", "Text outside the root element");
        }
      } else {
        frame.text.push(decode(raw, `The content of <${frame.el.qname}>`));
      }
      i = lt;
    }

    // --- comment ------------------------------------------------------------
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      if (end < 0) fail("xml_unterminated_comment", "Unterminated comment");
      i = end + 3;
      continue;
    }

    // --- CDATA --------------------------------------------------------------
    if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i + 9);
      if (end < 0) fail("xml_unterminated_cdata", "Unterminated CDATA section");
      const frame = current();
      const raw = source.slice(i + 9, end);
      if (!frame) {
        fail("xml_text_outside_root", "CDATA outside the root element");
      } else {
        // No entity decoding inside CDATA — that is what CDATA means.
        if (ILLEGAL_XML_CHARS.test(raw)) {
          throw new XmlSyntaxError(
            "xml_illegal_character",
            "A CDATA section contains a control character that XML 1.0 does not permit.",
          );
        }
        frame.text.push(raw);
      }
      i = end + 3;
      continue;
    }

    // --- processing instruction (including the XML declaration) -------------
    if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i + 2);
      if (end < 0) {
        fail("xml_unterminated_pi", "Unterminated processing instruction");
      }
      // Processing instructions are skipped, never acted on. A stylesheet PI in
      // particular must not cause this library to fetch anything.
      i = end + 2;
      continue;
    }

    // --- other declarations -------------------------------------------------
    if (source.startsWith("<!", i)) {
      fail(
        "xml_unsupported_declaration",
        "Unsupported markup declaration; only comments and CDATA sections are accepted",
      );
    }

    // --- end tag ------------------------------------------------------------
    if (source.startsWith("</", i)) {
      i += 2;
      const qname = readName();
      skipSpace();
      if (source[i] !== ">") fail("xml_bad_end_tag", "Expected '>' to close an end tag");
      i += 1;
      const frame = stack.pop();
      if (!frame) fail("xml_unbalanced", `Stray end tag </${qname}>`);
      if (frame!.el.qname !== qname) {
        fail(
          "xml_unbalanced",
          `End tag </${qname}> does not match the open element <${frame!.el.qname}>`,
        );
      }
      closeFrame(frame!);
      continue;
    }

    // --- start tag ----------------------------------------------------------
    i += 1;
    const qname = readName();

    elementCount += 1;
    // Defence: element-count cap. A flat document of millions of empty
    // elements passes the depth check and can still exhaust memory.
    if (elementCount > lim.maxElements) {
      throw new XmlSecurityError(
        "xml_too_many_elements",
        `The document has more than ${lim.maxElements} elements. Raise the ` +
          `maxElements option if a document this large is genuinely expected.`,
      );
    }

    const parent = current();
    const rawAttrs: { qname: string; value: string }[] = [];
    let selfClosing = false;

    for (;;) {
      skipSpace();
      if (i >= source.length) fail("xml_unterminated_tag", "Unterminated start tag");
      if (source[i] === ">") {
        i += 1;
        break;
      }
      if (source.startsWith("/>", i)) {
        selfClosing = true;
        i += 2;
        break;
      }
      const aname = readName();
      skipSpace();
      if (source[i] !== "=") {
        fail("xml_bad_attribute", `Attribute ${aname} has no value`);
      }
      i += 1;
      skipSpace();
      const quote = source[i];
      if (quote !== '"' && quote !== "'") {
        fail("xml_bad_attribute", `The value of ${aname} is not quoted`);
      }
      const end = source.indexOf(quote!, i + 1);
      if (end < 0) fail("xml_bad_attribute", `Unterminated value for ${aname}`);
      const raw = source.slice(i + 1, end);
      if (raw.includes("<")) {
        fail("xml_bad_attribute", `The value of ${aname} contains an unescaped '<'`);
      }
      rawAttrs.push({ qname: aname, value: decode(raw, `The value of ${aname}`) });
      // Defence: per-element attribute cap. Namespace declarations are
      // attributes, and an element carrying tens of thousands of them builds a
      // namespace map that every descendant lookup has to walk.
      if (rawAttrs.length > lim.maxAttributes) {
        throw new XmlSecurityError(
          "xml_too_many_attributes",
          `<${qname}> carries more than ${lim.maxAttributes} attributes. Raise the ` +
            `maxAttributes option only if a document this unusual is genuinely ` +
            `expected; an EN 16931 element carries a handful.`,
        );
      }
      i = end + 1;
    }

    // Namespace declarations first: an element's own prefix may be declared on
    // the element itself.
    let nsMap = parent ? parent.nsMap : emptyNsMap();
    let declared = false;
    for (const a of rawAttrs) {
      const isDefault = a.qname === "xmlns";
      const isPrefixed = a.qname.startsWith("xmlns:");
      if (!isDefault && !isPrefixed) continue;
      if (!declared) {
        // Chain, do not copy: copying the inherited map on every element that
        // declares a prefix is quadratic in the number of declarations in
        // scope. `Object.create` is O(1) and lookups still find inherited
        // prefixes, because the whole chain is ours and bottoms out at a
        // null-prototype map.
        nsMap = Object.create(nsMap) as Record<string, string>;
        declared = true;
      }
      const prefix = isDefault ? "" : a.qname.slice(6);
      if (isPrefixed && a.value === "") {
        fail("xml_bad_namespace", `Cannot undeclare the prefix ${prefix}`);
      }
      nsMap[prefix] = a.value;
    }

    const resolve = (name: string, forAttribute: boolean): [string, string] => {
      const colon = name.indexOf(":");
      if (colon < 0) {
        // An unprefixed attribute is in no namespace; an unprefixed element is
        // in the default namespace.
        return [forAttribute ? "" : (nsMap[""] ?? ""), name];
      }
      const prefix = name.slice(0, colon);
      const local = name.slice(colon + 1);
      if (prefix === "xmlns") return [XMLNS_URI, local];
      const uri = nsMap[prefix];
      if (uri === undefined) {
        fail(
          "xml_unbound_prefix",
          `The namespace prefix "${prefix}" is used but never declared`,
        );
      }
      return [uri!, local];
    };

    const [ns, local] = resolve(qname, false);
    const attributes: XmlAttribute[] = rawAttrs.map((a) => {
      const [ans, alocal] = resolve(a.qname, true);
      return { namespace: ans, local: alocal, qname: a.qname, value: a.value };
    });

    // The `[n]` index counts preceding siblings of the same name. Counting them
    // by rescanning `parent.el.children` is O(siblings) per element and so
    // quadratic over the document: a flat 200,000-element file took over two
    // minutes, entirely inside this one line, and no cap bounded it because
    // maxElements is only checked once the element is already being built.
    // A per-frame tally is O(1) and produces byte-identical paths.
    let sameName = 0;
    if (parent) {
      sameName = parent.counts.get(qname) ?? 0;
      parent.counts.set(qname, sameName + 1);
    }
    const step = sameName > 0 ? `${qname}[${sameName + 1}]` : qname;
    const path = parent ? `${parent.el.path}/${step}` : `/${qname}`;

    const el: XmlElement = {
      namespace: ns,
      local,
      qname,
      path,
      attributes,
      children: [],
      text: "",
    };

    if (parent) {
      parent.el.children.push(el);
    } else if (root) {
      fail("xml_multiple_roots", "A document may have only one root element");
    } else {
      root = el;
    }

    if (selfClosing) {
      continue;
    }

    const frame: Frame = { el, nsMap, counts: new Map(), text: [] };
    stack.push(frame);

    // Defence: nesting depth cap. Without it, a few kilobytes of open tags
    // build a tree hundreds of thousands of levels deep and any recursive
    // consumer of it overflows the stack.
    if (stack.length > lim.maxDepth) {
      throw new XmlSecurityError(
        "xml_too_deep",
        `The document nests more than ${lim.maxDepth} elements deep. A UBL invoice ` +
          `nests about eight levels; a document this deep is either broken or ` +
          `hostile. Raise the maxDepth option only if you know why it is that deep.`,
      );
    }
  }

  if (stack.length > 0) {
    throw new XmlSyntaxError(
      "xml_unbalanced",
      `The document ends while <${stack[stack.length - 1]!.el.qname}> is still open.`,
    );
  }
  if (!root) {
    throw new XmlSyntaxError(
      "xml_no_root",
      "The document contains no root element.",
    );
  }
  return root;
}

function closeFrame(frame: Frame): void {
  const text = frame.text.join("");
  if (frame.el.children.length > 0) {
    if (text.trim() !== "") {
      throw new XmlSyntaxError(
        "xml_mixed_content",
        `<${frame.el.qname}> holds both child elements and text ("${text.trim().slice(0, 40)}"). ` +
          `UBL never mixes the two, so this parser refuses the document rather than ` +
          `guessing which of the two carries the value.`,
      );
    }
    frame.el.text = "";
    return;
  }
  frame.el.text = text;
}

/**
 * The five predefined entities, and nothing else.
 *
 * Null-prototype on purpose. As an object literal this table also answered to
 * every member of `Object.prototype`: `&constructor;` resolved to the `Object`
 * constructor and was substituted into the document as the string
 * `"function Object() { [native code] }"`, so an invoice number written
 * `&constructor;` parsed, validated and was billed for without a single
 * finding. `&toString;`, `&valueOf;` and `&__proto__;` did the same. Every one
 * of those names is short enough to pass the length guard in `decodeEntities`.
 */
const PREDEFINED: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  },
);

/**
 * Decode the five predefined entities and numeric character references.
 *
 * Every other entity reference is refused. Custom entities are what the
 * billion-laughs attack expands, and external entities are what XXE
 * dereferences; neither is decoded here, and neither is quietly dropped —
 * dropping one would change the text of a tax document without saying so.
 *
 * Numeric character references are safe to expand: each produces exactly one
 * character and cannot refer to another reference, so there is no expansion to
 * run away.
 */
function decodeEntities(raw: string, where: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const amp = raw.indexOf("&", i);
    if (amp < 0) {
      out += raw.slice(i);
      return out;
    }
    out += raw.slice(i, amp);
    const semi = raw.indexOf(";", amp + 1);
    // A reference longer than this is not one of ours and not a code point.
    if (semi < 0 || semi - amp > 12) {
      throw new XmlSyntaxError(
        "xml_bare_ampersand",
        `${where} contains a bare "&". In XML it must be written "&amp;".`,
      );
    }
    const name = raw.slice(amp + 1, semi);
    out += resolveEntity(name, where);
    i = semi + 1;
  }
}

function resolveEntity(name: string, where: string): string {
  // Own-property check as well as the null prototype: two independent guards,
  // because getting this wrong substitutes attacker-chosen text into a tax
  // document without raising anything.
  if (Object.hasOwn(PREDEFINED, name)) return PREDEFINED[name]!;

  if (name.startsWith("#")) {
    const hex = name[1] === "x" || name[1] === "X";
    const digits = hex ? name.slice(2) : name.slice(1);
    if (digits === "" || !/^[0-9a-fA-F]+$/.test(digits) || (!hex && !/^[0-9]+$/.test(digits))) {
      throw new XmlSyntaxError(
        "xml_bad_character_reference",
        `${where} contains the malformed character reference "&${name};".`,
      );
    }
    const code = Number.parseInt(digits, hex ? 16 : 10);
    if (
      !Number.isFinite(code) ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      throw new XmlSyntaxError(
        "xml_bad_character_reference",
        `${where} contains the character reference "&${name};", which is not a ` +
          `valid Unicode code point.`,
      );
    }
    return String.fromCodePoint(code);
  }

  throw new XmlSecurityError(
    "xml_entity_forbidden",
    `${where} refers to the entity "&${name};". Only the five predefined entities ` +
      `(&amp; &lt; &gt; &quot; &apos;) and numeric character references are decoded. ` +
      `Custom entities are refused because expanding them is how the billion-laughs ` +
      `denial of service works, and because an external entity would read a local ` +
      `file or make a network request (the XXE attack).`,
  );
}

/** First child element with this namespace and local name. */
export function firstChild(
  el: XmlElement,
  namespace: string,
  local: string,
): XmlElement | undefined {
  return el.children.find((c) => c.local === local && c.namespace === namespace);
}

/** Every child element with this namespace and local name, in document order. */
export function childrenNamed(
  el: XmlElement,
  namespace: string,
  local: string,
): XmlElement[] {
  return el.children.filter((c) => c.local === local && c.namespace === namespace);
}
