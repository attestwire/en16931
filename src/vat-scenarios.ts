import type {
  AppliedDefaults,
  InvoiceFacts,
  InvoiceInput,
  TeachingError,
  VatCategory,
  VatScenario,
} from "./types.js";

/**
 * VAT scenarios: the business fact in, the EN 16931 codes out.
 *
 * VAT category and exemption logic is a recurring theme in the CEN and KoSIT
 * rule trackers, and the reason is that the input asks the wrong question. A
 * developer knows that the customer is a business in France; the standard
 * wants `AE`, `VATEX-EU-AE` and "Autoliquidation", and the rules that check
 * them (BR-AE-02, -05, -10) only say afterwards which of the three was wrong. A scenario is asked for instead, and everything below derives the
 * codes from it. `validateInput` and both generators run this first, so a
 * scenario and the codes it stands for produce the same document, byte for
 * byte.
 *
 * Nothing here is a tax engine. The caller decides which scenario applies;
 * this module only refuses to let a correct decision be encoded wrongly.
 * Rates are never guessed: `"domestic"` takes the caller's rate or reports
 * that there is none.
 *
 * WHERE EACH CODE AND TEXT COMES FROM
 *
 * Cross-border scenarios (the codes are the CEF VATEX list's own, and its
 * descriptions say "Only use with VAT category code AE / K / G"):
 *   - Reverse charge: "Reverse charge" is the mention Article 226(11a) of
 *     Directive 2006/112/EC prescribes; "Steuerschuldnerschaft des
 *     Leistungsempfängers" is § 14a Abs. 5 UStG's; "Autoliquidation" is
 *     article 242 nonies A, I-13° of annexe II to the CGI.
 *   - Intra-community supply and export: an exempt supply's invoice has to
 *     say that it is exempt (§ 14 Abs. 4 Satz 1 Nr. 8 UStG) or cite the
 *     exempting provision (article 242 nonies A, I-12° annexe II CGI:
 *     article 262 ter I for intra-community supplies, 262 I for exports). The
 *     English texts are the standard ones BR-IC-10 and BR-G-10 name, and the
 *     same as `DEFAULT_EXEMPTION_REASONS`.
 *
 * Small-business exemption, established 2026-09-25 (the README's "Say what
 * happened, not the code" section records the same):
 *   - Germany. Category E, rate 0, no BT-121 code, because the VATEX list has
 *     no German code. Category E is KoSIT's own answer: XRechnung change
 *     request #32, implemented in XRechnung 1.2, specifies BT-118 "E", BT-119
 *     0 and a BT-120 text for § 19 UStG
 *     (https://projekte.kosit.org/xrechnung/xrechnung/-/issues/32). Since
 *     1 January 2025 § 19 Abs. 1 UStG says outright that the turnover "ist
 *     steuerfrei", so E (exempt) is also what the law says. The text follows
 *     the most authoritative source on invoice wording rather than KoSIT's
 *     2018 wording ("Kein Ausweis von Umsatzsteuer, da Kleinunternehmer gemäß
 *     § 19 UStG") or the common "Gemäß § 19 UStG wird keine Umsatzsteuer
 *     berechnet.", both written for the old regime, in which the tax was
 *     merely not levied: § 34a Satz 1 Nr. 5 UStDV requires a note "dass für
 *     die Lieferung oder sonstige Leistung die Steuerbefreiung für
 *     Kleinunternehmer gilt", and the BMF letter of 18 March 2025 (III C 3 -
 *     S 7360/00027/044/105, UStAE 14.7a Abs. 1) accepts any wording that
 *     names that exemption unambiguously. The text below names it in the
 *     regulation's own words.
 *   - France. Category E, `VATEX-FR-FRANCHISE` ("France domestic VAT franchise
 *     in base" in the CEF VATEX list, which this build ships for BR-CL-22),
 *     and the mention BOFiP BOI-TVA-DECLA-40-10-20 § 50 prescribes, "TVA non
 *     applicable, article 293 B du CGI". No French rule ties the code to a
 *     category (the FNFE-MPE BR-FR schematrons do not mention it), so EN
 *     16931 decides: BR-Z-10 forbids any exemption reason on Z, and BR-O-10
 *     requires O's to mean "not subject to VAT", which leaves E. One vendor's
 *     documentation maps the franchise to Z; carrying the code there fails
 *     BR-Z-10, so that is not followed.
 *   - Anywhere else: refused with `ATW-VAT-SCENARIO-UNSUPPORTED`, because each
 *     member state's scheme has its own wording, and guessing it is how a
 *     wrong invoice gets written with confidence.
 */

/** The five scenarios, in the order the README lists them. */
export const VAT_SCENARIOS: readonly VatScenario[] = Object.freeze([
  "domestic",
  "intra-eu-goods",
  "intra-eu-services",
  "export",
  "small-business-exemption",
] as const);

const SCENARIO_SET: ReadonlySet<string> = new Set(VAT_SCENARIOS);

/** True for one of the five scenario names, exactly as written. */
export const isVatScenario = (value: unknown): value is VatScenario =>
  typeof value === "string" && SCENARIO_SET.has(value);

/** The VAT category each scenario stands for. */
export const SCENARIO_CATEGORY: Readonly<Record<VatScenario, VatCategory>> = {
  domestic: "S",
  "intra-eu-goods": "K",
  "intra-eu-services": "AE",
  export: "G",
  "small-business-exemption": "E",
};

/** What each scenario means, for messages. */
export const SCENARIO_MEANING: Readonly<Record<VatScenario, string>> = {
  domestic: "a taxed supply inside the seller's own country",
  "intra-eu-goods": "goods sent to a VAT-registered business in another EU member state",
  "intra-eu-services":
    "a service to a business in another EU member state, which accounts for the VAT itself",
  export: "goods leaving the EU",
  "small-business-exemption": "the seller's small-business exemption",
};

/**
 * Categories whose rate is fixed at zero (BR-IC-05, BR-AE-05, BR-G-05,
 * BR-E-05). A scenario for one of them writes `vatRate: 0` when the item
 * states none; a stated rate is kept, and the `-05` rule judges it.
 */
const ZERO_RATED: ReadonlySet<VatCategory> = new Set(["K", "AE", "G", "E"]);

/** The language an exemption text is written in. */
export type ScenarioLanguage = "de" | "fr" | "en";

/** German for a seller in DE or AT, French for FR, English otherwise. */
export const scenarioLanguage = (sellerCountry: string): ScenarioLanguage =>
  sellerCountry === "DE" || sellerCountry === "AT"
    ? "de"
    : sellerCountry === "FR"
      ? "fr"
      : "en";

export const LANGUAGE_NAMES: Readonly<Record<ScenarioLanguage, string>> = {
  de: "German",
  fr: "French",
  en: "English",
};

/** A BT-121 code and a BT-120 text for one breakdown group. */
export interface ScenarioExemption {
  /** BT-121, from the CEF VATEX list. Absent where the list has none. */
  code?: string;
  /** BT-120. */
  text: string;
}

/** The three cross-border scenarios' codes and texts. Sources: module comment. */
const CROSS_BORDER: Readonly<
  Record<
    "intra-eu-goods" | "intra-eu-services" | "export",
    { code: string; text: Readonly<Record<ScenarioLanguage, string>> }
  >
> = {
  "intra-eu-goods": {
    code: "VATEX-EU-IC",
    text: {
      en: "Intra-Community supply",
      de: "Steuerfreie innergemeinschaftliche Lieferung",
      fr: "Exonération de TVA, article 262 ter I du CGI",
    },
  },
  "intra-eu-services": {
    code: "VATEX-EU-AE",
    text: {
      en: "Reverse charge",
      de: "Steuerschuldnerschaft des Leistungsempfängers",
      fr: "Autoliquidation",
    },
  },
  export: {
    code: "VATEX-EU-G",
    text: {
      en: "Export outside the EU",
      de: "Steuerfreie Ausfuhrlieferung",
      fr: "Exonération de TVA, article 262 I du CGI",
    },
  },
};

/**
 * The small-business exemptions this build implements, by the seller's
 * country (BT-40). Sources and the reasoning behind each: module comment.
 */
export const SMALL_BUSINESS_EXEMPTIONS: Readonly<
  Record<string, ScenarioExemption & { scheme: string }>
> = {
  DE: {
    text: "Steuerbefreiung für Kleinunternehmer gemäß § 19 UStG",
    scheme: "§ 19 UStG",
  },
  FR: {
    code: "VATEX-FR-FRANCHISE",
    text: "TVA non applicable, article 293 B du CGI",
    scheme: "the franchise en base, article 293 B du CGI",
  },
};

/**
 * The exemption a scenario states for a seller in `sellerCountry`.
 * Undefined for `"domestic"`, whose category S carries none (BR-S-10), and for
 * a small business outside the countries above.
 */
export function scenarioExemption(
  scenario: VatScenario,
  sellerCountry: string,
): ScenarioExemption | undefined {
  if (scenario === "domestic") return undefined;
  if (scenario === "small-business-exemption") {
    const exemption = SMALL_BUSINESS_EXEMPTIONS[sellerCountry];
    if (!exemption) return undefined;
    return exemption.code === undefined
      ? { text: exemption.text }
      : { code: exemption.code, text: exemption.text };
  }
  const entry = CROSS_BORDER[scenario];
  return { code: entry.code, text: entry.text[scenarioLanguage(sellerCountry)] };
}

// ---------------------------------------------------------------------------
// The plan: what the scenarios say about each item, before anything is written
// ---------------------------------------------------------------------------

/** Which list an item sits in. */
export type ScenarioItemKind = "line" | "allowance" | "charge";

/**
 * What became of one item's scenario.
 *
 * - `applied`: the item stated no category, and the scenario supplied it.
 * - `agrees`: the item stated the category the scenario stands for.
 * - `conflict`: the item's own scenario and its own category disagree. Fatal.
 * - `overridden`: the scenario is the invoice's default and the item states
 *   another category. The item's category wins; a default fills gaps only.
 * - `unknown`: not one of the five scenarios.
 * - `unsupported`: `"small-business-exemption"` for a seller outside DE and FR.
 */
export type ScenarioOutcome =
  | "applied"
  | "agrees"
  | "conflict"
  | "overridden"
  | "unknown"
  | "unsupported";

/** One line, allowance or charge a scenario reaches. */
export interface ScenarioItem {
  kind: ScenarioItemKind;
  /** Index in `lines`, `allowances` or `charges`. */
  index: number;
  /** The scenario as stated: the item's own, or the invoice's. */
  scenario: unknown;
  /** True when it is the invoice's `vatScenario`. */
  inherited: boolean;
  outcome: ScenarioOutcome;
  /** The category a known scenario stands for. */
  category?: VatCategory;
  /** The item's own `vatCategory`, when it states one. */
  stated?: unknown;
  /** True when the scenario writes `vatRate: 0` because the item states none. */
  rateFilled: boolean;
}

/** What a scenario writes into one category's BT-121 and BT-120. */
export interface ExemptionFill {
  code?: string;
  text?: string;
}

/** Everything the scenarios on one invoice amount to. Pure data. */
export interface ScenarioPlan {
  /** False when nothing carries a `vatScenario`: the input is already explicit. */
  present: boolean;
  /** The invoice-level `vatScenario`, as stated. */
  invoiceScenario: unknown;
  /** BT-40, trimmed and upper-cased; empty when absent. */
  sellerCountry: string;
  language: ScenarioLanguage;
  items: ScenarioItem[];
  /** Per category, the exemption code and text the scenarios fill in. */
  fills: Partial<Record<VatCategory, ExemptionFill>>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Null and undefined both mean "not stated", as JSON callers use them. */
const stated = (value: unknown): boolean => value !== undefined && value !== null;

const carriesScenario = (entry: unknown): boolean =>
  isObject(entry) && entry.vatScenario !== undefined;

/** True when the input, one of its lines or one of its allowances or charges carries `vatScenario`. */
export function hasVatScenario(input: unknown): boolean {
  if (!isObject(input)) return false;
  if (input.vatScenario !== undefined) return true;
  for (const list of [input.lines, input.allowances, input.charges]) {
    if (Array.isArray(list) && list.some(carriesScenario)) return true;
  }
  return false;
}

export const normaliseCountry = (value: unknown): string =>
  typeof value === "string" ? value.trim().toUpperCase() : "";

/**
 * Work out what the scenarios on this input say, item by item, without writing
 * anything. Never throws: anything that is not the shape it expects is left
 * for the rules to report.
 */
export function planVatScenarios(input: InvoiceInput | InvoiceFacts): ScenarioPlan {
  const facts = input as Partial<InvoiceFacts> | null | undefined;
  const sellerCountry = normaliseCountry(facts?.seller?.address?.countryCode);
  const plan: ScenarioPlan = {
    present: hasVatScenario(facts),
    invoiceScenario: isObject(facts) ? facts.vatScenario : undefined,
    sellerCountry,
    language: scenarioLanguage(sellerCountry),
    items: [],
    fills: {},
  };
  if (!plan.present || !isObject(facts)) return plan;

  const invoiceGiven = stated(plan.invoiceScenario);
  const lists: [ScenarioItemKind, unknown][] = [
    ["line", facts.lines],
    ["allowance", facts.allowances],
    ["charge", facts.charges],
  ];
  for (const [kind, list] of lists) {
    if (!Array.isArray(list)) continue;
    list.forEach((entry: unknown, index) => {
      if (!isObject(entry)) return;
      const ownGiven = stated(entry.vatScenario);
      if (!ownGiven && !invoiceGiven) return;
      const scenario = ownGiven ? entry.vatScenario : plan.invoiceScenario;
      const item: ScenarioItem = {
        kind,
        index,
        scenario,
        inherited: !ownGiven,
        outcome: "unknown",
        rateFilled: false,
      };
      const statedCategory = entry.vatCategory;
      if (stated(statedCategory)) item.stated = statedCategory;
      if (isVatScenario(scenario)) {
        const category = SCENARIO_CATEGORY[scenario];
        item.category = category;
        if (
          scenario === "small-business-exemption" &&
          SMALL_BUSINESS_EXEMPTIONS[sellerCountry] === undefined
        ) {
          item.outcome = "unsupported";
        } else if (!stated(statedCategory)) {
          item.outcome = "applied";
        } else if (statedCategory === category) {
          item.outcome = "agrees";
        } else {
          item.outcome = item.inherited ? "overridden" : "conflict";
        }
        if (
          (item.outcome === "applied" || item.outcome === "agrees") &&
          ZERO_RATED.has(category) &&
          entry.vatRate === undefined
        ) {
          item.rateFilled = true;
        }
      }
      plan.items.push(item);
    });
  }

  // BT-120 and BT-121 are per breakdown group, that is per category, so a
  // category's exemption is filled once, from the scenario that produced it.
  // Each half is filled only where the caller left it out: a stated code or
  // text always wins. A stated code other than the scenario's means the caller
  // has a different exemption in mind, so the scenario's text is not put
  // beside it either.
  const codes = facts.vatExemptionReasonCodes as unknown;
  const texts = facts.vatExemptionReasons as unknown;
  const codesWritable = codes === undefined || isObject(codes);
  const textsWritable = texts === undefined || isObject(texts);
  for (const item of plan.items) {
    if (item.outcome !== "applied" && item.outcome !== "agrees") continue;
    const category = item.category as VatCategory;
    if (category in plan.fills) continue;
    const exemption = scenarioExemption(item.scenario as VatScenario, sellerCountry);
    if (!exemption) continue;
    const statedCode = isObject(codes) ? codes[category] : undefined;
    const statedText = isObject(texts) ? texts[category] : undefined;
    const fill: ExemptionFill = {};
    if (exemption.code !== undefined && statedCode === undefined && codesWritable) {
      fill.code = exemption.code;
    }
    const codeAgrees =
      statedCode === undefined ||
      (typeof statedCode === "string" &&
        exemption.code !== undefined &&
        statedCode.trim().toUpperCase() === exemption.code);
    if (statedText === undefined && codeAgrees && textsWritable) fill.text = exemption.text;
    if (fill.code !== undefined || fill.text !== undefined) plan.fills[category] = fill;
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Writing the explicit invoice
// ---------------------------------------------------------------------------

const itemKey = (kind: ScenarioItemKind, index: number) => `${kind}:${index}`;

/** True when the scenario's codes go on this item. */
export const takesScenario = (item: ScenarioItem): boolean =>
  item.outcome === "applied" || item.outcome === "agrees";

function rewriteEntry(entry: unknown, item: ScenarioItem | undefined): unknown {
  if (!isObject(entry)) return entry;
  if (entry.vatScenario === undefined && (!item || !takesScenario(item))) return entry;
  const { vatScenario: _dropped, ...rest } = entry;
  if (!item || !takesScenario(item)) return rest;
  const next: Record<string, unknown> = { ...rest, vatCategory: item.category };
  if (item.rateFilled) next.vatRate = 0;
  return next;
}

/** The input with the plan written into it. The same object when there is nothing to write. */
export function explicitInvoice(
  input: InvoiceInput | InvoiceFacts,
  plan: ScenarioPlan,
): InvoiceInput {
  if (!plan.present || !isObject(input)) return input as InvoiceInput;
  const facts = input as InvoiceFacts;
  const items = new Map(plan.items.map((item) => [itemKey(item.kind, item.index), item]));
  const rewrite = (kind: ScenarioItemKind, list: unknown) =>
    Array.isArray(list)
      ? list.map((entry: unknown, index) => rewriteEntry(entry, items.get(itemKey(kind, index))))
      : list;

  const { vatScenario: _dropped, ...rest } = facts;
  const out: Record<string, unknown> = { ...rest, lines: rewrite("line", facts.lines) };
  if (facts.allowances !== undefined) out.allowances = rewrite("allowance", facts.allowances);
  if (facts.charges !== undefined) out.charges = rewrite("charge", facts.charges);

  const codes: Record<string, string> = {};
  const texts: Record<string, string> = {};
  for (const [category, fill] of Object.entries(plan.fills)) {
    if (fill?.code !== undefined) codes[category] = fill.code;
    if (fill?.text !== undefined) texts[category] = fill.text;
  }
  if (Object.keys(codes).length > 0) {
    out.vatExemptionReasonCodes = { ...facts.vatExemptionReasonCodes, ...codes };
  }
  if (Object.keys(texts).length > 0) {
    out.vatExemptionReasons = { ...facts.vatExemptionReasons, ...texts };
  }
  return out as unknown as InvoiceInput;
}

/**
 * The explicit invoice a scenario input stands for, and nothing else. This is
 * what the generators call: the same writing as `applyVatScenarios`, without
 * building the notes they would throw away.
 */
export function expandVatScenarios(input: InvoiceInput | InvoiceFacts): InvoiceInput {
  if (!hasVatScenario(input)) return input as InvoiceInput;
  return explicitInvoice(input, planVatScenarios(input));
}

// ---------------------------------------------------------------------------
// Notes: what was filled in, as `information` findings
// ---------------------------------------------------------------------------

const LIMITS_DOCS = "https://github.com/attestwire/en16931#not-implemented-yet";

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  S: "standard rated",
  K: "intra-community supply",
  AE: "reverse charge",
  G: "export outside the EU",
  E: "exempt from VAT",
};

/** "a", "a and b", "a, b and c". */
export const joinWords = (words: readonly string[]): string =>
  words.length <= 1
    ? words.join("")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

/** "line 1", "lines 1 and 2", "the document level charge charges[0]", joined. */
export function describeItems(items: readonly ScenarioItem[]): string {
  const parts: string[] = [];
  const lines = items.filter((item) => item.kind === "line").map((item) => String(item.index + 1));
  if (lines.length > 0) parts.push(`${lines.length === 1 ? "line" : "lines"} ${joinWords(lines)}`);
  for (const kind of ["allowance", "charge"] as const) {
    const paths = items
      .filter((item) => item.kind === kind)
      .map((item) => `${kind}s[${item.index}]`);
    if (paths.length > 0) {
      parts.push(`the document level ${kind}${paths.length === 1 ? "" : "s"} ${joinWords(paths)}`);
    }
  }
  return joinWords(parts);
}

/** The business terms for an item's category and rate. */
export const TERMS: Readonly<
  Record<ScenarioItemKind, { category: `BT-${number}`; rate: `BT-${number}` }>
> = {
  line: { category: "BT-151", rate: "BT-152" },
  allowance: { category: "BT-95", rate: "BT-96" },
  charge: { category: "BT-102", rate: "BT-103" },
};

/** "vatScenario "x" (what it means)", naming the scheme for a small business. */
export function scenarioPhrase(scenario: VatScenario, sellerCountry: string): string {
  const scheme = SMALL_BUSINESS_EXEMPTIONS[sellerCountry]?.scheme;
  const meaning =
    scenario === "small-business-exemption" && scheme
      ? `${SCENARIO_MEANING[scenario]}, ${scheme}`
      : SCENARIO_MEANING[scenario];
  return `vatScenario "${scenario}" (${meaning})`;
}

/**
 * One `ATW-VAT-SCENARIO-APPLIED` note per scenario that filled anything in,
 * listing each field it filled. `validateInput` reports the same notes as
 * `information`, which never affects `valid`.
 */
export function scenarioNotes(
  input: InvoiceInput | InvoiceFacts,
  plan: ScenarioPlan,
): TeachingError[] {
  if (!plan.present) return [];
  const notes: TeachingError[] = [];
  for (const scenario of VAT_SCENARIOS) {
    const active = plan.items.filter((item) => item.scenario === scenario && takesScenario(item));
    if (active.length === 0) continue;
    const category = SCENARIO_CATEGORY[scenario];
    const categoryFilled = active.filter((item) => item.outcome === "applied");
    const rateFilled = active.filter((item) => item.rateFilled);
    const fill = plan.fills[category];
    if (categoryFilled.length === 0 && rateFilled.length === 0 && !fill) continue;

    const filled: string[] = [];
    const fields = new Set<`BT-${number}`>();
    // Category and rate on the same items read as one clause, which is the
    // ordinary case: an item that states neither gets both.
    const together =
      categoryFilled.length > 0 &&
      categoryFilled.length === rateFilled.length &&
      categoryFilled.every((item) => item.rateFilled);
    if (categoryFilled.length > 0) {
      filled.push(
        `vatCategory "${category}" (${CATEGORY_LABELS[category]})${together ? " and vatRate 0" : ""} on ${describeItems(categoryFilled)}${
          scenario === "domestic" ? ", at the rate each states" : ""
        }`,
      );
      for (const item of categoryFilled) fields.add(TERMS[item.kind].category);
    }
    if (rateFilled.length > 0) {
      if (!together) filled.push(`vatRate 0 on ${describeItems(rateFilled)}`);
      for (const item of rateFilled) fields.add(TERMS[item.kind].rate);
    }
    if (fill?.code !== undefined) {
      filled.push(`vatExemptionReasonCodes.${category} "${fill.code}" (BT-121)`);
      fields.add("BT-121");
    }
    if (fill?.text !== undefined) {
      filled.push(`vatExemptionReasons.${category} "${fill.text}" (BT-120)`);
      fields.add("BT-120");
    }
    const language =
      fill?.text === undefined
        ? ""
        : ` The text is in ${LANGUAGE_NAMES[plan.language]} because ${
            plan.sellerCountry === ""
              ? "the invoice states no seller country (BT-40)"
              : `the seller's country (BT-40) is ${plan.sellerCountry}`
          }${plan.language === "en" ? "; German is used for DE and AT, French for FR" : ""}.`;

    const exampleParts = [`"vatCategory": "${category}"`];
    if (rateFilled.length > 0) exampleParts.push(`"vatRate": 0`);
    const example = [
      ...exampleParts,
      ...(fill?.code === undefined ? [] : [`"vatExemptionReasonCodes": { "${category}": "${fill.code}" }`]),
      ...(fill?.text === undefined ? [] : [`"vatExemptionReasons": { "${category}": "${fill.text}" }`]),
    ].join(", ");

    notes.push({
      rule: "ATW-VAT-SCENARIO-APPLIED",
      field: [...fields],
      severity: "information",
      message: `${scenarioPhrase(scenario, plan.sellerCountry)} was turned into codes. Filled in: ${joinWords(filled)}.${language} These are the codes validateInput judged and the generators write, and applyVatScenarios returns them as an explicit invoice.`,
      fix: `Nothing needs fixing. To write something else, state it yourself: an explicit vatCategory, vatRate, vatExemptionReasons.${category} or vatExemptionReasonCodes.${category} always wins over a scenario.`,
      example,
      docsUrl: LIMITS_DOCS,
    });
  }
  return notes;
}

/**
 * Turn every `vatScenario` into the codes it stands for.
 *
 * Returns the explicit invoice, with no `vatScenario` left in it, and one
 * `information` note (`ATW-VAT-SCENARIO-APPLIED`) per scenario that filled
 * anything in. Pure: the input is not modified, and an input with no
 * `vatScenario` anywhere comes back as the very same object with no notes.
 *
 * What each scenario fills, where the item does not state it already:
 *
 * | scenario | category | rate | BT-121 | BT-120 |
 * |---|---|---|---|---|
 * | `"domestic"` | S | yours; never guessed | — | — |
 * | `"intra-eu-goods"` | K | 0 | VATEX-EU-IC | e.g. "Intra-Community supply" |
 * | `"intra-eu-services"` | AE | 0 | VATEX-EU-AE | e.g. "Reverse charge" |
 * | `"export"` | G | 0 | VATEX-EU-G | e.g. "Export outside the EU" |
 * | `"small-business-exemption"` | E | 0 | VATEX-FR-FRANCHISE in France | § 19 UStG / art. 293 B CGI wording |
 *
 * Explicit values always win: a stated `vatCategory`, `vatRate`,
 * `vatExemptionReasons` entry or `vatExemptionReasonCodes` entry is kept. An
 * item whose own `vatScenario` and own `vatCategory` disagree keeps its
 * category, gets nothing from the scenario, and is the fatal
 * `ATW-VAT-SCENARIO-CONFLICT` in `validateInput`. Missing facts (a VAT
 * identifier, the deliver-to country, a domestic rate) are not filled or
 * invented: `validateInput` reports each as `ATW-VAT-SCENARIO-FACT-MISSING`,
 * so the returned invoice may still be incomplete, and is typed as the
 * explicit form it will be once they are supplied.
 */
export function applyVatScenarios(input: InvoiceInput | InvoiceFacts): AppliedDefaults {
  const plan = planVatScenarios(input);
  return { invoice: explicitInvoice(input, plan), notes: scenarioNotes(input, plan) };
}
