# KoSIT conformance check

Our rule engine is a reimplementation of EN 16931 and the XRechnung CIUS. The
only way to know our *output* agrees with the regulator is to run the
regulator's own tool against it. That is what `scripts/kosit-check.sh` does: it
validates every fixture in `fixtures/` — three of them today. It is a
conformance check on those documents, not a parity suite over the rule set.

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

Reports are written to `<workdir>/out/*-report.xml`.

`npm test` asserts the committed fixtures are still byte-identical to current
output, so the recorded result stands as long as the fixture set and the
generator are unchanged. Re-run the check after any change to `generate.ts`,
`totals.ts` or `xml.ts`, **and whenever a fixture is added** — a rule-set change
alone cannot alter the emitted document, but a new fixture is a document nobody
has validated. attestwire.com/llms.txt states this result and scopes it to
"the three fixtures shipped in the repository"; that sentence is only true
while the record below matches `fixtures/`.

## Last recorded result

Run on 2026-08-11 with validator 1.6.2 and XRechnung configuration 3.0.2
(2026-01-31), against all three committed fixtures:

| Fixture | XSD (UBL 2.1) | Schematron EN 16931 | Schematron XRechnung CIUS | Acceptance |
| --- | --- | --- | --- | --- |
| `xrechnung-ubl-discount.xml` | pass | pass | pass | ACCEPTABLE |
| `xrechnung-ubl-minimal.xml` | pass | pass | pass | ACCEPTABLE |
| `xrechnung-ubl-reverse-charge.xml` | pass | pass | pass | ACCEPTABLE |

`Acceptable: 3  Rejected: 0`. The three report XMLs contain zero
`failed-assert`, zero `successful-report` and zero `rep:message` elements — so
"no error, warning or information findings" is a count, not an impression.

### What the check caught

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

Passing KoSIT on three fixtures means our *output* is conformant for the paths
those fixtures exercise. It does **not** mean our *rule engine* has reached
schematron parity: the engine raises 251 rule ids reachable from caller input
(the number the site publishes, harvested by executing the library), but that
is a count of what we implement across EN 16931, the XRechnung CIUS and Peppol
BIS 3 — not a fraction of what the XRechnung schematron asserts, which nothing
in this repo measures. No ratio is quoted here for that reason; the previous
"126 of ~180" predated v0.2.0 and was never re-derived. This script exercises
three documents, so calling it a parity suite would be wrong either way. A
document our engine accepts can still be rejected
by KoSIT. Treat `validateInput` as a fast, teaching-oriented pre-flight and
KoSIT as the authority. Closing that gap is tracked as schematron parity on the
roadmap.
