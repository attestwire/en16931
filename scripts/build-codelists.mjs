#!/usr/bin/env node
/**
 * Regenerate `src/codelists/*.ts` from the official EN 16931 schematron.
 *
 * The code lists this package enforces are not retyped by hand. They are
 * extracted from the *same* artefact the KoSIT validator evaluates —
 * `ubl/schematron/codelist/EN16931-UBL-codes.sch` in
 * ConnectingEurope/eInvoicing-EN16931 — so a BR-CL finding from this library
 * and a BR-CL finding from KoSIT are drawn from one source of truth.
 *
 * Each BR-CL assertion in that file is a literal `contains(' A B C ', …)`
 * membership test. We parse the literal out and emit it as a frozen array.
 *
 *   node scripts/build-codelists.mjs            # fetch pinned ref, rewrite src/codelists
 *   REF=validation-1.3.16 node scripts/…        # pin a different release tag
 *
 * Requires network access. The generated files are committed, so a normal
 * build/test run never touches the network.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "src", "codelists");

/** Release tag of ConnectingEurope/eInvoicing-EN16931 the lists are taken from. */
const REF = process.env.REF ?? "validation-1.3.16";
const CODES_URL = `https://raw.githubusercontent.com/ConnectingEurope/eInvoicing-EN16931/${REF}/ubl/schematron/codelist/EN16931-UBL-codes.sch`;
/**
 * BR-CL-08 (the invoice note subject code, UNCL 4451) does not live in the
 * code-list file: UBL has no element for BT-21, so the binding embeds the code
 * in `cbc:Note` as `#CODE#text` and the membership test lands in the UBL model
 * binding instead. Same repository, same ref — one more fetch.
 */
const MODEL_URL = `https://raw.githubusercontent.com/ConnectingEurope/eInvoicing-EN16931/${REF}/ubl/schematron/UBL/EN16931-UBL-model.sch`;

const GENERATED_ON = new Date().toISOString().slice(0, 10);

/**
 * Every list we extract, keyed by the BR-CL rule whose assertion carries it.
 *
 * `index` picks which `contains('…')` literal to take when an assertion holds
 * more than one (BR-CL-01 carries the invoice list and the credit-note list).
 */
const SPECS = [
  {
    file: "invoice-type.ts",
    rule: "BR-CL-01",
    index: 0,
    constName: "INVOICE_TYPE_CODES",
    listName: "UNTDID 1001, invoice subset",
    doc: [
      "UNTDID 1001 document type codes admissible on an EN 16931 *invoice* (BT-3).",
      "",
      "This is the invoice half of BR-CL-01. The credit-note half is",
      "`CREDIT_NOTE_TYPE_CODES_CL`: in UBL a credit note is a separate",
      "`CreditNote` document with its own `cbc:CreditNoteTypeCode`, so the two",
      "lists are never interchangeable on one document.",
    ],
  },
  {
    file: "invoice-type.ts",
    rule: "BR-CL-01",
    index: 1,
    constName: "CREDIT_NOTE_TYPE_CODES_CL",
    listName: "UNTDID 1001, credit-note subset",
    append: true,
    doc: [
      "UNTDID 1001 document type codes admissible on an EN 16931 *credit note*",
      "(`cbc:CreditNoteTypeCode`). Present for completeness and for validating",
      "existing documents; this build does not generate credit notes.",
    ],
  },
  {
    file: "currency.ts",
    rule: "BR-CL-04",
    index: 0,
    constName: "CURRENCY_CODES",
    listName: "ISO 4217 alpha-3",
    doc: [
      "ISO 4217 alphabetic currency codes, as admitted by BR-CL-03/BR-CL-04.",
      "",
      "Includes the fund codes (BOV, CHE, CHW, CLF, COU, MXV, USN, UYI, …) and",
      "the metals (XAU, XAG, XPD, XPT) — the schematron admits the whole list,",
      "so we do too rather than second-guessing which are plausible on an",
      "invoice.",
    ],
  },
  {
    file: "country.ts",
    rule: "BR-CL-14",
    index: 0,
    constName: "COUNTRY_CODES",
    listName: "ISO 3166-1 alpha-2",
    doc: [
      "ISO 3166-1 alpha-2 country codes, as admitted by BR-CL-14 for every",
      "`cac:Country/cbc:IdentificationCode` in the document (BT-40 seller,",
      "BT-55 buyer, BT-69 tax representative, BT-80 deliver-to).",
      "",
      'Note `1A` (Kosovo, the ISO "user-assigned" code the list carries) and',
      'that Greece is `GR` here — `EL` is a VAT-number prefix only (BR-CO-09),',
      "not a country code, and is deliberately absent.",
    ],
  },
  {
    file: "payment-means.ts",
    rule: "BR-CL-16",
    index: 0,
    constName: "PAYMENT_MEANS_CODES",
    listName: "UNTDID 4461 (UNCL4461)",
    doc: [
      "UNTDID 4461 payment means codes, as admitted by BR-CL-16 for BT-81.",
      "",
      "Membership is only the first hurdle: XRechnung's BR-DE-23-a/24-a/25-a",
      "additionally require the payment group that matches the code (credit",
      "transfer BG-17 for 30/58, card BG-18 for 48/54/55, direct debit BG-19",
      "for 59).",
    ],
  },
  {
    file: "vat-category.ts",
    rule: "BR-CL-17",
    index: 0,
    constName: "VAT_CATEGORY_CODES",
    listName: "UNTDID 5305 (UNCL5305), EN 16931 subset",
    doc: [
      "VAT category codes admitted by BR-CL-17 (BT-118) and BR-CL-18 (BT-151).",
      "",
      "Wider than this package's `VatCategory` union, which covers the seven",
      "categories the generator can express. `L` (IGIC, Canary Islands), `M`",
      "(IPSI, Ceuta/Melilla) and `B` (split payment, Italy) are legal EN 16931",
      "codes with their own BR-AF-*, BR-AG-* and BR-B-* rule families, none of",
      "which this build implements — so they pass BR-CL-17/18 and are then",
      "refused by the model's own typing.",
    ],
  },
  {
    file: "unit.ts",
    rule: "BR-CL-23",
    index: 0,
    constName: "UNIT_CODES",
    listName: "UN/ECE Recommendation 20 with Rec 21 extension",
    doc: [
      "Unit of measure codes admitted by BR-CL-23 for BT-130 and BT-150.",
      "",
      "The complete list — Rec 20 common codes plus the Rec 21 extension (the",
      '`X…` codes). It is large (see the count below) because completeness is',
      "the point: rejecting a valid but obscure unit is a worse failure than",
      "the few kilobytes. The module is side-effect free and the array is the",
      "only export, so a bundler that sees no reference to it drops it whole.",
    ],
  },
  {
    file: "eas.ts",
    rule: "BR-CL-25",
    index: 0,
    constName: "EAS_SCHEME_CODES",
    listName: "CEF Electronic Address Scheme (EAS)",
    doc: [
      "Electronic Address Scheme identifiers admitted by BR-CL-25 for the",
      "`schemeID` on BT-34 (seller) and BT-49 (buyer) electronic addresses.",
      "",
      "Peppol routes on this pair. Common values: `0204` Leitweg-ID, `9930`",
      "German VAT identifier, `0088` GLN, `0192` Norwegian organisation number,",
      "`EM` email.",
    ],
  },
  {
    file: "tax-point-date.ts",
    rule: "BR-CL-06",
    index: 0,
    constName: "VAT_POINT_DATE_CODES",
    listName: "UNTDID 2005, EN 16931 restriction",
    doc: [
      "Value added tax point date codes (BT-8), admitted by BR-CL-06.",
      "",
      "A restriction of UNTDID 2005 down to three codes, and the restriction is",
      "the whole point: BT-8 says *which event* fixes the tax point, and only",
      "three events are recognised — `3` invoice date, `35` actual delivery",
      "date, `432` payment date. BT-8 is mutually exclusive with BT-7, the",
      "explicit tax point date (BR-CO-03).",
    ],
  },
  {
    file: "object-scheme.ts",
    rule: "BR-CL-07",
    index: 0,
    constName: "OBJECT_SCHEME_CODES",
    listName: "UNTDID 1153, EN 16931 restriction",
    doc: [
      "Scheme identifiers for the invoiced object identifier (BT-18-1), and for",
      "the line object identifier scheme (BT-128-1), admitted by BR-CL-07.",
      "",
      "UNTDID 1153 is a reference-qualifier list: the code says what *kind* of",
      "thing the identifier names, so the receiver knows whether it is looking",
      "at a contract number, a meter, a vehicle or a case file. Common values:",
      "`AAJ` delivery order number, `ABT` sender's reference, `AGA` package",
      "number, `ALO` receiving advice number.",
    ],
  },
  {
    file: "icd.ts",
    rule: "BR-CL-10",
    index: 0,
    constName: "ICD_SCHEME_CODES",
    listName: "ISO 6523 ICD",
    doc: [
      "ISO 6523 International Code Designator scheme identifiers.",
      "",
      "One list, four rules, because EN 16931 uses the same registry everywhere",
      "an organisation or a thing is identified by a scheme rather than by a",
      "name: BR-CL-10 (`cac:PartyIdentification/cbc:ID/@schemeID` — BT-29",
      "seller, BT-46 buyer, BT-60 payee), BR-CL-11 (`cac:PartyLegalEntity/",
      "cbc:CompanyID/@schemeID` — BT-30, BT-47, BT-61), BR-CL-21",
      "(`cac:StandardItemIdentification` — BT-157-1) and BR-CL-26",
      "(`cac:DeliveryLocation/cbc:ID` — BT-71). The schematron carries a",
      "byte-identical literal in all four, and this script asserts that rather",
      "than assuming it.",
      "",
      "Do not confuse it with the CEF EAS list (BR-CL-25, `EAS_SCHEME_CODES`),",
      "which is a narrower list for *routing* addresses: `0088` is a valid ICD",
      "and a valid EAS code, `0060` is a valid ICD and not an EAS code.",
    ],
  },
  {
    file: "item-classification.ts",
    rule: "BR-CL-13",
    index: 0,
    constName: "ITEM_CLASSIFICATION_SCHEME_CODES",
    listName: "UNTDID 7143",
    doc: [
      "Item classification scheme identifiers (BT-158-1), admitted by BR-CL-13.",
      "",
      "The code names the classification system the BT-158 value is drawn from,",
      "so a receiver can tell a CPV code from a UNSPSC code from a customs",
      "tariff heading. Common values: `ST` UNSPSC, `SRV` GPC, `HS` Harmonised",
      "System, `TSP` CPV, `MP` product/service identification number.",
    ],
  },
  {
    file: "allowance-reason.ts",
    rule: "BR-CL-19",
    index: 0,
    constName: "ALLOWANCE_REASON_CODES",
    listName: "UNCL 5189",
    doc: [
      "Allowance reason codes (BT-98 document level, BT-140 line level),",
      "admitted by BR-CL-19.",
      "",
      "Nineteen codes, and none of them is a free-text escape hatch: if none",
      "fits, omit the code and give the reason as text (BT-97 / BT-139)",
      "instead. BR-33 / BR-42 are satisfied by either.",
      "",
      "The list is *not* interchangeable with the charge list",
      "(`CHARGE_REASON_CODES`, UNCL 7161): they overlap on codes that mean",
      "different things, so an allowance carrying a charge reason code fails",
      "BR-CL-19 and vice versa.",
    ],
  },
  {
    file: "charge-reason.ts",
    rule: "BR-CL-20",
    index: 0,
    constName: "CHARGE_REASON_CODES",
    listName: "UNCL 7161",
    doc: [
      "Charge reason codes (BT-105 document level, BT-145 line level), admitted",
      "by BR-CL-20.",
      "",
      "Far larger than the allowance list, because a charge can be almost any",
      "service added to a supply. Frequently wanted: `FC` freight service,",
      "`PC` packing, `IN` insurance, `ABK` miscellaneous, `SH` handling.",
    ],
  },
  {
    file: "vatex.ts",
    rule: "BR-CL-22",
    index: 0,
    constName: "VATEX_CODES",
    listName: "CEF VATEX",
    doc: [
      "VAT exemption reason codes (BT-121), admitted by BR-CL-22.",
      "",
      "Each code names the article of Directive 2006/112/EC (or a national",
      "provision) the exemption rests on — `VATEX-EU-132-1I` for education,",
      "`VATEX-EU-AE` for reverse charge, `VATEX-EU-IC` for an intra-community",
      "supply. Supplying the code alongside the BT-120 text is what makes an",
      "exemption machine-checkable rather than merely stated.",
    ],
  },
];

/**
 * BR-CL-24 is the one list that is not a `contains('…')` literal: the mime
 * codes are written as an `or` chain of equality tests, so they are extracted
 * with their own pattern.
 */
const MIME_SPEC = {
  file: "mime.ts",
  rule: "BR-CL-24",
  constName: "MIME_CODES",
  listName: "MIMEMediaType, EN 16931 restriction",
  doc: [
    "Mime codes admitted by BR-CL-24 for an embedded attachment (BT-125-1).",
    "",
    "Six values, and the shortness is deliberate: an invoice attachment has to",
    "be something a receiving system can open without executing it, years",
    "later, without the sender's software. Anything outside this list —",
    "`application/zip`, `application/msword`, `image/svg+xml` — is rejected",
    "however legitimate the file is.",
  ],
};

/**
 * BR-CL-08's list lives in the UBL *model* binding rather than the code-list
 * file, because BT-21 has no element of its own.
 */
const NOTE_SUBJECT_SPEC = {
  file: "note-subject.ts",
  rule: "BR-CL-08",
  index: 0,
  constName: "NOTE_SUBJECT_CODES",
  listName: "UNCL 4451",
  doc: [
    "Invoice note subject codes (BT-21), admitted by BR-CL-08.",
    "",
    "UBL has no element for BT-21. The binding writes the code into the note",
    "itself as `#CODE#text`, and the schematron only applies the membership",
    "test when the note contains a `#` followed by exactly three characters",
    "and another `#` — so a note that merely mentions a hash is left alone,",
    "and a note beginning `#AB#` is left alone too. Common values: `AAI`",
    "general information, `REG` regulatory information, `ABL` governing law,",
    "`TXD` tax declaration, `PMT` payment information.",
  ],
};

const HEADER = (specs, source = "ubl/schematron/codelist/EN16931-UBL-codes.sch") => `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:  ConnectingEurope/eInvoicing-EN16931
 *          ${source}
 * Ref:     ${REF}
 * Lists:   ${specs.map((s) => `${s.rule} (${s.listName})`).join(", ")}
 * Emitted: ${GENERATED_ON} by scripts/build-codelists.mjs
 *
 * This is the same artefact the KoSIT validator evaluates, so a BR-CL finding
 * here and a BR-CL finding from KoSIT are drawn from one source of truth.
 * Regenerate with: node scripts/build-codelists.mjs
 */
`;

/** Pull every `contains(' A B C ', …)` literal out of one assertion. */
function extractLists(assertion) {
  return [...assertion.matchAll(/contains\(\s*'([^']*)'\s*,/g)].map((m) =>
    m[1].trim().split(/\s+/).filter(Boolean),
  );
}

function emitConst(spec, codes) {
  const doc = spec.doc.map((l) => (l ? ` * ${l}` : " *")).join("\n");
  const wrapped = [];
  let line = "";
  for (const code of codes) {
    const piece = `"${code}",`;
    if (line.length + piece.length > 74) {
      wrapped.push(`  ${line.trimEnd()}`);
      line = "";
    }
    line += (line ? " " : "") + piece;
  }
  if (line) wrapped.push(`  ${line.trimEnd()}`);

  return `
/**
${doc}
 *
 * ${codes.length} codes.
 */
export const ${spec.constName}: readonly string[] = Object.freeze([
${wrapped.join("\n")}
]);

/** Membership lookup for {@link ${spec.constName}}. */
export const ${spec.constName}_SET: ReadonlySet<string> = new Set(${spec.constName});
`;
}

const INDEX = `/**
 * GENERATED FILE — do not edit by hand.
 * Re-exports every EN 16931 code list. Regenerate with
 * \`node scripts/build-codelists.mjs\`.
 */
export * from "./invoice-type.js";
export * from "./currency.js";
export * from "./country.js";
export * from "./payment-means.js";
export * from "./vat-category.js";
export * from "./unit.js";
export * from "./eas.js";
export * from "./tax-point-date.js";
export * from "./object-scheme.js";
export * from "./icd.js";
export * from "./item-classification.js";
export * from "./allowance-reason.js";
export * from "./charge-reason.js";
export * from "./vatex.js";
export * from "./mime.js";
export * from "./note-subject.js";
`;

/**
 * BR-CL-11, BR-CL-21 and BR-CL-26 must carry the same ISO 6523 literal as
 * BR-CL-10. If a future release of the schematron diverges them, one shared
 * `ICD_SCHEME_CODES` export stops being honest, so this asserts rather than
 * assumes.
 */
const ICD_ALIASES = ["BR-CL-11", "BR-CL-21", "BR-CL-26"];

async function fetchText(url) {
  process.stderr.write(`fetching ${url}\n`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} → ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function main() {
  const sch = await fetchText(CODES_URL);

  const assertions = new Map();
  for (const assertion of sch.match(/<assert[\s\S]*?<\/assert>/g) ?? []) {
    const id = assertion.match(/id="([^"]+)"/)?.[1];
    if (id) assertions.set(id, assertion);
  }

  await mkdir(OUT_DIR, { recursive: true });

  const byFile = new Map();
  for (const spec of SPECS) {
    const assertion = assertions.get(spec.rule);
    if (!assertion) throw new Error(`${spec.rule} not found in ${CODES_URL}`);
    const codes = extractLists(assertion)[spec.index];
    if (!codes?.length) {
      throw new Error(`${spec.rule}: no code list at index ${spec.index}`);
    }
    if (!byFile.has(spec.file)) byFile.set(spec.file, []);
    byFile.get(spec.file).push({ spec, codes });
  }

  for (const [file, entries] of byFile) {
    const body =
      HEADER(entries.map((e) => e.spec)) +
      entries.map((e) => emitConst(e.spec, e.codes)).join("");
    await writeFile(join(OUT_DIR, file), body, "utf8");
    process.stderr.write(
      `wrote src/codelists/${file}  (${entries
        .map((e) => `${e.spec.constName}=${e.codes.length}`)
        .join(", ")})\n`,
    );
  }

  // BR-CL-10's literal must be the one BR-CL-11/21/26 use too.
  const icd = extractLists(assertions.get("BR-CL-10"))[0].join(" ");
  for (const alias of ICD_ALIASES) {
    const assertion = assertions.get(alias);
    if (!assertion) throw new Error(`${alias} not found in ${CODES_URL}`);
    if (extractLists(assertion)[0].join(" ") !== icd) {
      throw new Error(
        `${alias} no longer carries the same ISO 6523 list as BR-CL-10. ` +
          `src/codelists/icd.ts exports one array for all four rules; split it.`,
      );
    }
  }

  // BR-CL-24: an `or` chain of @mimeCode equality tests, not a contains() list.
  const mimeAssertion = assertions.get("BR-CL-24");
  if (!mimeAssertion) throw new Error(`BR-CL-24 not found in ${CODES_URL}`);
  const mimeCodes = [
    ...new Set(
      [...mimeAssertion.matchAll(/@mimeCode\s*=\s*'([^']+)'/g)].map((m) => m[1]),
    ),
  ];
  if (mimeCodes.length === 0) throw new Error("BR-CL-24: no mime codes extracted");
  await writeFile(
    join(OUT_DIR, MIME_SPEC.file),
    HEADER([MIME_SPEC]) + emitConst(MIME_SPEC, mimeCodes),
    "utf8",
  );
  process.stderr.write(
    `wrote src/codelists/${MIME_SPEC.file}  (MIME_CODES=${mimeCodes.length})\n`,
  );

  // BR-CL-08 lives in the model binding, not the code-list file.
  const model = await fetchText(MODEL_URL);
  const noteParam = model.match(/<param name="BR-CL-08" value="([\s\S]*?)"\/>/)?.[1];
  if (!noteParam) throw new Error(`BR-CL-08 not found in ${MODEL_URL}`);
  const noteCodes = extractLists(noteParam)[0];
  if (!noteCodes?.length) throw new Error("BR-CL-08: no code list extracted");
  await writeFile(
    join(OUT_DIR, NOTE_SUBJECT_SPEC.file),
    HEADER([NOTE_SUBJECT_SPEC], "ubl/schematron/UBL/EN16931-UBL-model.sch") +
      emitConst(NOTE_SUBJECT_SPEC, noteCodes),
    "utf8",
  );
  process.stderr.write(
    `wrote src/codelists/${NOTE_SUBJECT_SPEC.file}  (NOTE_SUBJECT_CODES=${noteCodes.length})\n`,
  );

  await writeFile(join(OUT_DIR, "index.ts"), INDEX, "utf8");
  process.stderr.write("wrote src/codelists/index.ts\n");
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
