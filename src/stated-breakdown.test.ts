import { describe, expect, it } from "vitest";
import { generateCii, generateXRechnungUBL, parseCiiInvoice, parseUbl, validateInput } from "./index.js";
import { clean, cleanLine, withInvoice } from "./testkit.js";
import type { InvoiceInput } from "./types.js";

// The readers and the stated-breakdown checks, from real XML. Each case below
// was a review probe on 2026-09-23 with KoSIT 1.6.2 / XRechnung 3.0.2 as the
// reference; the expectation is KoSIT's verdict on the same shape. Until these
// existed, reverting any of the reader changes left the suite green.
const rules = (result: ReturnType<typeof validateInput>) =>
  [...result.errors, ...result.warnings].map((e) => e.rule);
const ubl = (edit: (xml: string) => string, inv: InvoiceInput = clean) => {
  const xml = edit(generateXRechnungUBL(inv));
  return validateInput(parseUbl(xml).invoice);
};
const cii = (edit: (xml: string) => string, inv: InvoiceInput = clean) => {
  const xml = edit(generateCii({ ...inv, profile: "xrechnung-cii" }));
  return validateInput(parseCiiInvoice(xml).invoice);
};
// The header breakdown group, not the line's ram:ApplicableTradeTax.
const HEADER_TAX = /(<ram:ApplicableHeaderTradeSettlement>[\s\S]*?)(<ram:ApplicableTradeTax>[\s\S]*?<\/ram:ApplicableTradeTax>)/;

describe("the VAT breakdown a document states", () => {
  it("baselines are valid in both syntaxes", () => {
    expect(ubl((x) => x).valid).toBe(true);
    expect(cii((x) => x).valid).toBe(true);
  });

  it("UBL: a group with no taxable amount is BR-45", () => {
    const result = ubl((x) => x.replace(/(<cac:TaxSubtotal>\s*)<cbc:TaxableAmount[^>]*>[^<]*<\/cbc:TaxableAmount>/, "$1"));
    expect(rules(result)).toContain("BR-45");
    expect(result.valid).toBe(false);
  });

  it("UBL: a group without its TaxCategory is kept and judged (BR-47, BR-48)", () => {
    const result = ubl((x) => x.replace(/(<cac:TaxSubtotal>[\s\S]*?)<cac:TaxCategory>[\s\S]*?<\/cac:TaxCategory>/, "$1"));
    expect(rules(result)).toEqual(expect.arrayContaining(["BR-47", "BR-48"]));
  });

  it("CII: a group holding only a TypeCode is kept and judged (BR-45 to BR-48)", () => {
    const result = cii((x) =>
      x.replace(HEADER_TAX, "$1$2<ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode></ram:ApplicableTradeTax>"),
    );
    expect(rules(result)).toEqual(expect.arrayContaining(["BR-45", "BR-46", "BR-47", "BR-48"]));
  });

  it("UBL reads category codes as normalize-space does, everywhere: consistent padding is valid", () => {
    const result = ubl((x) => x.replaceAll("<cbc:ID>S</cbc:ID>", "<cbc:ID> S </cbc:ID>"));
    expect(rules(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("UBL: a padded category O is category O, so its group needs no rate (no BR-48)", () => {
    // Where trimming changes the verdict: category O is the one group BR-48
    // excuses from a rate, and " O " is O under normalize-space.
    const outOfScope = withInvoice({
      profile: "en16931",
      seller: { ...clean.seller, vatId: undefined, taxRegistrationId: "18/181/08155" },
      buyer: { ...clean.buyer, vatId: undefined },
      lines: [cleanLine({ vatCategory: "O", vatRate: undefined })],
      vatExemptionReasons: { O: "Not subject to VAT" },
    });
    const xml = generateXRechnungUBL(outOfScope);
    const baseline = rules(validateInput(parseUbl(xml).invoice));
    const padded = xml.replaceAll("<cbc:ID>O</cbc:ID>", "<cbc:ID> O </cbc:ID>");
    expect(padded).not.toBe(xml);
    const result = rules(validateInput(parseUbl(padded).invoice));
    expect(baseline).not.toContain("BR-48");
    // Padding changes nothing: the same findings, and no BR-48.
    expect(result).toEqual(baseline);
  });

  it("CII compares ram:CategoryCode literally, and KoSIT accepts consistent padding there too", () => {
    const result = cii((x) => x.replaceAll("<ram:CategoryCode>S</ram:CategoryCode>", "<ram:CategoryCode> S </ram:CategoryCode>"));
    expect(result.valid).toBe(true);
  });

  it("reports a group with no category once, as BR-47, when a line has none too", () => {
    const result = cii((x) => x.replaceAll(/<ram:CategoryCode>S<\/ram:CategoryCode>/g, ""));
    expect(rules(result).filter((r) => r === "BR-47")).toHaveLength(1);
    expect(rules(result)).toContain("BR-CO-04");
  });

  it("does not report BR-47 for a line with no category when every group has one", () => {
    const result = cii((x) =>
      x.replace(/(<ram:IncludedSupplyChainTradeLineItem>[\s\S]*?)<ram:CategoryCode>S<\/ram:CategoryCode>/, "$1"),
    );
    expect(rules(result)).toContain("BR-CO-04");
    expect(rules(result)).not.toContain("BR-47");
  });

  it("names a group whose category code is not in UNCL5305 by a well-formed rule id", () => {
    // Both readers keep BT-118 as written and cast it to VatCategory, so a group
    // can carry a code CATEGORY_RULE_INFIX has no entry for. The stated -08
    // check still runs on it, and its id falls back to S; without the fallback
    // it is "BR-undefined-08". KoSIT (2026-10-03) reports BR-CL-17 (UBL) or
    // BR-CL-18 (CII) and BR-S-01 on these shapes, and no -08 at all: each -08
    // context selects its own code. This build adds a BR-S-08 there; the test
    // pins only that every id it reports is well formed.
    const groupQ = [
      [ubl((x) => x.replace(/(<cac:TaxSubtotal>[\s\S]*?<cac:TaxCategory>\s*<cbc:ID>)S(<\/cbc:ID>)/, "$1Q$2")), "BR-CL-17"],
      [cii((x) => x.replace(/(<ram:BasisAmount>1500\.00<\/ram:BasisAmount>\s*<ram:CategoryCode>)S(<\/ram:CategoryCode>)/, "$1Q$2")), "BR-CL-18"],
    ] as const;
    for (const [result, codeListRule] of groupQ) {
      expect(rules(result)).toEqual(expect.arrayContaining([codeListRule, "BR-S-01"]));
      expect(rules(result).filter((id) => !/^[A-Z]+(-[A-Z0-9]+)+$/.test(id))).toEqual([]);
    }
  });
});

// BT-117 at a half cent, a whole unit of currency off. 1,034.10 at 25% is
// 258.525. CEN-EN16931-UBL.sch casts BT-116 and BT-119 to xs:decimal, so its
// BR-S-09 and BR-CO-17 both expect 258.53, half up. CEN-EN16931-CII.sch's
// BR-S-09 leaves ram:RateApplicablePercent uncast, so XPath multiplies in
// xs:double, where 1034.1 × 25 is 25852.499999999996, and expects 258.52; its
// BR-CO-17 casts both and expects 258.53. A stated 259.52 or 257.53 is exactly
// 1.00 from one of the two, on the edge of the exclusive tolerance. Every
// expectation is KoSIT 1.6.3's verdict, XRechnung 3.0.2 (2026-08-31), on these
// documents, 2026-10-03.
describe("BR-S-09 at a half cent, on the edge of its tolerance", () => {
  const at25 = withInvoice({ lines: [cleanLine({ unitPrice: 103.41, vatRate: 25 })] });
  // BT-117 and BT-110 move together, and BT-112 and BT-115 with them, so only
  // the group's VAT arithmetic is off.
  const restate = (tax: number) => (xml: string) => {
    const out = xml
      .replaceAll(">258.53<", `>${tax.toFixed(2)}<`)
      .replaceAll(">1292.63<", `>${(1034.1 + tax).toFixed(2)}<`);
    expect(out.split(`>${tax.toFixed(2)}<`)).toHaveLength(3);
    return out;
  };

  it("generates 258.53, valid in both syntaxes", () => {
    expect(generateXRechnungUBL(at25)).toContain(">258.53<");
    expect(rules(ubl((x) => x, at25))).toEqual([]);
    expect(rules(cii((x) => x, at25))).toEqual([]);
  });

  it("UBL: 259.52, 0.99 above 258.53, is accepted", () => {
    expect(rules(ubl(restate(259.52), at25))).toEqual([]);
  });

  it("UBL: 257.53, exactly 1.00 below 258.53, is BR-S-09 and BR-CO-17", () => {
    expect(rules(ubl(restate(257.53), at25)).sort()).toEqual(["BR-CO-17", "BR-S-09"]);
  });

  it("CII: 259.52, exactly 1.00 above BR-S-09's 258.52, is BR-S-09 alone", () => {
    expect(rules(cii(restate(259.52), at25))).toEqual(["BR-S-09"]);
  });

  it("CII: 257.53, exactly 1.00 below BR-CO-17's 258.53, is accepted: CII's BR-CO-17 includes the bound", () => {
    // 0.99 from BR-S-09's 258.52, so only BR-CO-17 could object, and
    // CEN-EN16931-CII.sch writes it with <= and >=.
    expect(rules(cii(restate(257.53), at25))).toEqual([]);
  });

  it("JSON input has no syntax and is held to 258.53, the amount the library computes", () => {
    const stated = (taxAmount: number) =>
      rules(
        validateInput({
          ...at25,
          declaredTotals: { subtotals: [{ category: "S", rate: 25, taxableAmount: 1034.1, taxAmount }] },
        }),
      );
    expect(stated(259.52)).not.toContain("BR-S-09");
    expect(stated(257.53)).toContain("BR-S-09");
  });
});

// BT-117 exactly a whole unit of currency from the amount it is checked
// against, away from any half cent. Both schematrons compute
// `abs(xs:decimal(BT-117)) - 1` and `+ 1` in xs:decimal, which is exact: 32.01
// - 1 is 31.01, not below it. In binary floating point it is
// 31.009999999999998, and the engine let these groups through. CII's BR-CO-17
// differs from UBL's twice: it includes the bound (S at a half cent, above),
// and it never reaches a group of category L, M or O. Every expectation is
// KoSIT 1.6.3's verdict, XRechnung 3.0.2 (2026-08-31), on these documents,
// 2026-10-03.
describe("BT-117 exactly a whole unit of currency off", () => {
  const at19 = (unitPrice: number) => withInvoice({ lines: [cleanLine({ unitPrice })] });
  const regional = (vatCategory: "L" | "M", vatRate: number) =>
    withInvoice({ lines: [cleanLine({ vatCategory, vatRate })] });
  // BT-117 and BT-110 restated from `tax` to `to`, and BT-112 and BT-115 from
  // `base + tax` with them, so only the group's VAT arithmetic is off.
  const restate = (base: number, tax: number, to: number) => (xml: string) => {
    const amount = (value: number) => `>${value.toFixed(2)}<`;
    const out = xml.replaceAll(amount(tax), amount(to)).replaceAll(amount(base + tax), amount(base + to));
    expect(out.split(amount(to))).toHaveLength(3);
    expect(out.split(amount(base + to))).toHaveLength(3);
    return out;
  };

  it("generates valid documents in both syntaxes", () => {
    for (const inv of [at19(16.32), at19(8.49), regional("L", 7), regional("M", 4)]) {
      expect(rules(ubl((x) => x, inv))).toEqual([]);
      expect(rules(cii((x) => x, inv))).toEqual([]);
    }
  });

  it("32.01 on 163.20 at 19%, exactly 1.00 above 31.01, is UBL BR-S-09 and BR-CO-17, CII BR-S-09", () => {
    const edit = restate(163.2, 31.01, 32.01);
    expect(rules(ubl(edit, at19(16.32))).sort()).toEqual(["BR-CO-17", "BR-S-09"]);
    expect(rules(cii(edit, at19(16.32)))).toEqual(["BR-S-09"]);
  });

  it("15.13 on 84.90 at 19%, exactly 1.00 below 16.13, is UBL BR-S-09 and BR-CO-17, CII BR-S-09", () => {
    const edit = restate(84.9, 16.13, 15.13);
    expect(rules(ubl(edit, at19(8.49))).sort()).toEqual(["BR-CO-17", "BR-S-09"]);
    expect(rules(cii(edit, at19(8.49)))).toEqual(["BR-S-09"]);
  });

  it("CII never applies BR-CO-17 to a category L or M group, which UBL rejects", () => {
    // Not the inclusive bound: 1.01 off is accepted too. In CEN-EN16931-CII.sch
    // BR-CO-17 sits in the rule for every header ram:ApplicableTradeTax, and the
    // rules for L, M and O match that same element earlier in the pattern, so it
    // is suppressed there (Saxon's SVRL: svrl:suppressed-rule). With BR-AF-09
    // and BR-AG-09 `true()`, nothing in CII checks these groups' VAT amount.
    const cases = [
      [regional("L", 7), restate(1500, 105, 106), "BR-AF-09"],
      [regional("L", 7), restate(1500, 105, 104), "BR-AF-09"],
      [regional("L", 7), restate(1500, 105, 106.01), "BR-AF-09"],
      [regional("L", 7), restate(1500, 105, 103.99), "BR-AF-09"],
      [regional("M", 4), restate(1500, 60, 61), "BR-AG-09"],
      [regional("M", 4), restate(1500, 60, 62.5), "BR-AG-09"],
    ] as const;
    for (const [inv, edit, categoryRule] of cases) {
      expect(rules(ubl(edit, inv)).sort()).toEqual([categoryRule, "BR-CO-17"]);
      expect(rules(cii(edit, inv))).toEqual([]);
    }
  });

  it("CII never applies BR-CO-17 to a category O group either, which UBL does", () => {
    // An O group that writes BT-119 0, as documents often do, and BT-117 0.60:
    // BR-CO-17's zero-rate branch wants round(BT-117) = 0, and BR-O-09 wants 0.
    const outOfScope = withInvoice({
      seller: { ...clean.seller, vatId: undefined, taxRegistrationId: "18/181/08155", legalRegistrationId: "HRB 12345" },
      buyer: { ...clean.buyer, vatId: undefined },
      lines: [cleanLine({ vatCategory: "O", vatRate: undefined })],
      vatExemptionReasons: { O: "Not subject to VAT" },
    });
    const ublRate = (xml: string) =>
      xml.replace(/(<cac:TaxSubtotal>[\s\S]*?<cbc:ID>O<\/cbc:ID>)/, "$1<cbc:Percent>0</cbc:Percent>");
    const ciiRate = (xml: string) =>
      xml.replace(
        /(<ram:BasisAmount>1500\.00<\/ram:BasisAmount>[\s\S]*?)(<\/ram:ApplicableTradeTax>)/,
        "$1<ram:RateApplicablePercent>0</ram:RateApplicablePercent>$2",
      );
    // BT-117 and BT-110 to 0.60, and BT-112 and BT-115 with them, by element:
    // with no VAT, BT-112 is the same figure as BT-116.
    const at060 = (totals: RegExp) => (xml: string) => {
      const out = xml.replaceAll(">0.00<", ">0.60<").replace(totals, (_, open: string) => `${open}1500.60<`);
      expect(out.split(">0.60<")).toHaveLength(3);
      expect(out.split(">1500.60<")).toHaveLength(3);
      return out;
    };
    const ublTotals = /(<cbc:(?:TaxInclusive|Payable)Amount currencyID="EUR">)1500\.00</g;
    const ciiTotals = /(<ram:(?:GrandTotal|DuePayable)Amount>)1500\.00</g;
    expect(rules(ubl(ublRate, outOfScope))).toEqual([]);
    expect(rules(cii(ciiRate, outOfScope))).toEqual([]);
    expect(rules(ubl((x) => at060(ublTotals)(ublRate(x)), outOfScope)).sort()).toEqual(["BR-CO-17", "BR-O-09"]);
    expect(rules(cii((x) => at060(ciiTotals)(ciiRate(x)), outOfScope))).toEqual(["BR-O-09"]);
  });

  it("JSON input has no syntax and keeps the exclusive bound: 32.01 on 163.20 is outside", () => {
    // Only the group is stated, so BR-CO-14 also compares it with the computed
    // BT-110; the two rules under test are picked out.
    const stated = (taxAmount: number) =>
      rules(
        validateInput({
          ...at19(16.32),
          declaredTotals: { subtotals: [{ category: "S", rate: 19, taxableAmount: 163.2, taxAmount }] },
        }),
      ).filter((id) => id === "BR-S-09" || id === "BR-CO-17");
    expect(stated(32.0)).toEqual([]);
    expect(stated(32.01).sort()).toEqual(["BR-CO-17", "BR-S-09"]);
  });
});

// BT-116 exactly a whole unit of currency from its line, where -08 keeps
// binary floating point (withinSignedTolerance). CEN-EN16931-CII.sch's BR-Z-08
// subtracts and compares in xs:double: 32.01 - 1 is 31.009999999999998, below
// 31.01, and 17.13 - 1 is exactly the double 16.13 is read as. UBL's BR-Z-08
// compares exactly. A decimal tolerance here would reject the first CII
// document. KoSIT 1.6.3, XRechnung 3.0.2 (2026-08-31), 2026-10-03.
describe("BT-116 exactly a whole unit of currency off, in category Z", () => {
  const zeroRated = (unitPrice: number) =>
    withInvoice({ lines: [cleanLine({ quantity: 1, unitPrice, vatCategory: "Z", vatRate: 0 })] });
  const restateBase = (line: number, stated: number) => (xml: string) => {
    const out = xml.replace(
      new RegExp(`(<cbc:TaxableAmount currencyID="EUR">|<ram:BasisAmount>)${line.toFixed(2)}<`),
      (_, open: string) => `${open}${stated.toFixed(2)}<`,
    );
    expect(out).not.toBe(xml);
    return out;
  };

  it("CII accepts 32.01 against 31.01 and rejects 17.13 against 16.13", () => {
    expect(rules(cii((x) => x, zeroRated(31.01)))).toEqual([]);
    expect(rules(cii(restateBase(31.01, 32.01), zeroRated(31.01)))).toEqual([]);
    expect(rules(cii(restateBase(16.13, 17.13), zeroRated(16.13)))).toEqual(["BR-Z-08"]);
  });

  it("UBL rejects both", () => {
    expect(rules(ubl(restateBase(31.01, 32.01), zeroRated(31.01)))).toEqual(["BR-Z-08"]);
    expect(rules(ubl(restateBase(16.13, 17.13), zeroRated(16.13)))).toEqual(["BR-Z-08"]);
  });
});
