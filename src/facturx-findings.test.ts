import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as F from "./facturx-findings.js";
import {
  FACTURX_OBSERVATIONS,
  FACTURX_RULES,
  facturXLevel,
  facturXProfileFindings,
  sortFacturXFindings,
  type FacturXFinding,
} from "./facturx-findings.js";
import { ParseError } from "./xml-parse.js";
import { readXmp } from "./xmp.js";

/**
 * The pieces behind the container's findings, on their own: the BT-24
 * classifier, the findings that need BT-24, and the XMP reader's edge cases.
 * facturx-pdf.test.ts drives them through real and hand-built PDFs, and
 * validate.test.ts through `validate()`.
 */

describe("facturXLevel: BT-24 in the metadata's words", () => {
  it("names each profile the way the XMP ConformanceLevel spells it", () => {
    const cases: [string, string | undefined][] = [
      ["urn:factur-x.eu:1p0:minimum", "MINIMUM"],
      ["urn:factur-x.eu:1p0:basicwl", "BASIC WL"],
      ["urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic", "BASIC"],
      ["urn:cen.eu:en16931:2017", "EN 16931"],
      ["urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended", "EXTENDED"],
      ["urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0", "XRECHNUNG"],
      ["urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_2.3", "XRECHNUNG"],
      // ZUGFeRD 2.0's own identifiers.
      ["urn:zugferd.de:2p0:minimum", "MINIMUM"],
      ["urn:zugferd.de:2p0:basicwl", "BASIC WL"],
      ["urn:cen.eu:en16931:2017#compliant#urn:zugferd.de:2p0:basic", "BASIC"],
      ["urn:cen.eu:en16931:2017#conformant#urn:zugferd.de:2p0:extended", "EXTENDED"],
      // Stated with stray whitespace, or in another case, as documents do.
      ["  urn:cen.eu:en16931:2017\n", "EN 16931"],
      ["URN:FACTUR-X.EU:1P0:MINIMUM", "MINIMUM"],
      // Nothing the metadata has a name for.
      ["urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0", undefined],
      ["urn:cen.eu:en16931:2017#conformant#urn.cpro.gouv.fr:1p0:extended-ctc-fr", undefined],
      ["urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic-plus", undefined],
      ["", undefined],
    ];
    for (const [id, level] of cases) expect(facturXLevel(id), id).toBe(level);
    expect(facturXLevel(undefined)).toBeUndefined();
  });

  it("reads MINIMUM and BASIC WL exactly as AW-PROFILE-SUBSET always has", () => {
    // The two patterns validate.ts used before it asked facturXLevel, kept
    // here so the move is proved to change nothing.
    const before = (id: string) => {
      const lower = id.toLowerCase();
      if (/factur-x\.eu:1p0:minimum|zugferd.*:minimum/.test(lower)) return "MINIMUM";
      if (/factur-x\.eu:1p0:basicwl|zugferd.*:basicwl/.test(lower)) return "BASIC WL";
      return null;
    };
    const after = (id: string) => {
      const level = facturXLevel(id);
      return level === "MINIMUM" || level === "BASIC WL" ? level : null;
    };
    for (const id of [
      "urn:factur-x.eu:1p0:minimum",
      "urn:factur-x.eu:1p0:basicwl",
      "urn:zugferd.de:2p0:minimum",
      "urn:zugferd.de:2p0:basicwl",
      "urn:zugferd.de:2p0:extended",
      "urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic",
      "urn:cen.eu:en16931:2017",
      "urn:ferd:CrossIndustryDocument:invoice:1p0:basic",
      "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0",
      "something:zugferd:else:minimum:and-more",
      "",
    ]) {
      expect(after(id), id).toBe(before(id));
    }
  });
});

describe("facturXProfileFindings: the checks that need BT-24", () => {
  const container = (conformanceLevel?: string, schema: "factur-x" | "zugferd-1.0" = "factur-x") => ({
    attachmentName: "factur-x.xml",
    relationship: "Alternative",
    xmp: conformanceLevel === undefined ? null : { schema, namespace: "urn:x", conformanceLevel },
  });

  it("reports a metadata level that is not BT-24's, on BT-24", () => {
    const [f] = facturXProfileFindings(container("EXTENDED"), "urn:cen.eu:en16931:2017");
    expect(f).toMatchObject({ rule: "AW-PDF-XMP-PROFILE", id: "xmp_level_mismatch", field: "BT-24", severity: "warning" });
  });

  it("reports Data or Source on a profile Germany asks Alternative for, as information", () => {
    const data = { ...container("EN 16931"), relationship: "Data" };
    const [f] = facturXProfileFindings(data, "urn:cen.eu:en16931:2017");
    expect(f).toMatchObject({
      rule: "AW-PDF-RELATIONSHIP",
      id: "relationship_not_alternative",
      field: "document",
      severity: "information",
    });
    // BASIC WL is Data by the same specification: nothing to ask.
    const basicWl = { ...container("BASIC WL"), relationship: "Data" };
    expect(facturXProfileFindings(basicWl, "urn:factur-x.eu:1p0:basicwl")).toEqual([]);
    // Both at once, in rule order: the relationship, then the level.
    const two = facturXProfileFindings({ ...container("BASIC"), relationship: "Source" }, "urn:cen.eu:en16931:2017");
    expect(two.map((x) => x.id)).toEqual(["relationship_not_alternative", "xmp_level_mismatch"]);
    // No relationship, or one Factur-X does not allow, is extractFacturX's to report.
    for (const relationship of [undefined, "Unspecified", "Alternative"]) {
      const c = { ...container("EN 16931"), relationship };
      expect(facturXProfileFindings(c, "urn:cen.eu:en16931:2017"), String(relationship)).toEqual([]);
    }
  });

  it("is silent when they agree, when either side says nothing, or when the level is one of its own", () => {
    expect(facturXProfileFindings(container("EN 16931"), "urn:cen.eu:en16931:2017")).toEqual([]);
    expect(facturXProfileFindings(container(), "urn:cen.eu:en16931:2017")).toEqual([]);
    expect(facturXProfileFindings(container("BASIC"), undefined)).toEqual([]);
    expect(facturXProfileFindings(container("BASIC"), "urn:example:other")).toEqual([]);
    // Unknown to its schema: xmpFindings has reported it already.
    expect(facturXProfileFindings(container("GOLD"), "urn:cen.eu:en16931:2017")).toEqual([]);
  });
});

describe("the container's findings, as a set", () => {
  it("has a rule for every observation, and every observation is named once", () => {
    expect(new Set(FACTURX_OBSERVATIONS).size).toBe(FACTURX_OBSERVATIONS.length);
    expect(FACTURX_RULES.every((rule) => /^AW-PDF-[A-Z]+(?:-[A-Z]+)*$/.test(rule))).toBe(true);
  });

  it("documents every finding id and every observation id in the README, with its rule and severity", () => {
    // Every new finding id must be documented: the README's table is the
    // public list, and a row that names the wrong rule or severity fails here.
    const one: FacturXFinding[] = [
      F.attachmentName("a.xml"),
      F.attachmentAmbiguous(["a.xml", "b.xml"], "a.xml", 0),
      F.attachmentExtra(["factur-x.xml", "b.xml"], "factur-x.xml"),
      F.attachmentEncoding("factur-x.xml", "iso-8859-1"),
      F.attachmentNotCii("factur-x.xml"),
      F.afStreamsDiffer("factur-x.xml"),
      F.afMissing("factur-x.xml"),
      F.afNameTreeMissing("factur-x.xml"),
      F.relationshipMissing("factur-x.xml"),
      F.relationshipUnexpected("factur-x.xml", "Unspecified"),
      F.relationshipNotAlternative("factur-x.xml", "Data", "EN 16931"),
      F.mimeNotXml("factur-x.xml", "image/png"),
      F.mimeMissing("factur-x.xml"),
      F.xmpMissing(),
      F.xmpUnreadable("it is not XML."),
      F.xmpPdfaMissing(undefined),
      F.xmpPdfaPart("2"),
      F.xmpPdfaConformance(undefined),
      F.xmpFacturXMissing("factur-x.xml"),
      F.xmpFacturXIncomplete(["Version"], "urn:x"),
      F.xmpFacturXNamespace("urn:x"),
      F.xmpDocumentType("ORDER"),
      F.xmpFileName("a.xml", "factur-x.xml"),
      F.xmpLevelUnknown("GOLD", "factur-x"),
      F.xmpLevelMismatch("BASIC", "EN 16931", "urn:cen.eu:en16931:2017"),
    ];
    expect(one.map((f) => f.id).sort()).toEqual([...FACTURX_OBSERVATIONS].sort());

    const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    for (const rule of FACTURX_RULES) expect(readme, rule).toContain(`\`${rule}\``);
    for (const f of one) {
      const row = readme.split("\n").find((line) => line.startsWith(`| \`${f.id}\` |`));
      expect(row, `README has no table row for ${f.id}`).toBeDefined();
      expect(row!.startsWith(`| \`${f.id}\` | \`${f.rule}\` | ${f.severity} |`), `${f.id}: ${row}`).toBe(true);
    }
  });

  it("sorts by rule, keeping each rule's own order", () => {
    const sorted = sortFacturXFindings([
      { rule: "AW-PDF-XMP", n: 1 },
      { rule: "AW-PDF-ATTACHMENT", n: 2 },
      { rule: "AW-PDF-XMP", n: 3 },
      { rule: "AW-PDF-AF", n: 4 },
    ]);
    expect(sorted.map((f) => f.n)).toEqual([2, 4, 1, 3]);
  });
});

describe("readXmp: the edge cases a packet brings", () => {
  const RDF = 'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"';
  const FX = "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#";

  it("matches properties by namespace URI, whatever the prefix", () => {
    const xmp = readXmp(
      `<rdf:RDF ${RDF}><rdf:Description rdf:about="" xmlns:zz="${FX}" zz:ConformanceLevel="BASIC"/></rdf:RDF>`,
    );
    expect(xmp).toEqual({ namespace: FX, schema: "factur-x", conformanceLevel: "BASIC" });
  });

  it("takes the first statement of a property, and neither rdf:about nor a namespace declaration as one", () => {
    const xmp = readXmp(
      `<rdf:RDF ${RDF}>` +
        `<rdf:Description rdf:about="" xmlns:fx="${FX}"><fx:ConformanceLevel>BASIC</fx:ConformanceLevel></rdf:Description>` +
        `<rdf:Description rdf:about="" xmlns:fx="${FX}"><fx:ConformanceLevel>EXTENDED</fx:ConformanceLevel></rdf:Description>` +
        `</rdf:RDF>`,
    );
    expect(xmp.conformanceLevel).toBe("BASIC");
    expect(Object.keys(xmp).sort()).toEqual(["conformanceLevel", "namespace", "schema"]);
  });

  it("reads a property's text through a structure a producer wrapped it in", () => {
    const xmp = readXmp(
      `<rdf:RDF ${RDF}><rdf:Description rdf:about="" xmlns:fx="${FX}">` +
        `<fx:ConformanceLevel><rdf:Alt><rdf:li xml:lang="x-default">EN 16931</rdf:li></rdf:Alt></fx:ConformanceLevel>` +
        `</rdf:Description></rdf:RDF>`,
    );
    expect(xmp.conformanceLevel).toBe("EN 16931");
  });

  it("refuses XML with no rdf:RDF by a stable code, and malformed XML as the XML reader does", () => {
    for (const [packet, code] of [
      ["<x:xmpmeta xmlns:x='adobe:ns:meta/'/>", "xmp_no_rdf"],
      ["<rdf:RDF>", /^xml_/],
      ["not xml at all", /^xml_/],
    ] as const) {
      let caught: unknown;
      try {
        readXmp(packet);
      } catch (error) {
        caught = error;
      }
      expect(caught, packet).toBeInstanceOf(ParseError);
      if (typeof code === "string") expect((caught as ParseError).code).toBe(code);
      else expect((caught as ParseError).code).toMatch(code);
    }
  });
});
