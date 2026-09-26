import {
  expandPaymentMeans,
  inferPaymentMeans,
  paymentMeansNote,
} from "./payment-means.js";
import type { AppliedDefaults, InvoiceFacts, InvoiceInput } from "./types.js";
import { applyVatScenarios, expandVatScenarios } from "./vat-scenarios.js";

/**
 * Everything the engine fills in from business facts, in one pass.
 *
 * Two things today: the VAT scenarios (`applyVatScenarios`) and the payment
 * means code inferred from the payment account (`payment-means.ts`). They are
 * one function rather than two options because `validateInput` and both
 * generators must apply exactly the same set, in the same order, or a caller
 * would validate one document and send another. `applyVatScenarios` stays
 * exported on its own for a caller who wants the VAT half only.
 *
 * The two halves touch disjoint fields (lines, allowances, charges and the
 * exemption maps; `payment.meansCode`), so their order cannot change the
 * result. An input neither applies to comes back as the same object.
 */

/**
 * The explicit invoice, without the notes. What the generators and
 * `runInputRules` call.
 */
export function expandDefaults(input: InvoiceInput | InvoiceFacts): InvoiceInput {
  return expandPaymentMeans(expandVatScenarios(input));
}

/**
 * Fill in every code the facts imply, and say what was filled.
 *
 * `applyVatScenarios`, then the payment means code: when `payment.meansCode`
 * is left out (absent, not empty), it becomes `"59"` for a direct-debit
 * mandate in euro (`"49"` otherwise), or, with an IBAN, `"58"` when the
 * currency is EUR and the IBAN's country is in the SEPA scheme (`"30"`
 * otherwise). Each inference is one `ATW-PAYMENT-MEANS-INFERRED` note, after
 * the scenarios' `ATW-VAT-SCENARIO-APPLIED` notes.
 *
 * This is the pass `validateInput`, `generateXRechnungUBL` and `generateCii`
 * apply before anything else, so `applyDefaults(facts).invoice` is the
 * invoice they judge and write. Pure; an input with nothing to fill comes
 * back as the same object with no notes.
 */
export function applyDefaults(input: InvoiceInput | InvoiceFacts): AppliedDefaults {
  const vat = applyVatScenarios(input);
  const inference = inferPaymentMeans(vat.invoice);
  if (!inference) return vat;
  return {
    invoice: expandPaymentMeans(vat.invoice),
    notes: [...vat.notes, paymentMeansNote(vat.invoice, inference)],
  };
}
