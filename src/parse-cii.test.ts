import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ParseError,
  UnsupportedCiiSyntaxError,
  UnsupportedCreditNoteError,
  UnsupportedSyntaxError,
  XmlSecurityError,
  fromCiiDate,
  generateCii,
  generateXRechnungUBL,
  parseCiiInvoice,
  parseUblInvoice,
  validateInput,
  type UnmappedElement,
} from "./index.js";
import {
  discountedXRechnungCii,
  extendedXRechnungCii,
  minimalXRechnung,
  minimalXRechnungCii,
  reverseChargeXRechnungCii,
} from "./fixtures.js";
import type { InvoiceInput } from "./types.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const read = (name: string) => readFileSync(join(fixturesDir, name), "utf8");

const cases: [string, InvoiceInput][] = [
  ["xrechnung-cii-minimal.xml", minimalXRechnungCii],
  ["xrechnung-cii-reverse-charge.xml", reverseChargeXRechnungCii],
  ["xrechnung-cii-discount.xml", discountedXRechnungCii],
  ["xrechnung-cii-extended.xml", extendedXRechnungCii],
];

/** The error code a call throws, or undefined if it does not throw. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof ParseError ? error.code : `not-a-ParseError:${error}`;
  }
}

const unknowns = (unmapped: UnmappedElement[]) =>
  unmapped.filter((u) => u.kind === "unknown");

const minimalXml = generateCii(minimalXRechnungCii);

describe("parseCiiInvoice: round trip over every committed CII fixture", () => {
  it.each(cases)(
    "%s parses back into an input that regenerates the identical document",
    (name) => {
      const xml = read(name);
      const { invoice } = parseCiiInvoice(xml);
      // The strongest correctness signal available: if any field were read into
      // the wrong place, or dropped, the regenerated document would differ.
      expect(generateCii(invoice)).toBe(xml);
    },
  );

  it.each(cases)("%s validates identically before and after", (name, input) => {
    const { invoice } = parseCiiInvoice(read(name));
    const before = validateInput(input);
    const after = validateInput(invoice);
    expect(after.errors.map((e) => e.rule)).toEqual(before.errors.map((e) => e.rule));
    expect(after.warnings.map((e) => e.rule)).toEqual(
      before.warnings.map((e) => e.rule),
    );
    expect(after.information.map((e) => e.rule)).toEqual(
      before.information.map((e) => e.rule),
    );
    expect(after.valid).toBe(true);
  });

  // ⚠ Changed 2026-08-12 (finding 9). BT-131, BT-116 and BT-117 used to be
  // reported as "recomputed" and then discarded, which is why a corrupt one
  // validated as `valid: true`. They now reach `declaredTotals` and are
  // compared, so a clean fixture leaves nothing unmapped at all.
  it.each(cases)("%s leaves nothing behind at all", (name) => {
    const { unmapped } = parseCiiInvoice(read(name));
    expect(unknowns(unmapped)).toEqual([]);
    expect(unmapped).toEqual([]);
  });

  it.each(cases)("%s reports the document's own arithmetic as declared", (name, input) => {
    const { invoice } = parseCiiInvoice(read(name));
    const declared = invoice.declaredTotals!;
    expect(declared.lineExtensionAmount).toBeDefined();
    expect(declared.payableAmount).toBeDefined();
    // Feeding them back through the rules must not trip a BR-CO finding.
    expect(validateInput({ ...invoice }).errors).toEqual([]);
    expect(declared.taxAmount).toBe(
      Number(
        /<ram:TaxTotalAmount[^>]*>([^<]*)</.exec(read(name))![1],
      ),
    );
    expect(input.currency).toBe(invoice.currency);
  });
});

describe("parseCiiInvoice: resolving by namespace URI, not by prefix", () => {
  /** Rename every prefix, leaving the namespace URIs alone. */
  const renamed = minimalXml
    .replace(/xmlns:rsm=/g, "xmlns:a=")
    .replace(/xmlns:ram=/g, "xmlns:b=")
    .replace(/xmlns:udt=/g, "xmlns:c=")
    .replace(/xmlns:qdt=/g, "xmlns:d=")
    .replace(/<(\/?)rsm:/g, "<$1a:")
    .replace(/<(\/?)ram:/g, "<$1b:")
    .replace(/<(\/?)udt:/g, "<$1c:")
    .replace(/<(\/?)qdt:/g, "<$1d:");

  it("reads a document that uses entirely different prefixes", () => {
    const { invoice } = parseCiiInvoice(renamed);
    expect(invoice.invoiceNumber).toBe("2026-000142");
    expect(invoice.seller.name).toBe("Musterlieferant GmbH");
    expect(generateCii(invoice)).toBe(minimalXml);
  });

  it("refuses a document whose element names look right but whose namespace is wrong", () => {
    const wrong = minimalXml.replace(
      "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100",
      "urn:example:not-cii",
    );
    expect(codeOf(() => parseCiiInvoice(wrong))).toBe("unsupported_syntax");
  });
});

describe("parseCiiInvoice: dates", () => {
  it("converts format-102 back to an ISO date", () => {
    expect(fromCiiDate("20260809")).toBe("2026-08-09");
    expect(fromCiiDate("  20260809 ")).toBe("2026-08-09");
  });

  it("carries a date it cannot recognise through untouched", () => {
    // Better an obviously wrong value the rules reject than an invented one.
    expect(fromCiiDate("2026-08-09")).toBe("2026-08-09");
    expect(fromCiiDate("later")).toBe("later");
    const odd = minimalXml.replace(">20260809<", ">later<");
    const { invoice } = parseCiiInvoice(odd);
    expect(invoice.issueDate).toBe("later");
    expect(validateInput(invoice).errors.map((e) => e.rule)).toContain(
      "ATW-DATE-NOT-A-CALENDAR-DATE",
    );
  });

  it("reads BT-26 from the qualified namespace", () => {
    const { invoice } = parseCiiInvoice(read("xrechnung-cii-discount.xml"));
    expect(invoice.precedingInvoices).toEqual([
      { invoiceNumber: "2026-000118", issueDate: "2026-07-15" },
    ]);
  });

  it("reads BT-7 from the VAT breakdown group that carries it", () => {
    const { invoice } = parseCiiInvoice(read("xrechnung-cii-extended.xml"));
    expect(invoice.taxPointDate).toBe("2026-08-07");
  });
});

describe("parseCiiInvoice: the groups CII places differently from UBL", () => {
  const { invoice } = parseCiiInvoice(read("xrechnung-cii-extended.xml"));

  it("reads BT-90 from the settlement into the payment instructions", () => {
    expect(invoice.payment?.directDebit).toEqual({
      mandateReference: "MANDAT-2026-0900",
      creditorIdentifier: "DE98ZZZ09999999999",
      debitedAccount: "DE02120300000000202051",
    });
  });

  it("reads BT-9 and BT-20 out of the payment terms group", () => {
    expect(invoice.dueDate).toBe("2026-09-08");
    expect(invoice.paymentTerms).toBe(
      "Der Betrag wird per Lastschrift eingezogen.",
    );
  });

  it("reads BT-31 and BT-32 back from schemeID VA and FC", () => {
    expect(invoice.seller.vatId).toBe("DE123456789");
    expect(invoice.seller.taxRegistrationId).toBe("181/815/08155");
  });

  it("reads BT-28 out of SpecifiedLegalOrganization", () => {
    expect(invoice.seller.tradingName).toBe("Muster Technik");
    expect(invoice.seller.legalRegistrationId).toBe("HRB 12345 B");
    expect(invoice.seller.legalRegistrationSchemeId).toBe("0060");
  });

  it("reads the payee and the tax representative", () => {
    expect(invoice.payee?.name).toBe("Factoring Nord AG");
    expect(invoice.payee?.identifier).toEqual({
      value: "4011111000005",
      schemeId: "0088",
    });
    expect(invoice.taxRepresentative?.vatId).toBe("NL123456789B01");
    expect(invoice.taxRepresentative?.address.city).toBe("Amsterdam");
  });

  it("splits ShipToTradeParty back into BT-70, BT-71 and BG-15", () => {
    expect(invoice.deliverToName).toBe("Zentrallager Nord");
    expect(invoice.deliverToLocationId).toEqual({
      value: "4098765000011",
      schemeId: "0088",
    });
    expect(invoice.deliverTo?.city).toBe("Hamburg");
    expect(invoice.deliveryDate).toBe("2026-08-07");
  });

  it("tells the three uses of AdditionalReferencedDocument apart", () => {
    expect(invoice.invoicedObjectIdentifier).toEqual({
      value: "ANL-2026-0900",
      schemeId: "AAJ",
    });
    expect(invoice.tenderOrLotReference).toBe("LOS-4");
    expect(invoice.supportingDocuments).toHaveLength(2);
    expect(invoice.supportingDocuments?.[1]?.attachment?.mimeCode).toBe("text/csv");
  });

  it("reads BT-6 and BT-111 apart by currencyID", () => {
    expect(invoice.vatAccountingCurrency).toBe("SEK");
    expect(invoice.taxAmountInAccountingCurrency).toBe(3255.6);
    expect(invoice.declaredTotals?.taxAmount).not.toBe(3255.6);
  });

  it("reads the gross price and its discount back into BT-148 and BT-147", () => {
    expect(invoice.lines[0]?.grossUnitPrice).toBe(50);
    expect(invoice.lines[0]?.priceDiscount).toBe(5);
    expect(invoice.lines[0]?.unitPrice).toBe(45);
    expect(invoice.lines[0]?.baseQuantity).toBe(1);
  });

  it("reads BT-21 from the real element, with no #CODE# to strip", () => {
    const { invoice: discounted } = parseCiiInvoice(
      read("xrechnung-cii-discount.xml"),
    );
    expect(discounted.noteSubjectCode).toBe("AAI");
    expect(discounted.note?.startsWith("#")).toBe(false);
  });
});

describe("parseCiiInvoice: what it refuses", () => {
  it("refuses a UBL Invoice and names the function that reads it", () => {
    const ubl = generateXRechnungUBL(minimalXRechnung);
    expect(codeOf(() => parseCiiInvoice(ubl))).toBe("unsupported_syntax");
    let caught: unknown;
    try {
      parseCiiInvoice(ubl);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsupportedCiiSyntaxError);
    expect((caught as Error).message).toContain("parseUblInvoice");
  });

  it("refuses a credit note by BT-3, exactly as the UBL reader does", () => {
    const credit = minimalXml.replace(
      "<ram:TypeCode>380</ram:TypeCode>",
      "<ram:TypeCode>381</ram:TypeCode>",
    );
    expect(codeOf(() => parseCiiInvoice(credit))).toBe("unsupported_document_type");
    expect(() => parseCiiInvoice(credit)).toThrow(UnsupportedCreditNoteError);
  });

  it("refuses something that is neither UBL nor CII", () => {
    expect(codeOf(() => parseCiiInvoice("<hello/>"))).toBe("unsupported_syntax");
  });

  it("keeps every security limit of the shared XML reader", () => {
    const doctype = `<!DOCTYPE x [<!ENTITY a "b">]>\n${minimalXml}`;
    expect(codeOf(() => parseCiiInvoice(doctype))).toBe("xml_doctype_forbidden");
    expect(codeOf(() => parseCiiInvoice(minimalXml, { maxCharacters: 10 }))).toBe(
      "xml_too_large",
    );
    expect(codeOf(() => parseCiiInvoice(minimalXml, { maxElements: 3 }))).toBe(
      "xml_too_many_elements",
    );
    expect(codeOf(() => parseCiiInvoice(minimalXml, { maxDepth: 2 }))).toBe(
      "xml_too_deep",
    );
    expect(() => parseCiiInvoice(doctype)).toThrow(XmlSecurityError);
  });

  it("still lets parseUblInvoice refuse a CII document, and vice versa", () => {
    expect(() => parseUblInvoice(minimalXml)).toThrow(UnsupportedSyntaxError);
    let caught: unknown;
    try {
      parseUblInvoice(minimalXml);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain("parseCiiInvoice");
  });
});

describe("parseCiiInvoice: nothing is dropped silently", () => {
  it("reports an element it has no field for", () => {
    const withExtra = minimalXml.replace(
      "<ram:TypeCode>380</ram:TypeCode>",
      "<ram:TypeCode>380</ram:TypeCode>\n    <ram:Name>Rechnung</ram:Name>",
    );
    const { unmapped } = parseCiiInvoice(withExtra);
    const found = unknowns(unmapped).find((u) => u.name === "ram:Name");
    expect(found).toBeDefined();
    expect(found?.text).toBe("Rechnung");
    expect(found?.namespace).toBe(
      "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100",
    );
  });

  // ⚠ Rewritten 2026-08-12 (finding 9). The old assertion — that BT-131 and
  // BT-116 were reported rather than stored — was the defect, not the contract:
  // nothing compared them, so a document stating 77.77 where its own lines
  // compute 99.99 validated with zero errors while KoSIT rejected it under
  // BR-CO-10 and PEPPOL-EN16931-R120.
  it("stores the stated line and breakdown amounts instead of discarding them", () => {
    const { invoice, unmapped } = parseCiiInvoice(minimalXml);
    expect(unmapped.map((u) => u.name)).not.toContain("ram:LineTotalAmount");
    expect(unmapped.map((u) => u.name)).not.toContain("ram:BasisAmount");
    const declared = invoice.declaredTotals!;
    expect(declared.lineNetAmounts).toBeDefined();
    expect(declared.subtotals?.[0]?.taxableAmount).toBeDefined();
    expect(declared.subtotals?.[0]?.taxAmount).toBeDefined();
  });

  it("reports a number it cannot read and leaves the field unset", () => {
    const broken = minimalXml.replace(
      "<ram:ChargeAmount>150.00</ram:ChargeAmount>",
      "<ram:ChargeAmount>one hundred</ram:ChargeAmount>",
    );
    const { invoice, unmapped } = parseCiiInvoice(broken);
    expect(invoice.lines[0]?.unitPrice).toBe(0);
    expect(unknowns(unmapped).some((u) => u.name === "ram:ChargeAmount")).toBe(true);
  });

  it("reports a second document note rather than overwriting the first", () => {
    const twoNotes = minimalXml.replace(
      "  </rsm:ExchangedDocument>",
      "    <ram:IncludedNote>\n      <ram:Content>A</ram:Content>\n    </ram:IncludedNote>\n" +
        "    <ram:IncludedNote>\n      <ram:Content>B</ram:Content>\n    </ram:IncludedNote>\n" +
        "  </rsm:ExchangedDocument>",
    );
    const { invoice, unmapped } = parseCiiInvoice(twoNotes);
    expect(invoice.note).toBe("A");
    expect(unknowns(unmapped).some((u) => u.name === "ram:IncludedNote")).toBe(true);
  });

  it("reports a tax registration scheme it does not model", () => {
    const odd = minimalXml.replace('schemeID="FC"', 'schemeID="XX"');
    const { invoice, unmapped } = parseCiiInvoice(odd);
    expect(invoice.seller.taxRegistrationId).toBeUndefined();
    expect(
      unknowns(unmapped).some((u) => u.name === "ram:SpecifiedTaxRegistration"),
    ).toBe(true);
  });
});

describe("parseCiiInvoice: the profile it infers", () => {
  it("maps the XRechnung 3.0 identifier to xrechnung-cii", () => {
    expect(parseCiiInvoice(minimalXml).invoice.profile).toBe("xrechnung-cii");
    expect(parseCiiInvoice(minimalXml).customizationId).toContain("xrechnung_3.0");
    expect(parseCiiInvoice(minimalXml).profileId).toBe(
      "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
    );
  });

  it("maps the core identifier to en16931, which is also what Factur-X states", () => {
    // Factur-X's EN 16931 profile and plain core EN 16931 carry the *same*
    // BT-24, so a facturx-en16931 document reads back as en16931. Nothing is
    // lost: the rule set is the same, and regenerating gives the same document.
    const facturx = generateCii({ ...minimalXRechnungCii, profile: "facturx-en16931" });
    const { invoice } = parseCiiInvoice(facturx);
    expect(invoice.profile).toBe("en16931");
    expect(generateCii(invoice)).toBe(facturx);
  });

  it("guesses from the text of an unknown identifier, and says so", () => {
    const pinned = generateCii(minimalXRechnungCii, {
      customizationId:
        "urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_2.3",
    });
    const { invoice, unmapped } = parseCiiInvoice(pinned);
    expect(invoice.profile).toBe("xrechnung-cii");
    expect(unknowns(unmapped).some((u) => u.reason.includes("xrechnung-cii"))).toBe(
      true,
    );
  });

  it("falls back to en16931 when BT-24 is absent, and reports the fallback", () => {
    const without = minimalXml.replace(
      /\s*<ram:GuidelineSpecifiedDocumentContextParameter>[\s\S]*?<\/ram:GuidelineSpecifiedDocumentContextParameter>/,
      "",
    );
    const { invoice, unmapped } = parseCiiInvoice(without);
    expect(invoice.profile).toBe("en16931");
    expect(unknowns(unmapped).some((u) => u.reason.includes("BT-24"))).toBe(true);
  });
});

describe("the two syntaxes meet in the middle", () => {
  it("a CII document can be re-issued as UBL through the shared model", () => {
    const { invoice } = parseCiiInvoice(read("xrechnung-cii-discount.xml"));
    const ubl = generateXRechnungUBL({ ...invoice, profile: "xrechnung-ubl" });
    // Not byte-identical to the UBL fixture — the two bindings differ on BT-21
    // and on the names the model keeps — but it is the same invoice, and the
    // arithmetic that a receiver checks is unchanged.
    expect(ubl).toContain("<cbc:PayableAmount currencyID=\"EUR\">1680.00</cbc:PayableAmount>");
    const back = parseUblInvoice(ubl).invoice;
    expect(back.invoiceNumber).toBe("2026-000144");
    expect(back.lines).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Findings 9, 10 and 12. Each verdict below was compared against KoSIT 1.6.2
// with the XRechnung 3.0.2 configuration on 2026-08-12.
// ---------------------------------------------------------------------------

describe("declared line and breakdown amounts are compared, not discarded (finding 9)", () => {
  const ublMinimal = generateXRechnungUBL(minimalXRechnung);
  const ciiMinimal = generateCii(minimalXRechnungCii);

  /**
   * The exact reproduction: a valid document with a line total, a VAT basis and
   * a VAT amount that contradict its own arithmetic and each other. KoSIT
   * REJECTS it with `[BR-CO-10, BR-CO-14, BR-S-08, PEPPOL-EN16931-R120]` in
   * both syntaxes. This build used to return `valid: true`, zero errors.
   */
  const corruptUbl = ublMinimal
    .replace(
      /<cbc:LineExtensionAmount currencyID="EUR">[\d.]+<\/cbc:LineExtensionAmount>\s*\n(\s*)<cac:Item>/,
      (m) => m.replace(/>[\d.]+</, ">77.77<"),
    )
    .replace(
      /<cbc:TaxableAmount currencyID="EUR">[\d.]+<\/cbc:TaxableAmount>/,
      `<cbc:TaxableAmount currencyID="EUR">55.55</cbc:TaxableAmount>`,
    )
    .replace(
      /(<cac:TaxSubtotal>[\s\S]*?)<cbc:TaxAmount currencyID="EUR">[\d.]+<\/cbc:TaxAmount>/,
      `$1<cbc:TaxAmount currencyID="EUR">11.11</cbc:TaxAmount>`,
    );

  const corruptCii = ciiMinimal
    .replace(/<ram:LineTotalAmount>[\d.]+<\/ram:LineTotalAmount>/, "<ram:LineTotalAmount>77.77</ram:LineTotalAmount>")
    .replace(/<ram:BasisAmount>[\d.]+<\/ram:BasisAmount>/, "<ram:BasisAmount>55.55</ram:BasisAmount>")
    .replace(/<ram:CalculatedAmount>[\d.]+<\/ram:CalculatedAmount>/, "<ram:CalculatedAmount>11.11</ram:CalculatedAmount>");

  it.each([
    ["UBL", corruptUbl, parseUblInvoice],
    ["CII", corruptCii, parseCiiInvoice],
  ] as const)(
    "%s: returns exactly the rule ids KoSIT returns for the corrupt document",
    (_name, xml, parse) => {
      const result = validateInput(parse(xml).invoice);
      expect(result.valid).toBe(false);
      expect([...new Set(result.errors.map((e) => e.rule))].sort()).toEqual([
        "BR-CO-10",
        "BR-CO-14",
        "BR-S-08",
        "PEPPOL-EN16931-R120",
      ]);
    },
  );

  it.each([
    ["UBL", ublMinimal, parseUblInvoice],
    ["CII", ciiMinimal, parseCiiInvoice],
  ] as const)("%s: leaves an honest document alone", (_name, xml, parse) => {
    const result = validateInput(parse(xml).invoice);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("carries the stated figures into declaredTotals in both syntaxes", () => {
    for (const [xml, parse] of [
      [ublMinimal, parseUblInvoice],
      [ciiMinimal, parseCiiInvoice],
    ] as const) {
      const declared = parse(xml).invoice.declaredTotals!;
      const invoice = parse(xml).invoice;
      expect(declared.lineNetAmounts).toHaveLength(invoice.lines.length);
      expect(declared.lineNetAmounts!.every((n) => typeof n === "number")).toBe(true);
      expect(declared.subtotals!.length).toBeGreaterThan(0);
      for (const sub of declared.subtotals!) {
        expect(sub.category).toBe("S");
        expect(typeof sub.rate).toBe("number");
        expect(sub.taxableAmount).toBeGreaterThan(0);
        expect(sub.taxAmount).toBeGreaterThan(0);
      }
    }
  });

  it("stays inside the schematron's tolerances rather than tightening them", () => {
    // BR-*-08 and BR-CO-17 allow a whole unit of currency, exclusive, and
    // PEPPOL-EN16931-R120 allows 0.02. A build that compared exactly here would
    // reject documents KoSIT accepts — which a first draft of this rule did.
    const nearMiss = ciiMinimal.replace(
      /<ram:CalculatedAmount>([\d.]+)<\/ram:CalculatedAmount>/,
      (_m, value) =>
        `<ram:CalculatedAmount>${(Number(value) + 0.5).toFixed(2)}</ram:CalculatedAmount>`,
    );
    const ids = validateInput(parseCiiInvoice(nearMiss).invoice).errors.map((e) => e.rule);
    expect(ids).not.toContain("BR-CO-17");
  });
});

describe("BT-110 when the VAT accounting currency equals the invoice currency (finding 12)", () => {
  // BT-110 and BT-111 are one element twice over, told apart only by
  // @currencyID. When BT-6 = BT-5 the first one used to be claimed as BT-111,
  // so declared.taxAmount was never set and BR-CO-14 silently did not run.
  const withSameCurrency = (xml: string) =>
    xml.replace(
      "<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>",
      "<ram:TaxCurrencyCode>EUR</ram:TaxCurrencyCode>\n      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>",
    );

  it("reads the first TaxTotalAmount as BT-110, not as BT-111", () => {
    const xml = withSameCurrency(generateCii(minimalXRechnungCii));
    const { invoice } = parseCiiInvoice(xml);
    expect(invoice.vatAccountingCurrency).toBe("EUR");
    expect(invoice.declaredTotals?.taxAmount).toBeDefined();
  });

  it("lets BR-CO-14 run on a corrupt BT-110 it used to skip", () => {
    const xml = withSameCurrency(generateCii(minimalXRechnungCii)).replace(
      /<ram:TaxTotalAmount currencyID="EUR">[\d.]+<\/ram:TaxTotalAmount>/,
      `<ram:TaxTotalAmount currencyID="EUR">999.99</ram:TaxTotalAmount>`,
    );
    const ids = validateInput(parseCiiInvoice(xml).invoice).errors.map((e) => e.rule);
    expect(ids).toContain("BR-CO-14");
  });

  it("still reads a genuine BT-111 in a different currency", () => {
    const xml = generateCii({
      ...minimalXRechnungCii,
      vatAccountingCurrency: "SEK",
      taxAmountInAccountingCurrency: 3255.6,
    });
    const { invoice } = parseCiiInvoice(xml);
    expect(invoice.taxAmountInAccountingCurrency).toBe(3255.6);
    expect(invoice.declaredTotals?.taxAmount).not.toBe(3255.6);
  });
});

describe("content nested inside a consumed leaf (finding 10)", () => {
  // `leaf()` marks an element consumed and reads `el.text`, which is "" for any
  // element with children — so the value came back empty AND `sweep()` never
  // mentioned what was inside. Silent data loss, on the module whose whole
  // stated contract is that nothing is dropped silently.
  const nested = generateCii(minimalXRechnungCii).replace(
    /<ram:ID>2026-000142<\/ram:ID>/,
    `<ram:ID><x:real xmlns:x="urn:x">2026-000142</x:real></ram:ID>`,
  );

  it("reports both the emptied container and the content inside it", () => {
    const { invoice, unmapped } = parseCiiInvoice(nested);
    expect(invoice.invoiceNumber).toBe("");
    const inner = unmapped.find((u) => u.name === "x:real");
    expect(inner).toBeDefined();
    expect(inner!.text).toBe("2026-000142");
    expect(inner!.namespace).toBe("urn:x");
    const container = unmapped.find(
      (u) => u.name === "ram:ID" && u.reason.includes("read as a text value"),
    );
    expect(container).toBeDefined();
  });

  it("leaves an ordinary leaf untouched", () => {
    const { unmapped } = parseCiiInvoice(generateCii(minimalXRechnungCii));
    expect(unmapped).toEqual([]);
  });
});
