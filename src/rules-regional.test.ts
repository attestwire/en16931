import { describe, expect, it } from "vitest";
import { computeTotals, generateXRechnungUBL, validateInput } from "./index.js";
import { allIds, clean, cleanLine, errorIds, findingFor, warningIds, withInvoice } from "./testkit.js";
import type { InvoiceInput, Party, VatCategory } from "./types.js";

/**
 * The regional Spanish VAT categories — `L` (IGIC, Canary Islands) and `M`
 * (IPSI, Ceuta and Melilla) — and their `BR-AF-*` and `BR-AG-*` families.
 *
 * These are not exotic. The Canary Islands alone issue enough B2B invoicing to
 * make `L` the eighth most common category code in the wild, and the reference
 * schematron defines both families at exactly the level it defines `BR-S-*`:
 * ten rules each, same shape, same numbering. What makes them worth their own
 * test file is the two places they are *not* like `S`:
 *
 *   - the rule id does not follow the category code (`L` → `BR-AF`, `M` →
 *     `BR-AG`), which is the single easiest thing to get wrong here, and
 *   - the rate may be exactly zero (`BR-AF-05` reads "0 or greater than zero"),
 *     where `BR-S-05` demands strictly greater. IGIC has a real 0% band.
 */

const regional = (
  category: "L" | "M",
  overrides: Partial<InvoiceInput> = {},
): InvoiceInput =>
  withInvoice({
    seller: {
      ...clean.seller,
      vatId: "ESX1234567X",
      address: { city: "Las Palmas", postalCode: "35001", countryCode: "ES" },
    } as Party,
    buyer: {
      ...clean.buyer,
      vatId: "ESY7654321Y",
      address: { city: "Santa Cruz", postalCode: "38001", countryCode: "ES" },
    } as Party,
    lines: [cleanLine({ vatCategory: category, vatRate: 7 })],
    ...overrides,
  });

const FAMILY: Record<"L" | "M", string> = { L: "AF", M: "AG" };

describe("the category codes themselves", () => {
  it("BR-CL-17/18 already admitted L and M, and the model now expresses them", () => {
    for (const category of ["L", "M"] as const) {
      const ids = allIds(regional(category));
      expect(ids).not.toContain("BR-CL-18");
      expect(ids).not.toContain("ATW-UNKNOWN-VAT-CATEGORY");
    }
  });

  it("still refuses B, the one UNCL5305 code the model does not carry", () => {
    // Not via BR-CL-18: "B" is on the code list, so the code-list rule passes it.
    // Before wave C that made it a silent hole — clean result, unchecked
    // breakdown group. It is now an explicit library-limitation refusal.
    const ids = errorIds(withInvoice({ lines: [cleanLine({ vatCategory: "B" as VatCategory })] }));
    expect(ids).not.toContain("BR-CL-18");
    expect(ids).toContain("ATW-VAT-CATEGORY-UNSUPPORTED");
  });

  it("the B refusal explains the split-payment mechanism it is protecting", () => {
    const finding = findingFor(
      withInvoice({ lines: [cleanLine({ vatCategory: "B" as VatCategory })] }),
      "ATW-VAT-CATEGORY-UNSUPPORTED",
    )!;
    expect(finding.message).toMatch(/Agenzia delle Entrate/);
    expect(finding.fix).toMatch(/"S"/);
  });

  it("maps the category to the right rule family, which is not the category letter", () => {
    const finding = findingFor(
      regional("L", { seller: { ...clean.seller, vatId: undefined, address: clean.seller.address } as Party }),
      "BR-AF-02",
    );
    expect(finding).toBeDefined();
    expect(allIds(regional("L"))).not.toContain("BR-L-02");
    expect(allIds(regional("M"))).not.toContain("BR-M-02");
  });
});

describe("BR-AF-02 / BR-AG-02 — the seller must be tax-identified", () => {
  for (const category of ["L", "M"] as const) {
    const rule = `BR-${FAMILY[category]}-02`;

    it(`${rule} fires when the seller carries no identifier at all`, () => {
      const ids = errorIds(
        regional(category, {
          seller: {
            name: "Acme SL",
            address: { city: "Las Palmas", postalCode: "35001", countryCode: "ES" },
            contact: clean.seller.contact,
            electronicAddress: clean.seller.electronicAddress,
          } as Party,
        }),
      );
      expect(ids).toContain(rule);
    });

    it(`${rule} accepts a national tax registration number, unlike BR-IC-02`, () => {
      const ids = errorIds(
        regional(category, {
          seller: {
            ...clean.seller,
            vatId: undefined,
            taxRegistrationId: "B12345678",
            address: { city: "Las Palmas", postalCode: "35001", countryCode: "ES" },
          } as Party,
        }),
      );
      expect(ids).not.toContain(rule);
    });

    it(`${rule} is satisfied by a VAT identifier`, () => {
      expect(errorIds(regional(category))).not.toContain(rule);
    });
  }
});

describe("BR-AF-05 / BR-AG-05 — the line rate may be zero, but not absent", () => {
  for (const category of ["L", "M"] as const) {
    const rule = `BR-${FAMILY[category]}-05`;

    it(`${rule} accepts a positive rate`, () => {
      expect(allIds(regional(category))).not.toContain(rule);
    });

    it(`${rule} accepts exactly zero — the difference from BR-S-05`, () => {
      const input = regional(category, {
        lines: [cleanLine({ vatCategory: category, vatRate: 0 })],
      });
      expect(allIds(input)).not.toContain(rule);
      // The same value under category S is a failure, which is the point.
      expect(errorIds(withInvoice({ lines: [cleanLine({ vatRate: 0 })] }))).toContain(
        "BR-S-05",
      );
    });

    it(`${rule} fires when the rate is missing`, () => {
      const ids = errorIds(
        regional(category, { lines: [cleanLine({ vatCategory: category, vatRate: undefined })] }),
      );
      expect(ids).toContain(rule);
    });

    it(`${rule} fires on a negative rate`, () => {
      const ids = errorIds(
        regional(category, { lines: [cleanLine({ vatCategory: category, vatRate: -7 })] }),
      );
      expect(ids).toContain(rule);
    });

    it(`${rule} names the tax rather than calling it VAT`, () => {
      const finding = findingFor(
        regional(category, { lines: [cleanLine({ vatCategory: category, vatRate: undefined })] }),
        rule,
      )!;
      expect(finding.message).toContain(category === "L" ? "IGIC" : "IPSI");
      expect(finding.docsUrl).toBe(`https://attestwire.com/rules/${rule}`);
      expect(finding.xpath).toContain("ClassifiedTaxCategory");
    });
  }
});

describe("BR-AF-03/04/06/07 and BR-AG-03/04/06/07 — document allowances and charges", () => {
  for (const category of ["L", "M"] as const) {
    const family = FAMILY[category];

    it(`BR-${family}-03 fires for an allowance in category ${category} with no seller identifier`, () => {
      const ids = errorIds(
        regional(category, {
          seller: {
            name: "Acme SL",
            address: { city: "Las Palmas", postalCode: "35001", countryCode: "ES" },
            contact: clean.seller.contact,
            electronicAddress: clean.seller.electronicAddress,
          } as Party,
          allowances: [{ amount: 25, vatCategory: category, vatRate: 7, reason: "Descuento" }],
        }),
      );
      expect(ids).toContain(`BR-${family}-03`);
    });

    it(`BR-${family}-04 fires for a charge in the same situation`, () => {
      const ids = errorIds(
        regional(category, {
          seller: {
            name: "Acme SL",
            address: { city: "Las Palmas", postalCode: "35001", countryCode: "ES" },
            contact: clean.seller.contact,
            electronicAddress: clean.seller.electronicAddress,
          } as Party,
          charges: [{ amount: 25, vatCategory: category, vatRate: 7, reason: "Transporte" }],
        }),
      );
      expect(ids).toContain(`BR-${family}-04`);
    });

    it(`BR-${family}-06 accepts a zero rate on an allowance and rejects an absent one`, () => {
      const zero = regional(category, {
        allowances: [{ amount: 25, vatCategory: category, vatRate: 0, reason: "Descuento" }],
      });
      expect(allIds(zero)).not.toContain(`BR-${family}-06`);

      const absent = regional(category, {
        allowances: [{ amount: 25, vatCategory: category, reason: "Descuento" }],
      });
      expect(errorIds(absent)).toContain(`BR-${family}-06`);
    });

    it(`BR-${family}-07 does the same for a charge`, () => {
      const absent = regional(category, {
        charges: [{ amount: 25, vatCategory: category, reason: "Transporte" }],
      });
      expect(errorIds(absent)).toContain(`BR-${family}-07`);
    });
  }
});

describe("BR-AF-10 / BR-AG-10 — no exemption reason on a tax that is charged", () => {
  for (const category of ["L", "M"] as const) {
    const rule = `BR-${FAMILY[category]}-10`;

    it(`${rule} fires when an exemption reason is supplied`, () => {
      const ids = warningIds(
        regional(category, {
          vatExemptionReasons: { [category]: "Exento" },
        }),
      );
      expect(ids).toContain(rule);
    });

    it(`${rule} fires for an exemption reason *code* too`, () => {
      const ids = warningIds(
        regional(category, {
          vatExemptionReasonCodes: { [category]: "VATEX-EU-132-1A" },
        }),
      );
      expect(ids).toContain(rule);
    });

    it(`${rule} stays silent on a clean invoice`, () => {
      expect(allIds(regional(category))).not.toContain(rule);
    });

    it(`the computed breakdown drops the reason rather than emitting it`, () => {
      const totals = computeTotals(
        regional(category, { vatExemptionReasons: { [category]: "Exento" } }),
      );
      expect(totals.subtotals).toHaveLength(1);
      expect(totals.subtotals[0]!.exemptionReason).toBeUndefined();
    });
  }
});

describe("totals and generation carry the regional categories through", () => {
  it("groups L and M breakdowns per rate, like S and unlike the zero-rated categories", () => {
    const totals = computeTotals(
      regional("L", {
        lines: [
          cleanLine({ id: "1", vatCategory: "L", vatRate: 7, quantity: 1, unitPrice: 100 }),
          cleanLine({ id: "2", vatCategory: "L", vatRate: 3, quantity: 1, unitPrice: 100 }),
          cleanLine({ id: "3", vatCategory: "L", vatRate: 7, quantity: 1, unitPrice: 50 }),
        ],
      }),
    );
    expect(totals.subtotals).toHaveLength(2);
    const seven = totals.subtotals.find((s) => s.rate === 7)!;
    expect(seven.taxableAmount).toBe(150);
    expect(seven.taxAmount).toBe(10.5);
    const three = totals.subtotals.find((s) => s.rate === 3)!;
    expect(three.taxAmount).toBe(3);
    expect(totals.taxAmount).toBe(13.5);
  });

  it("lets L and M share a document, since neither is exclusive the way O is", () => {
    const input = regional("L", {
      lines: [
        cleanLine({ id: "1", vatCategory: "L", vatRate: 7, quantity: 1, unitPrice: 100 }),
        cleanLine({ id: "2", vatCategory: "M", vatRate: 10, quantity: 1, unitPrice: 100 }),
      ],
    });
    const result = validateInput(input);
    expect(result.valid).toBe(true);
    expect(computeTotals(input).subtotals).toHaveLength(2);
  });

  it("nets a document allowance out of the right group", () => {
    const totals = computeTotals(
      regional("L", {
        lines: [cleanLine({ vatCategory: "L", vatRate: 7, quantity: 1, unitPrice: 1000 })],
        allowances: [{ amount: 100, vatCategory: "L", vatRate: 7, reason: "Descuento" }],
      }),
    );
    expect(totals.subtotals[0]!.taxableAmount).toBe(900);
    expect(totals.subtotals[0]!.taxAmount).toBe(63);
    expect(totals.allowanceTotalAmount).toBe(100);
  });

  it("emits the category code and its rate into the XML", () => {
    const xml = generateXRechnungUBL(
      regional("L", { profile: "en16931" }),
    );
    expect(xml).toContain("<cbc:ID>L</cbc:ID>");
    expect(xml).toContain("<cbc:Percent>7.00</cbc:Percent>");
    expect(xml).not.toContain("TaxExemptionReason");
  });

  it("validates a clean regional invoice with no findings at all", () => {
    for (const category of ["L", "M"] as const) {
      const result = validateInput(regional(category));
      expect(result.errors, category).toEqual([]);
      expect(result.warnings, category).toEqual([]);
    }
  });

  it("XRechnung's BR-DE-16 already listed L and M, and now they can reach it", () => {
    const ids = errorIds(
      regional("L", {
        seller: {
          name: "Acme SL",
          address: { city: "Las Palmas", postalCode: "35001", countryCode: "ES" },
          contact: clean.seller.contact,
          electronicAddress: clean.seller.electronicAddress,
        } as Party,
      }),
    );
    expect(ids).toContain("BR-DE-16");
  });
});
