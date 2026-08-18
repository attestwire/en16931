import { describe, expect, it } from "vitest";
import {
  generateXRechnungUBL,
  validateInput,
  type InvoiceInput,
} from "./index.js";
import { isValidIban } from "./rules-de.js";
import { allIds, cleanLine, errorIds, warningIds, withInvoice } from "./testkit.js";

/**
 * Every finding including `information`. `allIds` covers errors and warnings
 * only, and BR-DE-TMP-32 is KoSIT's one `information` rule — testing it through
 * `allIds` passes whatever the rule does.
 */
const allIdsWithInfo = (inv: InvoiceInput): string[] => {
  const r = validateInput(inv);
  return [...r.errors, ...r.warnings, ...r.information].map((e) => e.rule);
};

/**
 * Regression tests for the defects wave D's adversarial cross-read confirmed.
 *
 * Each block states the official expression it is holding us to, because the
 * failure mode these guard against is not "the code is wrong" but "the code
 * matches a plausible *paraphrase* of the rule". Every one of these bugs
 * survived three waves and a 783-test suite by being reasonable-looking.
 */

/** A base with no XRechnung/Peppol profile obligations in the way. */
const core = (over: Partial<InvoiceInput> = {}): InvoiceInput => ({
  profile: "en16931",
  invoiceNumber: "INV-1",
  issueDate: "2026-01-15",
  currency: "EUR",
  seller: {
    name: "Seller GmbH",
    taxRegistrationId: "12/345/67890",
    // BR-CO-26 names BT-29/BT-30/BT-31; BT-32 is not one of them.
    legalRegistrationId: "HRB 12345",
    address: { line1: "Str 1", city: "Berlin", postalCode: "10115", countryCode: "DE" },
  },
  buyer: {
    name: "Buyer Ltd",
    address: { line1: "Rd 2", city: "Köln", postalCode: "50667", countryCode: "DE" },
  },
  lines: [
    {
      id: "1",
      description: "Widget",
      quantity: 1,
      unitCode: "C62",
      unitPrice: 100,
      vatCategory: "S",
      vatRate: 19,
    },
  ],
  payment: { meansCode: "58", iban: "DE02120300000000202051" },
  ...over,
});

// ---------------------------------------------------------------------------

describe("validateInput never throws on a malformed payload", () => {
  // The package's whole proposition is a teaching error rather than a stack
  // trace, and `lines` missing entirely is the likeliest malformed input there
  // is — a JSON body off an HTTP request that a TypeScript signature never got
  // to police. Before 0.2.0 every one of these threw a TypeError out of
  // `usesCategory`, so the caller got nothing at all.
  const malformed: [string, unknown][] = [
    ["no lines key", { profile: "en16931", invoiceNumber: "1", issueDate: "2026-01-01", currency: "EUR", seller: { name: "s" }, buyer: { name: "b" } }],
    ["lines null", { profile: "en16931", invoiceNumber: "1", issueDate: "2026-01-01", currency: "EUR", seller: { name: "s" }, buyer: { name: "b" }, lines: null }],
    ["lines not an array", { profile: "en16931", invoiceNumber: "1", issueDate: "2026-01-01", currency: "EUR", seller: { name: "s" }, buyer: { name: "b" }, lines: "x" }],
    ["an empty object", {}],
    ["xrechnung with no lines key", { profile: "xrechnung-ubl", invoiceNumber: "1", issueDate: "2026-01-01", currency: "EUR", seller: { name: "s" }, buyer: { name: "b" } }],
  ];

  for (const [label, payload] of malformed) {
    it(`returns findings rather than throwing for ${label}`, () => {
      expect(() => validateInput(payload as InvoiceInput)).not.toThrow();
      const result = validateInput(payload as InvoiceInput);
      expect(result.valid).toBe(false);
      // BR-16 is the finding that actually explains the problem.
      expect(result.errors.map((e) => e.rule)).toContain("BR-16");
    });
  }
});

// ---------------------------------------------------------------------------

describe("every date term is checked against the calendar", () => {
  // UBL types all of these `xs:date`. Before 0.2.0 only BT-73/BT-74 were
  // checked; BT-2 was matched against a shape regex that "2026-02-30" passes,
  // and BT-9, BT-7, BT-72 and BT-26 were not checked at all — so an impossible
  // date validated clean and produced XML that fails schema validation.
  const impossible = ["2026-02-30", "2026-13-01", "2026-00-10", "2025-02-29", "2026-04-31"];

  for (const date of impossible) {
    it(`rejects an issue date of ${date}`, () => {
      expect(errorIds(core({ issueDate: date }))).toContain(
        "ATW-DATE-NOT-A-CALENDAR-DATE",
      );
    });
  }

  it("accepts a real leap day", () => {
    expect(allIds(core({ issueDate: "2024-02-29" }))).toEqual([]);
  });

  it.each([
    ["dueDate", "BT-9"],
    ["taxPointDate", "BT-7"],
    ["deliveryDate", "BT-72"],
  ])("checks %s (%s), which had no format rule at all", (key) => {
    expect(errorIds(core({ [key]: "2026-02-31" } as Partial<InvoiceInput>))).toContain(
      "ATW-DATE-NOT-A-CALENDAR-DATE",
    );
  });

  it("checks the preceding invoice issue date (BT-26)", () => {
    const inv = core({ precedingInvoices: [{ invoiceNumber: "A", issueDate: "2026-13-01" }] });
    expect(errorIds(inv)).toContain("ATW-DATE-NOT-A-CALENDAR-DATE");
  });

  it("checks invoice line period dates (BT-134 / BT-135)", () => {
    const inv = core({ lines: [{ ...cleanLine(), period: { startDate: "2026-02-30" } }] });
    expect(errorIds(inv)).toContain("ATW-DATE-NOT-A-CALENDAR-DATE");
  });

  it("reports it under PEPPOL-EN16931-F001 on the Peppol profile", () => {
    // The official Peppol rule is `string-length(text()) = 10 and
    // (string(.) castable as xs:date)`, flag fatal. Elsewhere there is no BR-*
    // to cite, because core EN 16931 leaves it to the schema.
    const ids = errorIds(core({ profile: "peppol-bis-3", issueDate: "2026-02-30" }));
    expect(ids).toContain("PEPPOL-EN16931-F001");
    expect(ids).not.toContain("ATW-DATE-NOT-A-CALENDAR-DATE");
  });

  it("never lets an impossible date reach the generated XML", () => {
    const inv = withInvoice({ issueDate: "2026-02-30" });
    expect(validateInput(inv).valid).toBe(false);
    // The generator is not the gate — validation is — but the emitted value is
    // what the XSD would reject, so this is the assertion that matters.
    expect(generateXRechnungUBL(inv)).toContain("<cbc:IssueDate>2026-02-30<");
  });
});

// ---------------------------------------------------------------------------

describe("BR-O-11 / BR-O-12 follow the breakdown, not the lines", () => {
  // Official: both tests are gated on
  //   exists(cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID = 'O')
  // Since wave B a document level allowance or charge produces a breakdown
  // group on its own account, so gating on BT-151 alone let a mixed document
  // through with a completely clean result.
  it("fires when category O reaches the breakdown only via an allowance", () => {
    const inv = core({ allowances: [{ amount: 10, vatCategory: "O", reason: "Goodwill" }] });
    const ids = errorIds(inv);
    expect(ids).toContain("BR-O-11");
    expect(ids).toContain("BR-O-12");
  });

  it("fires when category O reaches the breakdown only via a charge", () => {
    const inv = core({ charges: [{ amount: 10, vatCategory: "O", reason: "Fee" }] });
    expect(errorIds(inv)).toContain("BR-O-11");
  });

  it("still fires for the original line-level case", () => {
    const inv = core({
      lines: [cleanLine(), cleanLine({ id: "2", vatCategory: "O", vatRate: undefined })],
    });
    const ids = errorIds(inv);
    expect(ids).toContain("BR-O-11");
    expect(ids).toContain("BR-O-12");
  });

  it("does not report BR-O-12 when no line is the offender", () => {
    // O on an allowance, an S charge, and every line already O: BR-O-11 is
    // real, BR-O-12 would have to name zero offending lines.
    const inv = core({
      lines: [cleanLine({ vatCategory: "O", vatRate: undefined })],
      allowances: [{ amount: 5, vatCategory: "O", reason: "r" }],
      charges: [{ amount: 5, vatCategory: "S", vatRate: 19, reason: "r" }],
    });
    const ids = errorIds(inv);
    expect(ids).toContain("BR-O-11");
    expect(ids).not.toContain("BR-O-12");
  });

  it("stays silent on an all-O document", () => {
    const inv = core({
      lines: [cleanLine({ vatCategory: "O", vatRate: undefined })],
      allowances: [{ amount: 5, vatCategory: "O", reason: "r" }],
    });
    const ids = errorIds(inv);
    expect(ids).not.toContain("BR-O-11");
    expect(ids).not.toContain("BR-O-12");
  });
});

// ---------------------------------------------------------------------------

describe("ATW-VAT-CATEGORY-UNSUPPORTED covers every site a category can sit", () => {
  // The rule exists to stop an unmodelled `"B"` reaching the XML unchecked.
  // Wave B gave BT-95 and BT-102 their own category and reopened the hole:
  // a `"B"` allowance validated completely clean and was emitted as a `B`
  // breakdown group.
  it("fires for a document level allowance", () => {
    const inv = core({ allowances: [{ amount: 5, vatCategory: "B" as never, vatRate: 22, reason: "r" }] });
    expect(errorIds(inv)).toContain("ATW-VAT-CATEGORY-UNSUPPORTED");
  });

  it("fires for a document level charge", () => {
    const inv = core({ charges: [{ amount: 5, vatCategory: "B" as never, vatRate: 22, reason: "r" }] });
    expect(errorIds(inv)).toContain("ATW-VAT-CATEGORY-UNSUPPORTED");
  });

  it("still fires for a line", () => {
    const inv = core({ lines: [cleanLine({ vatCategory: "B" as never, vatRate: 22 })] });
    expect(errorIds(inv)).toContain("ATW-VAT-CATEGORY-UNSUPPORTED");
  });
});

// ---------------------------------------------------------------------------

describe("BR-DE-16 matches KoSIT's test on both clauses", () => {
  // Official:
  //   not( $BT-95 = $supportedVATCodes or $BT-102 = $supportedVATCodes
  //        or $BT-151 = $supportedVATCodes )
  //   or (cac:TaxRepresentativeParty, $BT-31orBT-32Path)
  const unidentified = {
    name: "Seller GmbH",
    address: { city: "Berlin", postalCode: "10115", countryCode: "DE" },
    contact: { name: "Buchhaltung", phone: "+49 30 1234567", email: "re@acme.example" },
    electronicAddress: { schemeId: "9930", value: "DE123456789" },
  };

  it("is satisfied by a tax representative alone", () => {
    // A seller trading through a fiscal representative legitimately has
    // neither BT-31 nor BT-32. Refusing this rejected a valid invoice.
    const inv = withInvoice({
      seller: unidentified,
      taxRepresentative: {
        name: "Fiskal Vertreter SL",
        vatId: "ESA12345674",
        address: { city: "Madrid", postalCode: "28001", countryCode: "ES" },
      },
    });
    expect(errorIds(inv)).not.toContain("BR-DE-16");
  });

  it("still fires when the seller is unidentified and there is no representative", () => {
    expect(errorIds(withInvoice({ seller: unidentified }))).toContain("BR-DE-16");
  });

  it("is armed by a document level charge, not only by a line", () => {
    // Lines all category O, freight charge category S: KoSIT arms the rule on
    // BT-102, we used to read BT-151 only.
    const inv = withInvoice({
      seller: unidentified,
      lines: [cleanLine({ vatCategory: "O", vatRate: undefined })],
      charges: [{ amount: 5, vatCategory: "S", vatRate: 19, reason: "Versand" }],
    });
    expect(errorIds(inv)).toContain("BR-DE-16");
  });

  it("is armed by a document level allowance too", () => {
    const inv = withInvoice({
      seller: unidentified,
      lines: [cleanLine({ vatCategory: "O", vatRate: undefined })],
      allowances: [{ amount: 5, vatCategory: "S", vatRate: 19, reason: "Rabatt" }],
    });
    expect(errorIds(inv)).toContain("BR-DE-16");
  });
});

// ---------------------------------------------------------------------------

describe("BR-DE-TMP-32 matches the official 'every' semantics", () => {
  const noTimeOfSupply = { deliveryDate: undefined, invoicingPeriod: undefined };

  it("is not raised against a document with no lines", () => {
    // Official: `every $line in (cac:InvoiceLine) satisfies $line/cac:InvoicePeriod`.
    // XPath's `every` over an empty sequence is vacuously true, so a line-less
    // document passes. BR-16 already rejects it; a second wrong finding is noise.
    const inv = withInvoice({ ...noTimeOfSupply, lines: [] });
    expect(allIdsWithInfo(inv)).not.toContain("BR-DE-TMP-32");
  });

  it("is raised when an invoicing period is present but empty", () => {
    // `group()` drops an element whose children are all empty, so
    // `invoicingPeriod: {}` emits no cac:InvoicePeriod — the very document the
    // rule is about. Object identity was not the right test.
    const inv = withInvoice({ ...noTimeOfSupply, invoicingPeriod: {} });
    expect(generateXRechnungUBL(inv)).not.toContain("cac:InvoicePeriod");
    expect(allIdsWithInfo(inv)).toContain("BR-DE-TMP-32");
  });

  it("is raised when a line period is present but empty", () => {
    const inv = withInvoice({ ...noTimeOfSupply, lines: [cleanLine({ period: {} })] });
    expect(allIdsWithInfo(inv)).toContain("BR-DE-TMP-32");
  });

  it("stays silent for a period that is actually stated", () => {
    const inv = withInvoice({
      ...noTimeOfSupply,
      invoicingPeriod: { startDate: "2026-07-01", endDate: "2026-07-31" },
    });
    expect(allIdsWithInfo(inv)).not.toContain("BR-DE-TMP-32");
  });
});

// ---------------------------------------------------------------------------

describe("the IBAN MOD-97 upper-cases only the country code", () => {
  // Official: concat(substring(s,5), upper-case(substring(s,1,2)), substring(s,3,2)).
  // The BBAN is fed to string-to-codepoints as written.
  it.each([
    "DE89370400440532013000",
    "GB82WEST12345698765432",
    "FR1420041010050500013M02606",
    "NL91ABNA0417164300",
    "MT84MALT011000012345MTLCAST001S",
    "DE02120300000000202051",
  ])("accepts the real IBAN %s", (iban) => {
    expect(isValidIban(iban)).toBe(true);
  });

  it.each([
    ["a lowercase BBAN", "NL91abna0417164300"],
    ["a mixed-case BBAN", "GB82wesT12345698765432"],
    ["a wrong check digit", "DE89370400440532013001"],
    ["a truncated IBAN", "DE8937040044053201300"],
  ])("rejects %s", (_label, iban) => {
    expect(isValidIban(iban)).toBe(false);
  });

  it("still accepts an IBAN written with spaces", () => {
    expect(isValidIban("DE89 3704 0044 0532 0130 00")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("the generator and BR-DE-24-b agree on what a present BG-17 is", () => {
  it("emits no PayeeFinancialAccount for a whitespace-only IBAN", () => {
    // Truthy but blank: the generator used to emit an empty BG-17 that
    // BR-DE-24-b, which tests with blank(), could not see.
    const inv = withInvoice({
      payment: {
        meansCode: "48",
        iban: "   ",
        card: { primaryAccountNumber: "4111111111" },
      },
    });
    expect(generateXRechnungUBL(inv)).not.toContain("PayeeFinancialAccount");
    expect(errorIds(inv)).not.toContain("BR-DE-24-b");
  });

  it("still forbids a real IBAN beside a card payment", () => {
    const inv = withInvoice({
      payment: {
        meansCode: "48",
        iban: "DE02120300000000202051",
        card: { primaryAccountNumber: "4111111111" },
      },
    });
    expect(errorIds(inv)).toContain("BR-DE-24-b");
  });

  it("names the offending group in `field`, not the permitted one", () => {
    // BR-DE-23-b is a finding about BG-18/BG-19 being present; it used to be
    // reported against BG-17, the group the code allows.
    const inv = withInvoice({
      payment: {
        meansCode: "58",
        iban: "DE02120300000000202051",
        card: { primaryAccountNumber: "4111111111" },
      },
    });
    const finding = validateInput(inv).errors.find((e) => e.rule === "BR-DE-23-b");
    expect(finding).toBeDefined();
    expect(finding!.field).toBe("BG-18");
  });
});

// ---------------------------------------------------------------------------

describe("BR-DE-28 uses KoSIT's regex, not its prose", () => {
  const withEmail = (email: string) =>
    withInvoice({
      seller: {
        name: "Acme GmbH",
        vatId: "DE123456789",
        address: { city: "Berlin", postalCode: "10115", countryCode: "DE" },
        electronicAddress: { schemeId: "9930", value: "DE123456789" },
        contact: { name: "Buchhaltung", phone: "+49 30 1234567", email },
      },
    });

  // $XR-EMAIL-REGEX = ^[^@\s]+@([^@.\s]+\.)+[^@.\s]+$
  it.each([
    ["a one-character local part", "a@b.de"],
    ["a trailing dot in the local part", "ab.@example.de"],
    ["an ordinary address", "rechnungen@acme.example"],
  ])("accepts %s, as the regex does", (_label, email) => {
    expect(warningIds(withEmail(email))).not.toContain("BR-DE-28");
  });

  it.each([
    ["a dotless domain", "user@localhost"],
    ["an empty domain label", "user@example..de"],
    ["no at sign", "userexample.de"],
    ["two at signs", "a@b@c.de"],
    ["a space", "user name@example.de"],
  ])("rejects %s, as the regex does", (_label, email) => {
    expect(warningIds(withEmail(email))).toContain("BR-DE-28");
  });
});

// ---------------------------------------------------------------------------

describe("PEPPOL-EN16931-P0110 is in the UBL binding and is enforced", () => {
  // Official, PEPPOL-EN16931-UBL.sch:
  //   context cac:TaxCategory[upper-case(cbc:TaxExemptionReasonCode)='VATEX-EU-I']
  //   assert  normalize-space(cbc:ID)='E'   flag="fatal"
  // It is absent from the CII binding, which is the opposite of what the code
  // comment used to claim.
  it("fires when VATEX-EU-I is used with a category other than E", () => {
    const inv = core({
      profile: "peppol-bis-3",
      vatExemptionReasonCodes: { S: "VATEX-EU-I" },
    });
    expect(errorIds(inv)).toContain("PEPPOL-EN16931-P0110");
  });

  it("stays silent when VATEX-EU-I is used with category E", () => {
    const inv = core({
      profile: "peppol-bis-3",
      lines: [cleanLine({ vatCategory: "E", vatRate: 0 })],
      vatExemptionReasonCodes: { E: "VATEX-EU-I" },
    });
    expect(errorIds(inv)).not.toContain("PEPPOL-EN16931-P0110");
  });
});

// ---------------------------------------------------------------------------

describe("BR-CO-17's sub-1% trap is explained, not blamed on the caller", () => {
  // BR-CO-17's first branch is `round(BT-119) = 0`, using XPath's
  // round-to-nearest-integer, so any rate below 0.5% demands a tax amount that
  // rounds to zero. That is a defect in the reference schematron, and the rate
  // is the caller's — telling them to file a library bug is useless advice.
  it("fires, matching the reference validator", () => {
    const inv = core({ lines: [cleanLine({ vatCategory: "L", vatRate: 0.4, quantity: 1, unitPrice: 100000 })] });
    expect(errorIds(inv)).toContain("BR-CO-17");
  });

  it("does not tell the caller to report a library defect", () => {
    const inv = core({ lines: [cleanLine({ vatCategory: "L", vatRate: 0.4, quantity: 1, unitPrice: 100000 })] });
    const finding = validateInput(inv).errors.find((e) => e.rule === "BR-CO-17")!;
    expect(finding.fix).not.toMatch(/report it with the invoice payload/);
    expect(finding.fix).toMatch(/0\.5/);
  });

  it("stays silent where the rate rounds to zero and so does the tax", () => {
    const inv = core({ lines: [cleanLine({ vatCategory: "L", vatRate: 0.4, quantity: 1, unitPrice: 100 })] });
    expect(errorIds(inv)).not.toContain("BR-CO-17");
  });
});

// ---------------------------------------------------------------------------

describe("Peppol allowance/charge findings name their own business terms", () => {
  // One rule body serves BG-20, BG-21, BG-27 and BG-28, and the four name their
  // amounts with twelve different BT ids. All four used to report the BG-20
  // triple, so a line charge was reported against BT-93/BT-94 while its xpath
  // pointed at cac:InvoiceLine/cac:AllowanceCharge.
  const peppol = (over: Partial<InvoiceInput>) =>
    core({ profile: "peppol-bis-3", ...over });
  const fieldOf = (inv: InvoiceInput, rule: string) =>
    validateInput(inv).errors.find((e) => e.rule === rule)?.field;

  it.each([
    ["a document level allowance (BG-20)", { allowances: [{ amount: 5, vatCategory: "S" as const, vatRate: 19, percentage: 5, reason: "r" }] }, ["BT-93", "BT-94"]],
    ["a document level charge (BG-21)", { charges: [{ amount: 5, vatCategory: "S" as const, vatRate: 19, percentage: 5, reason: "r" }] }, ["BT-100", "BT-101"]],
    ["a line allowance (BG-27)", { lines: [cleanLine({ allowances: [{ amount: 5, percentage: 5, reason: "r" }] })] }, ["BT-137", "BT-138"]],
    ["a line charge (BG-28)", { lines: [cleanLine({ charges: [{ amount: 5, percentage: 5, reason: "r" }] })] }, ["BT-142", "BT-143"]],
  ])("reports R041 on %s against its own terms", (_label, over, expected) => {
    expect(fieldOf(peppol(over as Partial<InvoiceInput>), "PEPPOL-EN16931-R041")).toEqual(expected);
  });

  it("reports R040 on a line allowance against BT-136/137/138", () => {
    const inv = peppol({
      lines: [cleanLine({ allowances: [{ amount: 99, baseAmount: 100, percentage: 5, reason: "r" }] })],
    });
    expect(fieldOf(inv, "PEPPOL-EN16931-R040")).toEqual(["BT-136", "BT-137", "BT-138"]);
  });
});
