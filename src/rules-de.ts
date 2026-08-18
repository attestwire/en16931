import { DEFAULT_INVOICE_TYPE_CODE } from "./generate.js";
import { DOCS, blank, err, isXRechnung, linesOf, totalsOutcomeOf } from "./rule-kit.js";
import type { RuleFn } from "./rule-kit.js";
import type { InvoicingPeriod, TeachingError } from "./types.js";

/**
 * XRechnung CIUS rules (BR-DE-*) that the current input model can express and
 * that `rules.ts` did not yet cover.
 *
 * Rule texts and severities from
 * `src/validation/schematron/ubl/XRechnung-UBL-validation.sch` and
 * `src/validation/schematron/common.sch`, itplr-kosit/xrechnung-schematron
 * (XRechnung 3.0.2 configuration). Where KoSIT flags a rule `warning` or
 * `information` we do too — over-rejecting a document the regulator would
 * accept is its own kind of wrong answer.
 */

/** Payment means codes that oblige the credit transfer group BG-17. */
const CREDIT_TRANSFER_CODES = new Set(["30", "58"]);
/** Payment means codes that oblige the payment card group BG-18. */
const CARD_CODES = new Set(["48", "54", "55"]);
/** Payment means code that obliges the direct debit group BG-19. */
const DIRECT_DEBIT_CODE = "59";

/**
 * BR-DE-18's Skonto grammar, transcribed from `$XR-SKONTO-REGEX` in KoSIT's
 * `common.sch`:
 *
 *   (^|\r?\n)#(SKONTO)#TAGE=([0-9]+#PROZENT=[0-9]+\.[0-9]{2})
 *            (#BASISBETRAG=-?[0-9]+\.[0-9]{2})?#$
 *
 * We apply it per line, exactly as the schematron does (it tokenises the note
 * on newlines and tests each line that starts with `#`), so the leading
 * alternation collapses to a line anchor.
 */
const SKONTO_LINE =
  /^#SKONTO#TAGE=[0-9]+#PROZENT=[0-9]+\.[0-9]{2}(#BASISBETRAG=-?[0-9]+\.[0-9]{2})?#$/;

/**
 * IBAN check per BR-DE-19: shape, then the ISO 7064 MOD-97-10 checksum.
 *
 * Written with BigInt-free chunked arithmetic because an IBAN can be 34
 * characters, which expands to well past `Number.MAX_SAFE_INTEGER` once the
 * letters become two-digit numbers.
 */
const IBAN_SHAPE = /^[A-Z]{2}[0-9]{2}[A-Za-z0-9]{0,30}$/;

export function isValidIban(value: string): boolean {
  const compact = value.replace(/\s/g, "");
  if (!IBAN_SHAPE.test(compact)) return false;
  // The official expression is
  //   concat(substring(s,5), upper-case(substring(s,1,2)), substring(s,3,2))
  // fed to string-to-codepoints — it upper-cases the *country code only*, and
  // leaves the BBAN exactly as written. A lowercase BBAN letter therefore maps
  // to codepoint − 55 = 42…67 rather than 10…35 and the MOD-97 fails. Before
  // 0.2.0 we upper-cased the whole string, which accepted "NL91abna0417164300"
  // and "GB82wesT12345698765432" — IBANs the reference validator rejects. The
  // shape regex admits a mixed-case BBAN, so this path is reachable rather than
  // blocked upstream. ISO 13616 defines the IBAN in upper case; a lowercase one
  // is not a formatting preference, it is a different string.
  const rearranged =
    compact.slice(4) + compact.slice(0, 2).toUpperCase() + compact.slice(2, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = char.charCodeAt(0);
    const digits =
      code >= 65 && code <= 90
        ? String(code - 55) // A→10 … Z→35
        : code >= 48 && code <= 57
          ? char
          : null;
    if (digits === null) return false;
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

export const germanRules: RuleFn[] = [
  // BR-DE-14: Das Element "VAT category rate" (BT-119) muss übermittelt werden.
  //
  // XRechnung requires a rate on *every* VAT breakdown group, with none of the
  // category-O exception that core EN 16931 grants in BR-48. That makes an
  // XRechnung invoice built purely from category O lines impossible: BR-O-05
  // forbids the rate on the line, so no rate reaches the breakdown, so
  // BR-DE-14 fails. Worth saying out loud, because the document validates
  // clean against core EN 16931 and is then rejected by a German portal.
  //
  // ⚠ IT IS THE STATED BREAKDOWN THAT IS CHECKED, not the computed one, and
  // that changed in 0.7.3. The rule is a presence check on an element —
  // "cbc:Percent is there and is not empty" — so the only breakdown it can be
  // asked about is the one the document writes. We asked it of ours instead,
  // and ours never carries a rate for category O by construction
  // (`effectiveRate` returns undefined for it, because BR-O-05 forbids one on
  // the line). A document that states `<cbc:Percent>0</cbc:Percent>` on its
  // category-O group therefore satisfied KoSIT and failed here — four cells in
  // the first benchmark run, including
  // kosit-testsuite/standard/01.04a-INVOICE_ubl.xml and its CII twin.
  //
  // The paragraph above still holds for a document *we* generate: no rate
  // reaches a category-O group, so the fallback below reports it. What changed
  // is that a document that states the element is now taken at its word.
  (inv, ctx) => {
    if (!isXRechnung(inv)) return null;
    if (linesOf(inv).length === 0) return null;
    const { totals: computed } = totalsOutcomeOf(inv, ctx);
    if (!computed) return null;
    const declaredSubtotals = inv.declaredTotals?.subtotals;
    const groups =
      Array.isArray(declaredSubtotals) && declaredSubtotals.length > 0
        ? declaredSubtotals.map((sub, index) => ({
            category: sub?.category ?? computed.subtotals[index]?.category ?? "",
            rate: sub?.rate,
          }))
        : computed.subtotals;
    const out: TeachingError[] = [];
    for (const [index, subtotal] of groups.entries()) {
      if (subtotal.rate !== undefined) continue;
      out.push({
        rule: "BR-DE-14",
        field: "BT-119",
        severity: "fatal",
        message: `XRechnung requires the element "VAT category rate" (BT-119) on every VAT breakdown group (BG-23), but the group for category ${subtotal.category} has none. Core EN 16931 excuses exactly one case from this — BR-48 allows a missing rate when the category is "O" (not subject to VAT) — and the German CIUS does not carry that exception forward. The practical consequence is that category O cannot be used in an XRechnung at all: BR-O-05 forbids a rate on the line, so no rate can reach the breakdown, and BR-DE-14 then rejects the document. Core EN 16931 validation passes; the German portal rejects.`,
        fix: 'Choose a different profile ("en16931" or "peppol-bis-3") for a genuinely out-of-scope transaction, or re-examine the categorisation: a supply that is inside the scope of VAT but taxed at nothing is category "Z" (zero rated) with vatRate 0, and that is what most transactions labelled "no VAT" actually are. Category "E" (exempt) with an exemption reason is the other common correct answer.',
        example: `"vatCategory": "Z", "vatRate": 0`,
        xpath: `/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal[${index + 1}]/cac:TaxCategory/cbc:Percent`,
        docsUrl: `${DOCS}/BR-DE-14`,
      });
    }
    return out;
  },

  // BR-DE-18: Skonto lines in BT-20 must follow the prescribed grammar.
  (inv) => {
    if (!isXRechnung(inv)) return null;
    const terms = inv.paymentTerms;
    if (blank(terms)) return null;

    const lines = terms!.split(/\r?\n/);
    const skontoLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.trim().startsWith("#"));
    if (skontoLines.length === 0) return null; // no Skonto claimed; nothing to check

    const out: TeachingError[] = [];
    for (const { line, index } of skontoLines) {
      const normalised = line.trim().replace(/\s+/g, " ");
      if (SKONTO_LINE.test(normalised)) continue;
      out.push({
        rule: "BR-DE-18",
        field: "BT-20",
        severity: "fatal",
        message: `Line ${index + 1} of the payment terms (BT-20) starts with "#", which marks it as a Skonto (early-payment discount) entry, but "${normalised}" does not match the grammar XRechnung prescribes. The format is rigid on purpose — it is the one place the standard turns free-text payment terms into something machine-readable — and it is: #SKONTO#TAGE=n#PROZENT=n.nn# with an optional fourth segment #BASISBETRAG=n.nn# before the closing #. Every segment is separated and terminated by "#", everything is upper case, the percentage carries exactly two decimals with a dot (never a comma) and no sign, and no whitespace of any kind is allowed inside the entry.`,
        fix: 'Write each discount as its own line, e.g. "#SKONTO#TAGE=14#PROZENT=2.00#". Add the base amount only when the discount applies to part of the invoice rather than to the full amount due (BT-115): "#SKONTO#TAGE=14#PROZENT=2.00#BASISBETRAG=1000.00#". Each entry must end with a newline. Human-readable prose is fine in BT-20 as well — it just must not start a line with "#".',
        example: `"paymentTerms": "Zahlbar innerhalb von 30 Tagen.\\n#SKONTO#TAGE=14#PROZENT=2.00#\\n"`,
        xpath: "/ubl:Invoice/cac:PaymentTerms/cbc:Note",
        docsUrl: `${DOCS}/BR-DE-18`,
      });
    }

    // The schematron additionally requires that whatever follows the last
    // Skonto entry begins with a newline, i.e. the block is newline-terminated.
    const lastSkonto = skontoLines[skontoLines.length - 1]!;
    const terminated = /(\r?\n)\s*$/.test(terms!) || lastSkonto.index < lines.length - 1;
    if (out.length === 0 && !terminated) {
      out.push({
        rule: "BR-DE-18",
        field: "BT-20",
        severity: "fatal",
        message:
          'The Skonto entries in the payment terms (BT-20) are correctly formed, but the block is not terminated by a line break. XRechnung requires an XML-conformant newline after a complete Skonto statement, so that a parser reading the terms line by line can tell where the machine-readable block ends and free text resumes.',
        fix: 'Append "\\n" after the final "#" of the last Skonto entry.',
        example: `"paymentTerms": "#SKONTO#TAGE=14#PROZENT=2.00#\\n"`,
        xpath: "/ubl:Invoice/cac:PaymentTerms/cbc:Note",
        docsUrl: `${DOCS}/BR-DE-18`,
      });
    }
    return out;
  },

  // BR-DE-19: BT-84 should be a correct IBAN when BT-81 is 58 (SEPA credit
  // transfer). KoSIT flags this `warning`, so we do too.
  (inv) => {
    if (!isXRechnung(inv)) return null;
    const payment = inv.payment;
    if (!payment || payment.meansCode?.trim() !== "58") return null;
    if (blank(payment.iban)) return null; // BR-61 / BR-DE-23-a report absence
    const value = payment.iban!.trim();
    if (isValidIban(value)) return null;
    const compact = value.replace(/\s/g, "");
    const shapeOk = IBAN_SHAPE.test(compact);
    return err({
      rule: "BR-DE-19",
      field: "BT-84",
      severity: "warning",
      message: `The payment means type code (BT-81) is "58" (SEPA credit transfer), so the payment account identifier (BT-84) should be a valid IBAN — but "${value}" ${
        shapeOk
          ? "fails the ISO 7064 MOD-97-10 check digits. The two digits in positions 3 and 4 are a checksum over the rest of the number, so a single mistyped character makes them disagree: this is almost always a transcription error rather than a wrong account."
          : "does not even have the shape of one. An IBAN is two letters for the country, two check digits, then up to thirty alphanumeric characters — no punctuation, and the country prefix is not optional."
      } KoSIT raises this as a warning rather than an error, so the invoice will be accepted; the payment, however, will not go anywhere.`,
      fix: "Set payment.iban to the receiving account's IBAN. Spaces are tolerated and stripped, but nothing else is — take the value from your bank's own record rather than from a formatted statement.",
      example: `"payment": { "meansCode": "58", "iban": "DE02120300000000202051" }`,
      xpath: "/ubl:Invoice/cac:PaymentMeans/cac:PayeeFinancialAccount/cbc:ID",
      docsUrl: `${DOCS}/BR-DE-19`,
    });
  },

  // BR-DE-23-a/-b, BR-DE-24-a/-b, BR-DE-25-a/-b: the payment means code and
  // the payment group must agree — each code requires exactly its own group,
  // and forbids the other two. The `-a` half checks presence, the `-b` half
  // checks exclusivity, and KoSIT reports them separately, so we do too.
  (inv) => {
    if (!isXRechnung(inv)) return null;
    const payment = inv.payment;
    const code = payment?.meansCode?.trim();
    if (!payment || !code) return null; // BR-DE-1 / BR-49 report absence

    const hasTransfer = !blank(payment.iban);
    const hasCard = Boolean(payment.card);
    const hasDebit = Boolean(payment.directDebit);
    const out: TeachingError[] = [];

    /**
     * The `-b` half: name the groups that are present and must not be.
     *
     * `field` is computed from the offenders, not passed in. Before 0.2.0 each
     * call handed in the group the code *allows* — BR-DE-23-b was reported
     * against BG-17, the credit-transfer group it exists to protect — so the
     * finding's `field` named a group that was not the problem while its
     * `xpath` correctly pointed at one that was. A caller routing on `field`
     * was sent to the wrong element.
     */
    const forbid = (
      rule: string,
      meaning: string,
      offenders: {
        present: boolean;
        term: `BG-${number}`;
        group: string;
        setter: string;
        element: string;
      }[],
      allowed: string,
    ) => {
      const found = offenders.filter((o) => o.present);
      if (found.length === 0) return;
      out.push({
        rule,
        field: found.length === 1 ? found[0]!.term : found.map((o) => o.term),
        severity: "fatal",
        message: `The payment means type code (BT-81) is "${code}", which XRechnung treats as ${meaning}, so ${found.length === 1 ? `the ${found[0]!.group} group must not be present — but it is` : `the ${found.map((o) => o.group).join(" and ")} groups must not be present — but they are`}. A payment instruction that names one settlement method and then supplies the account details of another is not merely redundant: the payer's system reads the code, looks for the matching group, and has no rule for what to do with the extra one. XRechnung closes that ambiguity by forbidding it outright.`,
        fix: `Remove ${found.map((o) => o.setter).join(" and ")}, keeping only ${allowed}. If you meant the other method, change payment.meansCode to match it instead — the code is what decides which group is required.`,
        example: `"payment": { "meansCode": "${code}", ${allowed === "payment.iban (BG-17)" ? '"iban": "DE02120300000000202051"' : allowed === "payment.card (BG-18)" ? '"card": { "primaryAccountNumber": "4111111111" }' : '"directDebit": { "mandateReference": "MANDAT-2026-01", "creditorIdentifier": "DE98ZZZ09999999999", "debitedAccount": "DE98700500001234567890" }'} }`,
        xpath: `/ubl:Invoice/cac:PaymentMeans/${found[0]!.element}`,
        docsUrl: `${DOCS}/${rule}`,
      });
    };

    if (CREDIT_TRANSFER_CODES.has(code)) {
      if (!hasTransfer) {
        out.push({
          rule: "BR-DE-23-a",
          field: ["BG-17", "BT-84"],
          severity: "fatal",
          message: `The payment means type code (BT-81) is "${code}", which XRechnung treats as a credit transfer, so the CREDIT TRANSFER group (BG-17) must be present. In UBL that group is cac:PayeeFinancialAccount, and this library emits it only when you supply an account identifier. Core EN 16931 states the same requirement as BR-61; BR-DE-23-a is the German CIUS restating it against the group rather than the field, and both appear in a KoSIT report.`,
          fix: 'Set payment.iban to the account the buyer should transfer to. If you did not intend a credit transfer, change payment.meansCode — "59" for SEPA direct debit (then supply payment.directDebit), "48" for card (then supply payment.card), "97" for clearing between partners — but note each of those brings its own mandatory group.',
          example: `"payment": { "meansCode": "58", "iban": "DE02120300000000202051", "accountName": "Acme GmbH" }`,
          xpath: "/ubl:Invoice/cac:PaymentMeans/cac:PayeeFinancialAccount",
          docsUrl: `${DOCS}/BR-DE-23-a`,
        });
      }
      forbid(
        "BR-DE-23-b",
        "a credit transfer (codes 30 and 58)",
        [
          { present: hasCard, term: "BG-18", group: "PAYMENT CARD INFORMATION (BG-18)", setter: "payment.card", element: "cac:CardAccount" },
          { present: hasDebit, term: "BG-19", group: "DIRECT DEBIT (BG-19)", setter: "payment.directDebit", element: "cac:PaymentMandate" },
        ],
        "payment.iban (BG-17)",
      );
      return out;
    }

    if (CARD_CODES.has(code)) {
      if (!hasCard) {
        out.push({
          rule: "BR-DE-24-a",
          field: "BG-18",
          severity: "fatal",
          message: `The payment means type code (BT-81) is "${code}", which XRechnung treats as a card payment, so exactly one PAYMENT CARD INFORMATION group (BG-18) must be present. BG-18 is not an invitation to put a card number on an invoice: BR-51 caps the primary account number (BT-87) at ten characters, which is the most the PCI Security Standards Council permits — the first six and the last four digits. What the group is actually for is letting the buyer reconcile this invoice against a card statement line they have already been charged for.`,
          fix: 'Set payment.card with the masked primary account number (BT-87) and, optionally, the cardholder name (BT-88). If the invoice is not settled by card, change payment.meansCode instead — "58" (SEPA credit transfer) with payment.iban is what most invoices want.',
          example: `"payment": { "meansCode": "48", "card": { "primaryAccountNumber": "4111111111", "holderName": "M Mustermann" } }`,
          xpath: "/ubl:Invoice/cac:PaymentMeans/cac:CardAccount",
          docsUrl: `${DOCS}/BR-DE-24-a`,
        });
      }
      forbid(
        "BR-DE-24-b",
        "a card payment (codes 48, 54 and 55)",
        [
          { present: hasTransfer, term: "BG-17", group: "CREDIT TRANSFER (BG-17)", setter: "payment.iban", element: "cac:PayeeFinancialAccount" },
          { present: hasDebit, term: "BG-19", group: "DIRECT DEBIT (BG-19)", setter: "payment.directDebit", element: "cac:PaymentMandate" },
        ],
        "payment.card (BG-18)",
      );
      return out;
    }

    if (code === DIRECT_DEBIT_CODE) {
      if (!hasDebit) {
        out.push({
          rule: "BR-DE-25-a",
          field: "BG-19",
          severity: "fatal",
          message: `The payment means type code (BT-81) is "59" (SEPA direct debit), so exactly one DIRECT DEBIT group (BG-19) must be present. BG-19 carries the mandate reference (BT-89), the bank assigned creditor identifier (BT-90, required by BR-DE-30) and the debited account (BT-91, required by BR-DE-31). Those three are what a collection is matched against: without them the buyer's bank cannot tell whether the debit you are about to raise is one they have authorised, and the mandate is what makes the collection lawful rather than merely expected.`,
          fix: 'Set payment.directDebit with mandateReference (BT-89), creditorIdentifier (BT-90, your SEPA Gläubiger-ID) and debitedAccount (BT-91, the payer\'s IBAN). If you are asking to be paid rather than collecting, use payment.meansCode "58" with payment.iban instead — that is what most invoices want even when a mandate exists, since the mandate governs the collection rather than the invoice.',
          example: `"payment": { "meansCode": "59", "directDebit": { "mandateReference": "MANDAT-2026-01", "creditorIdentifier": "DE98ZZZ09999999999", "debitedAccount": "DE98700500001234567890" } }`,
          xpath: "/ubl:Invoice/cac:PaymentMeans/cac:PaymentMandate",
          docsUrl: `${DOCS}/BR-DE-25-a`,
        });
      }
      forbid(
        "BR-DE-25-b",
        "a direct debit (code 59)",
        [
          { present: hasTransfer, term: "BG-17", group: "CREDIT TRANSFER (BG-17)", setter: "payment.iban", element: "cac:PayeeFinancialAccount" },
          { present: hasCard, term: "BG-18", group: "PAYMENT CARD INFORMATION (BG-18)", setter: "payment.card", element: "cac:CardAccount" },
        ],
        "payment.directDebit (BG-19)",
      );
      return out;
    }
    return out;
  },

  // BR-DE-30 / BR-DE-31: BG-19 is not optional in its parts.
  (inv) => {
    if (!isXRechnung(inv)) return null;
    const debit = inv.payment?.directDebit;
    if (!debit) return null;
    const out: TeachingError[] = [];
    if (blank(debit.creditorIdentifier)) {
      out.push({
        rule: "BR-DE-30",
        field: ["BG-19", "BT-90"],
        severity: "fatal",
        message:
          "The invoice carries a DIRECT DEBIT group (BG-19), so the bank assigned creditor identifier (BT-90) must be present. This is your SEPA Gläubiger-Identifikationsnummer — in Germany a 18-character identifier issued by the Bundesbank, of the form DE98ZZZ09999999999 — and it is what the payer's bank uses to check the collection you are about to raise against the mandate they hold. A mandate reference with no creditor identifier names a permission without naming who holds it. Note where it goes in the XML: EN 16931's UBL binding puts BT-90 on the seller party as a cac:PartyIdentification with schemeID=\"SEPA\", not inside the payment group, which is why a document can look complete and still fail this rule.",
        fix: "Set payment.directDebit.creditorIdentifier to your SEPA creditor identifier. Your bank issues it once, on application; it is not derived from your IBAN or your VAT number.",
        example: `"directDebit": { "creditorIdentifier": "DE98ZZZ09999999999" }`,
        xpath: "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyIdentification/cbc:ID",
        docsUrl: `${DOCS}/BR-DE-30`,
      });
    }
    if (blank(debit.debitedAccount)) {
      out.push({
        rule: "BR-DE-31",
        field: ["BG-19", "BT-91"],
        severity: "fatal",
        message:
          "The invoice carries a DIRECT DEBIT group (BG-19), so the debited account identifier (BT-91) must be present. It is the account the money will be taken from — the payer's IBAN, not yours. Under a direct debit the buyer does not act at all: they are told, on this document, which of their accounts you intend to draw on and under which mandate, and that disclosure is the only notice they get before the money moves.",
        fix: "Set payment.directDebit.debitedAccount to the payer's IBAN, exactly as it appears on the signed mandate. If you do not hold it, you do not have a usable mandate, and the invoice should ask for a credit transfer instead (payment.meansCode \"58\" with payment.iban).",
        example: `"directDebit": { "debitedAccount": "DE98700500001234567890" }`,
        xpath: "/ubl:Invoice/cac:PaymentMeans/cac:PaymentMandate/cac:PayerFinancialAccount/cbc:ID",
        docsUrl: `${DOCS}/BR-DE-31`,
      });
    }
    return out;
  },

  // BR-DE-20: BT-91 should be a correct IBAN under code 59. KoSIT flags it
  // `warning` — the same treatment BR-DE-19 gets for BT-84, and for the same
  // reason: a wrong IBAN is a payment that fails, not a document that is
  // malformed.
  (inv) => {
    if (!isXRechnung(inv)) return null;
    const payment = inv.payment;
    if (!payment || payment.meansCode?.trim() !== DIRECT_DEBIT_CODE) return null;
    const value = payment.directDebit?.debitedAccount;
    if (blank(value)) return null; // BR-DE-31 reports absence
    const trimmed = value!.trim();
    if (isValidIban(trimmed)) return null;
    const shapeOk = IBAN_SHAPE.test(trimmed.replace(/\s/g, ""));
    return err({
      rule: "BR-DE-20",
      field: "BT-91",
      severity: "warning",
      message: `The payment means type code (BT-81) is "59" (SEPA direct debit), so the debited account identifier (BT-91) should be a valid IBAN — but "${trimmed}" ${
        shapeOk
          ? "fails the ISO 7064 MOD-97-10 check digits. Positions 3 and 4 are a checksum over the rest of the number, so a single mistyped character makes them disagree."
          : "does not have the shape of one: two letters for the country, two check digits, then up to thirty alphanumeric characters, with no punctuation."
      } This matters more here than it does for your own account under BR-DE-19: a wrong IBAN on a credit transfer means nobody pays you, while a wrong IBAN on a direct debit means you attempt to collect from an account that is not the one on the mandate.`,
      fix: "Set payment.directDebit.debitedAccount to the IBAN written on the signed mandate. Do not retype it from a bank statement, and do not normalise it — take the stored value.",
      example: `"directDebit": { "debitedAccount": "DE98700500001234567890" }`,
      xpath: "/ubl:Invoice/cac:PaymentMeans/cac:PaymentMandate/cac:PayerFinancialAccount/cbc:ID",
      docsUrl: `${DOCS}/BR-DE-20`,
    });
  },

  // BR-DE-22: attachment filenames must be unique across the document.
  (inv) => {
    if (!isXRechnung(inv)) return null;
    const documents = inv.supportingDocuments ?? [];
    if (documents.length < 2) return null;
    const seen = new Map<string, number>();
    const out: TeachingError[] = [];
    for (const [index, doc] of documents.entries()) {
      const filename = doc?.attachment?.filename;
      if (blank(filename)) continue;
      const key = filename!.trim();
      const first = seen.get(key);
      if (first === undefined) {
        seen.set(key, index);
        continue;
      }
      out.push({
        rule: "BR-DE-22",
        field: ["BG-24", "BT-125"],
        severity: "fatal",
        message: `Two embedded attachments carry the same filename "${key}" — supportingDocuments[${first}] and supportingDocuments[${index}]. XRechnung requires the filename attribute of every EmbeddedDocumentBinaryObject to be unique, because the receiving system writes the attachments out to one directory: a duplicate name means one document silently overwrites the other, and the one that survives is whichever the parser happened to reach last.`,
        fix: `Rename one of them. Prefix with the reference (BT-122) or an index — "2026-000142-anlage-1.pdf", "2026-000142-anlage-2.pdf" — so the names stay unique even when two attachments genuinely are the same kind of document.`,
        example: `"attachment": { "filename": "2026-000142-stundennachweis.pdf", "mimeCode": "application/pdf", "content": "JVBERi0xLjQK" }`,
        xpath: `/ubl:Invoice/cac:AdditionalDocumentReference[${index + 1}]/cac:Attachment/cbc:EmbeddedDocumentBinaryObject`,
        docsUrl: `${DOCS}/BR-DE-22`,
      });
    }
    return out;
  },

  // BR-DE-TMP-32: an invoice should say when the supply happened.
  //
  // Severity `information`, which is KoSIT's own flag and a level below
  // `warning`: the document is accepted, silently, and nothing in a validation
  // report tells you otherwise. It is here because the underlying obligation is
  // not advisory at all — §14 Abs. 4 Nr. 6 UStG requires the time of supply on
  // a German invoice — so an XRechnung that passes every validator can still be
  // a defective invoice under tax law. Reporting it as a warning would overstate
  // what the validator does; not reporting it would understate what the law
  // wants. `information` is the honest level, and it is why `Severity` gained a
  // third value in 0.2.0.
  //
  // Two transcription defects, fixed in 0.2.0, both about the difference
  // between a group *existing* and a group being *emitted*:
  //
  //   - `if (inv.invoicingPeriod)` tested object identity, so an empty
  //     `invoicingPeriod: {}` satisfied the rule here while `periodNode` —
  //     which builds the element with `group()`, and `group()` returns null
  //     when every child is empty — wrote no `cac:InvoicePeriod` at all. The
  //     document we then produced was exactly the document KoSIT raises this
  //     against. Same for a line carrying `period: {}`.
  //   - The line branch read `lines.length > 0 && lines.every(...)`. The
  //     official test is `every $line in (cac:InvoiceLine) satisfies
  //     $line/cac:InvoicePeriod`, and XPath's `every` over an empty sequence is
  //     vacuously *true*, so a line-less document passes there and failed here.
  //     BR-16 already rejects such a document; adding a second, wrong finding
  //     on top of it is noise that costs trust.
  (inv) => {
    if (!isXRechnung(inv)) return null;
    if (!blank(inv.deliveryDate)) return null;
    // Mirrors what `periodNode` will actually write.
    const statesAPeriod = (period: InvoicingPeriod | undefined): boolean =>
      !!period &&
      (!blank(period.startDate) ||
        !blank(period.endDate) ||
        !blank(period.descriptionCode));
    if (statesAPeriod(inv.invoicingPeriod)) return null;
    const lines = linesOf(inv);
    if (lines.every((line) => statesAPeriod(line?.period))) return null;
    return err({
      rule: "BR-DE-TMP-32",
      field: ["BT-72", "BG-14"],
      severity: "information",
      message:
        "This invoice states no time of supply: it carries neither an actual delivery date (BT-72), nor an invoicing period (BG-14), nor a period on every invoice line (BG-26). KoSIT raises this at severity `information`, so the document is accepted and no validator will stop you — but §14 Abs. 4 Nr. 6 UStG requires the time of supply on a German invoice, and its absence is a defect the buyer's tax adviser finds long after the portal did not. The three routes are alternatives, not a hierarchy: pick whichever describes the supply.",
      fix: 'Set deliveryDate for a one-off supply ("2026-08-05"), or invoicingPeriod with startDate and endDate for a service billed over a period, or a period on each line when the lines cover different periods. If the supply date is the invoice date, say so explicitly rather than leaving it to be inferred.',
      example: `"invoicingPeriod": { "startDate": "2026-07-01", "endDate": "2026-07-31" }`,
      xpath: "/ubl:Invoice/cac:Delivery/cbc:ActualDeliveryDate",
      docsUrl: `${DOCS}/BR-DE-TMP-32`,
    });
  },

  // BR-DE-26: a corrected invoice (BT-3 = 384) should reference the invoice it
  // corrects. KoSIT flags this `warning`.
  (inv) => {
    if (!isXRechnung(inv)) return null;
    const code = (inv.invoiceTypeCode ?? DEFAULT_INVOICE_TYPE_CODE).trim();
    if (code !== "384") return null;
    // The official test is `cac:BillingReference/cac:InvoiceDocumentReference`
    // — the *element*, not its BT-25 content. The generator writes that element
    // for every entry in `precedingInvoices`, so requiring a non-blank
    // invoiceNumber here reported a warning against a document KoSIT accepts.
    // A reference with no number is still a poor reference, and BR-55 is what
    // says so; BR-DE-26 is only asking whether the group is there.
    const references = (inv.precedingInvoices ?? []).filter(Boolean);
    if (references.length > 0) return null;
    return err({
      rule: "BR-DE-26",
      field: ["BG-3", "BT-25"],
      severity: "warning",
      message:
        'The invoice type code (BT-3) is "384" (corrected invoice), so the PRECEDING INVOICE REFERENCE group (BG-3) should be present at least once, carrying the number of the invoice being corrected (BT-25). A correction that does not say what it corrects leaves the buyer holding two documents for one supply with no way to net them — and leaves your own VAT return unable to show which period the adjustment belongs to. KoSIT flags this `warning` rather than `fatal`, so the document is accepted; the reconciliation problem it creates is not.',
      fix: 'Set precedingInvoices to the invoice you are correcting — [{ "invoiceNumber": "2026-000141", "issueDate": "2026-07-31" }]. The issue date (BT-26) is optional and worth supplying: it is what lets the buyer find the original when your numbering has been reset. If no correction is intended, use "380" (commercial invoice) instead.',
      example: `"invoiceTypeCode": "384", "precedingInvoices": [{ "invoiceNumber": "2026-000141", "issueDate": "2026-07-31" }]`,
      xpath: "/ubl:Invoice/cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID",
      docsUrl: `${DOCS}/BR-DE-26`,
    });
  },

  // BR-DE-21 is deliberately NOT implemented.
  //
  // It requires the specification identifier (BT-24) to be one of the three
  // XRechnung customization ids (CIUS, Extension, CVD). BT-24 is not an input
  // in this model: `generateXRechnungUBL` derives it from `profile` via
  // CUSTOMIZATION_IDS, and the only way to produce a wrong one is to override
  // it through `GenerateOptions.customizationId` — which `validateInput` never
  // sees, because it takes the invoice and not the generate options. A rule
  // that cannot fail is not coverage. The same argument retires BR-01
  // (BT-24 shall be present) and BR-DE-13. See CHANGELOG 0.2.0.
];
