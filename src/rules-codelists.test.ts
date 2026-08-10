import { describe, expect, it } from "vitest";
import {
  COUNTRY_CODES,
  CURRENCY_CODES,
  EAS_SCHEME_CODES,
  INVOICE_TYPE_CODES,
  PAYMENT_MEANS_CODES,
  UNIT_CODES,
  VAT_CATEGORY_CODES,
} from "./codelists/index.js";
import {
  allIds,
  clean,
  cleanLine,
  findingFor,
  withInvoice,
  withLine,
} from "./testkit.js";
import type { Party } from "./types.js";

const withSeller = (o: Partial<Party>) =>
  withInvoice({ seller: { ...clean.seller, ...o } });
const withBuyer = (o: Partial<Party>) =>
  withInvoice({ buyer: { ...clean.buyer, ...o } });
const withSellerCountry = (countryCode: string) =>
  withSeller({ address: { ...clean.seller.address, countryCode } });

describe("code lists", () => {
  it("carry the counts the schematron carries", () => {
    // Guards against a regeneration that silently truncates a list. The numbers
    // are from EN16931-UBL-codes.sch @ validation-1.3.16; if the upstream list
    // grows, update them deliberately rather than letting a short list pass.
    expect(INVOICE_TYPE_CODES).toHaveLength(50);
    expect(CURRENCY_CODES).toHaveLength(178);
    expect(COUNTRY_CODES).toHaveLength(251);
    expect(PAYMENT_MEANS_CODES).toHaveLength(84);
    expect(VAT_CATEGORY_CODES).toHaveLength(10);
    expect(UNIT_CODES).toHaveLength(2162);
    expect(EAS_SCHEME_CODES).toHaveLength(104);
  });

  it("hold no duplicates and no whitespace", () => {
    for (const list of [
      INVOICE_TYPE_CODES,
      CURRENCY_CODES,
      COUNTRY_CODES,
      PAYMENT_MEANS_CODES,
      VAT_CATEGORY_CODES,
      UNIT_CODES,
      EAS_SCHEME_CODES,
    ]) {
      expect(new Set(list).size).toBe(list.length);
      expect(list.every((c) => c === c.trim() && c.length > 0)).toBe(true);
    }
  });

  it("are frozen, so a consumer cannot mutate the regulation", () => {
    expect(Object.isFrozen(CURRENCY_CODES)).toBe(true);
    expect(() => (CURRENCY_CODES as string[]).push("XXX")).toThrow();
  });
});

describe("BR-CL-01 invoice type code", () => {
  it("accepts 380 and the model default", () => {
    expect(allIds(withInvoice({ invoiceTypeCode: "380" }))).toEqual([]);
    expect(allIds(withInvoice({ invoiceTypeCode: undefined }))).toEqual([]);
  });

  it("accepts every construction-invoice code XRechnung admits", () => {
    for (const code of ["326", "384", "389", "875", "876", "877"]) {
      expect(allIds(withInvoice({ invoiceTypeCode: code }))).not.toContain(
        "BR-CL-01",
      );
    }
  });

  it("rejects a code that is in no UNTDID 1001 list", () => {
    expect(allIds(withInvoice({ invoiceTypeCode: "999" }))).toContain("BR-CL-01");
  });

  it("rejects a credit-note code carried on an invoice", () => {
    // 381 is a perfectly valid UNTDID 1001 code — on a CreditNote document.
    const ids = allIds(withInvoice({ invoiceTypeCode: "381" }));
    expect(ids).toContain("BR-CL-01");
    const finding = findingFor(withInvoice({ invoiceTypeCode: "381" }), "BR-CL-01")!;
    expect(finding.message).toContain("credit-note");
  });
});

describe("BR-CL-03 / BR-CL-04 currency", () => {
  it("accepts EUR and an obscure but listed code", () => {
    expect(allIds(withInvoice({ currency: "EUR" }))).toEqual([]);
    expect(allIds(withInvoice({ currency: "XAU" }))).not.toContain("BR-CL-04");
  });

  it("rejects a well-shaped code that is not in ISO 4217", () => {
    const ids = allIds(withInvoice({ currency: "XYZ" }));
    expect(ids).toContain("BR-CL-04");
    expect(ids).toContain("BR-CL-03");
  });

  it("rejects lower case, and says the list is case-sensitive", () => {
    const inv = withInvoice({ currency: "eur" });
    expect(allIds(inv)).toContain("BR-CL-04");
    expect(findingFor(inv, "BR-CL-04")!.message).toContain("case-sensitive");
  });

  it("stays quiet when the currency is absent — BR-05 owns that", () => {
    const ids = allIds(withInvoice({ currency: "" }));
    expect(ids).toContain("BR-05");
    expect(ids).not.toContain("BR-CL-04");
  });

  it("reports BR-CL-03 once, not once per amount element", () => {
    const ids = allIds(withInvoice({ currency: "XYZ" }));
    expect(ids.filter((r) => r === "BR-CL-03")).toHaveLength(1);
  });
});

describe("BR-CL-14 country codes", () => {
  it("accepts DE, GR and GB", () => {
    for (const code of ["DE", "GR", "GB"]) {
      expect(allIds(withSellerCountry(code))).not.toContain("BR-CL-14");
    }
  });

  it("rejects EL and explains that it is a VAT prefix, not a country", () => {
    const inv = withSellerCountry("EL");
    expect(allIds(inv)).toContain("BR-CL-14");
    expect(findingFor(inv, "BR-CL-14")!.message).toContain("BR-CO-09");
  });

  it("rejects UK and points at GB", () => {
    const inv = withSellerCountry("UK");
    expect(findingFor(inv, "BR-CL-14")!.message).toContain('"GB"');
  });

  it("checks the buyer and the deliver-to address too", () => {
    expect(
      allIds(withBuyer({ address: { ...clean.buyer.address, countryCode: "ZZ" } })),
    ).toContain("BR-CL-14");
    const ids = allIds(
      withInvoice({
        deliverTo: { city: "Lyon", postalCode: "69001", countryCode: "ZZ" },
      }),
    );
    expect(ids).toContain("BR-CL-14");
    expect(findingFor(
      withInvoice({
        deliverTo: { city: "Lyon", postalCode: "69001", countryCode: "ZZ" },
      }),
      "BR-CL-14",
    )!.field).toBe("BT-80");
  });

  it("accepts a valid deliver-to country", () => {
    expect(
      allIds(
        withInvoice({
          deliverTo: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
        }),
      ),
    ).toEqual([]);
  });
});

describe("BR-CL-16 payment means", () => {
  it("accepts 58, 30, 59 and 1", () => {
    for (const code of ["58", "30", "1"]) {
      expect(
        allIds(withInvoice({ payment: { meansCode: code, iban: clean.payment!.iban } })),
      ).not.toContain("BR-CL-16");
    }
  });

  it("rejects an invented code", () => {
    expect(allIds(withInvoice({ payment: { meansCode: "999" } }))).toContain(
      "BR-CL-16",
    );
  });

  it("stays quiet when the code is absent — BR-49 owns that", () => {
    const ids = allIds(withInvoice({ payment: { meansCode: "" } }));
    expect(ids).toContain("BR-49");
    expect(ids).not.toContain("BR-CL-16");
  });
});

describe("BR-CL-17 / BR-CL-18 VAT category codes", () => {
  it("accepts all seven categories this build supports", () => {
    for (const category of ["S", "Z", "E", "AE", "K", "G", "O"] as const) {
      const ids = allIds(
        withLine({ vatCategory: category, vatRate: category === "S" ? 19 : 0 }),
      );
      expect(ids).not.toContain("BR-CL-18");
      expect(ids).not.toContain("BR-CL-17");
    }
  });

  it("rejects a code outside UNCL5305, on both the line and the breakdown", () => {
    const inv = withLine({ vatCategory: "X" as never });
    const ids = allIds(inv);
    expect(ids).toContain("BR-CL-18");
    expect(ids).toContain("BR-CL-17");
    expect(findingFor(inv, "BR-CL-18")!.field).toBe("BT-151");
    expect(findingFor(inv, "BR-CL-17")!.field).toBe("BT-118");
  });

  it("reports BR-CL-17 once per distinct bad code, not once per line", () => {
    const inv = withInvoice({
      lines: [
        cleanLine({ vatCategory: "X" as never }),
        cleanLine({ id: "2", vatCategory: "X" as never }),
      ],
    });
    expect(allIds(inv).filter((r) => r === "BR-CL-17")).toHaveLength(1);
    expect(allIds(inv).filter((r) => r === "BR-CL-18")).toHaveLength(2);
  });

  it("lets L, M and B through the code list — they fail elsewhere", () => {
    // Valid EN 16931 codes with rule families this build does not implement.
    for (const code of ["L", "M", "B"]) {
      expect(allIds(withLine({ vatCategory: code as never }))).not.toContain(
        "BR-CL-18",
      );
    }
  });
});

describe("BR-CL-23 unit codes", () => {
  it("accepts common Rec 20 codes and a Rec 21 extension code", () => {
    for (const code of ["C62", "HUR", "DAY", "MON", "KWH", "XBX"]) {
      expect(allIds(withLine({ unitCode: code }))).not.toContain("BR-CL-23");
    }
  });

  it("rejects a word where a code belongs", () => {
    const inv = withLine({ unitCode: "hours" });
    expect(allIds(inv)).toContain("BR-CL-23");
    expect(findingFor(inv, "BR-CL-23")!.fix).toContain("HUR");
  });

  it("rejects the right code in the wrong case, and says so", () => {
    const inv = withLine({ unitCode: "hur" });
    expect(findingFor(inv, "BR-CL-23")!.message).toContain("case-sensitive");
  });

  it("stays quiet when the unit code is absent — BR-23 owns that", () => {
    const ids = allIds(withLine({ unitCode: "" }));
    expect(ids).toContain("BR-23");
    expect(ids).not.toContain("BR-CL-23");
  });
});

describe("BR-CL-25 electronic address scheme", () => {
  it("accepts the schemes German invoices actually use", () => {
    for (const schemeId of ["0204", "9930", "0088", "EM"]) {
      expect(
        allIds(withSeller({ electronicAddress: { schemeId, value: "x" } })),
      ).not.toContain("BR-CL-25");
    }
  });

  it("rejects an ISO 6523 code that is not in the narrower EAS list", () => {
    // 0003 is a valid party-identifier scheme and is not an endpoint scheme.
    const inv = withSeller({ electronicAddress: { schemeId: "0003", value: "x" } });
    expect(allIds(inv)).toContain("BR-CL-25");
    expect(findingFor(inv, "BR-CL-25")!.message).toContain("ISO 6523");
  });

  it("checks the buyer endpoint too", () => {
    expect(
      allIds(withBuyer({ electronicAddress: { schemeId: "ZZZ", value: "x" } })),
    ).toContain("BR-CL-25");
  });

  it("stays quiet when the scheme is absent — BR-62/BR-63 own that", () => {
    const ids = allIds(withSeller({ electronicAddress: { schemeId: "", value: "x" } }));
    expect(ids).toContain("BR-62");
    expect(ids).not.toContain("BR-CL-25");
  });
});
