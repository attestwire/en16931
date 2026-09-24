import { describe, expect, it } from "vitest";
import { generateCii, generateXRechnungUBL, parseCiiInvoice, parseUbl, validateInput } from "./index.js";
import { clean, cleanLine, withInvoice } from "./testkit.js";

// The readers and the stated-breakdown checks, from real XML. Each case below
// was a review probe on 2026-09-23 with KoSIT 1.6.2 / XRechnung 3.0.2 as the
// reference; the expectation is KoSIT's verdict on the same shape. Until these
// existed, reverting any of the reader changes left the suite green.
const rules = (result: ReturnType<typeof validateInput>) =>
  [...result.errors, ...result.warnings].map((e) => e.rule);
const ubl = (edit: (xml: string) => string) => {
  const xml = edit(generateXRechnungUBL(clean));
  return validateInput(parseUbl(xml).invoice);
};
const cii = (edit: (xml: string) => string) => {
  const xml = edit(generateCii(withInvoice({ profile: "xrechnung-cii" })));
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
});
