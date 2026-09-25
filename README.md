# @attestwire/en16931

[![CI](https://github.com/attestwire/en16931/actions/workflows/ci.yml/badge.svg)](https://github.com/attestwire/en16931/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@attestwire/en16931.svg)](https://www.npmjs.com/package/@attestwire/en16931)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![types: included](https://img.shields.io/badge/types-included-blue.svg)](https://www.npmjs.com/package/@attestwire/en16931)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

### E-invoice errors you can actually fix.

Validate and generate **XRechnung**, **Peppol BIS Billing 3.0** and the
**Factur-X / ZUGFeRD** XML (UBL 2.1 and UN/CEFACT CII) straight from TypeScript.
No Java, no server, no dependencies, no account. Every rejection names the rule,
explains why the regulation wants it, and tells you what to change.

```console
$ npx @attestwire/en16931 invoice-0142.xml
FAIL invoice-0142.xml  UBL · xrechnung-ubl
  ✗ error BR-DE-15 (BT-10)
    XRechnung requires a buyer reference (BT-10). For German public-sector buyers this is the Leitweg-ID; business buyers may supply any reference, but the field must be present.
    fix: Ask your client for their Leitweg-ID (public sector) or an order/customer reference, and set buyerReference.
    at:  /ubl:Invoice/cbc:BuyerReference  (nearest element in the file: <ubl:Invoice>, line 2)
    https://attestwire.com/rules/BR-DE-15
  ✗ error BR-DE-7 (BT-43)
    XRechnung requires the element "Seller contact email address" (BT-43). The seller contact group is present but incomplete — BR-DE-5, BR-DE-6 and BR-DE-7 each make one part of it mandatory, so supplying two of the three still fails.
    fix: Set seller.contact.email to a monitored mailbox — this is where the authority sends invoice queries.
    at:  /ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:Contact/cbc:ElectronicMail  (nearest element in the file: <cac:Contact>, line 44)
    https://attestwire.com/rules/BR-DE-7

1 document: 0 passed, 1 failed (2 errors, 0 warnings).
```

For the same file, the official XRechnung schematron says
`[BR-DE-15]-Das Element „Buyer reference“ (BT-10) muss übermittelt werden`, and
that is all it says. **[Try it in your browser →](https://attestwire.com/playground)**
(the playground is this package running client-side: your invoice never leaves the tab).

## Why use it

- **Errors that teach.** Each finding carries the official rule id, the business
  term, the *reason*, a concrete fix, an XPath and a passing example. You can fix
  the invoice without opening a 400-page standard, and so can your support
  desk or an LLM.
- **No JVM, anywhere.** The official validators are Java. This is TypeScript
  with zero runtime dependencies and no platform API beyond the JavaScript
  standard library, so the same build runs in Node 18+, Deno, Bun, Cloudflare
  Workers and the browser. Even the DEFLATE decoder for Factur-X PDFs is written
  in-repo.
- **Both syntaxes, both directions.** Generate *and* parse UBL 2.1 and CII D16B
  from one typed `InvoiceInput`, invoices and credit notes alike, and pull the
  XML out of a Factur-X or ZUGFeRD PDF.
- **Checked against the regulator, not against itself.** The generated fixtures
  are accepted by KoSIT, the German government's validator. Fuzzing, mutation
  testing and differential runs against KoSIT and the Peppol schematron are how bugs
  get found here, and every disagreement on record has a name and a reason. See
  [Conformance](#conformance).
- **Fast enough to run on every keystroke.** Parsing and validating a typical
  invoice takes well under a millisecond on a laptop, and a 1,000-line invoice
  tens of milliseconds. CI fails the build if that regresses.
- **Private by construction.** Nothing in the library makes a network call. The
  invoice data stays in your process.
- **Honest about its edges.** What it does not do is written down, in detail,
  [below](#not-implemented-yet), not discovered in production.

## What it covers

| Format | Syntax | Generate | Read | Validate |
| --- | --- | :---: | :---: | :---: |
| XRechnung 3.0 | UBL 2.1 | ✅ | ✅ | ✅ |
| XRechnung 3.0 | CII D16B | ✅ | ✅ | ✅ |
| Peppol BIS Billing 3.0 | UBL 2.1 (CII optional) | ✅ | ✅ | ✅ |
| Factur-X / ZUGFeRD, EN 16931 profile | CII inside a PDF/A-3 | the XML payload | ✅ from the PDF | ✅ |
| EN 16931 core | UBL 2.1 or CII D16B | ✅ | ✅ | ✅ |

Invoices and credit notes in all of them. 290 rules of the regulation (EN 16931
core, the XRechnung CIUS and Peppol BIS 3.0, including every `BR-CL-*` code list
in full), plus 15 checks of the library's own that catch input the XML could not
carry faithfully. Totals are always **computed** from the lines, never echoed,
so a generated document cannot fail its own arithmetic.

## Command line

Check invoices you already have, no code required:

```bash
npx @attestwire/en16931 invoice.xml
npx @attestwire/en16931 invoices/          # every .xml and .pdf, recursively
npx @attestwire/en16931 factur-x.pdf       # the CII payload inside the PDF
```

Exit status is 0 when every document passes, 1 when any fails and 2 on a usage
error, so it drops straight into a script or a CI step. A file it cannot read
counts as a failure, never a skip. Every finding names the line in your file:
the element itself when it is there, and where it belongs when it is missing,
in the file's own syntax (UBL or CII). `--short` prints one line per finding,
`--quiet` only failures, `--json` machine-readable output; `--fail-on warning`
fails on warnings too, `--profile <name>` judges every document against one
profile, and `--large` accepts invoices past the default size limits (about
3,000 lines). `npx @attestwire/en16931 --help` lists the rest.

Besides the rule findings `validateInput` returns, `validate()` and the
command line report a few of their own, about the file rather than the
invoice. They carry an `AW-` id and no `docsUrl`, and they are not rules, so
they are not in the rule counts: `AW-SIZE` (past the size limits without
`--large`, or `options.limits` raised), `AW-PDF` (a `.pdf` file that is not a PDF, or a
PDF with no readable invoice XML inside), `AW-PARSE` (not a UBL or CII
invoice), `AW-PROFILE-SUBSET` (a Factur-X MINIMUM or BASIC WL file, which
carries too little to be an EN 16931 invoice; fatal) and `AW-PROFILE-SYNTAX`
(a `--profile` or `options.profile` for the other syntax; a warning). The
command line alone reports `AW-IO` (the file could not be read). Until 0.10.0
the last two were both `AW-PROFILE`, and only the command line reported any
of them.

On GitHub, the
[Validate E-Invoice action](https://github.com/attestwire/validate-einvoice-action)
runs the same engine offline on every pull request, annotates the failing files
and can emit SARIF:

```yaml
- uses: attestwire/validate-einvoice-action@v1
  with:
    files: invoices/**/*.xml
```

## Quickstart

```bash
npm install @attestwire/en16931
```

**Which function.** Checking a file you already have (UBL, CII, or a Factur-X /
ZUGFeRD PDF)? Call `validate(bytes)`, shown under [Recipes](#recipes).
Building an invoice from your own data? Fill in an `InvoiceInput` object, check
it with `validateInput`, as below, and only then write the XML with
`generateXRechnungUBL` or `generateCii`. The generators do not validate.

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

That object is the whole input contract. Keep the `satisfies InvoiceInput`:
`profile` is a union of five string literals, and without it TypeScript widens
`"xrechnung-ubl"` to `string` and the call no longer compiles. The same object
feeds both generators: `generateXRechnungUBL(invoice)` returns UBL 2.1 XML, and
`generateCii({ ...invoice, profile: "xrechnung-cii" })` returns CII.

### 2. Take one field out

Remove the buyer reference (BT-10, the Leitweg-ID a German public-sector buyer
requires) and you get a rejection that names the rule and tells you what to do:

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

Both snippets, their `console.log` output and that JSON are executed and
type-checked against this build on every test run
(`src/readme-quickstart.test.ts` in the repository), so this page cannot drift
from the library.

## Recipes

**Why did my customer's platform reject this file?** Hand it over as it is. UBL,
CII and Factur-X / ZUGFeRD PDFs are told apart from their bytes, the declared
encoding is honoured, and every finding says which line of the file it is about:

```ts
import { readFile } from "node:fs/promises";
import { validate } from "@attestwire/en16931";

const result = validate(await readFile("invoice.xml")); // or invoice.pdf

for (const e of result.errors) console.log(`line ${e.location?.line}`, e.rule, e.fix);
```

`validate` never throws for anything about the file. A ZIP, an HTML login page
or a PDF with no invoice inside comes back as one fatal `AW-` finding naming what
it is, with the reader's own exception in `result.error`. `result.invoice` is the
invoice as read, ready for either generator.

**Generate the XML.** One model, pick the syntax by picking the function. The
generators write whatever they are given, fatal findings and all, so check
first:

```ts
import { generateCii, generateXRechnungUBL, validateInput } from "@attestwire/en16931";

const { valid, errors } = validateInput(invoice);
if (!valid) throw new Error(errors.map((e) => e.rule).join(", "));

const ubl = generateXRechnungUBL(invoice);                                 // XRechnung UBL
const cii = generateCii({ ...invoice, profile: "facturx-en16931" });      // Factur-X XML payload
const credit = generateXRechnungUBL({ ...invoice, invoiceNumber: "2026-G00021", invoiceTypeCode: "381" }); // credit note
```

**Plug it into what you already run:**

| | |
| --- | --- |
| **Stripe** | [`examples/stripe`](https://github.com/attestwire/en16931/tree/main/examples/stripe): a finalized Stripe invoice to validated XRechnung or Factur-X XML, in one file you copy. |
| **Medusa v2** | [`medusa-plugin-einvoice`](https://github.com/attestwire/medusa-plugin-einvoice): XRechnung and Factur-X XML for every order. |
| **GitHub Actions** | [`validate-einvoice-action`](https://github.com/attestwire/validate-einvoice-action): pull-request annotations, SARIF, fully offline. |
| **AI agents** | [Attestwire MCP server](https://attestwire.com/mcp): validate, explain and generate from Claude, Cursor or any MCP client. |
| **No Node at all** | [Hosted API](https://api.attestwire.com/docs): the same engine over HTTP, for PHP, Python, Go or anything else that can POST JSON. |
| **Any rule, explained** | [Rule reference](https://attestwire.com/rules/): one page per rule, with the reason, the fix and a passing example. Every finding's `docsUrl` points there. |

## How it compares

| | **@attestwire/en16931** | KoSIT validator | Mustang |
| --- | --- | --- | --- |
| Runtime | Any JavaScript runtime, browser included | Java | Java |
| Validates UBL and CII | ✅ | ✅ | ✅ |
| Generates UBL and CII XML | ✅ | — | ✅ |
| Reads Factur-X / ZUGFeRD PDFs | ✅ | — | ✅ |
| Writes Factur-X / ZUGFeRD PDFs | — | — | ✅ |
| Error output | rule, reason, fix, example, docs link | the schematron's assertion text | the schematron's assertion text |
| Status | a fast pre-flight, checked against KoSIT | **the reference** German receivers use | established Java library |

Use this package to catch and explain problems early, in the language your
stack already speaks. Where a receiver's verdict is what counts, run KoSIT too:
[`scripts/kosit-check.sh`](scripts/kosit-check.sh) does it for you. If you need
the PDF/A-3 container written, pair `generateCii` with a PDF/A-3 library or
Mustang.

## Limits worth knowing up front

- **It validates the invoice model, not the XML document.** A file is parsed
  into `InvoiceInput` and the rules run on that. It is not a schematron, so a
  document it passes can in principle still be rejected by KoSIT.
- **It does not write Factur-X or ZUGFeRD PDFs.** It writes the CII XML *payload*
  and reads the PDF. A file this package produces is a CII XML document, not a
  Factur-X file. [Why](#the-pdf-read-never-written).
- **It does not send invoices.** No Peppol access point, no transmission.
- The full, specific list is in [Not implemented yet](#not-implemented-yet).

---

# Reference

## Teaching errors

The [quickstart](#2-take-one-field-out) shows one missing field and the object
it produces. Every finding has that shape, and a rejection is a list of them
rather than "validation failed": drop the `buyerReference`, the `payment` block
and the seller `contact` from the quickstart invoice and `validateInput` reports
three fatal findings (`BR-DE-15`, `BR-DE-1`, `BR-DE-2`), with nothing in
`warnings` and nothing in `information`. (That count is asserted by
`src/readme-quickstart.test.ts` (repository) against this build.)

Errors explain the *reason*, not just the requirement. `BR-S-05` does not say
"rate must be > 0"; it says a zero rate with category S is contradictory, and
that if no VAT is due the category should be Z, E, AE, K, G or O, each with
different evidencing requirements.

Findings are separated by severity, because the reference validators separate
them: KoSIT's schematron flags each assertion `fatal`, `warning` or
`information`, and a report that promotes an advisory to an error is as wrong as
one that misses it. `result.valid` reflects fatal rules only, so advisory rules
(`BR-DE-27`, `BR-DE-28`) never block a build. `result.information` is a third
array, deliberately kept out of `warnings`: a caller who fails a build on a
non-empty `warnings` array should not be stopped by a finding the official
validator raises and then accepts. `BR-DE-TMP-32` (an invoice should state a
delivery date) is the rule that needs it.

If you switch or filter on `severity`, add the third value: a consumer that
allow-lists `['fatal', 'warning']` will silently drop `information` findings.
The union is exported as the type `Severity`, so a `switch` over it that misses
a case fails the build rather than the audit.

## Locations

`validateInput` judges an object, so the `xpath` on its findings is where the
element sits in the UBL this library would generate. `validate` judges a file,
and walks each finding back to the file:

```json
{
  "rule": "BR-CL-18",
  "xpath": "/rsm:CrossIndustryInvoice/rsm:SupplyChainTradeTransaction/ram:IncludedSupplyChainTradeLineItem[2]/ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax/ram:CategoryCode",
  "location": {
    "line": 137,
    "column": 11,
    "path": "/rsm:CrossIndustryInvoice/rsm:SupplyChainTradeTransaction/ram:IncludedSupplyChainTradeLineItem[2]/ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax/ram:CategoryCode",
    "exact": true
  }
}
```

That is the second line's VAT category in `fixtures/xrechnung-cii-extended.xml`
set to `Q`. `path` uses the prefixes the file declares; `xpath` is the same
element when it is found.

- **CII documents get CII paths.** A Factur-X or XRechnung CII finding points at
  the `ram:` element, not at a `cac:` path that does not exist in the file.
- **Positions are the file's.** The rules count a document's allowances before
  its charges; a file that states a charge first still gets the right element.
- **`exact: false` means "look here".** When the element is missing, the
  location is the element it belongs in, and `xpath` is where it goes. The same
  happens when the file holds several elements the rule could mean and nothing
  says which (several VAT breakdown groups, several tax registrations): the
  location is their parent rather than a guess.
- **From a PDF**, the line and column are in the embedded XML, and
  `location.attachment` names it. `toSarif` puts a line in the SARIF region only
  when it is a line of the file the log names.

## Reading an existing UBL invoice

`parseUbl` reads a UBL 2.1 `Invoice` **or `CreditNote`** document into the same
`InvoiceInput` object the rest of this package uses. That is what lets you
answer the question people actually arrive with: *my customer's platform
rejected this file. Why?*

The document type is detected from the root element, not asked for, and comes
back in `invoice.invoiceTypeCode`. Feed the result to `generateXRechnungUBL` and
you get the same document type out. (The function is still exported under its
old name, `parseUblInvoice`, which reads credit notes too.)

To **check** a file, you do not need the reader: `validate` detects the syntax,
reads it with `parseUbl` or `parseCiiInvoice`, runs the rules and points each
finding at its line (see [Recipes](#recipes) and [Locations](#locations)). Call
`parseUbl` yourself when you want the `InvoiceInput` object, to change a field
and generate the document again:

```ts
import { parseUbl, generateXRechnungUBL, validateInput } from "@attestwire/en16931";

const { invoice, unmapped } = parseUbl(xmlString);
const fixed = { ...invoice, buyerReference: "04011000-1234512345-06" };
if (validateInput(fixed).valid) {
  const corrected = generateXRechnungUBL(fixed);
}

for (const item of unmapped) {
  console.log(item.kind, item.path, item.reason);
}
```

**It is a reader, not an authority.** It tells you what is in the document, not
whether a receiver will accept it. A file that passes `validate` can still be
rejected by KoSIT or by a receiving platform: the rules run over what the
reader understood, not over the XML, and this build is not a schematron. See
[Not implemented yet](#not-implemented-yet).

### What it reads

Every element `generateXRechnungUBL` emits, mapped back to the field it came
from. The round trip is tested: for each committed fixture,
`generateXRechnungUBL(parseUbl(xml).invoice)` returns the identical
document, and the result validates identically, for the credit-note fixtures as
well as the invoice ones.

Namespaces are resolved by URI, not by prefix. A document that calls the two
common namespaces `b:` and `a:`, or that puts the root in the default
namespace, reads the same as one using `cbc:` and `cac:`. Element order does not
matter to the reader.

The document's own totals (BT-106 to BT-115) are read into `declaredTotals`, so
`validateInput` checks the document's arithmetic against ours under the
`BR-CO-*` rules. The VAT breakdown and the line net amounts are recomputed from
the lines instead of being stored, because that is how the input model works.

`parseUbl` also returns `customizationId` and `profileId`: BT-24 and
BT-23 exactly as the document states them. `invoice.profile` is derived from
BT-24. If BT-24 is missing or unknown, the profile falls back to `en16931` or is
guessed from the text, and the guess is reported in `unmapped`, because the
profile decides which CIUS rules run.

### What it refuses

It throws instead of returning a half-read invoice. Every error extends
`ParseError` and carries a stable `code`.

| Error | `code` | When |
| --- | --- | --- |
| `UnsupportedSyntaxError` | `unsupported_syntax` | The root element is neither a UBL `Invoice` nor a UBL `CreditNote`. A CII document (ZUGFeRD, Factur-X, XRechnung CII) gets its own message saying so and pointing at `parseCiiInvoice`. |
| `UnsupportedCreditNoteError` | `unsupported_document_type` | **Never.** Kept exported for compatibility; nothing has thrown it since credit notes became readable. |
| `XmlSecurityError` | see below | The document hit one of the security limits. |
| `XmlSyntaxError` | various | The document is not well-formed, or uses a construct outside the accepted subset. |

Factur-X and ZUGFeRD carry this CII inside a PDF/A-3. Since 0.7.0 that container
is **read**: `extractFacturX` returns the embedded XML, which you hand to
`parseCiiInvoice`. It is still never written.

### Security limits

The XML comes from someone else. The reader is written for the UBL subset and
refuses everything outside it, rather than accepting more and hoping.

| Defence | Limit | What it stops |
| --- | --- | --- |
| No DTD processing | any `<!DOCTYPE` or `<!ENTITY` in the document is refused (`xml_doctype_forbidden`, `xml_entity_declaration_forbidden`) | **XXE** — an external entity that reads a local file or makes a network request. Also the declaration half of billion-laughs. The check runs on the raw text, so a DOCTYPE inside a CDATA section is refused too. |
| No custom entity expansion | only `&amp; &lt; &gt; &quot; &apos;` and numeric character references are decoded (`xml_entity_forbidden`) | **Billion laughs.** An unknown entity is refused, never silently dropped — dropping one would change the text of a tax document without saying so. |
| Depth cap | 100 elements (`xml_too_deep`) | Deeply nested documents. A UBL invoice nests about eight levels. |
| Size cap | 8,000,000 characters (`xml_too_large`) | Memory exhaustion from a very large upload. |
| Element cap | 50,000 elements (`xml_too_many_elements`) | A flat document of millions of tiny elements, which passes both caps above. |
| Attribute cap | 256 per element (`xml_too_many_attributes`) | A root carrying tens of thousands of `xmlns:` declarations, each of which enters the namespace map every descendant lookup uses. |

All four numbers are the defaults in `DEFAULT_XML_LIMITS` and can be raised per
call: `parseUbl(xml, { maxCharacters: 16_000_000 })`.

**What the caps protect, and what they cost.** They are memory limits, chosen
from measurement, not from how big a file "feels". Every element in the
parsed tree retains roughly 250–400 bytes (the object, its four name strings,
its attribute array and its children array), so it is the element cap, not the
size cap, that bounds what a document can make the parser hold: at the default
50,000 elements the measured worst case is 35 ms and 16.3 MB retained. The size
cap is set high enough for the documents real validators accept, including
ones whose bulk is a single base64 attachment (a 3.29 MB CEN example parses in
twelve milliseconds and retains 0.4 MB).

The cost is that an unusually large invoice is refused, not parsed. The
largest fixture in this repository is under 10 kB and a thousand-line invoice
lands around 300 kB, so neither cap is a limit ordinary use meets. Base64
spends four characters per three bytes, so an attachment of about 6 MB fills
the default size cap on its own; that is the case to raise `maxCharacters` for,
deliberately.

⚠ **Changed in 0.4.0.** The size cap was 10,000,000 characters and the element
cap 200,000. Measured on Node 22, a legal document at the old size cap retained
about 81 MB of heap and about 306 MB of RSS, over the 128 MB a Cloudflare
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

- `"unknown"`: there is no field for it. **The content is gone from the
  model.** If it matters to you, read it from the XML yourself.
- `"recomputed"`: the element is understood, but the model derives the value
  instead of storing it. Line net amounts (BT-131) and the VAT breakdown
  (BT-116, BT-117) are the whole of this list for a document this package
  generated. Nothing is lost; the values come back from the lines.

An unmapped group is reported once, not once per element inside it. A number the
reader cannot read is reported too (including an empty element, which slipped
through this promise until 0.6.0), and the field is left unset, not guessed at.

For the six **document totals** that is no longer the end of it. Being left
unset used to mean nothing compared them and the document validated clean; since
0.6.0 the reader records what happened in `declaredTotals.defects`, and a total
that the document should state and does not fails `BR-12`, `BR-13`, `BR-14` or
`BR-15`, while one that is present and unreadable (`12,34`, say) fails
`ATW-DECLARED-TOTAL-NOT-A-NUMBER`. Building an invoice from the JSON model is
unaffected: omit a total there and the library computes it, as it always has.

### What a real XRechnung from a German portal will hit

Honestly: things this reader does not yet handle.

- **`ubl:SelfBilledInvoice` and `ubl:SelfBilledCreditNote`.** Two more UBL root
  elements, for documents the buyer issues. Refused by root element. BT-3 `389`
  and `261` are read and written on the ordinary `Invoice` and `CreditNote`
  roots, which is what EN 16931's binding asks for. It is the self-billing
  *workflow*, not the type code, that is out of scope.
- **`cac:Signature`, `cbc:CopyIndicator`, `cbc:UBLVersionID`** and the other UBL
  elements that carry no EN 16931 business term. These parse, and appear in
  `unmapped` as `"unknown"`. They are not errors.
- **Repeated groups the input model holds only once**: a second `cbc:Note`, a
  second `cac:PartyIdentification`, a second `cac:PaymentMeans`. The first is
  read; the rest are reported as `"unknown"`.
- **`cac:PaymentTerms` `#SKONTO#` lines.** XRechnung encodes discount terms in
  the payment-terms text. They are read as text, exactly as written, and are not
  parsed into fields.
- **A tax scheme other than `VAT` or `FC`** on a party is reported, not
  taken for a VAT number.

Nothing in that list produces a wrong invoice. Everything in it produces either
a clear refusal or an `unmapped` entry.

## The PDF: read, never written

Factur-X and ZUGFeRD are CII XML inside a PDF/A-3 container. **As of 0.7.0 the
container is read (extraction); it is still never built.**

To check one, hand the PDF's bytes to `validate`, which finds the attachment
and reports where in it each finding is:

```ts
import { readFile } from "node:fs/promises";
import { validate } from "@attestwire/en16931";

const result = validate(await readFile("invoice.pdf"));
console.log(result.container, result.valid);
```

The reader underneath is `extractFacturX`, which pulls the XML attachment out of
a Factur-X, ZUGFeRD or XRechnung-CII PDF, for when you want the XML itself:

```ts
import { readFile } from "node:fs/promises";
import { extractFacturX } from "@attestwire/en16931";

const { xml, attachmentName, warnings } = extractFacturX(await readFile("invoice.pdf"));
```

It reads classic cross-reference tables, cross-reference streams and object
streams, and inflates `FlateDecode` with a DEFLATE implementation written into
this package, so the zero-dependency promise holds and the function stays
synchronous. `warnings` carries what was odd but survivable: a non-standard
attachment name, a missing or wrong `/AFRelationship`, more than one XML
attachment. Malformed PDFs raise a named error with a stable `code`, never a
crash.

Writing it is still not implemented, and is not planned here. `generateCii`
emits the XML: it does not build the container, does not attach the XML under
the required name (`factur-x.xml`, or `xrechnung.xml` for the XRECHNUNG
reference profile), and does not set the `/AFRelationship` value Germany
requires (`Alternative`). A file *produced* by this package is a CII XML
document, not a Factur-X or ZUGFeRD document. The asymmetry is deliberate:
extraction either returns the attachment or throws, while a half-conformant
PDF/A-3 writer would emit files that look like Factur-X and are not.

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
money. A credit note carrying negative amounts reverses it back: that is a
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

- **BR-DE-17** admits `381`: XRechnung's eight codes are one list tested against
  both type-code elements. `261` (self-billed credit note) is a lawful EN 16931
  code and is *not* one of the eight, so it draws a warning there.
- **BR-DE-26 does not require a preceding invoice reference on a credit note.**
  It is widely believed to; the rule's own test names `384` (corrected invoice)
  and nothing else, on either document type, and KoSIT accepts a credit note with
  no BG-3 at all. Supplying one is still the ordinary case (the buyer cannot net
  two documents that do not reference each other), so this build says so at
  `information` level, the flag the regulator itself reserves for advice, under
  `ATW-CREDIT-NOTE-NO-PRECEDING-INVOICE`.

**Not covered:** self-billing as a *workflow*, and the UBL `SelfBilledInvoice` /
`SelfBilledCreditNote` root elements. BT-3 `389` and `261` generate and parse on
the ordinary root elements, which is what EN 16931's UBL binding uses; if a
platform demands one of those other roots, this package will not produce it.
Debit notes (`ubl:DebitNote`) are not supported either: EN 16931 has no binding
for them.

## CII: XRechnung CII and the Factur-X payload

```ts
import { generateCii, parseCiiInvoice } from "@attestwire/en16931";

const xml = generateCii({ ...invoice, profile: "xrechnung-cii" });
const { invoice: readBack, unmapped } = parseCiiInvoice(xml);
```

`generateCii` accepts `xrechnung-cii`, `facturx-en16931`, `en16931` and, since
0.7.0, `peppol-bis-3`. The core profile is syntax-neutral, so you pick the
syntax by picking the function. `xrechnung-ubl` is the one profile name that is
genuinely UBL-bound, and it throws; `xrechnung-cii` is the name for the same
rules in this syntax.

Earlier releases refused `peppol-bis-3` here, on the stated grounds that Peppol
BIS Billing 3.0 has no CII binding. **That was wrong.** OpenPEPPOL ships
`PEPPOL-EN16931-CII.sch` and a `peppolbis-en16931-01-3.0-cii` build
configuration, and the BIS describes CII D16B (the version this generator
emits) as *optional*, not absent: UBL is mandatory for every receiver, and CII
is accepted by receivers who register for it in the SMP. So sending
Peppol CII is a thing you must agree with your counterparty, not a thing this
library should have been deciding for you. One behaviour change comes with it:
under `peppol-bis-3` the CII generator omits BT-21 (`ram:SubjectCode`), which
`PEPPOL-EN16931-R002` forbids outright, and `validateInput` now raises `R002` as
a warning so you learn the rule instead of silently losing the field.

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
XML reader with `parseUbl`, including every one of its security limits, and
resolves everything by namespace URI, not by prefix.

One thing it cannot tell you: **Factur-X's EN 16931 profile and plain core
EN 16931 state the same BT-24** (`urn:cen.eu:en16931:2017`), so a
`facturx-en16931` document reads back with `profile: "en16931"`. Nothing is
lost: the rule set is identical and regenerating produces the same bytes. But if
you need the distinction, keep it yourself.

## API

| Export | Purpose |
| --- | --- |
| `validate(document, options?)` | An existing file — UBL or CII XML as a string or bytes, or a Factur-X / ZUGFeRD PDF as bytes — → `{ valid, syntax, profile, container, errors, warnings, information, invoice, unmapped, customizationId, profileId, error? }`. The same rules as `validateInput`, and each finding carries a `location` (`line`, `column`, `path`, `exact`) in the caller's file and an `xpath` in its own syntax. Options: `profile`, `limits`, `pdfLimits`. New in 0.10.0. |
| `validateInput(inv)` | Run all input rules. Returns `{ valid, profile, errors, warnings, information }`. Reports **every** finding, not the first. |
| `generateXRechnungUBL(inv, options?)` | JSON → UBL 2.1 `Invoice` XML string — or `CreditNote`, when `invoiceTypeCode` is a credit-note code. |
| `generateCii(inv, options?)` | JSON → UN/CEFACT CII (D16B) `CrossIndustryInvoice` XML string, for `xrechnung-cii`, `facturx-en16931`, `en16931` and `peppol-bis-3`. **XML only — this function never writes a PDF.** |
| `extractFacturX(bytes, limits?)` | Factur-X / ZUGFeRD PDF → `{ xml, attachmentName, warnings }`. Reads the embedded-file name tree and the `/AF` array, classic and stream cross-references, and object streams. Extraction only: the container is read, never built. |
| `toSarif(findings, provenance)` / `toJunitXml(findings, provenance, options?)` | Findings → a SARIF 2.1.0 log object, or a JUnit XML string, for CI. Pure: no clock, no filesystem. |
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

`GenerateOptions`: `indent` (default `"  "`), `customizationId`, `profileId`. The
last two let you pin an older CIUS version such as XRechnung 2.3.

### Refusals

Each generator throws instead of returning XML in two cases. Every error extends
`GenerationError`, carries a stable `code`, and explains in the message what
*is* supported:

| Error | `code` | When |
| --- | --- | --- |
| `UnsupportedProfileError` | `unsupported_profile` | From `generateXRechnungUBL`: `profile` is not one of `en16931`, `xrechnung-ubl`, `peppol-bis-3`. `xrechnung-cii` and `facturx-en16931` are CII documents — call `generateCii` for those. |
| `UnsupportedCiiProfileError` | `unsupported_profile` | From `generateCii`: `profile` is not one of `en16931`, `xrechnung-cii`, `facturx-en16931`, `peppol-bis-3`. `xrechnung-ubl` names the UBL binding of XRechnung specifically — use `generateXRechnungUBL`, or `xrechnung-cii` for the same rules in CII. |
| `PdfParseError` / `PdfSecurityError` / `PdfUnsupportedFilterError` / `FacturXNotFoundError` | see `code` | From `extractFacturX`: the bytes are not a readable PDF, a `PdfLimits` cap was hit, the file uses a compression filter this reader does not implement, or the PDF carries no XML attachment. All extend `PdfError`. |
| `UnsupportedDocumentTypeError` | `unsupported_document_type` | **Never.** It existed for one case — a credit-note `invoiceTypeCode` — and that case now generates a `ubl:CreditNote`. Kept exported so an existing `import` or `instanceof` does not break; the branch is simply never taken. |

Both generators now throw on the syntax and on nothing else. A credit-note BT-3
is a document, not a refusal.

### Rounding

Monetary sums are exact: each amount is rounded to the cent first, then the
cents are added as integers, so a 10,000-line invoice totals to the same cent as
a pencil-and-paper sum. The one cost is a ceiling. No amount, and no total
computed from amounts, may exceed `999,999,999,999.99` in absolute value
(exported as `MAX_MONETARY_AMOUNT`); past it a JavaScript number cannot hold every
cent. `validateInput` reports an invoice over the ceiling as a fatal
`ATW-AMOUNT-OUT-OF-RANGE` finding. `computeTotals` and the generators, which have
no findings to return, throw `AmountRangeError` (a `RangeError`, carrying the
offending `amount`). This is a limit of the library, not a rule of EN 16931.
Prices and quantities may carry more decimals; the ceiling applies to the amounts
computed from them.

EN 16931 sums **already-rounded** line amounts. Rounding only the final sum
drifts by a cent or two on long invoices and gets rejected under BR-CO-10.
`round2` is half-up and works around both JS traps: `Math.round(1.005 * 100)/100`
is `1.00`, and `(2.675).toFixed(2)` is `"2.67"`. Both are wrong for tax.

## Conformance

KoSIT, the German government's validator, accepts all eleven sample invoices
this library generates. One of them draws a warning from a European rule that
KoSIT itself has marked as broken and replaced; it passes the replacement.
None draws an error.

Validator 1.6.3, XRechnung configuration 3.0.2 (build of 31 August 2026), CEN
CII schematron 1.3.16, XRechnung CII schematron 2.6.0; recorded 24 September
2026 against engine 0.10.0. The validator's summary line was
`Acceptable: 11 Rejected: 0`. The three UBL invoices go through KoSIT's
`EN16931 XRechnung (UBL Invoice)` scenario, the two UBL credit notes through
its separate `EN16931 XRechnung (UBL CreditNote)` scenario against
`UBL-CreditNote-2.1.xsd`, and the six CII documents through
`EN16931 XRechnung (CII)`. Reproduce it with
[`scripts/kosit-check.sh`](scripts/kosit-check.sh), which needs a JDK; the
recorded output is in [`scripts/kosit-check.md`](scripts/kosit-check.md),
together with the credit-note probes and the two findings the CII run caught
before it went green.

<sub>The warning is `CII-SR-475` on the extended CII fixture, a rule that
miscounts attachments when an invoice has more than one
([CEN issue 508](https://github.com/ConnectingEurope/eInvoicing-EN16931/issues/508)).
KoSIT's configuration lowers it to information and checks `BR-TMP-4` instead,
which passes.</sub>

Even so, the run is a conformance check on eleven documents, not a parity suite:
it says nothing about the paths those fixtures do not exercise, and
`validateInput` is a pre-flight rather than a schematron (see
[Not implemented yet](#not-implemented-yet)).

**The same goes for Peppol and France.** [`scripts/peppol-check.sh`](scripts/peppol-check.sh)
puts the `peppol-bis-3` output through OpenPEPPOL's own schematrons, in both
syntaxes, and [`scripts/dgfip-check.sh`](scripts/dgfip-check.sh) checks the
fixtures against the schemas the French DGFiP publishes. What each run found,
and what was changed because of it, is recorded next to the script.

**Beyond the fixtures, the engine is tested adversarially.** Fuzzing and
parameter sweeps look for input that makes it throw or write a document it
would itself reject. Mutation testing looks for rules whose behaviour could
change with every test still green. Differential runs put the same documents,
official test files and hand-built hostile ones, through this package *and*
through KoSIT or the Peppol schematron, rule by rule. In the latest run, over
163 documents, every disagreement is classified and there is no case of the
official validator firing a rule this package implements while this package
stayed silent. The [CHANGELOG](CHANGELOG.md) lists what each round found and
fixed.

## Scope

### Implemented

| Area | Coverage |
| --- | --- |
| **XRechnung 3.0 UBL generation** | Full document: namespaces, BT-24/BT-23, header terms, both parties (incl. electronic address with `schemeID`, VAT vs. national tax scheme, legal entity, party and registration identifiers with their ISO 6523 schemes, trading name, contact), payee and tax representative parties, delivery group, payment means with card (`cac:CardAccount`) and direct debit (`cac:PaymentMandate`), payment terms, tax breakdown, monetary totals, lines. Plus document and line allowances and charges (`cac:AllowanceCharge`), invoicing periods at both levels, preceding invoice references (`cac:BillingReference`), the project/contract/despatch/receipt/tender/sales-order references, the invoiced object identifier and supporting documents (`cac:AdditionalDocumentReference`, including an embedded base64 attachment), item identifiers, origin country, commodity classification and item attributes, a second `cac:TaxTotal` for the VAT accounting currency, and the price allowance for BT-147/BT-148. Element order follows `UBL-Invoice-2.1.xsd`, and all three fixtures validate against the UBL 2.1 XSD. |
| **UBL credit notes** | `invoiceTypeCode: "381"` (or any other code on the credit-note half of UNTDID 1001) emits a `ubl:CreditNote` instead: the `CreditNote-2` namespace, `cbc:CreditNoteTypeCode`, `cac:CreditNoteLine` with `cbc:CreditedQuantity`, the tax point date before the type code, contract and additional references before the originator reference, and BT-9 in `cac:PaymentMeans/cbc:PaymentDueDate` because that document has no `cbc:DueDate`. Element order follows `UBL-CreditNote-2.1.xsd`; both credit-note fixtures pass KoSIT's own `EN16931 XRechnung (UBL CreditNote)` scenario. Every other business term is in the same place as on an invoice, and the whole rule set applies unchanged. |
| **XRechnung 3.0 UBL ingestion** | `parseUbl` (still exported as `parseUblInvoice`) reads a UBL 2.1 `Invoice` **or `CreditNote`** document back into the input model — every element the generator emits, resolved by namespace URI rather than by prefix, in any element order. Round-tripped over every committed fixture: parse then regenerate returns the identical document, and it validates identically. Anything not carried into the model is returned in `unmapped`. The XML reader is hand-rolled for the UBL subset and refuses DOCTYPEs, custom entities, mixed content and over-sized, over-deep or over-wide documents. The document type is detected from the root element and reported in `invoiceTypeCode`, so a credit note read here regenerates as a credit note. UBL is not carried in a PDF; for the CII-in-PDF case see `extractFacturX`. See [Reading an existing UBL invoice](#reading-an-existing-ubl-invoice). |
| **CII (D16B) generation** | `generateCii` emits a `rsm:CrossIndustryInvoice` for `xrechnung-cii`, `facturx-en16931`, `en16931` and `peppol-bis-3`, from the same `InvoiceInput`, with the same computed totals. Full document: the exchanged-document context (BT-23/BT-24), header terms, both trade parties (identifier vs. global identifier, legal organisation, contact, address, endpoint, VAT and national tax registrations), tax representative, payee, ship-to party and delivery event, payment means with financial card and direct debit, the VAT breakdown, document and line allowances and charges, billing periods at both levels, preceding invoices, the referenced-document family (BG-24 / BT-17 / BT-18 / BT-128, told apart by type code), procuring project, the monetary summation including BT-111, and lines with gross and net price, item identifiers, classification, origin country and attributes. Element order follows `CrossIndustryInvoice_*_100pD16B.xsd`; all six CII fixtures pass the D16B XSD and both CII schematrons. CII has no separate credit-note document, so a credit note is the same `rsm:CrossIndustryInvoice` with `ram:TypeCode` 381 and no other difference. |
| **CII (D16B) ingestion** | `parseCiiInvoice` reads a `CrossIndustryInvoice` back into the input model — every element the CII generator emits, resolved by namespace URI rather than by prefix, in any element order. Round-tripped over every committed CII fixture: parse then regenerate returns the identical document, and it validates identically. Same hardened XML reader and same security limits as the UBL path. Anything not carried into the model is returned in `unmapped`. |
| **BT coverage** | BT-1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161. |
| **Arithmetic** | BT-131 = quantity × (BT-146 / BT-149) − Σ BT-136 + Σ BT-141; BT-106 = Σ BT-131; BT-107 = Σ BT-92; BT-108 = Σ BT-99; BT-109 = BT-106 − BT-107 + BT-108; the BG-23 taxable amount per (category, rate) group nets document allowances out and charges in; BT-117 from BT-116 × BT-119; BT-110 = Σ BT-117; BT-112 = BT-109 + BT-110; BT-115 = BT-112 − BT-113 + BT-114. Per-line half-up rounding, and sums taken over the rounded values. BT-107 and BT-108 stay separate sums even where the breakdown nets them — that asymmetry is the standard's. |
| **Rules** | 290 regulation rules with teaching errors (enumerated below), plus sixteen `ATW-` findings of our own (listed at the end of the enumeration) — 306 distinct rule ids. 306 are reachable from caller input; none constrain only the library's own computed arithmetic. Both figures are read off a test run, not typed: `src/rules-invariants.test.ts` fires a battery of deliberately-broken invoices, and every rule id in the source must be either fired by it or named in that file's `ARITHMETIC_INVARIANTS` list with the reason no input can reach it. A rule that is neither fails the suite, so the guard is completeness rather than a number. That list is empty since 0.10.0, and the history of both figures is in the [CHANGELOG](CHANGELOG.md): the 0.9.0 README said 25 such rules, and every one turned out to be reachable from a document read from XML, three of them (BR-45, BR-46, BR-48) once 0.10.0 started checking the breakdown a document states. |
| **KoSIT conformance of the fixtures** | Checked on release against the official validator 1.6.3 / XRechnung 3.0.2 config (build of 2026-08-31) — for UBL: the UBL 2.1 XSD, the EN 16931 schematron and the XRechnung CIUS schematron; for CII: the UN/CEFACT D16B XSD, the EN 16931 CII schematron (1.3.16) and the XRechnung CII schematron (2.6.0). The two UBL credit notes are judged by KoSIT's separate `EN16931 XRechnung (UBL CreditNote)` scenario, against `UBL-CreditNote-2.1.xsd`. Eleven documents, not a parity suite — **recorded 2026-09-24 against engine 0.10.0, `Acceptable: 11 Rejected: 0`**. One of them draws a warning from a European rule that KoSIT itself has marked as broken and replaced; it passes the replacement. None draws an error. (The warning is `CII-SR-475` on the extended CII fixture; the XRechnung configuration lowers it to information and checks `BR-TMP-4` instead. See `scripts/kosit-check.md`, which also records the eight credit-note probes and the two findings the CII run caught first.) Run `./scripts/kosit-check.sh` yourself before relying on it. |

Rules implemented, by family. This list is maintained by hand; the
[rule reference](https://attestwire.com/rules/) derives its own from the engine.

- **Document and party**: `BR-01` (on a document read from XML that states no
  BT-24), `BR-02`, `BR-03`, `BR-04`, `BR-05`, `BR-06`, `BR-07`,
  `BR-08`, `BR-09`, `BR-10`, `BR-11`, `BR-12`, `BR-13`, `BR-14`, `BR-15`,
  `BR-16`, `BR-17` (payee), `BR-18`, `BR-19`, `BR-20`, `BR-56` (seller tax
  representative), `BR-57`, `BR-CO-26`.
- **Lines**: `BR-21`, `BR-22`, `BR-23`, `BR-24`, `BR-25`, `BR-26`, `BR-27`,
  `BR-28`, `BR-CO-04`.
- **Allowances and charges**. Document level (BG-20/BG-21): `BR-31`, `BR-32`,
  `BR-33`, `BR-36`, `BR-37`, `BR-38`, `BR-CO-11`, `BR-CO-12`, `BR-CO-21`,
  `BR-CO-22`. Line level (BG-27/BG-28): `BR-41`, `BR-42`, `BR-43`, `BR-44`,
  `BR-CO-23`, `BR-CO-24`.
- **VAT breakdown**: `BR-45`, `BR-46`, `BR-47`, `BR-48`, `BR-CO-17`,
  `BR-CO-18`.
- **VAT categories**: the `-01` (breakdown cardinality), `-02` (seller
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
- **Arithmetic against caller-declared totals**: `BR-CO-10`, `BR-CO-13`,
  `BR-CO-14`, `BR-CO-15`, `BR-CO-16`.
- **Periods and dates**: `BR-29`, `BR-30`, `BR-CO-03`, `BR-CO-19`, `BR-CO-20`.
- **References, items and attachments**: `BR-50`, `BR-51`, `BR-52`, `BR-53`,
  `BR-54`, `BR-55`, `BR-64`, `BR-65`.
- **Decimal precision**: `BR-DEC-01`, `BR-DEC-02`, `BR-DEC-05`, `BR-DEC-06`,
  `BR-DEC-09`, `BR-DEC-10`, `BR-DEC-11`, `BR-DEC-12`, `BR-DEC-13`, `BR-DEC-14`,
  `BR-DEC-15`, `BR-DEC-16`, `BR-DEC-17`, `BR-DEC-18`, `BR-DEC-19`, `BR-DEC-20`,
  `BR-DEC-23`, `BR-DEC-24`, `BR-DEC-25`, `BR-DEC-27`, `BR-DEC-28`.
- **Code lists**. Every `BR-CL-*` rule in the reference schematron:
  `BR-CL-01`, `BR-CL-03`, `BR-CL-04`, `BR-CL-05`, `BR-CL-06`, `BR-CL-07`,
  `BR-CL-08`, `BR-CL-10`, `BR-CL-11`, `BR-CL-13`, `BR-CL-14`, `BR-CL-15`,
  `BR-CL-16`, `BR-CL-17`, `BR-CL-18`, `BR-CL-19`, `BR-CL-20`, `BR-CL-21`,
  `BR-CL-22`, `BR-CL-23`, `BR-CL-24`, `BR-CL-25`, `BR-CL-26`. (There is no
  BR-CL-02, -09 or -12.)
- **VAT identifiers**: `BR-CO-09`, including the Greek `EL` derogation.
- **Payment**: `BR-49`, `BR-61`.
- **XRechnung CIUS**: `BR-DE-1`, `BR-DE-2`, `BR-DE-3`, `BR-DE-4`, `BR-DE-5`,
  `BR-DE-6`, `BR-DE-7`, `BR-DE-8`, `BR-DE-9`, `BR-DE-10`, `BR-DE-11`,
  `BR-DE-14`, `BR-DE-15`, `BR-DE-16`, `BR-DE-17`, `BR-DE-18`, `BR-DE-19`,
  `BR-DE-20`, `BR-DE-22`, `BR-DE-23-a`, `BR-DE-23-b`, `BR-DE-24-a`,
  `BR-DE-24-b`, `BR-DE-25-a`, `BR-DE-25-b`, `BR-DE-26`, `BR-DE-27`,
  `BR-DE-28`, `BR-DE-30`, `BR-DE-31`, `BR-DE-TMP-32`.
- **Transport**: `BR-62`, `BR-63`, `PEPPOL-EN16931-R010`,
  `PEPPOL-EN16931-R020`.
- **Peppol BIS Billing 3.0** (only on `profile: "peppol-bis-3"`):
  `PEPPOL-EN16931-R003`, `R005`, `R040`, `R041`, `R042`, `R046`, `R055`,
  `R061`, `R110`, `R111`, `R120`, `R121`; the code-list rules
  `PEPPOL-EN16931-CL007` and `CL008`; the process rules
  `PEPPOL-EN16931-P0100`, `P0101`, `P0110`, `P0112` and the VATEX/category
  pairs `P0104`, `P0105`, `P0106`, `P0107`, `P0108`, `P0109`, `P0111`; the
  date format rule `PEPPOL-EN16931-F001`; and the national
  identifier checksums `PEPPOL-COMMON-R040` .. `R050`, `R052`, `R053`.
- **Regional VAT categories**. IGIC (`L`): `BR-AF-01` .. `BR-AF-10`;
  IPSI (`M`): `BR-AG-01` .. `BR-AG-10`.
- **Library limitations and bindings** (`ATW-` prefix, not rules of the
  regulation). Input the XML could not carry faithfully:
  `ATW-INPUT-TYPE`, `ATW-TEXT-NOT-XML`, `ATW-NUMBER-NOT-FINITE`,
  `ATW-NUMBER-TOO-LARGE`, `ATW-VAT-RATE-OUT-OF-RANGE`,
  `ATW-DATE-NOT-A-CALENDAR-DATE`, `ATW-PROFILE-UNKNOWN`,
  `ATW-VAT-CATEGORY-UNSUPPORTED` and `ATW-AMOUNT-OUT-OF-RANGE`. Totals a
  document states but no reader can use: `ATW-DECLARED-TOTAL-NOT-FINITE` and
  `ATW-DECLARED-TOTAL-NOT-A-NUMBER`. And the four credit-note findings:
  `ATW-CREDIT-NOTE-NEGATIVE-AMOUNTS`, `ATW-CREDIT-NOTE-DUE-DATE-UNBOUND`,
  `ATW-CREDIT-NOTE-PROJECT-REFERENCE-UNBOUND` and
  `ATW-CREDIT-NOTE-NO-PRECEDING-INVOICE`. And a warning about the caller's
  units: `ATW-VAT-RATE-FRACTION`, a category S or L rate between 0 and 1,
  which is almost always a fraction (0.19) passed where the percentage (19)
  belongs. (`ATW-CREDIT-NOTE-UNSUPPORTED` was removed when the limitation it
  described was.)

### Code lists

Every coded field this model can express is checked against the **complete
official list**, not against a shape. The tables live in `src/codelists/` and are
generated by `scripts/build-codelists.mjs` from `EN16931-UBL-codes.sch` and
`EN16931-UBL-model.sch` in
[ConnectingEurope/eInvoicing-EN16931](https://github.com/ConnectingEurope/eInvoicing-EN16931)
at `validation-1.3.16`, the same artefacts the KoSIT validator evaluates, so the
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
lives in `EN16931-UBL-model.sch` and not in the codes file, because UBL has
no element for BT-21 and the note subject code has to be asserted inside the
model rules; the script fetches both files. And `BR-CL-11`, `BR-CL-21` and
`BR-CL-26` each restate the ISO 6523 list in full; the script asserts all three
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
neither strips whitespace, and the two literal lists are not even the same list:
UBL carries `SS` and not `AN`, CII carries `AN` and not `SS`. So:

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

The list below is what is known to be missing, not a survey of what is.

| Area | Status |
| --- | --- |
| **Full schematron parity** | Not reached, and this table is not a complete account of the gap. The build implements a large part of EN 16931 core, the XRechnung CIUS and Peppol BIS Billing 3.0 — 306 rule ids reachable from caller input — and the rows below name the exclusions we know about. They are not exhaustive: four separate coverage gaps were found in the two days before 0.4.0 (the seller half of `BR-AE-02`, `BR-CO-09` on BT-63, `BR-CL-14` on BT-69, and declared-versus-computed checks on BT-131, BT-116 and BT-117), none of which appeared in any earlier version of this list. Nothing in this repository measures coverage against the schematron, so treat an absent row as "not yet noticed", not as "does not exist". `validateInput` is still a fast pre-flight over the JSON input model, **not** an authority — it reads your input, not the XML a receiver will judge, so a document it accepts can in principle still be rejected by KoSIT. For the authoritative verdict, run KoSIT itself: `scripts/kosit-check.sh` shows how. |
| **VAT category B (split payment)** | `L` (IGIC) and `M` (IPSI) ship with their full `BR-AF-*` and `BR-AG-*` families. `B` does not. It is the one code of the ten with no `-01`/`-05`/`-08`/`-09`/`-10` family — only `BR-B-01` and `BR-B-02`, both of which exist to confine it to domestic Italian invoices — so expressing it would mean emitting rule ids the regulation does not define, or carving it out of every per-category loop for the sake of two checks. A line carrying `"B"` is a fatal `ATW-VAT-CATEGORY-UNSUPPORTED` finding rather than a silent pass. |
| **Amounts above 999,999,999,999.99** | Not representable exactly in a JavaScript number, so not computed: an invoice with any amount or computed total beyond `MAX_MONETARY_AMOUNT` is a fatal `ATW-AMOUNT-OUT-OF-RANGE` finding, and `computeTotals` and the generators throw `AmountRangeError`. EN 16931 itself sets no ceiling. In practice the finding almost always means a unit slip (cents entered as euros) rather than a real invoice that size; a genuine one would need splitting. See [Rounding](#rounding). |
| **XRechnung Extension and CVD profiles** | `BR-DEX-*` and `BR-DE-CVD-*` apply to customization ids this build does not emit. |
| **Rules that cannot be tested mechanically** | `BR-CO-05`, `BR-CO-06`, `BR-CO-07` and `BR-CO-08` require a reason code and a reason text to "indicate the same type of allowance". The reference schematron binds all four to `true()` — the regulator does not test them either. `BR-CO-25` is absent from both the reference schematron and Peppol's, so implementing it would reject documents the authority accepts. |
| **Rules the generator controls** | `BR-DE-21` constrains BT-24, which `generateXRechnungUBL` derives from `profile`; the only override is `GenerateOptions.customizationId`, which `validateInput` never sees. `BR-DE-13` is in the same position. They belong to a document-validation entry point, not an input pre-flight. `BR-01` (BT-24 present at all) does run on a document read from XML, since 0.9.0. |
| **Validating existing XML** | `validate` reads an existing file — a UBL 2.1 `Invoice` or `CreditNote`, a CII document, or the XML inside a Factur-X / ZUGFeRD PDF — into the input model and runs the rules over it. That is a **pre-flight over the parsed input, not a schematron over the document**. Two consequences. First, a rule that constrains the XML rather than the input — `BR-DE-13` and `BR-DE-21` on BT-24 — still does not run. Second, the reader recomputes the totals and the VAT breakdown from the lines, and checks the document's own stated figures against them — the totals, and since 0.9.0 the stated VAT breakdown too, with the tolerances each official binding uses — and checks them for presence: a document that does not state BT-106, BT-109, BT-112 or BT-115 fails `BR-12`/`BR-13`/`BR-14`/`BR-15`, and one that states a total no reader can turn into a number fails `ATW-DECLARED-TOTAL-NOT-A-NUMBER`. Since 0.10.0, `validate` points each finding at the element in the file itself — see [Locations](#locations). |
| **Writing a Factur-X / ZUGFeRD PDF** | Not started, and not planned in this package — *reading* one has been supported since 0.7.0 via `extractFacturX`, and the two directions are not symmetrical. To write one, the XML must be attached under a fixed name (`factur-x.xml`, except for the XRECHNUNG reference profile, which uses `xrechnung.xml`), the PDF must be PDF/A-3 conformant — fonts embedded, colour profile, XMP metadata, a conformance claim a validator checks — and Germany requires `/AFRelationship = Alternative` for the BASIC, EN 16931, EXTENDED and XRECHNUNG profiles. Getting any of that subtly wrong produces a file that looks like Factur-X and is not, which is a failure mode extraction does not have. `generateCii({ profile: "facturx-en16931" })` gives you the **CII XML payload**; take it to a PDF/A-3 library to make a Factur-X *file*. |
| **Peppol rules inside the XRechnung schematron** | KoSIT's XRechnung schematron — both the UBL and the CII one — includes a few `PEPPOL-EN16931-*` assertions (`R040` among them). This build gates its Peppol rules on `profile: "peppol-bis-3"`, so those do not run for an XRechnung input here even though KoSIT runs them. Found by the 2026-08-11 CII run; recorded in `scripts/kosit-check.md`. |
| **Self-billing** | The *documents* are supported — BT-3 `389` (self-billed invoice) and `261` (self-billed credit note) generate, parse and validate, and both are lawful EN 16931 type codes on the ordinary root elements. What is not here: the UBL `SelfBilledInvoice` and `SelfBilledCreditNote` root elements (which EN 16931's UBL binding does not use), and anything about the self-billing *process* — the buyer-issues-the-document agreement, the supplier's approval loop, the reverse party mapping. If your platform requires one of those root elements, this package will not produce it. Note also that `261` is outside XRechnung's eight-code list, so it draws a `BR-DE-17` warning there — KoSIT agrees, at warning level, and accepts the document. |
| **Debit notes** | Not supported, and not planned: UBL has a `DebitNote` root element and EN 16931 has no binding for it. |
| **BT-11 on a UBL credit note** | `cac:ProjectReference` does not exist in `UBL-CreditNote-2.1.xsd`, so no conformant UBL credit note can carry a project reference. Reported as `ATW-CREDIT-NOTE-PROJECT-REFERENCE-UNBOUND` rather than dropped silently. The CII binding keeps it. |
| **`BR-CO-09` under the generic `en16931` profile** | The rule's list of accepted VAT prefixes is not the same list in the two syntaxes: UBL carries `SS` and not `AN`, CII carries `AN` and not `SS`. `profile: "en16931"` can be emitted as either document, so a value has to satisfy **both** lists — reporting only the laxer one would hand you `valid: true` on an input KoSIT rejects the moment you call the other generator. The cost is the other direction: `SS123456789` (South Sudan, a real ISO 3166-1 code) is a fatal `BR-CO-09` here under `en16931`, clean under `xrechnung-ubl`, and the UBL document carrying it is accepted by KoSIT. If you emit UBL only, say so with `profile: "xrechnung-ubl"` or `"peppol-bis-3"` and the rule is evaluated against the UBL list alone. The same applies to `AN` for a CII-only emitter. |
| **VIES lookups** | Out of scope for this package. |

## Fixtures

`fixtures/` ships in the npm tarball and holds eleven generated documents, all
checked against the official KoSIT validator on release:

- `xrechnung-ubl-minimal.xml`: domestic German invoice, two lines at 19% and 7%.
- `xrechnung-ubl-reverse-charge.xml`: cross-border DE→NL, VAT category AE.
- `xrechnung-ubl-discount.xml`: a German Schlussrechnung: a line allowance, a
  document allowance and a document charge in the 19% group, two VAT rates, an
  invoicing period instead of a delivery date, a reference to the
  Abschlagsrechnung it settles, a prepayment of 500.00 and a rounding amount of
  0.47 that takes the payable figure to a round 1 680.00.
- `xrechnung-cii-minimal.xml`, `xrechnung-cii-reverse-charge.xml`,
  `xrechnung-cii-discount.xml`: the same three invoices in CII. The inputs
  differ from the UBL ones only in `profile`, which is asserted by a test, so
  the pair is a like-for-like comparison of the two bindings.
- `xrechnung-cii-extended.xml`: a wide CII invoice added so the validator sees
  the groups the other three never reach: payee (BG-10), seller tax
  representative (BG-11), direct debit (BG-19) with mandate, SEPA creditor
  identifier and debited account, deliver-to party and address (BG-13/BG-15),
  two supporting documents (one external, one with an embedded attachment), the
  VAT accounting currency and BT-111, the tax point date, a gross price with a
  discount, and the full set of item identifiers.
- `xrechnung-ubl-credit-note.xml`: the minimal invoice, credited in full, as a
  `ubl:CreditNote`. It exists to be diffed against `xrechnung-ubl-minimal.xml`:
  root element, namespace, type-code element, line element, quantity element and
  the home of BT-9 are the whole difference.
- `xrechnung-ubl-credit-note-discount.xml`: the Schlussrechnung's awkward
  shapes, credited: a line allowance, a document allowance and a document charge
  in the 19% group, two VAT rates, and a reference to the invoice being credited.
  All amounts positive, because the document type carries the direction.
- `xrechnung-cii-credit-note.xml`, `xrechnung-cii-credit-note-discount.xml`:
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
drift shows up as a test failure, not a stale file.

## Development

```bash
npm install
npm test      # unit tests, the committed fixtures, and the rule-coverage battery
npm run build
```

## Licence

MIT.

### Trademark

The MIT licence covers the code in this package and nothing else. "Attestwire"™ and
the Attestwire logo are trademarks of this project's owner, and no trademark
right is granted with the copyright licence.

Say what is true and there is no problem: that your product uses this library, or
is built on it, or validates with it. What the licence does not let you do is
name or brand a product or service "Attestwire", or word things so a reader would
take your work for ours or for something we endorse.
