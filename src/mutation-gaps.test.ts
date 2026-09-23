import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { computeTotals, generateXRechnungUBL, parseCiiInvoice, parseUbl, validateInput } from "./index.js";
import { clean, cleanLine, errorIds, warningIds, withInvoice, withLine } from "./testkit.js";
import { formatPrice } from "./totals.js";

// Mutation testing on 2026-09-23 (682 mutants, 86 survivors) found places
// where a planted bug left every test green. Each test here kills one of them;
// the comment names the mutant.

describe("money formatting and defaults", () => {
  // totals.ts: `value === 0` -> `value === 1` survived: nothing formatted 1.
  it("formats a price of exactly 1", () => {
    expect(formatPrice(1)).toBe("1.00");
    expect(formatPrice(0)).toBe("0.00");
  });

  // totals.ts: `vatRate ?? 0` -> `?? 1` survived, for lines and for document
  // allowances and charges. Only rated categories (S, L, M) reach the default;
  // a first version of this test used Z, which is always 0%, and missed it.
  it("taxes an S line or charge with no VAT rate at zero, not one percent", () => {
    expect(computeTotals(withLine({ vatCategory: "S", vatRate: undefined })).taxAmount).toBe(0);
    const charged = computeTotals(
      withInvoice({
        lines: [cleanLine({ vatCategory: "Z", vatRate: 0 })],
        charges: [{ amount: 100, vatCategory: "S", reason: "Freight" } as never],
      }),
    );
    expect(charged.taxAmount).toBe(0);
  });

  // totals.ts: a missing charge amount counted as 1 survived.
  it("adds nothing for a document charge with no amount", () => {
    const base = computeTotals(clean);
    const withCharge = computeTotals(
      withInvoice({
        charges: [{ vatCategory: "S", vatRate: 19, reason: "Freight" } as never],
      }),
    );
    expect(withCharge.taxExclusiveAmount).toBe(base.taxExclusiveAmount);
  });

  // totals.ts: `&&` -> `||` in the finiteness guards survived: they made
  // computeTotals throw on input that validateInput reports instead.
  it("does not throw on a non-finite document allowance or rounding amount", () => {
    expect(() =>
      computeTotals(withInvoice({ allowances: [{ amount: Number.NaN, vatCategory: "S", vatRate: 19, reason: "x" }] })),
    ).not.toThrow();
    expect(() => computeTotals(withInvoice({ roundingAmount: Number.POSITIVE_INFINITY }))).not.toThrow();
    expect(() =>
      computeTotals(withInvoice({ charges: [{ amount: Number.NaN, vatCategory: "S", vatRate: 19, reason: "x" }] })),
    ).not.toThrow();
  });
});

describe("rules with a half nothing exercised", () => {
  // rules.ts: the BR-IC-02 entry could be deleted, or its id swapped.
  it("BR-IC-02: an intra-community supply needs the seller's VAT identifier", () => {
    const k = { vatCategory: "K" as const, vatRate: 0 };
    const withoutSellerVat = withInvoice({
      seller: { ...clean.seller, vatId: undefined },
      lines: [cleanLine(k)],
    });
    expect(errorIds(withoutSellerVat)).toContain("BR-IC-02");
    expect(errorIds(withInvoice({ lines: [cleanLine(k)] }))).not.toContain("BR-IC-02");
  });

  // rules-core.ts: BR-28 `< 0` -> `<= 0` survived.
  it("BR-28: a gross price of zero is not negative", () => {
    expect(errorIds(withLine({ grossUnitPrice: 0, unitPrice: 0 }))).not.toContain("BR-28");
    expect(errorIds(withLine({ grossUnitPrice: -1 }))).toContain("BR-28");
  });

  // rules-allowance.ts: `&&` -> `||` let a negative IGIC/IPSI rate through.
  it("a document allowance in category L cannot have a negative rate", () => {
    const inv = withInvoice({
      lines: [cleanLine({ vatCategory: "L", vatRate: 7 })],
      allowances: [{ amount: 5, vatCategory: "L", vatRate: -5, reason: "Discount" }],
    });
    expect(errorIds(inv).some((id) => id.startsWith("BR-AF-"))).toBe(true);
  });

  // rules-peppol.ts: the Partita IVA checksum loop could start at index 1.
  it("PEPPOL-COMMON-R047: a Partita IVA with a wrong first digit is rejected", () => {
    // An independent Partita IVA check digit: odd positions plain, even
    // positions doubled with the digits of the product summed.
    const checkDigit = (ten: string) => {
      let sum = 0;
      for (let i = 0; i < 10; i++) {
        const d = Number(ten[i]);
        sum += i % 2 === 0 ? d : d * 2 > 9 ? d * 2 - 9 : d * 2;
      }
      return String((10 - (sum % 10)) % 10);
    };
    const valid = "0123456789" + checkDigit("0123456789");
    const wrongFirst = "5" + valid.slice(1);
    const peppol = (value: string) =>
      withInvoice({
        profile: "peppol-bis-3",
        seller: { ...clean.seller, identifier: { schemeId: "0211", value: `IT${value}` } },
      });
    // A warning in Peppol's own schematron, so it is a warning here.
    expect(warningIds(peppol(valid))).not.toContain("PEPPOL-COMMON-R047");
    expect(warningIds(peppol(wrongFirst))).toContain("PEPPOL-COMMON-R047");
  });
});

// Differential test against KoSIT, 2026-09-23: BR-IC-11 ignored BG-14.
describe("BR-IC-11", () => {
  const k = [cleanLine({ vatCategory: "K", vatRate: 0 })];
  it("is satisfied by an invoicing period, as in the official schematron", () => {
    const withPeriod = withInvoice({
      lines: k,
      deliveryDate: undefined,
      invoicingPeriod: { startDate: "2026-08-01", endDate: "2026-08-31" },
    });
    expect(errorIds(withPeriod)).not.toContain("BR-IC-11");
  });
  it("still fires with neither a delivery date nor a period", () => {
    expect(errorIds(withInvoice({ lines: k, deliveryDate: undefined }))).toContain("BR-IC-11");
  });
});

// Differential test against KoSIT, 2026-09-23: the CEN CII schematron checks
// BR-S-08 (and O, AF, AG) exactly; UBL, and the other categories, allow ±1.
describe("BR-S-08 tolerance by syntax", () => {
  const read = (name: string) =>
    readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

  it("CII: a stated S taxable amount one cent off is BR-S-08", () => {
    const xml = read("xrechnung-cii-minimal.xml").replace(
      "<ram:BasisAmount>1500.00</ram:BasisAmount>",
      "<ram:BasisAmount>1500.01</ram:BasisAmount>",
    );
    const invoice = parseCiiInvoice(xml).invoice;
    expect(invoice.declaredTotals?.syntax).toBe("cii");
    const s08 = validateInput(invoice).errors.find((e) => e.rule === "BR-S-08");
    expect(s08?.message).toMatch(/exactly/);
  });

  it("UBL: the same cent is within the ±1 tolerance", () => {
    const xml = read("xrechnung-ubl-minimal.xml").replace(
      '<cbc:TaxableAmount currencyID="EUR">1500.00</cbc:TaxableAmount>',
      '<cbc:TaxableAmount currencyID="EUR">1500.01</cbc:TaxableAmount>',
    );
    const invoice = parseUbl(xml).invoice;
    expect(invoice.declaredTotals?.syntax).toBe("ubl");
    expect(validateInput(invoice).errors.map((e) => e.rule)).not.toContain("BR-S-08");
  });
});

// Differential test against KoSIT, 2026-09-23: BT-110 is the VAT total in the
// invoice currency, and BR-CO-15 needs exactly one.
describe("BR-CO-15 selects BT-110 by currency", () => {
  const read = (name: string) =>
    readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
  const rules = (inv: Parameters<typeof validateInput>[0]) => validateInput(inv).errors.map((e) => e.rule);

  it("UBL: the only VAT total in another currency is not BT-110", () => {
    const xml = read("xrechnung-ubl-minimal.xml").replace(
      /(<cac:TaxTotal>\s*<cbc:TaxAmount currencyID=")EUR"/,
      '$1USD"',
    );
    expect(xml).toContain('<cbc:TaxAmount currencyID="USD"');
    expect(rules(parseUbl(xml).invoice)).toContain("BR-CO-15");
    expect(rules(parseUbl(read("xrechnung-ubl-minimal.xml")).invoice)).not.toContain("BR-CO-15");
  });

  it("CII: the same, for ram:TaxTotalAmount", () => {
    const xml = read("xrechnung-cii-minimal.xml").replace(
      /<ram:TaxTotalAmount currencyID="EUR">/,
      '<ram:TaxTotalAmount currencyID="USD">',
    );
    expect(xml).toContain('<ram:TaxTotalAmount currencyID="USD">');
    expect(rules(parseCiiInvoice(xml).invoice)).toContain("BR-CO-15");
    expect(rules(parseCiiInvoice(read("xrechnung-cii-minimal.xml")).invoice)).not.toContain("BR-CO-15");
  });
});

// Differential test against KoSIT, 2026-09-23: BR-CL-17 is the breakdown's
// own category code (cac:TaxCategory), BR-CL-18 the line's.
describe("BR-CL-17 on a document's stated breakdown", () => {
  const xml = readFileSync(new URL("../fixtures/xrechnung-ubl-minimal.xml", import.meta.url), "utf8");
  const rules = (x: string) => validateInput(parseUbl(x).invoice).errors.map((e) => e.rule);

  it("fires for a bad code in the stated breakdown", () => {
    const bad = xml.replace(
      /(<cac:TaxSubtotal>[\s\S]*?<cac:TaxCategory>\s*<cbc:ID>)S(<\/cbc:ID>)/,
      "$1Q$2",
    );
    expect(bad).not.toBe(xml);
    expect(rules(bad)).toContain("BR-CL-17");
  });

  it("does not repeat a bad line code as BR-CL-17", () => {
    const bad = xml.replace(
      /(<cac:ClassifiedTaxCategory>\s*<cbc:ID>)S(<\/cbc:ID>)/,
      "$1Q$2",
    );
    expect(bad).not.toBe(xml);
    const found = rules(bad);
    expect(found).toContain("BR-CL-18");
    expect(found).not.toContain("BR-CL-17");
  });
});

describe("BR-CL-18 on a CII document's stated breakdown", () => {
  it("reports a bad breakdown code as BR-CL-18, as the CII binding does", () => {
    const xml = readFileSync(new URL("../fixtures/xrechnung-cii-minimal.xml", import.meta.url), "utf8");
    const bad = xml.replace(
      /(<ram:BasisAmount>1500\.00<\/ram:BasisAmount>\s*<ram:CategoryCode>)S(<\/ram:CategoryCode>)/,
      "$1Q$2",
    );
    expect(bad).not.toBe(xml);
    const found = validateInput(parseCiiInvoice(bad).invoice).errors;
    expect(found.some((e) => e.rule === "BR-CL-18" && e.field === "BT-118")).toBe(true);
    expect(found.map((e) => e.rule)).not.toContain("BR-CL-17");
  });
});

// Differential test against KoSIT, 2026-09-23: a missing postal address was
// read as a blank one, so BR-08 / BR-10 never fired and BR-09 did instead.
describe("a missing postal address is BR-08 / BR-10", () => {
  const xml = readFileSync(new URL("../fixtures/xrechnung-ubl-minimal.xml", import.meta.url), "utf8");
  it("seller: BR-08, not BR-09", () => {
    const x = xml.replace(/(<cac:AccountingSupplierParty>[\s\S]*?)<cac:PostalAddress>[\s\S]*?<\/cac:PostalAddress>/, "$1");
    const rules = validateInput(parseUbl(x).invoice).errors.map((e) => e.rule);
    expect(rules).toContain("BR-08");
    expect(rules).not.toContain("BR-09");
  });
  it("buyer: BR-10, not BR-11", () => {
    const x = xml.replace(/(<cac:AccountingCustomerParty>[\s\S]*?)<cac:PostalAddress>[\s\S]*?<\/cac:PostalAddress>/, "$1");
    const rules = validateInput(parseUbl(x).invoice).errors.map((e) => e.rule);
    expect(rules).toContain("BR-10");
    expect(rules).not.toContain("BR-11");
  });
});

// Differential test against KoSIT, 2026-09-23: rules that could only see the
// computed breakdown now see the one a document states.
describe("the breakdown a document states", () => {
  const ubl = readFileSync(new URL("../fixtures/xrechnung-ubl-minimal.xml", import.meta.url), "utf8");
  const zeroRated = readFileSync(new URL("../fixtures/xrechnung-ubl-reverse-charge.xml", import.meta.url), "utf8");
  const rules = (x: string) => validateInput(parseUbl(x).invoice).errors.map((e) => e.rule);

  it("no breakdown at all is BR-CO-18 and BR-S-01", () => {
    const x = ubl.replace(/<cac:TaxSubtotal>[\s\S]*?<\/cac:TaxSubtotal>\s*/g, "");
    expect(x).not.toContain("TaxSubtotal");
    const found = rules(x);
    expect(found).toContain("BR-CO-18");
    expect(found).toContain("BR-S-01");
  });

  it("a nonzero VAT amount in a reverse-charge group is BR-AE-09, even at 0.01", () => {
    const x = zeroRated.replace(
      /(<cac:TaxSubtotal>[\s\S]*?<cbc:TaxAmount currencyID="EUR">)0\.00(<\/cbc:TaxAmount>)/,
      "$10.01$2",
    );
    expect(x).not.toBe(zeroRated);
    expect(rules(x)).toContain("BR-AE-09");
  });

  it("UBL: a zero-rate group's taxable amount one cent off is -08 (exact in UBL)", () => {
    const x = zeroRated.replace(
      /(<cac:TaxSubtotal>\s*<cbc:TaxableAmount currencyID="EUR">)(\d+)\.(\d\d)/,
      (_m, pre, whole, cents) => `${pre}${whole}.${String((Number(cents) + 1) % 100).padStart(2, "0")}`,
    );
    expect(x).not.toBe(zeroRated);
    expect(rules(x)).toContain("BR-AE-08");
  });

  it("a document without BT-24 is BR-01", () => {
    const x = ubl.replace(/<cbc:CustomizationID>[^<]*<\/cbc:CustomizationID>\s*/, "");
    expect(rules(x)).toContain("BR-01");
    expect(rules(ubl)).not.toContain("BR-01");
  });
});

// 2026-09-23: VAT in a currency with no minor unit is whole units.
describe("zero-decimal currencies", () => {
  const jpy = withInvoice({
    currency: "JPY",
    lines: [cleanLine({ quantity: 1, unitPrice: 1234, vatCategory: "S", vatRate: 19 })],
  });

  it("rounds each group's VAT to whole yen (1,234 at 19% is 234, not 234.46)", () => {
    const t = computeTotals(jpy);
    expect(t.subtotals[0]!.taxAmount).toBe(234);
    expect(t.taxAmount).toBe(234);
    expect(t.taxInclusiveAmount).toBe(1468);
    expect(computeTotals(withInvoice({ ...jpy, currency: "EUR" })).taxAmount).toBe(234.46);
  });

  it("rounds half up in whole units, as in cents (KRW 2,500 at 10% + 5 is 250.5 -> 251)", () => {
    const krw = withInvoice({
      currency: "KRW",
      lines: [cleanLine({ quantity: 1, unitPrice: 2505, vatCategory: "S", vatRate: 10 })],
    });
    expect(computeTotals(krw).taxAmount).toBe(251);
  });

  it("validates and round-trips through UBL", () => {
    expect(validateInput(jpy).errors).toEqual([]);
    const back = parseUbl(generateXRechnungUBL(jpy)).invoice;
    expect(validateInput(back).errors).toEqual([]);
    expect(computeTotals(back).taxAmount).toBe(234);
  });
});

// Benchmark, 2026-09-23: the CII binding of BR-CO-15 also passes when the
// grand total equals the tax basis total, so a no-VAT CII invoice may omit
// the VAT total. Three official CEN/KoSIT examples do exactly that.
describe("BR-CO-15 on a CII invoice with no VAT total", () => {
  const cii = readFileSync(new URL("../fixtures/xrechnung-cii-minimal.xml", import.meta.url), "utf8");
  it("passes when grand total equals the tax basis total", () => {
    const inv = parseCiiInvoice(cii).invoice;
    const d = inv.declaredTotals!;
    // The arithmetic half of BR-CO-15 may still fire on this synthetic
    // document (it charges VAT); the currency-count half must not.
    const currencyCount = validateInput({
      ...inv,
      declaredTotals: { ...d, taxTotalsInInvoiceCurrency: 0, taxInclusiveAmount: d.taxExclusiveAmount },
    }).errors.filter((e) => e.rule === "BR-CO-15" && /invoice currency/.test(e.message));
    expect(currencyCount).toEqual([]);
  });
  it("still fires when VAT is charged but no VAT total is in the invoice currency", () => {
    const inv = parseCiiInvoice(cii).invoice;
    const rules = validateInput({
      ...inv,
      declaredTotals: { ...inv.declaredTotals!, taxTotalsInInvoiceCurrency: 0 },
    }).errors.map((e) => e.rule);
    expect(rules).toContain("BR-CO-15");
  });
});

// Second differential run (2026-09-23): regressions and false positives that
// today's stricter checks introduced, each matched to KoSIT's verdict.
describe("differential round 2", () => {
  const read = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), "utf8");
  const ubl = read("xrechnung-ubl-minimal.xml");
  const cii = read("xrechnung-cii-minimal.xml");
  const ublRules = (x: string) => validateInput(parseUbl(x).invoice).errors.map((e) => e.rule);
  const ciiRules = (x: string) => validateInput(parseCiiInvoice(x).invoice).errors.map((e) => e.rule);

  it("PEPPOL-R120 still judges a line with no quantity (Peppol reads it as 1)", () => {
    const x = ubl.replace(/<cbc:InvoicedQuantity[^>]*>[^<]*<\/cbc:InvoicedQuantity>/, "");
    const found = ublRules(x);
    expect(found).toContain("BR-22");
    expect(found).toContain("PEPPOL-EN16931-R120");
  });

  it("CII: a missing seller address is BR-08 and BR-09, as the CII binding asserts both", () => {
    const x = cii.replace(/(<ram:SellerTradeParty>[\s\S]*?)<ram:PostalTradeAddress>[\s\S]*?<\/ram:PostalTradeAddress>/, "$1");
    const found = ciiRules(x);
    expect(found).toContain("BR-08");
    expect(found).toContain("BR-09");
  });

  it("a stated group at a rate no line carries is -08 (the official sum is 0)", () => {
    const x = cii.replace("<ram:RateApplicablePercent>7.00</ram:RateApplicablePercent>", "<ram:RateApplicablePercent>8.00</ram:RateApplicablePercent>");
    expect(x).not.toBe(cii);
    expect(ciiRules(x)).toContain("BR-S-08");
  });

  it("a stated group with no lines behind it is not also a reverse -01", () => {
    // Every line moves to Z; the stated breakdown still has its S groups.
    const x = ubl.replace(
      /(<cac:ClassifiedTaxCategory>\s*<cbc:ID>)S(<\/cbc:ID>\s*<cbc:Percent>)[\d.]+/g,
      "$1Z$20",
    );
    expect(x).not.toMatch(/<cac:ClassifiedTaxCategory>\s*<cbc:ID>S/);
    const found = ublRules(x);
    expect(found).not.toContain("BR-S-01");
    expect(found).toContain("BR-S-08"); // what KoSIT reports instead
  });
});
