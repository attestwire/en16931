import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { toSarif } from "./export.js";
import { extractFacturX } from "./facturx-pdf.js";
import { buildPdf, FACTURX_EN16931_XML, xmpPacket, type BuildPdfOptions } from "./facturx-testkit.js";
import { extendedXRechnungCii } from "./fixtures.js";
import { generateXRechnungUBL } from "./generate.js";
import { parseCiiInvoice } from "./parse-cii.js";
import { parseUbl } from "./parse.js";
import { __ciiSteps, locateFinding } from "./locate.js";
import { validate, type DocumentValidation } from "./validate.js";
import { validateInput } from "./index.js";
import { parseXml, type XmlElement } from "./xml-parse.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));
const text = (name: string) => fixture(name).toString("utf8");
const bytes = (s: string) => new TextEncoder().encode(s);

const all = (r: DocumentValidation) => [...r.errors, ...r.warnings, ...r.information];
const ruleIds = (findings: { rule: string }[]) => findings.map((f) => f.rule).sort();

/**
 * A PDF carrying `xml` as factur-x.xml, registered the way Factur-X registers
 * it, so a test controls the attachment's bytes exactly. The FeRD samples are
 * all UTF-8, and facturx-pdf.test.ts builds the hostile shapes.
 */
function facturX(xml: Uint8Array): Uint8Array {
  const stream = deflateSync(xml);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(factur-x.xml) 4 0 R] >> >> /AF [4 0 R] >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>",
    "<< /Type /Filespec /F (factur-x.xml) /UF (factur-x.xml) /AFRelationship /Alternative /EF << /F 5 0 R >> >>",
  ].map((dict) => Buffer.from(`${dict}\n`, "latin1"));
  objects.push(
    Buffer.concat([
      Buffer.from(`<< /Type /EmbeddedFile /Subtype /text#2Fxml /Filter /FlateDecode /Length ${stream.length} >>\nstream\n`, "latin1"),
      stream,
      Buffer.from("\nendstream\n", "latin1"),
    ]),
  );
  const parts = [Buffer.from("%PDF-1.7\n", "latin1")];
  const offsets: number[] = [];
  let size = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(size);
    const object = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("endobj\n", "latin1")]);
    parts.push(object);
    size += object.length;
  });
  const table = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${table}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`, "latin1"));
  return new Uint8Array(Buffer.concat(parts));
}

/** 1-based line and column of the first occurrence of `needle`. */
function lineOf(source: string, needle: string): { line: number; column: number } {
  const at = source.indexOf(needle);
  if (at < 0) throw new Error(`${needle} is not in the document`);
  const before = source.slice(0, at);
  const line = before.split("\n").length;
  return { line, column: at - (before.lastIndexOf("\n") + 1) + 1 };
}

describe("parseXml line and column", () => {
  it("records the start tag of every element, 1-based", () => {
    const root = parseXml('<?xml version="1.0"?>\n<a>\n  <b/>\n\t<c><d>x</d></c>\n</a>');
    expect([root.line, root.column]).toEqual([2, 1]);
    const [b, c] = root.children as [XmlElement, XmlElement];
    expect([b.line, b.column]).toEqual([3, 3]);
    expect([c.line, c.column]).toEqual([4, 2]);
    expect([c.children[0]!.line, c.children[0]!.column]).toEqual([4, 5]);
  });

  it("ends a line at a lone CR too, as XML 1.0 and editors do", () => {
    const root = parseXml("<a>\r<b/>\r\r<c/>\n\r<d/></a>");
    expect(root.children.map((c) => c.line)).toEqual([2, 4, 6]);
  });

  it("gives the same columns for bytes and text, even with a second byte order mark", () => {
    const xml = "\uFEFF\uFEFF" + text("xrechnung-ubl-minimal.xml").replace(/<cbc:BuyerReference>[^<]*<\/cbc:BuyerReference>/, "").replace(/\n/g, "");
    const loc = (r: DocumentValidation) => r.errors.map((f) => [f.rule, f.location?.line, f.location?.column]);
    expect(loc(validate(new TextEncoder().encode(xml)))).toEqual(loc(validate(xml)));
  });

  it("refuses a control character in a comment or a processing instruction, as in text", () => {
    expect(() => parseXml("<a><!-- x\u0000y --></a>")).toThrow(/control character/);
    expect(() => parseXml("<?pi \u0001?><a/>")).toThrow(/control character/);
    expect(parseXml("<a><!-- tab\tand newline\n --></a>").local).toBe("a");
  });

  it("counts CRLF as one line and does not count a byte order mark", () => {
    const root = parseXml("﻿<a>\r\n<b/></a>");
    expect([root.line, root.column]).toEqual([1, 1]);
    expect([root.children[0]!.line, root.children[0]!.column]).toEqual([2, 1]);
  });
});

describe("validate", () => {
  it("gives the same findings as parsing and validateInput, for both syntaxes", () => {
    for (const name of ["xrechnung-ubl-discount.xml", "xrechnung-cii-extended.xml", "xrechnung-ubl-credit-note.xml"]) {
      const xml = text(name);
      const broken = xml.replace(/<(cbc|ram):BuyerReference>[^<]*<\/(cbc|ram):BuyerReference>/, "");
      const parsed = name.includes("-cii-") ? parseCiiInvoice(broken) : parseUbl(broken);
      const expected = validateInput(parsed.invoice);
      const got = validate(broken);
      expect(ruleIds(all(got)), name).toEqual(ruleIds([...expected.errors, ...expected.warnings, ...expected.information]));
      expect(got.valid, name).toBe(expected.valid);
      expect(got.errors.map((f) => f.rule), name).toContain("BR-DE-15");
    }
  });

  it("passes the committed fixtures, from bytes and from text", () => {
    for (const name of ["xrechnung-ubl-minimal.xml", "xrechnung-cii-minimal.xml"]) {
      expect(validate(fixture(name)).valid, name).toBe(true);
      expect(validate(text(name)).valid, name).toBe(true);
    }
    const r = validate(fixture("xrechnung-cii-minimal.xml"));
    expect(r.syntax).toBe("cii");
    expect(r.profile).toBe("xrechnung-cii");
    expect(r.invoice?.invoiceNumber).toBeTruthy();
  });

  it("reads the XML out of a Factur-X PDF and says where it came from", () => {
    const r = validate(fixture("facturx/facturx-en16931-einfach.pdf"));
    expect(r.syntax).toBe("cii");
    expect(r.container).toBe("factur-x.xml");
    // Every finding about the XML is located in the attachment. The
    // container's own AW-PDF-* findings are about the PDF around it, which has
    // no line to point at (see the container tests below).
    const aboutTheXml = all(r).filter((f) => !f.rule.startsWith("AW-PDF-"));
    for (const f of aboutTheXml) expect(f.location?.attachment).toBe("factur-x.xml");
  });

  it("calls a Factur-X MINIMUM document what it is", () => {
    const r = validate(fixture("facturx/facturx-minimum-rechnung.pdf"));
    expect(r.errors[0]).toMatchObject({ rule: "AW-PROFILE-SUBSET", severity: "fatal" });
    expect(r.valid).toBe(false);
  });

  it("names what a file that is not an invoice actually is, and never throws for it", () => {
    const cases: [Uint8Array | string, RegExp][] = [
      [new Uint8Array(), /empty file/],
      [bytes("PK\x03\x04rest"), /ZIP archive/],
      [bytes('{"invoiceNumber":"1"}'), /JSON/],
      [bytes("<!doctype html><html></html>"), /HTML page/],
      [new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x3c]), /binary file/],
      [bytes("%PDF-1.7\nnot really"), /could not be read as a Factur-X/],
      ["%PDF-1.7", /PDF passed as text/],
      [bytes("<Invoice>unclosed"), /not an invoice this validator can read/],
      [bytes('<?xml version="1.0" encoding="x-nonsense"?><a/>'), /cannot decode/],
    ];
    for (const [input, message] of cases) {
      const r = validate(input);
      expect(r.valid).toBe(false);
      expect(r.syntax).toBeNull();
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.field).toBe("document");
      expect(r.errors[0]!.rule).toMatch(/^AW-/);
      expect(r.errors[0]!.message).toMatch(message);
    }
  });

  it("keeps the reader's own error, so a caller can branch on its code", () => {
    const r = validate("<not-an-invoice/>");
    expect(r.error?.code).toBe("unsupported_syntax");
    expect(validate(fixture("xrechnung-ubl-minimal.xml")).error).toBeUndefined();
  });

  it("returns BT-24 and BT-23 as the readers do, from XML and from a PDF", () => {
    for (const name of ["xrechnung-ubl-minimal.xml", "xrechnung-cii-minimal.xml"]) {
      const parsed = name.includes("-cii-") ? parseCiiInvoice(text(name)) : parseUbl(text(name));
      const r = validate(fixture(name));
      expect(parsed.profileId, name).toBeTruthy();
      expect(r.profileId, name).toBe(parsed.profileId);
      expect(r.customizationId, name).toBe(parsed.customizationId);
    }
    // The FeRD samples state no BT-23, so the PDF path is pinned against the
    // reader rather than against a value.
    const file = fixture("facturx/facturx-en16931-einfach.pdf");
    expect(validate(file).profileId).toBe(parseCiiInvoice(extractFacturX(file).xml).profileId);
    expect(validate(bytes("<not-an-invoice/>")).profileId).toBeUndefined();
  });

  it("honours the declared encoding rather than assuming UTF-8", () => {
    const xml = text("xrechnung-ubl-minimal.xml")
      .replace('encoding="UTF-8"', 'encoding="windows-1252"')
      .replace(/<cbc:Name>[^<]*<\/cbc:Name>/, "<cbc:Name>Müller</cbc:Name>");
    // "ü" as a single windows-1252 byte, which is invalid UTF-8.
    const encoded = Uint8Array.from(xml, (ch) => (ch === "ü" ? 0xfc : ch.charCodeAt(0)));
    const r = validate(encoded);
    expect(r.syntax).toBe("ubl");
    expect(JSON.stringify(r.invoice)).toContain("Müller");
  });

  it("refuses UTF-8 bytes under a single-byte declaration, by name, rather than read mojibake", () => {
    // A file converted to UTF-8 by something that left its declaration alone.
    // Read as it declares, "Hauptstraße" is "HauptstraÃŸe", and it used to
    // pass that way.
    const xml = text("xrechnung-cii-minimal.xml");
    for (const label of ["ISO-8859-1", "windows-1252", "ISO-8859-15"]) {
      const stale = xml.replace('encoding="UTF-8"', `encoding="${label}"`);
      const r = validate(bytes(stale));
      expect(r.valid, label).toBe(false);
      expect(r.syntax, label).toBeNull();
      expect(r.errors, label).toHaveLength(1);
      expect(r.errors[0], label).toMatchObject({ rule: "AW-PARSE", field: "document", severity: "fatal" });
      expect(r.errors[0]!.message, label).toContain(`declares encoding "${label.toLowerCase()}", but its bytes are UTF-8`);
      expect(r.errors[0]!.fix, label).toContain('encoding="UTF-8"');
      // Text is taken as already decoded: a caller who decoded it is believed.
      expect(validate(stale).valid, label).toBe(true);
    }
  });

  it("still reads a single-byte declaration over plain ASCII, which reads the same either way", () => {
    const ascii = text("xrechnung-cii-minimal.xml")
      .replace('encoding="UTF-8"', 'encoding="ISO-8859-1"')
      .replace(/[^\x00-\x7F]/g, "?");
    const r = validate(bytes(ascii));
    expect(r.syntax).toBe("cii");
    expect(r.errors.filter((f) => f.rule.startsWith("AW-"))).toEqual([]);
  });

  it("reads a Factur-X attachment's non-ASCII text exactly, as it reads the same XML as a file", () => {
    const file = fixture("xrechnung-cii-minimal.xml");
    const r = validate(facturX(file));
    expect(r.container).toBe("factur-x.xml");
    expect(r.valid).toBe(true);
    expect(r.invoice?.seller?.address?.line1).toBe("Hauptstraße 1");
    expect(r.invoice).toEqual(validate(file).invoice);
  });

  it("refuses a Factur-X attachment that is not UTF-8, by name, instead of judging replacement characters", () => {
    // Was: "Hauptstra\uFFFDe 1" in the invoice, no finding, and valid: true.
    const latin1 = text("xrechnung-cii-minimal.xml").replace('encoding="UTF-8"', 'encoding="ISO-8859-1"');
    const r = validate(facturX(Buffer.from(latin1, "latin1")));
    expect(r.valid).toBe(false);
    expect(r.syntax).toBeNull();
    expect(r.invoice).toBeNull();
    expect(r.container).toBe("factur-x.xml");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ rule: "AW-PARSE", field: "document", severity: "fatal" });
    expect(r.errors[0]!.message).toContain('attached as "factur-x.xml" is in iso-8859-1, not UTF-8');
    expect(r.errors[0]!.fix).toMatch(/in UTF-8, and declared as UTF-8/);
    expect(r.error?.code).toBe("facturx_xml_encoding");
    expect(JSON.stringify(r)).not.toContain("\uFFFD");
  });

  it("refuses a stale declaration inside a PDF as it refuses one in a file", () => {
    const stale = bytes(text("xrechnung-cii-minimal.xml").replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'));
    const inPdf = validate(facturX(stale));
    expect(inPdf.error?.code).toBe("facturx_xml_encoding");
    expect(inPdf.errors[0]!.message).toContain('declares encoding "iso-8859-1", but its bytes are UTF-8');
    expect(validate(stale).errors[0]!.message).toContain('declares encoding "iso-8859-1", but its bytes are UTF-8');
  });

  it("reports a document over the limits as AW-SIZE, and reads it when they are raised", () => {
    const xml = text("xrechnung-ubl-minimal.xml");
    const small = validate(xml, { limits: { maxCharacters: 100 } });
    expect(small.errors[0]).toMatchObject({ rule: "AW-SIZE", field: "document" });
    expect(small.error?.code).toBe("xml_too_large");
    expect(validate(xml, { limits: { maxCharacters: 10_000_000 } }).valid).toBe(true);
  });

  it("warns when the profile asked for is in the other syntax", () => {
    const r = validate(text("xrechnung-cii-minimal.xml"), { profile: "peppol-bis-3" });
    expect(r.profile).toBe("peppol-bis-3");
    expect(r.warnings[0]).toMatchObject({ rule: "AW-PROFILE-SYNTAX", severity: "warning" });
    expect(r.warnings[0]!.message).toMatch(/UBL profile, but this document is CII/);
  });

  it("rejects an argument that is not a document, which is a programming error", () => {
    expect(() => validate(42 as unknown as string)).toThrow(TypeError);
  });
});

describe("locations", () => {
  it("points a missing UBL element at the element it belongs in", () => {
    const xml = text("xrechnung-ubl-minimal.xml").replace(/<cbc:BuyerReference>[^<]*<\/cbc:BuyerReference>/, "");
    const f = validate(xml).errors.find((e) => e.rule === "BR-DE-15")!;
    expect(f.xpath).toBe("/ubl:Invoice/cbc:BuyerReference");
    expect(f.location).toMatchObject({ exact: false, ...lineOf(xml, "<ubl:Invoice") });
  });

  it("points a wrong UBL value at its own line", () => {
    const xml = text("xrechnung-ubl-minimal.xml").replace(
      /<cbc:DocumentCurrencyCode>EUR</,
      "<cbc:DocumentCurrencyCode>EURO<",
    );
    const f = validate(xml).errors.find((e) => e.xpath?.endsWith("DocumentCurrencyCode"))!;
    expect(f.location).toMatchObject({ exact: true, ...lineOf(xml, "<cbc:DocumentCurrencyCode>") });
  });

  it("points a CII finding at the CII element, with a CII path", () => {
    const xml = text("xrechnung-cii-extended.xml").replace(
      "<ram:CategoryCode>S</ram:CategoryCode>",
      "<ram:CategoryCode>Q</ram:CategoryCode>",
    );
    const f = validate(xml).errors.find((e) => e.rule === "BR-CL-18" && e.field === "BT-151")!;
    expect(f.xpath).toMatch(/^\/rsm:CrossIndustryInvoice\/.*ram:IncludedSupplyChainTradeLineItem\/.*ram:CategoryCode$/);
    expect(f.location).toMatchObject({ exact: true, ...lineOf(xml, "<ram:CategoryCode>Q") });
  });

  it("gives a missing CII element the CII path it belongs at", () => {
    const xml = text("xrechnung-cii-extended.xml").replace(/<ram:BuyerReference>[^<]*<\/ram:BuyerReference>/, "");
    const f = validate(xml).errors.find((e) => e.rule === "BR-DE-15")!;
    expect(f.xpath).toBe(
      "/rsm:CrossIndustryInvoice/rsm:SupplyChainTradeTransaction/ram:ApplicableHeaderTradeAgreement/ram:BuyerReference",
    );
    expect(f.location).toMatchObject({ exact: false, ...lineOf(xml, "<ram:ApplicableHeaderTradeAgreement>") });
  });

  it("never leaves a UBL path on a CII finding, and locates every finding", () => {
    const xml = text("xrechnung-cii-extended.xml")
      .replace(/<ram:BuyerReference>[^<]*<\/ram:BuyerReference>/, "")
      .replace(/<ram:CountryID>DE<\/ram:CountryID>/g, "<ram:CountryID>XX</ram:CountryID>")
      .replace(/<ram:LineTotalAmount>1785.00</, "<ram:LineTotalAmount>1785.004<")
      .replace(/<ram:ReasonCode>95</g, "<ram:ReasonCode>ZZZ<");
    const findings = all(validate(xml));
    expect(findings.length).toBeGreaterThan(4);
    for (const f of findings) {
      expect(f.xpath ?? "", f.rule).not.toMatch(/^\/ubl:/);
      expect(f.location, f.rule).toBeDefined();
    }
  });

  it("counts allowances before charges, the way the rules do, whatever order the file uses", () => {
    const ac = (charge: boolean, reason: string) =>
      `<cac:AllowanceCharge><cbc:ChargeIndicator>${charge}</cbc:ChargeIndicator><cbc:AllowanceChargeReason>${reason}</cbc:AllowanceChargeReason></cac:AllowanceCharge>`;
    const xml = `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">\n${ac(true, "freight")}\n${ac(false, "discount")}\n</Invoice>`;
    const root = parseXml(xml);
    const first = locateFinding("/ubl:Invoice/cac:AllowanceCharge[1]/cbc:AllowanceChargeReason", root, "ubl");
    expect(first.location).toMatchObject({ exact: true, line: 3 });
    expect(first.xpath).toBe("/Invoice/cac:AllowanceCharge[2]/cbc:AllowanceChargeReason");
    const second = locateFinding("/ubl:Invoice/cac:AllowanceCharge[2]", root, "ubl");
    expect(second.location).toMatchObject({ exact: true, line: 2 });
  });

  it("reads a rule's Invoice path on a credit note", () => {
    const xml = text("xrechnung-ubl-credit-note.xml");
    const root = parseXml(xml);
    const at = locateFinding("/ubl:Invoice/cac:InvoiceLine[1]/cbc:InvoicedQuantity/@unitCode", root, "ubl");
    expect(at.location).toMatchObject({ exact: true, ...lineOf(xml, "<cbc:CreditedQuantity") });
    expect(at.xpath).toMatch(/CreditNoteLine\/cbc:CreditedQuantity\/@unitCode$/);
  });

  it("points at the parent when several elements could be meant, rather than guess", () => {
    const xml = text("xrechnung-cii-extended.xml");
    const at = locateFinding("/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal[2]/cbc:TaxAmount", parseXml(xml), "cii");
    expect(at.location).toMatchObject({ exact: false, ...lineOf(xml, "<ram:ApplicableHeaderTradeSettlement>") });
  });
});

/**
 * The UBL → CII table, checked against invoices that exist in both syntaxes.
 *
 * Every leaf of each UBL document is located in its CII twin. Where the table
 * says the element is there, its value must be the same value. Anything the
 * table cannot answer for (several candidates, no CII equivalent) is allowed to
 * fall back to a parent; a WRONG element is not.
 */
describe("the UBL to CII table", () => {
  const pairs: [string, string, string][] = [
    "minimal",
    "reverse-charge",
    "discount",
    "credit-note",
    "credit-note-discount",
  ].map((n) => [n, text(`xrechnung-ubl-${n}.xml`), text(`xrechnung-cii-${n}.xml`)]);
  pairs.push([
    "extended",
    generateXRechnungUBL({ ...extendedXRechnungCii, profile: "xrechnung-ubl" }),
    text("xrechnung-cii-extended.xml"),
  ]);

  const PREFIX: Record<string, string> = {
    "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2": "cbc",
    "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2": "cac",
  };
  const same = (a: string, b: string) => {
    const norm = (t: string) => {
      const v = t.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v.replace(/-/g, "");
      if (/^-?\d+(\.\d+)?$/.test(v)) return String(Number(v));
      return v;
    };
    return norm(a) === norm(b);
  };
  const find = (root: XmlElement, path: string): XmlElement | undefined => {
    if (root.path === path) return root;
    for (const c of root.children) {
      const hit = find(c, path);
      if (hit) return hit;
    }
    return undefined;
  };

  it("lands every translatable UBL leaf on the CII element holding the same value", () => {
    let matched = 0;
    const wrong: string[] = [];
    for (const [name, ubl, cii] of pairs) {
      const ciiRoot = parseXml(cii);
      const visit = (el: XmlElement, path: string) => {
        const total = new Map<string, number>();
        for (const c of el.children) total.set(`${PREFIX[c.namespace]}:${c.local}`, (total.get(`${PREFIX[c.namespace]}:${c.local}`) ?? 0) + 1);
        const seen = new Map<string, number>();
        for (const c of el.children) {
          const q = `${PREFIX[c.namespace]}:${c.local}`;
          const n = (seen.get(q) ?? 0) + 1;
          seen.set(q, n);
          // Rules always write the index of a repeated element, [1] included.
          const p = `${path}/${q}${(total.get(q) ?? 0) > 1 ? `[${n}]` : ""}`;
          if (c.children.length > 0) {
            visit(c, p);
            continue;
          }
          if (!__ciiSteps(p)?.complete) continue;
          const { location } = locateFinding(p, ciiRoot, "cii");
          if (!location.exact) continue;
          const target = find(ciiRoot, location.path)!;
          // A leaf that maps to a CII group: UBL's cbc:Note is "#AAI#text" in
          // one element, CII splits it into SubjectCode and Content.
          if (target.children.length > 0) continue;
          if (same(target.text, c.text)) matched += 1;
          else wrong.push(`${name} ${p}: UBL "${c.text.trim()}" landed on "${target.text.trim()}" at ${location.path}`);
        }
      };
      visit(parseXml(ubl), "/ubl:Invoice");
    }
    // The one known difference: UBL's PartyName carries the trading name when
    // there is one, and BR-06 (the only rule pointing there) is about the
    // legal name, which CII keeps in ram:Name.
    expect(wrong.filter((w) => !/^extended .*AccountingSupplierParty\/cac:Party\/cac:PartyName\/cbc:Name/.test(w))).toEqual([]);
    expect(matched).toBeGreaterThan(500);
  });
});

describe("SARIF from validate", () => {
  it("puts the line and column in the physical location", () => {
    const xml = text("xrechnung-ubl-minimal.xml").replace(/<cbc:BuyerReference>[^<]*<\/cbc:BuyerReference>/, "");
    const r = validate(xml);
    const log = toSarif(all(r) as never, { engineVersion: "test", documentUri: "invoice.xml" }) as {
      runs: { results: { locations: { physicalLocation: { region?: { startLine: number } } }[] }[] }[];
    };
    const region = log.runs[0]!.results[0]!.locations[0]!.physicalLocation.region;
    expect(region?.startLine).toBe(lineOf(xml, "<ubl:Invoice").line);
  });

  it("leaves the region out for XML that came out of a PDF", () => {
    const r = validate(fixture("facturx/facturx-minimum-rechnung.pdf"));
    const findings = all(r).filter((f) => f.location);
    expect(findings.length).toBeGreaterThan(0);
    const log = toSarif(findings as never, { engineVersion: "test", documentUri: "invoice.pdf" }) as {
      runs: { results: { locations: { physicalLocation: { region?: unknown } }[] }[] }[];
    };
    for (const result of log.runs[0]!.results) expect(result.locations[0]!.physicalLocation.region).toBeUndefined();
  });
});

describe("a document that states its VAT rates as fractions", () => {
  // The same slip as `vatRate: 0.19` on JSON input, read from a file: the
  // warning lands on the line's own rate element, in either syntax.
  const asFraction = (name: string, element: string) =>
    new TextEncoder().encode(
      fixture(name).toString("utf8").replace(new RegExp(`<${element}>19\\.00</${element}>`, "g"), `<${element}>0.19</${element}>`),
    );

  for (const [name, element, tag] of [
    ["xrechnung-ubl-discount.xml", "cbc:Percent", "cbc:Percent"],
    ["xrechnung-cii-discount.xml", "ram:RateApplicablePercent", "ram:RateApplicablePercent"],
  ] as const) {
    it(`warns on the line's rate element in ${name}`, () => {
      const result = validate(asFraction(name, element));
      const finding = result.warnings.find((f) => f.rule === "ATW-VAT-RATE-FRACTION");
      expect(finding?.location?.exact).toBe(true);
      expect(finding?.location?.path).toMatch(new RegExp(`${tag}$`));
      expect(finding?.message).toContain("as a percentage, 0.19 is 19%");
      // A file's sender cannot set the model's field paths.
      expect(finding?.fix).toMatch(/^If you meant 19%, set the rate to 19/);
      // The stated group fails BR-CO-17, and its advice now names the unit.
      const stated = result.errors.find((f) => f.rule === "BR-CO-17" && f.fix.startsWith("VAT rates are percentages and no EU VAT rate is below 1%: if 0.19 is a rate kept as a fraction"));
      expect(stated).toBeDefined();
    });
  }
});

describe("the Factur-X container's own findings", () => {
  // The same XML in every PDF here, so any difference between two results is
  // the container's. Its BT-24 declares EN 16931, as the default container's
  // metadata does.
  const cii = FACTURX_EN16931_XML;
  const pdf = (options: BuildPdfOptions = {}) => buildPdf({ xml: cii, compress: true, ...options });
  const container = (findings: { rule: string }[]) => findings.filter((f) => f.rule.startsWith("AW-PDF-"));

  it("reports what the PDF says about its attachment, and the verdict on the invoice does not move", () => {
    const clean = validate(pdf());
    expect(clean.valid).toBe(true);
    expect(container(all(clean))).toEqual([]);

    const r = validate(pdf({ attachmentName: "invoice.xml", afRelationship: null, subtype: null }));
    expect(r.valid).toBe(true);
    expect(r.container).toBe("invoice.xml");
    expect(ruleIds(container(r.warnings))).toEqual(["AW-PDF-ATTACHMENT", "AW-PDF-MIME", "AW-PDF-RELATIONSHIP"]);
    expect(r.errors).toEqual([]);
    expect(r.invoice).toEqual(clean.invoice);
  });

  it("gives them the TeachingError fields and nothing else: no location, xpath or docsUrl", () => {
    // The hosted API passes these through verbatim, and its schema admits no
    // other key and no location on an AW- finding.
    const r = validate(pdf({ attachmentName: "invoice.xml", afRelationship: "Unspecified", omitAf: true }));
    const found = container(all(r));
    expect(found.length).toBe(3);
    for (const f of found) {
      expect(Object.keys(f).sort()).toEqual(["field", "fix", "message", "rule", "severity"]);
      expect(f).toMatchObject({ field: "document" });
    }
  });

  it("lists them after the engine's profile findings and before the rule findings", () => {
    const r = validate(pdf({ attachmentName: "invoice.xml" }), { profile: "xrechnung-ubl" });
    expect(r.warnings[0]!.rule).toBe("AW-PROFILE-SYNTAX");
    expect(r.warnings[1]!.rule).toBe("AW-PDF-ATTACHMENT");
    const firstRule = r.warnings.findIndex((f) => !f.rule.startsWith("AW-"));
    const lastContainer = r.warnings.map((f) => f.rule).lastIndexOf("AW-PDF-ATTACHMENT");
    if (firstRule !== -1) expect(lastContainer).toBeLessThan(firstRule);
  });

  it("keeps information in `information`, where it never touches a warnings gate", () => {
    const r = validate(pdf({ extraAttachment: { name: "timesheet.xml", xml: "<timesheet/>" } }));
    expect(container(r.warnings)).toEqual([]);
    expect(container(r.information)).toMatchObject([{ rule: "AW-PDF-ATTACHMENT", severity: "information" }]);
  });

  it("still says what the PDF says when the XML inside cannot be read, and that explains the refusal", () => {
    const ferd1 =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<rsm:CrossIndustryDocument xmlns:rsm="urn:ferd:CrossIndustryDocument:invoice:1p0"/>';
    const r = validate(buildPdf({ xml: ferd1, attachmentName: "ZUGFeRD-invoice.xml" }));
    expect(r.syntax).toBeNull();
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ rule: "AW-PARSE", severity: "fatal" });
    expect(r.container).toBe("ZUGFeRD-invoice.xml");
    const [notCii] = container(r.warnings);
    expect(notCii).toMatchObject({ rule: "AW-PDF-ATTACHMENT", severity: "warning" });
    expect(notCii!.message).toContain("ZUGFeRD 1.0 CrossIndustryDocument");
  });

  it("says nothing about a container when there is none", () => {
    expect(container(all(validate(cii)))).toEqual([]);
    expect(container(all(validate(bytes(cii))))).toEqual([]);
  });

  it("sets the profile the metadata declares against the one BT-24 declares", () => {
    const basic = validate(pdf({ xmp: xmpPacket({ conformanceLevel: "BASIC" }) }));
    expect(basic.valid).toBe(true);
    const found = container(basic.warnings);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rule: "AW-PDF-XMP-PROFILE", field: "BT-24", severity: "warning" });
    expect(found[0]!.message).toContain(
      'declares the BASIC profile (ConformanceLevel), but the XML declares EN 16931: its BT-24 is "urn:cen.eu:en16931:2017"',
    );
    expect(found[0]!.fix).toMatch(/^Write EN 16931 to the XMP ConformanceLevel\./);
    expect(Object.keys(found[0]!).sort()).toEqual(["field", "fix", "message", "rule", "severity"]);

    // XRechnung CII in a PDF: the metadata level is XRECHNUNG.
    const xrechnung = text("xrechnung-cii-minimal.xml");
    const agreeing = validate(buildPdf({ xml: xrechnung, compress: true, xmp: xmpPacket({ conformanceLevel: "XRECHNUNG" }) }));
    expect(container(all(agreeing))).toEqual([]);
    const disagreeing = validate(buildPdf({ xml: xrechnung, compress: true }));
    expect(container(disagreeing.warnings)[0]!.message).toContain("declares the EN 16931 profile (ConformanceLevel), but the XML declares XRECHNUNG");
  });

  it("compares nothing when BT-24 declares no profile the metadata has a name for", () => {
    const peppol = cii.replace(
      "urn:cen.eu:en16931:2017",
      "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0",
    );
    expect(peppol).not.toBe(cii);
    const r = validate(buildPdf({ xml: peppol, compress: true, xmp: xmpPacket({ conformanceLevel: "BASIC" }) }));
    expect(container(all(r))).toEqual([]);
  });

  it("reports an unknown level once, as unknown, not as a second disagreement", () => {
    const r = validate(pdf({ xmp: xmpPacket({ conformanceLevel: "COMFORT" }) }));
    expect(container(all(r)).map((f) => f.rule)).toEqual(["AW-PDF-XMP-PROFILE"]);
    expect(container(all(r))[0]!.message).toMatch(/not one the Factur-X metadata defines/);
  });

  it("Data or Source on a profile Germany asks Alternative for is information, and the verdict does not move", () => {
    for (const rel of ["Data", "Source"]) {
      const r = validate(pdf({ afRelationship: rel }));
      expect(r.valid, rel).toBe(true);
      expect(container(r.warnings), rel).toEqual([]);
      const found = container(r.information);
      expect(found, rel).toHaveLength(1);
      expect(found[0], rel).toMatchObject({ rule: "AW-PDF-RELATIONSHIP", field: "document", severity: "information" });
      expect(found[0]!.message, rel).toContain(
        `attached with /AFRelationship /${rel}, and its BT-24 declares the EN 16931 profile`,
      );
      expect(found[0]!.message, rel).toContain("Germany the ZUGFeRD specification requires Alternative");
      expect(found[0]!.fix, rel).toContain(`For France, /${rel} can stay.`);
    }
    expect(container(all(validate(pdf({ afRelationship: "Alternative" }))))).toEqual([]);
  });

  it("asks it of BASIC, EN 16931, EXTENDED and XRECHNUNG only: MINIMUM and BASIC WL are Data", () => {
    const cases: [string, string, boolean][] = [
      ["urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic", "BASIC", true],
      ["urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended", "EXTENDED", true],
      ["urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0", "XRECHNUNG", true],
      ["urn:factur-x.eu:1p0:minimum", "MINIMUM", false],
      ["urn:factur-x.eu:1p0:basicwl", "BASIC WL", false],
      ["urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0", "EN 16931", false],
    ];
    for (const [id, level, asked] of cases) {
      const xml = cii.replace("urn:cen.eu:en16931:2017", id);
      const r = validate(buildPdf({ xml, compress: true, afRelationship: "Data", xmp: xmpPacket({ conformanceLevel: level }) }));
      expect(container(r.warnings), id).toEqual([]);
      expect(container(r.information).length, id).toBe(asked ? 1 : 0);
    }
  });

  it("FeRD's samples: MINIMUM's container agrees with its XML; BASIC's and EN 16931's lack the Factur-X metadata and use Data", () => {
    const minimum = validate(fixture("facturx/facturx-minimum-rechnung.pdf"));
    expect(container(all(minimum))).toEqual([]);
    expect(minimum.errors[0]!.rule).toBe("AW-PROFILE-SUBSET");

    for (const name of ["facturx-basic-einfach.pdf", "facturx-en16931-einfach.pdf"]) {
      const r = validate(fixture(`facturx/${name}`));
      expect(container(r.warnings).map((f) => f.rule), name).toEqual(["AW-PDF-XMP"]);
      expect(container(r.warnings)[0]!.message, name).toMatch(/does not declare this file as Factur-X or ZUGFeRD/);
      expect(container(r.information).map((f) => f.rule), name).toEqual(["AW-PDF-RELATIONSHIP"]);
      expect(container(r.information)[0]!.message, name).toContain("/AFRelationship /Data");
    }
    expect(validate(fixture("facturx/facturx-en16931-einfach.pdf")).valid).toBe(true);
  });
});
