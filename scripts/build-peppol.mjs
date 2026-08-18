#!/usr/bin/env node
/**
 * Regenerate `src/codelists/peppol.ts` from the official Peppol BIS
 * Billing 3.0 schematron.
 *
 * Wave A's `build-codelists.mjs` does the same job for the CEN artefact. This
 * one exists because Peppol maintains its *own* copy of the Electronic Address
 * Scheme list and it is not the CEN one: `PEPPOL-EN16931-CL008` asserts
 * membership of `$eaid`, which tracks the Peppol Participant Identifier
 * Scheme code list and moves whenever OpenPEPPOL onboards a new national
 * register. A document can therefore satisfy `BR-CL-25` and be rejected on the
 * Peppol network, or the reverse — so both lists are carried, separately, and
 * the rules that cite them cite different ids.
 *
 *   node scripts/build-peppol.mjs                  # fetch pinned ref, rewrite the list
 *   PEPPOL_REF=master node scripts/build-peppol.mjs
 *
 * Requires network access. The generated file is committed, so a normal
 * build/test run never touches the network.
 *
 * The script also asserts, and fails on, three things it must not silently
 * absorb:
 *   - that the `$eaid` literal is still a `tokenize('…', '\s')` list,
 *   - that the five Peppol code-list rules this package deliberately does
 *     *not* re-implement (CL001, CL002, CL003, CL006, CL007) still carry
 *     byte-identical literals to the CEN lists already generated, and
 *   - that the set of `PEPPOL-EN16931-R*` and `PEPPOL-COMMON-R*` ids has not
 *     grown since the rule family was written.
 * If any of those changes, the build stops rather than shipping a rule set
 * that quietly disagrees with the network it claims to target.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "src", "codelists");

/** Ref of OpenPEPPOL/peppol-bis-invoice-3 the list is taken from. */
const REF = process.env.PEPPOL_REF ?? "master";
const SCH_URL = `https://raw.githubusercontent.com/OpenPEPPOL/peppol-bis-invoice-3/${REF}/rules/sch/PEPPOL-EN16931-UBL.sch`;

const GENERATED_ON = new Date().toISOString().slice(0, 10);

/** Rule ids the TypeScript rule family knows about. A new one must be triaged. */
const KNOWN_R_IDS = [
  "PEPPOL-EN16931-R001", "PEPPOL-EN16931-R002", "PEPPOL-EN16931-R003",
  "PEPPOL-EN16931-R004", "PEPPOL-EN16931-R005", "PEPPOL-EN16931-R007",
  "PEPPOL-EN16931-R008", "PEPPOL-EN16931-R010", "PEPPOL-EN16931-R020",
  "PEPPOL-EN16931-R040", "PEPPOL-EN16931-R041", "PEPPOL-EN16931-R042",
  "PEPPOL-EN16931-R043", "PEPPOL-EN16931-R044", "PEPPOL-EN16931-R046",
  "PEPPOL-EN16931-R051", "PEPPOL-EN16931-R053", "PEPPOL-EN16931-R054",
  "PEPPOL-EN16931-R055", "PEPPOL-EN16931-R061", "PEPPOL-EN16931-R080",
  "PEPPOL-EN16931-R100", "PEPPOL-EN16931-R101", "PEPPOL-EN16931-R110",
  "PEPPOL-EN16931-R111", "PEPPOL-EN16931-R120", "PEPPOL-EN16931-R121",
  "PEPPOL-EN16931-R130",
  "PEPPOL-COMMON-R040", "PEPPOL-COMMON-R041", "PEPPOL-COMMON-R042",
  "PEPPOL-COMMON-R043", "PEPPOL-COMMON-R044", "PEPPOL-COMMON-R045",
  "PEPPOL-COMMON-R046", "PEPPOL-COMMON-R047", "PEPPOL-COMMON-R048",
  "PEPPOL-COMMON-R049", "PEPPOL-COMMON-R050", "PEPPOL-COMMON-R052",
  "PEPPOL-COMMON-R053",
];

/**
 * The Peppol code-list rules whose literal must equal a list this package
 * already generates from the CEN artefact. Keyed by the generated file and
 * export the value is compared against.
 */
const MIRRORED = [
  { letName: "MIMECODE", rule: "PEPPOL-EN16931-CL001", file: "mime.ts", constName: "MIME_CODES" },
  { letName: "UNCL5189", rule: "PEPPOL-EN16931-CL002", file: "allowance-reason.ts", constName: "ALLOWANCE_REASON_CODES" },
  { letName: "UNCL7161", rule: "PEPPOL-EN16931-CL003", file: "charge-reason.ts", constName: "CHARGE_REASON_CODES" },
  { letName: "UNCL2005", rule: "PEPPOL-EN16931-CL006", file: "tax-point-date.ts", constName: "VAT_POINT_DATE_CODES" },
];

/**
 * `ISO4217` is deliberately *not* in {@link MIRRORED}. It used to be a
 * duplicate of the CEN currency list and no longer is: as of this ref Peppol
 * still admits `ANG` and `BGN`, which the CEN list has retired, and does not
 * yet admit `XCG`, which the CEN list has added. So a Peppol invoice
 * denominated in `XCG` passes `BR-CL-04` and fails `PEPPOL-EN16931-CL007`, and
 * one denominated in `BGN` does the reverse. Both lists ship, and both rules
 * are implemented.
 */
const PEPPOL_LISTS = [
  {
    letName: "eaid",
    constName: "PEPPOL_EAS_SCHEME_CODES",
    rule: "PEPPOL-EN16931-CL008",
    listName: "Peppol Participant Identifier Scheme",
    doc: [
      "Electronic address scheme identifiers Peppol admits on BT-34 (seller)",
      "and BT-49 (buyer), under PEPPOL-EN16931-CL008.",
      "",
      "Not the same list as `EAS_SCHEME_CODES`, which comes from the CEN",
      "artefact under BR-CL-25, and the difference is not cosmetic: the CEN",
      "list is the ISO/CEF Electronic Address Scheme register, while this one",
      "is the set of schemes an *access point* will actually route on. A code",
      "in the first and not the second produces a document that validates in a",
      "CIUS checker and is refused at the network edge — which is the more",
      "expensive failure, because it happens after you thought you had",
      "shipped.",
    ],
  },
  {
    letName: "ISO4217",
    constName: "PEPPOL_CURRENCY_CODES",
    rule: "PEPPOL-EN16931-CL007",
    listName: "ISO 4217 alpha-3, Peppol's copy",
    doc: [
      "ISO 4217 currency codes Peppol admits on BT-5 and on every `currencyID`",
      "attribute, under PEPPOL-EN16931-CL007.",
      "",
      "Carried separately from `CURRENCY_CODES` because the two have drifted:",
      "Peppol's copy is refreshed on its own release cadence, so a currency",
      "the CEN list has just added (or just retired) is admitted by one and",
      "refused by the other for as long as the lag lasts. Validating a Peppol",
      "document against the CEN list alone is how a perfectly legal invoice",
      "gets bounced by an access point.",
    ],
  },
];

const fail = (message) => {
  console.error(`build-peppol: ${message}`);
  process.exit(1);
};

/** Pull `<let name="X" value="tokenize('a b c', '\s')" />` out of the schematron. */
function tokenizeLet(source, name) {
  const re = new RegExp(
    `<let\\s+name="${name}"\\s+value="\\s*tokenize\\('([^']*)'`,
    "s",
  );
  const match = re.exec(source);
  if (!match) return null;
  return match[1].split(/\s+/).filter(Boolean);
}

/** Read the frozen array literal back out of a generated codelist module. */
async function generatedList(file, constName) {
  const text = await readFile(join(OUT_DIR, file), "utf8");
  const re = new RegExp(
    `export const ${constName}: readonly string\\[\\] = Object\\.freeze\\(\\[(.*?)\\]\\)`,
    "s",
  );
  const match = re.exec(text);
  if (!match) return null;
  return [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/** Wrap a code list at 72 columns, two-space indented, the way wave A does. */
function formatCodes(codes) {
  const lines = [];
  let current = " ";
  for (const code of codes) {
    const piece = ` "${code}",`;
    if (current.length + piece.length > 74) {
      lines.push(current.trimEnd());
      current = " ";
    }
    current += piece;
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines.map((l) => ` ${l}`.replace(/^\s+/, "  ")).join("\n");
}

async function main() {
  const response = await fetch(SCH_URL);
  if (!response.ok) fail(`GET ${SCH_URL} → ${response.status}`);
  const sch = await response.text();

  // 1. The rule inventory must not have grown behind the rule family's back.
  const present = [
    ...new Set(
      [...sch.matchAll(/id="(PEPPOL-(?:EN16931-R|COMMON-R)\d+)"/g)].map((m) => m[1]),
    ),
  ].sort();
  const unknown = present.filter((id) => !KNOWN_R_IDS.includes(id));
  if (unknown.length > 0) {
    fail(
      `the Peppol schematron carries rule ids this build has never triaged: ${unknown.join(", ")}. ` +
        `Implement or defer each one in src/rules-peppol.ts, then add it to KNOWN_R_IDS.`,
    );
  }

  // 2. The lists we deliberately do not duplicate must still be duplicates.
  for (const spec of MIRRORED) {
    const peppol = tokenizeLet(sch, spec.letName);
    if (!peppol) fail(`no <let name="${spec.letName}"> in the Peppol schematron`);
    const cen = await generatedList(spec.file, spec.constName);
    if (!cen) fail(`could not read ${spec.constName} out of src/codelists/${spec.file}`);
    const a = [...peppol].sort().join(" ");
    const b = [...cen].sort().join(" ");
    if (a !== b) {
      fail(
        `${spec.rule} no longer carries the same list as ${spec.constName} ` +
          `(${spec.file}). The two have diverged, so ${spec.rule} needs its own ` +
          `implementation rather than relying on the CEN rule that mirrors it.`,
      );
    }
  }

  // 3. The lists this package carries on its own account.
  const sections = [];
  const counts = [];
  for (const spec of PEPPOL_LISTS) {
    const codes = tokenizeLet(sch, spec.letName);
    if (!codes || codes.length === 0) {
      fail(`no usable <let name="${spec.letName}"> in ${SCH_URL}`);
    }
    counts.push(`${spec.constName} ${codes.length}`);
    sections.push(`/**
${spec.doc.map((l) => (l ? ` * ${l}` : " *")).join("\n")}
 *
 * ${codes.length} codes.
 */
export const ${spec.constName}: readonly string[] = Object.freeze([
${formatCodes(codes)}
]);

/** Membership lookup for {@link ${spec.constName}}. */
export const ${spec.constName}_SET: ReadonlySet<string> = new Set(
  ${spec.constName},
);`);
  }

  const body = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:  OpenPEPPOL/peppol-bis-invoice-3
 *          rules/sch/PEPPOL-EN16931-UBL.sch
 * Ref:     ${REF}
 * Lists:   ${PEPPOL_LISTS.map((s) => `${s.rule} (${s.listName})`).join("\n *          ")}
 * Emitted: ${GENERATED_ON} by scripts/build-peppol.mjs
 *
 * Regenerate with: node scripts/build-peppol.mjs
 */

${sections.join("\n\n")}
`;

  await writeFile(join(OUT_DIR, "peppol.ts"), body, "utf8");

  // `index.ts` is written by build-codelists.mjs, which knows nothing about the
  // Peppol lists. Re-add the export idempotently so running the two scripts in
  // either order leaves the barrel complete.
  const indexPath = join(OUT_DIR, "index.ts");
  const index = await readFile(indexPath, "utf8");
  const line = `export * from "./peppol.js";`;
  if (!index.includes(line)) {
    await writeFile(indexPath, `${index.trimEnd()}\n${line}\n`, "utf8");
  }
  console.log(
    `build-peppol: wrote peppol.ts (${counts.join(", ")}), ` +
      `verified ${MIRRORED.length} mirrored lists and ${present.length} rule ids.`,
  );
}

main().catch((error) => fail(String(error?.stack ?? error)));
