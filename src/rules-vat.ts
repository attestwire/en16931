import {
  REASON_FORBIDDEN_CATEGORIES,
  computeTotals,
  lineNetAmount,
  round2,
} from "./totals.js";
import {
  ALL_CATEGORIES,
  CATEGORY_NAMES,
  CATEGORY_RULE_INFIX,
  DOCS,
  RATED_CATEGORIES,
  VAT_TOLERANCE,
  blank,
  documentAllowanceCharges,
  err,
  linesOf,
  usesCategory,
  usesCategoryAnywhere,
  withinAbsoluteTolerance,
  withinSignedTolerance,
} from "./rule-kit.js";
import type { RuleFn } from "./rule-kit.js";
import type { InvoiceInput, InvoiceTotals, TaxSubtotal, TeachingError, VatCategory } from "./types.js";

/**
 * The per-category VAT breakdown families: BR-S-*, BR-Z-*, BR-E-*, BR-AE-*,
 * BR-IC-*, BR-G-*, BR-O-*, plus the breakdown-integrity rules BR-45..BR-48,
 * BR-CO-17 and BR-CO-18.
 *
 * A note on what these rules are worth on *this* model, because the honest
 * answer is not uniform and pretending otherwise would be the kind of coverage
 * theatre this package exists to avoid:
 *
 *   - The `-10` family (exemption reason present, or absent for S and Z) and
 *     BR-O-11 / BR-O-12 (category O may not share a document with any other
 *     category) are fully falsifiable from caller input. They catch real
 *     mistakes today.
 *   - The `-01`, `-08` and `-09` families, and BR-45..BR-48 / BR-CO-17 /
 *     BR-CO-18, are evaluated against the breakdown `computeTotals` derives
 *     from your lines, your document allowances (BG-20) and your document
 *     charges (BG-21). Since the same function also *emits* that breakdown,
 *     they cannot fail on well-formed input — they are invariants of the
 *     arithmetic, checked rather than assumed, and they are cheap. What
 *     changed in 0.2.0 is what they are an invariant *of*: the taxable amount
 *     is no longer a plain sum of lines, so the `-08` family now has real
 *     arithmetic to guard.
 *
 * The tolerance on `-08`, `-09` and BR-CO-17 is the standard's own: strictly
 * less than one whole unit of the invoice currency, at both ends. See
 * `VAT_TOLERANCE` in rule-kit.ts for why it is that loose.
 *
 * Rule texts from `ubl/schematron/abstract/EN16931-model.sch` and the UBL
 * binding in `ubl/schematron/UBL/EN16931-UBL-model.sch`,
 * ConnectingEurope/eInvoicing-EN16931 @ validation-1.3.16.
 */

/** Categories whose VAT breakdown must be unique; S may repeat, one per rate. */
const EXACTLY_ONE: readonly VatCategory[] = ["Z", "E", "AE", "K", "G", "O"];

/** Categories whose breakdown must carry a VAT exemption reason (BT-120/BT-121). */
const REASON_REQUIRED: readonly VatCategory[] = ["E", "AE", "K", "G", "O"];

/**
 * Categories whose breakdown must NOT carry a VAT exemption reason
 * (BR-S-10, BR-Z-10, BR-AF-10, BR-AG-10). Taken from totals.ts so that the
 * function which drops the reason and the rule which reports it dropped can
 * never disagree.
 */
const REASON_FORBIDDEN: readonly VatCategory[] = REASON_FORBIDDEN_CATEGORIES;

/** The standard wording BT-120 is expected to carry, per category. */
const STANDARD_REASON: Partial<Record<VatCategory, string>> = {
  AE: "Reverse charge",
  K: "Intra-Community supply",
  G: "Export outside the EU",
  O: "Not subject to VAT",
};

const ruleId = (category: VatCategory, suffix: string): string =>
  `BR-${CATEGORY_RULE_INFIX[category]}-${suffix}`;

const describe = (category: VatCategory): string =>
  `${category} (${CATEGORY_NAMES[category]})`;

/** Totals, or null when the line data is too malformed to compute. */
const totalsOf = (inv: InvoiceInput): InvoiceTotals | null => {
  if (linesOf(inv).length === 0) return null;
  try {
    return computeTotals(inv);
  } catch {
    return null; // BR-22 / BR-24 / BR-26 report the underlying line defect
  }
};

const subtotalsFor = (
  totals: InvoiceTotals,
  category: VatCategory,
): TaxSubtotal[] => totals.subtotals.filter((s) => s.category === category);

/**
 * The taxable base of one breakdown group, computed independently of
 * `computeTotals`:
 *
 *   Σ BT-131 − Σ BT-92 + Σ BT-99, over the lines, document allowances and
 *   document charges whose category (and, for S, whose rate) matches.
 *
 * Deliberately a second implementation rather than a call into totals.ts: the
 * `-08` rules exist to catch our own arithmetic drifting, and a check that
 * reuses the code it is checking catches nothing.
 */
const taxableBaseFor = (
  inv: InvoiceInput,
  category: VatCategory,
  rate: number | undefined,
): number => {
  const matchesRate = (declared: number | undefined): boolean => {
    if (rate === undefined) return true;
    const effective = RATED_CATEGORIES.includes(category)
      ? (declared ?? 0)
      : category === "O"
        ? undefined
        : 0;
    return effective === rate;
  };

  let sum = 0;
  for (const line of linesOf(inv)) {
    if (line?.vatCategory !== category) continue;
    if (!matchesRate(line.vatRate)) continue;
    try {
      sum = round2(sum + lineNetAmount(line));
    } catch {
      return Number.NaN;
    }
  }
  for (const tagged of documentAllowanceCharges(inv)) {
    const entry = tagged.entry;
    if (entry.vatCategory !== category) continue;
    if (!matchesRate(entry.vatRate)) continue;
    const amount =
      typeof entry.amount === "number" && Number.isFinite(entry.amount)
        ? round2(entry.amount)
        : 0;
    sum = round2(sum + (tagged.isCharge ? amount : -amount));
  }
  return sum;
};

export const vatRules: RuleFn[] = [
  // --- -01: the breakdown for a used category must exist, and be unique -----
  (inv) => {
    const totals = totalsOf(inv);
    if (!totals) return null;
    const out: TeachingError[] = [];
    for (const category of ALL_CATEGORIES) {
      const used = usesCategoryAnywhere(inv, category);
      const groups = subtotalsFor(totals, category);
      const unique = EXACTLY_ONE.includes(category);
      const rule = ruleId(category, "01");

      if (used && groups.length === 0) {
        out.push({
          rule,
          field: "BT-118",
          severity: "fatal",
          message: `An invoice line (BT-151), a document level allowance (BT-95) or a document level charge (BT-102) uses VAT category ${describe(category)}, so the VAT breakdown (BG-23) must contain ${unique ? "exactly one" : "at least one"} group with the VAT category code (BT-118) ${category} — but none was produced. The breakdown is the document's own summary of what VAT is due and why; a category that appears on the invoice but not in the breakdown means the tax authority cannot reconcile the two.`,
          fix: "The VAT breakdown is always computed by this library from the lines and the document level allowances and charges, so a missing group means one of those carries a vatCategory this build does not recognise. Check it against the nine supported codes: S, Z, E, AE, K, G, O, L, M.",
          example: `"lines": [{ "id": "1", "description": "Beratung", "quantity": 1, "unitCode": "C62", "unitPrice": 100, "vatCategory": "${category}"${RATED_CATEGORIES.includes(category) ? ', "vatRate": 19' : ""} }]`,
          xpath: "/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID",
          docsUrl: `${DOCS}/${rule}`,
        });
        continue;
      }

      if (unique && groups.length > 1) {
        out.push({
          rule,
          field: "BT-118",
          severity: "fatal",
          message: `The VAT breakdown (BG-23) contains ${groups.length} groups with the VAT category code (BT-118) ${category} (${CATEGORY_NAMES[category]}), but ${rule} allows exactly one. Only the rated categories — "Standard rated", and the regional Spanish "IGIC" and "IPSI" — may appear more than once, and then only once per distinct rate — every other category is fixed at a single rate, so a second group can only mean the same tax treatment was split across two rows.`,
          fix: `Give every ${category} line the same VAT rate (0, or omit it entirely for category O). A stray non-zero rate on a ${category} line is what splits the breakdown, and it also fails ${ruleId(category, "05")}.`,
          example: `"vatCategory": "${category}"${category === "O" ? "" : ', "vatRate": 0'}`,
          xpath: "/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID",
          docsUrl: `${DOCS}/${rule}`,
        });
      }

      if (!used && groups.length > 0) {
        out.push({
          rule,
          field: "BT-118",
          severity: "fatal",
          message: `The VAT breakdown (BG-23) contains a group with the VAT category code (BT-118) ${describe(category)}, but no invoice line, document level allowance or document level charge uses that category. ${rule} makes the breakdown and the lines mirror each other exactly: a breakdown group with nothing behind it declares VAT treatment for a supply that is not on the invoice.`,
          fix: "The breakdown is computed from the lines, so this cannot arise from your input — it indicates a defect in this library's arithmetic. Please report it with the invoice payload.",
          xpath: "/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID",
          docsUrl: `${DOCS}/${rule}`,
        });
      }
    }
    return out;
  },

  // --- -08: taxable amount per category equals the sum of its lines ---------
  (inv) => {
    const totals = totalsOf(inv);
    if (!totals) return null;
    const out: TeachingError[] = [];
    for (const category of ALL_CATEGORIES) {
      if (!usesCategoryAnywhere(inv, category)) continue;
      const rule = ruleId(category, "08");
      for (const subtotal of subtotalsFor(totals, category)) {
        const expected = taxableBaseFor(inv, category, subtotal.rate);
        if (Number.isNaN(expected)) continue;
        if (withinSignedTolerance(subtotal.taxableAmount, expected)) continue;
        const rateNote = RATED_CATEGORIES.includes(category)
          ? ` at rate ${subtotal.rate ?? 0}%`
          : "";
        out.push({
          rule,
          field: "BT-116",
          severity: "fatal",
          message: `The VAT category taxable amount (BT-116) in the ${describe(category)} breakdown${rateNote} is ${subtotal.taxableAmount.toFixed(2)} ${inv.currency}, but the lines, allowances and charges in that category sum to ${expected.toFixed(2)}. ${rule} requires BT-116 to equal Σ invoice line net amounts (BT-131) − Σ document level allowances (BT-92) + Σ document level charges (BT-99) for that category${RATED_CATEGORIES.includes(category) ? " and that rate" : ""}. A document allowance in the group subtracts from the base and a document charge adds to it, and both are rounded before they are summed. EN 16931 allows a tolerance of strictly less than ${VAT_TOLERANCE.toFixed(2)} ${inv.currency} here; the difference is ${Math.abs(round2(subtotal.taxableAmount - expected)).toFixed(2)}.`,
          fix: "The taxable amount is computed from your lines, so a mismatch indicates a defect in this library's arithmetic rather than in your data. Please report it with the invoice payload.",
          xpath: "/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount",
          docsUrl: `${DOCS}/${rule}`,
        });
      }
    }
    return out;
  },

  // --- -09: the VAT amount per category ------------------------------------
  (inv) => {
    const totals = totalsOf(inv);
    if (!totals) return null;
    const out: TeachingError[] = [];
    for (const category of ALL_CATEGORIES) {
      if (!usesCategoryAnywhere(inv, category)) continue;
      const rule = ruleId(category, "09");
      const mustBeZero = !RATED_CATEGORIES.includes(category);
      for (const subtotal of subtotalsFor(totals, category)) {
        if (mustBeZero) {
          if (round2(subtotal.taxAmount) === 0) continue;
          out.push({
            rule,
            field: "BT-117",
            severity: "fatal",
            message: `The VAT category tax amount (BT-117) in the ${describe(category)} breakdown is ${subtotal.taxAmount.toFixed(2)} ${inv.currency}, but ${rule} requires it to be 0 (zero). No VAT is charged on this category${category === "AE" ? " — under reverse charge the buyer self-assesses it, so the seller's invoice must show nothing" : category === "K" ? " — an intra-community supply is zero-rated in the country of dispatch and taxed in the country of arrival" : category === "O" ? " — the transaction is outside the scope of VAT entirely" : ""}. A non-zero amount here would also break BR-CO-14, since the document VAT total is the sum of these amounts.`,
            fix: `Set the VAT rate on every ${category} line to 0 (or omit it${category === "O" ? "; category O must not carry a rate at all" : ""}). The tax amount is derived from the rate, so correcting the rate corrects this.`,
            example: `"vatCategory": "${category}"${category === "O" ? "" : ', "vatRate": 0'}`,
            xpath: "/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount",
            docsUrl: `${DOCS}/${rule}`,
          });
          continue;
        }

        const rate = subtotal.rate ?? 0;
        // Magnitudes on both sides — see withinAbsoluteTolerance.
        const expected = round2((Math.abs(subtotal.taxableAmount) * rate) / 100);
        if (withinAbsoluteTolerance(subtotal.taxAmount, expected)) continue;
        out.push({
          rule,
          field: "BT-117",
          severity: "fatal",
          message: `The VAT category tax amount (BT-117) in the ${describe(category)} breakdown at ${rate}% is ${subtotal.taxAmount.toFixed(2)} ${inv.currency}, but ${rule} requires it to equal the VAT category taxable amount (BT-116) multiplied by the VAT category rate (BT-119): ${subtotal.taxableAmount.toFixed(2)} x ${rate}% = ${expected.toFixed(2)}. EN 16931's schematron allows a tolerance of strictly less than ${VAT_TOLERANCE.toFixed(2)} ${inv.currency} on this comparison — deliberately loose, so that computing VAT line by line and computing it on the group total both pass — and this difference exceeds even that.`,
          fix: "The VAT amount is computed from the lines by this library, so a mismatch indicates a defect in its arithmetic rather than in your data. Please report it with the invoice payload.",
          xpath: "/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount",
          docsUrl: `${DOCS}/${rule}`,
        });
      }
    }
    return out;
  },

  // --- -10: the VAT exemption reason ---------------------------------------
  //
  // BR-E-10 lives in rules.ts and is deliberately not duplicated here: category
  // E is the one case with no standard wording, so it carries its own message.
  (inv) => {
    const out: TeachingError[] = [];
    for (const category of REASON_REQUIRED) {
      if (category === "E") continue; // BR-E-10, in rules.ts
      if (!usesCategoryAnywhere(inv, category)) continue;
      const supplied = inv.vatExemptionReasons?.[category];
      // `undefined` picks up the library default (see DEFAULT_EXEMPTION_REASONS);
      // an explicitly blank string suppresses it, and that is what fails.
      if (supplied === undefined || !blank(supplied)) continue;
      // BT-120 and BT-121 are alternatives, not a pair: a VATEX code alone
      // satisfies the rule, so suppressing the text is only a failure when no
      // code was supplied either.
      if (!blank(inv.vatExemptionReasonCodes?.[category])) continue;
      const rule = ruleId(category, "10");
      const standard = STANDARD_REASON[category]!;
      out.push({
        rule,
        field: ["BT-120", "BT-121"],
        severity: "fatal",
        message: `The VAT breakdown for category ${describe(category)} must have a VAT exemption reason code (BT-121) meaning "${standard}", or the VAT exemption reason text (BT-120) "${standard}" (or the equivalent standard text in another language). You set vatExemptionReasons.${category} to an empty value, which suppresses the wording this library would otherwise supply. The reason is what tells the buyer — and their auditor — why an invoice line carries no VAT; a zero with no explanation is indistinguishable from a mistake.`,
        fix: `Either remove vatExemptionReasons.${category} entirely, in which case this library supplies the standard text "${standard}", or set it to your own wording in the invoice language.`,
        example: `"vatExemptionReasons": { "${category}": "${standard}" }`,
        xpath: "/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:TaxExemptionReason",
        docsUrl: `${DOCS}/${rule}`,
      });
    }

    for (const category of REASON_FORBIDDEN) {
      if (!usesCategoryAnywhere(inv, category)) continue;
      const text = inv.vatExemptionReasons?.[category];
      const code = inv.vatExemptionReasonCodes?.[category];
      const supplied = !blank(text) ? text : code;
      if (blank(supplied)) continue;
      const which = !blank(text)
        ? `vatExemptionReasons.${category}`
        : `vatExemptionReasonCodes.${category}`;
      const rule = ruleId(category, "10");
      out.push({
        rule,
        field: ["BT-120", "BT-121"],
        severity: "warning",
        message: `A VAT breakdown with the VAT category code (BT-118) ${describe(category)} must not have a VAT exemption reason code (BT-121) or reason text (BT-120), but you supplied ${which} = "${String(supplied).trim()}". ${
          category === "S"
            ? "Standard-rated supplies are taxed, so there is no exemption to explain"
            : category === "Z"
              ? "Zero rating is a rate, not an exemption — the supply is inside the VAT system and taxed at 0%, so no reason is due"
              : `Category ${category} charges ${category === "L" ? "IGIC" : "IPSI"}, which is a tax actually levied on the supply — an exemption reason would claim relief from the very tax the breakdown says you collected`
        }. ${rule} is fatal at document level; this finding is a warning because the library drops the value rather than emitting it, so the generated XML still passes — but your intent was silently discarded, which you should know about.`,
        fix: `Remove the "${category}" entry from ${!blank(text) ? "vatExemptionReasons" : "vatExemptionReasonCodes"}. If you need to say something to the buyer about this line, use the invoice note (BT-22) or the line note (BT-127), which carry free text without making a VAT claim.`,
        example: `"${!blank(text) ? "vatExemptionReasons" : "vatExemptionReasonCodes"}": { }, "lines": [{ "id": "1", "description": "Beratung", "quantity": 1, "unitCode": "C62", "unitPrice": 100, "vatCategory": "${category}", "vatRate": ${category === "S" ? 19 : category === "Z" ? 0 : category === "L" ? 7 : 10} }]`,
        xpath: "/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:TaxExemptionReason",
        docsUrl: `${DOCS}/${rule}`,
      });
    }
    return out;
  },

  // --- BR-O-11 / BR-O-12: category O does not share a document -------------
  //
  // Both official tests are gated on the *breakdown* containing an O group —
  // `exists(cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID = 'O')` — not on
  // a line carrying BT-151 = O. Since wave B, a document level allowance
  // (BT-95) or charge (BT-102) produces a breakdown group on its own account,
  // so gating on the lines alone let a whole class of mixed document through:
  // O on an allowance beside standard-rated lines validated completely clean
  // here and was rejected with two fatals by the reference validator. Hence
  // `usesCategoryAnywhere` on both sides.
  (inv) => {
    if (!usesCategoryAnywhere(inv, "O")) return null;
    const others = ALL_CATEGORIES.filter(
      (c) => c !== "O" && usesCategoryAnywhere(inv, c),
    );
    if (others.length === 0) return null;

    const otherLines = linesOf(inv)
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line?.vatCategory && line.vatCategory !== "O");
    const where = otherLines
      .slice(0, 5)
      .map(({ line, index }) => `line ${index + 1} (${line.vatCategory})`)
      .join(", ");

    const out: TeachingError[] = [
      {
        rule: "BR-O-11",
        field: "BT-118",
        severity: "fatal",
        message: `This invoice contains a VAT breakdown group (BG-23) with the VAT category code (BT-118) "Not subject to VAT", so it must not contain any other VAT breakdown group — but your lines, document level allowances and document level charges also produce ${others.map((c) => `"${c}"`).join(", ")}. "Not subject to VAT" is a statement about the whole document: the transaction falls outside the scope of VAT altogether, which cannot be true of the invoice and false of one figure on it.`,
        fix: `Split the document. Put everything in category O on its own invoice, and the ${others.join("/")} lines, allowances and charges on another. There is no way to express a mixed document here, and none is intended: BR-O-11, BR-O-12, BR-O-13 and BR-O-14 close every route to it.`,
        example: `"lines": [{ "id": "1", "description": "Statutory levy", "quantity": 1, "unitCode": "C62", "unitPrice": 100, "vatCategory": "O" }]`,
        xpath: "/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID",
        docsUrl: `${DOCS}/BR-O-11`,
      },
      {
        rule: "BR-O-12",
        field: "BT-151",
        severity: "fatal",
        message: `This invoice contains a VAT breakdown group (BG-23) with the VAT category code (BT-118) "Not subject to VAT", so no invoice line may carry an invoiced item VAT category code (BT-151) other than "O" — but ${otherLines.length === 1 ? "one line does" : `${otherLines.length} lines do`}: ${where}${otherLines.length > 5 ? ", …" : ""}. This is BR-O-11's counterpart at line level; together they make category O all-or-nothing for the document.`,
        fix: 'Move the non-O lines to a separate invoice, or correct their vatCategory if "O" was the intended treatment for them too. Note that an invoice using category O must also carry no VAT identifiers at all (BR-O-02).',
        example: `"vatCategory": "O"`,
        xpath: "/ubl:Invoice/cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory/cbc:ID",
        docsUrl: `${DOCS}/BR-O-12`,
      },
    ];
    // BR-O-12 is about invoice lines only. When category O reaches the
    // breakdown solely through a document level allowance or charge and every
    // line is already O, BR-O-11 fires and BR-O-12 does not — reporting it
    // would name zero offending lines.
    return otherLines.length > 0 ? out : [out[0]!];
  },

  // --- BR-AF-05 / BR-AG-05: the regional Spanish line rate --------------
  //
  // The sibling of BR-S-05 (in rules.ts) for the two categories that charge a
  // tax which is not VAT. The bound is deliberately different: BR-S-05 wants a
  // rate *greater than* zero, because a standard-rated supply taxed at nothing
  // is a contradiction, while BR-AF-05 and BR-AG-05 read "shall be 0 (zero) or
  // greater than zero" — IGIC has a real 0% band (books, water, some foods,
  // and a long list of Canarian exemptions applied as a rate rather than as an
  // exemption), and IPSI likewise. So zero is legal here and absent is not:
  // the term has to be stated, because a missing rate and a rate of zero are
  // different claims about a tax that is genuinely levied.
  (inv) => {
    const out: TeachingError[] = [];
    for (const [index, line] of linesOf(inv).entries()) {
      const category = line?.vatCategory;
      if (category !== "L" && category !== "M") continue;
      const rate = line.vatRate;
      if (typeof rate === "number" && Number.isFinite(rate) && rate >= 0) continue;
      const rule = ruleId(category, "05");
      const tax = category === "L" ? "IGIC" : "IPSI";
      out.push({
        rule,
        field: "BT-152",
        severity: "fatal",
        message: `Line ${index + 1} uses VAT category ${describe(category)}, so the invoiced item VAT rate (BT-152) must be 0 (zero) or greater than zero, but it is ${
          rate === undefined ? "missing" : String(rate)
        }. ${tax} is a tax that is actually charged, so the rate is the substance of the line, not decoration — and unlike category S, ${category} does admit a rate of exactly 0, because ${tax} relieves some supplies by rate rather than by exemption. What it does not admit is silence, or a negative figure.`,
        fix: `Set line.vatRate to the applicable ${tax} percentage as a number. ${
          category === "L"
            ? "IGIC is the Canary Islands tax and its bands are set nationally: 7 for the general rate, 0 for a zero-rated Canarian supply, and 3, 9.5, 15 or 20 for the reduced and increased bands."
            : "IPSI is the municipal tax of Ceuta and Melilla, not an IGIC band table: its rates are fixed by each city's own ordinance for the class of goods or service, and in practice run from about 0.5 to 10 percent — so take the figure from the Ceuta or Melilla ordinance that governs your supply rather than from a national list."
        } If the supply is in mainland Spain and bears VAT rather than ${tax}, the category is S.`,
        example: `"vatCategory": "${category}", "vatRate": ${category === "L" ? 7 : 10}`,
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent`,
        docsUrl: `${DOCS}/${rule}`,
      });
    }
    return out;
  },

  // --- BR-45 / BR-46 / BR-47 / BR-48: every breakdown group is complete ----
  (inv) => {
    const totals = totalsOf(inv);
    if (!totals) return null;
    const out: TeachingError[] = [];
    for (const [index, subtotal] of totals.subtotals.entries()) {
      const at = `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal[${index + 1}]`;
      const which = `The VAT breakdown group for category ${subtotal.category}`;
      const advice =
        "The VAT breakdown is computed from your lines, so this cannot arise from your input — it indicates a defect in this library's arithmetic. Please report it with the invoice payload.";

      if (typeof subtotal.taxableAmount !== "number" || !Number.isFinite(subtotal.taxableAmount)) {
        out.push({
          rule: "BR-45",
          field: "BT-116",
          severity: "fatal",
          message: `${which} has no VAT category taxable amount (BT-116). Each VAT breakdown (BG-23) shall have one: it is the base the VAT was calculated on, and without it neither BR-CO-17 nor any of the per-category -08/-09 rules can be evaluated.`,
          fix: advice,
          xpath: `${at}/cbc:TaxableAmount`,
          docsUrl: `${DOCS}/BR-45`,
        });
      }
      if (typeof subtotal.taxAmount !== "number" || !Number.isFinite(subtotal.taxAmount)) {
        out.push({
          rule: "BR-46",
          field: "BT-117",
          severity: "fatal",
          message: `${which} has no VAT category tax amount (BT-117). Each VAT breakdown (BG-23) shall have one, even when it is zero — an absent amount and a zero amount are different claims, and BR-CO-14 sums these values into the document VAT total.`,
          fix: advice,
          xpath: `${at}/cbc:TaxAmount`,
          docsUrl: `${DOCS}/BR-46`,
        });
      }
      if (blank(subtotal.category as unknown as string)) {
        out.push({
          rule: "BR-47",
          field: "BT-118",
          severity: "fatal",
          message: `${which} has no VAT category code (BT-118). Each VAT breakdown (BG-23) shall be defined through one — the code is what selects the rule family the group is judged by, so a group without it is uninterpretable.`,
          fix: advice,
          xpath: `${at}/cac:TaxCategory/cbc:ID`,
          docsUrl: `${DOCS}/BR-47`,
        });
      }
      if (subtotal.rate === undefined && subtotal.category !== "O") {
        out.push({
          rule: "BR-48",
          field: "BT-119",
          severity: "fatal",
          message: `${which} has no VAT category rate (BT-119). Each VAT breakdown (BG-23) shall have one, with a single exception: category O ("Not subject to VAT"), where the transaction is outside the scope of VAT and therefore has no rate at all — which is a different statement from a rate of zero. Category ${subtotal.category} is inside the scope, so the rate must be present even though it is 0.`,
          fix: advice,
          xpath: `${at}/cac:TaxCategory/cbc:Percent`,
          docsUrl: `${DOCS}/BR-48`,
        });
      }
    }
    return out;
  },

  // --- BR-CO-17: VAT amount = taxable x rate / 100, rounded to 2 decimals ---
  (inv) => {
    const totals = totalsOf(inv);
    if (!totals) return null;
    const out: TeachingError[] = [];
    for (const [index, subtotal] of totals.subtotals.entries()) {
      const rate = subtotal.rate;
      if (rate === undefined) {
        // No rate (category O): BR-CO-17's first branch requires a zero amount.
        if (round2(subtotal.taxAmount) === 0) continue;
      } else {
        const expected = round2((Math.abs(subtotal.taxableAmount) * rate) / 100);
        if (Math.round(rate) === 0) {
          if (Math.round(subtotal.taxAmount) === 0) continue;
        } else if (withinAbsoluteTolerance(subtotal.taxAmount, expected)) {
          continue;
        }
      }
      const expected = round2((subtotal.taxableAmount * (rate ?? 0)) / 100);
      out.push(
        err({
          rule: "BR-CO-17",
          field: "BT-117",
          severity: "fatal",
          message: `In the VAT breakdown group for category ${subtotal.category}${rate === undefined ? "" : ` at ${rate}%`}, the VAT category tax amount (BT-117) is ${subtotal.taxAmount.toFixed(2)} ${inv.currency}. BR-CO-17 requires BT-117 = BT-116 x (BT-119 / 100), rounded to two decimals — here ${subtotal.taxableAmount.toFixed(2)} x ${rate ?? 0}% = ${expected.toFixed(2)}.${
            rate !== undefined && rate !== 0 && Math.round(rate) === 0
              ? ` The arithmetic is right; the *rule* is what rejects it. BR-CO-17's first branch is written as round(BT-119) = 0, using XPath's round-to-nearest-integer — so any rate below 0.5% rounds to zero and the rule then demands that the tax amount round to zero as well. At ${rate}% on a taxable amount of ${subtotal.taxableAmount.toFixed(2)} it does not. This is a known defect in the reference schematron, not in your invoice: a genuine sub-1% rate on a base large enough to yield half a unit of currency cannot satisfy BR-CO-17 at all.`
              : " Where the rate rounds to zero, the tax amount must round to zero too. Note the direction of the arithmetic: VAT is computed on the *group* taxable amount, not summed from per-line VAT amounts, which is why EN 16931 rounds once per group rather than once per line."
          }`,
          fix:
            rate !== undefined && rate !== 0 && Math.round(rate) === 0
              ? `Nothing in your data is wrong, and the library cannot compute its way out of this: any BT-119 below 0.5% trips BR-CO-17's integer rounding. If the rate is a rounding of a real one, state the real one (0.5 or above passes). If ${rate}% is genuinely the rate, the receiving validator will raise BR-CO-17 too — take it up with the recipient, or split the supply so the group taxable amount stays small enough that the tax amount rounds to zero.`
              : "This amount is computed by the library from the VAT rate you supplied, so unless the rate is one you meant to change, a mismatch here indicates a defect in the library's arithmetic. Please report it with the invoice payload.",
          xpath: `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal[${index + 1}]/cbc:TaxAmount`,
          docsUrl: `${DOCS}/BR-CO-17`,
        }),
      );
    }
    return out;
  },

  // --- BR-CO-18: an invoice shall have at least one VAT breakdown group -----
  (inv) => {
    const totals = totalsOf(inv);
    if (!totals) return null;
    if (totals.subtotals.length > 0) return null;
    return err({
      rule: "BR-CO-18",
      field: "BG-23",
      severity: "fatal",
      message:
        "An invoice shall have at least one VAT breakdown group (BG-23). Even a document on which no VAT is due must say so explicitly and say why — with a category (BT-118), a taxable amount (BT-116) and a tax amount of zero (BT-117) — because \"no VAT breakdown\" and \"no VAT due\" are different claims, and only the second is something a tax authority can accept.",
      fix: "Add at least one invoice line with a vatCategory. The breakdown is derived from the lines, so a document with lines always produces one.",
      example: `"lines": [{ "id": "1", "description": "Beratung", "quantity": 1, "unitCode": "C62", "unitPrice": 100, "vatCategory": "S", "vatRate": 19 }]`,
      xpath: "/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal",
      docsUrl: `${DOCS}/BR-CO-18`,
    });
  },
];
