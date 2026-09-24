/**
 * The command line: `npx @attestwire/en16931 invoice.xml`.
 *
 * The one file in this package that touches the platform. The library itself
 * uses nothing beyond the JavaScript standard library and runs in a browser;
 * this module reads files and writes to a terminal, so it is reachable only
 * through the `bin` entry (src/bin.ts) and is deliberately NOT exported from
 * index.ts. Importing the package never loads it.
 *
 * It is the GitHub Action's local mode without the runner: the same syntax
 * probe (root element by namespace, never by extension or substring), the same
 * rule that a file it could not read is a FATAL finding rather than a skip, and
 * the same exit semantics. A validator that exits 0 on an unreadable file
 * reports green for a document nobody looked at.
 *
 * `main` takes its argv and its output streams as arguments and returns the
 * exit code, so the test drives it without spawning a process.
 */

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { notXml, validate } from "./validate.js";
import type { Profile, TeachingError } from "./types.js";

/** The version is injected by bin.ts from package.json, so it is stated once. */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
  version: string;
}

const PROFILES: readonly Profile[] = [
  "en16931",
  "xrechnung-ubl",
  "xrechnung-cii",
  "facturx-en16931",
  "peppol-bis-3",
];

/** Exit codes. 1 is "the invoices fail", 2 is "the command was used wrongly". */
export const EXIT = { ok: 0, findings: 1, usage: 2 } as const;

const HELP = `Validate EN 16931 e-invoices: XRechnung, Peppol BIS 3.0, Factur-X / ZUGFeRD.

Usage:
  npx @attestwire/en16931 <file|directory>... [options]

Reads UBL 2.1 and UN/CEFACT CII XML, and the CII payload inside a Factur-X /
ZUGFeRD PDF. A directory is searched recursively for .xml and .pdf files.
Everything runs locally: no account, no key, no network call.

Options:
  --short              One line per finding: rule, business term, the problem
  -q, --quiet          Print only failing documents and the summary
  --json               Print the results as JSON instead of text
  --fail-on <level>    error (default), or warning to fail on warnings too
  --profile <name>     Judge every document against this profile instead of
                       the one it declares: ${PROFILES.join(", ")}
  --large              Accept documents past the default size limits
                       (about 3,000 invoice lines or 8 MB of XML)
  -v, --version        Print the version
  -h, --help           Print this help

Exit status: 0 when every document passes, 1 when any fails, 2 on a usage error.
Rule reference: https://attestwire.com/rules/`;

export interface CliOptions {
  paths: string[];
  profile: Profile | null;
  failOn: "error" | "warning";
  json: boolean;
  quiet: boolean;
  short: boolean;
  large: boolean;
  help: boolean;
  version: boolean;
}

export class UsageError extends Error {}

/**
 * Names people type for a profile, mapped to the profile. A bare "xrechnung"
 * is deliberately absent: it is ambiguous between UBL and CII, and the error
 * for it names both.
 */
const PROFILE_ALIASES: Record<string, Profile> = {
  peppol: "peppol-bis-3",
  "peppol-bis": "peppol-bis-3",
  "peppol-bis-3.0": "peppol-bis-3",
  facturx: "facturx-en16931",
  "factur-x": "facturx-en16931",
  zugferd: "facturx-en16931",
  "en-16931": "en16931",
};

const BOOLEAN_FLAGS: Record<string, keyof CliOptions> = {
  "-h": "help",
  "--help": "help",
  "-v": "version",
  "--version": "version",
  "--json": "json",
  "-q": "quiet",
  "--quiet": "quiet",
  "--short": "short",
  "--large": "large",
};
const VALUE_FLAGS = ["--profile", "--fail-on"];
const ALL_FLAGS = [...Object.keys(BOOLEAN_FLAGS), ...VALUE_FLAGS];

/** Levenshtein distance, for "did you mean". Inputs here are a few characters. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** " Did you mean X?" when one candidate is close, or nothing. */
function suggest(input: string, candidates: readonly string[]): string {
  const scored = candidates
    .map((c) => ({ c, d: c.startsWith(input) || input.startsWith(c) ? 1 : distance(input, c) }))
    .sort((x, y) => x.d - y.d);
  const best = scored[0];
  return best && best.d <= Math.max(2, Math.floor(input.length / 3)) ? ` Did you mean ${best.c}?` : "";
}

function parseProfile(raw: string): Profile {
  const value = raw.trim().toLowerCase();
  if ((PROFILES as readonly string[]).includes(value)) return value as Profile;
  const alias = PROFILE_ALIASES[value];
  if (alias) return alias;
  if (value === "xrechnung") {
    throw new UsageError(
      '--profile: XRechnung comes in two syntaxes. Use "xrechnung-ubl" for a UBL Invoice or ' +
        '"xrechnung-cii" for a CrossIndustryInvoice (or leave --profile out: the document says which).',
    );
  }
  throw new UsageError(
    `--profile: "${raw}" is not a profile.${suggest(value, PROFILES)} Use one of ${PROFILES.join(", ")}.`,
  );
}

/** Parse argv (without node and the script path). Throws UsageError. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    paths: [],
    profile: null,
    failOn: "error",
    json: false,
    quiet: false,
    short: false,
    large: false,
    help: false,
    version: false,
  };

  // "validate" is accepted as a leading verb so that both
  // `npx @attestwire/en16931 validate x.xml` and `... x.xml` work. It is the
  // only verb, and only in first position: a FILE called "validate" elsewhere
  // in the list is still a file.
  const args = argv[0] === "validate" ? argv.slice(1) : [...argv];

  const valueOf = (i: number, flag: string, inline: string | undefined): [string, number] => {
    if (inline !== undefined) return [inline, i];
    const next = args[i + 1];
    if (next === undefined || next.startsWith("-")) {
      throw new UsageError(`${flag} needs a value.`);
    }
    return [next, i + 1];
  };

  let onlyPaths = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (onlyPaths || !arg.startsWith("-") || arg === "-") {
      opts.paths.push(arg);
      continue;
    }
    if (arg === "--") {
      onlyPaths = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    const boolKey = BOOLEAN_FLAGS[flag];
    if (boolKey) {
      // --json=false must mean false, not "present, so true".
      const v = inline?.toLowerCase();
      if (v !== undefined && !["true", "false", "1", "0", "yes", "no"].includes(v)) {
        throw new UsageError(`${flag} takes no value (or true/false), not "${inline}".`);
      }
      (opts[boolKey] as boolean) = v === undefined || v === "true" || v === "1" || v === "yes";
      continue;
    }
    switch (flag) {
      case "--profile": {
        const [value, j] = valueOf(i, flag, inline);
        i = j;
        opts.profile = parseProfile(value);
        break;
      }
      case "--fail-on": {
        const [raw, j] = valueOf(i, flag, inline);
        i = j;
        // "fatal" is the engine's word for an error; the plurals are what
        // people type.
        const value = raw.trim().toLowerCase();
        if (["error", "errors", "fatal"].includes(value)) opts.failOn = "error";
        else if (["warning", "warnings", "warn"].includes(value)) opts.failOn = "warning";
        else throw new UsageError(`--fail-on: "${raw}" is not valid. Use error or warning.`);
        break;
      }
      default: {
        const hint = flag === "-j" ? " Did you mean --json?" : suggest(flag, ALL_FLAGS);
        throw new UsageError(`Unknown option ${flag}.${hint} Run with --help for the list.`);
      }
    }
  }
  if (opts.paths.includes("-")) {
    throw new UsageError("Reading from stdin is not supported; pass a file path.");
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Reading one file

interface FileResult {
  file: string;
  syntax: "ubl" | "cii" | null;
  profile: Profile | null;
  /** The attachment name, when the XML came out of a Factur-X PDF. */
  container: string | null;
  /** Elements the reader did not map, and which no rule therefore saw. */
  unmapped: { path: string; reason: string }[];
  findings: Finding[];
}

/**
 * A rule finding, or a finding for a file no rule could run on. The second kind
 * has no docsUrl: there is no rule page for "this is not an invoice".
 */
type Finding = Omit<TeachingError, "rule" | "field" | "docsUrl"> & {
  rule: string;
  field: string | string[];
  docsUrl?: string;
};

function unreadable(file: string, rule: string, message: string, fix: string): FileResult {
  return {
    file,
    syntax: null,
    profile: null,
    container: null,
    unmapped: [],
    findings: [{ rule, field: "document", severity: "fatal", message, fix }],
  };
}

/** Limits for --large: well past any real invoice, still bounded. */
const LARGE_XML = { maxCharacters: 512_000_000, maxElements: 20_000_000 };
const LARGE_PDF = { maxStreamBytes: 512 * 1024 * 1024, maxTotalInflatedBytes: 1024 * 1024 * 1024, maxAttachmentBytes: 512 * 1024 * 1024 };

async function validateFile(file: string, profile: Profile | null = null, large = false): Promise<FileResult> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(file);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return unreadable(
      file,
      "AW-IO",
      e?.code === "ENOENT"
        ? `${file} does not exist.`
        : e?.code === "EISDIR"
          ? `${file} is a directory.`
          : `${file} could not be read: ${e?.message ?? String(err)}`,
      "Check the path and that you have permission to read it.",
    );
  }

  // Only a file has a name, so only here can a name contradict the contents.
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
  if (!isPdf && /\.pdf$/i.test(file)) {
    const kind = notXml(bytes);
    return unreadable(
      file,
      "AW-PDF",
      `${file} is named .pdf but is ${kind ? kind.what : "not a PDF"}.`,
      kind?.fix ?? "Check the file was downloaded completely.",
    );
  }

  const result = validate(bytes, {
    ...(profile ? { profile } : {}),
    ...(large ? { limits: LARGE_XML, pdfLimits: LARGE_PDF } : {}),
  });
  // The library's advice is written for code; on the command line the limits
  // and the profile are flags.
  const findings: Finding[] = [...result.errors, ...result.warnings, ...result.information].map((f) => {
    if (f.rule === "AW-SIZE") return { ...f, fix: "Run again with --large if a document this size is expected." };
    if (f.rule === "AW-PROFILE-SYNTAX" && profile && result.syntax) {
      const other = result.syntax === "ubl" ? "CII" : "UBL";
      const own = result.syntax.toUpperCase();
      return {
        ...f,
        message: `--profile ${profile} is a ${other} profile, but this document is ${own}.`,
        fix: `Leave --profile out to use the profile the document declares, or pick a ${own} profile.`,
      };
    }
    return f;
  });
  return {
    file,
    syntax: result.syntax,
    profile: result.profile,
    container: result.container,
    unmapped: result.unmapped.map((u) => ({ path: u.path, reason: u.reason })),
    findings,
  };
}

/**
 * Expand the arguments into a sorted list of files.
 *
 * A directory is walked for .xml and .pdf, following symbolic links (a
 * directory already visited is not walked twice); a file named explicitly is
 * taken whatever its extension, because naming it is the instruction. Nothing
 * the walk meets may vanish from the report: a path that does not exist, a
 * broken link and a directory that cannot be read all come back in
 * `unreadable`, and each becomes a fatal AW-IO finding.
 */
export async function expand(
  paths: readonly string[],
): Promise<{ files: string[]; unreadable: { path: string; message: string }[] }> {
  const files: string[] = [];
  const bad: { path: string; message: string }[] = [];
  const seen = new Set<string>();
  const message = (err: unknown) => (err as Error)?.message ?? String(err);

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      const real = await realpath(dir);
      if (seen.has(real)) return;
      seen.add(real);
      // Sorted, because readdir order is filesystem-dependent and decides
      // which of two links to one directory is the path reported.
      entries = (await readdir(dir, { withFileTypes: true })).sort((x, y) => (x.name < y.name ? -1 : 1));
    } catch (err) {
      bad.push({ path: dir, message: message(err) });
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const target = await stat(full);
          isDir = target.isDirectory();
          isFile = target.isFile();
        } catch (err) {
          if (/\.(xml|pdf)$/i.test(e.name)) bad.push({ path: full, message: `broken link: ${message(err)}` });
          continue;
        }
      }
      if (isDir) await walk(full);
      else if (isFile && /\.(xml|pdf)$/i.test(e.name)) files.push(full);
    }
  };

  for (const p of paths) {
    let isDir = false;
    try {
      isDir = (await stat(p)).isDirectory();
    } catch {
      /* not a directory we can see: validateFile reports it as AW-IO */
    }
    if (isDir) await walk(p);
    else files.push(p);
  }
  return { files: [...new Set(files)].sort(), unreadable: bad };
}

// ---------------------------------------------------------------------------
// Output

interface Counts {
  files: number;
  failed: number;
  errors: number;
  warnings: number;
  information: number;
}

type FailOn = "error" | "warning";

const countOf = (r: FileResult, severity: string) => r.findings.filter((f) => f.severity === severity).length;

/** Does this document fail? Warnings count when --fail-on warning asked them to. */
function failsFile(r: FileResult, failOn: FailOn): boolean {
  return countOf(r, "fatal") > 0 || (failOn === "warning" && countOf(r, "warning") > 0);
}

function tally(results: readonly FileResult[], failOn: FailOn): Counts {
  return {
    files: results.length,
    failed: results.filter((r) => failsFile(r, failOn)).length,
    errors: results.reduce((n, r) => n + countOf(r, "fatal"), 0),
    warnings: results.reduce((n, r) => n + countOf(r, "warning"), 0),
    information: results.reduce((n, r) => n + countOf(r, "information"), 0),
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function painter(color: boolean) {
  const wrap = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { red: wrap("31"), yellow: wrap("33"), green: wrap("32"), dim: wrap("2"), bold: wrap("1") };
}

/** The first sentence of a message, for --short. */
function firstSentence(message: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(message);
  const sentence = (m ? m[1]! : message).trim();
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

/**
 * "line 14  /ubl:Invoice/cbc:ID" when the element is in the file. When it is
 * not, the path says where it belongs and the line says where to look.
 */
function locationText(f: Finding): string | undefined {
  const at = f.location;
  if (!at) return f.xpath;
  const inside = at.attachment ? ` of ${at.attachment}` : "";
  if (at.exact) return `line ${at.line}${inside}  ${f.xpath ?? at.path}`;
  const near = `nearest element in the file: <${at.path.split("/").pop()!.replace(/\[\d+\]$/, "")}>, line ${at.line}${inside}`;
  return f.xpath ? `${f.xpath}  (${near})` : `(${near})`;
}

function formatText(
  results: readonly FileResult[],
  opts: { quiet: boolean; short: boolean; color: boolean; failOn: FailOn },
): string {
  const c = painter(opts.color);
  const lines: string[] = [];
  const mark = { fatal: c.red("✗ error"), warning: c.yellow("! warning"), information: c.dim("i info") };
  const shortMark = { fatal: c.red("✗"), warning: c.yellow("!"), information: c.dim("i") };
  // In --quiet, show exactly the findings that decide the exit status.
  const decisive = (severity: string) =>
    severity === "fatal" || (opts.failOn === "warning" && severity === "warning");

  for (const r of results) {
    const failed = failsFile(r, opts.failOn);
    if (opts.quiet && !failed) continue;

    const what = [r.syntax?.toUpperCase(), r.profile, r.container && `from ${r.container}`]
      .filter(Boolean)
      .join(" · ");
    const verdict = failed ? c.red("FAIL") : c.green("PASS");
    lines.push(`${verdict} ${c.bold(r.file)}${what ? c.dim(`  ${what}`) : ""}`);

    for (const f of r.findings) {
      if (opts.quiet && !decisive(f.severity)) continue;
      const fields = Array.isArray(f.field) ? f.field.join(", ") : f.field;
      if (opts.short) {
        const m = shortMark[f.severity as keyof typeof shortMark] ?? f.severity;
        lines.push(`  ${m} ${c.bold(f.rule)} ${c.dim(fields)}  ${firstSentence(f.message)}`);
        continue;
      }
      lines.push(`  ${mark[f.severity as keyof typeof mark] ?? f.severity} ${c.bold(f.rule)} ${c.dim(`(${fields})`)}`);
      lines.push(`    ${f.message}`);
      if (f.fix) lines.push(`    ${c.dim("fix:")} ${f.fix}`);
      const where = locationText(f);
      if (where) lines.push(`    ${c.dim("at:")}  ${where}`);
      if (f.docsUrl) lines.push(`    ${c.dim(f.docsUrl)}`);
    }
    if (r.unmapped.length > 0 && !opts.quiet && !opts.short) {
      lines.push(
        c.dim(
          `  note: ${plural(r.unmapped.length, "element")} in this file ${r.unmapped.length === 1 ? "is" : "are"} outside ` +
            "what this validator reads, so no rule checked them. Usually extensions or extra notes; --json lists them.",
        ),
      );
    }
  }

  const n = tally(results, opts.failOn);
  if (lines.length > 0) lines.push("");
  lines.push(
    `${plural(n.files, "document")}: ${n.files - n.failed} passed, ${n.failed} failed ` +
      `(${plural(n.errors, "error")}, ${plural(n.warnings, "warning")}` +
      `${opts.failOn === "warning" ? "; --fail-on warning" : ""}).`,
  );
  if (n.failed > 0 && !opts.short && !opts.quiet && n.errors + n.warnings > 6) {
    lines.push(c.dim("Tip: --short prints one line per finding."));
  }
  return lines.join("\n");
}

function formatJson(results: readonly FileResult[], version: string, failOn: FailOn): string {
  return JSON.stringify(
    {
      engine: `@attestwire/en16931@${version}`,
      failOn,
      summary: tally(results, failOn),
      results: results.map((r) => ({ ...r, passed: !failsFile(r, failOn) })),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.stderr(`${err.message}\n`);
    return EXIT.usage;
  }

  if (opts.help) {
    io.stdout(`${HELP}\n`);
    return EXIT.ok;
  }
  if (opts.version) {
    io.stdout(`${io.version}\n`);
    return EXIT.ok;
  }
  if (opts.paths.length === 0) {
    io.stderr(`No files given.\n\n${HELP}\n`);
    return EXIT.usage;
  }

  const { files, unreadable: badPaths } = await expand(opts.paths);
  if (files.length === 0 && badPaths.length === 0) {
    // Same rule as the Action: zero documents is not a pass.
    io.stderr(`No .xml or .pdf files found in ${opts.paths.join(", ")}. Nothing was validated.\n`);
    return EXIT.usage;
  }

  const results: FileResult[] = badPaths.map((b) =>
    unreadable(
      b.path,
      "AW-IO",
      `${b.path} could not be read: ${b.message}`,
      "Check the path and that you have permission to read it.",
    ),
  );
  for (const file of files) results.push(await validateFile(file, opts.profile, opts.large));
  results.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));

  io.stdout(
    `${
      opts.json
        ? formatJson(results, io.version, opts.failOn)
        : formatText(results, { quiet: opts.quiet, short: opts.short, color: io.color, failOn: opts.failOn })
    }\n`,
  );
  return tally(results, opts.failOn).failed > 0 ? EXIT.findings : EXIT.ok;
}
