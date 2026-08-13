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

**Re-run 2026-08-12**, same validator and configuration, after the 0.4.0
rule-coverage fixes (BR-CO-09 on BT-63, BR-CL-14 on BT-69, and the BR-CO-09
prefix code list). Identical verdict, `Acceptable: 7  Rejected: 0`, so the
table above still holds. That is the expected result: 0.4.0 changes which
inputs `validateInput` rejects and does not change a byte of what the
generators emit, and no committed fixture carries a malformed tax
representative or a made-up VAT prefix.

**Re-run again 2026-08-12**, after the adversarial-review fixes — and this time
the generators *did* change: `formatPrice` replaced `formatAmount` on BT-146,
BT-147 and BT-148, and the VAT rate is normalised before the breakdown is
computed from it. The fixtures were regenerated with `node scripts/emit-fixtures.mjs`
first and came back byte-identical, because none of them carries a price with
more than two decimals or a rate with more than two. Verbatim, from
`JAVA_BIN=/opt/homebrew/opt/openjdk@17/bin/java ./scripts/kosit-check.sh`:

```
Processing of 7 objects started
Processing of 7 objects completed in 266ms
Results:
----------------------------------------------------------------------------------------------------------------
|File                                                        |Schema |Schematron|Acceptance|Error/Description   |
|/private/var/folders/9y/rbfz8qjs0gqgsvtth7xnx_ym0000gp/T/...|   Y   |    Y     |ACCEPTABLE|                    |
|estwire-kosit/in/xrechnung-cii-discount.xml                 |       |          |          |                    |
|/private/var/folders/9y/rbfz8qjs0gqgsvtth7xnx_ym0000gp/T/...|   Y   |    Y     |ACCEPTABLE|                    |
|estwire-kosit/in/xrechnung-cii-extended.xml                 |       |          |          |                    |
|/private/var/folders/9y/rbfz8qjs0gqgsvtth7xnx_ym0000gp/T/...|   Y   |    Y     |ACCEPTABLE|                    |
|estwire-kosit/in/xrechnung-cii-minimal.xml                  |       |          |          |                    |
|/private/var/folders/9y/rbfz8qjs0gqgsvtth7xnx_ym0000gp/T/...|   Y   |    Y     |ACCEPTABLE|                    |
|estwire-kosit/in/xrechnung-cii-reverse-charge.xml           |       |          |          |                    |
|/private/var/folders/9y/rbfz8qjs0gqgsvtth7xnx_ym0000gp/T/...|   Y   |    Y     |ACCEPTABLE|                    |
|estwire-kosit/in/xrechnung-ubl-discount.xml                 |       |          |          |                    |
|/private/var/folders/9y/rbfz8qjs0gqgsvtth7xnx_ym0000gp/T/...|   Y   |    Y     |ACCEPTABLE|                    |
|estwire-kosit/in/xrechnung-ubl-minimal.xml                  |       |          |          |                    |
|/private/var/folders/9y/rbfz8qjs0gqgsvtth7xnx_ym0000gp/T/...|   Y   |    Y     |ACCEPTABLE|                    |
|estwire-kosit/in/xrechnung-ubl-reverse-charge.xml           |       |          |          |                    |
----------------------------------------------------------------------------------------------------------------
Acceptable:  7  Rejected:  0


##############################
#   Validation successful!   #
##############################
```

`grep -c "failed-assert\|successful-report\|rep:message" out/*.xml` returns `0`
for all seven reports, so "no error, warning or information findings" is again a
count and not an impression.

### What the check settled, 2026-08-12 (adversarial review)

Seven fixtures cannot exercise a rule change, so each fix below was probed on
purpose-built documents that are *not* committed — a fixture has to be
acceptable to belong in `fixtures/`, and most of these exist to be rejected.
Every probe was run in **both** syntaxes and the rule ids KoSIT returns were
compared against the ids this build returns for the same input.

#### BR-CO-09: the two syntaxes genuinely disagree

The seller VAT identifier was varied and the invoice regenerated in each syntax.
`ours` is `validateInput` on the same input.

| Probe (BT-31) | Syntax | KoSIT | This build |
| --- | --- | --- | --- |
| `DE123456789` | UBL | ACCEPTABLE `[]` | (none) |
| `DE123456789` | CII | ACCEPTABLE `[]` | (none) |
| `de123456789` | UBL | REJECTED `[BR-CO-09]` | `BR-CO-09 (BT-31)` |
| `de123456789` | CII | REJECTED `[BR-CO-09]` | `BR-CO-09 (BT-31)` |
| `D E123456789` | UBL | ACCEPTABLE `[]` | (none) |
| `D E123456789` | CII | REJECTED `[BR-CO-09]` | `BR-CO-09 (BT-31)` |
| `" DE123456789"` | UBL | ACCEPTABLE `[]` | (none) |
| `" DE123456789"` | CII | REJECTED `[BR-CO-09]` | `BR-CO-09 (BT-31)` |
| `Q 123456789` | UBL | ACCEPTABLE `[]` | (none) |
| `Q 123456789` | CII | REJECTED `[BR-CO-09]` | `BR-CO-09 (BT-31)` |
| `D` | UBL | ACCEPTABLE `[]` | (none) |
| `D` | CII | REJECTED `[BR-CO-09]` | `BR-CO-09 (BT-31)` |
| `"D\tE123456789"` | UBL | REJECTED `[BR-CO-09]` | `BR-CO-09 (BT-31)` |
| `"D\tE123456789"` | CII | REJECTED `[BR-CO-09]` | `BR-CO-09 (BT-31)` |
| `ZZ123456789` | UBL | REJECTED `[BR-CO-09]` | `BR-CO-09 (BT-31)` |
| `ZZ123456789` | CII | REJECTED `[BR-CO-09]` | `BR-CO-09 (BT-31)` |
| `SS123456789` | UBL | ACCEPTABLE `[]` | (none) |
| `SS123456789` | CII | REJECTED `[BR-CO-09]` | `BR-CO-09 (BT-31)` |
| `AN123456789` | UBL | REJECTED `[BR-CO-09]` | `BR-CO-09 (BT-31)` |
| `AN123456789` | CII | ACCEPTABLE `[]` | (none) |
| `" "` | UBL | REJECTED `[PEPPOL-EN16931-R008]` | (none) |
| `" "` | CII | REJECTED `[BR-CO-09, PEPPOL-EN16931-R008]` | `BR-CO-09 (BT-31)` |
| `"  "` | UBL | REJECTED `[BR-CO-09, PEPPOL-EN16931-R008]` | `BR-CO-09 (BT-31)` |
| `"  "` | CII | REJECTED `[BR-CO-09, PEPPOL-EN16931-R008]` | `BR-CO-09 (BT-31)` |
| `""` | UBL | ACCEPTABLE `[]` | (none) |
| `""` | CII | ACCEPTABLE `[]` | (none) |

Twenty-six probes, and this build's BR-CO-09 verdict matches KoSIT's in every
one. Before the fix the first four whitespace rows and both `de…` rows were
wrong, in both directions: `de123456789` was reported valid and is rejected in
both syntaxes, and `Q 123456789` was reported fatal and is accepted in UBL.

Three things make the two syntaxes differ, and none of them is a rounding-off we
get to make:

1. The CII needle is space-wrapped (`concat(' ', substring(.,1,2), ' ')`) and
   the UBL needle is not (`substring(cbc:CompanyID,1,2)`), so in UBL a
   two-character string matches anywhere in the list *including across a token
   boundary*: `"D "` is inside `"AD "`, `" D"` is inside `" DE"`, `"Q "` is
   inside `"AQ "`.
2. Neither test folds case and neither strips whitespace.
3. The two literal lists are not the same list. UBL carries `SS` and not `AN`;
   CII carries `AN` and not `SS`. Both are 252 tokens. Extracted and diffed from
   `EN16931-UBL-validation.xsl` and `EN16931-CII-validation.xsl`; both literals
   are pinned verbatim in `src/rules.test.ts`, which asserts this build agrees
   with the transliterated XPath on every two-character prefix over a character
   set covering list members, near-misses, both cases, digits and whitespace.

The `""` rows are why the rule guards on the empty string rather than on
`blank()`: an empty value emits no `cbc:CompanyID` at all, so the schematron
context never fires, while `" "` does emit one and is judged.

⚠ **A residual, unrelated divergence is visible in this table.**
`PEPPOL-EN16931-R008` ("document MUST NOT contain empty elements") is raised by
KoSIT for the whitespace probes and by nothing here. That is the known
Peppol-rules-inside-the-XRechnung-schematron gap, already recorded below and in
the README; it is not new and it is not BR-CO-09.

#### The other fixes

| Probe | KoSIT | This build |
| --- | --- | --- |
| BT-146 `0.0345` × 10000 — UBL | ACCEPTABLE `[]`, `PriceAmount 0.0345` / `LineExtensionAmount 345.00` | `valid: true`, zero findings |
| BT-146 `0.0345` × 10000 — CII | ACCEPTABLE `[]`, `ChargeAmount 0.0345` / `LineTotalAmount 345.00` | `valid: true`, zero findings |
| BT-119 `16.665` on a base of 100 000 — UBL | ACCEPTABLE `[]`, `Percent 16.67` / `TaxAmount 16670.00` | `valid: true`, zero findings |
| BT-119 `16.665` on a base of 100 000 — CII | ACCEPTABLE `[]`, `RateApplicablePercent 16.67` / `CalculatedAmount 16670.00` | `valid: true`, zero findings |
| Document allowance `{E, 19%}` on an exempt invoice — UBL | ACCEPTABLE `[]`, every `Percent` is `0.00` | `BR-E-05`, `BR-E-06` on the *input* |
| Document allowance `{E, 19%}` on an exempt invoice — CII | ACCEPTABLE `[]`, every `RateApplicablePercent` is `0.00` | `BR-E-05`, `BR-E-06` on the *input* |
| Reverse charge, no seller BT-31/BT-32/BT-63 — UBL | REJECTED `[BR-AE-02, BR-DE-16]` | same two ids |
| Reverse charge, no seller BT-31/BT-32/BT-63 — CII | REJECTED `[BR-AE-02, BR-DE-16]` | same two ids |
| BT-131 `77.77`, BT-116 `55.55`, BT-117 `11.11` — UBL | REJECTED `[BR-CO-10, BR-CO-14, BR-S-08, PEPPOL-EN16931-R120]` | same four ids |
| BT-131 `77.77`, BT-116 `55.55`, BT-117 `11.11` — CII | REJECTED `[BR-CO-10, BR-CO-14, BR-S-08, PEPPOL-EN16931-R120]` | same four ids |

Before these fixes: the two BT-146 rows emitted `0.03` against `345.00` and were
still ACCEPTABLE, which is why the defect was silent; the two BT-119 rows were
REJECTED with `[BR-CO-17, BR-S-09]`; the two BR-AE-02 rows returned `valid: true`
here on the `en16931` and `peppol-bis-3` profiles; and the last two returned
`valid: true` with zero errors.

The allowance rows are the one deliberate mismatch. `validateInput` reports
BR-E-05 and BR-E-06 because the *input* states a 19% rate on an exempt category,
which is wrong. The emitted document normalises it to zero, which is why KoSIT
sees nothing. Both answers are right about different artefacts, and the input
answer is the more useful one to a caller.

Two corrections the validator made to this work, worth recording because reasoning
alone produced the wrong answer twice:

- A first draft gave the new BR-CO-17 check a ±0.02 tolerance. The schematron's
  is `abs(BT-117) - 1 < expected and abs(BT-117) + 1 > expected` — a whole unit
  of currency — and the draft reported a finding on a document KoSIT accepts.
- The existing test asserting that a one-character VAT identifier "can match no
  two-character code" was false for UBL, where the unwrapped `contains` needle
  finds `"D"` inside `"AD"`. KoSIT returns ACCEPTABLE.

### What the check settled, 2026-08-12 (0.4.0)

None of the three 0.4.0 fixes was reasoned into place from the rule text. Each
was put to the validator first, in **both** syntaxes, and the rule ids KoSIT
returned were compared against the ids this build returns for the same input.

| Probe | KoSIT | This build |
| --- | --- | --- |
| Tax representative, BT-63 `123456789` + BT-69 `ZZ` — UBL | REJECT: `BR-CO-09`, `BR-CL-14` | same two, nothing else |
| Tax representative, BT-63 `123456789` + BT-69 `ZZ` — CII | REJECT: `BR-CO-09`, `BR-CL-14` | same two, nothing else |
| Seller BT-31 `ZZ123456789` — UBL | REJECT: `BR-CO-09` | `BR-CO-09` (BT-31), nothing else |
| Seller BT-31 `ZZ123456789` — CII | REJECT: `BR-CO-09` | `BR-CO-09` (BT-31), nothing else |
| Greek seller, BT-31 `EL123456789` + BT-40 `GR` — UBL | ACCEPTABLE, zero findings | `valid: true`, zero findings |
| Greek seller, BT-31 `EL123456789` + BT-40 `GR` — CII | ACCEPTABLE, zero findings | `valid: true`, zero findings |

Before 0.4.0 this build reported **none** of those findings. A caller using a
tax representative, or holding a VAT number with a prefix that is not a real
country, passed here and was refused by the portal.

The last two rows are the ones that had to be checked rather than assumed.
BR-CO-09 admits `EL` and BR-CL-14 does not, so a Greek invoice is correct with
a VAT prefix that is not its country code. Tightening the prefix test against
a code list is exactly the change that could have broken it. It does not.

The two literal lists in `EN16931-UBL-validation.xsl` were also extracted and
compared element by element with `src/codelists/country.ts`: BR-CL-14's is
`COUNTRY_CODES` exactly (251 codes, no difference in either direction), and
BR-CO-09's is that set plus `EL` and nothing else (252).

None of these probes is committed. A fixture has to be *acceptable* to belong
in `fixtures/`, and four of the six exist to be rejected; the check above
validates the fixtures, not the rule set.

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
schematron parity: the engine raises 262 rule ids reachable from caller input
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
