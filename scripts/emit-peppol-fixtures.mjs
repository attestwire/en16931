#!/usr/bin/env node
/**
 * Emit `peppol-bis-3` profile documents for `scripts/peppol-check.sh`.
 *
 * These are NOT committed to `fixtures/`. A fixture in that directory has to be
 * acceptable to the authority that judges it, and as of 2026-08-14 two of these
 * five are not (see `scripts/peppol-check.md`). They are generated into a
 * scratch directory at check time so the record stays reproducible without
 * pinning a document nobody has cleared.
 *
 * The inputs are the five committed UBL fixture inputs with `profile` switched
 * to `peppol-bis-3` and nothing else changed. That is deliberate: the question
 * this run answers is what the official Peppol artefacts say about the
 * documents this library already emits, not what they say about documents
 * written to pass them.
 *
 * Run from the package root after `npm run build`:
 *   node scripts/emit-peppol-fixtures.mjs <output-dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { generateCii, generateXRechnungUBL, validateInput } = await import(
  join(here, "..", "dist", "index.js")
);
const {
  creditNoteDiscountXRechnung,
  creditNoteXRechnung,
  discountedXRechnung,
  minimalXRechnung,
  reverseChargeXRechnung,
} = await import(join(here, "..", "dist", "fixtures.js"));

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node scripts/emit-peppol-fixtures.mjs <output-dir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const documents = [
  ["peppol-ubl-minimal.xml", minimalXRechnung],
  ["peppol-ubl-reverse-charge.xml", reverseChargeXRechnung],
  ["peppol-ubl-discount.xml", discountedXRechnung],
  ["peppol-ubl-credit-note.xml", creditNoteXRechnung],
  ["peppol-ubl-credit-note-discount.xml", creditNoteDiscountXRechnung],
];

const ids = (findings) => findings.map((f) => f.rule).join(", ") || "none";

for (const [filename, base] of documents) {
  const input = { ...base, profile: "peppol-bis-3" };
  const result = validateInput(input);
  // The document is written whether or not this build accepts the input. The
  // point of the run is to compare this build's verdict with the authority's,
  // and a document we refuse to emit cannot be compared with anything.
  writeFileSync(join(outDir, filename), generateXRechnungUBL(input), "utf8");
  console.log(
    `${filename}: this build says valid=${result.valid} ` +
      `errors=[${ids(result.errors)}] warnings=[${ids(result.warnings)}] ` +
      `information=[${ids(result.information)}]`,
  );

  // The same five inputs in the other syntax, added 2026-08-14.
  //
  // `generateCii` refused `peppol-bis-3` until 0.7.0, on the stated grounds
  // that Peppol BIS Billing 3.0 is a UBL-only CIUS. It is not: the official
  // package ships PEPPOL-EN16931-CII.sch and declares a
  // `peppolbis-en16931-01-3.0-cii` build configuration, and the BIS guide makes
  // CII D16B optional rather than absent — receivers register for it in the
  // SMP. Emitting both syntaxes from one input is the point: any divergence in
  // verdict between the two files below is a binding defect and not a data one,
  // because the data is identical by construction.
  writeFileSync(
    join(outDir, filename.replace("peppol-ubl-", "peppol-cii-")),
    generateCii(input),
    "utf8",
  );
}
