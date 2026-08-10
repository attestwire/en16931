import { describe, expect, it } from "vitest";
import { computeTotals, lineNetAmount } from "./totals.js";
import { generateXRechnungUBL } from "./generate.js";
import {
  allIds,
  clean,
  cleanLine,
  errorIds,
  findingFor,
  withInvoice,
  withLine,
} from "./testkit.js";

describe("BR-04 invoice type code", () => {
  it("accepts the model default when the field is omitted", () => {
    expect(allIds(withInvoice({ invoiceTypeCode: undefined }))).toEqual([]);
  });

  it("accepts an explicit 380", () => {
    expect(allIds(withInvoice({ invoiceTypeCode: "380" }))).toEqual([]);
  });

  it("fires when the field is present but empty", () => {
    const inv = withInvoice({ invoiceTypeCode: "" });
    expect(allIds(inv)).toContain("BR-04");
    expect(findingFor(inv, "BR-04")!.message).toContain("not the same as omitting");
  });

  it("fires on whitespace, which is the same mistake wearing a disguise", () => {
    expect(allIds(withInvoice({ invoiceTypeCode: "   " }))).toContain("BR-04");
  });
});

describe("BR-CO-04 line VAT category", () => {
  it("accepts every supported category", () => {
    for (const category of ["S", "Z", "E", "AE", "K", "G", "O"] as const) {
      expect(
        allIds(withLine({ vatCategory: category, vatRate: category === "S" ? 19 : 0 })),
      ).not.toContain("BR-CO-04");
    }
  });

  it("fires on a line with no category at all", () => {
    const inv = withLine({ vatCategory: undefined as never });
    expect(allIds(inv)).toContain("BR-CO-04");
    expect(findingFor(inv, "BR-CO-04")!.message).toContain('no "default" VAT treatment');
  });

  it("names the offending line and its id", () => {
    const inv = withInvoice({
      lines: [cleanLine(), cleanLine({ id: "L-2", vatCategory: "" as never })],
    });
    expect(findingFor(inv, "BR-CO-04")!.message).toContain('Line 2 (id "L-2")');
  });
});

describe("BR-24 invoice line net amount", () => {
  it("stays silent when BT-131 can be computed", () => {
    expect(allIds(clean)).not.toContain("BR-24");
    expect(allIds(withLine({ baseQuantity: 100, quantity: 500, unitPrice: 12.5 }))).toEqual(
      [],
    );
  });

  it("fires on a zero base quantity instead of throwing a RangeError", () => {
    // Regression: computeTotals threw, rules.ts swallowed the throw, and
    // validateInput returned clean — for an invoice that generation then
    // refused with an unhandled RangeError.
    const inv = withLine({ baseQuantity: 0 });
    expect(() => allIds(inv)).not.toThrow();
    expect(errorIds(inv)).toContain("BR-24");
    expect(findingFor(inv, "BR-24")!.message).toContain("base quantity (BT-149) is 0");
  });

  it("still refuses generation, and says the same thing first", () => {
    const inv = withLine({ baseQuantity: 0 });
    expect(errorIds(inv)).toContain("BR-24");
    expect(() => generateXRechnungUBL(inv)).toThrow();
  });

  it("fires when the arithmetic cannot produce a finite amount", () => {
    const inv = withLine({ quantity: Number.POSITIVE_INFINITY });
    expect(allIds(inv)).toContain("BR-24");
  });

  it("defers to BR-22 / BR-26 when a factor is simply absent", () => {
    const ids = allIds(withLine({ unitPrice: undefined as never }));
    expect(ids).toContain("BR-26");
    expect(ids).not.toContain("BR-24");
  });

  it("computes the documented base-quantity example correctly", () => {
    expect(lineNetAmount(cleanLine({ quantity: 500, unitPrice: 12.5, baseQuantity: 100 }))).toBe(
      62.5,
    );
  });
});

describe("BR-12 / BR-13 / BR-14 / BR-15 document totals", () => {
  it("stay silent, because the library always computes all five", () => {
    for (const rule of ["BR-12", "BR-13", "BR-14", "BR-15"]) {
      expect(allIds(clean)).not.toContain(rule);
    }
    const totals = computeTotals(clean);
    for (const key of [
      "lineExtensionAmount",
      "taxExclusiveAmount",
      "taxAmount",
      "taxInclusiveAmount",
      "payableAmount",
    ] as const) {
      expect(Number.isFinite(totals[key])).toBe(true);
    }
  });

  it("say nothing on an invoice with no lines — BR-16 owns that", () => {
    const ids = allIds(withInvoice({ lines: [] }));
    expect(ids).toContain("BR-16");
    for (const rule of ["BR-12", "BR-13", "BR-14", "BR-15"]) {
      expect(ids).not.toContain(rule);
    }
  });
});

describe("BR-49 payment means type code", () => {
  it("stays silent when there is no payment group at all", () => {
    // BG-16 is optional in core EN 16931; BR-DE-1 is what makes it mandatory
    // under XRechnung, and it is a different rule with a different message.
    const ids = allIds(withInvoice({ profile: "en16931", payment: undefined }));
    expect(ids).not.toContain("BR-49");
  });

  it("fires when a payment group is present without a means code", () => {
    const inv = withInvoice({
      profile: "en16931",
      payment: { meansCode: "", iban: "DE02120300000000202051" },
    });
    expect(allIds(inv)).toContain("BR-49");
    expect(findingFor(inv, "BR-49")!.message).toContain("direct debit");
  });

  it("applies to every profile, not just XRechnung", () => {
    for (const profile of ["en16931", "peppol-bis-3", "xrechnung-ubl"] as const) {
      expect(allIds(withInvoice({ profile, payment: { meansCode: " " } }))).toContain(
        "BR-49",
      );
    }
  });

  it("accepts a valid means code", () => {
    expect(allIds(clean)).not.toContain("BR-49");
  });
});

describe("BR-57 deliver-to country code", () => {
  it("stays silent when there is no deliver-to address", () => {
    expect(allIds(clean)).not.toContain("BR-57");
  });

  it("stays silent on a complete deliver-to address", () => {
    expect(
      allIds(
        withInvoice({
          deliverTo: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
        }),
      ),
    ).toEqual([]);
  });

  it("fires when BG-15 is present without BT-80", () => {
    const inv = withInvoice({
      deliverTo: { city: "Lyon", postalCode: "69001" } as never,
    });
    expect(allIds(inv)).toContain("BR-57");
    expect(findingFor(inv, "BR-57")!.message).toContain("not partially optional");
  });

  it("fires on a blank country code as well as an absent one", () => {
    expect(
      allIds(
        withInvoice({
          deliverTo: { city: "Lyon", postalCode: "69001", countryCode: "  " },
        }),
      ),
    ).toContain("BR-57");
  });
});

describe("BR-28 the item gross price shall not be negative", () => {
  it("fires on a negative gross price and names the value", () => {
    const inv = withLine({ grossUnitPrice: -200, priceDiscount: -50 });
    expect(errorIds(inv)).toContain("BR-28");
    expect(findingFor(inv, "BR-28")!.message).toContain("-200");
  });

  it("accepts a positive gross price above the net price", () => {
    expect(allIds(withLine({ grossUnitPrice: 200, priceDiscount: 50 }))).not.toContain(
      "BR-28",
    );
  });

  it("does not fire when no gross price is stated", () => {
    expect(allIds(clean)).not.toContain("BR-28");
  });

  it("is a separate rule from BR-27, which constrains the net price", () => {
    const inv = withLine({ unitPrice: -5, grossUnitPrice: -10 });
    const ids = errorIds(inv);
    expect(ids).toContain("BR-27");
    expect(ids).toContain("BR-28");
  });
});

describe("BR-50 a credit transfer group must identify its account", () => {
  it("fires when BG-17 is present through the account name alone", () => {
    const inv = withInvoice({
      payment: { meansCode: "97", accountName: "Acme GmbH" },
    });
    expect(errorIds(inv)).toContain("BR-50");
  });

  it("fires when BG-17 is present through the BIC alone", () => {
    const inv = withInvoice({ payment: { meansCode: "97", bic: "BYLADEM1001" } });
    expect(errorIds(inv)).toContain("BR-50");
  });

  it("is silent once the account identifier is supplied", () => {
    const inv = withInvoice({
      payment: { meansCode: "97", accountName: "Acme GmbH", iban: "DE02120300000000202051" },
    });
    expect(allIds(inv)).not.toContain("BR-50");
  });

  it("is triggered by the group, not by the means code, unlike BR-61", () => {
    // Means code 97 is clearing between partners, so BR-61 does not apply —
    // but a half-filled BG-17 is still a half-filled BG-17.
    const inv = withInvoice({ payment: { meansCode: "97", accountName: "Acme GmbH" } });
    expect(errorIds(inv)).toContain("BR-50");
    expect(errorIds(inv)).not.toContain("BR-61");
  });

  it("does not fire when there is no payment group at all", () => {
    expect(allIds(withInvoice({ profile: "en16931", payment: undefined }))).not.toContain(
      "BR-50",
    );
  });
});

describe("BR-DEC-19 / BR-DEC-20 / BR-DEC-23 as arithmetic invariants", () => {
  it("stay silent on every shape of well-formed input", () => {
    // They constrain amounts this library derives and rounds, so they cannot
    // fail on caller input. They exist so a regression in round2 surfaces as a
    // finding rather than as a document a portal quietly rejects.
    for (const inv of [
      clean,
      withLine({ quantity: 3, unitPrice: 33.333 }),
      withLine({ quantity: 500, unitPrice: 12.5, baseQuantity: 100 }),
      withInvoice({
        allowances: [{ amount: 53.1, vatCategory: "S", vatRate: 19, reason: "Rabatt" }],
        charges: [{ amount: 24.9, vatCategory: "S", vatRate: 19, reason: "Versand" }],
      }),
    ]) {
      const ids = allIds(inv);
      expect(ids).not.toContain("BR-DEC-19");
      expect(ids).not.toContain("BR-DEC-20");
      expect(ids).not.toContain("BR-DEC-23");
    }
  });
});
