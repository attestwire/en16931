import { describe, expect, it } from "vitest";
import { generateXRechnungUBL, computeTotals } from "./index.js";
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

/** Index of the first occurrence of `<tag`, for ordering assertions. */
function posOf(xml: string, tag: string): number {
  return xml.indexOf(`<${tag}`);
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
