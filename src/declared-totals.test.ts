// The declared-totals gap, closed in 0.6.0, in every cell it had.
//
// THE DEFECT. Both readers populated `declaredTotals` only for values that
// parsed as numbers, and `set` skips `undefined`. So a document total that was
// absent, empty, or written `12,34` never reached the model, nothing compared
// what was not there, and `validateInput` returned `valid: true` with zero
// findings — on a file KoSIT rejects. The comparison rules were never the
// problem: BR-CO-16 fires correctly the moment there is a number to compare,
// and the last two tests here pin that so the fix cannot be mistaken for a
// loosening.
//
// THE MATRIX. Four cases (missing block, absent element, empty element,
// unreadable text) x two syntaxes x invoice and credit note. Every one of them
// was verified against the official validator on 2026-08-14 — KoSIT 1.6.2 with
// the XRechnung 3.0.2 configuration — and the citations are recorded in
// scripts/kosit-check.md. Where our rule id differs from the one KoSIT prints,
// the reason is written next to the expectation rather than left to be
// rediscovered.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseCiiInvoice, parseUblInvoice, validateInput } from "./index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const read = (name: string) => readFileSync(join(fixturesDir, name), "utf8");

/** Replace the first occurrence, and fail loudly if there was none. */
function swap(xml: string, from: string | RegExp, to: string): string {
  const out = xml.replace(from, to);
  if (out === xml) throw new Error(`fixture no longer contains ${String(from)}`);
  return out;
}

const ids = (xml: string, parse: (x: string) => { invoice: never }) =>
  validateInput(parse(xml).invoice as never).errors.map((e) => e.rule);

interface Syntax {
  name: string;
  parse: (xml: string) => { invoice: never };
  /** Document, block-open tag pattern, and the elements by business term. */
  documents: { kind: string; xml: string }[];
  block: RegExp;
  bt106: (amount: string) => string;
  bt109: (amount: string) => string;
  bt115: (amount: string) => string;
  bt115Xpath: RegExp;
  /** BT-107 and BT-108 as the discount fixture writes them, for the omission test. */
  optionalTotals: { allowance: string; charge: string };
}

const UBL: Syntax = {
  name: "UBL",
  parse: parseUblInvoice as never,
  documents: [
    { kind: "invoice", xml: read("xrechnung-ubl-minimal.xml") },
    { kind: "credit note", xml: read("xrechnung-ubl-credit-note.xml") },
  ],
  block: /\s*<cac:LegalMonetaryTotal>[\s\S]*?<\/cac:LegalMonetaryTotal>/,
  bt106: (a) => `<cbc:LineExtensionAmount currencyID="EUR">${a}</cbc:LineExtensionAmount>`,
  bt109: (a) => `<cbc:TaxExclusiveAmount currencyID="EUR">${a}</cbc:TaxExclusiveAmount>`,
  bt115: (a) => `<cbc:PayableAmount currencyID="EUR">${a}</cbc:PayableAmount>`,
  bt115Xpath: /cac:LegalMonetaryTotal\/cbc:PayableAmount$/,
  optionalTotals: {
    allowance: '<cbc:AllowanceTotalAmount currencyID="EUR">53.10</cbc:AllowanceTotalAmount>',
    charge: '<cbc:ChargeTotalAmount currencyID="EUR">24.90</cbc:ChargeTotalAmount>',
  },
};

const CII: Syntax = {
  name: "CII",
  parse: parseCiiInvoice as never,
  documents: [
    { kind: "invoice", xml: read("xrechnung-cii-minimal.xml") },
    { kind: "credit note", xml: read("xrechnung-cii-credit-note.xml") },
  ],
  block:
    /\s*<ram:SpecifiedTradeSettlementHeaderMonetarySummation>[\s\S]*?<\/ram:SpecifiedTradeSettlementHeaderMonetarySummation>/,
  bt106: (a) => `<ram:LineTotalAmount>${a}</ram:LineTotalAmount>`,
  bt109: (a) => `<ram:TaxBasisTotalAmount>${a}</ram:TaxBasisTotalAmount>`,
  bt115: (a) => `<ram:DuePayableAmount>${a}</ram:DuePayableAmount>`,
  bt115Xpath: /ram:SpecifiedTradeSettlementHeaderMonetarySummation\/ram:DuePayableAmount$/,
  optionalTotals: {
    allowance: "<ram:AllowanceTotalAmount>53.10</ram:AllowanceTotalAmount>",
    charge: "<ram:ChargeTotalAmount>24.90</ram:ChargeTotalAmount>",
  },
};

/** The amounts the two minimal fixtures and the two credit notes all use. */
const AMOUNTS = { bt106: "1599.80", bt109: "1599.80", bt115: "1891.79" };

for (const syntax of [UBL, CII]) {
  describe(`declared document totals, ${syntax.name}`, () => {
    for (const { kind, xml } of syntax.documents) {
      it(`accepts the unmodified ${kind}, so the cases below are the only difference`, () => {
        const { invoice } = syntax.parse(xml);
        const result = validateInput(invoice);
        expect(result.errors.map((e) => e.rule)).toEqual([]);
        expect(result.valid).toBe(true);
      });

      it(`rejects a ${kind} with no monetary total block at all`, () => {
        // KoSIT rejects this too, and cites something different in each syntax:
        // UBL's XSD makes cac:LegalMonetaryTotal mandatory, so it never reaches
        // the schematron; CII's summation group is optional in D16B, and the
        // CII schematron writes BR-12..15 with that group as their context, so
        // removing it removes the context node and only BR-CO-15 fires. Both
        // are REJECT. We cite the four presence rules the document breaks.
        const broken = swap(xml, syntax.block, "");
        const errors = validateInput(syntax.parse(broken).invoice).errors;
        expect(errors.map((e) => e.rule)).toEqual(
          expect.arrayContaining(["BR-12", "BR-13", "BR-14", "BR-15"]),
        );
        expect(validateInput(syntax.parse(broken).invoice).valid).toBe(false);
      });

      it(`rejects a ${kind} whose sum of line net amounts (BT-106) is absent, as BR-12`, () => {
        // The one cell where KoSIT quotes exactly this id in both syntaxes:
        // [BR-12], with BR-CO-10 and BR-CO-13 alongside it.
        const broken = swap(xml, syntax.bt106(AMOUNTS.bt106), "");
        expect(ids(broken, syntax.parse)).toContain("BR-12");
      });

      it(`rejects a ${kind} whose amount due for payment (BT-115) is absent, as BR-15`, () => {
        const broken = swap(xml, syntax.bt115(AMOUNTS.bt115), "");
        expect(ids(broken, syntax.parse)).toContain("BR-15");
      });

      it(`rejects a ${kind} whose total without VAT (BT-109) is an empty element`, () => {
        // Present but unreadable: KoSIT stops at the schema here — "'' is not a
        // valid value for 'decimal'" — so there is no BR id to quote and we do
        // not invent one. BR-13 is deliberately NOT raised: the element exists.
        const broken = swap(xml, syntax.bt109(AMOUNTS.bt109), syntax.bt109(""));
        const result = validateInput(syntax.parse(broken).invoice);
        const rules = result.errors.map((e) => e.rule);
        expect(rules).toContain("ATW-DECLARED-TOTAL-NOT-A-NUMBER");
        expect(rules).not.toContain("BR-13");
        expect(result.valid).toBe(false);
        const finding = result.errors.find(
          (e) => e.rule === "ATW-DECLARED-TOTAL-NOT-A-NUMBER",
        );
        expect(finding?.field).toBe("BT-109");
        expect(finding?.message).toContain("the element is empty");
      });

      it(`rejects a ${kind} whose amount due for payment is written "12,34", and says so`, () => {
        const broken = swap(xml, syntax.bt115(AMOUNTS.bt115), syntax.bt115("12,34"));
        const result = validateInput(syntax.parse(broken).invoice);
        const finding = result.errors.find(
          (e) => e.rule === "ATW-DECLARED-TOTAL-NOT-A-NUMBER",
        );
        expect(result.valid).toBe(false);
        expect(finding?.field).toBe("BT-115");
        // The exact text seen, quoted back — the whole value of the finding.
        expect(finding?.message).toContain('"12,34"');
        // And the one thing the writer needs to hear.
        expect(finding?.message).toContain("decimal comma");
        expect(finding?.fix).toContain('"12.34"');
        expect(finding?.xpath).toMatch(syntax.bt115Xpath);
        expect(result.errors.map((e) => e.rule)).not.toContain("BR-15");
      });

      it(`rejects a ${kind} whose amount due for payment is "notanumber"`, () => {
        const broken = swap(
          xml,
          syntax.bt115(AMOUNTS.bt115),
          syntax.bt115("notanumber"),
        );
        const result = validateInput(syntax.parse(broken).invoice);
        const finding = result.errors.find(
          (e) => e.rule === "ATW-DECLARED-TOTAL-NOT-A-NUMBER",
        );
        expect(result.valid).toBe(false);
        expect(finding?.message).toContain('"notanumber"');
        // No decimal-comma hint where there is no decimal comma.
        expect(finding?.message).not.toContain("decimal comma");
      });

      // ⚠ DO NOT DELETE THIS TEST. It is the property standing between this
      // release and rejecting most real invoices in the world.
      //
      // BT-107 and BT-108 are OPTIONAL: a document with no document-level
      // allowance states no allowance total, and that is correct rather than
      // missing. They sit in the same block as the four mandatory totals and are
      // read by the same loop, so a one-character slip — recording a defect for
      // every term instead of only the ones with a presence rule — would make
      // every invoice without a discount fail. Nothing else in the suite would
      // catch it: the fixtures that DO carry allowances would still pass.
      it(`records no defect for the optional totals a ${kind} omits`, () => {
        const { invoice } = syntax.parse(xml);
        expect(invoice.declaredTotals?.defects).toBeUndefined();
        expect(validateInput(invoice).valid).toBe(true);

        // And explicitly, on a document built to omit them: the minimal
        // fixtures have no BT-107/BT-108 to begin with, so removing them from a
        // discount document is the case that proves the rule rather than
        // restating the one above.
        const withTotals = syntax.documents === UBL.documents
          ? read("xrechnung-ubl-discount.xml")
          : read("xrechnung-cii-discount.xml");
        const stripped = swap(
          swap(withTotals, syntax.optionalTotals.allowance, ""),
          syntax.optionalTotals.charge,
          "",
        );
        const { invoice: after } = syntax.parse(stripped);
        expect(
          after.declaredTotals?.defects,
          "an optional document total was recorded as a defect",
        ).toBeUndefined();
      });

      it(`reports the unreadable and the empty ${kind} total as unmapped as well`, () => {
        // "Nothing is dropped silently" is the readers' oldest promise, and the
        // empty element used to slip through it: TreeReader.number noted
        // unreadable text and returned early on empty text, so an empty total
        // appeared in neither the model nor the unmapped list.
        for (const text of ["", "12,34"]) {
          const broken = swap(xml, syntax.bt115(AMOUNTS.bt115), syntax.bt115(text));
          const { unmapped } = syntax.parse(broken) as unknown as {
            unmapped: { path: string; reason: string }[];
          };
          const entry = unmapped.find((u) => syntax.bt115Xpath.test(u.path));
          expect(entry, `unmapped entry for ${JSON.stringify(text)}`).toBeDefined();
        }
      });
    }

    it("still compares a declared total that IS a number: BR-CO-16 on a mismatch", () => {
      const { xml } = syntax.documents[0]!;
      const broken = swap(xml, syntax.bt115(AMOUNTS.bt115), syntax.bt115("9999.99"));
      const result = validateInput(syntax.parse(broken).invoice);
      expect(result.errors.map((e) => e.rule)).toContain("BR-CO-16");
      expect(result.errors.map((e) => e.rule)).not.toContain(
        "ATW-DECLARED-TOTAL-NOT-A-NUMBER",
      );
    });

    it("and stays silent when the declared total matches", () => {
      const { xml } = syntax.documents[0]!;
      const result = validateInput(syntax.parse(xml).invoice);
      expect(result.errors).toEqual([]);
    });
  });
}

describe("a CII document missing the settlement group above the totals", () => {
  // The group can be missing at either of two levels, and the heavier omission
  // must not be the quieter one. Four presence findings for a missing summation
  // group and none for a missing ApplicableHeaderTradeSettlement would be
  // under-detection exactly where the document is most broken.
  it("reports the same four presence rules as a missing summation group", () => {
    const xml = read("xrechnung-cii-minimal.xml");
    const broken = swap(
      xml,
      /\s*<ram:ApplicableHeaderTradeSettlement>[\s\S]*<\/ram:ApplicableHeaderTradeSettlement>/,
      "",
    );
    const { invoice } = parseCiiInvoice(broken);
    const rules = validateInput(invoice).errors.map((e) => e.rule);
    for (const id of ["BR-12", "BR-13", "BR-14", "BR-15"]) {
      expect(rules, `a missing settlement group did not report ${id}`).toContain(id);
    }
    // The XPath still says where the value belongs, built from the ancestors
    // that do exist rather than from a group that does not.
    const finding = validateInput(invoice).errors.find((e) => e.rule === "BR-15");
    expect(finding?.xpath).toContain("ram:ApplicableHeaderTradeSettlement");
    expect(finding?.xpath).toMatch(/ram:DuePayableAmount$/);
  });
});

// ---------------------------------------------------------------------------
// `defects` is parser-written, and `InvoiceInput` is a public type.
//
// The JSON surfaces — `POST /v1/validate` with a JSON body, the MCP
// `validate_invoice` tool — hand `validateInput` whatever the caller posted. A
// hand-written `defects` array used to reach `defect.state` on a `null` and
// `defect.xpath.split()` on an absent xpath, which threw a TypeError out of
// `validateInput`: a 500 from a validation endpoint, which is the one answer a
// validator must never give. Every shape below is a real request body someone
// can send.
//
// The policy these pin: a malformed entry is IGNORED, never thrown and never
// turned into a finding. The reasoning is on `usableDefects`; the short version
// is that an unrecognised `state` has nothing true to say about it, so the whole
// field gets one rule rather than a finding for a mistake no invoice can make.
// ---------------------------------------------------------------------------

describe("malformed declaredTotals.defects from a JSON caller", () => {
  const base = () => {
    const { invoice } = parseUblInvoice(read("xrechnung-ubl-minimal.xml"));
    return invoice;
  };
  const withDefects = (defects: unknown) =>
    ({ ...base(), declaredTotals: { defects } }) as never;

  const shapes: [string, unknown][] = [
    ["a null entry", [null]],
    ["an undefined entry", [undefined]],
    ["a string entry", ["BR-15"]],
    ["a number entry", [42]],
    ["an array entry", [[]]],
    ["an array-like object instead of an array", { length: 2, 0: {}, 1: {} }],
    ["a bare string", "payableAmount"],
    ["a number", 7],
    ["null", null],
    ["an empty array", []],
    ["an entry with no state", [{ key: "payableAmount", field: "BT-115" }]],
    ["an entry with an unknown state", [{ key: "payableAmount", state: "banana" }]],
    ["an entry with a non-string state", [{ key: "payableAmount", state: 3 }]],
    ["an entry with no key", [{ state: "absent", xpath: "/x" }]],
    ["an entry with an unknown key", [{ key: "vibes", state: "absent" }]],
    ["an entry with a non-string key", [{ key: 9, state: "absent" }]],
  ];

  for (const [label, defects] of shapes) {
    it(`ignores ${label} instead of throwing`, () => {
      const result = validateInput(withDefects(defects));
      expect(result.valid, `${label} produced a finding it should not have`).toBe(true);
      expect(result.errors).toEqual([]);
    });
  }

  it("does not throw on an entry with no xpath, and still names the element", () => {
    // The crash was `defect.xpath.split("/")`, in the fix text of the presence
    // rule and in the example of the datatype rule. Both fall back to the
    // term's own element name now.
    const absent = validateInput(
      withDefects([{ key: "payableAmount", field: "BT-115", state: "absent" }]),
    );
    expect(absent.valid).toBe(false);
    const presence = absent.errors.find((e) => e.rule === "BR-15");
    expect(presence?.fix).toContain("PayableAmount");
    expect(presence?.xpath).toContain("PayableAmount");

    const unreadable = validateInput(
      withDefects([{ key: "payableAmount", state: "unreadable", text: "12,34" }]),
    );
    const datatype = unreadable.errors.find(
      (e) => e.rule === "ATW-DECLARED-TOTAL-NOT-A-NUMBER",
    );
    expect(datatype?.example).toBe("<PayableAmount>1891.79</PayableAmount>");
  });

  it("keeps the good entries in an array that also holds bad ones", () => {
    const result = validateInput(
      withDefects([
        null,
        { key: "payableAmount", field: "BT-115", state: "absent", xpath: "/x/y" },
        "nonsense",
        { key: "lineExtensionAmount", state: "banana" },
      ]),
    );
    expect(result.errors.map((e) => e.rule)).toEqual(["BR-15"]);
  });

  it("ignores a caller-supplied field that disagrees with the key", () => {
    // `field` is not trusted: the term's own business term is used, so a
    // hand-written BT-999 cannot put a wrong term into a message.
    const result = validateInput(
      withDefects([{ key: "payableAmount", field: "BT-999", state: "absent" }]),
    );
    const [finding] = result.errors;
    expect(finding?.rule).toBe("BR-15");
    expect(finding?.field).toBe("BT-115");
    expect(JSON.stringify(finding)).not.toContain("BT-999");
  });

  it("reports a term once however many times it is listed", () => {
    // The readers write each term at most once. A hand-fed duplicate would
    // otherwise produce two findings for one figure, which reads as the engine
    // contradicting itself.
    const result = validateInput(
      withDefects([
        { key: "payableAmount", state: "absent", xpath: "/a" },
        { key: "payableAmount", state: "absent", xpath: "/b" },
        { key: "payableAmount", state: "unreadable", text: "12,34", xpath: "/c" },
      ]),
    );
    expect(result.errors.map((e) => e.rule)).toEqual(["BR-15"]);
  });

  it("truncates the text it quotes, wherever the entry came from", () => {
    // The reader already truncates at 200 characters. A hand-fed entry does not
    // go through the reader, and a 10 kB string must not land whole in a
    // message that ends up in someone's logs.
    const huge = "9".repeat(10_000);
    const result = validateInput(
      withDefects([{ key: "payableAmount", state: "unreadable", text: huge }]),
    );
    const [finding] = result.errors;
    expect(finding?.rule).toBe("ATW-DECLARED-TOTAL-NOT-A-NUMBER");
    expect(finding?.message.length).toBeLessThan(1200);
    expect(finding?.message).not.toContain(huge);
    expect(finding?.message).toContain("9".repeat(200));
  });
});

describe("the JSON input path is untouched", () => {
  it("computes the totals for a caller who declares none, with no presence finding", () => {
    // The whole point of the model: omitting a total means "compute it for me".
    // BR-12..15 must not start firing on hand-built invoices just because they
    // can now fire on parsed documents.
    const { invoice } = parseUblInvoice(read("xrechnung-ubl-minimal.xml"));
    const hand = { ...invoice };
    delete hand.declaredTotals;
    const result = validateInput(hand);
    expect(result.errors.map((e) => e.rule)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("still reports a caller-declared total that disagrees with the lines", () => {
    const { invoice } = parseUblInvoice(read("xrechnung-ubl-minimal.xml"));
    const result = validateInput({
      ...invoice,
      declaredTotals: { ...invoice.declaredTotals, payableAmount: 1 },
    });
    expect(result.errors.map((e) => e.rule)).toContain("BR-CO-16");
  });
});
