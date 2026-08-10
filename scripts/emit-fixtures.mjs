#!/usr/bin/env node
/**
 * Regenerate the example XML documents in `fixtures/`.
 *
 * Run from the package root after `npm run build`:
 *   node scripts/emit-fixtures.mjs
 *
 * The fixtures are committed so that a reviewer (or the KoSIT validator) can
 * look at real output without installing anything. `npm test` asserts that the
 * committed files still match what the current code generates, so a drift shows
 * up as a test failure rather than a stale file.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateXRechnungUBL, validateInput } from "../dist/index.js";
import {
  discountedXRechnung,
  minimalXRechnung,
  reverseChargeXRechnung,
} from "../dist/fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "fixtures");
mkdirSync(outDir, { recursive: true });

const documents = [
  ["xrechnung-ubl-minimal.xml", minimalXRechnung],
  ["xrechnung-ubl-reverse-charge.xml", reverseChargeXRechnung],
  ["xrechnung-ubl-discount.xml", discountedXRechnung],
];

let failed = false;
for (const [filename, input] of documents) {
  const result = validateInput(input);
  if (!result.valid) {
    failed = true;
    console.error(`✗ ${filename}: input is not valid`);
    for (const error of result.errors) {
      console.error(`    ${error.rule} (${error.field}): ${error.message}`);
    }
    continue;
  }
  const xml = generateXRechnungUBL(input);
  writeFileSync(join(outDir, filename), xml, "utf8");
  const warnings = result.warnings.length
    ? ` (${result.warnings.length} warning(s): ${result.warnings.map((w) => w.rule).join(", ")})`
    : "";
  console.log(`✓ ${filename} — ${xml.length} bytes${warnings}`);
}

process.exit(failed ? 1 : 0);
