import { round2 } from "./totals.js";
import {
  ALLOWANCE_REASON_CODES,
  ALLOWANCE_REASON_CODES_SET,
  CHARGE_REASON_CODES,
  CHARGE_REASON_CODES_SET,
} from "./codelists/index.js";
import {
  ALL_CATEGORIES,
  CATEGORY_NAMES,
  CATEGORY_RULE_INFIX,
  DOCS,
  allowanceChargePath,
  allowanceChargesOf,
  blank,
  decimalPlaces,
  err,
  isXRechnung,
  linesOf,
  sellerTaxIdentified,
  totalsOutcomeOf,
  usesCategoryAnywhere,
} from "./rule-kit.js";
import type { RuleFn, TaggedAllowanceCharge } from "./rule-kit.js";
import type {
  BusinessTerm,
  InvoiceInput,
  LineAllowanceCharge,
  TeachingError,
  VatCategory,
} from "./types.js";

/**
 * The allowance and charge families: BG-20 / BG-21 at document level and
 * BG-27 / BG-28 at line level.
 *
 * Four groups, one shape. In UBL all four are `cac:AllowanceCharge` elements
 * distinguished by `cbc:ChargeIndicator` and by where they hang, and EN 16931
 * mirrors nearly every rule across the allowance/charge divide — BR-31 has
 * BR-36, BR-33 has BR-38, BR-DEC-01 has BR-DEC-05. What does *not* mirror is
 * the part that costs people rejections:
 *
 *   - The reason code lists are different and not interchangeable. An allowance
 *     reason code (BT-98 / BT-140) comes from UNCL 5189, nineteen codes; a
 *     charge reason code (BT-105 / BT-145) comes from UNCL 7161, one hundred
 *     and seventy-eight. They overlap on strings that mean different things, so
 *     moving an entry from `allowances` to `charges` without changing its code
 *     turns a valid document into a BR-CL-20 failure.
 *   - Document level entries carry their own VAT category (BT-95 / BT-102) and
 *     rate (BT-96 / BT-103) and therefore land in the VAT breakdown on their
 *     own account; line level entries have neither, because they modify BT-131
 *     and inherit the VAT treatment of the line they sit on. That is why the
 *     per-category `-03`/`-04`/`-06`/`-07` families exist for BG-20 and BG-21
 *     and have no line-level counterpart.
 *   - BT-107 and BT-108 stay separate sums (BR-CO-11, BR-CO-12) even where an
 *     allowance and a charge in the same category-and-rate group net against
 *     each other inside BT-116. The totals are disclosures; the breakdown is
 *     the tax base.
 *
 * BR-33/BR-38/BR-42/BR-44 and BR-CO-21..BR-CO-24 test the same predicate. That
 * is not redundancy in the standard and it is not deduplicated here: the BR-3x
 * rules are cardinality constraints on the group, the BR-CO-2x rules are
 * co-occurrence constraints, and the reference validators report both ids. A
 * caller pasting an id into a search engine gets the page they were sent to.
 *
 * Rule texts from `ubl/schematron/abstract/EN16931-model.sch` and the UBL
 * binding in `ubl/schematron/UBL/EN16931-UBL-model.sch`,
 * ConnectingEurope/eInvoicing-EN16931 @ validation-1.3.16.
 */

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

const page = (rule: string): string => `${DOCS}/${rule}`;

const describe = (category: VatCategory): string =>
  `${category} (${CATEGORY_NAMES[category]})`;

/** The nine categories, spelled out, for a fix that has to offer a choice. */
const CATEGORY_MENU = ALL_CATEGORIES.map(
  (c) => `"${c}" ${CATEGORY_NAMES[c]}`,
).join(", ");

/** Render a value for a message without pretending `undefined` is a number. */
const show = (value: unknown): string =>
  value === undefined ? "missing" : value === null ? "null" : String(value);

/**
 * A line level allowance or charge, tagged the way `TaggedAllowanceCharge`
 * tags a document level one.
 *
 * `position` is the 1-based index among the line's own `cac:AllowanceCharge`
 * children, and the generator emits BG-27 before BG-28, so a line with two
 * allowances puts its first charge at `cac:AllowanceCharge[3]`.
 */
interface TaggedLineAllowanceCharge {
  entry: LineAllowanceCharge;
  isCharge: boolean;
  /** 0-based index of the line within `inv.lines`. */
  lineIndex: number;
  /** 0-based index within `line.allowances` or `line.charges`. */
  index: number;
  /** 1-based index among the line's `cac:AllowanceCharge` elements. */
  position: number;
  /** BT-126 invoice line identifier, when the line has one. */
  lineId?: string;
  label: string;
  group: "BG-27" | "BG-28";
  /** "lines[2].allowances[0]" — addresses the caller's own object. */
  path: string;
  xpath: string;
}

/** Every BG-27 and BG-28 entry on the document, in generated order. */
const lineAllowanceCharges = (
  inv: InvoiceInput,
): TaggedLineAllowanceCharge[] => {
  const out: TaggedLineAllowanceCharge[] = [];
  for (const [lineIndex, line] of linesOf(inv).entries()) {
    if (!line) continue;
    const allowances = line.allowances ?? [];
    const push = (
      entries: LineAllowanceCharge[] | undefined,
      isCharge: boolean,
    ) => {
      for (const [index, entry] of (entries ?? []).entries()) {
        if (!entry) continue;
        const position = (isCharge ? allowances.length : 0) + index + 1;
        const key = isCharge ? "charges" : "allowances";
        out.push({
          entry,
          isCharge,
          lineIndex,
          index,
          position,
          lineId: line.id,
          label: isCharge ? "invoice line charge" : "invoice line allowance",
          group: isCharge ? "BG-28" : "BG-27",
          path: `lines[${lineIndex}].${key}[${index}]`,
          xpath: `/ubl:Invoice/cac:InvoiceLine[${lineIndex + 1}]/cac:AllowanceCharge[${position}]`,
        });
      }
    };
    push(allowances, false);
    push(line.charges, true);
  }
  return out;
};

/** "the line allowance on line 3 (id \"3\")" — a human locator for a message. */
const whereLine = (tagged: TaggedLineAllowanceCharge): string =>
  `The ${tagged.label} at ${tagged.path}, on line ${tagged.lineIndex + 1}${
    tagged.lineId ? ` (id "${tagged.lineId}")` : ""
  },`;

/** "The document level allowance at allowances[0]" */
const whereDocument = (tagged: TaggedAllowanceCharge): string =>
  `The ${tagged.label} at ${allowanceChargePath(tagged)}`;

/**
 * Why a reason matters more under a CIUS with a mandated visualisation.
 *
 * XRechnung obliges the recipient to be able to render the invoice for a human
 * reader, and what the rendering shows for a reason code is the code. "64" on
 * a screen is not an explanation of a deduction from an invoice total.
 */
const visualisationNote = (inv: InvoiceInput): string =>
  isXRechnung(inv)
    ? " Under XRechnung, prefer the free text: the mandated visualisation renders the code verbatim, so a buyer looking at the rendered invoice sees the bare code and not what it means."
    : "";

// ---------------------------------------------------------------------------
// Document level: presence rules
// ---------------------------------------------------------------------------

interface PresenceSpec {
  /** BR-31 (allowance) / BR-36 (charge) etc. */
  rule: string;
  field: BusinessTerm | BusinessTerm[];
  element: string;
}

const AMOUNT_SPEC: Record<"allowance" | "charge", PresenceSpec> = {
  allowance: { rule: "BR-31", field: "BT-92", element: "cbc:Amount" },
  charge: { rule: "BR-36", field: "BT-99", element: "cbc:Amount" },
};

const CATEGORY_SPEC: Record<"allowance" | "charge", PresenceSpec> = {
  allowance: {
    rule: "BR-32",
    field: "BT-95",
    element: "cac:TaxCategory/cbc:ID",
  },
  charge: {
    rule: "BR-37",
    field: "BT-102",
    element: "cac:TaxCategory/cbc:ID",
  },
};

// ---------------------------------------------------------------------------
// Per-category document allowance / charge specs
// ---------------------------------------------------------------------------

interface CategorySpec {
  category: VatCategory;
  /** Prose form of the identifiers `-03` / `-04` demand. */
  requires: string;
  /** True when the invoice satisfies the identifier requirement. */
  satisfied: (inv: InvoiceInput) => boolean;
  identityFields: BusinessTerm[];
  /** Why *this* category needs those identifiers and not others. */
  identityWhy: string;
  identityFix: string;
  identityExample: string;
  /** What `-06` / `-07` demand of BT-96 / BT-103. */
  rate: "positive" | "nonNegative" | "zero" | "none";
  /** Why the rate constraint follows from the category. */
  rateWhy: string;
}

const sellerVatOrTaxNumberOrRep = (inv: InvoiceInput): boolean =>
  (inv.seller ? sellerTaxIdentified(inv.seller) : false) ||
  !blank(inv.taxRepresentative?.vatId);

const sellerVatOrRep = (inv: InvoiceInput): boolean =>
  !blank(inv.seller?.vatId) || !blank(inv.taxRepresentative?.vatId);

const buyerIdentified = (inv: InvoiceInput): boolean =>
  !blank(inv.buyer?.vatId) || !blank(inv.buyer?.legalRegistrationId);

const SELLER_IDENTIFIERS =
  "the seller VAT identifier (BT-31), the seller tax registration identifier (BT-32) and/or the seller tax representative VAT identifier (BT-63)";

const CATEGORY_SPECS: CategorySpec[] = [
  {
    category: "S",
    requires: SELLER_IDENTIFIERS,
    satisfied: sellerVatOrTaxNumberOrRep,
    identityFields: ["BT-31", "BT-32"],
    identityWhy:
      "A standard-rated document level adjustment does not merely move net value: it changes the VAT the buyer may reclaim, because the adjustment is netted into the standard-rated breakdown group before BT-117 is computed. The authority therefore has to be able to trace it to the registered person who collected that VAT.",
    identityFix:
      'Set seller.vatId to your VAT identifier (e.g. "DE123456789"). If you are not VAT-registered but hold a national tax number, set seller.taxRegistrationId instead; if you invoice through a fiscal representative, supply the taxRepresentative group with its vatId.',
    identityExample: `"seller": { "vatId": "DE123456789" }`,
    rate: "positive",
    rateWhy:
      'Category S means VAT is charged, and the rate is what selects which standard-rated breakdown group the adjustment nets into — the standard-rated category is the one category that may appear more than once in BG-23, once per distinct rate. A rate of zero would open a standard-rated group at 0%, which is a contradiction: "taxed" and "at no rate" cannot both hold.',
  },
  {
    category: "Z",
    requires: SELLER_IDENTIFIERS,
    satisfied: sellerVatOrTaxNumberOrRep,
    identityFields: ["BT-31", "BT-32"],
    identityWhy:
      "Zero rating is a rate inside the VAT system, not the absence of VAT. The supply is taxable, the supplier is exercising a right to apply 0%, and a document level adjustment to it is a taxable adjustment — so it has to name a registered supplier exactly as a standard-rated one does.",
    identityFix:
      "Set seller.vatId, or seller.taxRegistrationId if you have no VAT identifier, or supply the taxRepresentative group. If in truth no VAT applies to the transaction at all, the category is O rather than Z, and O forbids these identifiers instead of requiring them.",
    identityExample: `"seller": { "vatId": "DE123456789" }`,
    rate: "zero",
    rateWhy:
      "Zero rated means the rate is zero — that is the whole content of the category. Any other value here would put VAT on an adjustment to a supply the document has just declared untaxed, and would split the breakdown into two Z groups, which BR-Z-01 forbids.",
  },
  {
    category: "E",
    requires: SELLER_IDENTIFIERS,
    satisfied: sellerVatOrTaxNumberOrRep,
    identityFields: ["BT-31", "BT-32"],
    identityWhy:
      "An exemption is granted by a named provision and can only be invoked by a registered taxable person. A discount or surcharge attached to an exempt supply inherits that exemption, and with it the evidencing burden: the breakdown will carry an exemption reason (BR-E-10) that has to be attributable to someone.",
    identityFix:
      "Set seller.vatId or seller.taxRegistrationId, or supply the taxRepresentative group. Remember that an exempt breakdown also needs vatExemptionReasons.E — category E is the one category with no standard wording, because the provision differs by member state.",
    identityExample: `"seller": { "vatId": "DE123456789" }, "vatExemptionReasons": { "E": "Exempt under Article 132(1)(i) of Directive 2006/112/EC" }`,
    rate: "zero",
    rateWhy:
      "An exempt supply carries no VAT, so neither does an adjustment to it. Note that exempt is not the same as zero rated even though both produce 0 in BT-117: an exempt supplier generally cannot deduct input tax on the related costs, which is why the two categories exist separately.",
  },
  {
    category: "AE",
    requires: `${SELLER_IDENTIFIERS}, and the buyer VAT identifier (BT-48) and/or the buyer legal registration identifier (BT-47)`,
    satisfied: (inv) => sellerVatOrTaxNumberOrRep(inv) && buyerIdentified(inv),
    identityFields: ["BT-31", "BT-48"],
    identityWhy:
      "Reverse charge moves the VAT liability to the buyer, who self-assesses it. A document level adjustment in category AE changes the base they self-assess on, so both ends of the transfer have to be identifiable: yours for the output side that reports zero, theirs for the input side that reports the tax. This is the only allowance/charge family that constrains the buyer as well as the seller.",
    identityFix:
      "Set buyer.vatId to your client's VAT number (buyer.legalRegistrationId also satisfies the rule) and make sure seller.vatId or seller.taxRegistrationId is set. Validate the buyer's number against VIES on the invoice date and keep the response — if it is invalid at the time of supply the liability stays with you.",
    identityExample: `"buyer": { "vatId": "ATU12345678" }`,
    rate: "zero",
    rateWhy:
      "The seller charges no VAT at all on a reverse-charge document — the buyer does. A rate here would be you quoting a percentage for tax you are not accounting for, and the buyer's own rate may differ from yours anyway, since the applicable rate is the one in their member state.",
  },
  {
    category: "K",
    requires:
      "the seller VAT identifier (BT-31) or the seller tax representative VAT identifier (BT-63), and the buyer VAT identifier (BT-48)",
    satisfied: (inv) => sellerVatOrRep(inv) && !blank(inv.buyer?.vatId),
    identityFields: ["BT-31", "BT-48"],
    identityWhy:
      "An intra-community supply is zero-rated in the country of dispatch only because it will be taxed in the country of arrival, and the pair of VAT identifiers is what lets the two administrations match the same transaction across the border. Note what is *not* accepted here: a national tax registration number (BT-32) satisfies the standard-rated and exempt families but not this one, because it does not resolve in VIES.",
    identityFix:
      "Set seller.vatId (not seller.taxRegistrationId) and buyer.vatId to VAT numbers issued in different member states, and verify the buyer's in VIES before you issue. An intra-community supply must also carry a delivery date (BR-IC-11) and a deliver-to country (BR-IC-12).",
    identityExample: `"seller": { "vatId": "DE123456789" }, "buyer": { "vatId": "FR12345678901" }`,
    rate: "zero",
    rateWhy:
      "The supply is zero-rated on despatch and acquired VAT is due from the customer in the destination member state at that state's rate. Quoting a rate here would assert a tax liability that arises in a jurisdiction this invoice does not settle.",
  },
  {
    category: "G",
    requires:
      "the seller VAT identifier (BT-31) or the seller tax representative VAT identifier (BT-63)",
    satisfied: sellerVatOrRep,
    identityFields: ["BT-31", "BT-63"],
    identityWhy:
      "Export zero-rating is reconciled against customs export evidence, and that evidence is filed under a VAT identifier. This family is stricter than the standard-rated one on purpose: unlike BR-S-03 or BR-E-03, a national tax registration number (BT-32) does not satisfy it, so a seller invoicing on a Steuernummer alone cannot zero-rate an export.",
    identityFix:
      "Set seller.vatId, or supply the taxRepresentative group with its vatId if you export through a fiscal representative. seller.taxRegistrationId will not satisfy this rule however valid the number is.",
    identityExample: `"seller": { "vatId": "DE123456789" }`,
    rate: "zero",
    rateWhy:
      "Goods leaving the customs territory of the EU are relieved of EU VAT; whatever tax the destination levies on import is assessed there, on the importer, and has nothing to do with this document.",
  },
  {
    category: "O",
    requires:
      "the seller VAT identifier (BT-31), the seller tax representative VAT identifier (BT-63) or the buyer VAT identifier (BT-48)",
    // Inverted: the rule is satisfied when the identifiers are *absent*.
    satisfied: (inv) =>
      blank(inv.seller?.vatId) &&
      blank(inv.taxRepresentative?.vatId) &&
      blank(inv.buyer?.vatId),
    identityFields: ["BT-31", "BT-48"],
    identityWhy:
      'This is the one member of the family that runs backwards. "Not subject to VAT" says the transaction falls outside the scope of VAT entirely, so quoting a VAT number on it is self-contradictory: a VAT identifier is an assertion that the holder is acting as a taxable person in the very transaction the document says is not one.',
    identityFix:
      "Remove seller.vatId, buyer.vatId and any taxRepresentative from an invoice carrying a category O allowance or charge. If the supply really is within the scope of VAT, change the entry's vatCategory instead — Z for taxed at 0%, E for exempt.",
    identityExample: `"seller": { "taxRegistrationId": "18/181/08155" }`,
    rate: "none",
    rateWhy:
      'A transaction outside the scope of VAT has no rate at all, which is a different claim from a rate of zero: zero means "taxed, at nothing", absent means "not taxed". EN 16931 keeps the distinction because the two are reported differently on a VAT return.',
  },
  {
    category: "L",
    requires: SELLER_IDENTIFIERS,
    satisfied: sellerVatOrTaxNumberOrRep,
    identityFields: ["BT-31", "BT-32"],
    identityWhy:
      "IGIC is the Canary Islands' own general indirect tax, levied instead of VAT because the archipelago is outside the EU VAT area while remaining inside the customs union. A document level adjustment in this category changes the IGIC base the same way a standard-rated one changes the VAT base, so the same identification requirement applies — the tax is collected on behalf of a real administration, the Canarian one.",
    identityFix:
      'Set seller.vatId to your Spanish NIF-IVA (e.g. "ESX1234567X"), or seller.taxRegistrationId if you hold a national tax number rather than a VAT identifier, or supply the taxRepresentative group.',
    identityExample: `"seller": { "vatId": "ESX1234567X" }`,
    rate: "nonNegative",
    rateWhy:
      "IGIC is charged, so the adjustment carries a rate — and unlike category S that rate may be exactly 0, because the Canarian regime relieves a number of supplies by applying a zero rate rather than by exempting them. What it may not be is absent or negative.",
  },
  {
    category: "M",
    requires: SELLER_IDENTIFIERS,
    satisfied: sellerVatOrTaxNumberOrRep,
    identityFields: ["BT-31", "BT-32"],
    identityWhy:
      "IPSI is the tax on production, services and imports levied in Ceuta and Melilla, which sit outside both the EU VAT area and the customs union. As with IGIC, the tax on the adjusted supply is real and collected, so the seller has to be identifiable to the administration that levies it.",
    identityFix:
      'Set seller.vatId (e.g. "ESX1234567X"), or seller.taxRegistrationId, or supply the taxRepresentative group.',
    identityExample: `"seller": { "vatId": "ESX1234567X" }`,
    rate: "nonNegative",
    rateWhy:
      "IPSI is charged, so the adjustment carries a rate, and that rate may be 0 as well as positive — the Ceuta and Melilla tariffs include a zero band. An absent rate would leave the adjustment untethered from the tax the document says applies to it.",
  },
];

// ---------------------------------------------------------------------------
// Decimal specs
// ---------------------------------------------------------------------------

interface DecSpec {
  rule: string;
  field: BusinessTerm;
  key: "amount" | "baseAmount";
  label: string;
  element: string;
  why: string;
}

const AMOUNT_WHY =
  "An allowance amount usually arrives as a percentage of something — 3% settlement discount, 1.5% surcharge — and a percentage of a two-decimal figure is almost never a two-decimal figure. EN 16931 wants the *result* rounded, once, before it is written.";

const BASE_WHY =
  "A base amount is normally lifted straight out of a subtotal your own system computed, so it carries whatever precision that computation left behind. It is also the number the percentage is applied to, so an over-precise base tends to produce an over-precise amount alongside it.";

const DOC_DEC_SPECS: Record<"allowance" | "charge", DecSpec[]> = {
  allowance: [
    {
      rule: "BR-DEC-01",
      field: "BT-92",
      key: "amount",
      label: "document level allowance amount",
      element: "cbc:Amount",
      why: AMOUNT_WHY,
    },
    {
      rule: "BR-DEC-02",
      field: "BT-93",
      key: "baseAmount",
      label: "document level allowance base amount",
      element: "cbc:BaseAmount",
      why: BASE_WHY,
    },
  ],
  charge: [
    {
      rule: "BR-DEC-05",
      field: "BT-99",
      key: "amount",
      label: "document level charge amount",
      element: "cbc:Amount",
      why: AMOUNT_WHY,
    },
    {
      rule: "BR-DEC-06",
      field: "BT-100",
      key: "baseAmount",
      label: "document level charge base amount",
      element: "cbc:BaseAmount",
      why: BASE_WHY,
    },
  ],
};

const LINE_DEC_SPECS: Record<"allowance" | "charge", DecSpec[]> = {
  allowance: [
    {
      rule: "BR-DEC-24",
      field: "BT-136",
      key: "amount",
      label: "invoice line allowance amount",
      element: "cbc:Amount",
      why: "A line allowance is subtracted from the line net amount (BT-131), and BT-131 must land on two decimals. Rounding the line total while leaving the allowance long only hides the extra digits from your own display — they still reach the XML.",
    },
    {
      rule: "BR-DEC-25",
      field: "BT-137",
      key: "baseAmount",
      label: "invoice line allowance base amount",
      element: "cbc:BaseAmount",
      why: BASE_WHY,
    },
  ],
  charge: [
    {
      rule: "BR-DEC-27",
      field: "BT-141",
      key: "amount",
      label: "invoice line charge amount",
      element: "cbc:Amount",
      why: "A line charge is added into the line net amount (BT-131), which must land on two decimals. Per-unit surcharges multiplied by a fractional quantity are the usual source of the extra digits.",
    },
    {
      rule: "BR-DEC-28",
      field: "BT-142",
      key: "baseAmount",
      label: "invoice line charge base amount",
      element: "cbc:BaseAmount",
      why: BASE_WHY,
    },
  ],
};

// ---------------------------------------------------------------------------
// Reason code lists
// ---------------------------------------------------------------------------

const ALLOWANCE_CODE_LIST = ALLOWANCE_REASON_CODES.map((c) => `"${c}"`).join(", ");

/**
 * BR-CL-19 (UNCL 5189) and BR-CL-20 (UNCL 7161) at either level. The two lists
 * are not the same list, and the failure mode this catches is a caller moving
 * an entry between `allowances` and `charges` without changing its code.
 */
const CODE_LIST_SPECS = {
  allowance: {
    rule: "BR-CL-19",
    list: "UNCL 5189",
    set: ALLOWANCE_REASON_CODES_SET,
    otherSet: CHARGE_REASON_CODES_SET,
    scope: `The whole list is short enough to read: ${ALLOWANCE_CODE_LIST} — nineteen codes, and none of them is a free-text escape hatch.`,
    otherName: "charge",
  },
  charge: {
    rule: "BR-CL-20",
    list: "UNCL 7161",
    set: CHARGE_REASON_CODES_SET,
    otherSet: ALLOWANCE_REASON_CODES_SET,
    scope: `The list holds ${CHARGE_REASON_CODES.length} codes, far more than the allowance list, because a charge can be almost any service added to a supply. The ones most often wanted: "FC" freight service, "PC" packing, "IAA" insurance, "ABK" miscellaneous, "SH" handling. Note "IN" is not among them — the plain two-letter abbreviation for insurance is exactly the kind of near-miss this rule exists to catch.`,
    otherName: "allowance",
  },
} as const;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const allowanceChargeRules: RuleFn[] = [
  // --- BR-31 / BR-36: the amount is mandatory ------------------------------
  (inv, ctx) => {
    const out: TeachingError[] = [];
    for (const tagged of allowanceChargesOf(inv, ctx)) {
      const amount = tagged.entry.amount;
      if (typeof amount === "number" && Number.isFinite(amount)) continue;
      const spec = AMOUNT_SPEC[tagged.isCharge ? "charge" : "allowance"];
      const path = allowanceChargePath(tagged);
      out.push({
        rule: spec.rule,
        field: spec.field,
        severity: "fatal",
        message: `${whereDocument(tagged)} has no usable ${tagged.isCharge ? "charge" : "allowance"} amount (${spec.field}): you supplied ${show(amount)}. Each ${tagged.group} group must have one, because it is the only figure that actually moves money — the percentage (${tagged.isCharge ? "BT-101" : "BT-94"}) and base amount (${tagged.isCharge ? "BT-100" : "BT-93"}) are documentation of how the figure was reached, not substitutes for it, and BT-${tagged.isCharge ? "108" : "107"} is the sum of these amounts under BR-CO-1${tagged.isCharge ? "2" : "1"}.`,
        fix: `Set ${path}.amount to a positive number of ${inv.currency || "the invoice currency"} — always positive, even for an allowance: it is the array the entry sits in, not its sign, that decides whether the figure is deducted or added.`,
        example: `"${tagged.isCharge ? "charges" : "allowances"}": [{ "amount": 25.00, "vatCategory": "S", "vatRate": 19, "reason": "${tagged.isCharge ? "Freight" : "Volume discount"}" }]`,
        xpath: `${tagged.xpath}/${spec.element}`,
        docsUrl: page(spec.rule),
      });
    }
    return out;
  },

  // --- BR-32 / BR-37: the VAT category is mandatory ------------------------
  (inv, ctx) => {
    const out: TeachingError[] = [];
    for (const tagged of allowanceChargesOf(inv, ctx)) {
      if (!blank(tagged.entry.vatCategory as unknown as string)) continue;
      const spec = CATEGORY_SPEC[tagged.isCharge ? "charge" : "allowance"];
      const path = allowanceChargePath(tagged);
      out.push({
        rule: spec.rule,
        field: spec.field,
        severity: "fatal",
        message: `${whereDocument(tagged)} has no VAT category code (${spec.field}): you supplied ${show(tagged.entry.vatCategory)}. A document level ${tagged.isCharge ? "charge" : "allowance"} is not a neutral adjustment to a total — it enters the VAT breakdown on its own account, ${tagged.isCharge ? "adding to" : "reducing"} the taxable amount (BT-116) of exactly one category-and-rate group. Without a category there is no group to put it in, and the document's VAT would silently disagree with its totals.`,
        fix: `Set ${path}.vatCategory to the category of the supply this ${tagged.isCharge ? "charge" : "allowance"} relates to — ${CATEGORY_MENU} — which should normally be the category of the lines it adjusts.`,
        example: `"vatCategory": "S", "vatRate": 19`,
        xpath: `${tagged.xpath}/${spec.element}`,
        docsUrl: page(spec.rule),
      });
    }
    return out;
  },

  // --- BR-33 / BR-38 and BR-CO-21 / BR-CO-22: a reason, or a reason code ---
  //
  // One predicate, two findings, deliberately. KoSIT reports both ids and they
  // are different constraints: BR-33/BR-38 are cardinality on the group,
  // BR-CO-21/BR-CO-22 are co-occurrence between two optional terms.
  (inv, ctx) => {
    const out: TeachingError[] = [];
    for (const tagged of allowanceChargesOf(inv, ctx)) {
      const { reason, reasonCode } = tagged.entry;
      if (!blank(reason) || !blank(reasonCode)) continue;
      const path = allowanceChargePath(tagged);
      const charge = tagged.isCharge;
      const reasonTerm = charge ? "BT-104" : "BT-97";
      const codeTerm = charge ? "BT-105" : "BT-98";
      const cardinalityRule = charge ? "BR-38" : "BR-33";
      const coRule = charge ? "BR-CO-22" : "BR-CO-21";
      const codeList = charge ? "UNCL 7161" : "UNCL 5189";
      const sampleCode = charge ? "FC" : "95";
      const sampleText = charge ? "Freight service" : "Discount";

      out.push({
        rule: cardinalityRule,
        field: [reasonTerm, codeTerm],
        severity: "fatal",
        message: `${whereDocument(tagged)} states neither a reason (${reasonTerm}) nor a reason code (${codeTerm}); both are empty. Every ${tagged.group} group must carry at least one of them, because an unexplained ${charge ? "addition to" : "deduction from"} an invoice total is the single most disputed thing on a commercial document — the buyer's accounts-payable clerk has to decide whether to approve it, and "${charge ? "+" : "−"}${show(tagged.entry.amount)}" on its own gives them nothing to decide on.`,
        fix: `Set ${path}.reason to a short description in the invoice language, or ${path}.reasonCode to a ${codeList} code, or both.${visualisationNote(inv)}`,
        example: `"${charge ? "charges" : "allowances"}": [{ "amount": 25.00, "vatCategory": "S", "vatRate": 19, "reason": "${sampleText}", "reasonCode": "${sampleCode}" }]`,
        xpath: `${tagged.xpath}/cbc:AllowanceChargeReason`,
        docsUrl: page(cardinalityRule),
      });

      out.push({
        rule: coRule,
        field: [reasonTerm, codeTerm],
        severity: "fatal",
        message: `Taken individually, the reason (${reasonTerm}) and the reason code (${codeTerm}) on the ${tagged.label} at ${path} are both optional terms — which is why this constraint exists separately from ${cardinalityRule}: it is the co-occurrence rule that forbids the one combination the cardinalities allow, namely neither. Supplying both is explicitly permitted and is usually the better answer, since the code is what a receiving system can act on automatically and the text is what a person reads.`,
        fix: `Add ${path}.reason, ${path}.reasonCode, or both. If no ${codeList} code fits what you are ${charge ? "charging for" : "discounting"}, omit the code and write the reason as free text — the list has no "other" entry, and inventing a code fails ${charge ? "BR-CL-20" : "BR-CL-19"}.`,
        example: `"reason": "${sampleText}", "reasonCode": "${sampleCode}"`,
        xpath: `${tagged.xpath}/cbc:AllowanceChargeReasonCode`,
        docsUrl: page(coRule),
      });
    }
    return out;
  },

  // --- BR-DEC-01 / BR-DEC-02 / BR-DEC-05 / BR-DEC-06 -----------------------
  (inv, ctx) => {
    const out: TeachingError[] = [];
    for (const tagged of allowanceChargesOf(inv, ctx)) {
      const specs = DOC_DEC_SPECS[tagged.isCharge ? "charge" : "allowance"];
      const path = allowanceChargePath(tagged);
      for (const spec of specs) {
        const value = tagged.entry[spec.key];
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        const places = decimalPlaces(value);
        if (places <= 2) continue;
        const rounded = Math.round(value * 100) / 100;
        out.push({
          rule: spec.rule,
          field: spec.field,
          severity: "fatal",
          message: `The allowed maximum number of decimals for the ${spec.label} (${spec.field}) is 2, but ${path}.${spec.key} is ${value}, which has ${places}. The schematron measures the digits after the decimal point in the serialised XML, so a value that merely *displays* as two decimals still fails when the underlying number carries more. ${spec.why}`,
          fix: `Round ${path}.${spec.key} to two decimals before you hand it over — ${rounded.toFixed(2)} here. This package exports round2() for it, which avoids the two JavaScript traps: Math.round(1.005 * 100) / 100 gives 1.00, and (2.675).toFixed(2) gives "2.67".`,
          example: `"${spec.key}": ${rounded.toFixed(2)}`,
          xpath: `${tagged.xpath}/${spec.element}`,
          docsUrl: page(spec.rule),
        });
      }
    }
    return out;
  },

  // --- BR-CL-19 / BR-CL-20 at document level -------------------------------
  (inv, ctx) => {
    const out: TeachingError[] = [];
    for (const tagged of allowanceChargesOf(inv, ctx)) {
      const code = tagged.entry.reasonCode;
      if (blank(code)) continue; // BR-33 / BR-38 govern absence
      const value = String(code).trim();
      const kind = tagged.isCharge ? "charge" : "allowance";
      const spec = CODE_LIST_SPECS[kind];
      if (spec.set.has(value)) continue;
      const path = allowanceChargePath(tagged);
      const crossed = spec.otherSet.has(value);
      out.push({
        rule: spec.rule,
        field: tagged.isCharge ? "BT-105" : "BT-98",
        severity: "fatal",
        message: `The ${tagged.label} at ${path} carries the reason code "${value}", which is not in ${spec.list}, the list ${spec.rule} admits for ${kind} reason codes.${crossed ? ` It *is* in the ${spec.otherName} list — and that is the trap this rule exists to catch. EN 16931 uses two different code lists for the two directions: allowance reason codes come from UNCL 5189, charge reason codes from UNCL 7161. Moving an entry between the allowances and charges arrays without changing its code turns a valid document into a rejected one, because the same string means something else in the other list.` : ` Allowance reason codes come from UNCL 5189 and charge reason codes from UNCL 7161 — two different lists that overlap on strings meaning different things, so a code copied from the wrong side fails here even when it looks plausible.`} ${spec.scope}`,
        fix: `Either set ${path}.reasonCode to a ${spec.list} code, or remove it and describe the ${kind} in ${path}.reason instead — free text on its own satisfies ${tagged.isCharge ? "BR-38 and BR-CO-22" : "BR-33 and BR-CO-21"}, and is better than a code that means the wrong thing.`,
        example: tagged.isCharge
          ? `"charges": [{ "amount": 15.00, "vatCategory": "S", "vatRate": 19, "reasonCode": "FC", "reason": "Freight service" }]`
          : `"allowances": [{ "amount": 15.00, "vatCategory": "S", "vatRate": 19, "reasonCode": "95", "reason": "Discount" }]`,
        xpath: `${tagged.xpath}/cbc:AllowanceChargeReasonCode`,
        docsUrl: page(spec.rule),
      });
    }
    return out;
  },

  // --- BR-CO-11 / BR-CO-12: BT-107 = Σ BT-92, BT-108 = Σ BT-99 -------------
  (inv, ctx) => {
    const declared = inv.declaredTotals;
    if (!declared) return null;
    if (linesOf(inv).length === 0) return null;
    const { totals: computed } = totalsOutcomeOf(inv, ctx);
    // BR-22 / BR-24 / BR-26 report the underlying line defect.
    if (!computed) return null;

    const out: TeachingError[] = [];
    const compare = (
      declaredValue: number | undefined,
      computedValue: number,
      rule: string,
      field: BusinessTerm,
      key: "allowanceTotalAmount" | "chargeTotalAmount",
      group: "BG-20" | "BG-21",
      term: "BT-92" | "BT-99",
      element: string,
      why: string,
    ) => {
      if (typeof declaredValue !== "number" || !Number.isFinite(declaredValue)) {
        return;
      }
      if (round2(declaredValue) === computedValue) return;
      const delta = round2(round2(declaredValue) - computedValue);
      const count = (key === "allowanceTotalAmount" ? inv.allowances : inv.charges)?.length ?? 0;
      out.push(
        err({
          rule,
          field,
          severity: "fatal",
          message: `${rule} requires ${field} to equal Σ ${term}, the sum of the ${group} amounts on the document. You declared ${round2(declaredValue).toFixed(2)} for ${field}, but the ${count === 1 ? "single entry" : `${count} entries`} in ${key === "allowanceTotalAmount" ? "allowances" : "charges"} sum to ${computedValue.toFixed(2)} — a difference of ${delta > 0 ? "+" : ""}${delta.toFixed(2)} ${inv.currency}. ${why}`,
          fix: `Either correct the ${key === "allowanceTotalAmount" ? "allowances" : "charges"} array so it sums to your declared figure, or drop declaredTotals.${key} and let the library compute it — generation always emits the computed value regardless of what you declare. Sum the *rounded* entry amounts, in that order: EN 16931 rounds each amount to two decimals and then adds.`,
          example: `"declaredTotals": { "${key}": ${computedValue.toFixed(2)} }`,
          xpath: `/ubl:Invoice/cac:LegalMonetaryTotal/${element}`,
          docsUrl: page(rule),
        }),
      );
    };

    compare(
      declared.allowanceTotalAmount,
      computed.allowanceTotalAmount,
      "BR-CO-11",
      "BT-107",
      "allowanceTotalAmount",
      "BG-20",
      "BT-92",
      "cbc:AllowanceTotalAmount",
      "BT-107 is a plain sum and nothing nets against it: a document level charge in the same VAT category does reduce the taxable amount of that category's breakdown group, but it never reduces BT-107, which stays a gross disclosure of everything deducted.",
    );
    compare(
      declared.chargeTotalAmount,
      computed.chargeTotalAmount,
      "BR-CO-12",
      "BT-108",
      "chargeTotalAmount",
      "BG-21",
      "BT-99",
      "cbc:ChargeTotalAmount",
      "Line level charges (BG-28) are deliberately not in this sum — they are already inside the line net amounts that make up BT-106, and counting them again here would double them into BT-109 via BR-CO-13.",
    );
    return out;
  },

  // --- BR-DEC-10 / BR-DEC-11: BT-107 and BT-108 carry at most 2 decimals ---
  (inv) => {
    const declared = inv.declaredTotals;
    if (!declared) return null;
    const specs: {
      rule: string;
      field: BusinessTerm;
      key: "allowanceTotalAmount" | "chargeTotalAmount";
      label: string;
      element: string;
      why: string;
    }[] = [
      {
        rule: "BR-DEC-10",
        field: "BT-107",
        key: "allowanceTotalAmount",
        label: "Sum of allowances on document level",
        element: "cbc:AllowanceTotalAmount",
        why: "A total that carries extra decimals when its parts do not means the parts were added before they were rounded. EN 16931 requires the other order — round each document level allowance amount (BT-92) to two decimals, then sum.",
      },
      {
        rule: "BR-DEC-11",
        field: "BT-108",
        key: "chargeTotalAmount",
        label: "Sum of charges on document level",
        element: "cbc:ChargeTotalAmount",
        why: "Charges are the usual home of per-unit and percentage-based figures — freight per kilo, a 1.5% handling fee — so this is the total most likely to inherit a long decimal from the arithmetic that produced it.",
      },
    ];

    const out: TeachingError[] = [];
    for (const spec of specs) {
      const value = declared[spec.key];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const places = decimalPlaces(value);
      if (places <= 2) continue;
      const rounded = Math.round(value * 100) / 100;
      out.push({
        rule: spec.rule,
        field: spec.field,
        severity: "fatal",
        message: `The allowed maximum number of decimals for the ${spec.label} (${spec.field}) is 2, but you declared ${value}, which has ${places}. The rule is written against the serialised value — the schematron counts the characters after the decimal point in the XML — so the check is about what gets written, not about what the number "really" is. ${spec.why}`,
        fix: `Round declaredTotals.${spec.key} to two decimals (${rounded.toFixed(2)} here) using half-up rounding away from zero, for which this package exports round2(). Alternatively drop declaredTotals and let the library compute the totals, which it always rounds correctly.`,
        example: `"declaredTotals": { "${spec.key}": ${rounded.toFixed(2)} }`,
        xpath: `/ubl:Invoice/cac:LegalMonetaryTotal/${spec.element}`,
        docsUrl: page(spec.rule),
      });
    }
    return out;
  },

  // --- BR-{S,Z,E,AE,IC,G,O}-03 / -04: identifiers the category demands -----
  (inv, ctx) => {
    const entries = allowanceChargesOf(inv, ctx);
    if (entries.length === 0) return null;
    const out: TeachingError[] = [];

    for (const spec of CATEGORY_SPECS) {
      const affected = entries.filter((t) => t.entry.vatCategory === spec.category);
      if (affected.length === 0) continue;
      if (spec.satisfied(inv)) continue;

      for (const kind of ["allowance", "charge"] as const) {
        const isCharge = kind === "charge";
        const hits = affected.filter((t) => t.isCharge === isCharge);
        if (hits.length === 0) continue;
        const rule = `BR-${CATEGORY_RULE_INFIX[spec.category]}-${isCharge ? "04" : "03"}`;
        const term = isCharge ? "BT-102" : "BT-95";
        const where = hits.map((t) => allowanceChargePath(t)).slice(0, 5).join(", ");
        const verb = spec.category === "O" ? "must not contain" : "must contain";

        out.push({
          rule,
          field: spec.identityFields,
          severity: "fatal",
          message: `This invoice contains ${hits.length === 1 ? "a" : `${hits.length}`} document level ${isCharge ? "charge" : "allowance"}${hits.length === 1 ? "" : "s"} (${isCharge ? "BG-21" : "BG-20"}) whose VAT category code (${term}) is ${describe(spec.category)} — ${where}${hits.length > 5 ? ", …" : ""} — so the invoice ${verb} ${spec.requires}. ${spec.identityWhy}`,
          fix: spec.identityFix,
          example: spec.identityExample,
          xpath: `${hits[0]!.xpath}/cac:TaxCategory/cbc:ID`,
          docsUrl: page(rule),
        });
      }
    }
    return out;
  },

  // --- BR-{S,Z,E,AE,IC,G,O}-06 / -07: the rate the category demands -------
  (inv, ctx) => {
    const out: TeachingError[] = [];
    for (const tagged of allowanceChargesOf(inv, ctx)) {
      const spec = CATEGORY_SPECS.find(
        (s) => s.category === tagged.entry.vatCategory,
      );
      if (!spec) continue; // BR-32 / BR-37 and BR-CL-18 report an unusable category

      const rate = tagged.entry.vatRate;
      const isCharge = tagged.isCharge;
      const rateTerm = isCharge ? "BT-103" : "BT-96";
      const rule = `BR-${CATEGORY_RULE_INFIX[spec.category]}-${isCharge ? "07" : "06"}`;
      const path = allowanceChargePath(tagged);

      let requirement: string;
      let fix: string;
      let example: string;

      if (spec.rate === "positive") {
        if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) continue;
        requirement = `must be greater than zero, but it is ${show(rate)}`;
        fix = `Set ${path}.vatRate to the percentage the adjusted supply is taxed at, as a number (19 for the German standard rate, 7 for the reduced rate). If no VAT applies to this ${isCharge ? "charge" : "allowance"}, change ${path}.vatCategory rather than the rate — Z, E, AE, K, G and O each say something different about why.`;
        example = `"vatCategory": "S", "vatRate": 19`;
      } else if (spec.rate === "nonNegative") {
        if (typeof rate === "number" && Number.isFinite(rate) && rate >= 0) continue;
        requirement = `must be 0 (zero) or greater than zero, but it is ${show(rate)}`;
        fix = `Set ${path}.vatRate to the ${spec.category === "L" ? "IGIC" : "IPSI"} percentage the adjusted supply bears, as a number. Zero is a legal value here — unlike category S — but the term must be present, because a missing rate and a rate of zero are different claims about a tax that is genuinely levied.`;
        example = `"vatCategory": "${spec.category}", "vatRate": ${spec.category === "L" ? 7 : 10}`;
      } else if (spec.rate === "zero") {
        if (rate === undefined || rate === 0) continue;
        requirement = `must be 0 (zero), but it is ${show(rate)}`;
        fix = `Set ${path}.vatRate to 0, or omit it — this library normalises the rate for category ${spec.category} either way. If you did mean to charge ${show(rate)}% VAT on this ${isCharge ? "charge" : "allowance"}, the category should be S instead, and that will change which breakdown group it nets into.`;
        example = `"vatCategory": "${spec.category}", "vatRate": 0`;
      } else {
        if (rate === undefined) continue;
        requirement = `must not be present at all — not even as 0 — but it is ${show(rate)}`;
        fix = `Remove vatRate from ${path}. If the ${isCharge ? "charge" : "allowance"} relates to a supply that is inside the scope of VAT but taxed at nothing, use category Z, which does carry a rate of 0.`;
        example = `"vatCategory": "O"`;
      }

      out.push({
        rule,
        field: rateTerm,
        severity: "fatal",
        message: `${whereDocument(tagged)} uses VAT category ${describe(spec.category)}, so its VAT rate (${rateTerm}) ${requirement}. ${spec.rateWhy}`,
        fix,
        example,
        xpath: `${tagged.xpath}/cac:TaxCategory/cbc:Percent`,
        docsUrl: page(rule),
      });
    }
    return out;
  },

  // --- BR-O-13 / BR-O-14: category O does not share a document -------------
  (inv, ctx) => {
    if (!usesCategoryAnywhere(inv, "O", ctx)) return null;
    const entries = allowanceChargesOf(inv, ctx);
    const out: TeachingError[] = [];

    for (const isCharge of [false, true]) {
      const offenders = entries.filter(
        (t) =>
          t.isCharge === isCharge &&
          !blank(t.entry.vatCategory as unknown as string) &&
          t.entry.vatCategory !== "O",
      );
      if (offenders.length === 0) continue;
      const rule = isCharge ? "BR-O-14" : "BR-O-13";
      const group = isCharge ? "BG-21" : "BG-20";
      const term = isCharge ? "BT-102" : "BT-95";
      const key = isCharge ? "charges" : "allowances";
      const where = offenders
        .slice(0, 5)
        .map((t) => `${allowanceChargePath(t)} (${t.entry.vatCategory})`)
        .join(", ");
      out.push({
        rule,
        field: term,
        severity: "fatal",
        message: `This invoice produces a VAT breakdown group (BG-23) with the VAT category code (BT-118) "Not subject to VAT", so no document level ${isCharge ? "charge" : "allowance"} (${group}) may carry a ${isCharge ? "charge" : "allowance"} VAT category code (${term}) other than "O" — but ${offenders.length === 1 ? "one does" : `${offenders.length} do`}: ${where}${offenders.length > 5 ? ", …" : ""}. Category O is a statement about the whole document, not about one figure on it: the transaction falls outside the scope of VAT altogether, so an adjustment carrying any other category would place taxable value on a document that has just declared there is none.`,
        fix: `Change the vatCategory on those ${key} entries to "O", or move the in-scope part of the invoice — lines and adjustments together — onto a separate document. BR-O-11 and BR-O-12 close the same route at breakdown and line level, so there is no arrangement of the four rules that lets category O share a document.`,
        example: `"${key}": [{ "amount": 25.00, "vatCategory": "O", "reason": "${isCharge ? "Statutory fee" : "Goodwill deduction"}" }]`,
        xpath: `${offenders[0]!.xpath}/cac:TaxCategory/cbc:ID`,
        docsUrl: page(rule),
      });
    }
    return out;
  },

  // --- BR-41 / BR-43: the line allowance / charge amount is mandatory ------
  (inv) => {
    const out: TeachingError[] = [];
    for (const tagged of lineAllowanceCharges(inv)) {
      const amount = tagged.entry.amount;
      if (typeof amount === "number" && Number.isFinite(amount)) continue;
      const rule = tagged.isCharge ? "BR-43" : "BR-41";
      const field: BusinessTerm = tagged.isCharge ? "BT-141" : "BT-136";
      out.push({
        rule,
        field,
        severity: "fatal",
        message: `${whereLine(tagged)} has no usable amount (${field}): you supplied ${show(amount)}. Each ${tagged.group} group must have one, and at line level the consequence is immediate — the line net amount is BT-129 x (BT-146 / BT-149) − Σ BT-136 + Σ BT-141, so an entry with no amount silently contributes nothing and the line total the buyer sees is not the one you meant to send.`,
        fix: `Set ${tagged.path}.amount to a positive number. Line level entries have no VAT category of their own: they inherit the line's, which is why a line discount changes BT-131 rather than appearing in the VAT breakdown on its own account.`,
        example: `"${tagged.isCharge ? "charges" : "allowances"}": [{ "amount": 12.50, "reason": "${tagged.isCharge ? "Handling" : "Damaged goods"}" }]`,
        xpath: `${tagged.xpath}/cbc:Amount`,
        docsUrl: page(rule),
      });
    }
    return out;
  },

  // --- BR-42 / BR-44 and BR-CO-23 / BR-CO-24 -------------------------------
  (inv) => {
    const out: TeachingError[] = [];
    for (const tagged of lineAllowanceCharges(inv)) {
      const { reason, reasonCode } = tagged.entry;
      if (!blank(reason) || !blank(reasonCode)) continue;
      const charge = tagged.isCharge;
      const reasonTerm = charge ? "BT-144" : "BT-139";
      const codeTerm = charge ? "BT-145" : "BT-140";
      const cardinalityRule = charge ? "BR-44" : "BR-42";
      const coRule = charge ? "BR-CO-24" : "BR-CO-23";
      const codeList = charge ? "UNCL 7161" : "UNCL 5189";
      const sampleCode = charge ? "SH" : "100";
      const sampleText = charge ? "Handling" : "Special agreement";

      out.push({
        rule: cardinalityRule,
        field: [reasonTerm, codeTerm],
        severity: "fatal",
        message: `${whereLine(tagged)} states neither a reason (${reasonTerm}) nor a reason code (${codeTerm}). Every ${tagged.group} group must carry at least one. A line level adjustment is harder to query than a document level one, because it disappears into the line net amount: the buyer sees a line total that does not equal quantity x price and has no way to find out why unless you say.`,
        fix: `Set ${tagged.path}.reason to a short description, or ${tagged.path}.reasonCode to a ${codeList} code, or both.${visualisationNote(inv)}`,
        example: `"${charge ? "charges" : "allowances"}": [{ "amount": 12.50, "reason": "${sampleText}", "reasonCode": "${sampleCode}" }]`,
        xpath: `${tagged.xpath}/cbc:AllowanceChargeReason`,
        docsUrl: page(cardinalityRule),
      });

      out.push({
        rule: coRule,
        field: [reasonTerm, codeTerm],
        severity: "fatal",
        message: `The reason (${reasonTerm}) and the reason code (${codeTerm}) on the ${tagged.label} at ${tagged.path} are individually optional terms, and this constraint — separate from ${cardinalityRule}, which is the cardinality rule on the group — is what rules out the one combination those cardinalities would otherwise permit: neither present. Supplying both is allowed and preferable, because the code is machine-actionable and the text is what a person reads.`,
        fix: `Add ${tagged.path}.reason, ${tagged.path}.reasonCode, or both. Where no ${codeList} code describes what you are ${charge ? "charging for" : "deducting"}, omit the code entirely and use free text — the lists have no "other" entry, and an invented code fails ${charge ? "BR-CL-20" : "BR-CL-19"}.`,
        example: `"reason": "${sampleText}", "reasonCode": "${sampleCode}"`,
        xpath: `${tagged.xpath}/cbc:AllowanceChargeReasonCode`,
        docsUrl: page(coRule),
      });
    }
    return out;
  },

  // --- BR-DEC-24 / BR-DEC-25 / BR-DEC-27 / BR-DEC-28 -----------------------
  (inv) => {
    const out: TeachingError[] = [];
    for (const tagged of lineAllowanceCharges(inv)) {
      const specs = LINE_DEC_SPECS[tagged.isCharge ? "charge" : "allowance"];
      for (const spec of specs) {
        const value = tagged.entry[spec.key];
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        const places = decimalPlaces(value);
        if (places <= 2) continue;
        const rounded = Math.round(value * 100) / 100;
        out.push({
          rule: spec.rule,
          field: spec.field,
          severity: "fatal",
          message: `The allowed maximum number of decimals for the ${spec.label} (${spec.field}) is 2, but ${tagged.path}.${spec.key} is ${value}, which has ${places}. The constraint is on the serialised value, so it is about what reaches the XML rather than about what your variable holds — and the line is where over-precision starts, since every document total downstream of it inherits the drift. ${spec.why}`,
          fix: `Round ${tagged.path}.${spec.key} to two decimals before assigning it (${rounded.toFixed(2)} here). Use half-up rounding away from zero — this package exports round2(), which handles the cases Math.round and toFixed get wrong.`,
          example: `"${spec.key}": ${rounded.toFixed(2)}`,
          xpath: `${tagged.xpath}/${spec.element}`,
          docsUrl: page(spec.rule),
        });
      }
    }
    return out;
  },

  // --- BR-CL-19 / BR-CL-20 at line level -----------------------------------
  (inv) => {
    const out: TeachingError[] = [];
    for (const tagged of lineAllowanceCharges(inv)) {
      const code = tagged.entry.reasonCode;
      if (blank(code)) continue; // BR-42 / BR-44 govern absence
      const value = String(code).trim();
      const kind = tagged.isCharge ? "charge" : "allowance";
      const spec = CODE_LIST_SPECS[kind];
      if (spec.set.has(value)) continue;
      const crossed = spec.otherSet.has(value);
      out.push({
        rule: spec.rule,
        field: tagged.isCharge ? "BT-145" : "BT-140",
        severity: "fatal",
        message: `${whereLine(tagged)} carries the reason code "${value}", which is not in ${spec.list} — the list ${spec.rule} admits for ${kind} reason codes at both line and document level.${crossed ? ` The code does exist in the ${spec.otherName} list, which is precisely the mistake this rule catches: allowance reason codes come from UNCL 5189 and charge reason codes from UNCL 7161, and the same string can appear in both meaning different things.` : ` Allowance reason codes come from UNCL 5189 and charge reason codes from UNCL 7161; the two lists are not interchangeable, so a code taken from the wrong one fails even when it reads plausibly.`} ${spec.scope}`,
        fix: `Set ${tagged.path}.reasonCode to a ${spec.list} code, or remove it and put a description in ${tagged.path}.reason — free text alone satisfies ${tagged.isCharge ? "BR-44 and BR-CO-24" : "BR-42 and BR-CO-23"}.`,
        example: tagged.isCharge
          ? `"charges": [{ "amount": 5.00, "reasonCode": "SH", "reason": "Handling" }]`
          : `"allowances": [{ "amount": 5.00, "reasonCode": "100", "reason": "Special agreement" }]`,
        xpath: `${tagged.xpath}/cbc:AllowanceChargeReasonCode`,
        docsUrl: page(spec.rule),
      });
    }
    return out;
  },
];

