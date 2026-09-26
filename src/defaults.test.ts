import { describe, expect, it } from "vitest";

import {
  applyDefaults,
  applyVatScenarios,
  generateCii,
  generateXRechnungUBL,
  validate,
  validateInput,
} from "./index.js";
import { SEPA_IBAN_COUNTRIES, ibanCountry, inferPaymentMeans } from "./payment-means.js";
import { clean } from "./testkit.js";
import type {
  InvoiceFacts,
  InvoiceInput,
  PaymentInstructionsFacts,
  TeachingError,
} from "./types.js";

/** `clean` with its payment instructions replaced, stated as facts. */
const paying = (payment: PaymentInstructionsFacts, currency = "EUR"): InvoiceFacts => ({
  ...clean,
  currency,
  payment,
});

const codeFor = (payment: PaymentInstructionsFacts, currency = "EUR") =>
  applyDefaults(paying(payment, currency)).invoice.payment?.meansCode;

const noteOf = (inv: InvoiceFacts): TeachingError | undefined =>
  validateInput(inv).information.find((f) => f.rule === "ATW-PAYMENT-MEANS-INFERRED");

const DE_IBAN = "DE02120300000000202051";
const TR_IBAN = "TR330006100519786457841326";
const GB_IBAN = "GB29NWBK60161331926819";
const CH_IBAN = "CH9300762011623852957";

describe("the payment means code, inferred from the account", () => {
  it("is 58, SEPA credit transfer, for an IBAN in the SEPA scheme on a euro invoice", () => {
    expect(codeFor({ iban: DE_IBAN })).toBe("58");
    expect(codeFor({ iban: "de02 1203 0000 0000 2020 51" })).toBe("58");
    const note = noteOf(paying({ iban: DE_IBAN }))!;
    expect(note.severity).toBe("information");
    expect(note.field).toBe("BT-81");
    expect(note.message).toContain('set to "58", SEPA credit transfer');
    expect(note.message).toContain("the IBAN's country, DE, takes part in the SEPA scheme");
    expect(note.xpath).toBe("/ubl:Invoice/cac:PaymentMeans/cbc:PaymentMeansCode");
  });

  it("is 30, credit transfer, when the IBAN is outside SEPA or the currency is not the euro", () => {
    expect(codeFor({ iban: TR_IBAN })).toBe("30");
    expect(noteOf(paying({ iban: TR_IBAN }))!.message).toContain("its country, TR, is not in the SEPA scheme");
    expect(codeFor({ iban: GB_IBAN }, "GBP")).toBe("30");
    expect(codeFor({ iban: CH_IBAN }, "CHF")).toBe("30");
    expect(noteOf(paying({ iban: GB_IBAN }, "GBP"))!.message).toContain(
      "the invoice currency (BT-5) is GBP, and SEPA credit transfers are in euro only",
    );
    // A euro payment to a UK or Swiss account is still a SEPA credit transfer.
    expect(codeFor({ iban: GB_IBAN })).toBe("58");
    expect(codeFor({ iban: CH_IBAN })).toBe("58");
  });

  it("is 59, SEPA direct debit, when a mandate reference is given on a euro invoice", () => {
    const payment: PaymentInstructionsFacts = {
      directDebit: {
        mandateReference: "MANDAT-2026-01",
        creditorIdentifier: "DE98ZZZ09999999999",
        debitedAccount: "DE89370400440532013000",
      },
    };
    expect(codeFor(payment)).toBe("59");
    // The mandate decides even when the seller's own IBAN is there too.
    expect(codeFor({ ...payment, iban: DE_IBAN })).toBe("59");
    expect(noteOf(paying(payment))!.message).toContain('set to "59", SEPA direct debit');
    // A complete XRechnung direct debit is valid once the code is inferred.
    expect(validateInput(paying(payment)).errors).toEqual([]);
  });

  it("is 49, direct debit, for a mandate SEPA cannot carry", () => {
    expect(codeFor({ directDebit: { mandateReference: "DDI-0042" } }, "GBP")).toBe("49");
    expect(codeFor({ directDebit: { mandateReference: "M-1", debitedAccount: TR_IBAN } })).toBe("49");
    expect(noteOf(paying({ directDebit: { mandateReference: "DDI-0042" } }, "GBP"))!.message).toContain(
      "SEPA direct debits are in euro only",
    );
  });

  it("never replaces a stated code, not even an empty one", () => {
    expect(codeFor({ meansCode: "31", iban: DE_IBAN })).toBe("31");
    const empty = paying({ meansCode: "", iban: DE_IBAN });
    expect(applyDefaults(empty).invoice).toBe(empty);
    expect(validateInput(empty).errors.map((f) => f.rule)).toContain("BR-49");
    expect(noteOf(empty)).toBeUndefined();
  });

  it("infers nothing without an account or a mandate, and BR-49 says so", () => {
    const inv = paying({ accountName: "Acme GmbH" });
    expect(inferPaymentMeans(inv)).toBeUndefined();
    expect(applyDefaults(inv).invoice).toBe(inv);
    expect(validateInput(inv).errors.map((f) => f.rule)).toContain("BR-49");
  });

  it("points the note at the credit-note document on a credit note", () => {
    const inv: InvoiceFacts = { ...paying({ iban: DE_IBAN }), invoiceTypeCode: "381" };
    expect(noteOf(inv)!.xpath).toBe("/ubl:CreditNote/cac:PaymentMeans/cbc:PaymentMeansCode");
  });

  it("writes the same XML as the stated code, in both syntaxes", () => {
    const facts = paying({ iban: DE_IBAN, accountName: "Acme GmbH" });
    const explicit: InvoiceInput = { ...clean, payment: { meansCode: "58", iban: DE_IBAN, accountName: "Acme GmbH" } };
    const ubl = generateXRechnungUBL(facts);
    expect(ubl).toBe(generateXRechnungUBL(explicit));
    expect(ubl).toContain('<cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>');
    const cii = generateCii({ ...facts, profile: "xrechnung-cii" });
    expect(cii).toBe(generateCii({ ...explicit, profile: "xrechnung-cii" }));
    expect(cii).toContain("<ram:TypeCode>58</ram:TypeCode>");
  });

  it("leaves a document read from XML alone: a missing code there is BR-49", () => {
    const xml = generateXRechnungUBL(clean).replace(/\s*<cbc:PaymentMeansCode>58<\/cbc:PaymentMeansCode>/, "");
    expect(xml).not.toContain("PaymentMeansCode");
    const result = validate(xml);
    const rules = [...result.errors, ...result.warnings, ...result.information].map((f) => f.rule);
    expect(rules).toContain("BR-49");
    expect(rules).not.toContain("ATW-PAYMENT-MEANS-INFERRED");
  });
});

describe("the SEPA scheme's IBAN prefixes (EPC409-09 v8.0)", () => {
  it("holds the 42 prefixes of the EPC list, including the 2025 and 2026 members", () => {
    expect(SEPA_IBAN_COUNTRIES.size).toBe(42);
    for (const prefix of ["AL", "MD", "ME", "MK", "RS", "GB", "CH", "VA", "GI"]) {
      expect(SEPA_IBAN_COUNTRIES.has(prefix), prefix).toBe(true);
    }
    // Territories bank under their parent's prefix, so their own codes are not listed.
    for (const territory of ["AX", "RE", "JE", "GG", "IM", "GF"]) {
      expect(SEPA_IBAN_COUNTRIES.has(territory), territory).toBe(false);
    }
    for (const outside of ["TR", "US", "UA", "BA", "XK"]) {
      expect(SEPA_IBAN_COUNTRIES.has(outside), outside).toBe(false);
    }
  });

  it("reads the prefix off an IBAN however it is written", () => {
    expect(ibanCountry(" de02 1203 ")).toBe("DE");
    expect(ibanCountry("1234")).toBe("");
    expect(ibanCountry(undefined)).toBe("");
  });
});

describe("applyDefaults", () => {
  const facts: InvoiceFacts = {
    ...clean,
    vatScenario: "intra-eu-services",
    buyer: {
      ...clean.buyer,
      vatId: "FR12345678901",
      address: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
    },
    payment: { iban: DE_IBAN },
    lines: [{ id: "1", description: "Beratung", quantity: 8, unitCode: "HUR", unitPrice: 175 }],
  };

  it("is the VAT scenarios and the payment means together, noted in that order", () => {
    const { invoice, notes } = applyDefaults(facts);
    expect(notes.map((n) => n.rule)).toEqual(["ATW-VAT-SCENARIO-APPLIED", "ATW-PAYMENT-MEANS-INFERRED"]);
    expect(invoice.lines[0]).toMatchObject({ vatCategory: "AE", vatRate: 0 });
    expect(invoice.payment?.meansCode).toBe("58");
    // applyVatScenarios is the VAT half alone.
    expect(applyVatScenarios(facts).invoice.payment?.meansCode).toBeUndefined();
  });

  it("is what validateInput judges and the generators write", () => {
    const { invoice, notes } = applyDefaults(facts);
    const result = validateInput(facts);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.information).toEqual(notes);
    expect(generateXRechnungUBL(facts)).toBe(generateXRechnungUBL(invoice));
    expect(generateCii({ ...facts, profile: "xrechnung-cii" })).toBe(
      generateCii({ ...invoice, profile: "xrechnung-cii" }),
    );
  });

  it("returns an explicit input as the same object, with no notes", () => {
    const result = applyDefaults(clean);
    expect(result.invoice).toBe(clean);
    expect(result.notes).toEqual([]);
  });

  it("does not modify its input", () => {
    const copy = structuredClone(facts);
    applyDefaults(facts);
    expect(facts).toEqual(copy);
  });
});
