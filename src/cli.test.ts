import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { EXIT, expand, main, parseArgs, UsageError } from "./cli.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

async function run(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    color: false,
    version: "9.9.9",
  });
  return { code, stdout, stderr };
}

const scratch = mkdtempSync(join(tmpdir(), "en16931-cli-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("parseArgs", () => {
  it("accepts an optional leading `validate` verb", () => {
    expect(parseArgs(["validate", "a.xml"]).paths).toEqual(["a.xml"]);
    expect(parseArgs(["a.xml", "validate"]).paths).toEqual(["a.xml", "validate"]);
  });

  it("reads --flag value and --flag=value alike", () => {
    expect(parseArgs(["--profile", "peppol-bis-3", "a.xml"]).profile).toBe("peppol-bis-3");
    expect(parseArgs(["--fail-on=warning", "a.xml"]).failOn).toBe("warning");
  });

  it("refuses an unknown profile, fail-on level or option by name", () => {
    expect(() => parseArgs(["--profile", "xrechnung"])).toThrow(/xrechnung-ubl.*xrechnung-cii/);
    expect(() => parseArgs(["--profile", "xrechnug-ubl"])).toThrow(/Did you mean xrechnung-ubl\?/);
    expect(() => parseArgs(["--profile", "banana"])).toThrow(/not a profile\. Use one of/);
    expect(() => parseArgs(["--fail-on", "info"])).toThrow(/error or warning/);
    expect(() => parseArgs(["--strict"])).toThrow(UsageError);
    expect(() => parseArgs(["-j"])).toThrow(/Did you mean --json\?/);
    expect(() => parseArgs(["--jsno"])).toThrow(/Did you mean --json\?/);
  });

  it("accepts profiles in any case, common aliases, and the plural of fail-on levels", () => {
    expect(parseArgs(["--profile", "XRechnung-UBL"]).profile).toBe("xrechnung-ubl");
    expect(parseArgs(["--profile", "peppol"]).profile).toBe("peppol-bis-3");
    expect(parseArgs(["--profile", "zugferd"]).profile).toBe("facturx-en16931");
    expect(parseArgs(["--fail-on", "warnings"]).failOn).toBe("warning");
    expect(parseArgs(["--fail-on", "fatal"]).failOn).toBe("error");
  });

  it("reads --flag=false as false", () => {
    expect(parseArgs(["--json=false"]).json).toBe(false);
    expect(parseArgs(["--json=true"]).json).toBe(true);
    expect(() => parseArgs(["--json=maybe"])).toThrow(/takes no value/);
  });

  it("does not swallow the next flag as a missing value", () => {
    expect(() => parseArgs(["--profile", "--json"])).toThrow(/needs a value/);
  });

  it("treats everything after -- as a path", () => {
    expect(parseArgs(["--", "--json"]).paths).toEqual(["--json"]);
  });
});

describe("main", () => {
  it("passes a conformant invoice with exit 0", async () => {
    const r = await run(fixture("xrechnung-ubl-minimal.xml"));
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toMatch(/^PASS .*xrechnung-ubl-minimal\.xml {2}UBL · xrechnung-ubl$/m);
    expect(r.stdout).toMatch(/1 document: 1 passed, 0 failed/);
  });

  it("reads CII and a Factur-X PDF", async () => {
    const cii = await run(fixture("xrechnung-cii-minimal.xml"));
    expect(cii.stdout).toMatch(/CII · xrechnung-cii/);
    const pdf = await run(fixture("facturx/facturx-en16931-einfach.pdf"));
    expect(pdf.code).toBe(EXIT.ok);
    expect(pdf.stdout).toMatch(/from factur-x\.xml/);
  });

  it("fails an invoice with a rule violation, naming the rule, fix and docs page", async () => {
    const r = await run(fixture("facturx/facturx-minimum-rechnung.pdf"));
    expect(r.code).toBe(EXIT.findings);
    expect(r.stdout).toMatch(/^FAIL /m);
    expect(r.stdout).toMatch(/✗ error BR-16 \(BG-25\)/);
    expect(r.stdout).toMatch(/fix: /);
    expect(r.stdout).toContain("https://attestwire.com/rules/BR-16");
  });

  it("turns an unreadable or missing file into a fatal finding, never a skip", async () => {
    const html = join(scratch, "not-an-invoice.xml");
    writeFileSync(html, "<html><body>hi</body></html>");
    const r = await run(html, join(scratch, "missing.xml"));
    expect(r.code).toBe(EXIT.findings);
    expect(r.stdout).toMatch(/AW-PARSE/);
    expect(r.stdout).toMatch(/AW-IO/);
    expect(r.stdout).toMatch(/2 documents: 0 passed, 2 failed/);
  });

  it("reports a .pdf that is not a PDF as AW-PDF", async () => {
    const fake = join(scratch, "fake.pdf");
    writeFileSync(fake, "not a pdf");
    const r = await run(fake);
    expect(r.code).toBe(EXIT.findings);
    expect(r.stdout).toMatch(/AW-PDF/);
  });

  it("walks a directory for .xml and .pdf, skipping dot-dirs and node_modules", async () => {
    const dir = join(scratch, "tree");
    mkdirSync(join(dir, "nested"), { recursive: true });
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    for (const f of ["a.xml", "nested/b.PDF", "notes.txt", "node_modules/c.xml", ".git/d.xml"]) {
      writeFileSync(join(dir, f), "x");
    }
    expect(await expand([dir])).toEqual({
      files: [join(dir, "a.xml"), join(dir, "nested/b.PDF")],
      unreadable: [],
    });
  });

  it("follows symlinks, reports broken ones, and does not loop on a cycle", async () => {
    const dir = join(scratch, "links");
    mkdirSync(join(dir, "real"), { recursive: true });
    writeFileSync(join(dir, "real", "a.xml"), "x");
    symlinkSync(join(dir, "real", "a.xml"), join(dir, "link.xml"));
    symlinkSync(join(dir, "real"), join(dir, "linked-dir"));
    symlinkSync(join(dir, "gone.xml"), join(dir, "broken.xml"));
    symlinkSync(dir, join(dir, "real", "loop"));
    const { files, unreadable } = await expand([dir]);
    // real/ is reached first through linked-dir/ (the walk goes in name
    // order) and is then not walked a second time.
    expect(files).toEqual([join(dir, "link.xml"), join(dir, "linked-dir", "a.xml")]);
    expect(unreadable.map((u) => u.path)).toEqual([join(dir, "broken.xml")]);
  });

  it.skipIf(process.getuid?.() === 0)("reports an unreadable directory and still validates the rest", async () => {
    const dir = join(scratch, "locked-tree");
    mkdirSync(join(dir, "locked"), { recursive: true });
    writeFileSync(join(dir, "ok.xml"), readFileSync(fixture("xrechnung-ubl-minimal.xml")));
    chmodSync(join(dir, "locked"), 0o000);
    try {
      const r = await run(dir);
      expect(r.code).toBe(EXIT.findings);
      expect(r.stdout).toMatch(/^PASS .*ok\.xml/m);
      expect(r.stdout).toMatch(/AW-IO[\s\S]*locked could not be read/);
      expect(r.stdout).toMatch(/2 documents: 1 passed, 1 failed/);
    } finally {
      chmodSync(join(dir, "locked"), 0o755);
    }
  });

  it("decodes the declared encoding and a UTF-16 byte-order mark", async () => {
    const xml = readFileSync(fixture("xrechnung-ubl-minimal.xml"), "utf8");
    const name = /<cac:PartyLegalEntity>\s*<cbc:RegistrationName>([^<]+)</.exec(xml)![1]!;
    const withUmlaut = xml
      .replace('<?xml version="1.0" encoding="UTF-8"?>', '<?xml version="1.0" encoding="ISO-8859-1"?>')
      .replace(name, "Café Müller GmbH");
    expect(withUmlaut).toContain("ISO-8859-1");
    const latin1 = join(scratch, "latin1.xml");
    writeFileSync(latin1, Buffer.from(withUmlaut, "latin1"));
    const r = await run("--json", latin1);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).not.toContain("\ufffd");

    const utf16 = join(scratch, "utf16.xml");
    writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml.replace("UTF-8", "UTF-16"), "utf16le")]));
    expect((await run(utf16)).code).toBe(EXIT.ok);
  });

  it("refuses bytes that are not valid in the declared encoding", async () => {
    const bad = join(scratch, "bad-utf8.xml");
    const xml = readFileSync(fixture("xrechnung-ubl-minimal.xml"));
    writeFileSync(bad, Buffer.concat([xml.subarray(0, 200), Buffer.from([0xc3, 0x28]), xml.subarray(200)]));
    const r = await run(bad);
    expect(r.code).toBe(EXIT.findings);
    expect(r.stdout).toMatch(/AW-PARSE[\s\S]*not valid utf-8/);
  });

  it("validates a whole fixtures directory and counts every document", async () => {
    const r = await run(FIXTURES, "--quiet");
    expect(r.code).toBe(EXIT.findings); // the MINIMUM-profile PDF is not EN 16931
    expect(r.stdout).not.toMatch(/^PASS /m);
    expect(r.stdout).toMatch(/14 documents: 13 passed, 1 failed/);
  });

  it("treats a directory with no invoices as a usage error, not a pass", async () => {
    const empty = join(scratch, "empty");
    mkdirSync(empty);
    const r = await run(empty);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toMatch(/Nothing was validated/);
  });

  it("a warning passes by default and fails under --fail-on warning", async () => {
    // One wrong IBAN check digit on a SEPA credit transfer is BR-DE-19, which
    // KoSIT (and so this engine) reports as a warning, not an error.
    const xml = readFileSync(fixture("xrechnung-ubl-minimal.xml"), "utf8");
    expect(xml).toContain("DE02120300000000202051");
    const file = join(scratch, "bad-iban.xml");
    writeFileSync(file, xml.replace("DE02120300000000202051", "DE03120300000000202051"));

    const lenient = await run(file);
    expect(lenient.code).toBe(EXIT.ok);
    expect(lenient.stdout).toMatch(/! warning BR-DE-19 \(BT-84\)/);
    expect(lenient.stdout).toMatch(/0 errors, 1 warning\)/);
    // Under --fail-on warning the verdict, the count and --quiet all agree
    // with the exit status, and --quiet still shows the warning that decided it.
    const strict = await run("--fail-on", "warning", "--quiet", file);
    expect(strict.code).toBe(EXIT.findings);
    expect(strict.stdout).toMatch(/^FAIL /m);
    expect(strict.stdout).toMatch(/! warning BR-DE-19/);
    expect(strict.stdout).toMatch(/0 passed, 1 failed/);
    const json = JSON.parse((await run("--json", "--fail-on", "warning", file)).stdout) as {
      summary: { failed: number };
      results: { passed: boolean }[];
    };
    expect(json.summary.failed).toBe(1);
    expect(json.results[0]!.passed).toBe(false);
  });

  it("names what a non-invoice file actually is", async () => {
    const cases: [string, string | Buffer, RegExp][] = [
      ["bundle.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), /is a ZIP archive/],
      ["invoice.json", '{"invoiceNumber": "1"}', /is JSON, not XML/],
      ["page.xml", "<!DOCTYPE html><html><body>Login</body></html>", /is an HTML page/],
      ["empty.xml", "", /is an empty file/],
      ["fake.pdf", "not a pdf at all", /named \.pdf but is not a PDF/],
    ];
    for (const [name, body, expected] of cases) {
      const file = join(scratch, name);
      writeFileSync(file, body);
      const r = await run(file);
      expect(r.code, name).toBe(EXIT.findings);
      expect(r.stdout, name).toMatch(expected);
      expect(r.stdout, name).not.toMatch(/UTF-8|XXE|character 0/);
    }
    expect((await run(join(scratch, "nope.xml"))).stdout).toMatch(/nope\.xml does not exist/);
  });

  it("reads a PDF by its bytes, and says so when a PDF has no invoice inside", async () => {
    const renamed = join(scratch, "facturx-saved-as.xml");
    writeFileSync(renamed, readFileSync(fixture("facturx/facturx-en16931-einfach.pdf")));
    expect((await run(renamed)).code).toBe(EXIT.ok);

    const plain = join(scratch, "plain.pdf");
    writeFileSync(plain, "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
    const r = await run(plain);
    expect(r.code).toBe(EXIT.findings);
    expect(r.stdout).toMatch(/AW-PDF/);
  });

  it("explains a Factur-X MINIMUM file instead of only listing what it lacks", async () => {
    const r = await run("--short", fixture("facturx/facturx-minimum-rechnung.pdf"));
    expect(r.stdout).toMatch(/AW-PROFILE-SUBSET .*Factur-X MINIMUM document/);
  });

  it("warns when --profile names the other syntax", async () => {
    const r = await run("--profile", "xrechnung-cii", fixture("xrechnung-ubl-minimal.xml"));
    expect(r.stdout).toMatch(/! warning AW-PROFILE-SYNTAX[\s\S]*CII profile, but this document is UBL/);
  });

  it("shows a location only when it is in the document's own syntax", async () => {
    const ubl = readFileSync(fixture("xrechnung-ubl-minimal.xml"), "utf8").replace(
      /<cbc:BuyerReference>[^<]*<\/cbc:BuyerReference>/,
      "",
    );
    const ublFile = join(scratch, "no-ref.xml");
    writeFileSync(ublFile, ubl);
    expect((await run(ublFile)).stdout).toMatch(/at: {2}\/ubl:Invoice\/cbc:BuyerReference/);

    const cii = await run("--json", fixture("facturx/facturx-minimum-rechnung.pdf"));
    const out = JSON.parse(cii.stdout) as { results: { findings: { xpath?: string }[] }[] };
    for (const f of out.results[0]!.findings) expect(f.xpath ?? "").not.toMatch(/^\/ubl:/);
  });

  it("--short prints one line per finding", async () => {
    const r = await run("--short", fixture("facturx/facturx-minimum-rechnung.pdf"));
    const findingLines = r.stdout.split("\n").filter((l) => /^ {2}[✗!i] /.test(l));
    expect(findingLines.length).toBeGreaterThanOrEqual(3);
    for (const l of findingLines) expect(l.length).toBeLessThan(260);
    expect(r.stdout).not.toMatch(/fix:/);
  });

  it("refuses a very large invoice with a pointer to --large, and reads it with --large", async () => {
    const xml = readFileSync(fixture("xrechnung-ubl-minimal.xml"), "utf8");
    const line = /<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/.exec(xml)![0];
    const big = xml.replace(line, line.repeat(6000));
    const file = join(scratch, "big.xml");
    writeFileSync(file, big);
    const refused = await run("--short", file);
    expect(refused.stdout).toMatch(/AW-SIZE/);
    expect((await run(file)).stdout).toMatch(/--large/);
    const accepted = await run("--short", "--large", file);
    expect(accepted.stdout).not.toMatch(/AW-SIZE/);
  });

  it("--json prints one parseable document with the engine version", async () => {
    const r = await run("--json", fixture("xrechnung-ubl-minimal.xml"));
    const out = JSON.parse(r.stdout) as { engine: string; results: { file: string }[] };
    expect(out.engine).toBe("@attestwire/en16931@9.9.9");
    expect(out.results).toHaveLength(1);
  });

  it("--profile overrides the declared profile", async () => {
    const r = await run("--json", "--profile", "peppol-bis-3", fixture("xrechnung-ubl-minimal.xml"));
    const out = JSON.parse(r.stdout) as { results: { profile: string }[] };
    expect(out.results[0]!.profile).toBe("peppol-bis-3");
  });

  it("usage errors exit 2 on stderr; help and version exit 0", async () => {
    expect((await run()).code).toBe(EXIT.usage);
    const bad = await run("--nope");
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.stderr).toMatch(/Unknown option --nope/);
    expect((await run("--help")).stdout).toMatch(/npx @attestwire\/en16931/);
    expect((await run("-v")).stdout).toBe("9.9.9\n");
  });
});

// Mutation testing (2026-09-23): what the command line prints about a location.
describe("locations in the output", () => {
  it("prints the line for an element that is there, and the nearest element for one that is not", async () => {
    const xml = readFileSync(fixture("xrechnung-ubl-minimal.xml"), "utf8")
      .replace(/<cbc:BuyerReference>[^<]*<\/cbc:BuyerReference>/, "")
      .replace("<cbc:DocumentCurrencyCode>EUR<", "<cbc:DocumentCurrencyCode>EURO<");
    const file = join(scratch, "located.xml");
    writeFileSync(file, xml);
    const r = await run(file);
    const currencyLine = xml.slice(0, xml.indexOf("<cbc:DocumentCurrencyCode>")).split("\n").length;
    expect(r.stdout).toContain(`at:  line ${currencyLine}  /ubl:Invoice/cbc:DocumentCurrencyCode`);
    expect(r.stdout).toContain("at:  /ubl:Invoice/cbc:BuyerReference  (nearest element in the file: <ubl:Invoice>, line 2)");
  });

  it("says a PDF finding's line is in the attachment", async () => {
    const r = await run(fixture("facturx/facturx-minimum-rechnung.pdf"));
    expect(r.stdout).toMatch(/line \d+ of factur-x\.xml/);
  });

  it("rewrites the profile warning in terms of the flag", async () => {
    const r = await run(fixture("xrechnung-cii-minimal.xml"), "--profile", "peppol-bis-3");
    expect(r.stdout).toContain("--profile peppol-bis-3 is a UBL profile, but this document is CII.");
    expect(r.stdout).toContain("Leave --profile out");
  });
});
