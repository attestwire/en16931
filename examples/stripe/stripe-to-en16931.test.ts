import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  computeTotals,
  generateCii,
  generateXRechnungUBL,
  parseCiiInvoice,
  parseUbl,
  validateInput,
} from "@attestwire/en16931";

import {
  StripeMappingError,
  stripeInvoiceToInput,
  type StripeInvoice,
  type StripeInvoiceLine,
  type StripeMappingOptions,
} from "./stripe-to-en16931.js";

// The seller and payment come from the package's own conformant XRechnung, so
// every finding in this suite is about the Stripe mapping, not the fixture.
const fixture = parseUbl(
  readFileSync(new URL("../../fixtures/xrechnung-ubl-minimal.xml", import.meta.url), "utf8"),
).invoice;
const OPTS: StripeMappingOptions = {
  seller: fixture.seller,
  payment: fixture.payment!,
  buyerReference: "04011000-1234512345-06",
};

const rate = (id: string, percentage: number) => ({ tax_rate: { id, percentage } });

/** A finalized Stripe invoice, shaped as API version 2026-08-26.dahlia returns it. */
function stripeInvoice(lines: StripeInvoiceLine[], overrides: Partial<StripeInvoice> = {}): StripeInvoice {
  return {
    id: "in_test_1",
    number: "ACME-0042",
    created: 1_789_000_000,
    status_transitions: { finalized_at: 1_789_003_600 },
    due_date: 1_790_209_600,
    currency: "eur",
    customer_name: "Beispiel Handels GmbH",
    customer_email: "ap@beispiel.example",
    customer_address: { line1: "Hauptstraße 5", city: "Köln", postal_code: "50667", country: "DE" },
    customer_tax_ids: [{ type: "eu_vat", value: "DE123456789" }],
    lines: { data: lines, has_more: false },
    total: 0,
    ...overrides,
    // Unpaid unless the test says otherwise.
    amount_remaining: overrides.amount_remaining ?? overrides.total ?? 0,
  };
}

// Two tax-exclusive lines at two rates, one with a coupon: 2 × 49.00 − 9.80
// at 19 %, and 12.50 at 7 %. Stripe's total is what Stripe would compute.
const exclusiveLines: StripeInvoiceLine[] = [
  {
    id: "il_seat",
    description: "Pro plan, per seat",
    amount: 9800,
    quantity: 2,
    pricing: { unit_amount_decimal: "4900" },
    discount_amounts: [{ amount: 980 }],
    taxes: [
      {
        amount: 1676,
        tax_behavior: "exclusive",
        taxability_reason: "standard_rated",
        taxable_amount: 8820,
        tax_rate_details: rate("txr_de19", 19),
      },
    ],
    period: { start: 1_786_000_000, end: 1_788_592_000 },
  },
  {
    id: "il_book",
    description: "Printed handbook",
    amount: 1250,
    quantity: 1,
    pricing: { unit_amount_decimal: "1250" },
    taxes: [
      {
        amount: 88,
        tax_behavior: "exclusive",
        taxability_reason: "reduced_rated",
        taxable_amount: 1250,
        tax_rate_details: rate("txr_de7", 7),
      },
    ],
  },
];

describe("stripeInvoiceToInput", () => {
  it("maps a tax-exclusive invoice with a coupon to a valid XRechnung that matches Stripe's total", () => {
    const { input, notes } = stripeInvoiceToInput(stripeInvoice(exclusiveLines, { total: 11834 }), OPTS);

    const result = validateInput(input);
    expect(result.errors).toEqual([]);
    expect(notes).toEqual([]);
    expect(computeTotals(input).taxInclusiveAmount).toBe(118.34);

    expect(input.invoiceNumber).toBe("ACME-0042");
    expect(input.issueDate).toBe("2026-09-10"); // finalized_at, not created
    expect(input.currency).toBe("EUR");
    expect(input.buyer.vatId).toBe("DE123456789");
    expect(input.buyer.electronicAddress).toEqual({ schemeId: "EM", value: "ap@beispiel.example" });
    expect(input.lines[0]).toMatchObject({
      quantity: 2,
      unitPrice: 49,
      vatCategory: "S",
      vatRate: 19,
      allowances: [{ amount: 9.8, reasonCode: "95" }],
      period: { startDate: "2026-08-06", endDate: "2026-09-05" },
    });
    expect(input.lines[1]).toMatchObject({ unitPrice: 12.5, vatRate: 7 });
  });

  it("generates UBL and CII that read back and validate", () => {
    const { input } = stripeInvoiceToInput(stripeInvoice(exclusiveLines, { total: 11834 }), OPTS);

    const ubl = parseUbl(generateXRechnungUBL(input)).invoice;
    expect(validateInput(ubl).errors).toEqual([]);

    const cii = parseCiiInvoice(generateCii({ ...input, profile: "xrechnung-cii" })).invoice;
    expect(validateInput(cii).errors).toEqual([]);
    expect(computeTotals(cii).payableAmount).toBe(118.34);
  });

  it("derives the net price of a tax-inclusive line from taxable_amount", () => {
    const line: StripeInvoiceLine = {
      id: "il_gross",
      description: "Annual licence (price incl. VAT)",
      amount: 11900,
      quantity: 3,
      pricing: { unit_amount_decimal: "3966.666666666667" },
      taxes: [
        {
          amount: 1900,
          tax_behavior: "inclusive",
          taxability_reason: "standard_rated",
          taxable_amount: 10000,
          tax_rate_details: rate("txr_de19", 19),
        },
      ],
    };
    const { input, notes } = stripeInvoiceToInput(stripeInvoice([line], { total: 11900 }), OPTS);
    expect(validateInput(input).errors).toEqual([]);
    expect(notes).toEqual([]);
    const totals = computeTotals(input);
    expect(totals.lineExtensionAmount).toBe(100);
    expect(totals.taxInclusiveAmount).toBe(119);
  });

  it("maps a reverse-charge sale to an EU business as category AE", () => {
    const line: StripeInvoiceLine = {
      id: "il_rc",
      description: "Consulting",
      amount: 50000,
      quantity: 1,
      pricing: { unit_amount_decimal: "50000" },
      taxes: [
        {
          amount: 0,
          tax_behavior: "exclusive",
          taxability_reason: "reverse_charge",
          taxable_amount: 50000,
          tax_rate_details: rate("txr_rc", 0),
        },
      ],
    };
    const invoice = stripeInvoice([line], {
      total: 50000,
      customer_name: "Exemple SARL",
      customer_address: { line1: "1 rue de la Paix", city: "Paris", postal_code: "75002", country: "FR" },
      customer_tax_ids: [{ type: "eu_vat", value: "FR40303265045" }],
    });
    const { input } = stripeInvoiceToInput(invoice, OPTS);
    expect(input.lines[0]).toMatchObject({ vatCategory: "AE", vatRate: 0 });
    expect(validateInput(input).errors).toEqual([]);
  });

  it("states a paid invoice's payment as BT-113, so the amount due is zero", () => {
    const { input } = stripeInvoiceToInput(stripeInvoice(exclusiveLines, { total: 11834, amount_remaining: 0 }), OPTS);
    expect(input.paidAmount).toBe(118.34);
    expect(computeTotals(input).payableAmount).toBe(0);
    expect(validateInput(input).errors).toEqual([]);
  });

  it("counts a customer credit balance as settled, like a card payment", () => {
    // 118.34 total; 18.34 came off the customer's Stripe balance, 100.00 is still due.
    const { input } = stripeInvoiceToInput(stripeInvoice(exclusiveLines, { total: 11834, amount_remaining: 10000 }), OPTS);
    expect(input.paidAmount).toBe(18.34);
    expect(computeTotals(input).payableAmount).toBe(100);
  });

  it("refuses an invoice that carries a previous debt", () => {
    expect(() =>
      stripeInvoiceToInput(stripeInvoice(exclusiveLines, { total: 11834, amount_remaining: 15000 }), OPTS),
    ).toThrow(/previous balance/);
  });

  it("reads a zero-decimal currency in whole units, not hundredths", () => {
    const line: StripeInvoiceLine = {
      id: "il_jpy",
      description: "Plan",
      amount: 1000,
      quantity: 1,
      pricing: { unit_amount_decimal: "1000" },
      taxes: [{ amount: 100, tax_behavior: "exclusive", taxability_reason: "standard_rated", taxable_amount: 1000, tax_rate_details: rate("txr_jp", 10) }],
    };
    const { input, notes } = stripeInvoiceToInput(stripeInvoice([line], { currency: "jpy", total: 1100 }), OPTS);
    expect(input.lines[0]!.unitPrice).toBe(1000);
    expect(computeTotals(input).taxInclusiveAmount).toBe(1100);
    expect(notes).toEqual([]);
  });

  it("matches Stripe on yen VAT: 1,234 JPY at 19% is 234 JPY, with no note", () => {
    const line: StripeInvoiceLine = {
      id: "il_jpy19",
      description: "Plan",
      amount: 1234,
      quantity: 1,
      pricing: { unit_amount_decimal: "1234" },
      taxes: [{ amount: 234, tax_behavior: "exclusive", taxability_reason: "standard_rated", taxable_amount: 1234, tax_rate_details: rate("txr_jp19", 19) }],
    };
    const { input, notes } = stripeInvoiceToInput(stripeInvoice([line], { currency: "jpy", total: 1468 }), OPTS);
    expect(computeTotals(input).taxInclusiveAmount).toBe(1468);
    expect(notes).toEqual([]);
  });

  // From the second schmoo sweep: 3 × 0.125 − 0.38 rounds to −0.01, not 0.
  it("keeps a half-cent line exact under a 100% discount", () => {
    const line: StripeInvoiceLine = {
      id: "il_free",
      description: "Promo",
      amount: 38,
      quantity: 3,
      pricing: { unit_amount_decimal: "12.5" },
      discount_amounts: [{ amount: 38 }],
      taxes: [{ amount: 0, tax_behavior: "exclusive", taxability_reason: "standard_rated", taxable_amount: 0, tax_rate_details: rate("txr_de19", 19) }],
    };
    const { input, notes } = stripeInvoiceToInput(stripeInvoice([line], { total: 0 }), OPTS);
    expect(computeTotals(input).lineNetAmounts[0]).toBe(0);
    expect(notes).toEqual([]);
  });

  it("refuses a three-decimal currency rather than rounding money", () => {
    expect(() => stripeInvoiceToInput(stripeInvoice(exclusiveLines, { currency: "kwd" }), OPTS)).toThrow(/three decimal/);
  });

  it("keeps package pricing exact through the base quantity", () => {
    // 1,000 units at 5.00 per package of 100: Stripe's unit amount is per package.
    const line: StripeInvoiceLine = {
      id: "il_pkg",
      description: "API calls",
      amount: 5000,
      quantity: 1000,
      pricing: { unit_amount_decimal: "500" },
      taxes: [{ amount: 950, tax_behavior: "exclusive", taxability_reason: "standard_rated", taxable_amount: 5000, tax_rate_details: rate("txr_de19", 19) }],
    };
    const { input, notes } = stripeInvoiceToInput(stripeInvoice([line], { total: 5950 }), OPTS);
    expect(input.lines[0]).toMatchObject({ quantity: 1000, unitPrice: 50, baseQuantity: 1000 });
    expect(computeTotals(input).taxInclusiveAmount).toBe(59.5);
    expect(notes).toEqual([]);
    expect(validateInput(input).errors).toEqual([]);
  });

  // From the schmoo sweep: sub-cent prices were rounded to whole cents first.
  it("keeps a sub-cent unit price exact: 1,000 × 0.5 cents is 5.00", () => {
    const line: StripeInvoiceLine = {
      id: "il_sub",
      description: "API calls",
      amount: 500,
      quantity: 1000,
      pricing: { unit_amount_decimal: "0.5" },
      taxes: [{ amount: 0, tax_behavior: "exclusive", taxability_reason: "zero_rated", taxable_amount: 500, tax_rate_details: rate("txr_z", 0) }],
    };
    const { input, notes } = stripeInvoiceToInput(stripeInvoice([line], { total: 500 }), OPTS);
    expect(computeTotals(input).lineExtensionAmount).toBe(5);
    expect(notes).toEqual([]);
  });

  it("stays exact when 8 decimals of unit price are not enough", () => {
    const line: StripeInvoiceLine = {
      id: "il_frac",
      description: "Metered",
      amount: 4115200,
      quantity: 123456,
      pricing: { unit_amount_decimal: "33.333333333333" },
      taxes: [{ amount: 781888, tax_behavior: "exclusive", taxability_reason: "standard_rated", taxable_amount: 4115200, tax_rate_details: rate("txr_de19", 19) }],
    };
    const { input, notes } = stripeInvoiceToInput(stripeInvoice([line], { total: 4897088 }), OPTS);
    expect(computeTotals(input).lineExtensionAmount).toBe(41152);
    expect(notes).toEqual([]);
    expect(validateInput(input).errors).toEqual([]);
  });

  it("keeps a tax-inclusive line exact at a quantity of ten million", () => {
    const line: StripeInvoiceLine = {
      id: "il_big",
      description: "Units",
      amount: 10_000_000,
      quantity: 10_000_000,
      pricing: { unit_amount_decimal: "1" },
      taxes: [{ amount: 1_596_639, tax_behavior: "inclusive", taxability_reason: "standard_rated", taxable_amount: 8_403_361, tax_rate_details: rate("txr_de19", 19) }],
    };
    const { input, notes } = stripeInvoiceToInput(stripeInvoice([line], { total: 10_000_000 }), OPTS);
    expect(computeTotals(input).lineExtensionAmount).toBe(84033.61);
    expect(notes).toEqual([]);
  });

  it("a fully paid invoice has nothing due even when VAT rounding differs by a cent", () => {
    // Stripe: two lines of 0.03 at 19 % are taxed 0.01 each, total 0.08.
    // EN 16931: 0.06 at 19 % is 0.01, total 0.07.
    const lines = [0, 1].map((k): StripeInvoiceLine => ({
      id: `il_${k}`,
      description: "Tiny",
      amount: 3,
      quantity: 1,
      pricing: { unit_amount_decimal: "3" },
      taxes: [{ amount: 1, tax_behavior: "exclusive", taxability_reason: "standard_rated", taxable_amount: 3, tax_rate_details: rate("txr_de19", 19) }],
    }));
    const { input, notes } = stripeInvoiceToInput(stripeInvoice(lines, { total: 8, amount_remaining: 0 }), OPTS);
    expect(computeTotals(input).payableAmount).toBe(0);
    expect(notes[0]).toMatch(/VAT rounding/);
    expect(notes[0]).not.toMatch(/check the invoice in Stripe/);
  });

  it("maps metered usage of zero to a zero line, not a NaN price", () => {
    const line: StripeInvoiceLine = {
      id: "il_zero",
      description: "Overage",
      amount: 0,
      quantity: 0,
      pricing: null,
      taxes: [{ amount: 0, tax_behavior: "inclusive", taxability_reason: "standard_rated", taxable_amount: 0, tax_rate_details: rate("txr_de19", 19) }],
    };
    const { input } = stripeInvoiceToInput(stripeInvoice([...exclusiveLines, line], { total: 11834 }), OPTS);
    expect(input.lines[2]!.unitPrice).toBe(0);
    expect(validateInput(input).errors).toEqual([]);
  });

  it("ends a period that stops at midnight on the previous day", () => {
    const aug6 = Date.UTC(2026, 7, 6) / 1000;
    const sep6 = Date.UTC(2026, 8, 6) / 1000;
    const lines = [{ ...exclusiveLines[0]!, period: { start: aug6, end: sep6 } }, exclusiveLines[1]!];
    const { input } = stripeInvoiceToInput(stripeInvoice(lines, { total: 11834 }), OPTS);
    expect(input.lines[0]!.period).toEqual({ startDate: "2026-08-06", endDate: "2026-09-05" });
  });

  it("takes rates from options.taxRates when the invoice was not expanded", () => {
    const lines = exclusiveLines.map((l) => ({
      ...l,
      taxes: l.taxes!.map((t) => ({ ...t, tax_rate_details: { tax_rate: (t.tax_rate_details!.tax_rate as { id: string }).id } })),
    }));
    expect(() => stripeInvoiceToInput(stripeInvoice(lines, { total: 11834 }), OPTS)).toThrow(/expand/);
    const { input } = stripeInvoiceToInput(stripeInvoice(lines, { total: 11834 }), {
      ...OPTS,
      taxRates: { txr_de19: { id: "txr_de19", percentage: 19 }, txr_de7: { id: "txr_de7", percentage: 7 } },
    });
    expect(input.lines.map((l) => l.vatRate)).toEqual([19, 7]);
  });

  it("returns a note when Stripe's total and the EN 16931 total disagree", () => {
    const { notes } = stripeInvoiceToInput(stripeInvoice(exclusiveLines, { total: 11835 }), OPTS);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/118\.35 but the EN 16931 total is 118\.34/);
  });

  it("leaves missing customer data for the validator to name, rather than inventing it", () => {
    const { input } = stripeInvoiceToInput(
      stripeInvoice(exclusiveLines, { total: 11834, customer_name: null, customer_address: null }),
      OPTS,
    );
    const rules = validateInput(input).errors.map((e) => e.rule);
    expect(rules).toContain("BR-07"); // buyer name
    expect(rules).toContain("BR-11"); // buyer country
  });

  it("refuses what EN 16931 cannot express, saying why", () => {
    const refuse = (inv: StripeInvoice) => () => stripeInvoiceToInput(inv, OPTS);
    expect(refuse(stripeInvoice(exclusiveLines, { number: null }))).toThrow(/draft/);
    expect(refuse(stripeInvoice(exclusiveLines, { lines: { data: exclusiveLines, has_more: true } }))).toThrow(
      /listLineItems/,
    );
    const untaxed = [{ ...exclusiveLines[0]!, taxes: [] }];
    expect(refuse(stripeInvoice(untaxed))).toThrow(/no tax information/);
    const twoTaxes = [{ ...exclusiveLines[0]!, taxes: [...exclusiveLines[0]!.taxes!, ...exclusiveLines[1]!.taxes!] }];
    expect(refuse(stripeInvoice(twoTaxes))).toThrow(/2 taxes/);
    const split = [
      { ...exclusiveLines[0]!, taxes: [{ ...exclusiveLines[0]!.taxes![0]!, taxability_reason: "proportionally_rated" }] },
    ];
    expect(refuse(stripeInvoice(split))).toThrow(StripeMappingError);
  });
});
