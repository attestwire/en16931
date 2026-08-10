import { describe, expect, it } from "vitest";
import { validateInput } from "./index.js";
import { computeTotals } from "./totals.js";
import {
  allIds,
  clean,
  cleanLine,
  findingFor,
  withInvoice,
  withLine,
} from "./testkit.js";
import type {
  DocumentAllowanceCharge,
  InvoiceInput,
  LineAllowanceCharge,
  TaxRepresentative,
  TeachingError,
  VatCategory,
} from "./types.js";

/**
 * BG-20 / BG-21 (document level) and BG-27 / BG-28 (line level).
 *
 * The tests are written against what EN 16931 *requires*, not against what the
 * implementation happens to do, so each name states the obligation. Where the
 * standard is asymmetric — two reason code lists that are not one list,
 * identifier demands that differ per VAT category, category O running backwards
 * — there is a test that pins the asymmetry down, because those are the places
 * a well-meaning refactor quietly makes both sides the same.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A well-formed document level allowance: BT-92, BT-95, BT-96, BT-97. */
const ALLOWANCE: DocumentAllowanceCharge = {
  amount: 25,
  vatCategory: "S",
  vatRate: 19,
  reason: "Volume discount",
};

/** A well-formed document level charge, with a UNCL 7161 code (BT-105). */
const CHARGE: DocumentAllowanceCharge = {
  amount: 15,
  vatCategory: "S",
  vatRate: 19,
  reason: "Freight service",
  reasonCode: "FC",
};

const LINE_ALLOWANCE: LineAllowanceCharge = {
  amount: 12.5,
  reason: "Damaged goods",
};

const LINE_CHARGE: LineAllowanceCharge = {
  amount: 5,
  reason: "Handling",
  reasonCode: "SH",
};

type Kind = "allowance" | "charge";

/** `clean` carrying one document level entry of the given kind. */
const withEntry = (
  kind: Kind,
  entry: DocumentAllowanceCharge,
  overrides: Partial<InvoiceInput> = {},
): InvoiceInput =>
  withInvoice(
    kind === "charge"
      ? { charges: [entry], ...overrides }
      : { allowances: [entry], ...overrides },
  );

const docAllowance = (
  overrides: Partial<DocumentAllowanceCharge> = {},
  invoice: Partial<InvoiceInput> = {},
): InvoiceInput => withEntry("allowance", { ...ALLOWANCE, ...overrides }, invoice);

const docCharge = (
  overrides: Partial<DocumentAllowanceCharge> = {},
  invoice: Partial<InvoiceInput> = {},
): InvoiceInput => withEntry("charge", { ...CHARGE, ...overrides }, invoice);

/** Either document level entry, chosen by kind — for the mirrored rule pairs. */
const docEntry = (
  kind: Kind,
  overrides: Partial<DocumentAllowanceCharge> = {},
): InvoiceInput =>
  kind === "charge" ? docCharge(overrides) : docAllowance(overrides);

const lineAllowance = (
  overrides: Partial<LineAllowanceCharge> = {},
): InvoiceInput => withLine({ allowances: [{ ...LINE_ALLOWANCE, ...overrides }] });

const lineCharge = (
  overrides: Partial<LineAllowanceCharge> = {},
): InvoiceInput => withLine({ charges: [{ ...LINE_CHARGE, ...overrides }] });

const lineEntry = (
  kind: Kind,
  overrides: Partial<LineAllowanceCharge> = {},
): InvoiceInput =>
  kind === "charge" ? lineCharge(overrides) : lineAllowance(overrides);

/** EN 16931 names the intra-community family BR-IC-* though the code is "K". */
const INFIX: Record<VatCategory, string> = {
  S: "S",
  Z: "Z",
  E: "E",
  AE: "AE",
  K: "IC",
  G: "G",
  O: "O",
};

const CATEGORIES = ["S", "Z", "E", "AE", "K", "G", "O"] as const;

/** BT-96 / BT-103 as the category demands it: S positive, O absent, rest zero. */
const catEntry = (
  category: VatCategory,
  kind: Kind,
): DocumentAllowanceCharge => ({
  amount: 25,
  vatCategory: category,
  ...(category === "O" ? {} : { vatRate: category === "S" ? 19 : 0 }),
  reason: kind === "charge" ? "Freight service" : "Volume discount",
});

const NO_SELLER_IDS = {
  ...clean.seller,
  vatId: undefined,
  taxRegistrationId: undefined,
};

/** A seller holding a national tax number (BT-32) and no VAT identifier. */
const TAX_NUMBER_ONLY = {
  ...clean.seller,
  vatId: undefined,
  taxRegistrationId: "18/181/08155",
};

const ANONYMOUS_BUYER = {
  ...clean.buyer,
  vatId: undefined,
  legalRegistrationId: undefined,
};

/** BG-11: a fiscal representative, whose BT-63 stands in for the seller's own. */
const TAX_REPRESENTATIVE: TaxRepresentative = {
  name: "Fiskaal Vertegenwoordiging BV",
  vatId: "NL123456789B01",
  address: { city: "Amsterdam", postalCode: "1011 AB", countryCode: "NL" },
};

/**
 * An invoice whose document level entry sits in `category` while the invoice
 * withholds exactly the identifiers that category's -03 / -04 rule demands.
 *
 * Category O is the exception and is built the other way up: BR-O-03 / BR-O-04
 * fire when the VAT identifiers are *present*, so the untouched `clean` party
 * data is already the failing case.
 */
const unidentified = (category: VatCategory, kind: Kind): InvoiceInput =>
  withEntry(
    kind,
    catEntry(category, kind),
    category === "O"
      ? { profile: "en16931" }
      : { profile: "en16931", seller: NO_SELLER_IDS, buyer: ANONYMOUS_BUYER },
  );

/** The same entry with a VAT rate the category forbids. */
const wrongRate = (category: VatCategory, kind: Kind): InvoiceInput =>
  withEntry(
    kind,
    {
      ...catEntry(category, kind),
      // S must be > 0, O must have none at all, everything else must be 0.
      vatRate: category === "S" || category === "O" ? 0 : 19,
    },
    { profile: "en16931" },
  );

// ---------------------------------------------------------------------------
// Silence on well-formed input
// ---------------------------------------------------------------------------

describe("a well-formed document level allowance and charge", () => {
  const both = withInvoice({ allowances: [ALLOWANCE], charges: [CHARGE] });

  it("is accepted by EN 16931 with no finding of any kind", () => {
    const result = validateInput(both);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("is accepted on its own, an allowance without a charge and the reverse", () => {
    expect(allIds(docAllowance())).toEqual([]);
    expect(allIds(docCharge())).toEqual([]);
  });

  it("is accepted with a base amount and a percentage alongside the amount", () => {
    // BT-93/BT-94 document how BT-92 was reached; supplying them is optional
    // and must not oblige anything further.
    expect(allIds(docAllowance({ baseAmount: 1500, percentage: 1.67 }))).toEqual([]);
  });

  it("is accepted several times over, each entry standing on its own", () => {
    const inv = withInvoice({
      allowances: [ALLOWANCE, { ...ALLOWANCE, amount: 10, reason: "Rebate" }],
      charges: [CHARGE, { ...CHARGE, amount: 4, reason: "Packing", reasonCode: "PC" }],
    });
    expect(allIds(inv)).toEqual([]);
  });

  it("is accepted at line level, allowance and charge together", () => {
    expect(allIds(withLine({ allowances: [LINE_ALLOWANCE], charges: [LINE_CHARGE] }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BR-31 / BR-36 — the amount is mandatory
// ---------------------------------------------------------------------------

describe("BR-31 / BR-36: every document level entry states an amount", () => {
  it("BR-31 fires when a document level allowance has no BT-92, naming the value", () => {
    const inv = docAllowance({ amount: undefined as never });
    expect(allIds(inv)).toContain("BR-31");
    expect(findingFor(inv, "BR-31")!.message).toContain("you supplied missing");
    expect(findingFor(docAllowance({ amount: Number.NaN }), "BR-31")!.message).toContain(
      "you supplied NaN",
    );
  });

  it("BR-36 fires when a document level charge has no BT-99, naming the value", () => {
    const inv = docCharge({ amount: undefined as never });
    expect(allIds(inv)).toContain("BR-36");
    expect(findingFor(inv, "BR-36")!.message).toContain("you supplied missing");
  });

  it("treats a percentage and a base amount as documentation, not a substitute", () => {
    // BT-93 + BT-94 describe how BT-92 was derived; they never stand in for it.
    const inv = docAllowance({
      amount: undefined as never,
      baseAmount: 1500,
      percentage: 1.67,
    });
    expect(allIds(inv)).toContain("BR-31");
  });

  it("accepts an amount of zero, which is a number even though it moves nothing", () => {
    expect(allIds(docAllowance({ amount: 0 }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BR-32 / BR-37 — the VAT category is mandatory
// ---------------------------------------------------------------------------

describe("BR-32 / BR-37: every document level entry states a VAT category", () => {
  it("BR-32 fires when a document level allowance has no BT-95", () => {
    const inv = docAllowance({ vatCategory: undefined as never });
    expect(allIds(inv)).toContain("BR-32");
    expect(findingFor(inv, "BR-32")!.message).toContain("you supplied missing");
    // A blank string is no category either.
    expect(allIds(docAllowance({ vatCategory: "  " as never }))).toContain("BR-32");
  });

  it("BR-37 fires when a document level charge has no BT-102", () => {
    const inv = docCharge({ vatCategory: undefined as never });
    expect(allIds(inv)).toContain("BR-37");
    expect(findingFor(inv, "BR-37")!.message).toContain("you supplied missing");
  });

  it("is satisfied by any of the seven categories EN 16931 admits", () => {
    for (const category of CATEGORIES) {
      const inv = withEntry("allowance", catEntry(category, "allowance"), {
        profile: "en16931",
      });
      expect(allIds(inv), category).not.toContain("BR-32");
    }
  });
});

// ---------------------------------------------------------------------------
// BR-33 / BR-38 with BR-CO-21 / BR-CO-22 — a reason, or a reason code
// ---------------------------------------------------------------------------

describe("BR-33 / BR-CO-21: a document allowance explains itself", () => {
  const bare = docAllowance({ reason: undefined, reasonCode: undefined });

  it("fires the cardinality rule and the co-occurrence rule, naming the amount", () => {
    // Not duplication: BR-33 constrains the BG-20 group, BR-CO-21 forbids the
    // one combination the two optional terms' cardinalities would allow. The
    // reference validators report both ids, so a caller searching either finds
    // the page they were sent to.
    const ids = allIds(bare);
    expect(ids).toContain("BR-33");
    expect(ids).toContain("BR-CO-21");
    expect(findingFor(bare, "BR-33")!.message).toContain("25");
  });

  it("is satisfied by free text alone (BT-97) or by a UNCL 5189 code alone (BT-98)", () => {
    expect(allIds(docAllowance({ reasonCode: undefined }))).toEqual([]);
    expect(allIds(docAllowance({ reason: undefined, reasonCode: "95" }))).toEqual([]);
  });

  it("treats whitespace in both terms as absence", () => {
    expect(allIds(docAllowance({ reason: "   ", reasonCode: "  " }))).toContain("BR-33");
  });
});

describe("BR-38 / BR-CO-22: a document charge explains itself", () => {
  const bare = docCharge({ reason: undefined, reasonCode: undefined });

  it("fires the cardinality rule and the co-occurrence rule, naming the amount", () => {
    const ids = allIds(bare);
    expect(ids).toContain("BR-38");
    expect(ids).toContain("BR-CO-22");
    expect(findingFor(bare, "BR-38")!.message).toContain("15");
  });

  it("is satisfied by free text alone (BT-104) or by a UNCL 7161 code alone (BT-105)", () => {
    expect(allIds(docCharge({ reasonCode: undefined }))).toEqual([]);
    expect(allIds(docCharge({ reason: undefined }))).toEqual([]);
  });

  it("points a CIUS user at the free text, because the code is what gets rendered", () => {
    // XRechnung mandates a human-readable visualisation, which renders the bare
    // code; "FC" on a screen is not an explanation of a surcharge.
    expect(findingFor(bare, "BR-38")!.fix).toContain("XRechnung");
    const core = withInvoice({
      profile: "en16931",
      charges: [{ ...CHARGE, reason: undefined, reasonCode: undefined }],
    });
    expect(findingFor(core, "BR-38")!.fix).not.toContain("XRechnung");
  });
});

// ---------------------------------------------------------------------------
// BR-DEC-01 / -02 / -05 / -06 — two decimals at document level
// ---------------------------------------------------------------------------

describe("BR-DEC-01/-02/-05/-06: document level amounts carry at most 2 decimals", () => {
  const DEC: [string, Kind, "amount" | "baseAmount"][] = [
    ["BR-DEC-01", "allowance", "amount"],
    ["BR-DEC-02", "allowance", "baseAmount"],
    ["BR-DEC-05", "charge", "amount"],
    ["BR-DEC-06", "charge", "baseAmount"],
  ];

  for (const [rule, kind, key] of DEC) {
    it(`${rule} rejects a third decimal on the ${kind} ${key} and accepts exactly two`, () => {
      const bad = docEntry(kind, { [key]: 25.001 });
      expect(allIds(bad)).toContain(rule);
      const finding = findingFor(bad, rule)!;
      expect(finding.message).toContain("25.001");
      expect(finding.message).toContain("which has 3");
      // Two decimals is the boundary, and it is inclusive.
      expect(allIds(docEntry(kind, { [key]: 25.01 }))).not.toContain(rule);
    });
  }

  it("counts the decimals that would be serialised, not the ones displayed", () => {
    // The schematron measures characters after the point in the XML, so a value
    // a UI shows as "25.00" still fails when the number carries more digits.
    const inv = docAllowance({ amount: 24.999999 });
    expect(allIds(inv)).toContain("BR-DEC-01");
    expect(findingFor(inv, "BR-DEC-01")!.fix).toContain("25.00");
  });

  it("says nothing about an absent base amount, which is optional", () => {
    expect(allIds(docAllowance({ baseAmount: undefined }))).not.toContain("BR-DEC-02");
  });
});

// ---------------------------------------------------------------------------
// BR-CL-19 / BR-CL-20 — two code lists that are not one code list
// ---------------------------------------------------------------------------

describe("BR-CL-19: an allowance reason code comes from UNCL 5189", () => {
  it("accepts a code that is in the list", () => {
    expect(allIds(docAllowance({ reasonCode: "95" }))).toEqual([]);
  });

  it("fires on a code that is in no list at all, naming the code", () => {
    const inv = docAllowance({ reasonCode: "ZZZ" });
    expect(allIds(inv)).toContain("BR-CL-19");
    expect(findingFor(inv, "BR-CL-19")!.message).toContain('"ZZZ"');
  });

  it("fires when an allowance borrows a charge-only code, and says which list it belongs to", () => {
    // "FC" (freight service) lives in UNCL 7161. Moving an entry from `charges`
    // to `allowances` without changing its code is exactly this failure.
    const inv = docAllowance({ reasonCode: "FC" });
    expect(allIds(inv)).toContain("BR-CL-19");
    const finding = findingFor(inv, "BR-CL-19")!;
    expect(finding.message).toContain('"FC"');
    expect(finding.message).toContain("charge list");
    expect(finding.message).toContain("UNCL 5189");
    // The list has no "other" entry, so free text is the escape.
    expect(finding.fix).toContain("reason");
  });
});

describe("BR-CL-20: a charge reason code comes from UNCL 7161", () => {
  it("accepts a code that is in the list", () => {
    expect(allIds(docCharge({ reasonCode: "PC" }))).toEqual([]);
  });

  it("fires on a code that is in no list at all, naming the code", () => {
    // "IN" is the near-miss abbreviation for insurance; UNCL 7161 has "IAA".
    const inv = docCharge({ reasonCode: "IN" });
    expect(allIds(inv)).toContain("BR-CL-20");
    expect(findingFor(inv, "BR-CL-20")!.message).toContain('"IN"');
  });

  it("fires when a charge borrows an allowance-only code, and says which list it belongs to", () => {
    // "95" (discount) lives in UNCL 5189 and nowhere in UNCL 7161.
    const inv = docCharge({ reasonCode: "95" });
    expect(allIds(inv)).toContain("BR-CL-20");
    const message = findingFor(inv, "BR-CL-20")!.message;
    expect(message).toContain('"95"');
    expect(message).toContain("allowance list");
    expect(message).toContain("UNCL 7161");
  });

  it("leaves an absent code to BR-38, rather than reporting an empty code", () => {
    expect(allIds(docCharge({ reason: undefined, reasonCode: undefined }))).not.toContain(
      "BR-CL-20",
    );
  });
});

// ---------------------------------------------------------------------------
// BR-CO-11 / BR-CO-12 — BT-107 = Σ BT-92, BT-108 = Σ BT-99
// ---------------------------------------------------------------------------

describe("BR-CO-11 / BR-CO-12: the declared totals equal the sums", () => {
  it("accept declared totals that match Σ BT-92 and Σ BT-99", () => {
    const inv = withInvoice({
      allowances: [ALLOWANCE, { ...ALLOWANCE, amount: 10 }],
      charges: [CHARGE],
      declaredTotals: { allowanceTotalAmount: 35, chargeTotalAmount: 15 },
    });
    const ids = allIds(inv);
    expect(ids).not.toContain("BR-CO-11");
    expect(ids).not.toContain("BR-CO-12");
  });

  it("fire when the declared totals disagree, quoting both figures and the delta", () => {
    const inv = withInvoice({
      allowances: [ALLOWANCE],
      charges: [CHARGE],
      declaredTotals: { allowanceTotalAmount: 30, chargeTotalAmount: 20 },
    });
    const ids = allIds(inv);
    expect(ids).toContain("BR-CO-11");
    expect(ids).toContain("BR-CO-12");
    const allowanceMessage = findingFor(inv, "BR-CO-11")!.message;
    expect(allowanceMessage).toContain("30.00");
    expect(allowanceMessage).toContain("25.00");
    expect(allowanceMessage).toContain("+5.00");
    const chargeMessage = findingFor(inv, "BR-CO-12")!.message;
    expect(chargeMessage).toContain("20.00");
    expect(chargeMessage).toContain("15.00");
  });

  it("hold BT-107 and BT-108 apart even when the two entries cancel out", () => {
    // An allowance and a charge of the same size in the same group leave BT-109
    // unchanged, but BT-107 and BT-108 are gross disclosures and stay separate.
    const inv = withInvoice({
      allowances: [{ ...ALLOWANCE, amount: 20 }],
      charges: [{ ...CHARGE, amount: 20 }],
      declaredTotals: { allowanceTotalAmount: 0, chargeTotalAmount: 0 },
    });
    const ids = allIds(inv);
    expect(ids).toContain("BR-CO-11");
    expect(ids).toContain("BR-CO-12");
  });

  it("keep line level charges out of BT-108, where they would be double counted", () => {
    // BG-28 is already inside BT-131 and therefore inside BT-106.
    const inv = withInvoice({
      lines: [cleanLine({ charges: [LINE_CHARGE] })],
      declaredTotals: { chargeTotalAmount: 0 },
    });
    expect(allIds(inv)).not.toContain("BR-CO-12");
  });

  it("say nothing when the declared total is not a usable number", () => {
    const inv = withInvoice({
      allowances: [ALLOWANCE],
      charges: [CHARGE],
      declaredTotals: {
        allowanceTotalAmount: Number.NaN,
        chargeTotalAmount: Number.POSITIVE_INFINITY,
      },
    });
    const ids = allIds(inv);
    expect(ids).not.toContain("BR-CO-11");
    expect(ids).not.toContain("BR-CO-12");
  });

  it("defer to the line rules when the lines cannot be totalled at all", () => {
    const inv = withInvoice({
      lines: [cleanLine({ baseQuantity: 0 })],
      allowances: [ALLOWANCE],
      declaredTotals: { allowanceTotalAmount: 999 },
    });
    expect(allIds(inv)).toEqual(["BR-24"]);
  });
});

// ---------------------------------------------------------------------------
// BR-DEC-10 / BR-DEC-11 — two decimals on BT-107 and BT-108
// ---------------------------------------------------------------------------

describe("BR-DEC-10 / BR-DEC-11: the declared sums carry at most 2 decimals", () => {
  it("fire on over-precise declared BT-107 and BT-108, quoting the values", () => {
    const inv = withInvoice({
      allowances: [ALLOWANCE],
      charges: [CHARGE],
      declaredTotals: { allowanceTotalAmount: 25.001, chargeTotalAmount: 15.0004 },
    });
    const ids = allIds(inv);
    expect(ids).toContain("BR-DEC-10");
    expect(ids).toContain("BR-DEC-11");
    expect(findingFor(inv, "BR-DEC-10")!.message).toContain("25.001");
    expect(findingFor(inv, "BR-DEC-11")!.message).toContain("15.0004");
  });

  it("accept exactly two decimals on both totals", () => {
    const inv = withInvoice({
      allowances: [{ ...ALLOWANCE, amount: 25.01 }],
      charges: [{ ...CHARGE, amount: 15.02 }],
      declaredTotals: { allowanceTotalAmount: 25.01, chargeTotalAmount: 15.02 },
    });
    const ids = allIds(inv);
    expect(ids).not.toContain("BR-DEC-10");
    expect(ids).not.toContain("BR-DEC-11");
  });

  it("say nothing when no totals were declared at all", () => {
    const ids = allIds(withInvoice({ allowances: [ALLOWANCE], charges: [CHARGE] }));
    expect(ids).not.toContain("BR-DEC-10");
    expect(ids).not.toContain("BR-DEC-11");
  });
});

// ---------------------------------------------------------------------------
// Line level
// ---------------------------------------------------------------------------

describe("BR-41 / BR-43: every line level entry states an amount", () => {
  it("fire when a line allowance or charge has no BT-136 / BT-141", () => {
    const onAllowance = lineAllowance({ amount: undefined as never });
    const onCharge = lineCharge({ amount: undefined as never });
    expect(allIds(onAllowance)).toContain("BR-41");
    expect(allIds(onCharge)).toContain("BR-43");
    expect(findingFor(onAllowance, "BR-41")!.message).toContain("you supplied missing");
    expect(findingFor(onCharge, "BR-43")!.message).toContain("you supplied missing");
  });

  it("locate the offending entry by line and by line identifier", () => {
    const inv = withInvoice({
      lines: [
        cleanLine(),
        cleanLine({ id: "2", allowances: [{ amount: undefined as never, reason: "x" }] }),
      ],
    });
    const message = findingFor(inv, "BR-41")!.message;
    expect(message).toContain("line 2");
    expect(message).toContain('id "2"');
  });

  it("accept a well-formed line allowance and charge together", () => {
    expect(allIds(withLine({ allowances: [LINE_ALLOWANCE], charges: [LINE_CHARGE] }))).toEqual([]);
  });
});

describe("BR-42 / BR-CO-23 and BR-44 / BR-CO-24: line entries explain themselves", () => {
  it("fire both the cardinality and the co-occurrence rule at line level", () => {
    const onAllowance = lineAllowance({ reason: undefined, reasonCode: undefined });
    const onCharge = lineCharge({ reason: undefined, reasonCode: undefined });
    expect(allIds(onAllowance)).toContain("BR-42");
    expect(allIds(onAllowance)).toContain("BR-CO-23");
    expect(allIds(onCharge)).toContain("BR-44");
    expect(allIds(onCharge)).toContain("BR-CO-24");
  });

  it("are satisfied by free text alone", () => {
    expect(allIds(lineAllowance({ reasonCode: undefined }))).toEqual([]);
    expect(allIds(lineCharge({ reasonCode: undefined }))).toEqual([]);
  });

  it("are satisfied by a code alone, drawn from the right list", () => {
    expect(allIds(lineAllowance({ reason: undefined, reasonCode: "100" }))).toEqual([]);
    expect(allIds(lineCharge({ reason: undefined, reasonCode: "SH" }))).toEqual([]);
  });

  it("explain that a line adjustment vanishes into BT-131 unless it is named", () => {
    const inv = lineAllowance({ reason: undefined, reasonCode: undefined });
    expect(findingFor(inv, "BR-42")!.message).toContain("line net amount");
  });
});

describe("BR-CL-19 / BR-CL-20 apply at line level too", () => {
  it("reject a charge-list code on a line allowance, and locate the line", () => {
    const inv = lineAllowance({ reasonCode: "FC" });
    expect(allIds(inv)).toContain("BR-CL-19");
    const message = findingFor(inv, "BR-CL-19")!.message;
    expect(message).toContain("charge list");
    expect(message).toContain("line 1");
  });

  it("reject an allowance-list code on a line charge", () => {
    const inv = lineCharge({ reasonCode: "95" });
    expect(allIds(inv)).toContain("BR-CL-20");
    expect(findingFor(inv, "BR-CL-20")!.message).toContain("allowance list");
  });
});

describe("BR-DEC-24/-25/-27/-28: line level amounts carry at most 2 decimals", () => {
  const DEC: [string, Kind, "amount" | "baseAmount"][] = [
    ["BR-DEC-24", "allowance", "amount"],
    ["BR-DEC-25", "allowance", "baseAmount"],
    ["BR-DEC-27", "charge", "amount"],
    ["BR-DEC-28", "charge", "baseAmount"],
  ];

  for (const [rule, kind, key] of DEC) {
    it(`${rule} rejects a third decimal on the line ${kind} ${key} and accepts exactly two`, () => {
      const bad = lineEntry(kind, { [key]: 12.505 });
      expect(allIds(bad)).toContain(rule);
      const finding = findingFor(bad, rule)!;
      expect(finding.message).toContain("12.505");
      expect(finding.message).toContain("which has 3");
      expect(allIds(lineEntry(kind, { [key]: 12.5 }))).not.toContain(rule);
    });
  }
});

// ---------------------------------------------------------------------------
// Per-category -03 / -04: the identifiers the category demands
// ---------------------------------------------------------------------------

describe("the -03 / -04 families: a category demands its identifiers", () => {
  it("fire for every category, on an allowance and on a charge alike", () => {
    for (const category of CATEGORIES) {
      const allowanceRule = `BR-${INFIX[category]}-03`;
      const chargeRule = `BR-${INFIX[category]}-04`;
      const onAllowance = unidentified(category, "allowance");
      const onCharge = unidentified(category, "charge");
      expect(allIds(onAllowance), category).toContain(allowanceRule);
      expect(allIds(onCharge), category).toContain(chargeRule);
      // The message points at the caller's own field, not just at the XML.
      expect(findingFor(onAllowance, allowanceRule)!.message, category).toContain(
        "allowances[0]",
      );
      expect(findingFor(onCharge, chargeRule)!.message, category).toContain("charges[0]");
    }
  });

  it("accept the seller VAT identifier (BT-31) for every category that admits one", () => {
    for (const category of ["S", "Z", "E", "K", "G"] as const) {
      const inv = withEntry("allowance", catEntry(category, "allowance"), {
        profile: "en16931",
      });
      expect(allIds(inv), category).not.toContain(`BR-${INFIX[category]}-03`);
    }
  });

  it("accept a national tax number (BT-32) for the S, Z and E families", () => {
    for (const category of ["S", "Z", "E"] as const) {
      const inv = withEntry("allowance", catEntry(category, "allowance"), {
        profile: "en16931",
        seller: TAX_NUMBER_ONLY,
      });
      expect(allIds(inv), category).not.toContain(`BR-${INFIX[category]}-03`);
    }
  });

  it("refuse a national tax number (BT-32) for the intra-community and export families", () => {
    // BR-IC-03 and BR-G-03 are stricter than BR-S-03 on purpose: a Steuernummer
    // does not resolve in VIES and is not what customs export evidence is filed
    // under, so a seller invoicing on one alone cannot zero-rate either supply.
    for (const category of ["K", "G"] as const) {
      const inv = withEntry("allowance", catEntry(category, "allowance"), {
        profile: "en16931",
        seller: TAX_NUMBER_ONLY,
      });
      expect(allIds(inv), category).toContain(`BR-${INFIX[category]}-03`);
    }
  });

  it("require the buyer to be identified as well, for reverse charge", () => {
    // AE is the only allowance/charge family that constrains the buyer: the
    // liability moves to them, so both ends of the transfer must be traceable.
    const anonymous = withEntry("allowance", catEntry("AE", "allowance"), {
      profile: "en16931",
      buyer: ANONYMOUS_BUYER,
    });
    expect(allIds(anonymous)).toContain("BR-AE-03");
    // BT-47 satisfies it as readily as BT-48 does.
    const registered = withEntry("charge", catEntry("AE", "charge"), {
      profile: "en16931",
      buyer: { ...ANONYMOUS_BUYER, legalRegistrationId: "HRB 12345" },
    });
    expect(allIds(registered)).not.toContain("BR-AE-04");
  });

  it("require the buyer VAT identifier specifically, for an intra-community supply", () => {
    // BR-IC-03 admits only BT-48 on the buyer side; a legal registration number
    // is not a VIES-resolvable identifier.
    const inv = withEntry("allowance", catEntry("K", "allowance"), {
      profile: "en16931",
      buyer: { ...ANONYMOUS_BUYER, legalRegistrationId: "HRB 12345" },
    });
    expect(allIds(inv)).toContain("BR-IC-03");
  });

  it("run BR-O-03 / BR-O-04 backwards: the identifiers must be absent", () => {
    // "Not subject to VAT" and "here is my VAT number for this transaction" are
    // contradictory claims, so O forbids what the other six require.
    const failing = unidentified("O", "allowance");
    expect(allIds(failing)).toContain("BR-O-03");
    expect(findingFor(failing, "BR-O-03")!.message).toContain("must not contain");

    const passing = withEntry("allowance", catEntry("O", "allowance"), {
      profile: "en16931",
      seller: TAX_NUMBER_ONLY,
      buyer: ANONYMOUS_BUYER,
    });
    expect(allIds(passing)).not.toContain("BR-O-03");

    // A tax representative's BT-63 is a VAT identifier too, and equally fatal.
    const withRep = withInvoice({
      profile: "en16931",
      seller: TAX_NUMBER_ONLY,
      buyer: ANONYMOUS_BUYER,
      taxRepresentative: TAX_REPRESENTATIVE,
      allowances: [catEntry("O", "allowance")],
    });
    expect(allIds(withRep)).toContain("BR-O-03");
  });

  it("accept a tax representative's BT-63 in place of the seller's own identifier", () => {
    // BG-11 exists for a seller registered abroad through a fiscal
    // representative; every family except O admits BT-63 for the seller half.
    for (const category of ["S", "Z", "E", "AE", "K", "G"] as const) {
      const inv = withEntry("allowance", catEntry(category, "allowance"), {
        profile: "en16931",
        seller: NO_SELLER_IDS,
        taxRepresentative: TAX_REPRESENTATIVE,
      });
      expect(allIds(inv), category).not.toContain(`BR-${INFIX[category]}-03`);
    }
  });

  it("report one finding per direction, however many entries share the fault", () => {
    const inv = withInvoice({
      profile: "en16931",
      seller: NO_SELLER_IDS,
      buyer: ANONYMOUS_BUYER,
      allowances: [catEntry("S", "allowance"), catEntry("S", "allowance")],
      charges: [catEntry("S", "charge")],
    });
    const ids = allIds(inv);
    expect(ids.filter((r) => r === "BR-S-03")).toHaveLength(1);
    expect(ids.filter((r) => r === "BR-S-04")).toHaveLength(1);
    expect(findingFor(inv, "BR-S-03")!.message).toContain("allowances[0], allowances[1]");
  });

  it("say nothing about a category no document level entry uses", () => {
    const inv = withEntry("allowance", catEntry("S", "allowance"), {
      profile: "en16931",
      seller: NO_SELLER_IDS,
      buyer: ANONYMOUS_BUYER,
    });
    for (const category of ["Z", "E", "AE", "K", "G", "O"] as const) {
      expect(allIds(inv), category).not.toContain(`BR-${INFIX[category]}-03`);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-category -06 / -07: the rate the category demands
// ---------------------------------------------------------------------------

describe("the -06 / -07 families: a category fixes its VAT rate", () => {
  it("fire for every category, on an allowance and on a charge alike", () => {
    for (const category of CATEGORIES) {
      expect(allIds(wrongRate(category, "allowance")), category).toContain(
        `BR-${INFIX[category]}-06`,
      );
      expect(allIds(wrongRate(category, "charge")), category).toContain(
        `BR-${INFIX[category]}-07`,
      );
    }
  });

  it("BR-S-06 requires a rate greater than zero, because S means taxed", () => {
    const inv = docAllowance({ vatRate: 0 });
    expect(allIds(inv)).toContain("BR-S-06");
    expect(findingFor(inv, "BR-S-06")!.message).toContain(
      "must be greater than zero, but it is 0",
    );
    // An omitted rate is no better: S must name the rate it is taxed at.
    expect(allIds(docAllowance({ vatRate: undefined }))).toContain("BR-S-06");
  });

  it("BR-S-06 accepts a reduced rate as readily as a standard one", () => {
    const inv = withInvoice({
      allowances: [{ ...ALLOWANCE, vatRate: 7 }],
      lines: [cleanLine({ vatRate: 7 })],
    });
    expect(allIds(inv)).not.toContain("BR-S-06");
  });

  it("the zero-rate families require exactly 0, and name the rate supplied", () => {
    for (const category of ["Z", "E", "AE", "K", "G"] as const) {
      const finding = findingFor(
        wrongRate(category, "allowance"),
        `BR-${INFIX[category]}-06`,
      )!;
      expect(finding.message, category).toContain("must be 0 (zero), but it is 19");
    }
  });

  it("the zero-rate families accept an omitted rate as equivalent to zero", () => {
    for (const category of ["Z", "E", "AE", "K", "G"] as const) {
      const inv = withEntry(
        "allowance",
        { ...catEntry(category, "allowance"), vatRate: undefined },
        { profile: "en16931" },
      );
      expect(allIds(inv), category).not.toContain(`BR-${INFIX[category]}-06`);
    }
  });

  it("BR-O-06 rejects even a rate of zero, which is a different claim from none", () => {
    // Zero means "taxed, at nothing"; absent means "not taxed at all". The two
    // are reported differently on a VAT return, so EN 16931 keeps them apart.
    expect(findingFor(wrongRate("O", "allowance"), "BR-O-06")!.message).toContain(
      "must not be present at all",
    );
    const noRate = withEntry("allowance", catEntry("O", "allowance"), {
      profile: "en16931",
      seller: TAX_NUMBER_ONLY,
      buyer: ANONYMOUS_BUYER,
    });
    expect(allIds(noRate)).not.toContain("BR-O-06");
  });

  it("leaves an unusable category to BR-32 rather than guessing a rate rule", () => {
    const inv = docAllowance({ vatCategory: "X" as never });
    expect(allIds(inv).filter((r) => /^BR-[A-Z]+-0[67]$/.test(r))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BR-O-13 / BR-O-14: category O does not share a document
// ---------------------------------------------------------------------------

describe("BR-O-13 / BR-O-14: an out-of-scope invoice carries no in-scope adjustment", () => {
  const outOfScope = {
    profile: "en16931" as const,
    seller: TAX_NUMBER_ONLY,
    buyer: ANONYMOUS_BUYER,
    lines: [cleanLine({ vatCategory: "O" as const, vatRate: undefined })],
  };

  it("BR-O-13 fires on a non-O document allowance, naming its category", () => {
    const inv = withInvoice({ ...outOfScope, allowances: [ALLOWANCE] });
    expect(allIds(inv)).toContain("BR-O-13");
    expect(findingFor(inv, "BR-O-13")!.message).toContain("allowances[0] (S)");
  });

  it("BR-O-14 fires on a non-O document charge, naming its category", () => {
    const inv = withInvoice({ ...outOfScope, charges: [CHARGE] });
    expect(allIds(inv)).toContain("BR-O-14");
    expect(findingFor(inv, "BR-O-14")!.message).toContain("charges[0] (S)");
  });

  it("stays silent when every adjustment is category O as well", () => {
    const inv = withInvoice({
      ...outOfScope,
      allowances: [catEntry("O", "allowance")],
      charges: [catEntry("O", "charge")],
    });
    const ids = allIds(inv);
    expect(ids).not.toContain("BR-O-13");
    expect(ids).not.toContain("BR-O-14");
  });

  it("stays silent on a document with no category O anywhere", () => {
    const inv = withInvoice({ allowances: [ALLOWANCE], charges: [CHARGE] });
    expect(allIds(inv)).not.toContain("BR-O-13");
  });

  it("leaves a categoryless entry to BR-32, rather than counting it as non-O", () => {
    const inv = withInvoice({
      ...outOfScope,
      allowances: [{ ...ALLOWANCE, vatCategory: undefined as never }],
    });
    const ids = allIds(inv);
    expect(ids).toContain("BR-32");
    expect(ids).not.toContain("BR-O-13");
  });
});

// ---------------------------------------------------------------------------
// Totals interaction
// ---------------------------------------------------------------------------

describe("document level entries in the VAT breakdown", () => {
  const inv = withInvoice({ allowances: [ALLOWANCE], charges: [CHARGE] });

  it("nets an allowance and a charge into the taxable amount of their group", () => {
    // BT-116 = Σ BT-131 − Σ BT-92 + Σ BT-99 within one (category, rate) group.
    const totals = computeTotals(inv);
    expect(totals.subtotals).toHaveLength(1);
    expect(totals.subtotals[0]!.taxableAmount).toBe(1490);
    expect(totals.subtotals[0]!.taxAmount).toBe(283.1);
  });

  it("keeps BT-107 and BT-108 as separate gross sums", () => {
    const totals = computeTotals(inv);
    expect(totals.allowanceTotalAmount).toBe(25);
    expect(totals.chargeTotalAmount).toBe(15);
    expect(totals.lineExtensionAmount).toBe(1500);
    expect(totals.taxExclusiveAmount).toBe(1490);
  });

  it("does not disturb the -08 / -09 invariants of the breakdown", () => {
    expect(allIds(inv)).toEqual([]);
  });

  it("opens a second breakdown group when the adjustment sits at another rate", () => {
    // Only category S may repeat in BG-23, once per distinct rate.
    const split = withInvoice({ allowances: [{ ...ALLOWANCE, vatRate: 7 }] });
    const totals = computeTotals(split);
    expect(totals.subtotals).toHaveLength(2);
    expect(totals.subtotals[1]!.taxableAmount).toBe(-25);
    expect(allIds(split)).toEqual([]);
  });

  it("leaves the line totals to absorb a line level allowance and charge", () => {
    const withBoth = withLine({ allowances: [LINE_ALLOWANCE], charges: [LINE_CHARGE] });
    const totals = computeTotals(withBoth);
    expect(totals.lineNetAmounts[0]).toBe(1492.5);
    expect(totals.allowanceTotalAmount).toBe(0);
    expect(totals.chargeTotalAmount).toBe(0);
    expect(allIds(withBoth)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The teaching-error contract, across everything this family emits
// ---------------------------------------------------------------------------

/** Every rule id the allowance and charge families can raise. */
const FAMILY_IDS = new Set<string>([
  "BR-31", "BR-32", "BR-33", "BR-36", "BR-37", "BR-38",
  "BR-41", "BR-42", "BR-43", "BR-44",
  "BR-CO-11", "BR-CO-12", "BR-CO-21", "BR-CO-22", "BR-CO-23", "BR-CO-24",
  "BR-CL-19", "BR-CL-20",
  "BR-DEC-01", "BR-DEC-02", "BR-DEC-05", "BR-DEC-06",
  "BR-DEC-10", "BR-DEC-11",
  "BR-DEC-24", "BR-DEC-25", "BR-DEC-27", "BR-DEC-28",
  "BR-O-13", "BR-O-14",
  ...CATEGORIES.flatMap((c) =>
    ["03", "04", "06", "07"].map((s) => `BR-${INFIX[c]}-${s}`),
  ),
]);

const BATTERY: [string, InvoiceInput][] = [
  ["noAllowanceAmount", docAllowance({ amount: undefined as never })],
  ["noChargeAmount", docCharge({ amount: undefined as never })],
  ["noAllowanceCategory", docAllowance({ vatCategory: undefined as never })],
  ["noChargeCategory", docCharge({ vatCategory: undefined as never })],
  ["unexplainedAllowance", docAllowance({ reason: undefined, reasonCode: undefined })],
  ["unexplainedCharge", docCharge({ reason: undefined, reasonCode: undefined })],
  ["longAllowanceAmount", docAllowance({ amount: 25.001, baseAmount: 1500.005 })],
  ["longChargeAmount", docCharge({ amount: 15.001, baseAmount: 1500.005 })],
  ["crossedAllowanceCode", docAllowance({ reasonCode: "FC" })],
  ["crossedChargeCode", docCharge({ reasonCode: "95" })],
  ["unknownAllowanceCode", docAllowance({ reasonCode: "ZZZ" })],
  ["unknownChargeCode", docCharge({ reasonCode: "IN" })],
  [
    "mismatchedTotals",
    withInvoice({
      allowances: [ALLOWANCE],
      charges: [CHARGE],
      declaredTotals: { allowanceTotalAmount: 30, chargeTotalAmount: 20 },
    }),
  ],
  [
    "longDeclaredTotals",
    withInvoice({
      allowances: [ALLOWANCE],
      charges: [CHARGE],
      declaredTotals: { allowanceTotalAmount: 25.001, chargeTotalAmount: 15.0004 },
    }),
  ],
  ["noLineAllowanceAmount", lineAllowance({ amount: undefined as never })],
  ["noLineChargeAmount", lineCharge({ amount: undefined as never })],
  ["unexplainedLineAllowance", lineAllowance({ reason: undefined, reasonCode: undefined })],
  ["unexplainedLineCharge", lineCharge({ reason: undefined, reasonCode: undefined })],
  ["longLineAllowance", lineAllowance({ amount: 12.505, baseAmount: 100.001 })],
  ["longLineCharge", lineCharge({ amount: 12.505, baseAmount: 100.001 })],
  ["crossedLineAllowanceCode", lineAllowance({ reasonCode: "FC" })],
  ["crossedLineChargeCode", lineCharge({ reasonCode: "95" })],
  [
    "outOfScopeMixedAdjustments",
    withInvoice({
      profile: "en16931",
      seller: TAX_NUMBER_ONLY,
      buyer: ANONYMOUS_BUYER,
      lines: [cleanLine({ vatCategory: "O", vatRate: undefined })],
      allowances: [ALLOWANCE],
      charges: [CHARGE],
    }),
  ],
  ...CATEGORIES.flatMap(
    (c) =>
      [
        [`unidentified_${c}_allowance`, unidentified(c, "allowance")],
        [`unidentified_${c}_charge`, unidentified(c, "charge")],
        [`wrongRate_${c}_allowance`, wrongRate(c, "allowance")],
        [`wrongRate_${c}_charge`, wrongRate(c, "charge")],
      ] as [string, InvoiceInput][],
  ),
];

const harvested: { fixture: string; error: TeachingError }[] = [];
for (const [fixture, invoice] of BATTERY) {
  const result = validateInput(invoice);
  for (const error of [...result.errors, ...result.warnings]) {
    if (FAMILY_IDS.has(error.rule)) harvested.push({ fixture, error });
  }
}

describe("every finding the allowance and charge families emit", () => {
  it("is raised at all: the battery reaches every rule in the family", () => {
    const fired = new Set(harvested.map((h) => h.error.rule));
    expect([...FAMILY_IDS].filter((id) => !fired.has(id)).sort()).toEqual([]);
  });

  it("is fatal, and carries a business term for every id it names", () => {
    for (const { fixture, error } of harvested) {
      const where = `${fixture} / ${error.rule}`;
      expect(error.severity, where).toBe("fatal");
      const terms = Array.isArray(error.field) ? error.field : [error.field];
      expect(terms.length, where).toBeGreaterThan(0);
      for (const term of terms) expect(term, where).toMatch(/^B[TG]-\d+$/);
    }
  });

  it("teaches: a real message and a real, actionable fix", () => {
    for (const { fixture, error } of harvested) {
      const where = `${fixture} / ${error.rule}`;
      expect(error.message.length, where).toBeGreaterThan(80);
      expect(error.fix.length, where).toBeGreaterThan(20);
      expect(error.message, where).not.toBe(error.fix);
      expect(error.message.trim(), where).toMatch(/[.!?)"']$/);
      expect(error.fix.trim(), where).toMatch(/[.!?)"']$/);
    }
  });

  it("points at one docs page per rule id, built from the same pattern", () => {
    for (const { fixture, error } of harvested) {
      expect(error.docsUrl, `${fixture} / ${error.rule}`).toBe(
        `https://attestwire.com/rules/${error.rule}`,
      );
    }
  });

  it("carries an absolute XPath into the offending element", () => {
    for (const { fixture, error } of harvested) {
      const where = `${fixture} / ${error.rule}`;
      expect(error.xpath, where).toBeDefined();
      expect(error.xpath!, where).toMatch(/^\/ubl:Invoice/);
      expect(error.xpath!, where).not.toMatch(/\s/);
    }
  });

  it("shows a JSON fragment that would pass", () => {
    for (const { fixture, error } of harvested) {
      const where = `${fixture} / ${error.rule}`;
      expect(error.example, where).toBeDefined();
      expect(error.example!, where).toContain('"');
    }
  });

  it("never throws on any of the broken fixtures", () => {
    for (const [fixture, invoice] of BATTERY) {
      expect(() => validateInput(invoice), fixture).not.toThrow();
    }
  });
});
