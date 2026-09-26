import { describe, expect, it } from "vitest";

import { generateCii, generateXRechnungUBL, validate, validateInput } from "./index.js";
import { identifierRules } from "./rules-identifiers.js";
import { clean, withInvoice } from "./testkit.js";
import type { InvoiceInput, TeachingError } from "./types.js";

const LIMITS_DOCS = "https://github.com/attestwire/en16931#not-implemented-yet";

const IDS = [
  "ATW-LEITWEG-ID-INVALID",
  "ATW-IBAN-INVALID",
  "ATW-BIC-INVALID",
  "ATW-SIREN-INVALID",
  "ATW-SIRET-INVALID",
] as const;

/** Every finding of the five identifier rules, whatever its severity. */
const identifierFindings = (inv: InvoiceInput): TeachingError[] => {
  const r = validateInput(inv);
  return [...r.errors, ...r.warnings, ...r.information].filter((f) =>
    (IDS as readonly string[]).includes(f.rule),
  );
};
const ruleIds = (inv: InvoiceInput) => identifierFindings(inv).map((f) => f.rule);
const allRuleIds = (inv: InvoiceInput) => {
  const r = validateInput(inv);
  return [...r.errors, ...r.warnings, ...r.information].map((f) => f.rule);
};

/** An IBAN with the given country and account part, and check digits that satisfy MOD 97-10. */
const withCheckDigits = (country: string, bban: string): string => {
  const digits = (bban + country + "00").replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  const check = 98 - Number(BigInt(digits) % 97n);
  return `${country}${String(check).padStart(2, "0")}${bban}`;
};

const core = (overrides: Partial<InvoiceInput>): InvoiceInput => withInvoice({ profile: "en16931", ...overrides });

describe("ATW-LEITWEG-ID-INVALID in the buyer reference (BT-10)", () => {
  it("stays silent on a valid Leitweg-ID", () => {
    expect(ruleIds(clean)).toEqual([]);
    expect(ruleIds(withInvoice({ buyerReference: " 991-33333TEST-33 " }))).toEqual([]);
  });

  it("warns when a Leitweg-ID's check digits do not match, and says why that matters", () => {
    const [finding, ...rest] = identifierFindings(withInvoice({ buyerReference: "04011000-1234512345-07" }));
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      rule: "ATW-LEITWEG-ID-INVALID",
      field: "BT-10",
      severity: "warning",
      xpath: "/ubl:Invoice/cbc:BuyerReference",
      docsUrl: LIMITS_DOCS,
      example: `"buyerReference": "04011000-1234512345-06"`,
    });
    expect(finding!.message).toContain('"04011000-1234512345-07"');
    expect(finding!.message).toMatch(/check digits do not match/);
    expect(finding!.message).toMatch(/MOD 97-10/);
    expect(finding!.message).toMatch(/portal routes on it/);
    expect(finding!.fix).toMatch(/Do not recompute the check digits/);
    expect(validateInput(withInvoice({ buyerReference: "04011000-1234512345-07" })).valid).toBe(true);
  });

  it("never checks a buyer reference that merely resembles a Leitweg-ID", () => {
    for (const reference of [
      "PO-4711",
      "4500012345",
      "Kostenstelle 4711",
      "2026-07-31", // a date: four digits are not a coarse address table 1 allows
      "20-4711-01", // 20 is not a Land code
      "0401-1234512345-06",
      "04011000123451234507", // no hyphens: not a Leitweg-ID's form at all
    ]) {
      expect(ruleIds(withInvoice({ buyerReference: reference })), reference).toEqual([]);
    }
  });

  it("checks BT-10 only on an invoice addressed to Germany", () => {
    const foreign = core({
      buyerReference: "04011000-1234512345-07",
      buyer: { ...clean.buyer, vatId: "FR12345678901", address: { city: "Lyon", postalCode: "69001", countryCode: "FR" } },
    });
    expect(ruleIds(foreign)).toEqual([]);
    // A German buyer, whatever the profile.
    expect(ruleIds(core({ buyerReference: "04011000-1234512345-07" }))).toEqual(["ATW-LEITWEG-ID-INVALID"]);
    // Or a buyer addressed by Leitweg-ID.
    const addressed = core({
      buyerReference: "04011000-1234512345-07",
      buyer: { ...foreign.buyer, electronicAddress: { schemeId: "0204", value: "04011000-1234512345-06" } },
    });
    expect(ruleIds(addressed)).toEqual(["ATW-LEITWEG-ID-INVALID"]);
  });

  it("points a credit note's finding at the credit note", () => {
    const [finding] = identifierFindings(withInvoice({ invoiceTypeCode: "381", buyerReference: "04011000-1234512345-07" }));
    expect(finding!.xpath).toBe("/ubl:CreditNote/cbc:BuyerReference");
  });
});

describe("ATW-LEITWEG-ID-INVALID under scheme 0204", () => {
  it("checks the buyer's electronic address, which declares itself a Leitweg-ID", () => {
    const inv = withInvoice({ buyer: { ...clean.buyer, electronicAddress: { schemeId: "0204", value: "04011000-1234512345-07" } } });
    const [finding, ...rest] = identifierFindings(inv);
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      rule: "ATW-LEITWEG-ID-INVALID",
      field: "BT-49",
      severity: "warning",
      xpath: "/ubl:Invoice/cac:AccountingCustomerParty/cac:Party/cbc:EndpointID",
      example: `"electronicAddress": { "schemeId": "0204", "value": "04011000-1234512345-06" }`,
    });
    expect(finding!.message).toMatch(/under scheme 0204, which makes it a Leitweg-ID/);
  });

  it("says when the form is wrong, and what about it", () => {
    const [noHyphens] = identifierFindings(
      withInvoice({ buyer: { ...clean.buyer, electronicAddress: { schemeId: "0204", value: "04011000123451234506" } } }),
    );
    expect(noHyphens!.message).toMatch(/does not have the form of one/);
    expect(noHyphens!.message).toMatch(/no hyphens/);
    const [dashes] = identifierFindings(
      withInvoice({ buyer: { ...clean.buyer, electronicAddress: { schemeId: "0204", value: "04011000–1234512345–06" } } }),
    );
    expect(dashes!.message).toMatch(/not the hyphen-minus/);
  });

  it("checks scheme 0204 in every identifier slot, on every profile", () => {
    const bad = "991-33333TEST-34";
    const cases: [Partial<InvoiceInput>, string, string][] = [
      [{ seller: { ...clean.seller, identifier: { schemeId: "0204", value: bad } } }, "BT-29", "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyIdentification/cbc:ID"],
      [{ buyer: { ...clean.buyer, legalRegistrationId: bad, legalRegistrationSchemeId: "0204" } }, "BT-47", "/ubl:Invoice/cac:AccountingCustomerParty/cac:Party/cac:PartyLegalEntity/cbc:CompanyID"],
      [{ payee: { name: "Factor", identifier: { schemeId: "0204", value: bad } } }, "BT-60", "/ubl:Invoice/cac:PayeeParty/cac:PartyIdentification/cbc:ID"],
      [{ deliverToLocationId: { schemeId: "0204", value: bad } }, "BT-71", "/ubl:Invoice/cac:Delivery/cac:DeliveryLocation/cbc:ID"],
    ];
    for (const [overrides, field, xpath] of cases) {
      for (const profile of ["xrechnung-ubl", "peppol-bis-3", "en16931"] as const) {
        const found = identifierFindings(withInvoice({ ...overrides, profile }));
        expect(found.map((f) => [f.rule, f.field, f.xpath]), `${field} on ${profile}`).toEqual([
          ["ATW-LEITWEG-ID-INVALID", field, xpath],
        ]);
      }
    }
  });

  it("reports BT-10 and BT-49 separately when both carry the same mistyped Leitweg-ID", () => {
    const bad = "04011000-1234512345-07";
    const inv = withInvoice({ buyerReference: bad, buyer: { ...clean.buyer, electronicAddress: { schemeId: "0204", value: bad } } });
    expect(identifierFindings(inv).map((f) => f.field)).toEqual(["BT-10", "BT-49"]);
  });

  it("leaves a Leitweg-ID-like value under another scheme alone", () => {
    const inv = withInvoice({ buyer: { ...clean.buyer, electronicAddress: { schemeId: "9930", value: "04011000-1234512345-07" } } });
    expect(ruleIds(inv)).toEqual([]);
  });
});

describe("ATW-IBAN-INVALID", () => {
  const pay = (payment: InvoiceInput["payment"], overrides: Partial<InvoiceInput> = {}) =>
    withInvoice({ ...overrides, payment });

  it("stays silent on a valid IBAN, written with or without spaces", () => {
    expect(ruleIds(pay({ meansCode: "58", iban: "DE02 1203 0000 0000 2020 51" }))).toEqual([]);
    expect(ruleIds(core({ payment: { meansCode: "58", iban: "FR1420041010050500013M02606" } }))).toEqual([]);
  });

  it("leaves a wrong check digit on an XRechnung SEPA transfer to BR-DE-19, which already reports it", () => {
    const inv = pay({ meansCode: "58", iban: "DE02120300000000202052" });
    expect(allRuleIds(inv)).toContain("BR-DE-19");
    expect(ruleIds(inv)).toEqual([]);
  });

  it("adds what BR-DE-19 does not check: the length ISO 13616 gives each country", () => {
    // Twenty-one characters with check digits that pass MOD 97: KoSIT's test
    // accepts it, and no German IBAN is twenty-one characters long.
    const short = withCheckDigits("DE", "12030000000020205");
    expect(short).toHaveLength(21);
    const inv = pay({ meansCode: "58", iban: short });
    expect(allRuleIds(inv)).not.toContain("BR-DE-19");
    const [finding] = identifierFindings(inv);
    expect(finding).toMatchObject({
      rule: "ATW-IBAN-INVALID",
      field: "BT-84",
      severity: "warning",
      xpath: "/ubl:Invoice/cac:PaymentMeans/cac:PayeeFinancialAccount/cbc:ID",
      docsUrl: LIMITS_DOCS,
    });
    expect(finding!.message).toMatch(/has 21 characters, and an IBAN from DE has 22/);
  });

  it("checks every profile, and says what failed", () => {
    const cases: [string, RegExp][] = [
      ["DE02120300000000202052", /MOD 97-10 check/],
      ["de02120300000000202051", /lower-case letters/],
      ["DE0212030000000020205", /has 21 characters/],
    ];
    for (const [iban, reason] of cases) {
      for (const meansCode of ["58", "30"]) {
        const [finding, ...rest] = identifierFindings(core({ payment: { meansCode, iban } }));
        expect(rest, iban).toEqual([]);
        expect(finding?.rule, `${iban} under ${meansCode}`).toBe("ATW-IBAN-INVALID");
        expect(finding!.message).toMatch(reason);
      }
    }
  });

  it("holds BT-84 to being an IBAN under SEPA credit transfer, and otherwise only when it looks like one", () => {
    const sepa = identifierFindings(core({ payment: { meansCode: "58", iban: "12345678" } }));
    expect(sepa.map((f) => f.rule)).toEqual(["ATW-IBAN-INVALID"]);
    expect(sepa[0]!.message).toMatch(/is not one: an IBAN is two letters/);
    // Under a plain credit transfer an account number that is not an IBAN is
    // allowed: BT-84 is the "payment account identifier", not "IBAN".
    expect(ruleIds(core({ payment: { meansCode: "30", iban: "12345678" } }))).toEqual([]);
    expect(ruleIds(core({ payment: { meansCode: "30", iban: "021000021 / 123456789" } }))).toEqual([]);
  });
});

describe("ATW-BIC-INVALID", () => {
  const bic = (value: string) =>
    withInvoice({ payment: { meansCode: "58", iban: "DE02120300000000202051", bic: value } });

  it("stays silent on a valid BIC, and when there is none", () => {
    expect(ruleIds(bic("BYLADEM1001"))).toEqual([]);
    expect(ruleIds(bic("COBADEFF"))).toEqual([]);
    expect(ruleIds(clean)).toEqual([]);
  });

  it("warns on a malformed one, and says what is wrong with it", () => {
    const cases: [string, RegExp][] = [
      ["COBA DE FF", /8 or 11 letters and digits/],
      ["COBAXXFF", /"XX", are where the bank's country code goes/],
      ["byladem1001", /lower-case letters/],
    ];
    for (const [value, reason] of cases) {
      const [finding, ...rest] = identifierFindings(bic(value));
      expect(rest).toEqual([]);
      expect(finding).toMatchObject({
        rule: "ATW-BIC-INVALID",
        field: "BT-86",
        severity: "warning",
        xpath: "/ubl:Invoice/cac:PaymentMeans/cac:PayeeFinancialAccount/cac:FinancialInstitutionBranch/cbc:ID",
      });
      expect(finding!.message, value).toMatch(reason);
      expect(finding!.fix).toMatch(/leave payment\.bic out/);
    }
  });
});

describe("ATW-SIREN-INVALID and ATW-SIRET-INVALID", () => {
  const legal = (value: string, scheme: string) =>
    core({ seller: { ...clean.seller, legalRegistrationId: value, legalRegistrationSchemeId: scheme } });

  it("stays silent on a valid SIREN (0002) and SIRET (0009), La Poste's included", () => {
    expect(ruleIds(legal("123456782", "0002"))).toEqual([]);
    expect(ruleIds(legal("12345678200010", "0009"))).toEqual([]);
    expect(ruleIds(legal("35600000000001", "0009"))).toEqual([]);
  });

  it("warns on a SIREN whose check digit fails, in the field it is in", () => {
    const [finding, ...rest] = identifierFindings(legal("123456789", "0002"));
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      rule: "ATW-SIREN-INVALID",
      field: "BT-30",
      severity: "warning",
      xpath: "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:CompanyID",
      example: `"legalRegistrationId": "123456782", "legalRegistrationSchemeId": "0002"`,
    });
    expect(finding!.message).toMatch(/fails the Luhn check/);
  });

  it("tells a SIRET under the SIREN scheme from a SIREN under the SIRET scheme", () => {
    const [siretAsSiren] = identifierFindings(legal("12345678200010", "0002"));
    expect(siretAsSiren!.rule).toBe("ATW-SIREN-INVALID");
    expect(siretAsSiren!.message).toMatch(/Fourteen digits is a SIRET/);
    const [sirenAsSiret] = identifierFindings(core({ buyer: { ...clean.buyer, identifier: { schemeId: "0009", value: "123456782" } } }));
    expect(sirenAsSiret).toMatchObject({ rule: "ATW-SIRET-INVALID", field: "BT-46" });
    expect(sirenAsSiret!.message).toMatch(/Nine digits is a SIREN/);
  });

  it("reports a SIRET that fails its check, and one written with spaces", () => {
    expect(identifierFindings(legal("12345678200011", "0009"))[0]!.message).toMatch(/all fourteen digits must pass the Luhn check/);
    expect(identifierFindings(legal("123 456 782 00010", "0009"))[0]!.message).toMatch(/written with spaces/);
    expect(identifierFindings(legal("35600000000000", "0009")).map((f) => f.rule)).toEqual(["ATW-SIRET-INVALID"]);
  });

  it("checks every slot a scheme can sit in", () => {
    const bad = "12345678200011";
    const cases: [Partial<InvoiceInput>, string][] = [
      [{ seller: { ...clean.seller, electronicAddress: { schemeId: "0009", value: bad } } }, "BT-34"],
      [{ payee: { name: "Factor", legalRegistrationId: { schemeId: "0009", value: bad } } }, "BT-61"],
      [{ deliverToLocationId: { schemeId: " 0009", value: bad } }, "BT-71"],
    ];
    for (const [overrides, field] of cases) {
      expect(identifierFindings(core(overrides)).map((f) => [f.rule, f.field])).toEqual([["ATW-SIRET-INVALID", field]]);
    }
  });
});

describe("the identifier rules as a family", () => {
  it("are warnings: an invoice carrying every one of them is still valid", () => {
    const inv = withInvoice({
      buyerReference: "04011000-1234512345-07",
      seller: { ...clean.seller, legalRegistrationId: "123456789", legalRegistrationSchemeId: "0002", identifier: { schemeId: "0009", value: "12345678200011" } },
      payment: { meansCode: "30", iban: "DE02120300000000202052", bic: "byladem1001" },
    });
    const r = validateInput(inv);
    expect(identifierFindings(inv).map((f) => f.rule).sort()).toEqual([...IDS].sort());
    expect(r.errors.filter((f) => (IDS as readonly string[]).includes(f.rule))).toEqual([]);
  });

  it("never throws on a value of the wrong type", () => {
    const odd = {
      ...clean,
      buyerReference: 4011000,
      buyer: { ...clean.buyer, electronicAddress: { schemeId: 204, value: 4011000 } },
      payment: { meansCode: 58, iban: 12, bic: ["x"] },
      seller: { ...clean.seller, legalRegistrationId: 123456789, legalRegistrationSchemeId: "0002" },
    } as unknown as InvoiceInput;
    for (const rule of identifierRules) expect(() => rule(odd)).not.toThrow();
    expect(() => validateInput(odd)).not.toThrow();
  });

  it("points at the element in the file, in UBL and in CII", () => {
    const inv = withInvoice({ buyerReference: "04011000-1234512345-07" });
    const ubl = validate(generateXRechnungUBL(inv));
    const ublFinding = ubl.warnings.find((f) => f.rule === "ATW-LEITWEG-ID-INVALID");
    expect(ublFinding?.location).toMatchObject({ exact: true });
    expect(ublFinding?.location?.path).toMatch(/cbc:BuyerReference$/);

    const cii = validate(generateCii({ ...inv, profile: "xrechnung-cii" }));
    const ciiFinding = cii.warnings.find((f) => f.rule === "ATW-LEITWEG-ID-INVALID");
    expect(ciiFinding?.location).toMatchObject({ exact: true });
    expect(ciiFinding?.xpath).toMatch(/ram:BuyerReference$/);
  });
});
