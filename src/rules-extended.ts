import { allowanceChargeRules } from "./rules-allowance.js";
import { codelistRules } from "./rules-codelists.js";
import { coreRules } from "./rules-core.js";
import { decimalRules } from "./rules-decimals.js";
import { germanRules } from "./rules-de.js";
import { peppolRules } from "./rules-peppol.js";
import { referenceRules } from "./rules-references.js";
import { vatRules } from "./rules-vat.js";
import type { RuleFn } from "./rule-kit.js";

/**
 * The single integration point between `rules.ts` and the rule families added
 * from wave A onwards.
 *
 * `rules.ts` composes `inputRules = [...baseInputRules, ...extendedRules]` and
 * otherwise stays untouched. New families are added by writing a new
 * `rules-*.ts` and appending it to the array below, so two waves working on
 * different families never edit the same lines.
 *
 * Order is presentation order in `validateInput`, nothing more: no rule here
 * depends on another having run, and every rule tolerates input that an
 * earlier rule has already rejected.
 */
export const extendedRules: RuleFn[] = [
  ...coreRules,
  ...codelistRules,
  ...decimalRules,
  ...vatRules,
  ...allowanceChargeRules,
  ...referenceRules,
  ...germanRules,
  ...peppolRules,
];
