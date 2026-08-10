import { describe, expect, it } from "vitest";
import { validateInput } from "./index.js";
import type { InvoiceInput } from "./types.js";

/**
 * A genuinely XRechnung-complete invoice.
 *
 * This fixture grew when the rule set did: BR-DE-1 (payment instructions),
 * BR-DE-2/5/6/7 (seller contact) and the Peppol endpoint rules all constrain
 * fields the original seed fixture omitted, so an invoice without them was
 * never actually valid — the seed rule set just could not see it yet.
 */
export const base: InvoiceInput = {
  profile: "xrechnung-ubl",
  invoiceNumber: "2026-001",
  issueDate: "2026-08-09",
  currency: "EUR",
  buyerReference: "990-123456-78",
  seller: {
    name: "Acme LLC",
    vatId: "DE123456789",
    address: { city: "Berlin", postalCode: "10115", countryCode: "DE" },
    electronicAddress: { schemeId: "9930", value: "DE123456789" },
    contact: {
      name: "Buchhaltung",
      phone: "+49 30 1234567",
      email: "rechnungen@acme.example",
    },
  },
  buyer: {
    name: "Kunde GmbH",
    vatId: "DE987654321",
    address: { city: "München", postalCode: "80331", countryCode: "DE" },
    electronicAddress: { schemeId: "9930", value: "DE987654321" },
  },
  payment: {
    meansCode: "58",
    iban: "DE02120300000000202051",
    accountName: "Acme LLC",
  },
  lines: [
    {
      id: "1",
      description: "Consulting",
      quantity: 10,
      unitCode: "HUR",
      unitPrice: 150,
      vatCategory: "S",
      vatRate: 19,
    },
  ],
};

const rulesOf = (inv: InvoiceInput) =>
  validateInput(inv).errors.map((e) => e.rule);

describe("validateInput", () => {
  it("passes a well-formed XRechnung input", () => {
    const result = validateInput(base);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("BR-DE-15: missing buyer reference on XRechnung is fatal and teaches the fix", () => {
    const result = validateInput({ ...base, buyerReference: undefined });
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.rule === "BR-DE-15");
    expect(err).toBeDefined();
    expect(err!.field).toBe("BT-10");
    expect(err!.fix).toMatch(/Leitweg-ID/);
  });

  it("BR-DE-15 does not fire for non-XRechnung profiles", () => {
    const result = validateInput({
      ...base,
      profile: "facturx-en16931",
      buyerReference: undefined,
    });
    expect(result.errors.map((e) => e.rule)).not.toContain("BR-DE-15");
  });

  it("BR-AE-02: reverse charge without buyer VAT ID is fatal", () => {
    const result = validateInput({
      ...base,
      buyer: { ...base.buyer, vatId: undefined },
      lines: [{ ...base.lines[0]!, vatCategory: "AE", vatRate: 0 }],
    });
    expect(result.errors.map((e) => e.rule)).toContain("BR-AE-02");
  });

  it("BR-S-02: standard-rated lines without a seller tax identifier is fatal", () => {
    // Historically this case was reported as BR-CO-09. That was a mis-ID:
    // BR-CO-09 governs the ISO country *prefix* on a VAT identifier that is
    // present, whereas an absent identifier on a standard-rated line is BR-S-02
    // (and, under the German CIUS, BR-DE-16).
    const result = validateInput({
      ...base,
      seller: { ...base.seller, vatId: undefined },
    });
    const rules = result.errors.map((e) => e.rule);
    expect(rules).toContain("BR-S-02");
    expect(rules).toContain("BR-DE-16");
    expect(rules).not.toContain("BR-CO-09");
  });
});

describe("mandatory document-level fields (BR-02..BR-16)", () => {
  it("BR-02: blank invoice number is fatal", () => {
    expect(rulesOf({ ...base, invoiceNumber: "  " })).toContain("BR-02");
  });

  it("BR-03: missing issue date is fatal", () => {
    expect(rulesOf({ ...base, issueDate: "" })).toContain("BR-03");
  });

  it("BR-03: a non-ISO issue date is fatal and names the offending value", () => {
    const err = validateInput({ ...base, issueDate: "09.08.2026" }).errors.find(
      (e) => e.rule === "BR-03",
    );
    expect(err).toBeDefined();
    expect(err!.message).toContain("09.08.2026");
    expect(err!.message).toMatch(/xs:date/);
  });

  it("BR-05: a non-ISO-4217 currency is fatal", () => {
    expect(rulesOf({ ...base, currency: "Euro" })).toContain("BR-05");
  });

  it("BR-06 / BR-07: missing party names are fatal", () => {
    const rules = rulesOf({
      ...base,
      seller: { ...base.seller, name: "" },
      buyer: { ...base.buyer, name: "" },
    });
    expect(rules).toContain("BR-06");
    expect(rules).toContain("BR-07");
  });

  it("BR-09 / BR-11: missing country codes are fatal", () => {
    const rules = rulesOf({
      ...base,
      seller: { ...base.seller, address: { ...base.seller.address, countryCode: "" } },
      buyer: { ...base.buyer, address: { ...base.buyer.address, countryCode: "Germany" } },
    });
    expect(rules).toContain("BR-09");
    expect(rules).toContain("BR-11");
  });

  it("BR-16: an invoice with no lines is fatal", () => {
    expect(rulesOf({ ...base, lines: [] })).toContain("BR-16");
  });

  it("BR-CO-26: a seller with no identifier at all is fatal", () => {
    const rules = rulesOf({
      ...base,
      seller: {
        ...base.seller,
        vatId: undefined,
        taxRegistrationId: undefined,
        legalRegistrationId: undefined,
      },
    });
    expect(rules).toContain("BR-CO-26");
  });

  it("BR-CO-26 is satisfied by a legal registration identifier alone", () => {
    const rules = rulesOf({
      ...base,
      seller: {
        ...base.seller,
        vatId: undefined,
        legalRegistrationId: "HRB 12345",
      },
    });
    expect(rules).not.toContain("BR-CO-26");
  });
});

describe("per-line mandatory fields (BR-21..BR-27)", () => {
  const withLine = (patch: Partial<InvoiceInput["lines"][number]>) => ({
    ...base,
    lines: [{ ...base.lines[0]!, ...patch }],
  });

  it("BR-21: missing line id is fatal", () => {
    expect(rulesOf(withLine({ id: "" }))).toContain("BR-21");
  });

  it("BR-22: non-numeric quantity is fatal", () => {
    expect(rulesOf(withLine({ quantity: NaN }))).toContain("BR-22");
  });

  it("BR-23: missing unit code is fatal and teaches UN/ECE Rec 20", () => {
    const err = validateInput(withLine({ unitCode: "" })).errors.find(
      (e) => e.rule === "BR-23",
    );
    expect(err).toBeDefined();
    expect(err!.fix).toMatch(/HUR/);
  });

  it("BR-25: missing item name is fatal", () => {
    expect(rulesOf(withLine({ description: "" }))).toContain("BR-25");
  });

  it("BR-26: missing unit price is fatal", () => {
    expect(rulesOf(withLine({ unitPrice: undefined as unknown as number }))).toContain(
      "BR-26",
    );
  });

  it("BR-27: a negative unit price is fatal, not merely odd", () => {
    const err = validateInput(withLine({ unitPrice: -5 })).errors.find(
      (e) => e.rule === "BR-27",
    );
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/allowances/);
  });

  it("per-line errors identify which line failed", () => {
    const result = validateInput({
      ...base,
      lines: [base.lines[0]!, { ...base.lines[0]!, id: "2", unitCode: "" }],
    });
    const err = result.errors.find((e) => e.rule === "BR-23");
    expect(err!.message).toContain("Line 2");
    expect(err!.xpath).toBe("/ubl:Invoice/cac:InvoiceLine[2]/cbc:InvoicedQuantity/@unitCode");
  });
});

describe("VAT identifier prefixes (BR-CO-09)", () => {
  it("fires when a VAT id has no ISO country prefix", () => {
    const rules = rulesOf({
      ...base,
      seller: { ...base.seller, vatId: "123456789" },
    });
    expect(rules).toContain("BR-CO-09");
  });

  it("accepts the Greek EL derogation", () => {
    const rules = rulesOf({
      ...base,
      seller: { ...base.seller, vatId: "EL123456789" },
    });
    expect(rules).not.toContain("BR-CO-09");
  });
});

describe("VAT category consistency", () => {
  it("BR-S-05: standard rated with a zero rate is fatal and explains the alternatives", () => {
    const err = validateInput({
      ...base,
      lines: [{ ...base.lines[0]!, vatCategory: "S", vatRate: 0 }],
    }).errors.find((e) => e.rule === "BR-S-05");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/contradictory/);
  });

  it.each([
    ["Z", "BR-Z-05"],
    ["E", "BR-E-05"],
    ["AE", "BR-AE-05"],
    ["K", "BR-IC-05"],
    ["G", "BR-G-05"],
  ] as const)(
    "%s with a non-zero rate triggers %s",
    (category, rule) => {
      const rules = rulesOf({
        ...base,
        deliveryDate: "2026-08-05",
        deliverTo: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
        vatExemptionReasons: { E: "Exempt under Article 132" },
        lines: [{ ...base.lines[0]!, vatCategory: category, vatRate: 19 }],
      });
      expect(rules).toContain(rule);
    },
  );

  it.each([
    ["Z", "BR-Z-02"],
    ["E", "BR-E-02"],
    ["G", "BR-G-02"],
  ] as const)(
    "%s without a seller tax identifier triggers %s",
    (category, rule) => {
      const rules = rulesOf({
        ...base,
        seller: { ...base.seller, vatId: undefined },
        vatExemptionReasons: { E: "Exempt under Article 132" },
        lines: [{ ...base.lines[0]!, vatCategory: category, vatRate: 0 }],
      });
      expect(rules).toContain(rule);
    },
  );

  it("BR-IC-02: intra-community supply needs the buyer VAT id specifically", () => {
    const rules = rulesOf({
      ...base,
      buyer: { ...base.buyer, vatId: undefined, legalRegistrationId: "HRB 1" },
      deliveryDate: "2026-08-05",
      deliverTo: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
      lines: [{ ...base.lines[0]!, vatCategory: "K", vatRate: 0 }],
    });
    expect(rules).toContain("BR-IC-02");
  });

  it("BR-IC-11 / BR-IC-12: category K needs a delivery date and destination country", () => {
    const rules = rulesOf({
      ...base,
      buyer: { ...base.buyer, vatId: "FR12345678901" },
      lines: [{ ...base.lines[0]!, vatCategory: "K", vatRate: 0 }],
    });
    expect(rules).toContain("BR-IC-11");
    expect(rules).toContain("BR-IC-12");
  });

  it("BR-O-05: category O must not carry a rate at all, even zero", () => {
    const err = validateInput({
      ...base,
      seller: { ...base.seller, vatId: undefined, legalRegistrationId: "HRB 1" },
      buyer: { ...base.buyer, vatId: undefined },
      lines: [{ ...base.lines[0]!, vatCategory: "O", vatRate: 0 }],
    }).errors.find((e) => e.rule === "BR-O-05");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/not even 0/);
  });

  it("BR-O-02: category O must not appear alongside a VAT identifier", () => {
    const rules = rulesOf({
      ...base,
      lines: [{ ...base.lines[0]!, vatCategory: "O", vatRate: undefined }],
    });
    expect(rules).toContain("BR-O-02");
  });

  it("BR-E-10: exempt lines need an exemption reason, and there is no default", () => {
    const err = validateInput({
      ...base,
      lines: [{ ...base.lines[0]!, vatCategory: "E", vatRate: 0 }],
    }).errors.find((e) => e.rule === "BR-E-10");
    expect(err).toBeDefined();
    expect(err!.fix).toMatch(/UStG|Directive/);
  });

  it("BR-E-10 is satisfied by an explicit reason", () => {
    const rules = rulesOf({
      ...base,
      vatExemptionReasons: { E: "Steuerbefreit nach §4 Nr. 21 UStG" },
      lines: [{ ...base.lines[0]!, vatCategory: "E", vatRate: 0 }],
    });
    expect(rules).not.toContain("BR-E-10");
  });
});

describe("BR-CO arithmetic against declared totals", () => {
  it("stays silent when declaredTotals agree with the computed values", () => {
    const rules = rulesOf({
      ...base,
      declaredTotals: {
        lineExtensionAmount: 1500,
        taxExclusiveAmount: 1500,
        taxAmount: 285,
        taxInclusiveAmount: 1785,
        payableAmount: 1785,
      },
    });
    expect(rules.filter((r) => r.startsWith("BR-CO-1"))).toHaveLength(0);
  });

  it("BR-CO-10: a wrong line sum is fatal and reports the delta", () => {
    const err = validateInput({
      ...base,
      declaredTotals: { lineExtensionAmount: 1499.5 },
    }).errors.find((e) => e.rule === "BR-CO-10");
    expect(err).toBeDefined();
    expect(err!.message).toContain("1499.50");
    expect(err!.message).toContain("1500.00");
    expect(err!.message).toContain("-0.50");
  });

  it("BR-CO-14 / BR-CO-15: wrong VAT and gross totals are each reported", () => {
    const rules = rulesOf({
      ...base,
      declaredTotals: { taxAmount: 280, taxInclusiveAmount: 1780 },
    });
    expect(rules).toContain("BR-CO-14");
    expect(rules).toContain("BR-CO-15");
  });

  it("teaches the sum-of-rounded-values rule in the fix text", () => {
    const err = validateInput({
      ...base,
      declaredTotals: { lineExtensionAmount: 1 },
    }).errors.find((e) => e.rule === "BR-CO-10");
    expect(err!.fix).toMatch(/round each line to 2 decimals first/i);
  });
});

describe("electronic addresses", () => {
  it("PEPPOL-EN16931-R010/R020: missing endpoints are fatal on Peppol", () => {
    const result = validateInput({
      ...base,
      profile: "peppol-bis-3",
      seller: { ...base.seller, electronicAddress: undefined },
      buyer: { ...base.buyer, electronicAddress: undefined },
    });
    const rules = result.errors.map((e) => e.rule);
    expect(rules).toContain("PEPPOL-EN16931-R020");
    expect(rules).toContain("PEPPOL-EN16931-R010");
  });

  it("the same gap is a warning, not an error, on XRechnung", () => {
    const result = validateInput({
      ...base,
      seller: { ...base.seller, electronicAddress: undefined },
    });
    expect(result.errors.map((e) => e.rule)).not.toContain(
      "PEPPOL-EN16931-R020",
    );
    expect(result.warnings.map((e) => e.rule)).toContain(
      "PEPPOL-EN16931-R020",
    );
  });

  it("BR-62 / BR-63: an endpoint without a scheme identifier is always fatal", () => {
    const rules = rulesOf({
      ...base,
      seller: {
        ...base.seller,
        electronicAddress: { schemeId: "", value: "DE123456789" },
      },
      buyer: {
        ...base.buyer,
        electronicAddress: { schemeId: "", value: "DE987654321" },
      },
    });
    expect(rules).toContain("BR-62");
    expect(rules).toContain("BR-63");
  });
});

describe("XRechnung CIUS (BR-DE-*)", () => {
  it("BR-DE-1: payment instructions are mandatory", () => {
    const err = validateInput({ ...base, payment: undefined }).errors.find(
      (e) => e.rule === "BR-DE-1",
    );
    expect(err).toBeDefined();
    expect(err!.field).toBe("BG-16");
    expect(err!.fix).toMatch(/UNTDID 4461/);
  });

  it("BR-61: a credit transfer without an IBAN is fatal", () => {
    const rules = rulesOf({
      ...base,
      payment: { meansCode: "58" },
    });
    expect(rules).toContain("BR-61");
  });

  it("BR-61 does not fire for non-credit-transfer means", () => {
    const rules = rulesOf({ ...base, payment: { meansCode: "48" } });
    expect(rules).not.toContain("BR-61");
  });

  it("BR-DE-2: an entirely absent seller contact reports the group, once", () => {
    const result = validateInput({
      ...base,
      seller: { ...base.seller, contact: undefined },
    });
    const rules = result.errors.map((e) => e.rule);
    expect(rules).toContain("BR-DE-2");
    expect(rules).not.toContain("BR-DE-5");
  });

  it.each([
    ["name", "BR-DE-5"],
    ["phone", "BR-DE-6"],
    ["email", "BR-DE-7"],
  ] as const)(
    "a partial seller contact missing %s reports %s",
    (key, rule) => {
      const contact = { ...base.seller.contact! };
      delete contact[key];
      const rules = rulesOf({
        ...base,
        seller: { ...base.seller, contact },
      });
      expect(rules).toContain(rule);
      expect(rules).not.toContain("BR-DE-2");
    },
  );

  it.each([
    ["seller", "city", "BR-DE-3"],
    ["seller", "postalCode", "BR-DE-4"],
    ["buyer", "city", "BR-DE-8"],
    ["buyer", "postalCode", "BR-DE-9"],
  ] as const)("%s missing %s triggers %s", (party, key, rule) => {
    const target = party === "seller" ? base.seller : base.buyer;
    const rules = rulesOf({
      ...base,
      [party]: { ...target, address: { ...target.address, [key]: "" } },
    } as InvoiceInput);
    expect(rules).toContain(rule);
  });

  it("BR-DE-10 / BR-DE-11: a deliver-to address must be complete once present", () => {
    // Regression: the generator used to emit BG-15 with only a country code,
    // which core EN 16931 accepts and the KoSIT validator rejects.
    const result = validateInput({
      ...base,
      deliverTo: { countryCode: "FR" },
    });
    const rules = result.errors.map((e) => e.rule);
    expect(rules).toContain("BR-DE-10");
    expect(rules).toContain("BR-DE-11");
    expect(
      result.errors.find((e) => e.rule === "BR-DE-10")!.message,
    ).toMatch(/all-or-nothing/);
  });

  it("BR-DE-10 / BR-DE-11 stay silent for a complete deliver-to address", () => {
    const rules = rulesOf({
      ...base,
      deliverTo: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
    });
    expect(rules).not.toContain("BR-DE-10");
    expect(rules).not.toContain("BR-DE-11");
  });

  it("BR-DE-10 / BR-DE-11 do not apply when BG-15 is absent", () => {
    const rules = rulesOf({ ...base, deliveryDate: "2026-08-05" });
    expect(rules).not.toContain("BR-DE-10");
    expect(rules).not.toContain("BR-DE-11");
  });

  it("BR-DE-17: an invoice type code outside the German subset is a WARNING", () => {
    // Not fatal. KoSIT's XRechnung schematron flags BR-DE-17 `warning` — the
    // German text says "sollen", not "müssen" — and 0.2.x corrects an
    // over-rejection that shipped in 0.1.x. A document carrying BT-3 = 393 is
    // accepted by the official validator, so it must be accepted here too.
    const result = validateInput({ ...base, invoiceTypeCode: "393" });
    expect(result.errors.find((e) => e.rule === "BR-DE-17")).toBeUndefined();
    const warning = result.warnings.find((e) => e.rule === "BR-DE-17");
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe("warning");
    expect(warning!.message).toContain("393");
    // 393 is a valid UNTDID 1001 invoice code, so nothing else objects to it:
    // the document as a whole stays valid.
    expect(result.valid).toBe(true);
  });

  it("BR-DE-17 accepts the default 380 and the credit-note code 381", () => {
    expect(rulesOf(base)).not.toContain("BR-DE-17");
    // 381 is legal under BR-DE-17; it is refused separately, as a library
    // limitation, by ATW-CREDIT-NOTE-UNSUPPORTED.
    expect(rulesOf({ ...base, invoiceTypeCode: "381" })).not.toContain(
      "BR-DE-17",
    );
  });

  it("ATW-CREDIT-NOTE-UNSUPPORTED: a credit note is fatal and says why", () => {
    const result = validateInput({ ...base, invoiceTypeCode: "381" });
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) => e.rule === "ATW-CREDIT-NOTE-UNSUPPORTED",
    );
    expect(err).toBeDefined();
    expect(err!.field).toBe("BT-3");
    expect(err!.message).toContain("CreditNote");
    expect(err!.message).toContain("not yet supported");
    expect(err!.fix).toContain("384");
    // A library limitation, so it must not pretend to be a regulator rule page.
    expect(err!.docsUrl).not.toContain("attestwire.com/rules");
  });

  it("ATW-CREDIT-NOTE-UNSUPPORTED does not fire for ordinary invoices", () => {
    for (const code of [undefined, "380", "384", "326", "389"]) {
      expect(rulesOf({ ...base, invoiceTypeCode: code })).not.toContain(
        "ATW-CREDIT-NOTE-UNSUPPORTED",
      );
    }
  });

  it("BR-DE-27: a phone number with too few digits is a warning", () => {
    const result = validateInput({
      ...base,
      seller: {
        ...base.seller,
        contact: { ...base.seller.contact!, phone: "n/a" },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.map((e) => e.rule)).toContain("BR-DE-27");
  });

  it("BR-DE-28: a malformed email is a warning that names the value", () => {
    const result = validateInput({
      ...base,
      seller: {
        ...base.seller,
        contact: { ...base.seller.contact!, email: "buchhaltung(at)acme.de" },
      },
    });
    const warning = result.warnings.find((e) => e.rule === "BR-DE-28");
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("buchhaltung(at)acme.de");
  });

  it("BR-DE rules do not fire on the plain en16931 profile", () => {
    const rules = rulesOf({
      ...base,
      profile: "en16931",
      payment: undefined,
      seller: { ...base.seller, contact: undefined },
    });
    expect(rules.filter((r) => r.startsWith("BR-DE-"))).toHaveLength(0);
  });
});

describe("teaching-error quality invariants", () => {
  const scenarios: InvoiceInput[] = [
    { ...base, invoiceNumber: "", issueDate: "nope", currency: "X" },
    { ...base, lines: [] },
    { ...base, payment: undefined, seller: { ...base.seller, contact: undefined } },
    {
      ...base,
      seller: { ...base.seller, vatId: "123" },
      lines: [{ ...base.lines[0]!, vatCategory: "E", vatRate: 5 }],
    },
    {
      ...base,
      profile: "peppol-bis-3",
      seller: { ...base.seller, electronicAddress: undefined },
    },
    { ...base, declaredTotals: { taxAmount: 1 } },
  ];

  it("every emitted error carries a rule, field, message, fix and docsUrl", () => {
    let seen = 0;
    for (const scenario of scenarios) {
      const result = validateInput(scenario);
      for (const e of [...result.errors, ...result.warnings]) {
        seen += 1;
        expect(e.rule, "rule").toBeTruthy();
        expect(e.field, `field for ${e.rule}`).toBeTruthy();
        // `ATW-` ids are library limitations rather than regulation rules, and
        // are documented in the README instead of on a per-rule page.
        expect(e.docsUrl).toBe(
          e.rule.startsWith("ATW-")
            ? "https://github.com/attestwire/en16931#not-implemented-yet"
            : `https://attestwire.com/rules/${e.rule}`,
        );
        // A message that teaches is a sentence, not a label.
        expect(e.message.length, `message for ${e.rule}`).toBeGreaterThan(60);
        expect(e.fix.length, `fix for ${e.rule}`).toBeGreaterThan(20);
        expect(e.message.trim().endsWith("."), `message for ${e.rule}`).toBe(
          true,
        );
      }
    }
    expect(seen).toBeGreaterThan(10);
  });

  it("never emits the same rule twice for the same cause", () => {
    const result = validateInput({
      ...base,
      payment: undefined,
      seller: { ...base.seller, contact: undefined },
    });
    const rules = result.errors.map((e) => e.rule);
    expect(new Set(rules).size).toBe(rules.length);
  });
});
