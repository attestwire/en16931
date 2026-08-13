import { describe, expect, it } from "vitest";

import {
  DEFAULT_XML_LIMITS,
  ParseError,
  XmlSecurityError,
  XmlSyntaxError,
  attr,
  childrenNamed,
  firstChild,
  parseXml,
} from "./xml-parse.js";

const CBC = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2";
const CAC = "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2";

/** The error code a call throws, or undefined if it does not throw. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof ParseError ? error.code : `not-a-ParseError:${error}`;
  }
}

describe("parseXml: the accepted subset", () => {
  it("reads elements, attributes and text", () => {
    const root = parseXml(`<a x="1"><b>hello</b></a>`);
    expect(root.local).toBe("a");
    expect(attr(root, "x")).toBe("1");
    expect(root.children).toHaveLength(1);
    expect(root.children[0]!.text).toBe("hello");
  });

  it("resolves prefixes to namespace URIs, not to the prefix text", () => {
    // The prefixes here are deliberately misleading: "x" is bound to cbc and
    // "y" to cac. A parser that matched on the prefix would get this backwards.
    const root = parseXml(
      `<y:Invoice xmlns:y="${CAC}" xmlns:x="${CBC}"><x:ID>R-1</x:ID></y:Invoice>`,
    );
    expect(root.namespace).toBe(CAC);
    expect(firstChild(root, CBC, "ID")?.text).toBe("R-1");
    expect(firstChild(root, CAC, "ID")).toBeUndefined();
  });

  it("puts unprefixed elements in the default namespace and attributes in none", () => {
    const root = parseXml(`<Invoice xmlns="${CBC}" note="x"><ID>1</ID></Invoice>`);
    expect(root.namespace).toBe(CBC);
    expect(firstChild(root, CBC, "ID")?.text).toBe("1");
    // An unprefixed attribute is never in the default namespace.
    expect(attr(root, "note", "")).toBe("x");
    expect(attr(root, "note", CBC)).toBeUndefined();
  });

  it("re-declares a namespace for a subtree without leaking it upward", () => {
    const root = parseXml(
      `<a xmlns="urn:one"><b xmlns="urn:two"><c/></b><d/></a>`,
    );
    expect(root.children[0]!.namespace).toBe("urn:two");
    expect(root.children[0]!.children[0]!.namespace).toBe("urn:two");
    expect(root.children[1]!.namespace).toBe("urn:one");
  });

  it("accepts self-closing elements and both quote styles", () => {
    const root = parseXml(`<a><b/><c d='1' e="2"/></a>`);
    expect(root.children).toHaveLength(2);
    expect(root.children[0]!.text).toBe("");
    expect(attr(root.children[1]!, "d")).toBe("1");
    expect(attr(root.children[1]!, "e")).toBe("2");
  });

  it("skips comments and processing instructions without acting on them", () => {
    const root = parseXml(
      `<?xml version="1.0"?><?xml-stylesheet href="http://example.invalid/x.xsl"?>` +
        `<!-- a note --><a><!-- another --><b>1</b></a>`,
    );
    expect(root.children).toHaveLength(1);
    expect(root.children[0]!.text).toBe("1");
  });

  it("keeps text verbatim, including newlines and trailing whitespace", () => {
    const root = parseXml("<a>line one\nline two\n</a>");
    expect(root.text).toBe("line one\nline two\n");
  });

  it("reads a CDATA section as plain text and does not decode inside it", () => {
    const root = parseXml(`<a><![CDATA[3 < 4 &amp; more]]></a>`);
    expect(root.text).toBe("3 < 4 &amp; more");
  });

  it("decodes the five predefined entities", () => {
    const root = parseXml(`<a>&amp;&lt;&gt;&quot;&apos;</a>`);
    expect(root.text).toBe(`&<>"'`);
  });

  it("decodes numeric character references, decimal and hexadecimal", () => {
    const root = parseXml(`<a>&#65;&#x20AC;&#x1F600;</a>`);
    expect(root.text).toBe("A€\u{1F600}");
  });

  it("decodes entities in attribute values too", () => {
    const root = parseXml(`<a b="Meier &amp; S&#246;hne"/>`);
    expect(attr(root, "b")).toBe("Meier & Söhne");
  });

  it("decodes each reference exactly once, so a decoded entity is never rescanned", () => {
    // `decodeEntities` is one left-to-right scan that appends to a separate
    // buffer, which is what makes this true: the "&" that comes out of `&amp;`
    // lands in the output and is never looked at again. A `.replace()` chain
    // would decode `&amp;` first and then find the `&lt;` it just created, so
    // `&amp;lt;` — the correct escaping of the literal text "&lt;" — would come
    // back as "<". Applying a decode to its own output is how an escaped
    // document silently becomes a different document.
    expect(parseXml(`<a>&amp;amp;lt;</a>`).text).toBe("&amp;lt;");
    expect(parseXml(`<a>&amp;lt;</a>`).text).toBe("&lt;");
  });

  it("does not turn an escaped numeric reference into the digits of an amount", () => {
    // The case that makes the ordering load-bearing rather than pedantic: an
    // invoice line whose text reads `1&#48;0` is escaped on the wire as
    // `1&amp;#48;0`. Decoded once that is the seven characters "1&#48;0";
    // decoded twice it is "100", and a monetary amount has been corrupted by
    // the parser with nothing raised.
    expect(parseXml(`<a>1&amp;#48;0</a>`).text).toBe("1&#48;0");
    expect(parseXml(`<a>1&#48;0</a>`).text).toBe("100");
  });

  it("decodes an attribute value once as well", () => {
    // Attribute values go through the same function, and BT-6 and BT-5 both
    // live in an attribute (@currencyID), so the same corruption is reachable
    // there.
    expect(attr(parseXml(`<a b="&amp;amp;lt;"/>`), "b")).toBe("&amp;lt;");
    expect(attr(parseXml(`<a b="1&amp;#48;0"/>`), "b")).toBe("1&#48;0");
  });

  it("gives every element a path, indexing repeated siblings", () => {
    const root = parseXml(`<a><b><c/></b><b/><d/></a>`);
    expect(root.path).toBe("/a");
    expect(root.children[0]!.path).toBe("/a/b");
    expect(root.children[0]!.children[0]!.path).toBe("/a/b/c");
    expect(root.children[1]!.path).toBe("/a/b[2]");
    expect(root.children[2]!.path).toBe("/a/d");
  });

  it("finds children by namespace and local name", () => {
    const root = parseXml(
      `<a xmlns:cbc="${CBC}"><cbc:ID>1</cbc:ID><cbc:ID>2</cbc:ID></a>`,
    );
    expect(childrenNamed(root, CBC, "ID").map((c) => c.text)).toEqual(["1", "2"]);
    expect(firstChild(root, CBC, "ID")?.text).toBe("1");
  });

  it("ignores a byte order mark", () => {
    const root = parseXml(`\uFEFF<?xml version="1.0"?><a>1</a>`);
    expect(root.text).toBe("1");
  });
});

describe("parseXml: security defences", () => {
  it("refuses a DOCTYPE outright, which is what stops XXE", () => {
    const xxe =
      `<?xml version="1.0"?>` +
      `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>` +
      `<a>&xxe;</a>`;
    expect(codeOf(() => parseXml(xxe))).toBe("xml_doctype_forbidden");
    expect(() => parseXml(xxe)).toThrow(XmlSecurityError);
    // The message must say why, not merely that it failed.
    expect(() => parseXml(xxe)).toThrow(/XXE/);
  });

  it("refuses the billion-laughs document before expanding anything", () => {
    const lol =
      `<!DOCTYPE lolz [` +
      `<!ENTITY lol "lol">` +
      `<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">` +
      `<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">` +
      `]><lolz>&lol3;</lolz>`;
    expect(codeOf(() => parseXml(lol))).toBe("xml_doctype_forbidden");
  });

  it("refuses an entity declaration even without a DOCTYPE keyword nearby", () => {
    expect(codeOf(() => parseXml(`<a><!ENTITY x "y">1</a>`))).toBe(
      "xml_entity_declaration_forbidden",
    );
  });

  it("refuses any entity reference that is not one of the five predefined ones", () => {
    expect(codeOf(() => parseXml(`<a>&nbsp;</a>`))).toBe("xml_entity_forbidden");
    expect(codeOf(() => parseXml(`<a b="&xxe;"/>`))).toBe("xml_entity_forbidden");
    // And it is refused, not silently dropped: dropping it would change the
    // text of a tax document without saying so.
    expect(() => parseXml(`<a>&nbsp;</a>`)).toThrow(XmlSecurityError);
  });

  it("caps nesting depth and fails cleanly", () => {
    const deep = "<a>".repeat(500) + "x" + "</a>".repeat(500);
    expect(codeOf(() => parseXml(deep))).toBe("xml_too_deep");
    expect(() => parseXml(deep)).toThrow(XmlSecurityError);
    // A document at the limit still parses.
    const atLimit = "<a>".repeat(100) + "x" + "</a>".repeat(100);
    expect(() => parseXml(atLimit)).not.toThrow();
  });

  it("caps the input size and says so plainly", () => {
    const big = `<a>${"x".repeat(5000)}</a>`;
    expect(codeOf(() => parseXml(big, { maxCharacters: 1000 }))).toBe("xml_too_large");
    expect(() => parseXml(big, { maxCharacters: 1000 })).toThrow(/maxCharacters/);
    expect(() => parseXml(big)).not.toThrow();
  });

  it("caps the element count, which depth and size alone do not", () => {
    const wide = `<a>${"<b/>".repeat(5000)}</a>`;
    expect(codeOf(() => parseXml(wide, { maxElements: 100 }))).toBe(
      "xml_too_many_elements",
    );
    expect(() => parseXml(wide)).not.toThrow();
  });

  it("has limits that are documented constants, not magic numbers", () => {
    expect(DEFAULT_XML_LIMITS).toEqual({
      maxCharacters: 400_000,
      maxDepth: 100,
      maxElements: 50_000,
      maxAttributes: 256,
    });
  });

  // Regression, finding 3. The default character cap used to be 10,000,000,
  // which a measurement put at ~81 MB retained heap and ~306 MB RSS — over the
  // 128 MB a Workers isolate gets. The cap must stay in the low hundreds of
  // thousands, and must stay overridable for a caller who has the headroom.
  it("keeps the default size cap inside a Workers isolate's budget", () => {
    expect(DEFAULT_XML_LIMITS.maxCharacters).toBeLessThanOrEqual(1_000_000);
    // At ~250-400 bytes retained per element and four characters per element,
    // the cap bounds retained memory at roughly 40 MB.
    const worstCaseElements = DEFAULT_XML_LIMITS.maxCharacters / 4;
    expect(worstCaseElements * 400).toBeLessThan(64 * 1024 * 1024);
    // Still overridable upwards.
    const big = `<a>${"x".repeat(DEFAULT_XML_LIMITS.maxCharacters)}</a>`;
    expect(codeOf(() => parseXml(big))).toBe("xml_too_large");
    expect(() =>
      parseXml(big, { maxCharacters: DEFAULT_XML_LIMITS.maxCharacters * 4 }),
    ).not.toThrow();
  });

  // Regression, finding 4. The per-element attribute count was uncapped, so a
  // root carrying 20,000 xmlns: declarations was accepted and every descendant
  // paid for it.
  it("caps the number of attributes on one element", () => {
    const many = `<a ${Array.from({ length: 300 }, (_, n) => `x${n}="1"`).join(" ")}/>`;
    expect(codeOf(() => parseXml(many))).toBe("xml_too_many_attributes");
    expect(() => parseXml(many, { maxAttributes: 500 })).not.toThrow();
    // A realistic root, with its handful of namespace declarations, is nowhere
    // near the cap.
    expect(() =>
      parseXml(`<a xmlns="urn:d" xmlns:b="urn:b" xmlns:c="urn:c" id="1"/>`),
    ).not.toThrow();
  });

  it("refuses control characters that XML 1.0 does not permit", () => {
    expect(codeOf(() => parseXml("<a>ok\u0001bad</a>"))).toBe("xml_illegal_character");
    // Including one smuggled in as a numeric character reference.
    expect(codeOf(() => parseXml("<a>&#0;</a>"))).toBe("xml_illegal_character");
    expect(codeOf(() => parseXml("<a>&#xD800;</a>"))).toBe(
      "xml_bad_character_reference",
    );
    // Tab, newline and carriage return are legal.
    expect(() => parseXml("<a>\t\r\n</a>")).not.toThrow();
  });
});

describe("parseXml: prototype-chain lookups (findings 1 and 5)", () => {
  // Regression, finding 1. The predefined-entity table was an object literal,
  // so `PREDEFINED[name]` also answered to every Object.prototype member. A
  // document whose invoice number was `&constructor;` parsed clean, validated
  // `valid: true` with zero findings, and carried the text
  // "function Object() { [native code] }" as its BT-1.
  it("refuses an entity that is only an Object.prototype member", () => {
    // All four fit inside the `semi - amp > 12` length guard, so the guard
    // never saved us.
    for (const name of ["constructor", "toString", "valueOf", "__proto__"]) {
      expect(codeOf(() => parseXml(`<a>&${name};</a>`))).toBe(
        "xml_entity_forbidden",
      );
      expect(codeOf(() => parseXml(`<a b="&${name};"/>`))).toBe(
        "xml_entity_forbidden",
      );
    }
    // Longer prototype members are refused too, by the length guard.
    for (const name of ["hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable"]) {
      expect(() => parseXml(`<a>&${name};</a>`)).toThrow(ParseError);
    }
    // The five real ones still decode — the control.
    expect(parseXml(`<a>&amp;&lt;&gt;&quot;&apos;</a>`).text).toBe(`&<>"'`);
    expect(parseXml(`<a>&#65;&#x42;</a>`).text).toBe("AB");
  });

  // Regression, finding 5. `nsMap[prefix]` had the same hole: `constructor`
  // resolved to a function, so the element got a namespace that was not a
  // string instead of being refused as unbound.
  it("refuses a prefix that is only an Object.prototype member", () => {
    for (const prefix of ["constructor", "toString", "valueOf", "__proto__"]) {
      expect(codeOf(() => parseXml(`<${prefix}:a/>`))).toBe("xml_unbound_prefix");
      expect(codeOf(() => parseXml(`<a ${prefix}:b="1"/>`))).toBe(
        "xml_unbound_prefix",
      );
    }
    // Declared explicitly, such a prefix is ordinary and must still work.
    const root = parseXml(`<constructor:a xmlns:constructor="urn:c"/>`);
    expect(root.namespace).toBe("urn:c");
    expect(typeof root.namespace).toBe("string");
  });

  it("gives every element a string namespace, never an inherited member", () => {
    const root = parseXml(`<a xmlns="urn:d"><b/></a>`);
    expect(typeof root.namespace).toBe("string");
    expect(typeof root.children[0]!.namespace).toBe("string");
  });
});

describe("parseXml: sibling path indexing (finding 2)", () => {
  // Regression, finding 2. The `[n]` index was computed by rescanning every
  // sibling, which is quadratic: 200,000 flat elements took over two minutes,
  // and maxElements did not bound it because the cap is checked only once an
  // element is already being built. The assertion here is on the paths, not on
  // the clock — a timing assertion would be flaky on shared CI.
  it("numbers repeated siblings exactly as before", () => {
    const root = parseXml(`<r><x/><y/><x/><x/><y/></r>`);
    expect(root.children.map((c) => c.path)).toEqual([
      "/r/x",
      "/r/y",
      "/r/x[2]",
      "/r/x[3]",
      "/r/y[2]",
    ]);
  });

  it("counts siblings per parent, not per document", () => {
    const root = parseXml(`<r><p><x/><x/></p><p><x/><x/></p></r>`);
    const paths: string[] = [];
    const walk = (el: (typeof root)): void => {
      paths.push(el.path);
      el.children.forEach(walk);
    };
    walk(root);
    expect(paths).toEqual([
      "/r",
      "/r/p",
      "/r/p/x",
      "/r/p/x[2]",
      "/r/p[2]",
      "/r/p[2]/x",
      "/r/p[2]/x[2]",
    ]);
  });

  it("indexes by qname, so a re-bound prefix is still counted separately", () => {
    const root = parseXml(
      `<r xmlns:a="urn:a" xmlns:b="urn:a"><a:x/><b:x/><a:x/></r>`,
    );
    expect(root.children.map((c) => c.path)).toEqual([
      "/r/a:x",
      "/r/b:x",
      "/r/a:x[2]",
    ]);
  });

  it("indexes a large flat document correctly, and in linear time", () => {
    const n = 20_000;
    const root = parseXml(`<r>${"<x/>".repeat(n)}</r>`, {
      maxElements: n + 10,
      maxCharacters: n * 4 + 100,
    });
    expect(root.children).toHaveLength(n);
    expect(root.children[0]!.path).toBe("/r/x");
    expect(root.children[1]!.path).toBe("/r/x[2]");
    expect(root.children[n - 1]!.path).toBe(`/r/x[${n}]`);
  });
});

describe("parseXml: refusals for anything outside the subset", () => {
  it("refuses mixed content rather than guessing which part is the value", () => {
    expect(codeOf(() => parseXml(`<a>text<b>1</b></a>`))).toBe("xml_mixed_content");
    expect(() => parseXml(`<a>text<b>1</b></a>`)).toThrow(XmlSyntaxError);
    // Whitespace between children is not mixed content.
    expect(() => parseXml(`<a>\n  <b>1</b>\n</a>`)).not.toThrow();
  });

  it("refuses unbalanced or unclosed tags", () => {
    expect(codeOf(() => parseXml(`<a><b></a></b>`))).toBe("xml_unbalanced");
    expect(codeOf(() => parseXml(`<a><b></b>`))).toBe("xml_unbalanced");
    expect(codeOf(() => parseXml(`<a></b>`))).toBe("xml_unbalanced");
  });

  it("refuses an unbound namespace prefix", () => {
    expect(codeOf(() => parseXml(`<a><cbc:ID>1</cbc:ID></a>`))).toBe(
      "xml_unbound_prefix",
    );
  });

  it("refuses two root elements, and text outside the root", () => {
    expect(codeOf(() => parseXml(`<a/><b/>`))).toBe("xml_multiple_roots");
    expect(codeOf(() => parseXml(`junk<a/>`))).toBe("xml_text_outside_root");
    expect(codeOf(() => parseXml(`<a/>junk`))).toBe("xml_text_outside_root");
  });

  it("refuses a bare ampersand and a malformed character reference", () => {
    expect(codeOf(() => parseXml(`<a>Meier & Söhne</a>`))).toBe("xml_bare_ampersand");
    expect(codeOf(() => parseXml(`<a>&#zz;</a>`))).toBe("xml_bad_character_reference");
  });

  it("refuses an unquoted or valueless attribute", () => {
    expect(codeOf(() => parseXml(`<a b=1/>`))).toBe("xml_bad_attribute");
    expect(codeOf(() => parseXml(`<a b/>`))).toBe("xml_bad_attribute");
  });

  it("refuses an element that carries the same attribute name twice", () => {
    // XML 1.0 forbids it, and the reason it matters here is that `attr()`
    // returns the first match: accepted, one of the two values would simply be
    // gone from the invoice with nothing raised.
    expect(codeOf(() => parseXml(`<r a="1" a="2"/>`))).toBe("xml_duplicate_attribute");
    expect(() => parseXml(`<r a="1" a="2"/>`)).toThrow(XmlSyntaxError);
    // The message names the attribute, so the sender can find it.
    expect(() => parseXml(`<r a="1" a="2"/>`)).toThrow(/\ba\b/);
    // Repeated namespace declarations are attributes too.
    expect(codeOf(() => parseXml(`<r xmlns:p="urn:a" xmlns:p="urn:b"/>`))).toBe(
      "xml_duplicate_attribute",
    );
  });

  it("refuses two attributes that are the same name once the prefixes resolve", () => {
    // Different prefixes, one namespace URI, one local name: this is the same
    // attribute written twice, and a check on the text as written would miss it.
    expect(
      codeOf(() =>
        parseXml(`<r xmlns:p="urn:one" xmlns:q="urn:one" p:x="1" q:x="2"/>`),
      ),
    ).toBe("xml_duplicate_attribute");
    // The message names both spellings, because neither on its own explains it.
    expect(() =>
      parseXml(`<r xmlns:p="urn:one" xmlns:q="urn:one" p:x="1" q:x="2"/>`),
    ).toThrow(/p:x.*q:x/);
  });

  it("accepts the same local name under two genuinely different namespaces", () => {
    const root = parseXml(
      `<r xmlns:p="urn:one" xmlns:q="urn:two" p:x="1" q:x="2"/>`,
    );
    expect(attr(root, "x", "urn:one")).toBe("1");
    expect(attr(root, "x", "urn:two")).toBe("2");
    // An unprefixed attribute is in no namespace, so it does not collide with a
    // prefixed one of the same local name even under the default namespace.
    const mixed = parseXml(`<r xmlns="urn:one" xmlns:p="urn:one" x="1" p:x="2"/>`);
    expect(attr(mixed, "x", "")).toBe("1");
    expect(attr(mixed, "x", "urn:one")).toBe("2");
  });

  it("refuses a comment containing '--', which XML 1.0 does not permit", () => {
    // "-->" is the only terminator, so a comment holding "--" has no single
    // reading: writer and reader disagree about where the markup ends.
    expect(codeOf(() => parseXml(`<r><!-- bad -- comment --></r>`))).toBe(
      "xml_bad_comment",
    );
    expect(() => parseXml(`<r><!-- bad -- comment --></r>`)).toThrow(XmlSyntaxError);
    // A comment may not end with a hyphen either, which is the same rule seen
    // from the other end: the close would be written "--->".
    expect(codeOf(() => parseXml(`<r><!-- bad ---></r>`))).toBe("xml_bad_comment");
  });

  it("still accepts single hyphens inside a comment", () => {
    // The boundary case the '--' check must not swallow: hyphens separated by
    // other characters are ordinary comment text.
    expect(() => parseXml(`<r><!-- a- -b --></r>`)).not.toThrow();
    expect(() => parseXml(`<r><!-- BT-1 is the invoice number --></r>`)).not.toThrow();
    // And an ordinary comment, in every position one can appear.
    const root = parseXml(
      `<!-- before --><r><!-- inside --><b>1</b></r><!-- after -->`,
    );
    expect(root.children[0]!.text).toBe("1");
  });

  it("refuses a markup declaration it does not understand", () => {
    expect(codeOf(() => parseXml(`<a><!NOTATION x SYSTEM "y"></a>`))).toBe(
      "xml_unsupported_declaration",
    );
  });

  it("refuses an empty document", () => {
    expect(codeOf(() => parseXml(``))).toBe("xml_no_root");
    expect(codeOf(() => parseXml(`<?xml version="1.0"?>`))).toBe("xml_no_root");
  });

  it("refuses input that is not a string", () => {
    expect(codeOf(() => parseXml(undefined as unknown as string))).toBe(
      "xml_not_a_string",
    );
  });
});
