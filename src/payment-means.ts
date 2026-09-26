import { xpathRoot } from "./document-type.js";
import type { InvoiceFacts, InvoiceInput, TeachingError } from "./types.js";

/**
 * The payment means code (BT-81), inferred from the payment account.
 *
 * BR-49 (and XRechnung's BR-DE-1) make a means code mandatory, and a caller
 * who has an IBAN has no reason to know that UNTDID 4461 wants "58" for it.
 * The account already says what kind of payment it is, so when the code is
 * left out it is filled in from the account, and reported, and never when it
 * is stated.
 *
 * Only a code that is *absent* (`undefined`) is inferred. An empty string is
 * an explicit value, as it is everywhere in this model, and BR-49 judges it:
 * that is also what a document read from XML carries when its payment means
 * code is missing, so `validate()` on a file is untouched by this module.
 */

/**
 * IBAN country prefixes in the SEPA schemes' geographical scope, from the
 * IBAN column of EPC409-09 "EPC list of Countries in the SEPA Schemes'
 * Geographical Scope", version 8.0, issued 24 December 2025. It is a list of
 * prefixes rather than countries because territories bank under their
 * parent's: Åland under FI, the French overseas departments and collectivities
 * under FR, Guernsey, Jersey and the Isle of Man under GB. Albania, Moldova,
 * Montenegro and North Macedonia joined with an operational readiness date of
 * 5 October 2025, Serbia with one of May 2026.
 */
export const SEPA_IBAN_COUNTRIES: ReadonlySet<string> = new Set([
  "AD", "AL", "AT", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES",
  "FI", "FR", "GB", "GI", "GR", "HR", "HU", "IE", "IS", "IT", "LI", "LT",
  "LU", "LV", "MC", "MD", "ME", "MK", "MT", "NL", "NO", "PL", "PT", "RO",
  "RS", "SE", "SI", "SK", "SM", "VA",
]);

/** What was inferred, and the facts it was inferred from. */
export interface PaymentMeansInference {
  code: "58" | "30" | "59" | "49";
  /** The invoice currency (BT-5), upper-cased. */
  currency: string;
  /** The country prefix of the account the inference rests on; empty when none. */
  country: string;
  /** True when the inference rests on a direct-debit mandate (BT-89). */
  mandate: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const given = (value: unknown): boolean =>
  value !== undefined && value !== null && String(value).trim() !== "";

/** The two-letter country prefix of an IBAN, or "" when it has none. */
export const ibanCountry = (iban: unknown): string => {
  if (typeof iban !== "string") return "";
  const prefix = iban.replace(/\s+/g, "").slice(0, 2).toUpperCase();
  return /^[A-Z]{2}$/.test(prefix) ? prefix : "";
};

/**
 * The code the payment instructions imply, or undefined when there is nothing
 * to infer: no payment group, a stated code, or neither a mandate nor an IBAN.
 *
 * A mandate reference means the seller collects, so it decides first: `59`,
 * SEPA direct debit, which exists in euro only, or `49`, direct debit, for
 * any other currency or a debited account outside SEPA. Otherwise an IBAN
 * means the buyer pays: `58`, SEPA credit transfer, in euro to a SEPA
 * account, or `30`, credit transfer, for everything else.
 */
export function inferPaymentMeans(
  input: InvoiceInput | InvoiceFacts,
): PaymentMeansInference | undefined {
  if (!isObject(input)) return undefined;
  const payment = input.payment as unknown;
  if (!isObject(payment) || payment.meansCode !== undefined) return undefined;
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  const debit = payment.directDebit;
  if (isObject(debit) && given(debit.mandateReference)) {
    const country = ibanCountry(debit.debitedAccount);
    const sepa = currency === "EUR" && (country === "" || SEPA_IBAN_COUNTRIES.has(country));
    return { code: sepa ? "59" : "49", currency, country, mandate: true };
  }
  if (given(payment.iban)) {
    const country = ibanCountry(payment.iban);
    const sepa = currency === "EUR" && SEPA_IBAN_COUNTRIES.has(country);
    return { code: sepa ? "58" : "30", currency, country, mandate: false };
  }
  return undefined;
}

/** The input with the inferred code written in. The same object when nothing is inferred. */
export function expandPaymentMeans<T extends InvoiceInput | InvoiceFacts>(input: T): T {
  const inference = inferPaymentMeans(input);
  if (!inference) return input;
  return { ...input, payment: { ...input.payment, meansCode: inference.code } } as T;
}

const MEANS_NAMES: Readonly<Record<PaymentMeansInference["code"], string>> = {
  "58": "SEPA credit transfer",
  "30": "credit transfer",
  "59": "SEPA direct debit",
  "49": "direct debit",
};

/** Why the inference came out as it did, in one clause. */
function because(inference: PaymentMeansInference): string {
  const { code, currency, country, mandate } = inference;
  const shown = currency === "" ? "not stated" : currency;
  if (mandate) {
    if (code === "59") {
      return `the payment instructions carry a direct-debit mandate reference (BT-89) and the invoice is in euro${
        country === "" ? "" : `, debiting an account in ${country}, which takes part in the SEPA scheme`
      }`;
    }
    return `the payment instructions carry a direct-debit mandate reference (BT-89), but ${
      currency !== "EUR"
        ? `the invoice currency (BT-5) is ${shown}, and SEPA direct debits are in euro only`
        : `the debited account's country, ${country}, is not in the SEPA scheme`
    }`;
  }
  if (code === "58") {
    return `there is an IBAN (BT-84), the invoice currency (BT-5) is EUR, and the IBAN's country, ${country}, takes part in the SEPA scheme`;
  }
  return `there is an IBAN (BT-84), but ${
    currency !== "EUR"
      ? `the invoice currency (BT-5) is ${shown}, and SEPA credit transfers are in euro only`
      : country === ""
        ? "it does not start with a country code"
        : `its country, ${country}, is not in the SEPA scheme`
  }`;
}

/** The `ATW-PAYMENT-MEANS-INFERRED` note for an inference. */
export function paymentMeansNote(
  input: InvoiceInput | InvoiceFacts,
  inference: PaymentMeansInference,
): TeachingError {
  const { code } = inference;
  return {
    rule: "ATW-PAYMENT-MEANS-INFERRED",
    field: "BT-81",
    severity: "information",
    message: `payment.meansCode was not given, so the payment means type code (BT-81) was set to "${code}", ${MEANS_NAMES[code]}: ${because(inference)}. This is the code validateInput judged and the generators write.`,
    fix: "Nothing needs fixing. If the buyer should pay another way, state payment.meansCode yourself; a stated code is never replaced.",
    example: inference.mandate
      ? `"payment": { "meansCode": "${code}", "directDebit": { "mandateReference": "MANDAT-2026-01" } }`
      : `"payment": { "meansCode": "${code}", "iban": "DE02120300000000202051" }`,
    xpath: `${xpathRoot(input)}/cac:PaymentMeans/cbc:PaymentMeansCode`,
    docsUrl: "https://github.com/attestwire/en16931#not-implemented-yet",
  };
}
