/**
 * UBL 2.1 `Invoice` XML → the `InvoiceInput` model.
 *
 * This is the inverse of `generate.ts`, and only of `generate.ts`: it reads the
 * same elements, in the same bindings, and puts them back in the same fields.
 * Anything it meets that has no field is reported in `unmapped` rather than
 * dropped — silent data loss on a tax document is the worst failure this code
 * could have.
 *
 * It is a reader, not a validator and not an authority. Run `validateInput` on
 * the result to get findings; a document that parses here and validates there
 * can still be rejected by KoSIT or by a receiving platform.
 */

import { CREDIT_NOTE_TYPE_CODES, DEFAULT_INVOICE_TYPE_CODE } from "./generate.js";
import { NOTE_SUBJECT_CODES_SET } from "./codelists/note-subject.js";
import {
  attr,
  firstChild,
  parseXml,
  ParseError,
  type XmlElement,
  type XmlLimits,
} from "./xml-parse.js";
import { set, TreeReader, type UnmappedElement } from "./xml-reader.js";
import type {
  DeclaredTaxSubtotal,
  DeclaredTotals,
  DeliverToAddress,
  DocumentAllowanceCharge,
  InvoiceInput,
  InvoiceLine,
  InvoicingPeriod,
  ItemAttribute,
  ItemClassification,
  LineAllowanceCharge,
  Party,
  Payee,
  PaymentCard,
  PaymentInstructions,
  PostalAddress,
  PrecedingInvoiceReference,
  Profile,
  SupportingDocument,
  TaxRepresentative,
  VatCategory,
} from "./types.js";

const CBC = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2";
const CAC = "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2";
const INVOICE_NS = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";
const CREDIT_NOTE_NS = "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2";
const CII_NS = "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100";

/** The customization identifiers (BT-24) this parser recognises, per profile. */
const PROFILE_BY_CUSTOMIZATION_ID: Record<string, Profile> = {
  "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0":
    "xrechnung-ubl",
  "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0":
    "peppol-bis-3",
  "urn:cen.eu:en16931:2017": "en16931",
};

/** UNTDID 1153 code that marks an AdditionalDocumentReference as BT-18. */
const INVOICED_OBJECT_CODE = "130";

/** Thrown when the document is not a UBL 2.1 `Invoice`. */
export class UnsupportedSyntaxError extends ParseError {
  readonly rootElement: string;
  readonly rootNamespace: string;

  constructor(rootElement: string, rootNamespace: string, detail: string) {
    super(
      "unsupported_syntax",
      `parseUblInvoice reads UBL 2.1 Invoice documents only. ${detail} ` +
        `The root element found was <${rootElement}> in the namespace ` +
        `"${rootNamespace || "(none)"}"; a UBL invoice has the root element Invoice in ` +
        `"${INVOICE_NS}". Parsing this document as a UBL invoice would produce an ` +
        `invoice object with almost every field missing, and a long list of findings ` +
        `that all point at the wrong problem, so this call refuses instead.`,
    );
    this.rootElement = rootElement;
    this.rootNamespace = rootNamespace;
  }
}

/** Thrown when BT-3 says the document is a credit note. */
export class UnsupportedCreditNoteError extends ParseError {
  readonly invoiceTypeCode: string;

  constructor(invoiceTypeCode: string) {
    super(
      "unsupported_document_type",
      `This document carries the invoice type code (BT-3) "${invoiceTypeCode}", which ` +
        `denotes a credit note. Credit notes are not supported: the input model, the ` +
        `generator and a large part of the rule set are all written for an invoice, and ` +
        `a UBL credit note is a different document (root element CreditNote, with ` +
        `cac:CreditNoteLine and cbc:CreditedQuantity). Reading one into an InvoiceInput ` +
        `would produce findings about the wrong document. Handle credit notes with ` +
        `another tool until the CreditNote reader ships.`,
    );
    this.invoiceTypeCode = invoiceTypeCode;
  }
}

export type { UnmappedElement } from "./xml-reader.js";

export interface ParsedInvoice {
  /** The invoice, ready for `validateInput`. */
  invoice: InvoiceInput;
  /** Everything in the document that did not reach `invoice`. Never silent. */
  unmapped: UnmappedElement[];
  /** BT-24 exactly as the document states it, before it was mapped to a profile. */
  customizationId?: string;
  /** BT-23 exactly as the document states it. Not part of the input model. */
  profileId?: string;
}

export interface ParseUblOptions extends Partial<XmlLimits> {}

// ---------------------------------------------------------------------------
// Bookkeeping: what was read, what was walked into, what is left over.
// ---------------------------------------------------------------------------

class Reader extends TreeReader {
  /** First `cbc:` child, marked as read. Returns its text verbatim. */
  cbc(parent: XmlElement, local: string): string | undefined {
    return this.leaf(parent, CBC, local);
  }

  /** First `cbc:` child element itself, marked as read — for attribute access. */
  cbcEl(parent: XmlElement, local: string): XmlElement | undefined {
    return this.leafEl(parent, CBC, local);
  }

  /** First `cac:` child, marked as walked into. */
  cac(parent: XmlElement, local: string): XmlElement | undefined {
    return this.group(parent, CAC, local);
  }

  /** Every `cac:` child with this name, each marked as walked into. */
  cacAll(parent: XmlElement, local: string): XmlElement[] {
    return this.groupAll(parent, CAC, local);
  }

  /** Every `cbc:` child with this name, each marked as read. */
  cbcAll(parent: XmlElement, local: string): XmlElement[] {
    return this.leafAll(parent, CBC, local);
  }

  /** A number, or `undefined` — an unreadable one is reported, never guessed. */
  num(parent: XmlElement, local: string): number | undefined {
    return this.number(parent, CBC, local);
  }
}

// ---------------------------------------------------------------------------
// Group readers
// ---------------------------------------------------------------------------

/** `cac:PostalAddress` / `cac:Address` → `PostalAddress`. */
function readAddress(r: Reader, el: XmlElement): PostalAddress {
  const addressLine = r.cac(el, "AddressLine");
  const address: PostalAddress = {
    city: r.cbc(el, "CityName") ?? "",
    postalCode: r.cbc(el, "PostalZone") ?? "",
    countryCode: "",
  };
  set(address, "line1", r.cbc(el, "StreetName"));
  set(address, "line2", r.cbc(el, "AdditionalStreetName"));
  set(address, "countrySubdivision", r.cbc(el, "CountrySubentity"));
  if (addressLine) set(address, "line3", r.cbc(addressLine, "Line"));
  const country = r.cac(el, "Country");
  if (country) address.countryCode = r.cbc(country, "IdentificationCode") ?? "";
  return address;
}

function readIdentifier(
  el: XmlElement | undefined,
): { value: string; schemeId?: string } | undefined {
  if (!el) return undefined;
  const identifier: { value: string; schemeId?: string } = { value: el.text };
  const schemeId = attr(el, "schemeID");
  if (schemeId !== undefined) identifier.schemeId = schemeId;
  return identifier;
}

/** `cac:Party` → `Party`. Returns the BT-90 SEPA identifier separately. */
function readParty(
  r: Reader,
  el: XmlElement,
): { party: Party; sepaCreditorIdentifier?: string } {
  const partyName = r.cac(el, "PartyName");
  const legalEntity = r.cac(el, "PartyLegalEntity");

  const tradingName = partyName ? r.cbc(partyName, "Name") : undefined;
  const registrationName = legalEntity
    ? r.cbc(legalEntity, "RegistrationName")
    : undefined;

  // BT-27/BT-44 is the registered legal name; BT-28/BT-45 is the trading name.
  // When the two agree the document has only one name, so `tradingName` stays
  // unset and the generator re-emits exactly what was read.
  const name = registrationName ?? tradingName ?? "";

  const party: Party = { name, address: { city: "", postalCode: "", countryCode: "" } };
  if (tradingName !== undefined && tradingName !== name) {
    party.tradingName = tradingName;
  }

  const endpoint = r.cbcEl(el, "EndpointID");
  if (endpoint) {
    party.electronicAddress = {
      schemeId: attr(endpoint, "schemeID") ?? "",
      value: endpoint.text,
    };
  }

  let sepaCreditorIdentifier: string | undefined;
  for (const identification of r.cacAll(el, "PartyIdentification")) {
    const idEl = r.cbcEl(identification, "ID");
    if (!idEl) continue;
    // BT-90: EN 16931's UBL binding puts the SEPA creditor identifier on the
    // seller party, told apart from BT-29 only by schemeID="SEPA".
    if (attr(idEl, "schemeID") === "SEPA") {
      sepaCreditorIdentifier = idEl.text;
      continue;
    }
    if (party.identifier === undefined) {
      party.identifier = readIdentifier(idEl);
    } else {
      r.note(
        identification,
        "unknown",
        "The input model carries one party identifier (BT-29 / BT-46); this further " +
          "cac:PartyIdentification was not carried over.",
      );
    }
  }

  const postal = r.cac(el, "PostalAddress");
  if (postal) party.address = readAddress(r, postal);

  for (const taxScheme of r.cacAll(el, "PartyTaxScheme")) {
    const companyId = r.cbc(taxScheme, "CompanyID");
    const scheme = r.cac(taxScheme, "TaxScheme");
    const schemeId = scheme ? r.cbc(scheme, "ID") : undefined;
    if (schemeId === "VAT") {
      set(party, "vatId", companyId);
    } else if (schemeId === "FC") {
      set(party, "taxRegistrationId", companyId);
    } else {
      r.note(
        taxScheme,
        "unknown",
        `The input model holds a VAT registration (tax scheme "VAT") and a national ` +
          `tax registration (tax scheme "FC"). The scheme here is ` +
          `"${schemeId ?? "(absent)"}", which has no field.`,
      );
    }
  }

  if (legalEntity) {
    const companyId = r.cbcEl(legalEntity, "CompanyID");
    if (companyId) {
      party.legalRegistrationId = companyId.text;
      set(party, "legalRegistrationSchemeId", attr(companyId, "schemeID"));
    }
    set(party, "additionalLegalInformation", r.cbc(legalEntity, "CompanyLegalForm"));
  }

  const contact = r.cac(el, "Contact");
  if (contact) {
    const value: NonNullable<Party["contact"]> = {};
    set(value, "name", r.cbc(contact, "Name"));
    set(value, "phone", r.cbc(contact, "Telephone"));
    set(value, "email", r.cbc(contact, "ElectronicMail"));
    party.contact = value;
  }

  const result: { party: Party; sepaCreditorIdentifier?: string } = { party };
  if (sepaCreditorIdentifier !== undefined) {
    result.sepaCreditorIdentifier = sepaCreditorIdentifier;
  }
  return result;
}

function readPeriod(r: Reader, el: XmlElement): InvoicingPeriod {
  const period: InvoicingPeriod = {};
  set(period, "startDate", r.cbc(el, "StartDate"));
  set(period, "endDate", r.cbc(el, "EndDate"));
  set(period, "descriptionCode", r.cbc(el, "DescriptionCode"));
  return period;
}

function readDocumentAllowanceCharge(
  r: Reader,
  el: XmlElement,
): DocumentAllowanceCharge {
  const taxCategory = r.cac(el, "TaxCategory");
  const entry: DocumentAllowanceCharge = {
    amount: r.num(el, "Amount") ?? 0,
    vatCategory: (taxCategory ? (r.cbc(taxCategory, "ID") ?? "") : "") as VatCategory,
  };
  set(entry, "baseAmount", r.num(el, "BaseAmount"));
  set(entry, "percentage", r.num(el, "MultiplierFactorNumeric"));
  set(entry, "reason", r.cbc(el, "AllowanceChargeReason"));
  set(entry, "reasonCode", r.cbc(el, "AllowanceChargeReasonCode"));
  if (taxCategory) {
    set(entry, "vatRate", r.num(taxCategory, "Percent"));
    const scheme = r.cac(taxCategory, "TaxScheme");
    if (scheme) r.cbc(scheme, "ID");
  }
  return entry;
}

function readLineAllowanceCharge(r: Reader, el: XmlElement): LineAllowanceCharge {
  const entry: LineAllowanceCharge = { amount: r.num(el, "Amount") ?? 0 };
  set(entry, "baseAmount", r.num(el, "BaseAmount"));
  set(entry, "percentage", r.num(el, "MultiplierFactorNumeric"));
  set(entry, "reason", r.cbc(el, "AllowanceChargeReason"));
  set(entry, "reasonCode", r.cbc(el, "AllowanceChargeReasonCode"));
  return entry;
}

/** `cbc:ChargeIndicator` — the schematron matches `true()`, and so do we. */
function isCharge(r: Reader, el: XmlElement): boolean {
  return (r.cbc(el, "ChargeIndicator") ?? "").trim().toLowerCase() === "true";
}

/** A line, plus the BT-131 the document states for it (finding 9). */
interface ReadLineResult {
  line: InvoiceLine;
  declaredNetAmount?: number;
}

function readLine(r: Reader, el: XmlElement): ReadLineResult {
  const quantity = r.cbcEl(el, "InvoicedQuantity");
  const item = r.cac(el, "Item");
  const price = r.cac(el, "Price");

  const quantityValue = quantity ? Number(quantity.text.trim()) : undefined;
  if (quantity && !Number.isFinite(quantityValue)) {
    r.note(
      quantity,
      "unknown",
      `"${quantity.text.trim().slice(0, 40)}" is not a number; the quantity was read as 0.`,
    );
  }

  const line: InvoiceLine = {
    id: r.cbc(el, "ID") ?? "",
    description: "",
    quantity: Number.isFinite(quantityValue) ? (quantityValue as number) : 0,
    unitCode: quantity ? (attr(quantity, "unitCode") ?? "") : "",
    unitPrice: 0,
    vatCategory: "" as VatCategory,
  };

  // BT-131 is derived from quantity, price and the line allowances and charges,
  // so it has no field on InvoiceLine — but the figure the document *states*
  // is kept, in declaredTotals.lineNetAmounts, and compared against the derived
  // one. Recording it as an unmapped "recomputed" note and discarding it (which
  // is what happened until 0.4.0) meant a line whose stated total disagreed
  // with its own arithmetic validated with zero errors, while KoSIT rejected
  // the same document under BR-CO-10 and PEPPOL-EN16931-R120.
  const declaredNetAmount = r.number(el, CBC, "LineExtensionAmount");

  set(line, "note", r.cbc(el, "Note"));
  set(line, "buyerAccountingReference", r.cbc(el, "AccountingCost"));

  const period = r.cac(el, "InvoicePeriod");
  if (period) line.period = readPeriod(r, period);

  const orderLine = r.cac(el, "OrderLineReference");
  if (orderLine) set(line, "orderLineReference", r.cbc(orderLine, "LineID"));

  const documentReference = r.cac(el, "DocumentReference");
  if (documentReference) {
    r.cbc(documentReference, "DocumentTypeCode");
    const identifier = readIdentifier(r.cbcEl(documentReference, "ID"));
    if (identifier) line.objectIdentifier = identifier;
  }

  const allowances: LineAllowanceCharge[] = [];
  const charges: LineAllowanceCharge[] = [];
  for (const entry of r.cacAll(el, "AllowanceCharge")) {
    const charge = isCharge(r, entry);
    (charge ? charges : allowances).push(readLineAllowanceCharge(r, entry));
  }
  if (allowances.length > 0) line.allowances = allowances;
  if (charges.length > 0) line.charges = charges;

  if (item) {
    line.description = r.cbc(item, "Name") ?? "";
    set(line, "longDescription", r.cbc(item, "Description"));

    const buyerItem = r.cac(item, "BuyersItemIdentification");
    if (buyerItem) set(line, "buyerItemId", r.cbc(buyerItem, "ID"));
    const sellerItem = r.cac(item, "SellersItemIdentification");
    if (sellerItem) set(line, "sellerItemId", r.cbc(sellerItem, "ID"));
    const standardItem = r.cac(item, "StandardItemIdentification");
    if (standardItem) {
      const identifier = readIdentifier(r.cbcEl(standardItem, "ID"));
      if (identifier) line.standardItemId = identifier;
    }
    const origin = r.cac(item, "OriginCountry");
    if (origin) set(line, "originCountryCode", r.cbc(origin, "IdentificationCode"));

    const classifications: ItemClassification[] = [];
    for (const group of r.cacAll(item, "CommodityClassification")) {
      const code = r.cbcEl(group, "ItemClassificationCode");
      if (!code) continue;
      const classification: ItemClassification = {
        code: code.text,
        schemeId: attr(code, "listID") ?? "",
      };
      const version = attr(code, "listVersionID");
      if (version !== undefined) classification.schemeVersion = version;
      classifications.push(classification);
    }
    if (classifications.length > 0) line.itemClassifications = classifications;

    const taxCategory = r.cac(item, "ClassifiedTaxCategory");
    if (taxCategory) {
      line.vatCategory = (r.cbc(taxCategory, "ID") ?? "") as VatCategory;
      set(line, "vatRate", r.num(taxCategory, "Percent"));
      const scheme = r.cac(taxCategory, "TaxScheme");
      if (scheme) r.cbc(scheme, "ID");
    }

    const attributes: ItemAttribute[] = [];
    for (const group of r.cacAll(item, "AdditionalItemProperty")) {
      attributes.push({
        name: r.cbc(group, "Name") ?? "",
        value: r.cbc(group, "Value") ?? "",
      });
    }
    if (attributes.length > 0) line.itemAttributes = attributes;
  }

  if (price) {
    line.unitPrice = r.num(price, "PriceAmount") ?? 0;
    set(line, "baseQuantity", r.num(price, "BaseQuantity"));
    // BT-147/BT-148: a gross price with a discount hangs off cac:Price as an
    // allowance, never as a second price element.
    const priceAllowance = r.cac(price, "AllowanceCharge");
    if (priceAllowance) {
      isCharge(r, priceAllowance);
      set(line, "grossUnitPrice", r.num(priceAllowance, "BaseAmount"));
      set(line, "priceDiscount", r.num(priceAllowance, "Amount"));
    }
  }

  const result: ReadLineResult = { line };
  if (declaredNetAmount !== undefined) result.declaredNetAmount = declaredNetAmount;
  return result;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Read a UBL 2.1 `Invoice` document into the `InvoiceInput` model.
 *
 * ```ts
 * const { invoice, unmapped } = parseUblInvoice(xmlString);
 * const findings = validateInput(invoice);
 * ```
 *
 * @throws {XmlSecurityError} DOCTYPE present, a custom entity, or the document
 *   is over the size, depth or element limits.
 * @throws {XmlSyntaxError} the document is not well-formed, or uses a
 *   construct outside the accepted subset (mixed content, for instance).
 * @throws {UnsupportedSyntaxError} the root element is not a UBL `Invoice` —
 *   a CII document, a UBL `CreditNote`, or something else entirely.
 * @throws {UnsupportedCreditNoteError} BT-3 says the document is a credit note.
 *
 * All four extend `ParseError` and carry a stable `code`.
 */
export function parseUblInvoice(
  xml: string,
  options: ParseUblOptions = {},
): ParsedInvoice {
  const root = parseXml(xml, options);

  if (root.namespace === CII_NS || root.local === "CrossIndustryInvoice") {
    throw new UnsupportedSyntaxError(
      root.qname,
      root.namespace,
      "This is a CII (UN/CEFACT Cross Industry Invoice) document — the syntax used by " +
        "ZUGFeRD, Factur-X and XRechnung CII. It shares no element names with UBL. " +
        "Read it with parseCiiInvoice instead.",
    );
  }
  if (root.namespace === CREDIT_NOTE_NS || root.local === "CreditNote") {
    throw new UnsupportedSyntaxError(
      root.qname,
      root.namespace,
      "This is a UBL CreditNote, not a UBL Invoice. A credit note is a different " +
        "document with its own root element and its own line element " +
        "(cac:CreditNoteLine with cbc:CreditedQuantity), and it is not supported.",
    );
  }
  if (root.namespace !== INVOICE_NS || root.local !== "Invoice") {
    throw new UnsupportedSyntaxError(
      root.qname,
      root.namespace,
      "The document is not a UBL invoice.",
    );
  }

  const r = new Reader();
  r.enter(root);

  const typeCode = (r.cbc(root, "InvoiceTypeCode") ?? DEFAULT_INVOICE_TYPE_CODE).trim();
  if (CREDIT_NOTE_TYPE_CODES.has(typeCode)) {
    throw new UnsupportedCreditNoteError(typeCode);
  }

  const customizationId = r.cbc(root, "CustomizationID");
  const profileId = r.cbc(root, "ProfileID");
  const profile = profileFor(customizationId, r, root);

  const invoice: InvoiceInput = {
    profile,
    invoiceNumber: r.cbc(root, "ID") ?? "",
    issueDate: r.cbc(root, "IssueDate") ?? "",
    currency: (r.cbc(root, "DocumentCurrencyCode") ?? "").toUpperCase(),
    invoiceTypeCode: typeCode,
    seller: { name: "", address: { city: "", postalCode: "", countryCode: "" } },
    buyer: { name: "", address: { city: "", postalCode: "", countryCode: "" } },
    lines: [],
  };

  set(invoice, "dueDate", r.cbc(root, "DueDate"));
  set(invoice, "taxPointDate", r.cbc(root, "TaxPointDate"));
  set(invoice, "buyerAccountingReference", r.cbc(root, "AccountingCost"));
  set(invoice, "buyerReference", r.cbc(root, "BuyerReference"));

  const taxCurrency = r.cbc(root, "TaxCurrencyCode");
  if (taxCurrency !== undefined) invoice.vatAccountingCurrency = taxCurrency.toUpperCase();

  // BT-21 has no element of its own: EN 16931's UBL binding writes the note
  // subject code into the note as "#CODE#text".
  const notes = r.cbcAll(root, "Note");
  if (notes.length > 0) {
    const raw = notes[0]!.text;
    const match = /^#([^#]{1,4})#([\s\S]*)$/.exec(raw);
    if (match && NOTE_SUBJECT_CODES_SET.has(match[1]!)) {
      invoice.noteSubjectCode = match[1]!;
      invoice.note = match[2]!;
    } else {
      invoice.note = raw;
    }
    for (const extra of notes.slice(1)) {
      r.note(
        extra,
        "unknown",
        "The input model carries one document note (BT-22). This further cbc:Note was " +
          "not carried over.",
      );
    }
  }

  const period = r.cac(root, "InvoicePeriod");
  if (period) invoice.invoicingPeriod = readPeriod(r, period);

  const orderReference = r.cac(root, "OrderReference");
  if (orderReference) {
    set(invoice, "orderReference", r.cbc(orderReference, "ID"));
    set(invoice, "salesOrderReference", r.cbc(orderReference, "SalesOrderID"));
  }

  const preceding: PrecedingInvoiceReference[] = [];
  for (const billing of r.cacAll(root, "BillingReference")) {
    const reference = r.cac(billing, "InvoiceDocumentReference");
    if (!reference) continue;
    const entry: PrecedingInvoiceReference = {
      invoiceNumber: r.cbc(reference, "ID") ?? "",
    };
    set(entry, "issueDate", r.cbc(reference, "IssueDate"));
    preceding.push(entry);
  }
  if (preceding.length > 0) invoice.precedingInvoices = preceding;

  const despatch = r.cac(root, "DespatchDocumentReference");
  if (despatch) set(invoice, "despatchAdviceReference", r.cbc(despatch, "ID"));
  const receipt = r.cac(root, "ReceiptDocumentReference");
  if (receipt) set(invoice, "receivingAdviceReference", r.cbc(receipt, "ID"));
  const originator = r.cac(root, "OriginatorDocumentReference");
  if (originator) set(invoice, "tenderOrLotReference", r.cbc(originator, "ID"));
  const contract = r.cac(root, "ContractDocumentReference");
  if (contract) set(invoice, "contractReference", r.cbc(contract, "ID"));
  const project = r.cac(root, "ProjectReference");
  if (project) set(invoice, "projectReference", r.cbc(project, "ID"));

  // BT-18 and BG-24 share cac:AdditionalDocumentReference and are told apart
  // only by DocumentTypeCode 130.
  const supporting: SupportingDocument[] = [];
  for (const reference of r.cacAll(root, "AdditionalDocumentReference")) {
    const typeCodeEl = r.cbc(reference, "DocumentTypeCode");
    const idEl = r.cbcEl(reference, "ID");
    if (typeCodeEl?.trim() === INVOICED_OBJECT_CODE) {
      const identifier = readIdentifier(idEl);
      if (identifier) invoice.invoicedObjectIdentifier = identifier;
      continue;
    }
    const document: SupportingDocument = { reference: idEl?.text ?? "" };
    set(document, "description", r.cbc(reference, "DocumentDescription"));
    const attachment = r.cac(reference, "Attachment");
    if (attachment) {
      const external = r.cac(attachment, "ExternalReference");
      if (external) set(document, "externalUri", r.cbc(external, "URI"));
      const embedded = r.cbcEl(attachment, "EmbeddedDocumentBinaryObject");
      if (embedded) {
        document.attachment = {
          filename: attr(embedded, "filename") ?? "",
          mimeCode: attr(embedded, "mimeCode") ?? "",
          content: embedded.text,
        };
      }
    }
    supporting.push(document);
  }
  if (supporting.length > 0) invoice.supportingDocuments = supporting;

  let sepaCreditorIdentifier: string | undefined;
  const supplier = r.cac(root, "AccountingSupplierParty");
  if (supplier) {
    const partyEl = r.cac(supplier, "Party");
    if (partyEl) {
      const read = readParty(r, partyEl);
      invoice.seller = read.party;
      sepaCreditorIdentifier = read.sepaCreditorIdentifier;
    }
  }
  const customer = r.cac(root, "AccountingCustomerParty");
  if (customer) {
    const partyEl = r.cac(customer, "Party");
    if (partyEl) invoice.buyer = readParty(r, partyEl).party;
  }

  const payeeEl = r.cac(root, "PayeeParty");
  if (payeeEl) {
    const nameEl = r.cac(payeeEl, "PartyName");
    const payee: Payee = { name: nameEl ? (r.cbc(nameEl, "Name") ?? "") : "" };
    const identification = r.cac(payeeEl, "PartyIdentification");
    if (identification) {
      const identifier = readIdentifier(r.cbcEl(identification, "ID"));
      if (identifier) payee.identifier = identifier;
    }
    const legalEntity = r.cac(payeeEl, "PartyLegalEntity");
    if (legalEntity) {
      const identifier = readIdentifier(r.cbcEl(legalEntity, "CompanyID"));
      if (identifier) payee.legalRegistrationId = identifier;
    }
    invoice.payee = payee;
  }

  const representativeEl = r.cac(root, "TaxRepresentativeParty");
  if (representativeEl) {
    const nameEl = r.cac(representativeEl, "PartyName");
    const addressEl = r.cac(representativeEl, "PostalAddress");
    const taxSchemeEl = r.cac(representativeEl, "PartyTaxScheme");
    const representative: TaxRepresentative = {
      name: nameEl ? (r.cbc(nameEl, "Name") ?? "") : "",
      vatId: taxSchemeEl ? (r.cbc(taxSchemeEl, "CompanyID") ?? "") : "",
      address: addressEl
        ? readAddress(r, addressEl)
        : { city: "", postalCode: "", countryCode: "" },
    };
    if (taxSchemeEl) {
      const scheme = r.cac(taxSchemeEl, "TaxScheme");
      if (scheme) r.cbc(scheme, "ID");
    }
    invoice.taxRepresentative = representative;
  }

  const delivery = r.cac(root, "Delivery");
  if (delivery) {
    set(invoice, "deliveryDate", r.cbc(delivery, "ActualDeliveryDate"));
    const location = r.cac(delivery, "DeliveryLocation");
    if (location) {
      const identifier = readIdentifier(r.cbcEl(location, "ID"));
      if (identifier) invoice.deliverToLocationId = identifier;
      const addressEl = r.cac(location, "Address");
      if (addressEl) {
        const address = readAddress(r, addressEl);
        const deliverTo: DeliverToAddress = { countryCode: address.countryCode };
        set(deliverTo, "line1", address.line1);
        set(deliverTo, "line2", address.line2);
        if (address.city !== "") deliverTo.city = address.city;
        if (address.postalCode !== "") deliverTo.postalCode = address.postalCode;
        set(deliverTo, "countrySubdivision", address.countrySubdivision);
        invoice.deliverTo = deliverTo;
      }
    }
    const deliveryParty = r.cac(delivery, "DeliveryParty");
    if (deliveryParty) {
      const nameEl = r.cac(deliveryParty, "PartyName");
      if (nameEl) set(invoice, "deliverToName", r.cbc(nameEl, "Name"));
    }
  }

  const paymentMeans = r.cac(root, "PaymentMeans");
  if (paymentMeans) {
    const meansCodeEl = r.cbcEl(paymentMeans, "PaymentMeansCode");
    const payment: PaymentInstructions = { meansCode: meansCodeEl?.text ?? "" };
    if (meansCodeEl) set(payment, "meansName", attr(meansCodeEl, "name"));
    set(payment, "remittanceInformation", r.cbc(paymentMeans, "PaymentID"));

    const card = r.cac(paymentMeans, "CardAccount");
    if (card) {
      const value: PaymentCard = {
        primaryAccountNumber: r.cbc(card, "PrimaryAccountNumberID") ?? "",
      };
      set(value, "holderName", r.cbc(card, "HolderName"));
      const network = firstChild(card, CBC, "NetworkID");
      if (network) {
        r.note(
          network,
          "recomputed",
          "cbc:NetworkID is mandatory in UBL's CardAccountType but carries no EN 16931 " +
            'business term. The generator always emits "NA".',
        );
      }
      payment.card = value;
    }

    const account = r.cac(paymentMeans, "PayeeFinancialAccount");
    if (account) {
      set(payment, "iban", r.cbc(account, "ID"));
      set(payment, "accountName", r.cbc(account, "Name"));
      const branch = r.cac(account, "FinancialInstitutionBranch");
      if (branch) set(payment, "bic", r.cbc(branch, "ID"));
    }

    const mandate = r.cac(paymentMeans, "PaymentMandate");
    if (mandate || sepaCreditorIdentifier !== undefined) {
      const directDebit: NonNullable<PaymentInstructions["directDebit"]> = {};
      if (mandate) {
        set(directDebit, "mandateReference", r.cbc(mandate, "ID"));
        const payer = r.cac(mandate, "PayerFinancialAccount");
        if (payer) set(directDebit, "debitedAccount", r.cbc(payer, "ID"));
      }
      set(directDebit, "creditorIdentifier", sepaCreditorIdentifier);
      payment.directDebit = directDebit;
      sepaCreditorIdentifier = undefined;
    }

    invoice.payment = payment;
  }

  if (sepaCreditorIdentifier !== undefined) {
    // BT-90 lives on the seller party but belongs to BG-19, which hangs off the
    // payment instructions. With no cac:PaymentMeans there is nowhere to put it.
    r.unmapped.push({
      path: `${root.path}/cac:AccountingSupplierParty/cac:Party/cac:PartyIdentification`,
      name: "cbc:ID",
      namespace: CBC,
      kind: "unknown",
      reason:
        'The seller carries a PartyIdentification with schemeID="SEPA" (BT-90, the SEPA ' +
        "creditor identifier), but the document has no cac:PaymentMeans, and the input " +
        "model only holds BT-90 inside the payment instructions.",
      text: sepaCreditorIdentifier.slice(0, 200),
    });
  }

  const terms = r.cac(root, "PaymentTerms");
  if (terms) set(invoice, "paymentTerms", r.cbc(terms, "Note"));

  const allowances: DocumentAllowanceCharge[] = [];
  const charges: DocumentAllowanceCharge[] = [];
  for (const entry of r.cacAll(root, "AllowanceCharge")) {
    const charge = isCharge(r, entry);
    (charge ? charges : allowances).push(readDocumentAllowanceCharge(r, entry));
  }
  if (allowances.length > 0) invoice.allowances = allowances;
  if (charges.length > 0) invoice.charges = charges;

  // The VAT breakdown is recomputed from the lines, so only the two things the
  // model cannot derive are read here: the declared total (BT-110), and the
  // exemption reasons (BT-120 / BT-121), which are free text.
  const declared: DeclaredTotals = {};
  const declaredSubtotals: DeclaredTaxSubtotal[] = [];
  const exemptionReasons: Partial<Record<VatCategory, string>> = {};
  const exemptionReasonCodes: Partial<Record<VatCategory, string>> = {};
  const taxCurrencyCode = invoice.vatAccountingCurrency;
  let taxTotalIndex = 0;
  for (const taxTotal of r.cacAll(root, "TaxTotal")) {
    const amountEl = r.cbcEl(taxTotal, "TaxAmount");
    const subtotals = r.cacAll(taxTotal, "TaxSubtotal");
    const currencyId = amountEl ? attr(amountEl, "currencyID") : undefined;
    const isFirstTaxTotal = taxTotalIndex === 0;
    taxTotalIndex += 1;

    // BT-111: the same VAT total restated in the VAT accounting currency, as a
    // second cac:TaxTotal carrying nothing but the amount.
    //
    // The absence of a breakdown is the primary signal here, and it is a
    // stronger one than CII has — but it is not enough on its own when BT-6
    // equals BT-5 (see the same defect in parse-cii.ts). BT-110 is mandatory,
    // so the first cac:TaxTotal is BT-110 whatever its currency says; only a
    // later one can be the restatement.
    if (
      subtotals.length === 0 &&
      taxCurrencyCode !== undefined &&
      currencyId?.toUpperCase() === taxCurrencyCode &&
      (!isFirstTaxTotal || taxCurrencyCode !== invoice.currency?.toUpperCase())
    ) {
      const value = amountEl ? Number(amountEl.text.trim()) : Number.NaN;
      if (Number.isFinite(value)) invoice.taxAmountInAccountingCurrency = value;
      continue;
    }

    if (amountEl && declared.taxAmount === undefined) {
      const value = Number(amountEl.text.trim());
      if (Number.isFinite(value)) declared.taxAmount = value;
    }

    for (const subtotal of subtotals) {
      // BT-116 and BT-117 are kept as *declared* figures and compared against
      // the computed breakdown. Until 0.4.0 they were noted as "recomputed"
      // and discarded, so a corrupt VAT basis or VAT amount reached
      // `valid: true` with zero errors while KoSIT rejected the same document
      // under BR-S-08 (or its per-category sibling) and BR-CO-14.
      const stated: DeclaredTaxSubtotal = {};
      set(stated, "taxableAmount", r.num(subtotal, "TaxableAmount"));
      set(stated, "taxAmount", r.num(subtotal, "TaxAmount"));
      const category = r.cac(subtotal, "TaxCategory");
      if (!category) {
        if (Object.keys(stated).length > 0) declaredSubtotals.push(stated);
        continue;
      }
      const code = (r.cbc(category, "ID") ?? "") as VatCategory;
      if (code !== ("" as VatCategory)) stated.category = code;
      set(stated, "rate", r.num(category, "Percent"));
      declaredSubtotals.push(stated);
      const scheme = r.cac(category, "TaxScheme");
      if (scheme) r.cbc(scheme, "ID");
      const reason = r.cbc(category, "TaxExemptionReason");
      if (reason !== undefined) exemptionReasons[code] = reason;
      const reasonCode = r.cbc(category, "TaxExemptionReasonCode");
      if (reasonCode !== undefined) exemptionReasonCodes[code] = reasonCode;
    }
  }
  if (declaredSubtotals.length > 0) declared.subtotals = declaredSubtotals;
  if (Object.keys(exemptionReasons).length > 0) {
    invoice.vatExemptionReasons = exemptionReasons;
  }
  if (Object.keys(exemptionReasonCodes).length > 0) {
    invoice.vatExemptionReasonCodes = exemptionReasonCodes;
  }

  const monetaryTotal = r.cac(root, "LegalMonetaryTotal");
  if (monetaryTotal) {
    set(declared, "lineExtensionAmount", r.num(monetaryTotal, "LineExtensionAmount"));
    set(declared, "taxExclusiveAmount", r.num(monetaryTotal, "TaxExclusiveAmount"));
    set(declared, "taxInclusiveAmount", r.num(monetaryTotal, "TaxInclusiveAmount"));
    set(declared, "allowanceTotalAmount", r.num(monetaryTotal, "AllowanceTotalAmount"));
    set(declared, "chargeTotalAmount", r.num(monetaryTotal, "ChargeTotalAmount"));
    set(declared, "payableAmount", r.num(monetaryTotal, "PayableAmount"));
    set(invoice, "paidAmount", r.num(monetaryTotal, "PrepaidAmount"));
    set(invoice, "roundingAmount", r.num(monetaryTotal, "PayableRoundingAmount"));
  }
  if (Object.keys(declared).length > 0) invoice.declaredTotals = declared;

  const readLines = r.cacAll(root, "InvoiceLine").map((line) => readLine(r, line));
  invoice.lines = readLines.map((read) => read.line);
  if (readLines.some((read) => read.declaredNetAmount !== undefined)) {
    declared.lineNetAmounts = readLines.map((read) => read.declaredNetAmount);
    invoice.declaredTotals = declared;
  }

  r.sweep(root);

  const result: ParsedInvoice = { invoice, unmapped: r.unmapped };
  if (customizationId !== undefined) result.customizationId = customizationId;
  if (profileId !== undefined) result.profileId = profileId;
  return result;
}

/**
 * BT-24 → profile.
 *
 * An unrecognised customization identifier is not fatal — CIUS identifiers gain
 * version suffixes, and a document from an older XRechnung release is still a
 * document worth reading. But the choice of profile decides which rules run, so
 * a guess is recorded in `unmapped` rather than made quietly.
 */
function profileFor(
  customizationId: string | undefined,
  r: Reader,
  root: XmlElement,
): Profile {
  if (customizationId === undefined) {
    r.unmapped.push({
      path: `${root.path}/cbc:CustomizationID`,
      name: "cbc:CustomizationID",
      namespace: CBC,
      kind: "unknown",
      reason:
        'The document states no specification identifier (BT-24), so the profile was ' +
        'set to "en16931" — the core rules only. If this document is meant to be an ' +
        "XRechnung or a Peppol BIS 3 invoice, set invoice.profile yourself before " +
        "validating, or the CIUS rules will not run.",
    });
    return "en16931";
  }

  const exact = PROFILE_BY_CUSTOMIZATION_ID[customizationId.trim()];
  if (exact) return exact;

  const lower = customizationId.toLowerCase();
  const guess: Profile = lower.includes("xrechnung")
    ? "xrechnung-ubl"
    : lower.includes("peppol")
      ? "peppol-bis-3"
      : "en16931";
  r.unmapped.push({
    path: `${root.path}/cbc:CustomizationID`,
    name: "cbc:CustomizationID",
    namespace: CBC,
    kind: "unknown",
    reason:
      `"${customizationId.slice(0, 120)}" is not a specification identifier (BT-24) this ` +
      `build knows. The profile was set to "${guess}" from the text of the identifier. ` +
      `Check that, because the profile decides which CIUS rules run.`,
    text: customizationId.slice(0, 200),
  });
  return guess;
}
