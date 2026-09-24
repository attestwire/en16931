import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { extendedXRechnungCii } from "./fixtures.js";
import { generateXRechnungUBL } from "./generate.js";
import { locateFinding } from "./locate.js";
import { validate } from "./validate.js";
import { parseXml, type XmlElement } from "./xml-parse.js";

// The locator on its own. validate.test.ts checks that no UBL leaf lands on a
// CII element holding a different value; mutation testing (2026-09-23) showed
// that was not enough: most of the choosing strategies, the table's paths and
// the tax-total ordering could change and every test still passed, because a
// finding that falls back to its parent is not wrong, only less useful. So
// this file pins, for every leaf of every fixture pair, WHERE it lands and
// whether exactly, as a reviewed table. A change to the locator is a diff in
// __snapshots__/locate-table.txt that someone reads.

const text = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");

const PREFIX: Record<string, string> = {
  "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2": "cbc",
  "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2": "cac",
};

/** Every leaf of a UBL document as a rule would write its path: canonical prefixes, [n] on repeats. */
function ublLeafPaths(root: XmlElement): string[] {
  const out: string[] = [];
  const visit = (el: XmlElement, path: string) => {
    const total = new Map<string, number>();
    for (const c of el.children) total.set(c.local, (total.get(c.local) ?? 0) + 1);
    const seen = new Map<string, number>();
    for (const c of el.children) {
      const n = (seen.get(c.local) ?? 0) + 1;
      seen.set(c.local, n);
      // Rules write the Invoice spelling on credit notes too.
      const local = { CreditNoteLine: "InvoiceLine", CreditedQuantity: "InvoicedQuantity", CreditNoteTypeCode: "InvoiceTypeCode" }[c.local] ?? c.local;
      const p = `${path}/${PREFIX[c.namespace]}:${local}${(total.get(c.local) ?? 0) > 1 ? `[${n}]` : ""}`;
      if (c.children.length > 0) visit(c, p);
      else out.push(p);
    }
  };
  visit(root, "/ubl:Invoice");
  return out;
}

const PAIRS: [string, string, string][] = [
  ...["minimal", "reverse-charge", "discount", "credit-note", "credit-note-discount"].map(
    (n): [string, string, string] => [n, text(`xrechnung-ubl-${n}.xml`), text(`xrechnung-cii-${n}.xml`)],
  ),
  ["extended", generateXRechnungUBL({ ...extendedXRechnungCii, profile: "xrechnung-ubl" }), text("xrechnung-cii-extended.xml")],
];

/** One row per leaf: where it lands in its own UBL file and in the CII twin. */
function table(): string {
  const rows: string[] = [];
  for (const [name, ubl, cii] of PAIRS) {
    const u = parseXml(ubl);
    const c = parseXml(cii);
    rows.push(`## ${name}`);
    for (const p of ublLeafPaths(u)) {
      const inUbl = locateFinding(p, u, "ubl");
      const inCii = locateFinding(p, c, "cii");
      const mark = (l: { location: { exact: boolean; line: number } }) => `${l.location.exact ? "=" : "~"}${l.location.line}`;
      rows.push(`${p}\n  ubl ${mark(inUbl)}\n  cii ${mark(inCii)} ${inCii.location.path}${inCii.xpath && !inCii.location.exact ? `  -> ${inCii.xpath}` : ""}`);
    }
  }
  return rows.join("\n") + "\n";
}

describe("the locator's reviewed table", () => {
  it("lands every fixture leaf where it landed when the table was reviewed", async () => {
    await expect(table()).toMatchFileSnapshot("./__snapshots__/locate-table.txt");
  });

  it("finds every leaf of a UBL document exactly in that document, bar the ones it cannot tell apart", () => {
    for (const [name, ubl] of PAIRS) {
      const u = parseXml(ubl);
      for (const p of ublLeafPaths(u)) {
        const { location } = locateFinding(p, u, "ubl");
        // The deliberate "cannot tell" groups: several VAT breakdowns, tax
        // registrations, identifiers or document references.
        if (/TaxSubtotal\[|PartyTaxScheme\[|PartyIdentification\[|AdditionalDocumentReference\[/.test(p)) continue;
        expect(location.exact, `${name} ${p}`).toBe(true);
      }
    }
  });
});

describe("choosing among siblings", () => {
  const UBL_NS =
    'xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"';
  const doc = (body: string) => parseXml(`<Invoice ${UBL_NS}>\n${body}\n</Invoice>`);
  const line = (xpath: string, root: XmlElement) => locateFinding(xpath, root, "ubl").location;

  it("counts allowances before charges, whatever the file's order, at document and line level", () => {
    const ac = (charge: boolean) => `<cac:AllowanceCharge><cbc:ChargeIndicator>${charge}</cbc:ChargeIndicator></cac:AllowanceCharge>`;
    const root = doc([ac(true), ac(false), ac(true), ac(false)].join("\n"));
    // allowances are lines 3 and 5, charges 2 and 4
    expect([1, 2, 3, 4].map((n) => line(`/ubl:Invoice/cac:AllowanceCharge[${n}]`, root).line)).toEqual([3, 5, 2, 4]);
    expect(line("/ubl:Invoice/cac:AllowanceCharge[5]", root)).toMatchObject({ exact: false, line: 1 });
    const inLine = doc(`<cac:InvoiceLine>\n${ac(true)}\n${ac(false)}\n</cac:InvoiceLine>`);
    expect(line("/ubl:Invoice/cac:InvoiceLine[1]/cac:AllowanceCharge[1]", inLine).line).toBe(4);
    expect(line("/ubl:Invoice/cac:InvoiceLine[1]/cac:AllowanceCharge[2]", inLine).line).toBe(3);
  });

  it("reads a charge indicator written the CII way, inside udt:Indicator", () => {
    const root = parseXml(text("xrechnung-cii-extended.xml"));
    const allowance = locateFinding("/ubl:Invoice/cac:AllowanceCharge[1]/cbc:Amount", root, "cii");
    const charge = locateFinding("/ubl:Invoice/cac:AllowanceCharge[2]/cbc:Amount", root, "cii");
    expect(allowance.location.exact && charge.location.exact).toBe(true);
    expect(allowance.location.line).toBeLessThan(charge.location.line);
    // swap them in the file: the rule's [1] still means the allowance
    const src = text("xrechnung-cii-extended.xml");
    const blocks = [...src.matchAll(/<ram:SpecifiedTradeAllowanceCharge>[\s\S]*?<\/ram:SpecifiedTradeAllowanceCharge>/g)].slice(-2);
    const swapped = src.replace(blocks[0]![0] + "\n      " + blocks[1]![0], blocks[1]![0] + "\n      " + blocks[0]![0]);
    expect(swapped).not.toBe(src);
    const r2 = parseXml(swapped);
    const a2 = locateFinding("/ubl:Invoice/cac:AllowanceCharge[1]/cbc:Amount", r2, "cii");
    const c2 = locateFinding("/ubl:Invoice/cac:AllowanceCharge[2]/cbc:Amount", r2, "cii");
    expect(a2.location.line).toBeGreaterThan(c2.location.line);
  });

  it("tells the two tax totals apart by content, not by order", () => {
    const total = (breakdown: boolean, amount: string) =>
      `<cac:TaxTotal><cbc:TaxAmount>${amount}</cbc:TaxAmount>${breakdown ? "<cac:TaxSubtotal/>" : ""}</cac:TaxTotal>`;
    const root = doc(`${total(false, "SEK")}\n${total(true, "EUR")}`);
    expect(line("/ubl:Invoice/cac:TaxTotal/cbc:TaxAmount", root).line).toBe(3);
    expect(line("/ubl:Invoice/cac:TaxTotal[1]/cbc:TaxAmount", root).line).toBe(3);
    expect(line("/ubl:Invoice/cac:TaxTotal[2]/cbc:TaxAmount", root).line).toBe(2);
    expect(line("/ubl:Invoice/cac:TaxTotal[3]/cbc:TaxAmount", root).exact).toBe(false);
    // one total: [1] is it, [2] is not there
    const one = doc(total(true, "EUR"));
    expect(line("/ubl:Invoice/cac:TaxTotal[1]/cbc:TaxAmount", one)).toMatchObject({ exact: true, line: 2 });
    expect(line("/ubl:Invoice/cac:TaxTotal[2]/cbc:TaxAmount", one).exact).toBe(false);
    // two with a breakdown: nothing says which is which
    const both = doc(`${total(true, "A")}\n${total(true, "B")}`);
    expect(line("/ubl:Invoice/cac:TaxTotal[1]/cbc:TaxAmount", both).exact).toBe(false);
  });

  it("answers a single-only group only when there is exactly one", () => {
    const sub = (n: number) => Array.from({ length: n }, () => "<cac:TaxSubtotal><cbc:TaxAmount>1</cbc:TaxAmount></cac:TaxSubtotal>").join("");
    expect(line("/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal[1]/cbc:TaxAmount", doc(`<cac:TaxTotal>${sub(1)}</cac:TaxTotal>`)).exact).toBe(true);
    expect(line("/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal[2]/cbc:TaxAmount", doc(`<cac:TaxTotal>${sub(1)}</cac:TaxTotal>`)).exact).toBe(false);
    expect(line("/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal[1]/cbc:TaxAmount", doc(`<cac:TaxTotal>${sub(2)}</cac:TaxTotal>`)).exact).toBe(false);
  });

  it("takes a position only when the path gives one or there is one candidate", () => {
    const notes = doc("<cbc:Note>a</cbc:Note>\n<cbc:Note>b</cbc:Note>");
    expect(line("/ubl:Invoice/cbc:Note", notes).exact).toBe(false);
    expect(line("/ubl:Invoice/cbc:Note[2]", notes)).toMatchObject({ exact: true, line: 3 });
    expect(line("/ubl:Invoice/cbc:Note[3]", notes).exact).toBe(false);
    expect(line("/ubl:Invoice/cbc:Note", doc("<cbc:Note>a</cbc:Note>"))).toMatchObject({ exact: true, line: 2 });
  });

  it("accepts a CII identifier written as ram:GlobalID, in document order, and refuses a second one", () => {
    const party = (inner: string) =>
      parseXml(
        `<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"><rsm:SupplyChainTradeTransaction><ram:ApplicableHeaderTradeAgreement><ram:SellerTradeParty>\n${inner}\n</ram:SellerTradeParty></ram:ApplicableHeaderTradeAgreement></rsm:SupplyChainTradeTransaction></rsm:CrossIndustryInvoice>`,
      );
    const p = "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyIdentification/cbc:ID";
    expect(locateFinding(p, party("<ram:GlobalID>1</ram:GlobalID>"), "cii").location).toMatchObject({ exact: true, line: 2 });
    expect(locateFinding(p, party("<ram:ID>1</ram:ID>"), "cii").location).toMatchObject({ exact: true, line: 2 });
    expect(locateFinding(p, party("<ram:GlobalID>1</ram:GlobalID>\n<ram:ID>2</ram:ID>"), "cii").location.exact).toBe(false);
    expect(locateFinding(`${p.replace("PartyIdentification", "PartyIdentification[2]")}`, party("<ram:GlobalID>1</ram:GlobalID>"), "cii").location.exact).toBe(false);
  });
});

describe("paths the locator cannot or should not walk", () => {
  const ubl = parseXml(text("xrechnung-ubl-minimal.xml"));
  const cii = parseXml(text("xrechnung-cii-minimal.xml"));

  it("keeps a malformed or relative path on UBL, and drops it on CII", () => {
    for (const bad of ["relative/path", "/ubl:Invoice/cac:X[a]", "/ubl:Invoice/not a step", "/"]) {
      const u = locateFinding(bad, ubl, "ubl");
      expect(u.location, bad).toMatchObject({ exact: false, line: ubl.line, path: ubl.path });
      expect(u.xpath, bad).toBe(bad);
      const c = locateFinding(bad, cii, "cii");
      expect(c.location.path, bad).toBe(cii.path);
      expect(c.xpath, bad).toBeUndefined();
    }
    expect(locateFinding(undefined, cii, "cii").xpath).toBeUndefined();
  });

  it("keeps an unknown prefix on UBL at the root", () => {
    const r = locateFinding("/ubl:Invoice/xx:Thing", ubl, "ubl");
    expect(r).toMatchObject({ location: { exact: false, path: ubl.path }, xpath: "/ubl:Invoice/xx:Thing" });
  });

  it("walks a rule path already written in CII on a CII file, and drops it on UBL", () => {
    const p = "/rsm:CrossIndustryInvoice/rsm:ExchangedDocument/ram:TypeCode";
    const c = locateFinding(p, cii, "cii");
    expect(c.location.exact).toBe(true);
    expect(c.xpath).toBe(c.location.path);
    const missing = locateFinding("/rsm:CrossIndustryInvoice/rsm:ExchangedDocument/ram:Nope/@x", cii, "cii");
    expect(missing).toMatchObject({ location: { exact: false }, xpath: "/rsm:CrossIndustryInvoice/rsm:ExchangedDocument/ram:Nope/@x" });
    const u = locateFinding(p, ubl, "ubl");
    expect(u).toMatchObject({ location: { exact: false, path: ubl.path }, xpath: undefined });
  });

  it("keeps the attribute on an exact path, and writes a full CII path for a missing element", () => {
    const at = locateFinding("/ubl:Invoice/cbc:DocumentCurrencyCode/@listID", ubl, "ubl");
    expect(at.xpath).toBe(at.location.path + "/@listID");
    const gone = locateFinding("/ubl:Invoice/cac:InvoiceLine[1]/cac:Item/cac:OriginCountry/cbc:IdentificationCode", cii, "cii");
    expect(gone.location.exact).toBe(false);
    expect(gone.xpath).toBe(
      "/rsm:CrossIndustryInvoice/rsm:SupplyChainTradeTransaction/ram:IncludedSupplyChainTradeLineItem[1]/ram:SpecifiedTradeProduct/ram:OriginTradeCountry/ram:ID",
    );
  });

  it("does not claim a path it could only partly translate", () => {
    const r = locateFinding("/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cac:TaxScheme/cbc:ID", cii, "cii");
    expect(r.location.exact).toBe(false);
    expect(r.xpath).toBeUndefined();
  });
});

describe("validate() input forms", () => {
  const xml = text("xrechnung-ubl-minimal.xml");

  it("takes an ArrayBuffer as well as bytes and text", () => {
    const bytes = new TextEncoder().encode(xml);
    const r = validate(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(r).toMatchObject({ valid: true, syntax: "ubl" });
  });

  it("calls a file a PDF only when all four bytes say %PDF", () => {
    for (const head of ["%PDX", "%PXF", "%XDF", "XPDF", "%!PS"]) {
      const r = validate(new TextEncoder().encode(`${head}-1.7 not a pdf`));
      expect(r.errors[0]!.rule, head).toBe("AW-PARSE");
    }
    expect(validate(new TextEncoder().encode("%PDF-1.7 broken")).errors[0]!.rule).toBe("AW-PDF");
  });
});

// Mutation testing, second round (2026-09-23): the byte-level readers and the
// command line's own wording were only reached by the fuzzer.
describe("reading bytes", () => {
  const xml = text("xrechnung-ubl-minimal.xml").replace(/<cbc:BuyerReference>[^<]*<\/cbc:BuyerReference>/, "");
  const utf16 = (s: string, be: boolean) => {
    const out = new Uint8Array(2 + s.length * 2);
    out.set(be ? [0xfe, 0xff] : [0xff, 0xfe]);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out[2 + i * 2 + (be ? 1 : 0)] = c & 0xff;
      out[2 + i * 2 + (be ? 0 : 1)] = c >> 8;
    }
    return out;
  };
  const loc = (r: ReturnType<typeof validate>) => r.errors.map((f) => [f.rule, f.location?.line, f.location?.column]);
  const expected = loc(validate(xml));

  it("reads UTF-16 in both byte orders, and a UTF-8 BOM, with the same findings and columns", () => {
    const decl = xml.replace('encoding="UTF-8"', 'encoding="UTF-16"');
    expect(loc(validate(utf16(decl, false)))).toEqual(expected);
    expect(loc(validate(utf16(decl, true)))).toEqual(expected);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(xml)]);
    expect(loc(validate(bom))).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it("does not call a UTF-16 file binary for its zero bytes, but does call other zero bytes binary", () => {
    expect(validate(utf16(xml, false)).syntax).toBe("ubl");
    expect(validate(new Uint8Array([0x3c, 0x00, 0x61, 0x00])).errors[0]!.message).toMatch(/binary/);
    expect(validate(new TextEncoder().encode('[{"a":1}]')).errors[0]!.message).toMatch(/JSON/);
  });

  it("names a Factur-X BASIC WL document as too thin to be an invoice", () => {
    const cii = text("xrechnung-cii-minimal.xml").replace(
      /(<ram:GuidelineSpecifiedDocumentContextParameter>\s*<ram:ID>)[^<]*/,
      "$1urn:factur-x.eu:1p0:basicwl",
    );
    expect(validate(cii).errors[0]).toMatchObject({ rule: "AW-PROFILE-SUBSET", severity: "fatal" });
    expect(validate(cii).errors[0]!.message).toMatch(/BASIC WL/);
    expect(validate(text("xrechnung-cii-minimal.xml")).errors.some((f) => f.rule === "AW-PROFILE-SUBSET")).toBe(false);
  });

  it("reports a PDF over the limits as AW-SIZE, with the reader's code", () => {
    const pdf = readFileSync(fileURLToPath(new URL("../fixtures/facturx/facturx-en16931-einfach.pdf", import.meta.url)));
    const r = validate(pdf, { pdfLimits: { maxStreamBytes: 64, maxTotalInflatedBytes: 64, maxAttachmentBytes: 64 } });
    expect(r.errors[0]).toMatchObject({ rule: "AW-SIZE", field: "document" });
    expect(r.error?.code).toMatch(/^pdf_/);
  });
});

describe("credit-note spellings in a rule's path, on CII", () => {
  const cii = parseXml(text("xrechnung-cii-credit-note.xml"));
  it("finds CreditedQuantity and CreditNoteTypeCode where CII keeps them", () => {
    const q = locateFinding("/ubl:CreditNote/cac:CreditNoteLine[1]/cbc:CreditedQuantity", cii, "cii");
    expect(q.location.exact).toBe(true);
    expect(q.location.path).toMatch(/ram:SpecifiedLineTradeDelivery\/ram:BilledQuantity$/);
    const t = locateFinding("/ubl:CreditNote/cbc:CreditNoteTypeCode", cii, "cii");
    expect(t.location.exact).toBe(true);
    expect(t.location.path).toMatch(/rsm:ExchangedDocument\/ram:TypeCode$/);
  });
});
