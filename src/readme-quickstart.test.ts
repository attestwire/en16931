import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { formatWithOptions } from "node:util";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { validateInput } from "./index.js";
import type { InvoiceInput } from "./types.js";

// The README's quickstart is the first thing a developer sees on npmjs.com, and
// a published tarball cannot be edited. So the two snippets in it are not
// copy-and-pasted prose: this file EXTRACTS them from README.md and RUNS them
// against the shipped engine, the way apps/site/build.mjs runs the snippets it
// prints before it prints them. A stated `console.log` output is a factual
// claim like any other; if the library's answer changes, this suite fails
// rather than the README quietly going stale.
//
// TWO CHECKS, BECAUSE EXECUTING A SNIPPET DOES NOT TYPE-CHECK IT. The snippets
// are fenced as ```ts and a reader will paste them into a .ts file, so "it runs"
// is only half the claim. Running them means erasing the types, and an earlier
// revision of this file did exactly that and nothing else — so the published
// quickstart declared `profile: "xrechnung-ubl"` with no `satisfies`, TypeScript
// widened it to `string`, and the very next line (`validateInput(invoice)`)
// failed to compile with TS2345 twice over, in a suite that was green. The
// transpile below erases types for execution; `tsc --noEmit` at the bottom
// compiles them for real, against this package's own tsconfig.

/* eslint-disable no-new-func */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const readme = read("../README.md");
const pkg = JSON.parse(read("../package.json")) as {
  name: string;
  version: string;
};

/** The `## Quickstart` section, up to the next level-2 heading. */
function quickstartSection(): string {
  const start = readme.indexOf("\n## Quickstart\n");
  expect(start, "README.md has no `## Quickstart` section").toBeGreaterThan(-1);
  const rest = readme.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every fenced block of the given language, in document order. */
function fencedBlocks(section: string, lang: string): string[] {
  const out: string[] = [];
  const re = new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g");
  for (const m of section.matchAll(re)) out.push(m[1]);
  return out;
}

const section = quickstartSection();
const bash = fencedBlocks(section, "bash");
const tsBlocks = fencedBlocks(section, "ts");
const json = fencedBlocks(section, "json");

/**
 * Run both quickstart snippets, in order, in one scope — snippet 2 destructures
 * the invoice snippet 1 declares, exactly as a reader pasting them would.
 *
 * `import` lines are dropped and the bindings injected instead; nothing else is
 * rewritten, so what executes is the text on the page. `console.log` is
 * captured and formatted the way Node formats it, so the `// …` comment at the
 * end of each log line can be compared with what the call actually printed.
 */
function runQuickstart(): {
  logged: string[];
  invoice: InvoiceInput;
  result: ReturnType<typeof validateInput>;
  rejected: ReturnType<typeof validateInput>;
} {
  // Erase the types, then run. `satisfies InvoiceInput` and `type` imports are
  // TypeScript-only syntax and `new Function` would throw on either, so the
  // snippets go through the compiler's transpiler first — which strips types and
  // touches nothing else, so what executes is still the text on the page.
  const source = tsBlocks
    .join("\n")
    .split("\n")
    .filter((l) => !/^import\s/.test(l))
    .join("\n");
  const body =
    ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText + "\nreturn { invoice, result, rejected };\n";

  const logged: string[] = [];
  const fakeConsole = {
    log: (...args: unknown[]) =>
      logged.push(formatWithOptions({ colors: false }, ...args)),
  };

  // eslint-disable-next-line no-new-func
  const run = new Function("validateInput", "console", body) as (
    v: typeof validateInput,
    c: unknown,
  ) => { invoice: InvoiceInput; result: never; rejected: never };

  const out = run(validateInput, fakeConsole);
  return { logged, ...out };
}

/** The `// …` claim at the end of each `console.log` line, in order. */
function statedOutputs(): string[] {
  return tsBlocks
    .join("\n")
    .split("\n")
    .filter((l) => l.includes("console.log("))
    .map((l) => {
      const m = /\/\/ (.*)$/.exec(l);
      expect(m, `a quickstart console.log states no output: ${l}`).not.toBeNull();
      return (m as RegExpExecArray)[1].trim();
    });
}

describe("README quickstart", () => {
  it("leads with an install command that matches the package", () => {
    expect(bash.length, "the quickstart has no ```bash install block").toBeGreaterThan(0);
    const install = bash[0].trim();
    expect(install).toBe(`npm install ${pkg.name}`);

    // If a version is ever pinned in the command, it must be this one.
    const pinned = /@(\d+\.\d+\.\d+[^\s]*)\s*$/.exec(install);
    if (pinned) expect(pinned[1]).toBe(pkg.version);

    // The install block comes before any code block: passing-first is the house
    // rule, and it starts with being able to install the thing.
    expect(section.indexOf("```bash")).toBeLessThan(section.indexOf("```ts"));
  });

  it("has exactly two code snippets and one error object", () => {
    expect(tsBlocks.length).toBe(2);
    expect(json.length).toBe(1);
  });

  it("the first snippet's invoice really is valid", () => {
    const { invoice } = runQuickstart();
    const result = validateInput(invoice);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.information).toEqual([]);
  });

  it("the second snippet trips exactly BR-DE-15 and nothing else", () => {
    const { rejected } = runQuickstart();
    expect(rejected.valid).toBe(false);
    expect(rejected.errors.map((e) => e.rule)).toEqual(["BR-DE-15"]);
    expect(rejected.errors.every((e) => e.severity === "fatal")).toBe(true);
    expect(rejected.warnings).toEqual([]);
    expect(rejected.information).toEqual([]);
  });

  it("prints what it says it prints", () => {
    const { logged } = runQuickstart();
    expect(logged).toEqual(statedOutputs());
  });

  it("quotes the error object the engine actually returns", () => {
    const { rejected } = runQuickstart();
    expect(JSON.parse(json[0])).toEqual(JSON.parse(JSON.stringify(rejected.errors[0])));
  });
});

// THE GUARD THE EXECUTION TESTS STRUCTURALLY CANNOT BE. Everything above runs
// the snippets with their types erased, so it proves the JavaScript works and
// says nothing about whether the TypeScript compiles — which is the only claim a
// ```ts fence actually makes. This compiles them, unerased, against this
// package's own tsconfig (`strict`, `NodeNext`), with the import rewritten to the
// built entry point so it resolves the same declarations a consumer gets.
describe("README quickstart type-checks", () => {
  it("compiles under the package's own tsconfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "attestwire-readme-ts-"));
    try {
      const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
      const entry = join(pkgRoot, "dist", "index.d.ts").replace(/\.d\.ts$/, ".js");
      const source = tsBlocks
        .join("\n")
        // The snippet imports by package name; inside a temp directory that does
        // not resolve, so point it at this build. Nothing else is rewritten.
        .replace(/from "@attestwire\/en16931"/g, `from ${JSON.stringify(entry)}`);

      const file = join(dir, "quickstart.ts");
      writeFileSync(file, source);
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
          files: ["quickstart.ts"],
        }),
      );

      try {
        // Resolved rather than path-joined: npm hoists `typescript` to the
        // workspace root, so packages/en16931/node_modules/typescript may not
        // exist even though the import at the top of this file works.
        const tscBin = join(
          createRequire(import.meta.url).resolve("typescript"),
          "..",
          "..",
          "bin",
          "tsc",
        );
        execFileSync(process.execPath, [tscBin, "-p", dir], {
          stdio: "pipe",
          encoding: "utf8",
        });
      } catch (err) {
        const out = (err as { stdout?: string; stderr?: string });
        throw new Error(
          "the README quickstart does not compile as TypeScript:\n" +
            `${out.stdout ?? ""}${out.stderr ?? ""}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// THE README STATES THE REACHABLE-RULE COUNT TWICE, AND THE TWO DISAGREED.
// The capability table said 294 distinct ids of which 265 are reachable and 29
// are arithmetic invariants; the limitations table, 400 lines later, still said
// 262 — a figure from before three rule families became reachable in 0.4.0. Both
// are hand-typed copies of a number the suite derives, so the copy nobody
// scrolled to went stale, and it understated the product on the one page a
// sceptical reader reads hardest. Nothing here re-derives the count (that is
// `rules-invariants.test.ts`, which owns it): this asserts only that every copy
// in the README says the same thing, and that the three numbers add up.
describe("README rule counts", () => {
  const stated = [...readme.matchAll(/(\d{3})\s+(?:rule ids\s+)?(?:are\s+)?reachable/g)].map(
    (m) => Number(m[1]),
  );

  it("states the reachable count the same way everywhere it states it", () => {
    expect(stated.length, "the README stopped stating a reachable-rule count").toBeGreaterThan(1);
    expect(new Set(stated).size, `the README states ${new Set(stated).size} different reachable counts: ${[...new Set(stated)].join(", ")}`).toBe(1);
  });

  it("reachable + arithmetic invariants = the distinct total", () => {
    const total = /(\d{3}) distinct rule ids/.exec(readme);
    const invariants = /the other (\d{2}) constrain the library's own computed arithmetic/.exec(readme);
    expect(total, "the README no longer states a distinct rule-id total").not.toBeNull();
    expect(invariants, "the README no longer states an arithmetic-invariant count").not.toBeNull();
    expect(stated[0]! + Number((invariants as RegExpExecArray)[1])).toBe(
      Number((total as RegExpExecArray)[1]),
    );
  });
});

describe("README teaching-errors section", () => {
  // The section states a three-finding count for the quickstart invoice minus
  // three fields. Derived here rather than trusted: an earlier revision claimed
  // "errors: 3  warnings: 2" and the real answer was 3 fatal, 0 warnings and
  // one `information` advisory.
  it("states the count the engine produces", () => {
    const { invoice } = runQuickstart();
    const { buyerReference, payment, ...rest } = invoice as InvoiceInput & {
      payment?: unknown;
    };
    void buyerReference;
    void payment;
    const stripped = {
      ...rest,
      seller: { ...rest.seller, contact: undefined },
    } as InvoiceInput;

    const result = validateInput(stripped);
    expect(result.errors.map((e) => e.rule)).toEqual(["BR-DE-15", "BR-DE-1", "BR-DE-2"]);
    expect(result.warnings).toEqual([]);
    expect(result.information).toEqual([]);

    const prose = readme.slice(readme.indexOf("\n## Teaching errors\n"));
    expect(prose).toContain("`BR-DE-15`, `BR-DE-1`, `BR-DE-2`");
    expect(prose).toMatch(/three fatal findings/);
  });
});
