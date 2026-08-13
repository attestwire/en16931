import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { inputRules, validateInput } from "./index.js";
import { CATEGORY_RULE_INFIX } from "./rule-kit.js";
import { clean, cleanLine, withInvoice, withLine } from "./testkit.js";
import type { InvoiceInput, TeachingError } from "./types.js";

/**
 * Cross-cutting guarantees about the whole rule set.
 *
 * The teaching error is the product. A rule that fires with an empty `fix`, a
 * `docsUrl` that does not resolve, or a message that restates the rule id has
 * technically detected the problem and has failed at the job. These tests hold
 * every rule to the same bar, including the ones added after them.
 *
 * ⚠ THINGS OUTSIDE THIS PACKAGE ARE GENERATED FROM THESE RULES. The rule pages
 * on the website and `apps/api/src/rules-content.js` are both produced by
 * running this library and publishing what it returns — nothing on them is
 * authored by hand. So a change to a rule id, a message, a `fix` or a
 * `docsUrl` makes those committed artefacts stale, and nothing here can tell
 * you: this package has no idea they exist, and would not be a zero-dependency
 * library if it did. If you change a rule, regenerate them and run the whole
 * repository's tests, not just this package's.
 */

const outOfScopeParty = {
  seller: { ...clean.seller, vatId: undefined, taxRegistrationId: "18/181/08155" },
  buyer: { ...clean.buyer, vatId: undefined },
};

/**
 * One fixture per member of the per-category `-08` family: a stated taxable
 * amount (BT-116) that the lines behind it cannot produce.
 *
 * The single line multiplies out to 10 × 150 = 1500.00, so a stated 55.55 is
 * not a rounding argument — it is outside the family's ±1 tolerance by three
 * orders of magnitude.
 *
 * The nine ids are written out rather than derived from the category codes.
 * EN 16931 does not name these rules after the code BT-151 carries: `K` is
 * `BR-IC-08`, `L` is `BR-AF-08` and `M` is `BR-AG-08`. Deriving the id from
 * the code would produce three ids that resolve to nothing, which is why
 * `CATEGORY_RULE_INFIX` exists in rule-kit.ts and why this list is literal.
 *
 * Category `O` ("outside the scope of VAT") gets its own shape: it carries no
 * rate at all, and its breakdown is refused outright from a party that quotes
 * a VAT number (BR-O-11..-14). Stating a rate or keeping the VAT ids would
 * bury the one id this fixture exists to fire.
 */
const declaredTaxableWrongPerCategory: [string, InvoiceInput][] = (
  [
    ["S", 19],
    ["Z", 0],
    ["E", 0],
    ["AE", 0],
    ["K", 0],
    ["G", 0],
    ["L", 7],
    ["M", 10],
  ] as const
).map(([category, rate]) => [
  `declaredTaxableWrong${category}`,
  withInvoice({
    profile: "en16931",
    lines: [cleanLine({ vatCategory: category, vatRate: rate })],
    declaredTotals: {
      subtotals: [{ category, rate, taxableAmount: 55.55, taxAmount: 0 }],
    },
  }),
]);

declaredTaxableWrongPerCategory.push([
  "declaredTaxableWrongO",
  withInvoice({
    profile: "en16931",
    ...outOfScopeParty,
    lines: [cleanLine({ vatCategory: "O", vatRate: undefined })],
    vatExemptionReasons: { O: "Not subject to VAT" },
    declaredTotals: {
      subtotals: [{ category: "O", taxableAmount: 55.55, taxAmount: 0 }],
    },
  }),
]);

/**
 * A battery broad enough to fire every rule that *can* fire on this input
 * model. Rules that are invariants of the library's own arithmetic — the
 * per-category -01 and -09 families, BR-12..BR-15, BR-45/46/48, BR-CO-18 and
 * BR-DEC-19/-20/-23 — are absent by construction: they only fire if
 * computeTotals regresses, which is what they are there for. That list is
 * written out in `ARITHMETIC_INVARIANTS` below and checked, not assumed.
 */
const BATTERY: [string, InvoiceInput][] = [
  ["clean", clean],
  ["cleanPeppol", withInvoice({ profile: "peppol-bis-3" })],
  ["cleanCore", withInvoice({ profile: "en16931" })],
  [
    "empty",
    {
      profile: "en16931",
      invoiceNumber: "",
      issueDate: "",
      currency: "",
      seller: { name: "", address: { city: "", postalCode: "", countryCode: "" } },
      buyer: { name: "", address: { city: "", postalCode: "", countryCode: "" } },
      lines: [],
    } as unknown as InvoiceInput,
  ],
  ["emptyXRechnung", withInvoice({
    invoiceNumber: "",
    issueDate: "",
    currency: "",
    buyerReference: "",
    payment: undefined,
    deliveryDate: undefined,
    seller: { name: "Acme GmbH" } as never,
    buyer: { name: "Kunde GmbH" } as never,
    lines: [],
  })],
  ["emptyPeppol", withInvoice({
    profile: "peppol-bis-3",
    seller: { ...clean.seller, electronicAddress: undefined },
    buyer: { ...clean.buyer, electronicAddress: undefined },
  })],
  ["lineEmpty", withLine({
    id: "",
    description: "",
    quantity: undefined as never,
    unitCode: "",
    unitPrice: undefined as never,
    vatCategory: undefined as never,
    vatRate: undefined,
  })],
  ["lineNegativePrice", withLine({ unitPrice: -5 })],
  ["lineBaseQuantityZero", withLine({ baseQuantity: 0 })],
  ["badDate", withInvoice({ issueDate: "09.08.2026" })],
  ["badCurrency", withInvoice({ currency: "euro" })],
  ["badInvoiceType", withInvoice({ invoiceTypeCode: "999" })],
  ["emptyInvoiceType", withInvoice({ invoiceTypeCode: "" })],
  ["creditNoteType", withInvoice({ invoiceTypeCode: "381" })],
  // The credit-note battery. `creditNoteType` above is a *clean* credit note —
  // it fires the advisory and nothing else — so each ATW- credit-note finding
  // needs a fixture of its own that breaks exactly one thing.
  ["creditNoteWithReference", withInvoice({
    invoiceTypeCode: "381",
    precedingInvoices: [{ invoiceNumber: "2026-000142", issueDate: "2026-08-09" }],
  })],
  ["creditNoteNegative", withInvoice({
    invoiceTypeCode: "381",
    lines: [cleanLine({ quantity: -10 })],
    precedingInvoices: [{ invoiceNumber: "2026-000142" }],
  })],
  ["creditNoteDueDateUnbound", withInvoice({
    invoiceTypeCode: "381",
    dueDate: "2026-09-08",
    payment: undefined,
    precedingInvoices: [{ invoiceNumber: "2026-000142" }],
  })],
  ["creditNoteProjectReference", withInvoice({
    invoiceTypeCode: "381",
    projectReference: "PRJ-ERECHNUNG-2026",
    precedingInvoices: [{ invoiceNumber: "2026-000142" }],
  })],
  ["correctedInvoice", withInvoice({ invoiceTypeCode: "384" })],
  ["badCountry", withInvoice({
    seller: { ...clean.seller, address: { ...clean.seller.address, countryCode: "UK" } },
  })],
  ["badUnit", withLine({ unitCode: "hours" })],
  ["badCategory", withLine({ vatCategory: "X" as never })],
  ["badEas", withInvoice({
    seller: { ...clean.seller, electronicAddress: { schemeId: "0003", value: "x" } },
  })],
  ["blankEndpointScheme", withInvoice({
    seller: { ...clean.seller, electronicAddress: { schemeId: "", value: "x" } },
    buyer: { ...clean.buyer, electronicAddress: { schemeId: "", value: "y" } },
  })],
  ["noCategoryOnly", withLine({ vatCategory: "" as never })],
  ["badMeansCode", withInvoice({ payment: { meansCode: "999" } })],
  ["noMeansCode", withInvoice({ payment: { meansCode: "" } })],
  ["cardMeansCode", withInvoice({ payment: { meansCode: "48" } })],
  ["directDebitMeansCode", withInvoice({ payment: { meansCode: "59" } })],
  ["noIban", withInvoice({ payment: { meansCode: "58" } })],
  ["badIban", withInvoice({ payment: { meansCode: "58", iban: "DE02120300000000202052" } })],
  ["badSkonto", withInvoice({ paymentTerms: "#SKONTO#TAGE=14#PROZENT=2#\n" })],
  ["noDeliveryDate", withInvoice({ deliveryDate: undefined })],
  ["deliverToNoCountry", withInvoice({
    deliverTo: { city: "Lyon", postalCode: "69001" } as never,
  })],
  ["deliverToPartial", withInvoice({ deliverTo: { countryCode: "FR" } })],
  ["unprefixedVat", withInvoice({ seller: { ...clean.seller, vatId: "123456789" } })],
  ["noSellerTaxId", withInvoice({
    seller: { ...clean.seller, vatId: undefined, taxRegistrationId: undefined },
  })],
  ...(["S", "Z", "E", "AE", "K", "G"] as const).map(
    (c) =>
      [
        `noSellerTaxId_${c}`,
        withInvoice({
          profile: "en16931",
          seller: { ...clean.seller, vatId: undefined, taxRegistrationId: undefined },
          buyer: { ...clean.buyer, vatId: undefined, legalRegistrationId: undefined },
          lines: [cleanLine({ vatCategory: c, vatRate: c === "S" ? 19 : 0 })],
        }),
      ] as [string, InvoiceInput],
  ),
  ["noSellerIdAtAll", withInvoice({
    seller: {
      ...clean.seller,
      vatId: undefined,
      taxRegistrationId: undefined,
      legalRegistrationId: undefined,
    },
  })],
  ["noContact", withInvoice({ seller: { ...clean.seller, contact: undefined } })],
  ["partialContact", withInvoice({
    seller: { ...clean.seller, contact: { name: "Buchhaltung" } },
  })],
  ["contactNoName", withInvoice({
    seller: { ...clean.seller, contact: { ...clean.seller.contact, name: "" } },
  })],
  ["shortPhone", withInvoice({
    seller: { ...clean.seller, contact: { ...clean.seller.contact, phone: "call" } },
  })],
  ["badEmail", withInvoice({
    seller: {
      ...clean.seller,
      contact: { ...clean.seller.contact, email: "Buchhaltung <x@y.example>" },
    },
  })],
  ["noAddressParts", withInvoice({
    seller: { ...clean.seller, address: { countryCode: "DE" } as never },
    buyer: { ...clean.buyer, address: { countryCode: "DE" } as never },
  })],
  ["noBuyerReference", withInvoice({ buyerReference: "" })],
  ["zeroRateStandard", withLine({ vatCategory: "S", vatRate: 0 })],
  ...(["Z", "E", "AE", "K", "G"] as const).map(
    (c) => [`rated_${c}`, withLine({ vatCategory: c, vatRate: 19 })] as [string, InvoiceInput],
  ),
  ["ratedO", withInvoice({ ...outOfScopeParty, lines: [cleanLine({ vatCategory: "O", vatRate: 0 })] })],
  ["exemptNoReason", withInvoice({
    lines: [cleanLine({ vatCategory: "E", vatRate: 0 })],
    vatExemptionReasons: undefined,
  })],
  ...(["AE", "K", "G"] as const).map(
    (c) =>
      [
        `blankReason_${c}`,
        withInvoice({
          buyer: { ...clean.buyer, vatId: "NL123456789B01" },
          deliverTo: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
          lines: [cleanLine({ vatCategory: c, vatRate: 0 })],
          vatExemptionReasons: { [c]: "" },
        }),
      ] as [string, InvoiceInput],
  ),
  ["blankReasonO", withInvoice({
    ...outOfScopeParty,
    lines: [cleanLine({ vatCategory: "O", vatRate: undefined })],
    vatExemptionReasons: { O: "" },
  })],
  ["reasonOnStandard", withInvoice({ vatExemptionReasons: { S: "not applicable" } })],
  ["reasonOnZero", withInvoice({
    lines: [cleanLine({ vatCategory: "Z", vatRate: 0 })],
    vatExemptionReasons: { Z: "no VAT" },
  })],
  ["outOfScopeWithVatIds", withInvoice({
    lines: [cleanLine({ vatCategory: "O", vatRate: undefined })],
  })],
  ["outOfScopeOnly", withInvoice({
    ...outOfScopeParty,
    lines: [cleanLine({ vatCategory: "O", vatRate: undefined })],
  })],
  ["outOfScopeMixed", withInvoice({
    ...outOfScopeParty,
    lines: [
      cleanLine({ vatCategory: "O", vatRate: undefined }),
      cleanLine({ id: "2", vatCategory: "S", vatRate: 19 }),
    ],
  })],
  ["intraCommunityNoDelivery", withInvoice({
    buyer: { ...clean.buyer, vatId: undefined },
    lines: [cleanLine({ vatCategory: "K", vatRate: 0 })],
    deliveryDate: undefined,
  })],
  ["badTotals", withInvoice({
    declaredTotals: {
      lineExtensionAmount: 1,
      taxExclusiveAmount: 1,
      taxAmount: 1,
      taxInclusiveAmount: 1,
      payableAmount: 1,
    },
  })],
  ["overPreciseTotals", withInvoice({
    declaredTotals: {
      lineExtensionAmount: 1500.001,
      taxExclusiveAmount: 1500.001,
      taxAmount: 285.0004,
      taxInclusiveAmount: 1785.0011,
      payableAmount: 1785.0011,
    },
  })],
  ["nonFiniteTotals", withInvoice({
    declaredTotals: { taxAmount: Number.NaN, payableAmount: Number.POSITIVE_INFINITY },
  })],

  // --- wave B: the groups the model gained in 0.2.0 -------------------------
  ["allowanceEmpty", withInvoice({
    allowances: [{ amount: undefined, vatCategory: undefined } as never],
  })],
  ["chargeEmpty", withInvoice({
    charges: [{ amount: undefined, vatCategory: undefined } as never],
  })],
  ["allowanceNoReason", withInvoice({
    allowances: [{ amount: 10, vatCategory: "S", vatRate: 19 }],
  })],
  ["chargeNoReason", withInvoice({
    charges: [{ amount: 10, vatCategory: "S", vatRate: 19 }],
  })],
  ["allowanceOverPrecise", withInvoice({
    allowances: [
      { amount: 10.005, baseAmount: 100.005, percentage: 10, vatCategory: "S", vatRate: 19, reason: "Rabatt" },
    ],
  })],
  ["chargeOverPrecise", withInvoice({
    charges: [
      { amount: 10.005, baseAmount: 100.005, percentage: 10, vatCategory: "S", vatRate: 19, reason: "Versand" },
    ],
  })],
  ["allowanceBadReasonCode", withInvoice({
    allowances: [{ amount: 10, vatCategory: "S", vatRate: 19, reasonCode: "FC" }],
  })],
  ["chargeBadReasonCode", withInvoice({
    charges: [{ amount: 10, vatCategory: "S", vatRate: 19, reasonCode: "95" }],
  })],
  ["allowanceZeroRateS", withInvoice({
    allowances: [{ amount: 10, vatCategory: "S", vatRate: 0, reason: "Rabatt" }],
  })],
  ["chargeZeroRateS", withInvoice({
    charges: [{ amount: 10, vatCategory: "S", vatRate: 0, reason: "Versand" }],
  })],
  ...(["Z", "E", "AE", "K", "G"] as const).map(
    (c) =>
      [
        `allowanceRated_${c}`,
        withInvoice({
          allowances: [{ amount: 10, vatCategory: c, vatRate: 19, reason: "Rabatt" }],
          charges: [{ amount: 10, vatCategory: c, vatRate: 19, reason: "Versand" }],
          vatExemptionReasons: c === "E" ? { E: "Steuerfrei" } : undefined,
        }),
      ] as [string, InvoiceInput],
  ),
  ["allowanceRatedO", withInvoice({
    ...outOfScopeParty,
    lines: [cleanLine({ vatCategory: "O", vatRate: undefined })],
    allowances: [{ amount: 10, vatCategory: "O", vatRate: 0, reason: "Rabatt" }],
    charges: [{ amount: 10, vatCategory: "O", vatRate: 0, reason: "Versand" }],
  })],
  ["allowanceMixedWithO", withInvoice({
    ...outOfScopeParty,
    lines: [cleanLine({ vatCategory: "O", vatRate: undefined })],
    allowances: [{ amount: 10, vatCategory: "S", vatRate: 19, reason: "Rabatt" }],
    charges: [{ amount: 10, vatCategory: "S", vatRate: 19, reason: "Versand" }],
  })],
  ...(["S", "Z", "E", "AE", "K", "G"] as const).map(
    (c) =>
      [
        `allowanceNoSellerId_${c}`,
        withInvoice({
          profile: "en16931",
          seller: { ...clean.seller, vatId: undefined, taxRegistrationId: undefined },
          buyer: { ...clean.buyer, vatId: undefined, legalRegistrationId: undefined },
          lines: [cleanLine({ vatCategory: c, vatRate: c === "S" ? 19 : 0 })],
          allowances: [
            { amount: 10, vatCategory: c, vatRate: c === "S" ? 19 : 0, reason: "Rabatt" },
          ],
          charges: [
            { amount: 10, vatCategory: c, vatRate: c === "S" ? 19 : 0, reason: "Versand" },
          ],
          vatExemptionReasons: c === "E" ? { E: "Steuerfrei" } : undefined,
        }),
      ] as [string, InvoiceInput],
  ),
  ["allowanceTaxRegOnly", withInvoice({
    profile: "en16931",
    seller: { ...clean.seller, vatId: undefined, taxRegistrationId: "18/181/08155" },
    lines: [cleanLine({ vatCategory: "G", vatRate: 0 })],
    allowances: [{ amount: 10, vatCategory: "G", vatRate: 0, reason: "Rabatt" }],
  })],
  ["declaredAllowanceTotals", withInvoice({
    allowances: [{ amount: 10, vatCategory: "S", vatRate: 19, reason: "Rabatt" }],
    charges: [{ amount: 5, vatCategory: "S", vatRate: 19, reason: "Versand" }],
    declaredTotals: { allowanceTotalAmount: 1, chargeTotalAmount: 1 },
  })],
  ["declaredAllowanceTotalsOverPrecise", withInvoice({
    allowances: [{ amount: 10, vatCategory: "S", vatRate: 19, reason: "Rabatt" }],
    charges: [{ amount: 5, vatCategory: "S", vatRate: 19, reason: "Versand" }],
    declaredTotals: { allowanceTotalAmount: 10.005, chargeTotalAmount: 5.005 },
  })],
  ["lineAllowanceEmpty", withLine({
    allowances: [{ amount: undefined } as never],
    charges: [{ amount: undefined } as never],
  })],
  ["lineAllowanceOverPrecise", withLine({
    allowances: [{ amount: 1.005, baseAmount: 10.005, percentage: 10, reason: "Rabatt" }],
    charges: [{ amount: 1.005, baseAmount: 10.005, percentage: 10, reason: "Zuschlag" }],
  })],
  ["lineAllowanceBadReasonCode", withLine({
    allowances: [{ amount: 1, reasonCode: "FC" }],
    charges: [{ amount: 1, reasonCode: "95" }],
  })],

  // references, parties, periods
  ["payeeNoName", withInvoice({ payee: { name: "" } })],
  ["payeeSameAsSeller", withInvoice({ payee: { name: clean.seller.name } })],
  ["taxRepEmpty", withInvoice({
    taxRepresentative: { name: "", vatId: "", address: { city: "", postalCode: "", countryCode: "" } },
  })],
  ["taxRepNoAddress", withInvoice({
    taxRepresentative: { name: "Fiskal GmbH", vatId: "DE555555555" } as never,
  })],
  ["precedingNoNumber", withInvoice({ precedingInvoices: [{ invoiceNumber: "" }] })],
  ["supportingNoReference", withInvoice({ supportingDocuments: [{ reference: "" }] })],
  ["cardPanTooLong", withInvoice({
    payment: { meansCode: "48", card: { primaryAccountNumber: "4111111111111111" } },
  })],
  ["itemAttributeEmpty", withLine({ itemAttributes: [{ name: "", value: "" }] })],
  ["standardItemNoScheme", withLine({ standardItemId: { value: "04012345678901" } })],
  ["classificationNoScheme", withLine({
    itemClassifications: [{ code: "72154000" } as never],
  })],
  ["classificationBadScheme", withLine({
    itemClassifications: [{ code: "72154000", schemeId: "NOPE" }],
  })],
  ["badOriginCountry", withLine({ originCountryCode: "UK" })],
  ["badStandardItemScheme", withLine({
    standardItemId: { value: "04012345678901", schemeId: "9930" },
  })],
  ["emptyPeriod", withInvoice({ invoicingPeriod: {} })],
  ["invertedPeriod", withInvoice({
    invoicingPeriod: { startDate: "2026-07-31", endDate: "2026-07-01" },
  })],
  ["malformedPeriod", withInvoice({
    invoicingPeriod: { startDate: "01.07.2026", endDate: "31.07.2026" },
  })],
  ["emptyLinePeriod", withLine({ period: {} })],
  ["invertedLinePeriod", withLine({
    period: { startDate: "2026-07-31", endDate: "2026-07-01" },
  })],
  ["taxPointAndCode", withInvoice({
    taxPointDate: "2026-07-31",
    invoicingPeriod: { descriptionCode: "35" },
  })],
  ["badPeriodCode", withInvoice({ invoicingPeriod: { descriptionCode: "99" } })],
  ["taxCurrencyNoAmount", withInvoice({ vatAccountingCurrency: "SEK" })],
  ["taxAmountNoCurrency", withInvoice({ taxAmountInAccountingCurrency: 100 })],
  ["badTaxCurrency", withInvoice({
    vatAccountingCurrency: "SEKK",
    taxAmountInAccountingCurrency: 100,
  })],
  ["overPreciseAccountingAmounts", withInvoice({
    vatAccountingCurrency: "SEK",
    taxAmountInAccountingCurrency: 100.005,
    paidAmount: 10.005,
    roundingAmount: 0.005,
  })],
  ["badNoteSubjectCode", withInvoice({ note: "Hinweis", noteSubjectCode: "ZZ9" })],
  ["badObjectScheme", withInvoice({
    invoicedObjectIdentifier: { value: "OBJ-1", schemeId: "NOPE" },
  })],
  ["badLineObjectScheme", withLine({
    objectIdentifier: { value: "OBJ-1", schemeId: "NOPE" },
  })],
  ["badPartyIdentifierScheme", withInvoice({
    seller: { ...clean.seller, identifier: { value: "X", schemeId: "9930" } },
  })],
  ["badLegalRegistrationScheme", withInvoice({
    seller: { ...clean.seller, legalRegistrationId: "HRB 1", legalRegistrationSchemeId: "9930" },
  })],
  ["badVatexCode", withInvoice({
    lines: [cleanLine({ vatCategory: "E", vatRate: 0 })],
    vatExemptionReasonCodes: { E: "NOT-A-VATEX" },
  })],
  ["badMimeCode", withInvoice({
    supportingDocuments: [
      { reference: "A", attachment: { filename: "a.zip", mimeCode: "application/zip", content: "AA==" } },
    ],
  })],
  ["badDeliveryLocationScheme", withInvoice({
    deliverToLocationId: { value: "LOC-1", schemeId: "9930" },
  })],
  ["duplicateAttachmentNames", withInvoice({
    supportingDocuments: [
      { reference: "A", attachment: { filename: "a.pdf", mimeCode: "application/pdf", content: "AA==" } },
      { reference: "B", attachment: { filename: "a.pdf", mimeCode: "application/pdf", content: "AA==" } },
    ],
  })],

  // payment groups
  ["transferPlusCard", withInvoice({
    payment: {
      meansCode: "58",
      iban: "DE02120300000000202051",
      card: { primaryAccountNumber: "411111**11" },
    },
  })],
  ["cardComplete", withInvoice({
    payment: { meansCode: "48", card: { primaryAccountNumber: "411111**11" } },
  })],
  ["directDebitIncomplete", withInvoice({
    payment: { meansCode: "59", directDebit: {} },
  })],
  ["negativeGrossPrice", withLine({ grossUnitPrice: -200, priceDiscount: -50 })],
  ["creditTransferGroupNoIban", withInvoice({
    payment: { meansCode: "97", accountName: "Acme GmbH", bic: "BYLADEM1001" },
  })],
  ["outOfScopeAllowanceWithVatIds", withInvoice({
    lines: [cleanLine({ vatCategory: "O", vatRate: undefined })],
    allowances: [{ amount: 10, vatCategory: "O", reason: "Rabatt" }],
    charges: [{ amount: 10, vatCategory: "O", reason: "Versand" }],
  })],
  ["cardPlusTransferAndDebit", withInvoice({
    payment: {
      meansCode: "48",
      card: { primaryAccountNumber: "411111**11" },
      iban: "DE02120300000000202051",
      directDebit: { mandateReference: "M-1", creditorIdentifier: "DE98ZZZ09999999999", debitedAccount: "DE98700500001234567890" },
    },
  })],
  ["debitPlusTransfer", withInvoice({
    payment: {
      meansCode: "59",
      iban: "DE02120300000000202051",
      directDebit: { mandateReference: "M-1", creditorIdentifier: "DE98ZZZ09999999999", debitedAccount: "DE98700500001234567890" },
    },
  })],
  ["directDebitBadIban", withInvoice({
    payment: {
      meansCode: "59",
      directDebit: {
        mandateReference: "M-1",
        creditorIdentifier: "DE98ZZZ09999999999",
        debitedAccount: "DE98700500001234567891",
      },
    },
  })],

  // wave C — the Peppol tail. Everything here is on the peppol-bis-3 profile,
  // because that is the only profile on which any of it fires.
  ["peppolNoReference", withInvoice({
    profile: "peppol-bis-3",
    buyerReference: undefined,
    orderReference: undefined,
  })],
  ["peppolSameCurrency", withInvoice({
    profile: "peppol-bis-3",
    vatAccountingCurrency: "EUR",
    taxAmountInAccountingCurrency: 285,
  })],
  ["peppolUnknownCurrency", withInvoice({ profile: "peppol-bis-3", currency: "XCG" })],
  ["peppolUnroutableScheme", withInvoice({
    profile: "peppol-bis-3",
    seller: { ...clean.seller, electronicAddress: { schemeId: "EM", value: "a@b.example" } },
  })],
  ["peppolBadGln", withInvoice({
    profile: "peppol-bis-3",
    seller: { ...clean.seller, electronicAddress: { schemeId: "0088", value: "7300010000002" } },
  })],
  ["peppolBadNorwegianOrg", withInvoice({
    profile: "peppol-bis-3",
    seller: { ...clean.seller, electronicAddress: { schemeId: "0192", value: "991825828" } },
  })],
  ["peppolBadDanishCvr", withInvoice({
    profile: "peppol-bis-3",
    seller: { ...clean.seller, electronicAddress: { schemeId: "0184", value: "DK1234567" } },
  })],
  ["peppolBadBelgianNumber", withInvoice({
    profile: "peppol-bis-3",
    seller: { ...clean.seller, electronicAddress: { schemeId: "0208", value: "0848934497" } },
  })],
  ["peppolBadItalianCodes", withInvoice({
    profile: "peppol-bis-3",
    seller: { ...clean.seller, electronicAddress: { schemeId: "0201", value: "TOOLONG" }, identifier: { schemeId: "0210", value: "123" } },
    buyer: { ...clean.buyer, electronicAddress: { schemeId: "9906", value: "IT01234567890" }, identifier: { schemeId: "0211", value: "IT01234567890" } },
  })],
  ["peppolBadItalianEndpointCf", withInvoice({
    profile: "peppol-bis-3",
    seller: { ...clean.seller, electronicAddress: { schemeId: "9907", value: "123" } },
  })],
  ["peppolBadSwedishOrg", withInvoice({
    profile: "peppol-bis-3",
    seller: { ...clean.seller, electronicAddress: { schemeId: "0007", value: "2021005488" } },
  })],
  ["peppolBadAbn", withInvoice({
    profile: "peppol-bis-3",
    seller: { ...clean.seller, electronicAddress: { schemeId: "0151", value: "51824753557" } },
  })],
  ["peppolBadDanishSecondary", withInvoice({
    profile: "peppol-bis-3",
    seller: { ...clean.seller, identifier: { schemeId: "0096", value: "123" } },
    buyer: { ...clean.buyer, identifier: { schemeId: "0198", value: "12345678" } },
  })],
  ["peppolPercentageNoBase", withInvoice({
    profile: "peppol-bis-3",
    allowances: [{ amount: 50, percentage: 5, vatCategory: "S", vatRate: 19 }],
  })],
  ["peppolBaseNoPercentage", withInvoice({
    profile: "peppol-bis-3",
    charges: [{ amount: 50, baseAmount: 1000, vatCategory: "S", vatRate: 19 }],
  })],
  ["peppolAllowanceArithmetic", withInvoice({
    profile: "peppol-bis-3",
    allowances: [{ amount: 60, baseAmount: 1000, percentage: 5, vatCategory: "S", vatRate: 19 }],
  })],
  ["peppolPriceGroup", withInvoice({
    profile: "peppol-bis-3",
    lines: [cleanLine({ unitPrice: 91, grossUnitPrice: 100, priceDiscount: 10 })],
  })],
  ["peppolVatSignMismatch", withInvoice({
    profile: "peppol-bis-3",
    vatAccountingCurrency: "SEK",
    taxAmountInAccountingCurrency: -3200,
  })],
  ["peppolDirectDebitNoMandate", withInvoice({
    profile: "peppol-bis-3",
    payment: { meansCode: "59", directDebit: { debitedAccount: "DE02120300000000202051" } },
  })],
  ["peppolLinePeriodOutside", withInvoice({
    profile: "peppol-bis-3",
    deliveryDate: undefined,
    invoicingPeriod: { startDate: "2026-07-01", endDate: "2026-07-31" },
    lines: [cleanLine({ period: { startDate: "2026-06-01", endDate: "2026-08-31" } })],
  })],
  ["peppolBaseQuantityZero", withInvoice({
    profile: "peppol-bis-3",
    lines: [cleanLine({ baseQuantity: 0 })],
  })],
  ["peppolBadTypeCode", withInvoice({ profile: "peppol-bis-3", invoiceTypeCode: "325" })],
  ["peppolGermanOnlyTypeCode", withInvoice({
    profile: "peppol-bis-3",
    invoiceTypeCode: "384",
    precedingInvoices: [{ invoiceNumber: "2026-000141" }],
    buyer: {
      ...clean.buyer,
      vatId: "FR12345678901",
      address: { city: "Lyon", postalCode: "69001", countryCode: "FR" },
    },
  })],
  ["peppolVatexCategoryMismatch", withInvoice({
    profile: "peppol-bis-3",
    lines: [cleanLine({ vatCategory: "E", vatRate: 0 })],
    vatExemptionReasons: { E: "Exento" },
    vatExemptionReasonCodes: { E: "VATEX-EU-G" },
  })],
  ["peppolVatexOnE", withInvoice({
    profile: "peppol-bis-3",
    lines: [cleanLine({ vatCategory: "AE", vatRate: 0 })],
    buyer: { ...clean.buyer, vatId: "FR12345678901" },
    vatExemptionReasonCodes: { AE: "VATEX-EU-D" },
  })],
  ["peppolVatexOnE2", withInvoice({
    profile: "peppol-bis-3",
    lines: [cleanLine({ vatCategory: "AE", vatRate: 0 })],
    buyer: { ...clean.buyer, vatId: "FR12345678901" },
    vatExemptionReasonCodes: { AE: "VATEX-EU-F" },
  })],
  ["peppolVatexOnE3", withInvoice({
    profile: "peppol-bis-3",
    lines: [cleanLine({ vatCategory: "AE", vatRate: 0 })],
    buyer: { ...clean.buyer, vatId: "FR12345678901" },
    vatExemptionReasonCodes: { AE: "VATEX-EU-J" },
  })],
  ["peppolVatexOnOthers", withInvoice({
    profile: "peppol-bis-3",
    lines: [cleanLine({ vatCategory: "E", vatRate: 0 })],
    vatExemptionReasons: { E: "Exento" },
    vatExemptionReasonCodes: { E: "VATEX-EU-O" },
  })],
  ["peppolVatexOnOthers2", withInvoice({
    profile: "peppol-bis-3",
    lines: [cleanLine({ vatCategory: "E", vatRate: 0 })],
    vatExemptionReasons: { E: "Exento" },
    vatExemptionReasonCodes: { E: "VATEX-EU-IC" },
  })],
  ["peppolVatexOnOthers3", withInvoice({
    profile: "peppol-bis-3",
    lines: [cleanLine({ vatCategory: "E", vatRate: 0 })],
    vatExemptionReasons: { E: "Exento" },
    vatExemptionReasonCodes: { E: "VATEX-EU-AE" },
  })],

  // wave C — the regional Spanish categories.
  ["regionalNoSellerId", withInvoice({
    seller: { name: "Acme SL", address: { city: "Las Palmas", postalCode: "35001", countryCode: "ES" } } as never,
    lines: [
      cleanLine({ id: "1", vatCategory: "L", vatRate: 7 }),
      cleanLine({ id: "2", vatCategory: "M", vatRate: 10 }),
    ],
  })],
  ["regionalNoRate", withInvoice({
    lines: [
      cleanLine({ id: "1", vatCategory: "L", vatRate: undefined }),
      cleanLine({ id: "2", vatCategory: "M", vatRate: undefined }),
    ],
  })],
  ["regionalAllowanceNoRate", withInvoice({
    seller: { name: "Acme SL", address: { city: "Las Palmas", postalCode: "35001", countryCode: "ES" } } as never,
    lines: [cleanLine({ vatCategory: "L", vatRate: 7 })],
    allowances: [
      { amount: 25, vatCategory: "L", reason: "Descuento" },
      { amount: 25, vatCategory: "M", reason: "Descuento" },
    ],
    charges: [
      { amount: 25, vatCategory: "M", reason: "Transporte" },
      { amount: 25, vatCategory: "L", reason: "Transporte" },
    ],
  })],
  ["regionalExemptionReason", withInvoice({
    lines: [
      cleanLine({ id: "1", vatCategory: "L", vatRate: 7 }),
      cleanLine({ id: "2", vatCategory: "M", vatRate: 10 }),
    ],
    vatExemptionReasons: { L: "Exento", M: "Exento" },
  })],
  ["splitPaymentCategory", withLine({ vatCategory: "B" as never, vatRate: 22 })],
  // Wave D. A date that is well-formed but names no day on the calendar: the
  // shape regex accepts it, `xs:date` does not, and the two reachable ids for
  // it differ by profile.
  ["impossibleDate", withInvoice({ issueDate: "2026-02-30", dueDate: "2026-13-01" })],
  [
    "impossibleDatePeppol",
    withInvoice({ profile: "peppol-bis-3", issueDate: "2026-02-30" }),
  ],
  // Wave D. P0110 was implemented in 0.2.0 after three waves of being omitted
  // on an inverted premise; it gets battery coverage so it cannot quietly
  // regress the same way.
  [
    "vatexPinsTheCategory",
    withInvoice({
      profile: "peppol-bis-3",
      vatExemptionReasonCodes: { S: "VATEX-EU-I" },
    }),
  ],
  // 2026-08-12, finding 9. Until now the stated BT-131, BT-116 and BT-117 were
  // read out of a document and thrown away, so PEPPOL-EN16931-R120, the -08
  // family and BR-CO-17 were genuinely unreachable from caller input and the
  // note below said so. `declaredTotals` now carries them, which makes all
  // three reachable — a caller can state them directly, and both parsers do.
  [
    "declaredLineAndBreakdownDisagree",
    withInvoice({
      declaredTotals: {
        lineNetAmounts: [77.77],
        subtotals: [
          { category: "S", rate: 19, taxableAmount: 55.55, taxAmount: 11.11 },
        ],
      },
    }),
  ],
  [
    "declaredVatAmountOutsideTheTolerance",
    withInvoice({
      declaredTotals: {
        subtotals: [
          { category: "S", rate: 19, taxableAmount: 1500, taxAmount: 0 },
        ],
      },
    }),
  ],
  // 2026-08-12, second pass. The fixture above fires `BR-S-08` and nothing
  // else in that family, and for a while the count in this file treated the
  // other eight members as unreachable on that evidence alone. They are not:
  // the rule is one per VAT category, and a caller can state a wrong taxable
  // amount on any of the nine. Whether a battery happens to exercise a rule
  // says nothing about whether a caller can trip it, and reading it as if it
  // did put "you cannot trip this rule" on eight pages that readers can trip.
  // One fixture per category, so no member can go unexercised again.
  ...declaredTaxableWrongPerCategory,
];

/** Every finding the battery produces, tagged with the case that produced it. */
const harvested: { fixture: string; error: TeachingError }[] = [];
for (const [fixture, invoice] of BATTERY) {
  const result = validateInput(invoice);
  for (const error of [
    ...result.errors,
    ...result.warnings,
    ...result.information,
  ]) {
    harvested.push({ fixture, error });
  }
}

const firedIds = [...new Set(harvested.map((h) => h.error.rule))].sort();

/**
 * Every rule id this build can emit, read out of the source rather than typed
 * here.
 *
 * Two halves, because the rules emit their ids two ways:
 *
 *  1. Literals. Most rules carry `rule: "BR-CL-14"` or hold the id in a spec
 *     table, so a scan of the string literals in src/ finds them.
 *  2. The per-category families. Nine VAT categories × ten suffixes, built at
 *     runtime as `BR-${CATEGORY_RULE_INFIX[category]}-${suffix}` in rules.ts,
 *     rules-vat.ts and rules-allowance.ts. No literal exists to scan, so the
 *     grid is expanded from the same table the rules use. Members outside the
 *     grid (BR-IC-11/-12, BR-O-11..-14) are literals and come from half 1.
 *
 * A scan of literals will also pick up a rule id merely *named* in a comment.
 * That is the intended trade: an id mentioned in src/ and fired by nothing is
 * something a reader should be told about, and NOT_IMPLEMENTED below is where
 * a genuinely unimplemented one is recorded, in the open.
 */
const RULE_ID_IN_SOURCE = /"((?:BR|PEPPOL|ATW)-[A-Za-z0-9-]+)"/g;

const srcDir = new URL(".", import.meta.url);

const literalRuleIds = readdirSync(srcDir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .flatMap((name) => [
    ...readFileSync(new URL(name, srcDir), "utf8").matchAll(RULE_ID_IN_SOURCE),
  ])
  .map((match) => match[1]);

const perCategoryGrid = Object.values(CATEGORY_RULE_INFIX).flatMap((infix) =>
  Array.from({ length: 10 }, (_unused, i) => `BR-${infix}-${String(i + 1).padStart(2, "0")}`),
);

const ALL_RULE_IDS = [
  ...new Set([...literalRuleIds, ...perCategoryGrid]),
].sort();

/**
 * The rule ids no caller input can reach, each with the reason.
 *
 * These constrain figures the library computes rather than figures it reads.
 * `computeTotals` rounds every amount to two decimals before it is written, it
 * builds one breakdown group per category-and-rate pair present on the lines,
 * and it derives each group's taxable and VAT amounts from those lines. So the
 * rules below can only fire if that arithmetic regresses — which is what they
 * are for, and why leaving them in is right even though no fixture reaches
 * them.
 *
 * Being on this list is a claim about the *rule*, not about this battery. If a
 * caller can state the figure a rule checks, the rule is reachable and belongs
 * in BATTERY, however awkward the fixture. That distinction is the whole of
 * finding 9: the `-08` family sat here while callers could trip all nine.
 */
const ARITHMETIC_INVARIANTS: Record<string, string> = {
  "BR-12": "BT-106, the sum of line net amounts, is computed by summing them.",
  "BR-13": "BT-109, the total without VAT, is computed, never read.",
  "BR-14": "BT-112, the total with VAT, is computed, never read.",
  "BR-15": "BT-115, the amount due for payment, is computed, never read.",
  "BR-45":
    "Every computed breakdown group is built carrying a taxable amount (BT-116).",
  "BR-46":
    "Every computed breakdown group is built carrying a VAT amount (BT-117).",
  "BR-48":
    "Every computed breakdown group is built carrying a VAT rate (BT-119).",
  "BR-CO-18":
    "A breakdown group is emitted for every category on the lines, so an invoice with lines always has one.",
  "BR-DEC-19":
    "BT-106 goes through the same two-decimal rounding helper as every other computed amount.",
  "BR-DEC-20":
    "BT-109 goes through the same two-decimal rounding helper as every other computed amount.",
  "BR-DEC-23":
    "BT-115 goes through the same two-decimal rounding helper as every other computed amount.",
  ...Object.fromEntries(
    Object.values(CATEGORY_RULE_INFIX).flatMap((infix) => [
      [
        `BR-${infix}-01`,
        "The breakdown group for this category is created from the lines that carry it, so it exists whenever the category is used.",
      ],
      [
        `BR-${infix}-09`,
        "This group's VAT amount is computed from its own taxable amount and rate, by the one helper that does it.",
      ],
    ]),
  ),
};

/**
 * Rule ids named in src/ but not implemented — deliberately, and with the
 * reason recorded here rather than in a comment nobody greps.
 *
 * Empty today. It is not a place to park a rule that is merely inconvenient to
 * fire: a rule with an implementation belongs in BATTERY or in
 * ARITHMETIC_INVARIANTS, and putting it here instead would hide exactly the
 * gap those two lists exist to expose.
 */
const NOT_IMPLEMENTED: string[] = [];

describe("the rule set as a whole", () => {
  it("never throws, whatever it is handed", () => {
    for (const [fixture, invoice] of BATTERY) {
      expect(() => validateInput(invoice), fixture).not.toThrow();
    }
  });

  it("is exercised by the battery", () => {
    expect(harvested.length).toBeGreaterThanOrEqual(270);
    expect(firedIds.length).toBeGreaterThan(0);
  });

  // WHY THERE IS NO NUMBER HERE ANY MORE.
  //
  // This test used to read `expect(firedIds.length).toBe(N)`. N was 248, then
  // 251, then 254, and it was wrong twice — not because the library changed,
  // but because a literal cannot tell you *which* rule is missing, only that
  // the total moved. The 254 was the worse kind of wrong: it passed. It
  // recorded the size of this battery and was read as the count of rules a
  // caller can trip, and on that reading eight rule pages told readers "you
  // cannot trip this rule" about rules they can trip.
  //
  // So the guard is completeness, not arithmetic. Every rule id this build can
  // emit is either fired by the battery or named in ARITHMETIC_INVARIANTS with
  // the reason it cannot be. A new rule that nobody exercises fails this test
  // and the failure names the id.
  it("fires every rule a caller can reach, and none that they cannot", () => {
    const unaccounted = ALL_RULE_IDS.filter(
      (id) =>
        !firedIds.includes(id) &&
        !(id in ARITHMETIC_INVARIANTS) &&
        !NOT_IMPLEMENTED.includes(id),
    );
    expect(
      unaccounted,
      "each of these rule ids exists in src/ but no fixture fires it. Add a " +
        "fixture to BATTERY, or — only if no caller input can reach it — add " +
        "it to ARITHMETIC_INVARIANTS with the reason.",
    ).toEqual([]);

    // The other direction, and the one that produced the eight wrong pages: an
    // id called an invariant that a caller can in fact trip. Documenting a
    // reachable rule as unreachable is the more dangerous error, because it
    // tells a reader their own input cannot have caused a finding their own
    // input just caused.
    const reachableAfterAll = Object.keys(ARITHMETIC_INVARIANTS).filter((id) =>
      firedIds.includes(id),
    );
    expect(
      reachableAfterAll,
      "these are listed as invariants of the library's own arithmetic, but " +
        "the battery just fired them from caller input. Remove them from " +
        "ARITHMETIC_INVARIANTS.",
    ).toEqual([]);
  });

  it("keeps the invariant list from rotting", () => {
    // An entry naming a rule this build no longer has is a claim about
    // nothing. Every id in the list must still exist in the source.
    const gone = Object.keys(ARITHMETIC_INVARIANTS).filter(
      (id) => !ALL_RULE_IDS.includes(id),
    );
    expect(gone, "no such rule id in src/ any more").toEqual([]);
    for (const [id, reason] of Object.entries(ARITHMETIC_INVARIANTS)) {
      expect(reason.length, id).toBeGreaterThan(30);
    }
    const stillUnfired = NOT_IMPLEMENTED.filter((id) => firedIds.includes(id));
    expect(stillUnfired, "NOT_IMPLEMENTED names a rule that fires").toEqual([]);
  });

  it("passes a clean invoice with no findings at all", () => {
    const result = validateInput(clean);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("every emitted TeachingError", () => {
  it("carries a rule id, a business term, a severity, a message, a fix and a docsUrl", () => {
    for (const { fixture, error } of harvested) {
      const where = `${fixture} / ${error.rule}`;
      expect(typeof error.rule, where).toBe("string");
      expect(error.rule.trim(), where).not.toBe("");
      expect(error.field, where).toBeDefined();
      for (const term of Array.isArray(error.field) ? error.field : [error.field]) {
        expect(term, where).toMatch(/^B[TG]-\d+$/);
      }
      expect(["fatal", "warning", "information"], where).toContain(error.severity);
      expect(typeof error.message, where).toBe("string");
      expect(typeof error.fix, where).toBe("string");
      expect(typeof error.docsUrl, where).toBe("string");
    }
  });

  it("says enough to teach: a real message and a real fix", () => {
    for (const { fixture, error } of harvested) {
      const where = `${fixture} / ${error.rule}`;
      // A message that only restates the rule id is not an explanation.
      expect(error.message.length, where).toBeGreaterThan(80);
      expect(error.fix.length, where).toBeGreaterThan(20);
      expect(error.message, where).not.toBe(error.fix);
      // Sentence case and terminal punctuation: these are read in a console.
      expect(error.message.trim(), where).toMatch(/[.!?)"']$/);
      expect(error.fix.trim(), where).toMatch(/[.!?)"']$/);
    }
  });

  it("points at a docs URL built from the same pattern", () => {
    for (const { fixture, error } of harvested) {
      const where = `${fixture} / ${error.rule}`;
      if (error.rule.startsWith("ATW-")) {
        // Library limitations are ours, not the regulator's, and are documented
        // in the README rather than on a rule page.
        expect(error.docsUrl, where).toBe(
          "https://github.com/attestwire/en16931#not-implemented-yet",
        );
        continue;
      }
      expect(error.docsUrl, where).toBe(`https://attestwire.com/rules/${error.rule}`);
    }
  });

  it("supplies an example that is a JSON fragment, when it supplies one", () => {
    for (const { fixture, error } of harvested) {
      if (error.example === undefined) continue;
      const where = `${fixture} / ${error.rule}`;
      expect(typeof error.example, where).toBe("string");
      expect(error.example.length, where).toBeGreaterThan(4);
      expect(error.example, where).toContain('"');
    }
  });

  it("supplies an absolute XPath, when it supplies one", () => {
    // Two roots since 0.5.0: `/ubl:CreditNote` is a different document from
    // `/ubl:Invoice`, and an XPath naming the wrong one resolves to nothing in
    // the file the reader has open. A finding that can only arise on a credit
    // note must say so.
    for (const { fixture, error } of harvested) {
      if (error.xpath === undefined) continue;
      const where = `${fixture} / ${error.rule}`;
      expect(error.xpath, where).toMatch(/^\/ubl:(Invoice|CreditNote)/);
      expect(error.xpath, where).not.toMatch(/\s/);
    }
  });

  it("keeps one docs page per rule id", () => {
    // Two rules must not share an id, and one rule must not point at two
    // different pages depending on which fixture tripped it — a docs page is
    // generated per id, and it can only describe one rule.
    //
    // Severity is deliberately *not* asserted stable: the Peppol endpoint rules
    // are fatal under peppol-bis-3 and advisory under XRechnung, where the
    // requirement comes from cardinality rather than from a BR-DE rule.
    const byId = new Map<string, TeachingError>();
    for (const { error } of harvested) {
      const first = byId.get(error.rule);
      if (!first) {
        byId.set(error.rule, error);
        continue;
      }
      expect(first.docsUrl, error.rule).toBe(error.docsUrl);
    }
  });
});

describe("rule coverage", () => {
  it("fires every rule family added in 0.2.0", () => {
    const expected = [
      // core
      "BR-04", "BR-24", "BR-49", "BR-57", "BR-CO-04", "BR-47",
      // code lists
      "BR-CL-01", "BR-CL-03", "BR-CL-04", "BR-CL-14", "BR-CL-16",
      "BR-CL-17", "BR-CL-18", "BR-CL-23", "BR-CL-25",
      // decimals
      "BR-DEC-09", "BR-DEC-12", "BR-DEC-13", "BR-DEC-14", "BR-DEC-18",
      "ATW-DECLARED-TOTAL-NOT-FINITE",
      // VAT breakdown
      "BR-S-10", "BR-Z-10", "BR-AE-10", "BR-IC-10", "BR-G-10", "BR-O-10",
      "BR-O-11", "BR-O-12",
      // XRechnung CIUS
      "BR-DE-14", "BR-DE-18", "BR-DE-19", "BR-DE-23-a", "BR-DE-24-a",
      "BR-DE-25-a", "BR-DE-26",
    ];
    for (const rule of expected) expect(firedIds, rule).toContain(rule);
  });

  it("fires every family the wave-B model unlocked", () => {
    const expected = [
      // document allowances and charges (BG-20 / BG-21)
      "BR-31", "BR-32", "BR-33", "BR-36", "BR-37", "BR-38",
      "BR-CO-11", "BR-CO-12", "BR-CO-21", "BR-CO-22",
      "BR-DEC-01", "BR-DEC-02", "BR-DEC-05", "BR-DEC-06",
      "BR-DEC-10", "BR-DEC-11",
      // line allowances and charges (BG-27 / BG-28)
      "BR-41", "BR-42", "BR-43", "BR-44", "BR-CO-23", "BR-CO-24",
      "BR-DEC-24", "BR-DEC-25", "BR-DEC-27", "BR-DEC-28",
      // the per-category allowance/charge branches
      "BR-S-03", "BR-S-04", "BR-S-06", "BR-S-07",
      "BR-Z-03", "BR-Z-04", "BR-Z-06", "BR-Z-07",
      "BR-E-03", "BR-E-04", "BR-E-06", "BR-E-07",
      "BR-AE-03", "BR-AE-04", "BR-AE-06", "BR-AE-07",
      "BR-IC-03", "BR-IC-04", "BR-IC-06", "BR-IC-07",
      "BR-G-03", "BR-G-04", "BR-G-06", "BR-G-07",
      "BR-O-03", "BR-O-04", "BR-O-06", "BR-O-07", "BR-O-13", "BR-O-14",
      // parties and references
      "BR-17", "BR-18", "BR-19", "BR-20", "BR-51", "BR-52", "BR-53",
      "BR-54", "BR-55", "BR-56", "BR-64", "BR-65",
      // periods and tax point
      "BR-29", "BR-30", "BR-CO-03", "BR-CO-19", "BR-CO-20",
      // amounts unlocked by BT-111 / BT-113 / BT-114
      "BR-DEC-15", "BR-DEC-16", "BR-DEC-17",
      // code lists the new fields unlocked
      "BR-CL-05", "BR-CL-06", "BR-CL-07", "BR-CL-08", "BR-CL-10",
      "BR-CL-11", "BR-CL-13", "BR-CL-15", "BR-CL-19", "BR-CL-20",
      "BR-CL-21", "BR-CL-22", "BR-CL-24", "BR-CL-26",
      // XRechnung CIUS
      "BR-DE-20", "BR-DE-22", "BR-DE-23-b", "BR-DE-24-b", "BR-DE-25-b",
      "BR-DE-30", "BR-DE-31", "BR-DE-TMP-32",
      // core rules the new price and payment fields unlocked
      "BR-28", "BR-50",
    ];
    for (const rule of expected) expect(firedIds, rule).toContain(rule);
  });

  it("reports BR-DE-17 as a warning, not an error — the 0.1.x over-rejection", () => {
    const result = validateInput(withInvoice({ invoiceTypeCode: "999" }));
    expect(result.errors.map((e) => e.rule)).not.toContain("BR-DE-17");
    expect(result.warnings.map((e) => e.rule)).toContain("BR-DE-17");
  });

  it("keeps advisory findings out of errors and warnings alike", () => {
    // `information` is KoSIT's third flag. A caller that fails a build on a
    // non-empty `warnings` array must not be stopped by a finding the official
    // validator raises and then accepts.
    const result = validateInput(withInvoice({ deliveryDate: undefined }));
    expect(result.information.length).toBeGreaterThan(0);
    for (const finding of result.information) {
      expect(finding.severity).toBe("information");
      expect(result.errors).not.toContain(finding);
      expect(result.warnings).not.toContain(finding);
    }
    expect(result.valid).toBe(true);
  });

  it("still fires every rule the 0.1.x set covered", () => {
    const expected = [
      "BR-02", "BR-03", "BR-05", "BR-06", "BR-07", "BR-08", "BR-09", "BR-10",
      "BR-11", "BR-16", "BR-21", "BR-22", "BR-23", "BR-25", "BR-26", "BR-27",
      "BR-61", "BR-62", "BR-63",
      "BR-CO-09", "BR-CO-10", "BR-CO-13", "BR-CO-14", "BR-CO-15", "BR-CO-16",
      "BR-CO-26",
      "BR-S-02", "BR-S-05", "BR-Z-02", "BR-Z-05", "BR-E-02", "BR-E-05",
      "BR-E-10", "BR-AE-02", "BR-AE-05", "BR-IC-02", "BR-IC-05", "BR-IC-11",
      "BR-IC-12", "BR-G-02", "BR-G-05", "BR-O-02", "BR-O-05",
      "BR-DE-1", "BR-DE-2", "BR-DE-3", "BR-DE-4", "BR-DE-5", "BR-DE-6",
      "BR-DE-7", "BR-DE-8", "BR-DE-9", "BR-DE-10", "BR-DE-11", "BR-DE-15",
      "BR-DE-16", "BR-DE-17", "BR-DE-27", "BR-DE-28",
      "PEPPOL-EN16931-R010", "PEPPOL-EN16931-R020",
      // ATW-CREDIT-NOTE-UNSUPPORTED stood here until 2026-08-13. It was a
      // library limitation, not a regulation rule, and 0.5.0 removed the
      // limitation: a credit note generates, parses and validates. A rule id
      // that no longer exists cannot be fired, and leaving it in this list
      // would assert that the gap is still open.
    ];
    for (const rule of expected) expect(firedIds, rule).toContain(rule);
  });

  it("fires every rule wave C added", () => {
    const expected = [
      // the Peppol tail
      "PEPPOL-EN16931-R003", "PEPPOL-EN16931-R005", "PEPPOL-EN16931-R040",
      "PEPPOL-EN16931-R041", "PEPPOL-EN16931-R042", "PEPPOL-EN16931-R046",
      "PEPPOL-EN16931-R055", "PEPPOL-EN16931-R061", "PEPPOL-EN16931-R110",
      "PEPPOL-EN16931-R111", "PEPPOL-EN16931-R121",
      "PEPPOL-EN16931-CL007", "PEPPOL-EN16931-CL008",
      "PEPPOL-EN16931-P0100", "PEPPOL-EN16931-P0112",
      "PEPPOL-EN16931-P0104",
      "PEPPOL-COMMON-R040", "PEPPOL-COMMON-R041", "PEPPOL-COMMON-R042",
      "PEPPOL-COMMON-R043", "PEPPOL-COMMON-R044", "PEPPOL-COMMON-R045",
      "PEPPOL-COMMON-R046", "PEPPOL-COMMON-R047", "PEPPOL-COMMON-R048",
      "PEPPOL-COMMON-R049", "PEPPOL-COMMON-R050", "PEPPOL-COMMON-R052",
      "PEPPOL-COMMON-R053",
      // the regional Spanish categories
      "BR-AF-02", "BR-AF-03", "BR-AF-05", "BR-AF-06", "BR-AF-10",
      "BR-AG-02", "BR-AG-04", "BR-AG-05", "BR-AG-07", "BR-AG-10",
      // and the hole wave C closed
      "ATW-VAT-CATEGORY-UNSUPPORTED",
    ];
    for (const rule of expected) expect(firedIds, rule).toContain(rule);
  });

  it("fires no Peppol rule on any profile but peppol-bis-3, with one documented exception", () => {
    // The battery is mostly xrechnung-ubl, so anything PEPPOL- in it must have
    // come from a case that opted into the profile — with one exception that
    // predates wave C and is deliberate. `PEPPOL-EN16931-R010` and `R020`
    // (the seller and buyer electronic addresses) are reported on XRechnung
    // too, because XRechnung requires both by cardinality rather than through
    // a BR-DE rule of its own, and borrowing the Peppol id was judged better
    // than inventing one. There they are *warnings*; only on Peppol are they
    // fatal. That distinction is the thing this test pins down: a borrowed id
    // must never carry borrowed severity.
    const BORROWED = new Set(["PEPPOL-EN16931-R010", "PEPPOL-EN16931-R020"]);
    // A second, different exception, added 2026-08-12. KoSIT's XRechnung 3.0.2
    // schematron *embeds* a handful of PEPPOL-EN16931-* assertions, so these
    // are not borrowed ids — they are rules the German validator actually runs
    // on an XRechnung document, at fatal severity. Verified, not assumed: an
    // XRechnung invoice with a line total contradicting its own arithmetic came
    // back from KoSIT carrying `PEPPOL-EN16931-R120` in both syntaxes.
    //
    // The set is deliberately narrow. Most of this build's Peppol rules are
    // still gated on `profile: "peppol-bis-3"` even where KoSIT runs them for
    // XRechnung — that gap is recorded in the README and in
    // scripts/kosit-check.md, and it is a gap, not a decision.
    const EMBEDDED_IN_XRECHNUNG = new Set(["PEPPOL-EN16931-R120"]);
    const profileOf = new Map(BATTERY.map(([name, inv]) => [name, inv.profile]));
    for (const { fixture, error } of harvested) {
      if (!error.rule.startsWith("PEPPOL-")) continue;
      if (profileOf.get(fixture) === "peppol-bis-3") continue;
      if (EMBEDDED_IN_XRECHNUNG.has(error.rule)) {
        expect(error.severity, `${error.rule} in ${fixture}`).toBe("fatal");
        continue;
      }
      expect(BORROWED.has(error.rule), `${error.rule} in ${fixture}`).toBe(true);
      expect(error.severity, `${error.rule} in ${fixture}`).toBe("warning");
    }
  });

  it("exposes the rule functions as an array, which the docs harvester needs", () => {
    expect(Array.isArray(inputRules)).toBe(true);
    expect(inputRules.length).toBeGreaterThan(60);
    for (const fn of inputRules) expect(typeof fn).toBe("function");
  });
});

// A deliberate escape hatch for tooling: `ATW_DUMP_RULE_IDS=1 npx vitest run
// src/rules-invariants.test.ts` prints every rule id the battery reaches, plus
// the totals. This is where the counts in the README and the CHANGELOG come
// from — read them off a run, do not retype them from memory.
if (process.env.ATW_DUMP_RULE_IDS) {
  /* eslint-disable no-console */
  console.log(`ATW_FIRED_IDS=${firedIds.join(",")}`);
  console.log(`ATW_REACHABLE_COUNT=${firedIds.length}`);
  console.log(`ATW_INVARIANT_COUNT=${Object.keys(ARITHMETIC_INVARIANTS).length}`);
  console.log(`ATW_TOTAL_RULE_IDS=${ALL_RULE_IDS.length}`);
  /* eslint-enable no-console */
}
