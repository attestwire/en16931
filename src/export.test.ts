import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { toJunitXml, toSarif, type ExportProvenance } from "./export.js";
import { parseXml } from "./xml-parse.js";
import { validateInput } from "./index.js";
import { discountedXRechnung } from "./fixtures.js";
import type { TeachingError } from "./types.js";

/**
 * The exporters, checked against the published artefacts rather than against
 * our reading of them.
 *
 * The SARIF half is the one that matters. A test that asserts our own object
 * shape proves nothing — it just restates the implementation — so the real
 * check runs the output through the normative OASIS schema, and a **negative
 * control** proves the check can fail: four deliberately corrupted logs must be
 * rejected. Without that control the schema test would pass just as happily
 * against a validator that returns `true` unconditionally, which is the failure
 * mode this repo has been bitten by before.
 *
 * Schema provenance is in `src/test-fixtures/README.md` with sha256s.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCHEMA_PATH = join(HERE, "test-fixtures", "sarif-schema-2.1.0.json");
const JUNIT_XSD = join(HERE, "test-fixtures", "junit-10.xsd");

const sarifSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

// ---------------------------------------------------------------------------
// A JSON Schema subset validator, sized to this one schema
// ---------------------------------------------------------------------------

/**
 * Enough of JSON Schema to validate against the OASIS SARIF schema, and no
 * more. Zero dependencies is the package's law and it applies to the tests too.
 *
 * The keyword inventory was enumerated from the schema file rather than
 * guessed: `$ref, type, enum, properties, required, additionalProperties,
 * items, oneOf, anyOf, pattern, minimum, maximum, minItems, uniqueItems,
 * format, default, title, description, definitions, id`. There is no `allOf`,
 * no `not`, no boolean schema and no `$id`, and `required` is an array
 * everywhere — so although the file declares draft-04, every keyword it
 * actually uses means the same thing in draft-04 and draft-07 and this
 * validator is exact rather than approximate for this input.
 *
 * Two shapes that do occur and are easy to get wrong, both handled below:
 * `type` is sometimes an array (`["array", "null"]`), and
 * `additionalProperties` is sometimes a schema object rather than `false`.
 */
type Schema = Record<string, any>;

function resolveRef(ref: string): Schema {
  if (!ref.startsWith("#/definitions/")) {
    throw new Error(`unexpected non-local $ref: ${ref}`);
  }
  const name = ref.slice("#/definitions/".length);
  const def = sarifSchema.definitions?.[name];
  if (!def) throw new Error(`unresolvable $ref: ${ref}`);
  return def;
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    default:
      throw new Error(`unknown type keyword: ${type}`);
  }
}

/** Returns a list of human-readable errors; empty means valid. */
function validate(value: unknown, schema: Schema, path = "$"): string[] {
  if (schema.$ref) return validate(value, resolveRef(schema.$ref), path);
  const errors: string[] = [];

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t: string) => typeMatches(value, t))) {
      errors.push(`${path}: expected ${types.join("|")}`);
      return errors; // further keywords assume the type held
    }
  }

  if (schema.enum !== undefined && !schema.enum.includes(value as never)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  }

  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: below minimum`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: above maximum`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (schema.uniqueItems === true) {
      const seen = value.map((v) => JSON.stringify(v));
      if (new Set(seen).size !== seen.length) {
        errors.push(`${path}: items are not unique`);
      }
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validate(item, schema.items, `${path}[${i}]`));
      });
    }
  }

  if (typeMatches(value, "object")) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) errors.push(`${path}: missing required "${req}"`);
    }
    for (const [key, child] of Object.entries(obj)) {
      const propSchema = schema.properties?.[key];
      if (propSchema) {
        errors.push(...validate(child, propSchema, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      ) {
        errors.push(
          ...validate(child, schema.additionalProperties, `${path}.${key}`),
        );
      }
    }
  }

  for (const key of ["oneOf", "anyOf"] as const) {
    if (!schema[key]) continue;
    const branches: string[][] = schema[key].map((s: Schema) =>
      validate(value, s, path),
    );
    const passing = branches.filter((b) => b.length === 0).length;
    if (key === "anyOf" && passing === 0) {
      errors.push(`${path}: matched no anyOf branch`);
    }
    if (key === "oneOf" && passing !== 1) {
      errors.push(`${path}: matched ${passing} oneOf branches, expected 1`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Findings to export
// ---------------------------------------------------------------------------

const provenance: ExportProvenance = {
  engineVersion: "0.7.0",
  profile: "xrechnung-ubl",
  rulesetVersions: { XRechnung: "3.0.2", "Peppol BIS Billing": "3.0.20" },
  documentUri: "invoices/INV-2026-001.xml",
  generatedAt: "2026-08-14T12:00:00Z",
  durationSeconds: 0.012,
};

const findings: TeachingError[] = [
  {
    rule: "BR-DE-1",
    field: "BT-10",
    severity: "fatal",
    message: "A German invoice must carry the buyer reference (BT-10).",
    fix: "Set buyerReference to the Leitweg-ID your client gave you.",
    xpath: "/ubl:Invoice/cbc:BuyerReference",
    docsUrl: "https://attestwire.com/docs/rules/BR-DE-1",
    example: '"buyerReference": "991-33333TEST-33"',
  },
  {
    rule: "BR-CO-15",
    field: ["BT-112", "BT-109"],
    severity: "warning",
    message: "The total with VAT does not equal the total without VAT plus VAT.",
    fix: "Recompute BT-112.",
    xpath: "/ubl:Invoice/cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount",
    docsUrl: "https://attestwire.com/docs/rules/BR-CO-15",
  },
  {
    rule: "BR-DE-1",
    field: "BT-10",
    severity: "information",
    message: "A second BR-DE-1 finding, to exercise rule deduplication.",
    fix: "Nothing; this exists to prove one descriptor is emitted for two results.",
    docsUrl: "https://attestwire.com/docs/rules/BR-DE-1",
  },
];

describe("toSarif", () => {
  it("validates against the normative OASIS SARIF 2.1.0 schema", () => {
    const log = toSarif(findings, provenance);
    expect(validate(log, sarifSchema)).toEqual([]);
  });

  it("validates with no findings, and with the minimum provenance", () => {
    expect(validate(toSarif([], { engineVersion: "0.7.0" }), sarifSchema)).toEqual(
      [],
    );
  });

  it("validates over every finding the real fixtures produce", () => {
    const result = validateInput({
      ...discountedXRechnung,
      buyerReference: undefined,
      orderReference: undefined,
    });
    const all = [...result.errors, ...result.warnings, ...result.information];
    expect(all.length).toBeGreaterThan(0);
    expect(validate(toSarif(all, provenance), sarifSchema)).toEqual([]);
  });

  // --- the negative control -------------------------------------------------
  //
  // Required. A schema test whose validator cannot reject anything is
  // indistinguishable from no test at all, so each of these must produce at
  // least one error, and the reason each is invalid is named.
  it("the schema check has teeth: corrupted logs are rejected", () => {
    const base = () => toSarif(findings, provenance) as any;

    const noVersion = base();
    delete noVersion.version; // root requires ["version", "runs"]
    expect(validate(noVersion, sarifSchema).length).toBeGreaterThan(0);

    const badLevel = base();
    badLevel.runs[0].results[0].level = "fatal"; // enum is none|note|warning|error
    expect(validate(badLevel, sarifSchema).length).toBeGreaterThan(0);

    const unknownKey = base();
    unknownKey.runs[0].nonsense = true; // additionalProperties: false on run
    expect(validate(unknownKey, sarifSchema).length).toBeGreaterThan(0);

    const noDriverName = base();
    delete noDriverName.runs[0].tool.driver.name; // toolComponent requires name
    expect(validate(noDriverName, sarifSchema).length).toBeGreaterThan(0);

    const wrongVersion = base();
    wrongVersion.version = "2.0.0"; // enum is exactly ["2.1.0"]
    expect(validate(wrongVersion, sarifSchema).length).toBeGreaterThan(0);
  });

  it("maps severity to SARIF level", () => {
    const log = toSarif(findings, provenance) as any;
    expect(log.runs[0].results.map((r: any) => r.level)).toEqual([
      "error",
      "warning",
      "note",
    ]);
  });

  it("deduplicates rule descriptors by id and indexes results into them", () => {
    const log = toSarif(findings, provenance) as any;
    const rules = log.runs[0].tool.driver.rules;
    expect(rules.map((r: any) => r.id)).toEqual(["BR-DE-1", "BR-CO-15"]);
    expect(log.runs[0].results.map((r: any) => r.ruleIndex)).toEqual([0, 1, 0]);
    for (const result of log.runs[0].results) {
      expect(rules[result.ruleIndex].id).toBe(result.ruleId);
    }
  });

  it("carries docsUrl as helpUri and xpath as a logical location", () => {
    const log = toSarif(findings, provenance) as any;
    expect(log.runs[0].tool.driver.rules[0].helpUri).toBe(
      "https://attestwire.com/docs/rules/BR-DE-1",
    );
    expect(
      log.runs[0].results[0].locations[0].logicalLocations[0]
        .fullyQualifiedName,
    ).toBe("/ubl:Invoice/cbc:BuyerReference");
  });

  it("puts the engine and ruleset versions in the tool metadata", () => {
    const driver = (toSarif(findings, provenance) as any).runs[0].tool.driver;
    expect(driver.version).toBe("0.7.0");
    expect(driver.semanticVersion).toBe("0.7.0");
    expect(driver.properties.rulesetVersions).toEqual({
      XRechnung: "3.0.2",
      "Peppol BIS Billing": "3.0.20",
    });
  });

  it("is pure: the same inputs serialise identically twice", () => {
    expect(JSON.stringify(toSarif(findings, provenance))).toBe(
      JSON.stringify(toSarif(findings, provenance)),
    );
  });

  it("omits a finding with no xpath from logical locations rather than inventing one", () => {
    const log = toSarif([findings[2]], {
      engineVersion: "0.7.0",
    }) as any;
    expect(log.runs[0].results[0].locations).toBeUndefined();
  });
});

describe("toJunitXml", () => {
  it("is well-formed XML this package's own reader accepts", () => {
    const xml = toJunitXml(findings, provenance);
    const root = parseXml(xml);
    expect(root.local).toBe("testsuite");
    expect(root.children.map((c) => c.local)).toContain("properties");
    expect(root.children.filter((c) => c.local === "testcase")).toHaveLength(3);
  });

  it("maps fatal to failure and leaves warning and information passing", () => {
    const xml = toJunitXml(findings, provenance);
    expect(xml.match(/<failure /g)?.length).toBe(1);
    expect(xml).toContain('failures="1"');
    expect(xml.match(/<system-out>/g)?.length).toBe(2);
  });

  it("promotes warnings only when asked", () => {
    const xml = toJunitXml(findings, provenance, { warningsAsFailures: true });
    expect(xml.match(/<failure /g)?.length).toBe(2);
    expect(xml).toContain('failures="2"');
    expect(xml).toContain('type="warning"');
  });

  it("a clean document is one passing test case, never an empty suite", () => {
    const xml = toJunitXml([], { engineVersion: "0.7.0" });
    expect(xml).toContain('tests="1"');
    expect(xml).toContain('failures="0"');
    expect(xml).toContain("no findings");
  });

  it("escapes markup, quotes and ampersands, and strips characters XML 1.0 forbids", () => {
    const nasty: TeachingError = {
      rule: "ATW-TEST",
      field: "BT-1",
      severity: "fatal",
      // A control character () cannot be escaped — it has to be removed,
      // or the document is not well-formed however it is encoded.
      message: 'A <tag> & an "amp" and a  control char',
      fix: "Fix the <thing> & move on",
      docsUrl: "https://attestwire.com/docs/rules/ATW-TEST",
    };
    const xml = toJunitXml([nasty], { engineVersion: "0.7.0" });
    expect(xml).not.toContain("");
    expect(xml).toContain("&lt;tag&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;");
    expect(() => parseXml(xml)).not.toThrow();
  });

  it("a message containing ]]> cannot break out, CDATA or not", () => {
    // There is no CDATA section in the output, and `>` is escaped as well as
    // `<`, so the sequence cannot re-form. Asserted rather than assumed,
    // because "we don't use CDATA" is a property of today's emitter.
    const xml = toJunitXml(
      [
        {
          rule: "ATW-TEST",
          field: "BT-1",
          severity: "fatal",
          message: "]]></failure></testcase></testsuite><injected/>",
          fix: "]]>",
        },
      ],
      { engineVersion: "0.7.0" },
    );
    expect(xml).not.toContain("]]>");
    expect(xml).not.toContain("<injected/>");
    const root = parseXml(xml);
    expect(root.local).toBe("testsuite");
  });

  it("drops unpaired surrogates but keeps real astral characters", () => {
    // A lone U+D800 is a legal JavaScript string element and not an XML
    // character at all: it has no UTF-8 encoding, so a report carrying one is
    // ill-formed however carefully everything around it is escaped. A
    // well-formed pair is a real character and must survive untouched.
    const xml = toJunitXml(
      [
        {
          rule: "ATW-TEST",
          field: "BT-27",
          severity: "fatal",
          message: "Seller \uD800 name 😀 here",
          fix: "Trailing low surrogate \uDC00",
        },
      ],
      { engineVersion: "0.7.0" },
    );
    expect(xml).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(xml).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(xml).toContain("😀");
    // The whole point: it still parses, and Buffer can encode it.
    expect(() => parseXml(xml)).not.toThrow();
    expect(Buffer.from(xml, "utf8").toString("utf8")).toBe(xml);
  });

  it("carries provenance as suite properties", () => {
    const xml = toJunitXml(findings, provenance);
    expect(xml).toContain('<property name="engineVersion" value="0.7.0"/>');
    expect(xml).toContain('name="ruleset.XRechnung" value="3.0.2"');
  });

  it("is pure: the same inputs produce identical bytes twice", () => {
    expect(toJunitXml(findings, provenance)).toBe(
      toJunitXml(findings, provenance),
    );
  });

  // The de-facto artefact, used for what it is worth and no more — see
  // src/test-fixtures/README.md. Skipped where libxml2 is absent so the suite
  // still runs; the structural assertions above do not depend on it.
  it.skipIf(!existsSync("/usr/bin/xmllint"))(
    "validates against the Jenkins xUnit junit-10.xsd",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "en16931-junit-"));
      const file = join(dir, "report.xml");
      for (const xml of [
        toJunitXml(findings, provenance),
        toJunitXml([], { engineVersion: "0.7.0" }),
        toJunitXml(findings, provenance, { warningsAsFailures: true }),
      ]) {
        writeFileSync(file, xml);
        expect(() =>
          execFileSync(
            "/usr/bin/xmllint",
            ["--noout", "--schema", JUNIT_XSD, file],
            { stdio: "pipe" },
          ),
        ).not.toThrow();
      }
    },
  );
});
