/**
 * Core type model. Design goal: every validation failure is a teaching error —
 * enough context that a developer (or an AI agent reading the same payload)
 * can fix the invoice without opening the EN 16931 spec.
 */

/** Business Term identifier from EN 16931, e.g. "BT-10" (buyer reference). */
export type BusinessTerm = `BT-${number}` | `BG-${number}`;

/** Rule identifier: EN 16931 core (BR-*), German CIUS (BR-DE-*), Peppol (PEPPOL-EN16931-R*). */
export type RuleId = string;

/**
 * How much weight a finding carries.
 *
 * The three levels are the reference validators' own, not ours: KoSIT's
 * schematron flags each assertion `fatal`, `warning` or `information`, and a
 * report that promotes an advisory to an error is as wrong as one that misses
 * it. `information` was added in 0.2.0 — a document with only `information`
 * findings is accepted, silently, by every validator that raises them.
 */
export type Severity = "fatal" | "warning" | "information";

export interface TeachingError {
  rule: RuleId;
  /** Business term(s) the rule constrains. */
  field: BusinessTerm | BusinessTerm[];
  severity: Severity;
  /** Plain-English statement of what the regulation requires and why this input fails it. */
  message: string;
  /** Concrete, actionable fix ("set buyerReference to the Leitweg-ID your client gave you"). */
  fix: string;
  /** XPath into the offending XML, when validating an existing document. */
  xpath?: string;
  /** Stable docs URL — one page per rule. */
  docsUrl: string;
  /** Minimal XML/JSON example of a passing value. */
  example?: string;
}

export interface ValidationResult {
  valid: boolean;
  profile: Profile;
  errors: TeachingError[];
  warnings: TeachingError[];
  /**
   * Advisory findings (severity `"information"`). Never affect `valid`, and are
   * kept out of `warnings` deliberately: a caller that treats warnings as
   * something to fix before shipping should not be handed a finding the
   * regulator raises and then ignores.
   */
  information: TeachingError[];
}

/** Target output profiles, narrowest first. */
export type Profile =
  | "en16931" // core
  | "xrechnung-ubl"
  | "xrechnung-cii"
  | "facturx-en16931"
  | "peppol-bis-3";

/**
 * Simplified invoice input model (JSON in → compliant XML out).
 *
 * Every field beyond the six required ones is optional, and every group added
 * after 0.1.0 is optional too: an input that validated under an earlier
 * version still validates, and still generates the same document.
 */
export interface InvoiceInput {
  profile: Profile;
  invoiceNumber: string; // BT-1
  issueDate: string; // BT-2, ISO 8601 date
  currency: string; // BT-5, ISO 4217
  /**
   * BT-3, UNTDID 1001 invoice type code. Defaults to "380" (commercial invoice).
   * BR-DE-17 restricts XRechnung to 326/380/381/384/389/875/876/877.
   */
  invoiceTypeCode?: string;
  /** BT-9 payment due date, ISO 8601. */
  dueDate?: string;
  /** BT-22 free-text note on the invoice. */
  note?: string;
  /**
   * BT-21 invoice note subject code, from UNCL 4451.
   *
   * UBL has no element for it: the code is written into the note itself as
   * `#CODE#text`, which is why it lives beside `note` rather than inside a
   * group. Only meaningful when `note` is also present.
   */
  noteSubjectCode?: string;
  /** BT-10. Required by BR-DE-15 for German public-sector buyers (Leitweg-ID). */
  buyerReference?: string;
  /** BT-13 purchase order reference. */
  orderReference?: string;
  /** BT-14 sales order reference — your own order number, not the buyer's. */
  salesOrderReference?: string;
  /** BT-11 project reference. */
  projectReference?: string;
  /** BT-12 contract reference. */
  contractReference?: string;
  /** BT-16 despatch advice reference. */
  despatchAdviceReference?: string;
  /** BT-15 receiving advice reference. */
  receivingAdviceReference?: string;
  /** BT-17 tender or lot reference. */
  tenderOrLotReference?: string;
  /**
   * BT-18 invoiced object identifier, with its BT-18-1 scheme identifier.
   *
   * The thing the invoice is *about* when that is not an order — a contract
   * number, a meter, a vehicle, a case file. The scheme comes from UNTDID 1153
   * and is what makes the bare identifier resolvable.
   */
  invoicedObjectIdentifier?: { value: string; schemeId?: string };
  /** BT-19 buyer accounting reference — the buyer's cost centre or GL account. */
  buyerAccountingReference?: string;
  /**
   * BT-7 value added tax point date. Mutually exclusive with
   * `invoicingPeriod.descriptionCode` (BT-8) under BR-CO-03.
   */
  taxPointDate?: string;
  /** BG-14 invoicing period — the period the supply relates to. */
  invoicingPeriod?: InvoicingPeriod;
  /** BG-3 preceding invoice references. Required in substance by BR-DE-26 for BT-3 = 384. */
  precedingInvoices?: PrecedingInvoiceReference[];
  seller: Party;
  buyer: Party;
  /** BG-10 payee, when payment goes somewhere other than the seller. */
  payee?: Payee;
  /** BG-11 seller tax representative, for a seller registered through a fiscal representative. */
  taxRepresentative?: TaxRepresentative;
  lines: InvoiceLine[];
  /** BG-20 document level allowances (discounts applying to the whole invoice). */
  allowances?: DocumentAllowanceCharge[];
  /** BG-21 document level charges (freight, packing, surcharges). */
  charges?: DocumentAllowanceCharge[];
  paymentTerms?: string; // BT-20
  /** BG-16 payment instructions. Required for XRechnung by BR-DE-1. */
  payment?: PaymentInstructions;
  /** BG-24 additional supporting documents. */
  supportingDocuments?: SupportingDocument[];
  /** BT-72 actual delivery date, ISO 8601. Required with BT-80 by BR-IC-11 for category K. */
  deliveryDate?: string;
  /**
   * BG-15 deliver-to address. Emitting this group at all obliges you to fill it
   * in: XRechnung's BR-DE-10 and BR-DE-11 make city (BT-77) and post code
   * (BT-78) mandatory whenever BG-15 is present, even though core EN 16931 only
   * requires the country code (BT-80).
   */
  deliverTo?: DeliverToAddress;
  /** BT-70 deliver-to party name. */
  deliverToName?: string;
  /** BT-71 deliver-to location identifier, with its ISO 6523 ICD scheme. */
  deliverToLocationId?: { value: string; schemeId?: string };
  /**
   * BT-6 VAT accounting currency, when VAT must be reported in a currency other
   * than the invoice currency (BT-5). Supplying it obliges you to supply
   * `taxAmountInAccountingCurrency` too (BR-53).
   */
  vatAccountingCurrency?: string;
  /**
   * BT-111 invoice total VAT amount in the VAT accounting currency.
   *
   * Not derivable: it depends on the exchange rate the tax authority requires
   * for the tax point, which is not on the invoice. You supply it.
   */
  taxAmountInAccountingCurrency?: number;
  /** BT-113 paid amount — a prepayment or deposit already received. */
  paidAmount?: number;
  /** BT-114 rounding amount added to the total to produce a payable round figure. */
  roundingAmount?: number;
  /**
   * BT-120 VAT exemption reason text, per VAT category. Sensible defaults are applied
   * for AE/K/G/O; category E has no standard text, so the caller must supply one
   * (BR-E-10).
   */
  vatExemptionReasons?: Partial<Record<VatCategory, string>>;
  /** BT-121 VAT exemption reason code (CEF VATEX list), per VAT category. */
  vatExemptionReasonCodes?: Partial<Record<VatCategory, string>>;
  /**
   * Optional caller-declared totals. When present they are checked against the
   * computed values under BR-CO-10/11/12/13/14/15/16. Generation always emits
   * the computed values — these exist so you can catch a mismatch in your own
   * accounting system before it reaches a tax authority.
   */
  declaredTotals?: DeclaredTotals;
}

/** A postal address (BG-5 seller, BG-8 buyer, BG-12 tax representative). */
export interface PostalAddress {
  line1?: string; // BT-35 / BT-50 / BT-64
  line2?: string; // BT-36 / BT-51 / BT-65
  /** BT-162 / BT-163 / BT-164 third address line. */
  line3?: string;
  city: string; // BT-37 / BT-52 / BT-66
  postalCode: string; // BT-38 / BT-53 / BT-67
  /** BT-39 / BT-54 / BT-68 country subdivision (Bundesland, région, …). */
  countrySubdivision?: string;
  countryCode: string; // BT-40 / BT-55 / BT-69, ISO 3166-1 alpha-2
}

export interface DeliverToAddress {
  /** BT-75 deliver-to address line 1. */
  line1?: string;
  /** BT-76 deliver-to address line 2. */
  line2?: string;
  /** BT-77 deliver-to city. Mandatory under XRechnung once BG-15 is present. */
  city?: string;
  /** BT-78 deliver-to post code. Mandatory under XRechnung once BG-15 is present. */
  postalCode?: string;
  /** BT-79 deliver-to country subdivision. */
  countrySubdivision?: string;
  /** BT-80 deliver-to country code, ISO 3166-1 alpha-2. */
  countryCode: string;
}

/** BG-14 invoicing period, or BG-26 when it hangs off a line. */
export interface InvoicingPeriod {
  /** BT-73 / BT-134 period start date, ISO 8601. */
  startDate?: string;
  /** BT-74 / BT-135 period end date, ISO 8601. */
  endDate?: string;
  /**
   * BT-8 value added tax point date code (UNTDID 2005, restricted to 3, 35,
   * 432). Document level only, and mutually exclusive with BT-7 under
   * BR-CO-03. Ignored on a line period, which has no such term.
   */
  descriptionCode?: string;
}

/** BG-3 preceding invoice reference. */
export interface PrecedingInvoiceReference {
  /** BT-25 the number of the invoice being corrected or referenced. */
  invoiceNumber: string;
  /** BT-26 the issue date of that invoice, ISO 8601. */
  issueDate?: string;
}

/** BG-10 payee — where the money goes, when that is not the seller. */
export interface Payee {
  /** BT-59 payee name. Must differ from the seller name (BR-17). */
  name: string;
  /** BT-60 payee identifier, with its ISO 6523 ICD scheme. */
  identifier?: { value: string; schemeId?: string };
  /** BT-61 payee legal registration identifier, with its ISO 6523 ICD scheme. */
  legalRegistrationId?: { value: string; schemeId?: string };
}

/** BG-11 seller tax representative party. */
export interface TaxRepresentative {
  /** BT-62 tax representative name. */
  name: string;
  /** BT-63 tax representative VAT identifier. Mandatory once BG-11 exists (BR-56). */
  vatId: string;
  /** BG-12 tax representative postal address. Mandatory once BG-11 exists (BR-19). */
  address: PostalAddress;
}

/**
 * BG-20 document level allowance / BG-21 document level charge.
 *
 * One type for both, because in UBL they are one element (`cac:AllowanceCharge`)
 * distinguished by `cbc:ChargeIndicator`, and every rule on one has a mirror on
 * the other. Which array you put it in is what makes it an allowance or a
 * charge — the reason code lists differ (UNCL 5189 vs UNCL 7161), so an
 * allowance reason code in the charges array fails BR-CL-20.
 */
export interface DocumentAllowanceCharge {
  /** BT-92 allowance amount / BT-99 charge amount. Always positive. */
  amount: number;
  /** BT-93 allowance base amount / BT-100 charge base amount. */
  baseAmount?: number;
  /** BT-94 allowance percentage / BT-101 charge percentage. */
  percentage?: number;
  /** BT-95 allowance VAT category / BT-102 charge VAT category. */
  vatCategory: VatCategory;
  /** BT-96 allowance VAT rate / BT-103 charge VAT rate, percent. */
  vatRate?: number;
  /** BT-97 allowance reason / BT-104 charge reason, free text. */
  reason?: string;
  /** BT-98 allowance reason code (UNCL 5189) / BT-105 charge reason code (UNCL 7161). */
  reasonCode?: string;
}

/**
 * BG-27 invoice line allowance / BG-28 invoice line charge.
 *
 * No VAT category of its own: a line allowance inherits the VAT treatment of
 * the line it sits on, which is why it changes BT-131 rather than appearing in
 * the VAT breakdown on its own account.
 */
export interface LineAllowanceCharge {
  /** BT-136 line allowance amount / BT-141 line charge amount. Always positive. */
  amount: number;
  /** BT-137 line allowance base amount / BT-142 line charge base amount. */
  baseAmount?: number;
  /** BT-138 line allowance percentage / BT-143 line charge percentage. */
  percentage?: number;
  /** BT-139 line allowance reason / BT-144 line charge reason, free text. */
  reason?: string;
  /** BT-140 line allowance reason code (UNCL 5189) / BT-145 line charge reason code (UNCL 7161). */
  reasonCode?: string;
}

/** BG-24 additional supporting document. */
export interface SupportingDocument {
  /** BT-122 supporting document reference. */
  reference: string;
  /** BT-123 supporting document description. */
  description?: string;
  /** BT-124 external document location (a URL). */
  externalUri?: string;
  /** BT-125 the document itself, embedded. */
  attachment?: EmbeddedAttachment;
}

export interface EmbeddedAttachment {
  /** BT-125-2 attached document filename. Must be unique across the invoice (BR-DE-22). */
  filename: string;
  /**
   * BT-125-1 attached document mime code. BR-CL-24 admits only
   * application/pdf, image/png, image/jpeg, text/csv,
   * application/vnd.openxmlformats-officedocument.spreadsheetml.sheet and
   * application/vnd.oasis.opendocument.spreadsheet.
   */
  mimeCode: string;
  /** The document bytes, base64-encoded. Emitted verbatim; not re-encoded. */
  content: string;
}

export interface DeclaredTotals {
  /** BT-106 sum of invoice line net amounts. */
  lineExtensionAmount?: number;
  /** BT-107 sum of allowances on document level. */
  allowanceTotalAmount?: number;
  /** BT-108 sum of charges on document level. */
  chargeTotalAmount?: number;
  /** BT-109 invoice total amount without VAT. */
  taxExclusiveAmount?: number;
  /** BT-110 invoice total VAT amount. */
  taxAmount?: number;
  /** BT-112 invoice total amount with VAT. */
  taxInclusiveAmount?: number;
  /** BT-115 amount due for payment. */
  payableAmount?: number;
}

export interface PaymentInstructions {
  /** BT-81 UNTDID 4461 payment means code, e.g. "58" (SEPA credit transfer). */
  meansCode: string;
  /** BT-82 payment means text. */
  meansName?: string;
  /** BT-84 payment account identifier (IBAN for credit transfer). BG-17. */
  iban?: string;
  /** BT-85 payment account name. BG-17. */
  accountName?: string;
  /** BT-86 payment service provider identifier (BIC). BG-17. */
  bic?: string;
  /** BT-83 remittance information / payment reference. */
  remittanceInformation?: string;
  /** BG-18 payment card information. Obliged by BT-81 = 48, 54 or 55. */
  card?: PaymentCard;
  /** BG-19 direct debit information. Obliged by BT-81 = 59. */
  directDebit?: DirectDebit;
}

/** BG-18 payment card information. */
export interface PaymentCard {
  /**
   * BT-87 payment card primary account number.
   *
   * BR-51 caps this at ten characters: the PCI Security Standards Council
   * permits the first six and last four digits and nothing more. Never put a
   * full PAN on an invoice.
   */
  primaryAccountNumber: string;
  /** BT-88 payment card holder name. */
  holderName?: string;
}

/** BG-19 direct debit information. */
export interface DirectDebit {
  /** BT-89 mandate reference identifier. */
  mandateReference?: string;
  /**
   * BT-90 bank assigned creditor identifier (the SEPA Gläubiger-ID).
   *
   * Emitted as the seller's `cac:PartyIdentification/cbc:ID` with
   * `schemeID="SEPA"`, which is where EN 16931's UBL binding puts it and where
   * BR-DE-30 looks for it.
   */
  creditorIdentifier?: string;
  /** BT-91 debited account identifier (the payer's IBAN). Required by BR-DE-31. */
  debitedAccount?: string;
}

export interface Party {
  name: string; // BT-27 / BT-44
  vatId?: string; // BT-31 / BT-48
  /** BT-32 seller tax registration identifier (e.g. German Steuernummer). */
  taxRegistrationId?: string;
  /** BT-30 / BT-47 legal registration identifier (e.g. HRB number). */
  legalRegistrationId?: string;
  /** BT-30-1 / BT-47-1 ISO 6523 ICD scheme for the legal registration identifier. */
  legalRegistrationSchemeId?: string;
  /**
   * BT-29 seller identifier / BT-46 buyer identifier, with its BT-29-1 /
   * BT-46-1 ISO 6523 ICD scheme. A machine-resolvable handle for the party —
   * a GLN, a DUNS number, a national organisation number.
   */
  identifier?: { value: string; schemeId?: string };
  /** BT-33 seller additional legal information (Rechtsform, share capital, …). */
  additionalLegalInformation?: string;
  /** BT-28 / BT-45 trading name, when the party trades under a name other than its legal one. */
  tradingName?: string;
  /** BT-27 / BT-44 registered legal name, when it differs from the trading name. */
  legalName?: string;
  address: PostalAddress;
  /** BT-34/BT-49 electronic address (Peppol participant ID) with scheme. */
  electronicAddress?: { schemeId: string; value: string };
  /** BG-6 / BG-9 contact. BR-DE-2/5/6/7 make all three seller fields mandatory. */
  contact?: {
    /** BT-41 / BT-56 contact point name. */
    name?: string;
    email?: string; // BT-43 / BT-58
    phone?: string; // BT-42 / BT-57
  };
}

export interface InvoiceLine {
  id: string; // BT-126
  description: string; // BT-153/154
  /** BT-154 item description, when it should differ from the item name (BT-153). */
  longDescription?: string;
  quantity: number; // BT-129
  unitCode: string; // BT-130, UN/ECE rec 20
  unitPrice: number; // BT-146
  /** BT-148 item gross price, before the BT-147 price discount. */
  grossUnitPrice?: number;
  /** BT-147 item price discount — the difference between BT-148 and BT-146. */
  priceDiscount?: number;
  /** BT-149 item price base quantity. Defaults to 1. */
  baseQuantity?: number;
  vatCategory: VatCategory; // BT-151
  vatRate?: number; // BT-152, percent
  /** BT-127 line note. */
  note?: string;
  /** BT-128 line object identifier, with its BT-128-1 UNTDID 1153 scheme. */
  objectIdentifier?: { value: string; schemeId?: string };
  /** BT-133 line buyer accounting reference. */
  buyerAccountingReference?: string;
  /** BG-26 invoice line period. */
  period?: InvoicingPeriod;
  /** BT-132 referenced purchase order line reference. */
  orderLineReference?: string;
  /** BG-27 line allowances — discounts on this line only. */
  allowances?: LineAllowanceCharge[];
  /** BG-28 line charges — surcharges on this line only. */
  charges?: LineAllowanceCharge[];
  /** BT-155 item seller's identifier. */
  sellerItemId?: string;
  /** BT-156 item buyer's identifier. */
  buyerItemId?: string;
  /** BT-157 item standard identifier (GTIN and friends), with its BT-157-1 ISO 6523 ICD scheme. */
  standardItemId?: { value: string; schemeId?: string };
  /**
   * BT-158 item classification identifiers, each with its BT-158-1 UNTDID 7143
   * scheme and optional BT-158-2 version.
   */
  itemClassifications?: ItemClassification[];
  /** BT-159 item country of origin, ISO 3166-1 alpha-2. */
  originCountryCode?: string;
  /** BG-32 item attributes — name/value pairs describing the item. */
  itemAttributes?: ItemAttribute[];
}

/** BT-158 item classification identifier. */
export interface ItemClassification {
  /** BT-158 the classification code itself. */
  code: string;
  /** BT-158-1 the scheme it is drawn from (UNTDID 7143), e.g. "TST" or "SRV". */
  schemeId: string;
  /** BT-158-2 the version of that scheme. */
  schemeVersion?: string;
}

/** BG-32 item attribute. Both halves are mandatory once the group exists (BR-54). */
export interface ItemAttribute {
  /** BT-160 item attribute name. */
  name: string;
  /** BT-161 item attribute value. */
  value: string;
}

/**
 * UNCL5305 subset used by EN 16931 (BT-151).
 *
 * Nine of the ten codes BR-CL-17 admits. The missing one is `B` (split
 * payment): see the deferral note in the changelog — it has only two rules of
 * its own (BR-B-01, BR-B-02) and none of the `-01`/`-05`/`-08`/`-09`/`-10`
 * family every other category has, so expressing it would mean either emitting
 * rule ids the regulation does not define or carving it out of every
 * per-category loop for the sake of two checks.
 *
 * `L` and `M` are the regional Spanish categories, and they behave exactly like
 * `S`: a real, positive rate, a repeatable breakdown group, no exemption
 * reason. What differs is the tax they name — IGIC in the Canary Islands and
 * IPSI in Ceuta and Melilla are not VAT, they are separate indirect taxes that
 * apply *because* those territories sit outside the EU VAT area. An invoice
 * that uses `S` for a Canarian supply claims to have charged VAT that does not
 * exist there.
 */
export type VatCategory =
  | "S" // standard rate
  | "Z" // zero-rated
  | "E" // exempt
  | "AE" // reverse charge
  | "K" // intra-community supply
  | "G" // export outside EU
  | "O" // not subject to VAT
  | "L" // IGIC, Canary Islands (BR-AF-* family)
  | "M"; // IPSI, Ceuta and Melilla (BR-AG-* family)

/** One VAT breakdown group (BG-23) as computed from the lines. */
export interface TaxSubtotal {
  category: VatCategory; // BT-118
  /** BT-119. Absent for category O, which must not carry a rate (BR-O-05). */
  rate?: number;
  taxableAmount: number; // BT-116
  taxAmount: number; // BT-117
  /** BT-120 exemption reason text, for the categories that require one. */
  exemptionReason?: string;
  /** BT-121 exemption reason code (CEF VATEX list). */
  exemptionReasonCode?: string;
}

/** Computed document totals (BG-22), all rounded to 2 decimals. */
export interface InvoiceTotals {
  /** Per-line net amounts (BT-131) in line order, each rounded to 2 decimals. */
  lineNetAmounts: number[];
  lineExtensionAmount: number; // BT-106
  /** BT-107 sum of document level allowance amounts. Zero when there are none. */
  allowanceTotalAmount: number;
  /** BT-108 sum of document level charge amounts. Zero when there are none. */
  chargeTotalAmount: number;
  taxExclusiveAmount: number; // BT-109
  taxAmount: number; // BT-110
  taxInclusiveAmount: number; // BT-112
  /** BT-113 paid amount, echoed from the input (0 when absent). */
  paidAmount: number;
  /** BT-114 rounding amount, echoed from the input (0 when absent). */
  roundingAmount: number;
  payableAmount: number; // BT-115
  subtotals: TaxSubtotal[]; // BG-23
}
