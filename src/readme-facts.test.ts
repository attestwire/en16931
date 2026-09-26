import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodeModule from "node:module";
import { join } from "node:path";
import { formatWithOptions } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as engine from "./index.js";
import { SCENARIO_CATEGORY, scenarioExemption } from "./vat-scenarios.js";
import type { InvoiceFacts, InvoiceInput, VatScenario } from "./types.js";

// The README's "Say what happened, not the code" section makes the same kind
// of claims as the quickstart, so it is held to the same standard as
// `readme-quickstart.test.ts` holds that one: its snippets are extracted and
// executed, every `console.log` must print what its comment says, the snippets
// compile as TypeScript against the built declarations, and the scenario table
// must say what the engine does.

const { createRequire } = nodeModule;

// Needs Node >= 22.13 to run the snippets, as the quickstart test does.
const stripTypeScriptTypes = (
  nodeModule as { stripTypeScriptTypes?: (source: string) => string }
).stripTypeScriptTypes;
const canRunSnippets = typeof stripTypeScriptTypes === "function";

const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");

/** The level-2 section with this heading, up to the next level-2 heading. */
function sectionOf(heading: string): string {
  const start = readme.indexOf(`\n## ${heading}\n`);
  expect(start, `README.md has no "## ${heading}" section`).toBeGreaterThan(-1);
  const rest = readme.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

const section = sectionOf("Say what happened, not the code");
const tsBlocks = [...section.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!);

/** The names the snippets import from the package, types left out. */
const importedNames = (): string[] => {
  const names = new Set<string>();
  for (const block of tsBlocks) {
    for (const m of block.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@attestwire\/en16931"/g)) {
      for (const part of m[1]!.split(",")) {
        const name = part.trim();
        if (name !== "" && !name.startsWith("type ")) names.add(name);
      }
    }
  }
  return [...names];
};

interface Run {
  logged: string[];
  facts: InvoiceFacts;
  result: ReturnType<typeof engine.validateInput>;
  invoice: InvoiceInput;
  xml: string;
  creditNote: InvoiceInput;
}

/** Run every snippet in the section, in order, in one scope, as a reader would paste them. */
function runSection(): Run {
  const names = importedNames();
  const source = tsBlocks
    .join("\n")
    .split("\n")
    .filter((line) => !/^import\s/.test(line))
    .join("\n");
  const body = `${stripTypeScriptTypes!(source)}\nreturn { facts, result, invoice, xml, creditNote };\n`;
  const logged: string[] = [];
  const fakeConsole = {
    log: (...args: unknown[]) => logged.push(formatWithOptions({ colors: false }, ...args)),
  };
  // eslint-disable-next-line no-new-func
  const run = new Function(...names, "console", body) as (...args: unknown[]) => Omit<Run, "logged">;
  const out = run(...names.map((name) => (engine as Record<string, unknown>)[name]), fakeConsole);
  return { logged, ...out };
}

describe("README: Say what happened, not the code", () => {
  it("has the two snippets it describes", () => {
    expect(tsBlocks.length).toBe(2);
    expect(importedNames()).toEqual(["applyDefaults", "generateXRechnungUBL", "validateInput", "createCreditNote"]);
  });

  it.skipIf(!canRunSnippets)("prints what it says it prints", () => {
    const stated = tsBlocks
      .join("\n")
      .split("\n")
      .filter((line) => line.includes("console.log("))
      .map((line) => /\/\/ (.*)$/.exec(line)![1]!.trim());
    expect(runSection().logged).toEqual(stated);
  });

  it.skipIf(!canRunSnippets)("states facts that are valid, and XML that is the explicit invoice's", () => {
    const { facts, result, invoice, xml } = runSection();
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(xml).toBe(engine.generateXRechnungUBL(invoice));
    expect(engine.validateInput(invoice).information).toEqual([]);
    expect(engine.applyDefaults(facts).invoice).toEqual(invoice);
  });

  it.skipIf(!canRunSnippets)("builds a credit note that passes", () => {
    const { creditNote } = runSection();
    const result = engine.validateInput(creditNote);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(engine.generateXRechnungUBL(creditNote)).toContain("<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>");
  });

  it("tabulates what the engine writes for each scenario", () => {
    const rows = [...section.matchAll(/^\| `"([a-z-]+)"` \| ([A-Z]+), ([^|]+) \| ([^|]+) \| ([^|]+) \|/gm)];
    expect(rows.map((row) => row[1])).toEqual([...engine.VAT_SCENARIOS]);
    for (const [, name, category, , code, texts] of rows) {
      const scenario = name as VatScenario;
      expect(category, scenario).toBe(SCENARIO_CATEGORY[scenario]);
      const [de, fr, other] = texts!.split(" · ").map((t) => t.trim());
      if (scenario === "domestic") {
        expect(texts!.trim()).toBe("—");
        continue;
      }
      expect(de, scenario).toBe(scenarioExemption(scenario, "DE")!.text);
      expect(fr, scenario).toBe(scenarioExemption(scenario, "FR")!.text);
      if (scenario === "small-business-exemption") {
        expect(other).toBe("refused");
        expect(scenarioExemption(scenario, "BE")).toBeUndefined();
        expect(code).toContain("`VATEX-FR-FRANCHISE` in France; none in Germany");
        expect(scenarioExemption(scenario, "FR")!.code).toBe("VATEX-FR-FRANCHISE");
        expect(scenarioExemption(scenario, "DE")!.code).toBeUndefined();
      } else {
        expect(other, scenario).toBe(scenarioExemption(scenario, "BE")!.text);
        expect(code!.trim(), scenario).toBe(`\`${scenarioExemption(scenario, "DE")!.code}\``);
      }
    }
  });

  // The same guard the quickstart has: executing a snippet does not type-check
  // it, and a ```ts fence claims it compiles. This compiles both snippets
  // against the built declarations (`npm run build` first), strict.
  it("compiles under the package's own tsconfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "attestwire-readme-facts-"));
    try {
      const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
      const entry = join(pkgRoot, "dist", "index.js");
      // One import line per snippet, merged: two imports of one module are legal
      // TypeScript, but the second snippet's is written to be pasted after the first.
      const source = tsBlocks
        .join("\n")
        .replace(/from "@attestwire\/en16931"/g, `from ${JSON.stringify(entry)}`);
      writeFileSync(join(dir, "facts.ts"), source);
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noUncheckedIndexedAccess: true,
            skipLibCheck: true,
            noEmit: true,
            types: [],
          },
          files: ["facts.ts"],
        }),
      );
      const tscBin = join(createRequire(import.meta.url).resolve("typescript"), "..", "..", "bin", "tsc");
      try {
        execFileSync(process.execPath, [tscBin, "-p", dir], { stdio: "pipe", encoding: "utf8" });
      } catch (err) {
        const out = err as { stdout?: string; stderr?: string };
        throw new Error(`the README facts section does not compile:\n${out.stdout ?? ""}${out.stderr ?? ""}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
