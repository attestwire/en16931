/**
 * UN/CEFACT `CrossIndustryInvoice` (CII, D16B) XML → the `InvoiceInput` model.
 *
 * This is the inverse of `generate-cii.ts`, and only of `generate-cii.ts`: it
 * reads the same elements, in the same bindings, and puts them back in the same
 * fields. Anything it meets that has no field is reported in `unmapped` rather
 * than dropped.
 *
 * It shares the hardened XML reader in `xml-parse.ts` with the UBL parser —
 * there is exactly one XML parser in this package, with one set of security
 * limits — and the bookkeeping in `xml-reader.ts`. What is different is the
 * vocabulary, and all of it is resolved by **namespace URI**, never by prefix.
 * A document that calls the namespaces `a:` and `b:` reads the same as one
 * using `rsm:` and `ram:`.
 *
 * It is a reader, not a validator and not an authority. Run `validateInput` on
 * the result to get findings; a document that parses here and validates there
 * can still be rejected by KoSIT or by a receiving platform.
 */

import {
  CREDIT_NOTE_TYPE_CODES,
  DEFAULT_INVOICE_TYPE_CODE,
} from "./generate.js";
import {
  CII_NAMESPACES,
  SUPPORTING_DOCUMENT_TYPE_CODE,
  TENDER_OR_LOT_DOCUMENT_TYPE_CODE,
} from "./generate-cii.js";
import { UnsupportedCreditNoteError, type ParsedInvoice } from "./parse.js";
import {
  attr,
  firstChild,
  parseXml,
  ParseError,
  type XmlElement,
  type XmlLimits,
} from "./xml-parse.js";
import { set, TreeReader } from "./xml-reader.js";
import type {
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

const RSM = CII_NAMESPACES.rsm;
const RAM = CII_NAMESPACES.ram;
const UDT = CII_NAMESPACES.udt;
const QDT = CII_NAMESPACES.qdt;

const UBL_INVOICE_NS = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";
const UBL_CREDIT_NOTE_NS =
  "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2";

/** UNTDID 1001 code that marks a `ram:AdditionalReferencedDocument` as BT-18. */
const INVOICED_OBJECT_CODE = "130";

/** The customization identifiers (BT-24) this parser recognises, per profile. */
const PROFILE_BY_CUSTOMIZATION_ID: Record<string, Profile> = {
  "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0":
    "xrechnung-cii",
  "urn:cen.eu:en16931:2017": "en16931",
};

/** Thrown when the document is not a UN/CEFACT `CrossIndustryInvoice`. */
export class UnsupportedCiiSyntaxError extends ParseError {
  readonly rootElement: string;
  readonly rootNamespace: string;

  constructor(rootElement: string, rootNamespace: string, detail: string) {
    super(
      "unsupported_syntax",
      `parseCiiInvoice reads UN/CEFACT CrossIndustryInvoice (CII) documents only. ` +
        `${detail} The root element found was <${rootElement}> in the namespace ` +
        `"${rootNamespace || "(none)"}"; a CII invoice has the root element ` +
        `CrossIndustryInvoice in "${RSM}". Parsing this document as CII would produce ` +
        `an invoice object with almost every field missing, and a long list of findings ` +
        `that all point at the wrong problem, so this call refuses instead.`,
    );
    this.rootElement = rootElement;
    this.rootNamespace = rootNamespace;
  }
}

export interface ParseCiiOptions extends Partial<XmlLimits> {}

class Reader extends TreeReader {
  /** Text of a `ram:` leaf, marked as read. */
  ram(parent: XmlElement, local: string): string | undefined {
    return this.leaf(parent, RAM, local);
  }

  /** A `ram:` leaf element itself, marked as read — for attribute access. */
  ramEl(parent: XmlElement, local: string): XmlElement | undefined {
    return this.leafEl(parent, RAM, local);
  }

  /** A `ram:` container, marked as walked into. */
  grp(parent: XmlElement, local: string): XmlElement | undefined {
    return this.group(parent, RAM, local);
  }

  /** Every `ram:` container with this name, each marked as walked into. */
  grpAll(parent: XmlElement, local: string): XmlElement[] {
    return this.groupAll(parent, RAM, local);
  }

  /** Every `ram:` leaf with this name, each marked as read. */
  ramAll(parent: XmlElement, local: string): XmlElement[] {
    return this.leafAll(parent, RAM, local);
  }

  num(parent: XmlElement, local: string): number | undefined {
    return this.number(parent, RAM, local);
  }
}

/**
 * `YYYYMMDD` → `YYYY-MM-DD`.
 *
 * Anything else is returned untouched. A date this reader cannot recognise is
 * carried into the model exactly as written, so `validateInput` can raise
 * `ATW-DATE-NOT-A-CALENDAR-DATE` on it — better than a silently invented date.
 */
export function fromCiiDate(value: string): string {
  const raw = value.trim();
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : raw;
}

/**
 * A CII date: `<ram:X><udt:DateTimeString format="102">…</udt:DateTimeString></ram:X>`.
 *
 * `child` names the wrapper's own child, because the three date wrappers in an
 * EN 16931 CII invoice do not agree on it: most use `udt:DateTimeString`,
 * `ram:TaxPointDate` uses `udt:DateString`, and `ram:FormattedIssueDateTime`
 * uses `qdt:DateTimeString` — a different namespace, not just a different name.
 */
function readDate(
  r: Reader,
  parent: XmlElement,
  local: string,
  child: { namespace: string; local: string } = {
    namespace: UDT,
    local: "DateTimeString",
  },
): string | undefined {
  const wrapper = r.grp(parent, local);
  if (!wrapper) return undefined;
  const value = r.leafEl(wrapper, child.namespace, child.local);
  if (!value) return undefined;
  return fromCiiDate(value.text);
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

/** `ram:PostalTradeAddress` → `PostalAddress`. */
function readAddress(r: Reader, el: XmlElement): PostalAddress {
  const address: PostalAddress = {
    city: r.ram(el, "CityName") ?? "",
    postalCode: r.ram(el, "PostcodeCode") ?? "",
    countryCode: r.ram(el, "CountryID") ?? "",
  };
  set(address, "line1", r.ram(el, "LineOne"));
  set(address, "line2", r.ram(el, "LineTwo"));
  set(address, "line3", r.ram(el, "LineThree"));
  set(address, "countrySubdivision", r.ram(el, "CountrySubDivisionName"));
  return address;
}

/** `ram:*TradeParty` → `Party`. */
function readParty(r: Reader, el: XmlElement): Party {
  const party: Party = {
    name: r.ram(el, "Name") ?? "",
    address: { city: "", postalCode: "", countryCode: "" },
  };

  // BT-29/BT-46 is ram:ID without a scheme and ram:GlobalID with one.
  const globalId = readIdentifier(r.ramEl(el, "GlobalID"));
  const plainId = readIdentifier(r.ramEl(el, "ID"));
  if (globalId) party.identifier = globalId;
  else if (plainId) party.identifier = plainId;

  set(party, "additionalLegalInformation", r.ram(el, "Description"));

  const legalOrganization = r.grp(el, "SpecifiedLegalOrganization");
  if (legalOrganization) {
    const companyId = r.ramEl(legalOrganization, "ID");
    if (companyId) {
      party.legalRegistrationId = companyId.text;
      set(party, "legalRegistrationSchemeId", attr(companyId, "schemeID"));
    }
    const tradingName = r.ram(legalOrganization, "TradingBusinessName");
    if (tradingName !== undefined && tradingName !== party.name) {
      party.tradingName = tradingName;
    }
  }

  const contact = r.grp(el, "DefinedTradeContact");
  if (contact) {
    const value: NonNullable<Party["contact"]> = {};
    set(value, "name", r.ram(contact, "PersonName"));
    const phone = r.grp(contact, "TelephoneUniversalCommunication");
    if (phone) set(value, "phone", r.ram(phone, "CompleteNumber"));
    const email = r.grp(contact, "EmailURIUniversalCommunication");
    if (email) set(value, "email", r.ram(email, "URIID"));
    party.contact = value;
  }

  const postal = r.grp(el, "PostalTradeAddress");
  if (postal) party.address = readAddress(r, postal);

  const endpoint = r.grp(el, "URIUniversalCommunication");
  if (endpoint) {
    const uri = r.ramEl(endpoint, "URIID");
    if (uri) {
      party.electronicAddress = {
        schemeId: attr(uri, "schemeID") ?? "",
        value: uri.text,
      };
    }
  }

  // BT-31 and BT-32 share one element and are told apart by schemeID: "VA" is
  // the VAT identifier, "FC" the national tax registration.
  for (const registration of r.grpAll(el, "SpecifiedTaxRegistration")) {
    const idEl = r.ramEl(registration, "ID");
    if (!idEl) continue;
    const scheme = attr(idEl, "schemeID");
    if (scheme === "VA") set(party, "vatId", idEl.text);
    else if (scheme === "FC") set(party, "taxRegistrationId", idEl.text);
    else {
      r.note(
        registration,
        "unknown",
        `The input model holds a VAT registration (schemeID "VA") and a national tax ` +
          `registration (schemeID "FC"). The scheme here is "${scheme ?? "(absent)"}", ` +
          `which has no field.`,
      );
    }
  }

  return party;
}

function readPeriod(r: Reader, el: XmlElement): InvoicingPeriod {
  const period: InvoicingPeriod = {};
  set(period, "startDate", readDate(r, el, "StartDateTime"));
  set(period, "endDate", readDate(r, el, "EndDateTime"));
  return period;
}

/** `ram:ChargeIndicator/udt:Indicator` — the schematron matches `true()`. */
function isCharge(r: Reader, el: XmlElement): boolean {
  const indicator = r.grp(el, "ChargeIndicator");
  if (!indicator) return false;
  const value = r.leafEl(indicator, UDT, "Indicator");
  return (value?.text ?? "").trim().toLowerCase() === "true";
}

function readAllowanceChargeCore(
  r: Reader,
  el: XmlElement,
): LineAllowanceCharge {
  const entry: LineAllowanceCharge = { amount: r.num(el, "ActualAmount") ?? 0 };
  set(entry, "baseAmount", r.num(el, "BasisAmount"));
  set(entry, "percentage", r.num(el, "CalculationPercent"));
  set(entry, "reason", r.ram(el, "Reason"));
  set(entry, "reasonCode", r.ram(el, "ReasonCode"));
  return entry;
}

function readDocumentAllowanceCharge(
  r: Reader,
  el: XmlElement,
): DocumentAllowanceCharge {
  const core = readAllowanceChargeCore(r, el);
  const tax = r.grp(el, "CategoryTradeTax");
  const entry: DocumentAllowanceCharge = {
    ...core,
    vatCategory: (tax ? (r.ram(tax, "CategoryCode") ?? "") : "") as VatCategory,
  };
  if (tax) {
    r.ram(tax, "TypeCode");
    set(entry, "vatRate", r.num(tax, "RateApplicablePercent"));
  }
  return entry;
}

/** `ram:AdditionalReferencedDocument` → BG-24, BT-17 or BT-18, by type code. */
function readReferencedDocument(
  r: Reader,
  el: XmlElement,
): { kind: "supporting" | "object" | "tender"; document: SupportingDocument; identifier?: { value: string; schemeId?: string } } {
  const typeCode = (r.ram(el, "TypeCode") ?? "").trim();
  const issuerId = r.ram(el, "IssuerAssignedID") ?? "";

  if (typeCode === INVOICED_OBJECT_CODE) {
    const schemeId = r.ram(el, "ReferenceTypeCode");
    const identifier: { value: string; schemeId?: string } = { value: issuerId };
    if (schemeId !== undefined) identifier.schemeId = schemeId;
    return { kind: "object", document: { reference: issuerId }, identifier };
  }

  if (typeCode === TENDER_OR_LOT_DOCUMENT_TYPE_CODE) {
    return { kind: "tender", document: { reference: issuerId } };
  }

  const document: SupportingDocument = { reference: issuerId };
  set(document, "description", r.ram(el, "Name"));
  set(document, "externalUri", r.ram(el, "URIID"));
  const embedded = r.ramEl(el, "AttachmentBinaryObject");
  if (embedded) {
    document.attachment = {
      filename: attr(embedded, "filename") ?? "",
      mimeCode: attr(embedded, "mimeCode") ?? "",
      content: embedded.text,
    };
  }
  if (typeCode !== "" && typeCode !== SUPPORTING_DOCUMENT_TYPE_CODE) {
    r.unmapped.push({
      path: `${el.path}/ram:TypeCode`,
      name: "ram:TypeCode",
      namespace: RAM,
      kind: "unknown",
      reason:
        `This referenced document carries the type code "${typeCode}". The input model ` +
        `knows ${SUPPORTING_DOCUMENT_TYPE_CODE} (supporting document, BG-24), ` +
        `${INVOICED_OBJECT_CODE} (invoiced object identifier, BT-18) and ` +
        `${TENDER_OR_LOT_DOCUMENT_TYPE_CODE} (tender or lot reference, BT-17). It was ` +
        `read as a supporting document, and the code itself was not carried over.`,
      text: typeCode,
    });
  }
  return { kind: "supporting", document };
}

function readLine(r: Reader, el: XmlElement): InvoiceLine {
  const lineDocument = r.grp(el, "AssociatedDocumentLineDocument");
  const product = r.grp(el, "SpecifiedTradeProduct");
  const agreement = r.grp(el, "SpecifiedLineTradeAgreement");
  const deliveryGroup = r.grp(el, "SpecifiedLineTradeDelivery");
  const settlement = r.grp(el, "SpecifiedLineTradeSettlement");

  const quantity = deliveryGroup
    ? r.ramEl(deliveryGroup, "BilledQuantity")
    : undefined;
  const quantityValue = quantity ? Number(quantity.text.trim()) : undefined;
  if (quantity && !Number.isFinite(quantityValue)) {
    r.note(
      quantity,
      "unknown",
      `"${quantity.text.trim().slice(0, 40)}" is not a number; the quantity was read as 0.`,
    );
  }

  const line: InvoiceLine = {
    id: lineDocument ? (r.ram(lineDocument, "LineID") ?? "") : "",
    description: "",
    quantity: Number.isFinite(quantityValue) ? (quantityValue as number) : 0,
    unitCode: quantity ? (attr(quantity, "unitCode") ?? "") : "",
    unitPrice: 0,
    vatCategory: "" as VatCategory,
  };

  if (lineDocument) {
    const note = r.grp(lineDocument, "IncludedNote");
    if (note) set(line, "note", r.ram(note, "Content"));
  }

  if (product) {
    line.description = r.ram(product, "Name") ?? "";
    set(line, "longDescription", r.ram(product, "Description"));
    set(line, "sellerItemId", r.ram(product, "SellerAssignedID"));
    set(line, "buyerItemId", r.ram(product, "BuyerAssignedID"));
    const globalId = readIdentifier(r.ramEl(product, "GlobalID"));
    if (globalId) line.standardItemId = globalId;
    const origin = r.grp(product, "OriginTradeCountry");
    if (origin) set(line, "originCountryCode", r.ram(origin, "ID"));

    const attributes: ItemAttribute[] = [];
    for (const characteristic of r.grpAll(
      product,
      "ApplicableProductCharacteristic",
    )) {
      attributes.push({
        name: r.ram(characteristic, "Description") ?? "",
        value: r.ram(characteristic, "Value") ?? "",
      });
    }
    if (attributes.length > 0) line.itemAttributes = attributes;

    const classifications: ItemClassification[] = [];
    for (const classification of r.grpAll(
      product,
      "DesignatedProductClassification",
    )) {
      const code = r.ramEl(classification, "ClassCode");
      if (!code) continue;
      const entry: ItemClassification = {
        code: code.text,
        schemeId: attr(code, "listID") ?? "",
      };
      const version = attr(code, "listVersionID");
      if (version !== undefined) entry.schemeVersion = version;
      classifications.push(entry);
    }
    if (classifications.length > 0) line.itemClassifications = classifications;
  }

  if (agreement) {
    const orderLine = r.grp(agreement, "BuyerOrderReferencedDocument");
    if (orderLine) set(line, "orderLineReference", r.ram(orderLine, "LineID"));

    const netPrice = r.grp(agreement, "NetPriceProductTradePrice");
    if (netPrice) {
      line.unitPrice = r.num(netPrice, "ChargeAmount") ?? 0;
      set(line, "baseQuantity", r.num(netPrice, "BasisQuantity"));
    }

    // BT-148/BT-147: a separate price element in CII, with the discount as an
    // allowance hanging off it.
    const grossPrice = r.grp(agreement, "GrossPriceProductTradePrice");
    if (grossPrice) {
      set(line, "grossUnitPrice", r.num(grossPrice, "ChargeAmount"));
      r.num(grossPrice, "BasisQuantity");
      const applied = r.grp(grossPrice, "AppliedTradeAllowanceCharge");
      if (applied) {
        isCharge(r, applied);
        set(line, "priceDiscount", r.num(applied, "ActualAmount"));
      }
    }
  }

  if (settlement) {
    const tax = r.grp(settlement, "ApplicableTradeTax");
    if (tax) {
      r.ram(tax, "TypeCode");
      line.vatCategory = (r.ram(tax, "CategoryCode") ?? "") as VatCategory;
      set(line, "vatRate", r.num(tax, "RateApplicablePercent"));
    }

    const period = r.grp(settlement, "BillingSpecifiedPeriod");
    if (period) line.period = readPeriod(r, period);

    const allowances: LineAllowanceCharge[] = [];
    const charges: LineAllowanceCharge[] = [];
    for (const entry of r.grpAll(settlement, "SpecifiedTradeAllowanceCharge")) {
      const charge = isCharge(r, entry);
      (charge ? charges : allowances).push(readAllowanceChargeCore(r, entry));
    }
    if (allowances.length > 0) line.allowances = allowances;
    if (charges.length > 0) line.charges = charges;

    // BT-131 is derived from quantity, price and the line allowances and
    // charges, so it has no field of its own.
    const summation = r.grp(
      settlement,
      "SpecifiedTradeSettlementLineMonetarySummation",
    );
    if (summation) {
      const total = firstChild(summation, RAM, "LineTotalAmount");
      if (total) {
        r.note(
          total,
          "recomputed",
          "BT-131 is computed from the quantity, the price and the line allowances and " +
            "charges. Compare it with computeTotals(invoice).lineNetAmounts if you want " +
            "to know whether the document's own arithmetic agrees.",
        );
      }
    }

    for (const reference of r.grpAll(settlement, "AdditionalReferencedDocument")) {
      const read = readReferencedDocument(r, reference);
      if (read.kind === "object" && read.identifier) {
        line.objectIdentifier = read.identifier;
      } else {
        r.note(
          reference,
          "unknown",
          "The input model holds one line-level referenced document, the invoiced " +
            "object identifier (BT-128, type code 130). This one was not carried over.",
        );
      }
    }

    const account = r.grp(
      settlement,
      "ReceivableSpecifiedTradeAccountingAccount",
    );
    if (account) set(line, "buyerAccountingReference", r.ram(account, "ID"));
  }

  return line;
}

/**
 * Read a UN/CEFACT `CrossIndustryInvoice` document into the `InvoiceInput`
 * model.
 *
 * ```ts
 * const { invoice, unmapped } = parseCiiInvoice(xmlString);
 * const findings = validateInput(invoice);
 * ```
 *
 * @throws {XmlSecurityError} DOCTYPE present, a custom entity, or the document
 *   is over the size, depth or element limits.
 * @throws {XmlSyntaxError} the document is not well-formed, or uses a
 *   construct outside the accepted subset.
 * @throws {UnsupportedCiiSyntaxError} the root element is not a CII
 *   `CrossIndustryInvoice` — a UBL document, or something else entirely.
 * @throws {UnsupportedCreditNoteError} BT-3 says the document is a credit note.
 *
 * All four extend `ParseError` and carry a stable `code`.
 */
export function parseCiiInvoice(
  xml: string,
  options: ParseCiiOptions = {},
): ParsedInvoice {
  const root = parseXml(xml, options);

  if (root.namespace === UBL_INVOICE_NS || root.namespace === UBL_CREDIT_NOTE_NS) {
    throw new UnsupportedCiiSyntaxError(
      root.qname,
      root.namespace,
      "This is a UBL document — the syntax used by XRechnung UBL and Peppol BIS 3. " +
        "Read it with parseUblInvoice instead.",
    );
  }
  if (root.namespace !== RSM || root.local !== "CrossIndustryInvoice") {
    throw new UnsupportedCiiSyntaxError(
      root.qname,
      root.namespace,
      "The document is not a Cross Industry Invoice.",
    );
  }

  const r = new Reader();
  r.enter(root);

  const context = r.group(root, RSM, "ExchangedDocumentContext");
  let customizationId: string | undefined;
  let profileId: string | undefined;
  if (context) {
    const business = r.grp(
      context,
      "BusinessProcessSpecifiedDocumentContextParameter",
    );
    if (business) profileId = r.ram(business, "ID");
    const guideline = r.grp(
      context,
      "GuidelineSpecifiedDocumentContextParameter",
    );
    if (guideline) customizationId = r.ram(guideline, "ID");
  }
  const profile = profileFor(customizationId, r, root);

  const header = r.group(root, RSM, "ExchangedDocument");
  const typeCode = (
    (header ? r.ram(header, "TypeCode") : undefined) ?? DEFAULT_INVOICE_TYPE_CODE
  ).trim();
  if (CREDIT_NOTE_TYPE_CODES.has(typeCode)) {
    throw new UnsupportedCreditNoteError(typeCode);
  }

  const invoice: InvoiceInput = {
    profile,
    invoiceNumber: header ? (r.ram(header, "ID") ?? "") : "",
    issueDate: (header ? readDate(r, header, "IssueDateTime") : undefined) ?? "",
    currency: "",
    invoiceTypeCode: typeCode,
    seller: { name: "", address: { city: "", postalCode: "", countryCode: "" } },
    buyer: { name: "", address: { city: "", postalCode: "", countryCode: "" } },
    lines: [],
  };

  if (header) {
    // BT-21 has a real element in CII, so there is no "#CODE#" prefix to undo.
    const notes = r.grpAll(header, "IncludedNote");
    if (notes.length > 0) {
      set(invoice, "note", r.ram(notes[0]!, "Content"));
      set(invoice, "noteSubjectCode", r.ram(notes[0]!, "SubjectCode"));
      for (const extra of notes.slice(1)) {
        r.note(
          extra,
          "unknown",
          "The input model carries one document note (BT-22). This further " +
            "ram:IncludedNote was not carried over.",
        );
      }
    }
  }

  const transaction = r.group(root, RSM, "SupplyChainTradeTransaction");
  if (!transaction) {
    r.sweep(root);
    const bare: ParsedInvoice = { invoice, unmapped: r.unmapped };
    if (customizationId !== undefined) bare.customizationId = customizationId;
    if (profileId !== undefined) bare.profileId = profileId;
    return bare;
  }

  // --- ram:ApplicableHeaderTradeAgreement ----------------------------------
  const agreement = r.grp(transaction, "ApplicableHeaderTradeAgreement");
  if (agreement) {
    set(invoice, "buyerReference", r.ram(agreement, "BuyerReference"));

    const seller = r.grp(agreement, "SellerTradeParty");
    if (seller) invoice.seller = readParty(r, seller);
    const buyer = r.grp(agreement, "BuyerTradeParty");
    if (buyer) invoice.buyer = readParty(r, buyer);

    const representativeEl = r.grp(
      agreement,
      "SellerTaxRepresentativeTradeParty",
    );
    if (representativeEl) {
      const addressEl = r.grp(representativeEl, "PostalTradeAddress");
      const registration = r.grp(representativeEl, "SpecifiedTaxRegistration");
      const representative: TaxRepresentative = {
        name: r.ram(representativeEl, "Name") ?? "",
        vatId: registration ? (r.ram(registration, "ID") ?? "") : "",
        address: addressEl
          ? readAddress(r, addressEl)
          : { city: "", postalCode: "", countryCode: "" },
      };
      invoice.taxRepresentative = representative;
    }

    const sellerOrder = r.grp(agreement, "SellerOrderReferencedDocument");
    if (sellerOrder) {
      set(invoice, "salesOrderReference", r.ram(sellerOrder, "IssuerAssignedID"));
    }
    const buyerOrder = r.grp(agreement, "BuyerOrderReferencedDocument");
    if (buyerOrder) {
      set(invoice, "orderReference", r.ram(buyerOrder, "IssuerAssignedID"));
    }
    const contract = r.grp(agreement, "ContractReferencedDocument");
    if (contract) {
      set(invoice, "contractReference", r.ram(contract, "IssuerAssignedID"));
    }

    const supporting: SupportingDocument[] = [];
    for (const reference of r.grpAll(agreement, "AdditionalReferencedDocument")) {
      const read = readReferencedDocument(r, reference);
      if (read.kind === "object" && read.identifier) {
        invoice.invoicedObjectIdentifier = read.identifier;
      } else if (read.kind === "tender") {
        invoice.tenderOrLotReference = read.document.reference;
      } else {
        supporting.push(read.document);
      }
    }
    if (supporting.length > 0) invoice.supportingDocuments = supporting;

    const project = r.grp(agreement, "SpecifiedProcuringProject");
    if (project) {
      set(invoice, "projectReference", r.ram(project, "ID"));
      // ram:Name is mandatory in the schema and the generator fills it from the
      // reference, so it carries no information of its own.
      const name = firstChild(project, RAM, "Name");
      if (name) {
        if (name.text === invoice.projectReference) r.use(name);
        else {
          r.note(
            name,
            "unknown",
            "The input model holds one project reference (BT-11), read from ram:ID. " +
              "This project name was not carried over.",
          );
        }
      }
    }
  }

  // --- ram:ApplicableHeaderTradeDelivery -----------------------------------
  const delivery = r.grp(transaction, "ApplicableHeaderTradeDelivery");
  if (delivery) {
    const shipTo = r.grp(delivery, "ShipToTradeParty");
    if (shipTo) {
      const identifier =
        readIdentifier(r.ramEl(shipTo, "GlobalID")) ??
        readIdentifier(r.ramEl(shipTo, "ID"));
      if (identifier) invoice.deliverToLocationId = identifier;
      set(invoice, "deliverToName", r.ram(shipTo, "Name"));
      const addressEl = r.grp(shipTo, "PostalTradeAddress");
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
    const event = r.grp(delivery, "ActualDeliverySupplyChainEvent");
    if (event) set(invoice, "deliveryDate", readDate(r, event, "OccurrenceDateTime"));
    const despatch = r.grp(delivery, "DespatchAdviceReferencedDocument");
    if (despatch) {
      set(invoice, "despatchAdviceReference", r.ram(despatch, "IssuerAssignedID"));
    }
    const receipt = r.grp(delivery, "ReceivingAdviceReferencedDocument");
    if (receipt) {
      set(invoice, "receivingAdviceReference", r.ram(receipt, "IssuerAssignedID"));
    }
  }

  // --- ram:ApplicableHeaderTradeSettlement ---------------------------------
  const settlement = r.grp(transaction, "ApplicableHeaderTradeSettlement");
  const declared: DeclaredTotals = {};
  if (settlement) {
    invoice.currency = (r.ram(settlement, "InvoiceCurrencyCode") ?? "").toUpperCase();
    const taxCurrency = r.ram(settlement, "TaxCurrencyCode");
    if (taxCurrency !== undefined) {
      invoice.vatAccountingCurrency = taxCurrency.toUpperCase();
    }
    const creditorIdentifier = r.ram(settlement, "CreditorReferenceID");
    const remittance = r.ram(settlement, "PaymentReference");

    const payeeEl = r.grp(settlement, "PayeeTradeParty");
    if (payeeEl) {
      const payee: Payee = { name: r.ram(payeeEl, "Name") ?? "" };
      const identifier =
        readIdentifier(r.ramEl(payeeEl, "GlobalID")) ??
        readIdentifier(r.ramEl(payeeEl, "ID"));
      if (identifier) payee.identifier = identifier;
      const legalOrganization = r.grp(payeeEl, "SpecifiedLegalOrganization");
      if (legalOrganization) {
        const registration = readIdentifier(r.ramEl(legalOrganization, "ID"));
        if (registration) payee.legalRegistrationId = registration;
      }
      invoice.payee = payee;
    }

    const meansEl = r.grp(settlement, "SpecifiedTradeSettlementPaymentMeans");
    const terms = r.grp(settlement, "SpecifiedTradePaymentTerms");
    let mandateReference: string | undefined;
    let debitedAccount: string | undefined;

    if (terms) {
      set(invoice, "paymentTerms", r.ram(terms, "Description"));
      set(invoice, "dueDate", readDate(r, terms, "DueDateDateTime"));
      mandateReference = r.ram(terms, "DirectDebitMandateID");
    }

    if (meansEl) {
      const payment: PaymentInstructions = {
        meansCode: r.ram(meansEl, "TypeCode") ?? "",
      };
      set(payment, "meansName", r.ram(meansEl, "Information"));
      set(payment, "remittanceInformation", remittance);

      const card = r.grp(meansEl, "ApplicableTradeSettlementFinancialCard");
      if (card) {
        const value: PaymentCard = { primaryAccountNumber: r.ram(card, "ID") ?? "" };
        set(value, "holderName", r.ram(card, "CardholderName"));
        payment.card = value;
      }

      const debtor = r.grp(meansEl, "PayerPartyDebtorFinancialAccount");
      if (debtor) debitedAccount = r.ram(debtor, "IBANID");

      const creditor = r.grp(meansEl, "PayeePartyCreditorFinancialAccount");
      if (creditor) {
        set(payment, "iban", r.ram(creditor, "IBANID"));
        set(payment, "accountName", r.ram(creditor, "AccountName"));
      }

      const institution = r.grp(
        meansEl,
        "PayeeSpecifiedCreditorFinancialInstitution",
      );
      if (institution) set(payment, "bic", r.ram(institution, "BICID"));

      if (
        mandateReference !== undefined ||
        creditorIdentifier !== undefined ||
        debitedAccount !== undefined
      ) {
        const directDebit: NonNullable<PaymentInstructions["directDebit"]> = {};
        set(directDebit, "mandateReference", mandateReference);
        set(directDebit, "creditorIdentifier", creditorIdentifier);
        set(directDebit, "debitedAccount", debitedAccount);
        payment.directDebit = directDebit;
      }

      invoice.payment = payment;
    } else if (
      creditorIdentifier !== undefined ||
      mandateReference !== undefined ||
      debitedAccount !== undefined
    ) {
      r.unmapped.push({
        path: `${settlement.path}/ram:CreditorReferenceID`,
        name: "ram:CreditorReferenceID",
        namespace: RAM,
        kind: "unknown",
        reason:
          "The document carries direct-debit details (BT-89, BT-90 or BT-91) but no " +
          "ram:SpecifiedTradeSettlementPaymentMeans, and the input model only holds " +
          "BG-19 inside the payment instructions.",
        ...(creditorIdentifier !== undefined
          ? { text: creditorIdentifier.slice(0, 200) }
          : {}),
      });
    }

    // The VAT breakdown is recomputed from the lines, so only what the model
    // cannot derive is read here: the exemption reasons (BT-120 / BT-121),
    // which are free text, and BT-7 / BT-8.
    const exemptionReasons: Partial<Record<VatCategory, string>> = {};
    const exemptionReasonCodes: Partial<Record<VatCategory, string>> = {};
    let taxPointDate: string | undefined;
    let taxPointCode: string | undefined;
    for (const tax of r.grpAll(settlement, "ApplicableTradeTax")) {
      const category = (r.ram(tax, "CategoryCode") ?? "") as VatCategory;
      r.ram(tax, "TypeCode");
      r.num(tax, "RateApplicablePercent");
      const calculated = firstChild(tax, RAM, "CalculatedAmount");
      if (calculated) {
        r.note(calculated, "recomputed", "BT-117 is computed from BT-116 and BT-119.");
      }
      const basis = firstChild(tax, RAM, "BasisAmount");
      if (basis) {
        r.note(
          basis,
          "recomputed",
          "BT-116 is computed per (category, rate) group from the lines and the " +
            "document allowances and charges.",
        );
      }
      const reason = r.ram(tax, "ExemptionReason");
      if (reason !== undefined) exemptionReasons[category] = reason;
      const reasonCode = r.ram(tax, "ExemptionReasonCode");
      if (reasonCode !== undefined) exemptionReasonCodes[category] = reasonCode;
      taxPointDate ??= readDate(r, tax, "TaxPointDate", {
        namespace: UDT,
        local: "DateString",
      });
      taxPointCode ??= r.ram(tax, "DueDateTypeCode");
    }
    if (Object.keys(exemptionReasons).length > 0) {
      invoice.vatExemptionReasons = exemptionReasons;
    }
    if (Object.keys(exemptionReasonCodes).length > 0) {
      invoice.vatExemptionReasonCodes = exemptionReasonCodes;
    }
    set(invoice, "taxPointDate", taxPointDate);

    const period = r.grp(settlement, "BillingSpecifiedPeriod");
    if (period || taxPointCode !== undefined) {
      const invoicingPeriod = period ? readPeriod(r, period) : {};
      // BT-8 has no element of its own in CII: it rides inside every VAT
      // breakdown group as ram:DueDateTypeCode.
      set(invoicingPeriod, "descriptionCode", taxPointCode);
      invoice.invoicingPeriod = invoicingPeriod;
    }

    const allowances: DocumentAllowanceCharge[] = [];
    const charges: DocumentAllowanceCharge[] = [];
    for (const entry of r.grpAll(settlement, "SpecifiedTradeAllowanceCharge")) {
      const charge = isCharge(r, entry);
      (charge ? charges : allowances).push(readDocumentAllowanceCharge(r, entry));
    }
    if (allowances.length > 0) invoice.allowances = allowances;
    if (charges.length > 0) invoice.charges = charges;

    const summation = r.grp(
      settlement,
      "SpecifiedTradeSettlementHeaderMonetarySummation",
    );
    if (summation) {
      set(declared, "lineExtensionAmount", r.num(summation, "LineTotalAmount"));
      set(declared, "chargeTotalAmount", r.num(summation, "ChargeTotalAmount"));
      set(declared, "allowanceTotalAmount", r.num(summation, "AllowanceTotalAmount"));
      set(declared, "taxExclusiveAmount", r.num(summation, "TaxBasisTotalAmount"));
      set(declared, "taxInclusiveAmount", r.num(summation, "GrandTotalAmount"));
      set(declared, "payableAmount", r.num(summation, "DuePayableAmount"));
      set(invoice, "paidAmount", r.num(summation, "TotalPrepaidAmount"));
      set(invoice, "roundingAmount", r.num(summation, "RoundingAmount"));

      // BT-110 and BT-111 are one element twice over, told apart only by
      // @currencyID. The VAT accounting currency is BT-6.
      for (const amount of r.ramAll(summation, "TaxTotalAmount")) {
        const value = Number(amount.text.trim());
        if (!Number.isFinite(value)) continue;
        const currencyId = attr(amount, "currencyID")?.toUpperCase();
        if (
          invoice.vatAccountingCurrency !== undefined &&
          currencyId === invoice.vatAccountingCurrency
        ) {
          invoice.taxAmountInAccountingCurrency = value;
        } else if (declared.taxAmount === undefined) {
          declared.taxAmount = value;
        }
      }
    }

    const preceding: PrecedingInvoiceReference[] = [];
    for (const reference of r.grpAll(settlement, "InvoiceReferencedDocument")) {
      const entry: PrecedingInvoiceReference = {
        invoiceNumber: r.ram(reference, "IssuerAssignedID") ?? "",
      };
      set(
        entry,
        "issueDate",
        readDate(r, reference, "FormattedIssueDateTime", {
          namespace: QDT,
          local: "DateTimeString",
        }),
      );
      preceding.push(entry);
    }
    if (preceding.length > 0) invoice.precedingInvoices = preceding;

    const account = r.grp(
      settlement,
      "ReceivableSpecifiedTradeAccountingAccount",
    );
    if (account) set(invoice, "buyerAccountingReference", r.ram(account, "ID"));
  }

  if (Object.keys(declared).length > 0) invoice.declaredTotals = declared;

  invoice.lines = r
    .grpAll(transaction, "IncludedSupplyChainTradeLineItem")
    .map((line) => readLine(r, line));

  r.sweep(root);

  const result: ParsedInvoice = { invoice, unmapped: r.unmapped };
  if (customizationId !== undefined) result.customizationId = customizationId;
  if (profileId !== undefined) result.profileId = profileId;
  return result;
}

/**
 * BT-24 → profile.
 *
 * Note what this cannot tell you: Factur-X's EN 16931 profile and plain core
 * EN 16931 state the *same* identifier, `urn:cen.eu:en16931:2017`, so a
 * `facturx-en16931` document reads back as `en16931`. Nothing is lost —
 * `facturx-en16931` reaches exactly the core rule set, and re-generating from
 * the parsed input produces the identical document — but if you need the
 * distinction, keep it yourself.
 */
function profileFor(
  customizationId: string | undefined,
  r: Reader,
  root: XmlElement,
): Profile {
  const path = `${root.path}/rsm:ExchangedDocumentContext/ram:GuidelineSpecifiedDocumentContextParameter/ram:ID`;

  if (customizationId === undefined) {
    r.unmapped.push({
      path,
      name: "ram:ID",
      namespace: RAM,
      kind: "unknown",
      reason:
        'The document states no specification identifier (BT-24), so the profile was ' +
        'set to "en16931" — the core rules only. If this document is meant to be an ' +
        "XRechnung CII invoice, set invoice.profile yourself before validating, or the " +
        "CIUS rules will not run.",
    });
    return "en16931";
  }

  const exact = PROFILE_BY_CUSTOMIZATION_ID[customizationId.trim()];
  if (exact) return exact;

  const guess: Profile = customizationId.toLowerCase().includes("xrechnung")
    ? "xrechnung-cii"
    : "en16931";
  r.unmapped.push({
    path,
    name: "ram:ID",
    namespace: RAM,
    kind: "unknown",
    reason:
      `"${customizationId.slice(0, 120)}" is not a specification identifier (BT-24) this ` +
      `build knows. The profile was set to "${guess}" from the text of the identifier. ` +
      `Check that, because the profile decides which CIUS rules run.`,
    text: customizationId.slice(0, 200),
  });
  return guess;
}
