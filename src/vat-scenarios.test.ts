import { describe, expect, it } from "vitest";

import {
  applyVatScenarios,
  generateCii,
  generateXRechnungUBL,
  validateInput,
  VAT_SCENARIOS,
} from "./index.js";
import { clean } from "./testkit.js";
import { planVatScenarios } from "./vat-scenarios.js";
import type {
  InvoiceFacts,
  InvoiceInput,
  InvoiceLine,
  InvoiceLineFacts,
  Party,
  Profile,
  TeachingError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Parties and lines, stated once
// ---------------------------------------------------------------------------

const frBuyer: Party = {
  name: "Client Exemple SARL",
  vatId: "FR12345678901",
  address: { line1: "12 rue de la République", city: "Lyon", postalCode: "69001", countryCode: "FR" },
  electronicAddress: { schemeId: "9957", value: "FR12345678901" },
};

const usBuyer: Party = {
  name: "Example Industries Inc.",
  address: { line1: "1 Main Street", city: "Springfield", postalCode: "62701", countryCode: "US" },
  electronicAddress: { schemeId: "EM", value: "payables@example-industries.example" },
};

const deBuyer = clean.buyer;

// No VAT identifier, as many Kleinunternehmer have none: the tax number
// (BT-32) satisfies BR-E-02, and BR-CO-26 then wants a seller identifier
// (BT-29), here the supplier number the buyer assigned.
const kleinunternehmer: Party = {
  name: "Grafikbüro Beispiel",
  taxRegistrationId: "181/815/08155",
  identifier: { value: "LIEF-2026-0815" },
  address: { line1: "Lindenstraße 3", city: "Berlin", postalCode: "10969", countryCode: "DE" },
  electronicAddress: { schemeId: "EM", value: "rechnung@grafikbuero.example" },
  contact: { name: "Anna Beispiel", phone: "+49 30 7654321", email: "rechnung@grafikbuero.example" },
};

const frSeller: Party = {
  name: "Atelier Martin",
  vatId: "FR98765432109",
  address: { line1: "5 rue des Artisans", city: "Paris", postalCode: "75011", countryCode: "FR" },
  electronicAddress: { schemeId: "9957", value: "FR98765432109" },
};

const beSeller: Party = {
  name: "Voorbeeld Consultancy BV",
  vatId: "BE0123456749",
  address: { line1: "Grote Markt 1", city: "Brussel", postalCode: "1000", countryCode: "BE" },
  electronicAddress: { schemeId: "9925", value: "BE0123456749" },
};

const nlBuyer: Party = {
  name: "Voorbeeld Handel B.V.",
  vatId: "NL123456789B01",
  address: { line1: "Keizersgracht 1", city: "Amsterdam", postalCode: "1015 CJ", countryCode: "NL" },
  electronicAddress: { schemeId: "9944", value: "NL123456789B01" },
};

const atSeller: Party = {
  name: "Beispiel Maschinenbau GmbH",
  vatId: "ATU12345678",
  address: { line1: "Hauptplatz 1", city: "Linz", postalCode: "4020", countryCode: "AT" },
  electronicAddress: { schemeId: "9914", value: "ATU12345678" },
};

const services: InvoiceLineFacts[] = [
  { id: "1", description: "Beratung", quantity: 8, unitCode: "HUR", unitPrice: 175 },
  { id: "2", description: "Workshop", quantity: 1.5, unitCode: "DAY", unitPrice: 1200 },
];

const goods: InvoiceLineFacts[] = [
  { id: "1", description: "Industriepumpe P-200", quantity: 2, unitCode: "C62", unitPrice: 1450 },
  { id: "2", description: "Ersatzdichtungen", quantity: 20, unitCode: "C62", unitPrice: 3.2 },
];

/** The same lines with the category (and a zero rate) written out by hand. */
const coded = (lines: InvoiceLineFacts[], vatCategory: InvoiceLine["vatCategory"]): InvoiceLine[] =>
  lines.map((line) => ({ ...line, vatCategory, vatRate: 0 }));

/** `clean` without its lines, for building both forms of each case. */
const { lines: _cleanLines, ...cleanHead } = clean;

// ---------------------------------------------------------------------------
// One case per scenario, stated twice: as facts, and as the codes a person
// who knows EN 16931 would write by hand. The two must be the same invoice.
// ---------------------------------------------------------------------------

interface Case {
  name: string;
  facts: InvoiceFacts;
  explicit: InvoiceInput;
  /** The profile to generate UBL under, and the one to generate CII under. */
  ubl: Profile;
  cii: Profile;
}

const german = (head: Partial<InvoiceInput>) => ({ ...cleanHead, ...head });

const cases: Case[] = [
  {
    name: "domestic (DE)",
    facts: german({
      vatScenario: "domestic",
      lines: [
        { ...services[0]!, vatRate: 19 },
        { ...services[1]!, vatRate: 7 },
      ],
    }) as InvoiceFacts,
    explicit: german({
      lines: [
        { ...services[0]!, vatRate: 19, vatCategory: "S" },
        { ...services[1]!, vatRate: 7, vatCategory: "S" },
      ],
    }) as InvoiceInput,
    ubl: "xrechnung-ubl",
    cii: "xrechnung-cii",
  },
  {
    name: "intra-eu-goods (DE seller, FR buyer)",
    facts: german({
      vatScenario: "intra-eu-goods",
      buyer: frBuyer,
      deliverTo: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
      lines: goods,
    }) as InvoiceFacts,
    explicit: german({
      buyer: frBuyer,
      deliverTo: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
      lines: coded(goods, "K"),
      vatExemptionReasonCodes: { K: "VATEX-EU-IC" },
      vatExemptionReasons: { K: "Steuerfreie innergemeinschaftliche Lieferung" },
    }) as InvoiceInput,
    ubl: "xrechnung-ubl",
    cii: "xrechnung-cii",
  },
  {
    name: "intra-eu-services (DE seller, FR buyer)",
    facts: german({ vatScenario: "intra-eu-services", buyer: frBuyer, lines: services }) as InvoiceFacts,
    explicit: german({
      buyer: frBuyer,
      lines: coded(services, "AE"),
      vatExemptionReasonCodes: { AE: "VATEX-EU-AE" },
      vatExemptionReasons: { AE: "Steuerschuldnerschaft des Leistungsempfängers" },
    }) as InvoiceInput,
    ubl: "xrechnung-ubl",
    cii: "xrechnung-cii",
  },
  {
    name: "export (DE seller, US buyer)",
    facts: german({ vatScenario: "export", buyer: usBuyer, lines: goods }) as InvoiceFacts,
    explicit: german({
      buyer: usBuyer,
      lines: coded(goods, "G"),
      vatExemptionReasonCodes: { G: "VATEX-EU-G" },
      vatExemptionReasons: { G: "Steuerfreie Ausfuhrlieferung" },
    }) as InvoiceInput,
    ubl: "xrechnung-ubl",
    cii: "xrechnung-cii",
  },
  {
    name: "small-business-exemption (DE, § 19 UStG)",
    facts: german({
      vatScenario: "small-business-exemption",
      seller: kleinunternehmer,
      buyer: deBuyer,
      lines: services,
    }) as InvoiceFacts,
    explicit: german({
      seller: kleinunternehmer,
      buyer: deBuyer,
      lines: coded(services, "E"),
      vatExemptionReasons: { E: "Steuerbefreiung für Kleinunternehmer gemäß § 19 UStG" },
    }) as InvoiceInput,
    ubl: "xrechnung-ubl",
    cii: "xrechnung-cii",
  },
  {
    name: "small-business-exemption (FR, franchise en base)",
    facts: german({
      profile: "en16931",
      vatScenario: "small-business-exemption",
      seller: frSeller,
      buyer: frBuyer,
      lines: services,
    }) as InvoiceFacts,
    explicit: german({
      profile: "en16931",
      seller: frSeller,
      buyer: frBuyer,
      lines: coded(services, "E"),
      vatExemptionReasonCodes: { E: "VATEX-FR-FRANCHISE" },
      vatExemptionReasons: { E: "TVA non applicable, article 293 B du CGI" },
    }) as InvoiceInput,
    ubl: "en16931",
    cii: "facturx-en16931",
  },
  {
    name: "intra-eu-goods in French (FR seller, DE buyer)",
    facts: german({
      profile: "en16931",
      vatScenario: "intra-eu-goods",
      seller: frSeller,
      buyer: deBuyer,
      deliverTo: { city: "München", postalCode: "80331", countryCode: "DE" },
      lines: goods,
    }) as InvoiceFacts,
    explicit: german({
      profile: "en16931",
      seller: frSeller,
      buyer: deBuyer,
      deliverTo: { city: "München", postalCode: "80331", countryCode: "DE" },
      lines: coded(goods, "K"),
      vatExemptionReasonCodes: { K: "VATEX-EU-IC" },
      vatExemptionReasons: { K: "Exonération de TVA, article 262 ter I du CGI" },
    }) as InvoiceInput,
    ubl: "en16931",
    cii: "en16931",
  },
  {
    name: "intra-eu-services in English (BE seller, NL buyer)",
    facts: german({
      profile: "en16931",
      vatScenario: "intra-eu-services",
      seller: beSeller,
      buyer: nlBuyer,
      lines: services,
    }) as InvoiceFacts,
    explicit: german({
      profile: "en16931",
      seller: beSeller,
      buyer: nlBuyer,
      lines: coded(services, "AE"),
      vatExemptionReasonCodes: { AE: "VATEX-EU-AE" },
      vatExemptionReasons: { AE: "Reverse charge" },
    }) as InvoiceInput,
    ubl: "en16931",
    cii: "en16931",
  },
  {
    name: "export in German (AT seller, US buyer)",
    facts: german({ profile: "en16931", vatScenario: "export", seller: atSeller, buyer: usBuyer, lines: goods }) as InvoiceFacts,
    explicit: german({
      profile: "en16931",
      seller: atSeller,
      buyer: usBuyer,
      lines: coded(goods, "G"),
      vatExemptionReasonCodes: { G: "VATEX-EU-G" },
      vatExemptionReasons: { G: "Steuerfreie Ausfuhrlieferung" },
    }) as InvoiceInput,
    ubl: "en16931",
    cii: "en16931",
  },
];

const allFindings = (inv: InvoiceInput | InvoiceFacts): TeachingError[] => {
  const result = validateInput(inv);
  return [...result.errors, ...result.warnings, ...result.information];
};

const ids = (inv: InvoiceInput | InvoiceFacts): string[] => allFindings(inv).map((f) => f.rule);

const errorsOf = (inv: InvoiceInput | InvoiceFacts, rule: string): TeachingError[] =>
  validateInput(inv).errors.filter((f) => f.rule === rule);

describe("VAT_SCENARIOS", () => {
  it("lists exactly the five scenarios, frozen", () => {
    expect(VAT_SCENARIOS).toEqual([
      "domestic",
      "intra-eu-goods",
      "intra-eu-services",
      "export",
      "small-business-exemption",
    ]);
    expect(Object.isFrozen(VAT_SCENARIOS)).toBe(true);
  });

  it("has a case below for every scenario", () => {
    const covered = new Set(cases.map((c) => c.facts.vatScenario));
    expect([...covered].sort()).toEqual([...VAT_SCENARIOS].sort());
  });
});

describe.each(cases)("$name", ({ facts, explicit, ubl, cii }) => {
  it("applyVatScenarios returns exactly the explicit invoice a person would write", () => {
    const { invoice } = applyVatScenarios(facts);
    expect(invoice).toEqual(explicit);
    expect(JSON.stringify(invoice)).not.toContain("vatScenario");
  });

  it("the explicit invoice has no findings at all", () => {
    for (const profile of new Set([ubl, cii])) {
      const result = validateInput({ ...explicit, profile });
      expect(result.errors, profile).toEqual([]);
      expect(result.warnings, profile).toEqual([]);
      expect(result.information, profile).toEqual([]);
    }
  });

  it("validateInput judges the facts as the explicit invoice, and notes what it filled in", () => {
    for (const profile of new Set([ubl, cii])) {
      const result = validateInput({ ...facts, profile });
      expect(result.valid, profile).toBe(true);
      expect(result.errors, profile).toEqual([]);
      expect(result.warnings, profile).toEqual([]);
      expect(result.information.map((f) => f.rule), profile).toEqual(["ATW-VAT-SCENARIO-APPLIED"]);
      expect(result.information, profile).toEqual(applyVatScenarios({ ...facts, profile }).notes);
    }
  });

  it("generates the same UBL, byte for byte, from the facts and from the codes", () => {
    const fromFacts = generateXRechnungUBL({ ...facts, profile: ubl });
    expect(fromFacts).toBe(generateXRechnungUBL({ ...explicit, profile: ubl }));
    expect(fromFacts).toBe(generateXRechnungUBL(applyVatScenarios({ ...facts, profile: ubl }).invoice));
  });

  it("generates the same CII, byte for byte, from the facts and from the codes", () => {
    const fromFacts = generateCii({ ...facts, profile: cii });
    expect(fromFacts).toBe(generateCii({ ...explicit, profile: cii }));
    expect(fromFacts).toBe(generateCii(applyVatScenarios({ ...facts, profile: cii }).invoice));
  });

  it("writes the exemption into both documents", () => {
    const category = explicit.lines[0]!.vatCategory;
    const text = explicit.vatExemptionReasons?.[category];
    const code = explicit.vatExemptionReasonCodes?.[category];
    const ublXml = generateXRechnungUBL({ ...facts, profile: ubl });
    const ciiXml = generateCii({ ...facts, profile: cii });
    if (text) {
      expect(ublXml).toContain(`<cbc:TaxExemptionReason>${text}</cbc:TaxExemptionReason>`);
      expect(ciiXml).toContain(`<ram:ExemptionReason>${text}</ram:ExemptionReason>`);
    }
    if (code) {
      expect(ublXml).toContain(`<cbc:TaxExemptionReasonCode>${code}</cbc:TaxExemptionReasonCode>`);
      expect(ciiXml).toContain(`<ram:ExemptionReasonCode>${code}</ram:ExemptionReasonCode>`);
    }
  });
});

describe("the small-business exemption", () => {
  it("writes no VATEX code for Germany, whose exemption has none in the CEF list", () => {
    const { invoice } = applyVatScenarios(cases[4]!.facts);
    expect(invoice.vatExemptionReasonCodes).toBeUndefined();
    expect(invoice.vatExemptionReasons).toEqual({
      E: "Steuerbefreiung für Kleinunternehmer gemäß § 19 UStG",
    });
  });

  it("refuses a seller outside Germany and France, and fills nothing in", () => {
    const facts: InvoiceFacts = { ...cases[4]!.facts, seller: { ...atSeller, taxRegistrationId: "12 345/6789" } };
    const result = validateInput(facts);
    expect(result.errors.map((f) => f.rule)).toContain("ATW-VAT-SCENARIO-UNSUPPORTED");
    const finding = result.errors.find((f) => f.rule === "ATW-VAT-SCENARIO-UNSUPPORTED")!;
    expect(finding.field).toEqual(["BT-40", "BT-151"]);
    expect(finding.message).toContain('"AT"');
    expect(finding.message).toContain("lines 1 and 2");
    // Nothing was guessed: the lines stay uncategorised, and BR-CO-04 says so.
    expect(applyVatScenarios(facts).invoice.lines.every((l) => l.vatCategory === undefined)).toBe(true);
    expect(result.errors.filter((f) => f.rule === "BR-CO-04")).toHaveLength(2);
    expect(result.information).toEqual([]);
  });

  it("asks for the seller's country when there is none, rather than calling it unsupported", () => {
    const facts: InvoiceFacts = {
      ...cases[4]!.facts,
      seller: { ...kleinunternehmer, address: { ...kleinunternehmer.address, countryCode: "" } },
    };
    const missing = errorsOf(facts, "ATW-VAT-SCENARIO-FACT-MISSING");
    expect(missing.map((f) => f.field)).toEqual(["BT-40"]);
    expect(ids(facts)).not.toContain("ATW-VAT-SCENARIO-UNSUPPORTED");
  });

  it("needs a tax identifier for the seller, as BR-E-02 does", () => {
    const facts: InvoiceFacts = {
      ...cases[4]!.facts,
      seller: { ...kleinunternehmer, taxRegistrationId: undefined },
    };
    const missing = errorsOf(facts, "ATW-VAT-SCENARIO-FACT-MISSING");
    expect(missing.map((f) => f.field)).toEqual([["BT-31", "BT-32"]]);
    expect(missing[0]!.message).toContain('vatScenario "small-business-exemption"');
    expect(missing[0]!.message).toContain("§ 19 UStG");
    expect(ids(facts)).toContain("BR-E-02");
  });
});

describe("missing facts", () => {
  const goodsCase = cases[1]!;
  const servicesCase = cases[2]!;
  const exportCase = cases[3]!;

  const missingFields = (inv: InvoiceFacts) =>
    errorsOf(inv, "ATW-VAT-SCENARIO-FACT-MISSING").map((f) => f.field);

  it("reports each fact an intra-community supply lacks, and nothing else", () => {
    const facts: InvoiceFacts = {
      ...goodsCase.facts,
      seller: { ...goodsCase.facts.seller, vatId: undefined, taxRegistrationId: "181/815/08155" },
      buyer: { ...frBuyer, vatId: undefined },
      deliverTo: undefined,
      deliveryDate: undefined,
    };
    expect(missingFields(facts)).toEqual([["BT-31", "BT-63"], "BT-48", "BT-80", ["BT-72", "BG-14"]]);
    for (const finding of errorsOf(facts, "ATW-VAT-SCENARIO-FACT-MISSING")) {
      expect(finding.message).toContain('vatScenario "intra-eu-goods"');
      expect(finding.message).toContain("lines 1 and 2");
    }
    // The regulation's own findings still fire on the explicit invoice.
    const official = validateInput(facts).errors.map((f) => f.rule);
    expect(official).toEqual(expect.arrayContaining(["BR-IC-02", "BR-IC-11", "BR-IC-12"]));
  });

  it("accepts an invoicing period in place of the delivery date, as BR-IC-11 does", () => {
    const facts: InvoiceFacts = {
      ...goodsCase.facts,
      deliveryDate: undefined,
      invoicingPeriod: { startDate: "2026-08-01", endDate: "2026-08-31" },
    };
    expect(missingFields(facts)).toEqual([]);
  });

  it("accepts a tax representative's VAT identifier for the seller's", () => {
    const facts: InvoiceFacts = {
      ...goodsCase.facts,
      seller: { ...goodsCase.facts.seller, vatId: undefined, taxRegistrationId: "181/815/08155" },
      taxRepresentative: {
        name: "Représentant Fiscal SARL",
        vatId: "FR55555555555",
        address: { city: "Paris", postalCode: "75001", countryCode: "FR" },
      },
    };
    expect(missingFields(facts)).toEqual([]);
  });

  it("asks for the buyer's VAT identifier under the reverse charge even where BR-AE-02 would take less", () => {
    const facts: InvoiceFacts = {
      ...servicesCase.facts,
      buyer: { ...frBuyer, vatId: undefined, legalRegistrationId: "RCS Lyon 123 456 789" },
    };
    expect(missingFields(facts)).toEqual(["BT-48"]);
    // BR-AE-02 is satisfied by the legal registration number; the Directive is not.
    expect(ids(facts)).not.toContain("BR-AE-02");
    expect(errorsOf(facts, "ATW-VAT-SCENARIO-FACT-MISSING")[0]!.message).toContain("Article 226(4)");
  });

  it("asks for the seller's VAT identifier on an export, not a tax number", () => {
    const facts: InvoiceFacts = {
      ...exportCase.facts,
      seller: { ...exportCase.facts.seller, vatId: undefined, taxRegistrationId: "181/815/08155" },
    };
    expect(missingFields(facts)).toEqual([["BT-31", "BT-63"]]);
    expect(ids(facts)).toContain("BR-G-02");
  });

  it("never guesses a domestic rate: each line without one is reported", () => {
    const facts: InvoiceFacts = {
      ...cases[0]!.facts,
      lines: [{ ...services[0]!, vatRate: 19 }, services[1]!],
    };
    const missing = errorsOf(facts, "ATW-VAT-SCENARIO-FACT-MISSING");
    expect(missing.map((f) => f.field)).toEqual(["BT-152"]);
    expect(missing[0]!.message).toMatch(/^Line 2 /);
    expect(missing[0]!.xpath).toBe(
      "/ubl:Invoice/cac:InvoiceLine[2]/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent",
    );
    expect(ids(facts)).toContain("BR-S-05");
    expect(applyVatScenarios(facts).invoice.lines[1]!.vatRate).toBeUndefined();
  });

  it("checks facts only for scenarios something actually follows", () => {
    // Every line overrides the invoice's scenario, so its facts are not needed.
    const facts: InvoiceFacts = {
      ...servicesCase.facts,
      buyer: { ...frBuyer, vatId: undefined },
      lines: services.map((line) => ({ ...line, vatScenario: "export" as const })),
    };
    expect(missingFields(facts)).toEqual([]);
  });
});

describe("explicit values always win", () => {
  const servicesCase = cases[2]!;

  it("keeps a stated exemption text and fills only the missing code", () => {
    const facts: InvoiceFacts = {
      ...servicesCase.facts,
      vatExemptionReasons: { AE: "Reverse charge: Article 196, Directive 2006/112/EC" },
    };
    const { invoice, notes } = applyVatScenarios(facts);
    expect(invoice.vatExemptionReasons).toEqual({ AE: "Reverse charge: Article 196, Directive 2006/112/EC" });
    expect(invoice.vatExemptionReasonCodes).toEqual({ AE: "VATEX-EU-AE" });
    expect(notes[0]!.message).toContain('vatExemptionReasonCodes.AE "VATEX-EU-AE"');
    expect(notes[0]!.message).not.toContain("vatExemptionReasons.AE");
  });

  it("keeps a stated code and fills the text beside it only when the code is the scenario's own", () => {
    const same = applyVatScenarios({ ...servicesCase.facts, vatExemptionReasonCodes: { AE: "VATEX-EU-AE" } });
    expect(same.invoice.vatExemptionReasons).toEqual({ AE: "Steuerschuldnerschaft des Leistungsempfängers" });
    const other = applyVatScenarios({
      ...cases[4]!.facts,
      vatExemptionReasonCodes: { E: "VATEX-EU-132-1I" },
    });
    expect(other.invoice.vatExemptionReasonCodes).toEqual({ E: "VATEX-EU-132-1I" });
    expect(other.invoice.vatExemptionReasons).toBeUndefined();
  });

  it("keeps a stated rate, and lets the -05 rule judge it", () => {
    const facts: InvoiceFacts = {
      ...servicesCase.facts,
      lines: [{ ...services[0]!, vatRate: 19 }],
    };
    expect(applyVatScenarios(facts).invoice.lines[0]).toMatchObject({ vatCategory: "AE", vatRate: 19 });
    expect(ids(facts)).toContain("BR-AE-05");
  });

  it("lets an item's own category win over the invoice's scenario, silently", () => {
    const facts: InvoiceFacts = {
      ...servicesCase.facts,
      lines: [services[0]!, { ...services[1]!, vatCategory: "S", vatRate: 19 }],
    };
    const { invoice } = applyVatScenarios(facts);
    expect(invoice.lines.map((l) => l.vatCategory)).toEqual(["AE", "S"]);
    expect(ids(facts)).not.toContain("ATW-VAT-SCENARIO-CONFLICT");
    expect(planVatScenarios(facts).items.map((i) => i.outcome)).toEqual(["applied", "overridden"]);
  });

  it("fills the rest of an item that states the scenario's own category", () => {
    const facts: InvoiceFacts = {
      ...servicesCase.facts,
      lines: [{ ...services[0]!, vatCategory: "AE", vatScenario: "intra-eu-services" }],
    };
    expect(applyVatScenarios(facts).invoice.lines[0]).toMatchObject({ vatCategory: "AE", vatRate: 0 });
    expect(validateInput(facts).errors).toEqual([]);
  });

  it("makes an item's own scenario and its own disagreeing category a fatal conflict", () => {
    const facts: InvoiceFacts = {
      ...servicesCase.facts,
      lines: [services[0]!, { ...services[1]!, vatCategory: "S", vatRate: 19, vatScenario: "intra-eu-services" }],
    };
    const conflict = errorsOf(facts, "ATW-VAT-SCENARIO-CONFLICT");
    expect(conflict).toHaveLength(1);
    expect(conflict[0]!.severity).toBe("fatal");
    expect(conflict[0]!.field).toBe("BT-151");
    expect(conflict[0]!.message).toMatch(/^Line 2 states vatScenario "intra-eu-services"/);
    expect(conflict[0]!.xpath).toBe("/ubl:Invoice/cac:InvoiceLine[2]/cac:Item/cac:ClassifiedTaxCategory/cbc:ID");
    // The explicit category is kept and nothing from the scenario is added to it.
    expect(applyVatScenarios(facts).invoice.lines[1]).toMatchObject({ vatCategory: "S", vatRate: 19 });
    expect(validateInput(facts).valid).toBe(false);
  });
});

describe("an unknown scenario", () => {
  it("is fatal on a line, suggests the scenario it most likely meant, and fills nothing", () => {
    const facts: InvoiceFacts = {
      ...cases[2]!.facts,
      vatScenario: undefined,
      lines: [{ ...services[0]!, vatScenario: "Intra_EU_Service" as never }],
    };
    const unknown = errorsOf(facts, "ATW-VAT-SCENARIO-UNKNOWN");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.fix).toContain('Did you mean "intra-eu-services"?');
    expect(unknown[0]!.example).toBe('"vatScenario": "intra-eu-services"');
    expect(ids(facts)).toContain("BR-CO-04");
    expect(JSON.stringify(applyVatScenarios(facts).invoice)).not.toContain("vatScenario");
  });

  it("is reported once at the invoice level, however many lines rely on it", () => {
    const facts = { ...cases[2]!.facts, vatScenario: "reverse-charge" } as unknown as InvoiceFacts;
    const unknown = errorsOf(facts, "ATW-VAT-SCENARIO-UNKNOWN");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.message).toMatch(/^The invoice states vatScenario "reverse-charge"/);
    expect(unknown[0]!.message).toContain("lines 1 and 2");
    expect(unknown[0]!.fix).not.toContain("Did you mean");
  });

  it("names a value that is not text at all", () => {
    const facts = { ...cases[2]!.facts, lines: [{ ...services[0]!, vatScenario: 5 }] } as unknown as InvoiceFacts;
    expect(errorsOf(facts, "ATW-VAT-SCENARIO-UNKNOWN")[0]!.message).toContain("vatScenario 5,");
  });
});

describe("document level allowances and charges", () => {
  it("follow the invoice's scenario like the lines do", () => {
    const facts: InvoiceFacts = {
      ...cases[1]!.facts,
      charges: [{ amount: 45, reason: "Fracht", reasonCode: "FC" }],
      allowances: [{ amount: 10, reason: "Rabatt", reasonCode: "95", vatScenario: "intra-eu-goods" }],
    };
    const { invoice, notes } = applyVatScenarios(facts);
    expect(invoice.charges).toEqual([{ amount: 45, reason: "Fracht", reasonCode: "FC", vatCategory: "K", vatRate: 0 }]);
    expect(invoice.allowances).toEqual([{ amount: 10, reason: "Rabatt", reasonCode: "95", vatCategory: "K", vatRate: 0 }]);
    expect(notes[0]!.message).toContain("the document level allowance allowances[0] and the document level charge charges[0]");
    expect(notes[0]!.field).toEqual(expect.arrayContaining(["BT-95", "BT-102", "BT-96", "BT-103"]));
    expect(validateInput(facts).errors).toEqual([]);
    expect(generateXRechnungUBL(facts)).toBe(generateXRechnungUBL(invoice));
  });

  it("need a rate of their own under a domestic scenario", () => {
    const facts: InvoiceFacts = {
      ...cases[0]!.facts,
      charges: [{ amount: 45, reason: "Fracht", reasonCode: "FC" }],
    };
    const missing = errorsOf(facts, "ATW-VAT-SCENARIO-FACT-MISSING");
    expect(missing.map((f) => f.field)).toEqual(["BT-103"]);
    expect(missing[0]!.message).toMatch(/^The document level charge at charges\[0\] /);
    expect(missing[0]!.message).toContain("BR-S-07");
  });
});

describe("applyVatScenarios", () => {
  it("returns an explicit input as the same object, with no notes", () => {
    const result = applyVatScenarios(clean);
    expect(result.invoice).toBe(clean);
    expect(result.notes).toEqual([]);
  });

  it("does not modify its input", () => {
    const deepFreeze = <T>(value: T): T => {
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
      }
      return value;
    };
    for (const { facts } of cases) {
      const frozen = deepFreeze(structuredClone(facts));
      expect(() => applyVatScenarios(frozen)).not.toThrow();
      expect(frozen).toEqual(facts);
    }
  });

  it("never throws, whatever it is handed", () => {
    for (const value of [undefined, null, 5, "invoice", [], { vatScenario: "export" }, { vatScenario: "export", lines: "x" }]) {
      expect(() => applyVatScenarios(value as never)).not.toThrow();
      expect(() => validateInput(value as never)).not.toThrow();
    }
  });

  it("points findings on a credit note at the credit-note document", () => {
    const facts: InvoiceFacts = {
      ...cases[0]!.facts,
      invoiceTypeCode: "381",
      precedingInvoices: [{ invoiceNumber: "2026-000100", issueDate: "2026-08-01" }],
      lines: [services[0]!],
    };
    const missing = errorsOf(facts, "ATW-VAT-SCENARIO-FACT-MISSING");
    expect(missing[0]!.xpath).toBe(
      "/ubl:CreditNote/cac:CreditNoteLine[1]/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent",
    );
  });
});

describe("the language of the exemption text", () => {
  const textFor = (country: string) =>
    applyVatScenarios({
      ...cases[2]!.facts,
      seller: { ...cases[2]!.facts.seller, address: { ...cases[2]!.facts.seller.address, countryCode: country } },
    }).invoice.vatExemptionReasons?.AE;

  it("is German for DE and AT, French for FR, English for everyone else", () => {
    expect(textFor("DE")).toBe("Steuerschuldnerschaft des Leistungsempfängers");
    expect(textFor("AT")).toBe("Steuerschuldnerschaft des Leistungsempfängers");
    expect(textFor("FR")).toBe("Autoliquidation");
    expect(textFor("IT")).toBe("Reverse charge");
    expect(textFor(" de ")).toBe("Steuerschuldnerschaft des Leistungsempfängers");
  });

  it("says in the note which language it chose and why", () => {
    const [note] = applyVatScenarios(cases[7]!.facts).notes;
    expect(note!.message).toContain("The text is in English because the seller's country (BT-40) is BE");
  });
});
