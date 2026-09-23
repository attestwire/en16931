# Stripe invoice → XRechnung / Factur-X XML

Turn a finalized Stripe invoice into an EN 16931 e-invoice: XRechnung UBL or
CII for Germany, or the CII XML that goes inside a Factur-X / ZUGFeRD PDF.
It then validates the result before you send it.

[`stripe-to-en16931.ts`](stripe-to-en16931.ts) is a recipe, not a package: one
file with no dependency beyond `@attestwire/en16931`. Copy it into your project
and change what doesn't fit. Its tests,
[`stripe-to-en16931.test.ts`](stripe-to-en16931.test.ts), run in this
package's suite: tax-exclusive and tax-inclusive prices, coupons, two VAT rates
on one invoice, reverse charge, paid invoices, and a round trip through the
UBL and CII generators and readers.

## Use it

Get the file (it is not in the npm package), and the two dependencies:

```bash
curl -O https://raw.githubusercontent.com/attestwire/en16931/main/examples/stripe/stripe-to-en16931.ts
npm install @attestwire/en16931 stripe
npm install -D typescript @types/node
```

```ts
import { writeFileSync } from "node:fs";
import Stripe from "stripe";
import { generateXRechnungUBL, validateInput } from "@attestwire/en16931";
import { stripeInvoiceToInput } from "./stripe-to-en16931.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function exportInvoice(invoiceId: string) {
  const invoice = await stripe.invoices.retrieve(invoiceId);

  // The invoice embeds its first 10 lines. Fetch them all.
  const lines = [];
  for await (const line of stripe.invoices.listLineItems(invoiceId, { limit: 100 })) lines.push(line);

  // Stripe states each line's tax amount, but the percentage lives on the tax rate.
  const rateIds = new Set(
    lines.flatMap((l) => (l.taxes ?? []).map((t) => t.tax_rate_details?.tax_rate)).filter((r) => typeof r === "string"),
  );
  const taxRates = Object.fromEntries(
    await Promise.all([...rateIds].map(async (id) => [id, await stripe.taxRates.retrieve(id)])),
  );

  const { input, notes } = stripeInvoiceToInput(
    { ...invoice, lines: { data: lines, has_more: false } },
    {
      seller: {
        name: "Your Company GmbH",
        vatId: "DE123456789",
        address: { line1: "Musterstraße 1", city: "Berlin", postalCode: "10115", countryCode: "DE" },
        electronicAddress: { schemeId: "EM", value: "invoices@yourcompany.example" },
        contact: { name: "Accounts", email: "invoices@yourcompany.example", phone: "+49 30 1234567" },
      },
      payment: { meansCode: "58", iban: "DE02120300000000202051" }, // SEPA credit transfer
      // BT-10, required by XRechnung: the buyer's Leitweg-ID (public sector) or
      // the reference they gave you. Or set metadata.buyer_reference in Stripe.
      buyerReference: invoice.metadata?.buyer_reference ?? "your-customer-reference",
      taxRates,
    },
  );

  const result = validateInput(input);
  if (!result.valid) {
    // Each error names the rule (BR-DE-15, BR-11…), what is wrong and the fix.
    throw new Error(result.errors.map((e) => `${e.rule}: ${e.message}\n  fix: ${e.fix}`).join("\n"));
  }
  for (const note of notes) console.warn(note);

  writeFileSync(`${input.invoiceNumber}.xml`, generateXRechnungUBL(input));
}
```

To run it on every invoice, call `exportInvoice(event.data.object.id)` from an
`invoice.finalized` webhook.

For CII instead of UBL, pass `profile: "xrechnung-cii"` (or `"facturx-en16931"`)
and call `generateCii(input)`. This library writes the Factur-X **XML**; putting
it inside a PDF/A-3 is a job for a PDF tool.

## What Stripe doesn't know

- **You.** Stripe has your account name and country, not your address, VAT
  number and contact details as the invoice must show them. Pass them as
  `seller`.
- **How to pay you.** XRechnung requires payment instructions (BG-16, rule
  BR-DE-1). Pass them as `payment`.
- **The buyer reference.** XRechnung requires BT-10 (BR-DE-15). For a German
  public-sector buyer it is their Leitweg-ID. Pass `buyerReference`, or set it
  on the Stripe invoice as `metadata.buyer_reference`.

## How it maps

| EN 16931 | From Stripe |
|---|---|
| BT-1 invoice number | `number` (a draft has none, so drafts are refused) |
| BT-2 issue date | `status_transitions.finalized_at`, else `created` |
| BT-9 due date | `due_date` |
| BT-44 / BG-8 buyer | `customer_name`, `customer_address` |
| BT-48 buyer VAT ID | the `eu_vat` entry in `customer_tax_ids`, else any `*_vat` |
| BT-49 buyer electronic address | `customer_email`, scheme `EM` |
| BT-129 / BT-146 quantity, net price | `quantity_decimal`, `pricing.unit_amount_decimal` (tax-exclusive); `taxable_amount ÷ quantity` (tax-inclusive) |
| BT-149 base quantity | the line quantity, when the unit amount does not multiply out to the line amount (package or tiered pricing) |
| BG-27 line allowance | the line's `discount_amounts` (tax-exclusive lines) |
| BT-151 / BT-152 VAT category, rate | `taxability_reason` and the tax rate's `percentage` |
| BG-26 line period | the line's `period` |
| BT-113 paid amount | `total − amount_remaining`: card payments, customer balance and credits alike |

VAT categories: `standard_rated` and `reduced_rated` become S,
`zero_rated` becomes Z, `reverse_charge` becomes AE, the `*_exempt` reasons
become E, and `not_subject_to_tax` becomes O. An exempt (E) line also needs
`vatExemptionReasons: { E: "…" }` (BR-E-10).

## What it refuses, and why

It throws `StripeMappingError` with the reason when:

- **the currency has three decimals** (BHD, JOD, KWD, OMR, TND). EN 16931
  amounts have two, and the recipe won't round money. Zero-decimal currencies
  such as JPY are read in whole units.
- **the amount due includes a previous debt.** EN 16931 has nowhere to carry
  a balance from another invoice.
- **the invoice is a draft.** It has no number yet.
- **a line has no tax information.** Every EN 16931 line needs a VAT category,
  zero-rated and reverse-charge lines included. Use Stripe Tax or tax rates.
- **a line has two taxes.** An EN 16931 line carries one rate. Split the item.
- **a taxability reason has no single category**, such as `not_collecting`,
  `portion_*` or `proportionally_rated`.

It never invents data. A missing customer name or address goes through as
empty, and `validateInput` reports the exact rule (BR-07, BR-11, BR-DE-8…).

## Two things to know

- **Rounding.** Stripe rounds VAT per line, and EN 16931 rounds it per rate
  across the invoice. On a long invoice the two can differ by a cent. The
  document always states the EN 16931 figure, and `notes` tells you when
  Stripe's total differs.
- **Dates are UTC.** An invoice finalized at 00:30 in Berlin is dated the
  previous day. If that matters, convert `finalized_at` in your own time zone
  and set `input.issueDate`.

Not covered: Stripe credit notes, which are a separate object. The same
approach works for them with `invoiceTypeCode: "381"` and positive amounts.
