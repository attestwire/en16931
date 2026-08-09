export * from "./types.js";
export { runInputRules, inputRules } from "./rules.js";
export {
  generateXRechnungUBL,
  CUSTOMIZATION_IDS,
  PROFILE_IDS,
  DEFAULT_INVOICE_TYPE_CODE,
  type GenerateOptions,
} from "./generate.js";
export {
  computeTotals,
  lineNetAmount,
  round2,
  formatAmount,
  DEFAULT_EXEMPTION_REASONS,
} from "./totals.js";

export { minimalXRechnung, reverseChargeXRechnung } from "./fixtures.js";

import { runInputRules } from "./rules.js";
import type { InvoiceInput, ValidationResult } from "./types.js";

/**
 * Validate the JSON input model against EN 16931 / CIUS business rules.
 *
 * Returns every finding, not just the first: a teaching error is only useful if
 * you can see the whole set of things wrong with the document at once.
 * Schematron-parity validation of *existing* XML lands next; this entry point's
 * shape is stable — the same TeachingError payload appears everywhere.
 */
export function validateInput(inv: InvoiceInput): ValidationResult {
  const errors = runInputRules(inv);
  return {
    valid: errors.every((e) => e.severity !== "fatal"),
    profile: inv.profile,
    errors: errors.filter((e) => e.severity === "fatal"),
    warnings: errors.filter((e) => e.severity === "warning"),
  };
}
