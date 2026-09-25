import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { validateInput } from "./index.js";
import { validate } from "./validate.js";
import { withInvoice } from "./testkit.js";
import type { InvoiceInput } from "./types.js";

/**
 * The two entry points, handed the other one's input, or no input at all.
 *
 * `validateInput(undefined)` — what an Express route without a body parser
 * passes — threw a TypeError from inside a rule, and `validateInput(xml)` came
 * back as nine findings about fields a string was never going to have (DX
 * audit, 2026-09-24). Each is now one finding that names the right function.
 */
describe("validateInput, given something that is not an invoice object", () => {
  const asInput = (value: unknown) => value as InvoiceInput;
  const xml = readFileSync(fileURLToPath(new URL("../fixtures/xrechnung-ubl-minimal.xml", import.meta.url)), "utf8");

  const cases: [string, unknown, RegExp][] = [
    ["undefined", undefined, /given undefined\./],
    ["null", null, /given null\./],
    ["a number", 42, /given a number\./],
    ["an array", [], /given an array\./],
    ["plain text", "invoice 2026-000142", /given text\./],
    ["JSON text", '{"profile":"xrechnung-ubl"}', /given text\./],
    ["XML text", xml, /given text that starts like an XML or PDF document\./],
    ["PDF text", "%PDF-1.7\n", /given text that starts like an XML or PDF document\./],
    ["a Uint8Array", new TextEncoder().encode(xml), /given the bytes of a file\./],
    ["an ArrayBuffer", new ArrayBuffer(8), /given the bytes of a file\./],
  ];

  for (const [label, value, said] of cases) {
    it(`returns one fatal ATW-INPUT-TYPE for ${label}, and does not throw`, () => {
      const result = validateInput(asInput(value));
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.warnings).toEqual([]);
      expect(result.information).toEqual([]);
      expect(result.errors[0]).toMatchObject({ rule: "ATW-INPUT-TYPE", severity: "fatal", field: [] });
      expect(result.errors[0]!.message).toMatch(said);
      expect(result.profile).toBeUndefined();
    });
  }

  it("points a document at validate(), and undefined at a missing body parser", () => {
    expect(validateInput(asInput(xml)).errors[0]!.fix).toMatch(/^Call validate\(document\)/);
    expect(validateInput(asInput(new Uint8Array(4))).errors[0]!.fix).toMatch(/^Call validate\(document\)/);
    expect(validateInput(asInput(undefined)).errors[0]!.fix).toContain("express.json()");
    expect(validateInput(asInput("x")).errors[0]!.fix).toContain("parse it first");
  });

  it("leaves an invoice object to the rules, whatever is wrong inside it", () => {
    const result = validateInput(withInvoice({ buyerReference: undefined }));
    expect(result.errors.map((e) => e.rule)).toContain("BR-DE-15");
    expect(result.errors.map((e) => e.rule)).not.toContain("ATW-INPUT-TYPE");
  });
});

describe("validate, given something that is not a document", () => {
  it("names validateInput for an invoice object", () => {
    expect(() => validate(withInvoice({}) as never)).toThrow(TypeError);
    expect(() => validate(withInvoice({}) as never)).toThrow(/call validateInput\(invoice\)/);
  });

  it("says how to read a browser File or Blob", () => {
    expect(() => validate(new Blob(["<Invoice/>"]) as never)).toThrow(/new Uint8Array\(await file\.arrayBuffer\(\)\)/);
  });

  it("says how to view other typed arrays as bytes, rather than naming validateInput", () => {
    for (const view of [new DataView(new ArrayBuffer(4)), new Uint16Array(2)]) {
      expect(() => validate(view as never)).toThrow(/new Uint8Array\(view\.buffer, view\.byteOffset, view\.byteLength\)/);
      expect(() => validate(view as never)).not.toThrow(/validateInput/);
    }
  });

  it("keeps the plain message for anything else", () => {
    expect(() => validate(42 as never)).toThrow(/^validate\(\) takes the document as a string, a Uint8Array or an ArrayBuffer\.$/);
  });
});

describe("BR-03's advice does not move the date", () => {
  // It suggested toISOString().slice(0, 10), which converts to UTC first: a
  // Date built at midnight in Berlin comes out as the day before.
  it("recommends the date's own calendar fields, and warns off toISOString", () => {
    const finding = validateInput(withInvoice({ issueDate: "09.08.2026" })).errors.find((e) => e.rule === "BR-03")!;
    expect(finding.fix).toContain("getFullYear()");
    expect(finding.fix).not.toMatch(/toISOString\(\)\.slice/);
  });
});

describe("every field of the input model is documented where an editor shows it", () => {
  // tsc drops `//` comments from the published types, so a note written as a
  // trailing line comment never reached a developer's hover (DX audit,
  // 2026-09-24: 29 of them, including issueDate and vatRate). Doc comments
  // survive into dist/types.d.ts.
  const source = readFileSync(fileURLToPath(new URL("./types.ts", import.meta.url)), "utf8");

  it("has no field whose only note is a trailing line comment", () => {
    const trailing = source
      .split("\n")
      .filter((l) => /^\s+[A-Za-z_][A-Za-z0-9_]*\??:\s*[^;]+;\s*\/\//.test(l))
      .map((l) => l.trim());
    expect(trailing).toEqual([]);
  });

  it("documents the fields a developer fills in first", () => {
    for (const field of ["profile: Profile;", "issueDate: string;", "currency: string;", "seller: Party;", "lines: InvoiceLine[];", "vatRate?: number;", "unitCode: string;", "countryCode: string;"]) {
      const at = source.indexOf(`  ${field}`, source.indexOf("export interface InvoiceInput {"));
      expect(at, field).toBeGreaterThan(-1);
      expect(source.slice(0, at).trimEnd().endsWith("*/"), `${field} has no doc comment above it`).toBe(true);
    }
  });
});
