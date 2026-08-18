# Third-party notices

Every third-party source that contributed content to this package, with the
exact reference it was taken from, what was taken, and how it was transformed.

The package itself is MIT — see `LICENSE` — and nothing in this file changes
that. This is a record, not a second licence. It exists because "MIT" answers
the question about the code we wrote and says nothing about the code lists,
sample documents and schemas that came from elsewhere, and a reader doing
diligence on this package deserves the second answer as well as the first.

Where a licensing position is stated it is the maintainer's position, arrived
at by reading the artefacts. It is not a legal opinion, no lawyer has reviewed
it, and each entry says where it is weakest rather than only where it is
strong. Two entries carry unresolved residual risk and say so.

---

## 1. CEN / CEF EN 16931 validation artefacts — code lists

**Source**
[ConnectingEurope/eInvoicing-EN16931](https://github.com/ConnectingEurope/eInvoicing-EN16931),
pinned ref **`validation-1.3.16`**. Two files:

- `ubl/schematron/codelist/EN16931-UBL-codes.sch`
- `ubl/schematron/UBL/EN16931-UBL-model.sch` (BR-CL-08 only — see below)

Generated on 2026-08-10 by `scripts/build-codelists.mjs`; the ref is recorded in
the header of every generated file.

**Upstream licence**
European Union Public Licence v1.2 (EUPL-1.2). Verified 2026-08-16 by fetching
`LICENSE.txt` at both `master` and the pinned `validation-1.3.16` ref; both are
the EUPL-1.2 text under the heading "Licensed under European Union Public
Licence (EUPL) version 1.2."

**What was taken**
Code-list *membership data* only — the set of admissible code values carried
inside each BR-CL assertion. In the schematron these appear as a
`contains(' A B C … ', …)` string literal (or, for BR-CL-24, as a chain of
`@mimeCode = '…'` equality tests). The values are:

| Rule | List | Codes |
| --- | --- | --- |
| BR-CL-01 | UNTDID 1001, invoice subset | 50 |
| BR-CL-01 | UNTDID 1001, credit-note subset | 13 |
| BR-CL-04 | ISO 4217 alpha-3 | 178 |
| BR-CL-06 | UNTDID 2005, EN 16931 restriction | 3 |
| BR-CL-07 | UNTDID 1153, EN 16931 restriction | 818 |
| BR-CL-08 | UNCL 4451 | 383 |
| BR-CL-10 | ISO 6523 ICD | 243 |
| BR-CL-13 | UNTDID 7143 | 185 |
| BR-CL-14 | ISO 3166-1 alpha-2 | 251 |
| BR-CL-16 | UNTDID 4461 | 84 |
| BR-CL-17 | UNTDID 5305, EN 16931 subset | 10 |
| BR-CL-19 | UNCL 5189 | 19 |
| BR-CL-20 | UNCL 7161 | 178 |
| BR-CL-22 | CEF VATEX | 88 |
| BR-CL-23 | UN/ECE Rec 20 + Rec 21 extension | 2162 |
| BR-CL-24 | MIMEMediaType, EN 16931 restriction | 6 |
| BR-CL-25 | CEF Electronic Address Scheme | 104 |

**What was not taken.** No schematron logic, no XPath, no assertion text, no
rule structure, no `<pattern>`/`<rule>`/`<let>` arrangement, no documentation
prose. The 295 rules this package implements are written from the EN 16931
specification and the rules' own published semantics; their diagnostic messages
are original prose. The schematron was read to find where the code values live,
not to be transcribed.

**How it was transformed**
`scripts/build-codelists.mjs` fetches the two `.sch` files over HTTPS, locates
each assertion by its `id`, extracts the literal with a regular expression,
splits it on whitespace, and emits each list as a frozen TypeScript array plus a
`Set` for membership lookup, wrapped at 74 columns, under an original doc
comment. The generator also asserts an upstream invariant it refuses to absorb
silently: BR-CL-11, BR-CL-21 and BR-CL-26 must carry a literal byte-identical to
BR-CL-10, or the build stops rather than shipping one `ICD_SCHEME_CODES` export
that has quietly stopped being true of all four rules.

The generated files are committed, so an ordinary build, test or install never
touches the network.

**Resulting files**

From `EN16931-UBL-codes.sch`:

```
src/codelists/allowance-reason.ts        ALLOWANCE_REASON_CODES
src/codelists/charge-reason.ts           CHARGE_REASON_CODES
src/codelists/country.ts                 COUNTRY_CODES
src/codelists/currency.ts                CURRENCY_CODES
src/codelists/eas.ts                     EAS_SCHEME_CODES
src/codelists/icd.ts                     ICD_SCHEME_CODES
src/codelists/invoice-type.ts            INVOICE_TYPE_CODES, CREDIT_NOTE_TYPE_CODES_CL
src/codelists/item-classification.ts     ITEM_CLASSIFICATION_SCHEME_CODES
src/codelists/mime.ts                    MIME_CODES
src/codelists/object-scheme.ts           OBJECT_SCHEME_CODES
src/codelists/payment-means.ts           PAYMENT_MEANS_CODES
src/codelists/tax-point-date.ts          VAT_POINT_DATE_CODES
src/codelists/unit.ts                    UNIT_CODES
src/codelists/vat-category.ts            VAT_CATEGORY_CODES
src/codelists/vatex.ts                   VATEX_CODES
```

From `EN16931-UBL-model.sch`:

```
src/codelists/note-subject.ts            NOTE_SUBJECT_CODES
```

BR-CL-08 lives in the model binding rather than the code-list file because UBL
has no element for BT-21: the binding writes the code into `cbc:Note` as
`#CODE#text`, so the membership test lands in the model binding instead.

`src/codelists/index.ts` is also generated, but it is a barrel of `export *`
lines and contains no third-party content.

Each of these compiles into the corresponding `dist/codelists/*.js` and `.d.ts`,
which is what ships on npm.

**Licensing position**
The material taken is code-list membership data, and that data does not
originate with CEN or CEF. ISO 4217 currency codes, ISO 3166-1 country codes,
ISO 6523 ICD entries, the UNTDID/UNECE code lists (1001, 1153, 2005, 4461,
5305, 7143, UNCL 5189, UNCL 7161, UNCL 4451) and UN/ECE Recommendation 20/21
unit codes are all maintained in registries upstream of the schematron. The
schematron is a *carrier* of those pre-existing facts, chosen because it is the
same artefact the KoSIT validator evaluates — so a BR-CL finding from this
library and one from KoSIT are drawn from one source of truth rather than from
two independent retypings that can drift.

Our position is therefore that what was copied is facts rather than the
schematron's expression of them: the selection is dictated by the standard, the
arrangement in our output (alphabetical-by-nothing, wrapped at 74 columns,
frozen arrays) is not the arrangement upstream, and none of the schematron's
own creative content — its logic, its assertion prose, its structure — is
present in this package. On that reading the EUPL's copyleft is not engaged,
because no EUPL-covered work of authorship is being distributed or derived
from.

Where this is weakest, stated plainly:

- The analysis is stronger under US law, where facts are not copyrightable and
  *Feist* forecloses a "sweat of the brow" claim, than in the EU. EU law adds a
  *sui generis* database right (Directive 96/9/EC) that can be infringed by the
  extraction of a **substantial part** of a protected database, irrespective of
  originality. Several of these lists are large — 2162 unit codes, 818 object
  scheme codes — and "we took the whole list" is exactly the shape of an
  extraction the doctrine contemplates. The counter-argument is that the
  database whose contents these are is the ISO/UNECE registry, not the
  schematron, and that CEN/CEF are themselves extractors rather than makers —
  but that is an argument, not a settled answer.
- EUPL-1.2 is a strong copyleft with an unusually broad conception of
  derivative work, and it defers the question of what counts as one to the law
  of the member state at Article 15. That is a less predictable boundary than,
  say, the GPL's.
- No lawyer has reviewed this.

**Planned hardening.** Re-source each list directly from its original
publication — the ISO 4217 and ISO 3166 registries, the UNECE code list
distributions, the genericode files published alongside the EN 16931 artefacts —
so the provenance chain no longer runs through an EUPL-licensed carrier at all.
That removes the question rather than answering it. Until it is done, this
entry is the honest description of where the bytes came from.

---

## 2. OpenPeppol BIS Billing 3.0 schematron — Peppol code lists

**Source**
[OpenPEPPOL/peppol-bis-invoice-3](https://github.com/OpenPEPPOL/peppol-bis-invoice-3),
file `rules/sch/PEPPOL-EN16931-UBL.sch`.

Ref: **`master`** — a moving branch, not a pinned tag. This is a known weakness
of this entry relative to entry 1. The generated file records `master` and an
emission date of **2026-08-10**; which upstream release the branch pointed at on
that date is **not recorded and is unverified**. (For reference, the branch head
read on 2026-08-16 declares "Last update: 2025 November release 3.0.20", but
that is today's head, not necessarily the head on 2026-08-10.) Separately,
`scripts/lib/validator-setup.sh` pins `v3.0.20` for the conformance runs.

**Upstream licence**
**None found.** Verified 2026-08-16: the repository has no `LICENSE` or
`LICENSE.md` file at its root, and the GitHub licence API returns 404 with
`"license": null`. OpenPeppol's published BIS pages carry a restrictive
copyright notice. The schematron's own header states that it "uses business
terms defined the CEN/EN16931-1 and is reproduced with permission from CEN" —
that is a permission granted to OpenPeppol, and it says nothing about
downstream reuse by us.

So there is no grant to rely on here, express or implied. That is why this is
the highest-residual-risk entry in this file.

**What was taken**
Two code-list membership sets, each the contents of a `<let name="…"
value="tokenize('…', '\s')"/>` parameter:

| Rule | `<let>` | List | Codes |
| --- | --- | --- | --- |
| PEPPOL-EN16931-CL008 | `eaid` | Peppol Participant Identifier Scheme (electronic address schemes) | 94 |
| PEPPOL-EN16931-CL007 | `ISO4217` | ISO 4217 alpha-3, Peppol's own copy | 179 |

Nothing else. No rule logic, no XPath, no assertion text, no rule structure.
The `PEPPOL-EN16931-R*` and `PEPPOL-COMMON-R*` rules this package implements are
written from the published rule semantics, with original diagnostics.

Both lists are carried separately from their CEN counterparts because they are
not the same lists. `PEPPOL_EAS_SCHEME_CODES` is the set of schemes an access
point will actually route on, which is narrower than the CEF EAS register that
BR-CL-25 tests; and Peppol's ISO 4217 copy has measurably drifted from the CEN
one (as of the generated ref, Peppol still admits `ANG` and `BGN` that the CEN
list has retired, and does not yet admit `XCG` that the CEN list has added).
Validating a Peppol document against the CEN list alone is how a legal invoice
gets bounced at the network edge.

**How it was transformed**
`scripts/build-peppol.mjs` fetches the schematron, extracts each `tokenize()`
literal by regular expression, splits on whitespace, and emits frozen
TypeScript arrays plus `Set` lookups under original doc comments — the same
shape as entry 1. The script additionally verifies, and fails the build on,
three upstream invariants: that the `$eaid` parameter is still a `tokenize()`
list; that the four Peppol code-list rules this package deliberately does *not*
re-implement (CL001, CL002, CL003, CL006) still carry literals identical to the
CEN lists already generated; and that the set of `PEPPOL-EN16931-R*` /
`PEPPOL-COMMON-R*` rule ids has not grown since the rule family was written.
Those checks read upstream and compare; they copy nothing.

The generated file is committed, so an ordinary build, test or install never
touches the network.

**Resulting files**

```
src/codelists/peppol.ts                  PEPPOL_EAS_SCHEME_CODES, PEPPOL_CURRENCY_CODES
```

compiled to `dist/codelists/peppol.js` and `.d.ts`. (`scripts/build-peppol.mjs`
also appends one `export *` line to the generated `src/codelists/index.ts`
barrel. The script's own header comment names its output `peppol-eas.ts`; the
file it actually writes is `peppol.ts`.)

**Licensing position**
The same facts-versus-expression reasoning as entry 1, and the same admission
that it is a position rather than a settled answer. The EAS list tracks ISO 6523
ICD registrations and the participant-identifier scheme code list Peppol
publishes in its own right; the currency list is ISO 4217. In both cases the
values originate in registries upstream of the schematron, the schematron is
the carrier we happened to read them from, and no expressive content of the
schematron is reproduced.

The residual risk is higher here than anywhere else in this file, for reasons
that have nothing to do with the strength of the facts argument:

- There is **no licence at all**, so there is no permissive grant to fall back
  on if the facts argument fails. Entry 1 at least has a grant, even an
  awkwardly copyleft one.
- The ref is a moving branch, so the provenance is less precisely reproducible
  than it should be.
- The 94-code EAS list is a curated set — Peppol decides which registers to
  onboard — which makes the "selection is dictated by the standard" half of the
  facts argument weaker than it is for, say, ISO 4217.

**Planned hardening**, in order of preference: source both lists from Peppol's
separately published code-list distributions (which carry their own terms —
those terms would then govern, and would need reading before use); or obtain
written permission from OpenPeppol to extract the membership data; or pin a
release tag as an interim improvement to reproducibility. Until one of these is
done, this entry is the one to look at first.

---

## 3. FeRD ZUGFeRD 2.5.2 sample PDFs — test fixtures, redistributed verbatim

**Source**
FeRD (Forum elektronische Rechnung Deutschland), ZUGFeRD 2.5.2 German example
package.

- Package: `ZUGFeRD_2.5.2_DE_examples.zip` (11,966,326 bytes; contents dated 2026-07)
- URL: <https://www.ferd-net.de/fileadmin/user_upload/FeRD/Downloads/ZUGFeRD_2.5.2_DE_examples.zip>
- Linked from: <https://www.ferd-net.de/faqs/zugferd-beispielrechnungen>
- Retrieved: **2026-08-14**

**Upstream licence**
No licence accompanies the example package, and no redistribution permission
has been obtained. See the licensing position below.

**What was taken**
Three PDF/A-3 documents, extracted from that one zip and **redistributed
byte-for-byte**. This is the only entry in this file where third-party bytes
ship unmodified.

| File | Path inside the zip | Profile | sha256 |
| --- | --- | --- | --- |
| `facturx-en16931-einfach.pdf` | `3. EN16931/E05_Einfach/E05_01_Einfach_fx.pdf` | EN16931 (`urn:cen.eu:en16931:2017`) | `a0978983423b7261cea82ed4bea1e7b3062c87521692be83ad52ed27caeb6612` |
| `facturx-basic-einfach.pdf` | `2. BASIC/B01_Einfach/B01_01_Einfach_fx.pdf` | BASIC (`urn:factur-x.eu:1p0:basic`) | `3272dd58f4f55f8b5970fe6661c5afcc93398971ee3032559086aa91feb474e7` |
| `facturx-minimum-rechnung.pdf` | `0. MINIMUM/MINIMUM_Rechnung/MINIMUM_Rechnung_fx.pdf` | MINIMUM (`urn:factur-x.eu:1p0:minimum`) | `4d331416500719b338d8f969c8a414c396adce37e21273efdbf59c6a41920712` |

**How it was transformed**
Renamed, and nothing else. The bytes are unchanged — the sha256s above are
verifiable with `shasum -a 256 fixtures/facturx/*.pdf`. Full provenance,
including why these three and why not the French FNFE-MPE package, is in
`fixtures/facturx/README.md`.

**Resulting files**

```
fixtures/facturx/facturx-en16931-einfach.pdf
fixtures/facturx/facturx-basic-einfach.pdf
fixtures/facturx/facturx-minimum-rechnung.pdf
fixtures/facturx/README.md          (our prose; provenance record)
```

`fixtures/` is in the package's `files` array, so these three PDFs **are
published to npm**.

They exist because `src/facturx-pdf.test.ts` needs documents this package did
not produce. A hand-built PDF tests the parser against its author's
understanding of the format; these test it against what a conformant producer
actually emits. Two different cross-reference styles are represented on purpose
(classic xref table, and xref stream with the file specification compressed
inside an `/ObjStm`), because those are two different code paths in
`facturx-pdf.ts`. No content extracted from these PDFs is embedded anywhere in
the source: the tests parse them at run time and assert on structure.

**Licensing position**
**Unresolved, and being resolved.** FeRD publishes these files as public
examples for implementers and they are downloadable without registration or
click-through terms, which is why they were used — but "published for
implementers to download" is not the same as "licensed for redistribution
inside a third party's npm package", and no permission has been confirmed. We
are not claiming one.

The mitigating facts, offered as context and not as a substitute for
permission: the files are unmodified and attributed, the package is free, the
use is as test material for tooling that implements FeRD's own standard, and
the redistribution is plausibly to FeRD's benefit rather than in competition
with anything they sell.

The resolution is one of two things: confirmation of FeRD's terms permitting
redistribution (which would be recorded here), or replacement of the committed
PDFs with a fetch-on-demand step so the test downloads them from FeRD at run
time and nothing third-party ships. Whichever lands, this entry gets rewritten.

---

## 4. OASIS SARIF 2.1.0 schema and Jenkins xUnit JUnit XSD — dev-time test schemas

**Source and retrieval**

| File | Source | Retrieved | sha256 |
| --- | --- | --- | --- |
| `sarif-schema-2.1.0.json` | <https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/sarif-2.1/schema/sarif-schema-2.1.0.json> | 2026-08-14 | `c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e` |
| `junit-10.xsd` | <https://raw.githubusercontent.com/jenkinsci/xunit-plugin/master/src/main/resources/org/jenkinsci/plugins/xunit/types/model/xsd/junit-10.xsd> | 2026-08-14 | `a1a816f58d1bf95ebabf371994df0b9246dee66ea9572fbec4f9296f1b2c0ff6` |

**Upstream licence**

- `sarif-schema-2.1.0.json` — the normative SARIF 2.1.0 schema published by the
  OASIS SARIF TC (schema `id`:
  `https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json`).
  OASIS publishes its standards for implementation under its IPR policy; the
  specific licence terms attaching to this file were **not verified** as part of
  writing this notice.
- `junit-10.xsd` — **MIT**, © 2014 Gregory Boissinot. The licence text is inside
  the file and is left there verbatim.

**What was taken**
Both files, unmodified.

**How it was transformed**
Not at all. Both are byte-identical to what was retrieved.

**Resulting files**

```
src/test-fixtures/sarif-schema-2.1.0.json
src/test-fixtures/junit-10.xsd
src/test-fixtures/README.md          (our prose; provenance record)
```

**Neither file ships.** The package's `files` array publishes `dist`,
`fixtures`, `README.md`, `CHANGELOG.md` and `LICENSE`; these live under
`src/test-fixtures/`, are read only by `src/export.test.ts` at test time, and
are never imported by anything under `dist/`. They are checked in so the export
tests validate `toSarif()` and `toJunitXml()` output against the *published*
artefacts rather than against our reading of them.

One caveat worth repeating from `src/test-fixtures/README.md`: there is no
official JUnit XML schema and `junit-10.xsd` is not one. JUnit never specified
the format; what CI systems consume is Ant's `junitreport` output as extended by
Maven Surefire, and this XSD is the Jenkins xUnit plugin's model of that.
Passing it means "Jenkins' own parser model accepts this", not "conforms to a
standard", because there is none.

**Licensing position**
`junit-10.xsd` is MIT, the copyright and licence notice travels inside the file
as MIT requires, and it is not redistributed in the published package in any
case. For the SARIF schema the terms were not verified; the exposure is small
because the file is not redistributed either — but "not verified" is the honest
state, and confirming OASIS's terms is a small outstanding task rather than a
resolved one.

---

## 5. External conformance oracles — considered, nothing shipped

Several third-party validators and specification packages are used at
development time to check this package's output against the authorities that
actually judge it. **No code, schema, schematron, stylesheet or content from any
of them is present in this package**, in `src/`, in `dist/`, or in `fixtures/`.
Every one is downloaded into a scratch directory at run time by a script, used,
and left there; nothing is installed system-wide and nothing is committed.

They are recorded here so a reader can see they were considered rather than
missed.

| Tool / artefact | Version pinned in the scripts | Fetched by |
| --- | --- | --- |
| KoSIT validator (`itplr-kosit/validator`) | `1.6.2` | `scripts/lib/validator-setup.sh` |
| KoSIT XRechnung validator configuration | `3.0.2` / `2026-01-31` | `scripts/lib/validator-setup.sh`, `scripts/dgfip-check.sh` |
| OpenPEPPOL `peppol-bis-invoice-3` (reference schematron, for the Peppol run) | tag `v3.0.20` | `scripts/lib/validator-setup.sh` |
| OASIS UBL 2.1 OS schemas (`UBL-2.1.zip`) | 2.1 OS | `scripts/lib/validator-setup.sh` |
| Saxon-HE | `12.5` (Maven Central) | `scripts/lib/validator-setup.sh` |
| `org.xmlresolver:xmlresolver` | `5.2.2` (Maven Central) | `scripts/lib/validator-setup.sh` |
| ISO Schematron skeleton (`Schematron/schematron`) | commit `77dcd36c` | `scripts/lib/validator-setup.sh` |
| DGFiP *spécifications externes B2B* (French Flux 1 XSDs) | `v3.2`, published 2026-04-30 | `scripts/dgfip-check.sh` |

The recorded outcomes of those runs live in `scripts/kosit-check.md`,
`scripts/peppol-check.md` and `scripts/dgfip-check.md`. Those are our own
write-ups; where they quote a validator verdict they quote it as evidence, in
the amount needed to make the record checkable.

Two by-products of oracle runs are worth naming explicitly, because both are
*facts learned* rather than content copied:

- `src/cii-tax-point-code.ts` carries a note that a particular code is accepted
  by KoSIT, discovered via the KoSIT test suite file
  `kosit-testsuite/cius/01.02_comprehensive_test_uncefact.xml`. The finding is
  ours; none of that file's content is reproduced.
- `src/fixtures-gln.test.ts` exists because OpenPeppol's artefacts surfaced
  three invalid GLN check digits in our own fixtures that eleven clean KoSIT
  runs could not see. The fix and the test are ours.

---

## 6. Our own fixtures

`fixtures/*.xml` — the eleven committed XRechnung UBL and CII example documents —
are **not** third-party content. They are generated by this package from inputs
in `src/fixtures.ts` via `scripts/emit-fixtures.mjs`, and `npm test` asserts
that the committed files still match what the current code emits, so drift
shows up as a test failure rather than a stale file. They are MIT along with the
rest of the package.

They are named for the standards they target and carry standard-defined
namespace URIs, customization identifiers and code values, which is what any
conformant document of that kind must carry; that does not make them derived
from anyone else's document.

---

## Corrections

If you believe anything in this file is wrong — a licence misread, a permission
we do not in fact have, an attribution missing, or an extraction that should not
have been made — please open an issue at
<https://github.com/attestwire/en16931/issues>. Provenance mistakes are worth
more to us than most bug reports, and an entry here will be corrected or the
material removed.
