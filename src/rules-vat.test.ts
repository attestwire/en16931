import { describe, expect, it } from "vitest";
import { computeTotals, round2 } from "./totals.js";
import {
  VAT_TOLERANCE,
  withinAbsoluteTolerance,
  withinSignedTolerance,
} from "./rule-kit.js";
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
import type { InvoiceInput, VatCategory } from "./types.js";

/**
 * A document in one non-standard category, with the identifiers that category
 * needs and nothing it forbids — so the only findings are the ones under test.
 */
const inCategory = (
  category: VatCategory,
  overrides: Partial<InvoiceInput> = {},
): InvoiceInput =>
  withInvoice({
    profile: "en16931",
    seller:
      category === "O"
        ? {
            ...clean.seller,
            vatId: undefined,
            taxRegistrationId: "18/181/08155",
            // BR-CO-26 names BT-29/BT-30/BT-31; BT-32 is not one of them, so a
            // category-O seller still needs one of the three.
            legalRegistrationId: "HRB 12345",
          }
        : clean.seller,
    buyer:
      category === "O"
        ? { ...clean.buyer, vatId: undefined }
        : category === "AE" || category === "K"
          ? { ...clean.buyer, vatId: "NL123456789B01" }
          : clean.buyer,
    lines: [
      cleanLine({ vatCategory: category, vatRate: category === "O" ? undefined : 0 }),
    ],
    ...(category === "K"
      ? { deliverTo: { city: "Lyon", postalCode: "69001", countryCode: "FR" } }
      : {}),
    ...overrides,
  });

describe("the two tolerance forms", () => {
  it("share the standard's whole-unit band", () => {
    expect(VAT_TOLERANCE).toBe(1);
    for (const within of [withinSignedTolerance, withinAbsoluteTolerance]) {
      expect(within(285, 285)).toBe(true);
      expect(within(285.5, 285)).toBe(true);
      expect(within(284.5, 285)).toBe(true);
    }
  });

  it("exclude the endpoints, exactly as the schematron writes them", () => {
    for (const within of [withinSignedTolerance, withinAbsoluteTolerance]) {
      expect(within(286, 285)).toBe(false);
      expect(within(284, 285)).toBe(false);
      expect(within(285.999, 285)).toBe(true);
      expect(within(284.001, 285)).toBe(true);
    }
  });

  it("differ on sign, which is the whole reason there are two of them", () => {
    // -08 compares signed values on both sides: a credit breakdown has a
    // negative taxable amount and a negative sum of lines, and they match.
    expect(withinSignedTolerance(-285.5, -285.5)).toBe(true);
    // -09 and BR-CO-17 take the magnitude on both sides. Taking it on one side
    // only — which is the bug this test exists to prevent — makes a correct
    // credit breakdown fail: abs(-85.5) - 1 = 84.5 is not less than -85.5.
    expect(withinAbsoluteTolerance(-85.5, 85.5)).toBe(true);
    expect(withinAbsoluteTolerance(-85.5, -85.5)).toBe(false);
  });
});

describe("the -01 / -08 / -09 families on well-formed input", () => {
  it("stay silent for every supported category", () => {
    for (const category of ["S", "Z", "E", "AE", "K", "G", "O"] as const) {
      const inv =
        category === "E"
          ? inCategory("E", { vatExemptionReasons: { E: "§4 Nr. 21 UStG" } })
          : inCategory(category);
      const ids = allIds(inv);
      for (const suffix of ["01", "08", "09"]) {
        expect(
          ids.filter((r) => r.endsWith(`-${suffix}`)),
          `${category} emitted ${ids.join(", ")}`,
        ).toEqual([]);
      }
    }
  });

  it("stay silent when per-line and per-group VAT rounding disagree", () => {
    // Sixteen lines at 0.13 x 19% = 0.0247 each. Rounded per line and summed
    // that is 16 x 0.02 = 0.32; computed on the group total it is
    // round2(2.08 x 19%) = 0.40. EN 16931 rounds per group, and its ±1
    // tolerance exists precisely so a sender who did it the other way still
    // passes. Neither figure may produce a finding.
    const lines = Array.from({ length: 16 }, (_, i) =>
      cleanLine({ id: String(i + 1), quantity: 1, unitCode: "C62", unitPrice: 0.13 }),
    );
    const inv = withInvoice({ lines });
    const totals = computeTotals(inv);
    expect(totals.subtotals[0]!.taxableAmount).toBeCloseTo(2.08, 2);
    expect(totals.subtotals[0]!.taxAmount).toBeCloseTo(0.4, 2);
    expect(round2(16 * round2(0.13 * 0.19))).toBeCloseTo(0.32, 2);
    expect(allIds(inv)).toEqual([]);
  });

  it("stay silent on a credit line, where every amount goes negative", () => {
    // BR-27 forbids a negative *price*, not a negative line amount: a negative
    // invoiced quantity is how EN 16931 expresses a reversal on a line. Both
    // the taxable amount and the VAT amount then go negative, and the -08/-09
    // comparisons have to follow them there. Getting this wrong made every
    // credit line fail BR-S-08, BR-S-09 and BR-CO-17 — caught by the docs
    // harvester, which drives a negative-quantity fixture.
    const inv = withInvoice({ lines: [cleanLine({ quantity: -3 })] });
    const totals = computeTotals(inv);
    expect(totals.subtotals[0]!.taxableAmount).toBe(-450);
    expect(totals.subtotals[0]!.taxAmount).toBe(-85.5);
    expect(allIds(inv)).toEqual([]);
  });

  it("stay silent on an invoice that nets to a credit across lines", () => {
    const inv = withInvoice({
      lines: [cleanLine({ quantity: 2 }), cleanLine({ id: "2", quantity: -5 })],
    });
    expect(computeTotals(inv).subtotals[0]!.taxableAmount).toBe(-450);
    expect(allIds(inv)).toEqual([]);
  });

  it("stay silent on a many-line, mixed-rate invoice", () => {
    const lines = Array.from({ length: 40 }, (_, i) =>
      cleanLine({
        id: String(i + 1),
        quantity: 3,
        unitPrice: 33.33 + i * 0.07,
        vatRate: i % 2 === 0 ? 19 : 7,
      }),
    );
    expect(allIds(withInvoice({ lines }))).toEqual([]);
  });

  it("stay silent when standard-rated lines split across two rates", () => {
    const inv = withInvoice({
      lines: [cleanLine({ vatRate: 19 }), cleanLine({ id: "2", vatRate: 7 })],
    });
    expect(computeTotals(inv).subtotals).toHaveLength(2);
    expect(allIds(inv)).toEqual([]);
  });

  it("BR-S-01 tolerates two standard-rated groups; the others do not repeat", () => {
    // Only S may appear more than once in the breakdown, one group per rate,
    // and computeTotals cannot produce a repeat for any other category because
    // their rate is fixed at zero.
    for (const category of ["Z", "E", "AE", "K", "G", "O"] as const) {
      const inv = inCategory(category, {
        lines: [
          cleanLine({ vatCategory: category, vatRate: category === "O" ? undefined : 0 }),
          cleanLine({
            id: "2",
            vatCategory: category,
            vatRate: category === "O" ? undefined : 0,
          }),
        ],
        ...(category === "E" ? { vatExemptionReasons: { E: "§4 UStG" } } : {}),
      });
      expect(computeTotals(inv).subtotals).toHaveLength(1);
    }
  });
});

describe("the -10 family: exemption reasons", () => {
  const REQUIRED: [VatCategory, string][] = [
    ["AE", "BR-AE-10"],
    ["K", "BR-IC-10"],
    ["G", "BR-G-10"],
    ["O", "BR-O-10"],
  ];

  for (const [category, rule] of REQUIRED) {
    it(`${rule} accepts the library's default wording`, () => {
      expect(allIds(inCategory(category))).not.toContain(rule);
    });

    it(`${rule} accepts caller-supplied wording`, () => {
      const inv = inCategory(category, {
        vatExemptionReasons: { [category]: "Steuerschuldnerschaft des Leistungsempfängers" },
      });
      expect(allIds(inv)).not.toContain(rule);
    });

    it(`${rule} fires when the caller blanks the reason`, () => {
      const inv = inCategory(category, { vatExemptionReasons: { [category]: "  " } });
      expect(allIds(inv)).toContain(rule);
      const finding = findingFor(inv, rule)!;
      expect(finding.severity).toBe("fatal");
      expect(finding.field).toEqual(["BT-120", "BT-121"]);
    });
  }

  it("leaves BR-E-10 to the original rule, without duplicating it", () => {
    const inv = inCategory("E", { vatExemptionReasons: undefined });
    const ids = allIds(inv);
    expect(ids.filter((r) => r === "BR-E-10")).toHaveLength(1);
  });

  it("BR-S-10 warns when a reason is supplied for a standard-rated document", () => {
    const inv = withInvoice({ vatExemptionReasons: { S: "not applicable" } });
    expect(warningIds(inv)).toContain("BR-S-10");
    // The generated document is still valid — computeTotals drops the value —
    // so this must never make the invoice invalid.
    expect(allIds(inv).filter((r) => r === "BR-S-10")).toHaveLength(1);
    expect(computeTotals(inv).subtotals[0]!.exemptionReason).toBeUndefined();
  });

  it("BR-Z-10 warns for zero-rated, and explains the rate/exemption distinction", () => {
    const inv = inCategory("Z", { vatExemptionReasons: { Z: "no VAT" } });
    expect(warningIds(inv)).toContain("BR-Z-10");
    expect(findingFor(inv, "BR-Z-10")!.message).toContain("taxed at 0%");
  });

  it("says nothing about S or Z when no reason was supplied for them", () => {
    expect(allIds(withInvoice({ vatExemptionReasons: { E: "unused" } }))).toEqual([]);
  });
});

describe("BR-O-11 / BR-O-12: category O owns the whole document", () => {
  const mixed = withInvoice({
    profile: "en16931",
    // BT-30 as well as BT-32: BR-CO-26 names BT-29/BT-30/BT-31 and not BT-32,
    // so a seller carrying only a national tax number is a BR-CO-26 failure and
    // would drown out what this block is about.
    seller: {
      ...clean.seller,
      vatId: undefined,
      taxRegistrationId: "18/181/08155",
      legalRegistrationId: "HRB 12345",
    },
    buyer: { ...clean.buyer, vatId: undefined },
    lines: [
      cleanLine({ vatCategory: "O", vatRate: undefined }),
      cleanLine({ id: "2", vatCategory: "S", vatRate: 19 }),
    ],
  });

  it("fires both rules on a mixed document", () => {
    const ids = allIds(mixed);
    expect(ids).toContain("BR-O-11");
    expect(ids).toContain("BR-O-12");
  });

  it("names the offending lines in BR-O-12", () => {
    expect(findingFor(mixed, "BR-O-12")!.message).toContain("line 2 (S)");
  });

  it("names the colliding categories in BR-O-11", () => {
    expect(findingFor(mixed, "BR-O-11")!.message).toContain('"S"');
  });

  it("stays silent on a document that is category O throughout", () => {
    expect(allIds(inCategory("O"))).toEqual([]);
  });

  it("stays silent on a document with no category O at all", () => {
    expect(allIds(withInvoice({}))).toEqual([]);
  });
});

describe("breakdown integrity (BR-45..BR-48, BR-CO-17, BR-CO-18)", () => {
  it("stays silent on well-formed input", () => {
    for (const rule of ["BR-45", "BR-46", "BR-47", "BR-48", "BR-CO-17", "BR-CO-18"]) {
      expect(allIds(clean)).not.toContain(rule);
    }
  });

  it("BR-47 fires when a line carries no category, so the group has no code", () => {
    const inv = withLine({ vatCategory: undefined as never });
    const ids = allIds(inv);
    expect(ids).toContain("BR-CO-04");
    expect(ids).toContain("BR-47");
  });

  it("BR-48 accepts a missing rate only for category O", () => {
    // Category O legitimately has no BT-119; every other category must carry
    // one even when it is zero.
    expect(allIds(inCategory("O"))).not.toContain("BR-48");
    for (const category of ["Z", "E", "AE", "K", "G"] as const) {
      const totals = computeTotals(inCategory(category));
      expect(totals.subtotals[0]!.rate).toBe(0);
    }
  });

  it("says nothing at all when the lines cannot be totalled", () => {
    // baseQuantity 0 makes BT-131 uncomputable; BR-24 owns that, and the
    // breakdown rules must not pile on with derived noise.
    const ids = allIds(withLine({ baseQuantity: 0 }));
    expect(ids).toEqual(["BR-24"]);
  });
});

// ---------------------------------------------------------------------------
// Finding 13. BR-AE-02 has two halves and only the buyer half was enforced.
//
// The seller half is in the EN 16931 schematron, not in a CIUS:
//   exists(//cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID)
//   or exists(//cac:TaxRepresentativeParty/cac:PartyTaxScheme[…'VAT']/cbc:CompanyID)
// so it applies to every profile. Before this fix an `en16931` or
// `peppol-bis-3` invoice with reverse-charge lines and no seller identifier
// returned `valid: true` with zero errors, and only XRechnung caught it — under
// BR-DE-16, which is a different rule about a different thing.
//
// Probed 2026-08-12: KoSIT REJECTED the XRechnung form with
// [BR-AE-02, BR-DE-16] in both syntaxes, and this build now returns the same
// two ids.
// ---------------------------------------------------------------------------
describe("BR-AE-02: the seller half, on every profile (finding 13)", () => {
  const reverseCharge = (profile: InvoiceInput["profile"], seller: Partial<InvoiceInput["seller"]>): InvoiceInput => ({
    ...clean,
    profile,
    seller: { ...clean.seller, ...seller },
    lines: [cleanLine({ vatCategory: "AE", vatRate: 0 })],
    vatExemptionReasons: { AE: "Reverse charge" },
  });

  it.each(["en16931", "peppol-bis-3", "xrechnung-ubl", "xrechnung-cii"] as const)(
    "fires on %s when the seller carries no tax identifier at all",
    (profile) => {
      const ids = errorIds(
        reverseCharge(profile, { vatId: undefined, taxRegistrationId: undefined }),
      );
      expect(ids).toContain("BR-AE-02");
    },
  );

  it("is satisfied by BT-32 alone — the seller half takes any PartyTaxScheme", () => {
    const ids = errorIds(
      reverseCharge("en16931", { vatId: undefined, taxRegistrationId: "201/123/12345" }),
    );
    expect(ids).not.toContain("BR-AE-02");
  });

  it("is satisfied by a tax representative's VAT identifier", () => {
    const ids = errorIds({
      ...reverseCharge("en16931", { vatId: undefined, taxRegistrationId: undefined }),
      taxRepresentative: {
        name: "Fiscal Rep France SARL",
        vatId: "FR12345678901",
        address: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
      },
    });
    expect(ids).not.toContain("BR-AE-02");
  });

  it("still fires for the buyer half, and names the buyer terms", () => {
    const buyerHalf = findings({
      ...reverseCharge("en16931", {}),
      buyer: { ...clean.buyer, vatId: undefined },
    }).filter((e) => e.rule === "BR-AE-02");
    expect(buyerHalf).toHaveLength(1);
    expect(buyerHalf[0]!.field).toEqual(["BT-48", "BT-47"]);
  });

  it("says nothing on a well-formed reverse-charge invoice", () => {
    expect(errorIds(reverseCharge("en16931", {}))).not.toContain("BR-AE-02");
  });
});
