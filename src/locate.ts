/**
 * Pointing a finding at the element in the caller's own file.
 *
 * The rules run over the input model, not over XML, so the `xpath` a rule
 * writes is where the element sits in the document THIS LIBRARY would
 * generate from that model: always UBL, always `ubl:`/`cac:`/`cbc:`, and with
 * `[n]` counted the way the generator counts. That is a good address for "where
 * does this go" and a poor one for "where is it in my file", in three ways:
 *
 *   1. A CII document has no `cac:` anything. Every UBL path on a Factur-X or
 *      XRechnung CII finding pointed at nothing, and the command line dropped
 *      them rather than print them wrong.
 *   2. The generator writes a document's allowances before its charges. A file
 *      that states a charge first has its allowance at `AllowanceCharge[2]`,
 *      and the rule, counting the model, says `[1]`.
 *   3. A path is not a line number, and an editor, a code review and a CI
 *      annotation all want a line number.
 *
 * So `locateFinding` walks the rule's path through the tree the caller's file
 * was parsed into (translating it to CII first where the file is CII) and
 * reports the element it lands on, with its line and column.
 *
 * WHEN IT CANNOT TELL, IT SAYS SO. A missing element has no line, so the
 * location falls back to the nearest ancestor that does exist, which is where
 * the missing element would go, and `exact` is false. The same happens when
 * the file holds several elements the path could mean and nothing says which:
 * several `cac:TaxSubtotal`s, which the rules count sometimes in the file's
 * order and sometimes in the order the engine computes them, or several
 * `cbc:Note`s under a path with no index. Pointing at the parent is less
 * useful than pointing at the right child, and much more useful than pointing
 * confidently at the wrong one.
 */

import { CII_NAMESPACES } from "./generate-cii.js";
import type { SourceLocation } from "./types.js";
import type { XmlElement } from "./xml-parse.js";

const UBL_NS: Record<string, string> = {
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
};
const INVOICE_NS = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";
const CREDIT_NOTE_NS = "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2";
const CII_NS: Record<string, string> = { ...CII_NAMESPACES };

/**
 * How to choose among several siblings with the name a step asks for.
 *
 * - `position`: the step's `[n]`, counted in the file. Right for the groups
 *   the readers keep in document order (lines, billing references, item
 *   properties, classifications).
 * - `allowance`: allowances first, then charges, each in file order, which is
 *   how the generator (and so every rule's `[n]`) counts them.
 * - `taxTotal`: UBL's first `cac:TaxTotal` is the one with the breakdown, the
 *   second is the tax-currency total. A file may state them either way round.
 * - `single`: only answerable when the file has exactly one.
 */
type Choose = "position" | "allowance" | "taxTotal" | "single";

interface Step {
  ns: string;
  local: string;
  /** Other names the same element goes by in this syntax. */
  or?: string[];
  index?: number;
  choose: Choose;
}

// ---------------------------------------------------------------------------
// UBL → CII
//
// One node per UBL element a rule path can pass through. `to` is the CII path
// relative to the parent node's CII element: "" stays where it is, a leading
// "/" starts again from the root, and ".." goes up one. `choose` applies to
// the last element of `to`, and the UBL step's `[n]` travels with it.
//
// Written by hand from generate.ts and generate-cii.ts, which emit the two
// syntaxes from one model; locate.test.ts checks every leaf here against the
// committed fixture pairs, which are the same invoices in both syntaxes.
// ---------------------------------------------------------------------------

interface Node {
  to: string;
  choose?: Choose;
  /** Other names for the last element of `to` (CII writes a scheme identifier as GlobalID). */
  or?: string[];
  /** The UBL step's index belongs to the next node down, not this one. */
  carry?: boolean;
  kids?: Record<string, Node>;
}

const H = "/rsm:SupplyChainTradeTransaction";
const AGREEMENT = `${H}/ram:ApplicableHeaderTradeAgreement`;
const DELIVERY = `${H}/ram:ApplicableHeaderTradeDelivery`;
const SETTLEMENT = `${H}/ram:ApplicableHeaderTradeSettlement`;
const DUE_DATE = `${SETTLEMENT}/ram:SpecifiedTradePaymentTerms/ram:DueDateDateTime/udt:DateTimeString`;

const leaf = (to: string, choose?: Choose): Node => ({ to, choose });
/** An identifier CII writes as ram:ID, or as ram:GlobalID when it has a scheme. */
const ID_OR_GLOBAL: Node = { to: "ram:ID", choose: "single", or: ["GlobalID"] };

const ADDRESS: Record<string, Node> = {
  "cbc:StreetName": leaf("ram:LineOne"),
  "cbc:AdditionalStreetName": leaf("ram:LineTwo"),
  "cac:AddressLine": { to: "", kids: { "cbc:Line": leaf("ram:LineThree") } },
  "cbc:CityName": leaf("ram:CityName"),
  "cbc:PostalZone": leaf("ram:PostcodeCode"),
  "cbc:CountrySubentity": leaf("ram:CountrySubDivisionName"),
  "cac:Country": { to: "", kids: { "cbc:IdentificationCode": leaf("ram:CountryID") } },
};

/** The children of a UBL `cac:Party` (or a party that is its own `cac:Party`). */
const PARTY: Record<string, Node> = {
  "cbc:EndpointID": leaf("ram:URIUniversalCommunication/ram:URIID"),
  "cac:PartyIdentification": { to: "", kids: { "cbc:ID": ID_OR_GLOBAL } },
  // The generator writes the trading name here, falling back to the name, and
  // the rules that point here are about the name: CII keeps it in ram:Name.
  "cac:PartyName": { to: "", kids: { "cbc:Name": leaf("ram:Name") } },
  "cac:PostalAddress": { to: "ram:PostalTradeAddress", kids: ADDRESS },
  "cac:PartyTaxScheme": {
    to: "ram:SpecifiedTaxRegistration",
    choose: "single",
    kids: { "cbc:CompanyID": leaf("ram:ID") },
  },
  "cac:PartyLegalEntity": {
    to: "ram:SpecifiedLegalOrganization",
    kids: {
      "cbc:RegistrationName": leaf("../ram:Name"),
      "cbc:CompanyID": leaf("ram:ID"),
      "cbc:CompanyLegalForm": leaf("../ram:Description"),
    },
  },
  "cac:Contact": {
    to: "ram:DefinedTradeContact",
    kids: {
      "cbc:Name": leaf("ram:PersonName"),
      "cbc:Telephone": leaf("ram:TelephoneUniversalCommunication/ram:CompleteNumber"),
      "cbc:ElectronicMail": leaf("ram:EmailURIUniversalCommunication/ram:URIID"),
    },
  },
};

const ALLOWANCE_CHARGE: Record<string, Node> = {
  "cbc:ChargeIndicator": leaf("ram:ChargeIndicator/udt:Indicator"),
  "cbc:AllowanceChargeReasonCode": leaf("ram:ReasonCode"),
  "cbc:AllowanceChargeReason": leaf("ram:Reason"),
  "cbc:MultiplierFactorNumeric": leaf("ram:CalculationPercent"),
  "cbc:Amount": leaf("ram:ActualAmount"),
  "cbc:BaseAmount": leaf("ram:BasisAmount"),
  "cac:TaxCategory": {
    to: "ram:CategoryTradeTax",
    kids: { "cbc:ID": leaf("ram:CategoryCode"), "cbc:Percent": leaf("ram:RateApplicablePercent") },
  },
};

const PERIOD: Record<string, Node> = {
  "cbc:StartDate": leaf("ram:StartDateTime/udt:DateTimeString"),
  "cbc:EndDate": leaf("ram:EndDateTime/udt:DateTimeString"),
  // BT-8 is a code on the VAT breakdown in CII, not on the period.
  "cbc:DescriptionCode": leaf(`${SETTLEMENT}/ram:ApplicableTradeTax/ram:DueDateTypeCode`),
};

const LINE: Node = {
  to: `${H}/ram:IncludedSupplyChainTradeLineItem`,
  choose: "position",
  kids: {
    "cbc:ID": leaf("ram:AssociatedDocumentLineDocument/ram:LineID"),
    "cbc:Note": leaf("ram:AssociatedDocumentLineDocument/ram:IncludedNote/ram:Content"),
    "cbc:InvoicedQuantity": leaf("ram:SpecifiedLineTradeDelivery/ram:BilledQuantity"),
    "cbc:CreditedQuantity": leaf("ram:SpecifiedLineTradeDelivery/ram:BilledQuantity"),
    "cbc:LineExtensionAmount": leaf(
      "ram:SpecifiedLineTradeSettlement/ram:SpecifiedTradeSettlementLineMonetarySummation/ram:LineTotalAmount",
    ),
    "cbc:AccountingCost": leaf("ram:SpecifiedLineTradeSettlement/ram:ReceivableSpecifiedTradeAccountingAccount/ram:ID"),
    "cac:InvoicePeriod": { to: "ram:SpecifiedLineTradeSettlement/ram:BillingSpecifiedPeriod", kids: PERIOD },
    "cac:OrderLineReference": {
      to: "ram:SpecifiedLineTradeAgreement/ram:BuyerOrderReferencedDocument",
      kids: { "cbc:LineID": leaf("ram:LineID") },
    },
    "cac:DocumentReference": {
      to: "ram:SpecifiedLineTradeSettlement/ram:AdditionalReferencedDocument",
      kids: { "cbc:ID": leaf("ram:IssuerAssignedID") },
    },
    "cac:AllowanceCharge": {
      to: "ram:SpecifiedLineTradeSettlement/ram:SpecifiedTradeAllowanceCharge",
      choose: "allowance",
      kids: ALLOWANCE_CHARGE,
    },
    "cac:Item": {
      to: "ram:SpecifiedTradeProduct",
      kids: {
        "cbc:Name": leaf("ram:Name"),
        "cbc:Description": leaf("ram:Description"),
        "cac:SellersItemIdentification": { to: "", kids: { "cbc:ID": leaf("ram:SellerAssignedID") } },
        "cac:BuyersItemIdentification": { to: "", kids: { "cbc:ID": leaf("ram:BuyerAssignedID") } },
        "cac:StandardItemIdentification": { to: "", kids: { "cbc:ID": leaf("ram:GlobalID") } },
        "cac:OriginCountry": { to: "ram:OriginTradeCountry", kids: { "cbc:IdentificationCode": leaf("ram:ID") } },
        "cac:CommodityClassification": {
          to: "ram:DesignatedProductClassification",
          choose: "position",
          kids: { "cbc:ItemClassificationCode": leaf("ram:ClassCode") },
        },
        "cac:AdditionalItemProperty": {
          to: "ram:ApplicableProductCharacteristic",
          choose: "position",
          kids: { "cbc:Name": leaf("ram:Description"), "cbc:Value": leaf("ram:Value") },
        },
        "cac:ClassifiedTaxCategory": {
          to: "../ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax",
          kids: { "cbc:ID": leaf("ram:CategoryCode"), "cbc:Percent": leaf("ram:RateApplicablePercent") },
        },
      },
    },
    "cac:Price": {
      to: "ram:SpecifiedLineTradeAgreement/ram:NetPriceProductTradePrice",
      kids: {
        "cbc:PriceAmount": leaf("ram:ChargeAmount"),
        "cbc:BaseQuantity": leaf("ram:BasisQuantity"),
        // The price discount sits on the GROSS price in CII, and the gross
        // price itself (UBL's BaseAmount on it) is that element's ChargeAmount.
        "cac:AllowanceCharge": {
          to: "../ram:GrossPriceProductTradePrice/ram:AppliedTradeAllowanceCharge",
          kids: { "cbc:Amount": leaf("ram:ActualAmount"), "cbc:BaseAmount": leaf("../ram:ChargeAmount") },
        },
      },
    },
  },
};

const UBL_TO_CII: Record<string, Node> = {
  "cbc:CustomizationID": leaf("/rsm:ExchangedDocumentContext/ram:GuidelineSpecifiedDocumentContextParameter/ram:ID"),
  "cbc:ProfileID": leaf("/rsm:ExchangedDocumentContext/ram:BusinessProcessSpecifiedDocumentContextParameter/ram:ID"),
  "cbc:ID": leaf("/rsm:ExchangedDocument/ram:ID"),
  "cbc:IssueDate": leaf("/rsm:ExchangedDocument/ram:IssueDateTime/udt:DateTimeString"),
  "cbc:DueDate": leaf(DUE_DATE),
  "cbc:InvoiceTypeCode": leaf("/rsm:ExchangedDocument/ram:TypeCode"),
  "cbc:CreditNoteTypeCode": leaf("/rsm:ExchangedDocument/ram:TypeCode"),
  "cbc:Note": leaf("/rsm:ExchangedDocument/ram:IncludedNote", "position"),
  "cbc:TaxPointDate": leaf(`${SETTLEMENT}/ram:ApplicableTradeTax/ram:TaxPointDate/udt:DateString`),
  "cbc:DocumentCurrencyCode": leaf(`${SETTLEMENT}/ram:InvoiceCurrencyCode`),
  "cbc:TaxCurrencyCode": leaf(`${SETTLEMENT}/ram:TaxCurrencyCode`),
  "cbc:AccountingCost": leaf(`${SETTLEMENT}/ram:ReceivableSpecifiedTradeAccountingAccount/ram:ID`),
  "cbc:BuyerReference": leaf(`${AGREEMENT}/ram:BuyerReference`),
  "cac:InvoicePeriod": { to: `${SETTLEMENT}/ram:BillingSpecifiedPeriod`, kids: PERIOD },
  "cac:OrderReference": {
    to: "",
    kids: {
      "cbc:ID": leaf(`${AGREEMENT}/ram:BuyerOrderReferencedDocument/ram:IssuerAssignedID`),
      "cbc:SalesOrderID": leaf(`${AGREEMENT}/ram:SellerOrderReferencedDocument/ram:IssuerAssignedID`),
    },
  },
  "cac:BillingReference": {
    to: `${SETTLEMENT}/ram:InvoiceReferencedDocument`,
    choose: "position",
    kids: {
      "cac:InvoiceDocumentReference": {
        to: "",
        kids: {
          "cbc:ID": leaf("ram:IssuerAssignedID"),
          "cbc:IssueDate": leaf("ram:FormattedIssueDateTime/qdt:DateTimeString"),
        },
      },
    },
  },
  "cac:DespatchDocumentReference": {
    to: `${DELIVERY}/ram:DespatchAdviceReferencedDocument`,
    kids: { "cbc:ID": leaf("ram:IssuerAssignedID") },
  },
  "cac:ReceiptDocumentReference": {
    to: `${DELIVERY}/ram:ReceivingAdviceReferencedDocument`,
    kids: { "cbc:ID": leaf("ram:IssuerAssignedID") },
  },
  "cac:ContractDocumentReference": {
    to: `${AGREEMENT}/ram:ContractReferencedDocument`,
    kids: { "cbc:ID": leaf("ram:IssuerAssignedID") },
  },
  "cac:ProjectReference": { to: `${AGREEMENT}/ram:SpecifiedProcuringProject`, kids: { "cbc:ID": leaf("ram:ID") } },
  // UBL and CII both hold supporting documents, the invoiced object and the
  // tender reference in this one repeated group, and the two generators do
  // not order them alike, so a position only counts when there is just one.
  "cac:AdditionalDocumentReference": {
    to: `${AGREEMENT}/ram:AdditionalReferencedDocument`,
    choose: "single",
    kids: {
      "cbc:ID": leaf("ram:IssuerAssignedID"),
      "cac:Attachment": {
        to: "",
        kids: {
          "cbc:EmbeddedDocumentBinaryObject": leaf("ram:AttachmentBinaryObject"),
          "cac:ExternalReference": { to: "", kids: { "cbc:URI": leaf("ram:URIID") } },
        },
      },
    },
  },
  "cac:AccountingSupplierParty": {
    to: `${AGREEMENT}/ram:SellerTradeParty`,
    kids: { "cac:Party": { to: "", kids: PARTY } },
  },
  "cac:AccountingCustomerParty": {
    to: `${AGREEMENT}/ram:BuyerTradeParty`,
    kids: { "cac:Party": { to: "", kids: PARTY } },
  },
  "cac:PayeeParty": { to: `${SETTLEMENT}/ram:PayeeTradeParty`, kids: PARTY },
  "cac:TaxRepresentativeParty": { to: `${AGREEMENT}/ram:SellerTaxRepresentativeTradeParty`, kids: PARTY },
  "cac:Delivery": {
    to: DELIVERY,
    kids: {
      "cbc:ActualDeliveryDate": leaf("ram:ActualDeliverySupplyChainEvent/ram:OccurrenceDateTime/udt:DateTimeString"),
      "cac:DeliveryLocation": {
        to: "ram:ShipToTradeParty",
        kids: { "cbc:ID": ID_OR_GLOBAL, "cac:Address": { to: "ram:PostalTradeAddress", kids: ADDRESS } },
      },
      "cac:DeliveryParty": {
        to: "ram:ShipToTradeParty",
        kids: { "cac:PartyName": { to: "", kids: { "cbc:Name": leaf("ram:Name") } } },
      },
    },
  },
  "cac:PaymentMeans": {
    to: `${SETTLEMENT}/ram:SpecifiedTradeSettlementPaymentMeans`,
    choose: "position",
    kids: {
      "cbc:PaymentMeansCode": leaf("ram:TypeCode"),
      "cbc:PaymentID": leaf(`${SETTLEMENT}/ram:PaymentReference`),
      "cbc:PaymentDueDate": leaf(DUE_DATE),
      "cac:PayeeFinancialAccount": {
        to: "ram:PayeePartyCreditorFinancialAccount",
        kids: {
          "cbc:ID": leaf("ram:IBANID"),
          "cbc:Name": leaf("ram:AccountName"),
          "cac:FinancialInstitutionBranch": {
            to: "../ram:PayeeSpecifiedCreditorFinancialInstitution",
            kids: { "cbc:ID": leaf("ram:BICID") },
          },
        },
      },
      "cac:CardAccount": {
        to: "ram:ApplicableTradeSettlementFinancialCard",
        kids: { "cbc:PrimaryAccountNumberID": leaf("ram:ID"), "cbc:HolderName": leaf("ram:CardholderName") },
      },
      // A mandate is payment terms in CII, and the debited account is on the
      // payment means beside it.
      "cac:PaymentMandate": {
        to: `${SETTLEMENT}/ram:SpecifiedTradePaymentTerms`,
        kids: {
          "cbc:ID": leaf("ram:DirectDebitMandateID"),
          "cac:PayerFinancialAccount": {
            to: `${SETTLEMENT}/ram:SpecifiedTradeSettlementPaymentMeans/ram:PayerPartyDebtorFinancialAccount`,
            kids: { "cbc:ID": leaf("ram:IBANID") },
          },
        },
      },
    },
  },
  "cac:PaymentTerms": { to: `${SETTLEMENT}/ram:SpecifiedTradePaymentTerms`, kids: { "cbc:Note": leaf("ram:Description") } },
  "cac:AllowanceCharge": {
    to: `${SETTLEMENT}/ram:SpecifiedTradeAllowanceCharge`,
    choose: "allowance",
    kids: ALLOWANCE_CHARGE,
  },
  // UBL's TaxTotal[1]/TaxAmount and TaxTotal[2]/TaxAmount are CII's first and
  // second TaxTotalAmount; the breakdown under TaxTotal[1] is ApplicableTradeTax.
  "cac:TaxTotal": {
    to: SETTLEMENT,
    carry: true,
    kids: {
      "cbc:TaxAmount": leaf("ram:SpecifiedTradeSettlementHeaderMonetarySummation/ram:TaxTotalAmount", "position"),
      "cac:TaxSubtotal": {
        to: "ram:ApplicableTradeTax",
        choose: "single",
        kids: {
          "cbc:TaxableAmount": leaf("ram:BasisAmount"),
          "cbc:TaxAmount": leaf("ram:CalculatedAmount"),
          "cac:TaxCategory": {
            to: "",
            kids: {
              "cbc:ID": leaf("ram:CategoryCode"),
              "cbc:Percent": leaf("ram:RateApplicablePercent"),
              "cbc:TaxExemptionReason": leaf("ram:ExemptionReason"),
              "cbc:TaxExemptionReasonCode": leaf("ram:ExemptionReasonCode"),
            },
          },
        },
      },
    },
  },
  "cac:LegalMonetaryTotal": {
    to: `${SETTLEMENT}/ram:SpecifiedTradeSettlementHeaderMonetarySummation`,
    kids: {
      "cbc:LineExtensionAmount": leaf("ram:LineTotalAmount"),
      "cbc:TaxExclusiveAmount": leaf("ram:TaxBasisTotalAmount"),
      "cbc:TaxInclusiveAmount": leaf("ram:GrandTotalAmount"),
      "cbc:AllowanceTotalAmount": leaf("ram:AllowanceTotalAmount"),
      "cbc:ChargeTotalAmount": leaf("ram:ChargeTotalAmount"),
      "cbc:PrepaidAmount": leaf("ram:TotalPrepaidAmount"),
      "cbc:PayableRoundingAmount": leaf("ram:RoundingAmount"),
      "cbc:PayableAmount": leaf("ram:DuePayableAmount"),
    },
  },
  "cac:InvoiceLine": LINE,
  "cac:CreditNoteLine": LINE,
};

/** How each UBL group is counted when the file itself is UBL. */
const UBL_CHOOSE: Record<string, Choose> = {
  AllowanceCharge: "allowance",
  TaxTotal: "taxTotal",
  TaxSubtotal: "single",
  AdditionalDocumentReference: "single",
  PartyTaxScheme: "single",
  PartyIdentification: "single",
};

/** The credit-note spelling of an invoice element, and back. */
const CREDIT_NOTE_NAMES: Record<string, string> = {
  InvoiceLine: "CreditNoteLine",
  InvoicedQuantity: "CreditedQuantity",
  InvoiceTypeCode: "CreditNoteTypeCode",
};
const INVOICE_NAMES = Object.fromEntries(Object.entries(CREDIT_NOTE_NAMES).map(([a, b]) => [b, a]));

// ---------------------------------------------------------------------------

interface RawStep {
  prefix: string;
  local: string;
  index?: number;
}

/** `/ubl:Invoice/cac:X[2]/cbc:Y/@attr` → steps and the attribute. Null if it is not a plain path. */
function splitPath(xpath: string): { steps: RawStep[]; attribute?: string } | null {
  if (!xpath.startsWith("/")) return null;
  const parts = xpath.slice(1).split("/");
  let attribute: string | undefined;
  if (parts.at(-1)?.startsWith("@")) attribute = parts.pop()!.slice(1);
  const steps: RawStep[] = [];
  for (const part of parts) {
    const m = /^([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)(?:\[(\d+)\])?$/.exec(part);
    if (!m) return null;
    steps.push({ prefix: m[1]!, local: m[2]!, index: m[3] ? Number(m[3]) : undefined });
  }
  return steps.length > 0 ? { steps, attribute } : null;
}

/** A rule path, as steps through a UBL file. The root step is left out. */
function ublSteps(raw: RawStep[], root: XmlElement): Step[] | null {
  const creditNote = root.namespace === CREDIT_NOTE_NS;
  const out: Step[] = [];
  for (const step of raw.slice(1)) {
    const ns = UBL_NS[step.prefix];
    if (!ns) return null;
    const local = (creditNote ? CREDIT_NOTE_NAMES[step.local] : INVOICE_NAMES[step.local]) ?? step.local;
    out.push({ ns, local, index: step.index, choose: UBL_CHOOSE[step.local] ?? "position" });
  }
  return out;
}

/** A CII path written as text (`ram:X/udt:Y`), as steps. */
function ciiSegments(to: string): (Step | "..")[] {
  return to
    .split("/")
    .filter(Boolean)
    .map((part) => {
      if (part === "..") return "..";
      const [prefix, local] = part.split(":") as [string, string];
      return { ns: CII_NS[prefix]!, local, choose: "position" as Choose };
    });
}

/**
 * A rule's UBL path, translated to steps through a CII file.
 *
 * `complete` is false when the path runs past what the table knows; the steps
 * then stop at the last element it could translate.
 */
function ciiSteps(raw: RawStep[]): { steps: Step[]; complete: boolean } {
  let steps: Step[] = [];
  let kids: Record<string, Node> | undefined = UBL_TO_CII;
  let carried: number | undefined;
  for (const step of raw.slice(1)) {
    const node: Node | undefined = kids?.[`${step.prefix}:${step.local}`];
    if (!node) return { steps, complete: false };
    if (node.to.startsWith("/")) steps = [];
    const added: Step[] = [];
    for (const seg of ciiSegments(node.to)) {
      if (seg === "..") {
        if (added.length > 0) added.pop();
        else steps.pop();
      } else added.push(seg);
    }
    // A step that adds no CII element of its own (`to: ""`) cannot hold its
    // index, so the index goes down to the next one, as `carry` asks for
    // explicitly. Dropping it would make `PartyIdentification[2]/cbc:ID` read
    // as the only identifier, and point confidently at the first.
    const passes = node.carry || added.length === 0;
    const index = passes ? undefined : (step.index ?? carried);
    carried = passes ? (step.index ?? carried) : undefined;
    const last = added.at(-1);
    if (last) {
      last.choose = node.choose ?? "position";
      last.index = index;
      if (node.or) last.or = node.or;
    }
    steps.push(...added);
    kids = node.kids;
  }
  return { steps, complete: true };
}

/** Allowances then charges, per list of siblings; the list is the cached one above. */
const allowanceOrder = new WeakMap<XmlElement[], XmlElement[]>();

const isCharge = (el: XmlElement): boolean => {
  for (const child of el.children) {
    if (child.local !== "ChargeIndicator") continue;
    // UBL states it as text; CII wraps it in udt:Indicator.
    const text = child.children.length > 0 ? (child.children[0]?.text ?? "") : child.text;
    return text.trim().toLowerCase() === "true";
  }
  return false;
};

/**
 * An element's children grouped by expanded name, built once per element.
 *
 * Every finding walks from the root, and a document with a finding on each of
 * its N lines would otherwise filter the root's N children N times: measured
 * at 216 µs a finding on a 4,000-line invoice against 19 µs at 100 lines,
 * which is quadratic. A WeakMap keeps the index exactly as long as the tree.
 */
const byName = new WeakMap<XmlElement, Map<string, XmlElement[]>>();
function childrenNamed(parent: XmlElement, ns: string, local: string): XmlElement[] {
  let index = byName.get(parent);
  if (!index) {
    index = new Map();
    for (const c of parent.children) {
      const key = `${c.namespace} ${c.local}`;
      const list = index.get(key);
      if (list) list.push(c);
      else index.set(key, [c]);
    }
    byName.set(parent, index);
  }
  return index.get(`${ns} ${local}`) ?? [];
}

/** Pick the child a step names. Undefined when it is missing or cannot be told apart. */
function choose(parent: XmlElement, step: Step): XmlElement | undefined {
  let named = childrenNamed(parent, step.ns, step.local);
  if (step.or) {
    const also = step.or.flatMap((local) => childrenNamed(parent, step.ns, local));
    // Back in document order, which is what "the only one" and a position mean.
    if (also.length > 0) named = [...named, ...also].sort((a, b) => parent.children.indexOf(a) - parent.children.indexOf(b));
  }
  const n = step.index ?? 1;
  switch (step.choose) {
    case "allowance": {
      let ordered = allowanceOrder.get(named);
      if (!ordered) {
        ordered = [...named.filter((c) => !isCharge(c)), ...named.filter(isCharge)];
        allowanceOrder.set(named, ordered);
      }
      return ordered[n - 1];
    }
    case "taxTotal": {
      if (named.length <= 1) return n === 1 ? named[0] : undefined;
      const withBreakdown = named.filter((t) => t.children.some((c) => c.local === "TaxSubtotal"));
      const without = named.filter((t) => !withBreakdown.includes(t));
      if (withBreakdown.length !== 1 || without.length !== 1) return undefined;
      return n === 1 ? withBreakdown[0] : n === 2 ? without[0] : undefined;
    }
    case "single":
      return named.length === 1 && n === 1 ? named[0] : undefined;
    case "position":
      // An index the path does not give is only an answer when there is one.
      if (step.index === undefined && named.length > 1) return undefined;
      return named[n - 1];
  }
}

function walk(root: XmlElement, steps: Step[]): { el: XmlElement; exact: boolean } {
  let el = root;
  for (const step of steps) {
    const next = choose(el, step);
    if (!next) return { el, exact: false };
    el = next;
  }
  return { el, exact: true };
}

const at = (el: XmlElement, exact: boolean): SourceLocation => ({
  line: el.line,
  column: el.column,
  path: el.path,
  exact,
});

/**
 * Where a rule's path lands in a parsed document.
 *
 * `xpath` is the address to report: the element's path in the file as written
 * when it was found, otherwise the rule's own path in the file's syntax (the
 * place the element belongs), otherwise undefined for a CII file whose path
 * could not be translated, because a UBL path on a CII document points at
 * nothing and is worse than no path.
 */
export function locateFinding(
  xpath: string | undefined,
  root: XmlElement,
  syntax: "ubl" | "cii",
): { location: SourceLocation; xpath: string | undefined } {
  const parsed = xpath ? splitPath(xpath) : null;
  if (!parsed) return { location: at(root, false), xpath: syntax === "ubl" ? xpath : undefined };
  const suffix = parsed.attribute ? `/@${parsed.attribute}` : "";
  const first = parsed.steps[0]!;

  // A handful of rules already write a CII path; walk it as written.
  if (first.prefix === "rsm") {
    if (syntax !== "cii") return { location: at(root, false), xpath: undefined };
    const steps = parsed.steps.slice(1).map((s) => ({
      ns: CII_NS[s.prefix] ?? "",
      local: s.local,
      index: s.index,
      choose: "position" as Choose,
    }));
    const { el, exact } = walk(root, steps);
    return { location: at(el, exact), xpath: exact ? el.path + suffix : xpath };
  }

  if (syntax === "ubl") {
    const steps = ublSteps(parsed.steps, root);
    if (!steps) return { location: at(root, false), xpath };
    const { el, exact } = walk(root, steps);
    return { location: at(el, exact), xpath: exact ? el.path + suffix : xpath };
  }

  const { steps, complete } = ciiSteps(parsed.steps);
  const { el, exact } = walk(root, steps);
  const found = exact && complete;
  const written = complete
    ? `/rsm:CrossIndustryInvoice${steps.map((s) => `/${prefixOf(s.ns)}:${s.local}${s.index ? `[${s.index}]` : ""}`).join("")}${suffix}`
    : undefined;
  return { location: at(el, found), xpath: found ? el.path + suffix : written };
}

const prefixOf = (ns: string): string => Object.entries(CII_NS).find(([, uri]) => uri === ns)?.[0] ?? "ram";

/** @internal For the table's own test: whether a path translates in full. */
export const __ciiSteps = (xpath: string) => {
  const parsed = splitPath(xpath);
  return parsed ? ciiSteps(parsed.steps) : null;
};
