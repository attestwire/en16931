# Third-party notices

The package is MIT licensed — see `LICENSE`. This file records content sourced
from third parties: where it came from, at what exact reference, what was taken,
and whether it ships on npm.

Corrections: <https://github.com/attestwire/en16931/issues>. Entries will be
corrected or the material removed.

---

## 1. CEN / CEF EN 16931 validation artefacts — code lists

**Source** [ConnectingEurope/eInvoicing-EN16931](https://github.com/ConnectingEurope/eInvoicing-EN16931),
ref `validation-1.3.16`: `ubl/schematron/codelist/EN16931-UBL-codes.sch` and
`ubl/schematron/UBL/EN16931-UBL-model.sch` (BR-CL-08 only, which lives in the
model binding because UBL has no element for BT-21). Retrieved 2026-08-10 by
`scripts/build-codelists.mjs`; the ref is in the header of every generated file.

**Upstream licence** EUPL-1.2 (verified 2026-08-16 against `LICENSE.txt` at both
`master` and the pinned ref).

**Taken** Code-list membership data only — the admissible values inside each
BR-CL assertion, held as a `contains(' A B C … ', …)` literal (BR-CL-24: a chain
of `@mimeCode = '…'` tests). 16 code lists, ~4,700 values. No schematron logic,
XPath, assertion text, rule structure or prose; the 295 rules this package
implements are written from the EN 16931 specification with original diagnostics.

**Transformation** The script extracts each literal by regular expression,
splits on whitespace, and emits frozen TypeScript arrays plus `Set` lookups under
original doc comments. The build fails if BR-CL-11/21/26 stop carrying literals
byte-identical to BR-CL-10. Generated files are committed, so no build, test or
install touches the network.

**Files** (`src/codelists/index.ts` is also generated: `export *` lines only, no
third-party content)

```
allowance-reason.ts  ALLOWANCE_REASON_CODES     object-scheme.ts  OBJECT_SCHEME_CODES
charge-reason.ts     CHARGE_REASON_CODES        payment-means.ts  PAYMENT_MEANS_CODES
country.ts           COUNTRY_CODES              tax-point-date.ts VAT_POINT_DATE_CODES
currency.ts          CURRENCY_CODES             unit.ts           UNIT_CODES
eas.ts               EAS_SCHEME_CODES           vat-category.ts   VAT_CATEGORY_CODES
icd.ts               ICD_SCHEME_CODES           vatex.ts          VATEX_CODES
invoice-type.ts      INVOICE_TYPE_CODES, CREDIT_NOTE_TYPE_CODES_CL
item-classification.ts  ITEM_CLASSIFICATION_SCHEME_CODES
mime.ts              MIME_CODES
note-subject.ts      NOTE_SUBJECT_CODES         (from EN16931-UBL-model.sch)
```

**Ships on npm** Yes, compiled to `dist/codelists/*.js` and `.d.ts`. The
extracted content is code-list membership data originating in ISO/UNECE/CEF
registries upstream of the schematron.

---

## 2. OpenPeppol BIS Billing 3.0 schematron — Peppol code lists

**Source** [OpenPEPPOL/peppol-bis-invoice-3](https://github.com/OpenPEPPOL/peppol-bis-invoice-3),
`rules/sch/PEPPOL-EN16931-UBL.sch`, ref `master` — a moving branch, not a pinned
tag. Retrieved 2026-08-10; which upstream release the branch pointed at that day
is not recorded. (`scripts/lib/validator-setup.sh` separately pins `v3.0.20` for
conformance runs.)

**Upstream licence** None found (verified 2026-08-16: no `LICENSE` file at the
repository root; the GitHub licence API returns 404 with `"license": null`).

**Taken** Two membership sets, each the contents of a
`<let name="…" value="tokenize('…', '\s')"/>` parameter, and nothing else:

| Rule | `<let>` | List | Codes |
| --- | --- | --- | --- |
| PEPPOL-EN16931-CL008 | `eaid` | Peppol Participant Identifier Scheme | 94 |
| PEPPOL-EN16931-CL007 | `ISO4217` | ISO 4217 alpha-3, Peppol's own copy | 179 |

Both are carried separately from their CEN counterparts because they differ:
`PEPPOL_EAS_SCHEME_CODES` is narrower than the CEF EAS register BR-CL-25 tests,
and Peppol's ISO 4217 copy has drifted (at the generated ref it still admits
`ANG` and `BGN`, retired by CEN, and lacks `XCG`, which CEN has added).

**Transformation** `scripts/build-peppol.mjs` extracts each `tokenize()` literal
by regular expression and emits frozen arrays plus `Set` lookups, same shape as
entry 1. The build fails if `$eaid` stops being a `tokenize()` list, if
CL001/CL002/CL003/CL006 stop matching the CEN lists, or if the set of
`PEPPOL-EN16931-R*` / `PEPPOL-COMMON-R*` rule ids grows. The generated file is
committed; no network access at build, test or install time.

**Files** `src/codelists/peppol.ts` (`PEPPOL_EAS_SCHEME_CODES`,
`PEPPOL_CURRENCY_CODES`); the script also appends one `export *` line to
`src/codelists/index.ts`.

**Ships on npm** Yes, as `dist/codelists/peppol.js` and `.d.ts`. The upstream
repository carries no license; the extracted content is code-list membership data
originating in ISO/UNECE/Peppol registries.

---

## 3. FeRD ZUGFeRD 2.5.2 sample PDFs — test fixtures, redistributed verbatim

**Source** FeRD, ZUGFeRD 2.5.2 German example package
`ZUGFeRD_2.5.2_DE_examples.zip` (11,966,326 bytes; contents dated 2026-07),
<https://www.ferd-net.de/fileadmin/user_upload/FeRD/Downloads/ZUGFeRD_2.5.2_DE_examples.zip>,
linked from <https://www.ferd-net.de/faqs/zugferd-beispielrechnungen>. Retrieved
2026-08-14. **Upstream licence:** none accompanies the package.

**Taken** Three PDF/A-3 documents, renamed and otherwise byte-for-byte. This is
the only entry where third-party bytes ship unmodified.

| File (in `fixtures/facturx/`) | Path inside the zip | Profile | sha256 |
| --- | --- | --- | --- |
| `facturx-en16931-einfach.pdf` | `3. EN16931/E05_Einfach/E05_01_Einfach_fx.pdf` | EN16931 (`urn:cen.eu:en16931:2017`) | `a0978983423b7261cea82ed4bea1e7b3062c87521692be83ad52ed27caeb6612` |
| `facturx-basic-einfach.pdf` | `2. BASIC/B01_Einfach/B01_01_Einfach_fx.pdf` | BASIC (`urn:factur-x.eu:1p0:basic`) | `3272dd58f4f55f8b5970fe6661c5afcc93398971ee3032559086aa91feb474e7` |
| `facturx-minimum-rechnung.pdf` | `0. MINIMUM/MINIMUM_Rechnung/MINIMUM_Rechnung_fx.pdf` | MINIMUM (`urn:factur-x.eu:1p0:minimum`) | `4d331416500719b338d8f969c8a414c396adce37e21273efdbf59c6a41920712` |

Verify with `shasum -a 256 fixtures/facturx/*.pdf`. Full provenance is in
`fixtures/facturx/README.md` (our prose). `src/facturx-pdf.test.ts` parses the
PDFs at run time and asserts on structure; no extracted content is embedded in
the source. Two cross-reference styles are represented deliberately (classic
xref table, and xref stream with the file specification inside an `/ObjStm`),
because those are two code paths in `facturx-pdf.ts`.

**Ships on npm** Yes — `fixtures/` is in the package's `files` array.
Redistribution permission from FeRD has not been confirmed; pending resolution.

---

## 4. OASIS SARIF 2.1.0 schema and Jenkins xUnit JUnit XSD — dev-time schemas

| File (in `src/test-fixtures/`) | Source | Retrieved | sha256 |
| --- | --- | --- | --- |
| `sarif-schema-2.1.0.json` | <https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/sarif-2.1/schema/sarif-schema-2.1.0.json> | 2026-08-14 | `c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e` |
| `junit-10.xsd` | <https://raw.githubusercontent.com/jenkinsci/xunit-plugin/master/src/main/resources/org/jenkinsci/plugins/xunit/types/model/xsd/junit-10.xsd> | 2026-08-14 | `a1a816f58d1bf95ebabf371994df0b9246dee66ea9572fbec4f9296f1b2c0ff6` |

**Upstream licence** SARIF schema: the normative OASIS SARIF TC publication,
specific terms not verified. `junit-10.xsd`: MIT (notice in file), © 2014
Gregory Boissinot, left verbatim.

**Taken** Both files, unmodified and byte-identical to what was retrieved.
`src/test-fixtures/README.md` is our own provenance prose.

**Ships on npm** No — read only by `src/export.test.ts` at test time, and outside
the package's `files` array.

Note, repeated from `src/test-fixtures/README.md`: there is no official JUnit XML
schema. `junit-10.xsd` is the Jenkins xUnit plugin's model of Ant `junitreport`
output as extended by Maven Surefire, so passing it means that parser model
accepts the document, not that it conforms to a standard.

---

## 5. External conformance oracles

Used at development time only; nothing from them ships. Each is fetched into a
scratch directory at run time; none is present in `src/`, `dist/` or `fixtures/`.

| Tool / artefact | Version pinned in the scripts | Fetched by |
| --- | --- | --- |
| KoSIT validator (`itplr-kosit/validator`) | `1.6.3` | `scripts/lib/validator-setup.sh` |
| KoSIT XRechnung validator configuration | `3.0.2` / `2026-08-31` | `scripts/lib/validator-setup.sh` |
| KoSIT XRechnung validator configuration (D16B XSD modules only) | `3.0.2` / `2026-01-31` | `scripts/dgfip-check.sh` |
| OpenPEPPOL `peppol-bis-invoice-3` (reference schematron) | tag `v3.0.20` | `scripts/lib/validator-setup.sh` |
| OASIS UBL 2.1 OS schemas (`UBL-2.1.zip`) | 2.1 OS | `scripts/lib/validator-setup.sh` |
| Saxon-HE | `12.5` (Maven Central) | `scripts/lib/validator-setup.sh` |
| `org.xmlresolver:xmlresolver` | `5.2.2` (Maven Central) | `scripts/lib/validator-setup.sh` |
| ISO Schematron skeleton (`Schematron/schematron`) | commit `77dcd36c` | `scripts/lib/validator-setup.sh` |
| DGFiP *spécifications externes B2B* (French Flux 1 XSDs) | `v3.2`, published 2026-04-30 | `scripts/dgfip-check.sh` |

Run outcomes are written up in `scripts/kosit-check.md`,
`scripts/peppol-check.md` and `scripts/dgfip-check.md`.

---

## 6. Our own fixtures

`fixtures/*.xml` — the eleven committed XRechnung UBL and CII example documents —
are not third-party content: they are generated by this package from inputs in
`src/fixtures.ts` via `scripts/emit-fixtures.mjs`, and `npm test` asserts the
committed files still match current output. They are MIT along with the rest of
the package.
