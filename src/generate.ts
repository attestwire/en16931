import { computeTotals, formatAmount, formatNumber } from "./totals.js";
import { document, el, group, groupAlways, type XmlNode } from "./xml.js";
import type { InvoiceInput, InvoiceTotals, Party, Profile } from "./types.js";

/**
 * JSON → XRechnung UBL 2.1 Invoice.
 *
 * UBL uses an `xsd:sequence` content model, so the order of children is part of
 * schema validity. Every builder below emits children in schema order; do not
 * reorder them to make a diff read better.
 */

const NS = {
  inv: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
} as const;

/** BT-24 Specification identifier, per profile. */
export const CUSTOMIZATION_IDS: Record<Profile, string> = {
  "xrechnung-ubl":
    "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0",
  "xrechnung-cii":
    "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0",
  "peppol-bis-3": "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0",
  en16931: "urn:cen.eu:en16931:2017",
  "facturx-en16931": "urn:cen.eu:en16931:2017",
};

/** BT-23 Business process type. */
export const PROFILE_IDS: Record<Profile, string> = {
  "xrechnung-ubl": "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
  "xrechnung-cii": "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
  "peppol-bis-3": "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
  en16931: "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
  "facturx-en16931": "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
};

/** Default BT-3 invoice type code: 380 = commercial invoice (UNTDID 1001). */
export const DEFAULT_INVOICE_TYPE_CODE = "380";

export interface GenerateOptions {
  /** Indentation string. Pass "" for a compact single-line-per-element document. */
  indent?: string;
  /** Override the BT-24 specification identifier (e.g. to pin XRechnung 2.3). */
  customizationId?: string;
  /** Override the BT-23 business process identifier. */
  profileId?: string;
}

/** cac:PostalAddress — schema order: street, additional street, city, zone, subentity, country. */
function postalAddress(party: Party): XmlNode {
  const a = party.address;
  return groupAlways("cac:PostalAddress", [
    el("cbc:StreetName", a.line1),
    el("cbc:AdditionalStreetName", a.line2),
    el("cbc:CityName", a.city),
    el("cbc:PostalZone", a.postalCode),
    el("cbc:CountrySubentity", a.countrySubdivision),
    group("cac:Country", [
      el("cbc:IdentificationCode", a.countryCode?.toUpperCase()),
    ]),
  ]);
}

/**
 * cac:Party — schema order: EndpointID, PartyIdentification, PartyName,
 * PostalAddress, PartyTaxScheme, PartyLegalEntity, Contact.
 *
 * Note the two distinct PartyTaxScheme entries: BT-31 (VAT identifier) carries
 * TaxScheme/ID "VAT", while BT-32 (national tax registration) carries the
 * scheme "FC". Collapsing them into one is a common source of BR-DE-16 noise.
 */
function partyNode(party: Party): XmlNode {
  const endpoint = party.electronicAddress
    ? el("cbc:EndpointID", party.electronicAddress.value, {
        schemeID: party.electronicAddress.schemeId,
      })
    : null;

  const contact = party.contact
    ? group("cac:Contact", [
        el("cbc:Name", party.contact.name),
        el("cbc:Telephone", party.contact.phone),
        el("cbc:ElectronicMail", party.contact.email),
      ])
    : null;

  return groupAlways("cac:Party", [
    endpoint,
    group("cac:PartyName", [el("cbc:Name", party.name)]),
    postalAddress(party),
    party.vatId
      ? group("cac:PartyTaxScheme", [
          el("cbc:CompanyID", party.vatId),
          group("cac:TaxScheme", [el("cbc:ID", "VAT")]),
        ])
      : null,
    party.taxRegistrationId
      ? group("cac:PartyTaxScheme", [
          el("cbc:CompanyID", party.taxRegistrationId),
          group("cac:TaxScheme", [el("cbc:ID", "FC")]),
        ])
      : null,
    groupAlways("cac:PartyLegalEntity", [
      el("cbc:RegistrationName", party.legalName ?? party.name),
      el("cbc:CompanyID", party.legalRegistrationId),
    ]),
    contact,
  ]);
}

/** cac:TaxTotal with one cac:TaxSubtotal per BG-23 breakdown group. */
function taxTotalNode(totals: InvoiceTotals, currency: string): XmlNode {
  const subtotals = totals.subtotals.map((sub) =>
    groupAlways("cac:TaxSubtotal", [
      el("cbc:TaxableAmount", formatAmount(sub.taxableAmount), {
        currencyID: currency,
      }),
      el("cbc:TaxAmount", formatAmount(sub.taxAmount), {
        currencyID: currency,
      }),
      groupAlways("cac:TaxCategory", [
        el("cbc:ID", sub.category),
        // BR-O-05: category O carries no rate at all.
        sub.rate === undefined
          ? null
          : el("cbc:Percent", formatNumber(sub.rate)),
        // BR-S-10 / BR-Z-10 forbid a reason here; totals.ts already suppresses it.
        el("cbc:TaxExemptionReason", sub.exemptionReason),
        group("cac:TaxScheme", [el("cbc:ID", "VAT")]),
      ]),
    ]),
  );

  return groupAlways("cac:TaxTotal", [
    el("cbc:TaxAmount", formatAmount(totals.taxAmount), {
      currencyID: currency,
    }),
    ...subtotals,
  ]);
}

/**
 * Generate an XRechnung 3.0 UBL 2.1 Invoice document.
 *
 * Totals are always computed from the lines — the function never echoes
 * caller-supplied totals into the XML, so a BR-CO arithmetic rejection cannot
 * originate here. Use `validateInput` first if you want to know whether your
 * own accounting figures agree with ours (BR-CO-10/13/14/15).
 */
export function generateXRechnungUBL(
  inv: InvoiceInput,
  options: GenerateOptions = {},
): string {
  const totals = computeTotals(inv);
  const currency = (inv.currency || "EUR").toUpperCase();
  const indent = options.indent ?? "  ";

  const customizationId =
    options.customizationId ??
    CUSTOMIZATION_IDS[inv.profile] ??
    CUSTOMIZATION_IDS["xrechnung-ubl"];
  const profileId =
    options.profileId ?? PROFILE_IDS[inv.profile] ?? PROFILE_IDS["xrechnung-ubl"];

  const lines = inv.lines.map((line, index) => {
    const net = totals.lineNetAmounts[index] ?? 0;
    const rate = line.vatCategory === "O" ? undefined : (line.vatRate ?? 0);
    const zeroRated = ["Z", "E", "AE", "K", "G"].includes(line.vatCategory);

    return groupAlways("cac:InvoiceLine", [
      el("cbc:ID", line.id),
      el("cbc:Note", line.note),
      el("cbc:InvoicedQuantity", formatNumber(line.quantity, 4), {
        unitCode: line.unitCode,
      }),
      el("cbc:LineExtensionAmount", formatAmount(net), {
        currencyID: currency,
      }),
      groupAlways("cac:Item", [
        el("cbc:Description", line.longDescription),
        el("cbc:Name", line.description),
        groupAlways("cac:ClassifiedTaxCategory", [
          el("cbc:ID", line.vatCategory),
          rate === undefined
            ? null
            : el("cbc:Percent", formatNumber(zeroRated ? 0 : rate)),
          group("cac:TaxScheme", [el("cbc:ID", "VAT")]),
        ]),
      ]),
      groupAlways("cac:Price", [
        el("cbc:PriceAmount", formatAmount(line.unitPrice), {
          currencyID: currency,
        }),
        line.baseQuantity === undefined
          ? null
          : el("cbc:BaseQuantity", formatNumber(line.baseQuantity, 4), {
              unitCode: line.unitCode,
            }),
      ]),
    ]);
  });

  const paymentMeans = inv.payment
    ? groupAlways("cac:PaymentMeans", [
        el("cbc:PaymentMeansCode", inv.payment.meansCode, {
          name: inv.payment.meansName,
        }),
        el("cbc:PaymentID", inv.payment.remittanceInformation),
        inv.payment.iban
          ? groupAlways("cac:PayeeFinancialAccount", [
              el("cbc:ID", inv.payment.iban),
              el("cbc:Name", inv.payment.accountName),
              inv.payment.bic
                ? group("cac:FinancialInstitutionBranch", [
                    el("cbc:ID", inv.payment.bic),
                  ])
                : null,
            ])
          : null,
      ])
    : null;

  // BG-15 is all-or-nothing under XRechnung (BR-DE-10 / BR-DE-11), so the
  // address carries city and post code alongside the country when supplied.
  const deliverTo = inv.deliverTo;
  const delivery =
    inv.deliveryDate || deliverTo
      ? groupAlways("cac:Delivery", [
          el("cbc:ActualDeliveryDate", inv.deliveryDate),
          deliverTo
            ? group("cac:DeliveryLocation", [
                group("cac:Address", [
                  el("cbc:StreetName", deliverTo.line1),
                  el("cbc:CityName", deliverTo.city),
                  el("cbc:PostalZone", deliverTo.postalCode),
                  group("cac:Country", [
                    el(
                      "cbc:IdentificationCode",
                      deliverTo.countryCode?.toUpperCase(),
                    ),
                  ]),
                ]),
              ])
            : null,
        ])
      : null;

  // Root children in UBL Invoice sequence order.
  const root = groupAlways(
    "ubl:Invoice",
    [
      el("cbc:CustomizationID", customizationId),
      el("cbc:ProfileID", profileId),
      el("cbc:ID", inv.invoiceNumber),
      el("cbc:IssueDate", inv.issueDate),
      el("cbc:DueDate", inv.dueDate),
      el(
        "cbc:InvoiceTypeCode",
        inv.invoiceTypeCode ?? DEFAULT_INVOICE_TYPE_CODE,
      ),
      el("cbc:Note", inv.note),
      el("cbc:DocumentCurrencyCode", currency),
      el("cbc:BuyerReference", inv.buyerReference),
      inv.orderReference
        ? group("cac:OrderReference", [el("cbc:ID", inv.orderReference)])
        : null,
      groupAlways("cac:AccountingSupplierParty", [partyNode(inv.seller)]),
      groupAlways("cac:AccountingCustomerParty", [partyNode(inv.buyer)]),
      delivery,
      paymentMeans,
      inv.paymentTerms
        ? group("cac:PaymentTerms", [el("cbc:Note", inv.paymentTerms)])
        : null,
      taxTotalNode(totals, currency),
      groupAlways("cac:LegalMonetaryTotal", [
        el("cbc:LineExtensionAmount", formatAmount(totals.lineExtensionAmount), {
          currencyID: currency,
        }),
        el("cbc:TaxExclusiveAmount", formatAmount(totals.taxExclusiveAmount), {
          currencyID: currency,
        }),
        el("cbc:TaxInclusiveAmount", formatAmount(totals.taxInclusiveAmount), {
          currencyID: currency,
        }),
        el("cbc:PayableAmount", formatAmount(totals.payableAmount), {
          currencyID: currency,
        }),
      ]),
      ...lines,
    ],
    {
      "xmlns:ubl": NS.inv,
      "xmlns:cac": NS.cac,
      "xmlns:cbc": NS.cbc,
    },
  );

  return document(root, indent);
}
