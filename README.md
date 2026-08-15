# @attestwire/en16931

[![CI](https://github.com/attestwire/en16931/actions/workflows/ci.yml/badge.svg)](https://github.com/attestwire/en16931/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@attestwire/en16931.svg)](https://www.npmjs.com/package/@attestwire/en16931)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

**Generate and validate EN 16931 e-invoices — UBL 2.1 and UN/CEFACT CII — with
errors that teach the regulation.**

Zero runtime dependencies, TypeScript-first, and entirely local: installing this
package needs no account and no key, and nothing it does makes a network call.

## Quickstart

```bash
npm install @attestwire/en16931
```

### 1. Validate an invoice

A conformant XRechnung, as small as validity allows. Every identifier here is
synthetic; the IBAN is the test IBAN used throughout German banking
documentation.

```ts
import { validateInput, type InvoiceInput } from "@attestwire/en16931";

const invoice = {
  profile: "xrechnung-ubl",
  invoiceNumber: "2026-000142",
  issueDate: "2026-08-09",
  currency: "EUR",
  buyerReference: "04011000-1234512345-06", // Leitweg-ID
  deliveryDate: "2026-08-31",
  seller: {
    name: "Acme GmbH",
    vatId: "DE123456789",
    address: { line1: "Chausseestr. 1", city: "Berlin", postalCode: "10115", countryCode: "DE" },
    electronicAddress: { schemeId: "0204", value: "04011000-1234512345-06" },
    contact: { name: "Buchhaltung", phone: "+49 30 1234567", email: "rechnungen@acme.example" },
  },
  buyer: {
    name: "Stadt Bonn",
    address: { line1: "Berliner Platz 2", city: "Bonn", postalCode: "53111", countryCode: "DE" },
    electronicAddress: { schemeId: "0204", value: "04011000-1234512345-06" },
  },
  payment: { meansCode: "58", iban: "DE02120300000000202051" },
  lines: [
    { id: "1", description: "Consulting, August 2026", quantity: 10, unitCode: "HUR", unitPrice: 150, vatCategory: "S", vatRate: 19 },
  ],
} satisfies InvoiceInput;

const result = validateInput(invoice);

console.log(result.valid, result.errors.length); // true 0
```

That object is the whole input contract, and `satisfies InvoiceInput` is not
decoration: `profile` is a union of five string literals, so without it TypeScript
widens `"xrechnung-ubl"` to `string` and the `validateInput(invoice)` call below
does not compile. It feeds both generators: `generateXRechnungUBL(invoice)`
returns UBL 2.1
XML, `generateCii({ ...invoice, profile: "xrechnung-cii" })` returns CII.

### 2. Take one field out

Remove the buyer reference — BT-10, the Leitweg-ID a German public-sector buyer
requires — and you get a rejection that names the rule and tells you what to do:

```ts
const { buyerReference, ...missingReference } = invoice;

const rejected = validateInput(missingReference);

console.log(rejected.valid, rejected.errors.map((e) => e.rule)); // false [ 'BR-DE-15' ]
```

`rejected.errors[0]` is this object, in full:

```json
{
  "rule": "BR-DE-15",
  "field": "BT-10",
  "severity": "fatal",
  "message": "XRechnung requires a buyer reference (BT-10). For German public-sector buyers this is the Leitweg-ID; business buyers may supply any reference, but the field must be present.",
  "fix": "Ask your client for their Leitweg-ID (public sector) or an order/customer reference, and set buyerReference.",
  "example": "\"buyerReference\": \"04011000-1234512345-06\"",
  "xpath": "/ubl:Invoice/cbc:BuyerReference",
  "docsUrl": "https://attestwire.com/rules/BR-DE-15"
}
```

Both snippets above are executed against this build by
`src/readme-quickstart.test.ts` (repository; the published tarball ships
`dist` only), including the stated `console.log` output and
the JSON above, so a README example cannot drift from the library.

**Links**

- **[Rule reference](https://attestwire.com/rules/)** — one page per implemented
  rule, with the reason, the fix and a passing example. Every `TeachingError`
  carries a `docsUrl` pointing at its page.
- **[Hosted API](https://api.attestwire.com/docs)** — same engine, zero setup.
  POST JSON, get validated XRechnung XML back.
- **[Severity, and what `valid` means](#teaching-errors)** — fatal, warning and
  information are three separate arrays.

## What this package does

Both syntaxes generate and both parse: `generateXRechnungUBL` /
`parseUbl` for XRechnung UBL and Peppol BIS 3.0, `generateCii` /
`parseCiiInvoice` for XRechnung CII and the Factur-X EN 16931 payload. One
`InvoiceInput` model feeds either.

**Invoices and credit notes.** In UBL those are two different documents, and one
field picks between them: set `invoiceTypeCode` to `"381"` and
`generateXRechnungUBL` emits a `ubl:CreditNote` instead of a `ubl:Invoice`.
See [Credit notes](#credit-notes).

Every validation failure carries the official rule ID, the business term it
constrains, a plain-English explanation of *why* the regulation requires it, a
concrete fix, and a passing example — so a developer (or an agent) can correct
the invoice without opening the spec.

Totals are always **computed** from the lines, never echoed from caller input, so
a BR-CO arithmetic rejection cannot originate in the generated document.

Generation **refuses** rather than emitting a document that would be rejected
downstream: a profile in the wrong syntax throws (`UnsupportedProfileError` from
the UBL generator, `UnsupportedCiiProfileError` from the CII one — see
[Refusals](#refusals)).

## There is no PDF

Factur-X and ZUGFeRD are CII XML inside a PDF/A-3
container. `generateCii` emits the XML. It does not build the container, does
not attach the XML to a PDF under the required name (`factur-x.xml`, or
`xrechnung.xml` for the XRECHNUNG reference profile), and does not set the
`/AFRelationship` value Germany requires (`Alternative`). A file produced by
this package is a CII XML document, not a Factur-X or ZUGFeRD document.

## Conformance

The eleven release fixtures in [`fixtures/`](fixtures) — the documents these
generators produce — are checked against the official
[KoSIT validator](https://github.com/itplr-kosit/validator) 1.6.2 with the
XRechnung 3.0.2 configuration on release. The three UBL invoices go through the
UBL 2.1 XSD, the EN 16931 schematron and the XRechnung CIUS schematron; the two
UBL credit notes go through KoSIT's separate
`EN16931 XRechnung (UBL CreditNote)` scenario, which swaps in
`UBL-CreditNote-2.1.xsd`; the six CII documents go through the UN/CEFACT D16B
XSD, the EN 16931 **CII** schematron and the XRechnung **CII** schematron, under
KoSIT's own `EN16931 XRechnung (CII)` scenario. Reproduce it yourself with
[`scripts/kosit-check.sh`](scripts/kosit-check.sh), which needs a JDK.

**The KoSIT run was performed on 2026-08-13** — validator 1.6.2, XRechnung
configuration 3.0.2, over all eleven committed fixtures: `Acceptable: 11
Rejected: 0`, with zero findings at any severity. The recorded output is in
[`scripts/kosit-check.md`](scripts/kosit-check.md), together with the eight
credit-note probes that settled which rules do and do not apply to one — and the
two findings the CII run caught, earlier, before it went green.

Even a clean run
is a conformance check on eleven documents, not a parity suite: it says nothing
about the paths those fixtures do not exercise, and `validateInput` is a
pre-flight rather than a schematron (see
[Not implemented yet](#not-implemented-yet)).

## Credit notes

A credit note is one field:

```ts
const creditNote = generateXRechnungUBL({
  ...invoice,                     // the invoice you are crediting
  invoiceNumber: "2026-G00021",   // its own number, from your own sequence
  invoiceTypeCode: "381",         // ← this is the whole API
  precedingInvoices: [{ invoiceNumber: "2026-000142", issueDate: "2026-08-09" }],
});
// → <ubl:CreditNote xmlns:ubl="…:xsd:CreditNote-2"> … </ubl:CreditNote>
```

There is no `generateCreditNote` and no `documentType` flag, because EN 16931
does not have one: BT-3 *is* the discriminant, and a second field would let an
input contradict itself. `isCreditNote(input)` exposes the same decision if you
need to branch on it yourself.

**State the amounts positively.** The document type conveys the direction of the
money. A credit note carrying negative amounts reverses it back — that is a
"negative invoice", a different (and equally lawful) idiom, and mixing the two
gets you a document that says the opposite of what you meant. Both schematrons
accept either, so no validator will catch it; `ATW-CREDIT-NOTE-NEGATIVE-AMOUNTS`
is a warning here for exactly that reason.

What changes in the emitted UBL, and nothing else does:

| | `ubl:Invoice` | `ubl:CreditNote` |
| --- | --- | --- |
| Root / namespace | `Invoice`, `…:xsd:Invoice-2` | `CreditNote`, `…:xsd:CreditNote-2` |
| BT-3 | `cbc:InvoiceTypeCode` | `cbc:CreditNoteTypeCode` |
| Lines | `cac:InvoiceLine` | `cac:CreditNoteLine` |
| BT-129 quantity | `cbc:InvoicedQuantity` | `cbc:CreditedQuantity` |
| BT-9 due date | `cbc:DueDate` | `cac:PaymentMeans/cbc:PaymentDueDate` — the document has no `cbc:DueDate`, and `UBL-CR-412` exempts credit notes from the rule forbidding it here |
| BT-7 tax point | after `cbc:Note` | before `cbc:CreditNoteTypeCode` |
| BT-11 project | `cac:ProjectReference` | **no element exists** — dropped, and reported as `ATW-CREDIT-NOTE-PROJECT-REFERENCE-UNBOUND` |
| BT-25 preceding invoice | `cac:BillingReference/cac:InvoiceDocumentReference` | the same element — EN 16931 binds BG-3 to the *invoice* reference on both documents |

In **CII** none of that applies: there is one root element for both document
types, so a credit note is `ram:TypeCode` 381 and no other difference at all.

The rule set does not change either. EN 16931 has one semantic model and binds
the same rule ids to both documents, so BR-CO-10 counts the same amounts and
BR-DE-16 asks the same question. Two rules are worth knowing about:

- **BR-DE-17** admits `381` — XRechnung's eight codes are one list tested against
  both type-code elements. `261` (self-billed credit note) is a lawful EN 16931
  code and is *not* one of the eight, so it draws a warning there.
- **BR-DE-26 does not require a preceding invoice reference on a credit note.**
  It is widely believed to; the rule's own test names `384` (corrected invoice)
  and nothing else, on either document type, and KoSIT accepts a credit note with
  no BG-3 at all. Supplying one is still the ordinary case — the buyer cannot net
  two documents that do not reference each other — so this build says so at
  `information` level, the flag the regulator itself reserves for advice, under
  `ATW-CREDIT-NOTE-NO-PRECEDING-INVOICE`.

**Not covered:** self-billing as a *workflow*, and the UBL `SelfBilledInvoice` /
`SelfBilledCreditNote` root elements. BT-3 `389` and `261` generate and parse on
the ordinary root elements, which is what EN 16931's UBL binding uses; if a
platform demands one of those other roots, this package will not produce it.
Debit notes (`ubl:DebitNote`) are not supported either — EN 16931 has no binding
for them.

## CII: XRechnung CII and the Factur-X payload

```ts
import { generateCii, parseCiiInvoice } from "@attestwire/en16931";

const xml = generateCii({ ...invoice, profile: "xrechnung-cii" });
const { invoice: readBack, unmapped } = parseCiiInvoice(xml);
```

`generateCii` accepts `xrechnung-cii`, `facturx-en16931` and `en16931` — the
core profile is syntax-neutral, so you pick the syntax by picking the function.
`xrechnung-ubl` and `peppol-bis-3` are UBL-only and throw; Peppol BIS Billing
3.0 has no CII binding at all.

CII is not UBL with different names, and four differences are where a UBL habit
produces a rejected file:

| | UBL | CII |
| --- | --- | --- |
| Dates | `<cbc:IssueDate>2026-08-09</cbc:IssueDate>` | `<ram:IssueDateTime><udt:DateTimeString format="102">20260809</udt:DateTimeString></ram:IssueDateTime>` |
| Currency | on every amount, as `@currencyID` | once, in `ram:InvoiceCurrencyCode`; only BT-110 and BT-111 carry `@currencyID` |
| BT-21 note subject | no element — encoded into the note as `#CODE#text` | a real element, `ram:SubjectCode` |
| BT-90 SEPA creditor id | on the seller party, `schemeID="SEPA"` | on the settlement, `ram:CreditorReferenceID` |

Element order is part of schema validity in both syntaxes, and the two do not
agree on it. `ram:PostalTradeAddress` puts the post code before the street.
`ram:SpecifiedTradeSettlementHeaderMonetarySummation` puts charges before
allowances and the rounding amount before the grand total. A
`ram:SpecifiedTradeAllowanceCharge` puts the percentage and the base amount
before the amount, and the reason **code** before the reason **text**. Every
builder in `generate-cii.ts` quotes the XSD sequence it follows.

`parseCiiInvoice` is the inverse, and the round trip is tested: for each
committed CII fixture, `generateCii(parseCiiInvoice(xml).invoice)` returns the
identical document, and the result validates identically. It shares the hardened
XML reader — and every one of its security limits — with `parseUbl`, and
resolves everything by namespace URI rather than by prefix.

One thing it cannot tell you: **Factur-X's EN 16931 profile and plain core
EN 16931 state the same BT-24** (`urn:cen.eu:en16931:2017`), so a
`facturx-en16931` document reads back with `profile: "en16931"`. Nothing is
lost — the rule set is identical and regenerating produces the same bytes — but
if you need the distinction, keep it yourself.

## Reading an existing UBL invoice

`parseUbl` reads a UBL 2.1 `Invoice` **or `CreditNote`** document into the same
`InvoiceInput` object the rest of this package uses. That is what lets you
answer the question people actually arrive with: *my customer's platform
rejected this file — why?*

The document type is detected from the root element, not asked for, and comes
back in `invoice.invoiceTypeCode`. Feed the result to `generateXRechnungUBL` and
you get the same document type out. (The function is still exported under its
old name, `parseUblInvoice`, which reads credit notes too.)

```ts
import { parseUbl, validateInput } from "@attestwire/en16931";

const { invoice, unmapped } = parseUbl(xmlString);
const findings = validateInput(invoice);

for (const item of unmapped) {
  console.log(item.kind, item.path, item.reason);
}
```

**It is a reader, not an authority.** It tells you what is in the document. It
does not tell you whether a receiver will accept the document. A file that
parses here, and then passes `validateInput`, can still be rejected by KoSIT or
by a receiving platform: `validateInput` checks the input model, not the XML,
and this build is not a schematron. See
[Not implemented yet](#not-implemented-yet).

### What it reads

Every element `generateXRechnungUBL` emits, mapped back to the field it came
from. The round trip is tested: for each committed fixture,
`generateXRechnungUBL(parseUbl(xml).invoice)` returns the identical
document, and the result validates identically — for the credit-note fixtures as
well as the invoice ones.

Namespaces are resolved by URI, not by prefix. A document that calls the two
common namespaces `b:` and `a:`, or that puts the root in the default
namespace, reads the same as one using `cbc:` and `cac:`. Element order does not
matter to the reader.

The document's own totals (BT-106 to BT-115) are read into `declaredTotals`, so
`validateInput` checks the document's arithmetic against ours under the
`BR-CO-*` rules. The VAT breakdown and the line net amounts are recomputed from
the lines instead of being stored, because that is how the input model works.

`parseUbl` also returns `customizationId` and `profileId` — BT-24 and
BT-23 exactly as the document states them. `invoice.profile` is derived from
BT-24. If BT-24 is missing or unknown, the profile falls back to `en16931` or is
guessed from the text, and the guess is reported in `unmapped` — because the
profile decides which CIUS rules run.

### What it refuses

It throws rather than returning a half-read invoice. Every error extends
`ParseError` and carries a stable `code`.

| Error | `code` | When |
| --- | --- | --- |
| `UnsupportedSyntaxError` | `unsupported_syntax` | The root element is neither a UBL `Invoice` nor a UBL `CreditNote`. A CII document (ZUGFeRD, Factur-X, XRechnung CII) gets its own message saying so and pointing at `parseCiiInvoice`. |
| `UnsupportedCreditNoteError` | `unsupported_document_type` | **Never.** Kept exported for compatibility; nothing has thrown it since credit notes became readable. |
| `XmlSecurityError` | see below | The document hit one of the security limits. |
| `XmlSyntaxError` | various | The document is not well-formed, or uses a construct outside the accepted subset. |

There is no PDF support: Factur-X and ZUGFeRD carry CII inside a PDF/A-3, and
neither half of that is implemented.

### Security limits

The XML comes from someone else. The reader is written for the UBL subset and
refuses everything outside it, rather than accepting more and hoping.

| Defence | Limit | What it stops |
| --- | --- | --- |
| No DTD processing | any `<!DOCTYPE` or `<!ENTITY` in the document is refused (`xml_doctype_forbidden`, `xml_entity_declaration_forbidden`) | **XXE** — an external entity that reads a local file or makes a network request. Also the declaration half of billion-laughs. The check runs on the raw text, so a DOCTYPE inside a CDATA section is refused too. |
| No custom entity expansion | only `&amp; &lt; &gt; &quot; &apos;` and numeric character references are decoded (`xml_entity_forbidden`) | **Billion laughs.** An unknown entity is refused, never silently dropped — dropping one would change the text of a tax document without saying so. |
| Depth cap | 100 elements (`xml_too_deep`) | Deeply nested documents. A UBL invoice nests about eight levels. |
| Size cap | 400,000 characters (`xml_too_large`) | Memory exhaustion from a very large upload. |
| Element cap | 50,000 elements (`xml_too_many_elements`) | A flat document of millions of tiny elements, which passes both caps above. |
| Attribute cap | 256 per element (`xml_too_many_attributes`) | A root carrying tens of thousands of `xmlns:` declarations, each of which enters the namespace map every descendant lookup uses. |

All four numbers are the defaults in `DEFAULT_XML_LIMITS` and can be raised per
call: `parseUbl(xml, { maxCharacters: 2_000_000 })`.

**What the caps protect, and what they cost.** They are memory limits, chosen
from measurement rather than from how big a file "feels". Every element in the
parsed tree retains roughly 250–400 bytes — the object, its four name strings,
its attribute array and its children array — and the smallest element that can
appear in a document is four characters (`<x/>`). So the size cap is really an
element cap in disguise: 400,000 characters is at most about 100,000 elements,
or about 25–40 MB retained.

The cost is that an unusually large invoice is refused rather than parsed. The
largest fixture in this repository is under 10 kB and a thousand-line invoice
lands around 300 kB, so this is not a limit ordinary use meets — but a document
carrying a base64 attachment can exceed it, and that is the case to raise
`maxCharacters` for, deliberately.

⚠ **Changed in 0.4.0.** The size cap was 10,000,000 characters and the element
cap 200,000. Measured on Node 22, a legal document at the old size cap retained
about 81 MB of heap and about 306 MB of RSS — over the 128 MB a Cloudflare
Workers isolate is allowed, so a single such request was killed rather than
rejected. A 785 kB body already retained about 47 MB. If you run this on a
server with real memory and you know why you need it, raise the option.

The reader also refuses mixed content (an element holding both text and child
elements), unbound namespace prefixes, and control characters XML 1.0 does not
permit. Comments and processing instructions are skipped and never acted on: a
stylesheet instruction cannot make this library fetch anything.

### Nothing is dropped silently

Anything in the document that does not reach the invoice object is returned in
`unmapped`, with its path, its name, its namespace and its text:

```ts
{
  path: "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cbc:WebsiteURI",
  name: "cbc:WebsiteURI",
  namespace: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
  kind: "unknown",
  reason: "This parser has no field for this element, so neither it nor anything inside it reached the invoice object.",
  text: "https://example.invalid"
}
```

`kind` separates the two reasons, and they are very different:

- `"unknown"` — there is no field for it. **The content is gone from the
  model.** If it matters to you, read it from the XML yourself.
- `"recomputed"` — the element is understood, but the model derives the value
  rather than storing it. Line net amounts (BT-131) and the VAT breakdown
  (BT-116, BT-117) are the whole of this list for a document this package
  generated. Nothing is lost; the values come back from the lines.

An unmapped group is reported once, not once per element inside it. A number the
reader cannot read is reported too — including an empty element, which slipped
through this promise until 0.6.0 — and the field is left unset rather than
guessed at.

For the six **document totals** that is no longer the end of it. Being left
unset used to mean nothing compared them and the document validated clean; since
0.6.0 the reader records what happened in `declaredTotals.defects`, and a total
that the document should state and does not fails `BR-12`, `BR-13`, `BR-14` or
`BR-15`, while one that is present and unreadable — `12,34`, say — fails
`ATW-DECLARED-TOTAL-NOT-A-NUMBER`. Building an invoice from the JSON model is
unaffected: omit a total there and the library computes it, as it always has.

### What a real XRechnung from a German portal will hit

Honestly: things this reader does not yet handle.

- **`ubl:SelfBilledInvoice` and `ubl:SelfBilledCreditNote`.** Two more UBL root
  elements, for documents the buyer issues. Refused by root element. BT-3 `389`
  and `261` are read and written on the ordinary `Invoice` and `CreditNote`
  roots, which is what EN 16931's binding asks for — it is the self-billing
  *workflow*, not the type code, that is out of scope.
- **`cac:Signature`, `cbc:CopyIndicator`, `cbc:UBLVersionID`** and the other UBL
  elements that carry no EN 16931 business term. These parse, and appear in
  `unmapped` as `"unknown"`. They are not errors.
- **Repeated groups the input model holds only once** — a second `cbc:Note`, a
  second `cac:PartyIdentification`, a second `cac:PaymentMeans`. The first is
  read; the rest are reported as `"unknown"`.
- **`cac:PaymentTerms` `#SKONTO#` lines.** XRechnung encodes discount terms in
  the payment-terms text. They are read as text, exactly as written, and are not
  parsed into fields.
- **A tax scheme other than `VAT` or `FC`** on a party is reported rather than
  taken for a VAT number.

Nothing in that list produces a wrong invoice. Everything in it produces either
a clear refusal or an `unmapped` entry.

## Teaching errors

The [quickstart](#2-take-one-field-out) shows one missing field and the object
it produces. Every finding has that shape, and a rejection is a list of them
rather than "validation failed": drop the `buyerReference`, the `payment` block
and the seller `contact` from the quickstart invoice and `validateInput` reports
three fatal findings — `BR-DE-15`, `BR-DE-1`, `BR-DE-2` — with nothing in
`warnings` and nothing in `information`. (That count is asserted by
`src/readme-quickstart.test.ts` (repository) against this build.)

Errors explain the *reason*, not just the requirement. `BR-S-05` does not say
"rate must be > 0"; it says a zero rate with category S is contradictory, and
that if no VAT is due the category should be Z, E, AE, K, G or O — each with
different evidencing requirements.

Findings are separated by severity, because the reference validators separate
them: KoSIT's schematron flags each assertion `fatal`, `warning` or
`information`, and a report that promotes an advisory to an error is as wrong as
one that misses it. `result.valid` reflects fatal rules only, so advisory rules
(`BR-DE-27`, `BR-DE-28`) never block a build. `result.information` is a third
array, deliberately kept out of `warnings`: a caller who fails a build on a
non-empty `warnings` array should not be stopped by a finding the official
validator raises and then accepts. `BR-DE-TMP-32` — an invoice should state a
delivery date — is the rule that needs it.

If you switch or filter on `severity`, add the third value: a consumer that
allow-lists `['fatal', 'warning']` will silently drop `information` findings.
The union is exported as the type `Severity`, so a `switch` over it that misses
a case fails the build rather than the audit.

## API

| Export | Purpose |
| --- | --- |
| `validateInput(inv)` | Run all input rules. Returns `{ valid, profile, errors, warnings, information }`. Reports **every** finding, not the first. |
| `generateXRechnungUBL(inv, options?)` | JSON → UBL 2.1 `Invoice` XML string — or `CreditNote`, when `invoiceTypeCode` is a credit-note code. |
| `generateCii(inv, options?)` | JSON → UN/CEFACT CII (D16B) `CrossIndustryInvoice` XML string, for `xrechnung-cii`, `facturx-en16931` and `en16931`. **XML only — not a PDF.** |
| `parseCiiInvoice(xml, options?)` | CII XML → `{ invoice, unmapped, customizationId, profileId }`, the same shape `parseUbl` returns. Reads invoices and credit notes alike — in CII they are one document type. |
| `CII_GENERATABLE_PROFILES` / type `CiiGeneratableProfile` | The profiles `generateCii` accepts, and the union type of them. |
| `CII_NAMESPACES` | The four namespace URIs (`rsm`, `ram`, `qdt`, `udt`) a CII invoice uses — for resolving by URI when you walk a document yourself. |
| `toCiiDate(iso)` / `fromCiiDate(value)` | ISO 8601 ↔ the CII `format="102"` form (`YYYYMMDD`). A value that is not a calendar date passes through untouched rather than being rewritten. |
| `SUPPORTING_DOCUMENT_TYPE_CODE` / `TENDER_OR_LOT_DOCUMENT_TYPE_CODE` | `"916"` and `"50"`. In CII one element, `ram:AdditionalReferencedDocument`, carries BG-24, BT-17 **and** BT-18, told apart only by these codes and by `INVOICED_OBJECT_DOCUMENT_TYPE_CODE` (`"130"`). |
| `parseUbl(xml, options?)` | UBL 2.1 `Invoice` **or `CreditNote`** XML → `{ invoice, unmapped, customizationId, profileId }`. Feed `invoice` to `validateInput`. See [Reading an existing UBL invoice](#reading-an-existing-ubl-invoice). |
| `parseUblInvoice(xml, options?)` | The same function under its pre-0.5.0 name. Kept forever; `parseUbl` is the name to use in new code, since it reads both document types. |
| `ParseError` and subclasses | What parsing throws instead of returning a half-read invoice: `UnsupportedSyntaxError`, `UnsupportedCreditNoteError`, `XmlSecurityError`, `XmlSyntaxError`. Each carries a stable `code`. |
| `DEFAULT_XML_LIMITS` / type `XmlLimits` | The size, depth and element caps applied to every parse, and the shape for overriding them. |
| `parseXml(xml, limits?)` | The hardened XML reader on its own, returning an `XmlElement` tree. With `attr`, `firstChild` and `childrenNamed` for walking it — useful for reading an element `parseUbl` reports as unmapped. |
| `computeTotals(inv)` | BG-22 totals and the BG-23 VAT breakdown, as the BR-CO rules define them — including BT-107/BT-108 for document allowances and charges, and BT-113/BT-114. |
| `lineNetAmount(line)` | BT-131 for a single line, net of its BG-27 allowances and BG-28 charges. |
| `round2(n)` / `formatAmount(n)` | Half-up 2dp rounding, and its 2-decimal string form. |
| `inputRules` | The raw rule array, if you want to run a subset. |
| `runInputRules(inv)` | The flat `TeachingError[]` behind `validateInput`, in rule order and unsplit by severity — what you want if you are grouping findings yourself. |
| `effectiveRate(line)` | The rate a line actually contributes to the BG-23 breakdown: `undefined` for the categories that carry none, `0` for the fixed-zero ones, otherwise `vatRate`. Use it rather than reading `line.vatRate`, or your grouping will disagree with ours. |
| `effectiveAllowanceChargeRate(entry)` | The same normalisation for a document allowance (BT-96) or charge (BT-103), so BG-20/BG-21 land in the same group as the lines they adjust. |
| `DEFAULT_EXEMPTION_REASONS` | The BT-120 wording this library supplies when you leave `vatExemptionReasons` unset — the standard texts named in `BR-AE-10`, `BR-IC-10`, `BR-G-10` and `BR-O-10`. Category `E` is deliberately absent: the reason depends on which national exemption you claim. |
| `DEFAULT_INVOICE_TYPE_CODE` | The BT-3 used when you supply none — `"380"`, commercial invoice. |
| `INVOICED_OBJECT_DOCUMENT_TYPE_CODE` | `"130"`, the UNTDID 1153 code that marks a `cac:AdditionalDocumentReference` as the invoiced object identifier (BT-18) rather than a supporting document (BG-24). They share one element and are told apart only by this code. |
| `CUSTOMIZATION_IDS` / `PROFILE_IDS` | BT-24 / BT-23 values per profile. |
| `UBL_GENERATABLE_PROFILES` / type `UblGeneratableProfile` | The profiles `generateXRechnungUBL` accepts, and the union type of them — narrow to it and the compiler rejects a profile that would throw. |
| `CREDIT_NOTE_TYPE_CODES` | The BT-3 values that make the document a **credit note** — `83`, `261`, `262`, `296`, `308`, `381`, `396`, `420`, `458`, `502`, `503`, `532`. A `Set`, used by both generators and both parsers to pick the document type. ⚠ It used to be the six codes generation *refused*; it is now the routing set, derived from `CREDIT_NOTE_TYPE_CODES_CL` minus the invoice list. `isCreditNote(input)` is the friendlier way to ask. |
| `isCreditNote` / `documentKindOf` | `isCreditNote({ invoiceTypeCode })` → boolean; `documentKindOf(code)` → `"invoice"` \| `"credit-note"`. The same decision `generateXRechnungUBL` makes, exported so a caller branching on the document type does not have to re-derive a code list. |
| `CREDIT_NOTE_TYPE_CODES_CL` (and `_SET`) | The thirteen UNTDID 1001 codes BR-CL-01 admits on a *credit note* document (`cbc:CreditNoteTypeCode`) — `81`, `83`, `261`, `262`, `296`, `308`, `381`, `396`, `420`, `458`, `502`, `503`, `532`. The `_CL` suffix means code list. `CREDIT_NOTE_TYPE_CODES` is derived from it: this list minus the codes that are *also* on the invoice list, which is `81` alone. Reach for `CREDIT_NOTE_TYPE_CODES` when you want to know which documents this build emits as a `CreditNote`, and for `CREDIT_NOTE_TYPE_CODES_CL` when you want to know what the regulation calls a credit note. |
| `PEPPOL_EAS_SCHEME_CODES`, `PEPPOL_CURRENCY_CODES` (and their `_SET` variants) | Peppol's own narrower lists, enforced only on `profile: "peppol-bis-3"`: the EAS schemes `PEPPOL-EN16931-CL008` admits for BT-34/BT-49, and the currencies `PEPPOL-EN16931-CL007` admits for BT-5. Both rules name these exports in their `fix` text, so this is where a caller following the error message lands. |
| `GenerationError` and subclasses | What generation throws instead of emitting a wrong document. |
| `minimalXRechnung` / `reverseChargeXRechnung` / `discountedXRechnung` | The example inputs behind the UBL `fixtures/`. |
| `minimalXRechnungCii` / `reverseChargeXRechnungCii` / `discountedXRechnungCii` | The same three invoices with `profile: "xrechnung-cii"` — one model, two syntaxes. |
| `extendedXRechnungCii` | A wide CII invoice: payee, tax representative, direct debit, deliver-to, attachments, VAT accounting currency, tax point date, gross price. It exists so KoSIT judges the groups the other three never reach. |
| `CURRENCY_CODES`, `COUNTRY_CODES`, `UNIT_CODES`, `VAT_CATEGORY_CODES`, `PAYMENT_MEANS_CODES`, `INVOICE_TYPE_CODES`, `EAS_SCHEME_CODES`, `ICD_SCHEME_CODES`, `OBJECT_SCHEME_CODES`, `ITEM_CLASSIFICATION_SCHEME_CODES`, `ALLOWANCE_REASON_CODES`, `CHARGE_REASON_CODES`, `VATEX_CODES`, `MIME_CODES`, `NOTE_SUBJECT_CODES`, `VAT_POINT_DATE_CODES` (and a `_SET` for each) | The official code lists the `BR-CL-*` rules enforce. Build a picker that cannot offer a value the validator rejects. |

`GenerateOptions`: `indent` (default `"  "`), `customizationId`, `profileId` — the
last two let you pin an older CIUS version such as XRechnung 2.3.

### Refusals

Each generator throws instead of returning XML in two cases. Every error extends
`GenerationError`, carries a stable `code`, and explains in the message what
*is* supported:

| Error | `code` | When |
| --- | --- | --- |
| `UnsupportedProfileError` | `unsupported_profile` | From `generateXRechnungUBL`: `profile` is not one of `en16931`, `xrechnung-ubl`, `peppol-bis-3`. `xrechnung-cii` and `facturx-en16931` are CII documents — call `generateCii` for those. |
| `UnsupportedCiiProfileError` | `unsupported_profile` | From `generateCii`: `profile` is not one of `en16931`, `xrechnung-cii`, `facturx-en16931`. `xrechnung-ubl` and `peppol-bis-3` are UBL-only. |
| `UnsupportedDocumentTypeError` | `unsupported_document_type` | **Never.** It existed for one case — a credit-note `invoiceTypeCode` — and that case now generates a `ubl:CreditNote`. Kept exported so an existing `import` or `instanceof` does not break; the branch is simply never taken. |

Both generators now throw on the syntax and on nothing else. A credit-note BT-3
is a document, not a refusal.

### Rounding

EN 16931 sums **already-rounded** line amounts. Rounding only the final sum
drifts by a cent or two on long invoices and gets rejected under BR-CO-10.
`round2` is half-up and works around both JS traps: `Math.round(1.005 * 100)/100`
is `1.00`, and `(2.675).toFixed(2)` is `"2.67"`. Both are wrong for tax.

## Scope

### Implemented

| Area | Coverage |
| --- | --- |
| **XRechnung 3.0 UBL generation** | Full document: namespaces, BT-24/BT-23, header terms, both parties (incl. electronic address with `schemeID`, VAT vs. national tax scheme, legal entity, party and registration identifiers with their ISO 6523 schemes, trading name, contact), payee and tax representative parties, delivery group, payment means with card (`cac:CardAccount`) and direct debit (`cac:PaymentMandate`), payment terms, tax breakdown, monetary totals, lines. Plus document and line allowances and charges (`cac:AllowanceCharge`), invoicing periods at both levels, preceding invoice references (`cac:BillingReference`), the project/contract/despatch/receipt/tender/sales-order references, the invoiced object identifier and supporting documents (`cac:AdditionalDocumentReference`, including an embedded base64 attachment), item identifiers, origin country, commodity classification and item attributes, a second `cac:TaxTotal` for the VAT accounting currency, and the price allowance for BT-147/BT-148. Element order follows `UBL-Invoice-2.1.xsd`, and all three fixtures validate against the UBL 2.1 XSD. |
| **UBL credit notes** | `invoiceTypeCode: "381"` (or any other code on the credit-note half of UNTDID 1001) emits a `ubl:CreditNote` instead: the `CreditNote-2` namespace, `cbc:CreditNoteTypeCode`, `cac:CreditNoteLine` with `cbc:CreditedQuantity`, the tax point date before the type code, contract and additional references before the originator reference, and BT-9 in `cac:PaymentMeans/cbc:PaymentDueDate` because that document has no `cbc:DueDate`. Element order follows `UBL-CreditNote-2.1.xsd`; both credit-note fixtures pass KoSIT's own `EN16931 XRechnung (UBL CreditNote)` scenario. Every other business term is in the same place as on an invoice, and the whole rule set applies unchanged. |
| **XRechnung 3.0 UBL ingestion** | `parseUbl` (still exported as `parseUblInvoice`) reads a UBL 2.1 `Invoice` **or `CreditNote`** document back into the input model — every element the generator emits, resolved by namespace URI rather than by prefix, in any element order. Round-tripped over every committed fixture: parse then regenerate returns the identical document, and it validates identically. Anything not carried into the model is returned in `unmapped`. The XML reader is hand-rolled for the UBL subset and refuses DOCTYPEs, custom entities, mixed content and over-sized, over-deep or over-wide documents. The document type is detected from the root element and reported in `invoiceTypeCode`, so a credit note read here regenerates as a credit note. No PDF. See [Reading an existing UBL invoice](#reading-an-existing-ubl-invoice). |
| **CII (D16B) generation** | `generateCii` emits a `rsm:CrossIndustryInvoice` for `xrechnung-cii`, `facturx-en16931` and `en16931`, from the same `InvoiceInput`, with the same computed totals. Full document: the exchanged-document context (BT-23/BT-24), header terms, both trade parties (identifier vs. global identifier, legal organisation, contact, address, endpoint, VAT and national tax registrations), tax representative, payee, ship-to party and delivery event, payment means with financial card and direct debit, the VAT breakdown, document and line allowances and charges, billing periods at both levels, preceding invoices, the referenced-document family (BG-24 / BT-17 / BT-18 / BT-128, told apart by type code), procuring project, the monetary summation including BT-111, and lines with gross and net price, item identifiers, classification, origin country and attributes. Element order follows `CrossIndustryInvoice_*_100pD16B.xsd`; all six CII fixtures pass the D16B XSD and both CII schematrons. CII has no separate credit-note document, so a credit note is the same `rsm:CrossIndustryInvoice` with `ram:TypeCode` 381 and no other difference. |
| **CII (D16B) ingestion** | `parseCiiInvoice` reads a `CrossIndustryInvoice` back into the input model — every element the CII generator emits, resolved by namespace URI rather than by prefix, in any element order. Round-tripped over every committed CII fixture: parse then regenerate returns the identical document, and it validates identically. Same hardened XML reader and same security limits as the UBL path. Anything not carried into the model is returned in `unmapped`. |
| **BT coverage** | BT-1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161. |
| **Arithmetic** | BT-131 = quantity × (BT-146 / BT-149) − Σ BT-136 + Σ BT-141; BT-106 = Σ BT-131; BT-107 = Σ BT-92; BT-108 = Σ BT-99; BT-109 = BT-106 − BT-107 + BT-108; the BG-23 taxable amount per (category, rate) group nets document allowances out and charges in; BT-117 from BT-116 × BT-119; BT-110 = Σ BT-117; BT-112 = BT-109 + BT-110; BT-115 = BT-112 − BT-113 + BT-114. Per-line half-up rounding, and sums taken over the rounded values. BT-107 and BT-108 stay separate sums even where the breakdown nets them — that asymmetry is the standard's. |
| **Rules** | 287 regulation rules with teaching errors (enumerated below), plus eight `ATW-` findings of our own (`ATW-DECLARED-TOTAL-NOT-FINITE`, `ATW-DECLARED-TOTAL-NOT-A-NUMBER`, `ATW-VAT-CATEGORY-UNSUPPORTED`, `ATW-DATE-NOT-A-CALENDAR-DATE` and the four credit-note ones) — 295 distinct rule ids. 270 are reachable from caller input; the other 25 constrain the library's own computed arithmetic and cannot be tripped by any input, which is what they are for. Both figures are read off a test run, not typed: `src/rules-invariants.test.ts` fires a battery of deliberately-broken invoices, and every rule id in the source must be either fired by it or named in that file's `ARITHMETIC_INVARIANTS` list with the reason no input can reach it. A rule that is neither fails the suite. (the reachable figure was five lower before 0.6.0: `BR-12`, `BR-13`, `BR-14` and `BR-15` became reachable once the parsers started recording a document total the *document* failed to state, which is what `declaredTotals.defects` is; `ATW-DECLARED-TOTAL-NOT-A-NUMBER` is new in the same release, for a total that is present and unreadable. 251 before 0.4.0: `PEPPOL-EN16931-R120`, `BR-CO-17` and all nine members of the `-08` family became reachable once `declaredTotals` started carrying the stated BT-131, BT-116 and BT-117 instead of discarding them. It then read 254 for a few hours on 2026-08-12, because the battery fired only one member of the `-08` family and the count was taken from the battery. Reachability is a property of the rule, not of the battery that happens to exercise it, and reading it the other way put "you cannot trip this rule" on eight pages that a caller can trip. `BR-Z-08`, `BR-E-08`, `BR-AE-08`, `BR-IC-08`, `BR-G-08`, `BR-O-08`, `BR-AF-08` and `BR-AG-08` each have their own fixture now, and the guard is completeness rather than a number, so the same mistake cannot pass again.) |
| **KoSIT conformance of the fixtures** | Checked on release against the official validator 1.6.2 / XRechnung 3.0.2 config — for UBL: the UBL 2.1 XSD, the EN 16931 schematron and the XRechnung CIUS schematron; for CII: the UN/CEFACT D16B XSD, the EN 16931 CII schematron and the XRechnung CII schematron. The two UBL credit notes are judged by KoSIT's separate `EN16931 XRechnung (UBL CreditNote)` scenario, against `UBL-CreditNote-2.1.xsd`. Eleven documents, not a parity suite — **run 2026-08-13, `Acceptable: 11 Rejected: 0`, zero findings** (see `scripts/kosit-check.md`, which also records the eight credit-note probes and the two findings the CII run caught first). Run `./scripts/kosit-check.sh` yourself before relying on it. |

Rules implemented, by family. This list is maintained by hand; the
[rule reference](https://attestwire.com/rules/) derives its own from the engine.

- **Document and party** — `BR-02`, `BR-03`, `BR-04`, `BR-05`, `BR-06`, `BR-07`,
  `BR-08`, `BR-09`, `BR-10`, `BR-11`, `BR-12`, `BR-13`, `BR-14`, `BR-15`,
  `BR-16`, `BR-17` (payee), `BR-18`, `BR-19`, `BR-20`, `BR-56` (seller tax
  representative), `BR-57`, `BR-CO-26`.
- **Lines** — `BR-21`, `BR-22`, `BR-23`, `BR-24`, `BR-25`, `BR-26`, `BR-27`,
  `BR-28`, `BR-CO-04`.
- **Allowances and charges** — document level (BG-20/BG-21): `BR-31`, `BR-32`,
  `BR-33`, `BR-36`, `BR-37`, `BR-38`, `BR-CO-11`, `BR-CO-12`, `BR-CO-21`,
  `BR-CO-22`. Line level (BG-27/BG-28): `BR-41`, `BR-42`, `BR-43`, `BR-44`,
  `BR-CO-23`, `BR-CO-24`.
- **VAT breakdown** — `BR-45`, `BR-46`, `BR-47`, `BR-48`, `BR-CO-17`,
  `BR-CO-18`.
- **VAT categories** — the `-01` (breakdown cardinality), `-02` (seller
  identification), `-03`/`-04` (allowance and charge identification), `-05`
  (line rate), `-06`/`-07` (allowance and charge rate), `-08` (taxable amount),
  `-09` (VAT amount) and `-10` (exemption reason) rules for all nine
  categories: `BR-S-*`, `BR-Z-*`, `BR-E-*`, `BR-AE-*`, `BR-IC-*`, `BR-G-*`,
  `BR-O-*`, `BR-AF-*`, `BR-AG-*`. Three of the nine are not named after the
  code BT-151 carries: category K is `BR-IC-*`, L is `BR-AF-*` and M is
  `BR-AG-*`, which is why `CATEGORY_RULE_INFIX` exists. The `-10`
  rules cut both ways: on the exempting categories they require an exemption
  reason, and on S and Z they forbid one. On top of those sit `BR-IC-11`,
  `BR-IC-12`, `BR-O-11`, `BR-O-12`, `BR-O-13` and `BR-O-14`.
- **Arithmetic against caller-declared totals** — `BR-CO-10`, `BR-CO-13`,
  `BR-CO-14`, `BR-CO-15`, `BR-CO-16`.
- **Periods and dates** — `BR-29`, `BR-30`, `BR-CO-03`, `BR-CO-19`, `BR-CO-20`.
- **References, items and attachments** — `BR-50`, `BR-51`, `BR-52`, `BR-53`,
  `BR-54`, `BR-55`, `BR-64`, `BR-65`.
- **Decimal precision** — `BR-DEC-01`, `BR-DEC-02`, `BR-DEC-05`, `BR-DEC-06`,
  `BR-DEC-09`, `BR-DEC-10`, `BR-DEC-11`, `BR-DEC-12`, `BR-DEC-13`, `BR-DEC-14`,
  `BR-DEC-15`, `BR-DEC-16`, `BR-DEC-17`, `BR-DEC-18`, `BR-DEC-19`, `BR-DEC-20`,
  `BR-DEC-23`, `BR-DEC-24`, `BR-DEC-25`, `BR-DEC-27`, `BR-DEC-28`.
- **Code lists** — every `BR-CL-*` rule in the reference schematron:
  `BR-CL-01`, `BR-CL-03`, `BR-CL-04`, `BR-CL-05`, `BR-CL-06`, `BR-CL-07`,
  `BR-CL-08`, `BR-CL-10`, `BR-CL-11`, `BR-CL-13`, `BR-CL-14`, `BR-CL-15`,
  `BR-CL-16`, `BR-CL-17`, `BR-CL-18`, `BR-CL-19`, `BR-CL-20`, `BR-CL-21`,
  `BR-CL-22`, `BR-CL-23`, `BR-CL-24`, `BR-CL-25`, `BR-CL-26`. (There is no
  BR-CL-02, -09 or -12.)
- **VAT identifiers** — `BR-CO-09`, including the Greek `EL` derogation.
- **Payment** — `BR-49`, `BR-61`.
- **XRechnung CIUS** — `BR-DE-1`, `BR-DE-2`, `BR-DE-3`, `BR-DE-4`, `BR-DE-5`,
  `BR-DE-6`, `BR-DE-7`, `BR-DE-8`, `BR-DE-9`, `BR-DE-10`, `BR-DE-11`,
  `BR-DE-14`, `BR-DE-15`, `BR-DE-16`, `BR-DE-17`, `BR-DE-18`, `BR-DE-19`,
  `BR-DE-20`, `BR-DE-22`, `BR-DE-23-a`, `BR-DE-23-b`, `BR-DE-24-a`,
  `BR-DE-24-b`, `BR-DE-25-a`, `BR-DE-25-b`, `BR-DE-26`, `BR-DE-27`,
  `BR-DE-28`, `BR-DE-30`, `BR-DE-31`, `BR-DE-TMP-32`.
- **Transport** — `BR-62`, `BR-63`, `PEPPOL-EN16931-R010`,
  `PEPPOL-EN16931-R020`.
- **Peppol BIS Billing 3.0** (only on `profile: "peppol-bis-3"`) —
  `PEPPOL-EN16931-R003`, `R005`, `R040`, `R041`, `R042`, `R046`, `R055`,
  `R061`, `R110`, `R111`, `R120`, `R121`; the code-list rules
  `PEPPOL-EN16931-CL007` and `CL008`; the process rules
  `PEPPOL-EN16931-P0100`, `P0112` and the VATEX/category pairs `P0104`,
  `P0105`, `P0106`, `P0107`, `P0108`, `P0109`, `P0111`; and the national
  identifier checksums `PEPPOL-COMMON-R040` .. `R050`, `R052`, `R053`.
- **Regional VAT categories** — IGIC (`L`): `BR-AF-01` .. `BR-AF-10`;
  IPSI (`M`): `BR-AG-01` .. `BR-AG-10`.
- **Library limitations and bindings** (`ATW-` prefix, not rules of the
  regulation) — `ATW-DECLARED-TOTAL-NOT-FINITE`, `ATW-VAT-CATEGORY-UNSUPPORTED`,
  `ATW-DATE-NOT-A-CALENDAR-DATE`, and the four credit-note findings:
  `ATW-CREDIT-NOTE-NEGATIVE-AMOUNTS`, `ATW-CREDIT-NOTE-DUE-DATE-UNBOUND`,
  `ATW-CREDIT-NOTE-PROJECT-REFERENCE-UNBOUND` and
  `ATW-CREDIT-NOTE-NO-PRECEDING-INVOICE`. (`ATW-CREDIT-NOTE-UNSUPPORTED` was
  removed when the limitation it described was.)

### Code lists

Every coded field this model can express is checked against the **complete
official list**, not against a shape. The tables live in `src/codelists/` and are
generated by `scripts/build-codelists.mjs` from `EN16931-UBL-codes.sch` and
`EN16931-UBL-model.sch` in
[ConnectingEurope/eInvoicing-EN16931](https://github.com/ConnectingEurope/eInvoicing-EN16931)
at `validation-1.3.16` — the same artefacts the KoSIT validator evaluates, so the
lists cannot drift from the ones you will be judged against.

| List | Codes | Rule |
| --- | --- | --- |
| UNTDID 1001 invoice type | 50 | `BR-CL-01` |
| ISO 4217 currency | 178 | `BR-CL-03`, `BR-CL-04`, `BR-CL-05` |
| ISO 3166-1 country | 251 | `BR-CL-14`, `BR-CL-15` |
| UNTDID 4461 payment means | 84 | `BR-CL-16` |
| UNCL5305 VAT category | 10 | `BR-CL-17`, `BR-CL-18` |
| UN/ECE Rec 20 + Rec 21 unit | 2,162 | `BR-CL-23` |
| CEF EAS scheme | 104 | `BR-CL-25` |
| ISO 6523 ICD scheme | 243 | `BR-CL-10`, `BR-CL-11`, `BR-CL-21`, `BR-CL-26` |
| UNTDID 2005 tax point date | 3 | `BR-CL-06` |
| UNTDID 1153 object scheme | 818 | `BR-CL-07` |
| UNCL 4451 note subject | 383 | `BR-CL-08` |
| UNTDID 7143 item classification scheme | 185 | `BR-CL-13` |
| UNCL 5189 allowance reason | 19 | `BR-CL-19` |
| UNCL 7161 charge reason | 178 | `BR-CL-20` |
| CEF VATEX exemption reason | 88 | `BR-CL-22` |
| Attachment MIME type | 6 | `BR-CL-24` |

Two details the generator script enforces rather than assumes. BR-CL-08's list
lives in `EN16931-UBL-model.sch` rather than in the codes file, because UBL has
no element for BT-21 and the note subject code has to be asserted inside the
model rules; the script fetches both files. And `BR-CL-11`, `BR-CL-21` and
`BR-CL-26` each restate the ISO 6523 list in full — the script asserts all three
literals are byte-identical to `BR-CL-10`'s before exporting one shared array,
so a drift upstream fails the build instead of being silently resolved in
someone's favour.

Each list is a side-effect-free module exporting a frozen array and a `Set`. The
whole set is 16.6 kB gzipped, 6.0 kB of which is the unit list; a bundler that
sees no reference to a list drops it.

### Where the two syntaxes disagree

UBL and CII are not two spellings of one rule set. Where the reference
schematrons word the same rule differently, this build follows each one rather
than picking a compromise, so the verdict depends on `profile`.

The clearest case is **BR-CO-09**, the country prefix on a VAT identifier. UBL
tests `contains(' 1A AD … ZW ', substring(cbc:CompanyID,1,2))`; CII wraps the
needle in spaces, `concat(' ', substring(.,1,2), ' ')`. Neither folds case and
neither strips whitespace, and the two literal lists are not even the same list
— UBL carries `SS` and not `AN`, CII carries `AN` and not `SS`. So:

| BT-31 | UBL | CII |
| --- | --- | --- |
| `DE123456789` | accepted | accepted |
| `de123456789` | **refused** | **refused** |
| `D E123456789` | accepted (`"D "` is inside `"AD "`) | **refused** |
| ` DE123456789` | accepted (`" D"` is inside `" DE"`) | **refused** |
| `SS123456789` | accepted | **refused** |
| `AN123456789` | **refused** | accepted |

All of these were put to the KoSIT validator in both syntaxes; the table is the
validator's answers, not a reading of the rule text. The `en16931` profile can
be emitted as either syntax, so an input carrying it has to satisfy both.

### Not implemented yet

The list below is what is known to be missing, not a survey of what is. Four
coverage gaps were found in the two days before 0.4.0 and none of them had a row
here beforehand.

| Area | Status |
| --- | --- |
| **Full schematron parity** | Not reached, and this table is not a complete account of the gap. The build implements a large part of EN 16931 core, the XRechnung CIUS and Peppol BIS Billing 3.0 — 270 rule ids reachable from caller input — and the rows below name the exclusions we know about. They are not exhaustive: four separate coverage gaps were found in the two days before 0.4.0 (the seller half of `BR-AE-02`, `BR-CO-09` on BT-63, `BR-CL-14` on BT-69, and declared-versus-computed checks on BT-131, BT-116 and BT-117), none of which appeared in any earlier version of this list. Nothing in this repository measures coverage against the schematron, so treat an absent row as "not yet noticed", not as "does not exist". `validateInput` is still a fast pre-flight over the JSON input model, **not** an authority — it reads your input, not the XML a receiver will judge, so a document it accepts can in principle still be rejected by KoSIT. If you want the authoritative answer without running Java, the [hosted API](https://api.attestwire.com/docs) is the same engine, zero setup. |
| **VAT category B (split payment)** | `L` (IGIC) and `M` (IPSI) ship with their full `BR-AF-*` and `BR-AG-*` families. `B` does not. It is the one code of the ten with no `-01`/`-05`/`-08`/`-09`/`-10` family — only `BR-B-01` and `BR-B-02`, both of which exist to confine it to domestic Italian invoices — so expressing it would mean emitting rule ids the regulation does not define, or carving it out of every per-category loop for the sake of two checks. A line carrying `"B"` is a fatal `ATW-VAT-CATEGORY-UNSUPPORTED` finding rather than a silent pass. |
| **XRechnung Extension and CVD profiles** | `BR-DEX-*` and `BR-DE-CVD-*` apply to customization ids this build does not emit. |
| **Rules that cannot be tested mechanically** | `BR-CO-05`, `BR-CO-06`, `BR-CO-07` and `BR-CO-08` require a reason code and a reason text to "indicate the same type of allowance". The reference schematron binds all four to `true()` — the regulator does not test them either. `BR-CO-25` is absent from both the reference schematron and Peppol's, so implementing it would reject documents the authority accepts. |
| **Rules the generator controls** | `BR-01` and `BR-DE-21` constrain BT-24, which `generateXRechnungUBL` derives from `profile`; the only override is `GenerateOptions.customizationId`, which `validateInput` never sees. `BR-DE-13` is in the same position. They belong to a document-validation entry point, not an input pre-flight. |
| **Validating existing XML** | `parseUbl` reads a UBL 2.1 `Invoice` or `CreditNote` document into the input model, so an existing file can be checked: parse it, then `validateInput` the result. That is a **pre-flight over the parsed input, not a schematron over the document**. Two consequences. First, a rule that constrains the XML rather than the input — `BR-01`, `BR-DE-13`, `BR-DE-21` on BT-24, and the rules the generator controls — still does not run. Second, the reader recomputes the totals and the VAT breakdown from the lines, so what is checked is the arithmetic of the *model*, with the document's own declared totals compared against it — and, since 0.6.0, checked for presence: a document that does not state BT-106, BT-109, BT-112 or BT-115 fails `BR-12`/`BR-13`/`BR-14`/`BR-15`, and one that states a total no reader can turn into a number fails `ATW-DECLARED-TOTAL-NOT-A-NUMBER`. `TeachingError.xpath` is populated but is not yet derived from the parsed document. |
| **Factur-X / ZUGFeRD as a PDF** | Not started, and not planned in this package. Factur-X and ZUGFeRD are CII XML embedded in a PDF/A-3 container: the XML must be attached under a fixed name (`factur-x.xml`, except for the XRECHNUNG reference profile, which uses `xrechnung.xml`), the PDF must be PDF/A-3 conformant, and Germany requires `/AFRelationship = Alternative` for the BASIC, EN 16931, EXTENDED and XRECHNUNG profiles. `generateCii({ profile: "facturx-en16931" })` gives you the **CII XML payload** and nothing else. Take it to a PDF/A-3 library to make a Factur-X *file*. |
| **Peppol rules inside the XRechnung schematron** | KoSIT's XRechnung schematron — both the UBL and the CII one — includes a few `PEPPOL-EN16931-*` assertions (`R040` among them). This build gates its Peppol rules on `profile: "peppol-bis-3"`, so those do not run for an XRechnung input here even though KoSIT runs them. Found by the 2026-08-11 CII run; recorded in `scripts/kosit-check.md`. |
| **Self-billing** | The *documents* are supported — BT-3 `389` (self-billed invoice) and `261` (self-billed credit note) generate, parse and validate, and both are lawful EN 16931 type codes on the ordinary root elements. What is not here: the UBL `SelfBilledInvoice` and `SelfBilledCreditNote` root elements (which EN 16931's UBL binding does not use), and anything about the self-billing *process* — the buyer-issues-the-document agreement, the supplier's approval loop, the reverse party mapping. If your platform requires one of those root elements, this package will not produce it. Note also that `261` is outside XRechnung's eight-code list, so it draws a `BR-DE-17` warning there — KoSIT agrees, at warning level, and accepts the document. |
| **Debit notes** | Not supported, and not planned: UBL has a `DebitNote` root element and EN 16931 has no binding for it. |
| **BT-11 on a UBL credit note** | `cac:ProjectReference` does not exist in `UBL-CreditNote-2.1.xsd`, so no conformant UBL credit note can carry a project reference. Reported as `ATW-CREDIT-NOTE-PROJECT-REFERENCE-UNBOUND` rather than dropped silently. The CII binding keeps it. |
| **XPaths on credit-note findings** | `TeachingError.xpath` is a fixed string per rule, and most of them still read `/ubl:Invoice/…` even when the document is a credit note. The rules that exist *because* the document is a credit note name `/ubl:CreditNote` correctly; the rest do not, and an XPath is documentation here rather than a resolved location (see the row on validating existing XML). |
| **`BR-CO-09` under the generic `en16931` profile** | The rule's list of accepted VAT prefixes is not the same list in the two syntaxes: UBL carries `SS` and not `AN`, CII carries `AN` and not `SS`. `profile: "en16931"` can be emitted as either document, so a value has to satisfy **both** lists — reporting only the laxer one would hand you `valid: true` on an input KoSIT rejects the moment you call the other generator. The cost is the other direction: `SS123456789` (South Sudan, a real ISO 3166-1 code) is a fatal `BR-CO-09` here under `en16931`, clean under `xrechnung-ubl`, and the UBL document carrying it is accepted by KoSIT. If you emit UBL only, say so with `profile: "xrechnung-ubl"` or `"peppol-bis-3"` and the rule is evaluated against the UBL list alone. The same applies to `AN` for a CII-only emitter. |
| **VIES lookups** | Out of scope for this package. |

## Fixtures

`fixtures/` ships in the npm tarball and holds eleven generated documents, all
checked against the official KoSIT validator on release:

- `xrechnung-ubl-minimal.xml` — domestic German invoice, two lines at 19% and 7%.
- `xrechnung-ubl-reverse-charge.xml` — cross-border DE→NL, VAT category AE.
- `xrechnung-ubl-discount.xml` — a German Schlussrechnung: a line allowance, a
  document allowance and a document charge in the 19% group, two VAT rates, an
  invoicing period instead of a delivery date, a reference to the
  Abschlagsrechnung it settles, a prepayment of 500.00 and a rounding amount of
  0.47 that takes the payable figure to a round 1 680.00.
- `xrechnung-cii-minimal.xml`, `xrechnung-cii-reverse-charge.xml`,
  `xrechnung-cii-discount.xml` — the same three invoices in CII. The inputs
  differ from the UBL ones only in `profile`, which is asserted by a test, so
  the pair is a like-for-like comparison of the two bindings.
- `xrechnung-cii-extended.xml` — a wide CII invoice added so the validator sees
  the groups the other three never reach: payee (BG-10), seller tax
  representative (BG-11), direct debit (BG-19) with mandate, SEPA creditor
  identifier and debited account, deliver-to party and address (BG-13/BG-15),
  two supporting documents (one external, one with an embedded attachment), the
  VAT accounting currency and BT-111, the tax point date, a gross price with a
  discount, and the full set of item identifiers.
- `xrechnung-ubl-credit-note.xml` — the minimal invoice, credited in full, as a
  `ubl:CreditNote`. It exists to be diffed against `xrechnung-ubl-minimal.xml`:
  root element, namespace, type-code element, line element, quantity element and
  the home of BT-9 are the whole difference.
- `xrechnung-ubl-credit-note-discount.xml` — the Schlussrechnung's awkward
  shapes, credited: a line allowance, a document allowance and a document charge
  in the 19% group, two VAT rates, and a reference to the invoice being credited.
  All amounts positive, because the document type carries the direction.
- `xrechnung-cii-credit-note.xml`, `xrechnung-cii-credit-note-discount.xml` —
  the same two credit notes in CII, where the entire structural difference from
  an invoice is `ram:TypeCode` 381.

Regenerate and re-verify:

```bash
npm run build
node scripts/emit-fixtures.mjs
./scripts/kosit-check.sh      # needs a JDK 11+; see scripts/kosit-check.md
```

`kosit-check.sh` takes `JAVA_BIN=/path/to/bin/java` if `java` is not on your
`PATH`. Re-run it whenever a fixture is added: a new fixture is a document
nobody has validated.

`npm test` asserts the committed XML still matches current output, so generator
drift shows up as a test failure rather than a stale file.

## Development

```bash
npm install
npm test      # unit tests, the committed fixtures, and the rule-coverage battery
npm run build
```

## Licence

MIT
