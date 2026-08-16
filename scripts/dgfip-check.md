# DGFiP Flux 1 schema check (spécifications externes v3.2)

An external review claimed that all eleven committed fixtures fail the official
French Flux 1 base schemas — six CII against the French D22B CII schema, five
UBL against the French UBL base schemas — and attributed it to element-order and
profile mismatches. This reproduces that claim against the artefacts the DGFiP
actually publishes.

The claim is **correct on the verdict and incomplete on the cause**, and the
difference matters more than the verdict does. Three things could produce these
failures, and they are worth wildly different amounts of work:

- **(a) a defective document** — we emit something no syntax allows;
- **(b) a D16B-vs-D22B mismatch** — we emit the wrong CII version, and France
  wants a different one;
- **(c) a profile mismatch** — the document is fine and is simply not the
  profile being asked for.

Every one of the 22 fixture × profile combinations is **(c)**. Not one is (a),
and — this is the load-bearing measurement — not one is (b), because the French
"D22B" CII schema accepts D16B content outright. Details below, with the
evidence for each.

## Running it

```bash
./scripts/dgfip-check.sh
```

Requires `xmllint` and `python3`. No Java. Everything is downloaded into a
scratch directory; nothing is installed system-wide.

| Artefact | Version | Source |
| --- | --- | --- |
| Dossier de spécifications externes B2B, annexes, XSD, swaggers | **v3.2**, published 2026-04-30 | [impots.gouv.fr/specifications-externes-b2b](https://www.impots.gouv.fr/specifications-externes-b2b) → `specifications-externes-v3.2.zip` |
| UN/CEFACT CII D16B modules (the D16B side of the version diff) | XRechnung validator configuration 3.0.2 / 2026-01-31 | [itplr-kosit/validator-configuration-xrechnung](https://github.com/itplr-kosit/validator-configuration-xrechnung/releases), `resources/cii/16b/xsd` |
| libxml2 `xmllint` | 20913 | macOS system |

```
cd8f6e817e37f329e6f62a35aa131b78a51379bec953445b774fa8adbaaa3862  specifications-externes-v3.2.zip   (6 766 301 bytes)
```

The e-invoicing schemas are at `3- XSD_v3.2/2 - E-invoicing/`, in four
directories: `F1_BASE_UBL_2.1`, `F1_FULL_UBL_2.1`, `F1_BASE_CII_D22B`,
`F1_FULL_CII_D22B`. `Base` and `Full` are not two guesses at the same thing —
§3.4.4 n.71 of the *Dossier général* makes them a filename prefix
(`<profil>_<nom_de_fichier>.xml`, "Base" or "Full") and §3.6.3 explains why: a
reduced regulatory data set is required from **2026-09-01**, and is completed at
généralisation. Both profiles were run for every fixture.

The script also prints, per fixture, a **complete** inventory of disallowed
elements. That is not redundant with `xmllint`: `xmllint` stops at the first
unexpected element in a sequence, so it reports one error for a document that
breaks fifty rules. The inventory
(`scripts/dgfip-profile-diff.py`) walks the document against the schema's type
graph instead, and classifies each refusal as `COMMENTED-OUT` (the DGFiP removed
a declaration that UBL 2.1 / CII D22B has) or `ABSENT` (the syntax never had it).
That single distinction is what separates bucket (c) from bucket (a).

## Last recorded result

Run on **2026-08-14** against spécifications externes v3.2, from a clean scratch
directory. All eleven fixtures were validated against both the Base and the Full
profile of their syntax; UBL credit notes were validated against the credit-note
schema, not the invoice one.

**Schema verdicts: 0 pass, 22 fail.** The external review's count is confirmed.

| Fixture | Profile | Schema | First `xmllint` error | Disallowed paths (complete) | `ABSENT` |
| --- | --- | --- | --- | --- | --- |
| `xrechnung-cii-minimal` | Base | `F1BASE_CrossIndustryInvoice_100pD22B` | `ram:IncludedSupplyChainTradeLineItem` | 12 | **0** |
| `xrechnung-cii-minimal` | Full | `F1FULL_CrossIndustryInvoice_100pD22B` | `ram:LineID` | 15 | **0** |
| `xrechnung-cii-reverse-charge` | Base | " | `ram:IncludedSupplyChainTradeLineItem` | 11 | **0** |
| `xrechnung-cii-reverse-charge` | Full | " | `ram:LineID` | 12 | **0** |
| `xrechnung-cii-discount` | Base | " | `ram:IncludedSupplyChainTradeLineItem` | 24 | **0** |
| `xrechnung-cii-discount` | Full | " | `ram:LineID` | 39 | **0** |
| `xrechnung-cii-extended` | Base | " | `ram:IncludedSupplyChainTradeLineItem` | 33 | **0** |
| `xrechnung-cii-extended` | Full | " | `ram:LineID` | 53 | **0** |
| `xrechnung-cii-credit-note` | Base | " | `ram:IncludedSupplyChainTradeLineItem` | 13 | **0** |
| `xrechnung-cii-credit-note` | Full | " | `ram:LineID` | 15 | **0** |
| `xrechnung-cii-credit-note-discount` | Base | " | `ram:IncludedSupplyChainTradeLineItem` | 21 | **0** |
| `xrechnung-cii-credit-note-discount` | Full | " | `ram:LineID` | 36 | **0** |
| `xrechnung-ubl-minimal` | Base | `F1BASE_UBL-invoice-2.1` | `cbc:BuyerReference` | 15 | **0** |
| `xrechnung-ubl-minimal` | Full | `F1FULL_UBL_invoice-2.1` | `cbc:BuyerReference` | 18 | **0** |
| `xrechnung-ubl-reverse-charge` | Base | `F1BASE_UBL-invoice-2.1` | `cbc:BuyerReference` | 15 | **0** |
| `xrechnung-ubl-reverse-charge` | Full | `F1FULL_UBL_invoice-2.1` | `cbc:BuyerReference` | 16 | **0** |
| `xrechnung-ubl-discount` | Base | `F1BASE_UBL-invoice-2.1` | `cbc:AccountingCost` | 27 | **0** |
| `xrechnung-ubl-discount` | Full | `F1FULL_UBL_invoice-2.1` | `cbc:AccountingCost` | 40 | **0** |
| `xrechnung-ubl-credit-note` | Base | `F1BASE_UBL-CreditNote-2.1` | `cbc:BuyerReference` | 18 | **0** |
| `xrechnung-ubl-credit-note` | Full | `F1FULL_UBL_CreditNote-2.1` | `cbc:BuyerReference` | 20 | **0** |
| `xrechnung-ubl-credit-note-discount` | Base | `F1BASE_UBL-CreditNote-2.1` | `cbc:AccountingCost` | 26 | **0** |
| `xrechnung-ubl-credit-note-discount` | Full | `F1FULL_UBL_CreditNote-2.1` | `cbc:AccountingCost` | 39 | **0** |

**518 disallowed paths across the 22 runs. Every one is `COMMENTED-OUT`. Zero
are `ABSENT`.**

The Base CII counts look artificially low next to Full, and the reason is worth
stating rather than leaving as a puzzle: `F1_BASE_CII_D22B` removes
`ram:IncludedSupplyChainTradeLineItem` — the entire line-item block, BG-25 —
so the inventory stops at the block and never counts what is inside it. The
DGFiP's own `Changelog_XSD.md` records that removal as a v3.1→v3.2 change.

### There is no rule-id column, and there should not be

The KoSIT record has one because KoSIT runs schematrons and cites `BR-`/`BR-DE-`
ids. This run is **XSD only**: the DGFiP package ships XML Schema and
spreadsheets, and no schematron for Flux 1. The French business rules live in
`2- Annexes_v3.2/…Annexe 7 - Règles de gestion - V1.9.xlsx` as prose with ids of
the form `G1.01` — 122 of them, 42 flagged applicable to Flux 1 — and nothing in
this package executes them. So there is no French rule id to cite for any
failure above, and inventing one would put words in the DGFiP's mouth. What
`xmllint` cites is `cvc-complex-type.2.4.a`, every time.

## The load-bearing answer: does the French base schema accept D16B?

**Yes. Unreservedly.** This is the fact that sizes a France build, so it was
measured rather than reasoned, by comparing the DGFiP's D22B modules with
UN/CEFACT's D16B modules declaration by declaration, reading *through* the
DGFiP's comment markers so the comparison is against D22B and not against the
French subset (`scripts/dgfip-d16b-d22b-diff.py`).

**1. The namespaces are identical.** There is no namespace to reject:

| Module | D16B `targetNamespace` | D22B |
| --- | --- | --- |
| root | `urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100` | same |
| RAM | `urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100` | same |
| QDT | `urn:un:unece:uncefact:data:standard:QualifiedDataType:100` | same |
| UDT | `urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100` | same |

Only the `version` attribute differs (`100.D16B` → `100.D22B`), and no XML
Schema processor consults it. So a bucket-(b) failure of the
"D16B namespaces are rejected" kind is not merely absent from our results — it
is not a thing that can happen. The one namespace-visible difference in the
whole comparison is a rename of an optional root-level element that is commented
out anyway (`ValuationBreakdownStatement` → `F1_ValuationBreakdownStatement`).

**2. The content models are the same model.**

| Module | D16B declarations | DGFiP D22B declarations | Identical ordered sequence |
| --- | --- | --- | --- |
| root | 6 | 6 | no — the one rename above |
| RAM | 1041 | 1041 | **yes** |
| QDT | 140 | 140 | **yes** |
| UDT | 20 | 20 | **yes** |

Element for element, name for name, in document order. **Zero elements change
position.** Of the 947 element declarations in the RAM module, 915 are
byte-identical and the remaining 32 differ only in cardinality.

That is a stronger result than "backward compatible". For the message this
package emits, the DGFiP's D22B modules and UN/CEFACT's D16B modules are the
*same content model* with a version string bumped and some cardinalities
tightened. The Factur-X 1.09.2 (2026-08-04) claim that D22B is backward
compatible with D16B holds here for a reason more specific than compatibility:
on the invoice message there is nothing to be compatible *with*.

**Migrating this package from D16B to D22B for France is a zero-line change.**
The failures above have nothing to do with the version.

The 32 cardinality changes are real French constraints and are worth reading —
they are requirements a `france-2026` capability inherits. The ones our fixtures
trip:

| Type / element | D16B | DGFiP D22B | What it means |
| --- | --- | --- | --- |
| `LineTradeAgreementType/GrossPriceProductTradePrice` | 0..1 | **1..1** | BT-148 gross price becomes mandatory on every line — we emit net only |
| `LineTradeAgreementType/NetPriceProductTradePrice` | 0..1 | 1..1 | BT-146 mandatory (we already emit it) |
| `SupplyChainTradeLineItemType/SpecifiedTradeProduct` | 0..1 | 1..1 | |
| `SupplyChainTradeLineItemType/SpecifiedLineTradeAgreement` / `Delivery` | 0..1 | 1..1 | |
| `SupplyChainTradeTransactionType/IncludedSupplyChainTradeLineItem` | 0..∞ | **1..∞** | at least one line (Full only; Base removes lines entirely) |
| `TradeAddressType/CountryID` | 0..1 | 1..1 | BT-40/BT-55 mandatory on any address |
| `TradeProductType/Name` | 0..∞ | 1..1 | BT-153 mandatory, and at most one |
| `TradeSettlementHeaderMonetarySummationType/TaxTotalAmount` | 0..∞ | **1..2** | BT-110 mandatory; at most two (document + accounting currency) |
| `HeaderTradeSettlementType/ApplicableTradeTax` | 0..∞ | 1..∞ | at least one VAT breakdown |
| `LegalOrganizationType/ID` / `DocumentContextParameterType/ID` | 0..1 | 1..1 | |

## Bucket analysis

### (a) genuine document defects — **none**

Zero `ABSENT` classifications across 518 disallowed paths. Every element these
fixtures emit is declared by the syntax the French schema was cut from; the
DGFiP commented it out. The independent confirmation is that these same eleven
documents are ACCEPTABLE to KoSIT against stock `UBL-Invoice-2.1.xsd`,
`UBL-CreditNote-2.1.xsd` and the D16B CII schema, recorded in
`scripts/kosit-check.md`. Re-checked directly on 2026-08-14 with the OASIS
UBL 2.1 OS schemas fetched by `scripts/peppol-check.sh`: all five committed UBL
fixtures validate clean against `UBL-Invoice-2.1.xsd` /
`UBL-CreditNote-2.1.xsd`, so a schema that refuses them is narrowing UBL, not
catching us.

One genuine fixture defect *was* found on 2026-08-14, but not by this run: three
of the four GLNs in the fixture set fail their GS1 check digit. That is recorded
in `scripts/peppol-check.md`; the French schemas do not check it.

### (b) D16B-vs-D22B version or namespace mismatch — **none**

Measured above and empty. Same namespaces, same element names, same order, in
all four modules.

### (c) profile mismatch — **all 22**

Every failure is the French Flux 1 profile refusing an element our fixtures
carry because they target the XRechnung CIUS, which nothing in this package has
ever claimed is French. The `peppol-bis-3` and `facturx-en16931` profiles are
equally unrelated to Flux 1; there is no `france-2026` profile and the README
does not offer one.

The size of the gap is the surprising part, and it is not a CIUS-shaped gap.
Here is every element `F1BASE_UBL-invoice-2.1.xsd` still admits:

```
cbc:CustomizationID  cbc:ProfileID  cbc:ID  cbc:IssueDate  cbc:DueDate
cbc:InvoiceTypeCode  cbc:Note  cbc:DocumentCurrencyCode
cac:InvoicePeriod  cac:BillingReference  cac:AccountingSupplierParty
cac:AccountingCustomerParty  cac:TaxRepresentativeParty  cac:Delivery
cac:TaxTotal  cac:LegalMonetaryTotal
```

Sixteen elements. `cac:InvoiceLine` is not among them; neither is
`cbc:BuyerReference` (BT-10), `cac:OrderReference` (BT-13),
`cac:PaymentMeans`, `cac:PaymentTerms` or `cac:AllowanceCharge`. The Full
profile adds exactly two, `cac:AllowanceCharge` and `cac:InvoiceLine`, and still
refuses BT-10, BT-13 and the payment groups. The CII side is cut the same way:
in both profiles `TradeSettlementHeaderMonetarySummationType` retains only
`TaxBasisTotalAmount` and `TaxTotalAmount` — **BT-106, BT-112 and BT-115 are
commented out**, so the French Flux 1 document does not carry a line total, a
grand total or an amount due at all. In `F1FULL`, `ram:LineID` (BT-126) is
commented out too.

A schema that has no invoice total is not a restricted invoice. It is a
different artefact, and reading it as a CIUS is the mistake the review made.
§3.6.3 of the *Dossier général* says what it is: the *données réglementaires*
transmitted to the tax administration, in a `tar.gz`, in UBL or CII. Flux 1 is a
tax filing derived from an invoice, not the invoice the buyer receives. That is
why our documents fail it and why the failure is not interesting on its own.

## What a `france-2026` capability would actually require

Nothing in the list below is a syntax migration, and none of it is fixed by this
run. Sized from the artefacts, not estimated:

1. **A new emitter, not a new profile flag.** Flux 1 Base and Full are two
   distinct reduced documents, each a projection of an EN 16931 invoice onto a
   16-to-18-element schema, with the file named `Base_…xml` / `Full_…xml`. A
   `profile: "france-2026"` that reused `generateXRechnungUBL` would emit
   elements the schema forbids at the second child of the root. Both profiles
   are needed: Base is what is required from 2026-09-01, Full is the target.
2. **Both syntaxes, and the CII one is free of version work.** The D16B
   generator already emits the right namespaces and the right element order; it
   emits too much. The work is subtraction plus the ten cardinality tightenings
   tabulated above, of which only BT-148 gross price is something the generator
   cannot currently produce.
3. **42 French business rules.** `Annexe 7 - Règles de gestion V1.9` carries 122
   rules (`G1.01`…) with a per-flux applicability column; 42 are marked
   applicable to Flux 1. They are prose in a spreadsheet — no schematron ships,
   so every one is a hand implementation with no external judge to check it
   against. That is the opposite of how every rule in this package has been
   validated to date, and it is the single largest risk in a France build.
4. **13 EN 16931 extensions.** `Annexe 1 - Format sémantique FE e-invoicing -
   Flux 1 v1.2` defines 13 `EXT-FR-FE-*` terms beyond the norm. Nine of them are
   also cited in Annexe 7.
5. **A transport and lifecycle layer this package has never had.** Flux 1 is a
   `tar.gz` archive with a naming convention, an interface code, a partner
   application code and a 25-character flow identifier (§3.4.5); rejections come
   back as `IRR_*` irrecevabilité codes; statuses travel in UN/CEFACT CDAR.
   There is also an annuaire (directory) with its own XSDs and an OpenAPI, and a
   separate e-reporting schema set. None of this is XML generation.
6. **Nothing to validate against.** There is no French equivalent of the KoSIT
   validator or the Peppol schematrons in this package. A France capability
   would ship with XSD conformance as its only external evidence, and the 42
   business rules unverified — which, by the standard the rest of this package
   holds itself to, means it would ship as "not verified".

The honest one-line summary: the version question is free, the schema question
is a day, and the business-rule and transport questions are the build.

## Scope of the claim

This run validates eleven documents against four XML Schemas. It does not
execute a single French business rule, because none is executable from what the
DGFiP publishes. It says nothing about e-reporting (Flux 2/6/10), the annuaire,
Chorus Pro, or the PDP accreditation process. It does not establish that a
correctly-shaped Flux 1 document would be *accepted* by the PPF — only that
these eleven, which were never Flux 1 documents, are refused by its schemas for
reasons entirely attributable to the profile.

The UNECE D22B package itself (`CII_D22B.zip`) could not be fetched — unece.org
returned HTTP 403 to every attempt on 2026-08-14 — so the D16B/D22B comparison
above is between UN/CEFACT's D16B as redistributed by KoSIT and UN/CEFACT's
D22B as redistributed by the DGFiP. Both sides are official redistributions;
neither is UN/CEFACT's own download. If that ever matters, it is the one link in
this record to re-check.
