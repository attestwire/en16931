#!/usr/bin/env node
// Smoke-test the BUILT package (dist/) with nothing but Node itself.
//
// `engines` promises Node >=18, but the dev toolchain does not run there:
// vitest 4 and vite need Node 20+. So CI builds and runs the full suite on 20
// and 22, and on 18 runs this instead — the published entry point, exercised
// end to end with no test framework, which is exactly what a Node 18 user gets.
//
//   npm run build && node scripts/smoke-dist.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dist = new URL("../dist/index.js", import.meta.url);
const fixture = new URL("../fixtures/xrechnung-ubl-minimal.xml", import.meta.url);

const {
  AmountRangeError,
  computeTotals,
  generateXRechnungUBL,
  parseUbl,
  validateInput,
} = await import(dist.href);

const xml = readFileSync(fixture, "utf8");

// 1. A shipped fixture parses, validates clean, and regenerates to itself.
const { invoice } = parseUbl(xml);
const result = validateInput(invoice);
assert.equal(result.valid, true, `fixture did not validate: ${JSON.stringify(result.errors)}`);
assert.equal(generateXRechnungUBL(invoice), xml, "parse then generate did not round-trip");

// 2. The 0.8.0 ceiling: a throw from the arithmetic, a finding from validation.
const over = {
  ...invoice,
  lines: [{ ...invoice.lines[0], quantity: 1, unitPrice: 1_000_000_000_000 }],
};
assert.throws(() => computeTotals(over), AmountRangeError);
const overResult = validateInput(over);
assert.equal(overResult.valid, false);
assert.ok(overResult.errors.some((e) => e.rule === "ATW-AMOUNT-OUT-OF-RANGE"));

console.log(`dist smoke test passed on Node ${process.versions.node}`);
