import { describe, expect, it } from "vitest";

import {
  CII_GENERATABLE_PROFILES,
  CII_NAMESPACES,
  GenerationError,
  UnsupportedCiiProfileError,
  UnsupportedDocumentTypeError,
  computeTotals,
  generateCii,
  generateXRechnungUBL,
  parseXml,
  toCiiDate,
  validateInput,
  attr,
  childrenNamed,
  firstChild,
  type XmlElement,
} from "./index.js";
import {
  discountedXRechnungCii,
  extendedXRechnungCii,
  minimalXRechnungCii,
  reverseChargeXRechnungCii,
} from "./fixtures.js";
import type { InvoiceInput } from "./types.js";

const { rsm: RSM, ram: RAM, udt: UDT, qdt: QDT } = CII_NAMESPACES;

const minimal = minimalXRechnungCii;

/** Walk a `/` separated path of local names, resolving by namespace URI. */
function at(root: XmlElement, path: string): XmlElement | undefined {
  let node: XmlElement | undefined = root;
  for (const step of path.split("/")) {
    if (!node) return undefined;
    const namespace = step.startsWith("rsm:")
      ? RSM
      : step.startsWith("udt:")
        ? UDT
        : step.startsWith("qdt:")
          ? QDT
          : RAM;
    node = firstChild(node, namespace, step.replace(/^[a-z]+:/, ""));
  }
  return node;
}

const parse = (xml: string) => parseXml(xml);
const textAt = (root: XmlElement, path: string) => at(root, path)?.text;

/** Local names of an element's children, in document order. */
const order = (el: XmlElement | undefined) =>
  (el?.children ?? []).map((c) => c.local);

const TRANSACTION = "rsm:SupplyChainTradeTransaction";
const SETTLEMENT = `${TRANSACTION}/ApplicableHeaderTradeSettlement`;
const AGREEMENT = `${TRANSACTION}/ApplicableHeaderTradeAgreement`;
const SUMMATION = `${SETTLEMENT}/SpecifiedTradeSettlementHeaderMonetarySummation`;

describe("generateCii: the document frame", () => {
  const root = parse(generateCii(minimal));

  it("is a rsm:CrossIndustryInvoice in the D16B namespace", () => {
    expect(root.local).toBe("CrossIndustryInvoice");
    expect(root.namespace).toBe(RSM);
  });

  it("declares all four namespaces the syntax needs", () => {
    const declared = Object.fromEntries(
      root.attributes.map((a) => [a.qname, a.value]),
    );
    expect(declared["xmlns:rsm"]).toBe(RSM);
    expect(declared["xmlns:ram"]).toBe(RAM);
    expect(declared["xmlns:udt"]).toBe(UDT);
    // qdt is declared even though only BT-26 uses it: a document that omits the
    // declaration and then emits a preceding-invoice date is not well-formed.
    expect(declared["xmlns:qdt"]).toBe(QDT);
  });

  it("puts the three top-level groups in schema order", () => {
    expect(order(root)).toEqual([
      "ExchangedDocumentContext",
      "ExchangedDocument",
      "SupplyChainTradeTransaction",
    ]);
  });

  it("puts the four transaction groups in schema order, lines first", () => {
    expect(order(at(root, TRANSACTION))).toEqual([
      "IncludedSupplyChainTradeLineItem",
      "IncludedSupplyChainTradeLineItem",
      "ApplicableHeaderTradeAgreement",
      "ApplicableHeaderTradeDelivery",
      "ApplicableHeaderTradeSettlement",
    ]);
  });

  it("states BT-23 and BT-24 in the document context", () => {
    expect(
      textAt(
        root,
        "rsm:ExchangedDocumentContext/BusinessProcessSpecifiedDocumentContextParameter/ID",
      ),
    ).toBe("urn:fdc:peppol.eu:2017:poacc:billing:01:1.0");
    expect(
      textAt(
        root,
        "rsm:ExchangedDocumentContext/GuidelineSpecifiedDocumentContextParameter/ID",
      ),
    ).toBe(
      "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0",
    );
  });

  it("states BT-1, BT-3 and BT-2, in that order", () => {
    const header = at(root, "rsm:ExchangedDocument");
    expect(order(header)).toEqual(["ID", "TypeCode", "IssueDateTime"]);
    expect(textAt(root, "rsm:ExchangedDocument/ID")).toBe("2026-000142");
    expect(textAt(root, "rsm:ExchangedDocument/TypeCode")).toBe("380");
  });
});

describe("generateCii: dates", () => {
  it("writes BT-2 as udt:DateTimeString with format 102, not an ISO date", () => {
    const root = parse(generateCii(minimal));
    const value = at(root, "rsm:ExchangedDocument/IssueDateTime/udt:DateTimeString");
    expect(value?.text).toBe("20260809");
    expect(attr(value!, "format")).toBe("102");
    // The trap this guards: an ISO date is well-formed XML and passes nothing.
    expect(generateCii(minimal)).not.toContain(">2026-08-09<");
  });

  it("converts an ISO date and leaves anything else alone", () => {
    expect(toCiiDate("2026-08-09")).toBe("20260809");
    expect(toCiiDate("  2026-08-09  ")).toBe("20260809");
    // Not a calendar date: passed through so a validator rejects it out loud
    // rather than a generator inventing a date.
    expect(toCiiDate("2026-08")).toBe("2026-08");
    expect(toCiiDate("tomorrow")).toBe("tomorrow");
  });

  it("writes BT-26 in the qualified namespace, not the unqualified one", () => {
    const root = parse(generateCii(discountedXRechnungCii));
    const reference = at(root, `${SETTLEMENT}/InvoiceReferencedDocument`);
    const formatted = firstChild(reference!, RAM, "FormattedIssueDateTime");
    // qdt, not udt. Getting this wrong is an XSD rejection, not a rule finding.
    expect(firstChild(formatted!, QDT, "DateTimeString")?.text).toBe("20260715");
    expect(firstChild(formatted!, UDT, "DateTimeString")).toBeUndefined();
  });
});

describe("generateCii: totals are computed, never echoed", () => {
  const cases: [string, InvoiceInput][] = [
    ["minimal", minimalXRechnungCii],
    ["reverse charge", reverseChargeXRechnungCii],
    ["discount", discountedXRechnungCii],
    ["extended", extendedXRechnungCii],
  ];

  it.each(cases)("%s agrees with computeTotals", (_name, input) => {
    const root = parse(generateCii(input));
    const totals = computeTotals(input);
    const summation = at(root, SUMMATION)!;
    const value = (local: string) => firstChild(summation, RAM, local)?.text;

    expect(value("LineTotalAmount")).toBe(totals.lineExtensionAmount.toFixed(2));
    expect(value("TaxBasisTotalAmount")).toBe(totals.taxExclusiveAmount.toFixed(2));
    expect(value("TaxTotalAmount")).toBe(totals.taxAmount.toFixed(2));
    expect(value("GrandTotalAmount")).toBe(totals.taxInclusiveAmount.toFixed(2));
    expect(value("DuePayableAmount")).toBe(totals.payableAmount.toFixed(2));
  });

  it("ignores caller-declared totals that disagree with the arithmetic", () => {
    const lying: InvoiceInput = {
      ...minimal,
      declaredTotals: { lineExtensionAmount: 1, payableAmount: 2 },
    };
    const root = parse(generateCii(lying));
    const summation = at(root, SUMMATION)!;
    expect(firstChild(summation, RAM, "LineTotalAmount")?.text).toBe("1599.80");
    expect(firstChild(summation, RAM, "DuePayableAmount")?.text).toBe("1891.79");
  });

  it("puts the summation amounts in schema order — charges before allowances", () => {
    const root = parse(generateCii(discountedXRechnungCii));
    // CII orders these the opposite way round from UBL's cac:LegalMonetaryTotal,
    // and the rounding amount comes before the grand total rather than after it.
    expect(order(at(root, SUMMATION))).toEqual([
      "LineTotalAmount",
      "ChargeTotalAmount",
      "AllowanceTotalAmount",
      "TaxBasisTotalAmount",
      "TaxTotalAmount",
      "RoundingAmount",
      "GrandTotalAmount",
      "TotalPrepaidAmount",
      "DuePayableAmount",
    ]);
  });

  it("restates BT-111 as a second TaxTotalAmount, told apart by currencyID", () => {
    const root = parse(generateCii(extendedXRechnungCii));
    const amounts = childrenNamed(at(root, SUMMATION)!, RAM, "TaxTotalAmount");
    expect(amounts).toHaveLength(2);
    expect(attr(amounts[0]!, "currencyID")).toBe("EUR");
    expect(attr(amounts[1]!, "currencyID")).toBe("SEK");
    expect(amounts[1]!.text).toBe("3255.60");
  });

  it("carries no currencyID on any other amount", () => {
    const xml = generateCii(extendedXRechnungCii);
    const withCurrency = xml.match(/<ram:\w+ currencyID=/g) ?? [];
    // Two TaxTotalAmount elements, and nothing else. In CII the document
    // currency is stated once, in ram:InvoiceCurrencyCode.
    expect(withCurrency).toHaveLength(2);
    expect(new Set(withCurrency)).toEqual(
      new Set(["<ram:TaxTotalAmount currencyID="]),
    );
  });
});

describe("generateCii: the VAT breakdown", () => {
  it("emits one ram:ApplicableTradeTax per BG-23 group, in schema order", () => {
    const root = parse(generateCii(minimal));
    const groups = childrenNamed(at(root, SETTLEMENT)!, RAM, "ApplicableTradeTax");
    expect(groups).toHaveLength(2);
    expect(order(groups[0])).toEqual([
      "CalculatedAmount",
      "TypeCode",
      "BasisAmount",
      "CategoryCode",
      "RateApplicablePercent",
    ]);
    expect(firstChild(groups[0]!, RAM, "BasisAmount")?.text).toBe("1500.00");
    expect(firstChild(groups[0]!, RAM, "CalculatedAmount")?.text).toBe("285.00");
  });

  it("carries the exemption reason for a reverse-charge invoice", () => {
    const root = parse(generateCii(reverseChargeXRechnungCii));
    const group = firstChild(at(root, SETTLEMENT)!, RAM, "ApplicableTradeTax")!;
    expect(firstChild(group, RAM, "CategoryCode")?.text).toBe("AE");
    expect(firstChild(group, RAM, "ExemptionReason")?.text).toBe("Reverse charge");
    expect(firstChild(group, RAM, "CalculatedAmount")?.text).toBe("0.00");
  });

  it("states BT-7 exactly once even when the breakdown has two groups", () => {
    // CII-SR-461: "Only one TaxPointDate shall be present". The tax point date
    // is a document-level term with no document-level element, so the binding
    // hangs it off one breakdown group — not off each of them. KoSIT rejected
    // an earlier build of this generator for exactly that.
    const root = parse(generateCii(extendedXRechnungCii));
    const groups = childrenNamed(at(root, SETTLEMENT)!, RAM, "ApplicableTradeTax");
    expect(groups.length).toBeGreaterThan(1);
    const dates = groups.filter((g) => firstChild(g, RAM, "TaxPointDate"));
    expect(dates).toHaveLength(1);
    expect(
      firstChild(firstChild(dates[0]!, RAM, "TaxPointDate")!, UDT, "DateString")
        ?.text,
    ).toBe("20260807");
  });

  it("states BT-8 exactly once, for the same reason", () => {
    const withCode: InvoiceInput = {
      ...minimal,
      invoicingPeriod: { startDate: "2026-07-01", endDate: "2026-07-31", descriptionCode: "35" },
    };
    const root = parse(generateCii(withCode));
    const groups = childrenNamed(at(root, SETTLEMENT)!, RAM, "ApplicableTradeTax");
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.filter((g) => firstChild(g, RAM, "DueDateTypeCode"))).toHaveLength(1);
  });
});

describe("generateCii: parties", () => {
  const root = parse(generateCii(extendedXRechnungCii));
  const seller = at(root, `${AGREEMENT}/SellerTradeParty`)!;

  it("puts the party children in schema order", () => {
    expect(order(seller)).toEqual([
      "GlobalID",
      "Name",
      "Description",
      "SpecifiedLegalOrganization",
      "DefinedTradeContact",
      "PostalTradeAddress",
      "URIUniversalCommunication",
      "SpecifiedTaxRegistration",
      "SpecifiedTaxRegistration",
    ]);
  });

  it("puts BT-29 in GlobalID when it has a scheme and in ID when it does not", () => {
    expect(attr(firstChild(seller, RAM, "GlobalID")!, "schemeID")).toBe("0088");
    expect(firstChild(seller, RAM, "ID")).toBeUndefined();

    const bare: InvoiceInput = {
      ...minimal,
      seller: { ...minimal.seller, identifier: { value: "SUP-1" } },
    };
    const party = at(parse(generateCii(bare)), `${AGREEMENT}/SellerTradeParty`)!;
    expect(firstChild(party, RAM, "ID")?.text).toBe("SUP-1");
    expect(firstChild(party, RAM, "GlobalID")).toBeUndefined();
  });

  it("tells BT-31 and BT-32 apart by schemeID VA and FC", () => {
    const registrations = childrenNamed(seller, RAM, "SpecifiedTaxRegistration");
    const scheme = (el: XmlElement) => attr(firstChild(el, RAM, "ID")!, "schemeID");
    expect(scheme(registrations[0]!)).toBe("VA");
    expect(firstChild(registrations[0]!, RAM, "ID")?.text).toBe("DE123456789");
    expect(scheme(registrations[1]!)).toBe("FC");
    expect(firstChild(registrations[1]!, RAM, "ID")?.text).toBe("181/815/08155");
  });

  it("puts the post code before the street, which is the opposite of UBL", () => {
    expect(order(firstChild(seller, RAM, "PostalTradeAddress"))).toEqual([
      "PostcodeCode",
      "LineOne",
      "LineTwo",
      "LineThree",
      "CityName",
      "CountryID",
      "CountrySubDivisionName",
    ]);
  });

  it("puts BT-30 and BT-28 inside SpecifiedLegalOrganization", () => {
    const organization = firstChild(seller, RAM, "SpecifiedLegalOrganization")!;
    const id = firstChild(organization, RAM, "ID")!;
    expect(id.text).toBe("HRB 12345 B");
    expect(attr(id, "schemeID")).toBe("0060");
    expect(firstChild(organization, RAM, "TradingBusinessName")?.text).toBe(
      "Muster Technik",
    );
  });

  it("puts BT-90 on the settlement, not on the seller as UBL does", () => {
    expect(textAt(root, `${SETTLEMENT}/CreditorReferenceID`)).toBe(
      "DE98ZZZ09999999999",
    );
    expect(generateCii(extendedXRechnungCii)).not.toContain('schemeID="SEPA"');
  });
});

describe("generateCii: lines", () => {
  const root = parse(generateCii(extendedXRechnungCii));
  const line = firstChild(
    at(root, TRANSACTION)!,
    RAM,
    "IncludedSupplyChainTradeLineItem",
  )!;

  it("puts the five line groups in schema order", () => {
    expect(order(line)).toEqual([
      "AssociatedDocumentLineDocument",
      "SpecifiedTradeProduct",
      "SpecifiedLineTradeAgreement",
      "SpecifiedLineTradeDelivery",
      "SpecifiedLineTradeSettlement",
    ]);
  });

  it("carries the quantity on ram:BilledQuantity with its unit code", () => {
    const delivery = firstChild(line, RAM, "SpecifiedLineTradeDelivery")!;
    const quantity = firstChild(delivery, RAM, "BilledQuantity")!;
    expect(quantity.text).toBe("40.0000");
    expect(attr(quantity, "unitCode")).toBe("C62");
  });

  it("expresses BT-148 and BT-147 as a separate gross price element", () => {
    // UBL hangs the discount off the one cac:Price as an allowance; CII has two
    // price elements, and the allowance hangs off the gross one.
    const agreement = firstChild(line, RAM, "SpecifiedLineTradeAgreement")!;
    const gross = firstChild(agreement, RAM, "GrossPriceProductTradePrice")!;
    expect(firstChild(gross, RAM, "ChargeAmount")?.text).toBe("50.00");
    const applied = firstChild(gross, RAM, "AppliedTradeAllowanceCharge")!;
    expect(firstChild(applied, RAM, "ActualAmount")?.text).toBe("5.00");
    const net = firstChild(agreement, RAM, "NetPriceProductTradePrice")!;
    expect(firstChild(net, RAM, "ChargeAmount")?.text).toBe("45.00");
  });

  it("orders a line allowance percentage, base, amount, reason code, reason", () => {
    // Two order traps against UBL in one element: the percentage and the base
    // come before the amount, and the reason code comes before the reason text.
    const settlement = firstChild(line, RAM, "SpecifiedLineTradeSettlement")!;
    const allowance = firstChild(settlement, RAM, "SpecifiedTradeAllowanceCharge")!;
    expect(order(allowance)).toEqual([
      "ChargeIndicator",
      "CalculationPercent",
      "BasisAmount",
      "ActualAmount",
      "ReasonCode",
      "Reason",
    ]);
  });

  it("writes the charge indicator as a nested udt:Indicator, not as text", () => {
    const settlement = firstChild(line, RAM, "SpecifiedLineTradeSettlement")!;
    const entries = childrenNamed(settlement, RAM, "SpecifiedTradeAllowanceCharge");
    const indicator = (el: XmlElement) =>
      firstChild(firstChild(el, RAM, "ChargeIndicator")!, UDT, "Indicator")?.text;
    expect(indicator(entries[0]!)).toBe("false");
    expect(indicator(entries[1]!)).toBe("true");
  });

  it("computes BT-131 net of the line allowance and charge", () => {
    const settlement = firstChild(line, RAM, "SpecifiedLineTradeSettlement")!;
    const summation = firstChild(
      settlement,
      RAM,
      "SpecifiedTradeSettlementLineMonetarySummation",
    )!;
    // 40 x 45.00 = 1800.00, less a 30.00 allowance, plus a 15.00 charge.
    expect(firstChild(summation, RAM, "LineTotalAmount")?.text).toBe("1785.00");
    expect(computeTotals(extendedXRechnungCii).lineNetAmounts[0]).toBe(1785);
  });

  it("puts the line settlement children in schema order", () => {
    expect(order(firstChild(line, RAM, "SpecifiedLineTradeSettlement"))).toEqual([
      "ApplicableTradeTax",
      "BillingSpecifiedPeriod",
      "SpecifiedTradeAllowanceCharge",
      "SpecifiedTradeAllowanceCharge",
      "SpecifiedTradeSettlementLineMonetarySummation",
      "AdditionalReferencedDocument",
      "ReceivableSpecifiedTradeAccountingAccount",
    ]);
  });
});

describe("generateCii: notes", () => {
  it("uses the real BT-21 element rather than UBL's #CODE# prefix", () => {
    const root = parse(generateCii(discountedXRechnungCii));
    const note = at(root, "rsm:ExchangedDocument/IncludedNote")!;
    expect(order(note)).toEqual(["Content", "SubjectCode"]);
    expect(firstChild(note, RAM, "SubjectCode")?.text).toBe("AAI");
    expect(firstChild(note, RAM, "Content")?.text).not.toContain("#AAI#");
    // The UBL binding of the same input does prefix it, because UBL has no
    // element for the code. Both are correct for their syntax.
    expect(generateXRechnungUBL({ ...discountedXRechnungCii, profile: "xrechnung-ubl" }))
      .toContain("#AAI#");
  });
});

describe("generateCii: referenced documents share one element", () => {
  const root = parse(generateCii(extendedXRechnungCii));
  const references = childrenNamed(
    at(root, AGREEMENT)!,
    RAM,
    "AdditionalReferencedDocument",
  );

  it("tells BT-18, BG-24 and BT-17 apart by type code", () => {
    const byCode = Object.fromEntries(
      references.map((r) => [firstChild(r, RAM, "TypeCode")!.text, r]),
    );
    expect(Object.keys(byCode).sort()).toEqual(["130", "50", "916"]);
    expect(firstChild(byCode["130"]!, RAM, "ReferenceTypeCode")?.text).toBe("AAJ");
    expect(firstChild(byCode["50"]!, RAM, "IssuerAssignedID")?.text).toBe("LOS-4");
  });

  it("embeds an attachment with its mime code and filename", () => {
    const withAttachment = references.find((r) =>
      firstChild(r, RAM, "AttachmentBinaryObject"),
    )!;
    const binary = firstChild(withAttachment, RAM, "AttachmentBinaryObject")!;
    expect(attr(binary, "mimeCode")).toBe("text/csv");
    expect(attr(binary, "filename")).toBe("preisblatt-2026.csv");
    expect(binary.text).toBe("cG9zO3ByZWlzCg==");
  });
});

describe("generateCii: options", () => {
  it("accepts a compact indent", () => {
    const compact = generateCii(minimal, { indent: "" });
    expect(compact).not.toContain("\n  <");
    expect(() => parse(compact)).not.toThrow();
  });

  it("allows pinning a different specification identifier", () => {
    const pinned = generateCii(minimal, { customizationId: "urn:example:pinned" });
    expect(
      textAt(
        parse(pinned),
        "rsm:ExchangedDocumentContext/GuidelineSpecifiedDocumentContextParameter/ID",
      ),
    ).toBe("urn:example:pinned");
  });
});

describe("generateCii: refusals", () => {
  it("generates every profile it claims to support", () => {
    for (const profile of CII_GENERATABLE_PROFILES) {
      const xml = generateCii({ ...minimal, profile });
      expect(parse(xml).local).toBe("CrossIndustryInvoice");
    }
  });

  it("emits Factur-X's EN 16931 specification identifier for facturx-en16931", () => {
    const root = parse(generateCii({ ...minimal, profile: "facturx-en16931" }));
    expect(
      textAt(
        root,
        "rsm:ExchangedDocumentContext/GuidelineSpecifiedDocumentContextParameter/ID",
      ),
    ).toBe("urn:cen.eu:en16931:2017");
  });

  // ⚠ Narrowed 2026-08-14. This test used to loop over
  // ["xrechnung-ubl", "peppol-bis-3"], on the belief — stated in the generator's
  // own doc-comment — that Peppol BIS Billing 3.0 is a UBL-only CIUS. It is not:
  // OpenPEPPOL/peppol-bis-invoice-3 @ v3.0.20 ships PEPPOL-EN16931-CII.sch and a
  // `peppolbis-en16931-01-3.0-cii` build configuration, and the BIS guide
  // describes CII D16B as optional rather than absent. `xrechnung-ubl` is the
  // only genuinely UBL-bound profile name left, and it is refused because
  // `xrechnung-cii` is the name for the same rules in this syntax.
  it("throws on the UBL-bound profile rather than emitting CII under a UBL name", () => {
    expect(() =>
      generateCii({ ...minimal, profile: "xrechnung-ubl" }),
    ).toThrow(UnsupportedCiiProfileError);
  });

  it("the profile error teaches what is and is not supported", () => {
    let caught: unknown;
    try {
      generateCii({ ...minimal, profile: "xrechnung-ubl" });
    } catch (error) {
      caught = error;
    }
    const err = caught as UnsupportedCiiProfileError;
    expect(err).toBeInstanceOf(GenerationError);
    expect(err.code).toBe("unsupported_profile");
    expect(err.profile).toBe("xrechnung-ubl");
    expect(err.supportedProfiles).toContain("xrechnung-cii");
    expect(err.supportedProfiles).toContain("peppol-bis-3");
    expect(err.message).toContain("generateXRechnungUBL");
  });

  // --- peppol-bis-3, the CII binding enabled in 0.7.0 ---------------------
  //
  // Both facts below are what the official artefacts checked on 2026-08-14, and
  // both were findings in `scripts/peppol-check.md` before they were tests:
  // R004 (specification identifier) and R002 (`not(ram:IncludedNote/
  // ram:SubjectCode)`).
  it("emits Peppol's specification identifier under peppol-bis-3", () => {
    const root = parse(generateCii({ ...minimal, profile: "peppol-bis-3" }));
    expect(
      textAt(
        root,
        "rsm:ExchangedDocumentContext/GuidelineSpecifiedDocumentContextParameter/ID",
      ),
    ).toBe(
      "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0",
    );
    expect(
      textAt(
        root,
        "rsm:ExchangedDocumentContext/BusinessProcessSpecifiedDocumentContextParameter/ID",
      ),
    ).toBe("urn:fdc:peppol.eu:2017:poacc:billing:01:1.0");
  });

  it("drops BT-21 under peppol-bis-3, and keeps it everywhere else", () => {
    const noted = { ...minimal, note: "Delivery in two parts.", noteSubjectCode: "AAI" };
    const peppol = generateCii({ ...noted, profile: "peppol-bis-3" });
    expect(peppol).toContain("Delivery in two parts.");
    expect(peppol).not.toContain("ram:SubjectCode");
    for (const profile of ["en16931", "xrechnung-cii", "facturx-en16931"] as const) {
      const other = generateCii({ ...noted, profile });
      expect(other, profile).toContain("<ram:SubjectCode>AAI</ram:SubjectCode>");
    }
  });

  it("throws on an unknown profile rather than silently defaulting", () => {
    expect(() =>
      generateCii({
        ...minimal,
        profile: "zugferd-2.3" as unknown as InvoiceInput["profile"],
      }),
    ).toThrow(UnsupportedCiiProfileError);
  });

  // ⚠ Replaced 2026-08-13, for the same reason as its UBL twin in
  // generate.test.ts: the refusal it asserted is gone. What replaces it is the
  // fact that makes CII credit notes so much less work than UBL ones — there is
  // no second document to emit, so the type code is the entire difference.
  it("emits a credit-note type code into the same document, with no other change", () => {
    const invoice = generateCii({ ...minimal, invoiceTypeCode: "380" });
    const creditNote = generateCii({ ...minimal, invoiceTypeCode: "381" });
    expect(textAt(parse(creditNote), "rsm:ExchangedDocument/TypeCode")).toBe("381");
    // Byte-for-byte identical apart from those three digits: CII has one root
    // element for both document types, so nothing else can differ.
    expect(creditNote.replace(">381<", ">380<")).toBe(invoice);
  });

  it("still generates the non-credit-note codes BR-DE-17 allows", () => {
    for (const code of ["380", "384", "326", "389", "875", "876", "877"]) {
      const root = parse(generateCii({ ...minimal, invoiceTypeCode: code }));
      expect(textAt(root, "rsm:ExchangedDocument/TypeCode")).toBe(code);
    }
  });
});

describe("generateCii and generateXRechnungUBL describe the same invoice", () => {
  it("agree on the totals, from one input in two syntaxes", () => {
    const totals = computeTotals(discountedXRechnungCii);
    const cii = parse(generateCii(discountedXRechnungCii));
    const ubl = generateXRechnungUBL({
      ...discountedXRechnungCii,
      profile: "xrechnung-ubl",
    });
    expect(
      firstChild(at(cii, SUMMATION)!, RAM, "DuePayableAmount")?.text,
    ).toBe(totals.payableAmount.toFixed(2));
    expect(ubl).toContain(
      `<cbc:PayableAmount currencyID="EUR">${totals.payableAmount.toFixed(2)}</cbc:PayableAmount>`,
    );
  });

  it("validate identically, because the German CIUS is syntax-independent", () => {
    const cii = validateInput(discountedXRechnungCii);
    const ubl = validateInput({
      ...discountedXRechnungCii,
      profile: "xrechnung-ubl",
    });
    expect(cii.errors.map((e) => e.rule)).toEqual(ubl.errors.map((e) => e.rule));
    expect(cii.warnings.map((e) => e.rule)).toEqual(ubl.warnings.map((e) => e.rule));
  });
});
