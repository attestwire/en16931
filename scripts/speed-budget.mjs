#!/usr/bin/env node
// A speed budget for the BUILT package, so a slowdown fails CI instead of
// reaching a user as "the validator got slow".
//
//   npm run build && node scripts/speed-budget.mjs
//
// Two kinds of check, because CI runners are slower and noisier than a laptop:
//
// 1. Absolute ceilings, set ~10-20x above what an M-series laptop measured on
//    2026-09-23 (in brackets). They only catch a large regression, and that is
//    the point: a flaky budget gets deleted.
// 2. A scaling ratio: a 10,000-line invoice against a 1,000-line one. Linear
//    work gives ~9.5x on any machine. It has to be this large: a planted
//    quadratic loop over the lines (a cheap comparison per pair) gave 17x at
//    200 -> 2,000 lines, hidden under the parsing cost, but 21x at 1,000 ->
//    10,000 (32x on a later run). It does not depend on how fast the runner is.
//
// Medians over repeated runs, after a warm-up. No dependencies; runs on Node 18.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BUDGET = {
  importMs: 400, // [24] cold import of dist/index.js
  perDocumentMs: 10, // [0.3-0.8] parse + validate, median over the fixtures
  lines1000Ms: 750, // [26-66] parse + validate one 1,000-line invoice
  cliOneFileMs: 1500, // [50-76] `node dist/bin.js one.xml`, Node startup included
  scaling10x: 15, // [9.4-9.7; 21-32 with a planted O(n^2)] time(10,000 lines) / time(1,000)
  // validate() with a finding on EVERY line, as CII, so each finding is also
  // translated and located. Before child lookups were indexed, locating was
  // quadratic in exactly this case: 216 us a finding at 4,000 lines, 19 at 100.
  locateScaling10x: 15, // [9.7-10.5; 56 with the old unindexed scan] time(10,000 broken lines) / time(1,000)
};

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const median = (fn, runs) => {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(runs / 2)];
};

const importStart = performance.now();
const engine = await import(new URL("../dist/index.js", import.meta.url).href);
const importMs = performance.now() - importStart;

const fixtureDir = here("../fixtures/");
const docs = readdirSync(fixtureDir)
  .filter((f) => f.endsWith(".xml"))
  .map((f) => readFileSync(fixtureDir + f, "utf8"));
const validateAll = () => {
  for (const xml of docs) {
    const parsed = xml.includes("CrossIndustryInvoice")
      ? engine.parseCiiInvoice(xml)
      : engine.parseUblInvoice(xml);
    engine.validateInput(parsed.invoice);
  }
};
for (let i = 0; i < 20; i++) validateAll();
const perDocumentMs = median(validateAll, 31) / docs.length;

const base = engine.parseUbl(readFileSync(fixtureDir + "xrechnung-ubl-minimal.xml", "utf8")).invoice;
const invoiceWith = (n) =>
  engine.generateXRechnungUBL({
    ...base,
    lines: Array.from({ length: n }, (_, i) => ({ ...base.lines[0], id: String(i + 1) })),
  });
// 10,000 lines is past the parser's default 50,000-element limit, so the
// limits are raised here; the default refuses such a file with a message.
const LARGE = { maxElements: 10_000_000, maxCharacters: 1_000_000_000 };
const timeLines = (n, runs) => {
  const xml = invoiceWith(n);
  const once = () => engine.validateInput(engine.parseUblInvoice(xml, LARGE).invoice);
  once();
  return median(once, runs);
};
const lines1000Ms = timeLines(1000, 9);
const scaling10x = timeLines(10_000, 5) / timeLines(1000, 9);

const brokenCii = (n) =>
  engine
    .generateCii({ ...base, profile: "xrechnung-cii", lines: Array.from({ length: n }, (_, i) => ({ ...base.lines[0], id: String(i + 1) })) })
    .replace(/<ram:CategoryCode>S<\/ram:CategoryCode>/g, "<ram:CategoryCode>Q</ram:CategoryCode>");
const timeLocate = (n, runs) => {
  const xml = brokenCii(n);
  const once = () => engine.validate(xml, { limits: LARGE });
  if (once().errors.length < n) throw new Error(`expected a finding per line at ${n} lines`);
  return median(once, runs);
};
const locateScaling10x = timeLocate(10_000, 3) / timeLocate(1000, 7);

const bin = here("../dist/bin.js");
const one = fixtureDir + "xrechnung-ubl-minimal.xml";
const cliOneFileMs = median(() => {
  const r = spawnSync(process.execPath, [bin, one], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`CLI failed on a valid fixture:\n${r.stdout}${r.stderr}`);
}, 7);

const measured = { importMs, perDocumentMs, lines1000Ms, cliOneFileMs, scaling10x, locateScaling10x };
let failed = 0;
console.log(`speed budget on Node ${process.versions.node}`);
for (const [name, limit] of Object.entries(BUDGET)) {
  const value = measured[name];
  const ok = value <= limit;
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "OVER"} ${name.padEnd(14)} ${value.toFixed(2).padStart(9)}   budget ${limit}`);
}
if (failed) {
  console.error(`\n${failed} over budget. If the slowdown is intended, raise the number in scripts/speed-budget.mjs and say why in the commit.`);
  process.exit(1);
}
