import { describe, expect, it } from "vitest";

import {
  CREDIT_NOTE_TYPE_CODES,
  documentKindOf,
  generateCii,
  generateXRechnungUBL,
  isCreditNote,
  parseCiiInvoice,
  parseUbl,
  parseUblInvoice,
  validateInput,
} from "./index.js";
import {
  creditNoteDiscountXRechnung,
  creditNoteDiscountXRechnungCii,
  creditNoteXRechnung,
  creditNoteXRechnungCii,
  discountedXRechnung,
  minimalXRechnung,
} from "./fixtures.js";
import { clean, cleanLine, findingFor, withInvoice } from "./testkit.js";
import type { InvoiceInput } from "./types.js";

/**
 * Credit notes, end to end.
 *
 * The family files cover the pieces — `generate.test.ts` the UBL document,
 * `parse.test.ts` the round trip, `rules-codelists.test.ts` BR-CL-01 — and this
 * file covers the claim they add up to: **one field**. Set `invoiceTypeCode` to
 * "381" on an invoice-shaped input and every layer of the package does the right
 * thing without being told twice.
 *
 * The one-field claim is asserted literally, by diffing a credit note against
 * the invoice it was derived from, rather than by describing it.
 */

const CREDIT_NOTE_NS = "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2";
const INVOICE_NS = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";

/** The invoice from the fixtures, with BT-3 changed and nothing else. */
const asCreditNote = (input: InvoiceInput): InvoiceInput => ({
  ...input,
  invoiceTypeCode: "381",
});

describe("BT-3 is the whole API: one field turns an invoice into a credit note", () => {
  it("routes to a ubl:CreditNote in UBL and to the same document in CII", () => {
    const ubl = generateXRechnungUBL(asCreditNote(minimalXRechnung));
    const cii = generateCii(asCreditNote({ ...minimalXRechnung, profile: "xrechnung-cii" }));

    expect(ubl).toContain(`<ubl:CreditNote xmlns:ubl="${CREDIT_NOTE_NS}"`);
    expect(ubl).not.toContain(INVOICE_NS);
    expect(cii).toContain("<rsm:CrossIndustryInvoice");
    expect(cii).toContain("<ram:TypeCode>381</ram:TypeCode>");
  });

  it("needs no second entry point: the same two functions emit both documents", () => {
    // If this ever stops being true — if a generateCreditNoteUBL appears — the
    // model has grown a second way to say the same thing, and an input can then
    // contradict itself about what document it is.
    expect(typeof generateXRechnungUBL).toBe("function");
    expect(typeof generateCii).toBe("function");
    expect(isCreditNote({ invoiceTypeCode: "381" })).toBe(true);
    expect(isCreditNote({ invoiceTypeCode: "380" })).toBe(false);
    expect(isCreditNote({})).toBe(false);
    expect(documentKindOf(undefined)).toBe("invoice");
    expect(documentKindOf(" 381 ")).toBe("credit-note");
  });

  it("derives the routing set from BR-CL-01 rather than curating it", () => {
    // Every code on the credit-note half of UNTDID 1001 that is not also on the
    // invoice half. `81` is on both, and stays an invoice: an ubl:Invoice
    // carrying it passes BR-CL-01, so routing it elsewhere would change a
    // document callers have been getting since 0.1.0.
    for (const code of ["381", "261", "262", "296", "308", "396", "83", "420", "458", "532"]) {
      expect(CREDIT_NOTE_TYPE_CODES.has(code), code).toBe(true);
    }
    expect(CREDIT_NOTE_TYPE_CODES.has("81")).toBe(false);
    expect(CREDIT_NOTE_TYPE_CODES.has("380")).toBe(false);
    expect(CREDIT_NOTE_TYPE_CODES.has("384")).toBe(false);
  });
});

describe("the UBL credit-note document differs from the invoice exactly where the schema does", () => {
  const xml = generateXRechnungUBL(asCreditNote(minimalXRechnung));

  it("carries cbc:CreditNoteTypeCode and no cbc:InvoiceTypeCode", () => {
    expect(xml).toContain("<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>");
    expect(xml).not.toContain("InvoiceTypeCode");
  });

  it("carries cac:CreditNoteLine with cbc:CreditedQuantity", () => {
    expect(xml).toContain("<cac:CreditNoteLine>");
    expect(xml).toContain('<cbc:CreditedQuantity unitCode="HUR">10.0000</cbc:CreditedQuantity>');
    expect(xml).not.toContain("cac:InvoiceLine");
    expect(xml).not.toContain("InvoicedQuantity");
  });

  it("puts BT-9 in cac:PaymentMeans, because the document has no cbc:DueDate", () => {
    // UBL-CR-412 forbids PaymentMeans/PaymentDueDate on an invoice and exempts
    // the credit note explicitly (`not(...) or ../cn:CreditNote`), which is the
    // schematron confirming this is where the binding puts BT-9.
    expect(xml).toContain("<cbc:PaymentDueDate>2026-09-08</cbc:PaymentDueDate>");
    expect(xml).not.toContain("<cbc:DueDate>");
    const invoice = generateXRechnungUBL(minimalXRechnung);
    expect(invoice).toContain("<cbc:DueDate>2026-09-08</cbc:DueDate>");
    expect(invoice).not.toContain("PaymentDueDate");
  });

  it("puts the tax point date before the type code, as UBL-CreditNote-2.1.xsd does", () => {
    const withTaxPoint = generateXRechnungUBL(
      asCreditNote({ ...minimalXRechnung, taxPointDate: "2026-08-07" }),
    );
    const taxPoint = withTaxPoint.indexOf("<cbc:TaxPointDate>");
    const typeCode = withTaxPoint.indexOf("<cbc:CreditNoteTypeCode>");
    expect(taxPoint).toBeGreaterThan(-1);
    expect(taxPoint).toBeLessThan(typeCode);

    // The invoice sequence is the other way round: DueDate, InvoiceTypeCode,
    // Note, TaxPointDate. Element order is schema validity in UBL, so this is
    // not a tidiness assertion.
    const asInvoice = generateXRechnungUBL({
      ...minimalXRechnung,
      taxPointDate: "2026-08-07",
    });
    expect(asInvoice.indexOf("<cbc:TaxPointDate>")).toBeGreaterThan(
      asInvoice.indexOf("<cbc:InvoiceTypeCode>"),
    );
  });

  it("puts the contract and additional references before the originator reference", () => {
    const wide = generateXRechnungUBL(
      asCreditNote({
        ...minimalXRechnung,
        contractReference: "RV-2024-0088",
        tenderOrLotReference: "LOS-4",
        invoicedObjectIdentifier: { value: "ANL-1", schemeId: "AAJ" },
      }),
    );
    const contract = wide.indexOf("<cac:ContractDocumentReference>");
    const additional = wide.indexOf("<cac:AdditionalDocumentReference>");
    const originator = wide.indexOf("<cac:OriginatorDocumentReference>");
    expect(contract).toBeLessThan(additional);
    expect(additional).toBeLessThan(originator);

    // Reversed on an invoice, where the sequence runs Statement, Originator,
    // Contract, Additional.
    const invoice = generateXRechnungUBL({
      ...minimalXRechnung,
      contractReference: "RV-2024-0088",
      tenderOrLotReference: "LOS-4",
      invoicedObjectIdentifier: { value: "ANL-1", schemeId: "AAJ" },
    });
    expect(invoice.indexOf("<cac:OriginatorDocumentReference>")).toBeLessThan(
      invoice.indexOf("<cac:ContractDocumentReference>"),
    );
  });

  it("drops BT-11, which has no element on a UBL CreditNote at all", () => {
    const withProject = generateXRechnungUBL(
      asCreditNote({ ...minimalXRechnung, projectReference: "PRJ-2026" }),
    );
    expect(withProject).not.toContain("ProjectReference");
    expect(withProject).not.toContain("PRJ-2026");
    // Not dropped silently: the caller is told before generation.
    expect(
      validateInput(
        asCreditNote({ ...minimalXRechnung, projectReference: "PRJ-2026" }),
      ).warnings.map((w) => w.rule),
    ).toContain("ATW-CREDIT-NOTE-PROJECT-REFERENCE-UNBOUND");
  });

  it("keeps BG-3 on cac:BillingReference/cac:InvoiceDocumentReference", () => {
    // Not cac:CreditNoteDocumentReference: EN 16931 binds BG-3 to the *invoice*
    // document reference on both documents, and UBL-CR-039 forbids the
    // credit-note sibling.
    const xmlWithBg3 = generateXRechnungUBL(creditNoteXRechnung);
    expect(xmlWithBg3).toContain("<cac:BillingReference>");
    expect(xmlWithBg3).toContain("<cac:InvoiceDocumentReference>");
    expect(xmlWithBg3).toContain("<cbc:ID>2026-000142</cbc:ID>");
    expect(xmlWithBg3).not.toContain("CreditNoteDocumentReference");
  });

  it("changes nothing else: every other line of the document is the invoice's", () => {
    // The strongest form of the one-field claim. Normalise away the six known
    // structural differences and the two documents are the same bytes.
    const invoice = generateXRechnungUBL(minimalXRechnung);
    const normalised = xml
      .replace(`<ubl:CreditNote xmlns:ubl="${CREDIT_NOTE_NS}"`, `<ubl:Invoice xmlns:ubl="${INVOICE_NS}"`)
      .replace("</ubl:CreditNote>", "</ubl:Invoice>")
      .replace(
        "  <cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>\n",
        "  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>\n",
      )
      .replace("    <cbc:PaymentDueDate>2026-09-08</cbc:PaymentDueDate>\n", "")
      .replace(
        "  <cbc:ID>2026-000142</cbc:ID>\n  <cbc:IssueDate>2026-08-09</cbc:IssueDate>\n",
        "  <cbc:ID>2026-000142</cbc:ID>\n  <cbc:IssueDate>2026-08-09</cbc:IssueDate>\n  <cbc:DueDate>2026-09-08</cbc:DueDate>\n",
      )
      .replaceAll("cac:CreditNoteLine", "cac:InvoiceLine")
      .replaceAll("cbc:CreditedQuantity", "cbc:InvoicedQuantity");
    expect(normalised).toBe(invoice);
  });
});

describe("credit notes round-trip through both readers", () => {
  it.each([
    ["xrechnung-ubl-credit-note", creditNoteXRechnung],
    ["xrechnung-ubl-credit-note-discount", creditNoteDiscountXRechnung],
  ])("%s: generate → parse → generate is byte-identical", (_name, input) => {
    const xml = generateXRechnungUBL(input);
    const { invoice, unmapped } = parseUbl(xml);
    expect(unmapped).toEqual([]);
    expect(invoice.invoiceTypeCode).toBe("381");
    expect(generateXRechnungUBL(invoice)).toBe(xml);
  });

  it.each([
    ["xrechnung-cii-credit-note", creditNoteXRechnungCii],
    ["xrechnung-cii-credit-note-discount", creditNoteDiscountXRechnungCii],
  ])("%s: the CII twin does the same", (_name, input) => {
    const xml = generateCii(input);
    const { invoice, unmapped } = parseCiiInvoice(xml);
    expect(unmapped.filter((u) => u.kind === "unknown")).toEqual([]);
    expect(invoice.invoiceTypeCode).toBe("381");
    expect(generateCii(invoice)).toBe(xml);
  });

  it("reads BT-9 back out of cac:PaymentMeans and re-emits it there", () => {
    // The round trip above would pass even if BT-9 were lost, as long as it
    // were lost in both directions. This is the assertion that it is not.
    const { invoice } = parseUbl(generateXRechnungUBL(creditNoteXRechnung));
    expect(invoice.dueDate).toBe("2026-09-08");
  });

  it("keeps parseUblInvoice working under its old name", () => {
    const xml = generateXRechnungUBL(creditNoteXRechnung);
    expect(parseUblInvoice(xml).invoice).toEqual(parseUbl(xml).invoice);
  });

  it("still reads an Invoice-rooted document exactly as before", () => {
    // The negative test for the whole change: adding a second root element must
    // not have moved anything on the first one.
    for (const input of [minimalXRechnung, discountedXRechnung]) {
      const xml = generateXRechnungUBL(input);
      const { invoice, unmapped } = parseUbl(xml);
      expect(xml).toContain("<ubl:Invoice");
      expect(invoice.invoiceTypeCode).toBe("380");
      expect(invoice.dueDate).toBe(input.dueDate);
      expect(unmapped).toEqual([]);
      expect(generateXRechnungUBL(invoice)).toBe(xml);
    }
  });
});

describe("the rule surface on a credit note", () => {
  const creditNote = withInvoice({
    invoiceTypeCode: "381",
    precedingInvoices: [{ invoiceNumber: "2026-000142" }],
  });

  it("runs the whole rule set: BR-CO arithmetic fires on a credit note too", () => {
    // BR-CO-10 counts the same amounts whichever document they are on, because
    // EN 16931 has one semantic model and binds the same rule ids to both. This
    // is the assertion that the rule set was not accidentally scoped to
    // invoices somewhere.
    const wrong = validateInput({
      ...creditNote,
      declaredTotals: { lineExtensionAmount: 999 },
    });
    expect(wrong.errors.map((e) => e.rule)).toContain("BR-CO-10");
    expect(wrong.valid).toBe(false);
  });

  it("fires the XRechnung CIUS rules unchanged", () => {
    const noBuyerReference = validateInput({
      ...creditNote,
      buyerReference: undefined,
    });
    expect(noBuyerReference.errors.map((e) => e.rule)).toContain("BR-DE-15");
  });

  it("BR-CL-01 admits the credit-note half of UNTDID 1001 and still rejects nonsense", () => {
    expect(validateInput({ ...creditNote, invoiceTypeCode: "381" }).valid).toBe(true);
    expect(
      validateInput({ ...creditNote, invoiceTypeCode: "999" }).errors.map((e) => e.rule),
    ).toContain("BR-CL-01");
  });

  it("BR-DE-17 restricts a credit note to the same eight codes as an invoice", () => {
    // XRechnung's list is one list over both type-code elements. "261"
    // (self-billed credit note) is a lawful EN 16931 credit-note code and is
    // *not* one of XRechnung's eight, so it is a portal-compatibility warning
    // there and clean under the core profile.
    const selfBilled = { ...creditNote, invoiceTypeCode: "261" };
    const finding = findingFor(selfBilled, "BR-DE-17");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.xpath).toBe("/ubl:CreditNote/cbc:CreditNoteTypeCode");
    expect(validateInput(selfBilled).valid).toBe(true);
    expect(
      validateInput({ ...selfBilled, profile: "en16931" }).warnings.map((e) => e.rule),
    ).not.toContain("BR-DE-17");
  });

  it("BR-DE-26 does not fire on a credit note, because its test names 384 only", () => {
    // ⚠ Verified against XRechnung 3.0.2 schematron 2.5.0, both syntaxes, not
    // reasoned from the rule's German text. The UBL assertion is
    //   not(normalize-space(cbc:InvoiceTypeCode) = '384'
    //       or normalize-space(cbc:CreditNoteTypeCode) = '384')
    //   or (cac:BillingReference/cac:InvoiceDocumentReference)
    // — 381 does not appear in it, and the string '381' occurs in the whole
    // XRechnung UBL schematron exactly once, inside BR-DE-17's code list.
    const noReference = withInvoice({ invoiceTypeCode: "381" });
    const all = validateInput(noReference);
    const ids = [...all.errors, ...all.warnings].map((e) => e.rule);
    expect(ids).not.toContain("BR-DE-26");
    expect(all.valid).toBe(true);

    // A corrected invoice still does fire it, on either document type.
    expect(
      validateInput(withInvoice({ invoiceTypeCode: "384" })).warnings.map((e) => e.rule),
    ).toContain("BR-DE-26");
  });

  it("advises, at information level, that a credit note should say what it credits", () => {
    const finding = findingFor(withInvoice({ invoiceTypeCode: "381" }), "ATW-CREDIT-NOTE-NO-PRECEDING-INVOICE");
    // `findings` in the testkit covers errors and warnings only, so an
    // information-level finding is fetched from the result directly.
    expect(finding).toBeUndefined();
    const result = validateInput(withInvoice({ invoiceTypeCode: "381" }));
    const advisory = result.information.find(
      (e) => e.rule === "ATW-CREDIT-NOTE-NO-PRECEDING-INVOICE",
    );
    expect(advisory).toBeDefined();
    expect(advisory!.message).toContain("BR-DE-26");
    expect(result.valid).toBe(true);
    expect(validateInput(creditNote).information.map((e) => e.rule)).not.toContain(
      "ATW-CREDIT-NOTE-NO-PRECEDING-INVOICE",
    );
  });
});

describe("the sign convention: a credit note is not a negative invoice", () => {
  it("warns when a credit note states negative line amounts", () => {
    const mixed = withInvoice({
      invoiceTypeCode: "381",
      precedingInvoices: [{ invoiceNumber: "2026-000142" }],
      lines: [cleanLine({ quantity: -10 })],
    });
    const finding = findingFor(mixed, "ATW-CREDIT-NOTE-NEGATIVE-AMOUNTS");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    // The offending figure, named: 10 × 150.00 credited the wrong way round.
    expect(finding!.message).toContain("line 1 has a net amount (BT-131) of -1500");
    expect(finding!.message).toContain("negative invoice");
    // A warning, not an error: the schematron rejects neither idiom, and this
    // package does not invent rejections the regulator does not make.
    expect(validateInput(mixed).valid).toBe(true);
  });

  it("says nothing about a negative invoice, which is a different lawful document", () => {
    const negativeInvoice = withInvoice({
      invoiceTypeCode: "380",
      lines: [cleanLine({ quantity: -10 })],
    });
    const ids = [
      ...validateInput(negativeInvoice).errors,
      ...validateInput(negativeInvoice).warnings,
    ].map((e) => e.rule);
    expect(ids).not.toContain("ATW-CREDIT-NOTE-NEGATIVE-AMOUNTS");
  });

  it("says nothing about a credit note stated positively, which is the correct idiom", () => {
    expect(
      findingFor(
        withInvoice({
          invoiceTypeCode: "381",
          precedingInvoices: [{ invoiceNumber: "2026-000142" }],
        }),
        "ATW-CREDIT-NOTE-NEGATIVE-AMOUNTS",
      ),
    ).toBeUndefined();
  });
});

describe("BT-9 on a credit note with no payment instructions", () => {
  it("warns rather than dropping the due date silently", () => {
    const unbound: InvoiceInput = {
      ...clean,
      invoiceTypeCode: "381",
      dueDate: "2026-09-08",
      payment: undefined,
      precedingInvoices: [{ invoiceNumber: "2026-000142" }],
    };
    const finding = findingFor(unbound, "ATW-CREDIT-NOTE-DUE-DATE-UNBOUND");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.field).toEqual(["BT-9", "BG-16"]);
    // And the document really does lack it, which is what the finding claims.
    expect(generateXRechnungUBL(unbound)).not.toContain("2026-09-08");
  });

  it("stays silent once BG-16 is there to hold it", () => {
    expect(
      findingFor(
        withInvoice({
          invoiceTypeCode: "381",
          dueDate: "2026-09-08",
          precedingInvoices: [{ invoiceNumber: "2026-000142" }],
        }),
        "ATW-CREDIT-NOTE-DUE-DATE-UNBOUND",
      ),
    ).toBeUndefined();
  });

  it("stays silent for CII, where BT-9 has an element of its own", () => {
    const cii: InvoiceInput = {
      ...clean,
      profile: "xrechnung-cii",
      invoiceTypeCode: "381",
      dueDate: "2026-09-08",
      payment: undefined,
      precedingInvoices: [{ invoiceNumber: "2026-000142" }],
    };
    expect(findingFor(cii, "ATW-CREDIT-NOTE-DUE-DATE-UNBOUND")).toBeUndefined();
    expect(generateCii(cii)).toContain("20260908");
  });
});
