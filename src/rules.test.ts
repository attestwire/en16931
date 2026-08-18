import { describe, expect, it } from "vitest";
import {
  generateCii,
  generateXRechnungUBL,
  parseCiiInvoice,
  parseUblInvoice,
  validateInput,
} from "./index.js";
import type { InvoiceInput } from "./types.js";

/**
 * A genuinely XRechnung-complete invoice.
 *
 * This fixture grew when the rule set did: BR-DE-1 (payment instructions),
 * BR-DE-2/5/6/7 (seller contact) and the Peppol endpoint rules all constrain
 * fields the original seed fixture omitted, so an invoice without them was
 * never actually valid — the seed rule set just could not see it yet.
 */
export const base: InvoiceInput = {
  profile: "xrechnung-ubl",
  invoiceNumber: "2026-001",
  issueDate: "2026-08-09",
  currency: "EUR",
  buyerReference: "990-123456-78",
  seller: {
    name: "Acme LLC",
    vatId: "DE123456789",
    address: { city: "Berlin", postalCode: "10115", countryCode: "DE" },
    electronicAddress: { schemeId: "9930", value: "DE123456789" },
    contact: {
      name: "Buchhaltung",
      phone: "+49 30 1234567",
      email: "rechnungen@acme.example",
    },
  },
  buyer: {
    name: "Kunde GmbH",
    vatId: "DE987654321",
    address: { city: "München", postalCode: "80331", countryCode: "DE" },
    electronicAddress: { schemeId: "9930", value: "DE987654321" },
  },
  payment: {
    meansCode: "58",
    iban: "DE02120300000000202051",
    accountName: "Acme LLC",
  },
  lines: [
    {
      id: "1",
      description: "Consulting",
      quantity: 10,
      unitCode: "HUR",
      unitPrice: 150,
      vatCategory: "S",
      vatRate: 19,
    },
  ],
};

/** The same business document in CII syntax. Some rules genuinely differ. */
export const ciiBase: InvoiceInput = { ...base, profile: "xrechnung-cii" };

const rulesOf = (inv: InvoiceInput) =>
  validateInput(inv).errors.map((e) => e.rule);

describe("validateInput", () => {
  it("passes a well-formed XRechnung input", () => {
    const result = validateInput(base);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("BR-DE-15: missing buyer reference on XRechnung is fatal and teaches the fix", () => {
    const result = validateInput({ ...base, buyerReference: undefined });
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.rule === "BR-DE-15");
    expect(err).toBeDefined();
    expect(err!.field).toBe("BT-10");
    expect(err!.fix).toMatch(/Leitweg-ID/);
  });

  it("BR-DE-15 does not fire for non-XRechnung profiles", () => {
    const result = validateInput({
      ...base,
      profile: "facturx-en16931",
      buyerReference: undefined,
    });
    expect(result.errors.map((e) => e.rule)).not.toContain("BR-DE-15");
  });

  it("BR-AE-02: reverse charge without buyer VAT ID is fatal", () => {
    const result = validateInput({
      ...base,
      buyer: { ...base.buyer, vatId: undefined },
      lines: [{ ...base.lines[0]!, vatCategory: "AE", vatRate: 0 }],
    });
    expect(result.errors.map((e) => e.rule)).toContain("BR-AE-02");
  });

  it("BR-S-02: standard-rated lines without a seller tax identifier is fatal", () => {
    // Historically this case was reported as BR-CO-09. That was a mis-ID:
    // BR-CO-09 governs the ISO country *prefix* on a VAT identifier that is
    // present, whereas an absent identifier on a standard-rated line is BR-S-02
    // (and, under the German CIUS, BR-DE-16).
    const result = validateInput({
      ...base,
      seller: { ...base.seller, vatId: undefined },
    });
    const rules = result.errors.map((e) => e.rule);
    expect(rules).toContain("BR-S-02");
    expect(rules).toContain("BR-DE-16");
    expect(rules).not.toContain("BR-CO-09");
  });
});

describe("mandatory document-level fields (BR-02..BR-16)", () => {
  it("BR-02: blank invoice number is fatal", () => {
    expect(rulesOf({ ...base, invoiceNumber: "  " })).toContain("BR-02");
  });

  it("BR-03: missing issue date is fatal", () => {
    expect(rulesOf({ ...base, issueDate: "" })).toContain("BR-03");
  });

  it("BR-03: a non-ISO issue date is fatal and names the offending value", () => {
    const err = validateInput({ ...base, issueDate: "09.08.2026" }).errors.find(
      (e) => e.rule === "BR-03",
    );
    expect(err).toBeDefined();
    expect(err!.message).toContain("09.08.2026");
    expect(err!.message).toMatch(/xs:date/);
  });

  it("BR-05: a non-ISO-4217 currency is fatal", () => {
    expect(rulesOf({ ...base, currency: "Euro" })).toContain("BR-05");
  });

  it("BR-06 / BR-07: missing party names are fatal", () => {
    const rules = rulesOf({
      ...base,
      seller: { ...base.seller, name: "" },
      buyer: { ...base.buyer, name: "" },
    });
    expect(rules).toContain("BR-06");
    expect(rules).toContain("BR-07");
  });

  it("BR-09 / BR-11: missing country codes are fatal", () => {
    const rules = rulesOf({
      ...base,
      seller: { ...base.seller, address: { ...base.seller.address, countryCode: "" } },
      buyer: { ...base.buyer, address: { ...base.buyer.address, countryCode: "Germany" } },
    });
    expect(rules).toContain("BR-09");
    expect(rules).toContain("BR-11");
  });

  it("BR-16: an invoice with no lines is fatal", () => {
    expect(rulesOf({ ...base, lines: [] })).toContain("BR-16");
  });

  it("BR-CO-26: a seller with no identifier at all is fatal", () => {
    const rules = rulesOf({
      ...base,
      seller: {
        ...base.seller,
        vatId: undefined,
        taxRegistrationId: undefined,
        legalRegistrationId: undefined,
      },
    });
    expect(rules).toContain("BR-CO-26");
  });

  it("BR-CO-26 is satisfied by a legal registration identifier alone", () => {
    const rules = rulesOf({
      ...base,
      seller: {
        ...base.seller,
        vatId: undefined,
        legalRegistrationId: "HRB 12345",
      },
    });
    expect(rules).not.toContain("BR-CO-26");
  });

  // The rule names BT-29, BT-30 and BT-31, and only those three. The check read
  // BT-32 instead of BT-29 until 0.7.3, so it was wrong in both directions at
  // once — see the note on the rule in rules.ts.
  it("BR-CO-26 is satisfied by the seller identifier (BT-29) alone", () => {
    const rules = rulesOf({
      ...base,
      seller: {
        ...base.seller,
        vatId: undefined,
        taxRegistrationId: undefined,
        legalRegistrationId: undefined,
        identifier: { value: "4025678000107", schemeId: "0088" },
      },
    });
    expect(rules).not.toContain("BR-CO-26");
  });

  it("BR-CO-26 is NOT satisfied by the tax registration identifier (BT-32)", () => {
    const rules = rulesOf({
      ...base,
      seller: {
        ...base.seller,
        vatId: undefined,
        legalRegistrationId: undefined,
        taxRegistrationId: "201/123/12345",
      },
    });
    expect(rules).toContain("BR-CO-26");
  });

  it("BR-CO-26 names the three terms the rule names", () => {
    const finding = validateInput({
      ...base,
      seller: {
        ...base.seller,
        vatId: undefined,
        taxRegistrationId: undefined,
        legalRegistrationId: undefined,
      },
    }).errors.find((e) => e.rule === "BR-CO-26")!;
    expect(finding.field).toEqual(["BT-29", "BT-30", "BT-31"]);
  });
});

describe("per-line mandatory fields (BR-21..BR-27)", () => {
  const withLine = (patch: Partial<InvoiceInput["lines"][number]>) => ({
    ...base,
    lines: [{ ...base.lines[0]!, ...patch }],
  });

  it("BR-21: missing line id is fatal", () => {
    expect(rulesOf(withLine({ id: "" }))).toContain("BR-21");
  });

  it("BR-22: non-numeric quantity is fatal", () => {
    expect(rulesOf(withLine({ quantity: NaN }))).toContain("BR-22");
  });

  it("BR-23: missing unit code is fatal and teaches UN/ECE Rec 20", () => {
    const err = validateInput(withLine({ unitCode: "" })).errors.find(
      (e) => e.rule === "BR-23",
    );
    expect(err).toBeDefined();
    expect(err!.fix).toMatch(/HUR/);
  });

  it("BR-25: missing item name is fatal", () => {
    expect(rulesOf(withLine({ description: "" }))).toContain("BR-25");
  });

  it("BR-26: missing unit price is fatal", () => {
    expect(rulesOf(withLine({ unitPrice: undefined as unknown as number }))).toContain(
      "BR-26",
    );
  });

  it("BR-27: a negative unit price is fatal, not merely odd", () => {
    const err = validateInput(withLine({ unitPrice: -5 })).errors.find(
      (e) => e.rule === "BR-27",
    );
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/allowances/);
  });

  it("per-line errors identify which line failed", () => {
    const result = validateInput({
      ...base,
      lines: [base.lines[0]!, { ...base.lines[0]!, id: "2", unitCode: "" }],
    });
    const err = result.errors.find((e) => e.rule === "BR-23");
    expect(err!.message).toContain("Line 2");
    expect(err!.xpath).toBe("/ubl:Invoice/cac:InvoiceLine[2]/cbc:InvoicedQuantity/@unitCode");
  });
});

describe("VAT identifier prefixes (BR-CO-09)", () => {
  it("fires when a VAT id has no ISO country prefix", () => {
    const rules = rulesOf({
      ...base,
      seller: { ...base.seller, vatId: "123456789" },
    });
    expect(rules).toContain("BR-CO-09");
  });

  it("accepts the Greek EL derogation", () => {
    const rules = rulesOf({
      ...base,
      seller: { ...base.seller, vatId: "EL123456789" },
    });
    expect(rules).not.toContain("BR-CO-09");
  });

  // Until 0.4.0 the prefix test was /^(EL|[A-Z]{2})/, which asserted only "two
  // letters". The schematron looks the prefix up in a code list, so a made-up
  // country passed here and was rejected by KoSIT under this same rule id.
  describe("the prefix is a real country code, not just two letters", () => {
    const co09 = (inv: InvoiceInput) =>
      validateInput(inv).errors.filter((e) => e.rule === "BR-CO-09");
    const seller = (vatId: string) => ({ ...base, seller: { ...base.seller, vatId } });

    it("rejects a two-letter prefix that is in no ISO 3166-1 list", () => {
      const finding = co09(seller("ZZ123456789"))[0];
      expect(finding).toBeDefined();
      expect(finding!.field).toBe("BT-31");
      expect(finding!.message).toContain("code list");
      expect(finding!.message).toContain('"ZZ"');
    });

    it('rejects "UK" and points at "GB"', () => {
      const finding = co09(seller("UK123456789"))[0];
      expect(finding).toBeDefined();
      expect(finding!.message).toContain('"GB"');
    });

    it("applies the code list to BT-48 and BT-63 as well as BT-31", () => {
      const findings = co09({
        ...base,
        seller: { ...base.seller, vatId: "ZZ111111111" },
        buyer: { ...base.buyer, vatId: "QQ222222222" },
        taxRepresentative: {
          name: "Fiscal Rep France SARL",
          vatId: "XX333333333",
          address: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
        },
      });
      expect(findings.map((e) => e.field).sort()).toEqual(["BT-31", "BT-48", "BT-63"]);
    });

    it('accepts "XI", which is in the list even though it is not a country', () => {
      expect(co09(seller("XI123456789"))).toEqual([]);
    });

    it('accepts "1A", the user-assigned code the list carries for Kosovo', () => {
      // Not two letters, so the old regex rejected it and the code list does
      // not. The prefix is looked up, never pattern-matched.
      expect(co09(seller("1A123456789"))).toEqual([]);
    });

    it("still rejects a number with no prefix, without the code-list wording", () => {
      const finding = co09(seller("123456789"))[0];
      expect(finding).toBeDefined();
      // "12" is not two letters, so the extra sentence would only confuse.
      expect(finding!.message).not.toContain("code list");
    });

    // ⚠ Corrected 2026-08-12 against KoSIT 1.6.2 / XRechnung 3.0.2. The claim
    // this test used to make — that a one-character value "can match no
    // two-character code" — is false in UBL. The UBL test is
    // `contains(' 1A AD … ', substring(cbc:CompanyID,1,2))` with an *unwrapped*
    // needle, so the one-character string "D" is found inside "AD" and KoSIT
    // returns ACCEPTABLE. The CII test wraps the needle in spaces and rejects.
    // Probed in both syntaxes; see scripts/kosit-check.md.
    it("follows each syntax on a one-character value, which they judge differently", () => {
      expect(co09({ ...seller("D"), profile: "xrechnung-ubl" })).toEqual([]);
      expect(
        co09({ ...ciiBase, seller: { ...ciiBase.seller, vatId: "D" } }),
      ).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------
  // Finding 6. Until 2026-08-12 this rule ran
  // `value.replace(/\s/g, "").toUpperCase()` before the lookup. The schematron
  // does neither, in either syntax. Every expectation below was put to KoSIT
  // 1.6.2 with the XRechnung 3.0.2 configuration, in both syntaxes, and the
  // rule ids returned were compared — not just pass/fail.
  // ------------------------------------------------------------------------
  describe("matches the schematron per syntax, case and whitespace included", () => {
    const co09 = (inv: InvoiceInput) =>
      validateInput(inv).errors.filter((e) => e.rule === "BR-CO-09");
    const withVat = (profile: InvoiceInput["profile"], vatId: string): InvoiceInput => {
      const b = profile === "xrechnung-cii" ? ciiBase : base;
      return { ...b, profile, seller: { ...b.seller, vatId } };
    };

    /**
     * KoSIT verdicts, recorded 2026-08-12. `true` = ACCEPTABLE with zero
     * findings; `false` = REJECTED with exactly `[BR-CO-09]` and nothing else.
     */
    const PROBED: ReadonlyArray<[string, boolean, boolean]> = [
      // value                 UBL     CII
      ["DE123456789", true, true],
      ["de123456789", false, false], // case-sensitive in both
      ["D E123456789", true, false], // "D " is inside "AD "
      [" DE123456789", true, false], // " D" is inside " DE"
      ["Q 123456789", true, false], // "Q " is inside "AQ "
      ["D", true, false], // unwrapped needle finds "D" in "AD"
      ["D\tE123456789", false, false], // a tab is in neither list
      ["ZZ123456789", false, false],
      ["SS123456789", true, false], // UBL's list carries SS, CII's does not
      ["AN123456789", false, true], // CII's list carries AN, UBL's does not
      ["EL123456789", true, true], // the Greek derogation, both syntaxes
      ["1A123456789", true, true],
    ];

    for (const [vatId, ublOk, ciiOk] of PROBED) {
      it(`agrees with KoSIT on ${JSON.stringify(vatId)} (UBL ${ublOk ? "accepts" : "rejects"}, CII ${ciiOk ? "accepts" : "rejects"})`, () => {
        expect(co09(withVat("xrechnung-ubl", vatId)).length === 0).toBe(ublOk);
        expect(co09(withVat("xrechnung-cii", vatId)).length === 0).toBe(ciiOk);
        // peppol-bis-3 is UBL syntax and must follow the UBL verdict.
        expect(co09(withVat("peppol-bis-3", vatId)).length === 0).toBe(ublOk);
      });
    }

    // The "en16931" profile is generatable as either syntax, so it has to
    // satisfy both rules — reporting only the laxer one would hand a caller
    // `valid: true` on an input the other generator's output is rejected for.
    it("holds a syntax-agnostic profile to both rules", () => {
      expect(co09(withVat("en16931", "SS123456789"))).toHaveLength(1);
      expect(co09(withVat("en16931", "AN123456789"))).toHaveLength(1);
      expect(co09(withVat("en16931", "DE123456789"))).toEqual([]);
      expect(co09(withVat("en16931", "SS123456789"))[0]!.message).toContain("CII");
    });

    it("says the lookup is case-sensitive rather than repeating the value", () => {
      const finding = co09(withVat("xrechnung-ubl", "de123456789"))[0]!;
      expect(finding.message).toContain("case-sensitive");
      expect(finding.message).toContain('"DE"');
    });

    it("names the whitespace when the prefix is broken by a space", () => {
      const finding = co09(withVat("xrechnung-cii", "D E123456789"))[0]!;
      expect(finding.message).toContain("whitespace");
    });

    // The two literal lists from the XRechnung 3.0.2 configuration, copied
    // character for character out of `EN16931-UBL-validation.xsl` and
    // `EN16931-CII-validation.xsl`. They are NOT the same list: UBL carries
    // `SS` and not `AN`, CII carries `AN` and not `SS`, and CII writes
    // `BI BL BJ` where UBL writes `BI BJ BL`. Both are 252 tokens.
    //
    // The reference implementations below are the XPath expressions
    // transliterated, nothing more:
    //   UBL  contains(LIST, substring(id, 1, 2))
    //   CII  contains(LIST, concat(' ', substring(id, 1, 2), ' '))
    // If this build's verdict ever diverges from them, it has diverged from
    // the schematron.
    describe("pinned against the schematron literals", () => {
      const UBL_LITERAL =
        " 1A AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH EL ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XI YE YT ZA ZM ZW ";
      const CII_LITERAL =
        " 1A AD AE AF AG AI AL AM AN AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BL BJ BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH EL ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XI YE YT ZA ZM ZW ";

      const ublAccepts = (id: string) => UBL_LITERAL.includes(id.slice(0, 2));
      const ciiAccepts = (id: string) =>
        CII_LITERAL.includes(` ${id.slice(0, 2)} `);

      it("carries the two lists the configuration actually ships", () => {
        const u = UBL_LITERAL.trim().split(" ");
        const c = CII_LITERAL.trim().split(" ");
        expect(u).toHaveLength(252);
        expect(c).toHaveLength(252);
        expect(u.filter((t) => !c.includes(t))).toEqual(["SS"]);
        expect(c.filter((t) => !u.includes(t))).toEqual(["AN"]);
      });

      // Exhaustive over a character set chosen to hit every interesting shape:
      // list members, near-misses, both cases, digits, and whitespace.
      const ALPHABET = [..."ADEGLNQSZ1a s\t"];
      it("agrees with the transliterated XPath on every two-character prefix", () => {
        const disagreements: string[] = [];
        for (const a of ALPHABET) {
          for (const b of ALPHABET) {
            const vatId = `${a}${b}123456789`;
            const ublClean = co09(withVat("xrechnung-ubl", vatId)).length === 0;
            const ciiClean = co09(withVat("xrechnung-cii", vatId)).length === 0;
            if (ublClean !== ublAccepts(vatId)) {
              disagreements.push(`UBL ${JSON.stringify(vatId)}`);
            }
            if (ciiClean !== ciiAccepts(vatId)) {
              disagreements.push(`CII ${JSON.stringify(vatId)}`);
            }
          }
        }
        expect(disagreements).toEqual([]);
      });

      it("agrees on values shorter than a prefix", () => {
        for (const vatId of ["D", "1", " ", "Z"]) {
          expect(co09(withVat("xrechnung-ubl", vatId)).length === 0).toBe(
            ublAccepts(vatId),
          );
          expect(co09(withVat("xrechnung-cii", vatId)).length === 0).toBe(
            ciiAccepts(vatId),
          );
        }
      });
    });
  });

  // BR-CO-09 and BR-CL-14 draw on deliberately different lists, and Greece is
  // the only place the difference shows. A Greek seller is correct with
  // BT-31 = "EL..." and BT-40 = "GR" at the same time — the fix must not make
  // that invoice fail in either direction.
  describe("Greece: EL is a VAT prefix, GR is the country code", () => {
    const greek: InvoiceInput = {
      ...base,
      seller: {
        ...base.seller,
        vatId: "EL123456789",
        address: { city: "Athina", postalCode: "10431", countryCode: "GR" },
        electronicAddress: { schemeId: "9933", value: "EL123456789" },
      },
    };

    it("accepts EL on BT-31 with GR on BT-40, and reports nothing at all", () => {
      const result = validateInput(greek);
      expect(result.errors.map((e) => e.rule)).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it('rejects "GR" as a country code nowhere, and "EL" as a country code', () => {
      // The mirror image: EL is fine as a VAT prefix and wrong as BT-40.
      const ids = validateInput({
        ...greek,
        seller: { ...greek.seller, address: { ...greek.seller.address!, countryCode: "EL" } },
      }).errors.map((e) => e.rule);
      expect(ids).toContain("BR-CL-14");
      expect(ids).not.toContain("BR-CO-09");
    });

    it('accepts "GR" as a VAT prefix too — it is in BR-CO-09\'s list', () => {
      const findings = validateInput({
        ...greek,
        seller: { ...greek.seller, vatId: "GR123456789" },
      }).errors.filter((e) => e.rule === "BR-CO-09");
      expect(findings).toEqual([]);
    });
  });

  // BR-CO-09 names three identifiers, not two. BT-63 was missing until 0.4.0.
  describe("the seller tax representative identifier (BT-63)", () => {
    /** BG-11, complete enough to satisfy BR-18, BR-19 and BR-20. */
    const representative = (vatId: string) => ({
      name: "Fiscal Rep France SARL",
      vatId,
      address: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
    });

    const co09 = (inv: InvoiceInput) =>
      validateInput(inv).errors.filter((e) => e.rule === "BR-CO-09");

    it("fires when the representative's VAT id has no country prefix", () => {
      const finding = co09({
        ...base,
        taxRepresentative: representative("123456789"),
      })[0];
      expect(finding).toBeDefined();
      expect(finding!.field).toBe("BT-63");
      expect(finding!.severity).toBe("fatal");
      expect(finding!.message).toContain("seller tax representative");
      expect(finding!.xpath).toBe(
        "/ubl:Invoice/cac:TaxRepresentativeParty/cac:PartyTaxScheme/cbc:CompanyID",
      );
    });

    it("fires on a one-letter prefix, which is not an ISO 3166-1 code", () => {
      expect(
        co09({ ...base, taxRepresentative: representative("F12345678901") }),
      ).toHaveLength(1);
    });

    it("accepts a prefixed representative identifier", () => {
      expect(
        co09({ ...base, taxRepresentative: representative("FR12345678901") }),
      ).toEqual([]);
    });

    it("accepts the Greek EL derogation on BT-63 too", () => {
      expect(
        co09({ ...base, taxRepresentative: representative("EL123456789") }),
      ).toEqual([]);
    });

    it("stays silent when BG-11 is absent, or when its VAT id is empty", () => {
      expect(co09(base)).toEqual([]);
      // An empty string emits no cbc:CompanyID at all, so the schematron
      // context never fires. KoSIT: ACCEPTABLE, zero findings, both syntaxes.
      expect(
        co09({ ...base, taxRepresentative: { ...representative(""), vatId: "" } }),
      ).toEqual([]);
    });

    // ⚠ Corrected 2026-08-12. This used to assert that a whitespace-only BT-63
    // was "BR-56's finding, not a prefix problem". It is both: the element is
    // emitted, the context fires, and `substring("  ", 1, 2)` is "  ", which is
    // in neither list. Probed on the seller identifier: KoSIT REJECTED with
    // BR-CO-09 in UBL and in CII.
    it("fires on a whitespace-only VAT id, which is emitted and then judged", () => {
      expect(
        co09({ ...base, taxRepresentative: { ...representative(""), vatId: "  " } }),
      ).toHaveLength(1);
    });

    it("reports the seller and the representative separately", () => {
      const findings = co09({
        ...base,
        seller: { ...base.seller, vatId: "123456789" },
        taxRepresentative: representative("987654321"),
      });
      expect(findings.map((e) => e.field).sort()).toEqual(["BT-31", "BT-63"]);
    });

    it("holds for the CII profile as well as UBL", () => {
      for (const profile of ["xrechnung-ubl", "xrechnung-cii"] as const) {
        expect(
          co09({ ...base, profile, taxRepresentative: representative("123456789") }),
        ).toHaveLength(1);
        expect(
          co09({ ...base, profile, taxRepresentative: representative("FR12345678901") }),
        ).toEqual([]);
      }
    });
  });
});

/**
 * The same rule, reached the way a receiver reaches it: through the XML.
 *
 * A model-level test cannot tell us that BT-63 survives generation and parsing
 * in each syntax — and the two syntaxes carry it in different places. UBL puts
 * it in `cac:TaxRepresentativeParty/cac:PartyTaxScheme/cbc:CompanyID`; CII puts
 * it on a trade party of its own, in
 * `ram:SellerTaxRepresentativeTradeParty/ram:SpecifiedTaxRegistration/ram:ID`.
 * If either mapping dropped the field, the round trip would report no finding
 * at all and the model-level test above would still pass.
 */
describe("BR-CO-09 on BT-63, through generated XML", () => {
  const withRep = (profile: InvoiceInput["profile"], vatId: string): InvoiceInput => ({
    ...base,
    profile,
    taxRepresentative: {
      name: "Fiscal Rep France SARL",
      vatId,
      address: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
    },
  });

  const co09FieldsFromUbl = (vatId: string) => {
    const xml = generateXRechnungUBL(withRep("xrechnung-ubl", vatId));
    expect(xml).toContain("cac:TaxRepresentativeParty");
    const { invoice } = parseUblInvoice(xml);
    expect(invoice.taxRepresentative?.vatId).toBe(vatId);
    return validateInput(invoice)
      .errors.filter((e) => e.rule === "BR-CO-09")
      .map((e) => e.field);
  };

  const co09FieldsFromCii = (vatId: string) => {
    const xml = generateCii(withRep("xrechnung-cii", vatId));
    expect(xml).toContain("ram:SellerTaxRepresentativeTradeParty");
    const { invoice } = parseCiiInvoice(xml);
    expect(invoice.taxRepresentative?.vatId).toBe(vatId);
    return validateInput(invoice)
      .errors.filter((e) => e.rule === "BR-CO-09")
      .map((e) => e.field);
  };

  it("catches an unprefixed BT-63 in a UBL invoice", () => {
    expect(co09FieldsFromUbl("123456789")).toEqual(["BT-63"]);
  });

  it("accepts a prefixed BT-63 in a UBL invoice", () => {
    expect(co09FieldsFromUbl("FR12345678901")).toEqual([]);
  });

  it("catches an unprefixed BT-63 in a CII invoice", () => {
    expect(co09FieldsFromCii("123456789")).toEqual(["BT-63"]);
  });

  it("accepts a prefixed BT-63 in a CII invoice", () => {
    expect(co09FieldsFromCii("FR12345678901")).toEqual([]);
  });
});

describe("VAT category consistency", () => {
  it("BR-S-05: standard rated with a zero rate is fatal and explains the alternatives", () => {
    const err = validateInput({
      ...base,
      lines: [{ ...base.lines[0]!, vatCategory: "S", vatRate: 0 }],
    }).errors.find((e) => e.rule === "BR-S-05");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/contradictory/);
  });

  it.each([
    ["Z", "BR-Z-05"],
    ["E", "BR-E-05"],
    ["AE", "BR-AE-05"],
    ["K", "BR-IC-05"],
    ["G", "BR-G-05"],
  ] as const)(
    "%s with a non-zero rate triggers %s",
    (category, rule) => {
      const rules = rulesOf({
        ...base,
        deliveryDate: "2026-08-05",
        deliverTo: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
        vatExemptionReasons: { E: "Exempt under Article 132" },
        lines: [{ ...base.lines[0]!, vatCategory: category, vatRate: 19 }],
      });
      expect(rules).toContain(rule);
    },
  );

  it.each([
    ["Z", "BR-Z-02"],
    ["E", "BR-E-02"],
    ["G", "BR-G-02"],
  ] as const)(
    "%s without a seller tax identifier triggers %s",
    (category, rule) => {
      const rules = rulesOf({
        ...base,
        seller: { ...base.seller, vatId: undefined },
        vatExemptionReasons: { E: "Exempt under Article 132" },
        lines: [{ ...base.lines[0]!, vatCategory: category, vatRate: 0 }],
      });
      expect(rules).toContain(rule);
    },
  );

  it("BR-IC-02: intra-community supply needs the buyer VAT id specifically", () => {
    const rules = rulesOf({
      ...base,
      buyer: { ...base.buyer, vatId: undefined, legalRegistrationId: "HRB 1" },
      deliveryDate: "2026-08-05",
      deliverTo: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
      lines: [{ ...base.lines[0]!, vatCategory: "K", vatRate: 0 }],
    });
    expect(rules).toContain("BR-IC-02");
  });

  it("BR-IC-11 / BR-IC-12: category K needs a delivery date and destination country", () => {
    const rules = rulesOf({
      ...base,
      buyer: { ...base.buyer, vatId: "FR12345678901" },
      lines: [{ ...base.lines[0]!, vatCategory: "K", vatRate: 0 }],
    });
    expect(rules).toContain("BR-IC-11");
    expect(rules).toContain("BR-IC-12");
  });

  it("BR-O-05: category O must not carry a rate at all, even zero", () => {
    const err = validateInput({
      ...base,
      seller: { ...base.seller, vatId: undefined, legalRegistrationId: "HRB 1" },
      buyer: { ...base.buyer, vatId: undefined },
      lines: [{ ...base.lines[0]!, vatCategory: "O", vatRate: 0 }],
    }).errors.find((e) => e.rule === "BR-O-05");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/not even 0/);
  });

  it("BR-O-02: category O must not appear alongside a VAT identifier", () => {
    const rules = rulesOf({
      ...base,
      lines: [{ ...base.lines[0]!, vatCategory: "O", vatRate: undefined }],
    });
    expect(rules).toContain("BR-O-02");
  });

  it("BR-E-10: exempt lines need an exemption reason, and there is no default", () => {
    const err = validateInput({
      ...base,
      lines: [{ ...base.lines[0]!, vatCategory: "E", vatRate: 0 }],
    }).errors.find((e) => e.rule === "BR-E-10");
    expect(err).toBeDefined();
    expect(err!.fix).toMatch(/UStG|Directive/);
  });

  it("BR-E-10 is satisfied by an explicit reason", () => {
    const rules = rulesOf({
      ...base,
      vatExemptionReasons: { E: "Steuerbefreit nach §4 Nr. 21 UStG" },
      lines: [{ ...base.lines[0]!, vatCategory: "E", vatRate: 0 }],
    });
    expect(rules).not.toContain("BR-E-10");
  });
});

describe("BR-CO arithmetic against declared totals", () => {
  it("stays silent when declaredTotals agree with the computed values", () => {
    const rules = rulesOf({
      ...base,
      declaredTotals: {
        lineExtensionAmount: 1500,
        taxExclusiveAmount: 1500,
        taxAmount: 285,
        taxInclusiveAmount: 1785,
        payableAmount: 1785,
      },
    });
    expect(rules.filter((r) => r.startsWith("BR-CO-1"))).toHaveLength(0);
  });

  it("BR-CO-10: a wrong line sum is fatal and reports the delta", () => {
    const err = validateInput({
      ...base,
      declaredTotals: { lineExtensionAmount: 1499.5 },
    }).errors.find((e) => e.rule === "BR-CO-10");
    expect(err).toBeDefined();
    expect(err!.message).toContain("1499.50");
    expect(err!.message).toContain("1500.00");
    expect(err!.message).toContain("-0.50");
  });

  it("BR-CO-14: a wrong VAT total is reported against the lines", () => {
    const rules = rulesOf({
      ...base,
      declaredTotals: { taxAmount: 280, taxInclusiveAmount: 1780 },
    });
    expect(rules).toContain("BR-CO-14");
    // ...and BR-CO-15 stays quiet, which is the correction made in 0.7.3.
    // BR-CO-15 asserts BT-112 = BT-109 + BT-110 over the figures the document
    // STATES: 1500 (no BT-109 stated, so the computed one stands in) + 280 =
    // 1780, exactly what is declared. The VAT total is wrong and BR-CO-14 says
    // so once; propagating that same cent-and-more into BR-CO-15 reported one
    // defect twice, and did it on documents the official validators accept.
    expect(rules).not.toContain("BR-CO-15");
  });

  // The 03.01a shape, from the first benchmark run against KoSIT and the CEN
  // schematrons (2026-08-16). Every stated figure is internally consistent —
  // the stated line amounts sum to exactly BT-106 = BT-109, plus the stated VAT
  // gives BT-112, minus nothing gives BT-115 — but one line's own quantity ×
  // price rounds a cent away from the amount that line states. We used to
  // answer that with three fatal findings (BR-CO-13, BR-CO-15, BR-CO-16); the
  // official validators answer with none, and they are right: those three rules
  // never look at the line arithmetic.
  it("BR-CO-13/-15/-16 stay silent when the stated chain is consistent and one line rounds a cent away", () => {
    const result = validateInput({
      ...base,
      lines: [
        // 3 × 33.335 = 100.005 → 100.01 computed, 100.00 stated.
        { id: "1", name: "Rounder", quantity: 3, unitPrice: 33.335, unitCode: "C62", vatCategory: "S", vatRate: 19 },
      ],
      declaredTotals: {
        lineNetAmounts: [100],
        lineExtensionAmount: 100,
        taxExclusiveAmount: 100,
        taxAmount: 19,
        subtotals: [{ category: "S", rate: 19, taxableAmount: 100, taxAmount: 19 }],
        taxInclusiveAmount: 119,
        payableAmount: 119,
      },
    });
    const rules = result.errors.map((e) => e.rule);
    expect(rules).not.toContain("BR-CO-13");
    expect(rules).not.toContain("BR-CO-15");
    expect(rules).not.toContain("BR-CO-16");
  });

  // The other direction, so the fix is not "stop checking". A stated BT-109
  // that does not follow from the stated BT-106 is exactly what BR-CO-13 is
  // for, and it must still be fatal even though the lines themselves are fine.
  it("BR-CO-13 still fires when the stated chain itself is broken", () => {
    const rules = rulesOf({
      ...base,
      declaredTotals: {
        lineExtensionAmount: 1500,
        taxExclusiveAmount: 1400,
      },
    });
    expect(rules).toContain("BR-CO-13");
  });

  // BT-107 and BT-108 are part of the same link, and they pull in opposite
  // directions: a 100 allowance and a 40 charge against a 1500 line total
  // require BT-109 = 1440.
  it("BR-CO-13 chains through the stated document allowance and charge totals", () => {
    const withCorrect = rulesOf({
      ...base,
      declaredTotals: {
        lineExtensionAmount: 1500,
        allowanceTotalAmount: 100,
        chargeTotalAmount: 40,
        taxExclusiveAmount: 1440,
      },
    });
    expect(withCorrect).not.toContain("BR-CO-13");
    const withNetted = rulesOf({
      ...base,
      declaredTotals: {
        lineExtensionAmount: 1500,
        allowanceTotalAmount: 100,
        chargeTotalAmount: 40,
        // The classic mistake: allowances subtracted, charges forgotten.
        taxExclusiveAmount: 1400,
      },
    });
    expect(withNetted).toContain("BR-CO-13");
  });

  // BR-CO-16's own link, with a prepayment — the adv-off-by-a-cent-payable
  // shape from the benchmark corpus.
  it("BR-CO-16 fires on a payable amount that does not follow from the stated BT-112", () => {
    const rules = rulesOf({
      ...base,
      paidAmount: 500,
      declaredTotals: {
        taxInclusiveAmount: 1785,
        payableAmount: 1284.99,
      },
    });
    expect(rules).toContain("BR-CO-16");
  });

  it("teaches the sum-of-rounded-values rule in the fix text", () => {
    const err = validateInput({
      ...base,
      declaredTotals: { lineExtensionAmount: 1 },
    }).errors.find((e) => e.rule === "BR-CO-10");
    expect(err!.fix).toMatch(/round each line to 2 decimals first/i);
  });
});

describe("one defect, one finding: a rule id is never reported twice", () => {
  // Two checks own BR-CO-10 and BR-CO-14 between them: the older one compares
  // the declared document total against the total computed from the lines, the
  // newer one compares it against the total the *lines themselves state*. When
  // a parsed document carries both its stated lines and its stated breakdown —
  // which every document parsed by `parseUblInvoice` or `parseCiiInvoice` does
  // — both fired, and the caller got two findings under one id, with different
  // messages and different deltas. The verdict was right and the report read as
  // one rule contradicting itself.
  //
  // These assertions run over the RAW findings list on purpose. The invariants
  // battery reads rule ids through a `Set`, which is exactly why it could not
  // see this, so a deduplicating assertion here would pin nothing.
  const asParsed: InvoiceInput = {
    ...base,
    declaredTotals: {
      lineNetAmounts: [1500],
      subtotals: [{ category: "S", rate: 19, taxableAmount: 1500, taxAmount: 285 }],
      lineExtensionAmount: 1500,
      taxExclusiveAmount: 1500,
      taxAmount: 285,
      taxInclusiveAmount: 1785,
      payableAmount: 1785,
    },
  };

  it("reports BR-CO-14 once on a corrupt BT-110, not once per implementation", () => {
    const errors = validateInput({
      ...asParsed,
      declaredTotals: { ...asParsed.declaredTotals, taxAmount: 9999.99 },
    }).errors.filter((e) => e.rule === "BR-CO-14");
    expect(errors).toHaveLength(1);
    // And the survivor is the one that compares against what the document
    // states: the breakdown groups state 285.00 between them.
    expect(errors[0]!.message).toContain("285.00");
    expect(errors[0]!.message).toContain("9999.99");
  });

  it("reports BR-CO-10 once on a corrupt BT-106, not once per implementation", () => {
    const errors = validateInput({
      ...asParsed,
      declaredTotals: { ...asParsed.declaredTotals, lineExtensionAmount: 1234.56 },
    }).errors.filter((e) => e.rule === "BR-CO-10");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("1500.00");
    expect(errors[0]!.message).toContain("1234.56");
  });

  it("still reports BR-CO-10 and BR-CO-14 when the document states no summands", () => {
    // The older check is not dead code: a caller who declares only the six
    // document totals has stated no line amounts and no breakdown, so there is
    // nothing to compare against except the computed values.
    const errors = validateInput({
      ...base,
      declaredTotals: { lineExtensionAmount: 1234.56, taxAmount: 9999.99 },
    }).errors;
    expect(errors.filter((e) => e.rule === "BR-CO-10")).toHaveLength(1);
    expect(errors.filter((e) => e.rule === "BR-CO-14")).toHaveLength(1);
  });

  it("reports no rule id more than once on a document broken several ways", () => {
    const errors = validateInput({
      ...asParsed,
      declaredTotals: {
        ...asParsed.declaredTotals,
        lineExtensionAmount: 1234.56,
        taxAmount: 9999.99,
      },
    }).errors;
    const seen = errors.map((e) => e.rule);
    expect(seen).toEqual([...new Set(seen)]);
  });
});

describe("BR-*-08 sums what the lines state, like BR-CO-10 above it", () => {
  // 80 lines that each state a net amount two cents above their own
  // arithmetic. Every one of them is legitimate on its own —
  // PEPPOL-EN16931-R120 allows exactly 0.02 of slack, which is how a sender who
  // rounds the price rather than the line stays compliant — but they add up to
  // 1.60, outside the `-08` family's ±1 tolerance. Comparing the stated BT-116
  // against the *derived* group total reported a BR-S-08 on a document KoSIT
  // accepts; comparing stated against stated, as BR-CO-10 already does, does
  // not.
  const lines = Array.from({ length: 80 }, (_, index) => ({
    id: String(index + 1),
    description: "Consulting",
    quantity: 1,
    unitCode: "HUR",
    unitPrice: 100,
    vatCategory: "S" as const,
    vatRate: 19,
  }));
  const statedLines = lines.map(() => 100.02); // derived: 100.00 each
  const statedTaxable = 8001.6; // 80 x 100.02, what the lines say
  const statedVat = 1520.3; // 19% of the stated base

  const invoice: InvoiceInput = {
    ...base,
    lines,
    declaredTotals: {
      lineNetAmounts: statedLines,
      subtotals: [
        { category: "S", rate: 19, taxableAmount: statedTaxable, taxAmount: statedVat },
      ],
      lineExtensionAmount: statedTaxable,
      taxAmount: statedVat,
    },
  };

  it("does not report BR-S-08 on a group whose lines are each inside R120's slack", () => {
    const ids = rulesOf(invoice);
    expect(ids).not.toContain("BR-S-08");
    expect(ids).not.toContain("PEPPOL-EN16931-R120");
    expect(ids).not.toContain("BR-CO-17");
    // BR-CO-10 agrees with it, which is the consistency the fix is about: both
    // rules sum the same 8001.60.
    expect(ids).not.toContain("BR-CO-10");
  });

  it("still reports BR-S-08 when the stated BT-116 disagrees with the stated lines", () => {
    const err = validateInput({
      ...invoice,
      declaredTotals: {
        ...invoice.declaredTotals,
        subtotals: [
          { category: "S", rate: 19, taxableAmount: 8003.6, taxAmount: statedVat },
        ],
      },
    }).errors.find((e) => e.rule === "BR-S-08");
    expect(err).toBeDefined();
    expect(err!.message).toContain("8003.60");
    expect(err!.message).toContain("8001.60");
    expect(err!.message).toContain("+2.00");
  });
});

describe("electronic addresses", () => {
  it("PEPPOL-EN16931-R010/R020: missing endpoints are fatal on Peppol", () => {
    const result = validateInput({
      ...base,
      profile: "peppol-bis-3",
      seller: { ...base.seller, electronicAddress: undefined },
      buyer: { ...base.buyer, electronicAddress: undefined },
    });
    const rules = result.errors.map((e) => e.rule);
    expect(rules).toContain("PEPPOL-EN16931-R020");
    expect(rules).toContain("PEPPOL-EN16931-R010");
  });

  it("the same gap is a warning, not an error, on XRechnung", () => {
    const result = validateInput({
      ...base,
      seller: { ...base.seller, electronicAddress: undefined },
    });
    expect(result.errors.map((e) => e.rule)).not.toContain(
      "PEPPOL-EN16931-R020",
    );
    expect(result.warnings.map((e) => e.rule)).toContain(
      "PEPPOL-EN16931-R020",
    );
  });

  it("BR-62 / BR-63: an endpoint without a scheme identifier is always fatal", () => {
    const rules = rulesOf({
      ...base,
      seller: {
        ...base.seller,
        electronicAddress: { schemeId: "", value: "DE123456789" },
      },
      buyer: {
        ...base.buyer,
        electronicAddress: { schemeId: "", value: "DE987654321" },
      },
    });
    expect(rules).toContain("BR-62");
    expect(rules).toContain("BR-63");
  });
});

describe("XRechnung CIUS (BR-DE-*)", () => {
  it("BR-DE-1: payment instructions are mandatory", () => {
    const err = validateInput({ ...base, payment: undefined }).errors.find(
      (e) => e.rule === "BR-DE-1",
    );
    expect(err).toBeDefined();
    expect(err!.field).toBe("BG-16");
    expect(err!.fix).toMatch(/UNTDID 4461/);
  });

  it("BR-61: a credit transfer without an IBAN is fatal", () => {
    const rules = rulesOf({
      ...base,
      payment: { meansCode: "58" },
    });
    expect(rules).toContain("BR-61");
  });

  it("BR-61 does not fire for non-credit-transfer means", () => {
    const rules = rulesOf({ ...base, payment: { meansCode: "48" } });
    expect(rules).not.toContain("BR-61");
  });

  it("BR-DE-2: an entirely absent seller contact reports the group, once", () => {
    const result = validateInput({
      ...base,
      seller: { ...base.seller, contact: undefined },
    });
    const rules = result.errors.map((e) => e.rule);
    expect(rules).toContain("BR-DE-2");
    expect(rules).not.toContain("BR-DE-5");
  });

  it.each([
    ["name", "BR-DE-5"],
    ["phone", "BR-DE-6"],
    ["email", "BR-DE-7"],
  ] as const)(
    "a partial seller contact missing %s reports %s",
    (key, rule) => {
      const contact = { ...base.seller.contact! };
      delete contact[key];
      const rules = rulesOf({
        ...base,
        seller: { ...base.seller, contact },
      });
      expect(rules).toContain(rule);
      expect(rules).not.toContain("BR-DE-2");
    },
  );

  it.each([
    ["seller", "city", "BR-DE-3"],
    ["seller", "postalCode", "BR-DE-4"],
    ["buyer", "city", "BR-DE-8"],
    ["buyer", "postalCode", "BR-DE-9"],
  ] as const)("%s missing %s triggers %s", (party, key, rule) => {
    const target = party === "seller" ? base.seller : base.buyer;
    const rules = rulesOf({
      ...base,
      [party]: { ...target, address: { ...target.address, [key]: "" } },
    } as InvoiceInput);
    expect(rules).toContain(rule);
  });

  it("BR-DE-10 / BR-DE-11: a deliver-to address must be complete once present", () => {
    // Regression: the generator used to emit BG-15 with only a country code,
    // which core EN 16931 accepts and the KoSIT validator rejects.
    const result = validateInput({
      ...base,
      deliverTo: { countryCode: "FR" },
    });
    const rules = result.errors.map((e) => e.rule);
    expect(rules).toContain("BR-DE-10");
    expect(rules).toContain("BR-DE-11");
    expect(
      result.errors.find((e) => e.rule === "BR-DE-10")!.message,
    ).toMatch(/all-or-nothing/);
  });

  it("BR-DE-10 / BR-DE-11 stay silent for a complete deliver-to address", () => {
    const rules = rulesOf({
      ...base,
      deliverTo: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
    });
    expect(rules).not.toContain("BR-DE-10");
    expect(rules).not.toContain("BR-DE-11");
  });

  it("BR-DE-10 / BR-DE-11 do not apply when BG-15 is absent", () => {
    const rules = rulesOf({ ...base, deliveryDate: "2026-08-05" });
    expect(rules).not.toContain("BR-DE-10");
    expect(rules).not.toContain("BR-DE-11");
  });

  it("BR-DE-17: an invoice type code outside the German subset is a WARNING", () => {
    // Not fatal. KoSIT's XRechnung schematron flags BR-DE-17 `warning` — the
    // German text says "sollen", not "müssen" — and 0.2.x corrects an
    // over-rejection that shipped in 0.1.x. A document carrying BT-3 = 393 is
    // accepted by the official validator, so it must be accepted here too.
    const result = validateInput({ ...base, invoiceTypeCode: "393" });
    expect(result.errors.find((e) => e.rule === "BR-DE-17")).toBeUndefined();
    const warning = result.warnings.find((e) => e.rule === "BR-DE-17");
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe("warning");
    expect(warning!.message).toContain("393");
    // 393 is a valid UNTDID 1001 invoice code, so nothing else objects to it:
    // the document as a whole stays valid.
    expect(result.valid).toBe(true);
  });

  it("BR-DE-17 accepts the default 380 and the credit-note code 381", () => {
    expect(rulesOf(base)).not.toContain("BR-DE-17");
    // 381 is legal under BR-DE-17, and since 0.5.0 it is legal here too: it
    // generates a ubl:CreditNote. KoSIT's test is one test over both elements
    // and one eight-code list.
    expect(rulesOf({ ...base, invoiceTypeCode: "381" })).not.toContain(
      "BR-DE-17",
    );
  });

  // ⚠ Replaced 2026-08-13. Two tests stood here asserting that BT-3 = 381 was
  // a fatal ATW-CREDIT-NOTE-UNSUPPORTED finding. That rule is gone, along with
  // the limitation it described, and a rule id that no longer exists cannot be
  // tested for — so what is asserted instead is the property that used to be
  // impossible: a credit note validates clean.
  it("a credit note is a valid document, with no library-limitation finding", () => {
    const result = validateInput({ ...base, invoiceTypeCode: "381" });
    expect(result.valid).toBe(true);
    const ids = [...result.errors, ...result.warnings].map((e) => e.rule);
    expect(ids).not.toContain("ATW-CREDIT-NOTE-UNSUPPORTED");
    expect(ids).not.toContain("BR-CL-01");
    expect(ids).not.toContain("BR-DE-17");
  });

  it("the whole rule set is silent about a well-formed credit note but for the advisory", () => {
    // The point of the credit-note work: nothing in EN 16931 treats a credit
    // note as a second class of document, so nothing here does either. The one
    // finding is `information`, which never affects `valid`.
    const result = validateInput({
      ...base,
      invoiceTypeCode: "381",
      precedingInvoices: [{ invoiceNumber: "2026-000142" }],
    });
    expect(result.errors).toEqual([]);
    expect(result.information.map((e) => e.rule)).not.toContain(
      "ATW-CREDIT-NOTE-NO-PRECEDING-INVOICE",
    );
  });

  it("BR-DE-27: a phone number with too few digits is a warning", () => {
    const result = validateInput({
      ...base,
      seller: {
        ...base.seller,
        contact: { ...base.seller.contact!, phone: "n/a" },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.map((e) => e.rule)).toContain("BR-DE-27");
  });

  it("BR-DE-28: a malformed email is a warning that names the value", () => {
    const result = validateInput({
      ...base,
      seller: {
        ...base.seller,
        contact: { ...base.seller.contact!, email: "buchhaltung(at)acme.de" },
      },
    });
    const warning = result.warnings.find((e) => e.rule === "BR-DE-28");
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("buchhaltung(at)acme.de");
  });

  it("BR-DE rules do not fire on the plain en16931 profile", () => {
    const rules = rulesOf({
      ...base,
      profile: "en16931",
      payment: undefined,
      seller: { ...base.seller, contact: undefined },
    });
    expect(rules.filter((r) => r.startsWith("BR-DE-"))).toHaveLength(0);
  });
});

describe("teaching-error quality invariants", () => {
  const scenarios: InvoiceInput[] = [
    { ...base, invoiceNumber: "", issueDate: "nope", currency: "X" },
    { ...base, lines: [] },
    { ...base, payment: undefined, seller: { ...base.seller, contact: undefined } },
    {
      ...base,
      seller: { ...base.seller, vatId: "123" },
      lines: [{ ...base.lines[0]!, vatCategory: "E", vatRate: 5 }],
    },
    {
      ...base,
      profile: "peppol-bis-3",
      seller: { ...base.seller, electronicAddress: undefined },
    },
    { ...base, declaredTotals: { taxAmount: 1 } },
  ];

  it("every emitted error carries a rule, field, message, fix and docsUrl", () => {
    let seen = 0;
    for (const scenario of scenarios) {
      const result = validateInput(scenario);
      for (const e of [...result.errors, ...result.warnings]) {
        seen += 1;
        expect(e.rule, "rule").toBeTruthy();
        expect(e.field, `field for ${e.rule}`).toBeTruthy();
        // `ATW-` ids are library limitations rather than regulation rules, and
        // are documented in the README instead of on a per-rule page.
        expect(e.docsUrl).toBe(
          e.rule.startsWith("ATW-")
            ? "https://github.com/attestwire/en16931#not-implemented-yet"
            : `https://attestwire.com/rules/${e.rule}`,
        );
        // A message that teaches is a sentence, not a label.
        expect(e.message.length, `message for ${e.rule}`).toBeGreaterThan(60);
        expect(e.fix.length, `fix for ${e.rule}`).toBeGreaterThan(20);
        expect(e.message.trim().endsWith("."), `message for ${e.rule}`).toBe(
          true,
        );
      }
    }
    expect(seen).toBeGreaterThan(10);
  });

  it("never emits the same rule twice for the same cause", () => {
    const result = validateInput({
      ...base,
      payment: undefined,
      seller: { ...base.seller, contact: undefined },
    });
    const rules = result.errors.map((e) => e.rule);
    expect(new Set(rules).size).toBe(rules.length);
  });
});
