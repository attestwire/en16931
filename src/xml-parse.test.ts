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
      maxCharacters: 10_000_000,
      maxDepth: 100,
      maxElements: 200_000,
    });
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
