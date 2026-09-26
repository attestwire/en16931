import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { recipientClass, validate, validateInput } from "./index.js";
import { RECIPIENT_CLASS_ENTRIES } from "./recipient-class.js";
import { CATEGORY_RULE_INFIX } from "./rule-kit.js";
import { withInvoice } from "./testkit.js";

/**
 * Every id this build can report, read out of the source the way
 * rules-invariants.test.ts reads it: the rule ids as string literals, the
 * per-category families expanded from the table the rules use, and the `AW-`
 * findings of `validate()` and the command line. recipient-class.ts itself is
 * left out, or its own table would vouch for itself.
 */
const srcDir = new URL(".", import.meta.url);
const sources = readdirSync(srcDir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "recipient-class.ts")
  .map((name) => readFileSync(new URL(name, srcDir), "utf8"));
const literals = (pattern: RegExp) => new Set(sources.flatMap((text) => [...text.matchAll(pattern)].map((m) => m[1]!)));

const RULE_IDS = new Set([
  ...literals(/"((?:BR|PEPPOL|ATW)-[A-Za-z0-9-]+)"/g),
  ...Object.values(CATEGORY_RULE_INFIX).flatMap((infix) =>
    Array.from({ length: 10 }, (_unused, i) => `BR-${infix}-${String(i + 1).padStart(2, "0")}`),
  ),
]);
const AW_IDS = literals(/"(AW-[A-Z0-9-]+)"/g);

/**
 * The container findings of en16931/container-findings, classified here before
 * they reach this branch. Once they are in the source they are checked like
 * every other id; until then they may be absent.
 */
const PENDING = ["AW-PDF-ATTACHMENT", "AW-PDF-AF", "AW-PDF-RELATIONSHIP", "AW-PDF-MIME", "AW-PDF-XMP", "AW-PDF-XMP-PROFILE"];

const table = new Map(RECIPIENT_CLASS_ENTRIES);

describe("the recipient-class table", () => {
  it("gives every rule id the engine has a class", () => {
    expect(RULE_IDS.size).toBeGreaterThan(300);
    const missing = [...RULE_IDS].filter((id) => !table.has(id)).sort();
    expect(missing, "rule ids with no class in recipient-class.ts: classify each one").toEqual([]);
  });

  it("gives every AW- finding a class, the container findings included", () => {
    expect(AW_IDS.size).toBeGreaterThanOrEqual(6);
    const missing = [...AW_IDS, ...PENDING].filter((id) => !table.has(id)).sort();
    expect(missing, "AW- ids with no class in recipient-class.ts").toEqual([]);
  });

  it("gives each id exactly one class", () => {
    const ids = RECIPIENT_CLASS_ENTRIES.map(([id]) => id);
    const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(twice).toEqual([]);
    for (const [, cls] of RECIPIENT_CLASS_ENTRIES) expect(["format", "vat-relevant", "formal"]).toContain(cls);
  });

  it("classifies nothing the engine does not have", () => {
    const stale = RECIPIENT_CLASS_ENTRIES.map(([id]) => id).filter(
      (id) => !RULE_IDS.has(id) && !AW_IDS.has(id) && !PENDING.includes(id),
    );
    expect(stale, "ids in recipient-class.ts that no source emits").toEqual([]);
  });
});

describe("recipientClass", () => {
  it("follows the letter's own examples", () => {
    // Rn. 35a: a missing BT-10 in an XRechnung is "umsatzsteuerlich unbeachtlich".
    expect(recipientClass("BR-DE-15")).toBe("formal");
    // Rn. 6b: a tax amount that does not match the rate.
    expect(recipientClass("BR-CO-17")).toBe("vat-relevant");
    expect(recipientClass("BR-S-09")).toBe("vat-relevant");
    // Rn. 35a: a wrong tax rate is a content error.
    expect(recipientClass("ATW-VAT-RATE-FRACTION")).toBe("vat-relevant");
  });

  it("calls a file that is not a structured e-invoice a format error", () => {
    for (const id of ["AW-PARSE", "AW-PDF", "AW-PROFILE-SUBSET"]) expect(recipientClass(id), id).toBe("format");
  });

  it("calls the PDF container of a hybrid invoice whose XML was read formal", () => {
    for (const id of PENDING) expect(recipientClass(id), id).toBe("formal");
  });

  it("puts the § 14 Abs. 4 content where it belongs", () => {
    const vatRelevant = [
      "BR-02", // invoice number
      "BR-03", // issue date
      "BR-06", "BR-07", "BR-08", "BR-10", "BR-DE-3", "BR-DE-8", // names and addresses
      "BR-DE-16", "BR-S-02", "BR-CO-09", // supplier tax number or VAT identifier
      "BR-22", "BR-25", // quantity and kind
      "BR-DE-TMP-32", "BR-29", // date of supply
      "BR-45", "BR-CO-14", // net amount per rate, tax amount
      "BR-AE-10", "BR-E-10", // reverse-charge and exemption notes
      "BR-DE-18", // agreed reduction (Skonto)
      "BR-55", "BR-DE-26", // the invoice a correction refers to
    ];
    for (const id of vatRelevant) expect(recipientClass(id), id).toBe("vat-relevant");
    const formal = [
      "BR-DE-2", "BR-DE-5", "BR-DE-27", // contact data
      "BR-62", "PEPPOL-EN16931-R010", "BR-CL-25", "PEPPOL-COMMON-R040", // electronic addresses
      "BR-CL-23", "BR-CL-04", // code-list formalities
      "BR-DE-1", "BR-DE-19", "BR-61", // payment
      "BR-DEC-13", // precision of a stated figure
      "ATW-LEITWEG-ID-INVALID", "ATW-IBAN-INVALID", "ATW-BIC-INVALID", "ATW-SIREN-INVALID", "ATW-SIRET-INVALID",
    ];
    for (const id of formal) expect(recipientClass(id), id).toBe("formal");
  });

  it("ignores case and surrounding whitespace", () => {
    expect(recipientClass("br-de-15")).toBe("formal");
    expect(recipientClass(" BR-DE-23-A ")).toBe("formal");
    expect(recipientClass("aw-parse")).toBe("format");
  });

  it("answers an id it does not know with the cautious class", () => {
    for (const id of ["BR-ZZ-99", "CII-SR-475", "", "constructor", "__proto__", "toString"]) {
      expect(recipientClass(id), id).toBe("vat-relevant");
    }
    expect(recipientClass(42 as unknown as string)).toBe("vat-relevant");
  });

  it("classifies every finding validateInput and validate return", () => {
    const findings = [
      ...Object.values(validateInput(withInvoice({ buyerReference: undefined, lines: [] }))).flat(),
      ...Object.values(validate("<not-an-invoice/>")).flat(),
    ].filter((f): f is { rule: string } => typeof f === "object" && f !== null && "rule" in f);
    expect(findings.length).toBeGreaterThan(2);
    for (const f of findings) expect(table.has(f.rule), f.rule).toBe(true);
    expect(recipientClass("AW-PARSE")).toBe("format");
  });
});
