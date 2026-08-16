# Peppol BIS Billing 3.0 conformance check

`scripts/kosit-check.sh` puts our XRechnung output to the German regulator's own
tool. This does the same for Peppol. It matters because the package has
advertised a `peppol-bis-3` profile since 0.3.0, the CHANGELOG has said "Not
verified" about it ever since, and `scripts/kosit-check.md:440` recorded that
the Peppol rules in this build had never been run against a Peppol artefact at
all. Until this script, the only external check on any Peppol claim here was
that a handful of `PEPPOL-EN16931-*` rules happen to be embedded in the
XRechnung schematron and were seen firing there.

Scope: five documents, UBL only. This is a conformance check on those
documents, not a schematron parity suite.

## Running it

```bash
npm run build
JAVA_BIN=/opt/homebrew/opt/openjdk@17/bin/java ./scripts/peppol-check.sh
```

Requires a JDK 11+, `xmllint` and `python3`. Everything is downloaded into a
scratch directory; nothing is installed system-wide.

| Artefact | Version | Source |
| --- | --- | --- |
| Peppol BIS Billing 3.0 validation rules (`CEN-EN16931-UBL.sch`, `PEPPOL-EN16931-UBL.sch`) | `v3.0.20` — 2025 November release | [OpenPEPPOL/peppol-bis-invoice-3](https://github.com/OpenPEPPOL/peppol-bis-invoice-3/releases/tag/v3.0.20) (the repository behind [docs.peppol.eu/poacc/billing/3.0/](https://docs.peppol.eu/poacc/billing/3.0/)) |
| UBL 2.1 XML Schema | 2.1 OS, 2013-11-04 | [docs.oasis-open.org/ubl/os-UBL-2.1/UBL-2.1.zip](https://docs.oasis-open.org/ubl/os-UBL-2.1/UBL-2.1.zip) |
| Saxon-HE | 12.5 | Maven Central `net.sf.saxon:Saxon-HE` |
| ISO Schematron reference implementation | commit `77dcd36c53d12ed786c144ece3b2af7694abdc56` (2020-11-01) | [Schematron/schematron](https://github.com/Schematron/schematron), `trunk/schematron/code` |
| JDK | Temurin/Homebrew OpenJDK 17.0.18+0 | `/opt/homebrew/opt/openjdk@17` |
| libxml2 `xmllint` | 20913 | macOS system |

SHA-256 of the downloads, as fetched on 2026-08-14:

```
54b9ada9b866338c629789d30593162f90f1d76654d978266244932aabe02802  peppol-v3.0.20.tar.gz
60b80d76394a8a2add90723ecb8e0e2e9d826775de9749df37a72d60703f86ed  UBL-2.1.zip
98c3a91e6e5aaf9b3e2b37601e04b214a6e67098493cdd8232fcb705fddcb674  Saxon-HE-12.5.jar
0588d617924a0686255f6d182633d434c7986d561be8fcc3b363907d3f671b26  iso_svrl_for_xslt2.xsl
95f3195d9f437ea8ff5f75d1a27f4e68ae20b236fe0d4a217bb4209f498a10a3  iso_schematron_skeleton_for_saxon.xsl
43ff20a1afd89d8a744d1c0b8df94ac5559ffa6a820d1ffbf508d6431ee4fdd9  iso_dsdl_include.xsl
c5267f124abf23eeb6669884e40a98607c055bfaa1f39e73b7d578feceeb6e46  iso_abstract_expand.xsl
```

**One thing to be clear about, because it is the weakest link in this record.**
OpenPEPPOL publishes the rules as Schematron source, not as compiled XSLT — the
repository's own `build.sh` compiles them inside a Docker image we are not
running. So the *rules* are official and the *compiler* is not OpenPEPPOL's; it
is the ISO Schematron reference implementation, pinned above. The results below
are what those rules assert when compiled by that skeleton and run by Saxon
12.5. A different Schematron engine could in principle differ, and if a verdict
here is ever disputed the compiler is the first thing to check.

### Nothing is committed

The five documents are generated at check time by
`scripts/emit-peppol-fixtures.mjs` and are **not** in `fixtures/`. A fixture in
that directory has to be acceptable to the authority that judges it, and two of
these five are not. They are the five committed UBL fixture *inputs* with
`profile` switched to `peppol-bis-3` and nothing else changed — deliberately, so
that the question answered is what Peppol says about the documents this library
already emits, rather than what it says about documents written to pass.

## Last recorded result

Run on **2026-08-14** against Peppol BIS Billing 3.0.20, from a clean scratch
directory.

| Document | Root | UBL 2.1 XSD | `CEN-EN16931-UBL` | `PEPPOL-EN16931-UBL` | Verdict | This build says |
| --- | --- | --- | --- | --- | --- | --- |
| `peppol-ubl-minimal` | `ubl:Invoice` | pass | pass (71 rules fired) | pass (45 fired) | **ACCEPTED** | `valid: true`, no findings |
| `peppol-ubl-reverse-charge` | `ubl:Invoice` | pass | pass (66) | pass (33) | **ACCEPTED** | `valid: true`, no findings |
| `peppol-ubl-credit-note` | `ubl:CreditNote` | pass | pass (73) | pass (46) | **ACCEPTED** | ✗ `valid: false`, `PEPPOL-EN16931-P0100` |
| `peppol-ubl-discount` | `ubl:Invoice` | pass | pass (128) | **fail** `PEPPOL-COMMON-R040` | **REJECTED** | `valid: false`, `PEPPOL-COMMON-R040` |
| `peppol-ubl-credit-note-discount` | `ubl:CreditNote` | pass | pass (123) | **fail** `PEPPOL-COMMON-R040` | **REJECTED** | `valid: false`, `PEPPOL-COMMON-R040` + ✗ `P0100` |

**Accepted: 3  Rejected: 2**, two distinct findings in total, both
`PEPPOL-COMMON-R040`, both fatal.

The "rules fired" counts are in the table on purpose. A schematron that finds
nothing and a schematron that never ran produce the same empty report, and
"pass" is worth nothing without evidence the artefact was exercised. The CEN
schematron fired between 66 and 128 rules per document and returned zero
findings; the Peppol one fired between 33 and 86.

## What the check settled

### 1. `PEPPOL-COMMON-R040` — a real defect, in fixture data, that KoSIT cannot see

`discountedXRechnung` states the buyer's BT-46 as `4098765000004` under scheme
`0088`, which is the GS1 Global Location Number. A GLN carries a mod-10 check
digit in its last position, and this one does not close:

```
4098765000004  weighted sum of the first twelve digits = 67  →  check digit 3, not 4
```

Both the official schematron and this build report it, and they agree on which
two documents carry it. The probe that settles it is the corrected value: with
`4098765000003` substituted, both documents come back with **zero findings from
both schematrons**, so `R040` is the only thing standing between them and
acceptance.

The value is not an artefact of the Peppol run. It is byte-for-byte the same
identifier in the committed `fixtures/xrechnung-ubl-discount.xml`, which KoSIT
has recorded as ACCEPTABLE three times. `PEPPOL-COMMON-R040` is one of the
Peppol rules the XRechnung schematron does *not* carry, so eleven clean KoSIT
runs never had an opportunity to catch it. Three of the four GLNs in the fixture
set are invalid:

| GLN in fixtures | Check digit expected | Stated | |
| --- | --- | --- | --- |
| `4012345000009` | 9 | 9 | valid |
| `4098765000004` | 3 | 4 | **invalid** |
| `4098765000011` | 0 | 1 | **invalid** |
| `4011111000005` | 7 | 5 | **invalid** |

This is fixture *data*, not a generator defect: the generator copies BT-46
through, and it is the example value that is wrong. Fixing it is out of scope
for this run and belongs to whoever owns `src/fixtures.ts`.

### 2. `PEPPOL-EN16931-P0100` — this build is wrong about credit notes

Both credit notes are **ACCEPTED** by the official Peppol schematron and
**rejected** by this build, under `PEPPOL-EN16931-P0100`. The official rule,
verbatim from `PEPPOL-EN16931-UBL.sch`:

```xml
<rule context="cbc:InvoiceTypeCode">
  <assert id="PEPPOL-EN16931-P0100"
    test="$profile != '01' or (some $code in tokenize('71 80 82 84 102 218 219 326 331 380 382 383 384 386 388 393 395 553 575 623 780 817 870 875 876 877', '\s')
      satisfies normalize-space(text()) = $code)" flag="fatal">…
<rule context="cbc:CreditNoteTypeCode">
  <assert id="PEPPOL-EN16931-P0101"
    test="$profile != '01' or (some $code in tokenize('381 396 81 83 532', '\s')
      satisfies normalize-space(text()) = $code)" flag="fatal">…
```

Two rules, two contexts. `P0100` is bound to `cbc:InvoiceTypeCode` and never
sees a credit note; credit notes are judged by `P0101`, whose list *does* admit
`381`. This build's `P0100` (`src/rules-peppol.ts:1015`) tests
`inv.invoiceTypeCode` on any `peppol-bis-3` input without asking what document
the code will land on, so it rejects `381` — a code the authority accepts —
while `P0101` is not implemented at all (`src/rules-peppol.ts:61` lists it under
"Not this document"). The rule's own `fix` text already says credit notes are
governed by `P0101`; the code does not act on it.

That is a false positive on a document Peppol accepts, which is the error class
this package works hardest to avoid. Not fixed here: this record is evidence,
and `src/` is out of scope for this run.

### 3. Peppol BIS Billing 3.0 *does* have a CII binding

`generate-cii.ts:92` refuses `peppol-bis-3` with `UnsupportedCiiProfileError`,
on the stated grounds that Peppol BIS Billing 3.0 has no CII binding. The
official package contradicts that. `rules/sch/PEPPOL-EN16931-CII.sch` is 602
lines with 87 assertions, `rules/buildconfig.xml` declares a
`peppolbis-en16931-01-3.0-cii` configuration bound to
`CrossIndustryInvoice::urn:fdc:peppol.eu:2017:poacc:billing:01:1.0::…`, and
`guide/bis/appendix/cii.adoc` describes CII D16B as optional in the BIS —
receivers may register in the SMP to accept CII alongside the mandatory UBL.

So the restriction is real but the reason given for it is not: CII is optional
on Peppol, not absent. Worth noting that Peppol's CII binding is **D16B**, the
same version this package emits.

Since the artefacts were already compiled, the six committed CII fixtures were
put to them as well. They are `xrechnung-cii` documents, so this measures how
far the CII *shape* is from Peppol, not conformance — the specification
identifier alone guarantees a rejection.

| Fixture | `CEN-EN16931-CII` | `PEPPOL-EN16931-CII` |
| --- | --- | --- |
| `xrechnung-cii-minimal` | pass (102 fired) | `R004` |
| `xrechnung-cii-reverse-charge` | pass (96) | `R004` |
| `xrechnung-cii-credit-note` | pass (106) | `R004` |
| `xrechnung-cii-discount` | pass (190) | `R004`, `R002`, `COMMON-R040` |
| `xrechnung-cii-credit-note-discount` | pass (187) | `R004`, `R002`, `COMMON-R040` |
| `xrechnung-cii-extended` | pass (226) | `R004`, `R002`, `COMMON-R040` ×3 |

Three distinct findings, and only one of them is a surprise:

- **`R004`** is the specification identifier, and it fires on all six because
  these documents say XRechnung. Expected, and not a defect.
- **`R002`** — "No more than one note is allowed on document level" — tests
  `count(ram:IncludedNote) <= 1 and not(ram:IncludedNote/ram:SubjectCode)`. The
  three fixtures that trip it each carry **one** note; what they also carry is a
  `ram:SubjectCode`, which the second half of the same assertion forbids
  outright. The rule's title does not say that and the test does. A CII binding
  for `peppol-bis-3` would have to drop BT-21.
- **`COMMON-R040`** is the same GLN defect as above, reaching three parties in
  the extended fixture (buyer, ship-to, payee).

The CEN EN 16931 CII schematron passes on all six, firing up to 226 rules — an
independent confirmation of the KoSIT result through a different artefact
(OpenPEPPOL's copy, schematron 1.3.15) and a different engine.

### 4. What this run did *not* settle

`scripts/kosit-check.md:440` records a gap: the XRechnung schematron carries
some `PEPPOL-EN16931-*` rules, `R040` among them, and this build gates its
Peppol rules on `profile: "peppol-bis-3"`, so those rules do not run for an
XRechnung input here even though KoSIT runs them. **That gap is untouched by
this run.** Note that the rule cited there is `PEPPOL-EN16931-R040` (allowance
amount = base × percentage), which is a different rule from the
`PEPPOL-COMMON-R040` (GLN format) found above, despite the shared number. No
document in this run trips `PEPPOL-EN16931-R040`, in either direction, so
nothing here confirms or refutes it.

Also unmeasured: the ratio of Peppol assertions this build implements. The
official `PEPPOL-EN16931-UBL.sch` carries 160 distinct assertion ids and
`CEN-EN16931-UBL.sch` carries 979; this build implements 36 Peppol rule ids.
Those numbers are not comparable — the CEN count includes every syntax-binding
assertion and both files repeat ids across contexts — and nothing in this repo
measures the overlap. No ratio is quoted for that reason.

## Scope of the claim

Three accepted documents mean our `peppol-bis-3` *output* is conformant for the
paths those documents exercise: a two-rate domestic invoice, a cross-border
reverse-charge invoice, and a credit note. It does not mean the `peppol-bis-3`
profile is verified. Specifically, this run says nothing about:

- **CII under `peppol-bis-3`** — the library refuses to emit it (see finding 3).
- **The Peppol network.** These are schematron and schema checks on XML. SMP
  registration, AS4 transport, participant identifier resolution and the
  Peppol Directory are all outside what any of this touches, and a document
  that passes here can still be undeliverable.
- **Allowances and charges at document level with a percentage**, which is the
  `PEPPOL-EN16931-R040` path — the discount fixtures use flat amounts.
- **National rules.** `PEPPOL-EN16931-UBL.sch` carries thirteen country rule
  sets (`PEPPOL-COMMON-R040`..`R053`); only R040 fired here, and only because a
  fixture happens to state a GLN.

A document this build accepts can still be rejected by an access point. Treat
`validateInput` as a fast, teaching-oriented pre-flight and OpenPEPPOL's
artefacts as the authority — and note that on the credit-note path recorded
above, the divergence ran the other way: this build refused a document Peppol
accepts.

---

## Addendum — 2026-08-14 (second run, after the fixes)

Same artefacts, same versions, same SHA-256s as the table above; the tarball
was re-fetched into a clean scratch directory and hashed to
`54b9ada9…be02802` again. What changed is this build, not the authority.

Three things were done between the two runs: the three invalid GLNs in
`src/fixtures.ts` were corrected, `PEPPOL-EN16931-P0100` was scoped to invoices
and `P0101` implemented, and `generateCii` was taught the `peppol-bis-3`
profile. The check itself grew a CII leg — the same five inputs are now emitted
in both syntaxes and judged by `CEN-EN16931-CII.sch` and
`PEPPOL-EN16931-CII.sch` as well.

### Result: 10 documents, 10 ACCEPTED, 0 findings

| Document | Root | XSD | `CEN-EN16931-*` | `PEPPOL-EN16931-*` | Verdict | This build says |
| --- | --- | --- | --- | --- | --- | --- |
| `peppol-ubl-minimal` | `ubl:Invoice` | pass | pass (71 fired) | pass (45) | **ACCEPTED** | `valid: true`, no findings |
| `peppol-ubl-reverse-charge` | `ubl:Invoice` | pass | pass (66) | pass (33) | **ACCEPTED** | `valid: true`, no findings |
| `peppol-ubl-discount` | `ubl:Invoice` | pass | pass (128) | pass (86) | **ACCEPTED** | `valid: true`, warning `PEPPOL-EN16931-R002` |
| `peppol-ubl-credit-note` | `ubl:CreditNote` | pass | pass (73) | pass (46) | **ACCEPTED** | `valid: true`, no findings |
| `peppol-ubl-credit-note-discount` | `ubl:CreditNote` | pass | pass (123) | pass (82) | **ACCEPTED** | `valid: true`, warning `PEPPOL-EN16931-R002` |
| `peppol-cii-minimal` | `rsm:CrossIndustryInvoice` | n/a | pass (102) | pass (16) | **ACCEPTED** | `valid: true`, no findings |
| `peppol-cii-reverse-charge` | `rsm:CrossIndustryInvoice` | n/a | pass (96) | pass (16) | **ACCEPTED** | `valid: true`, no findings |
| `peppol-cii-discount` | `rsm:CrossIndustryInvoice` | n/a | pass (189) | pass (35) | **ACCEPTED** | `valid: true`, warning `PEPPOL-EN16931-R002` |
| `peppol-cii-credit-note` | `rsm:CrossIndustryInvoice` | n/a | pass (106) | pass (16) | **ACCEPTED** | `valid: true`, no findings |
| `peppol-cii-credit-note-discount` | `rsm:CrossIndustryInvoice` | n/a | pass (186) | pass (35) | **ACCEPTED** | `valid: true`, warning `PEPPOL-EN16931-R002` |

**Accepted: 10  Rejected: 0.  `total findings across all reports: 0`.**

Previous run: accepted 3, rejected 2, two `PEPPOL-COMMON-R040` findings, plus
one divergence where this build refused a document Peppol accepted.

The XSD column reads `n/a` for the CII half and that is not a pass. The
OpenPEPPOL package ships no schemas — the UBL ones come from OASIS — and
UN/CEFACT publishes no stable URL for the D16B `CrossIndustryInvoice` XSD that
this script could pin the way it pins everything else. The CII documents are
schematron-checked only. Their schema validity is covered elsewhere, by
`scripts/kosit-check.sh`, which runs the German regulator's own tool over the
same generator's output — but that is a different document with a different
specification identifier, so it is evidence about the generator's *shape* and
not about these ten files. **Nothing in this repository XSD-validates a
`peppol-bis-3` CII document.**

### Was the CII leg actually exercised?

The Peppol CII schematron fired 16–35 rules per document against the UBL one's
33–86, which is low enough to be worth answering rather than asserting. Two
checks:

1. **The CEN CII schematron fired 96–189 rules on the same files** and returned
   nothing. A document the CII artefacts could not see would not fire those
   either.
2. **A negative control.** The six committed `xrechnung-cii` fixtures were put
   to the *same* compiled `PEPPOL-EN16931-CII.xsl` in the same run. They fire
   the same rule counts (16, 16, 16, 35, 35, 40) and return **9 findings** —
   `PEPPOL-EN16931-R004` on all six and `R002` on the three that carry a note.
   Identical harness, identical engine, one set of inputs clean and the other
   not. The empty report on the `peppol-cii-*` documents is a verdict, not a
   silence.

Worth recording alongside it: `COMMON-R040` no longer fires on
`xrechnung-cii-extended`, where it hit three parties in the previous run. That
is the GLN fix, observed from the other side.

### 1. `PEPPOL-COMMON-R040` — closed

`src/fixtures.ts` stated four GS1 Global Location Numbers and three of them did
not close under mod-10. All three were corrected to the check digit the
algorithm computes, which is the same digit the schematron computes:

| Was | Now | Weighted sum of the first twelve digits |
| --- | --- | --- |
| `4098765000004` | `4098765000003` | 67 → check digit 3 |
| `4098765000011` | `4098765000010` | 70 → check digit 0 |
| `4011111000005` | `4011111000007` | 13 → check digit 7 |
| `4012345000009` | unchanged | 31 → check digit 9, already right |

The committed `fixtures/*.xml` were regenerated, so the two `xrechnung-ubl` and
four `xrechnung-cii` files that carried the bad values no longer do.

The regression guard is `src/fixtures-gln.test.ts`, and it deliberately does not
assert the four corrected literals. A transcription is what was wrong; a test
that transcribes it again would have passed on 2026-08-13. It walks every
exported fixture for `{ schemeId: "0088" }` and applies mod-10 to whatever it
finds, and it re-reads the same check out of the generated XML, so an identifier
the model walk cannot see is still caught. The arithmetic is written out a
second time in the test rather than imported from `rules-peppol.ts`: a fixture
checked with the same function that validates it passes whatever that function
does, including nothing.

### 2. `PEPPOL-EN16931-P0100` / `P0101` — the false positive is gone

Both credit notes were ACCEPTED by the authority and rejected by this build in
the previous run. `P0100` is now gated on `documentKindOf(...) === "invoice"` —
the same function `generate.ts` uses to choose the root element, so the rule and
the emitted XML cannot disagree about which type-code element the code lands in
— and `P0101` is implemented with the five-code list.

Both code lists are now regression-tested against the assertions themselves.
`src/rules-peppol.test.ts` carries the two `<assert>` elements verbatim from
`rules/sch/PEPPOL-EN16931-UBL.sch` @ v3.0.20, including the `context` attribute,
parses the list back out of each assertion's own `tokenize(...)` literal, and
compares it with the Set this build validates against. A hand-edit to the Set
fails; a hand-edit to the quoted assertion is visible as a diff against a file
whose sha256 is recorded above.

One thing that was checked and left alone. `81` is on P0101's list and this
build routes it to a `ubl:Invoice`, because `81` appears on *both* halves of
BR-CL-01 and `document-type.ts` resolves that ambiguity towards an invoice. So a
document this build emits for `81` carries `cbc:InvoiceTypeCode`, is judged by
P0100, and is rejected — which is exactly what the official schematron does to
that same document, since P0100's list does not contain `81` either. Same
verdict, same id, from both. The divergence is in the routing, not in either
rule, and it is not a divergence in outcome.

### 3. `PEPPOL-EN16931-R002` — a rule that was assumed unreachable

The previous run found three committed CII fixtures failing a rule titled "No
more than one note is allowed on document level" while carrying exactly one
note. The reason is the second conjunct, and this is the CII assertion verbatim
from `rules/sch/PEPPOL-EN16931-CII.sch` @ v3.0.20:

```xml
<rule context="rsm:ExchangedDocument">
  <assert id="PEPPOL-EN16931-R002" test="count(ram:IncludedNote) &lt;= 1 and not(ram:IncludedNote/ram:SubjectCode)" flag="fatal">No more than one note is allowed on document level.</assert>
</rule>
```

and this is the UBL assertion under the same id and nearly the same title:

```xml
<assert id="PEPPOL-EN16931-R002"
  test="count(cbc:Note) &lt;= 1 or ($supplierCountryIsDE and $customerCountryIsDE)"
  flag="fatal">No more than one note is allowed on document level, unless both the buyer and seller are German organizations.</assert>
```

One id, two tests, and only the CII one forbids BT-21. `rules-peppol.ts` had
R002 filed under "not expressible in the model — `note` is scalar, so the count
is one by construction". That reasoning is sound about the UBL assertion and
answers a question the CII assertion does not ask. **The title is what made it
plausible**, which is the defect class worth naming: an id was excused on the
strength of its human-readable name rather than its test.

Two changes, deliberately paired:

- `generateCii` omits `ram:SubjectCode` under `peppol-bis-3`, and only under
  `peppol-bis-3`. That is what makes the five CII documents above conformant.
- `validateInput` reports `PEPPOL-EN16931-R002` as a **warning** on any
  `peppol-bis-3` input carrying `noteSubjectCode`, so the omission is not
  silent. This is the reason two rows in the table say "warning
  `PEPPOL-EN16931-R002`" while the same documents are ACCEPTED — the finding is
  about the input, not about the file.

It is a warning and not an error because `profile` names a CIUS and not a
syntax, and at validation time this library does not know which of the two
documents the caller will generate. On the UBL path BT-21 is fine: UBL has no
element for it, the binding folds it into the note text as `#AAI#…`, and
Peppol's UBL R002 tests only the count. Calling it fatal would reject a caller
whose target is the syntax every Peppol receiver is obliged to accept.

### 4. Peppol's CII binding, enabled

`generate-cii.ts` refused `peppol-bis-3` on the stated grounds that Peppol BIS
Billing 3.0 is "a UBL-only CIUS". Finding 3 of the previous run showed that is
false, and the ten-document table above is the consequence: the same five inputs
now emit in both syntaxes and both syntaxes are accepted. The refusal is gone,
`peppol-bis-3` is in `CII_GENERATABLE_PROFILES`, and the error message for
`xrechnung-ubl` no longer asserts something untrue about Peppol.

`R004` needed no work. `CUSTOMIZATION_IDS` and `PROFILE_IDS` in `generate.ts`
already carried the Peppol values and `generateCii` already indexes both by
`inv.profile`; the XRechnung fallback was only ever reached because the profile
could not get past the refusal at the top of the function. Verified in the
emitted XML and in `src/generate-cii.test.ts`.

### 5. Something the CII artefact cannot do, recorded because later conclusions depend on it

`PEPPOL-EN16931-CII.sch` @ v3.0.20 states the type-code rule once, as `P0100`,
over the union of both UBL lists (31 codes) — and gives it the context

```
ram:ExchangedDocument/ram:TypeCode
```

There is no `ram:ExchangedDocument` in a CII document. The element is
`rsm:ExchangedDocument`, in the `rsm:` namespace, and `ram:` and `rsm:` are
different namespaces. **That context matches nothing, so `P0100` never fires in
the CII artefact.** It is consistent with the fired-rule counts: the CII Peppol
schematron fires roughly half what the UBL one does on the same data.

This is stated because it changes what the clean CII rows above are worth. They
are not evidence that this build's type codes are right for Peppol CII — the
authority did not look. Note also that `validateInput` applies `P0100`/`P0101`
to a `peppol-bis-3` input regardless of which syntax the caller will emit, so on
the CII path this build is *stricter* than the artefact. That is left as it is:
the input model does not carry a syntax, UBL is Peppol's mandatory syntax and is
checked properly, and being strict about a type code is not a way to get an
invoice rejected.

### 6. What this addendum still does not settle

Everything in "What this run did *not* settle" above stands, unchanged: the
XRechnung-profile gating gap at `scripts/kosit-check.md:440`, the unmeasured
ratio of Peppol assertions implemented, `PEPPOL-EN16931-R040` with a percentage,
the twelve national rule sets other than R040, and the whole Peppol network
layer. Added to it by this run:

- **No XSD check exists for `peppol-bis-3` CII**, as above.
- **The CII documents are not committed either.** They are generated at check
  time like the UBL ones. They would pass now, which was not true on the first
  run, but `fixtures/` is the UBL and XRechnung set and adding a sixth and
  seventh profile's worth of files is a separate decision.
- **`P0100` is unverified in CII**, because the artefact's own context is
  unreachable (finding 5).
- **BT-21 is dropped, not carried, on the Peppol CII path.** A caller who sets
  `noteSubjectCode` and generates CII under `peppol-bis-3` gets a document
  without it. That is the only way to satisfy R002, it is warned about before it
  happens, and it is still a business term this library declines to emit.
