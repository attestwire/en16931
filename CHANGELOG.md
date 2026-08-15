# Changelog

All notable changes to `@attestwire/en16931`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] — 2026-08-14

**A document total that is not there is now a finding.** Both readers populated
`declaredTotals` only for values that parsed as a number, and the input model
had nowhere to record the difference between "the caller did not supply this"
and "the document does not contain it". So a `PayableAmount` that was absent, an
empty `<cbc:TaxExclusiveAmount/>`, or a total written `12,34` was dropped, and
the rules that compare a declared total against the computed one — BR-CO-15,
BR-CO-16 and family — had nothing to compare. `validateInput` returned
`valid: true` with zero findings on a file KoSIT rejects.

**This is 0.6.0 and not 0.5.1 because it rejects documents 0.5.0 accepted.** Not
new strictness: the regulator rejected all of them all along, and we were the
ones being lenient about a figure nobody may omit.

### The gap, and what closes it

- **Added** — `DeclaredTotals.defects`, written by `parseUbl` and
  `parseCiiInvoice`, one entry per document total the file failed to state
  readably: which term it was (`BT-106`, `BT-109`, `BT-112`, `BT-115`, and
  `BT-107`/`BT-108` when present and unreadable), whether it was `absent`,
  `empty` or `unreadable`, the exact text where there was any, and the XPath it
  was read from or should have been at. Nothing else in the model changed.

- **Changed** — **`BR-12`, `BR-13`, `BR-14` and `BR-15` are real rules now.**
  They were documented as arithmetic invariants — "this library computes the
  totals, so the field cannot be absent" — which is true of an invoice you
  *build* and false of one you *read*. A parsed document missing the sum of line
  net amounts (BT-106), the total without VAT (BT-109), the total with VAT
  (BT-112) or the amount due for payment (BT-115) now fails the matching
  presence rule. Reachable rule ids: 265 → 270.

- **Added** — `ATW-DECLARED-TOTAL-NOT-A-NUMBER` (fatal) for a total that is
  *present* and unreadable: an empty element, `12,34`, `notanumber`. It carries
  the text it saw, and for a decimal comma it says why the XML cannot have one.
  It is an `ATW-` id rather than a `BR-` id on purpose — KoSIT rejects these at
  XML Schema validation (`cvc-datatype-valid.1.2.1`), before a single business
  rule runs, so there is no official rule id to quote and inventing one would
  misrepresent the regulator. 294 → 295 distinct rule ids.

- **Changed** — an empty element where an amount belongs is also reported in
  `unmapped` now. `TreeReader.number` noted unreadable text and returned early
  on empty text, so an empty total appeared in neither the model nor the
  unmapped list — the one case where "nothing is dropped silently" was not
  true.

### KoSIT agreement, verified rather than assumed

Validator 1.6.2 with the XRechnung 3.0.2 configuration (2026-01-31), run on
2026-08-14 over twelve probe documents built from the committed fixtures, both
syntaxes. All twelve REJECT, and the citations are recorded in
`scripts/kosit-check.md`:

| Case | KoSIT | This release |
| --- | --- | --- |
| BT-106 absent (UBL and CII) | `[BR-12]` (+ BR-CO-10, BR-CO-13) | `BR-12` |
| BT-115 absent (CII) | `[BR-15]` (+ BR-CO-16) | `BR-15` |
| BT-115 absent (UBL) | XSD: `cac:LegalMonetaryTotal` incomplete | `BR-15` |
| Whole totals block absent (UBL) | XSD: invalid content | `BR-12`/`13`/`14`/`15` |
| Whole totals block absent (CII) | `[BR-CO-15]` only | `BR-12`/`13`/`14`/`15` |
| Empty element, `12,34`, `notanumber` (both) | XSD: `cvc-datatype-valid.1.2.1` | `ATW-DECLARED-TOTAL-NOT-A-NUMBER` |

Two cells where the citation differs and the verdict does not, both worth
knowing. UBL's XSD makes `cac:LegalMonetaryTotal` and `cbc:PayableAmount`
mandatory, so KoSIT stops at the schema and never reaches the rule. And the CII
schematron writes BR-12..15 with `//ram:SpecifiedTradeSettlementHeaderMonetary`
`Summation` as their context, so deleting that group deletes the context node
and the four assertions never evaluate — BR-CO-15 catches the document instead.
This build is not a schema validator, so where KoSIT's schema speaks, we cite
the EN 16931 rule the document actually breaks.

The eleven committed fixtures were re-run in the same session:
`Acceptable: 11  Rejected: 0`, unchanged.

### Hardening, from the review of this release

- **Fixed before shipping** — a hand-written `declaredTotals.defects` could
  throw a `TypeError` out of `validateInput` rather than produce findings:
  `[null]` reading `.state` off nothing, a non-array `{length: 2}` failing to
  iterate, an entry with no `xpath` failing on `.split("/")`. `InvoiceInput` is
  a public type and `POST /v1/validate` with a JSON body passes on what the
  caller posted, so that was a 500 from a validation endpoint. Both rules now
  read the array through one checked accessor. Malformed entries are **ignored**
  — not reported — because an unrecognised `state` has nothing true to say about
  it, and one policy for the whole field beats a rule id for a mistake no
  invoice can make. `field` is not trusted either: the business term comes from
  the key, so a hand-written `BT-999` cannot reach a message. A term listed
  twice is reported once, and quoted text is truncated at the rule as well as at
  the reader.
- **Fixed** — a CII document missing `ram:ApplicableHeaderTradeSettlement`
  entirely now reports the same four presence rules as one missing only the
  summation group inside it. The heavier omission must not be the quieter one.

### What did NOT change

- **The JSON input path.** Omitting `declaredTotals.payableAmount` on a
  hand-built `InvoiceInput` still means "compute it for me", still computes it,
  and still fires nothing — that is what the model is for, and no defect is
  produced for a field a caller merely did not supply. BR-12..15 remain
  unreachable from any hand-built invoice; only a reader that has seen a
  document can tell the two cases apart.
- **Comparison of totals that ARE numbers.** A readable declared total is
  compared exactly as before: BR-CO-16 on a mismatch, silence on a match.
- **Prepaid (BT-113) and rounding (BT-114) amounts**, which live in the same
  block and are optional in both syntaxes: an unreadable one is still only an
  `unmapped` note. That is a narrower version of the same gap and it is named
  here rather than quietly widened.

### API-visible

The hosted API's XML path (`POST /v1/validate` with an XML content-type) and
the MCP tool `validate_invoice_xml` go through this engine and nothing else, so
a document in any of the states above changes from `valid: true` with no
findings to `valid: false` with the finding named here. `/docs` says so at the
XML section, and the "one thing a passing verdict does not prove" caveat on
attestwire.com/playground came off in the same change — the tests that pinned
it now assert the opposite.

## [0.5.0] — 2026-08-13

**Credit notes.** The package's largest functional gap is closed: UBL
`CreditNote` and CII type-code-381 documents are now generated, parsed and
validated end to end. Also in this release: two well-formedness holes in the
XML reader, both named by an external review and reproduced against the
published 0.4.0 build before being fixed.

**This is 0.5.0 and not 0.4.1 for the same reason 0.4.0 was not 0.3.1: it
rejects input 0.4.0 accepted** (the two reader fixes below), and it accepts
input 0.4.0 refused (credit notes, which previously raised
`ATW-CREDIT-NOTE-UNSUPPORTED`).

### Credit notes

- **Added** — **`invoiceTypeCode` is the whole API.** Set `"381"` on the same
  input you already build and `generateXRechnungUBL` emits a `ubl:CreditNote`
  (root, namespace, `cac:CreditNoteLine`/`cbc:CreditedQuantity`,
  `cbc:CreditNoteTypeCode`), while the CII generator emits `ram:TypeCode` 381
  into the unchanged `CrossIndustryInvoice` shape — that asymmetry is the two
  standards', not ours. No new entry points for the ordinary case; BT-3 is the
  discriminant in the regulation, so it is the discriminant here. Parsers
  detect the document from the root element (`parseUbl` is the new canonical
  name; `parseUblInvoice` remains as a permanent alias) and `validateInput`
  runs the full rule surface — EN 16931 binds the same rule ids to both
  document types, and the whole BR-*/BR-CO-*/BR-DE-* surface runs unchanged on
  the semantic model. Helpers: `isCreditNote(input)`, `documentKindOf(code)`.

- **Verified against KoSIT, not claimed.** Four new committed fixtures
  (`xrechnung-{ubl,cii}-credit-note{,-discount}.xml`) put the total at eleven,
  and the validator (1.6.2, XRechnung 3.0.2 configuration) reports
  `Acceptable: 11  Rejected: 0` — the UBL credit notes routed by the
  validator's own scenario matching to its dedicated UBL-CreditNote schema.
  Probe documents recorded in `scripts/kosit-check.md` settled the contested
  bindings, including two deliberate rejections (`cbc:DueDate` is not in the
  CreditNote schema; `CreditNoteTypeCode` 380 fails BR-CL-01).

- **Changed** — `BR-CL-01` accepts the union of the invoice and credit-note
  halves of UNTDID 1001, matching the CII schematron literally; `BR-DE-17`'s
  message and XPath are document-aware. New advisories, none fatal:
  `ATW-CREDIT-NOTE-NEGATIVE-AMOUNTS` (warning — a credit note stating negative
  amounts mixes two legal idioms; KoSIT accepts both, so we advise rather than
  reject), `ATW-CREDIT-NOTE-DUE-DATE-UNBOUND` and
  `ATW-CREDIT-NOTE-PROJECT-REFERENCE-UNBOUND` (fields with no UBL CreditNote
  element to land in), and `ATW-CREDIT-NOTE-NO-PRECEDING-INVOICE`
  (information — BG-3 is how a credit note names the invoice it corrects, but
  no XRechnung rule requires it; BR-DE-26 fires on type 384 only, verified
  against schematron 2.5.0 before deciding not to invent the requirement).
  Removed: `ATW-CREDIT-NOTE-UNSUPPORTED`. Counts: 265 reachable, 294 total.

- **Out of scope, stated plainly:** self-billing workflows and the
  `SelfBilledInvoice`/`SelfBilledCreditNote` roots, `ubl:DebitNote`, and BT-11
  on a UBL credit note (the schema has no element for it). Most
  `TeachingError.xpath` values still read `/ubl:Invoice/…` on credit notes;
  the credit-note-specific rules name `/ubl:CreditNote`. Both limitations are
  in the README.

### Reading

Both reader fixes below came from an external review
(`STRATEGIC_ASSESSMENT.md` §2.4) and were knowingly left out of 0.4.0 as
lower-priority than the security and arithmetic defects that release carried.
Both documents are ill-formed under XML 1.0 and were parsed anyway, so nothing
that was *correct* stops working — but if you generate documents with a tool of
your own, a comment or an attribute list it emits may now be refused where it
previously went through. Both refusals are `XmlSyntaxError`, which the API
surfaces as HTTP 400 `xml_malformed`.

- **Fixed** — **an element could carry the same attribute twice.**
  `<r a="1" a="2"/>` parsed, both attributes landed in `attributes`, and `attr()`
  returned the first — so a document stating two different `@currencyID` or
  `@schemeID` values on one element was read by position and the losing value
  vanished from the invoice with nothing raised. XML 1.0 forbids it, and the
  duplicate is now detected by **expanded name** (namespace URI plus local name)
  rather than by the text as written: `p:x` and `q:x` with both prefixes bound to
  one URI are the same attribute written twice and are refused, while the same
  local name under two genuinely different namespaces is legal and still parses.
  The check runs after prefix resolution, which is the only point at which the
  element's namespace context is known. New code: `xml_duplicate_attribute`.

- **Fixed** — **a comment could contain `--`.** `<r><!-- bad -- comment --></r>`
  was accepted. `-->` is the only comment terminator there is, so a comment
  holding `--` has no single reading — a writer who meant it as text and a reader
  who takes it as the start of the terminator disagree about where the comment
  ends, and therefore about how much of the document is markup. A comment ending
  in a hyphen (`--->`) is refused on the same grounds. Single hyphens separated
  by other characters are ordinary text and are unaffected: `<!-- a- -b -->` and
  `<!-- BT-1 is the invoice number -->` both still parse. New code:
  `xml_bad_comment`.

## [0.4.0] — 2026-08-12

Security, correctness and rule-coverage fixes from a four-lens adversarial
review. Every defect below was reproduced before it was fixed, and most were put
to the KoSIT validator (1.6.2, XRechnung 3.0.2 configuration 2026-01-31) in both
syntaxes, comparing the rule ids it returns against the ones this build returns.

### ⚠ Migrating from 0.3.0 — read this first

**This is 0.4.0 and not 0.3.1 because it rejects input 0.3.0 accepted, and
because the default parser caps are 25× lower.** It was written up as a patch
and that was wrong: two of the three things below will change the answer your
code gets from an input it is already sending. Neither is a bug fix you can take
without looking.

**1. A document that parsed in 0.3.0 can now fail with `xml_too_large`.**
`maxCharacters` is 10,000,000 → **400,000**, `maxElements` 200,000 → **50,000**,
and there is a new `maxAttributes` of **256** per element. The case that will
find you is a base64-embedded attachment: base64 costs four characters per three
bytes, so an invoice carrying a PDF of about **300 kB** lands on 400,000
characters on its own and is refused. A thousand-line invoice with no attachment
is around 300 kB of XML and is unaffected; the largest fixture in this package is
under 10 kB.

All four caps are still overridable per call — but **do not raise
`maxCharacters` on Cloudflare Workers without measuring**. That is what the old
default was hiding: measured on Node 22, a *legal* document at the old 10M cap
retained about **81 MB of heap and about 306 MB of RSS**, against the **128 MB**
an isolate is allowed. A request like that was not rejected, it was **killed** —
no status code, no finding, no charge, nothing to catch. A 785 kB body already
retained about 47 MB. On a long-lived Node process with room to spare, raise it
deliberately and know the arithmetic; on Workers, the safer shape is to strip the
attachment before parsing.

**2. 0.3.0 emitted documents that are silently wrong, and no version of the
library will tell you which.** If you have priced anything per unit at more than
two decimals — per kilo, per kWh, per thousand impressions — **regenerate those
documents**. `quantity: 10000, unitPrice: 0.0345` emitted BT-146 as `0.03`
beside a correct line total of `345.00`: the price a human reads was wrong by
**71%**, and **KoSIT accepts it**, because no EN 16931 rule ties BT-146 to
BT-131. Nothing rejects these. They are simply wrong, in your customers' hands.

A second one is worse than a plain rejection because it is intermittent: the VAT
rate was truncated while the VAT amount was computed from the full rate, so
**KoSIT REJECTS `[BR-CO-17, BR-S-09]`** — but only once the taxable base clears
the rule's ±1 tolerance, at somewhere around **20,000**. The same 0.3.0 document
shape passes at one invoice size and is rejected at another.

**3. Input that validated before may now fail.** Every new finding is `fatal`,
so it lands in `result.errors` and turns `result.valid` to `false`. That
direction is the point. A validator that says yes where the portal says no is
worse than useless — it spends the caller's trust and then loses them the
invoice. Nobody is newly harmed by a new finding: every input that starts failing
was already going to be rejected downstream, and now it is rejected a great deal
earlier and with a rule id and a fix attached.

**⚠ 0.3.0 is affected.** Three of these shipped in it and none is visible from
inside the library:

- **The unit price was rounded to two decimals** (BT-146, and BT-147/BT-148 with
  it). `quantity: 10000, unitPrice: 0.0345` emitted a price of `0.03` beside a
  correct line total of `345.00`, so the document read 10000 × 0.03 = 345.00 and
  the price a human reads was wrong by 71%. KoSIT *accepts* that document — no
  EN 16931 rule ties BT-146 to BT-131 — so it is silent corruption, not a
  rejection. Anyone on 0.3.0 with per-unit pricing carrying more than two
  decimals (per-kilo, per-kWh, per-thousand-impressions) has documents with a
  wrong price in them. Regenerate them.
- **The VAT rate was truncated while the VAT amount was computed from the full
  rate.** A rate of 16.665 emitted `RateApplicablePercent 16.66` (`toFixed`
  truncates, and half-up is 16.67, so it was wrong twice) against a
  `CalculatedAmount` computed at 16.665%. **KoSIT REJECTS: `[BR-CO-17,
  BR-S-09]`, both syntaxes** — but only once the base clears the rule's ±1
  tolerance, which happens above roughly 20,000, so a 0.3.0 document can be fine
  at one size and rejected at another.
- **A corrupt VAT breakdown or line total validated as `valid: true`.** A
  document stating a line net amount of 77.77 where its own lines compute 99.99,
  a VAT basis of 55.55 and a VAT amount of 11.11 — three fatal schematron
  violations — parsed and validated with **zero errors**. KoSIT REJECTS it with
  `[BR-CO-10, BR-CO-14, BR-S-08, PEPPOL-EN16931-R120]` in both syntaxes.

### Security

- **Fixed** — **an entity reference could resolve to an `Object.prototype`
  member and be substituted into the document.** `PREDEFINED[name]` was a lookup
  on an object literal, so `&constructor;` resolved to the `Object` constructor
  and was written into the invoice as the string
  `"function Object() { [native code] }"`. End to end: a minimal XRechnung UBL
  fixture with its invoice number replaced by `&constructor;` returned HTTP 200,
  `valid: true`, zero findings and a charged quota, carrying that text as BT-1.
  `&toString;`, `&valueOf;` and `&__proto__;` did the same, on both readers, and
  all four are short enough to pass the reference-length guard. The table is now
  null-prototype and the lookup is an own-property check — two independent
  guards. Any name that is not one of the five and not a numeric character
  reference reaches `xml_entity_forbidden`.

- **Fixed** — **parsing was quadratic in the number of sibling elements.** The
  `[n]` path index was computed by rescanning every preceding sibling. Measured:
  10k elements 177 ms, 20k 799 ms, 40k 3,777 ms, and
  `'<r>' + '<x/>'.repeat(199999) + '</r>'` — 800 kB, under every cap then in
  force — took **125,600 ms** in `parseXml`. `maxElements` did not bound it,
  because the cap is checked inside the loop, so *refusing* a 200,001-element
  document cost 224 seconds. It is now a per-frame tally, O(1) per element, with
  byte-identical paths.

- **Fixed** — **the namespace map was copied per element that declared a
  prefix**, a second and independent amplifier. 20,000 `xmlns:` declarations on
  the root plus 6,000 children each declaring one — 536 kB — took **21,779 ms**,
  of which the path index accounted for about 50. The map is now chained with
  `Object.create` rather than copied, and the chain bottoms out at a
  null-prototype map, which also fixes `nsMap[prefix]` resolving `constructor`
  to a function instead of raising `xml_unbound_prefix`.

- **Changed** — **the default XML limits are much lower, and there is a new
  one.** `maxCharacters` 10,000,000 → **400,000**; `maxElements` 200,000 →
  **50,000**; new `maxAttributes`, **256** per element. Measured on Node 22, a
  legal document at the old size cap retained about 81 MB of heap and about
  306 MB of RSS — over the 128 MB a Cloudflare Workers isolate is allowed, so
  such a request was killed rather than rejected. A 785 kB body already retained
  about 47 MB. The docstring that claimed 10M characters was "far below anything
  that threatens a Node or Workers heap" said the opposite of the measurement and
  has been replaced with the bytes-per-element arithmetic. All four remain
  overridable per call. The largest fixture here is under 10 kB and a
  thousand-line invoice lands around 300 kB; raise `maxCharacters` deliberately
  if you parse documents carrying base64 attachments.

### Correctness of emitted documents

- **Fixed** — **BT-146, BT-147 and BT-148 are written at their own precision.**
  A new `formatPrice()` replaces `formatAmount()` on the three price terms, with
  two decimals as a floor rather than a cap, up to eight. EN 16931 sets no
  BR-DEC rule on BT-146 — `rules-decimals.ts` says so explicitly — because
  per-unit pricing legitimately needs more. Every committed fixture is
  byte-identical.

- **Fixed** — **BT-119 and BT-117 now come from one number.** The VAT rate is
  normalised to two decimals before `computeTotals` groups on it, and
  `formatNumber` rounds half-up through the same `toPrecision(15)`
  normalisation `round2` uses instead of calling `toFixed` — the exact trap
  `round2`'s own docblock warns about, six lines above the function that fell
  into it. `16.665` now emits `Percent 16.67` against `TaxAmount 16670.00`, and
  KoSIT accepts it.

- **Fixed** — **a document-level allowance or charge no longer carries a rate
  the breakdown does not.** The line path zero-normalised the rate for
  categories Z/E/AE/K/G and the document path did not, so an allowance written
  `{ vatCategory: "E", vatRate: 19 }` emitted `19.00` against an `E @ 0.00`
  breakdown — one document contradicting itself, and a BR-E-06 violation. Both
  syntaxes.

### Rule coverage

- **Fixed** — **BR-CO-09 now matches the schematron, per syntax.** It folded
  case and stripped whitespace before the code-list lookup; the schematron does
  neither, in either syntax, and the two syntaxes do not agree with each other.
  `"de123456789"` was reported valid here and is rejected by KoSIT in **both**
  syntaxes. In the other direction, `"Q 123456789"` was reported fatal here and
  is *accepted* by KoSIT in UBL, whose `contains` needle is not space-wrapped
  and finds `"Q "` inside `"AQ "`. The two literal lists are not even the same
  list: UBL carries `SS` and not `AN`, CII carries `AN` and not `SS`. The rules
  are now implemented separately, and the `en16931` profile — emittable as
  either syntax — must satisfy both. Thirteen BT-31 values put to KoSIT in both
  syntaxes — twenty-six probes — all agreeing on the rule ids returned; the
  table is in `scripts/kosit-check.md`
  and mirrored in the README. Greece is unaffected: `EL` on BT-31 with `GR` on
  BT-40 is still accepted by both.

- **Fixed** — **declared line net amounts and declared VAT breakdowns are
  compared instead of discarded.** `DeclaredTotals` gains `lineNetAmounts`
  (BT-131 per line) and `subtotals` (BT-116, BT-117, BT-118, BT-119 per group),
  and both parsers populate them. They were recorded as `unmapped` "recomputed"
  notes and thrown away, so nothing ever compared them — which is why the
  corrupt document described above validated clean. `BR-CO-10`, `BR-CO-14`,
  `BR-{S,Z,E,AE,IC,G,O,AF,AG}-08`, `BR-CO-17` and `PEPPOL-EN16931-R120` now run
  against the stated figures, each with the schematron's own tolerance — a whole
  unit of currency for the `-08` family and BR-CO-17, 0.02 for R120, exact for
  BR-CO-10 and BR-CO-14. A first draft used ±0.02 for BR-CO-17 and reported a
  finding on a document KoSIT accepts; the probe caught it.

  Two consequences of running against the stated figures, both settled in this
  release. First, each rule id now yields **one finding per document**: the
  stated-versus-stated checks own `BR-CO-10` and `BR-CO-14`, and the older
  derived-value twins stand down when the document states its summands — a
  first cut reported `['BR-CO-14', 'BR-CO-14']` on a single corrupt BT-110,
  same id, two deltas. Second, a document whose stated line amounts agree with
  its stated BT-106 but whose per-line arithmetic is wrong no longer gets
  `BR-CO-10` under the plain `en16931` profile. That matches the schematron,
  which sums what the lines *state*: the per-line arithmetic is
  `PEPPOL-EN16931-R120`, a Peppol rule, and it still fires under
  `peppol-bis-3` and the XRechnung profiles. The `BR-{…}-08` family compares
  stated against stated for the same reason — a document whose lines each
  drift +0.02 inside R120's own slack is accepted by KoSIT, and now here too.

- **Fixed** — **BR-AE-02's seller half is enforced on every profile.** Only the
  buyer half was, so an `en16931` or `peppol-bis-3` invoice with reverse-charge
  lines and no seller tax identifier at all returned `valid: true` with zero
  errors. Only XRechnung caught it, via `BR-DE-16`, which is a different rule
  about a different thing. The seller half is in the EN 16931 schematron, not a
  CIUS, so it applies everywhere; it takes any seller `PartyTaxScheme`, so BT-32
  satisfies it, as does a tax representative's BT-63. KoSIT REJECTS the
  XRechnung form with `[BR-AE-02, BR-DE-16]` in both syntaxes, which is now
  exactly what this build returns.

- **Fixed** — **BT-110 no longer escapes validation when BT-6 equals BT-5.**
  BT-110 and BT-111 are one CII element twice over, told apart only by
  `@currencyID`. With the two currencies equal — legal, and not rare — the first
  one was claimed as BT-111, so `declared.taxAmount` was never set and BR-CO-14
  silently did not run. Position now decides the ambiguous case: the first
  `TaxTotalAmount` is BT-110, and only a later one can be BT-111. `@currencyID`
  still decides when the currencies genuinely differ. The same tiebreak was
  added to the UBL reader, which had a partial guard.

### Reading

- **Fixed** — **content nested inside a consumed leaf is no longer lost
  silently.** `leaf()` marked an element read and took its text, which is `""`
  for any element with children, and `sweep()` then skipped it — so
  `<ram:ID><x:real xmlns:x="urn:x">2026-000142</x:real></ram:ID>` produced
  `invoiceNumber === ""` with `x:real` reported nowhere. That is the one thing
  `xml-reader.ts` exists to prevent. Both the emptied container and its contents
  are now reported in `unmapped`.

  As a consequence, a clean fixture now leaves **nothing** unmapped, where it
  previously reported three "recomputed" entries. Code that asserted those
  entries exist will need updating.

### Documentation

- **Fixed** — **the reachable-rule count is 262, and is now derived rather than
  typed.** Of the 291 rule ids, 262 can be tripped by caller input and 29
  constrain the library's own computed arithmetic. The figure was published as
  254 for a few hours on the day of this release, because it was taken from the
  size of the battery in `src/rules-invariants.test.ts`, which fired only one
  member of the nine-member per-category `-08` family. Reachability is a
  property of the rule, not of the battery that happens to exercise it: all
  nine members were fired from caller input, one fixture each, when this was
  checked. Read the wrong way round, the number put "You cannot trip this rule"
  on eight rule pages describing rules a caller can trip.

  The number itself is no longer the guard. The battery now proves
  completeness: every rule id present in `src/` must be either fired by a
  fixture or named in `ARITHMETIC_INVARIANTS` with the reason no input reaches
  it, and a rule that is neither fails the suite by name. A literal that has
  been wrong twice — it read 248, then 251, then 254 — is not a guard.

- **Changed** — the README no longer claims the build implements "every"
  expressible rule, or that the limitations list is complete. Four coverage gaps
  were found in two days and none of them had a row in that list beforehand.
  Nothing in this repository measures coverage against the schematron, so an
  absent row means "not yet noticed", not "does not exist".

### Also in this release

The three rule-coverage fixes below were made earlier on the same day.

- **Fixed** — **BR-CO-09 now checks the seller tax representative VAT
  identifier (BT-63).** The rule names three identifiers — BT-31, BT-63 and
  BT-48 — and this build checked two. A representative VAT identifier with no
  ISO 3166-1 country prefix, such as `123456789`, was accepted. The schematron
  context is every `cac:PartyTaxScheme` whose tax scheme is `VAT`, wherever it
  sits in the document, and the generator writes one under
  `cac:TaxRepresentativeParty`.

  The gap was excused by a belief that the input model had no BG-11 group.
  That stopped being true in 0.2.0: `taxRepresentative` is in `types.ts`, and
  the BR-\*-02 family in `rules-allowance.ts` already read `BT-63` from it.

- **Fixed** — **BR-CL-14 now checks the seller tax representative country code
  (BT-69).** Found by sweeping for the same kind of mistake. The rule applies
  to every `cac:Country/cbc:IdentificationCode` in the document; the code
  checked the seller (BT-40), the buyer (BT-55) and the deliver-to address
  (BT-80), and a comment listed those three as if the list were complete. The
  representative's address is the fourth. `taxRepresentative.address.countryCode`
  has been in the model since 0.2.0 — BR-20 already reads it.

  `cac:OriginCountry/cbc:IdentificationCode` (BT-159) is still deliberately not
  here. The schematron gives it a template of its own at a higher priority, and
  that is BR-CL-15.

- **Fixed, and this is the one to read twice** — **BR-CO-09 now checks the VAT
  prefix against the country code list, instead of checking that it is two
  letters.** The test was `/^(EL|[A-Z]{2})/`. Any two capitals satisfied it, so
  `"ZZ123456789"` was reported as valid and is rejected by KoSIT under this
  same rule id.

  **This affects every caller, not only those using a tax representative.** It
  applies to all three identifiers — BT-31, BT-48 and BT-63. If a VAT
  identifier in your data carries a prefix that is not a real country code, you
  will now get a fatal `BR-CO-09` where you previously got `valid: true`. A
  common case is `"UK123456789"`: the United Kingdom is `GB` in ISO 3166-1 and
  `UK` is reserved and never assigned, so the message names that specifically.

  **Greece still works, in both directions.** BR-CO-09 and BR-CL-14 use
  deliberately different lists: BR-CO-09 admits `EL`, BR-CL-14 does not. So a
  Greek seller is correct with `vatId: "EL123456789"` and
  `address.countryCode: "GR"` at the same time, and stays correct — verified
  against KoSIT, which accepts that invoice in both syntaxes. The two lists are
  built separately on purpose and must not be merged.

- **Verified against the regulator, not against our own reasoning.** An invoice
  carrying an unprefixed BT-63 and an invalid BT-69 was put through the KoSIT
  validator (1.6.2, XRechnung 3.0.2 configuration 2026-01-31) in **both**
  syntaxes. It is rejected in each, under exactly these two rule ids and no
  others, which is now what `validateInput` reports for the same input.

  The same was done for the prefix change: a `ZZ`-prefixed invoice is rejected
  in both syntaxes under exactly `BR-CO-09`, and a Greek `EL`/`GR` invoice is
  accepted in both with zero findings — matching this build exactly, in all
  four cases. The two literal code lists in the schematron were also compared
  element by element against ours: BR-CL-14's is `COUNTRY_CODES` exactly (251
  codes) and BR-CO-09's is that set plus `EL` and nothing else (252).

- **Unchanged** — the seven committed fixtures. None carries a bad
  representative or a made-up VAT prefix, so the conformance record stands:
  re-run 2026-08-12, `Acceptable: 7  Rejected: 0`. This release changes which
  inputs `validateInput` rejects and does not change a byte of what the
  generators emit.

## [0.3.0] — 2026-08-11

Adds **CII**, in both directions — and with it the German and French markets
this library could not serve. ZUGFeRD and Factur-X are CII by construction, and
a real share of German senders use XRechnung CII rather than XRechnung UBL.
Until now `xrechnung-cii` and `facturx-en16931` threw on generation and a CII
file was refused on parse.

- **Added** — `generateCii(inv, options?)`. Emits a UN/CEFACT
  `rsm:CrossIndustryInvoice` (D16B) from the same `InvoiceInput` the UBL
  generator takes, for `xrechnung-cii`, `facturx-en16931` and `en16931` — the
  core profile is syntax-neutral, so you choose the syntax by choosing the
  function. Totals are computed by the same `computeTotals`, never echoed from
  caller input. `xrechnung-ubl` and `peppol-bis-3` throw
  `UnsupportedCiiProfileError`: Peppol BIS Billing 3.0 has no CII binding.

- **Added** — `parseCiiInvoice(xml, options?)`. Reads a `CrossIndustryInvoice`
  back into an `InvoiceInput`, returning the same
  `{ invoice, unmapped, customizationId, profileId }` shape as
  `parseUblInvoice`. It shares the one hardened XML reader in the package — and
  every one of its security limits — and resolves everything by namespace URI
  rather than by prefix.

- **Added** — four CII fixtures, and **the KoSIT run that judges them**. KoSIT's
  XRechnung 3.0.2 configuration has its own CII scenario (D16B XSD, EN 16931 CII
  schematron, XRechnung CII schematron), selected by BT-24. Run 2026-08-11 over
  all seven fixtures: `Acceptable: 7  Rejected: 0`, zero findings at any
  severity. `xrechnung-cii-extended.xml` exists specifically to put the payee,
  tax representative, direct debit, deliver-to, attachment, BT-111, tax point
  date and gross-price paths in front of the validator.

- **Fixed** — before shipping: `CII-SR-461`, "only one TaxPointDate shall be
  present". BT-7 and BT-8 have no document-level element in CII, so the binding
  hangs them off a VAT breakdown group; the generator hung them off *every*
  group, which is invisible on a single-rate invoice and rejected on a two-rate
  one. Caught by KoSIT, not by the round trip — a round trip cannot catch it,
  because the parser reads back exactly what the generator wrote.

- **Known gap, found by the same run** — KoSIT's XRechnung schematron (UBL and
  CII alike) includes some `PEPPOL-EN16931-*` assertions, `R040` among them.
  This build gates its Peppol rules on `profile: "peppol-bis-3"`, so they do not
  run for an XRechnung input here. Not new, not CII-specific, now named — see
  `scripts/kosit-check.md`.

- **Unchanged: there is still no PDF.** Factur-X and ZUGFeRD are CII XML inside
  a PDF/A-3 container. `generateCii({ profile: "facturx-en16931" })` produces
  the **CII XML payload**. It does not build the container, does not attach the
  XML under the required name (`factur-x.xml`, or `xrechnung.xml` for the
  XRECHNUNG reference profile) and does not set `/AFRelationship = Alternative`,
  which Germany requires. Do not describe the output as a Factur-X or ZUGFeRD
  file.

- **Note** — Factur-X's EN 16931 profile and plain core EN 16931 state the same
  BT-24 (`urn:cen.eu:en16931:2017`), so `parseCiiInvoice` reads a
  `facturx-en16931` document back as `profile: "en16931"`. The rule set is
  identical and regeneration is byte-identical; if you need the distinction,
  keep it yourself.

- **Changed** — `UnsupportedProfileError` and the CII branch of
  `UnsupportedSyntaxError` no longer say a CII generator or reader "has not
  shipped yet". They now name `generateCii` and `parseCiiInvoice`.

- **Internal** — the `unmapped` bookkeeping shared by both readers moved to
  `src/xml-reader.ts`. No behaviour change; `UnmappedElement` is still exported
  from the package root.

- **Credit notes are still refused** in both syntaxes, by root element, by BT-3,
  and by `ATW-CREDIT-NOTE-UNSUPPORTED`.

Adds XML ingestion. Until now the library could only look at its own JSON input
model, so it could not answer the question most people arrive with: *my
customer's platform rejected this file — why?* It also could not serve the
French, Belgian and Dutch mandates at all, because those are **receiving**
mandates, and receiving means reading someone else's document.

- **Added** — `parseUblInvoice(xml, options?)`. Reads a UBL 2.1 `Invoice`
  document into an `InvoiceInput`, so the existing rules can run against a real
  file:

  ```ts
  const { invoice, unmapped } = parseUblInvoice(xmlString);
  const findings = validateInput(invoice);
  ```

  Returns `{ invoice, unmapped, customizationId, profileId }`. Namespaces are
  resolved by URI, not by prefix, and element order does not matter. The
  document's declared totals go into `declaredTotals`, so the `BR-CO-*` rules
  check the document's own arithmetic against ours.

- **Added** — `unmapped`, so nothing is dropped in silence. Every element that
  did not reach the invoice object is reported with its path, name, namespace
  and text. `kind: "unknown"` means there is no field for it and the content is
  gone from the model; `kind: "recomputed"` means the model derives the value
  from the lines (BT-131, BT-116, BT-117). For a document this package
  generated, `unmapped` holds nothing but `"recomputed"` entries — that is
  asserted per fixture.

- **Added** — round-trip tests over every committed fixture:
  `generateXRechnungUBL(parseUblInvoice(xml).invoice)` returns the identical
  document, and validates identically. This is the strongest correctness signal
  available for a mapper, and it costs one assertion per fixture.

- **Added** — `parseXml`, a hardened XML reader written for the UBL subset, with
  `attr`, `firstChild` and `childrenNamed` for walking the tree. It exists
  because this package has zero runtime dependencies and intends to keep them.
  Four defences, each tested:
  - any `<!DOCTYPE` or `<!ENTITY` in the document is refused, which is what
    stops **XXE** (external entities reading local files or making network
    requests) and the declaration half of **billion laughs**;
  - only the five predefined entities and numeric character references are
    decoded — an unknown entity is refused, never silently dropped;
  - a **depth cap** of 100 elements, against deeply nested documents;
  - a **size cap** of 10,000,000 characters and an **element cap** of 200,000,
    against memory exhaustion. All are in `DEFAULT_XML_LIMITS` and can be
    raised per call.

  It also refuses mixed content, unbound namespace prefixes and control
  characters XML 1.0 forbids, and it never acts on a processing instruction.

- **Added** — explicit refusals rather than a half-read invoice.
  `UnsupportedSyntaxError` for a CII document or a UBL `CreditNote`,
  `UnsupportedCreditNoteError` for a credit-note BT-3, `XmlSecurityError` for a
  limit, `XmlSyntaxError` for anything malformed. All extend `ParseError` and
  carry a stable `code`, matching the way generation already refuses.

- **Unchanged** — no rule was added, removed or altered; no generated document
  changed; `dependencies` is still empty. `parseUblInvoice` is a reader, **not**
  a schematron and **not** an authority: a file it parses, and that then passes
  `validateInput`, can still be rejected by KoSIT or by a receiving platform.
  The scope is UBL `Invoice` only — no CII, no Factur-X, no PDF, no credit
  notes. The package README lists what a real German portal file will hit that
  this does not yet handle.

## [0.2.1] — 2026-08-11

Documentation correctness only. No code, no rule, no output changes.

0.2.0 was published on 2026-08-10. The KoSIT conformance run happened on
2026-08-11 — one day later — so the README inside the published 0.2.0 tarball
states, in bold, that the run "has not been performed". That was true when
written and could not be edited without republishing, while attestwire.com
correctly reported the fixtures passing. Two of our own artefacts contradicted
each other on the one claim we invite people to verify.

- **Fixed** — the README now records the actual result: validator 1.6.2,
  XRechnung configuration 3.0.2, three committed fixtures, `Acceptable: 3
  Rejected: 0`, zero findings at any severity. The scope caveat is unchanged:
  this is a conformance check on three documents, not a schematron parity suite.
- **Fixed** — removed the `zugferd` keyword from `package.json`. The only
  ZUGFeRD code in this package is a test asserting that a `zugferd-2.3` profile
  *throws*. Advertising a format the library refuses to emit is an overclaim,
  and npm keyword search is a discovery surface.
- **Added** — `src/readme-kosit-claim.test.ts`, a release gate that fails the
  build whenever `README.md` and `scripts/kosit-check.md` disagree about whether
  the KoSIT run happened, in either direction. A published tarball cannot be
  edited; this makes the contradiction impossible to ship again.

## [0.2.0] — 2026-08-10

Closes the gap between what the input model can say and what EN 16931 lets an
invoice say. 0.1.x could describe a simple invoice: lines, one or two VAT rates,
a payment instruction. It could not describe a discount, a surcharge, a
prepayment, a period, a payee, a corrected invoice that names what it corrects,
or an attachment — and every rule governing those groups was deferred because
there was no field to test. This release adds the groups and the rules together,
so nothing is modelled without being checked.

The rule set goes from 128 to **291 distinct rule ids**: 287 rules of the
regulation plus four `ATW-` library findings. Of the 291, 251 are reachable
from caller input; the other 40 constrain the library's own arithmetic (the
per-category `-01`/`-08`/`-09` families — nine categories now, so 27 of them —
`BR-12`..`BR-15`, `BR-45`/`BR-46`/`BR-48`, `BR-CO-17`, `BR-CO-18`,
`BR-DEC-19`/`-20`/`-23` and `PEPPOL-EN16931-R120`) and cannot be tripped by any
input, because totals are computed rather than echoed. That is what they are
for: they are the assertions that would catch a regression in `computeTotals`
before it reached a tax authority.

No breaking changes to the input model. Every group added here is optional, every
0.1.x input validates and generates identically, and both existing fixtures are
byte-identical to 0.1.1 output.

### Added

- **Document and line allowances and charges (BG-20/BG-21, BG-27/BG-28)** —
  `allowances` and `charges` on the invoice, `line.allowances` and
  `line.charges` on a line. Document level entries carry their own VAT category
  and rate and land in the BG-23 breakdown on their own account; line level
  entries have neither, because they modify BT-131 and inherit the VAT treatment
  of the line they sit on. Rules: `BR-31`, `BR-32`, `BR-33`, `BR-36`, `BR-37`,
  `BR-38`, `BR-CO-11`, `BR-CO-12`, `BR-CO-21`, `BR-CO-22`, `BR-DEC-01`,
  `BR-DEC-02`, `BR-DEC-05`, `BR-DEC-06`, `BR-DEC-10`, `BR-DEC-11` at document
  level; `BR-41`, `BR-42`, `BR-43`, `BR-44`, `BR-CO-23`, `BR-CO-24`,
  `BR-DEC-24`, `BR-DEC-25`, `BR-DEC-27`, `BR-DEC-28` at line level. Plus the
  `-03`/`-04` (seller and buyer identification) and `-06`/`-07` (rate) branches
  of all seven VAT category families — 28 rules — and `BR-O-13` / `BR-O-14`.

- **Parties and references** — `payee` (BG-10, `BR-17`), `taxRepresentative`
  (BG-11, `BR-18`/`BR-19`/`BR-20`/`BR-56`), `precedingInvoices` (BG-3, BT-25 and
  BT-26, `BR-55`), `supportingDocuments` (BG-24, `BR-52`) with either an embedded
  base64 attachment (BT-125) or an external URL (BT-124), `payment.card` (BG-18,
  `BR-51` on the PAN — a warning, because a caller who put a full card number in
  an invoice has a problem the invoice cannot fix by rejecting it) and
  `payment.directDebit` (BG-19, BT-89/BT-90/BT-91), item attributes (BG-32,
  `BR-54`), item identifier schemes (`BR-64`, `BR-65`), and `BR-50` — a credit
  transfer group must identify the account the money goes to.

  The plain reference fields too: BT-11 project, BT-12 contract, BT-14 sales
  order, BT-15 receiving advice, BT-16 despatch advice, BT-17 tender or lot,
  BT-18 invoiced object identifier with its BT-18-1 scheme and BT-128 at line
  level, BT-19 and BT-133 buyer accounting reference, BT-132 order line
  reference, BT-21 note subject code, BT-70/BT-71 deliver-to name and location
  identifier.

- **Periods** — `invoicingPeriod` (BG-14) and `line.period` (BG-26), with
  `BR-29`, `BR-30`, `BR-CO-19`, `BR-CO-20`, and `BR-CO-03`: BT-7 (tax point
  date) and BT-8 (period description code) state the same fact two ways, so an
  invoice may carry one or the other and not both.

- **The second currency and the amounts that were missing** —
  `vatAccountingCurrency` (BT-6) with `taxAmountInAccountingCurrency` (BT-111)
  under `BR-53`, `paidAmount` (BT-113), `roundingAmount` (BT-114), and
  `BR-DEC-15`/`-16`/`-17` over the three. `BR-28` (an item gross price must not
  be negative) joins them.

- **Item and party detail** — BT-29/BT-46 party `identifier` with its ISO 6523
  scheme, BT-30-1/BT-47-1 `legalRegistrationSchemeId`, BT-28/BT-45
  `tradingName`, BT-33 `additionalLegalInformation`; BT-155/BT-156 seller and
  buyer item identifiers, BT-157 `standardItemId`, BT-158 `itemClassifications`,
  BT-159 `originCountryCode`; BT-147/BT-148 `priceDiscount` and
  `grossUnitPrice`; BT-121 `vatExemptionReasonCodes`; a third address line.
  `declaredTotals` gains BT-107 and BT-108.

- **Every `BR-CL-*` rule in the reference schematron is now implemented** —
  `BR-CL-05`, `-06`, `-07`, `-08`, `-10`, `-11`, `-13`, `-15`, `-19`, `-20`,
  `-21`, `-22`, `-24` and `-26` join the nine from 0.2.0's first wave. The
  complete list is 01, 03, 04, 05, 06, 07, 08, 10, 11, 13, 14, 15, 16, 17, 18,
  19, 20, 21, 22, 23, 24, 25, 26 — 23 rules; there is no BR-CL-02, -09 or -12.

- **Nine more generated code lists** under `src/codelists/` — tax point date (3
  codes), object identifier scheme (818, UNTDID 1153), ISO 6523 ICD (243), item
  classification scheme (185, UNTDID 7143), allowance reason (19, UNCL 5189),
  charge reason (178, UNCL 7161), VATEX exemption reason (88, CEF), MIME type
  (6) and note subject (383, UNCL 4451). `scripts/build-codelists.mjs` now also
  fetches `EN16931-UBL-model.sch`, because BR-CL-08's list lives there rather
  than in the codes file — UBL has no element for BT-21, so the note subject
  code is asserted inside the model rules. The script asserts that `BR-CL-11`,
  `BR-CL-21` and `BR-CL-26` carry a byte-identical ISO 6523 literal to
  `BR-CL-10` before exporting one shared array for all four; if the schematron
  ever lets them drift, the build fails rather than silently picking one.

- **XRechnung CIUS** — `BR-DE-20`, `BR-DE-22`, `BR-DE-23-b`, `BR-DE-24-b`,
  `BR-DE-25-b`, `BR-DE-30`, `BR-DE-31`, `BR-DE-TMP-32`.

- **`PEPPOL-EN16931-F001` and `PEPPOL-EN16931-P0110`**, both added by the
  adversarial pass over the finished rule set. F001 checks that every date term
  is a real calendar day; P0110 pins `VATEX-EU-I` to category `E`. Both had been
  recorded as deliberately absent, and in both cases the recorded reason was
  wrong — see **Fixed**.

- **`Severity` gains `"information"`**, the third flag KoSIT's schematron uses,
  and `ValidationResult` gains an `information` array to carry it. It is
  deliberately kept out of `warnings`: a caller who fails a build on a non-empty
  `warnings` array should not be stopped by a finding the official validator
  raises and then accepts. `BR-DE-TMP-32` is the first rule to use it.

- **Generation** — `cac:AllowanceCharge` at document and line level with a
  literal `true`/`false` `ChargeIndicator`; `cac:PayeeParty`;
  `cac:TaxRepresentativeParty`; `cac:BillingReference`; `cac:InvoicePeriod` at
  both levels; `cbc:TaxCurrencyCode` and a second `cac:TaxTotal` carrying BT-111;
  `cbc:AccountingCost` at both levels; `cac:ProjectReference`,
  `cac:ContractDocumentReference`, `cac:DespatchDocumentReference`,
  `cac:ReceiptDocumentReference`, `cac:OriginatorDocumentReference`,
  `cac:OrderReference/cbc:SalesOrderID` and `cac:OrderLineReference`;
  `cac:AdditionalDocumentReference` for BT-18 (`DocumentTypeCode` 130) and for
  BG-24, including an embedded base64 attachment with `@mimeCode` and
  `@filename`; item identifiers, `cac:OriginCountry`,
  `cac:CommodityClassification`, `cac:AdditionalItemProperty`; `cac:CardAccount`
  and `cac:PaymentMandate`; a price allowance on `cac:Price` for BT-147/BT-148;
  `cbc:AllowanceTotalAmount`, `cbc:ChargeTotalAmount`, `cbc:PrepaidAmount` and
  `cbc:PayableRoundingAmount`.

  BT-90, the SEPA creditor identifier, is emitted as the *seller's*
  `cac:PartyIdentification/cbc:ID` with `schemeID="SEPA"` rather than anywhere
  near the mandate — that is where EN 16931's UBL binding puts it and where
  BR-DE-30 looks for it.

  Element order was taken from `UBL-Invoice-2.1.xsd` and
  `UBL-CommonAggregateComponents-2.1.xsd`, and **all three fixtures validate
  against the UBL 2.1 XSD** (`xmllint --schema`). Sequence order is part of
  schema validity in UBL, and a new element in the wrong slot fails the XSD
  before any schematron sees it.

- **A third fixture — `fixtures/xrechnung-ubl-discount.xml`**, from
  `discountedXRechnung`: a German Schlussrechnung with a line allowance, a
  document allowance and a document charge in the 19% group, two VAT rates, an
  invoicing period instead of a delivery date, a reference to the
  Abschlagsrechnung it settles, a prepayment, and a rounding amount that takes
  the payable figure to a whole euro. This is the case the audit said the model
  could not express. Its arithmetic: BT-106 1 869.80, BT-107 53.10, BT-108
  24.90, BT-109 1 841.60; breakdown S 19% on 1 741.80 → 330.94 and S 7% on 99.80
  → 6.99; BT-110 337.93, BT-112 2 179.53, BT-113 500.00, BT-114 0.47, BT-115
  1 680.00.

- **The Peppol BIS Billing 3.0 rule tail** — `src/rules-peppol.ts`, 36 rule ids,
  every one of them gated on `profile === "peppol-bis-3"` and every message
  saying so. Peppol is a CIUS *and* a network, and the rules divide along that
  line. Half narrow EN 16931 the way XRechnung does: `R003` (a buyer reference
  or an order reference must be present, because the document is being
  delivered straight into an accounts-payable system that has to match it
  against something), `R005` (a VAT accounting currency that equals the invoice
  currency states a situation and then contradicts it), `R041`/`R042` (a
  percentage and a base amount travel together, in both directions, so that
  `R040` can check the multiplication), `R040` itself, `R046` (BT-146 =
  BT-148 − BT-147, with no tolerance at all), `R055` (BT-110 and BT-111 share
  an operational sign — an exchange rate scales a number, it never flips it),
  `R061` (a direct debit names its mandate), `R110`/`R111` (a line period sits
  inside the document period, which is the one rule in the set that catches
  double billing), `R120` and `R121`.

  The other half exist because an access point is about to route on a
  participant identifier. `PEPPOL-EN16931-CL008` is the scheme list — **not the
  same list as `BR-CL-25`**, which is the surprise: `BR-CL-25` is the CEF
  Electronic Address Scheme *register*, `CL008` is the subset the network
  resolves, and a code in the first and not the second gives you a document
  that passes every validator you can run locally and is refused at the edge.
  `PEPPOL-COMMON-R040` .. `R050`, `R052` and `R053` are the thirteen national
  identifier checks behind it — GLN mod-10, the Norwegian modulus-11, the
  Danish CVR and its two secondary spellings, the Belgian modulus-97, the
  Swedish Luhn, the Australian modulus-89, the Italian Codice Fiscale and
  Partita IVA in both their party and endpoint scheme spellings. These catch
  the transposed digit that EN 16931, XRechnung and your own test suite all
  wave through. Severities are the schematron's own, not levelled: the Italian
  and secondary Danish schemes are `warning`, the rest `fatal`.

  Plus the process rules `P0100` (billing process 01 admits 26 of the UNTDID
  1001 codes — a *different* narrowing from `BR-CL-01` and from XRechnung's
  `BR-DE-17`, so passing one says nothing about the others) and `P0112` (type
  codes 326 and 384 are confined to domestic German exchanges), and the seven
  `P0104`..`P0111` pairs, where a VATEX code whose meaning *is* a category —
  `VATEX-EU-AE` means reverse charge — must sit on that category.

- **`PEPPOL-EN16931-CL007`, and the reason it is not a duplicate.** Peppol keeps
  its own copy of ISO 4217, and as of this ref the two lists have drifted: Peppol
  still admits `ANG` and `BGN`, which the CEN list has retired, and does not yet
  admit `XCG`, which the CEN list has added. So a Peppol invoice in `XCG` passes
  `BR-CL-04` and fails `CL007`, and one in `BGN` does the reverse. Both lists
  ship (`PEPPOL_CURRENCY_CODES` alongside `CURRENCY_CODES`) and both rules are
  implemented. `scripts/build-peppol.mjs` found this: it asserts that the five
  Peppol code-list rules this package does *not* re-implement (`CL001`, `CL002`,
  `CL003`, `CL006`, `CL007`) still carry byte-identical literals to the CEN
  lists already generated, and it failed the build on `CL007` rather than
  letting the divergence ship silently. The other four still mirror, and the
  script will fail again the day one of them stops.

- **`scripts/build-peppol.mjs`** — fetches `PEPPOL-EN16931-UBL.sch`, emits
  `src/codelists/peppol.ts` (the 94-code participant scheme list and the
  179-code currency list), verifies the four mirrored lists above, and **fails
  the build if the schematron carries a `PEPPOL-EN16931-R*` or
  `PEPPOL-COMMON-R*` id this package has never triaged**. A new Peppol rule can
  no longer arrive unnoticed; it has to be implemented or explicitly deferred.

- **VAT categories `L` (IGIC, Canary Islands) and `M` (IPSI, Ceuta and
  Melilla)**, with their full `BR-AF-01`..`BR-AF-10` and `BR-AG-01`..`BR-AG-10`
  families — 20 rules. The reference schematron defines both at exactly the
  level it defines `BR-S-*`, so the assessment was straightforward: they are
  real, and the per-category machinery generalised to them with a table entry
  each. Two things about them are not like `S`, and both are traps:

  - **The rule id does not follow the category code.** `L` → `BR-AF-*`,
    `M` → `BR-AG-*`, alongside the `K` → `BR-IC-*` case that was already there.
    `CATEGORY_RULE_INFIX` in `rule-kit.ts` is now the only place a rule id is
    derived from a category, and it says so.
  - **The rate may be exactly zero.** `BR-AF-05` and `BR-AG-05` read "shall be 0
    (zero) or greater than zero", where `BR-S-05` demands strictly greater —
    IGIC has a genuine 0% band. What they do not admit is an *absent* rate: a
    missing rate and a rate of zero are different claims about a tax that is
    actually levied.

  IGIC and IPSI are not VAT. They are separate indirect taxes that apply because
  the Canary Islands, Ceuta and Melilla sit outside the EU VAT area, so an
  invoice using `S` for a Canarian supply claims to have charged a tax that does
  not exist there. `BR-AF-10`/`BR-AG-10` forbid an exemption reason on both, for
  the same reason `BR-S-10` does: nothing is exempt.

- **Tests — 783, up from 605**, in 14 files. Two are new:
  `rules-peppol.test.ts` (134) and `rules-regional.test.ts` (42). Every Peppol
  rule is asserted twice — that it fires on `peppol-bis-3`, and that it stays
  silent on `xrechnung-ubl` given byte-identical data — because a Peppol rule
  firing on the wrong profile is an over-rejection that makes the caller
  "correct" a document which was already right for its target. The invariant
  battery grew by 36 cases and now holds all 251 reachable rule ids to the full
  `TeachingError` contract; a new assertion pins down that no `PEPPOL-` id
  appears outside the Peppol profile except `R010`/`R020`, and that where they
  do appear they carry `warning` rather than the `fatal` they carry on Peppol.

### Fixed

The entries below the horizontal rule were found during 0.2.0 development. The
ones above it were found by a fourth, adversarial pass over the finished rule
set, re-reading every family clause-by-clause against the official schematron
(CEF `EN16931-model.sch` + the UBL binding, KoSIT XRechnung 3.0.2, OpenPEPPOL
3.0.20) rather than against the prose of the rules. Every defect in that pass
shares one shape: the code matched a *plausible paraphrase* of the rule and not
its executable test. Three of them let invalid documents through, two rejected
valid ones, and one crashed.

- **`validateInput` threw a `TypeError` instead of returning findings when
  `lines` was missing.** `usesCategory` read `inv.lines.some(...)` unguarded, so
  `validateInput({})`, `lines: null` and `lines: "x"` all crashed out of the
  rule run before a single finding was produced. `lines` is required by the
  type, but `validateInput` exists precisely for payloads a type checker never
  saw — a JSON body off an HTTP request is the likeliest input this package
  gets, and a missing `lines` is the likeliest thing wrong with it. That is the
  one case where the package's whole proposition, a teaching error rather than a
  stack trace, was reversed. All line access now goes through a `linesOf()`
  normaliser, and BR-16 reports the problem as it always should have.

- **Impossible calendar dates validated clean and produced schema-invalid XML.**
  BT-2 was matched against a shape regex, `^\d{4}-\d{2}-\d{2}$`, which
  `"2026-02-30"`, `"2026-13-01"` and `"2025-02-29"` all satisfy. BT-9, BT-7,
  BT-72, BT-26 and the line periods BT-134/BT-135 had no format rule at all, so
  `"not-a-date"` in `dueDate` passed too. UBL types every one of these elements
  `xs:date`: the value was written straight through and the emitted document
  failed XSD validation (confirmed with `xmllint` against UBL-Invoice-2.1.xsd),
  which is the one failure a library promising "JSON in, compliant XML out" must
  never cause. Every date term is now checked against the calendar, reported as
  `PEPPOL-EN16931-F001` on the Peppol profile — where the rule is stated
  explicitly and is fatal — and as `ATW-DATE-NOT-A-CALENDAR-DATE` elsewhere,
  since core EN 16931 delegates it to the schema and there is no `BR-*` to cite.

- **`BR-O-11` and `BR-O-12` missed category O entirely when it arrived on a
  document level allowance or charge.** Both official tests are gated on the
  *breakdown* containing an `O` group — `exists(cac:TaxTotal/cac:TaxSubtotal/
  cac:TaxCategory/cbc:ID = 'O')` — not on a line carrying BT-151 = `O`. Since
  0.2.0 gave BG-20 and BG-21 their own VAT category, an allowance in category O
  beside standard-rated lines produces exactly that breakdown, and the reference
  validator rejects it with two fatals. We returned a completely clean result.
  Both rules now gate on `usesCategoryAnywhere`; BR-O-12 additionally stays
  silent when no invoice line is the offender, since it is a rule about lines.

- **`ATW-VAT-CATEGORY-UNSUPPORTED` had the same hole, reopened by this
  release.** The rule was written to stop an unmodelled `"B"` reaching the XML
  unchecked, but it read BT-151 only. Giving BG-20/BG-21 their own category
  meant a `"B"` allowance validated clean and was emitted as a `B` breakdown
  group — the exact scenario the rule exists to prevent. It now checks BT-95 and
  BT-102 as well as BT-151.

- **`BR-DE-16` rejected invoices sold through a fiscal representative.** The
  official test ends `or (cac:TaxRepresentativeParty, $BT-31orBT-32Path)` — BG-11
  satisfies the rule on its own. A seller trading through a tax representative
  legitimately has neither BT-31 nor BT-32, and we refused the document outright.
  Our own message already said BG-11 was an alternative; the code did not
  implement it. The same rule was also armed by BT-151 only, where the official
  trigger is `$BT-95 or $BT-102 or $BT-151`, so a document whose lines were all
  category O but whose freight charge was standard-rated passed us and was
  rejected by the portal. Both clauses now match.

- **`BR-DE-26` demanded BT-25 where KoSIT asks only for the group.** The official
  test is `cac:BillingReference/cac:InvoiceDocumentReference` — the element, not
  its content — and our generator writes that element for every entry in
  `precedingInvoices`. Requiring a non-blank `invoiceNumber` raised a warning
  against a document the reference validator accepts. The blank number is BR-55's
  business, and BR-55 is fatal, so nothing is let through by the correction.

- **`BR-DE-TMP-32` fired on a document with no lines, and stayed silent on an
  empty period.** The official test is `every $line in (cac:InvoiceLine)
  satisfies $line/cac:InvoicePeriod`, and XPath's `every` over an empty sequence
  is vacuously *true* — a `lines.length > 0 &&` guard turned that into a
  failure, adding a wrong finding on top of the BR-16 that already rejects such
  a document. In the other direction, the rule tested `if (inv.invoicingPeriod)`
  by object identity, so `invoicingPeriod: {}` satisfied it while the generator
  — which builds the element with a helper that drops it when every child is
  empty — wrote no `cac:InvoicePeriod` at all, producing precisely the document
  the rule is about. Both now mirror what is actually emitted.

- **`PEPPOL-EN16931-P0110` was omitted on an inverted premise.** The code
  documented its absence by claiming the rule "appears in the CII binding and
  not the UBL one". It is the other way round: P0110 is in
  `PEPPOL-EN16931-UBL.sch` at `flag="fatal"` and is not in the CII binding at
  all. So `VATEX-EU-I` with a category other than `E` passed us and is rejected
  by the Peppol validator — and the comment was the reason nobody re-checked
  across three waves. Implemented, and the comment now records what actually
  happened.

- **The IBAN MOD-97 upper-cased the whole string; the official expression
  upper-cases only the country code.** KoSIT computes `concat(substring(s,5),
  upper-case(substring(s,1,2)), substring(s,3,2))` and feeds the BBAN to
  `string-to-codepoints` exactly as written, so a lowercase BBAN letter maps to
  42…67 rather than 10…35 and the checksum fails. We accepted
  `"NL91abna0417164300"` and `"GB82wesT12345698765432"`, which the reference
  validator rejects, and the shape regex admits a mixed-case BBAN so the path
  was reachable. ISO 13616 defines the IBAN in upper case: a lowercase one is
  not a formatting preference, it is a different string. Verified against 13
  real IBANs including the 31-character Maltese and Seychelles forms.

- **`BR-DE-28` implemented the rule's German prose rather than its regex.** The
  executable test is `$XR-EMAIL-REGEX` = `^[^@\s]+@([^@.\s]+\.)+[^@.\s]+$`. The
  hand-coded version diverged in both directions: it rejected `"a@b.de"` and
  `"ab.@example.de"` (the "at least two characters either side" and "no trailing
  dot" clauses exist only in the message text) and accepted `"user@localhost"`
  and `"user@example..de"` (the regex requires at least one dot-terminated,
  non-empty domain label). The regex is now transcribed verbatim.

- **A whitespace-only `payment.iban` made the generator and the rules
  disagree.** `BR-DE-24-b`/`BR-DE-25-b` test BG-17's presence with `blank()`,
  but the generator gated on bare truthiness — so `iban: "   "` emitted an empty
  `cac:PayeeFinancialAccount` that the rules could not see, and a card or
  direct-debit invoice we validated clean carried the very group those rules
  forbid. The generator is now blank-aware, matching the definition of "present"
  used everywhere else.

- **The Peppol allowance/charge rules named the wrong business terms.** One
  rule body serves BG-20, BG-21, BG-27 and BG-28, and the four name their
  amount, base amount and percentage with twelve different BT ids. `R040`,
  `R041` and `R042` hard-coded the BG-20 triple for all four, so a finding
  against a line charge was reported against BT-93/BT-94 — terms belonging to a
  document level allowance — while its `xpath` correctly pointed at
  `cac:InvoiceLine/cac:AllowanceCharge`. The two fields contradicted each other.
  The triple is now carried per entry.

- **The `-b` payment rules named the wrong business term.** `BR-DE-23-b` is a
  finding about BG-18 or BG-19 being present, and was reported against BG-17 —
  the group the payment means code *allows*. The `xpath` correctly pointed at
  the offender, so the two fields contradicted each other. `field` is now
  derived from the groups actually found.

- **`BR-CO-17`'s fix text blamed the library for the caller's VAT rate.** The
  rule's first branch is `round(BT-119) = 0` using XPath's round-to-nearest-
  integer, so any rate below 0.5% demands a tax amount that also rounds to zero —
  which a genuine 0.4% rate on a large base cannot satisfy. This is a defect in
  the reference schematron, faithfully reproduced, but the fix told the user to
  file a bug against us and offered nothing actionable. It now explains the trap
  and gives the caller something to do about it.

- **`BR-DEC-15`'s fix text contradicted the generator.** It said the library
  "does not round it for you" for BT-111, while the generator writes every amount
  through `formatAmount`, which rounds half-up to two decimals. The advice — fix
  the figure at source, because which rounding is correct is a tax question — is
  unchanged and still right; the claim about what the code does is now accurate.

---

- **Nine `fix`/`example` texts gave advice that was wrong, or that this
  library's own rules reject.** No fix text named a non-existent field this
  round — the recurring defect had moved. What a full sweep of all 509 fix and
  example strings found instead was `example:` strings left un-templated beside
  a `fix:` that was templated, so the two contradicted each other:
  `BR-S-10`/`BR-Z-10`/`BR-AF-10`/`BR-AG-10` told the caller to *remove* an
  exemption reason and then demonstrated *adding* one, for the wrong category;
  `BR-CL-07` showed the document-level field name on the line-level path;
  `BR-CL-22` was hardcoded to category `AE`, and for S/Z/L/M told the caller to
  set a VATEX code that `BR-S-10` and its siblings then forbid — two of our own
  rules giving opposite advice on one payload. `BR-AF-05`/`BR-AG-05` described
  the Canary Islands and the IGIC band table for category M, which is IPSI in
  Ceuta and Melilla and uses neither. `BR-DE-24-a`/`BR-DE-24-b` offered 12- and
  16-character card numbers that our own `BR-51` rejects at 10.
  `PEPPOL-EN16931-R046` recommended a negative unit price ("Set
  lines[0].unitPrice to -98") that `BR-27` rejects outright. `BR-DE-17` offered
  `"381"` without the caveat that this build refuses it. `BR-09`/`BR-11` led
  with `"EL"` for Greece, which fails our own `BR-CL-14`. `BR-DE-1` called
  UNTDID 4461 code 57 "standing order" rather than "standing agreement". All
  corrected, and every quoted code literal across the whole rule set was
  machine-checked against the codelist that would validate it.

- **The README Quickstart did not compile.** `as const` made `lines` a readonly
  tuple, which is not assignable to `InvoiceInput["lines"]`, so the package's
  first code sample produced two errors under `tsc --strict` — at both
  `validateInput` and `generateXRechnungUBL`. It now uses `satisfies
  InvoiceInput`, verified against the built `dist/`.

- **`package.json` declared `0.1.1`** while the README and this changelog
  described 0.2.0 throughout.

- **A line with VAT category `"B"` validated completely clean.** `B` (split
  payment, Italy) is on the BR-CL-17/BR-CL-18 code list, so the code-list rules
  passed it; it was absent from the `VatCategory` union, so no per-category
  family claimed it either. Between the two, a JavaScript caller — or any JSON
  payload arriving over HTTP, where TypeScript's union is not enforced — could
  set `"B"` and receive an empty `ValidationResult`, then generate a document
  with a `B` breakdown group that nothing in this package had checked and that
  Italy's own rules would have had a great deal to say about. Split payment
  means the buyer pays the VAT directly to the Agenzia delle Entrate, so the
  invoice states VAT the seller will never receive; getting it wrong sends money
  to the wrong party. It is now a fatal `ATW-VAT-CATEGORY-UNSUPPORTED` finding.
  The same shape of gap for `L` and `M` is closed by implementing them.

- **`BR-DE-17` was fatal; KoSIT flags it `warning`.** The German text says
  "sollen", not "müssen", and the reference schematron carries `flag="warning"`.
  0.1.x therefore rejected documents the official validator accepts — an
  over-rejection, which for a compliance engine is as serious as a miss: the
  caller changes a correct invoice to satisfy a rule that was never binding. It
  is a warning now, with a message that explains what the eight listed type
  codes actually buy you. `BR-DE-26` was already correct.
- **`BR-IC-02` and `BR-G-02` accepted the seller tax registration identifier
  (BT-32).** Both rules admit only the seller's VAT identifier (BT-31) or the
  tax representative's (BT-63). BT-32 satisfies `BR-S-02`, `BR-Z-02`, `BR-E-02`
  and `BR-AE-02` — and not those two, because an intra-community supply and an
  export are zero-rated on the strength of a VAT identification number and a
  Steuernummer is not one. A German seller with a Steuernummer and no USt-IdNr.
  passed here and was rejected by the regulator's own validator.
- **Fix texts named paths the model did not have.** `BR-27` told the reader that
  line allowances were not implemented; `BR-DE-26` told them to put the preceding
  invoice number in a free-text note; `BR-DE-24-a` and `BR-DE-25-a` said the
  library could not emit BG-18 or BG-19. All four are implemented in this
  release, and each fix now names the field to set.
- **`posOf` in the generator test suite matched a prefix.** `cbc:TaxExemptionReason`
  and `cbc:TaxExemptionReasonCode` reported the same position, so any ordering
  assertion over such a pair was a tautology that would have passed whatever the
  generator emitted. The match is anchored now; the pre-existing assertions still
  hold.

### Changed

- The `"information"` severity is additive, but a consumer that allow-lists
  severities — `['fatal', 'warning']` in a switch or a filter — needs a third
  entry, or it will drop findings it used never to receive.
- `BT-131` is now quantity × (net price / base quantity) − Σ line allowances +
  Σ line charges, and the BG-23 taxable amount per (category, rate) group nets
  document allowances out and document charges in. `BT-107` = Σ BT-92,
  `BT-108` = Σ BT-99, `BT-109` = BT-106 − BT-107 + BT-108, and
  `BT-115` = BT-112 − BT-113 + BT-114. BT-107 and BT-108 stay separate sums and
  do not net against each other even though the breakdown nets them; that
  asymmetry is the standard's, and it is deliberate — the two totals are
  disclosures, the breakdown is the tax base.
- `InvoiceTotals` gains `allowanceTotalAmount`, `chargeTotalAmount`,
  `paidAmount` and `roundingAmount`; `TaxSubtotal` gains `exemptionReasonCode`.
- **`VatCategory` gains `"L"` and `"M"`.** Additive for anyone passing a value
  in, but a `switch` or `Record<VatCategory, …>` that enumerates the seven old
  codes will now fail to compile until the two new ones are handled — which is
  the point: `ALL_CATEGORIES`, `CATEGORY_NAMES` and `CATEGORY_RULE_INFIX` are
  exhaustive records, so the compiler names every site that has to be updated
  rather than letting one silently fall through to a default branch.
  `REASON_FORBIDDEN_CATEGORIES` is now exported from `totals.ts` and consumed by
  `rules-vat.ts`, so the function that drops an exemption reason and the rule
  that reports it dropped cannot disagree.
- Bundle: `dist` is **121.8 kB gzipped**, 477.4 kB raw (`cat dist/**/*.js`),
  up from 98.7 kB / 387 kB at the end of wave B. The Peppol rule family and its
  two code lists are the whole of the delta. The npm tarball is 171.8 kB across
  77 files. `tsc --removeComments` produces 387.5 kB raw, so roughly 90 kB of
  the shipped source is prose — deliberately, since the rule files are where the
  reasoning lives.

### Not verified in this release

**The KoSIT conformance check has not been run for 0.2.0**: the build machine has
no Java runtime (`java -version` fails), and the validator is a Java program.
The XSD validation that *was* run proves element order and schema validity, and
says nothing about the schematron — which is where every EN 16931 and XRechnung
rule lives. Before publishing, run from `packages/en16931`:

```bash
./scripts/kosit-check.sh          # or JAVA_BIN=/path/to/bin/java ./scripts/kosit-check.sh
```

It validates all three committed fixtures against validator 1.6.2 with the
XRechnung 3.0.2 configuration.

**Nor has the Peppol rule family been run against OpenPEPPOL's own validator**,
for the same reason — it is the same Java program with a different
configuration, and there is no committed `peppol-bis-3` fixture to run it
against. The rule semantics in `src/rules-peppol.ts` were taken from
`PEPPOL-EN16931-UBL.sch` directly, including the four checksum algorithms, which
are transcribed from the XSLT functions `u:gln`, `u:mod11`, `u:mod97-0208`,
`u:checkSEOrgnr`, `u:abn`, `u:checkPIVA`, `u:checkCF` and `u:checkCodiceIPA`
rather than from a description of them. That is verification against the source
of truth, not against the reference implementation running on real documents,
and the difference matters: a transcription can be faithful and still disagree
on an input neither of us thought of. Adding a Peppol fixture and a
`peppol-check.sh` is the obvious next step.

### Deferred

Named here rather than silently skipped, because a rule this package does not
implement is a rule a reader should not assume it implements. With wave C this
list is closed: every remaining entry falls into one of five categories, and
"hard, so skipped" is not among them.

**Generator-controlled, and therefore not falsifiable from the input model.**
These constrain XML that `generateXRechnungUBL` writes from the profile and the
model rather than echoing from the caller, so a rule function for them would
assert `true`. They belong to a future entry point that reads XML.

- `BR-01`, `BR-DE-13`, `BR-DE-21` — BT-24 is derived from `profile`, and the
  only override is `GenerateOptions.customizationId`, which `validateInput`
  never sees.
- `PEPPOL-EN16931-R001`, `R004`, `R007` — the `ProfileID`, its format, and the
  `CustomizationID` prefix, all three emitted from `profile`.
- `PEPPOL-EN16931-R008` (no empty elements — the generator omits rather than
  emits empty), `R043` (the literal `true`/`false` on `ChargeIndicator`),
  `R044` (a price-level allowance is always an allowance here, never a charge),
  `R051` (every `currencyID` comes from BT-5), `R053`/`R054` (the number of
  `cac:TaxTotal` elements), `R101` (the `130` on a line document reference),
  `R130` (the unit code on `cbc:BaseQuantity` is the line's own).
- `PEPPOL-EN16931-R002`, `R080`, `R100` — cardinality limits ("at most one
  note", "at most one project reference", "at most one invoiced object per
  line") on fields this model makes scalar. One field, one element, so the
  count is one by construction.
- `PEPPOL-EN16931-CL001`, `CL002`, `CL003` and `CL006` are a fifth shape of the
  same thing: their lists are byte-identical to `BR-CL-24`, `BR-CL-19`,
  `BR-CL-20` and `BR-CL-06`, which are implemented, so reporting both ids for
  one defect would be noise. `scripts/build-peppol.mjs` asserts the identity on
  every run and fails the build if any of the four ever drifts — which is
  exactly what it did for `CL007`, now implemented separately.

  `PEPPOL-EN16931-F001` was listed here too, on the claim that "F001's date
  format is already enforced on every date term". It was not: only BT-73 and
  BT-74 were checked against the calendar, and BT-2 was matched against a shape
  regex that accepts `"2026-02-30"`. It is now implemented — see **Fixed** — and
  is no longer deferred.

**Upstream binds them to `true()`, so the regulator does not test them either.**

- `BR-CO-05`, `BR-CO-06`, `BR-CO-07`, `BR-CO-08` — "the reason code and the
  reason text shall indicate the same type of allowance". No mechanical test
  exists. `BR-CO-25` is absent from the reference schematron and from Peppol's,
  so implementing it would reject documents the authority accepts.

**Documents this build does not produce.**

- **Credit notes** — still `ATW-CREDIT-NOTE-UNSUPPORTED`; a UBL credit note is a
  separate `CreditNote` document, not an `Invoice` with a different BT-3. This
  also defers `PEPPOL-EN16931-P0101` (credit-note type codes) and the
  credit-note halves of `BR-CL-01`.
- **CII syntax and Factur-X**, and with them `PEPPOL-EN16931-R006` and `P0110`,
  which appear in the CII binding and not the UBL one. Implementing `P0110`
  would reject documents the Peppol UBL validator accepts.
- **The XRechnung Extension and CVD profiles**: `BR-DEX-*` and `BR-DE-CVD-*`,
  which apply to customization ids this build does not emit.
- **National Peppol rule sets** — `NO-R-*`, `DK-R-*`, `SE-R-*`, `IT-R-*`,
  `NL-R-*`, `GR-R-*`, `IS-R-*` and the `DE-R-*` set in Peppol's own file. These
  are country-specific overlays that apply on top of the BIS rules, and each is
  a project of its own; a document this library accepts is checked against the
  core, XRechnung and Peppol BIS rule sets, not against a receiving country's
  additional national requirements.

**One category the model deliberately does not express.**

- **VAT category `B` (split payment, Italy)** — refused with a fatal
  `ATW-VAT-CATEGORY-UNSUPPORTED` rather than accepted silently. `L` and `M` ship
  in this release because the reference schematron gives each a full ten-rule
  family at the same level as `BR-S-*`; `B` has only `BR-B-01` and `BR-B-02`,
  and both exist purely to confine it — to domestic Italian invoices, and to
  documents where it is the only category. Adding it to `VatCategory` would mean
  either emitting `BR-B-05`/`BR-B-08`/`BR-B-09` ids the regulation does not
  define, or carving `B` out of every per-category loop in six files for the
  sake of two checks. The real constraints on a split-payment invoice live in
  Italy's `IT-R-*` national rules and in FatturaPA, neither of which this build
  implements, so accepting `B` would be the more misleading choice.

**Validating existing XML** — `validateInput` covers the JSON input model only.
`TeachingError.xpath` is populated throughout in anticipation of it.

## [0.1.1] — 2026-08-09

Stops two ways the library could hand back a document that no validator would
accept, and corrects the packaging and the claims made for it.

### Fixed

- **`generateXRechnungUBL` silently emitted UBL for CII profiles.** Passing
  `xrechnung-cii` or `facturx-en16931` produced an `ubl:Invoice` carrying an
  XRechnung `CustomizationID` — a file that passes nothing, delivered as if it
  had worked. Generation now throws `UnsupportedProfileError` naming the three
  profiles it can emit (`en16931`, `xrechnung-ubl`, `peppol-bis-3`) and
  explaining that CII (and Factur-X, CII inside a PDF/A-3) is a different syntax
  with no generator yet. An unknown profile throws the same error instead of
  falling back to the XRechnung defaults.
- **`invoiceTypeCode: "381"` validated clean and generated an invalid document.**
  A UBL credit note is a separate `CreditNote` document (root `ubl:CreditNote`,
  `cac:CreditNoteLine`, `cbc:CreditedQuantity`), not an `Invoice` with a
  different BT-3, so the emitted `ubl:Invoice` was rejected by the EN 16931
  schematron. Credit-note type codes are now a fatal validation finding
  (`ATW-CREDIT-NOTE-UNSUPPORTED`) and generation throws
  `UnsupportedDocumentTypeError`. Writing the `CreditNote` generator is the
  proper fix and is on the roadmap; refusing is the honest interim.
- **`repository`, `homepage` and `bugs` pointed at a repository that does not
  exist** (`attestwire/einvoice`). All three now point at
  `https://github.com/attestwire/en16931`, which is where the source is.
- **`publishConfig.access: "public"` was missing** from the monorepo copy of the
  manifest, so a publish from a fresh checkout could fail or default wrongly for
  a scoped package.
- **`fixtures/` is included in the npm tarball.** The README refers to the
  fixtures; 0.1.0 shipped `dist` only.

### Added

- `UBL_GENERATABLE_PROFILES`, `CREDIT_NOTE_TYPE_CODES`, and the error classes
  `GenerationError`, `UnsupportedProfileError`, `UnsupportedDocumentTypeError`
  are exported. Each error carries a stable `code`
  (`unsupported_profile` / `unsupported_document_type`) matching the hosted
  API's error codes, so both layers can be handled uniformly.
- Tests for both refusals, and for the profiles and type codes that must keep
  working: 137, up from 129.

### Changed

- **Documentation corrected.** The rule set is **61** rules, not "~30" — counted
  from the rule IDs `src/rules.ts` actually emits, and matching the list the
  README already enumerated. The KoSIT script is described as a conformance
  check on the two release fixtures rather than a "parity suite"; it validates
  two documents and says nothing about the rest of the rule set. The root
  monorepo README no longer claims CII generation, Factur-X, or validation of
  existing XML — `validateInput` covers the JSON input model only.

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
- **Rule set expanded from 4 to 61 rules**, each with the official rule ID, the
  business terms it constrains, a message that explains the reason, a concrete
  fix, an example and a `docsUrl`:
  - Mandatory document fields: `BR-02`, `BR-03`, `BR-05`, `BR-06`, `BR-07`,
    `BR-08`, `BR-09`, `BR-10`, `BR-11`, `BR-16`, `BR-CO-26`.
  - Per-line fields: `BR-21`, `BR-22`, `BR-23`, `BR-25`, `BR-26`, `BR-27`.
  - VAT category consistency: `BR-S-02`, `BR-S-05`, `BR-Z-02`, `BR-Z-05`,
    `BR-E-02`, `BR-E-05`, `BR-E-10`, `BR-AE-02`, `BR-AE-05`, `BR-IC-02`,
    `BR-IC-05`, `BR-IC-11`, `BR-IC-12`, `BR-G-02`, `BR-G-05`, `BR-O-02`,
    `BR-O-05`.
  - Arithmetic against caller-declared totals: `BR-CO-10`, `BR-CO-13`,
    `BR-CO-14`, `BR-CO-15`, `BR-CO-16`, reporting the exact delta.
  - VAT identifier prefixes: `BR-CO-09`, including the Greek `EL` derogation.
  - XRechnung CIUS: `BR-DE-1`, `BR-DE-2`, `BR-DE-3`, `BR-DE-4`, `BR-DE-5`,
    `BR-DE-6`, `BR-DE-7`, `BR-DE-8`, `BR-DE-9`, `BR-DE-10`, `BR-DE-11`,
    `BR-DE-15`, `BR-DE-16`, `BR-DE-17`, `BR-DE-27`, `BR-DE-28`.
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
- **KoSIT conformance check** — `scripts/kosit-check.sh` downloads the official
  validator and XRechnung configuration and validates the two fixtures; results
  and scope caveats in `scripts/kosit-check.md`. Two documents, not a parity
  suite over the rule set.
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
[0.1.1]: https://github.com/attestwire/en16931/releases/tag/v0.1.1
