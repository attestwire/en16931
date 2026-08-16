import { describe, expect, it } from "vitest";
import * as fixtures from "./fixtures.js";
import { generateXRechnungUBL } from "./generate.js";
import { generateCii } from "./generate-cii.js";
import type { InvoiceInput } from "./types.js";

/**
 * Every scheme-`0088` identifier in the fixtures is a real GLN.
 *
 * This test exists because three of the four were not, from 0.3.0 until
 * 2026-08-14, and nothing in this repository could see it. The defect —
 * `4098765000004`, whose GS1 check digit is 3 — sat in
 * `fixtures/xrechnung-ubl-discount.xml`, which KoSIT had recorded as ACCEPTABLE
 * three separate times, because `PEPPOL-COMMON-R040` is one of the Peppol rules
 * the XRechnung schematron does not carry. Eleven clean KoSIT runs never had an
 * opportunity to catch it. It took putting the same bytes to OpenPEPPOL's own
 * artefacts (`scripts/peppol-check.md`) to surface it.
 *
 * So the guard is not "the four known values are correct" — that is a
 * transcription, and a transcription is what was wrong. It is the arithmetic
 * itself, applied to every `0088` identifier reachable from an exported
 * fixture, however it got there. A new fixture with a mistyped GLN fails here.
 *
 * ## The algorithm
 *
 * GS1 mod-10, the same check digit a barcode scanner computes. Take the twelve
 * digits, weight them alternately — 3 for the digits in even positions counting
 * from the right of those twelve, 1 for the rest — sum, and the check digit is
 * whatever brings the total to the next multiple of ten. `PEPPOL-COMMON-R040`
 * is this and nothing else; `rules-peppol.ts` has the implementation the
 * library validates with, and this file deliberately writes it out a second
 * time rather than importing it. A fixture checked with the same function that
 * validates it would pass whatever that function did, including nothing.
 */

const isValidGln = (value: string): boolean => {
  if (!/^[0-9]{13}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += Number(value[i]) * (i % 2 === 1 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(value[12]);
};

/** Every `{ schemeId: "0088", value }` pair anywhere in an exported fixture. */
const glnsIn = (root: unknown): { path: string; value: string }[] => {
  const found: { path: string; value: string }[] = [];
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.schemeId === "0088" && typeof record.value === "string") {
      found.push({ path, value: record.value });
    }
    for (const [key, value] of Object.entries(record)) {
      walk(value, path ? `${path}.${key}` : key);
    }
  };
  walk(root, "");
  return found;
};

const exported = Object.entries(fixtures).filter(
  ([, value]) => value !== null && typeof value === "object",
) as [string, InvoiceInput][];

describe("the check digit on every GLN in the fixtures", () => {
  it("agrees with itself on the four values the conformance run judged", () => {
    // The algorithm, checked against a known answer before it is trusted to
    // judge anything else. These four verdicts are OpenPEPPOL's, recorded in
    // scripts/peppol-check.md §1 on 2026-08-14 — one accept, three rejects.
    expect(isValidGln("4012345000009")).toBe(true);
    expect(isValidGln("4098765000004")).toBe(false);
    expect(isValidGln("4098765000011")).toBe(false);
    expect(isValidGln("4011111000005")).toBe(false);
    // …and the corrections this build now ships.
    expect(isValidGln("4098765000003")).toBe(true);
    expect(isValidGln("4098765000010")).toBe(true);
    expect(isValidGln("4011111000007")).toBe(true);
  });

  it("rejects a non-numeric or wrong-length value", () => {
    for (const bad of ["", "401234500000", "40123450000090", "40123450000O9"]) {
      expect(isValidGln(bad), bad).toBe(false);
    }
  });

  it("finds the identifiers it is meant to be checking", () => {
    // A walk that silently finds nothing is a test that silently passes. As of
    // 0.7.0 the fixture set states six.
    const all = exported.flatMap(([, invoice]) => glnsIn(invoice));
    expect(all.length).toBeGreaterThanOrEqual(6);
  });

  it("closes on every scheme-0088 identifier in every exported fixture", () => {
    const invalid: string[] = [];
    for (const [name, invoice] of exported) {
      for (const { path, value } of glnsIn(invoice)) {
        if (!isValidGln(value)) invalid.push(`${name}.${path} = "${value}"`);
      }
    }
    expect(
      invalid,
      "scheme 0088 is the GS1 Global Location Number and carries a mod-10 " +
        "check digit. Each of these does not close, and PEPPOL-COMMON-R040 " +
        "would reject the document at a Peppol access point.",
    ).toEqual([]);
  });

  it("closes on every schemeID=\"0088\" value in the generated XML too", () => {
    // The model walk above cannot see an identifier the generator writes from
    // something other than a `{ schemeId, value }` pair. This reads the emitted
    // documents instead, which is the artefact that actually gets sent.
    const invalid: string[] = [];
    for (const [name, invoice] of exported) {
      const xml =
        invoice.profile === "xrechnung-ubl" || invoice.profile === "peppol-bis-3"
          ? generateXRechnungUBL(invoice)
          : generateCii(invoice);
      for (const match of xml.matchAll(/schemeID="0088"[^>]*>([^<]*)</g)) {
        if (!isValidGln(match[1].trim())) {
          invalid.push(`${name}: "${match[1].trim()}"`);
        }
      }
    }
    expect(invalid).toEqual([]);
  });
});
