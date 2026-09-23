import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { computeTotals, parseCiiInvoice, parseUbl, validateInput } from "./index.js";
import { CATEGORY_RULE_INFIX } from "./rule-kit.js";
import { clean, cleanLine, withInvoice, withLine } from "./testkit.js";
import { formatQuantity, MAX_MONETARY_AMOUNT } from "./totals.js";
import type { InvoiceInput, VatCategory } from "./types.js";

// Second mutation-testing round (2026-09-23), on the code written that day.
// Each test kills mutants that survived the suite; the comment names them.

const findings = (inv: unknown) => {
  const r = validateInput(inv as InvoiceInput);
  return [...r.errors, ...r.warnings];
};
const ids = (inv: unknown) => findings(inv).map((f) => f.rule);
const ruleFor = (category: string, n: string) => `BR-${CATEGORY_RULE_INFIX[category] ?? category}-${n}`;

describe("stated-breakdown tolerances, per syntax and category", () => {
  // The CEN schematrons, as read on 2026-09-23 (rules.ts EXACT_08 / ZERO_TAX_09).
  const EXACT: Record<"ubl" | "cii", string[]> = {
    ubl: ["Z", "E", "AE", "K", "G", "O"],
    cii: ["S", "O", "L", "M"],
  };
  const RATE: Record<string, number | undefined> = { S: 19, L: 7, M: 10, O: undefined };
  const stated = (syntax: "ubl" | "cii", category: VatCategory, patch: object) =>
    withInvoice({
      lines: [cleanLine({ vatCategory: category, vatRate: RATE[category] ?? (category === "O" ? undefined : 0) })],
      vatExemptionReasons: category === "E" ? { E: "Exempt" } : undefined,
      declaredTotals: {
        syntax,
        specificationIdentifier: "urn:cen.eu:en16931:2017",
        subtotals: [
          {
            category,
            rate: RATE[category] ?? 0,
            taxableAmount: 1500,
            taxAmount: RATE[category] ? Math.round(1500 * RATE[category]!) / 100 : 0,
            ...patch,
          },
        ],
      },
    });

  for (const syntax of ["ubl", "cii"] as const) {
    for (const category of ["S", "Z", "E", "AE", "K", "G", "O", "L", "M"] as VatCategory[]) {
      const exact = EXACT[syntax].includes(category);
      it(`${syntax} ${category}: BT-116 off by 0.50 ${exact ? "fails" : "passes"} -08`, () => {
        expect(ids(stated(syntax, category, { taxableAmount: 1500.5 })).includes(ruleFor(category, "08"))).toBe(exact);
      });
    }
    for (const category of ["Z", "E", "AE", "K", "G", "O"] as VatCategory[]) {
      it(`${syntax} ${category}: a stated VAT amount of 0.01 is -09`, () => {
        expect(ids(stated(syntax, category, { taxAmount: 0.01 }))).toContain(ruleFor(category, "09"));
      });
    }
  }

  it("a stated O group that writes rate 0 is still compared (BR-O-08)", () => {
    expect(ids(stated("ubl", "O", { rate: 0, taxableAmount: 1400 }))).toContain("BR-O-08");
  });

  it("CII: BR-AF-09 never fires (the binding's test is true())", () => {
    expect(ids(stated("cii", "L", { taxAmount: 105 + 5 }))).not.toContain("BR-AF-09");
    expect(ids(stated("ubl", "L", { taxAmount: 105 + 5 }))).toContain("BR-AF-09");
  });

  it("an S group stating a VAT amount but no taxable amount is not BR-S-09", () => {
    expect(ids(stated("ubl", "S", { taxableAmount: undefined, taxAmount: 999 }))).not.toContain("BR-S-09");
  });
});

describe("the rule runner's backstop", () => {
  it("turns a TypeError thrown inside the rules into one ATW-INPUT-TYPE", () => {
    const inv = { ...clean };
    Object.defineProperty(inv, "note", {
      enumerable: true,
      get() {
        throw new TypeError("boom");
      },
    });
    const found = validateInput(inv).errors.filter((e) => e.rule === "ATW-INPUT-TYPE");
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("fatal");
  });

  it("lets anything other than a TypeError or RangeError propagate", () => {
    const inv = { ...clean };
    Object.defineProperty(inv, "note", {
      enumerable: true,
      get() {
        throw new SyntaxError("a real bug");
      },
    });
    expect(() => validateInput(inv)).toThrow(SyntaxError);
  });
});

describe("the input-shape check", () => {
  it("names the path and the wrong kind of value", () => {
    const f = findings(withLine({ quantity: null as never })).find((e) => e.rule === "ATW-INPUT-TYPE")!;
    expect(f.message).toMatch(/^lines\[0\]\.quantity should be a number, but it is null\./);
    const g = findings(withLine({ quantity: "5" as never })).find((e) => e.rule === "ATW-INPUT-TYPE")!;
    expect(g.message).toContain('it is the text "5"');
  });

  it("files line allowances and charges under BG-27 / BG-28", () => {
    expect(findings(withLine({ allowances: 5 as never })).find((e) => e.rule === "ATW-INPUT-TYPE")!.field).toBe("BG-27");
    expect(findings(withLine({ charges: 5 as never })).find((e) => e.rule === "ATW-INPUT-TYPE")!.field).toBe("BG-28");
  });

  it("accepts an object legalRegistrationId on the payee only", () => {
    expect(ids(withInvoice({ seller: { ...clean.seller, legalRegistrationId: { value: "x" } as never } }))).toContain(
      "ATW-INPUT-TYPE",
    );
    expect(ids(withInvoice({ payee: { name: "P", legalRegistrationId: { value: "x" } } as never }))).not.toContain(
      "ATW-INPUT-TYPE",
    );
  });

  it("requires text in the exemption-reason maps", () => {
    expect(ids(withInvoice({ vatExemptionReasons: { E: 5 as never } }))).toContain("ATW-INPUT-TYPE");
  });

  it("checks stated figures: non-finite line amounts and rates, and the ceiling", () => {
    const declared = (d: object) => withInvoice({ declaredTotals: { syntax: "ubl", specificationIdentifier: "x", ...d } });
    expect(ids(declared({ lineNetAmounts: [Number.POSITIVE_INFINITY] }))).toContain("ATW-NUMBER-NOT-FINITE");
    expect(
      ids(declared({ subtotals: [{ category: "S", rate: Number.POSITIVE_INFINITY, taxableAmount: 1500, taxAmount: 285 }] })),
    ).toContain("ATW-NUMBER-NOT-FINITE");
    expect(ids(declared({ taxTotalsInInvoiceCurrency: 1e20 }))).not.toContain("ATW-NUMBER-TOO-LARGE");
    expect(ids(declared({ payableAmount: MAX_MONETARY_AMOUNT }))).not.toContain("ATW-NUMBER-TOO-LARGE");
    expect(ids(declared({ payableAmount: MAX_MONETARY_AMOUNT + 1 }))).toContain("ATW-NUMBER-TOO-LARGE");
  });

  it("does not look inside the readers' own bookkeeping", () => {
    const inv = withInvoice({
      declaredTotals: { syntax: "ubl", specificationIdentifier: "x", defects: [{ key: "payableAmount", state: "absent", xpath: "\u0000" }] as never },
    });
    expect(ids(inv)).not.toContain("ATW-TEXT-NOT-XML");
  });

  it("makes text of only a control character fatal", () => {
    const f = findings(withInvoice({ note: "\u0001" })).find((e) => e.rule === "ATW-TEXT-NOT-XML")!;
    expect(f.severity).toBe("fatal");
  });

  it("ignores numbers under keys it does not know", () => {
    expect(ids({ ...clean, extra: 1e22 })).not.toContain("ATW-NUMBER-TOO-LARGE");
  });

  it("flags a VAT rate just over 100%", () => {
    expect(ids(withLine({ vatRate: 100.5 }))).toContain("ATW-VAT-RATE-OUT-OF-RANGE");
    expect(ids(withLine({ vatRate: 100 }))).not.toContain("ATW-VAT-RATE-OUT-OF-RANGE");
  });
});

describe("totals and formatting", () => {
  it("rounds VAT to whole units for CLP, and for a currency code with stray case or spaces", () => {
    const at = (currency: string) =>
      computeTotals(withInvoice({ currency, lines: [cleanLine({ quantity: 1, unitPrice: 1234, vatRate: 19 })] })).taxAmount;
    expect(at("CLP")).toBe(234);
    expect(at(" jpy ")).toBe(234);
    expect(at("EUR")).toBe(234.46);
  });

  it("writes quantities at twelve decimals at most, and refuses 1e21", () => {
    expect(formatQuantity(1.0000000000001)).toBe("1.0000");
    expect(formatQuantity(-1e-13)).toBe("0.0000");
    expect(() => formatQuantity(1e21)).toThrow(RangeError);
  });
});

describe("the readers", () => {
  const ubl = readFileSync(new URL("../fixtures/xrechnung-ubl-minimal.xml", import.meta.url), "utf8");
  const cii = readFileSync(new URL("../fixtures/xrechnung-cii-minimal.xml", import.meta.url), "utf8");

  it("a line with no price element is BR-26, in both syntaxes", () => {
    const u = ubl.replace(/<cac:Price>[\s\S]*?<\/cac:Price>/, "");
    expect(validateInput(parseUbl(u).invoice).errors.map((e) => e.rule)).toContain("BR-26");
    const c = cii.replace(/<ram:NetPriceProductTradePrice>[\s\S]*?<\/ram:NetPriceProductTradePrice>/, "");
    expect(validateInput(parseCiiInvoice(c).invoice).errors.map((e) => e.rule)).toContain("BR-26");
  });

  it("CII: a buyer with no address is BR-10 and BR-11", () => {
    const c = cii.replace(/(<ram:BuyerTradeParty>[\s\S]*?)<ram:PostalTradeAddress>[\s\S]*?<\/ram:PostalTradeAddress>/, "$1");
    const found = validateInput(parseCiiInvoice(c).invoice).errors.map((e) => e.rule);
    expect(found).toContain("BR-10");
    expect(found).toContain("BR-11");
  });

  it("counts a VAT total whose currencyID is the invoice currency in lower case", () => {
    const u = ubl.replace(/(<cac:TaxTotal>\s*<cbc:TaxAmount currencyID=")EUR"/, '$1eur"');
    expect(u).not.toBe(ubl);
    expect(parseUbl(u).invoice.declaredTotals?.taxTotalsInInvoiceCurrency).toBe(1);
  });
});

describe("BR-CL-17 / BR-CL-18 on JSON input", () => {
  it("a CII profile reports a bad category once, as BR-CL-18 on the line", () => {
    const found = ids(withInvoice({ profile: "facturx-en16931", lines: [cleanLine({ vatCategory: "Q" as never })] }));
    expect(found).toContain("BR-CL-18");
    expect(found).not.toContain("BR-CL-17");
  });
});

describe("second-pass survivors", () => {
  it("says why text with a control character is fatal, or only a warning", () => {
    const fatal = findings(withInvoice({ note: "\u0001" })).find((e) => e.rule === "ATW-TEXT-NOT-XML")!;
    expect(fatal.message).toContain("nothing is left");
    const warning = findings(withInvoice({ note: "ok\u0001" })).find((e) => e.rule === "ATW-TEXT-NOT-XML")!;
    expect(warning.severity).toBe("warning");
    expect(warning.message).toContain("slightly different");
  });

  it("UBL: a cac:Price with no PriceAmount is BR-26, not a price of 0", () => {
    const ubl = readFileSync(new URL("../fixtures/xrechnung-ubl-minimal.xml", import.meta.url), "utf8");
    const x = ubl.replace(/(<cac:Price>\s*)<cbc:PriceAmount[^>]*>[^<]*<\/cbc:PriceAmount>/, "$1");
    expect(x).toContain("<cac:Price>");
    expect(x).not.toBe(ubl);
    expect(validateInput(parseUbl(x).invoice).errors.map((e) => e.rule)).toContain("BR-26");
  });

  it("a stated O group at rate 0 is matched to the lines, not compared with 0", () => {
    const inv = withInvoice({
      lines: [cleanLine({ vatCategory: "O", vatRate: undefined })],
      declaredTotals: {
        syntax: "ubl",
        specificationIdentifier: "x",
        subtotals: [{ category: "O", rate: 0, taxableAmount: 1400, taxAmount: 0 }],
      },
    });
    const f = findings(inv).find((e) => e.rule === "BR-O-08")!;
    expect(f.message).toContain("come to 1500.00");
  });
});
