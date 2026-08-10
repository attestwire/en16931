# Changelog

All notable changes to `@attestwire/en16931`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 0.2.0

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
