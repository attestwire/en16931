import { describe, expect, it } from "vitest";

import {
  applyDefaults,
  computeTotals,
  createCreditNote,
  generateCii,
  generateXRechnungUBL,
  validateInput,
} from "./index.js";
import {
  discountedXRechnung,
  extendedXRechnungCii,
  minimalXRechnung,
  reverseChargeXRechnung,
} from "./fixtures.js";
import { clean } from "./testkit.js";
import type { InvoiceFacts, InvoiceInput, Profile } from "./types.js";

const options = { invoiceNumber: "2026-G00031", issueDate: "2026-09-01", reason: "Gutschrift: Leistung nicht erbracht." };

const PROFILES: Profile[] = ["xrechnung-ubl", "xrechnung-cii", "facturx-en16931", "peppol-bis-3", "en16931"];
const UBL_PROFILES = new Set<Profile>(["xrechnung-ubl", "peppol-bis-3", "en16931"]);
const CII_PROFILES = new Set<Profile>(["xrechnung-cii", "facturx-en16931", "en16931"]);

const ORIGINALS: [string, InvoiceInput][] = [
  ["a domestic invoice", minimalXRechnung],
  ["a reverse-charge invoice", reverseChargeXRechnung],
  ["an invoice with allowances, charges, a prepayment and rounding", discountedXRechnung],
  ["the extended CII invoice", extendedXRechnungCii],
];

const count = (xml: string, element: string) => xml.split(`<${element}>`).length - 1;

describe.each(PROFILES)("a credit note under %s", (profile) => {
  it.each(ORIGINALS)("from %s passes validateInput", (_name, fixture) => {
    const original: InvoiceInput = { ...fixture, profile };
    const creditNote = createCreditNote(original, options);
    const result = validateInput(creditNote);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.information).toEqual([]);
    // The one warning a credit note can inherit is the documented one: a UBL
    // credit note has no element for BT-11, and the original had one.
    const expected =
      original.projectReference !== undefined && UBL_PROFILES.has(profile)
        ? ["ATW-CREDIT-NOTE-PROJECT-REFERENCE-UNBOUND"]
        : [];
    expect(result.warnings.map((f) => f.rule)).toEqual(expected);
  });

  it.each(ORIGINALS)("from %s is emitted as a credit note", (_name, fixture) => {
    const original: InvoiceInput = { ...fixture, profile };
    const creditNote = createCreditNote(original, options);
    if (UBL_PROFILES.has(profile)) {
      const xml = generateXRechnungUBL(creditNote);
      expect(xml).toContain("<ubl:CreditNote ");
      expect(xml).toContain("<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>");
      expect(xml).toContain(
        `<cac:BillingReference>\n    <cac:InvoiceDocumentReference>\n      <cbc:ID>${original.invoiceNumber}</cbc:ID>\n      <cbc:IssueDate>${original.issueDate}</cbc:IssueDate>`,
      );
      expect(count(xml, "cac:CreditNoteLine")).toBe(original.lines.length);
      expect(xml).not.toContain("<cac:InvoiceLine>");
    }
    if (CII_PROFILES.has(profile)) {
      const xml = generateCii(creditNote);
      expect(xml).toContain("<ram:TypeCode>381</ram:TypeCode>");
      expect(xml).toContain(
        `<ram:InvoiceReferencedDocument>\n        <ram:IssuerAssignedID>${original.invoiceNumber}</ram:IssuerAssignedID>`,
      );
      expect(count(xml, "ram:IncludedSupplyChainTradeLineItem")).toBe(original.lines.length);
    }
  });
});

describe("createCreditNote", () => {
  it("references the original, and keeps its profile, parties, currency and payment details", () => {
    const creditNote = createCreditNote(minimalXRechnung, options);
    expect(creditNote).toMatchObject({
      profile: minimalXRechnung.profile,
      invoiceNumber: "2026-G00031",
      issueDate: "2026-09-01",
      invoiceTypeCode: "381",
      note: options.reason,
      currency: "EUR",
      precedingInvoices: [{ invoiceNumber: "2026-000142", issueDate: "2026-08-09" }],
      buyerReference: minimalXRechnung.buyerReference,
      orderReference: minimalXRechnung.orderReference,
      deliveryDate: minimalXRechnung.deliveryDate,
      paymentTerms: minimalXRechnung.paymentTerms,
    });
    expect(creditNote.seller).toEqual(minimalXRechnung.seller);
    expect(creditNote.buyer).toEqual(minimalXRechnung.buyer);
    expect(creditNote.payment).toEqual(minimalXRechnung.payment);
    expect(creditNote.lines).toEqual(minimalXRechnung.lines);
  });

  it("states the same positive amounts: the type code carries the direction", () => {
    const creditNote = createCreditNote(minimalXRechnung, options);
    expect(computeTotals(creditNote)).toEqual(computeTotals(minimalXRechnung));
    expect(computeTotals(creditNote).payableAmount).toBeGreaterThan(0);
    expect(validateInput(creditNote).warnings.map((f) => f.rule)).not.toContain(
      "ATW-CREDIT-NOTE-NEGATIVE-AMOUNTS",
    );
  });

  it("leaves out what belongs to the original's settlement", () => {
    const original: InvoiceInput = {
      ...discountedXRechnung,
      taxPointDate: "2026-07-31",
      invoicingPeriod: { startDate: "2026-07-01", endDate: "2026-07-31" },
      declaredTotals: { payableAmount: 1680 },
    };
    const creditNote = createCreditNote(original, { invoiceNumber: "GS-1", issueDate: "2026-09-01" });
    for (const key of [
      "dueDate",
      "taxPointDate",
      "paidAmount",
      "roundingAmount",
      "declaredTotals",
      "supportingDocuments",
      "note",
      "noteSubjectCode",
    ] as const) {
      expect(creditNote[key], key).toBeUndefined();
    }
    // The credit note names the invoice it credits, not the one the original settled.
    expect(creditNote.precedingInvoices).toEqual([{ invoiceNumber: "2026-000144", issueDate: "2026-08-09" }]);
    // A full credit keeps the document level allowance and charge, so it
    // credits exactly what was invoiced: 2 179.53, before the prepayment.
    expect(creditNote.allowances).toEqual(original.allowances);
    expect(creditNote.charges).toEqual(original.charges);
    expect(computeTotals(creditNote).payableAmount).toBe(2179.53);
  });

  it("credits only the lines asked for, in the original's order", () => {
    const creditNote = createCreditNote(discountedXRechnung, { ...options, lines: ["3", "2"] });
    expect(creditNote.lines.map((line) => line.id)).toEqual(["2", "3"]);
    // Document level allowances and charges are not apportioned to a partial credit.
    expect(creditNote.allowances).toBeUndefined();
    expect(creditNote.charges).toBeUndefined();
    // 99.80 at 7% and 270.00 at 19%: 106.79 + 321.30.
    expect(computeTotals(creditNote).payableAmount).toBe(428.09);
    expect(validateInput({ ...creditNote, projectReference: undefined }).valid).toBe(true);
  });

  it("keeps BT-111 on a full credit and leaves it to the caller on a partial one", () => {
    const original: InvoiceInput = {
      ...minimalXRechnung,
      profile: "en16931",
      vatAccountingCurrency: "PLN",
      taxAmountInAccountingCurrency: 1150.12,
    };
    const full = createCreditNote(original, options);
    expect(full.taxAmountInAccountingCurrency).toBe(1150.12);
    expect(validateInput(full).valid).toBe(true);
    const partial = createCreditNote(original, { ...options, lines: ["1"] });
    expect(partial.vatAccountingCurrency).toBe("PLN");
    expect(partial.taxAmountInAccountingCurrency).toBeUndefined();
    expect(validateInput(partial).errors.map((f) => f.rule)).toContain("BR-53");
  });

  it("refuses a line the original does not have, or no lines at all", () => {
    expect(() => createCreditNote(minimalXRechnung, { ...options, lines: ["1", "9"] })).toThrow(RangeError);
    expect(() => createCreditNote(minimalXRechnung, { ...options, lines: ["9"] })).toThrow(
      'invoice 2026-000142 has no line "9". Its lines are "1", "2".',
    );
    expect(() => createCreditNote(minimalXRechnung, { ...options, lines: [] })).toThrow(/options\.lines is empty/);
  });

  it("shares no object with the original, and does not modify it", () => {
    const original = structuredClone(discountedXRechnung);
    const creditNote = createCreditNote(original, options);
    expect(original).toEqual(discountedXRechnung);
    expect(creditNote.seller).not.toBe(original.seller);
    expect(creditNote.lines[0]).not.toBe(original.lines[0]);
    creditNote.lines[0]!.quantity = 1;
    creditNote.seller.address.city = "Hamburg";
    expect(original).toEqual(discountedXRechnung);
  });

  it("credits an invoice stated as facts, and becomes the same codes", () => {
    const facts: InvoiceFacts = {
      ...clean,
      vatScenario: "intra-eu-services",
      buyer: { ...clean.buyer, vatId: "FR12345678901", address: { city: "Lyon", postalCode: "69001", countryCode: "FR" } },
      payment: { iban: "DE02120300000000202051" },
      lines: [
        { id: "1", description: "Beratung", quantity: 8, unitCode: "HUR", unitPrice: 175 },
        { id: "2", description: "Workshop", quantity: 1.5, unitCode: "DAY", unitPrice: 1200 },
      ],
    };
    const creditNote = createCreditNote(facts, { ...options, lines: ["2"] });
    expect(creditNote.vatScenario).toBe("intra-eu-services");
    const result = validateInput(creditNote);
    expect(result.errors).toEqual([]);
    expect(result.information.map((f) => f.rule)).toEqual([
      "ATW-VAT-SCENARIO-APPLIED",
      "ATW-PAYMENT-MEANS-INFERRED",
    ]);
    const explicit = createCreditNote(applyDefaults(facts).invoice, { ...options, lines: ["2"] });
    expect(generateXRechnungUBL(creditNote)).toBe(generateXRechnungUBL(explicit));
    expect(generateCii({ ...creditNote, profile: "xrechnung-cii" })).toBe(
      generateCii({ ...explicit, profile: "xrechnung-cii" }),
    );
    expect(generateXRechnungUBL(creditNote)).toContain(
      "<cbc:TaxExemptionReason>Steuerschuldnerschaft des Leistungsempfängers</cbc:TaxExemptionReason>",
    );
  });
});
