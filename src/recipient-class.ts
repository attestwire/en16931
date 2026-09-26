/**
 * What a finding means for the business that RECEIVED the invoice, under the
 * German BMF letter on mandatory e-invoicing.
 *
 * Source: BMF-Schreiben vom 15. Oktober 2025, III C 2 - S 7287-a/00019/007/243,
 * "Einführung der obligatorischen elektronischen Rechnung bei Umsätzen zwischen
 * inländischen Unternehmern ab dem 1. Januar 2025; Anpassung des
 * Umsatzsteuer-Anwendungserlasses", and the sections of the
 * Umsatzsteuer-Anwendungserlass (UStAE) it rewrites. The letter sorts what a
 * validator reports into three kinds, and so does this table:
 *
 *  - `format` — Rn. 6a, UStAE 14.1 Abs. 11 Sätze 4–5: a file that does not
 *    match an admissible syntax or its technical requirements, "welcher Art
 *    die Formatfehler sind" being irrelevant, is not an e-invoice but a
 *    "sonstige Rechnung" (UStAE 14.1 Abs. 2 Satz 4 Nr. 2), as is a PDF with no
 *    structured data in it. A Factur-X / ZUGFeRD MINIMUM or BASIC WL file is
 *    not among the admissible formats either (UStAE 14.1 Abs. 14 Satz 4).
 *  - `vat-relevant` — Rn. 35a, UStAE 14.5 Abs. 1 Sätze 7–8: a business-rule
 *    finding (Rn. 6b, "Geschäftsregelfehler") about content §§ 14 Abs. 4 and
 *    14a UStG require makes the invoice not "ordnungsmäßig": the full name and
 *    address of supplier and recipient, the supplier's tax number or VAT
 *    identifier, the issue date, the invoice number, the quantity and kind of
 *    the goods or services, the date of supply, the net amount per rate or
 *    exemption, the tax rate and amount or the exemption note, agreed
 *    reductions (UStAE 14.5 Abs. 19), the reverse-charge note and the parties'
 *    VAT identifiers (§ 14a), the marking of a self-billed invoice, which an
 *    e-invoice makes through its type code (UStAE 14.5 Abs. 24), and, for a
 *    correction or credit note, the reference to the invoice it corrects
 *    (UStAE 14.11 Abs. 1). A fiscal representative's name, address and number
 *    (§ 22c UStG) count too.
 *  - `formal` — Rn. 35a Satz 3, UStAE 14.5 Abs. 1 Satz 9: a business-rule
 *    finding about any other content is "umsatzsteuerlich unbeachtlich". The
 *    letter's own example is the missing buyer reference (BT-10) of an
 *    XRechnung; so are contact data, electronic addresses and routing
 *    identifiers, payment details, attachments, and code-list formalities that
 *    leave the VAT content legible. Findings about the PDF of a hybrid
 *    invoice whose XML was read are formal as well: in a hybrid format the
 *    structured part is the leading one, and where the two differ the
 *    structured data prevail (UStAE 14.4 Abs. 3).
 *
 * This is Attestwire's reading of the letter, not tax advice, and a class says
 * nothing a finding does not: `vat-relevant` does not mean the content is
 * wrong, only that the finding is about content the VAT law requires. The
 * letter is explicit that a validation supports the recipient's own check of
 * the invoice for completeness and correctness and does not replace it, and
 * that a content error can exist where no rule fires, a wrong tax rate being
 * its example (Rn. 35a; UStAE 14.5 Abs. 1 Sätze 10–11).
 *
 * The class is per rule id, not per finding. Where one id covers several
 * business terms (a date check that fires on the issue date and on the due
 * date alike) it takes the class of the one that matters most, which is the
 * cautious direction. An id this table does not know, from another validator
 * or a newer engine, is `vat-relevant`, so that nothing unrecognised is waved
 * through as a formality.
 */

/** The three kinds of finding the BMF letter of 15 October 2025 distinguishes. */
export type RecipientClass = "format" | "vat-relevant" | "formal";

/**
 * No structured invoice was read, or the value cannot be written in the
 * syntax at all (Rn. 6a; UStAE 14.1 Abs. 2 Satz 4 Nr. 2, Abs. 11, Abs. 14).
 */
const FORMAT = [
  // The file is not UBL or CII XML, not the text its encoding says, or a
  // Factur-X file's XML could not be read (Rn. 6a).
  "AW-PARSE",
  // A PDF with no readable invoice XML inside: "PDF-Dateien ohne integrierte
  // Datensätze" are sonstige Rechnungen (UStAE 14.1 Abs. 2 Satz 4 Nr. 2).
  "AW-PDF",
  // Factur-X / ZUGFeRD MINIMUM and BASIC WL: excluded from the admissible
  // e-invoice formats by name (UStAE 14.1 Abs. 14 Satz 4).
  "AW-PROFILE-SUBSET",
  // The check stopped before any structured invoice was read: past the size
  // limits, or the file could not be read at all. These do not show a format
  // error, only that none was ruled out; raise the limit or fix the read and
  // validate again before treating the file as one.
  "AW-SIZE",
  "AW-IO",
  // A value the syntax's own types cannot hold. An amount is an xs:decimal in
  // UBL and in CII, so "12,34" fails the schema, which Rn. 6a calls a format
  // error of any kind; NaN, 1e21 and U+0000 cannot be written at all.
  "ATW-DECLARED-TOTAL-NOT-A-NUMBER",
  "ATW-DECLARED-TOTAL-NOT-FINITE",
  "ATW-NUMBER-NOT-FINITE",
  "ATW-NUMBER-TOO-LARGE",
  "ATW-TEXT-NOT-XML",
  // Not an invoice object, or a value of the wrong type (a number where text
  // belongs): it cannot be written as a document as it stands, and the rules
  // could not all run over it.
  "ATW-INPUT-TYPE",
] as const;

/**
 * Business-rule findings about content §§ 14 Abs. 4, 14a UStG (and § 22c UStG)
 * require (Rn. 35a; UStAE 14.5 Abs. 1 Sätze 7–8).
 */
const VAT_RELEVANT = [
  // § 14 Abs. 4 Satz 1 Nr. 4 and 3: the invoice number and the issue date.
  "BR-02",
  "BR-03",
  // The type code is where an e-invoice marks a self-billed invoice (Nr. 10;
  // UStAE 14.5 Abs. 24 Satz 1) and a correction (UStAE 14.11 Abs. 1 Satz 7):
  // missing, or not a code at all.
  "BR-04",
  "BR-CL-01",
  // Every amount is stated in the invoice currency; without one, neither the
  // consideration nor the tax amount can be read (Nr. 7, 8).
  "BR-05",
  // Nr. 1: the full name and address of the supplier and of the recipient.
  "BR-06",
  "BR-07",
  "BR-08",
  "BR-09",
  "BR-10",
  "BR-11",
  "BR-DE-3",
  "BR-DE-4",
  "BR-DE-8",
  "BR-DE-9",
  // § 22c UStG: a fiscal representative's name, address and number.
  "BR-18",
  "BR-19",
  "BR-20",
  "BR-56",
  // Nr. 5: the quantity and kind of the goods or services, line by line, and
  // the figures the consideration (Nr. 7) is computed from.
  "BR-16",
  "BR-22",
  "BR-23",
  "BR-24",
  "BR-25",
  "BR-26",
  "BR-27",
  "BR-CO-04",
  "PEPPOL-EN16931-R046",
  "PEPPOL-EN16931-R120",
  "PEPPOL-EN16931-R121",
  // Nr. 6: the date of supply, which an e-invoice must state in its
  // structured data (UStAE 14.5 Abs. 16 Sätze 3–4): the periods, the tax
  // point, and dates that are not dates.
  "BR-29",
  "BR-30",
  "BR-CO-03",
  "BR-CO-19",
  "BR-CO-20",
  "BR-CL-06",
  "BR-DE-TMP-32",
  "PEPPOL-EN16931-R110",
  "PEPPOL-EN16931-R111",
  "PEPPOL-EN16931-F001",
  "ATW-DATE-NOT-A-CALENDAR-DATE",
  // Nr. 7: allowances and charges change the consideration, and an agreed
  // reduction must be stated (UStAE 14.5 Abs. 19), Skonto included (BR-DE-18,
  // UStAE 14.5 Abs. 19 Satz 11).
  "BR-31",
  "BR-32",
  "BR-36",
  "BR-37",
  "BR-41",
  "BR-43",
  "BR-CO-11",
  "BR-CO-12",
  "BR-DE-18",
  "PEPPOL-EN16931-R040",
  // Nr. 7 and 8: the net amount per rate or exemption, the rate, the tax
  // amount, and totals that contradict them (the letter's own example of a
  // business-rule error is a tax amount that does not match the rate, Rn. 6b).
  "BR-45",
  "BR-46",
  "BR-47",
  "BR-48",
  "BR-53",
  "BR-CO-10",
  "BR-CO-13",
  "BR-CO-14",
  "BR-CO-17",
  "BR-CO-18",
  "BR-CL-17",
  "BR-CL-18",
  "BR-DE-14",
  "PEPPOL-EN16931-R055",
  "ATW-AMOUNT-OUT-OF-RANGE",
  "ATW-VAT-CATEGORY-UNSUPPORTED",
  "ATW-VAT-RATE-FRACTION",
  "ATW-VAT-RATE-OUT-OF-RANGE",
  // Nr. 8 and § 14a: the exemption or reverse-charge note, as text or code,
  // and a note that contradicts the category it is on.
  "BR-CL-22",
  "PEPPOL-EN16931-P0104",
  "PEPPOL-EN16931-P0105",
  "PEPPOL-EN16931-P0106",
  "PEPPOL-EN16931-P0107",
  "PEPPOL-EN16931-P0108",
  "PEPPOL-EN16931-P0109",
  "PEPPOL-EN16931-P0110",
  "PEPPOL-EN16931-P0111",
  // Nr. 2 and § 14a: the supplier's tax number or VAT identifier, and the
  // buyer's under reverse charge and for an intra-community supply.
  "BR-CO-09",
  "BR-DE-16",
  "PEPPOL-COMMON-R056-2",
  // The per-category families (-01 breakdown, -02 to -04 identifiers, -05 to
  // -07 rates, -08 taxable amount, -09 tax amount, -10 exemption note), each
  // about the tax treatment itself, and the category rules that sit beside
  // them.
  "BR-S-01", "BR-S-02", "BR-S-03", "BR-S-04", "BR-S-05", "BR-S-06", "BR-S-07", "BR-S-08", "BR-S-09", "BR-S-10",
  "BR-Z-01", "BR-Z-02", "BR-Z-03", "BR-Z-04", "BR-Z-05", "BR-Z-06", "BR-Z-07", "BR-Z-08", "BR-Z-09", "BR-Z-10",
  "BR-E-01", "BR-E-02", "BR-E-03", "BR-E-04", "BR-E-05", "BR-E-06", "BR-E-07", "BR-E-08", "BR-E-09", "BR-E-10",
  "BR-AE-01", "BR-AE-02", "BR-AE-03", "BR-AE-04", "BR-AE-05", "BR-AE-06", "BR-AE-07", "BR-AE-08", "BR-AE-09", "BR-AE-10",
  "BR-IC-01", "BR-IC-02", "BR-IC-03", "BR-IC-04", "BR-IC-05", "BR-IC-06", "BR-IC-07", "BR-IC-08", "BR-IC-09", "BR-IC-10",
  "BR-G-01", "BR-G-02", "BR-G-03", "BR-G-04", "BR-G-05", "BR-G-06", "BR-G-07", "BR-G-08", "BR-G-09", "BR-G-10",
  "BR-O-01", "BR-O-02", "BR-O-03", "BR-O-04", "BR-O-05", "BR-O-06", "BR-O-07", "BR-O-08", "BR-O-09", "BR-O-10",
  "BR-AF-01", "BR-AF-02", "BR-AF-03", "BR-AF-04", "BR-AF-05", "BR-AF-06", "BR-AF-07", "BR-AF-08", "BR-AF-09", "BR-AF-10",
  "BR-AG-01", "BR-AG-02", "BR-AG-03", "BR-AG-04", "BR-AG-05", "BR-AG-06", "BR-AG-07", "BR-AG-08", "BR-AG-09", "BR-AG-10",
  "BR-IC-11",
  "BR-IC-12",
  "BR-O-11",
  "BR-O-12",
  "BR-O-13",
  "BR-O-14",
  // A credit note or correction must refer to the invoice it corrects
  // (UStAE 14.11 Abs. 1; § 31 Abs. 5 UStDV), and a credit note's amounts
  // carry the direction of the tax.
  "BR-55",
  "BR-DE-26",
  "ATW-CREDIT-NOTE-NO-PRECEDING-INVOICE",
  "ATW-CREDIT-NOTE-NEGATIVE-AMOUNTS",
] as const;

/**
 * Business-rule findings about content the VAT law does not require, which
 * the letter calls "umsatzsteuerlich unbeachtlich" (Rn. 35a Satz 3; UStAE 14.5
 * Abs. 1 Satz 9), and findings about the PDF of a hybrid invoice whose XML was
 * read (UStAE 14.4 Abs. 3).
 */
const FORMAL = [
  // The specification identifier and the profile: which rules apply, not
  // what the invoice says.
  "BR-01",
  "ATW-PROFILE-UNKNOWN",
  "AW-PROFILE-SYNTAX",
  // Document totals the VAT breakdown already carries per rate, and the
  // payment side of them: the gross total, the amount due, the paid and
  // rounding amounts.
  "BR-12",
  "BR-13",
  "BR-14",
  "BR-15",
  "BR-CO-15",
  "BR-CO-16",
  // The buyer reference, the letter's own example (Rn. 35a), and the order
  // reference Peppol asks for in its place.
  "BR-DE-15",
  "PEPPOL-EN16931-R003",
  // Contact data.
  "BR-DE-2",
  "BR-DE-5",
  "BR-DE-6",
  "BR-DE-7",
  "BR-DE-27",
  "BR-DE-28",
  // Electronic addresses, routing and party identifiers, and their schemes.
  "BR-62",
  "BR-63",
  "BR-CO-26",
  "BR-CL-10",
  "BR-CL-11",
  "BR-CL-25",
  "PEPPOL-EN16931-R010",
  "PEPPOL-EN16931-R020",
  "PEPPOL-EN16931-CL008",
  "PEPPOL-COMMON-R040",
  "PEPPOL-COMMON-R041",
  "PEPPOL-COMMON-R042",
  "PEPPOL-COMMON-R043",
  "PEPPOL-COMMON-R044",
  "PEPPOL-COMMON-R045",
  "PEPPOL-COMMON-R046",
  "PEPPOL-COMMON-R047",
  "PEPPOL-COMMON-R049",
  "PEPPOL-COMMON-R050",
  "PEPPOL-COMMON-R052",
  "PEPPOL-COMMON-R053",
  "PEPPOL-COMMON-R054",
  "PEPPOL-COMMON-R055",
  "PEPPOL-COMMON-R056-1",
  "PEPPOL-COMMON-R057",
  "ATW-LEITWEG-ID-INVALID",
  "ATW-SIREN-INVALID",
  "ATW-SIRET-INVALID",
  // The input model's business facts (vatScenario and the payment means
  // inferred from an account). They judge what an issuer typed before any XML
  // existed; a received document states codes, never scenarios, so none of
  // them can be about the content of an invoice a recipient holds.
  "ATW-VAT-SCENARIO-APPLIED",
  "ATW-VAT-SCENARIO-CONFLICT",
  "ATW-VAT-SCENARIO-FACT-MISSING",
  "ATW-VAT-SCENARIO-UNKNOWN",
  "ATW-VAT-SCENARIO-UNSUPPORTED",
  "ATW-PAYMENT-MEANS-INFERRED",
  // The payee, and payment: means, accounts, cards, mandates, the due date.
  "BR-17",
  "BR-49",
  "BR-50",
  "BR-51",
  "BR-61",
  "BR-CL-16",
  "BR-DE-1",
  "BR-DE-19",
  "BR-DE-20",
  "BR-DE-23-a",
  "BR-DE-23-b",
  "BR-DE-24-a",
  "BR-DE-24-b",
  "BR-DE-25-a",
  "BR-DE-25-b",
  "BR-DE-30",
  "BR-DE-31",
  "PEPPOL-EN16931-R061",
  "ATW-IBAN-INVALID",
  "ATW-BIC-INVALID",
  "ATW-CREDIT-NOTE-DUE-DATE-UNBOUND",
  // The reasons given for an allowance or charge, whose amount and category
  // are what the tax turns on, and a base or percentage stated beside an
  // amount that is there.
  "BR-33",
  "BR-38",
  "BR-42",
  "BR-44",
  "BR-CO-21",
  "BR-CO-22",
  "BR-CO-23",
  "BR-CO-24",
  "BR-CL-19",
  "BR-CL-20",
  "PEPPOL-EN16931-R041",
  "PEPPOL-EN16931-R042",
  // Line and item details beyond quantity, kind and price: identifiers,
  // classifications, attributes, origin, the gross price before a discount.
  "BR-21",
  "BR-28",
  "BR-54",
  "BR-64",
  "BR-65",
  "BR-CL-13",
  "BR-CL-15",
  "BR-CL-21",
  // The delivery address, notes, references, attachments.
  "BR-57",
  "BR-DE-10",
  "BR-DE-11",
  "BR-CL-26",
  "BR-CL-08",
  "PEPPOL-EN16931-R002",
  "BR-CL-07",
  "BR-52",
  "BR-CL-24",
  "BR-DE-22",
  "ATW-CREDIT-NOTE-PROJECT-REFERENCE-UNBOUND",
  // Code-list formalities that leave the VAT content legible: a currency, a
  // country or a unit written as a word or a near-miss rather than as the
  // code ("euro", "UK", "Stk"), and type codes the CIUS or Peppol narrow
  // further although the code itself names the document type.
  "BR-CL-03",
  "BR-CL-04",
  "BR-CL-05",
  "BR-CL-14",
  "BR-CL-23",
  "PEPPOL-EN16931-CL007",
  "PEPPOL-EN16931-R005",
  "BR-DE-17",
  "PEPPOL-EN16931-P0100",
  "PEPPOL-EN16931-P0101",
  "PEPPOL-EN16931-P0112",
  // Decimal precision: the figure is there and readable; the finding is about
  // how many places it is written with.
  "BR-DEC-01", "BR-DEC-02", "BR-DEC-05", "BR-DEC-06", "BR-DEC-09", "BR-DEC-10", "BR-DEC-11",
  "BR-DEC-12", "BR-DEC-13", "BR-DEC-14", "BR-DEC-15", "BR-DEC-16", "BR-DEC-17", "BR-DEC-18",
  "BR-DEC-19", "BR-DEC-20", "BR-DEC-23", "BR-DEC-24", "BR-DEC-25", "BR-DEC-27", "BR-DEC-28",
  // The PDF container of a hybrid invoice whose XML was read: the structured
  // part leads and prevails where the two differ (UStAE 14.4 Abs. 3). These
  // six arrive with the container findings of `validate()`.
  "AW-PDF-ATTACHMENT",
  "AW-PDF-AF",
  "AW-PDF-RELATIONSHIP",
  "AW-PDF-MIME",
  "AW-PDF-XMP",
  "AW-PDF-XMP-PROFILE",
] as const;

/**
 * Every rule id, `AW-` finding and `ATW-` finding this build knows, with its
 * class, in the order of the lists above. The test that every id has exactly
 * one class reads this, so a duplicate cannot hide in a lookup object.
 */
export const RECIPIENT_CLASS_ENTRIES: readonly (readonly [string, RecipientClass])[] = Object.freeze([
  ...FORMAT.map((id) => [id, "format"] as const),
  ...VAT_RELEVANT.map((id) => [id, "vat-relevant"] as const),
  ...FORMAL.map((id) => [id, "formal"] as const),
]);

const BY_ID: ReadonlyMap<string, RecipientClass> = new Map(RECIPIENT_CLASS_ENTRIES);

/** The same table keyed by upper-cased id, so `br-de-15` finds `BR-DE-15` and `BR-DE-23-A` finds `BR-DE-23-a`. */
const BY_UPPER_CASE: ReadonlyMap<string, RecipientClass> = new Map(
  RECIPIENT_CLASS_ENTRIES.map(([id, cls]) => [id.toUpperCase(), cls]),
);

/**
 * The class of a finding for the business that received the invoice, by rule
 * id: `format` (not an e-invoice at all), `vat-relevant` (about content the
 * VAT law requires on an invoice) or `formal` (about anything else). Per the
 * BMF letter of 15 October 2025, Rn. 6a, 6b and 35a; the module comment says
 * how each id was placed. Attestwire's reading of the letter, not tax advice.
 *
 * An id this build does not know is `vat-relevant`, the cautious answer.
 *
 * ```ts
 * recipientClass("BR-DE-15") // "formal": the buyer reference
 * recipientClass("BR-CO-17") // "vat-relevant": the tax amount
 * recipientClass("AW-PARSE") // "format": not a structured invoice
 * ```
 */
export function recipientClass(id: string): RecipientClass {
  if (typeof id !== "string") return "vat-relevant";
  return BY_ID.get(id) ?? BY_UPPER_CASE.get(id.trim().toUpperCase()) ?? "vat-relevant";
}
