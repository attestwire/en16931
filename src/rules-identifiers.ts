import { xpathRoot } from "./document-type.js";
import {
  bicProblem,
  hasLeitwegIdForm,
  ibanProblem,
  leitwegIdProblem,
  looksLikeIban,
  sirenProblem,
  siretProblem,
} from "./identifiers.js";
import type { FrenchIdProblem, IbanProblem } from "./identifiers.js";
import { isValidIban as brDe19Accepts } from "./rules-de.js";
import { LIMITS_DOCS, blank, isXRechnung } from "./rule-kit.js";
import type { RuleFn } from "./rule-kit.js";
import type { BusinessTerm, InvoiceInput, TeachingError } from "./types.js";

/**
 * `ATW-LEITWEG-ID-INVALID`, `ATW-IBAN-INVALID`, `ATW-BIC-INVALID`,
 * `ATW-SIREN-INVALID`, `ATW-SIRET-INVALID`: the check digits and formats of the
 * identifiers an invoice is routed and paid on.
 *
 * All five are warnings. The regulation requires none of these checks, KoSIT
 * and Peppol run none of them (bar `BR-DE-19`'s IBAN check, below), and a
 * document that fails one passes the official validators. What fails is what
 * happens next: the portal cannot route to a Leitweg-ID nobody holds, the bank returns
 * a transfer to an IBAN with a mistyped digit, the platform finds no company
 * under a SIREN that does not exist. Catching the typo before submission is
 * the whole point, and an error would overstate what the regulation says.
 *
 * Each identifier is checked only where it is expected or evidently meant:
 *
 *  - a Leitweg-ID wherever an identifier declares scheme 0204, and in the buyer
 *    reference (BT-10) only when that has the complete form of one on an
 *    invoice addressed to Germany. A business buyer may put any reference in
 *    BT-10, and an arbitrary one is never checked;
 *  - an IBAN in BT-84 when the payment means is a SEPA credit transfer (58), or
 *    when the value starts the way an IBAN does, since BT-84 also carries
 *    account numbers that are not IBANs;
 *  - a BIC in BT-86 whenever there is one;
 *  - a SIREN under scheme 0002 and a SIRET under scheme 0009.
 *
 * The algorithms are in `identifiers.ts`, with their sources.
 */

/** Where an identifier that carries an ISO 6523 scheme can sit in this model. */
interface SchemedSlot {
  schemeId: string;
  value: string;
  /** Model path, for the fix. */
  path: string;
  /** Prose label, for the message. */
  label: string;
  field: BusinessTerm;
  xpath: string;
  /** The JSON example for a value in this slot. */
  example: (schemeId: string, value: string) => string;
}

const text = (value: unknown): value is string => typeof value === "string" && !blank(value);

const pairExample =
  (key: string) =>
  (schemeId: string, value: string): string =>
    `"${key}": { "schemeId": "${schemeId}", "value": "${value}" }`;

const legalExample = (schemeId: string, value: string): string =>
  `"legalRegistrationId": "${value}", "legalRegistrationSchemeId": "${schemeId}"`;

/**
 * Every identifier with a scheme: the two electronic addresses, the party
 * identifiers and legal registration identifiers of seller, buyer and payee,
 * and the deliver-to location identifier. The values are read as written and
 * the scheme trimmed, since a padded " 0204" still says what it means (other
 * rules report the padding).
 */
function schemedSlots(inv: InvoiceInput): SchemedSlot[] {
  const root = xpathRoot(inv);
  const out: SchemedSlot[] = [];
  const push = (
    entry: { schemeId?: unknown; value?: unknown } | undefined,
    spec: Omit<SchemedSlot, "schemeId" | "value">,
  ) => {
    if (!entry || !text(entry.schemeId) || !text(entry.value)) return;
    out.push({ ...spec, schemeId: entry.schemeId.trim(), value: entry.value });
  };
  const parties = [
    { key: "seller", party: inv.seller, who: "seller", endpoint: "BT-34", id: "BT-29", legal: "BT-30", xpath: `${root}/cac:AccountingSupplierParty/cac:Party` },
    { key: "buyer", party: inv.buyer, who: "buyer", endpoint: "BT-49", id: "BT-46", legal: "BT-47", xpath: `${root}/cac:AccountingCustomerParty/cac:Party` },
  ] as const;
  for (const p of parties) {
    if (!p.party || typeof p.party !== "object") continue;
    push(p.party.electronicAddress, {
      path: `${p.key}.electronicAddress`,
      label: `${p.who} electronic address`,
      field: p.endpoint,
      xpath: `${p.xpath}/cbc:EndpointID`,
      example: pairExample("electronicAddress"),
    });
    push(p.party.identifier, {
      path: `${p.key}.identifier`,
      label: `${p.who} identifier`,
      field: p.id,
      xpath: `${p.xpath}/cac:PartyIdentification/cbc:ID`,
      example: pairExample("identifier"),
    });
    push(
      { schemeId: p.party.legalRegistrationSchemeId, value: p.party.legalRegistrationId },
      {
        path: `${p.key}.legalRegistrationId`,
        label: `${p.who} legal registration identifier`,
        field: p.legal,
        xpath: `${p.xpath}/cac:PartyLegalEntity/cbc:CompanyID`,
        example: legalExample,
      },
    );
  }
  push(inv.payee?.identifier, {
    path: "payee.identifier",
    label: "payee identifier",
    field: "BT-60",
    xpath: `${root}/cac:PayeeParty/cac:PartyIdentification/cbc:ID`,
    example: pairExample("identifier"),
  });
  push(inv.payee?.legalRegistrationId, {
    path: "payee.legalRegistrationId",
    label: "payee legal registration identifier",
    field: "BT-61",
    xpath: `${root}/cac:PayeeParty/cac:PartyLegalEntity/cbc:CompanyID`,
    example: pairExample("legalRegistrationId"),
  });
  push(inv.deliverToLocationId, {
    path: "deliverToLocationId",
    label: "deliver-to location identifier",
    field: "BT-71",
    xpath: `${root}/cac:Delivery/cac:DeliveryLocation/cbc:ID`,
    example: pairExample("deliverToLocationId"),
  });
  return out;
}

// ---------------------------------------------------------------------------
// Leitweg-ID
// ---------------------------------------------------------------------------

/** The specification's own example, which is a valid Leitweg-ID. */
const LEITWEG_ID_EXAMPLE = "04011000-1234512345-06";

const LEITWEG_ID_WHY =
  "The Leitweg-ID is how the German public sector addresses an e-invoice: the receiving portal routes on it, so an invoice carrying one that was issued to nobody cannot reach the authority it is meant for.";

const LEITWEG_ID_CHECK_DIGITS =
  "its check digits do not match. The last two digits are computed from everything before them with ISO/IEC 7064 MOD 97-10, as the Leitweg-ID format specification 2.0.2 prescribes (section 2.4), so a digit or letter before them is almost certainly mistyped or swapped.";

const LEITWEG_ID_FIX =
  "Copy the Leitweg-ID again from where the buyer gave it to you, such as the order, the contract or the authority's invoicing instructions, rather than retyping it. Do not recompute the check digits to silence this warning: a Leitweg-ID whose digits match but that nobody holds is just as undeliverable.";

const NOT_A_RULE =
  "This is a warning of this library, not a rule of EN 16931 or of a CIUS, so it never makes the invoice invalid.";

/** True when the invoice goes to a German buyer, the only place a Leitweg-ID means anything. */
const addressedToGermany = (inv: InvoiceInput): boolean =>
  isXRechnung(inv) ||
  (typeof inv.buyer?.address?.countryCode === "string" && inv.buyer.address.countryCode.trim().toUpperCase() === "DE") ||
  (typeof inv.buyer?.electronicAddress?.schemeId === "string" && inv.buyer.electronicAddress.schemeId.trim() === "0204");

/** Why a value under scheme 0204 is not in the form of a Leitweg-ID, when the reason is obvious. */
function leitwegFormHint(value: string): string {
  const trimmed = value.trim();
  if (/^[0-9A-Za-z]+$/.test(trimmed)) {
    return " It has no hyphens, and they are part of the Leitweg-ID: without them the coarse address, the fine address and the check digits cannot be told apart.";
  }
  if (/\s/.test(trimmed)) return " It contains whitespace; the parts are separated by hyphen-minus characters and by nothing else.";
  if (/[\u2010-\u2015\u2212]/.test(trimmed)) return " It contains a dash that is not the hyphen-minus (U+002D) the specification prescribes, as word processors substitute.";
  return "";
}

// ---------------------------------------------------------------------------
// IBAN and BIC
// ---------------------------------------------------------------------------

const IBAN_XPATH = "cac:PaymentMeans/cac:PayeeFinancialAccount/cbc:ID";
const BIC_XPATH = "cac:PaymentMeans/cac:PayeeFinancialAccount/cac:FinancialInstitutionBranch/cbc:ID";

function ibanWhat(problem: IbanProblem, value: string, sepa: boolean): string {
  const country = value.replace(/\s/g, "").slice(0, 2).toUpperCase();
  switch (problem.kind) {
    case "form":
      return sepa
        ? `is not one: an IBAN is two letters for the country, two check digits and up to 30 letters and digits, with no punctuation, and a SEPA credit transfer (payment means code 58) pays into nothing else.`
        : `starts like an IBAN but is not one: an IBAN is two letters for the country, two check digits and up to 30 letters and digits, with no punctuation.`;
    case "length":
      return `has ${problem.actual} characters, and an IBAN from ${country} has ${problem.expected} (ISO 13616, as the SWIFT IBAN Registry records it), so a character is missing or doubled.`;
    case "check-digits":
      return "fails the ISO 7064 MOD 97-10 check: the two digits after the country code are computed from the rest of the IBAN, so a mistyped or swapped character makes them disagree.";
    case "case":
      return "is written with lower-case letters. An IBAN is written in capitals (ISO 13616), and a system that compares it as written refuses the lower-case form; KoSIT's BR-DE-19 does.";
  }
}

// ---------------------------------------------------------------------------
// SIREN and SIRET
// ---------------------------------------------------------------------------

/** A valid SIREN and a valid SIRET built on it, for the examples. Neither belongs to a real company that we know of. */
const SIREN_EXAMPLE = "123456782";
const SIRET_EXAMPLE = "12345678200010";

const FRENCH_ID_WHY =
  "French invoicing platforms, Chorus Pro among them, find the company or establishment by this number, so an invoice carrying one that does not exist cannot be matched to it.";

function sirenWhat(problem: FrenchIdProblem, value: string): string {
  const digits = value.replace(/\s/g, "");
  switch (problem) {
    case "form":
      return `is not nine digits.${
        /^[0-9]{14}$/.test(digits)
          ? " Fourteen digits is a SIRET, which identifies one establishment and belongs under scheme 0009; the SIREN is its first nine digits."
          : ""
      }`;
    case "check-digit":
      return "fails the Luhn check its ninth digit exists for, so a digit is almost certainly mistyped or swapped.";
    case "spaces":
      return "is written with spaces. The digits are right, but an identifier is compared as it is written, and a SIREN is nine digits with nothing between them.";
  }
}

function siretWhat(problem: FrenchIdProblem, value: string): string {
  const digits = value.replace(/\s/g, "");
  switch (problem) {
    case "form":
      return `is not fourteen digits.${
        /^[0-9]{9}$/.test(digits) ? " Nine digits is a SIREN, which identifies the company rather than one establishment and belongs under scheme 0002." : ""
      }`;
    case "check-digit":
      return "fails the check: all fourteen digits must pass the Luhn check, and so must the SIREN they begin with. (La Poste's establishments, SIREN 356000000, are the one exception INSEE makes: their digits add up to a multiple of 5 instead, and that is accepted.)";
    case "spaces":
      return "is written with spaces. The digits are right, but an identifier is compared as it is written, and a SIRET is fourteen digits with nothing between them.";
  }
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

export const identifierRules: RuleFn[] = [
  // --- ATW-LEITWEG-ID-INVALID in the buyer reference (BT-10) ---------------
  //
  // Only a value with the complete form of a Leitweg-ID (`hasLeitwegIdForm`:
  // the coarse address a Land code and a length table 1 allows) on an invoice
  // addressed to Germany. Given that form, the only thing left to be wrong is
  // the check digits.
  (inv) => {
    const value = inv.buyerReference;
    if (!text(value) || !hasLeitwegIdForm(value) || !addressedToGermany(inv)) return null;
    if (leitwegIdProblem(value) === null) return null;
    return {
      rule: "ATW-LEITWEG-ID-INVALID",
      field: "BT-10",
      severity: "warning",
      message: `The buyer reference (BT-10) "${value.trim()}" has the form of a Leitweg-ID, but ${LEITWEG_ID_CHECK_DIGITS} ${LEITWEG_ID_WHY} ${NOT_A_RULE} It applies only because the reference has the form of a Leitweg-ID: if it is another kind of reference your buyer gave you, the warning does not apply.`,
      fix: LEITWEG_ID_FIX,
      example: `"buyerReference": "${LEITWEG_ID_EXAMPLE}"`,
      xpath: `${xpathRoot(inv)}/cbc:BuyerReference`,
      docsUrl: LIMITS_DOCS,
    };
  },

  // --- ATW-LEITWEG-ID-INVALID under scheme 0204 -----------------------------
  //
  // ISO 6523 ICD 0204 is the Leitweg-ID (specification, section 1.5), so a
  // value under it is one by declaration, whatever field it is in.
  (inv) => {
    const out: TeachingError[] = [];
    for (const slot of schemedSlots(inv)) {
      if (slot.schemeId !== "0204") continue;
      const problem = leitwegIdProblem(slot.value);
      if (problem === null) continue;
      out.push({
        rule: "ATW-LEITWEG-ID-INVALID",
        field: slot.field,
        severity: "warning",
        message: `The ${slot.label} (${slot.field}) is "${slot.value}" under scheme 0204, which makes it a Leitweg-ID, but ${
          problem === "form"
            ? `it does not have the form of one: a coarse address of 2 to 12 digits, an optional fine address of up to 30 letters and digits, and two check digits, joined by hyphens (Leitweg-ID format specification 2.0.2, section 2).${leitwegFormHint(slot.value)}`
            : LEITWEG_ID_CHECK_DIGITS
        } ${LEITWEG_ID_WHY} ${NOT_A_RULE}`,
        fix: `${LEITWEG_ID_FIX} If the value is not a Leitweg-ID at all, change ${slot.path}'s scheme identifier to the scheme it belongs to.`,
        example: slot.example("0204", LEITWEG_ID_EXAMPLE),
        xpath: slot.xpath,
        docsUrl: LIMITS_DOCS,
      });
    }
    return out;
  },

  // --- ATW-IBAN-INVALID: the payment account identifier (BT-84) --------------
  //
  // BT-84 is an IBAN under a SEPA credit transfer (58) and may be any account
  // number otherwise, so outside 58 only a value that starts like an IBAN is
  // held to being one. On XRechnung with 58, BR-DE-19 already reports a value
  // with the wrong form or check digits, at the same severity, and a second
  // finding would say it twice; what BR-DE-19 does not check, and this does,
  // is the length ISO 13616 gives the IBAN of each country.
  (inv) => {
    const payment = inv.payment;
    if (!payment || typeof payment !== "object" || !text(payment.iban)) return null;
    const value = payment.iban;
    const sepa = typeof payment.meansCode === "string" && payment.meansCode.trim() === "58";
    if (!sepa && !looksLikeIban(value)) return null;
    if (sepa && isXRechnung(inv) && !brDe19Accepts(value.trim())) return null;
    const problem = ibanProblem(value);
    if (problem === null) return null;
    return {
      rule: "ATW-IBAN-INVALID",
      field: "BT-84",
      severity: "warning",
      message: `The payment account identifier (BT-84) "${value.trim()}" ${ibanWhat(problem, value, sepa)} The IBAN is where the buyer's payment goes, and a bank refuses or returns a transfer to one that does not exist. ${NOT_A_RULE}`,
      fix: "Take the IBAN from the account holder's own record, such as the bank's account confirmation, rather than retyping it, and write it in capitals. Spaces between the groups of four are allowed.",
      example: `"payment": { "meansCode": "58", "iban": "DE02120300000000202051" }`,
      xpath: `${xpathRoot(inv)}/${IBAN_XPATH}`,
      docsUrl: LIMITS_DOCS,
    };
  },

  // --- ATW-BIC-INVALID: the payment service provider identifier (BT-86) -----
  (inv) => {
    const payment = inv.payment;
    if (!payment || typeof payment !== "object" || !text(payment.bic)) return null;
    const value = payment.bic;
    const problem = bicProblem(value);
    if (problem === null) return null;
    const trimmed = value.trim();
    const what =
      problem === "form"
        ? "is not a BIC: a BIC is 8 or 11 letters and digits, a four-character bank code, the two-letter country code, a two-character location code and an optional three-character branch code (ISO 9362), with no spaces."
        : problem === "country"
          ? `is not a BIC: its fifth and sixth characters, "${trimmed.slice(4, 6).toUpperCase()}", are where the bank's country code goes, and they are not one.`
          : "is written with lower-case letters. A BIC is written in capitals, and the ISO 20022 payment formats a buyer's system builds from the invoice accept nothing else.";
    return {
      rule: "ATW-BIC-INVALID",
      field: "BT-86",
      severity: "warning",
      message: `The payment service provider identifier (BT-86) "${trimmed}" ${what} It names the bank that holds the account; inside SEPA the IBAN alone is enough, but a malformed BIC is still copied into the buyer's payment. ${NOT_A_RULE}`,
      fix: "Write the BIC as the bank gives it: 8 or 11 capital letters and digits, without spaces. Within SEPA you may also leave payment.bic out, because the IBAN alone identifies the account.",
      example: `"payment": { "meansCode": "58", "iban": "DE02120300000000202051", "bic": "BYLADEM1001" }`,
      xpath: `${xpathRoot(inv)}/${BIC_XPATH}`,
      docsUrl: LIMITS_DOCS,
    };
  },

  // --- ATW-SIREN-INVALID (scheme 0002) and ATW-SIRET-INVALID (0009) ---------
  (inv) => {
    const out: TeachingError[] = [];
    for (const slot of schemedSlots(inv)) {
      const siren = slot.schemeId === "0002";
      if (!siren && slot.schemeId !== "0009") continue;
      const problem = siren ? sirenProblem(slot.value) : siretProblem(slot.value);
      if (problem === null) continue;
      out.push({
        rule: siren ? "ATW-SIREN-INVALID" : "ATW-SIRET-INVALID",
        field: slot.field,
        severity: "warning",
        message: siren
          ? `The ${slot.label} (${slot.field}) is "${slot.value}" under scheme 0002, the French SIRENE register, which makes it a SIREN: the nine digits INSEE gives a company. This one ${sirenWhat(problem, slot.value)} ${FRENCH_ID_WHY} ${NOT_A_RULE}`
          : `The ${slot.label} (${slot.field}) is "${slot.value}" under scheme 0009, which makes it a SIRET: the fourteen digits that identify one establishment of a French company, its SIREN followed by a five-digit establishment number. This one ${siretWhat(problem, slot.value)} ${FRENCH_ID_WHY} ${NOT_A_RULE}`,
        fix: siren
          ? `Take the SIREN from the company's registration, such as its Kbis extract or the SIRENE register, rather than retyping it, and write ${slot.path} as nine digits without spaces.`
          : `Take the SIRET from the SIRENE register or from the party it identifies, rather than retyping it, and write ${slot.path} as fourteen digits without spaces.`,
        example: slot.example(siren ? "0002" : "0009", siren ? SIREN_EXAMPLE : SIRET_EXAMPLE),
        xpath: slot.xpath,
        docsUrl: LIMITS_DOCS,
      });
    }
    return out;
  },
];
