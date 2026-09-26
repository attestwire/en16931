import { isCreditNote, xpathRoot } from "./document-type.js";
import { inferPaymentMeans, paymentMeansNote } from "./payment-means.js";
import { CATEGORY_NAMES, LIMITS_DOCS, blank } from "./rule-kit.js";
import type { RuleFn } from "./rule-kit.js";
import type { BusinessTerm, InvoiceFacts, InvoiceInput, TeachingError, VatScenario } from "./types.js";
import {
  TERMS,
  VAT_SCENARIOS,
  describeItems,
  isVatScenario,
  joinWords,
  planVatScenarios,
  scenarioNotes,
  scenarioPhrase,
  takesScenario,
  type ScenarioItem,
  type ScenarioPlan,
} from "./vat-scenarios.js";

/**
 * Findings about what the engine fills in from business facts (0.14.0).
 *
 * `runInputRules` runs these on the invoice as the caller stated it, and every
 * other rule on the explicit invoice the facts stand for (`applyDefaults`).
 * On an explicit invoice, which is what every other rule sees, all of them
 * return null: there is no `vatScenario` left to judge and no payment means
 * code left to infer. So a document read from XML, which carries neither gap,
 * is untouched by this file.
 *
 * All carry `ATW-` ids: they are this library's findings about its own input
 * model, not the regulator's. Where a scenario lacks a fact EN 16931 also
 * requires, the regulation's own finding (BR-IC-11, BR-AE-02, ...) fires on
 * the explicit invoice as well; the finding here adds what the regulation
 * cannot say, which is which scenario needed the fact and why.
 */

type Item = ScenarioItem;

const facts = (inv: InvoiceInput): InvoiceFacts => inv as unknown as InvoiceFacts;

/** "Line 2", "The document level charge at charges[0]". */
const label = (item: Item): string =>
  item.kind === "line"
    ? `Line ${item.index + 1}`
    : `The document level ${item.kind} at ${item.kind}s[${item.index}]`;

/** "lines[1]", "charges[0]": the path a fix names. */
const pathOf = (item: Item): string =>
  `${item.kind === "line" ? "lines" : `${item.kind}s`}[${item.index}]`;

/** The UBL element for a line's category or rate; undefined for allowances and charges. */
const lineXpath = (inv: InvoiceInput, item: Item, leaf: "cbc:ID" | "cbc:Percent"): string | undefined =>
  item.kind === "line"
    ? `${xpathRoot(inv)}/cac:${isCreditNote(inv) ? "CreditNoteLine" : "InvoiceLine"}[${item.index + 1}]/cac:Item/cac:ClassifiedTaxCategory/${leaf}`
    : undefined;

/** A value as a message quotes it. */
const quote = (value: unknown): string =>
  typeof value === "string"
    ? JSON.stringify(value)
    : value === null
      ? "null"
      : Array.isArray(value)
        ? "an array"
        : typeof value === "object"
          ? "an object"
          : String(value);

const SCENARIO_LIST = joinWords(VAT_SCENARIOS.map((s) => `"${s}"`));

/** Plain Levenshtein distance; the strings are a few dozen characters at most. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

/** The scenario a misspelt value most likely meant, if one is close. */
function closestScenario(value: unknown): VatScenario | undefined {
  if (typeof value !== "string") return undefined;
  const normalised = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (isVatScenario(normalised)) return normalised;
  let best: VatScenario | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const scenario of VAT_SCENARIOS) {
    const distance = editDistance(normalised, scenario);
    if (distance < bestDistance) {
      best = scenario;
      bestDistance = distance;
    }
  }
  return bestDistance <= 3 ? best : undefined;
}

// ---------------------------------------------------------------------------
// The facts each scenario needs
// ---------------------------------------------------------------------------

type FactKey =
  | "sellerVatId"
  | "sellerTaxId"
  | "buyerVatId"
  | "deliverToCountry"
  | "deliveryDateOrPeriod";

interface FactSpec {
  field: BusinessTerm | BusinessTerm[];
  /** What is missing, in words. */
  what: string;
  present: (inv: InvoiceFacts) => boolean;
  fix: string;
  example: string;
  /** Below the document root. */
  xpath: string;
}

const FACTS: Readonly<Record<FactKey, FactSpec>> = {
  sellerVatId: {
    field: ["BT-31", "BT-63"],
    what: "the seller's VAT identifier (BT-31), or its tax representative's (BT-63)",
    present: (inv) => !blank(inv.seller?.vatId) || !blank(inv.taxRepresentative?.vatId),
    fix: 'Set seller.vatId to your VAT identifier with its country prefix, e.g. "DE123456789". A tax number in seller.taxRegistrationId does not stand in for it here. If a fiscal representative holds your VAT registration, set taxRepresentative with its name, vatId and address instead.',
    example: `"seller": { "vatId": "DE123456789" }`,
    xpath: "/cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID",
  },
  sellerTaxId: {
    field: ["BT-31", "BT-32"],
    what: "a tax identifier for the seller, its VAT identifier (BT-31) or its tax registration number (BT-32)",
    present: (inv) =>
      !blank(inv.seller?.vatId) ||
      !blank(inv.seller?.taxRegistrationId) ||
      !blank(inv.taxRepresentative?.vatId),
    fix: 'Set seller.taxRegistrationId to your tax number (in Germany the Steuernummer, e.g. "181/815/08155"), or seller.vatId if you have a VAT identifier.',
    example: `"seller": { "taxRegistrationId": "181/815/08155" }`,
    xpath: "/cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID",
  },
  buyerVatId: {
    field: "BT-48",
    what: "the buyer's VAT identifier (BT-48)",
    present: (inv) => !blank(inv.buyer?.vatId),
    fix: "Set buyer.vatId to the customer's VAT identifier in its own member state, with the country prefix, and check it in VIES on the day you invoice.",
    example: `"buyer": { "vatId": "FR12345678901" }`,
    xpath: "/cac:AccountingCustomerParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID",
  },
  deliverToCountry: {
    field: "BT-80",
    what: "the country the goods were delivered to (BT-80)",
    present: (inv) => !blank(inv.deliverTo?.countryCode),
    fix: "Set deliverTo.countryCode to the member state the goods went to. Under XRechnung, deliverTo also needs city and postalCode (BR-DE-10, BR-DE-11).",
    example: `"deliverTo": { "city": "Lyon", "postalCode": "69001", "countryCode": "FR" }`,
    xpath: "/cac:Delivery/cac:DeliveryLocation/cac:Address/cac:Country/cbc:IdentificationCode",
  },
  deliveryDateOrPeriod: {
    field: ["BT-72", "BG-14"],
    what: "the actual delivery date (BT-72) or an invoicing period (BG-14)",
    present: (inv) =>
      !blank(inv.deliveryDate) ||
      !blank(inv.invoicingPeriod?.startDate) ||
      !blank(inv.invoicingPeriod?.endDate) ||
      !blank(inv.invoicingPeriod?.descriptionCode),
    fix: 'Set deliveryDate to the day the goods were dispatched, as "YYYY-MM-DD", or state the invoicing period the supplies fall in (invoicingPeriod.startDate and endDate).',
    example: `"deliveryDate": "2026-08-05"`,
    xpath: "/cac:Delivery/cbc:ActualDeliveryDate",
  },
};

/**
 * Which facts each scenario needs, and why, in the order they are reported.
 * `"domestic"` needs a rate per item instead, checked separately.
 */
const NEEDS: Readonly<Record<Exclude<VatScenario, "domestic">, readonly [FactKey, string][]>> = {
  "intra-eu-goods": [
    [
      "sellerVatId",
      "An intra-community supply is exempt only between two businesses registered for VAT in different member states, and the invoice has to show both numbers (Article 226(3) and (4) of Directive 2006/112/EC). EN 16931 asks for the same in BR-IC-02, which fires on this invoice too.",
    ],
    [
      "buyerVatId",
      "An intra-community supply is exempt only when the customer is registered for VAT in another member state, and its number is what the exemption, and your recapitulative statement, rest on (Article 226(4) of Directive 2006/112/EC). EN 16931 asks for it in BR-IC-02, which fires on this invoice too.",
    ],
    [
      "deliverToCountry",
      "The supply is exempt because the goods leave your member state, so the destination has to be on the invoice. EN 16931 asks for it in BR-IC-12, which fires on this invoice too.",
    ],
    [
      "deliveryDateOrPeriod",
      "The date decides the period in which you report the supply on your recapitulative statement. EN 16931 asks for it, or for an invoicing period, in BR-IC-11, which fires on this invoice too.",
    ],
  ],
  "intra-eu-services": [
    [
      "sellerVatId",
      "Under the reverse charge the customer accounts for the VAT, and the invoice has to show the VAT identifiers of both parties (Article 226(3) and (4) of Directive 2006/112/EC) so that each side can report the supply. EN 16931's BR-AE-02 would also accept a national tax number here; the scenario asks for what the Directive requires.",
    ],
    [
      "buyerVatId",
      "Under the reverse charge the customer accounts for the VAT, and its VAT identifier is what shows it is a business that can (Article 226(4) of Directive 2006/112/EC); you also report it on your recapitulative statement. EN 16931's BR-AE-02 would also accept a legal registration number here; the scenario asks for what the Directive requires.",
    ],
  ],
  export: [
    [
      "sellerVatId",
      "Export zero-rating is claimed under a VAT registration, and the customs evidence is matched against it. EN 16931 asks for it in BR-G-02, which fires on this invoice too.",
    ],
  ],
  "small-business-exemption": [
    [
      "sellerTaxId",
      "EN 16931 requires an invoice with exempt lines to identify the seller for tax (BR-E-02, which fires on this invoice too), and a small business has a tax number even when it has no VAT identifier.",
    ],
  ],
};

/** The rule a standard-rated item with no rate fails, per kind. */
const RATE_RULE: Readonly<Record<Item["kind"], string>> = {
  line: "BR-S-05",
  allowance: "BR-S-06",
  charge: "BR-S-07",
};

/** The items a known scenario's codes go on, grouped by scenario. */
const activeItems = (plan: ScenarioPlan, scenario: VatScenario): Item[] =>
  plan.items.filter((item) => item.scenario === scenario && takesScenario(item));

const planOf = (inv: InvoiceInput): ScenarioPlan | null => {
  const plan = planVatScenarios(inv);
  return plan.present ? plan : null;
};

export const defaultsRules: RuleFn[] = [
  // ATW-VAT-SCENARIO-UNKNOWN: not one of the five.
  //
  // A typo here is silent in the worst way: the line simply has no category,
  // and BR-CO-04 then says "no VAT category" about a line whose author was
  // sure they had given one.
  (inv) => {
    const plan = planOf(inv);
    if (!plan) return null;
    const out: TeachingError[] = [];
    const inheritors = plan.items.filter((item) => item.inherited && item.outcome === "unknown");
    const invoiceScenario = plan.invoiceScenario;
    if (invoiceScenario !== undefined && invoiceScenario !== null && !isVatScenario(invoiceScenario)) {
      const guess = closestScenario(invoiceScenario);
      out.push({
        rule: "ATW-VAT-SCENARIO-UNKNOWN",
        field: "BT-151",
        severity: "fatal",
        message: `The invoice states vatScenario ${quote(invoiceScenario)}, which is not one of the five scenarios this build knows: ${SCENARIO_LIST}. Nothing was filled in from it${
          inheritors.length > 0
            ? `, so ${describeItems(inheritors)}, which rely on it, have no VAT category`
            : "; every line states its own category or scenario, so nothing depends on it, but it is still a mistake in the input"
        }.`,
        fix: `${guess ? `Did you mean "${guess}"? ` : ""}Set vatScenario to one of the five, or remove it and state vatCategory (and vatRate) on each line.`,
        example: `"vatScenario": "${guess ?? "domestic"}"`,
        docsUrl: LIMITS_DOCS,
      });
    }
    for (const item of plan.items) {
      if (item.inherited || item.outcome !== "unknown") continue;
      const guess = closestScenario(item.scenario);
      out.push({
        rule: "ATW-VAT-SCENARIO-UNKNOWN",
        field: TERMS[item.kind].category,
        severity: "fatal",
        message: `${label(item)} states vatScenario ${quote(item.scenario)}, which is not one of the five scenarios this build knows: ${SCENARIO_LIST}. Nothing was filled in from it, ${
          item.stated === undefined
            ? `so the ${item.kind} has no VAT category`
            : `so the ${item.kind} keeps its own vatCategory ${quote(item.stated)} and nothing else`
        }.`,
        fix: `${guess ? `Did you mean "${guess}"? ` : ""}Set ${pathOf(item)}.vatScenario to one of the five, or remove it and state vatCategory (and vatRate) yourself.`,
        example: `"vatScenario": "${guess ?? "domestic"}"`,
        ...(lineXpath(inv, item, "cbc:ID") ? { xpath: lineXpath(inv, item, "cbc:ID") } : {}),
        docsUrl: LIMITS_DOCS,
      });
    }
    return out;
  },

  // ATW-VAT-SCENARIO-CONFLICT: an item's own scenario and its own category
  // disagree.
  //
  // Explicit values win over scenarios, so the category would be written and
  // the scenario ignored. When both are stated on the same item one of them
  // is a mistake, and nothing downstream can tell which: a reverse-charge
  // service written as standard rated is a valid document that charges the
  // wrong party. So this is fatal. An *inherited* scenario is different: the
  // invoice's default fills gaps, and an item that states a category has none.
  (inv) => {
    const plan = planOf(inv);
    if (!plan) return null;
    const out: TeachingError[] = [];
    for (const item of plan.items) {
      if (item.outcome !== "conflict" || item.category === undefined) continue;
      const scenario = item.scenario as VatScenario;
      out.push({
        rule: "ATW-VAT-SCENARIO-CONFLICT",
        field: TERMS[item.kind].category,
        severity: "fatal",
        message: `${label(item)} states vatScenario "${scenario}", which stands for VAT category ${item.category} (${CATEGORY_NAMES[item.category]}), and also vatCategory ${quote(item.stated)}. The scenario says what happened and the category is its code, so one of the two is wrong. An explicit category wins over a scenario, so the document would say ${quote(item.stated)} and nothing from the scenario would be written.`,
        fix: `Remove one of the two from ${pathOf(item)}: drop vatCategory to let the scenario decide the code, or drop vatScenario if ${quote(item.stated)} is what you meant.`,
        example: `"vatScenario": "${scenario}"`,
        ...(lineXpath(inv, item, "cbc:ID") ? { xpath: lineXpath(inv, item, "cbc:ID") } : {}),
        docsUrl: LIMITS_DOCS,
      });
    }
    return out;
  },

  // ATW-VAT-SCENARIO-UNSUPPORTED: a small-business exemption this build does
  // not know. Every member state runs its own scheme with its own wording, and
  // the two implemented here were each settled from the tax authority's own
  // texts (vat-scenarios.ts). A seller with no country at all is a missing
  // fact rather than an unsupported one.
  (inv) => {
    const plan = planOf(inv);
    if (!plan) return null;
    const items = plan.items.filter((item) => item.outcome === "unsupported");
    if (items.length === 0) return null;
    const root = xpathRoot(inv);
    if (plan.sellerCountry === "") {
      return {
        rule: "ATW-VAT-SCENARIO-FACT-MISSING",
        field: "BT-40",
        severity: "fatal",
        message: `vatScenario "small-business-exemption" on ${describeItems(items)} depends on where the seller is established, and the invoice states no seller country (BT-40). Each member state runs its own small-business scheme, with its own wording and, in an e-invoice, its own exemption code, so nothing was filled in.`,
        fix: 'Set seller.address.countryCode, e.g. "DE" or "FR". The scenario is implemented for sellers in Germany (§ 19 UStG) and France (franchise en base).',
        example: `"seller": { "address": { "city": "Berlin", "postalCode": "10115", "countryCode": "DE" } }`,
        xpath: `${root}/cac:AccountingSupplierParty/cac:Party/cac:PostalAddress/cac:Country/cbc:IdentificationCode`,
        docsUrl: LIMITS_DOCS,
      };
    }
    return {
      rule: "ATW-VAT-SCENARIO-UNSUPPORTED",
      field: ["BT-40", "BT-151"],
      severity: "fatal",
      message: `vatScenario "small-business-exemption" on ${describeItems(items)} is implemented for sellers established in Germany (§ 19 UStG) and France (the franchise en base, article 293 B du CGI), and the seller's country (BT-40) is ${quote(plan.sellerCountry)}. Each member state runs its own small-business scheme, with its own invoice wording and, in an e-invoice, its own exemption code, and this build does not guess them. Nothing was filled in.`,
      fix: "State the codes yourself and remove vatScenario: usually vatCategory \"E\" with vatRate 0, and the wording your country's scheme requires in vatExemptionReasons.E. If the seller is in fact established in Germany or France, correct seller.address.countryCode instead.",
      example: `"vatCategory": "E", "vatRate": 0`,
      xpath: `${root}/cac:AccountingSupplierParty/cac:Party/cac:PostalAddress/cac:Country/cbc:IdentificationCode`,
      docsUrl: LIMITS_DOCS,
    };
  },

  // ATW-VAT-SCENARIO-FACT-MISSING: a scenario whose treatment is lawful only
  // with a fact the invoice does not state. Each finding names the scenario
  // and the one field, because "report exactly what is missing" is the whole
  // value over the regulation's own finding, which cannot name a scenario.
  (inv) => {
    const plan = planOf(inv);
    if (!plan) return null;
    const stated = facts(inv);
    const root = xpathRoot(inv);
    const out: TeachingError[] = [];
    for (const item of activeItems(plan, "domestic")) {
      const list = item.kind === "line" ? stated.lines : item.kind === "allowance" ? stated.allowances : stated.charges;
      const entry = Array.isArray(list) ? (list[item.index] as { vatRate?: unknown } | undefined) : undefined;
      if (entry?.vatRate !== undefined && entry.vatRate !== null) continue;
      const term = TERMS[item.kind].rate;
      const xpath = lineXpath(inv, item, "cbc:Percent");
      out.push({
        rule: "ATW-VAT-SCENARIO-FACT-MISSING",
        field: term,
        severity: "fatal",
        message: `${label(item)} follows vatScenario "domestic"${item.inherited ? ", the invoice's," : ""} and states no vatRate. A domestic supply is taxed at the standard rate or at a reduced one, and which applies depends on what was sold, so the rate (${term}) is never guessed: it has to come from you. Without it the ${item.kind} is standard rated with no rate, which EN 16931 rejects (${RATE_RULE[item.kind]}).`,
        fix: `Set ${pathOf(item)}.vatRate to the percentage that applies to it, for example 19 or 7 in Germany, or 20, 10 or 5.5 in France.`,
        example: `"vatScenario": "domestic", "vatRate": 19`,
        ...(xpath ? { xpath } : {}),
        docsUrl: LIMITS_DOCS,
      });
    }
    for (const scenario of VAT_SCENARIOS) {
      if (scenario === "domestic") continue;
      const items = activeItems(plan, scenario);
      if (items.length === 0) continue;
      for (const [key, why] of NEEDS[scenario]) {
        const fact = FACTS[key];
        if (fact.present(stated)) continue;
        out.push({
          rule: "ATW-VAT-SCENARIO-FACT-MISSING",
          field: fact.field,
          severity: "fatal",
          message: `${scenarioPhrase(scenario, plan.sellerCountry)} on ${describeItems(items)} needs ${fact.what}, and the invoice has none. ${why}`,
          fix: fact.fix,
          example: fact.example,
          xpath: `${root}${fact.xpath}`,
          docsUrl: LIMITS_DOCS,
        });
      }
    }
    return out;
  },

  // ATW-VAT-SCENARIO-APPLIED: what the scenarios filled in, one note per
  // scenario. `information`, the level KoSIT uses for a finding the document
  // passes with: the invoice is fine, and this says what it now contains.
  (inv) => {
    const plan = planOf(inv);
    return plan ? scenarioNotes(inv, plan) : null;
  },

  // ATW-PAYMENT-MEANS-INFERRED: a payment means code filled in from the
  // account, because the caller left it out. Only an absent code is inferred,
  // and a document read from XML always carries one (empty when the file has
  // none), so this never fires on `validate()`.
  (inv) => {
    const inference = inferPaymentMeans(inv);
    return inference ? paymentMeansNote(inv, inference) : null;
  },
];
