import { describe, expect, it } from "vitest";
import { isValidIban } from "./rules-de.js";
import { validateInput as validateInputOf } from "./index.js";
import {
  allIds,
  clean,
  cleanLine,
  errorIds,
  findingFor,
  warningIds,
  withInvoice,
} from "./testkit.js";

const outOfScope = (overrides = {}) =>
  withInvoice({
    seller: { ...clean.seller, vatId: undefined, taxRegistrationId: "18/181/08155" },
    buyer: { ...clean.buyer, vatId: undefined },
    lines: [cleanLine({ vatCategory: "O", vatRate: undefined })],
    ...overrides,
  });

describe("BR-DE-14 VAT category rate on every breakdown", () => {
  it("fires for category O under XRechnung, where BR-48's exception is withdrawn", () => {
    const inv = outOfScope();
    expect(errorIds(inv)).toContain("BR-DE-14");
    const finding = findingFor(inv, "BR-DE-14")!;
    expect(finding.field).toBe("BT-119");
    expect(finding.message).toContain("BR-48");
    expect(finding.fix).toContain('"Z"');
  });

  it("does not fire under core EN 16931 or Peppol, where BR-48 grants the exception", () => {
    for (const profile of ["en16931", "peppol-bis-3"] as const) {
      expect(allIds(outOfScope({ profile }))).not.toContain("BR-DE-14");
    }
  });

  it("does not fire for any category that carries a rate", () => {
    for (const category of ["S", "Z", "E", "AE", "K", "G"] as const) {
      const inv = withInvoice({
        lines: [cleanLine({ vatCategory: category, vatRate: category === "S" ? 19 : 0 })],
      });
      expect(allIds(inv)).not.toContain("BR-DE-14");
    }
  });

  // The rule is a presence check on cbc:Percent, so a document that states the
  // element satisfies it — even for category O, where our own computed
  // breakdown never carries a rate because BR-O-05 forbids one on the line.
  // Found by the benchmark, 2026-08-16:
  // kosit-testsuite/standard/01.04a-INVOICE_ubl.xml states
  // <cbc:Percent>0</cbc:Percent> on its category-O group, KoSIT accepts it, and
  // we rejected it. Four cells, in both syntaxes.
  it("does not fire when the document states BT-119 on a category-O group", () => {
    const inv = outOfScope({
      declaredTotals: {
        subtotals: [{ category: "O" as const, rate: 0, taxableAmount: 1500, taxAmount: 0 }],
      },
    });
    expect(allIds(inv)).not.toContain("BR-DE-14");
  });

  it("still fires when the document states a breakdown group with no BT-119", () => {
    const inv = outOfScope({
      declaredTotals: {
        subtotals: [{ category: "O" as const, taxableAmount: 1500, taxAmount: 0 }],
      },
    });
    expect(errorIds(inv)).toContain("BR-DE-14");
  });
});

describe("BR-DE-18 Skonto grammar in BT-20", () => {
  const terms = (paymentTerms: string) => withInvoice({ paymentTerms });

  it("ignores payment terms that make no Skonto claim", () => {
    expect(allIds(terms("Zahlbar innerhalb von 30 Tagen ohne Abzug."))).toEqual([]);
    expect(allIds(withInvoice({ paymentTerms: undefined }))).toEqual([]);
  });

  it("accepts a well-formed entry", () => {
    expect(allIds(terms("#SKONTO#TAGE=14#PROZENT=2.00#\n"))).toEqual([]);
  });

  it("accepts the optional BASISBETRAG segment", () => {
    expect(
      allIds(terms("#SKONTO#TAGE=14#PROZENT=2.00#BASISBETRAG=1000.00#\n")),
    ).toEqual([]);
  });

  it("accepts several entries, and free text above them", () => {
    expect(
      allIds(
        terms(
          "Zahlbar in 30 Tagen.\n#SKONTO#TAGE=14#PROZENT=2.00#\n#SKONTO#TAGE=7#PROZENT=3.00#\n",
        ),
      ),
    ).toEqual([]);
  });

  const bad: [string, string][] = [
    ["one decimal on the percentage", "#SKONTO#TAGE=14#PROZENT=2.0#\n"],
    ["no decimals on the percentage", "#SKONTO#TAGE=14#PROZENT=2#\n"],
    ["a comma decimal separator", "#SKONTO#TAGE=14#PROZENT=2,00#\n"],
    ["a signed percentage", "#SKONTO#TAGE=14#PROZENT=-2.00#\n"],
    ["lower case", "#skonto#TAGE=14#PROZENT=2.00#\n"],
    ["internal whitespace", "#SKONTO# TAGE=14#PROZENT=2.00#\n"],
    ["a missing terminating hash", "#SKONTO#TAGE=14#PROZENT=2.00\n"],
    ["segments in the wrong order", "#SKONTO#PROZENT=2.00#TAGE=14#\n"],
    ["a non-numeric day count", "#SKONTO#TAGE=zwei#PROZENT=2.00#\n"],
  ];

  for (const [why, value] of bad) {
    it(`rejects ${why}`, () => {
      expect(allIds(terms(value))).toContain("BR-DE-18");
    });
  }

  it("rejects a well-formed entry that is not newline-terminated", () => {
    const inv = terms("#SKONTO#TAGE=14#PROZENT=2.00#");
    expect(allIds(inv)).toContain("BR-DE-18");
    expect(findingFor(inv, "BR-DE-18")!.message).toContain("line break");
  });

  it("does not apply outside XRechnung", () => {
    expect(
      allIds(
        withInvoice({ profile: "en16931", paymentTerms: "#SKONTO#TAGE=14#PROZENT=2#" }),
      ),
    ).not.toContain("BR-DE-18");
  });

  it("reports each malformed entry separately", () => {
    const inv = terms("#SKONTO#TAGE=14#PROZENT=2#\n#SKONTO#TAGE=7#PROZENT=3#\n");
    expect(allIds(inv).filter((r) => r === "BR-DE-18")).toHaveLength(2);
  });
});

describe("isValidIban", () => {
  it("accepts the German documentation test IBAN", () => {
    expect(isValidIban("DE02120300000000202051")).toBe(true);
  });

  it("accepts other countries, including a 34-character one", () => {
    expect(isValidIban("NL91ABNA0417164300")).toBe(true);
    expect(isValidIban("GB29NWBK60161331926819")).toBe(true);
    // Maximum length: the checksum must survive numbers far past 2^53.
    expect(isValidIban("MT84MALT011000012345MTLCAST001S")).toBe(true);
  });

  it("tolerates the spaces a printed IBAN carries", () => {
    expect(isValidIban("DE02 1203 0000 0000 2020 51")).toBe(true);
  });

  it("rejects a single-digit transposition", () => {
    expect(isValidIban("DE02120300000000202052")).toBe(false);
  });

  it("rejects the wrong shape", () => {
    expect(isValidIban("120300000000202051")).toBe(false);
    expect(isValidIban("DEXX120300000000202051")).toBe(false);
    expect(isValidIban("")).toBe(false);
    expect(isValidIban("DE02-1203-0000")).toBe(false);
  });
});

describe("BR-DE-19 IBAN on a SEPA credit transfer", () => {
  it("stays silent on a valid IBAN", () => {
    expect(allIds(clean)).not.toContain("BR-DE-19");
  });

  it("warns — never errors — on a bad checksum", () => {
    const inv = withInvoice({
      payment: { meansCode: "58", iban: "DE02120300000000202052" },
    });
    expect(warningIds(inv)).toContain("BR-DE-19");
    expect(errorIds(inv)).not.toContain("BR-DE-19");
    expect(findingFor(inv, "BR-DE-19")!.message).toContain("MOD-97-10");
  });

  it("explains the shape when the value is not IBAN-shaped at all", () => {
    const inv = withInvoice({ payment: { meansCode: "58", iban: "1203 0000 2020 51" } });
    expect(findingFor(inv, "BR-DE-19")!.message).toContain("two letters for the country");
  });

  it("only applies to code 58, not to a plain credit transfer", () => {
    expect(
      allIds(withInvoice({ payment: { meansCode: "30", iban: "NOTANIBAN12" } })),
    ).not.toContain("BR-DE-19");
  });

  it("leaves an absent account identifier to BR-61 / BR-DE-23-a", () => {
    const ids = allIds(withInvoice({ payment: { meansCode: "58" } }));
    expect(ids).toContain("BR-61");
    expect(ids).toContain("BR-DE-23-a");
    expect(ids).not.toContain("BR-DE-19");
  });
});

describe("BR-DE-23-a / 24-a / 25-a: means code and payment group must agree", () => {
  it("BR-DE-23-a fires when a credit-transfer code has no account", () => {
    for (const code of ["30", "58"]) {
      const inv = withInvoice({ payment: { meansCode: code } });
      expect(errorIds(inv)).toContain("BR-DE-23-a");
    }
  });

  it("BR-DE-23-a is satisfied by an IBAN", () => {
    expect(allIds(clean)).not.toContain("BR-DE-23-a");
  });

  it("BR-DE-24-a refuses a card code, because BG-18 is not modelled", () => {
    for (const code of ["48", "54", "55"]) {
      const inv = withInvoice({ payment: { meansCode: code } });
      expect(errorIds(inv)).toContain("BR-DE-24-a");
      expect(findingFor(inv, "BR-DE-24-a")!.message).toContain("BR-51");
    }
  });

  it("BR-DE-25-a refuses a direct-debit code, because BG-19 is not modelled", () => {
    const inv = withInvoice({ payment: { meansCode: "59" } });
    expect(errorIds(inv)).toContain("BR-DE-25-a");
    expect(findingFor(inv, "BR-DE-25-a")!.message).toContain("BR-DE-30");
  });

  it("says nothing for a code with no mandatory group, such as 97", () => {
    const ids = allIds(withInvoice({ payment: { meansCode: "97" } }));
    for (const rule of ["BR-DE-23-a", "BR-DE-24-a", "BR-DE-25-a"]) {
      expect(ids).not.toContain(rule);
    }
  });

  it("does not apply outside XRechnung", () => {
    expect(
      allIds(withInvoice({ profile: "en16931", payment: { meansCode: "48" } })),
    ).not.toContain("BR-DE-24-a");
  });
});

describe("BR-DE-26 preceding invoice reference on a correction", () => {
  it("warns for type code 384", () => {
    const inv = withInvoice({ invoiceTypeCode: "384" });
    expect(warningIds(inv)).toContain("BR-DE-26");
    expect(errorIds(inv)).not.toContain("BR-DE-26");
  });

  it("says nothing for an ordinary invoice", () => {
    expect(allIds(withInvoice({ invoiceTypeCode: "380" }))).not.toContain("BR-DE-26");
  });

  it("does not apply outside XRechnung", () => {
    expect(
      allIds(withInvoice({ profile: "en16931", invoiceTypeCode: "384" })),
    ).not.toContain("BR-DE-26");
  });
});

// ---------------------------------------------------------------------------
// Wave B: the payment-group exclusivity halves, BG-19's own requirements,
// attachment filenames, and the advisory time-of-supply rule.
// ---------------------------------------------------------------------------

describe("BR-DE-23-b / BR-DE-24-b / BR-DE-25-b: one payment group, not two", () => {
  it("a credit transfer must not also carry a card group", () => {
    const inv = withInvoice({
      payment: {
        meansCode: "58",
        iban: "DE02120300000000202051",
        card: { primaryAccountNumber: "411111**1111" },
      },
    });
    expect(errorIds(inv)).toContain("BR-DE-23-b");
    const finding = findingFor(inv, "BR-DE-23-b")!;
    expect(finding.message).toContain("BG-18");
    expect(finding.fix).toContain("payment.card");
  });

  it("a credit transfer must not also carry a direct debit mandate", () => {
    const inv = withInvoice({
      payment: {
        meansCode: "58",
        iban: "DE02120300000000202051",
        directDebit: { mandateReference: "M-1", debitedAccount: "DE98700500001234567890" },
      },
    });
    expect(errorIds(inv)).toContain("BR-DE-23-b");
    expect(findingFor(inv, "BR-DE-23-b")!.message).toContain("BG-19");
  });

  it("names both offending groups when both are present", () => {
    const inv = withInvoice({
      payment: {
        meansCode: "58",
        iban: "DE02120300000000202051",
        card: { primaryAccountNumber: "411111**1111" },
        directDebit: { mandateReference: "M-1", debitedAccount: "DE98700500001234567890" },
      },
    });
    const finding = findingFor(inv, "BR-DE-23-b")!;
    expect(finding.message).toContain("BG-18");
    expect(finding.message).toContain("BG-19");
  });

  it("stays silent for a credit transfer that carries only BG-17", () => {
    expect(allIds(clean)).not.toContain("BR-DE-23-b");
  });

  it("a card payment must carry BG-18 and nothing else", () => {
    const missing = withInvoice({ payment: { meansCode: "48" } });
    expect(errorIds(missing)).toContain("BR-DE-24-a");

    const ok = withInvoice({
      payment: { meansCode: "48", card: { primaryAccountNumber: "411111**1111" } },
    });
    expect(errorIds(ok)).not.toContain("BR-DE-24-a");
    expect(errorIds(ok)).not.toContain("BR-DE-24-b");

    const both = withInvoice({
      payment: {
        meansCode: "48",
        card: { primaryAccountNumber: "411111**1111" },
        iban: "DE02120300000000202051",
      },
    });
    expect(errorIds(both)).toContain("BR-DE-24-b");
  });

  it("a direct debit must carry BG-19 and nothing else", () => {
    const missing = withInvoice({ payment: { meansCode: "59" } });
    expect(errorIds(missing)).toContain("BR-DE-25-a");

    const ok = withInvoice({
      payment: {
        meansCode: "59",
        directDebit: {
          mandateReference: "MANDAT-2026-01",
          creditorIdentifier: "DE98ZZZ09999999999",
          debitedAccount: "DE98700500001234567890",
        },
      },
    });
    expect(errorIds(ok)).not.toContain("BR-DE-25-a");
    expect(errorIds(ok)).not.toContain("BR-DE-25-b");

    const both = withInvoice({
      payment: {
        meansCode: "59",
        iban: "DE02120300000000202051",
        directDebit: {
          mandateReference: "MANDAT-2026-01",
          creditorIdentifier: "DE98ZZZ09999999999",
          debitedAccount: "DE98700500001234567890",
        },
      },
    });
    expect(errorIds(both)).toContain("BR-DE-25-b");
  });

  it("BR-DE-24-a is no longer a refusal: the model can now express BG-18", () => {
    // 0.1.x reported this as "this library cannot emit the group". It can.
    const ok = withInvoice({
      payment: { meansCode: "48", card: { primaryAccountNumber: "411111**1111" } },
    });
    expect(validateInputOf(ok).valid).toBe(true);
  });
});

describe("BR-DE-30 / BR-DE-31: BG-19 is mandatory in its parts", () => {
  const debit = (patch: Record<string, unknown>) =>
    withInvoice({
      payment: {
        meansCode: "59",
        directDebit: {
          mandateReference: "MANDAT-2026-01",
          creditorIdentifier: "DE98ZZZ09999999999",
          debitedAccount: "DE98700500001234567890",
          ...patch,
        },
      },
    });

  it("requires the bank assigned creditor identifier (BT-90)", () => {
    const inv = debit({ creditorIdentifier: undefined });
    expect(errorIds(inv)).toContain("BR-DE-30");
    const finding = findingFor(inv, "BR-DE-30")!;
    // The identifier does not live in the payment group in UBL, and the message
    // has to say so or the reader looks in the wrong place.
    expect(finding.xpath).toContain("AccountingSupplierParty");
  });

  it("requires the debited account identifier (BT-91)", () => {
    const inv = debit({ debitedAccount: undefined });
    expect(errorIds(inv)).toContain("BR-DE-31");
  });

  it("stays silent for a complete direct debit group", () => {
    expect(errorIds(debit({}))).not.toContain("BR-DE-30");
    expect(errorIds(debit({}))).not.toContain("BR-DE-31");
  });

  it("does not fire at all when there is no direct debit", () => {
    expect(allIds(clean)).not.toContain("BR-DE-30");
    expect(allIds(clean)).not.toContain("BR-DE-31");
  });
});

describe("BR-DE-20: the debited account should be a real IBAN", () => {
  const debit = (debitedAccount: string) =>
    withInvoice({
      payment: {
        meansCode: "59",
        directDebit: {
          mandateReference: "M-1",
          creditorIdentifier: "DE98ZZZ09999999999",
          debitedAccount,
        },
      },
    });

  it("is a warning, not an error — KoSIT flags it so", () => {
    const inv = debit("DE98700500001234567891");
    expect(errorIds(inv)).not.toContain("BR-DE-20");
    expect(warningIds(inv)).toContain("BR-DE-20");
    expect(findingFor(inv, "BR-DE-20")!.severity).toBe("warning");
  });

  it("accepts a correct IBAN", () => {
    expect(allIds(debit("DE98700500001234567890"))).not.toContain("BR-DE-20");
  });

  it("distinguishes a bad checksum from a bad shape", () => {
    expect(findingFor(debit("DE98700500001234567891"), "BR-DE-20")!.message).toContain(
      "MOD-97-10",
    );
    expect(findingFor(debit("not-an-iban"), "BR-DE-20")!.message).toContain("shape");
  });
});

describe("BR-DE-22: attachment filenames must be unique", () => {
  const withDocs = (filenames: string[]) =>
    withInvoice({
      supportingDocuments: filenames.map((filename, index) => ({
        reference: `REF-${index}`,
        attachment: { filename, mimeCode: "application/pdf", content: "AA==" },
      })),
    });

  it("fires when two embedded attachments share a filename", () => {
    const inv = withDocs(["a.pdf", "a.pdf"]);
    expect(errorIds(inv)).toContain("BR-DE-22");
    expect(findingFor(inv, "BR-DE-22")!.message).toContain("a.pdf");
  });

  it("accepts distinct filenames", () => {
    expect(allIds(withDocs(["a.pdf", "b.pdf"]))).not.toContain("BR-DE-22");
  });

  it("does not fire on a single attachment", () => {
    expect(allIds(withDocs(["a.pdf"]))).not.toContain("BR-DE-22");
  });

  it("ignores documents that carry only an external reference", () => {
    const inv = withInvoice({
      supportingDocuments: [
        { reference: "A", externalUri: "https://example.test/a.pdf" },
        { reference: "B", externalUri: "https://example.test/b.pdf" },
      ],
    });
    expect(allIds(inv)).not.toContain("BR-DE-22");
  });
});

describe("BR-DE-TMP-32: an invoice should say when the supply happened", () => {
  it("is reported at severity information, not warning", () => {
    const inv = withInvoice({ deliveryDate: undefined });
    const result = validateInputOf(inv);
    expect(result.errors.map((e) => e.rule)).not.toContain("BR-DE-TMP-32");
    expect(result.warnings.map((e) => e.rule)).not.toContain("BR-DE-TMP-32");
    expect(result.information.map((e) => e.rule)).toContain("BR-DE-TMP-32");
    expect(result.valid).toBe(true);
  });

  it("is satisfied by a delivery date", () => {
    expect(validateInputOf(clean).information).toEqual([]);
  });

  it("is satisfied by an invoicing period", () => {
    const inv = withInvoice({
      deliveryDate: undefined,
      invoicingPeriod: { startDate: "2026-07-01", endDate: "2026-07-31" },
    });
    expect(validateInputOf(inv).information).toEqual([]);
  });

  it("is satisfied by a period on every line, and not by a period on some", () => {
    const period = { startDate: "2026-07-01", endDate: "2026-07-31" };
    const all = withInvoice({
      deliveryDate: undefined,
      lines: [cleanLine({ period }), cleanLine({ id: "2", period })],
    });
    expect(validateInputOf(all).information).toEqual([]);

    const some = withInvoice({
      deliveryDate: undefined,
      lines: [cleanLine({ period }), cleanLine({ id: "2" })],
    });
    expect(validateInputOf(some).information.map((e) => e.rule)).toContain(
      "BR-DE-TMP-32",
    );
  });

  it("names the German statute, because that is what actually bites", () => {
    const inv = withInvoice({ deliveryDate: undefined });
    const finding = validateInputOf(inv).information.find(
      (e) => e.rule === "BR-DE-TMP-32",
    )!;
    expect(finding.message).toContain("UStG");
    expect(finding.fix.length).toBeGreaterThan(20);
  });

  it("does not apply outside XRechnung", () => {
    const inv = withInvoice({ profile: "en16931", deliveryDate: undefined });
    expect(validateInputOf(inv).information).toEqual([]);
  });
});

describe("BR-DE-26 now that BG-3 is in the model", () => {
  it("is satisfied by a preceding invoice reference", () => {
    const inv = withInvoice({
      invoiceTypeCode: "384",
      precedingInvoices: [{ invoiceNumber: "2026-000141", issueDate: "2026-07-31" }],
    });
    expect(allIds(inv)).not.toContain("BR-DE-26");
  });

  it("still warns when a corrected invoice references nothing", () => {
    const inv = withInvoice({ invoiceTypeCode: "384" });
    expect(warningIds(inv)).toContain("BR-DE-26");
    // The fix must name the field that now exists, not a workaround.
    expect(findingFor(inv, "BR-DE-26")!.fix).toContain("precedingInvoices");
  });

  // Corrected in 0.2.0. KoSIT's BR-DE-26 test is
  // `cac:BillingReference/cac:InvoiceDocumentReference` — the presence of the
  // element, not the content of BT-25 inside it. Our generator writes that
  // element for every entry in `precedingInvoices`, so demanding a non-blank
  // invoiceNumber here raised a warning against a document KoSIT accepts, and
  // raised it under the wrong id: the blank number is BR-55's business, and
  // BR-55 is fatal, so nothing is let through by the correction.
  it("is satisfied by the reference group alone, as KoSIT's test is", () => {
    const inv = withInvoice({
      invoiceTypeCode: "384",
      precedingInvoices: [{ invoiceNumber: "  " }],
    });
    expect(warningIds(inv)).not.toContain("BR-DE-26");
  });

  it("leaves the blank invoice number to BR-55, which is fatal", () => {
    const inv = withInvoice({
      invoiceTypeCode: "384",
      precedingInvoices: [{ invoiceNumber: "  " }],
    });
    expect(errorIds(inv)).toContain("BR-55");
  });
});
