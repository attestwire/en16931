import {
  PEPPOL_CURRENCY_CODES_SET,
  PEPPOL_EAS_SCHEME_CODES,
  PEPPOL_EAS_SCHEME_CODES_SET,
} from "./codelists/index.js";
import { documentKindOf } from "./document-type.js";
import { computeTotals, lineNetAmount, round2 } from "./totals.js";
import { DOCS, blank, err, isIsoDate, isPeppol, linesOf } from "./rule-kit.js";
import type { RuleFn } from "./rule-kit.js";
import type {
  BusinessTerm,
  InvoiceInput,
  TeachingError,
  VatCategory,
} from "./types.js";

/**
 * Peppol BIS Billing 3.0 — the `PEPPOL-EN16931-*` and `PEPPOL-COMMON-*`
 * families, from `rules/sch/PEPPOL-EN16931-UBL.sch` in
 * OpenPEPPOL/peppol-bis-invoice-3.
 *
 * Peppol is a CIUS *and* a network. That double nature is the thing to keep in
 * view while reading this file, because it decides what a finding here is
 * worth. Roughly half of these rules narrow EN 16931 the way XRechnung does —
 * BuyerReference becomes conditionally mandatory, a direct debit must name its
 * mandate. The other half exist because a document is about to be handed to an
 * access point that will route it on a participant identifier, and a scheme
 * the network does not know is not a validation nicety: it is an undeliverable
 * invoice. `PEPPOL-COMMON-R040`..`R053` are that half. They are checksum rules
 * over national organisation numbers, and they catch the transposed digit that
 * an EN 16931 validator, a CIUS validator and your own test suite will all wave
 * through.
 *
 * **Every rule in this file is gated on `profile === "peppol-bis-3"`**, via
 * `isPeppol`, and every message says so. This matters in both directions. A
 * Peppol rule that fired on an `xrechnung-ubl` document would be an
 * over-rejection — the caller would "fix" an invoice that was already correct
 * for its target. And a Peppol rule that did *not* fire on a `peppol-bis-3`
 * document would be a miss that surfaces at the network edge, after the caller
 * believed they had shipped. The same shape as `isXRechnung` in `rules-de.ts`,
 * for the same reason.
 *
 * ## What is deliberately absent
 *
 * A rule the reference schematron carries and this file does not is one of
 * three things, and never a fourth:
 *
 *   - **Generator-controlled.** `R001`, `R004`, `R007`, `R008`, `R043`,
 *     `R044`, `R051`, `R053`, `R054`, `R101`, `R130`. These constrain XML that
 *     `generate.ts` writes from the profile and the model rather than echoing
 *     from the caller: the `ProfileID` and its format, the `CustomizationID`
 *     prefix, the absence of empty elements, the literal `true`/`false` on
 *     `ChargeIndicator`, the `currencyID` on every amount, the number of
 *     `cac:TaxTotal` elements, the `130` on a line document reference, and the
 *     unit code on `cbc:BaseQuantity`. No input can make them fail, so a rule
 *     function for them would assert `true`.
 *   - **Not expressible in the model.** `R080` (at most one project reference)
 *     and `R100` (at most one invoiced object per line) are cardinality limits
 *     on fields this model makes scalar — `projectReference`,
 *     `line.objectIdentifier`. One field, one element, so the count is one by
 *     construction.
 *
 *     `R002` sat on this list too, on the same grounds — `note` is scalar, so
 *     `count(cbc:Note) <= 1` holds by construction. That was true of the *UBL*
 *     assertion and only of the UBL assertion. The CII one, from
 *     `rules/sch/PEPPOL-EN16931-CII.sch` @ v3.0.20, is a different test under
 *     the same id and the same title:
 *
 *     ```
 *     count(ram:IncludedNote) <= 1 and not(ram:IncludedNote/ram:SubjectCode)
 *     ```
 *
 *     The second conjunct forbids BT-21 outright, the title says nothing about
 *     it, and the cardinality reasoning waved the whole assertion through. The
 *     2026-08-14 conformance run caught it: three committed CII fixtures
 *     tripping a "no more than one note" rule while carrying exactly one note.
 *     It is implemented below, as a warning rather than a fatal, because which
 *     syntax you emit decides whether it bites — see the rule for why.
 *   - **Not this document.** Nothing, as of 0.7.0. `P0101` (credit note type
 *     codes) stood here until the Peppol conformance run of 2026-08-14 showed
 *     what its absence cost: `P0100` was firing on credit notes, which the
 *     official rule's `cbc:InvoiceTypeCode` context never sees, so this build
 *     rejected `381` — a code Peppol accepts — on every credit note. Both
 *     rules are now implemented and each is scoped to the document its context
 *     element actually appears on, via `documentKindOf`.
 *
 * The fourth thing — "hard, so skipped" — is not on the list. `R120` and the
 * `COMMON` checksums are here.
 *
 * Rule texts and XPath from `rules/sch/PEPPOL-EN16931-UBL.sch`,
 * OpenPEPPOL/peppol-bis-invoice-3 @ master.
 */

const page = (rule: string): string => `${DOCS}/${rule}`;

/**
 * Appended to every message in this file.
 *
 * A caller who reads a finding and cannot tell whether it applies to them will
 * either ignore it or over-correct, and both are worse than the rule not
 * existing. Naming the profile in the message means the id in the report and
 * the reason it appeared travel together.
 */
const PROFILE_NOTE =
  'This is a Peppol BIS Billing 3.0 profile rule: it applies because profile is "peppol-bis-3". It does not apply to the en16931, xrechnung-ubl or xrechnung-cii profiles, whose validators will accept the same document.';

/** The tolerance Peppol's `u:slack` applies to its two arithmetic rules. */
const SLACK = 0.02;

/** `u:slack($exp, $val, $slack)`: |val − exp| ≤ slack, inclusive at both ends. */
const withinSlack = (value: number, expected: number): boolean =>
  expected + SLACK >= value && expected - SLACK <= value;

/** Render a value for a message without pretending `undefined` is a number. */
const show = (value: unknown): string =>
  value === undefined ? "missing" : value === null ? "null" : String(value);

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

// ---------------------------------------------------------------------------
// Allowance and charge traversal
// ---------------------------------------------------------------------------

/**
 * Every `cac:AllowanceCharge` the R040/R041/R042 contexts address.
 *
 * Note which one is *not* here: `cac:Price/cac:AllowanceCharge`, the BT-147
 * item price discount. Peppol addresses that element under R044 and R046
 * instead, with different rules, and folding it into this walk would make a
 * gross price with a discount but no percentage fail R042 — which it must not,
 * because a price allowance has no percentage term at all.
 */
interface AcEntry {
  amount: number | undefined;
  baseAmount: number | undefined;
  percentage: number | undefined;
  /** "allowances[0]" / "lines[1].charges[0]" — addresses the caller's object. */
  path: string;
  /** "document level allowance" / "line 2 charge". */
  label: string;
  xpath: string;
  /**
   * The business terms for this entry's amount, base amount and percentage.
   *
   * One rule body serves four different groups, and the four name their three
   * amounts with twelve different BT ids: BG-20 uses BT-92/93/94, BG-21
   * BT-99/100/101, BG-27 BT-136/137/138 and BG-28 BT-141/142/143. Before 0.2.0
   * the rules hard-coded the BG-20 triple for all four, so a finding against a
   * line charge was reported against BT-93/BT-94 — terms that belong to a
   * document level allowance. The `xpath` was right throughout, so the two
   * fields contradicted each other and a caller routing on `field` was sent to
   * the wrong element.
   */
  terms: { amount: BusinessTerm; base: BusinessTerm; percentage: BusinessTerm };
}

/** The BT triple for each of the four allowance/charge groups. */
const AC_TERMS = {
  "BG-20": { amount: "BT-92", base: "BT-93", percentage: "BT-94" },
  "BG-21": { amount: "BT-99", base: "BT-100", percentage: "BT-101" },
  "BG-27": { amount: "BT-136", base: "BT-137", percentage: "BT-138" },
  "BG-28": { amount: "BT-141", base: "BT-142", percentage: "BT-143" },
} as const satisfies Record<string, AcEntry["terms"]>;

const allowanceChargeEntries = (inv: InvoiceInput): AcEntry[] => {
  const out: AcEntry[] = [];

  let documentPosition = 0;
  for (const [kind, entries] of [
    ["allowances", inv.allowances],
    ["charges", inv.charges],
  ] as const) {
    for (const [index, entry] of (entries ?? []).entries()) {
      if (!entry) continue;
      documentPosition += 1;
      out.push({
        amount: entry.amount,
        baseAmount: entry.baseAmount,
        percentage: entry.percentage,
        path: `${kind}[${index}]`,
        label: `document level ${kind === "charges" ? "charge" : "allowance"}`,
        xpath: `/ubl:Invoice/cac:AllowanceCharge[${documentPosition}]`,
        terms: kind === "charges" ? AC_TERMS["BG-21"] : AC_TERMS["BG-20"],
      });
    }
  }

  for (const [lineIndex, line] of linesOf(inv).entries()) {
    if (!line) continue;
    let linePosition = 0;
    for (const [kind, entries] of [
      ["allowances", line.allowances],
      ["charges", line.charges],
    ] as const) {
      for (const [index, entry] of (entries ?? []).entries()) {
        if (!entry) continue;
        linePosition += 1;
        out.push({
          amount: entry.amount,
          baseAmount: entry.baseAmount,
          percentage: entry.percentage,
          path: `lines[${lineIndex}].${kind}[${index}]`,
          label: `line ${lineIndex + 1} ${kind === "charges" ? "charge" : "allowance"}`,
          xpath: `/ubl:Invoice/cac:InvoiceLine[${lineIndex + 1}]/cac:AllowanceCharge[${linePosition}]`,
          terms: kind === "charges" ? AC_TERMS["BG-28"] : AC_TERMS["BG-27"],
        });
      }
    }
  }

  return out;
};

// ---------------------------------------------------------------------------
// PEPPOL-COMMON-R040..R053 — national identifier formats
// ---------------------------------------------------------------------------

/**
 * Where an identifier that carries an ISO 6523 / Peppol scheme can sit in this
 * model, with the UBL element the scheme rules address.
 *
 * The schematron contexts are `cbc:EndpointID[@schemeID]`,
 * `cac:PartyIdentification/cbc:ID[@schemeID]` and `cbc:CompanyID[@schemeID]`,
 * which in this model are the electronic address, the party identifier (BT-29 /
 * BT-46 / BT-60) and the legal registration identifier (BT-30 / BT-47 /
 * BT-61). BT-31 also lands in a `cbc:CompanyID`, inside `cac:PartyTaxScheme`,
 * but the generator writes no `schemeID` there — a VAT identifier is scoped by
 * its country prefix, not by an ICD — so it is out of context and deliberately
 * not checked here.
 */
interface SchemedIdentifier {
  schemeId: string;
  value: string;
  /** Model path, for the fix. */
  path: string;
  /** Prose label, for the message. */
  label: string;
  field: BusinessTerm;
  xpath: string;
  /** True for `cbc:EndpointID`; R046 and R048 apply only there. */
  isEndpoint: boolean;
}

const schemedIdentifiers = (inv: InvoiceInput): SchemedIdentifier[] => {
  const out: SchemedIdentifier[] = [];
  const push = (
    entry: { schemeId?: string; value?: string } | undefined,
    spec: Omit<SchemedIdentifier, "schemeId" | "value">,
  ) => {
    if (!entry || blank(entry.schemeId) || blank(entry.value)) return;
    out.push({ ...spec, schemeId: entry.schemeId!.trim(), value: entry.value!.trim() });
  };

  const parties = [
    {
      key: "seller" as const,
      party: inv.seller,
      who: "Seller",
      endpointField: "BT-34" as BusinessTerm,
      idField: "BT-29" as BusinessTerm,
      legalField: "BT-30" as BusinessTerm,
      xpath: "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party",
    },
    {
      key: "buyer" as const,
      party: inv.buyer,
      who: "Buyer",
      endpointField: "BT-49" as BusinessTerm,
      idField: "BT-46" as BusinessTerm,
      legalField: "BT-47" as BusinessTerm,
      xpath: "/ubl:Invoice/cac:AccountingCustomerParty/cac:Party",
    },
  ];

  for (const p of parties) {
    if (!p.party) continue;
    push(p.party.electronicAddress, {
      path: `${p.key}.electronicAddress`,
      label: `${p.who} electronic address`,
      field: p.endpointField,
      xpath: `${p.xpath}/cbc:EndpointID`,
      isEndpoint: true,
    });
    push(p.party.identifier, {
      path: `${p.key}.identifier`,
      label: `${p.who} identifier`,
      field: p.idField,
      xpath: `${p.xpath}/cac:PartyIdentification/cbc:ID`,
      isEndpoint: false,
    });
    push(
      p.party.legalRegistrationId
        ? {
            schemeId: p.party.legalRegistrationSchemeId,
            value: p.party.legalRegistrationId,
          }
        : undefined,
      {
        path: `${p.key}.legalRegistrationId`,
        label: `${p.who} legal registration identifier`,
        field: p.legalField,
        xpath: `${p.xpath}/cac:PartyLegalEntity/cbc:CompanyID`,
        isEndpoint: false,
      },
    );
  }

  push(inv.payee?.identifier, {
    path: "payee.identifier",
    label: "Payee identifier",
    field: "BT-60",
    xpath: "/ubl:Invoice/cac:PayeeParty/cac:PartyIdentification/cbc:ID",
    isEndpoint: false,
  });
  push(inv.payee?.legalRegistrationId, {
    path: "payee.legalRegistrationId",
    label: "Payee legal registration identifier",
    field: "BT-61",
    xpath: "/ubl:Invoice/cac:PayeeParty/cac:PartyLegalEntity/cbc:CompanyID",
    isEndpoint: false,
  });

  return out;
};

const digitsOnly = (value: string): boolean => /^[0-9]+$/.test(value);

/**
 * GS1 mod-10, as `u:gln` computes it: weight the digits 3, 1, 3, 1 … from the
 * one immediately left of the check digit, and the check digit closes the sum
 * to a multiple of ten.
 */
const gln = (value: string): boolean => {
  if (!digitsOnly(value) || value.length < 2) return false;
  const body = value.slice(0, -1);
  const check = Number(value.slice(-1));
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    // i counts from the right of `body`, and the rightmost weight is 3.
    const digit = Number(body[body.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === check;
};

/**
 * The Norwegian organisasjonsnummer check digit: weights 2, 3, 4, 5, 6, 7
 * cycling from the right, modulus 11.
 */
const mod11 = (value: string): boolean => {
  if (!digitsOnly(value) || value.length < 2) return false;
  if (Number(value) <= 0) return false;
  const body = value.slice(0, -1);
  const check = Number(value.slice(-1));
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const digit = Number(body[body.length - 1 - i]);
    sum += digit * ((i % 6) + 2);
  }
  return (11 - (sum % 11)) % 11 === check;
};

/** The Belgian enterprise number: last two digits are 97 − (first eight mod 97). */
const mod97Belgian = (value: string): boolean => {
  if (!/^[0-9]{10}$/.test(value)) return false;
  return Number(value.slice(8, 10)) === 97 - (Number(value.slice(0, 8)) % 97);
};

/** Luhn over the first nine digits, check digit tenth. */
const luhn10 = (value: string): boolean => {
  if (!/^[0-9]{10}$/.test(value)) return false;
  const body = value.slice(0, 9);
  const check = Number(value[9]);
  let sum = 0;
  for (let i = 1; i <= body.length; i += 1) {
    const digit = Number(body[body.length - i]);
    if (i % 2 === 1) {
      const doubled = digit * 2;
      sum += (doubled % 10) + Math.floor(doubled / 10);
    } else {
      sum += digit;
    }
  }
  return (10 - (sum % 10)) % 10 === check;
};

/** The Australian Business Number weighting: first digit less one, mod 89. */
const abn = (value: string): boolean => {
  if (!/^[0-9]{11}$/.test(value)) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  let sum = (Number(value[0]) - 1) * weights[0]!;
  for (let i = 1; i < 11; i += 1) sum += Number(value[i]) * weights[i]!;
  return sum % 89 === 0;
};

/** The Partita IVA check: odd positions plain, even positions through the map. */
const partitaIva = (code: string): boolean => {
  if (!/^[0-9]{11}$/.test(code)) return false;
  const map = "0246813579";
  let sum = 0;
  for (let i = 0; i < code.length; i += 1) {
    const digit = Number(code[i]);
    // 1-based position: odd plain, even mapped. `i` is 0-based, so the parity
    // is inverted relative to the schematron's `$pari` flag, which starts 0.
    sum += i % 2 === 0 ? digit : Number(map[digit]);
  }
  return sum % 10 === 0;
};

const ALPHA = /^[A-Za-z]+$/;

/** Codice Fiscale: sixteen characters in the personal layout, or eleven digits. */
const codiceFiscale = (value: string): boolean => {
  if (value.length === 11) return /^[0-9]+$/.test(value);
  if (value.length !== 16) return false;
  return (
    ALPHA.test(value.slice(0, 6)) &&
    /^[0-9]{2}$/.test(value.slice(6, 8)) &&
    ALPHA.test(value.slice(8, 9)) &&
    /^[0-9]{2}$/.test(value.slice(9, 11)) &&
    /^[0-9]$/.test(value.slice(14, 15)) &&
    ALPHA.test(value.slice(15, 16))
  );
};

/** `u:checkPIVAseIT`: only values actually prefixed `IT` are checked. */
const italianVatCode = (value: string): boolean => {
  const country = value.slice(0, 2).toUpperCase();
  if (country !== "IT") return true;
  return partitaIva(value.slice(2));
};

const danishCvr = (value: string): boolean =>
  (value.length === 10 && value.slice(0, 2) === "DK" && digitsOnly(value.slice(2))) ||
  (value.length === 8 && digitsOnly(value));

interface SchemeCheck {
  rule: string;
  /** Scheme identifiers the rule's context selects. */
  schemes: string[];
  /** True when the rule applies to `cbc:EndpointID` only. */
  endpointOnly?: boolean;
  severity: "fatal" | "warning";
  /** The register the scheme names. */
  register: string;
  ok: (value: string) => boolean;
  /** What a well-formed value looks like. */
  shape: string;
  /** Why the format carries information — what the check actually buys. */
  why: string;
  example: string;
}

/**
 * `PEPPOL-COMMON-R040`..`R053`, in schematron order.
 *
 * Thirteen rules, one table, because the difference between them is a scheme
 * code and an arithmetic — everything else about the finding is the same. The
 * severities are the schematron's, not a judgement: the four Italian schemes
 * and the two secondary Danish ones are `warning`, the rest `fatal`, and that
 * split is worth respecting rather than levelling, since an access point
 * enforces exactly this list at exactly these levels.
 */
const SCHEME_CHECKS: SchemeCheck[] = [
  {
    rule: "PEPPOL-COMMON-R040",
    schemes: ["0088"],
    severity: "fatal",
    register: "GS1 Global Location Number",
    ok: gln,
    shape: "digits only, with a GS1 mod-10 check digit in the last position",
    why: "A GLN is self-checking by design: the final digit closes a weighted sum to a multiple of ten, which is what lets a scanner reject a misread barcode rather than route a pallet to the wrong dock. The same digit rejects a mistyped invoice address here, before an access point tries to resolve it.",
    example: `"electronicAddress": { "schemeId": "0088", "value": "7300010000001" }`,
  },
  {
    rule: "PEPPOL-COMMON-R041",
    schemes: ["0192"],
    severity: "fatal",
    register: "Norwegian organisation number (Enhetsregisteret)",
    ok: (v) => /^[0-9]{9}$/.test(v) && mod11(v),
    shape: "exactly nine digits, the last of which is a modulus-11 check digit",
    why: "Norway's organisasjonsnummer carries its own check digit, and Norway is one of the jurisdictions where Peppol is the mandatory channel for public-sector invoicing — so a transposed digit here is not a warning about data quality, it is an invoice that cannot be delivered.",
    example: `"electronicAddress": { "schemeId": "0192", "value": "991825827" }`,
  },
  {
    rule: "PEPPOL-COMMON-R042",
    schemes: ["0184"],
    severity: "fatal",
    register: "Danish CVR number",
    ok: danishCvr,
    shape: 'eight digits, or "DK" followed by eight digits',
    why: 'The CVR number is accepted both bare and with the country prefix, and those are the only two forms — a nine-digit value, or "DK" with seven digits, is a typo rather than a variant.',
    example: `"electronicAddress": { "schemeId": "0184", "value": "DK12345678" }`,
  },
  {
    rule: "PEPPOL-COMMON-R043",
    schemes: ["0208"],
    severity: "fatal",
    register: "Belgian enterprise number (KBO/BCE)",
    ok: mod97Belgian,
    shape: "exactly ten digits, where the last two are 97 minus the first eight modulo 97",
    why: "The Belgian ondernemingsnummer uses the same modulus-97 construction as an IBAN, which catches every single-digit error and almost every transposition. It only works if the number is stored with its leading zero — a value of nine digits is one that lost it somewhere.",
    example: `"electronicAddress": { "schemeId": "0208", "value": "0848934496" }`,
  },
  {
    rule: "PEPPOL-COMMON-R044",
    schemes: ["0201"],
    severity: "warning",
    register: "Italian IPA code (Codice Univoco Unità Organizzativa)",
    ok: (v) => v.length === 6 && /^[A-Za-z0-9]+$/.test(v),
    shape: "exactly six letters or digits",
    why: "The IPA code addresses a specific organisational unit inside an Italian public body, and it is fixed-width. A value of any other length is usually the body's fiscal code pasted into the wrong field.",
    example: `"electronicAddress": { "schemeId": "0201", "value": "UF9DHV" }`,
  },
  {
    rule: "PEPPOL-COMMON-R045",
    schemes: ["0210"],
    severity: "warning",
    register: "Italian Codice Fiscale",
    ok: codiceFiscale,
    shape:
      "either eleven digits (an organisation), or the sixteen-character personal layout: six letters, two digits, a letter, two digits, three characters, a digit and a letter",
    why: "The Codice Fiscale is issued in two shapes — the eleven-digit form for organisations and the sixteen-character encoded form for individuals — and mixing them up usually means an individual's code was entered for a company or vice versa.",
    example: `"identifier": { "schemeId": "0210", "value": "01234567890" }`,
  },
  {
    rule: "PEPPOL-COMMON-R046",
    schemes: ["9907"],
    endpointOnly: true,
    severity: "warning",
    register: "Italian Codice Fiscale (Peppol endpoint scheme 9907)",
    ok: codiceFiscale,
    shape:
      "either eleven digits, or the sixteen-character personal layout: six letters, two digits, a letter, two digits, three characters, a digit and a letter",
    why: "Scheme 9907 is the endpoint-only spelling of the Codice Fiscale — the same register as 0210, reachable as a routing address. The format rule is the same because the value is the same value.",
    example: `"electronicAddress": { "schemeId": "9907", "value": "01234567890" }`,
  },
  {
    rule: "PEPPOL-COMMON-R047",
    schemes: ["0211"],
    severity: "warning",
    register: "Italian VAT number (Partita IVA)",
    ok: italianVatCode,
    shape: '"IT" followed by eleven digits whose last digit is a Luhn-style check digit',
    why: "The Partita IVA check digit is computed by doubling every second digit and summing the results digit by digit, which catches the transposition that a plain length check does not. Note that a value not beginning with IT passes this rule untested — Peppol only checks what it can recognise.",
    example: `"identifier": { "schemeId": "0211", "value": "IT01234567897" }`,
  },
  {
    rule: "PEPPOL-COMMON-R048",
    schemes: ["9906"],
    endpointOnly: true,
    severity: "warning",
    register: "Italian VAT number (Peppol endpoint scheme 9906)",
    ok: italianVatCode,
    shape: '"IT" followed by eleven digits whose last digit is a check digit',
    why: "Scheme 9906 is the endpoint-only spelling of the Partita IVA, addressed as a routing identifier rather than quoted as a tax number. Same value, same check.",
    example: `"electronicAddress": { "schemeId": "9906", "value": "IT01234567897" }`,
  },
  {
    rule: "PEPPOL-COMMON-R049",
    schemes: ["0007"],
    severity: "fatal",
    register: "Swedish organisation number (Organisationsnummer)",
    ok: luhn10,
    shape: "exactly ten digits ending in a Luhn check digit",
    why: "Sweden's organisationsnummer is a ten-digit Luhn-checked value, written without the hyphen that Swedish paperwork usually shows. Strip the hyphen and keep all ten digits — dropping the century prefix is the common way to break it.",
    example: `"electronicAddress": { "schemeId": "0007", "value": "2021005489" }`,
  },
  {
    rule: "PEPPOL-COMMON-R050",
    schemes: ["0151"],
    severity: "fatal",
    register: "Australian Business Number (ABN)",
    ok: abn,
    shape: "exactly eleven digits, weighted and summed to a multiple of 89",
    why: "The ABN's modulus-89 construction subtracts one from the first digit before weighting, which is why an otherwise plausible eleven-digit number fails: the algorithm is deliberately not a plain checksum, so that a random number almost never validates.",
    example: `"electronicAddress": { "schemeId": "0151", "value": "51824753556" }`,
  },
  {
    rule: "PEPPOL-COMMON-R052",
    schemes: ["0096"],
    severity: "warning",
    register: "Danish chamber of commerce number (P-number)",
    ok: (v) => /^[0-9]{10}$/.test(v),
    shape: "exactly ten digits",
    why: "A Danish P-number identifies a production unit — a site — rather than the legal entity the CVR number identifies. It is ten digits with no check digit, so length is the only thing that can be verified, which is also why this is a warning and not a rejection.",
    example: `"identifier": { "schemeId": "0096", "value": "1234567890" }`,
  },
  {
    rule: "PEPPOL-COMMON-R053",
    schemes: ["0198"],
    severity: "warning",
    register: "Danish ERSTORG number (SE number)",
    ok: (v) =>
      v.length === 10 && v.slice(0, 2) === "DK" && digitsOnly(v.slice(2)),
    shape: '"DK" followed by eight digits',
    why: 'The SE number is the CVR number in its VAT-registration guise, and in this scheme it is always written with the "DK" prefix — unlike scheme 0184, which accepts the bare form as well.',
    example: `"identifier": { "schemeId": "0198", "value": "DK12345678" }`,
  },
];

// ---------------------------------------------------------------------------
// PEPPOL-EN16931-P0104..P0111 — VATEX code implies a category
// ---------------------------------------------------------------------------

/**
 * The VATEX exemption reason codes that pin the category down.
 *
 * These are the codes whose meaning *is* a category. `VATEX-EU-AE` says
 * "reverse charge", so a breakdown quoting it and carrying anything but `AE`
 * contradicts itself in a way a human reader would never notice and an
 * automated bookkeeping system absolutely would. The rest of the VATEX list —
 * the national article references, `VATEX-EU-132-1A` and its many siblings —
 * is not constrained, because those name a provision rather than a treatment.
 *
 * P0110 (`VATEX-EU-I` implies E) was absent before 0.2.0 on the stated grounds
 * that it "appears in the CII binding and not the UBL one". That was exactly
 * backwards — it is in `PEPPOL-EN16931-UBL.sch` at `flag="fatal"` and is *not*
 * in the CII binding at all — so the omission let through documents the Peppol
 * UBL validator rejects, and the comment stopped anyone re-checking. Verify
 * against the schematron, never against a note about the schematron.
 */
const VATEX_CATEGORY_RULES: {
  rule: string;
  code: string;
  category: VatCategory;
  means: string;
}[] = [
  { rule: "PEPPOL-EN16931-P0104", code: "VATEX-EU-G", category: "G", means: "Export outside the EU" },
  { rule: "PEPPOL-EN16931-P0105", code: "VATEX-EU-O", category: "O", means: "Not subject to VAT" },
  { rule: "PEPPOL-EN16931-P0106", code: "VATEX-EU-IC", category: "K", means: "Intra-community supply" },
  { rule: "PEPPOL-EN16931-P0107", code: "VATEX-EU-AE", category: "AE", means: "Reverse charge" },
  { rule: "PEPPOL-EN16931-P0108", code: "VATEX-EU-D", category: "E", means: "Intra-community acquisition from second-hand means of transport" },
  { rule: "PEPPOL-EN16931-P0109", code: "VATEX-EU-F", category: "E", means: "Intra-community acquisition of second-hand goods" },
  { rule: "PEPPOL-EN16931-P0110", code: "VATEX-EU-I", category: "E", means: "Intra-community acquisition of collectors items and antiques" },
  { rule: "PEPPOL-EN16931-P0111", code: "VATEX-EU-J", category: "E", means: "Intra-community acquisition of works of art" },
];

/**
 * UNTDID 1001 codes Peppol billing process 01 admits on an invoice (P0100).
 *
 * Verbatim from the assertion's own `tokenize(...)` literal in
 * `rules/sch/PEPPOL-EN16931-UBL.sch` @ v3.0.20. Its context element is
 * `cbc:InvoiceTypeCode`, which exists only on `ubl:Invoice` — hence the
 * document-kind gate on the rule below.
 */
export const PROFILE_01_INVOICE_TYPE_CODES: ReadonlySet<string> = new Set([
  "71", "80", "82", "84", "102", "218", "219", "326", "331", "380", "382",
  "383", "384", "386", "388", "393", "395", "553", "575", "623", "780", "817",
  "870", "875", "876", "877",
]);

/**
 * UNTDID 1001 codes Peppol billing process 01 admits on a credit note (P0101).
 *
 * Verbatim from the assertion's own `tokenize(...)` literal in the same file,
 * context `cbc:CreditNoteTypeCode`. Five codes against P0100's twenty-six, and
 * the two lists are disjoint — which is the point: a code is admissible on one
 * document type or the other, never both, and Peppol decides which by looking
 * at the element it is written in rather than at the code.
 *
 * `81` is on this list and *not* in `CREDIT_NOTE_TYPE_CODES`, because `81`
 * appears on both halves of BR-CL-01 and this build routes it to `ubl:Invoice`
 * (see `document-type.ts`). A document this build emits for `81` therefore
 * carries `cbc:InvoiceTypeCode`, is judged by P0100, and is rejected by it —
 * which is exactly what the official schematron does to that same document.
 * The divergence is in the routing, not in either rule.
 */
export const PROFILE_01_CREDIT_NOTE_TYPE_CODES: ReadonlySet<string> = new Set([
  "381", "396", "81", "83", "532",
]);

/** BT-3 codes Peppol restricts to German counterparties (P0112). */
const GERMAN_ONLY_TYPE_CODES = new Set(["326", "384"]);

/** UNTDID 4461 payment means that denote a direct debit (R061). */
const DIRECT_DEBIT_MEANS_CODES = new Set(["49", "59"]);

const DEFAULT_TYPE_CODE = "380";

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

export const peppolRules: RuleFn[] = [
  // --- PEPPOL-EN16931-R003: a reference the buyer can post against --------
  (inv) => {
    if (!isPeppol(inv)) return null;
    if (!blank(inv.buyerReference) || !blank(inv.orderReference)) return null;
    return err({
      rule: "PEPPOL-EN16931-R003",
      field: ["BT-10", "BT-13"],
      severity: "fatal",
      message: `A buyer reference (BT-10) or a purchase order reference (BT-13) must be provided, and this invoice carries neither. Core EN 16931 leaves both optional; Peppol makes the pair conditionally mandatory because the network delivers straight into the buyer's accounts payable system, and that system needs one handle to match the invoice against — a cost centre, a requisition, a purchase order. Without one, an invoice that arrives in seconds waits weeks for a human to work out who ordered it. ${PROFILE_NOTE}`,
      fix: "Set buyerReference to whatever reference your customer gave you when they ordered (in Germany this is the Leitweg-ID; elsewhere it is often a cost centre or contact code), or set orderReference to their purchase order number. Either satisfies the rule; supply both if you have both.",
      example: `"buyerReference": "04011000-1234512345-06"`,
      xpath: "/ubl:Invoice/cbc:BuyerReference",
      docsUrl: page("PEPPOL-EN16931-R003"),
    });
  },

  // --- PEPPOL-EN16931-R002: Peppol's CII binding has no BT-21 ------------
  //
  // WHY THIS IS A WARNING AND NOT A FATAL.
  //
  // There are two R002 assertions in the official artefacts, one per syntax,
  // sharing an id and a title and testing different things. UBL's is
  // `count(cbc:Note) <= 1 or ($supplierCountryIsDE and $customerCountryIsDE)`,
  // pure cardinality, which this model satisfies by construction — `note` is
  // scalar. CII's is
  // `count(ram:IncludedNote) <= 1 and not(ram:IncludedNote/ram:SubjectCode)`,
  // which forbids the element BT-21 lives in.
  //
  // `profile` names a CIUS, not a syntax, so at validation time this library
  // does not yet know which of the two documents the caller will generate. On
  // the UBL path — Peppol's mandatory syntax — `noteSubjectCode` is fine: UBL
  // has no element for BT-21 at all, so the binding prefixes it onto the note
  // text as "#AAI#…" and no assertion objects. On the CII path it is fatal.
  // Calling it fatal here would reject a caller whose target is the syntax
  // every Peppol receiver must accept; staying silent would let the CII caller
  // discover it at the access point, or — worse — let `generateCii` drop the
  // field without saying so. A warning that names both outcomes is the honest
  // shape. The generator drops the element under `peppol-bis-3` as well, so the
  // emitted document is conformant either way, and this finding is what tells
  // the caller that happened.
  (inv) => {
    if (!isPeppol(inv)) return null;
    if (blank(inv.noteSubjectCode)) return null;
    return err({
      rule: "PEPPOL-EN16931-R002",
      field: "BT-21",
      severity: "warning",
      message: `The document note subject code (BT-21) is "${inv.noteSubjectCode!.trim()}", and Peppol's CII binding forbids it. The rule is titled "No more than one note is allowed on document level", which is not what its second half does: the test is count(ram:IncludedNote) <= 1 and not(ram:IncludedNote/ram:SubjectCode), so a document carrying exactly one note still fails if that note has a subject code. This is a warning rather than an error because it depends on the syntax you emit, which "peppol-bis-3" does not state. generateXRechnungUBL is unaffected — UBL has no element for BT-21, so its binding folds the code into the note text as "#${inv.noteSubjectCode!.trim()}#…" and Peppol's UBL R002 tests only the note count. generateCii omits the element under this profile, so BT-21 will be absent from the CII document you get back. ${PROFILE_NOTE}`,
      fix: "Remove noteSubjectCode if you intend to send CII over Peppol, and fold whatever it qualified into the note text itself — the code is a UNTDID 4451 subject qualifier, and Peppol takes the view that a free-text note on a Peppol invoice needs no machine-readable subject. Keep it if you are generating UBL, which is Peppol's mandatory syntax and where the code is carried losslessly.",
      example: `"note": "Delivery in two parts, the second on 2026-09-01."`,
      xpath: "/rsm:CrossIndustryInvoice/rsm:ExchangedDocument/ram:IncludedNote/ram:SubjectCode",
      docsUrl: page("PEPPOL-EN16931-R002"),
    });
  },

  // --- PEPPOL-EN16931-R005: two currencies must be two currencies --------
  (inv) => {
    if (!isPeppol(inv)) return null;
    const accounting = inv.vatAccountingCurrency;
    if (blank(accounting)) return null;
    if (accounting!.trim().toUpperCase() !== (inv.currency ?? "").trim().toUpperCase()) {
      return null;
    }
    return err({
      rule: "PEPPOL-EN16931-R005",
      field: ["BT-6", "BT-5"],
      severity: "fatal",
      message: `The VAT accounting currency (BT-6) is "${accounting!.trim()}", which is the same as the invoice currency (BT-5). BT-6 exists for exactly one situation: the tax authority requires VAT to be reported in a currency the invoice is not denominated in — a Swedish invoice in EUR reporting VAT in SEK, say. Setting it to the invoice currency states that situation and then contradicts it, and it obliges you to supply BT-111 (BR-53), a second VAT total in a currency that already has one. ${PROFILE_NOTE}`,
      fix: "Remove vatAccountingCurrency (and taxAmountInAccountingCurrency with it) unless VAT genuinely has to be reported in a second currency. If it does, set vatAccountingCurrency to that currency and leave currency as the one the invoice is billed in.",
      example: `"currency": "EUR", "vatAccountingCurrency": "SEK", "taxAmountInAccountingCurrency": 3812.44`,
      xpath: "/ubl:Invoice/cbc:TaxCurrencyCode",
      docsUrl: page("PEPPOL-EN16931-R005"),
    });
  },

  // --- PEPPOL-EN16931-CL007: Peppol's own currency list ------------------
  //
  // Not a duplicate of BR-CL-04, though it was until recently. The two lists
  // have drifted (see scripts/build-peppol.mjs, which fails the build if the
  // other four mirrored lists ever do the same), so a Peppol document can pass
  // one and fail the other. Both are checked, and each names its own id.
  (inv) => {
    if (!isPeppol(inv)) return null;
    const out: TeachingError[] = [];
    const checks: { value: string | undefined; field: BusinessTerm; path: string; xpath: string; role: string }[] = [
      {
        value: inv.currency,
        field: "BT-5",
        path: "currency",
        xpath: "/ubl:Invoice/cbc:DocumentCurrencyCode",
        role: "the invoice currency, which every amount on the document is denominated in",
      },
      {
        value: inv.vatAccountingCurrency,
        field: "BT-6",
        path: "vatAccountingCurrency",
        xpath: "/ubl:Invoice/cbc:TaxCurrencyCode",
        role: "the VAT accounting currency, which BT-111 is denominated in",
      },
    ];
    for (const check of checks) {
      if (blank(check.value)) continue;
      const code = check.value!.trim().toUpperCase();
      if (PEPPOL_CURRENCY_CODES_SET.has(code)) continue;
      out.push({
        rule: "PEPPOL-EN16931-CL007",
        field: check.field,
        severity: "fatal",
        message: `"${check.value!.trim()}" is not in the ISO 4217 currency list Peppol admits for ${check.field} — ${check.role}. Peppol maintains its own copy of ISO 4217 and refreshes it on its own release cadence, so it is not always the same list as the one BR-CL-04 enforces: a currency the CEN artefact has just added is refused here until Peppol catches up, and one the CEN artefact has just retired is still accepted. Passing BR-CL-04 is therefore not evidence of passing this rule. ${PROFILE_NOTE}`,
        fix: `Set ${check.path} to an ISO 4217 alphabetic code in upper case, from the PEPPOL_CURRENCY_CODES list this package exports. If the currency you need is genuinely absent, the invoice cannot be sent over Peppol in it — bill in a currency the network knows and state the original in the note (BT-22).`,
        example: `"${check.path}": "EUR"`,
        xpath: check.xpath,
        docsUrl: page("PEPPOL-EN16931-CL007"),
      });
    }
    return out;
  },

  // --- PEPPOL-EN16931-CL008: the scheme an access point can route on -----
  (inv) => {
    if (!isPeppol(inv)) return null;
    const out: TeachingError[] = [];
    for (const entry of schemedIdentifiers(inv)) {
      if (!entry.isEndpoint) continue;
      if (PEPPOL_EAS_SCHEME_CODES_SET.has(entry.schemeId)) continue;
      out.push({
        rule: "PEPPOL-EN16931-CL008",
        field: entry.field,
        severity: "fatal",
        message: `The ${entry.label} (${entry.field}) uses the scheme identifier "${entry.schemeId}", which is not in the Peppol Participant Identifier Scheme list. This is the rule people are most surprised by, because "${entry.schemeId}" may well be a perfectly valid CEF Electronic Address Scheme code and satisfy BR-CL-25: the CEN list is the *register* of address schemes, and this one is the subset an access point will actually resolve. A code in the first and not the second gives you a document that passes every validator you can run locally and is refused at the network edge. ${PROFILE_NOTE}`,
        fix: `Set ${entry.path}.schemeId to a code from the PEPPOL_EAS_SCHEME_CODES list this package exports — ${PEPPOL_EAS_SCHEME_CODES.slice(0, 6).join(", ")} and ${PEPPOL_EAS_SCHEME_CODES.length - 6} others. In practice the choice is made for you: it is whichever scheme your counterparty is registered under in the Peppol directory, so look them up rather than guessing.`,
        example: `"electronicAddress": { "schemeId": "0088", "value": "7300010000001" }`,
        xpath: entry.xpath,
        docsUrl: page("PEPPOL-EN16931-CL008"),
      });
    }
    return out;
  },

  // --- PEPPOL-COMMON-R040..R053: national identifier formats -------------
  (inv) => {
    if (!isPeppol(inv)) return null;
    const out: TeachingError[] = [];
    for (const entry of schemedIdentifiers(inv)) {
      for (const check of SCHEME_CHECKS) {
        if (!check.schemes.includes(entry.schemeId)) continue;
        if (check.endpointOnly && !entry.isEndpoint) continue;
        if (check.ok(entry.value)) continue;
        out.push({
          rule: check.rule,
          field: entry.field,
          severity: check.severity,
          message: `The ${entry.label} (${entry.field}) is "${entry.value}" under scheme "${entry.schemeId}", which identifies the ${check.register}. A value in that scheme must be ${check.shape}, and this one is not. ${check.why} ${
            check.severity === "warning"
              ? "Peppol flags this one as a warning rather than a rejection, so the document will be delivered — but a wrong identifier is delivered to the wrong place, or to nowhere."
              : "Peppol flags this fatal: the identifier is what an access point resolves to find your counterparty, so a value that fails its own check digit is undeliverable."
          } ${PROFILE_NOTE}`,
          fix: `Correct ${entry.path}, or change its scheme identifier if the value belongs to a different register. A check digit failing almost always means one digit was transposed or dropped in transcription — compare it against the source register rather than re-typing it.`,
          example: check.example,
          xpath: entry.xpath,
          docsUrl: page(check.rule),
        });
      }
    }
    return out;
  },

  // --- PEPPOL-EN16931-R041 / R042: percentage and base travel together ---
  (inv) => {
    if (!isPeppol(inv)) return null;
    const out: TeachingError[] = [];
    for (const entry of allowanceChargeEntries(inv)) {
      const hasPercentage = isNumber(entry.percentage);
      const hasBase = isNumber(entry.baseAmount);
      if (hasPercentage === hasBase) continue;

      if (hasPercentage) {
        out.push({
          rule: "PEPPOL-EN16931-R041",
          field: [entry.terms.base, entry.terms.percentage],
          severity: "fatal",
          message: `The ${entry.label} states a percentage of ${show(entry.percentage)}% but no base amount. Peppol requires the base whenever the percentage is present, because a percentage on its own is not checkable: the reader can see that you claim ${show(entry.percentage)}% and cannot see ${show(entry.percentage)}% *of what*, so the amount has to be taken on trust. With both terms present, PEPPOL-EN16931-R040 can verify that the amount is what the percentage produces. Core EN 16931 leaves both optional and independent; this is a genuine tightening. ${PROFILE_NOTE}`,
          fix: `Set ${entry.path}.baseAmount to the figure the percentage is applied to, or drop ${entry.path}.percentage and state the amount alone. Note that the base is not necessarily the line or document total — it is whatever your commercial agreement computes the discount on.`,
          example: `{ "amount": 50.00, "baseAmount": 1000.00, "percentage": 5, "reason": "Volume discount" }`,
          xpath: `${entry.xpath}/cbc:BaseAmount`,
          docsUrl: page("PEPPOL-EN16931-R041"),
        });
      } else {
        out.push({
          rule: "PEPPOL-EN16931-R042",
          field: [entry.terms.base, entry.terms.percentage],
          severity: "fatal",
          message: `The ${entry.label} states a base amount of ${show(entry.baseAmount)} but no percentage. Peppol requires the pair to travel together in both directions: a base amount with no percentage names a figure the document then does nothing with, which reads as an incomplete edit rather than a statement. If the adjustment is a flat sum, it has no base — the amount is the whole of it. ${PROFILE_NOTE}`,
          fix: `Set ${entry.path}.percentage to the rate applied to the base, or drop ${entry.path}.baseAmount if the adjustment is a flat amount rather than a proportion.`,
          example: `{ "amount": 50.00, "baseAmount": 1000.00, "percentage": 5, "reason": "Volume discount" }`,
          xpath: `${entry.xpath}/cbc:MultiplierFactorNumeric`,
          docsUrl: page("PEPPOL-EN16931-R042"),
        });
      }
    }
    return out;
  },

  // --- PEPPOL-EN16931-R040: and then the arithmetic must hold ------------
  (inv) => {
    if (!isPeppol(inv)) return null;
    const out: TeachingError[] = [];
    for (const entry of allowanceChargeEntries(inv)) {
      if (!isNumber(entry.percentage) || !isNumber(entry.baseAmount)) continue;
      const amount = isNumber(entry.amount) ? entry.amount : 0;
      const expected = (entry.baseAmount * entry.percentage) / 100;
      if (withinSlack(amount, expected)) continue;
      out.push({
        rule: "PEPPOL-EN16931-R040",
        field: [entry.terms.amount, entry.terms.base, entry.terms.percentage],
        severity: "fatal",
        message: `The ${entry.label} states an amount of ${amount.toFixed(2)} ${inv.currency}, a base amount of ${entry.baseAmount.toFixed(2)} and a percentage of ${entry.percentage}%. Peppol requires the three to agree: ${entry.baseAmount.toFixed(2)} x ${entry.percentage}% = ${round2(expected).toFixed(2)}, and the difference here is ${Math.abs(round2(amount - expected)).toFixed(2)}. The tolerance is 0.02 in the invoice currency — tight, unlike the whole-unit tolerance EN 16931 allows on the VAT rules, because this is not a rounding-strategy question but a multiplication that either was or was not performed. The usual cause is a base amount that was updated when the line changed and an amount that was not. ${PROFILE_NOTE}`,
        fix: `Recompute ${entry.path}.amount as baseAmount x percentage / 100, rounded to two decimals — this package exports round2() for exactly that. If the amount is right and the base is stale, correct the base instead; if the adjustment is not proportional at all, remove both baseAmount and percentage and state the amount alone.`,
        example: `{ "amount": ${round2(expected).toFixed(2)}, "baseAmount": ${entry.baseAmount.toFixed(2)}, "percentage": ${entry.percentage} }`,
        xpath: `${entry.xpath}/cbc:Amount`,
        docsUrl: page("PEPPOL-EN16931-R040"),
      });
    }
    return out;
  },

  // --- PEPPOL-EN16931-R046: the gross price, the discount, the net price -
  (inv) => {
    if (!isPeppol(inv)) return null;
    const out: TeachingError[] = [];
    for (const [index, line] of linesOf(inv).entries()) {
      if (!line || !isNumber(line.grossUnitPrice)) continue;
      const discount = isNumber(line.priceDiscount) ? line.priceDiscount : 0;
      const expected = line.grossUnitPrice - discount;
      if (!isNumber(line.unitPrice)) continue;
      if (round2(line.unitPrice) === round2(expected)) continue;
      out.push({
        rule: "PEPPOL-EN16931-R046",
        field: ["BT-146", "BT-147", "BT-148"],
        severity: "fatal",
        message: `Line ${index + 1} states an item gross price (BT-148) of ${line.grossUnitPrice} and an item price discount (BT-147) of ${discount}, so the item net price (BT-146) must be ${round2(expected)} — but it is ${line.unitPrice}. Peppol requires the identity BT-146 = BT-148 − BT-147 exactly, with no tolerance at all, because these three terms are a single statement written three ways: the list price, what you took off it, and what you actually charged. Two of them disagreeing does not make the third ambiguous, it makes the line untrue. Note that BT-146 is the price the line total is computed from; BT-148 is disclosure. ${PROFILE_NOTE}`,
        fix:
          expected > 0
            ? `Set lines[${index}].unitPrice to ${round2(expected)}, or adjust grossUnitPrice / priceDiscount so the three agree. If there is no discount to disclose, drop grossUnitPrice and priceDiscount and state unitPrice alone — the group is optional.`
            : `Correct the discount, not the net price: lines[${index}].priceDiscount (${discount}) takes away all of grossUnitPrice (${line.grossUnitPrice}), so the identity would put the item net price at ${round2(expected)} — and BR-27 refuses a negative BT-146 outright, because EN 16931 models a reduction as an allowance rather than as a negative price. Lower priceDiscount below grossUnitPrice, or raise grossUnitPrice to the real list price, and then set unitPrice to the difference. If the reduction genuinely exceeds the list price, express it as a line allowance instead: lines[${index}].allowances[] carries the amount (BT-136), an optional base amount and percentage (BT-137/BT-138) and a reason (BT-139/BT-140), and it is subtracted from the line net amount for you.`,
        example: `"unitPrice": 90, "grossUnitPrice": 100, "priceDiscount": 10`,
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:Price/cbc:PriceAmount`,
        docsUrl: page("PEPPOL-EN16931-R046"),
      });
    }
    return out;
  },

  // --- PEPPOL-EN16931-R055: the two VAT totals point the same way --------
  (inv) => {
    if (!isPeppol(inv)) return null;
    if (!isNumber(inv.taxAmountInAccountingCurrency)) return null;
    let taxAmount: number;
    try {
      taxAmount = computeTotals(inv).taxAmount;
    } catch {
      return null; // the line rules report the underlying defect
    }
    const other = inv.taxAmountInAccountingCurrency;
    const sameSign =
      (taxAmount <= 0 && other <= 0) || (taxAmount >= 0 && other >= 0);
    if (sameSign) return null;
    return err({
      rule: "PEPPOL-EN16931-R055",
      field: ["BT-110", "BT-111"],
      severity: "fatal",
      message: `The invoice total VAT amount (BT-110) is ${taxAmount.toFixed(2)} ${inv.currency} and the same total in the VAT accounting currency (BT-111) is ${other.toFixed(2)} ${inv.vatAccountingCurrency ?? ""}. The two must carry the same operational sign, because they are one figure expressed twice — an exchange rate scales a number, it never flips it. Opposite signs mean the second figure was taken from a different document, or that a credit was converted without its sign. ${PROFILE_NOTE}`,
      fix: `Set taxAmountInAccountingCurrency to the computed VAT total converted at the rate your tax authority prescribes for the tax point, keeping the sign: ${taxAmount.toFixed(2)} ${inv.currency} converts to a figure with the same sign, never the opposite one.`,
      example: `"taxAmountInAccountingCurrency": ${Math.abs(other).toFixed(2)}`,
      xpath: "/ubl:Invoice/cac:TaxTotal/cbc:TaxAmount",
      docsUrl: page("PEPPOL-EN16931-R055"),
    });
  },

  // --- PEPPOL-EN16931-R061: a direct debit names its mandate -------------
  (inv) => {
    if (!isPeppol(inv)) return null;
    const payment = inv.payment;
    if (!payment) return null;
    const code = (payment.meansCode ?? "").trim();
    if (!DIRECT_DEBIT_MEANS_CODES.has(code)) return null;
    if (!blank(payment.directDebit?.mandateReference)) return null;
    return err({
      rule: "PEPPOL-EN16931-R061",
      field: "BT-89",
      severity: "fatal",
      message: `The payment means code (BT-81) is "${code}", which is a direct debit — you are telling the buyer that you will take the money rather than that they should send it. Peppol therefore requires the mandate reference (BT-89): the identifier of the authorisation the buyer signed permitting exactly that. Without it the buyer cannot reconcile the collection against a mandate they granted, and under the SEPA rulebook they can reclaim the funds for up to eight weeks with no reason given. Core EN 16931 leaves BT-89 optional; this is a tightening, and a well-judged one. ${PROFILE_NOTE}`,
      fix: 'Set payment.directDebit.mandateReference to the mandate identifier (the Mandatsreferenz) you issued when the buyer signed the mandate. Peppol also expects the creditor identifier and the debited account alongside it — set payment.directDebit.creditorIdentifier and payment.directDebit.debitedAccount too.',
      example: `"payment": { "meansCode": "59", "directDebit": { "mandateReference": "MND-2026-0042", "creditorIdentifier": "DE98ZZZ09999999999", "debitedAccount": "DE02120300000000202051" } }`,
      xpath: "/ubl:Invoice/cac:PaymentMeans/cac:PaymentMandate/cbc:ID",
      docsUrl: page("PEPPOL-EN16931-R061"),
    });
  },

  // --- PEPPOL-EN16931-R110 / R111: a line period sits inside the document's
  (inv) => {
    if (!isPeppol(inv)) return null;
    const documentPeriod = inv.invoicingPeriod;
    if (!documentPeriod) return null;
    const out: TeachingError[] = [];

    for (const [index, line] of linesOf(inv).entries()) {
      const linePeriod = line?.period;
      if (!linePeriod) continue;

      const checks = [
        {
          rule: "PEPPOL-EN16931-R111",
          field: ["BT-135", "BT-74"] as BusinessTerm[],
          lineValue: linePeriod.endDate,
          documentValue: documentPeriod.endDate,
          key: "endDate",
          element: "cbc:EndDate",
          bad: (a: string, b: string) => a > b,
          relation: "must not end after the invoicing period ends",
          why: "A line period that runs past the end of the invoicing period bills for a supply the document has just said it does not cover, which is how the same week gets invoiced twice — once at the end of this period and once at the start of the next.",
        },
        {
          rule: "PEPPOL-EN16931-R110",
          field: ["BT-134", "BT-73"] as BusinessTerm[],
          lineValue: linePeriod.startDate,
          documentValue: documentPeriod.startDate,
          key: "startDate",
          element: "cbc:StartDate",
          bad: (a: string, b: string) => a < b,
          relation: "must not begin before the invoicing period begins",
          why: "A line period starting before the document period claims for time outside the window the invoice declares, and the buyer's accrual for the earlier period has already been closed against a different invoice.",
        },
      ];

      for (const check of checks) {
        if (blank(check.lineValue) || blank(check.documentValue)) continue;
        if (!isIsoDate(check.lineValue) || !isIsoDate(check.documentValue)) continue;
        if (!check.bad(check.lineValue!, check.documentValue!)) continue;
        out.push({
          rule: check.rule,
          field: check.field,
          severity: "fatal",
          message: `Line ${index + 1} carries an invoice line period (BG-26) that ${check.relation}: the line says ${check.lineValue} and the document's invoicing period (BG-14) says ${check.documentValue}. Peppol requires every line period to fall within the document period. ${check.why} Core EN 16931 constrains each period internally (BR-29, BR-30) but never relates the two, so this is a genuine tightening and one that catches a real class of double billing. ${PROFILE_NOTE}`,
          fix: `Either move lines[${index}].period.${check.key} inside the document period, or widen invoicingPeriod.${check.key} to cover it. If the line genuinely belongs to another period, it belongs on another invoice.`,
          example: `"invoicingPeriod": { "startDate": "2026-07-01", "endDate": "2026-07-31" }, "lines": [{ "period": { "startDate": "2026-07-05", "endDate": "2026-07-20" } }]`,
          xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:InvoicePeriod/${check.element}`,
          docsUrl: page(check.rule),
        });
      }
    }
    return out;
  },

  // --- PEPPOL-EN16931-R121: a base quantity is a quantity ----------------
  (inv) => {
    if (!isPeppol(inv)) return null;
    const out: TeachingError[] = [];
    for (const [index, line] of linesOf(inv).entries()) {
      if (!line || line.baseQuantity === undefined) continue;
      const base = line.baseQuantity;
      if (isNumber(base) && base > 0) continue;
      out.push({
        rule: "PEPPOL-EN16931-R121",
        field: "BT-149",
        severity: "fatal",
        message: `Line ${index + 1} has an item price base quantity (BT-149) of ${show(base)}, and Peppol requires it to be a positive number above zero. BT-149 is the denominator of the price: it says "the unit price is for this many units", which is how you quote 12.50 per 100 sheets instead of 0.125 per sheet. Zero would make the line net amount a division by zero, and a negative base would silently invert the sign of the line. Core EN 16931 has no rule on this at all, which is precisely why documents with a zero base reach validators that then fail on the arithmetic instead, reporting BR-CO-10 and sending the reader to the wrong place. ${PROFILE_NOTE}`,
        fix: `Set lines[${index}].baseQuantity to the number of units the unit price covers — 1 in the ordinary case, in which case you can simply omit it. If you meant the invoiced quantity, that is lines[${index}].quantity, a different term.`,
        example: `"unitPrice": 12.5, "baseQuantity": 100, "quantity": 250`,
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cac:Price/cbc:BaseQuantity`,
        docsUrl: page("PEPPOL-EN16931-R121"),
      });
    }
    return out;
  },

  // --- PEPPOL-EN16931-R120: the line net amount, recomputed --------------
  //
  // An invariant of `lineNetAmount`, in the same family as the per-category
  // `-08` rules: the library computes BT-131 and then this rule recomputes it
  // independently and compares. It cannot fire on well-formed input, and that
  // is what it is for — Peppol's tolerance here is 0.02, an eighth of what
  // EN 16931 allows on the VAT rules, so this is the tightest arithmetic check
  // in the whole rule set and the first place a rounding regression would show.
  (inv) => {
    if (!isPeppol(inv)) return null;
    const out: TeachingError[] = [];
    for (const [index, line] of linesOf(inv).entries()) {
      if (!line) continue;
      let actual: number;
      try {
        actual = lineNetAmount(line);
      } catch {
        continue; // BR-26 / PEPPOL-EN16931-R121 report the underlying defect
      }
      if (!isNumber(line.quantity) || !isNumber(line.unitPrice)) continue;
      const base = isNumber(line.baseQuantity) && line.baseQuantity !== 0 ? line.baseQuantity : 1;
      const sum = (entries: { amount?: number }[] | undefined): number =>
        (entries ?? []).reduce(
          (total, entry) => round2(total + (isNumber(entry?.amount) ? round2(entry.amount) : 0)),
          0,
        );
      const expected =
        (line.quantity * line.unitPrice) / base + sum(line.charges) - sum(line.allowances);
      if (withinSlack(actual, expected)) continue;
      out.push({
        rule: "PEPPOL-EN16931-R120",
        field: "BT-131",
        severity: "fatal",
        message: `The invoice line net amount (BT-131) computed for line ${index + 1} is ${actual.toFixed(2)} ${inv.currency}, but Peppol requires it to equal invoiced quantity x (item net price / item price base quantity) + Σ line charges − Σ line allowances, which is ${round2(expected).toFixed(2)}. The tolerance is 0.02 — considerably tighter than the whole-unit tolerance EN 16931 grants the VAT rules, because there is only one correct way to perform this multiplication. ${PROFILE_NOTE}`,
        fix: "The line net amount is computed by this library rather than read from your input, so a mismatch here indicates a defect in its arithmetic and not in your data. Please report it with the invoice payload.",
        xpath: `/ubl:Invoice/cac:InvoiceLine[${index + 1}]/cbc:LineExtensionAmount`,
        docsUrl: page("PEPPOL-EN16931-R120"),
      });
    }
    return out;
  },

  // --- PEPPOL-EN16931-P0100: the type codes the billing process admits ---
  //
  // Scoped to invoices on purpose. The official assertion has context
  // `cbc:InvoiceTypeCode`, an element that appears only on `ubl:Invoice`, so it
  // never sees a credit note — and until 0.7.0 this rule did, and rejected
  // `381` under an id the authority would never have raised on that document.
  // `documentKindOf` is the same function `generate.ts` uses to pick the root
  // element, so the rule and the emitted XML cannot disagree about which of the
  // two type-code elements the code is going to land in.
  (inv) => {
    if (!isPeppol(inv)) return null;
    if (documentKindOf(inv.invoiceTypeCode) !== "invoice") return null;
    const code = (inv.invoiceTypeCode ?? DEFAULT_TYPE_CODE).trim();
    if (blank(code)) return null; // BR-CL-01 / BR-CO-26 report the empty value
    if (PROFILE_01_INVOICE_TYPE_CODES.has(code)) return null;
    return err({
      rule: "PEPPOL-EN16931-P0100",
      field: "BT-3",
      severity: "fatal",
      message: `The invoice type code (BT-3) is "${code}", which billing process 01 does not admit. Peppol's rules are scoped by business process — the ProfileID this library emits is urn:fdc:peppol.eu:2017:poacc:billing:01:1.0, "billing", and each process declares which UNTDID 1001 codes make sense inside it. The permitted set here is 71, 80, 82, 84, 102, 218, 219, 326, 331, 380, 382, 383, 384, 386, 388, 393, 395, 553, 575, 623, 780, 817, 870, 875, 876 and 877. Note that this is a *different* narrowing from BR-CL-01, which admits a wider list, and from XRechnung's BR-DE-17, which admits a narrower one — three lists, three ids, and passing one says nothing about the others. ${PROFILE_NOTE}`,
      fix: 'Use "380" for a commercial invoice, "384" for a corrected invoice, "386" for a prepayment invoice, "875"/"876"/"877" for the construction-industry partial invoices. A credit note is a separate document in UBL and is governed by PEPPOL-EN16931-P0101, not this rule.',
      example: `"invoiceTypeCode": "380"`,
      xpath: "/ubl:Invoice/cbc:InvoiceTypeCode",
      docsUrl: page("PEPPOL-EN16931-P0100"),
    });
  },

  // --- PEPPOL-EN16931-P0101: the same question, asked of a credit note ---
  (inv) => {
    if (!isPeppol(inv)) return null;
    if (documentKindOf(inv.invoiceTypeCode) !== "credit-note") return null;
    const code = (inv.invoiceTypeCode ?? DEFAULT_TYPE_CODE).trim();
    if (blank(code)) return null; // BR-CL-01 / BR-CO-26 report the empty value
    if (PROFILE_01_CREDIT_NOTE_TYPE_CODES.has(code)) return null;
    return err({
      rule: "PEPPOL-EN16931-P0101",
      field: "BT-3",
      severity: "fatal",
      message: `The document type code (BT-3) is "${code}", which makes this a credit note — and billing process 01 does not admit that code on a credit note. Peppol scopes its type codes by business process *and* by document: the ProfileID this library emits is urn:fdc:peppol.eu:2017:poacc:billing:01:1.0, and inside it a credit note may carry only 381, 396, 81, 83 or 532. That is a much shorter list than the twenty-six codes PEPPOL-EN16931-P0100 allows on an invoice, and the two lists share nothing — which is deliberate, because in UBL the code lands in a different element on a different root document (cbc:CreditNoteTypeCode on ubl:CreditNote, not cbc:InvoiceTypeCode on ubl:Invoice) and the receiving system branches on that. Note that BR-CL-01 admits a wider credit-note list than this one, so passing it says nothing here. ${PROFILE_NOTE}`,
      fix: 'Use "381" for an ordinary credit note, which is what almost every credit note in practice is. "396" is a factored credit note, "532" a forwarder\'s credit note. If you meant to issue an invoice rather than a credit note, set invoiceTypeCode to "380" — this build picks the document type from BT-3 alone, so the code is what decided you are looking at this rule and not PEPPOL-EN16931-P0100.',
      example: `"invoiceTypeCode": "381"`,
      xpath: "/ubl:CreditNote/cbc:CreditNoteTypeCode",
      docsUrl: page("PEPPOL-EN16931-P0101"),
    });
  },

  // --- PEPPOL-EN16931-P0112: 326 and 384 are German-only on Peppol -------
  (inv) => {
    if (!isPeppol(inv)) return null;
    const code = (inv.invoiceTypeCode ?? DEFAULT_TYPE_CODE).trim();
    if (!GERMAN_ONLY_TYPE_CODES.has(code)) return null;
    const sellerCountry = (inv.seller?.address?.countryCode ?? "").trim().toUpperCase();
    const buyerCountry = (inv.buyer?.address?.countryCode ?? "").trim().toUpperCase();
    if (sellerCountry === "DE" && buyerCountry === "DE") return null;
    return err({
      rule: "PEPPOL-EN16931-P0112",
      field: ["BT-3", "BT-40", "BT-55"],
      severity: "fatal",
      message: `The invoice type code (BT-3) is "${code}", which Peppol permits only when both the seller and the buyer are German — and here the seller country (BT-40) is "${sellerCountry || "missing"}" and the buyer country (BT-55) is "${buyerCountry || "missing"}". ${
        code === "326"
          ? "Code 326 is a partial invoice: an interim bill against a larger contract, settled later by a final invoice that deducts what was already paid."
          : "Code 384 is a corrected invoice: a document that replaces an earlier one rather than adjusting it with a credit note."
      } Both describe a German invoicing practice (Abschlagsrechnung and Rechnungskorrektur) that receiving systems elsewhere do not implement, so Peppol confines them to domestic German exchanges rather than letting them arrive somewhere that will mis-post them. ${PROFILE_NOTE}`,
      fix: `Use "380" and express the ${code === "326" ? "partial billing through the prepayment amount (paidAmount, BT-113)" : "correction through a credit note, or through 380 with precedingInvoices naming the document you are replacing"}. If both parties really are German, set seller.address.countryCode and buyer.address.countryCode to "DE" — and consider whether the xrechnung-ubl profile is the better target, since it is built for exactly this case.`,
      example: `"invoiceTypeCode": "380"`,
      xpath: "/ubl:Invoice/cbc:InvoiceTypeCode",
      docsUrl: page("PEPPOL-EN16931-P0112"),
    });
  },

  // --- PEPPOL-EN16931-P0104..P0111: a VATEX code that names a category ---
  (inv) => {
    if (!isPeppol(inv)) return null;
    const codes = inv.vatExemptionReasonCodes;
    if (!codes) return null;
    const out: TeachingError[] = [];
    for (const [category, code] of Object.entries(codes) as [VatCategory, string][]) {
      if (blank(code)) continue;
      const normalised = code.trim().toUpperCase();
      for (const spec of VATEX_CATEGORY_RULES) {
        if (spec.code !== normalised) continue;
        if (spec.category === category) continue;
        out.push({
          rule: spec.rule,
          field: ["BT-121", "BT-118"],
          severity: "fatal",
          message: `You set vatExemptionReasonCodes.${category} to "${code.trim()}", which attaches the VAT exemption reason code (BT-121) "${spec.code}" to the VAT breakdown for category ${category}. Peppol requires that code to appear only on category ${spec.category}, because the code *is* a statement of the category: "${spec.code}" means "${spec.means}", and a breakdown that says ${category} in BT-118 and ${spec.means} in BT-121 says two different things about one group of money. A human reader would skim past the contradiction; an automated ledger would post it twice, once per claim. ${PROFILE_NOTE}`,
          fix: `Either move the code — set vatExemptionReasonCodes.${spec.category} instead of vatExemptionReasonCodes.${category} — or pick a code that matches category ${category}. The VATEX list also carries article-level codes (VATEX-EU-132-1A and its siblings) which name a provision rather than a treatment and are not constrained to any category.`,
          example: `"vatExemptionReasonCodes": { "${spec.category}": "${spec.code}" }`,
          xpath: "/ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:TaxExemptionReasonCode",
          docsUrl: page(spec.rule),
        });
      }
    }
    return out;
  },
];
