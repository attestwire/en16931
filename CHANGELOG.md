# Changelog

All notable changes to `@attestwire/en16931`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-08-09

First usable release: JSON in, conformant XRechnung UBL out, with a rule set
that explains itself.

### Added

- **`generateXRechnungUBL(inv, options?)`** — JSON → UBL 2.1 Invoice XML.
  - XRechnung 3.0 `CustomizationID`
    (`urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`)
    and Peppol BIS 3.0 `ProfileID`; both overridable to pin an older CIUS.
  - Children emitted in UBL sequence order, which is part of schema validity.
  - Seller/buyer parties with electronic address (`schemeID`), VAT scheme (BT-31)
    kept separate from national tax registration (BT-32, scheme `FC`), legal
    entity and contact group.
  - Delivery group, payment means (incl. IBAN/BIC), payment terms, per-line VAT
    category, and the full BG-23 VAT breakdown.
  - Hand-rolled XML builder: escaping of `&`, `<`, `>` in text and quotes in
    attributes, plus removal of control characters that cannot be escaped at all.
    Optional elements are omitted rather than emitted empty.
- **`computeTotals(inv)`**, `lineNetAmount`, `round2`, `formatAmount` — document
  arithmetic satisfying BR-CO-10/13/14/15/16/17 and the BR-S-08 family, with
  per-line half-up rounding to 2dp and sums taken over the *rounded* line
  amounts. `round2` avoids both the `Math.round(x * 100) / 100` and the
  `toFixed(2)` binary-representation traps.
- **Rule set expanded from 4 to ~30 rules**, each with the official rule ID, the
  business terms it constrains, a message that explains the reason, a concrete
  fix, an example and a `docsUrl`:
  - Mandatory document fields: `BR-02`, `BR-03`, `BR-05`, `BR-06`, `BR-07`,
    `BR-08`, `BR-09`, `BR-10`, `BR-11`, `BR-16`, `BR-CO-26`.
  - Per-line fields: `BR-21`, `BR-22`, `BR-23`, `BR-25`, `BR-26`, `BR-27`.
  - VAT category consistency: `BR-S-02`, `BR-S-05`, `BR-Z-02`, `BR-Z-05`,
    `BR-E-02`, `BR-E-05`, `BR-E-10`, `BR-AE-05`, `BR-IC-02`, `BR-IC-05`,
    `BR-IC-11`, `BR-IC-12`, `BR-G-02`, `BR-G-05`, `BR-O-02`, `BR-O-05`.
  - Arithmetic against caller-declared totals: `BR-CO-10`, `BR-CO-13`,
    `BR-CO-14`, `BR-CO-15`, `BR-CO-16`, reporting the exact delta.
  - VAT identifier prefixes: `BR-CO-09`, including the Greek `EL` derogation.
  - XRechnung CIUS: `BR-DE-1`, `BR-DE-2`, `BR-DE-3`, `BR-DE-4`, `BR-DE-5`,
    `BR-DE-6`, `BR-DE-7`, `BR-DE-8`, `BR-DE-9`, `BR-DE-10`, `BR-DE-11`,
    `BR-DE-16`, `BR-DE-17`, `BR-DE-27`, `BR-DE-28`.
  - Transport: `BR-61`, `BR-62`, `BR-63`, `PEPPOL-EN16931-R010`,
    `PEPPOL-EN16931-R020`.
- **Model extensions** on `InvoiceInput`: `invoiceTypeCode`, `dueDate`, `note`,
  `orderReference`, `payment` (BG-16), `deliveryDate`, `deliverTo` (BG-15),
  `vatExemptionReasons`, `declaredTotals`. On `Party`: `taxRegistrationId`,
  `legalRegistrationId`, `legalName`, `contact.name`, address `line2` and
  `countrySubdivision`. On `InvoiceLine`: `longDescription`, `baseQuantity`,
  `note`.
- **Fixtures** — `fixtures/xrechnung-ubl-minimal.xml` (domestic, 19% + 7%) and
  `fixtures/xrechnung-ubl-reverse-charge.xml` (DE→NL, category AE), regenerated
  by `scripts/emit-fixtures.mjs` and asserted byte-identical in the test suite.
- **KoSIT parity check** — `scripts/kosit-check.sh` downloads the official
  validator and XRechnung configuration and validates the fixtures; results and
  scope caveats in `scripts/kosit-check.md`.
- **Tests** — 129, up from 5. Rule triggering for every new rule, generator
  structure and ordering, XML escaping against hostile input, and a 300-case
  property test asserting the BR-CO identities hold on random multi-line,
  mixed-rate invoices.

### Fixed

- **`BR-01` was the wrong rule ID for a missing invoice number** and is now
  `BR-02`. `BR-01` requires a *specification identifier* (BT-24), which the
  generator always emits; `BR-02` is the rule that requires an invoice number
  (BT-1).
- **`BR-CO-09` was the wrong rule ID for a missing seller VAT identifier.**
  `BR-CO-09` constrains the ISO 3166-1 country *prefix* on an identifier that is
  present, and is now implemented as such. An absent identifier on a
  standard-rated line is `BR-S-02` (and `BR-DE-16` under the German CIUS).
- **Deliver-to address emitted an incomplete BG-15.** Caught by the KoSIT
  validator: a delivery group containing only a country code passes core
  EN 16931 and is rejected by XRechnung under `BR-DE-10` / `BR-DE-11`. `deliverTo`
  is now a full address, and both rules are enforced up front.

### Changed

- `validateInput` reports every finding rather than stopping at the first, and
  splits advisory rules into `warnings` so they never block a build.
- Test files are excluded from `dist`.

[0.1.0]: https://github.com/attestwire/en16931/releases/tag/v0.1.0
