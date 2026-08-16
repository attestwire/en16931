/**
 * Findings → the two report formats CI systems already read.
 *
 * `validateInput` returns `TeachingError[]`, which is the right shape for a
 * human and the wrong shape for a build pipeline. GitHub's code-scanning UI
 * ingests SARIF; almost every other CI system — Jenkins, GitLab, CircleCI,
 * Buildkite, Azure Pipelines — ingests the JUnit XML that Ant's `junitreport`
 * task defined and Maven Surefire extended. Neither is hard to produce, and
 * producing neither is the difference between "the validator printed something"
 * and "the pull request shows the failing rule on the failing line".
 *
 * Both functions here are **pure**. No I/O, no clock: every varying value —
 * the engine version, the ruleset versions, the timestamp, the document URI —
 * arrives in `provenance`, so the same inputs give byte-identical output and a
 * caller can diff two reports without a timestamp making every line change.
 * Reading the package version off disk at runtime would have been convenient
 * and would have made this module impure and unbundleable; the caller knows its
 * own version and passes it.
 *
 * What this module deliberately does not do is decide whether your build fails.
 * `toSarif` writes the severity the rule carries and stops there — SARIF has no
 * "fail the build" flag, and GitHub's own gate is configured in the repository,
 * not in the file. `toJunitXml` maps to `<failure>` on a rule this package
 * calls fatal, and the mapping is stated below rather than left to be inferred.
 */

import { escapeAttr, escapeText, stripInvalidXmlChars } from "./xml.js";
import type { Severity, TeachingError } from "./types.js";

/**
 * Where the report came from — everything that varies between runs and must not
 * be read from the environment by a pure function.
 *
 * `engineVersion` is the only required field. A report that cannot say which
 * version of the validator produced it is not evidence of anything, and this is
 * a package whose entire value proposition is that its verdicts are traceable
 * to an authority.
 */
export interface ExportProvenance {
  /** Version of this package, e.g. `"0.7.0"`. Required: an untraceable report is not evidence. */
  engineVersion: string;
  /** The profile the document was validated against, e.g. `"xrechnung-ubl"`. */
  profile?: string;
  /**
   * Versions of the external rule sets this run's verdicts correspond to, e.g.
   * `{ "XRechnung": "3.0.2", "Peppol BIS Billing": "3.0.20" }`. Emitted as
   * SARIF `tool.driver.properties` / JUnit `<properties>`, because "which
   * schematron release said so" is the first question anyone disputing a
   * finding asks.
   */
  rulesetVersions?: Readonly<Record<string, string>>;
  /**
   * URI of the document that was validated. Becomes the SARIF artifact
   * location, which is what makes a finding appear against a file in a code
   * scanning UI rather than floating free of one.
   */
  documentUri?: string;
  /** ISO 8601 timestamp. Supplied, never read from the clock — see the module note on purity. */
  generatedAt?: string;
  /** Seconds the validation took, for the JUnit `time` attribute. Omitted → `0`. */
  durationSeconds?: number;
  /** Overrides the JUnit `<testsuite name>` / SARIF run name. Defaults to `"en16931"`. */
  suiteName?: string;
}

/** Our three severities → SARIF `level`. */
const SARIF_LEVEL: Readonly<Record<Severity, "error" | "warning" | "note">> = {
  fatal: "error",
  warning: "warning",
  information: "note",
};

const DEFAULT_SUITE = "en16931";
const TOOL_NAME = "@attestwire/en16931";
const TOOL_URI = "https://attestwire.com";

/** Findings in, findings out — accepts a `ValidationResult`'s three arrays concatenated. */
export type Findings = readonly TeachingError[];

function fieldList(field: TeachingError["field"]): string[] {
  return Array.isArray(field) ? [...field] : [field];
}

/**
 * Stable, deduplicated rule descriptors in first-appearance order.
 *
 * SARIF wants every rule described once in `tool.driver.rules` and referenced
 * from each result by index. First-appearance order rather than alphabetical
 * because it makes the diff between two reports of the same document minimal:
 * a rule that starts firing appends, it does not renumber everything after it.
 * Where the same id appears twice with different text — which happens when a
 * rule is parameterised by line number — the first occurrence wins and defines
 * the descriptor, and the per-result `message` carries the specific text.
 */
function ruleDescriptors(findings: Findings) {
  const index = new Map<string, number>();
  const rules: Record<string, unknown>[] = [];
  for (const f of findings) {
    if (index.has(f.rule)) continue;
    index.set(f.rule, rules.length);
    const terms = fieldList(f.field).join(", ");
    const descriptor: Record<string, unknown> = {
      id: f.rule,
      name: f.rule,
      shortDescription: { text: `${f.rule} (${terms})` },
      fullDescription: { text: f.message },
      help: { text: f.fix },
      defaultConfiguration: { level: SARIF_LEVEL[f.severity] },
      properties: { businessTerms: fieldList(f.field) },
    };
    if (f.docsUrl) descriptor.helpUri = f.docsUrl;
    rules.push(descriptor);
  }
  return { rules, index };
}

/**
 * The SARIF 2.1.0 log for a set of findings.
 *
 * Returns an **object**, not a string. SARIF is consumed as JSON by every tool
 * that reads it, a caller who wants bytes writes `JSON.stringify(log, null, 2)`
 * and controls their own indentation, and returning an object lets a caller
 * merge our run into a multi-run log — which is the normal shape when a
 * pipeline validates several invoices — without reparsing what we just
 * serialised. `toJunitXml` returns a string for the mirror reason: XML has no
 * useful intermediate representation, and there is nothing to merge into.
 *
 * The output validates against the normative OASIS schema; `export.test.ts`
 * checks that against the schema file itself rather than against our reading of
 * it, and proves the check has teeth with a corrupted-input negative control.
 */
export function toSarif(
  findings: Findings,
  provenance: ExportProvenance,
): Record<string, unknown> {
  const { rules, index } = ruleDescriptors(findings);
  const artifactLocation = provenance.documentUri
    ? { uri: provenance.documentUri }
    : undefined;

  const results = findings.map((f) => {
    const result: Record<string, unknown> = {
      ruleId: f.rule,
      ruleIndex: index.get(f.rule),
      level: SARIF_LEVEL[f.severity],
      message: { text: f.message },
    };
    // An XPath is a location in the document's logical structure, not a byte
    // offset, and SARIF has a slot for exactly that. Emitting it as a physical
    // location with a fabricated line number would be a lie a UI would then
    // draw an underline at.
    const location: Record<string, unknown> = {};
    if (f.xpath) {
      location.logicalLocations = [
        { fullyQualifiedName: f.xpath, kind: "member" },
      ];
    }
    if (artifactLocation) {
      location.physicalLocation = { artifactLocation };
    }
    if (Object.keys(location).length > 0) result.locations = [location];

    const properties: Record<string, unknown> = {
      businessTerms: fieldList(f.field),
      fix: f.fix,
    };
    if (f.example !== undefined) properties.example = f.example;
    result.properties = properties;
    return result;
  });

  const driver: Record<string, unknown> = {
    name: TOOL_NAME,
    version: provenance.engineVersion,
    semanticVersion: provenance.engineVersion,
    informationUri: TOOL_URI,
    rules,
  };
  const driverProperties: Record<string, unknown> = {};
  if (provenance.profile) driverProperties.profile = provenance.profile;
  if (provenance.rulesetVersions) {
    driverProperties.rulesetVersions = { ...provenance.rulesetVersions };
  }
  if (Object.keys(driverProperties).length > 0) {
    driver.properties = driverProperties;
  }

  const run: Record<string, unknown> = {
    tool: { driver },
    results,
  };
  if (artifactLocation) run.artifacts = [{ location: artifactLocation }];
  if (provenance.generatedAt) {
    // `invocations` is where SARIF puts run-time facts. `executionSuccessful`
    // describes whether the *validator* ran, not whether the document passed —
    // a validator that cleanly rejects an invoice has succeeded.
    run.invocations = [
      { executionSuccessful: true, endTimeUtc: provenance.generatedAt },
    ];
  }
  run.automationDetails = { id: provenance.suiteName ?? DEFAULT_SUITE };

  return {
    $schema:
      "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [run],
  };
}

/**
 * How a finding becomes a JUnit test case.
 *
 * The mapping is the interesting decision in this function, so it is stated
 * rather than buried:
 *
 *   - **fatal → `<failure>`.** Red in every CI UI, and correct: the regulator
 *     rejects the document.
 *   - **warning → `<failure type="warning">`, but only when
 *     `warningsAsFailures` is set.** Off by default. A warning here is a
 *     finding KoSIT raises and then *accepts the document anyway*, and turning
 *     a green build red for one would misrepresent the authority — the same
 *     reasoning that keeps `information` out of `warnings` in
 *     `ValidationResult`. Off, a warning is a passing test case with the text
 *     in `<system-out>`, so it is visible in the report without gating the
 *     build. On, it is a failure, for the team that wants a clean document.
 *   - **information → always a passing test case with `<system-out>`.** Never
 *     gates anything, under any option.
 *
 * There is no `<error>` anywhere. JUnit's distinction is failure = assertion
 * failed, error = the test itself blew up; a rule that fires is the former, and
 * an exception out of the validator never reaches this function.
 */
export interface JunitOptions {
  /** Promote `warning` findings to `<failure type="warning">`. Default `false` — see above. */
  warningsAsFailures?: boolean;
}

/** Text safe for an XML text node: invalid XML 1.0 characters removed, then escaped. */
function text(value: string): string {
  return escapeText(stripInvalidXmlChars(value));
}

/** Text safe for an attribute value. */
function attrText(value: string): string {
  return escapeAttr(stripInvalidXmlChars(value));
}

/**
 * The JUnit XML report for a set of findings.
 *
 * A clean document produces a suite with one passing test case rather than an
 * empty one: a report with zero test cases reads as "the validator did not run"
 * in most CI UIs, and that is the one thing this package refuses to let a
 * report say by accident — the same argument the Peppol conformance record
 * makes about rules-fired counts.
 */
export function toJunitXml(
  findings: Findings,
  provenance: ExportProvenance,
  options: JunitOptions = {},
): string {
  const suite = provenance.suiteName ?? DEFAULT_SUITE;
  const asFailure = (s: Severity): boolean =>
    s === "fatal" || (s === "warning" && options.warningsAsFailures === true);

  const failures = findings.filter((f) => asFailure(f.severity)).length;
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');

  const suiteAttrs = [
    `name="${attrText(suite)}"`,
    `tests="${Math.max(findings.length, 1)}"`,
    `failures="${failures}"`,
    `errors="0"`,
    `skipped="0"`,
    `time="${(provenance.durationSeconds ?? 0).toFixed(3)}"`,
  ];
  if (provenance.generatedAt) {
    suiteAttrs.push(`timestamp="${attrText(provenance.generatedAt)}"`);
  }
  // Root is `<testsuite>`, not `<testsuites>`. There is no official JUnit
  // schema, and the de-facto one — the Jenkins xUnit plugin's `junit-10.xsd`,
  // checked into `src/test-fixtures/` — declares `testsuite` as a root element
  // and does not declare `testsuites` at all. Emitting the plural wrapper would
  // produce a document that the closest thing to an authority rejects, for the
  // sake of a nesting level with exactly one child. A reader that wants the
  // wrapper accepts the singular form too; the reverse is not true.
  lines.push(`<testsuite ${suiteAttrs.join(" ")}>`);

  const properties: [string, string][] = [
    ["engineVersion", provenance.engineVersion],
  ];
  if (provenance.profile) properties.push(["profile", provenance.profile]);
  if (provenance.documentUri) {
    properties.push(["documentUri", provenance.documentUri]);
  }
  for (const [name, version] of Object.entries(
    provenance.rulesetVersions ?? {},
  )) {
    properties.push([`ruleset.${name}`, version]);
  }
  lines.push("  <properties>");
  for (const [name, value] of properties) {
    lines.push(
      `    <property name="${attrText(name)}" value="${attrText(value)}"/>`,
    );
  }
  lines.push("  </properties>");

  if (findings.length === 0) {
    lines.push(
      `  <testcase name="no findings" classname="${attrText(suite)}" time="0.000">`,
    );
    lines.push(
      `    <system-out>The document produced no findings under profile ${text(provenance.profile ?? "en16931")}.</system-out>`,
    );
    lines.push("  </testcase>");
  }

  findings.forEach((f, i) => {
    // classname is what CI UIs group by, so the business term goes there: a
    // developer scanning a run sees "every BT-46 finding" as one group rather
    // than a flat list ordered by whatever order the rules happen to run in.
    const terms = fieldList(f.field).join(",");
    const name = `${f.rule} (${terms}) #${i + 1}`;
    lines.push(
      `  <testcase name="${attrText(name)}" classname="${attrText(`${suite}.${terms}`)}" time="0.000">`,
    );
    const body = [
      f.message,
      "",
      `Fix: ${f.fix}`,
      f.example === undefined ? "" : `Example: ${f.example}`,
      f.xpath === undefined ? "" : `XPath: ${f.xpath}`,
      f.docsUrl ? `Docs: ${f.docsUrl}` : "",
    ]
      .filter((l) => l !== "")
      .join("\n");
    if (asFailure(f.severity)) {
      lines.push(
        `    <failure message="${attrText(f.message)}" type="${attrText(f.severity)}">${text(body)}</failure>`,
      );
    } else {
      lines.push(`    <system-out>${text(body)}</system-out>`);
    }
    lines.push("  </testcase>");
  });

  lines.push("</testsuite>");
  return `${lines.join("\n")}\n`;
}
