/**
 * Core type model. Design goal: every validation failure is a teaching error —
 * enough context that a developer (or an AI agent reading the same payload)
 * can fix the invoice without opening the EN 16931 spec.
 */

/** Business Term identifier from EN 16931, e.g. "BT-10" (buyer reference). */
export type BusinessTerm = `BT-${number}` | `BG-${number}`;

/** Rule identifier: EN 16931 core (BR-*), German CIUS (BR-DE-*), Peppol (PEPPOL-EN16931-R*). */
export type RuleId = string;

export type Severity = "fatal" | "warning";

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
}

/** Target output profiles, narrowest first. */
export type Profile =
  | "en16931" // core
  | "xrechnung-ubl"
  | "xrechnung-cii"
  | "facturx-en16931"
  | "peppol-bis-3";

/** Simplified invoice input model (JSON in → compliant XML out). Grows toward full BT coverage. */
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
  /** BT-10. Required by BR-DE-15 for German public-sector buyers (Leitweg-ID). */
  buyerReference?: string;
  /** BT-13 purchase order reference. */
  orderReference?: string;
  seller: Party;
  buyer: Party;
  lines: InvoiceLine[];
  paymentTerms?: string; // BT-20
  /** BG-16 payment instructions. Required for XRechnung by BR-DE-1. */
  payment?: PaymentInstructions;
  /** BT-72 actual delivery date, ISO 8601. Required with BT-80 by BR-IC-11 for category K. */
  deliveryDate?: string;
  /**
   * BG-15 deliver-to address. Emitting this group at all obliges you to fill it
   * in: XRechnung's BR-DE-10 and BR-DE-11 make city (BT-77) and post code
   * (BT-78) mandatory whenever BG-15 is present, even though core EN 16931 only
   * requires the country code (BT-80).
   */
  deliverTo?: DeliverToAddress;
  /**
   * BT-120 VAT exemption reason text, per VAT category. Sensible defaults are applied
   * for AE/K/G/O; category E has no standard text, so the caller must supply one
   * (BR-E-10).
   */
  vatExemptionReasons?: Partial<Record<VatCategory, string>>;
  /**
   * Optional caller-declared totals. When present they are checked against the
   * computed values under BR-CO-10/13/14/15. Generation always emits the
   * computed values — these exist so you can catch a mismatch in your own
   * accounting system before it reaches a tax authority.
   */
  declaredTotals?: DeclaredTotals;
}

export interface DeliverToAddress {
  /** BT-75 deliver-to address line 1. */
  line1?: string;
  /** BT-77 deliver-to city. Mandatory under XRechnung once BG-15 is present. */
  city?: string;
  /** BT-78 deliver-to post code. Mandatory under XRechnung once BG-15 is present. */
  postalCode?: string;
  /** BT-80 deliver-to country code, ISO 3166-1 alpha-2. */
  countryCode: string;
}

export interface DeclaredTotals {
  /** BT-106 sum of invoice line net amounts. */
  lineExtensionAmount?: number;
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
  /** BT-84 payment account identifier (IBAN for credit transfer). */
  iban?: string;
  /** BT-85 payment account name. */
  accountName?: string;
  /** BT-86 payment service provider identifier (BIC). */
  bic?: string;
  /** BT-83 remittance information / payment reference. */
  remittanceInformation?: string;
}

export interface Party {
  name: string; // BT-27 / BT-44
  vatId?: string; // BT-31 / BT-48
  /** BT-32 seller tax registration identifier (e.g. German Steuernummer). */
  taxRegistrationId?: string;
  /** BT-30 / BT-47 legal registration identifier (e.g. HRB number). */
  legalRegistrationId?: string;
  /** BT-27 / BT-44 registered legal name, when it differs from the trading name. */
  legalName?: string;
  address: {
    line1?: string; // BT-35 / BT-50
    line2?: string; // BT-36 / BT-51
    city: string; // BT-37 / BT-52
    postalCode: string; // BT-38 / BT-53
    /** BT-39 / BT-54 country subdivision (Bundesland, région, …). */
    countrySubdivision?: string;
    countryCode: string; // BT-40 / BT-55, ISO 3166-1 alpha-2
  };
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
  /** BT-149 item price base quantity. Defaults to 1. */
  baseQuantity?: number;
  vatCategory: VatCategory; // BT-151
  vatRate?: number; // BT-152, percent
  /** BT-127 line note. */
  note?: string;
}

/** UNCL5305 subset used by EN 16931 (BT-151). */
export type VatCategory =
  | "S" // standard rate
  | "Z" // zero-rated
  | "E" // exempt
  | "AE" // reverse charge
  | "K" // intra-community supply
  | "G" // export outside EU
  | "O"; // not subject to VAT

/** One VAT breakdown group (BG-23) as computed from the lines. */
export interface TaxSubtotal {
  category: VatCategory; // BT-118
  /** BT-119. Absent for category O, which must not carry a rate (BR-O-05). */
  rate?: number;
  taxableAmount: number; // BT-116
  taxAmount: number; // BT-117
  /** BT-120 exemption reason text, for the categories that require one. */
  exemptionReason?: string;
}

/** Computed document totals (BG-22), all rounded to 2 decimals. */
export interface InvoiceTotals {
  /** Per-line net amounts (BT-131) in line order, each rounded to 2 decimals. */
  lineNetAmounts: number[];
  lineExtensionAmount: number; // BT-106
  taxExclusiveAmount: number; // BT-109
  taxAmount: number; // BT-110
  taxInclusiveAmount: number; // BT-112
  payableAmount: number; // BT-115
  subtotals: TaxSubtotal[]; // BG-23
}
