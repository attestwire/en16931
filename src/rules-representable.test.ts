import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateInput } from "./index.js";
import { withInvoice } from "./testkit.js";

// The type check in rules-representable.ts works from a hand-kept list of the
// input model's text fields. Seven were missing until 2026-09-23 (review): an
// object in `deliverToName`, `schemeVersion` or `mandateReference` passed
// validation and then made the generator throw, a 500 from the hosted API.
// The list is checked against the types it mirrors, so a new text field in
// InvoiceInput cannot be left out again.
describe("the input type check", () => {
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

  it("knows every text field the input model declares", () => {
    // Properties declared `name: string` or `name?: string` in types.ts, less
    // the ones that belong to the library's OUTPUT (TeachingError, and the
    // SourceLocation `validate` attaches: `path`, `attachment`) and the
    // reader-set declaredTotals.specificationIdentifier.
    const OUTPUT_OR_READER = new Set([
      "docsUrl",
      "example",
      "fix",
      "message",
      "xpath",
      "path",
      "attachment",
      "specificationIdentifier",
    ]);
    // `name: string`, `readonly name?: string | undefined`, and string-literal
    // unions such as `"a" | "b"`, with or without the closing semicolon. A
    // first version matched only `name?: string;` exactly (review, 2026-09-23).
    const TEXT_PROPERTY =
      /^\s+(?:readonly\s+)?(\w+)\??:\s*(?:string(?:\s*\|\s*(?:undefined|null))*|"[^"]*"(?:\s*\|\s*"[^"]*")*)\s*;?\s*(?:\/\/.*)?$/gm;
    const declared = [...source("./types.ts").matchAll(TEXT_PROPERTY)]
      .map((m) => m[1]!)
      .filter((key) => !OUTPUT_OR_READER.has(key));
    const list = /const STRING_KEYS = new Set\(\[([\s\S]*?)\]\);/.exec(source("./rules-representable.ts"))![1]!;
    const known = new Set([...list.matchAll(/"(\w+)"/g)].map((m) => m[1]));
    expect([...new Set(declared)].filter((key) => !known.has(key)).sort()).toEqual([]);
  });

  it("reports an object in a text field instead of letting the generator throw on it", () => {
    const result = validateInput(withInvoice({ deliverToName: { toString: "x" } as unknown as string }));
    const finding = result.errors.find((e) => e.rule === "ATW-INPUT-TYPE");
    expect(finding?.message).toMatch(/^deliverToName should be text, but it is an object\./);
  });
});
