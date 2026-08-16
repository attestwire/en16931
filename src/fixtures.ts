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
    identifier: { value: "4098765000003", schemeId: "0088" },
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

/**
 * A minimal credit note: the invoice above, credited in full.
 *
 * One field separates this from `minimalXRechnung` in substance — BT-3 is "381"
 * rather than "380" — and that one field changes the *document*: UBL emits
 * `ubl:CreditNote` in the CreditNote-2 namespace with `cbc:CreditNoteTypeCode`
 * and `cac:CreditNoteLine` / `cbc:CreditedQuantity`, while CII emits the same
 * `rsm:CrossIndustryInvoice` with `ram:TypeCode` 381. Holding the two side by
 * side is what makes that asymmetry visible in `fixtures/`.
 *
 * Three things about it are deliberate:
 *
 *   - **The amounts are positive.** EN 16931 credit notes state positive figures
 *     and let the document type carry the direction. A fixture with negative
 *     line totals would be teaching the wrong idiom in the most visible place
 *     the package has.
 *   - **BG-3 names the invoice being credited.** No rule requires it — BR-DE-26
 *     fires on BT-3 = 384 and nothing else — but a credit note that does not say
 *     what it credits cannot be reconciled by the buyer, so the ordinary case is
 *     the one worth shipping.
 *   - **BT-9 is present, with payment instructions.** That is the pair the UBL
 *     credit-note binding needs: the due date has no `cbc:DueDate` to live in
 *     and goes into `cac:PaymentMeans/cbc:PaymentDueDate`, which is a real
 *     difference from the invoice document and one only a fixture will catch.
 */
export const creditNoteXRechnung: InvoiceInput = {
  ...minimalXRechnung,
  invoiceNumber: "2026-G00021",
  invoiceTypeCode: "381",
  note: "Gutschrift zur Rechnung 2026-000142. Die Leistung wurde nicht erbracht.",
  precedingInvoices: [
    { invoiceNumber: "2026-000142", issueDate: "2026-08-09" },
  ],
  payment: {
    ...minimalXRechnung.payment!,
    remittanceInformation: "2026-G00021",
  },
  paymentTerms: "Der Betrag wird innerhalb von 14 Tagen erstattet.",
};

/**
 * A partial credit note with the awkward shapes on it: the `discounted`
 * invoice's structure, credited.
 *
 * It mirrors `discountedXRechnung` deliberately — a line allowance (BG-27), a
 * document allowance (BG-20) and a document charge (BG-21) in the 19% group, and
 * two VAT rates so the breakdown has two groups — so the two documents can be
 * diffed against each other and every difference is either the type code, the
 * root element or the line element. What it drops is the prepayment (BT-113) and
 * the rounding amount (BT-114): both are lawful on a credit note and neither
 * means anything on one, and a fixture should not model a thing nobody does.
 *
 * The arithmetic, written out because it is the point of the fixture:
 *
 *   BT-106  1 500.00 + 99.80 + 270.00                    = 1 869.80
 *   BT-107  document allowance, 3% of 1 770.00           =    53.10
 *   BT-108  document charge, restocking                  =    24.90
 *   BT-109  1 869.80 − 53.10 + 24.90                     = 1 841.60
 *   BG-23   S 19%: 1 500.00 + 270.00 − 53.10 + 24.90     = 1 741.80 → VAT 330.94
 *           S  7%: 99.80                                 =    99.80 → VAT   6.99
 *   BT-110  330.94 + 6.99                                =   337.93
 *   BT-112  1 841.60 + 337.93                            = 2 179.53
 *   BT-115  2 179.53                                     = 2 179.53
 *
 * Every one of those figures is a *credit*: the seller owes the buyer 2 179.53,
 * and the document says so with the type code, not with a minus sign.
 */
export const creditNoteDiscountXRechnung: InvoiceInput = {
  ...discountedXRechnung,
  invoiceNumber: "2026-G00022",
  invoiceTypeCode: "381",
  note: "Teilgutschrift zur Rechnung 2026-000144 wegen Mängelrüge.",
  noteSubjectCode: "AAI",
  precedingInvoices: [
    { invoiceNumber: "2026-000144", issueDate: "2026-08-09" },
  ],
  // BT-113 and BT-114 removed: a prepayment against a credit note, and a
  // rounding adjustment on a refund, are shapes nobody issues.
  paidAmount: undefined,
  roundingAmount: undefined,
  // BT-11 has no element on a UBL CreditNote at all (see
  // ATW-CREDIT-NOTE-PROJECT-REFERENCE-UNBOUND). The invoice this mirrors carries
  // one; carrying it here would make the fixture emit a warning, and a committed
  // fixture is asserted to produce no findings of any severity.
  projectReference: undefined,
  payment: {
    ...discountedXRechnung.payment!,
    remittanceInformation: "2026-G00022",
  },
  paymentTerms: "Der Betrag wird innerhalb von 14 Tagen erstattet.",
  charges: [
    {
      amount: 24.9,
      vatCategory: "S",
      vatRate: 19,
      reason: "Wiedereinlagerung",
      reasonCode: "FC",
    },
  ],
};

/**
 * The same three invoices, in the CII syntax.
 *
 * They are the UBL fixtures with `profile` switched, and that is the point: one
 * `InvoiceInput` produces either syntax, so the two generators can be held
 * against each other on identical business content. `xrechnung-cii` and
 * `xrechnung-ubl` share a CIUS — the German rules are syntax-independent — so
 * these validate identically to their UBL twins.
 *
 * Each of the three is emitted to `fixtures/xrechnung-cii-*.xml` and checked
 * against the official KoSIT validator, which has a CII scenario of its own.
 */
export const minimalXRechnungCii: InvoiceInput = {
  ...minimalXRechnung,
  profile: "xrechnung-cii",
};

export const reverseChargeXRechnungCii: InvoiceInput = {
  ...reverseChargeXRechnung,
  profile: "xrechnung-cii",
};

export const discountedXRechnungCii: InvoiceInput = {
  ...discountedXRechnung,
  profile: "xrechnung-cii",
};

/**
 * The two credit notes in CII, on the same terms: `profile` switched and
 * nothing else.
 *
 * These are the pair that shows what "CII has no separate credit-note document"
 * means in practice. Diff `xrechnung-cii-credit-note.xml` against
 * `xrechnung-cii-minimal.xml` and the structural difference is three digits in
 * `ram:TypeCode`; diff the UBL twins and it is the root element, the namespace,
 * the type-code element, the line element, the quantity element, the position of
 * the tax point date and the home of BT-9.
 */
export const creditNoteXRechnungCii: InvoiceInput = {
  ...creditNoteXRechnung,
  profile: "xrechnung-cii",
};

export const creditNoteDiscountXRechnungCii: InvoiceInput = {
  ...creditNoteDiscountXRechnung,
  profile: "xrechnung-cii",
};

/**
 * A wide CII invoice, built to put the groups the other three do not reach in
 * front of the official validator.
 *
 * The three fixtures above are the same business documents in two syntaxes,
 * which is what makes them useful for comparing the generators — but it also
 * means whole branches of the CII mapping were never seen by KoSIT. This one
 * exists to fix that, and it is deliberately unglamorous rather than realistic.
 * What it adds:
 *
 *   - **BG-10 payee** and **BG-11 seller tax representative**, two parties that
 *     hang off different places in CII than in UBL;
 *   - **BG-19 direct debit** (BT-81 = 59) with the mandate (BT-89), the SEPA
 *     creditor identifier (BT-90, which CII puts in `ram:CreditorReferenceID`
 *     rather than on the seller) and the debited account (BT-91). Note there is
 *     no BG-17 payment account: BR-DE-25-b forbids one for a direct debit;
 *   - **BG-13/BG-15 deliver-to**, with the city and post code XRechnung's
 *     BR-DE-10 and BR-DE-11 make mandatory once the group exists;
 *   - **BG-24 supporting documents**, one external and one carrying an embedded
 *     base64 attachment;
 *   - **BT-6 / BT-111**, the VAT accounting currency and the VAT total restated
 *     in it — in CII a second `ram:TaxTotalAmount` in the same summation,
 *     distinguished only by `@currencyID`;
 *   - **BT-7** the tax point date, which CII carries inside every VAT
 *     breakdown group rather than at document level;
 *   - **BT-148 / BT-147** a gross price with a discount, **BT-149** a price base
 *     quantity, and the full set of item identifiers, classification, origin
 *     country and attributes;
 *   - **BT-17 tender or lot** and **BT-18 / BT-128 invoiced object**, which in
 *     CII share one element with BG-24 and are told apart by a type code.
 */
export const extendedXRechnungCii: InvoiceInput = {
  profile: "xrechnung-cii",
  invoiceNumber: "2026-000145",
  issueDate: "2026-08-09",
  dueDate: "2026-09-08",
  currency: "EUR",
  invoiceTypeCode: "380",
  buyerReference: "04011000-1234512345-06",
  note: "Sammelrechnung mit Einzugsermächtigung.",
  noteSubjectCode: "AAI",
  orderReference: "BEST-2026-0900",
  salesOrderReference: "AUF-2026-0900",
  contractReference: "RV-2024-0088",
  projectReference: "PRJ-ERECHNUNG-2026",
  despatchAdviceReference: "LS-2026-0900",
  receivingAdviceReference: "WE-2026-0900",
  tenderOrLotReference: "LOS-4",
  invoicedObjectIdentifier: { value: "ANL-2026-0900", schemeId: "AAJ" },
  buyerAccountingReference: "Kostenstelle 4711",
  taxPointDate: "2026-08-07",
  vatAccountingCurrency: "SEK",
  taxAmountInAccountingCurrency: 3255.6,
  seller: {
    name: "Musterlieferant GmbH",
    tradingName: "Muster Technik",
    vatId: "DE123456789",
    taxRegistrationId: "181/815/08155",
    legalRegistrationId: "HRB 12345 B",
    legalRegistrationSchemeId: "0060",
    identifier: { value: "4012345000009", schemeId: "0088" },
    additionalLegalInformation:
      "Sitz: Berlin. Geschäftsführer: Erika Mustermann.",
    address: {
      line1: "Hauptstraße 1",
      line2: "Haus 4",
      line3: "Aufgang C",
      city: "Berlin",
      postalCode: "10115",
      countrySubdivision: "Berlin",
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
    legalRegistrationId: "HRB 98765",
    legalRegistrationSchemeId: "0060",
    identifier: { value: "4098765000003", schemeId: "0088" },
    address: {
      line1: "Behördenweg 9",
      city: "München",
      postalCode: "80331",
      countryCode: "DE",
    },
    electronicAddress: { schemeId: "0204", value: "04011000-1234512345-06" },
    contact: {
      name: "Kreditorenbuchhaltung",
      phone: "+49 89 1234567",
      email: "kreditoren@bund.example",
    },
  },
  payee: {
    name: "Factoring Nord AG",
    identifier: { value: "4011111000007", schemeId: "0088" },
    legalRegistrationId: { value: "HRB 55555", schemeId: "0060" },
  },
  taxRepresentative: {
    name: "Fiscal Representation B.V.",
    vatId: "NL123456789B01",
    address: {
      line1: "Keizersgracht 1",
      city: "Amsterdam",
      postalCode: "1015 CJ",
      countryCode: "NL",
    },
  },
  deliveryDate: "2026-08-07",
  deliverToName: "Zentrallager Nord",
  deliverToLocationId: { value: "4098765000010", schemeId: "0088" },
  deliverTo: {
    line1: "Rampe 3",
    line2: "Tor B",
    city: "Hamburg",
    postalCode: "20095",
    countrySubdivision: "Hamburg",
    countryCode: "DE",
  },
  payment: {
    meansCode: "59",
    meansName: "SEPA direct debit",
    remittanceInformation: "2026-000145",
    directDebit: {
      mandateReference: "MANDAT-2026-0900",
      creditorIdentifier: "DE98ZZZ09999999999",
      debitedAccount: "DE02120300000000202051",
    },
  },
  paymentTerms: "Der Betrag wird per Lastschrift eingezogen.",
  supportingDocuments: [
    {
      reference: "STUNDENNACHWEIS-2026-08",
      description: "Stundennachweis August 2026",
      externalUri:
        "https://portal.musterlieferant.example/nachweise/2026-08.pdf",
    },
    {
      reference: "PREISBLATT-2026",
      description: "Preisblatt 2026",
      attachment: {
        filename: "preisblatt-2026.csv",
        mimeCode: "text/csv",
        // "pos;preis\n" — a real, tiny CSV, so the document is honest about
        // what it carries rather than embedding filler.
        content: "cG9zO3ByZWlzCg==",
      },
    },
  ],
  allowances: [
    {
      amount: 100,
      baseAmount: 2000,
      percentage: 5,
      vatCategory: "S",
      vatRate: 19,
      reason: "Rahmenvertragsrabatt",
      reasonCode: "95",
    },
  ],
  charges: [
    {
      amount: 40,
      vatCategory: "S",
      vatRate: 19,
      reason: "Versandkosten",
      reasonCode: "FC",
    },
  ],
  paidAmount: 250,
  roundingAmount: 0.03,
  lines: [
    {
      id: "1",
      description: "Industrie-Sensor",
      longDescription: "Sensor mit Kalibrierprotokoll.",
      note: "Kalibrierung inklusive.",
      quantity: 40,
      unitCode: "C62",
      unitPrice: 45,
      grossUnitPrice: 50,
      priceDiscount: 5,
      baseQuantity: 1,
      vatCategory: "S",
      vatRate: 19,
      buyerAccountingReference: "Kostenstelle 4711",
      orderLineReference: "10",
      objectIdentifier: { value: "ANL-2026-0900-1", schemeId: "AAJ" },
      period: { startDate: "2026-07-01", endDate: "2026-07-31" },
      allowances: [
        {
          amount: 30,
          baseAmount: 1500,
          percentage: 2,
          reason: "Mengenrabatt",
          reasonCode: "95",
        },
      ],
      charges: [{ amount: 15, reason: "Verpackung", reasonCode: "PC" }],
      sellerItemId: "SEN-4711",
      buyerItemId: "K-9900",
      standardItemId: { value: "04012345678901", schemeId: "0160" },
      itemClassifications: [
        { code: "31712000", schemeId: "TSP", schemeVersion: "2.0" },
      ],
      originCountryCode: "DE",
      itemAttributes: [
        { name: "Schutzart", value: "IP67" },
        { name: "Messbereich", value: "0-100 bar" },
      ],
    },
    {
      id: "2",
      description: "Wartungspauschale",
      quantity: 1,
      unitCode: "MON",
      unitPrice: 500,
      baseQuantity: 1,
      vatCategory: "S",
      vatRate: 7,
      period: { startDate: "2026-07-01", endDate: "2026-07-31" },
    },
  ],
};
