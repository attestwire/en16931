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

/**
 * A German B2B final invoice (Schlussrechnung) exercising the parts of the
 * model wave B added — and the one shape the 0.1.x model could not express at
 * all, which is an invoice with a discount on it.
 *
 * It is deliberately the awkward case rather than a showcase:
 *
 *   - a **line allowance** (BG-27) on line 3, so BT-131 is not quantity times
 *     price;
 *   - a **document allowance** (BG-20) and a **document charge** (BG-21), both
 *     in the 19% group, so BT-109 is not BT-106 and the 19% taxable amount is
 *     not the sum of its lines;
 *   - two VAT rates, so the breakdown has two groups and the allowance lands in
 *     exactly one of them;
 *   - an **invoicing period** (BG-14) rather than a delivery date, which is the
 *     route BR-DE-TMP-32 wants for a service billed monthly;
 *   - a **preceding invoice reference** (BG-3) to the partial invoice
 *     (Abschlagsrechnung) this one settles, together with the **paid amount**
 *     (BT-113) that was collected against it;
 *   - a **rounding amount** (BT-114) taking the payable figure to a whole euro,
 *     which is the only lawful way to do that — adjusting a line or a total to
 *     make the sum come out round breaks BR-CO-10 or BR-CO-13.
 *
 * The arithmetic, written out because it is the point of the fixture:
 *
 *   BT-106  1 500.00 + 99.80 + 270.00                    = 1 869.80
 *   BT-107  document allowance, 3% of 1 770.00           =    53.10
 *   BT-108  document charge, freight                     =    24.90
 *   BT-109  1 869.80 − 53.10 + 24.90                     = 1 841.60
 *   BG-23   S 19%: 1 500.00 + 270.00 − 53.10 + 24.90     = 1 741.80 → VAT 330.94
 *           S  7%: 99.80                                 =    99.80 → VAT   6.99
 *   BT-110  330.94 + 6.99                                =   337.93
 *   BT-112  1 841.60 + 337.93                            = 2 179.53
 *   BT-115  2 179.53 − 500.00 (BT-113) + 0.47 (BT-114)   = 1 680.00
 */
export const discountedXRechnung: InvoiceInput = {
  profile: "xrechnung-ubl",
  invoiceNumber: "2026-000144",
  issueDate: "2026-08-09",
  dueDate: "2026-09-08",
  currency: "EUR",
  invoiceTypeCode: "380",
  buyerReference: "PO-2026-0771",
  note: "Schlussrechnung zum Projekt E-Rechnung. Die Abschlagsrechnung 2026-000118 ist verrechnet.",
  noteSubjectCode: "AAI",
  orderReference: "BEST-2026-0771",
  contractReference: "RV-2024-0088",
  projectReference: "PRJ-ERECHNUNG-2026",
  buyerAccountingReference: "Kostenstelle 4711",
  invoicingPeriod: { startDate: "2026-07-01", endDate: "2026-07-31" },
  precedingInvoices: [
    { invoiceNumber: "2026-000118", issueDate: "2026-07-15" },
  ],
  seller: {
    name: "Musterlieferant GmbH",
    vatId: "DE123456789",
    taxRegistrationId: "181/815/08155",
    legalRegistrationId: "HRB 12345 B",
    legalRegistrationSchemeId: "0060",
    identifier: { value: "4012345000009", schemeId: "0088" },
    additionalLegalInformation:
      "Sitz: Berlin. Geschäftsführer: Erika Mustermann. Amtsgericht Charlottenburg.",
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
    name: "Beispiel Industrie AG",
    vatId: "DE987654321",
    legalRegistrationId: "HRB 98765",
    legalRegistrationSchemeId: "0060",
    identifier: { value: "4098765000004", schemeId: "0088" },
    address: {
      line1: "Industriering 42",
      line2: "Gebäude C",
      city: "Stuttgart",
      postalCode: "70173",
      countryCode: "DE",
    },
    electronicAddress: { schemeId: "9930", value: "DE987654321" },
    contact: {
      name: "Kreditorenbuchhaltung",
      phone: "+49 711 9876543",
      email: "kreditoren@beispiel-industrie.example",
    },
  },
  payment: {
    meansCode: "58",
    meansName: "SEPA credit transfer",
    iban: "DE02120300000000202051",
    accountName: "Musterlieferant GmbH",
    bic: "BYLADEM1001",
    remittanceInformation: "2026-000144",
  },
  paymentTerms:
    "Zahlbar innerhalb von 30 Tagen ohne Abzug.\n#SKONTO#TAGE=14#PROZENT=2.00#\n",
  supportingDocuments: [
    {
      reference: "STUNDENNACHWEIS-2026-07",
      description: "Stundennachweis Juli 2026",
      externalUri:
        "https://portal.musterlieferant.example/nachweise/2026-07.pdf",
    },
  ],
  allowances: [
    {
      amount: 53.1,
      baseAmount: 1770,
      percentage: 3,
      vatCategory: "S",
      vatRate: 19,
      reason: "Mengenrabatt",
      reasonCode: "95",
    },
  ],
  charges: [
    {
      amount: 24.9,
      vatCategory: "S",
      vatRate: 19,
      reason: "Versandkosten",
      reasonCode: "FC",
    },
  ],
  paidAmount: 500,
  roundingAmount: 0.47,
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
      buyerAccountingReference: "Kostenstelle 4711",
      period: { startDate: "2026-07-01", endDate: "2026-07-31" },
      itemClassifications: [{ code: "72154000", schemeId: "TSP" }],
    },
    {
      id: "2",
      description: "Projekthandbuch (gedruckt)",
      quantity: 4,
      unitCode: "C62",
      unitPrice: 24.95,
      vatCategory: "S",
      vatRate: 7,
      sellerItemId: "HB-2026",
      standardItemId: { value: "04012345678901", schemeId: "0160" },
      originCountryCode: "DE",
      itemAttributes: [
        { name: "Einband", value: "Hardcover" },
        { name: "Seitenzahl", value: "248" },
      ],
    },
    {
      id: "3",
      description: "Wartungspauschale Juli 2026",
      quantity: 1,
      unitCode: "MON",
      unitPrice: 300,
      vatCategory: "S",
      vatRate: 19,
      period: { startDate: "2026-07-01", endDate: "2026-07-31" },
      allowances: [
        {
          amount: 30,
          baseAmount: 300,
          percentage: 10,
          reason: "Einführungsrabatt",
          reasonCode: "95",
        },
      ],
    },
  ],
};
