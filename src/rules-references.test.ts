import { describe, expect, it } from "vitest";
import {
  ICD_SCHEME_CODES,
  ITEM_CLASSIFICATION_SCHEME_CODES,
  MIME_CODES,
  NOTE_SUBJECT_CODES,
  OBJECT_SCHEME_CODES,
  VATEX_CODES,
  VAT_POINT_DATE_CODES,
} from "./codelists/index.js";
import {
  allIds,
  clean,
  cleanLine,
  errorIds,
  findingFor,
  findings,
  warningIds,
  withInvoice,
  withLine,
} from "./testkit.js";
import type { InvoiceInput, Payee, TaxRepresentative } from "./types.js";

const repAddress = { city: "Lyon", postalCode: "69001", countryCode: "FR" };

/** A complete BG-11, so a test can knock out exactly one of its parts. */
const fullRep: TaxRepresentative = {
  name: "Fiscal Rep France SARL",
  vatId: "FR12345678901",
  address: repAddress,
};

const withRep = (o: Partial<TaxRepresentative>) =>
  withInvoice({ taxRepresentative: { ...fullRep, ...o } as TaxRepresentative });

const withPayee = (o: Partial<Payee>) =>
  withInvoice({ payee: { name: "Factoring Nord GmbH", ...o } as Payee });

/** A card lives under BT-81 = 48; under 58 the card group itself is a finding. */
const withCard = (primaryAccountNumber: string) =>
  withInvoice({ payment: { meansCode: "48", card: { primaryAccountNumber } } });

describe("a well-formed invoice that uses every optional group in this family", () => {
  // The most important test here: EN 16931 never penalises a document for
  // saying more, only for saying half of something. Opening the payee, the
  // tax representative, the preceding invoice, both periods, a supporting
  // document and the item's own identifiers must cost nothing.
  const loaded: InvoiceInput = withInvoice({
    payee: {
      name: "Factoring Nord GmbH",
      identifier: { schemeId: "0088", value: "4304171000002" },
      legalRegistrationId: { schemeId: "0198", value: "HRB 12345" },
    },
    taxRepresentative: fullRep,
    precedingInvoices: [{ invoiceNumber: "2026-000141", issueDate: "2026-07-31" }],
    invoicingPeriod: { startDate: "2026-07-01", endDate: "2026-07-31" },
    supportingDocuments: [
      {
        reference: "TS-2026-07",
        description: "Timesheet July 2026",
        attachment: {
          filename: "timesheet.pdf",
          mimeCode: "application/pdf",
          content: "JVBERi0xLjQK",
        },
      },
    ],
    invoicedObjectIdentifier: { schemeId: "MG", value: "1234567890" },
    deliverToLocationId: { schemeId: "0088", value: "4304171000002" },
    note: "Leistungszeitraum Juli 2026",
    noteSubjectCode: "AAI",
    vatAccountingCurrency: "PLN",
    taxAmountInAccountingCurrency: 1218.45,
    paidAmount: 500,
    roundingAmount: -0.03,
    lines: [
      cleanLine({
        period: { startDate: "2026-07-01", endDate: "2026-07-15" },
        objectIdentifier: { schemeId: "CT", value: "C-2026-77" },
        standardItemId: { schemeId: "0160", value: "04012345678901" },
        itemClassifications: [{ code: "43211508", schemeId: "TSP" }],
        originCountryCode: "DE",
        itemAttributes: [{ name: "Farbe", value: "anthrazit" }],
      }),
    ],
  });

  it("produces no errors and no warnings at all", () => {
    expect(errorIds(loaded)).toEqual([]);
    expect(warningIds(loaded)).toEqual([]);
  });

  it("leaves the bare fixture untouched, so the silence above is not an accident", () => {
    expect(allIds(clean)).toEqual([]);
  });
});

describe("BR-17: a payee group must name a party other than the seller", () => {
  it("accepts a payee that genuinely differs from the seller", () => {
    expect(allIds(withPayee({}))).toEqual([]);
  });

  it("requires the payee name once BG-10 is opened", () => {
    const inv = withPayee({ name: "" });
    expect(errorIds(inv)).toContain("BR-17");
    expect(findingFor(inv, "BR-17")!.field).toBe("BT-59");
  });

  it("treats whitespace as an absent name", () => {
    expect(allIds(withPayee({ name: "   " }))).toContain("BR-17");
  });

  it("rejects a payee name equal to the seller's, and quotes the name", () => {
    const inv = withPayee({ name: clean.seller.name });
    expect(errorIds(inv)).toContain("BR-17");
    expect(findingFor(inv, "BR-17")!.message).toContain(`"${clean.seller.name}"`);
  });

  it("compares against the seller's trading name, which is what UBL emits", () => {
    // cac:PartyName carries BT-28 when it is set, so that — not the legal
    // name — is the string the schematron compares the payee against.
    const inv = withInvoice({
      seller: { ...clean.seller, tradingName: "Acme Services" },
      payee: { name: "Acme Services" },
    });
    expect(errorIds(inv)).toContain("BR-17");
    expect(findingFor(inv, "BR-17")!.message).toContain("Acme Services");
  });

  it("rejects a payee identifier equal to the seller's, and reports it against BT-60", () => {
    const inv = withInvoice({
      seller: { ...clean.seller, identifier: { schemeId: "0088", value: "4304171000002" } },
      payee: {
        name: "Factoring Nord GmbH",
        identifier: { schemeId: "0088", value: "4304171000002" },
      },
    });
    const finding = findings(inv).find((f) => f.rule === "BR-17" && f.field === "BT-60");
    expect(finding).toBeDefined();
    expect(finding!.message).toContain("4304171000002");
  });

  it("accepts a distinct identifier on a distinct payee", () => {
    expect(
      allIds(
        withInvoice({
          seller: { ...clean.seller, identifier: { schemeId: "0088", value: "4304171000002" } },
          payee: {
            name: "Factoring Nord GmbH",
            identifier: { schemeId: "0088", value: "4304171000009" },
          },
        }),
      ),
    ).toEqual([]);
  });

  it("stays silent when there is no payee at all", () => {
    expect(allIds(clean)).not.toContain("BR-17");
  });
});

describe("BR-18 / BR-19 / BR-20 / BR-56: a tax representative must be fully identified", () => {
  it("accepts a complete tax representative", () => {
    expect(allIds(withRep({}))).toEqual([]);
  });

  it("requires the representative's name (BR-18)", () => {
    const inv = withRep({ name: "" });
    expect(errorIds(inv)).toContain("BR-18");
    expect(findingFor(inv, "BR-18")!.field).toBe("BT-62");
  });

  it("requires the representative's postal address (BR-19)", () => {
    const inv = withRep({ address: undefined as never });
    expect(errorIds(inv)).toContain("BR-19");
    expect(findingFor(inv, "BR-19")!.field).toBe("BG-12");
  });

  it("requires the country code inside that address (BR-20)", () => {
    const inv = withRep({ address: { ...repAddress, countryCode: "" } });
    expect(errorIds(inv)).toContain("BR-20");
    expect(findingFor(inv, "BR-20")!.field).toBe("BT-69");
  });

  it("lets BR-19 own a missing address rather than also firing BR-20", () => {
    // BR-20 guards on `rep.address`, so an absent address is reported once.
    const ids = allIds(withRep({ address: undefined as never }));
    expect(ids).toContain("BR-19");
    expect(ids).not.toContain("BR-20");
  });

  it("requires the representative's VAT identifier (BR-56)", () => {
    const inv = withRep({ vatId: "" });
    expect(errorIds(inv)).toContain("BR-56");
    expect(findingFor(inv, "BR-56")!.field).toBe("BT-63");
  });

  it("fires all four when the group is opened and left empty", () => {
    const inv = withInvoice({
      taxRepresentative: { name: " ", vatId: " ", address: undefined } as never,
    });
    const ids = allIds(inv);
    for (const rule of ["BR-18", "BR-19", "BR-56"]) expect(ids).toContain(rule);
  });

  it("stays silent when the seller is registered directly", () => {
    expect(allIds(clean)).not.toContain("BR-18");
  });
});

describe("BR-55: a preceding invoice reference must carry the invoice number", () => {
  it("accepts a reference with a number and a date", () => {
    expect(
      allIds(
        withInvoice({
          precedingInvoices: [{ invoiceNumber: "2026-000141", issueDate: "2026-07-31" }],
        }),
      ),
    ).toEqual([]);
  });

  it("fires on a blank invoice number", () => {
    const inv = withInvoice({ precedingInvoices: [{ invoiceNumber: "  " }] });
    expect(errorIds(inv)).toContain("BR-55");
    expect(findingFor(inv, "BR-55")!.field).toBe("BT-25");
  });

  it("names the date it does have, so the caller sees which entry is meant", () => {
    const inv = withInvoice({
      precedingInvoices: [{ invoiceNumber: "", issueDate: "2026-07-31" }],
    });
    expect(findingFor(inv, "BR-55")!.message).toContain('"2026-07-31"');
  });

  it("reports the position of the offending reference", () => {
    const inv = withInvoice({
      precedingInvoices: [{ invoiceNumber: "2026-000141" }, { invoiceNumber: "" }],
    });
    const finding = findingFor(inv, "BR-55")!;
    expect(finding.message).toContain("reference 2");
    expect(finding.xpath).toContain("cac:BillingReference[2]");
  });
});

describe("BR-52: a supporting document must carry a reference", () => {
  it("accepts a supporting document with a reference", () => {
    expect(
      allIds(withInvoice({ supportingDocuments: [{ reference: "TS-2026-07" }] })),
    ).toEqual([]);
  });

  it("fires on a blank reference", () => {
    const inv = withInvoice({ supportingDocuments: [{ reference: "" }] });
    expect(errorIds(inv)).toContain("BR-52");
    expect(findingFor(inv, "BR-52")!.field).toBe("BT-122");
  });

  it("names the attachment filename when one is present", () => {
    const inv = withInvoice({
      supportingDocuments: [
        {
          reference: "",
          attachment: {
            filename: "timesheet.pdf",
            mimeCode: "application/pdf",
            content: "AA",
          },
        },
      ],
    });
    expect(findingFor(inv, "BR-52")!.message).toContain("timesheet.pdf");
  });

  it("shifts its xpath when BT-18 occupies the first AdditionalDocumentReference", () => {
    // BT-18 shares cac:AdditionalDocumentReference and is emitted first, so a
    // document carrying an invoiced object identifier pushes BG-24 down by one.
    const withObject = withInvoice({
      invoicedObjectIdentifier: { schemeId: "MG", value: "1234567890" },
      supportingDocuments: [{ reference: "" }],
    });
    expect(findingFor(withObject, "BR-52")!.xpath).toContain(
      "cac:AdditionalDocumentReference[2]",
    );
    const withoutObject = withInvoice({ supportingDocuments: [{ reference: "" }] });
    expect(findingFor(withoutObject, "BR-52")!.xpath).toContain(
      "cac:AdditionalDocumentReference[1]",
    );
  });
});

describe("BR-51: an invoice must never carry a full card primary account number", () => {
  it("accepts a truncated PAN of exactly ten characters", () => {
    // The boundary: six leading digits plus four trailing is what PCI DSS
    // permits an invoice to show, and ten is therefore inclusive.
    expect(allIds(withCard("4111111111"))).toEqual([]);
  });

  it("accepts a PAN shorter than ten characters", () => {
    expect(allIds(withCard("1111"))).toEqual([]);
  });

  it("fires on an eleven-character PAN and states the length", () => {
    const inv = withCard("41111111111");
    expect(allIds(inv)).toContain("BR-51");
    expect(findingFor(inv, "BR-51")!.message).toContain("11 characters");
  });

  it("is a warning, not an error — the document is still accepted", () => {
    const inv = withCard("4111111111111111");
    expect(warningIds(inv)).toContain("BR-51");
    expect(errorIds(inv)).not.toContain("BR-51");
    expect(findingFor(inv, "BR-51")!.severity).toBe("warning");
  });

  it("stays silent when there is no card group", () => {
    expect(allIds(clean)).not.toContain("BR-51");
  });
});

describe("BR-54: an item attribute must have both a name and a value", () => {
  it("accepts a complete name/value pair", () => {
    expect(allIds(withLine({ itemAttributes: [{ name: "Farbe", value: "anthrazit" }] }))).toEqual(
      [],
    );
  });

  it("fires on a missing name and quotes the orphaned value", () => {
    const inv = withLine({ itemAttributes: [{ name: "", value: "anthrazit" }] });
    expect(errorIds(inv)).toContain("BR-54");
    expect(findingFor(inv, "BR-54")!.message).toContain('"anthrazit"');
  });

  it("fires on a missing value and quotes the orphaned name", () => {
    const inv = withLine({ itemAttributes: [{ name: "Farbe", value: "" }] });
    expect(errorIds(inv)).toContain("BR-54");
    expect(findingFor(inv, "BR-54")!.message).toContain('"Farbe"');
  });

  it("says so plainly when neither half is present", () => {
    const inv = withLine({ itemAttributes: [{ name: "", value: " " }] });
    expect(findingFor(inv, "BR-54")!.message).toContain("neither a name");
  });

  it("names the line and the attribute position", () => {
    const inv = withInvoice({
      lines: [
        cleanLine(),
        cleanLine({
          id: "2",
          itemAttributes: [{ name: "Farbe", value: "grau" }, { name: "", value: "x" }],
        }),
      ],
    });
    expect(findingFor(inv, "BR-54")!.message).toContain("attribute 2 on line 2");
  });

  it("reports both terms in its field", () => {
    const inv = withLine({ itemAttributes: [{ name: "", value: "x" }] });
    expect(findingFor(inv, "BR-54")!.field).toEqual(["BT-160", "BT-161"]);
  });
});

describe("BR-64 / BR-65: item identifiers and classifications need a scheme", () => {
  it("accepts a standard item identifier that declares its registry", () => {
    expect(
      allIds(withLine({ standardItemId: { schemeId: "0160", value: "04012345678901" } })),
    ).toEqual([]);
  });

  it("fires BR-64 on a standard identifier with no scheme, and quotes it", () => {
    const inv = withLine({ standardItemId: { value: "04012345678901" } });
    expect(errorIds(inv)).toContain("BR-64");
    expect(findingFor(inv, "BR-64")!.message).toContain('"04012345678901"');
  });

  it("stays silent on an empty standard identifier, which is never emitted", () => {
    expect(allIds(withLine({ standardItemId: { value: "" } }))).not.toContain("BR-64");
  });

  it("accepts a classification that declares its scheme", () => {
    expect(
      allIds(withLine({ itemClassifications: [{ code: "43211508", schemeId: "MP" }] })),
    ).toEqual([]);
  });

  it("fires BR-65 on a classification with no scheme, and quotes the code", () => {
    const inv = withLine({ itemClassifications: [{ code: "43211508", schemeId: "" }] });
    expect(errorIds(inv)).toContain("BR-65");
    expect(findingFor(inv, "BR-65")!.message).toContain('"43211508"');
  });

  it("names the classification position and the line", () => {
    const inv = withLine({
      itemClassifications: [
        { code: "43211508", schemeId: "MP" },
        { code: "8471", schemeId: "" },
      ],
    });
    expect(findingFor(inv, "BR-65")!.message).toContain("Classification 2 on line 1");
  });
});

describe("BR-CO-19 / BR-29: the document level invoicing period", () => {
  it("accepts a period with both dates", () => {
    expect(
      allIds(
        withInvoice({ invoicingPeriod: { startDate: "2026-07-01", endDate: "2026-07-31" } }),
      ),
    ).toEqual([]);
  });

  it("accepts a period with only a start date", () => {
    expect(allIds(withInvoice({ invoicingPeriod: { startDate: "2026-07-01" } }))).toEqual([]);
  });

  it("accepts a period with only an end date", () => {
    expect(allIds(withInvoice({ invoicingPeriod: { endDate: "2026-07-31" } }))).toEqual([]);
  });

  it("fires BR-CO-19 on a period with nothing in it", () => {
    const inv = withInvoice({ invoicingPeriod: {} });
    expect(errorIds(inv)).toContain("BR-CO-19");
    expect(findingFor(inv, "BR-CO-19")!.field).toBe("BG-14");
  });

  it("accepts a period carrying only the tax point date code — the UBL escape", () => {
    // BT-8 has nowhere else to live in UBL but cac:InvoicePeriod, so a
    // date-less period carrying only the code is legal there.
    expect(allIds(withInvoice({ invoicingPeriod: { descriptionCode: "35" } }))).toEqual([]);
  });

  it("accepts an end date equal to the start date — a one-day period", () => {
    expect(
      allIds(
        withInvoice({ invoicingPeriod: { startDate: "2026-07-01", endDate: "2026-07-01" } }),
      ),
    ).toEqual([]);
  });

  it("fires BR-29 when the end date precedes the start date", () => {
    const inv = withInvoice({
      invoicingPeriod: { startDate: "2026-07-31", endDate: "2026-07-01" },
    });
    expect(errorIds(inv)).toContain("BR-29");
    const finding = findings(inv).find(
      (f) => f.rule === "BR-29" && Array.isArray(f.field),
    )!;
    expect(finding.message).toContain('"2026-07-31"');
    expect(finding.message).toContain('"2026-07-01"');
  });

  it("fires BR-29 on a date written in a local format", () => {
    const inv = withInvoice({
      invoicingPeriod: { startDate: "01.07.2026", endDate: "2026-07-31" },
    });
    expect(errorIds(inv)).toContain("BR-29");
    expect(findingFor(inv, "BR-29")!.message).toContain('"01.07.2026"');
    expect(findingFor(inv, "BR-29")!.field).toBe("BT-73");
  });

  it("fires BR-29 on a syntactically fine date naming a day that does not exist", () => {
    expect(allIds(withInvoice({ invoicingPeriod: { endDate: "2026-07-32" } }))).toContain(
      "BR-29",
    );
  });

  it("does not attempt the ordering comparison once a date is malformed", () => {
    // A failed xs:date cast takes the comparison down with it, so exactly one
    // BR-29 finding is emitted, against the malformed endpoint.
    const inv = withInvoice({
      invoicingPeriod: { startDate: "01.07.2026", endDate: "2026-07-31" },
    });
    expect(allIds(inv).filter((r) => r === "BR-29")).toHaveLength(1);
  });

  it("stays silent when there is no invoicing period", () => {
    expect(allIds(clean)).not.toContain("BR-CO-19");
  });
});

describe("BR-CO-20 / BR-30: the line level invoicing period", () => {
  it("accepts a line period with both dates", () => {
    expect(
      allIds(withLine({ period: { startDate: "2026-07-01", endDate: "2026-07-15" } })),
    ).toEqual([]);
  });

  it("fires BR-CO-20 on a line period with no dates", () => {
    const inv = withLine({ period: {} });
    expect(errorIds(inv)).toContain("BR-CO-20");
    expect(findingFor(inv, "BR-CO-20")!.field).toBe("BG-26");
  });

  it("gives a line period no description-code escape — BT-8 is a document term", () => {
    // The document level period may carry BT-8 alone; a line period may not,
    // because there is no line equivalent of the tax point date code.
    const inv = withLine({ period: { descriptionCode: "35" } });
    expect(errorIds(inv)).toContain("BR-CO-20");
  });

  it("accepts a line period whose end equals its start", () => {
    expect(
      allIds(withLine({ period: { startDate: "2026-07-01", endDate: "2026-07-01" } })),
    ).toEqual([]);
  });

  it("fires BR-30 when a line period ends before it starts", () => {
    const inv = withLine({ period: { startDate: "2026-07-15", endDate: "2026-07-01" } });
    expect(errorIds(inv)).toContain("BR-30");
    expect(findingFor(inv, "BR-30")!.message).toContain("Line 1");
  });

  it("fires BR-30 on a malformed line period date", () => {
    const inv = withLine({ period: { startDate: "01.07.2026", endDate: "2026-07-15" } });
    expect(errorIds(inv)).toContain("BR-30");
    expect(findingFor(inv, "BR-30")!.field).toBe("BT-134");
  });

  it("names the offending line when several carry periods", () => {
    const inv = withInvoice({
      lines: [
        cleanLine({ period: { startDate: "2026-07-01", endDate: "2026-07-15" } }),
        cleanLine({ id: "2", period: { startDate: "2026-07-31", endDate: "2026-07-16" } }),
      ],
    });
    expect(findingFor(inv, "BR-30")!.message).toContain("Line 2");
  });
});

describe("BR-CO-03: the VAT point date and its code are mutually exclusive", () => {
  it("accepts an explicit tax point date alone", () => {
    expect(allIds(withInvoice({ taxPointDate: "2026-07-31" }))).toEqual([]);
  });

  it("accepts a tax point date code alone", () => {
    expect(allIds(withInvoice({ invoicingPeriod: { descriptionCode: "35" } }))).toEqual([]);
  });

  it("fires when both are given, and quotes both values", () => {
    const inv = withInvoice({
      taxPointDate: "2026-07-31",
      invoicingPeriod: { descriptionCode: "35" },
    });
    expect(errorIds(inv)).toContain("BR-CO-03");
    const finding = findingFor(inv, "BR-CO-03")!;
    expect(finding.message).toContain('"2026-07-31"');
    expect(finding.message).toContain('"35"');
    expect(finding.field).toEqual(["BT-7", "BT-8"]);
  });
});

describe("BR-53: the VAT accounting currency and its amount are one statement", () => {
  it("accepts both together", () => {
    expect(
      allIds(
        withInvoice({ vatAccountingCurrency: "PLN", taxAmountInAccountingCurrency: 1218.45 }),
      ),
    ).toEqual([]);
  });

  it("fires when BT-6 is declared without BT-111", () => {
    const inv = withInvoice({ vatAccountingCurrency: "PLN" });
    expect(errorIds(inv)).toContain("BR-53");
    const finding = findingFor(inv, "BR-53")!;
    expect(finding.field).toBe("BT-111");
    expect(finding.message).toContain('"PLN"');
  });

  it("fires on the reverse — an amount denominated in nothing", () => {
    const inv = withInvoice({ taxAmountInAccountingCurrency: 1218.45 });
    expect(errorIds(inv)).toContain("BR-53");
    const finding = findingFor(inv, "BR-53")!;
    expect(finding.field).toBe("BT-6");
    expect(finding.message).toContain("1218.45");
  });

  it("stays silent when neither is present", () => {
    expect(allIds(clean)).not.toContain("BR-53");
  });
});

describe("BR-CL-05: the tax currency code must come from ISO 4217", () => {
  it("accepts a real alpha-3 code", () => {
    expect(
      allIds(
        withInvoice({ vatAccountingCurrency: "PLN", taxAmountInAccountingCurrency: 1218.45 }),
      ),
    ).not.toContain("BR-CL-05");
  });

  it("rejects a well-shaped code that is in no ISO 4217 list", () => {
    const inv = withInvoice({
      vatAccountingCurrency: "XYZ",
      taxAmountInAccountingCurrency: 1218.45,
    });
    expect(errorIds(inv)).toContain("BR-CL-05");
    expect(findingFor(inv, "BR-CL-05")!.message).toContain('"XYZ"');
  });

  it("rejects lower case, and says the list is case-sensitive", () => {
    const inv = withInvoice({
      vatAccountingCurrency: "eur",
      taxAmountInAccountingCurrency: 1218.45,
    });
    expect(errorIds(inv)).toContain("BR-CL-05");
    expect(findingFor(inv, "BR-CL-05")!.message).toContain("case-sensitive");
  });
});

describe("BR-DEC-15 / BR-DEC-16 / BR-DEC-17: two decimals on the money terms", () => {
  it("accepts exactly two decimals on BT-111", () => {
    expect(
      allIds(
        withInvoice({ vatAccountingCurrency: "PLN", taxAmountInAccountingCurrency: 1218.45 }),
      ),
    ).toEqual([]);
  });

  it("fires BR-DEC-15 on an over-precise BT-111 and counts the decimals", () => {
    const inv = withInvoice({
      vatAccountingCurrency: "PLN",
      taxAmountInAccountingCurrency: 1218.4567,
    });
    expect(errorIds(inv)).toContain("BR-DEC-15");
    expect(findingFor(inv, "BR-DEC-15")!.message).toContain("4 decimals");
  });

  it("accepts exactly two decimals on the paid amount (BT-113)", () => {
    expect(allIds(withInvoice({ paidAmount: 500.12 }))).toEqual([]);
  });

  it("fires BR-DEC-16 on an over-precise paid amount", () => {
    const inv = withInvoice({ paidAmount: 500.123 });
    expect(errorIds(inv)).toContain("BR-DEC-16");
    expect(findingFor(inv, "BR-DEC-16")!.field).toBe("BT-113");
  });

  it("accepts exactly two decimals on the rounding amount (BT-114)", () => {
    expect(allIds(withInvoice({ roundingAmount: -0.03 }))).toEqual([]);
  });

  it("fires BR-DEC-17 on an over-precise rounding amount, negative included", () => {
    const inv = withInvoice({ roundingAmount: -0.035 });
    expect(errorIds(inv)).toContain("BR-DEC-17");
    expect(findingFor(inv, "BR-DEC-17")!.field).toBe("BT-114");
  });
});

describe("BR-CL-06: the VAT point date code is restricted to three UNTDID 2005 values", () => {
  it("accepts each of the three codes EN 16931 admits", () => {
    expect(VAT_POINT_DATE_CODES).toHaveLength(3);
    for (const code of ["3", "35", "432"]) {
      expect(allIds(withInvoice({ invoicingPeriod: { descriptionCode: code } }))).toEqual([]);
    }
  });

  it("rejects a UNTDID 2005 qualifier outside the restriction", () => {
    const inv = withInvoice({ invoicingPeriod: { descriptionCode: "7" } });
    expect(errorIds(inv)).toContain("BR-CL-06");
    expect(findingFor(inv, "BR-CL-06")!.message).toContain('"7"');
    expect(findingFor(inv, "BR-CL-06")!.field).toBe("BT-8");
  });
});

describe("BR-CL-07: an object identifier scheme must come from UNTDID 1153", () => {
  it("accepts a real reference qualifier on BT-18", () => {
    expect(OBJECT_SCHEME_CODES).toContain("MG");
    expect(
      allIds(withInvoice({ invoicedObjectIdentifier: { schemeId: "MG", value: "1234567890" } })),
    ).toEqual([]);
  });

  it("rejects an invented scheme on the invoiced object identifier", () => {
    const inv = withInvoice({
      invoicedObjectIdentifier: { schemeId: "METER", value: "1234567890" },
    });
    expect(errorIds(inv)).toContain("BR-CL-07");
    expect(findingFor(inv, "BR-CL-07")!.field).toBe("BT-18");
  });

  it("rejects an invented scheme on a line object identifier", () => {
    const inv = withLine({ objectIdentifier: { schemeId: "METER", value: "M-1" } });
    expect(errorIds(inv)).toContain("BR-CL-07");
    expect(findingFor(inv, "BR-CL-07")!.field).toBe("BT-128");
  });

  it("stays silent on an identifier with no scheme — the attribute is then absent", () => {
    expect(
      allIds(withInvoice({ invoicedObjectIdentifier: { value: "1234567890" } })),
    ).toEqual([]);
  });
});

describe("BR-CL-08: the note subject code must come from UNCL 4451", () => {
  it("accepts AAI, the general-information qualifier", () => {
    expect(NOTE_SUBJECT_CODES).toContain("AAI");
    expect(allIds(withInvoice({ note: "Hinweis", noteSubjectCode: "AAI" }))).toEqual([]);
  });

  it("rejects a code that is in no UNCL 4451 list", () => {
    const inv = withInvoice({ note: "Hinweis", noteSubjectCode: "ZQQ" });
    expect(errorIds(inv)).toContain("BR-CL-08");
    expect(findingFor(inv, "BR-CL-08")!.field).toBe("BT-21");
  });

  it("warns that a code of the wrong length slips past the schematron entirely", () => {
    // The reference test only applies to a three-character prefix, so a
    // four-character code passes KoSIT while still being wrong.
    const inv = withInvoice({ note: "Hinweis", noteSubjectCode: "ZQQQ" });
    expect(findingFor(inv, "BR-CL-08")!.message).toContain("4 characters");
  });

  it("says the code is dropped when there is no note to prefix it onto", () => {
    const inv = withInvoice({ note: undefined, noteSubjectCode: "ZQQ" });
    expect(findingFor(inv, "BR-CL-08")!.message).toContain("only emits the code");
  });
});

describe("BR-CL-10 / BR-CL-11: party and registration schemes come from the ISO 6523 ICD list", () => {
  it("accepts a GLN scheme on the seller, buyer and payee", () => {
    expect(ICD_SCHEME_CODES).toContain("0088");
    expect(
      allIds(
        withInvoice({
          seller: { ...clean.seller, identifier: { schemeId: "0088", value: "43041710000021" } },
          buyer: { ...clean.buyer, identifier: { schemeId: "0088", value: "43041710000038" } },
          payee: {
            name: "Factoring Nord GmbH",
            identifier: { schemeId: "0088", value: "43041710000045" },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('rejects "9930" on a party identifier — it is an EAS code, not an ICD code', () => {
    // The whole point of BR-CL-10: the endpoint list (BR-CL-25) and the party
    // identifier list are different lists, and 9930 belongs only to the former.
    const inv = withInvoice({
      seller: { ...clean.seller, identifier: { schemeId: "9930", value: "DE123456789" } },
    });
    expect(errorIds(inv)).toContain("BR-CL-10");
    const finding = findingFor(inv, "BR-CL-10")!;
    expect(finding.field).toBe("BT-29");
    expect(finding.message).toContain('"9930"');
  });

  it("checks the buyer identifier scheme too", () => {
    const inv = withInvoice({
      buyer: { ...clean.buyer, identifier: { schemeId: "9930", value: "DE987654321" } },
    });
    expect(findingFor(inv, "BR-CL-10")!.field).toBe("BT-46");
  });

  it("checks the payee identifier scheme too", () => {
    const inv = withPayee({ identifier: { schemeId: "GLN", value: "4304171000002" } });
    expect(findingFor(inv, "BR-CL-10")!.field).toBe("BT-60");
  });

  it('admits "SEPA" on the seller, where the creditor identifier lives', () => {
    expect(
      allIds(
        withInvoice({
          seller: { ...clean.seller, identifier: { schemeId: "SEPA", value: "DE98ZZZ0999" } },
        }),
      ),
    ).not.toContain("BR-CL-10");
  });

  it('refuses "SEPA" on the buyer, and explains where it is admitted', () => {
    const inv = withInvoice({
      buyer: { ...clean.buyer, identifier: { schemeId: "SEPA", value: "DE98ZZZ0999" } },
    });
    expect(errorIds(inv)).toContain("BR-CL-10");
    expect(findingFor(inv, "BR-CL-10")!.message).toContain("seller and the payee");
  });

  it('rejects "9930" on a legal registration identifier under BR-CL-11', () => {
    const inv = withInvoice({
      seller: {
        ...clean.seller,
        legalRegistrationId: "HRB 12345",
        legalRegistrationSchemeId: "9930",
      },
    });
    expect(errorIds(inv)).toContain("BR-CL-11");
    expect(findingFor(inv, "BR-CL-11")!.field).toBe("BT-30");
  });

  it("checks the buyer and payee registration schemes too", () => {
    expect(
      findingFor(
        withInvoice({
          buyer: {
            ...clean.buyer,
            legalRegistrationId: "HRB 999",
            legalRegistrationSchemeId: "KVK",
          },
        }),
        "BR-CL-11",
      )!.field,
    ).toBe("BT-47");
    expect(
      findingFor(
        withPayee({ legalRegistrationId: { schemeId: "KVK", value: "HRB 999" } }),
        "BR-CL-11",
      )!.field,
    ).toBe("BT-61");
  });

  it('gives BR-CL-11 no "SEPA" escape — that element is not where BT-90 lives', () => {
    const inv = withInvoice({
      seller: {
        ...clean.seller,
        legalRegistrationId: "HRB 12345",
        legalRegistrationSchemeId: "SEPA",
      },
    });
    expect(errorIds(inv)).toContain("BR-CL-11");
  });

  it("accepts a real ICD code on a legal registration identifier", () => {
    expect(
      allIds(
        withInvoice({
          seller: {
            ...clean.seller,
            legalRegistrationId: "HRB 12345",
            legalRegistrationSchemeId: "0198",
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe("BR-CL-13: an item classification scheme must come from UNTDID 7143", () => {
  it('accepts "TSP"', () => {
    expect(ITEM_CLASSIFICATION_SCHEME_CODES).toContain("TSP");
    expect(
      allIds(withLine({ itemClassifications: [{ code: "43211508", schemeId: "TSP" }] })),
    ).toEqual([]);
  });

  it("rejects the name of a classification system where its code belongs", () => {
    const inv = withLine({ itemClassifications: [{ code: "43211508", schemeId: "UNSPSC" }] });
    expect(errorIds(inv)).toContain("BR-CL-13");
    expect(findingFor(inv, "BR-CL-13")!.message).toContain('"UNSPSC"');
  });

  it("lets BR-65 own an absent scheme rather than also firing BR-CL-13", () => {
    const ids = allIds(withLine({ itemClassifications: [{ code: "43211508", schemeId: "" }] }));
    expect(ids).toContain("BR-65");
    expect(ids).not.toContain("BR-CL-13");
  });
});

describe("BR-CL-15: the item country of origin must come from ISO 3166-1", () => {
  it('accepts "DE"', () => {
    expect(allIds(withLine({ originCountryCode: "DE" }))).toEqual([]);
  });

  it("rejects a code that is in no ISO 3166-1 list, under BR-CL-15 and not BR-CL-14", () => {
    // Same code list, different element: cac:OriginCountry is BR-CL-15's, and
    // KoSIT reports the two separately.
    const inv = withLine({ originCountryCode: "ZZ" });
    const ids = allIds(inv);
    expect(ids).toContain("BR-CL-15");
    expect(ids).not.toContain("BR-CL-14");
    expect(findingFor(inv, "BR-CL-15")!.field).toBe("BT-159");
  });

  it('rejects "EL" and explains it is the Greek VAT prefix', () => {
    const inv = withLine({ originCountryCode: "EL" });
    expect(findingFor(inv, "BR-CL-15")!.message).toContain('country code is "GR"');
  });

  it('rejects "UK" and points at "GB"', () => {
    const inv = withLine({ originCountryCode: "UK" });
    expect(findingFor(inv, "BR-CL-15")!.message).toContain('"GB"');
  });
});

describe("BR-CL-21: the item standard identifier scheme must come from the ICD list", () => {
  it('accepts "0160", the GTIN registry', () => {
    expect(
      allIds(withLine({ standardItemId: { schemeId: "0160", value: "04012345678901" } })),
    ).toEqual([]);
  });

  it('rejects "GTIN" — the attribute holds a registry code, not its name', () => {
    const inv = withLine({ standardItemId: { schemeId: "GTIN", value: "04012345678901" } });
    expect(errorIds(inv)).toContain("BR-CL-21");
    expect(findingFor(inv, "BR-CL-21")!.message).toContain('"GTIN"');
  });

  it("lets BR-64 own an absent scheme rather than also firing BR-CL-21", () => {
    const ids = allIds(withLine({ standardItemId: { value: "04012345678901" } }));
    expect(ids).toContain("BR-64");
    expect(ids).not.toContain("BR-CL-21");
  });
});

describe("BR-CL-22: the VAT exemption reason code must come from the CEF VATEX list", () => {
  it("accepts a real VATEX code", () => {
    expect(VATEX_CODES).toContain("VATEX-EU-AE");
    expect(
      allIds(withInvoice({ vatExemptionReasonCodes: { S: "VATEX-EU-AE" } })),
    ).not.toContain("BR-CL-22");
  });

  it("rejects free text where a code belongs, and names the category", () => {
    const inv = withInvoice({ vatExemptionReasonCodes: { S: "Reverse charge" } });
    expect(errorIds(inv)).toContain("BR-CL-22");
    const finding = findingFor(inv, "BR-CL-22")!;
    expect(finding.field).toBe("BT-121");
    expect(finding.message).toContain('category "S"');
  });

  it("is case-insensitive, uniquely among the code-list rules", () => {
    // The schematron upper-cases the element content before testing, so this
    // is the one BR-CL rule where case genuinely cannot be the problem.
    expect(
      allIds(withInvoice({ vatExemptionReasonCodes: { S: "vatex-eu-ae" } })),
    ).not.toContain("BR-CL-22");
  });
});

describe("BR-CL-24: an attachment mime code must be one of the six admitted", () => {
  const withMime = (mimeCode: string) =>
    withInvoice({
      supportingDocuments: [
        {
          reference: "TS-2026-07",
          attachment: { filename: "evidence", mimeCode, content: "AA" },
        },
      ],
    });

  it("admits exactly six mime codes", () => {
    expect(MIME_CODES).toHaveLength(6);
  });

  it("accepts application/pdf and image/png", () => {
    for (const code of ["application/pdf", "image/png"]) {
      expect(allIds(withMime(code))).toEqual([]);
    }
  });

  it("rejects a legitimate format that is nonetheless outside the list", () => {
    const inv = withMime("application/zip");
    expect(errorIds(inv)).toContain("BR-CL-24");
    const finding = findingFor(inv, "BR-CL-24")!;
    expect(finding.field).toBe("BT-125");
    expect(finding.message).toContain('"application/zip"');
  });
});

describe("BR-CL-26: the deliver-to location identifier scheme comes from the ICD list", () => {
  it("accepts a GLN scheme", () => {
    expect(
      allIds(withInvoice({ deliverToLocationId: { schemeId: "0088", value: "4304171000002" } })),
    ).toEqual([]);
  });

  it("rejects a scheme that is not an ICD code", () => {
    const inv = withInvoice({
      deliverToLocationId: { schemeId: "GLN", value: "4304171000002" },
    });
    expect(errorIds(inv)).toContain("BR-CL-26");
    expect(findingFor(inv, "BR-CL-26")!.field).toBe("BT-71");
  });

  it("stays silent on a bare identifier with no scheme", () => {
    expect(allIds(withInvoice({ deliverToLocationId: { value: "4304171000002" } }))).toEqual([]);
  });
});

describe("every finding this family emits", () => {
  const broken: InvoiceInput[] = [
    withPayee({ name: "" }),
    withPayee({ name: clean.seller.name }),
    withInvoice({
      seller: { ...clean.seller, identifier: { schemeId: "0088", value: "4304171000002" } },
      payee: {
        name: "Factoring Nord GmbH",
        identifier: { schemeId: "0088", value: "4304171000002" },
      },
    }),
    withRep({ name: "" }),
    withRep({ address: undefined as never }),
    withRep({ address: { ...repAddress, countryCode: "" } }),
    withRep({ vatId: "" }),
    withInvoice({ precedingInvoices: [{ invoiceNumber: "" }] }),
    withInvoice({ supportingDocuments: [{ reference: "" }] }),
    withCard("4111111111111111"),
    withLine({ itemAttributes: [{ name: "", value: "x" }] }),
    withLine({ standardItemId: { value: "04012345678901" } }),
    withLine({ itemClassifications: [{ code: "43211508", schemeId: "" }] }),
    withInvoice({ invoicingPeriod: {} }),
    withInvoice({ invoicingPeriod: { startDate: "2026-07-31", endDate: "2026-07-01" } }),
    withInvoice({ invoicingPeriod: { startDate: "01.07.2026" } }),
    withLine({ period: {} }),
    withLine({ period: { startDate: "2026-07-15", endDate: "2026-07-01" } }),
    withLine({ period: { startDate: "01.07.2026" } }),
    withInvoice({ taxPointDate: "2026-07-31", invoicingPeriod: { descriptionCode: "35" } }),
    withInvoice({ vatAccountingCurrency: "PLN" }),
    withInvoice({ taxAmountInAccountingCurrency: 1218.45 }),
    withInvoice({ vatAccountingCurrency: "XYZ", taxAmountInAccountingCurrency: 1 }),
    withInvoice({ vatAccountingCurrency: "PLN", taxAmountInAccountingCurrency: 1218.4567 }),
    withInvoice({ paidAmount: 500.123 }),
    withInvoice({ roundingAmount: -0.035 }),
    withInvoice({ invoicingPeriod: { descriptionCode: "7" } }),
    withInvoice({ invoicedObjectIdentifier: { schemeId: "METER", value: "1" } }),
    withLine({ objectIdentifier: { schemeId: "METER", value: "1" } }),
    withInvoice({ note: "Hinweis", noteSubjectCode: "ZQQ" }),
    withInvoice({
      seller: { ...clean.seller, identifier: { schemeId: "9930", value: "DE1" } },
    }),
    withInvoice({
      seller: {
        ...clean.seller,
        legalRegistrationId: "HRB 1",
        legalRegistrationSchemeId: "9930",
      },
    }),
    withLine({ itemClassifications: [{ code: "43211508", schemeId: "UNSPSC" }] }),
    withLine({ originCountryCode: "ZZ" }),
    withLine({ standardItemId: { schemeId: "GTIN", value: "0401" } }),
    withInvoice({ vatExemptionReasonCodes: { S: "Reverse charge" } }),
    withInvoice({
      supportingDocuments: [
        {
          reference: "R",
          attachment: { filename: "a.zip", mimeCode: "application/zip", content: "AA" },
        },
      ],
    }),
    withInvoice({ deliverToLocationId: { schemeId: "GLN", value: "1" } }),
  ];

  it("satisfies the TeachingError contract", () => {
    const seen = new Set<string>();
    for (const inv of broken) {
      for (const finding of findings(inv)) {
        seen.add(finding.rule);
        const fields = Array.isArray(finding.field) ? finding.field : [finding.field];
        for (const field of fields) expect(field).toMatch(/^B[TG]-\d+$/);
        expect(finding.rule).toMatch(/^(BR|ATW)-[A-Z0-9-]+$/);
        expect(["fatal", "warning"]).toContain(finding.severity);
        expect(finding.message.length).toBeGreaterThan(80);
        expect(finding.fix.length).toBeGreaterThan(20);
        // Library limitations (`ATW-`) are documented in the README, not on a
        // per-rule page — there is no regulator page to point at.
        expect(finding.docsUrl).toBe(
          finding.rule.startsWith("ATW-")
            ? "https://github.com/attestwire/en16931#not-implemented-yet"
            : `https://attestwire.com/rules/${finding.rule}`,
        );
        expect(finding.xpath.startsWith("/ubl:Invoice")).toBe(true);
        expect(finding.xpath).not.toMatch(/\s/);
      }
    }
    expect(seen.size).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// BR-53 when BT-6 equals BT-5.
//
// The schematron looks for a VAT total carrying the accounting currency, and
// when the accounting currency IS the invoice currency, BT-110 is that amount:
// the document needs no second VAT total. Found on
// cen-ubl-examples/examples/sample-discount-price.xml (benchmark, 2026-08-16),
// which declares BT-5 = BT-6 = EUR — the CEN schematron accepts it and we
// rejected it.
describe("BR-53 and the equal-currency case", () => {
  it("is satisfied when the VAT accounting currency is the invoice currency", () => {
    const ids = allIds(
      withInvoice({ currency: "EUR", vatAccountingCurrency: "EUR", profile: "en16931" }),
    );
    expect(ids).not.toContain("BR-53");
  });

  it("still fires when the currencies genuinely differ and BT-111 is absent", () => {
    const ids = allIds(
      withInvoice({ currency: "EUR", vatAccountingCurrency: "SEK", profile: "en16931" }),
    );
    expect(ids).toContain("BR-53");
  });

  it("still fires for BT-111 with no BT-6", () => {
    const ids = allIds(
      withInvoice({ taxAmountInAccountingCurrency: 285, profile: "en16931" }),
    );
    expect(ids).toContain("BR-53");
  });
});
