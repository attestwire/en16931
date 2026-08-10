import { describe, expect, it } from "vitest";
import { validateInput } from "./index.js";
import { allIds, clean, cleanLine, errorIds, findingFor, warningIds, withInvoice } from "./testkit.js";
import type { InvoiceInput, Party } from "./types.js";

/**
 * Peppol BIS Billing 3.0 — `PEPPOL-EN16931-*` and `PEPPOL-COMMON-*`.
 *
 * Every test in this file comes in a pair, and the second half of the pair is
 * the one that matters. It is easy to write a rule that fires; the failure mode
 * that costs users money is a rule that fires on the *wrong profile*, because
 * the caller then "corrects" a document that was already right for its target
 * and breaks it. So each rule is asserted to fire on `peppol-bis-3` and to stay
 * silent on `xrechnung-ubl` given identical data.
 */

const peppol = (overrides: Partial<InvoiceInput> = {}): InvoiceInput =>
  withInvoice({ profile: "peppol-bis-3", ...overrides });

const xrechnung = (overrides: Partial<InvoiceInput> = {}): InvoiceInput =>
  withInvoice({ profile: "xrechnung-ubl", ...overrides });

/** Assert `rule` fires on Peppol and not on XRechnung for the same payload. */
const gatedFatal = (rule: string, overrides: Partial<InvoiceInput>) => {
  expect(errorIds(peppol(overrides)), `${rule} on peppol`).toContain(rule);
  expect(allIds(xrechnung(overrides)), `${rule} on xrechnung`).not.toContain(rule);
};

const withElectronicAddress = (
  schemeId: string,
  value: string,
): Partial<InvoiceInput> => ({
  seller: { ...clean.seller, electronicAddress: { schemeId, value } } as Party,
});

const withPartyIdentifier = (
  schemeId: string,
  value: string,
): Partial<InvoiceInput> => ({
  seller: { ...clean.seller, identifier: { schemeId, value } } as Party,
});

describe("Peppol profile gating", () => {
  it("a clean Peppol invoice produces no findings at all", () => {
    const result = validateInput(peppol());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("no PEPPOL- rule fires on any non-Peppol profile", () => {
    // The same deliberately broken payload, run through every other profile.
    const broken: Partial<InvoiceInput> = {
      buyerReference: undefined,
      orderReference: undefined,
      vatAccountingCurrency: "EUR",
      taxAmountInAccountingCurrency: 10,
      allowances: [{ amount: 10, percentage: 5, vatCategory: "S", vatRate: 19 }],
      lines: [cleanLine({ baseQuantity: 0 })],
    };
    for (const profile of ["en16931", "xrechnung-ubl", "xrechnung-cii", "facturx-en16931"] as const) {
      const ids = allIds(withInvoice({ profile, ...broken }));
      expect(ids.filter((id) => id.startsWith("PEPPOL-")), profile).toEqual([]);
    }
  });

  it("fires the Peppol family on the same payload", () => {
    const ids = allIds(
      peppol({
        buyerReference: undefined,
        orderReference: undefined,
        vatAccountingCurrency: "EUR",
        taxAmountInAccountingCurrency: 10,
        allowances: [{ amount: 10, percentage: 5, vatCategory: "S", vatRate: 19 }],
      }),
    );
    expect(ids).toContain("PEPPOL-EN16931-R003");
    expect(ids).toContain("PEPPOL-EN16931-R005");
    expect(ids).toContain("PEPPOL-EN16931-R041");
  });
});

describe("PEPPOL-EN16931-R003 — buyer reference or order reference", () => {
  it("fires when both are absent, and only on Peppol", () => {
    gatedFatal("PEPPOL-EN16931-R003", {
      buyerReference: undefined,
      orderReference: undefined,
    });
  });

  it("is satisfied by a buyer reference alone", () => {
    expect(errorIds(peppol({ orderReference: undefined }))).not.toContain(
      "PEPPOL-EN16931-R003",
    );
  });

  it("is satisfied by an order reference alone", () => {
    const ids = errorIds(
      peppol({ buyerReference: undefined, orderReference: "PO-2026-88" }),
    );
    expect(ids).not.toContain("PEPPOL-EN16931-R003");
  });

  it("treats whitespace as absent", () => {
    expect(
      errorIds(peppol({ buyerReference: "   ", orderReference: "  " })),
    ).toContain("PEPPOL-EN16931-R003");
  });

  it("teaches why the network needs one", () => {
    const finding = findingFor(
      peppol({ buyerReference: undefined, orderReference: undefined }),
      "PEPPOL-EN16931-R003",
    )!;
    expect(finding.message).toMatch(/accounts payable/i);
    expect(finding.fix).toMatch(/orderReference/);
    expect(finding.message).toMatch(/peppol-bis-3/);
  });
});

describe("PEPPOL-EN16931-R005 — the accounting currency must differ", () => {
  it("fires when BT-6 equals BT-5", () => {
    gatedFatal("PEPPOL-EN16931-R005", {
      vatAccountingCurrency: "EUR",
      taxAmountInAccountingCurrency: 285,
    });
  });

  it("is case-insensitive about the comparison", () => {
    expect(
      errorIds(
        peppol({ vatAccountingCurrency: "eur", taxAmountInAccountingCurrency: 285 }),
      ),
    ).toContain("PEPPOL-EN16931-R005");
  });

  it("stays silent when the two genuinely differ", () => {
    expect(
      errorIds(
        peppol({ vatAccountingCurrency: "SEK", taxAmountInAccountingCurrency: 3200 }),
      ),
    ).not.toContain("PEPPOL-EN16931-R005");
  });

  it("stays silent when BT-6 is absent", () => {
    expect(errorIds(peppol())).not.toContain("PEPPOL-EN16931-R005");
  });
});

describe("PEPPOL-EN16931-CL007 — Peppol's own currency list", () => {
  it("accepts a currency both lists carry", () => {
    expect(errorIds(peppol({ currency: "NOK" }))).not.toContain(
      "PEPPOL-EN16931-CL007",
    );
  });

  it("rejects a currency Peppol has not yet adopted, even though BR-CL-04 accepts it", () => {
    // XCG (Caribbean guilder) is in the CEN list and not in Peppol's. This is
    // the whole reason the two lists ship separately.
    const ids = errorIds(peppol({ currency: "XCG" }));
    expect(ids).toContain("PEPPOL-EN16931-CL007");
    expect(ids).not.toContain("BR-CL-04");
  });

  it("accepts a currency Peppol still carries and the CEN list has retired", () => {
    const ids = errorIds(peppol({ currency: "BGN" }));
    expect(ids).not.toContain("PEPPOL-EN16931-CL007");
    expect(ids).toContain("BR-CL-04");
  });

  it("checks the VAT accounting currency too", () => {
    const finding = findingFor(
      peppol({ vatAccountingCurrency: "XCG", taxAmountInAccountingCurrency: 10 }),
      "PEPPOL-EN16931-CL007",
    )!;
    expect(finding.field).toBe("BT-6");
  });

  it("does not fire on the xrechnung profile", () => {
    expect(allIds(xrechnung({ currency: "XCG" }))).not.toContain(
      "PEPPOL-EN16931-CL007",
    );
  });
});

describe("PEPPOL-EN16931-CL008 — the endpoint scheme must be routable", () => {
  it("accepts a scheme on the Peppol list", () => {
    expect(
      errorIds(peppol(withElectronicAddress("0088", "7300010000001"))),
    ).not.toContain("PEPPOL-EN16931-CL008");
  });

  it("rejects a CEF scheme Peppol does not route on", () => {
    // "EM" (email) is in the CEF EAS register and not in Peppol's participant
    // list — an access point routes on a participant identifier, not a mailbox.
    const ids = errorIds(peppol(withElectronicAddress("EM", "billing@acme.example")));
    expect(ids).toContain("PEPPOL-EN16931-CL008");
    expect(ids).not.toContain("BR-CL-25");
  });

  it("does not apply to a party identifier, only to the endpoint", () => {
    expect(
      errorIds(peppol(withPartyIdentifier("EM", "billing@acme.example"))),
    ).not.toContain("PEPPOL-EN16931-CL008");
  });

  it("does not fire on the xrechnung profile", () => {
    expect(allIds(xrechnung(withElectronicAddress("EM", "billing@acme.example")))).not.toContain(
      "PEPPOL-EN16931-CL008",
    );
  });
});

describe("PEPPOL-COMMON-R040..R053 — national identifier formats", () => {
  const cases: [string, string, string, string, boolean][] = [
    // rule, scheme, good value, bad value, fatal?
    ["PEPPOL-COMMON-R040", "0088", "7300010000001", "7300010000002", true],
    ["PEPPOL-COMMON-R041", "0192", "991825827", "991825828", true],
    ["PEPPOL-COMMON-R042", "0184", "DK12345678", "DK1234567", true],
    ["PEPPOL-COMMON-R043", "0208", "0848934496", "0848934497", true],
    ["PEPPOL-COMMON-R044", "0201", "UF9DHV", "UF9DH", false],
    ["PEPPOL-COMMON-R045", "0210", "01234567890", "0123456789", false],
    ["PEPPOL-COMMON-R046", "9907", "01234567890", "0123456789", false],
    ["PEPPOL-COMMON-R047", "0211", "IT01234567897", "IT01234567890", false],
    ["PEPPOL-COMMON-R048", "9906", "IT01234567897", "IT01234567890", false],
    ["PEPPOL-COMMON-R049", "0007", "2021005489", "2021005488", true],
    ["PEPPOL-COMMON-R050", "0151", "51824753556", "51824753557", true],
    ["PEPPOL-COMMON-R052", "0096", "1234567890", "123456789", false],
    ["PEPPOL-COMMON-R053", "0198", "DK12345678", "12345678", false],
  ];

  for (const [rule, scheme, good, bad, fatal] of cases) {
    it(`${rule} accepts a well-formed value in scheme ${scheme}`, () => {
      expect(allIds(peppol(withElectronicAddress(scheme, good)))).not.toContain(rule);
    });

    it(`${rule} rejects a malformed value in scheme ${scheme}`, () => {
      const ids = fatal
        ? errorIds(peppol(withElectronicAddress(scheme, bad)))
        : warningIds(peppol(withElectronicAddress(scheme, bad)));
      expect(ids).toContain(rule);
    });

    it(`${rule} does not fire on the xrechnung profile`, () => {
      expect(allIds(xrechnung(withElectronicAddress(scheme, bad)))).not.toContain(rule);
    });
  }

  it("checks a party identifier as well as an endpoint", () => {
    expect(errorIds(peppol(withPartyIdentifier("0088", "7300010000002")))).toContain(
      "PEPPOL-COMMON-R040",
    );
  });

  it("checks a legal registration identifier", () => {
    const ids = errorIds(
      peppol({
        seller: {
          ...clean.seller,
          legalRegistrationId: "991825828",
          legalRegistrationSchemeId: "0192",
        } as Party,
      }),
    );
    expect(ids).toContain("PEPPOL-COMMON-R041");
  });

  it("checks the payee's identifiers too", () => {
    const ids = errorIds(
      peppol({
        payee: { name: "Factor AB", identifier: { schemeId: "0007", value: "2021005488" } },
      }),
    );
    expect(ids).toContain("PEPPOL-COMMON-R049");
  });

  it("applies the endpoint-only schemes to endpoints only", () => {
    // 9906 and 9907 are routing schemes; a party identifier in them is out of
    // context in the schematron and must stay out of context here.
    expect(allIds(peppol(withPartyIdentifier("9906", "IT01234567890")))).not.toContain(
      "PEPPOL-COMMON-R048",
    );
  });

  it("leaves a non-IT Partita IVA untested, as the schematron does", () => {
    expect(allIds(peppol(withElectronicAddress("0211", "FR99999999999")))).not.toContain(
      "PEPPOL-COMMON-R047",
    );
  });

  it("accepts the bare eight-digit Danish CVR as well as the prefixed form", () => {
    expect(allIds(peppol(withElectronicAddress("0184", "12345678")))).not.toContain(
      "PEPPOL-COMMON-R042",
    );
  });

  it("accepts a sixteen-character Codice Fiscale", () => {
    expect(allIds(peppol(withElectronicAddress("9907", "RSSMRA85T10A562S")))).not.toContain(
      "PEPPOL-COMMON-R046",
    );
  });

  it("keeps the schematron's severities rather than levelling them", () => {
    expect(warningIds(peppol(withElectronicAddress("0201", "TOOLONG")))).toContain(
      "PEPPOL-COMMON-R044",
    );
    expect(errorIds(peppol(withElectronicAddress("0201", "TOOLONG")))).not.toContain(
      "PEPPOL-COMMON-R044",
    );
  });

  it("ignores a scheme it has no rule for", () => {
    const ids = allIds(peppol(withElectronicAddress("9930", "DE123456789")));
    expect(ids.filter((id) => id.startsWith("PEPPOL-COMMON-"))).toEqual([]);
  });
});

describe("PEPPOL-EN16931-R041 / R042 — percentage and base travel together", () => {
  it("R041 fires for a percentage with no base", () => {
    gatedFatal("PEPPOL-EN16931-R041", {
      allowances: [{ amount: 50, percentage: 5, vatCategory: "S", vatRate: 19 }],
    });
  });

  it("R042 fires for a base with no percentage", () => {
    gatedFatal("PEPPOL-EN16931-R042", {
      allowances: [{ amount: 50, baseAmount: 1000, vatCategory: "S", vatRate: 19 }],
    });
  });

  it("stays silent when both are present", () => {
    const ids = allIds(
      peppol({
        allowances: [
          { amount: 50, baseAmount: 1000, percentage: 5, vatCategory: "S", vatRate: 19 },
        ],
      }),
    );
    expect(ids).not.toContain("PEPPOL-EN16931-R041");
    expect(ids).not.toContain("PEPPOL-EN16931-R042");
  });

  it("stays silent when neither is present", () => {
    const ids = allIds(
      peppol({ allowances: [{ amount: 50, vatCategory: "S", vatRate: 19 }] }),
    );
    expect(ids).not.toContain("PEPPOL-EN16931-R041");
    expect(ids).not.toContain("PEPPOL-EN16931-R042");
  });

  it("applies to line level allowances and charges too", () => {
    const ids = errorIds(
      peppol({
        lines: [cleanLine({ charges: [{ amount: 10, percentage: 2 }] })],
      }),
    );
    expect(ids).toContain("PEPPOL-EN16931-R041");
  });

  it("does not apply to the item price discount, which has no percentage", () => {
    const ids = allIds(
      peppol({ lines: [cleanLine({ unitPrice: 90, grossUnitPrice: 100, priceDiscount: 10 })] }),
    );
    expect(ids).not.toContain("PEPPOL-EN16931-R041");
    expect(ids).not.toContain("PEPPOL-EN16931-R042");
  });
});

describe("PEPPOL-EN16931-R040 — amount = base x percentage / 100", () => {
  it("accepts an exact computation", () => {
    expect(
      allIds(
        peppol({
          allowances: [
            { amount: 50, baseAmount: 1000, percentage: 5, vatCategory: "S", vatRate: 19 },
          ],
        }),
      ),
    ).not.toContain("PEPPOL-EN16931-R040");
  });

  it("accepts a deviation inside the 0.02 tolerance", () => {
    expect(
      allIds(
        peppol({
          allowances: [
            { amount: 50.02, baseAmount: 1000, percentage: 5, vatCategory: "S", vatRate: 19 },
          ],
        }),
      ),
    ).not.toContain("PEPPOL-EN16931-R040");
  });

  it("rejects a deviation outside it", () => {
    gatedFatal("PEPPOL-EN16931-R040", {
      allowances: [
        { amount: 50.03, baseAmount: 1000, percentage: 5, vatCategory: "S", vatRate: 19 },
      ],
    });
  });

  it("reports the expected figure and the delta", () => {
    const finding = findingFor(
      peppol({
        allowances: [
          { amount: 60, baseAmount: 1000, percentage: 5, vatCategory: "S", vatRate: 19 },
        ],
      }),
      "PEPPOL-EN16931-R040",
    )!;
    expect(finding.message).toContain("50.00");
    expect(finding.message).toContain("10.00");
  });

  it("applies at line level", () => {
    expect(
      errorIds(
        peppol({ lines: [cleanLine({ allowances: [{ amount: 99, baseAmount: 100, percentage: 5 }] })] }),
      ),
    ).toContain("PEPPOL-EN16931-R040");
  });
});

describe("PEPPOL-EN16931-R046 — net price = gross price − discount", () => {
  it("accepts a consistent price group", () => {
    expect(
      allIds(peppol({ lines: [cleanLine({ unitPrice: 90, grossUnitPrice: 100, priceDiscount: 10 })] })),
    ).not.toContain("PEPPOL-EN16931-R046");
  });

  it("accepts a gross price with no discount when it equals the net price", () => {
    expect(
      allIds(peppol({ lines: [cleanLine({ unitPrice: 150, grossUnitPrice: 150 })] })),
    ).not.toContain("PEPPOL-EN16931-R046");
  });

  it("rejects an inconsistent one, with no tolerance", () => {
    gatedFatal("PEPPOL-EN16931-R046", {
      lines: [cleanLine({ unitPrice: 90.01, grossUnitPrice: 100, priceDiscount: 10 })],
    });
  });

  it("stays silent when no gross price is stated", () => {
    expect(allIds(peppol())).not.toContain("PEPPOL-EN16931-R046");
  });
});

describe("PEPPOL-EN16931-R055 — the two VAT totals share a sign", () => {
  it("accepts matching signs", () => {
    expect(
      allIds(peppol({ vatAccountingCurrency: "SEK", taxAmountInAccountingCurrency: 3200 })),
    ).not.toContain("PEPPOL-EN16931-R055");
  });

  it("rejects opposite signs", () => {
    gatedFatal("PEPPOL-EN16931-R055", {
      vatAccountingCurrency: "SEK",
      taxAmountInAccountingCurrency: -3200,
    });
  });

  it("accepts zero on either side", () => {
    expect(
      allIds(peppol({ vatAccountingCurrency: "SEK", taxAmountInAccountingCurrency: 0 })),
    ).not.toContain("PEPPOL-EN16931-R055");
  });
});

describe("PEPPOL-EN16931-R061 — a direct debit names its mandate", () => {
  it("fires for payment means 59 with no mandate reference", () => {
    gatedFatal("PEPPOL-EN16931-R061", {
      payment: { meansCode: "59", directDebit: { debitedAccount: "DE02120300000000202051" } },
    });
  });

  it("fires for payment means 49 as well", () => {
    expect(
      errorIds(peppol({ payment: { meansCode: "49" } })),
    ).toContain("PEPPOL-EN16931-R061");
  });

  it("is satisfied by a mandate reference", () => {
    expect(
      errorIds(
        peppol({
          payment: {
            meansCode: "59",
            directDebit: {
              mandateReference: "MND-2026-0042",
              creditorIdentifier: "DE98ZZZ09999999999",
              debitedAccount: "DE02120300000000202051",
            },
          },
        }),
      ),
    ).not.toContain("PEPPOL-EN16931-R061");
  });

  it("does not fire for a credit transfer", () => {
    expect(allIds(peppol())).not.toContain("PEPPOL-EN16931-R061");
  });
});

describe("PEPPOL-EN16931-R110 / R111 — a line period sits inside the document's", () => {
  const period = { startDate: "2026-07-01", endDate: "2026-07-31" };

  it("accepts a line period inside the document period", () => {
    const ids = allIds(
      peppol({
        deliveryDate: undefined,
        invoicingPeriod: period,
        lines: [cleanLine({ period: { startDate: "2026-07-05", endDate: "2026-07-20" } })],
      }),
    );
    expect(ids).not.toContain("PEPPOL-EN16931-R110");
    expect(ids).not.toContain("PEPPOL-EN16931-R111");
  });

  it("accepts a line period exactly coincident with it — the boundary", () => {
    const ids = allIds(
      peppol({ deliveryDate: undefined, invoicingPeriod: period, lines: [cleanLine({ period })] }),
    );
    expect(ids).not.toContain("PEPPOL-EN16931-R110");
    expect(ids).not.toContain("PEPPOL-EN16931-R111");
  });

  it("R110 fires for a line starting one day early", () => {
    gatedFatal("PEPPOL-EN16931-R110", {
      deliveryDate: undefined,
      invoicingPeriod: period,
      lines: [cleanLine({ period: { startDate: "2026-06-30", endDate: "2026-07-20" } })],
    });
  });

  it("R111 fires for a line ending one day late", () => {
    gatedFatal("PEPPOL-EN16931-R111", {
      deliveryDate: undefined,
      invoicingPeriod: period,
      lines: [cleanLine({ period: { startDate: "2026-07-05", endDate: "2026-08-01" } })],
    });
  });

  it("stays silent when the document has no period at all", () => {
    const ids = allIds(
      peppol({ lines: [cleanLine({ period: { startDate: "2020-01-01", endDate: "2020-12-31" } })] }),
    );
    expect(ids).not.toContain("PEPPOL-EN16931-R110");
    expect(ids).not.toContain("PEPPOL-EN16931-R111");
  });

  it("stays silent when the dates are unusable, leaving BR-DEC/date rules to report", () => {
    const ids = allIds(
      peppol({
        deliveryDate: undefined,
        invoicingPeriod: period,
        lines: [cleanLine({ period: { startDate: "01.06.2026" } })],
      }),
    );
    expect(ids).not.toContain("PEPPOL-EN16931-R110");
  });
});

describe("PEPPOL-EN16931-R121 — the price base quantity", () => {
  it("accepts a positive base quantity", () => {
    expect(
      allIds(peppol({ lines: [cleanLine({ unitPrice: 12.5, baseQuantity: 100, quantity: 250 })] })),
    ).not.toContain("PEPPOL-EN16931-R121");
  });

  it("accepts an absent base quantity", () => {
    expect(allIds(peppol())).not.toContain("PEPPOL-EN16931-R121");
  });

  it("rejects zero", () => {
    gatedFatal("PEPPOL-EN16931-R121", { lines: [cleanLine({ baseQuantity: 0 })] });
  });

  it("rejects a negative base quantity", () => {
    expect(errorIds(peppol({ lines: [cleanLine({ baseQuantity: -1 })] }))).toContain(
      "PEPPOL-EN16931-R121",
    );
  });

  it("explains what BT-149 is for", () => {
    const finding = findingFor(
      peppol({ lines: [cleanLine({ baseQuantity: 0 })] }),
      "PEPPOL-EN16931-R121",
    )!;
    expect(finding.message).toMatch(/denominator/i);
    expect(finding.fix).toMatch(/quantity/);
  });
});

describe("PEPPOL-EN16931-R120 — the line net amount invariant", () => {
  it("never fires on well-formed input, which is what it is for", () => {
    const inputs = [
      peppol(),
      peppol({ lines: [cleanLine({ quantity: 3, unitPrice: 33.333 })] }),
      peppol({ lines: [cleanLine({ unitPrice: 12.5, baseQuantity: 100, quantity: 250 })] }),
      peppol({
        lines: [
          cleanLine({ allowances: [{ amount: 15 }], charges: [{ amount: 7.5 }] }),
        ],
      }),
    ];
    for (const input of inputs) {
      expect(allIds(input)).not.toContain("PEPPOL-EN16931-R120");
    }
  });
});

describe("PEPPOL-EN16931-P0100 / P0112 — invoice type codes", () => {
  it("accepts 380", () => {
    expect(allIds(peppol())).not.toContain("PEPPOL-EN16931-P0100");
  });

  it("accepts 386, which XRechnung's BR-DE-17 does not", () => {
    const ids = allIds(peppol({ invoiceTypeCode: "386" }));
    expect(ids).not.toContain("PEPPOL-EN16931-P0100");
    expect(allIds(xrechnung({ invoiceTypeCode: "386" }))).toContain("BR-DE-17");
  });

  it("rejects a code outside billing process 01", () => {
    // 325 (proforma) is in UNTDID 1001 but not in the process-01 subset.
    gatedFatal("PEPPOL-EN16931-P0100", { invoiceTypeCode: "325" });
  });

  it("P0112 accepts 326 between two German parties", () => {
    expect(allIds(peppol({ invoiceTypeCode: "326" }))).not.toContain(
      "PEPPOL-EN16931-P0112",
    );
  });

  it("P0112 rejects 384 when the buyer is not German", () => {
    gatedFatal("PEPPOL-EN16931-P0112", {
      invoiceTypeCode: "384",
      precedingInvoices: [{ invoiceNumber: "2026-000141" }],
      buyer: {
        ...clean.buyer,
        vatId: "FR12345678901",
        address: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
      } as Party,
    });
  });

  it("P0112 does not fire for 380", () => {
    expect(allIds(peppol({ invoiceTypeCode: "380" }))).not.toContain(
      "PEPPOL-EN16931-P0112",
    );
  });
});

describe("PEPPOL-EN16931-P0104..P0111 — a VATEX code names its category", () => {
  const withCategory = (
    category: "E" | "AE" | "K" | "G" | "O",
    code: string,
  ): InvoiceInput =>
    peppol({
      deliveryDate: "2026-08-05",
      deliverTo: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
      buyer: { ...clean.buyer, vatId: "FR12345678901" } as Party,
      lines: [cleanLine({ vatCategory: category, vatRate: 0 })],
      vatExemptionReasonCodes: { [category]: code },
    });

  const pairs: [string, string, "E" | "AE" | "K" | "G" | "O"][] = [
    ["PEPPOL-EN16931-P0104", "VATEX-EU-G", "G"],
    ["PEPPOL-EN16931-P0105", "VATEX-EU-O", "O"],
    ["PEPPOL-EN16931-P0106", "VATEX-EU-IC", "K"],
    ["PEPPOL-EN16931-P0107", "VATEX-EU-AE", "AE"],
    ["PEPPOL-EN16931-P0108", "VATEX-EU-D", "E"],
    ["PEPPOL-EN16931-P0109", "VATEX-EU-F", "E"],
    ["PEPPOL-EN16931-P0111", "VATEX-EU-J", "E"],
  ];

  for (const [rule, code, category] of pairs) {
    it(`${rule} stays silent when ${code} sits on category ${category}`, () => {
      expect(allIds(withCategory(category, code))).not.toContain(rule);
    });

    it(`${rule} fires when ${code} sits on the wrong category`, () => {
      const wrong = category === "E" ? "AE" : "E";
      expect(errorIds(withCategory(wrong, code))).toContain(rule);
    });

    it(`${rule} does not fire on the xrechnung profile`, () => {
      const wrong = category === "E" ? "AE" : "E";
      const input = withCategory(wrong, code);
      expect(allIds({ ...input, profile: "xrechnung-ubl" })).not.toContain(rule);
    });
  }

  it("is case-insensitive about the code", () => {
    expect(errorIds(withCategory("E", "vatex-eu-ic"))).toContain(
      "PEPPOL-EN16931-P0106",
    );
  });

  it("leaves an article-level VATEX code unconstrained", () => {
    expect(
      allIds(withCategory("E", "VATEX-EU-132-1A")).filter((id) =>
        id.startsWith("PEPPOL-EN16931-P01"),
      ),
    ).toEqual([]);
  });
});

describe("the teaching contract holds for the Peppol family", () => {
  const payloads: InvoiceInput[] = [
    peppol({ buyerReference: undefined, orderReference: undefined }),
    peppol({ vatAccountingCurrency: "EUR", taxAmountInAccountingCurrency: 1 }),
    peppol({ currency: "XCG" }),
    peppol(withElectronicAddress("EM", "billing@acme.example")),
    peppol(withElectronicAddress("0088", "7300010000002")),
    peppol({ allowances: [{ amount: 5, percentage: 5, vatCategory: "S", vatRate: 19 }] }),
    peppol({ allowances: [{ amount: 5, baseAmount: 100, vatCategory: "S", vatRate: 19 }] }),
    peppol({
      allowances: [{ amount: 60, baseAmount: 1000, percentage: 5, vatCategory: "S", vatRate: 19 }],
    }),
    peppol({ lines: [cleanLine({ unitPrice: 91, grossUnitPrice: 100, priceDiscount: 10 })] }),
    peppol({ vatAccountingCurrency: "SEK", taxAmountInAccountingCurrency: -1 }),
    peppol({ payment: { meansCode: "59" } }),
    peppol({
      deliveryDate: undefined,
      invoicingPeriod: { startDate: "2026-07-01", endDate: "2026-07-31" },
      lines: [cleanLine({ period: { startDate: "2026-06-01", endDate: "2026-08-31" } })],
    }),
    peppol({ lines: [cleanLine({ baseQuantity: 0 })] }),
    peppol({ invoiceTypeCode: "325" }),
    peppol({
      invoiceTypeCode: "384",
      precedingInvoices: [{ invoiceNumber: "x" }],
      buyer: {
        ...clean.buyer,
        address: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
      } as Party,
    }),
    peppol({
      lines: [cleanLine({ vatCategory: "E", vatRate: 0 })],
      vatExemptionReasons: { E: "Exempt" },
      vatExemptionReasonCodes: { E: "VATEX-EU-G" },
    }),
  ];

  const findings = payloads
    .flatMap((input) => {
      const result = validateInput(input);
      return [...result.errors, ...result.warnings, ...result.information];
    })
    .filter((finding) => finding.rule.startsWith("PEPPOL-"));

  it("reaches every rule the family implements", () => {
    const seen = new Set(findings.map((f) => f.rule));
    const expected = [
      "PEPPOL-EN16931-R003", "PEPPOL-EN16931-R005", "PEPPOL-EN16931-R040",
      "PEPPOL-EN16931-R041", "PEPPOL-EN16931-R042", "PEPPOL-EN16931-R046",
      "PEPPOL-EN16931-R055", "PEPPOL-EN16931-R061", "PEPPOL-EN16931-R110",
      "PEPPOL-EN16931-R111", "PEPPOL-EN16931-R121",
      "PEPPOL-EN16931-CL007", "PEPPOL-EN16931-CL008",
      "PEPPOL-EN16931-P0100", "PEPPOL-EN16931-P0112", "PEPPOL-EN16931-P0104",
      "PEPPOL-COMMON-R040",
    ];
    for (const rule of expected) expect([...seen], rule).toContain(rule);
  });

  it("gives every finding a message, a fix, an example where one helps, and a docs URL", () => {
    expect(findings.length).toBeGreaterThan(15);
    for (const finding of findings) {
      expect(finding.message.length, finding.rule).toBeGreaterThan(80);
      expect(finding.fix.length, finding.rule).toBeGreaterThan(20);
      expect(finding.docsUrl, finding.rule).toBe(
        `https://attestwire.com/rules/${finding.rule}`,
      );
      expect(finding.xpath, finding.rule).toBeTruthy();
      expect(finding.message, finding.rule).toContain("peppol-bis-3");
      // A message that restates the rule id is not a teaching error.
      expect(finding.message, finding.rule).not.toMatch(/^PEPPOL-[A-Z0-9-]+$/);
    }
  });
});
