# KoSIT conformance check

Our rule engine is a reimplementation of EN 16931 and the XRechnung CIUS. The
only way to know our *output* agrees with the regulator is to run the
regulator's own tool against it. That is what `scripts/kosit-check.sh` does: it
validates every fixture in `fixtures/` — seven of them today, three UBL and four
CII. It is a conformance check on those documents, not a parity suite over the
rule set.

The CII fixtures matter more than their count suggests. KoSIT's XRechnung 3.0.2
configuration has a scenario of its own for CII (`EN16931 XRechnung (CII)`),
with the D16B XML Schema, the EN 16931 CII schematron and the XRechnung CII
schematron. It is selected by the specification identifier (BT-24) in
`ram:GuidelineSpecifiedDocumentContextParameter`, so a CII document we emit is
judged by the CII rules, not by anything we chose.

## Running it

```bash
npm run build
node scripts/emit-fixtures.mjs
./scripts/kosit-check.sh
```

Requires a JDK 11+. If `java` is not on your `PATH` (common on macOS, where
Homebrew installs keg-only JDKs), point `JAVA_BIN` at one:

```bash
JAVA_BIN=/opt/homebrew/opt/openjdk@17/bin/java ./scripts/kosit-check.sh
```

The script downloads two artefacts into a scratch directory and installs
nothing system-wide:

| Artefact | Version | Source |
| --- | --- | --- |
| KoSIT validator (standalone jar) | 1.6.2 | [itplr-kosit/validator](https://github.com/itplr-kosit/validator/releases) |
| XRechnung validator configuration | 3.0.2 / 2026-01-31 | [itplr-kosit/validator-configuration-xrechnung](https://github.com/itplr-kosit/validator-configuration-xrechnung/releases) |

That configuration bundles the UN/CEFACT D16B (SCRDM CII uncoupled) XML Schema,
the EN 16931 CII schematron (`en16931-cii-1.3.15`) and the XRechnung 3.0.2 CII
schematron (`xrechnung-3.0.2-schematron-2.5.0`).

Reports are written to `<workdir>/out/*-report.xml`.

`npm test` asserts the committed fixtures are still byte-identical to current
output, so the recorded result stands as long as the fixture set and the
generator are unchanged. Re-run the check after any change to `generate.ts`,
`generate-cii.ts`, `totals.ts` or `xml.ts`, **and whenever a fixture is added** —
a rule-set change alone cannot alter the emitted document, but a new fixture is
a document nobody has validated.

⚠ `apps/site` (attestwire.com/llms.txt and the homepage) still scopes this
result to "the three fixtures shipped in the repository". That was true until
2026-08-11 and is now stale — there are seven. The site is outside this
package; whoever updates it should take the count from the table below, which
is the record.

## Last recorded result

Run on 2026-08-11 with validator 1.6.2 and XRechnung configuration 3.0.2
(2026-01-31), against all seven committed fixtures:

| Fixture | Syntax | Scenario matched | XSD | Schematron EN 16931 | Schematron XRechnung CIUS | Acceptance |
| --- | --- | --- | --- | --- | --- | --- |
| `xrechnung-ubl-discount.xml` | UBL 2.1 | EN16931 XRechnung (UBL Invoice) | pass | pass | pass | ACCEPTABLE |
| `xrechnung-ubl-minimal.xml` | UBL 2.1 | EN16931 XRechnung (UBL Invoice) | pass | pass | pass | ACCEPTABLE |
| `xrechnung-ubl-reverse-charge.xml` | UBL 2.1 | EN16931 XRechnung (UBL Invoice) | pass | pass | pass | ACCEPTABLE |
| `xrechnung-cii-discount.xml` | CII D16B | EN16931 XRechnung (CII) | pass | pass | pass | ACCEPTABLE |
| `xrechnung-cii-extended.xml` | CII D16B | EN16931 XRechnung (CII) | pass | pass | pass | ACCEPTABLE |
| `xrechnung-cii-minimal.xml` | CII D16B | EN16931 XRechnung (CII) | pass | pass | pass | ACCEPTABLE |
| `xrechnung-cii-reverse-charge.xml` | CII D16B | EN16931 XRechnung (CII) | pass | pass | pass | ACCEPTABLE |

`Acceptable: 7  Rejected: 0`. The seven report XMLs contain zero
`failed-assert`, zero `successful-report` and zero `rep:message` elements — so
"no error, warning or information findings" is a count, not an impression.

### What the check caught, 2026-08-11 (CII)

The CII generator was **rejected** on its first wide fixture, which is the
entire reason for adding one. Two findings, one of them ours:

- **`CII-SR-461` — "Only one TaxPointDate shall be present."** BT-7 (the tax
  point date) and BT-8 (its date code) are document-level terms with no
  document-level element in CII: the binding hangs them off a VAT breakdown
  group. The generator hung them off *every* group, which is fine on a
  single-rate invoice and rejected on a two-rate one. Fixed by emitting both on
  the first group only. This is the class of defect that never shows up in a
  round-trip test, because the parser reads back exactly what the generator
  wrote — only an external judge catches it.
- **`PEPPOL-EN16931-R040`** — "Allowance/charge amount must equal base amount ×
  percentage/100 if base amount and percentage exists". This one was the
  fixture's own arithmetic, not a generator defect, and it exposed something
  worth writing down: the XRechnung schematron (both the UBL and the CII one)
  includes a handful of `PEPPOL-EN16931-*` rules, while this build gates its
  Peppol rules on `profile: "peppol-bis-3"`. So `R040` does not run for an
  XRechnung input here even though KoSIT runs it. That gap is not new and is not
  CII-specific; it is now known and named.

### What the check caught, earlier (UBL)

This was not green on the first run, which is the point of doing it. The
reverse-charge fixture was **rejected** under `BR-DE-10` and `BR-DE-11`: the
generator emitted a deliver-to address group (BG-15) containing only a country
code. Core EN 16931 accepts that — the EN 16931 schematron step passed — but the
XRechnung CIUS makes deliver-to city (BT-77) and post code (BT-78) mandatory
whenever BG-15 is present at all.

Fixed by modelling `deliverTo` as a full address rather than a bare country
code, and by adding `BR-DE-10` / `BR-DE-11` to the rule set so callers hit a
teaching error before the document ever reaches a validator.

The minimal fixture also drew an information-level `BR-DE-TMP-32` (an invoice
should state a delivery date via BT-72, BG-14, or a line-level period). It was
acceptable without one, but the fixture now sets `deliveryDate` so both
documents come back completely silent.

## Scope of the claim

Passing KoSIT on seven fixtures means our *output* is conformant for the paths
those fixtures exercise. It does **not** mean our *rule engine* has reached
schematron parity: the engine raises 251 rule ids reachable from caller input
(the number the site publishes, harvested by executing the library), but that
is a count of what we implement across EN 16931, the XRechnung CIUS and Peppol
BIS 3 — not a fraction of what the XRechnung schematron asserts, which nothing
in this repo measures. No ratio is quoted here for that reason; the previous
"126 of ~180" predated v0.2.0 and was never re-derived. This script exercises
seven documents, so calling it a parity suite would be wrong either way.

One boundary the table above cannot state for itself: **there is no PDF here.**
Factur-X and ZUGFeRD are this CII XML embedded in a PDF/A-3 container, and this
package emits the XML only. KoSIT judges XML, so a clean run says nothing about
a container we do not build. The `facturx-en16931` profile is also not covered
by this run at all: its specification identifier is `urn:cen.eu:en16931:2017`,
which matches no XRechnung scenario, so a Factur-X-profile document would be
reported as "no scenario matched" rather than validated. Only the four
`xrechnung-cii` fixtures are judged by a CII schematron.

A document our engine accepts can still be rejected by KoSIT. Treat `validateInput` as a fast, teaching-oriented pre-flight and
KoSIT as the authority. Closing that gap is tracked as schematron parity on the
roadmap.
