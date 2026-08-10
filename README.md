# @attestwire/en16931

[![CI](https://github.com/attestwire/en16931/actions/workflows/ci.yml/badge.svg)](https://github.com/attestwire/en16931/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@attestwire/en16931.svg)](https://www.npmjs.com/package/@attestwire/en16931)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

**Generate and validate EN 16931 e-invoices (XRechnung UBL, Peppol BIS 3.0) with
errors that teach the regulation.**

The three release fixtures in [`fixtures/`](fixtures) — the documents this
generator produces — are validated against the UBL 2.1 XSD, and are checked
against the official [KoSIT validator](https://github.com/itplr-kosit/validator)
1.6.2 with the XRechnung 3.0.2 configuration (XSD, EN 16931 schematron,
XRechnung CIUS schematron) on release. Reproduce it yourself with
[`scripts/kosit-check.sh`](scripts/kosit-check.sh), which needs a JDK.

**The KoSIT run for 0.2.0 has not been performed**: the machine this release was
built on has no Java runtime. The XSD validation that *was* run proves element
order and schema validity and says nothing about the schematron, which is where
every EN 16931 and XRechnung rule lives — so treat the schematron result as
unverified for this version until you run the script yourself. Even a clean run
is a conformance check on three documents, not a parity suite: it says nothing
about the paths those three fixtures do not exercise, and `validateInput` is a
pre-flight rather than a schematron (see
[Not implemented yet](#not-implemented-yet)).

Zero runtime dependencies. TypeScript-first. Every validation failure carries the
official rule ID, the business term it constrains, a plain-English explanation of
*why* the regulation requires it, a concrete fix, and a passing example — so a
developer (or an agent) can correct the invoice without opening the spec.

```bash
npm install @attestwire/en16931
```

## Quickstart

```ts
import { validateInput, generateXRechnungUBL, type InvoiceInput } from "@attestwire/en16931";

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
    contact: { name: "Buchhaltung", phone: "+49 30 1234567", email: "rechnungen@example.de" },
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
} satisfies InvoiceInput;

const result = validateInput(invoice);
if (!result.valid) {
  for (const e of result.errors) console.error(`${e.rule}: ${e.message}\n  → ${e.fix}`);
} else {
  const xml = generateXRechnungUBL(invoice); // UBL 2.1 Invoice, XRechnung 3.0
}
```

Every identifier in this repository's examples and fixtures is synthetic; the
IBAN above is the test IBAN used throughout German banking documentation.

**Links**

- **[Rule reference](https://attestwire.com/rules/)** — one page per implemented
  rule, with the reason, the fix and a passing example. Every `TeachingError`
  carries a `docsUrl` pointing at its page.
- **[Hosted API](https://api.attestwire.com/docs)** — same engine, zero setup.
  POST JSON, get validated XRechnung XML back.
- **[Teaching-error sample](#teaching-errors)** — what a rejection actually
  looks like.

Totals are always **computed** from the lines, never echoed from caller input, so
a BR-CO arithmetic rejection cannot originate in the generated document.

Generation **refuses** rather than emitting a document that would be rejected
downstream: a non-UBL profile throws `UnsupportedProfileError` and a credit-note
`invoiceTypeCode` throws `UnsupportedDocumentTypeError` (see
[Refusals](#refusals)).

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

Findings are separated by severity, because the reference validators separate
them: KoSIT's schematron flags each assertion `fatal`, `warning` or
`information`, and a report that promotes an advisory to an error is as wrong as
one that misses it. `result.valid` reflects fatal rules only, so advisory rules
(`BR-DE-27`, `BR-DE-28`) never block a build. `result.information` is a third
array, deliberately kept out of `warnings`: a caller who fails a build on a
non-empty `warnings` array should not be stopped by a finding the official
validator raises and then accepts. `BR-DE-TMP-32` — an invoice should state a
delivery date — is the rule that needs it.

If you switch or filter on `severity`, add the third value: a consumer that
allow-lists `['fatal', 'warning']` will silently drop `information` findings.
The union is exported as the type `Severity`, so a `switch` over it that misses
a case fails the build rather than the audit.

## API

| Export | Purpose |
| --- | --- |
| `validateInput(inv)` | Run all input rules. Returns `{ valid, profile, errors, warnings, information }`. Reports **every** finding, not the first. |
| `generateXRechnungUBL(inv, options?)` | JSON → UBL 2.1 Invoice XML string. |
| `computeTotals(inv)` | BG-22 totals and the BG-23 VAT breakdown, as the BR-CO rules define them — including BT-107/BT-108 for document allowances and charges, and BT-113/BT-114. |
| `lineNetAmount(line)` | BT-131 for a single line, net of its BG-27 allowances and BG-28 charges. |
| `round2(n)` / `formatAmount(n)` | Half-up 2dp rounding, and its 2-decimal string form. |
| `inputRules` | The raw rule array, if you want to run a subset. |
| `runInputRules(inv)` | The flat `TeachingError[]` behind `validateInput`, in rule order and unsplit by severity — what you want if you are grouping findings yourself. |
| `effectiveRate(line)` | The rate a line actually contributes to the BG-23 breakdown: `undefined` for the categories that carry none, `0` for the fixed-zero ones, otherwise `vatRate`. Use it rather than reading `line.vatRate`, or your grouping will disagree with ours. |
| `effectiveAllowanceChargeRate(entry)` | The same normalisation for a document allowance (BT-96) or charge (BT-103), so BG-20/BG-21 land in the same group as the lines they adjust. |
| `DEFAULT_EXEMPTION_REASONS` | The BT-120 wording this library supplies when you leave `vatExemptionReasons` unset — the standard texts named in `BR-AE-10`, `BR-IC-10`, `BR-G-10` and `BR-O-10`. Category `E` is deliberately absent: the reason depends on which national exemption you claim. |
| `DEFAULT_INVOICE_TYPE_CODE` | The BT-3 used when you supply none — `"380"`, commercial invoice. |
| `INVOICED_OBJECT_DOCUMENT_TYPE_CODE` | `"130"`, the UNTDID 1153 code that marks a `cac:AdditionalDocumentReference` as the invoiced object identifier (BT-18) rather than a supporting document (BG-24). They share one element and are told apart only by this code. |
| `CUSTOMIZATION_IDS` / `PROFILE_IDS` | BT-24 / BT-23 values per profile. |
| `UBL_GENERATABLE_PROFILES` / type `UblGeneratableProfile` | The profiles `generateXRechnungUBL` accepts, and the union type of them — narrow to it and the compiler rejects a profile that would throw. |
| `CREDIT_NOTE_TYPE_CODES` | The six BT-3 values this build **refuses** to generate — `381`, `261`, `262`, `296`, `308`, `396`. A `Set`, used by `generateXRechnungUBL` and by `ATW-CREDIT-NOTE-UNSUPPORTED`. Not a code list: it is this library's refusal set. |
| `CREDIT_NOTE_TYPE_CODES_CL` (and `_SET`) | The thirteen UNTDID 1001 codes BR-CL-01 admits on a *credit note* document (`cbc:CreditNoteTypeCode`) — `81`, `83`, `261`, `262`, `296`, `308`, `381`, `396`, `420`, `458`, `502`, `503`, `532`. The `_CL` suffix means code list. Different list, different job: it exists for validating credit-note documents, and a code in it that is not in `CREDIT_NOTE_TYPE_CODES` (such as `83`) is not refused by this generator. Reach for `CREDIT_NOTE_TYPE_CODES` when you want to know what this build will throw on, and for `CREDIT_NOTE_TYPE_CODES_CL` when you want to know what the regulation calls a credit note. |
| `PEPPOL_EAS_SCHEME_CODES`, `PEPPOL_CURRENCY_CODES` (and their `_SET` variants) | Peppol's own narrower lists, enforced only on `profile: "peppol-bis-3"`: the EAS schemes `PEPPOL-EN16931-CL008` admits for BT-34/BT-49, and the currencies `PEPPOL-EN16931-CL007` admits for BT-5. Both rules name these exports in their `fix` text, so this is where a caller following the error message lands. |
| `GenerationError` and subclasses | What generation throws instead of emitting a wrong document. |
| `minimalXRechnung` / `reverseChargeXRechnung` / `discountedXRechnung` | The example inputs behind `fixtures/`. |
| `CURRENCY_CODES`, `COUNTRY_CODES`, `UNIT_CODES`, `VAT_CATEGORY_CODES`, `PAYMENT_MEANS_CODES`, `INVOICE_TYPE_CODES`, `EAS_SCHEME_CODES`, `ICD_SCHEME_CODES`, `OBJECT_SCHEME_CODES`, `ITEM_CLASSIFICATION_SCHEME_CODES`, `ALLOWANCE_REASON_CODES`, `CHARGE_REASON_CODES`, `VATEX_CODES`, `MIME_CODES`, `NOTE_SUBJECT_CODES`, `VAT_POINT_DATE_CODES` (and a `_SET` for each) | The official code lists the `BR-CL-*` rules enforce. Build a picker that cannot offer a value the validator rejects. |

`GenerateOptions`: `indent` (default `"  "`), `customizationId`, `profileId` — the
last two let you pin an older CIUS version such as XRechnung 2.3.

### Refusals

`generateXRechnungUBL` throws instead of returning XML in two cases. Both errors
extend `GenerationError`, carry a stable `code`, and explain in the message what
*is* supported:

| Error | `code` | When |
| --- | --- | --- |
| `UnsupportedProfileError` | `unsupported_profile` | `profile` is not one of `en16931`, `xrechnung-ubl`, `peppol-bis-3`. In particular `xrechnung-cii` and `facturx-en16931` are CII documents (Factur-X being CII inside a PDF/A-3); emitting UBL under those names would produce a file that passes nothing. |
| `UnsupportedDocumentTypeError` | `unsupported_document_type` | `invoiceTypeCode` is one of the six codes in `CREDIT_NOTE_TYPE_CODES` — `381`, `261`, `262`, `296`, `308`, `396`. A UBL credit note is a separate `CreditNote` document, not an `Invoice` with a different BT-3. That set is narrower than the thirteen-code `CREDIT_NOTE_TYPE_CODES_CL`: `invoiceTypeCode: "83"` is a credit-note code in the code list and does **not** throw here. |

`validateInput` reports the credit-note case up front as a fatal finding with the
rule id `ATW-CREDIT-NOTE-UNSUPPORTED` — the `ATW-` prefix marks a limitation of
this library rather than a rule of the regulation, so it never gets mistaken for
a KoSIT finding. Validate first and you will never hit the throw.

### Rounding

EN 16931 sums **already-rounded** line amounts. Rounding only the final sum
drifts by a cent or two on long invoices and gets rejected under BR-CO-10.
`round2` is half-up and works around both JS traps: `Math.round(1.005 * 100)/100`
is `1.00`, and `(2.675).toFixed(2)` is `"2.67"`. Both are wrong for tax.

## Scope

### Implemented

| Area | Coverage |
| --- | --- |
| **XRechnung 3.0 UBL generation** | Full document: namespaces, BT-24/BT-23, header terms, both parties (incl. electronic address with `schemeID`, VAT vs. national tax scheme, legal entity, party and registration identifiers with their ISO 6523 schemes, trading name, contact), payee and tax representative parties, delivery group, payment means with card (`cac:CardAccount`) and direct debit (`cac:PaymentMandate`), payment terms, tax breakdown, monetary totals, lines. Plus document and line allowances and charges (`cac:AllowanceCharge`), invoicing periods at both levels, preceding invoice references (`cac:BillingReference`), the project/contract/despatch/receipt/tender/sales-order references, the invoiced object identifier and supporting documents (`cac:AdditionalDocumentReference`, including an embedded base64 attachment), item identifiers, origin country, commodity classification and item attributes, a second `cac:TaxTotal` for the VAT accounting currency, and the price allowance for BT-147/BT-148. Element order follows `UBL-Invoice-2.1.xsd`, and all three fixtures validate against the UBL 2.1 XSD. |
| **BT coverage** | BT-1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161. |
| **Arithmetic** | BT-131 = quantity × (BT-146 / BT-149) − Σ BT-136 + Σ BT-141; BT-106 = Σ BT-131; BT-107 = Σ BT-92; BT-108 = Σ BT-99; BT-109 = BT-106 − BT-107 + BT-108; the BG-23 taxable amount per (category, rate) group nets document allowances out and charges in; BT-117 from BT-116 × BT-119; BT-110 = Σ BT-117; BT-112 = BT-109 + BT-110; BT-115 = BT-112 − BT-113 + BT-114. Per-line half-up rounding, and sums taken over the rounded values. BT-107 and BT-108 stay separate sums even where the breakdown nets them — that asymmetry is the standard's. |
| **Rules** | 287 regulation rules with teaching errors (enumerated below), plus four library-limitation findings (`ATW-CREDIT-NOTE-UNSUPPORTED`, `ATW-DECLARED-TOTAL-NOT-FINITE`, `ATW-VAT-CATEGORY-UNSUPPORTED`, `ATW-DATE-NOT-A-CALENDAR-DATE`) — 291 distinct rule ids. 251 are reachable from caller input; the other 40 constrain the library's own computed arithmetic and cannot be tripped by any input, which is what they are for. |
| **KoSIT conformance of the fixtures** | Checked on release against the official validator 1.6.2 / XRechnung 3.0.2 config: XSD, EN 16931 schematron and XRechnung CIUS schematron. Three documents, not a parity suite — **and the 0.2.0 run has not been performed on the build machine, which has no JDK.** Run `./scripts/kosit-check.sh` yourself before relying on it. |

Rules implemented, by family. This list is maintained by hand; the
[rule reference](https://attestwire.com/rules/) derives its own from the engine.

- **Document and party** — `BR-02`, `BR-03`, `BR-04`, `BR-05`, `BR-06`, `BR-07`,
  `BR-08`, `BR-09`, `BR-10`, `BR-11`, `BR-12`, `BR-13`, `BR-14`, `BR-15`,
  `BR-16`, `BR-17` (payee), `BR-18`, `BR-19`, `BR-20`, `BR-56` (seller tax
  representative), `BR-57`, `BR-CO-26`.
- **Lines** — `BR-21`, `BR-22`, `BR-23`, `BR-24`, `BR-25`, `BR-26`, `BR-27`,
  `BR-28`, `BR-CO-04`.
- **Allowances and charges** — document level (BG-20/BG-21): `BR-31`, `BR-32`,
  `BR-33`, `BR-36`, `BR-37`, `BR-38`, `BR-CO-11`, `BR-CO-12`, `BR-CO-21`,
  `BR-CO-22`. Line level (BG-27/BG-28): `BR-41`, `BR-42`, `BR-43`, `BR-44`,
  `BR-CO-23`, `BR-CO-24`.
- **VAT breakdown** — `BR-45`, `BR-46`, `BR-47`, `BR-48`, `BR-CO-17`,
  `BR-CO-18`.
- **VAT categories** — the `-01` (breakdown cardinality), `-02` (seller
  identification), `-03`/`-04` (allowance and charge identification), `-05`
  (line rate), `-06`/`-07` (allowance and charge rate), `-08` (taxable amount),
  `-09` (VAT amount) and `-10` (exemption reason) rules for all seven
  categories: `BR-S-*`, `BR-Z-*`, `BR-E-*`, `BR-AE-*`, `BR-IC-*`, `BR-G-*`,
  `BR-O-*` (the intra-community family is `BR-IC-*`, for category K). The `-10`
  rules cut both ways: on the exempting categories they require an exemption
  reason, and on S and Z they forbid one. On top of those sit `BR-IC-11`,
  `BR-IC-12`, `BR-O-11`, `BR-O-12`, `BR-O-13` and `BR-O-14`.
- **Arithmetic against caller-declared totals** — `BR-CO-10`, `BR-CO-13`,
  `BR-CO-14`, `BR-CO-15`, `BR-CO-16`.
- **Periods and dates** — `BR-29`, `BR-30`, `BR-CO-03`, `BR-CO-19`, `BR-CO-20`.
- **References, items and attachments** — `BR-50`, `BR-51`, `BR-52`, `BR-53`,
  `BR-54`, `BR-55`, `BR-64`, `BR-65`.
- **Decimal precision** — `BR-DEC-01`, `BR-DEC-02`, `BR-DEC-05`, `BR-DEC-06`,
  `BR-DEC-09`, `BR-DEC-10`, `BR-DEC-11`, `BR-DEC-12`, `BR-DEC-13`, `BR-DEC-14`,
  `BR-DEC-15`, `BR-DEC-16`, `BR-DEC-17`, `BR-DEC-18`, `BR-DEC-19`, `BR-DEC-20`,
  `BR-DEC-23`, `BR-DEC-24`, `BR-DEC-25`, `BR-DEC-27`, `BR-DEC-28`.
- **Code lists** — every `BR-CL-*` rule in the reference schematron:
  `BR-CL-01`, `BR-CL-03`, `BR-CL-04`, `BR-CL-05`, `BR-CL-06`, `BR-CL-07`,
  `BR-CL-08`, `BR-CL-10`, `BR-CL-11`, `BR-CL-13`, `BR-CL-14`, `BR-CL-15`,
  `BR-CL-16`, `BR-CL-17`, `BR-CL-18`, `BR-CL-19`, `BR-CL-20`, `BR-CL-21`,
  `BR-CL-22`, `BR-CL-23`, `BR-CL-24`, `BR-CL-25`, `BR-CL-26`. (There is no
  BR-CL-02, -09 or -12.)
- **VAT identifiers** — `BR-CO-09`, including the Greek `EL` derogation.
- **Payment** — `BR-49`, `BR-61`.
- **XRechnung CIUS** — `BR-DE-1`, `BR-DE-2`, `BR-DE-3`, `BR-DE-4`, `BR-DE-5`,
  `BR-DE-6`, `BR-DE-7`, `BR-DE-8`, `BR-DE-9`, `BR-DE-10`, `BR-DE-11`,
  `BR-DE-14`, `BR-DE-15`, `BR-DE-16`, `BR-DE-17`, `BR-DE-18`, `BR-DE-19`,
  `BR-DE-20`, `BR-DE-22`, `BR-DE-23-a`, `BR-DE-23-b`, `BR-DE-24-a`,
  `BR-DE-24-b`, `BR-DE-25-a`, `BR-DE-25-b`, `BR-DE-26`, `BR-DE-27`,
  `BR-DE-28`, `BR-DE-30`, `BR-DE-31`, `BR-DE-TMP-32`.
- **Transport** — `BR-62`, `BR-63`, `PEPPOL-EN16931-R010`,
  `PEPPOL-EN16931-R020`.
- **Peppol BIS Billing 3.0** (only on `profile: "peppol-bis-3"`) —
  `PEPPOL-EN16931-R003`, `R005`, `R040`, `R041`, `R042`, `R046`, `R055`,
  `R061`, `R110`, `R111`, `R120`, `R121`; the code-list rules
  `PEPPOL-EN16931-CL007` and `CL008`; the process rules
  `PEPPOL-EN16931-P0100`, `P0112` and the VATEX/category pairs `P0104`,
  `P0105`, `P0106`, `P0107`, `P0108`, `P0109`, `P0111`; and the national
  identifier checksums `PEPPOL-COMMON-R040` .. `R050`, `R052`, `R053`.
- **Regional VAT categories** — IGIC (`L`): `BR-AF-01` .. `BR-AF-10`;
  IPSI (`M`): `BR-AG-01` .. `BR-AG-10`.
- **Library limitations** (`ATW-` prefix, not rules of the regulation) —
  `ATW-CREDIT-NOTE-UNSUPPORTED`, `ATW-DECLARED-TOTAL-NOT-FINITE`,
  `ATW-VAT-CATEGORY-UNSUPPORTED`.

### Code lists

Every coded field this model can express is checked against the **complete
official list**, not against a shape. The tables live in `src/codelists/` and are
generated by `scripts/build-codelists.mjs` from `EN16931-UBL-codes.sch` and
`EN16931-UBL-model.sch` in
[ConnectingEurope/eInvoicing-EN16931](https://github.com/ConnectingEurope/eInvoicing-EN16931)
at `validation-1.3.16` — the same artefacts the KoSIT validator evaluates, so the
lists cannot drift from the ones you will be judged against.

| List | Codes | Rule |
| --- | --- | --- |
| UNTDID 1001 invoice type | 50 | `BR-CL-01` |
| ISO 4217 currency | 178 | `BR-CL-03`, `BR-CL-04`, `BR-CL-05` |
| ISO 3166-1 country | 251 | `BR-CL-14`, `BR-CL-15` |
| UNTDID 4461 payment means | 84 | `BR-CL-16` |
| UNCL5305 VAT category | 10 | `BR-CL-17`, `BR-CL-18` |
| UN/ECE Rec 20 + Rec 21 unit | 2,162 | `BR-CL-23` |
| CEF EAS scheme | 104 | `BR-CL-25` |
| ISO 6523 ICD scheme | 243 | `BR-CL-10`, `BR-CL-11`, `BR-CL-21`, `BR-CL-26` |
| UNTDID 2005 tax point date | 3 | `BR-CL-06` |
| UNTDID 1153 object scheme | 818 | `BR-CL-07` |
| UNCL 4451 note subject | 383 | `BR-CL-08` |
| UNTDID 7143 item classification scheme | 185 | `BR-CL-13` |
| UNCL 5189 allowance reason | 19 | `BR-CL-19` |
| UNCL 7161 charge reason | 178 | `BR-CL-20` |
| CEF VATEX exemption reason | 88 | `BR-CL-22` |
| Attachment MIME type | 6 | `BR-CL-24` |

Two details the generator script enforces rather than assumes. BR-CL-08's list
lives in `EN16931-UBL-model.sch` rather than in the codes file, because UBL has
no element for BT-21 and the note subject code has to be asserted inside the
model rules; the script fetches both files. And `BR-CL-11`, `BR-CL-21` and
`BR-CL-26` each restate the ISO 6523 list in full — the script asserts all three
literals are byte-identical to `BR-CL-10`'s before exporting one shared array,
so a drift upstream fails the build instead of being silently resolved in
someone's favour.

Each list is a side-effect-free module exporting a frozen array and a `Set`. The
whole set is 16.6 kB gzipped, 6.0 kB of which is the unit list; a bundler that
sees no reference to a list drops it.

### Not implemented yet

| Area | Status |
| --- | --- |
| **Full schematron parity** | This build implements every EN 16931 core rule, every XRechnung CIUS rule and every Peppol BIS Billing 3.0 rule that the input model can express. What remains is bounded and named in the rows below: category `B`, the Extension and CVD profiles, four rules the regulator does not test either, and the rules the generator controls. `validateInput` is still a fast pre-flight over the JSON input model, **not** an authority — it reads your input, not the XML a receiver will judge, so a document it accepts can in principle still be rejected by KoSIT. If you want the authoritative answer without running Java, the [hosted API](https://api.attestwire.com/docs) is the same engine, zero setup. |
| **VAT category B (split payment)** | `L` (IGIC) and `M` (IPSI) ship with their full `BR-AF-*` and `BR-AG-*` families. `B` does not. It is the one code of the ten with no `-01`/`-05`/`-08`/`-09`/`-10` family — only `BR-B-01` and `BR-B-02`, both of which exist to confine it to domestic Italian invoices — so expressing it would mean emitting rule ids the regulation does not define, or carving it out of every per-category loop for the sake of two checks. A line carrying `"B"` is a fatal `ATW-VAT-CATEGORY-UNSUPPORTED` finding rather than a silent pass. |
| **XRechnung Extension and CVD profiles** | `BR-DEX-*` and `BR-DE-CVD-*` apply to customization ids this build does not emit. |
| **Rules that cannot be tested mechanically** | `BR-CO-05`, `BR-CO-06`, `BR-CO-07` and `BR-CO-08` require a reason code and a reason text to "indicate the same type of allowance". The reference schematron binds all four to `true()` — the regulator does not test them either. `BR-CO-25` is absent from both the reference schematron and Peppol's, so implementing it would reject documents the authority accepts. |
| **Rules the generator controls** | `BR-01` and `BR-DE-21` constrain BT-24, which `generateXRechnungUBL` derives from `profile`; the only override is `GenerateOptions.customizationId`, which `validateInput` never sees. `BR-DE-13` is in the same position. They belong to a document-validation entry point, not an input pre-flight. |
| **Validating existing XML** | Only the JSON input model is validated. `TeachingError.xpath` is populated in anticipation of this. |
| **CII syntax** | `validateInput` runs the profile's rules against the JSON model, but no CII document is generated: `generateXRechnungUBL` throws `UnsupportedProfileError` for `xrechnung-cii`. |
| **Factur-X / ZUGFeRD PDF** | Not started. `facturx-en16931` throws `UnsupportedProfileError` on generation. |
| **Credit notes** | `invoiceTypeCode: "381"` is a fatal `ATW-CREDIT-NOTE-UNSUPPORTED` finding and generation throws. A UBL credit note is a separate `CreditNote` document (root `ubl:CreditNote`, `cac:CreditNoteLine`, `cbc:CreditedQuantity`), not an `Invoice` with a different BT-3. |
| **VIES lookups** | Out of scope for this package. |

## Fixtures

`fixtures/` ships in the npm tarball and holds three generated documents, all
validated against the UBL 2.1 XSD and checked against the official KoSIT
validator on release:

- `xrechnung-ubl-minimal.xml` — domestic German invoice, two lines at 19% and 7%.
- `xrechnung-ubl-reverse-charge.xml` — cross-border DE→NL, VAT category AE.
- `xrechnung-ubl-discount.xml` — a German Schlussrechnung: a line allowance, a
  document allowance and a document charge in the 19% group, two VAT rates, an
  invoicing period instead of a delivery date, a reference to the
  Abschlagsrechnung it settles, a prepayment of 500.00 and a rounding amount of
  0.47 that takes the payable figure to a round 1 680.00.

Regenerate and re-verify:

```bash
npm run build
node scripts/emit-fixtures.mjs
./scripts/kosit-check.sh      # needs a JDK 11+; see scripts/kosit-check.md
```

`kosit-check.sh` takes `JAVA_BIN=/path/to/bin/java` if `java` is not on your
`PATH`. It has not been run against 0.2.0 — see the note at the top of this
README.

`npm test` asserts the committed XML still matches current output, so generator
drift shows up as a test failure rather than a stale file.

## Development

```bash
npm install
npm test      # 783 tests
npm run build
```

## Licence

MIT
