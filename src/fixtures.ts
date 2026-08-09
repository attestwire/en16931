import type { InvoiceInput } from "./types.js";

/**
 * Canonical example invoices. These are the inputs behind `fixtures/*.xml`, and
 * are exported so downstream tests can reuse a known-good starting point.
 */

/** A minimal domestic German XRechnung: one standard-rated line, 19% VAT. */
export const minimalXRechnung: InvoiceInput = {
  profile: "xrechnung-ubl",
  invoiceNumber: "2026-000142",
  issueDate: "2026-08-09",
  dueDate: "2026-09-08",
  currency: "EUR",
  invoiceTypeCode: "380",
  buyerReference: "04011000-1234512345-06",
  orderReference: "BEST-2026-0451",
  deliveryDate: "2026-08-07",
  seller: {
    name: "Musterlieferant GmbH",
    vatId: "DE123456789",
    taxRegistrationId: "181/815/08155",
    legalRegistrationId: "HRB 12345 B",
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
      email: "rechnungen@musterlieferant.example",
    },
  },
  buyer: {
    name: "Bundesamt für Musterangelegenheiten",
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
    meansName: "SEPA credit transfer",
    iban: "DE02120300000000202051",
    accountName: "Musterlieferant GmbH",
    bic: "BYLADEM1001",
    remittanceInformation: "2026-000142",
  },
  paymentTerms: "Zahlbar innerhalb von 30 Tagen ohne Abzug.",
  lines: [
    {
      id: "1",
      description: "Senior-Beratungsleistung",
      longDescription:
        "Fachliche Beratung zur Einführung der elektronischen Rechnungsstellung.",
      quantity: 10,
      unitCode: "HUR",
      unitPrice: 150,
      vatCategory: "S",
      vatRate: 19,
    },
    {
      id: "2",
      description: "Projekthandbuch (gedruckt)",
      quantity: 4,
      unitCode: "C62",
      unitPrice: 24.95,
      vatCategory: "S",
      vatRate: 7,
    },
  ],
};

/**
 * A cross-border reverse-charge invoice: German seller, Dutch business buyer,
 * VAT category AE. Exercises BR-AE-05/09/10 and the zero-VAT total path.
 */
export const reverseChargeXRechnung: InvoiceInput = {
  profile: "xrechnung-ubl",
  invoiceNumber: "2026-000143",
  issueDate: "2026-08-09",
  dueDate: "2026-09-08",
  currency: "EUR",
  invoiceTypeCode: "380",
  buyerReference: "PO-NL-2026-0088",
  note: "Steuerschuldnerschaft des Leistungsempfängers / Reverse charge.",
  seller: {
    name: "Musterlieferant GmbH",
    vatId: "DE123456789",
    legalRegistrationId: "HRB 12345 B",
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
      email: "rechnungen@musterlieferant.example",
    },
  },
  buyer: {
    name: "Voorbeeld Handelsmaatschappij B.V.",
    vatId: "NL123456789B01",
    address: {
      line1: "Keizersgracht 1",
      city: "Amsterdam",
      postalCode: "1015 CJ",
      countryCode: "NL",
    },
    electronicAddress: { schemeId: "9944", value: "NL123456789B01" },
  },
  payment: {
    meansCode: "58",
    meansName: "SEPA credit transfer",
    iban: "DE02120300000000202051",
    accountName: "Musterlieferant GmbH",
    bic: "BYLADEM1001",
  },
  paymentTerms: "Payable within 30 days. VAT reverse charged to the recipient.",
  deliveryDate: "2026-08-05",
  deliverTo: {
    line1: "Keizersgracht 1",
    city: "Amsterdam",
    postalCode: "1015 CJ",
    countryCode: "NL",
  },
  lines: [
    {
      id: "1",
      description: "Cross-border advisory services",
      quantity: 8,
      unitCode: "HUR",
      unitPrice: 175,
      vatCategory: "AE",
      vatRate: 0,
    },
    {
      id: "2",
      description: "Workshop facilitation",
      quantity: 1.5,
      unitCode: "DAY",
      unitPrice: 1200,
      vatCategory: "AE",
      vatRate: 0,
    },
  ],
};
