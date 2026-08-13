import { describe, expect, it } from "vitest";
import {
  generateXRechnungUBL,
  computeTotals,
  UBL_GENERATABLE_PROFILES,
  GenerationError,
  UnsupportedProfileError,
  UnsupportedDocumentTypeError,
  generateCii,
  parseCiiInvoice,
  parseUblInvoice,
  validateInput,
} from "./index.js";
import type { InvoiceInput } from "./types.js";

/**
 * Tiny, dependency-free probes over the generated document. Not a parser — just
 * enough structure to assert on element text, attributes and ordering without
 * pulling an XML library into a zero-dependency package.
 */

/** All text contents of `<tag>` in document order. */
function textsOf(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]!.trim());
}

/** First text content of `<tag>`, or undefined. */
function textOf(xml: string, tag: string): string | undefined {
  return textsOf(xml, tag)[0];
}

/** The full opening tag of the first `<tag ...>`, for attribute assertions. */
function openTagOf(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}(?:\\s[^>]*)?/?>`).exec(xml)?.[0];
}

/**
 * Index of the first occurrence of `<tag`, for ordering assertions.
 *
 * The tag name is anchored on a following `>`, `/` or space, because UBL has
 * several pairs where one name is a prefix of another —
 * `cbc:TaxExemptionReason` / `cbc:TaxExemptionReasonCode`,
 * `cbc:AllowanceChargeReason` / `cbc:AllowanceChargeReasonCode` — and a plain
 * indexOf silently reports the same position for both, which turns an ordering
 * assertion into a tautology.
 */
function posOf(xml: string, tag: string): number {
  const at = new RegExp(`<${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s/>])`).exec(xml);
  return at ? at.index : -1;
}

/** Assert that every tag appears, in the given relative order. */
function expectOrder(xml: string, tags: string[]): void {
  const positions = tags.map((t) => ({ t, at: posOf(xml, t) }));
  for (const p of positions) {
    expect(p.at, `${p.t} should be present`).toBeGreaterThan(-1);
  }
  for (let i = 1; i < positions.length; i += 1) {
    expect(
      positions[i]!.at,
      `${positions[i]!.t} should come after ${positions[i - 1]!.t}`,
    ).toBeGreaterThan(positions[i - 1]!.at);
  }
}

/** Crude well-formedness check: tags nest and close in order. */
function isWellFormed(xml: string): boolean {
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g;
  const body = xml.replace(/<\?[\s\S]*?\?>/g, "");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const [, closing, name, , selfClosing] = m;
    if (selfClosing === "/") continue;
    if (closing === "/") {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name!);
    }
  }
  return stack.length === 0;
}

const minimal: InvoiceInput = {
  profile: "xrechnung-ubl",
  invoiceNumber: "2026-000142",
  issueDate: "2026-08-09",
  dueDate: "2026-09-08",
  currency: "EUR",
  buyerReference: "04011000-1234512345-06",
  seller: {
    name: "Acme GmbH",
    vatId: "DE123456789",
    address: {
      line1: "Hauptstraße 1",
      city: "Berlin",
      postalCode: "10115",
      countryCode: "DE",
    },
    electronicAddress: { schemeId: "9930", value: "DE123456789" },
    contact: {
      name: "Buchhaltung",
      phone: "+49 30 1234567",
      email: "rechnungen@acme.example",
    },
  },
  buyer: {
    name: "Bundesamt für Beispiele",
    vatId: "DE987654321",
    address: {
      line1: "Behördenweg 9",
      city: "München",
      postalCode: "80331",
      countryCode: "DE",
    },
    electronicAddress: { schemeId: "0204", value: "04011000-1234512345-06" },
  },
  payment: {
    meansCode: "58",
    iban: "DE02120300000000202051",
    accountName: "Acme GmbH",
    bic: "BYLADEM1001",
  },
  paymentTerms: "Zahlbar innerhalb von 30 Tagen ohne Abzug.",
  lines: [
    {
      id: "1",
      description: "Senior engineering consultancy",
      quantity: 10,
      unitCode: "HUR",
      unitPrice: 150,
      vatCategory: "S",
      vatRate: 19,
    },
  ],
};

describe("generateXRechnungUBL — document shell", () => {
  const xml = generateXRechnungUBL(minimal);

  it("emits a well-formed document with an XML declaration", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(isWellFormed(xml)).toBe(true);
  });

  it("declares the three UBL namespaces on the root", () => {
    const root = openTagOf(xml, "ubl:Invoice")!;
    expect(root).toContain(
      'xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"',
    );
    expect(root).toContain(
      'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    );
    expect(root).toContain(
      'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"',
    );
  });

  it("carries the XRechnung 3.0 CustomizationID and a ProfileID (BT-24, BT-23)", () => {
    expect(textOf(xml, "cbc:CustomizationID")).toBe(
      "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0",
    );
    expect(textOf(xml, "cbc:ProfileID")).toBe(
      "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
    );
  });

  it("switches CustomizationID for the Peppol profile", () => {
    const peppol = generateXRechnungUBL({ ...minimal, profile: "peppol-bis-3" });
    expect(textOf(peppol, "cbc:CustomizationID")).toBe(
      "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0",
    );
  });

  it("keeps root children in UBL sequence order", () => {
    expectOrder(xml, [
      "cbc:CustomizationID",
      "cbc:ProfileID",
      "cbc:ID",
      "cbc:IssueDate",
      "cbc:DueDate",
      "cbc:InvoiceTypeCode",
      "cbc:DocumentCurrencyCode",
      "cbc:BuyerReference",
      "cac:AccountingSupplierParty",
      "cac:AccountingCustomerParty",
      "cac:PaymentMeans",
      "cac:PaymentTerms",
      "cac:TaxTotal",
      "cac:LegalMonetaryTotal",
      "cac:InvoiceLine",
    ]);
  });

  it("maps the header business terms", () => {
    expect(textOf(xml, "cbc:ID")).toBe("2026-000142"); // BT-1
    expect(textOf(xml, "cbc:IssueDate")).toBe("2026-08-09"); // BT-2
    expect(textOf(xml, "cbc:DueDate")).toBe("2026-09-08"); // BT-9
    expect(textOf(xml, "cbc:InvoiceTypeCode")).toBe("380"); // BT-3
    expect(textOf(xml, "cbc:DocumentCurrencyCode")).toBe("EUR"); // BT-5
    expect(textOf(xml, "cbc:BuyerReference")).toBe("04011000-1234512345-06"); // BT-10
  });

  it("omits optional elements rather than emitting them empty", () => {
    const bare = generateXRechnungUBL({
      ...minimal,
      dueDate: undefined,
      paymentTerms: undefined,
      note: undefined,
      orderReference: undefined,
    });
    expect(bare).not.toContain("cbc:DueDate");
    expect(bare).not.toContain("cac:PaymentTerms");
    expect(bare).not.toContain("cbc:Note");
    expect(bare).not.toContain("cac:OrderReference");
  });
});

describe("generateXRechnungUBL — parties", () => {
  const xml = generateXRechnungUBL(minimal);

  it("emits electronic addresses with their schemeID (BT-34, BT-49)", () => {
    expect(xml).toContain('<cbc:EndpointID schemeID="9930">DE123456789</cbc:EndpointID>');
    expect(xml).toContain(
      '<cbc:EndpointID schemeID="0204">04011000-1234512345-06</cbc:EndpointID>',
    );
  });

  it("keeps cac:Party children in schema order", () => {
    const supplier = /<cac:AccountingSupplierParty>[\s\S]*?<\/cac:AccountingSupplierParty>/.exec(
      xml,
    )![0];
    expectOrder(supplier, [
      "cbc:EndpointID",
      "cac:PartyName",
      "cac:PostalAddress",
      "cac:PartyTaxScheme",
      "cac:PartyLegalEntity",
      "cac:Contact",
    ]);
  });

  it("maps the postal address terms in schema order", () => {
    const supplier = /<cac:AccountingSupplierParty>[\s\S]*?<\/cac:AccountingSupplierParty>/.exec(
      xml,
    )![0];
    expectOrder(supplier, [
      "cbc:StreetName",
      "cbc:CityName",
      "cbc:PostalZone",
      "cac:Country",
    ]);
    expect(textOf(supplier, "cbc:StreetName")).toBe("Hauptstraße 1");
    expect(textOf(supplier, "cbc:CityName")).toBe("Berlin");
    expect(textOf(supplier, "cbc:PostalZone")).toBe("10115");
    expect(textOf(supplier, "cbc:IdentificationCode")).toBe("DE");
  });

  it("emits the seller contact group (BR-DE-2/5/6/7)", () => {
    const contact = /<cac:Contact>[\s\S]*?<\/cac:Contact>/.exec(xml)![0];
    expect(textOf(contact, "cbc:Name")).toBe("Buchhaltung");
    expect(textOf(contact, "cbc:Telephone")).toBe("+49 30 1234567");
    expect(textOf(contact, "cbc:ElectronicMail")).toBe("rechnungen@acme.example");
  });

  it("separates the VAT scheme (BT-31) from a national tax registration (BT-32)", () => {
    const withBoth = generateXRechnungUBL({
      ...minimal,
      seller: { ...minimal.seller, taxRegistrationId: "181/815/08155" },
    });
    const supplier = /<cac:AccountingSupplierParty>[\s\S]*?<\/cac:AccountingSupplierParty>/.exec(
      withBoth,
    )![0];
    expect(supplier).toMatch(
      /<cbc:CompanyID>DE123456789<\/cbc:CompanyID>[\s\S]*?<cbc:ID>VAT<\/cbc:ID>/,
    );
    expect(supplier).toMatch(
      /<cbc:CompanyID>181\/815\/08155<\/cbc:CompanyID>[\s\S]*?<cbc:ID>FC<\/cbc:ID>/,
    );
  });

  it("falls back to the trading name for the legal entity, and prefers legalName", () => {
    expect(
      /<cac:PartyLegalEntity>\s*<cbc:RegistrationName>Acme GmbH</.test(
        generateXRechnungUBL(minimal),
      ),
    ).toBe(true);
    const withLegal = generateXRechnungUBL({
      ...minimal,
      seller: { ...minimal.seller, legalName: "Acme Holding GmbH & Co. KG" },
    });
    expect(textOf(withLegal, "cbc:RegistrationName")).toBe(
      "Acme Holding GmbH &amp; Co. KG",
    );
  });
});

describe("generateXRechnungUBL — lines and totals", () => {
  const xml = generateXRechnungUBL(minimal);

  it("maps quantity, unit code and price (BT-129, BT-130, BT-146)", () => {
    expect(xml).toContain(
      '<cbc:InvoicedQuantity unitCode="HUR">10.0000</cbc:InvoicedQuantity>',
    );
    expect(xml).toContain(
      '<cbc:PriceAmount currencyID="EUR">150.00</cbc:PriceAmount>',
    );
    expect(textOf(xml, "cbc:Name")).toBeTruthy();
  });

  it("emits the VAT category and rate per line (BT-151, BT-152)", () => {
    const item = /<cac:ClassifiedTaxCategory>[\s\S]*?<\/cac:ClassifiedTaxCategory>/.exec(
      xml,
    )![0];
    expect(textOf(item, "cbc:ID")).toBe("S");
    expect(textOf(item, "cbc:Percent")).toBe("19.00");
    expect(item).toContain("<cbc:ID>VAT</cbc:ID>");
  });

  it("computes totals that satisfy the BR-CO identities", () => {
    const totals = computeTotals(minimal);
    const money = /<cac:LegalMonetaryTotal>[\s\S]*?<\/cac:LegalMonetaryTotal>/.exec(
      xml,
    )![0];
    expect(textOf(money, "cbc:LineExtensionAmount")).toBe("1500.00"); // BT-106
    expect(textOf(money, "cbc:TaxExclusiveAmount")).toBe("1500.00"); // BT-109
    expect(textOf(money, "cbc:TaxInclusiveAmount")).toBe("1785.00"); // BT-112
    expect(textOf(money, "cbc:PayableAmount")).toBe("1785.00"); // BT-115
    expect(textOf(xml, "cbc:TaxAmount")).toBe("285.00"); // BT-110
    expect(totals.taxInclusiveAmount).toBe(1785);
  });

  it("keeps LegalMonetaryTotal children in schema order", () => {
    const money = /<cac:LegalMonetaryTotal>[\s\S]*?<\/cac:LegalMonetaryTotal>/.exec(
      xml,
    )![0];
    expectOrder(money, [
      "cbc:LineExtensionAmount",
      "cbc:TaxExclusiveAmount",
      "cbc:TaxInclusiveAmount",
      "cbc:PayableAmount",
    ]);
  });

  it("stamps currencyID on every monetary amount", () => {
    const amounts = [
      ...xml.matchAll(/<cbc:(\w*Amount)([^>]*)>/g),
    ].filter(([, name]) => name !== "PayableRoundingAmount");
    expect(amounts.length).toBeGreaterThan(5);
    for (const [, name, attrs] of amounts) {
      expect(attrs, `${name} needs currencyID`).toContain('currencyID="EUR"');
    }
  });

  it("emits one TaxSubtotal per category-and-rate group, in document order", () => {
    const mixed = generateXRechnungUBL({
      ...minimal,
      lines: [
        { ...minimal.lines[0]!, id: "1", quantity: 1, unitPrice: 100, vatRate: 19 },
        {
          id: "2",
          description: "Printed handbook",
          quantity: 2,
          unitCode: "C62",
          unitPrice: 25,
          vatCategory: "S",
          vatRate: 7,
        },
        { ...minimal.lines[0]!, id: "3", quantity: 1, unitPrice: 50, vatRate: 19 },
      ],
    });
    const subtotals = [
      ...mixed.matchAll(/<cac:TaxSubtotal>[\s\S]*?<\/cac:TaxSubtotal>/g),
    ].map((m) => m[0]);
    expect(subtotals).toHaveLength(2);

    expect(textOf(subtotals[0]!, "cbc:TaxableAmount")).toBe("150.00");
    expect(textOf(subtotals[0]!, "cbc:TaxAmount")).toBe("28.50");
    expect(textOf(subtotals[0]!, "cbc:Percent")).toBe("19.00");

    expect(textOf(subtotals[1]!, "cbc:TaxableAmount")).toBe("50.00");
    expect(textOf(subtotals[1]!, "cbc:TaxAmount")).toBe("3.50");
    expect(textOf(subtotals[1]!, "cbc:Percent")).toBe("7.00");

    // BR-CO-14: document VAT total is the sum of the subtotal tax amounts.
    const money = /<cac:LegalMonetaryTotal>[\s\S]*?<\/cac:LegalMonetaryTotal>/.exec(
      mixed,
    )![0];
    expect(textOf(money, "cbc:TaxInclusiveAmount")).toBe("232.00");
    expect(textsOf(mixed, "cbc:TaxAmount")[0]).toBe("32.00");
  });

  it("emits one InvoiceLine per input line, keyed by BT-126", () => {
    const many = generateXRechnungUBL({
      ...minimal,
      lines: [
        { ...minimal.lines[0]!, id: "1" },
        { ...minimal.lines[0]!, id: "2" },
        { ...minimal.lines[0]!, id: "3" },
      ],
    });
    const lines = [...many.matchAll(/<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/g)];
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => textOf(l[0], "cbc:ID"))).toEqual(["1", "2", "3"]);
  });

  it("emits BaseQuantity only when the caller sets one (BT-149)", () => {
    expect(generateXRechnungUBL(minimal)).not.toContain("cbc:BaseQuantity");
    const perThousand = generateXRechnungUBL({
      ...minimal,
      lines: [{ ...minimal.lines[0]!, quantity: 5000, unitPrice: 3, baseQuantity: 1000 }],
    });
    expect(perThousand).toContain(
      '<cbc:BaseQuantity unitCode="HUR">1000.0000</cbc:BaseQuantity>',
    );
    expect(textOf(perThousand, "cbc:LineExtensionAmount")).toBe("15.00");
  });
});

describe("generateXRechnungUBL — reverse charge and exemptions", () => {
  const reverseCharge: InvoiceInput = {
    ...minimal,
    buyer: {
      name: "Beispiel BV",
      vatId: "NL123456789B01",
      address: {
        line1: "Keizersgracht 1",
        city: "Amsterdam",
        postalCode: "1015 CJ",
        countryCode: "NL",
      },
      electronicAddress: { schemeId: "9944", value: "NL123456789B01" },
    },
    lines: [
      {
        id: "1",
        description: "Cross-border consultancy",
        quantity: 8,
        unitCode: "HUR",
        unitPrice: 175,
        vatCategory: "AE",
        vatRate: 0,
      },
    ],
  };

  const xml = generateXRechnungUBL(reverseCharge);

  it("zero-rates the line and the document (BR-AE-05, BR-AE-09)", () => {
    expect(textOf(xml, "cbc:LineExtensionAmount")).toBe("1400.00");
    const money = /<cac:LegalMonetaryTotal>[\s\S]*?<\/cac:LegalMonetaryTotal>/.exec(
      xml,
    )![0];
    expect(textOf(money, "cbc:TaxExclusiveAmount")).toBe("1400.00");
    expect(textOf(money, "cbc:TaxInclusiveAmount")).toBe("1400.00");
    expect(textOf(money, "cbc:PayableAmount")).toBe("1400.00");
    expect(textsOf(xml, "cbc:TaxAmount")[0]).toBe("0.00");
  });

  it("emits the AE exemption reason required by BR-AE-10", () => {
    expect(textOf(xml, "cbc:TaxExemptionReason")).toBe("Reverse charge");
    const category = /<cac:TaxCategory>[\s\S]*?<\/cac:TaxCategory>/.exec(xml)![0];
    expectOrder(category, [
      "cbc:ID",
      "cbc:Percent",
      "cbc:TaxExemptionReason",
      "cac:TaxScheme",
    ]);
  });

  it("suppresses the exemption reason on S and Z breakdowns (BR-S-10, BR-Z-10)", () => {
    expect(generateXRechnungUBL(minimal)).not.toContain("TaxExemptionReason");
    const zero = generateXRechnungUBL({
      ...minimal,
      lines: [{ ...minimal.lines[0]!, vatCategory: "Z", vatRate: 0 }],
    });
    expect(zero).not.toContain("TaxExemptionReason");
  });

  it("omits Percent entirely for category O (BR-O-05)", () => {
    const notSubject = generateXRechnungUBL({
      ...minimal,
      seller: { ...minimal.seller, vatId: undefined },
      buyer: { ...minimal.buyer, vatId: undefined },
      lines: [
        { ...minimal.lines[0]!, vatCategory: "O", vatRate: undefined },
      ],
    });
    const category = /<cac:TaxCategory>[\s\S]*?<\/cac:TaxCategory>/.exec(
      notSubject,
    )![0];
    expect(category).toContain("<cbc:ID>O</cbc:ID>");
    expect(category).not.toContain("cbc:Percent");
    expect(textOf(notSubject, "cbc:TaxExemptionReason")).toBe("Not subject to VAT");
  });

  it("emits the delivery group for an intra-community supply (BT-72, BT-80)", () => {
    const ic = generateXRechnungUBL({
      ...reverseCharge,
      deliveryDate: "2026-08-05",
      deliverTo: { city: "Amsterdam", postalCode: "1015 CJ", countryCode: "nl" },
      lines: [{ ...reverseCharge.lines[0]!, vatCategory: "K", vatRate: 0 }],
    });
    const delivery = /<cac:Delivery>[\s\S]*?<\/cac:Delivery>/.exec(ic)![0];
    expect(textOf(delivery, "cbc:ActualDeliveryDate")).toBe("2026-08-05");
    expect(textOf(delivery, "cbc:IdentificationCode")).toBe("NL");
    expect(textOf(ic, "cbc:TaxExemptionReason")).toBe("Intra-Community supply");
  });
});

describe("generateXRechnungUBL — payment means", () => {
  it("emits BG-16 with the account and BIC (BT-81, BT-84, BT-85, BT-86)", () => {
    const xml = generateXRechnungUBL(minimal);
    const means = /<cac:PaymentMeans>[\s\S]*?<\/cac:PaymentMeans>/.exec(xml)![0];
    expect(textOf(means, "cbc:PaymentMeansCode")).toBe("58");
    expect(textOf(means, "cbc:ID")).toBe("DE02120300000000202051");
    expect(textOf(means, "cbc:Name")).toBe("Acme GmbH");
    expect(means).toContain("<cac:FinancialInstitutionBranch>");
    expect(textsOf(means, "cbc:ID")).toContain("BYLADEM1001");
  });

  it("carries the payment means name as an attribute (BT-82)", () => {
    const xml = generateXRechnungUBL({
      ...minimal,
      payment: { ...minimal.payment!, meansName: "SEPA credit transfer" },
    });
    expect(xml).toContain(
      '<cbc:PaymentMeansCode name="SEPA credit transfer">58</cbc:PaymentMeansCode>',
    );
  });

  it("emits a payment reference as PaymentID (BT-83)", () => {
    const xml = generateXRechnungUBL({
      ...minimal,
      payment: { ...minimal.payment!, remittanceInformation: "RF18 5390 0754 7034" },
    });
    expect(textOf(xml, "cbc:PaymentID")).toBe("RF18 5390 0754 7034");
  });
});

describe("generateXRechnungUBL — XML escaping", () => {
  const nasty: InvoiceInput = {
    ...minimal,
    invoiceNumber: 'R&D <2026> "spring" & co',
    note: "5 < 6 && 7 > 6",
    seller: {
      ...minimal.seller,
      name: "Müller & Söhne <GmbH>",
      electronicAddress: { schemeId: '99"30', value: "a&b" },
    },
    lines: [
      {
        ...minimal.lines[0]!,
        description: "Widget <A> & Widget 'B'",
      },
    ],
  };

  const xml = generateXRechnungUBL(nasty);

  it("escapes &, < and > in text content", () => {
    expect(xml).toContain(
      "<cbc:ID>R&amp;D &lt;2026&gt; \"spring\" &amp; co</cbc:ID>",
    );
    expect(textOf(xml, "cbc:Note")).toBe("5 &lt; 6 &amp;&amp; 7 &gt; 6");
    expect(xml).toContain("Müller &amp; Söhne &lt;GmbH&gt;");
  });

  it("escapes quotes inside attribute values", () => {
    expect(xml).toContain('schemeID="99&quot;30"');
    expect(xml).toContain(">a&amp;b<");
  });

  it("never emits a raw & or an unescaped angle bracket in text", () => {
    // Strip tags, then look for anything that should have been escaped.
    const textOnly = xml.replace(/<[^>]*>/g, "");
    expect(textOnly).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/);
    expect(textOnly).not.toMatch(/[<>]/);
  });

  it("stays well-formed with hostile input", () => {
    expect(isWellFormed(xml)).toBe(true);
    expect(isWellFormed(generateXRechnungUBL({
      ...nasty,
      note: "]]> <!-- <script> --> <?pi?>",
    }))).toBe(true);
  });

  it("strips control characters that cannot be escaped at all", () => {
    const withControl = generateXRechnungUBL({
      ...minimal,
      note: "line\u0000one\u0008two",
    });
    expect(textOf(withControl, "cbc:Note")).toBe("lineonetwo");
    expect(withControl).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  });
});

describe("generateXRechnungUBL — options", () => {
  it("honours a custom indent", () => {
    const compact = generateXRechnungUBL(minimal, { indent: "" });
    expect(compact).not.toMatch(/\n\s+</);
    expect(isWellFormed(compact)).toBe(true);
  });

  it("allows pinning a different CustomizationID", () => {
    const pinned = generateXRechnungUBL(minimal, {
      customizationId:
        "urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_2.3",
    });
    expect(textOf(pinned, "cbc:CustomizationID")).toContain("xrechnung_2.3");
  });
});

describe("generateXRechnungUBL — refusals", () => {
  it("generates every profile it claims to support", () => {
    for (const profile of UBL_GENERATABLE_PROFILES) {
      const xml = generateXRechnungUBL({ ...minimal, profile });
      expect(isWellFormed(xml)).toBe(true);
      expect(xml).toContain("<ubl:Invoice");
    }
  });

  it("throws on CII profiles instead of emitting UBL under a CII name", () => {
    for (const profile of ["xrechnung-cii", "facturx-en16931"] as const) {
      expect(() => generateXRechnungUBL({ ...minimal, profile })).toThrow(
        UnsupportedProfileError,
      );
    }
  });

  it("throws on an unknown profile rather than silently defaulting", () => {
    expect(() =>
      generateXRechnungUBL({
        ...minimal,
        profile: "zugferd-2.3" as unknown as InvoiceInput["profile"],
      }),
    ).toThrow(UnsupportedProfileError);
  });

  it("the profile error teaches what is and is not supported", () => {
    let caught: unknown;
    try {
      generateXRechnungUBL({ ...minimal, profile: "facturx-en16931" });
    } catch (e) {
      caught = e;
    }
    const err = caught as UnsupportedProfileError;
    expect(err).toBeInstanceOf(GenerationError);
    expect(err.code).toBe("unsupported_profile");
    expect(err.profile).toBe("facturx-en16931");
    expect(err.supportedProfiles).toContain("xrechnung-ubl");
    expect(err.message).toContain("xrechnung-ubl");
    expect(err.message).toContain("CII");
  });

  // ⚠ Replaced 2026-08-13. Until 0.4.0 this test asserted that a credit-note
  // BT-3 threw UnsupportedDocumentTypeError rather than emitting an
  // ubl:Invoice. Both halves of that were right at the time: an ubl:Invoice
  // carrying BT-3 = 381 fails BR-CL-01, so refusing was better than emitting
  // one. 0.5.0 emits the *third* option — the ubl:CreditNote the code actually
  // asks for — so the refusal has nothing left to protect against. The
  // assertion that survives unchanged is the one that mattered: BT-3 = 381
  // never produces an ubl:Invoice.
  it("emits a ubl:CreditNote, not an ubl:Invoice, for a credit-note type code", () => {
    const xml = generateXRechnungUBL({ ...minimal, invoiceTypeCode: "381" });
    expect(xml).toContain("<ubl:CreditNote");
    expect(xml).not.toContain("<ubl:Invoice");
    expect(xml).toContain(
      'xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"',
    );
    expect(textOf(xml, "cbc:CreditNoteTypeCode")).toBe("381");
    expect(xml).not.toContain("cbc:InvoiceTypeCode");
  });

  it("throws nothing at all for any code on the credit-note list", () => {
    // The refusal set was six hand-picked codes; the routing set is derived
    // from BR-CL-01's credit-note half, so it also covers the four this build
    // used to emit as an ubl:Invoice that KoSIT then rejected.
    for (const code of ["381", "261", "262", "296", "308", "396", "83", "420", "458", "532"]) {
      const xml = generateXRechnungUBL({ ...minimal, invoiceTypeCode: code });
      expect(textOf(xml, "cbc:CreditNoteTypeCode"), code).toBe(code);
    }
  });

  it("still generates the non-credit-note codes BR-DE-17 allows", () => {
    for (const code of ["380", "384", "326", "389", "875", "876", "877"]) {
      const xml = generateXRechnungUBL({ ...minimal, invoiceTypeCode: code });
      expect(textOf(xml, "cbc:InvoiceTypeCode")).toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------
// Wave B: the structures added with the full EN 16931 semantic model.
//
// Every assertion here is about *order*, not merely presence. UBL's content
// model is an xsd:sequence: a document carrying all the right elements in the
// wrong order is not a slightly-untidy document, it is schema-invalid, and it
// fails before a single business rule runs. The orders asserted below were
// taken from UBL-Invoice-2.1.xsd and UBL-CommonAggregateComponents-2.1.xsd.
// ---------------------------------------------------------------------------

/** Everything the model can express, so one document exercises every builder. */
const loaded: InvoiceInput = {
  ...minimal,
  deliveryDate: "2026-07-31",
  noteSubjectCode: "AAI",
  note: "Sammelrechnung.",
  taxPointDate: "2026-07-31",
  buyerAccountingReference: "Kostenstelle 4711",
  salesOrderReference: "SO-2026-1",
  projectReference: "PRJ-1",
  contractReference: "RV-1",
  despatchAdviceReference: "LS-1",
  receivingAdviceReference: "WE-1",
  tenderOrLotReference: "LOS-1",
  invoicedObjectIdentifier: { value: "OBJ-1", schemeId: "AAJ" },
  invoicingPeriod: { startDate: "2026-07-01", endDate: "2026-07-31" },
  precedingInvoices: [{ invoiceNumber: "2026-000141", issueDate: "2026-07-31" }],
  payee: {
    name: "Factoring Bank AG",
    identifier: { value: "4099999000001", schemeId: "0088" },
    legalRegistrationId: { value: "HRB 111", schemeId: "0060" },
  },
  taxRepresentative: {
    name: "Fiskalvertreter GmbH",
    vatId: "DE555555555",
    address: { city: "Hamburg", postalCode: "20095", countryCode: "DE" },
  },
  deliverToName: "Zentrallager Nord",
  deliverTo: { line1: "Lagerweg 3", city: "Hamburg", postalCode: "20095", countryCode: "DE" },
  deliverToLocationId: { value: "LOC-1", schemeId: "0088" },
  supportingDocuments: [
    {
      reference: "NACHWEIS-1",
      description: "Stundennachweis",
      attachment: {
        filename: "nachweis.pdf",
        mimeCode: "application/pdf",
        content: "JVBERi0xLjQK",
      },
    },
  ],
  allowances: [
    {
      amount: 50,
      baseAmount: 1000,
      percentage: 5,
      vatCategory: "S",
      vatRate: 19,
      reason: "Mengenrabatt",
      reasonCode: "95",
    },
  ],
  charges: [
    { amount: 20, vatCategory: "S", vatRate: 19, reason: "Versand", reasonCode: "FC" },
  ],
  paidAmount: 100,
  roundingAmount: -0.03,
  lines: [
    {
      ...minimal.lines[0]!,
      longDescription: "Fachliche Beratung zur E-Rechnung.",
      buyerAccountingReference: "KST-1",
      orderLineReference: "10",
      objectIdentifier: { value: "OBJ-L1", schemeId: "AAJ" },
      period: { startDate: "2026-07-01", endDate: "2026-07-31" },
      grossUnitPrice: 200,
      priceDiscount: 50,
      allowances: [{ amount: 10, baseAmount: 100, percentage: 10, reason: "Rabatt", reasonCode: "95" }],
      charges: [{ amount: 5, reason: "Eilzuschlag", reasonCode: "FC" }],
      sellerItemId: "SKU-1",
      buyerItemId: "MAT-1",
      standardItemId: { value: "04012345678901", schemeId: "0160" },
      itemClassifications: [{ code: "72154000", schemeId: "TSP", schemeVersion: "2008" }],
      originCountryCode: "DE",
      itemAttributes: [{ name: "Farbe", value: "blau" }],
    },
  ],
};

describe("generated UBL: document-level structures added in 0.2.0", () => {
  const xml = generateXRechnungUBL(loaded);

  it("is still well formed with every group populated", () => {
    expect(isWellFormed(xml)).toBe(true);
  });

  it("emits the root children in UBL Invoice sequence order", () => {
    expectOrder(xml, [
      "cbc:CustomizationID",
      "cbc:ProfileID",
      "cbc:ID",
      "cbc:IssueDate",
      "cbc:DueDate",
      "cbc:InvoiceTypeCode",
      "cbc:Note",
      "cbc:TaxPointDate",
      "cbc:DocumentCurrencyCode",
      "cbc:AccountingCost",
      "cbc:BuyerReference",
      "cac:InvoicePeriod",
      "cac:OrderReference",
      "cac:BillingReference",
      "cac:DespatchDocumentReference",
      "cac:ReceiptDocumentReference",
      "cac:OriginatorDocumentReference",
      "cac:ContractDocumentReference",
      "cac:AdditionalDocumentReference",
      "cac:ProjectReference",
      "cac:AccountingSupplierParty",
      "cac:AccountingCustomerParty",
      "cac:PayeeParty",
      "cac:TaxRepresentativeParty",
      "cac:Delivery",
      "cac:PaymentMeans",
      "cac:PaymentTerms",
      "cac:AllowanceCharge",
      "cac:TaxTotal",
      "cac:LegalMonetaryTotal",
      "cac:InvoiceLine",
    ]);
  });

  it("writes BT-21 into the note as #CODE#text, because UBL has no element for it", () => {
    expect(textOf(xml, "cbc:Note")).toBe("#AAI#Sammelrechnung.");
  });

  it("omits the subject-code prefix when no code is given", () => {
    const plain = generateXRechnungUBL({ ...loaded, noteSubjectCode: undefined });
    expect(textOf(plain, "cbc:Note")).toBe("Sammelrechnung.");
  });

  it("emits the invoicing period as StartDate then EndDate", () => {
    const period = /<cac:InvoicePeriod>([\s\S]*?)<\/cac:InvoicePeriod>/.exec(xml)![1]!;
    expectOrder(period, ["cbc:StartDate", "cbc:EndDate"]);
  });

  it("emits BG-3 as BillingReference / InvoiceDocumentReference with ID then IssueDate", () => {
    const ref = /<cac:BillingReference>([\s\S]*?)<\/cac:BillingReference>/.exec(xml)![1]!;
    expect(ref).toContain("<cac:InvoiceDocumentReference>");
    expectOrder(ref, ["cbc:ID", "cbc:IssueDate"]);
    expect(textsOf(ref, "cbc:ID")).toContain("2026-000141");
  });

  it("emits one BillingReference per preceding invoice", () => {
    const many = generateXRechnungUBL({
      ...loaded,
      precedingInvoices: [
        { invoiceNumber: "A" },
        { invoiceNumber: "B" },
      ],
    });
    expect((many.match(/<cac:BillingReference>/g) ?? []).length).toBe(2);
  });

  it("emits BT-18 as an AdditionalDocumentReference carrying DocumentTypeCode 130", () => {
    const refs = [...xml.matchAll(/<cac:AdditionalDocumentReference>([\s\S]*?)<\/cac:AdditionalDocumentReference>/g)];
    const object = refs.map((m) => m[1]!).find((body) => body.includes("OBJ-1"))!;
    expect(object).toContain('schemeID="AAJ"');
    expect(textOf(object, "cbc:DocumentTypeCode")).toBe("130");
    expectOrder(object, ["cbc:ID", "cbc:DocumentTypeCode"]);
  });

  it("emits an embedded attachment with mimeCode and filename inside cac:Attachment", () => {
    const refs = [...xml.matchAll(/<cac:AdditionalDocumentReference>([\s\S]*?)<\/cac:AdditionalDocumentReference>/g)];
    const doc = refs.map((m) => m[1]!).find((body) => body.includes("NACHWEIS-1"))!;
    expectOrder(doc, ["cbc:ID", "cbc:DocumentDescription", "cac:Attachment"]);
    const open = openTagOf(doc, "cbc:EmbeddedDocumentBinaryObject")!;
    expect(open).toContain('mimeCode="application/pdf"');
    expect(open).toContain('filename="nachweis.pdf"');
  });

  it("emits an external attachment reference as cac:ExternalReference/cbc:URI", () => {
    const external = generateXRechnungUBL({
      ...loaded,
      supportingDocuments: [
        { reference: "X", externalUri: "https://example.test/x.pdf" },
      ],
    });
    expect(external).toContain("<cac:ExternalReference>");
    expect(textOf(external, "cbc:URI")).toBe("https://example.test/x.pdf");
  });

  it("emits BG-10 as cac:PayeeParty with PartyIdentification, PartyName, PartyLegalEntity", () => {
    const payee = /<cac:PayeeParty>([\s\S]*?)<\/cac:PayeeParty>/.exec(xml)![1]!;
    expectOrder(payee, ["cac:PartyIdentification", "cac:PartyName", "cac:PartyLegalEntity"]);
    expect(textOf(payee, "cbc:Name")).toBe("Factoring Bank AG");
    // BG-10 is not wrapped in cac:Party — the element *is* the party.
    expect(payee).not.toContain("<cac:Party>");
  });

  it("emits BG-11 as cac:TaxRepresentativeParty with name, address, VAT scheme", () => {
    const rep = /<cac:TaxRepresentativeParty>([\s\S]*?)<\/cac:TaxRepresentativeParty>/.exec(xml)![1]!;
    expectOrder(rep, ["cac:PartyName", "cac:PostalAddress", "cac:PartyTaxScheme"]);
    expect(textOf(rep, "cbc:CompanyID")).toBe("DE555555555");
  });

  it("emits BT-29 as cac:PartyIdentification before cac:PartyName on the seller", () => {
    const seller = /<cac:AccountingSupplierParty>([\s\S]*?)<\/cac:AccountingSupplierParty>/.exec(
      generateXRechnungUBL({
        ...loaded,
        seller: { ...loaded.seller, identifier: { value: "GLN-1", schemeId: "0088" } },
      }),
    )![1]!;
    expectOrder(seller, ["cbc:EndpointID", "cac:PartyIdentification", "cac:PartyName"]);
  });

  it("puts BT-90, the SEPA creditor identifier, on the seller party rather than in BG-19", () => {
    const debit = generateXRechnungUBL({
      ...loaded,
      payment: {
        meansCode: "59",
        directDebit: {
          mandateReference: "MANDAT-1",
          creditorIdentifier: "DE98ZZZ09999999999",
          debitedAccount: "DE98700500001234567890",
        },
      },
    });
    const seller = /<cac:AccountingSupplierParty>([\s\S]*?)<\/cac:AccountingSupplierParty>/.exec(debit)![1]!;
    expect(seller).toContain('schemeID="SEPA"');
    expect(seller).toContain("DE98ZZZ09999999999");
    const means = /<cac:PaymentMeans>([\s\S]*?)<\/cac:PaymentMeans>/.exec(debit)![1]!;
    expect(means).toContain("<cac:PaymentMandate>");
    expectOrder(means, ["cbc:PaymentMeansCode", "cac:PaymentMandate"]);
    expect(means).toContain("<cac:PayerFinancialAccount>");
  });

  it("emits BG-18 as cac:CardAccount with the mandatory NetworkID UBL requires", () => {
    const card = generateXRechnungUBL({
      ...loaded,
      payment: { meansCode: "48", card: { primaryAccountNumber: "411111**1111", holderName: "M Muster" } },
    });
    const account = /<cac:CardAccount>([\s\S]*?)<\/cac:CardAccount>/.exec(card)![1]!;
    expectOrder(account, ["cbc:PrimaryAccountNumberID", "cbc:NetworkID", "cbc:HolderName"]);
    expect(textOf(account, "cbc:NetworkID")).toBe("NA");
  });

  it("emits the delivery group with date, location and party in schema order", () => {
    const delivery = /<cac:Delivery>([\s\S]*?)<\/cac:Delivery>/.exec(xml)![1]!;
    expectOrder(delivery, [
      "cbc:ActualDeliveryDate",
      "cac:DeliveryLocation",
      "cac:DeliveryParty",
    ]);
    const location = /<cac:DeliveryLocation>([\s\S]*?)<\/cac:DeliveryLocation>/.exec(delivery)![1]!;
    expectOrder(location, ["cbc:ID", "cac:Address"]);
  });
});

describe("generated UBL: allowances and charges", () => {
  const xml = generateXRechnungUBL(loaded);

  it("emits document allowances before document charges, both after PaymentTerms", () => {
    const bodies = [...xml.matchAll(/<cac:AllowanceCharge>([\s\S]*?)<\/cac:AllowanceCharge>/g)].map(
      (m) => m[1]!,
    );
    // Two on the line (allowance, charge), one price allowance, two on the
    // document — but the document ones come first in the serialised order,
    // because cac:AllowanceCharge precedes cac:InvoiceLine in the sequence.
    const documentLevel = bodies.filter((b) => b.includes("cac:TaxCategory"));
    expect(documentLevel.length).toBe(2);
    expect(textOf(documentLevel[0]!, "cbc:ChargeIndicator")).toBe("false");
    expect(textOf(documentLevel[1]!, "cbc:ChargeIndicator")).toBe("true");
  });

  it("emits ChargeIndicator as the literal true/false the schematron matches on", () => {
    // `cbc:ChargeIndicator = true()` in XPath does not match "1" or "Y", so a
    // charge written any other way falls out of every BG-21 rule silently.
    for (const value of textsOf(xml, "cbc:ChargeIndicator")) {
      expect(["true", "false"]).toContain(value);
    }
  });

  it("emits a document allowance's children in AllowanceCharge sequence order", () => {
    const first = /<cac:AllowanceCharge>([\s\S]*?)<\/cac:AllowanceCharge>/.exec(xml)![1]!;
    expectOrder(first, [
      "cbc:ChargeIndicator",
      "cbc:AllowanceChargeReasonCode",
      "cbc:AllowanceChargeReason",
      "cbc:MultiplierFactorNumeric",
      "cbc:Amount",
      "cbc:BaseAmount",
      "cac:TaxCategory",
    ]);
  });

  it("gives a document allowance a TaxCategory and a line allowance none", () => {
    // BG-27/BG-28 inherit the VAT treatment of their line. An explicit category
    // there would create a breakdown group EN 16931 does not recognise.
    const line = /<cac:InvoiceLine>([\s\S]*?)<\/cac:InvoiceLine>/.exec(xml)![1]!;
    const lineAllowances = [...line.matchAll(/<cac:AllowanceCharge>([\s\S]*?)<\/cac:AllowanceCharge>/g)].map(
      (m) => m[1]!,
    );
    expect(lineAllowances.length).toBeGreaterThanOrEqual(2);
    for (const body of lineAllowances) expect(body).not.toContain("cac:TaxCategory");
  });

  it("emits line allowances before line charges and both before cac:Item", () => {
    const line = /<cac:InvoiceLine>([\s\S]*?)<\/cac:InvoiceLine>/.exec(xml)![1]!;
    expectOrder(line, [
      "cbc:ID",
      "cbc:InvoicedQuantity",
      "cbc:LineExtensionAmount",
      "cbc:AccountingCost",
      "cac:InvoicePeriod",
      "cac:OrderLineReference",
      "cac:DocumentReference",
      "cac:AllowanceCharge",
      "cac:Item",
      "cac:Price",
    ]);
    const first = /<cac:AllowanceCharge>([\s\S]*?)<\/cac:AllowanceCharge>/.exec(line)![1]!;
    expect(textOf(first, "cbc:ChargeIndicator")).toBe("false");
  });

  it("carries BT-107 and BT-108 in LegalMonetaryTotal, in schema order", () => {
    const total = /<cac:LegalMonetaryTotal>([\s\S]*?)<\/cac:LegalMonetaryTotal>/.exec(xml)![1]!;
    expectOrder(total, [
      "cbc:LineExtensionAmount",
      "cbc:TaxExclusiveAmount",
      "cbc:TaxInclusiveAmount",
      "cbc:AllowanceTotalAmount",
      "cbc:ChargeTotalAmount",
      "cbc:PrepaidAmount",
      "cbc:PayableRoundingAmount",
      "cbc:PayableAmount",
    ]);
    expect(textOf(total, "cbc:AllowanceTotalAmount")).toBe("50.00");
    expect(textOf(total, "cbc:ChargeTotalAmount")).toBe("20.00");
  });

  it("omits BT-107 and BT-108 entirely when there are no allowances or charges", () => {
    // BR-CO-13's schematron branches on their presence. A 0.00 total asserts
    // that the document has allowances summing to nothing, which is a different
    // claim from having none.
    const plain = generateXRechnungUBL(minimal);
    expect(plain).not.toContain("cbc:AllowanceTotalAmount");
    expect(plain).not.toContain("cbc:ChargeTotalAmount");
  });

  it("emits a negative rounding amount rather than absorbing it into the payable amount", () => {
    const total = /<cac:LegalMonetaryTotal>([\s\S]*?)<\/cac:LegalMonetaryTotal>/.exec(xml)![1]!;
    expect(textOf(total, "cbc:PayableRoundingAmount")).toBe("-0.03");
    expect(textOf(total, "cbc:PrepaidAmount")).toBe("100.00");
  });

  it("expresses a gross price and its discount as an allowance on cac:Price", () => {
    const price = /<cac:Price>([\s\S]*?)<\/cac:Price>/.exec(xml)![1]!;
    expectOrder(price, ["cbc:PriceAmount", "cac:AllowanceCharge"]);
    const allowance = /<cac:AllowanceCharge>([\s\S]*?)<\/cac:AllowanceCharge>/.exec(price)![1]!;
    expect(textOf(allowance, "cbc:ChargeIndicator")).toBe("false");
    expect(textOf(allowance, "cbc:Amount")).toBe("50.00");
    expect(textOf(allowance, "cbc:BaseAmount")).toBe("200.00");
  });
});

describe("generated UBL: item detail and the VAT accounting currency", () => {
  const xml = generateXRechnungUBL(loaded);

  it("emits cac:Item children in schema order", () => {
    const item = /<cac:Item>([\s\S]*?)<\/cac:Item>/.exec(xml)![1]!;
    expectOrder(item, [
      "cbc:Description",
      "cbc:Name",
      "cac:BuyersItemIdentification",
      "cac:SellersItemIdentification",
      "cac:StandardItemIdentification",
      "cac:OriginCountry",
      "cac:CommodityClassification",
      "cac:ClassifiedTaxCategory",
      "cac:AdditionalItemProperty",
    ]);
  });

  it("carries the classification scheme on @listID and its version on @listVersionID", () => {
    const open = openTagOf(xml, "cbc:ItemClassificationCode")!;
    expect(open).toContain('listID="TSP"');
    expect(open).toContain('listVersionID="2008"');
  });

  it("emits item attributes as Name/Value pairs", () => {
    const property = /<cac:AdditionalItemProperty>([\s\S]*?)<\/cac:AdditionalItemProperty>/.exec(xml)![1]!;
    expectOrder(property, ["cbc:Name", "cbc:Value"]);
    expect(textOf(property, "cbc:Value")).toBe("blau");
  });

  it("emits BT-6 as cbc:TaxCurrencyCode and BT-111 as a second TaxTotal", () => {
    const dual = generateXRechnungUBL({
      ...loaded,
      vatAccountingCurrency: "SEK",
      taxAmountInAccountingCurrency: 3245.5,
    });
    expect(textOf(dual, "cbc:TaxCurrencyCode")).toBe("SEK");
    expectOrder(dual, ["cbc:DocumentCurrencyCode", "cbc:TaxCurrencyCode"]);
    const totals = [...dual.matchAll(/<cac:TaxTotal>([\s\S]*?)<\/cac:TaxTotal>/g)].map((m) => m[1]!);
    expect(totals.length).toBe(2);
    // The document-currency total carries the breakdown; the second carries
    // nothing but the amount, which is where BR-53 and BR-DEC-15 look.
    expect(totals[0]).toContain("cac:TaxSubtotal");
    expect(totals[1]).not.toContain("cac:TaxSubtotal");
    expect(openTagOf(totals[1]!, "cbc:TaxAmount")).toContain('currencyID="SEK"');
    expect(textOf(totals[1]!, "cbc:TaxAmount")).toBe("3245.50");
  });

  it("omits the second TaxTotal when only one of BT-6 / BT-111 is given", () => {
    const only = generateXRechnungUBL({ ...loaded, vatAccountingCurrency: "SEK" });
    expect((only.match(/<cac:TaxTotal>/g) ?? []).length).toBe(1);
  });

  it("emits BT-121 before BT-120 inside cac:TaxCategory", () => {
    const coded = generateXRechnungUBL({
      ...loaded,
      lines: [{ ...loaded.lines[0]!, vatCategory: "E", vatRate: 0 }],
      allowances: undefined,
      charges: undefined,
      vatExemptionReasons: { E: "Steuerfrei nach §4 Nr. 21 UStG" },
      vatExemptionReasonCodes: { E: "VATEX-EU-132-1I" },
    });
    const category = /<cac:TaxSubtotal>[\s\S]*?<cac:TaxCategory>([\s\S]*?)<\/cac:TaxCategory>/.exec(coded)![1]!;
    expectOrder(category, [
      "cbc:ID",
      "cbc:Percent",
      "cbc:TaxExemptionReasonCode",
      "cbc:TaxExemptionReason",
      "cac:TaxScheme",
    ]);
  });

  it("keeps the whole loaded document's arithmetic self-consistent", () => {
    const totals = computeTotals(loaded);
    const monetary = /<cac:LegalMonetaryTotal>([\s\S]*?)<\/cac:LegalMonetaryTotal>/.exec(xml)![1]!;
    expect(textOf(monetary, "cbc:LineExtensionAmount")).toBe(
      totals.lineExtensionAmount.toFixed(2),
    );
    expect(textOf(monetary, "cbc:TaxExclusiveAmount")).toBe(
      totals.taxExclusiveAmount.toFixed(2),
    );
    expect(textOf(monetary, "cbc:PayableAmount")).toBe(totals.payableAmount.toFixed(2));
  });
});

// ---------------------------------------------------------------------------
// Findings 7, 8 and 11, both syntaxes. Every expectation here was put to KoSIT
// 1.6.2 with the XRechnung 3.0.2 configuration on 2026-08-12; findings 7 and 8
// shipped in 0.3.0.
// ---------------------------------------------------------------------------

describe("prices and rates in the emitted document (findings 7, 8, 11)", () => {
  const priced = (patch: Partial<InvoiceInput["lines"][number]>): InvoiceInput => ({
    ...minimal,
    lines: [{ ...minimal.lines[0]!, ...patch }],
  });

  it("writes BT-146 at its own precision, not rounded to two decimals", () => {
    // Before: `<cbc:PriceAmount>0.03</cbc:PriceAmount>` beside a line total of
    // 345.00, so the document read 10000 x 0.03 = 345.00. KoSIT accepted it —
    // no rule ties BT-146 to BT-131 — so nothing downstream would have caught
    // the 71% error in the price a human reads.
    const inv = priced({ quantity: 10000, unitPrice: 0.0345 });
    const ubl = generateXRechnungUBL(inv);
    expect(ubl).toContain(`<cbc:PriceAmount currencyID="EUR">0.0345</cbc:PriceAmount>`);
    expect(ubl).toContain(
      `<cbc:LineExtensionAmount currencyID="EUR">345.00</cbc:LineExtensionAmount>`,
    );
    const cii = generateCii({ ...inv, profile: "xrechnung-cii" });
    expect(cii).toContain("<ram:ChargeAmount>0.0345</ram:ChargeAmount>");
    expect(cii).toContain("<ram:LineTotalAmount>345.00</ram:LineTotalAmount>");
  });

  it("round-trips a fractional price through generate → parse → validate", () => {
    // The round trip is what surfaced this: it came back `valid: false` with
    // five BR-CO failures, because the parser read 0.03 and recomputed 300.00.
    const inv = priced({ quantity: 10000, unitPrice: 0.0345 });
    for (const [xml, parse] of [
      [generateXRechnungUBL(inv), parseUblInvoice],
      [generateCii({ ...inv, profile: "xrechnung-cii" }), parseCiiInvoice],
    ] as const) {
      const parsed = parse(xml).invoice;
      expect(parsed.lines[0]!.unitPrice).toBe(0.0345);
      expect(validateInput(parsed).errors).toEqual([]);
    }
  });

  it("writes BT-147 and BT-148 at their own precision too", () => {
    const inv = priced({
      quantity: 1000,
      unitPrice: 0.0345,
      grossUnitPrice: 0.0405,
      priceDiscount: 0.006,
    });
    expect(generateXRechnungUBL(inv)).toContain(
      `<cbc:BaseAmount currencyID="EUR">0.0405</cbc:BaseAmount>`,
    );
    expect(generateXRechnungUBL(inv)).toContain(
      `<cbc:Amount currencyID="EUR">0.006</cbc:Amount>`,
    );
    const cii = generateCii({ ...inv, profile: "xrechnung-cii" });
    expect(cii).toContain("<ram:ChargeAmount>0.0405</ram:ChargeAmount>");
    expect(cii).toContain("<ram:ActualAmount>0.006</ram:ActualAmount>");
  });

  it("writes BT-119 and BT-117 from one number", () => {
    // Before: `Percent 16.66` (toFixed truncates; half-up is 16.67, so it was
    // wrong twice) against a VAT amount computed at the full 16.665%. KoSIT
    // REJECTED with [BR-CO-17, BR-S-09] in both syntaxes once the base cleared
    // the rule's ±1 tolerance, which it does above roughly 20,000.
    const inv = priced({ quantity: 1, unitPrice: 100000, vatRate: 16.665 });
    const ubl = generateXRechnungUBL(inv);
    expect(ubl).toContain("<cbc:Percent>16.67</cbc:Percent>");
    expect(ubl).toContain(`<cbc:TaxAmount currencyID="EUR">16670.00</cbc:TaxAmount>`);
    expect(ubl).not.toContain("16.66<");
    const cii = generateCii({ ...inv, profile: "xrechnung-cii" });
    expect(cii).toContain("<ram:RateApplicablePercent>16.67</ram:RateApplicablePercent>");
    expect(cii).toContain("<ram:CalculatedAmount>16670.00</ram:CalculatedAmount>");
    // And the document validates, which it did not before.
    expect(validateInput(inv).errors).toEqual([]);
  });

  it("zero-normalises a document allowance's rate the way the breakdown does", () => {
    // Finding 11: the line path normalised and the document path did not, so
    // an allowance in an exempt category emitted 19.00 against an E @ 0.00
    // breakdown — the two halves of one document disagreeing.
    const inv: InvoiceInput = {
      ...minimal,
      lines: [{ ...minimal.lines[0]!, vatCategory: "E", vatRate: 0 }],
      allowances: [{ amount: 10, reason: "Rabatt", vatCategory: "E", vatRate: 19 }],
      vatExemptionReasons: { E: "Exempt under Article 132 of Directive 2006/112/EC" },
    };
    const ubl = generateXRechnungUBL(inv);
    expect(ubl).not.toContain("<cbc:Percent>19.00</cbc:Percent>");
    const cii = generateCii({ ...inv, profile: "xrechnung-cii" });
    expect(cii).not.toContain("<ram:RateApplicablePercent>19.00</ram:RateApplicablePercent>");
    // Both documents are ACCEPTABLE to KoSIT, zero findings, in both syntaxes.
    expect(cii.match(/<ram:RateApplicablePercent>[^<]*</g)?.every((m) => m.includes("0.00"))).toBe(
      true,
    );
  });
});
