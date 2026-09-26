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
 *   node scripts/build-peppol.mjs                  # fetch the pinned commit, rewrite the list
 *   PEPPOL_REF=<tag or commit> node scripts/build-peppol.mjs   # try another ref
 *
 * Requires network access. The generated file is committed, so a normal
 * build/test run never touches the network.
 *
 * The script also asserts, and fails on, these things it must not silently
 * absorb:
 *   - that the pinned commit's two UBL schematrons are the files
 *     docs.peppol.eu published for the pinned release (see {@link SCH_SHA256}),
 *   - that the `$eaid` literal is still a `tokenize('…', '\s')` list,
 *   - that the four Peppol code-list rules this package deliberately does
 *     *not* re-implement (CL001, CL002, CL003, CL006) still carry
 *     byte-identical literals to the CEN lists already generated, and
 *   - that the set of live `PEPPOL-EN16931-R*` and `PEPPOL-COMMON-R*` ids is
 *     the set the rule family was written against, in both directions (no id
 *     added upstream, none of ours retired upstream, none we retired revived),
 *     and that each carries the flag the rule family gives it.
 * If any of those changes, the build stops rather than shipping a rule set
 * that quietly disagrees with the network it claims to target.
 *
 * "Live" means outside an XML comment. OpenPEPPOL retires an assertion by
 * commenting it out and leaving it in the file, so every check here reads the
 * schematron with its comments removed.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "src", "codelists");

/**
 * The Peppol BIS Billing 3.0 release this build implements, and where its
 * schematron is read from. Four values that are only worth anything together:
 *
 *   - `VERSION` is the release the conformance record (scripts/peppol-check.md),
 *     the site and the changelog quote.
 *   - `REF` is a commit of OpenPEPPOL/peppol-bis-invoice-3, not a tag, because
 *     OpenPEPPOL does not tag every release. 3.0.21 was published on
 *     docs.peppol.eu on 2026-05-20 and is mandatory from 2026-08-17, and on
 *     2026-09-25 GitHub still had no tag or release for it: its files sit on
 *     the working branch `2026-Q2-QA2`. A branch name moves, so the commit is
 *     pinned. scripts/lib/validator-setup.sh pins the same commit for
 *     scripts/peppol-check.sh, and scripts/test/upstream-check.test.js fails
 *     if the two differ.
 *   - `SCH_SHA256` and `CEN_SCH_SHA256` are the hashes of
 *     `PEPPOL-EN16931-UBL.sch` and `CEN-EN16931-UBL.sch` as docs.peppol.eu
 *     serves them for `VERSION`: the two files access points validate a UBL
 *     invoice against. The commit above holds both byte for byte (so does its
 *     parent, which differs only in the release notes); neither
 *     `2026-Q2-DEV-v3.0.21` nor `2026-Q2-validation-artefacts` does. The build
 *     refuses a pinned `REF` whose files hash differently, and
 *     scripts/upstream-check.mjs compares both hashes with what docs.peppol.eu
 *     serves today. That comparison is how a release OpenPEPPOL never tags gets
 *     noticed, and a hotfix too: 3.0.21 went unnoticed for four months because
 *     the watch read only GitHub.
 */
const VERSION = "3.0.21";
const REF = process.env.PEPPOL_REF ?? "806866bd2bd91d7e9623b68f08164e8fbe9e67a0";
const SCH_SHA256 = "62e5b67892f12755352d78b06f63229a02cc2eccc748677c56efbc8dbcb336e3";
const CEN_SCH_SHA256 = "268d4f7a2688676695e6c69cba6fba69a6802604fee12cb544a6b30ff09555a3";
const SCH_URL = `https://raw.githubusercontent.com/OpenPEPPOL/peppol-bis-invoice-3/${REF}/rules/sch/PEPPOL-EN16931-UBL.sch`;
const CEN_SCH_URL = `https://raw.githubusercontent.com/OpenPEPPOL/peppol-bis-invoice-3/${REF}/rules/sch/CEN-EN16931-UBL.sch`;

const GENERATED_ON = new Date().toISOString().slice(0, 10);

/**
 * Live rule ids the TypeScript rule family was written against. A new one must
 * be triaged: implemented in src/rules-peppol.ts, or recorded there as
 * generator-controlled or not expressible in the model.
 */
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
  "PEPPOL-COMMON-R046", "PEPPOL-COMMON-R047",
  "PEPPOL-COMMON-R049", "PEPPOL-COMMON-R050", "PEPPOL-COMMON-R052",
  "PEPPOL-COMMON-R053", "PEPPOL-COMMON-R054", "PEPPOL-COMMON-R055",
  "PEPPOL-COMMON-R056-1", "PEPPOL-COMMON-R056-2", "PEPPOL-COMMON-R057",
];

/**
 * The ids in {@link KNOWN_R_IDS} the schematron flags `warning`. Every other
 * known id is `fatal`, and the build fails when the schematron disagrees,
 * because a flag is half a rule: it decides whether a document is valid.
 * R052 and R053 were on this list until 3.0.21 made them fatal, and nothing
 * noticed, because the check below only compared ids. The five Dutch rules
 * are warnings in 3.0.21 and OpenPEPPOL says they become fatal in a later
 * release, so expect this list to shrink again.
 *
 * src/rules-invariants.test.ts reads this list and fails if the rule family
 * reports any of these ids at another severity.
 */
const WARNING_R_IDS = [
  "PEPPOL-COMMON-R044", "PEPPOL-COMMON-R045", "PEPPOL-COMMON-R046",
  "PEPPOL-COMMON-R047", "PEPPOL-COMMON-R054", "PEPPOL-COMMON-R055",
  "PEPPOL-COMMON-R056-1", "PEPPOL-COMMON-R056-2", "PEPPOL-COMMON-R057",
];

/**
 * Rule ids OpenPEPPOL has commented out of the schematron, with the release
 * that did it. The rule family must not emit them: a finding the reference
 * validator no longer raises is a false positive, whatever the rule once
 * checked.
 *
 * R048 was retired upstream in 3.0.14 and here only in 0.12.1, because the
 * inventory check used to read the raw file and counted the commented-out id
 * as live.
 */
const RETIRED_R_IDS = {
  "PEPPOL-COMMON-R048": "3.0.14, when scheme 9906 left the participant scheme list",
};

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
 * duplicate of the CEN currency list and has not been since. At v3.0.20
 * Peppol still admitted `ANG` and `BGN`, which the CEN list had retired, and
 * did not yet admit `XCG`, which the CEN list had added. 3.0.21 caught up on
 * all three and moved past the CEN list on a fourth: it admits `STN`, the São
 * Tomé and Príncipe dobra ISO 4217 introduced in 2018, and no longer `STD`, the
 * code it replaced, while CEN validation-1.3.16 still has `STD` and not `STN`.
 * So a Peppol invoice denominated in `STD` passes `BR-CL-04` and fails
 * `PEPPOL-EN16931-CL007`, and one denominated in `STN` does the reverse. Both
 * lists ship, and both rules are implemented.
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

/**
 * Every live `<assert>` in the schematron as `[id, flag]`. Attributes are read
 * by name, whatever their order and quote style, and a quoted value may
 * contain `>`: older files wrote `test="… > 0"` unescaped. An `<assert` this
 * cannot read stops the build, because an assertion skipped here would pass
 * every check below unseen.
 */
function assertions(sch) {
  const found = [...sch.matchAll(/<assert((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g)];
  const total = sch.match(/<assert[\s>]/g)?.length ?? 0;
  if (found.length !== total) {
    fail(`read ${found.length} of the ${total} <assert> elements in the schematron; the parser needs updating.`);
  }
  const attr = (attrs, name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs)?.slice(1).find((v) => v !== undefined);
  return found.map((m) => [attr(m[1], "id"), attr(m[1], "flag")]);
}

async function main() {
  const download = async (url) => {
    const response = await fetch(url);
    if (!response.ok) fail(`GET ${url} → ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const bytes = await download(SCH_URL);
  const raw = bytes.toString("utf8");

  // 0. The pinned commit must hold the files Peppol published for VERSION. An
  //    override is a trial of another ref, so it is reported, not refused, and
  //    src/rules-invariants.test.ts refuses the file it writes.
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const cenSha256 = createHash("sha256").update(await download(CEN_SCH_URL)).digest("hex");
  if (sha256 !== SCH_SHA256 || cenSha256 !== CEN_SCH_SHA256) {
    if (process.env.PEPPOL_REF === undefined) {
      fail(
        `the schematrons at ${REF} are not the files docs.peppol.eu published for ${VERSION}: ` +
          `PEPPOL-EN16931-UBL.sch ${sha256} (pinned ${SCH_SHA256}), ` +
          `CEN-EN16931-UBL.sch ${cenSha256} (pinned ${CEN_SCH_SHA256}). ` +
          `REF, VERSION and both hashes move together; see the note above them.`,
      );
    }
    console.warn(
      `build-peppol: PEPPOL_REF=${REF} is not the pinned ${VERSION} (PEPPOL-EN16931-UBL.sch ` +
        `${sha256}, CEN-EN16931-UBL.sch ${cenSha256}). Compare them with what docs.peppol.eu ` +
        `serves before pinning, and do not commit the file this run writes.`,
    );
  }
  const sch = raw.replace(/<!--[\s\S]*?-->/g, "");

  // 1. The rule inventory must not have moved behind the rule family's back.
  //    Any id in the two families counts, whatever follows the number: 3.0.21
  //    added PEPPOL-COMMON-R056-1 and R056-2, which the old pattern skipped.
  const flags = new Map();
  for (const [id, flag] of assertions(sch)) {
    if (!id || !/^PEPPOL-(?:EN16931-R|COMMON-R)\d/.test(id)) continue;
    flags.set(id, [...new Set([...(flags.get(id) ?? []), flag])]);
  }
  const present = [...flags.keys()].sort();
  const unknown = present.filter((id) => !KNOWN_R_IDS.includes(id) && !(id in RETIRED_R_IDS));
  if (unknown.length > 0) {
    fail(
      `the Peppol schematron carries rule ids this build has never triaged: ${unknown.join(", ")}. ` +
        `Implement or defer each one in src/rules-peppol.ts, then add it to KNOWN_R_IDS.`,
    );
  }
  const revived = present.filter((id) => id in RETIRED_R_IDS);
  if (revived.length > 0) {
    fail(
      `the Peppol schematron runs ${revived.join(", ")} again, which this build retired. ` +
        `Restore it in src/rules-peppol.ts, then move it from RETIRED_R_IDS to KNOWN_R_IDS.`,
    );
  }
  const retired = KNOWN_R_IDS.filter((id) => !present.includes(id));
  if (retired.length > 0) {
    fail(
      `the Peppol schematron no longer runs ${retired.join(", ")}: removed or commented out. ` +
        `Stop emitting it in src/rules-peppol.ts, then move it from KNOWN_R_IDS to RETIRED_R_IDS ` +
        `with the release that retired it.`,
    );
  }
  const reflagged = present
    .filter((id) => KNOWN_R_IDS.includes(id))
    .map((id) => [id, flags.get(id).join("|"), WARNING_R_IDS.includes(id) ? "warning" : "fatal"])
    .filter(([, upstream, ours]) => upstream !== ours);
  if (reflagged.length > 0) {
    fail(
      `the Peppol schematron changed the flag of ` +
        reflagged.map(([id, upstream, ours]) => `${id} (${ours} here, ${upstream} upstream)`).join(", ") +
        `. Change the severity in src/rules-peppol.ts, then WARNING_R_IDS; a flag decides ` +
        `whether a document is valid, so it also needs a changelog entry.`,
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
 * Release: ${sha256 === SCH_SHA256 ? `Peppol BIS Billing ${VERSION}` : `not ${VERSION}: an unpinned trial ref`}
 * Ref:     ${REF}
 * SHA-256: ${sha256}
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
      `verified ${MIRRORED.length} mirrored lists and ${present.length} rule ids and their flags.`,
  );
}

main().catch((error) => fail(String(error?.stack ?? error)));
