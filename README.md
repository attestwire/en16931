# @attestwire/en16931

[![CI](https://github.com/attestwire/en16931/actions/workflows/ci.yml/badge.svg)](https://github.com/attestwire/en16931/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@attestwire/en16931.svg)](https://www.npmjs.com/package/@attestwire/en16931)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

**Generate and validate EN 16931 e-invoices (XRechnung UBL, Peppol BIS 3.0) with errors that teach the regulation. Zero runtime dependencies.**

Generated output validates **ACCEPTABLE** against the official
[KoSIT validator](https://github.com/itplr-kosit/validator) 1.6.2 with the
XRechnung 3.0.2 configuration — XSD, EN 16931 schematron and XRechnung CIUS
schematron, zero messages. Reproduce it yourself with
[`scripts/kosit-check.sh`](scripts/kosit-check.sh).

```bash
npm install @attestwire/en16931
```

```ts
import { validateInput, generateXRechnungUBL } from "@attestwire/en16931";

const invoice = {
  profile: "xrechnung-ubl",
  invoiceNumber: "2026-000142",
  issueDate: "2026-08-09",
  currency: "EUR",
  buyerReference: "04011000-1234512345-06", // Leitweg-ID
  seller: { /* name, vatId, address, electronicAddress, contact */ },
  buyer: { /* name, address, electronicAddress */ },
  payment: { meansCode: "58", iban: "DE02120300000000202051" },
  lines: [
    { id: "1", description: "Beratung", quantity: 10, unitCode: "HUR",
      unitPrice: 150, vatCategory: "S", vatRate: 19 },
  ],
} as const;

const result = validateInput(invoice);
if (!result.valid) {
  for (const e of result.errors) console.error(`${e.rule}: ${e.message}\n  → ${e.fix}`);
} else {
  const xml = generateXRechnungUBL(invoice); // UBL 2.1 Invoice, XRechnung 3.0
}
```

The seller and buyer blocks are elided above — see
[Full example](#full-example) for the complete, runnable invoice.

**Links**

- **[58 rule pages](https://attestwire.com/rules/)** — one page per implemented
  rule, with the reason, the fix and a passing example. Every `TeachingError`
  carries a `docsUrl` pointing at its page.
- **[Hosted API](https://api.attestwire.com/docs)** — same engine, zero setup.
  POST JSON, get validated XRechnung XML back.
- **[Teaching-error sample](#teaching-errors)** — what a rejection actually
  looks like.

Totals are always **computed** from the lines, never echoed from caller input, so
a BR-CO arithmetic rejection cannot originate in the generated document.

## Teaching errors

Drop the `buyerReference`, the `payment` block and the seller `contact` from the
invoice above and you get this — not "validation failed":

```
errors: 3  warnings: 2
BR-DE-15, BR-DE-1, BR-DE-2
```

```json
{
  "rule": "BR-DE-15",
  "field": "BT-10",
  "severity": "fatal",
  "message": "XRechnung requires a buyer reference (BT-10). For German public-sector buyers this is the Leitweg-ID; business buyers may supply any reference, but the field must be present.",
  "fix": "Ask your client for their Leitweg-ID (public sector) or an order/customer reference, and set buyerReference.",
  "example": "\"buyerReference\": \"04011000-1234512345-06\"",
  "xpath": "/ubl:Invoice/cbc:BuyerReference",
  "docsUrl": "https://attestwire.com/rules/BR-DE-15"
}
```

Errors explain the *reason*, not just the requirement. `BR-S-05` does not say
"rate must be > 0"; it says a zero rate with category S is contradictory, and
that if no VAT is due the category should be Z, E, AE, K, G or O — each with
different evidencing requirements.

Warnings are separated from errors: `result.valid` reflects fatal rules only, so
KoSIT-style advisory rules (`BR-DE-27`, `BR-DE-28`) never block a build.

## Full example

The invoice literal from the quickstart, in full — a domestic German invoice to
a public-sector buyer, one line at 19%:

```ts
import { validateInput, generateXRechnungUBL } from "@attestwire/en16931";

const invoice = {
  profile: "xrechnung-ubl",
  invoiceNumber: "2026-000142",
  issueDate: "2026-08-09",
  currency: "EUR",
  buyerReference: "04011000-1234512345-06", // Leitweg-ID
  seller: {
    name: "Musterlieferant GmbH",
    vatId: "DE123456789",
    address: { line1: "Hauptstraße 1", city: "Berlin", postalCode: "10115", countryCode: "DE" },
    electronicAddress: { schemeId: "9930", value: "DE123456789" },
    contact: { name: "Buchhaltung", phone: "+49 30 1234567", email: "rechnungen@musterlieferant.example" },
  },
  buyer: {
    name: "Bundesamt für Musterangelegenheiten",
    address: { city: "München", postalCode: "80331", countryCode: "DE" },
    electronicAddress: { schemeId: "0204", value: "04011000-1234512345-06" },
  },
  payment: { meansCode: "58", iban: "DE02120300000000202051" },
  lines: [
    { id: "1", description: "Beratung", quantity: 10, unitCode: "HUR", unitPrice: 150, vatCategory: "S", vatRate: 19 },
  ],
} as const;

const result = validateInput(invoice);
if (!result.valid) {
  for (const e of result.errors) console.error(`${e.rule}: ${e.message}\n  → ${e.fix}`);
} else {
  const xml = generateXRechnungUBL(invoice); // UBL 2.1 Invoice, XRechnung 3.0
}
```

The IBAN above is the standard published test IBAN used throughout German
banking documentation; every identifier in this repository's examples and
fixtures is synthetic.

## API

| Export | Purpose |
| --- | --- |
| `validateInput(inv)` | Run all input rules. Returns `{ valid, profile, errors, warnings }`. Reports **every** finding, not the first. |
| `generateXRechnungUBL(inv, options?)` | JSON → UBL 2.1 Invoice XML string. |
| `computeTotals(inv)` | BG-22 totals and the BG-23 VAT breakdown, as the BR-CO rules define them. |
| `lineNetAmount(line)` | BT-131 for a single line. |
| `round2(n)` / `formatAmount(n)` | Half-up 2dp rounding, and its 2-decimal string form. |
| `inputRules` | The raw rule array, if you want to run a subset. |
| `CUSTOMIZATION_IDS` / `PROFILE_IDS` | BT-24 / BT-23 values per profile. |
| `minimalXRechnung` / `reverseChargeXRechnung` | The example inputs behind `fixtures/`. |

`GenerateOptions`: `indent` (default `"  "`), `customizationId`, `profileId` — the
last two let you pin an older CIUS version such as XRechnung 2.3.

### Rounding

EN 16931 sums **already-rounded** line amounts. Rounding only the final sum
drifts by a cent or two on long invoices and gets rejected under BR-CO-10.
`round2` is half-up and works around both JS traps: `Math.round(1.005 * 100)/100`
is `1.00`, and `(2.675).toFixed(2)` is `"2.67"`. Both are wrong for tax.

## Scope

### Implemented

| Area | Coverage |
| --- | --- |
| **XRechnung 3.0 UBL generation** | Full document: namespaces, BT-24/BT-23, header terms, both parties (incl. electronic address with `schemeID`, VAT vs. national tax scheme, legal entity, contact), delivery group, payment means, payment terms, tax breakdown, monetary totals, lines. |
| **BT coverage** | BT-1, 2, 3, 5, 9, 10, 13, 20, 22, 23, 24, 27, 30, 31, 32, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 72, 75, 77, 78, 80, 81, 82, 83, 84, 85, 86, 106, 109, 110, 112, 115, 116, 117, 118, 119, 120, 126, 129, 130, 131, 146, 149, 151, 152, 153, 154. |
| **Arithmetic** | BR-CO-10/13/14/15/16/17 and the BR-S-08 family, with per-line half-up rounding and sums of rounded values. |
| **Rules** | ~30 rules with teaching errors (see below). |
| **KoSIT parity** | Both fixtures pass the official validator 1.6.2 / XRechnung 3.0.2 config: XSD, EN 16931 schematron and XRechnung CIUS schematron, zero messages. |

Rules implemented: `BR-02`, `BR-03`, `BR-05`, `BR-06`, `BR-07`, `BR-08`, `BR-09`,
`BR-10`, `BR-11`, `BR-16`, `BR-21`, `BR-22`, `BR-23`, `BR-25`, `BR-26`, `BR-27`,
`BR-61`, `BR-62`, `BR-63`, `BR-CO-09`, `BR-CO-10`, `BR-CO-13`, `BR-CO-14`,
`BR-CO-15`, `BR-CO-16`, `BR-CO-26`, `BR-S-02`, `BR-S-05`, `BR-Z-02`, `BR-Z-05`,
`BR-E-02`, `BR-E-05`, `BR-E-10`, `BR-AE-02`, `BR-AE-05`, `BR-IC-02`, `BR-IC-05`,
`BR-IC-11`, `BR-IC-12`, `BR-G-02`, `BR-G-05`, `BR-O-02`, `BR-O-05`, `BR-DE-1`,
`BR-DE-2`, `BR-DE-3`, `BR-DE-4`, `BR-DE-5`, `BR-DE-6`, `BR-DE-7`, `BR-DE-8`,
`BR-DE-9`, `BR-DE-10`, `BR-DE-11`, `BR-DE-15`, `BR-DE-16`, `BR-DE-17`,
`BR-DE-27`, `BR-DE-28`, `PEPPOL-EN16931-R010`, `PEPPOL-EN16931-R020`.

### Not implemented yet

| Area | Status |
| --- | --- |
| **Full schematron parity** | ~30 of ~180 applicable rules. `validateInput` is a fast pre-flight, **not** an authority — a document it accepts can still be rejected by KoSIT. What *is* proven: the XML this package **generates** validates ACCEPTABLE against the official KoSIT validator 1.6.2 / XRechnung 3.0.2 config (reproduce with [`scripts/kosit-check.sh`](scripts/kosit-check.sh)). If you want the authoritative answer without running Java, the [hosted API](https://api.attestwire.com/docs) is the same engine with full schematron behind it, zero setup. |
| **Validating existing XML** | Only the JSON input model is validated. `TeachingError.xpath` is populated in anticipation of this. |
| **Document-level allowances & charges** (BG-20/BG-21) | Not modelled, so BT-107/BT-108 are always zero. |
| **Line allowances & charges** (BG-27/BG-28) | Not modelled. |
| **Prepaid & rounding amounts** (BT-113/BT-114) | Not modelled, so BT-115 always equals BT-112. |
| **CII syntax** | `xrechnung-cii` validates, but only UBL is generated. |
| **Factur-X / ZUGFeRD PDF** | Not started. |
| **Credit notes** | `invoiceTypeCode: "381"` is accepted, but the UBL `CreditNote` document type is not generated. |
| **Code-list validation** | Currency, unit and country codes are shape-checked, not checked against ISO 4217 / UN/ECE Rec 20 / ISO 3166. |
| **VIES lookups** | Out of scope for this package. |

## Fixtures

[`fixtures/`](fixtures) in the repository (not in the npm tarball — the package
ships `dist` only) holds two generated documents, both verified against the
official KoSIT validator:

- `xrechnung-ubl-minimal.xml` — domestic German invoice, two lines at 19% and 7%.
- `xrechnung-ubl-reverse-charge.xml` — cross-border DE→NL, VAT category AE.

Regenerate and re-verify:

```bash
npm run build
node scripts/emit-fixtures.mjs
./scripts/kosit-check.sh      # needs a JDK 11+; see scripts/kosit-check.md
```

`npm test` asserts the committed XML still matches current output, so generator
drift shows up as a test failure rather than a stale file.

## Development

```bash
npm install
npm test      # 129 tests
npm run build
```

## Licence

MIT
