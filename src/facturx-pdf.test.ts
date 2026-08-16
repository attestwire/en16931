import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PDF_LIMITS,
  FacturXNotFoundError,
  PdfError,
  PdfParseError,
  PdfSecurityError,
  PdfUnsupportedFilterError,
  extractFacturX,
} from "./facturx-pdf.js";
import { parseCiiInvoice } from "./parse-cii.js";
import { parseXml } from "./xml-parse.js";

/**
 * `extractFacturX`, against real files and against hostile ones.
 *
 * The real half uses three PDFs from FeRD's own ZUGFeRD 2.5.2 example package
 * (provenance and sha256s in `fixtures/facturx/README.md`), chosen so that both
 * cross-reference styles are exercised: two are xref streams with object
 * streams, one is a classic table. A hand-built PDF can only test the parser
 * against its author's beliefs about the format, which is the one thing a
 * conformance-minded package must not do.
 *
 * The hostile half asserts the error **class and code**, not merely that
 * something was thrown. "It throws" is satisfied by a `TypeError` from a bug,
 * which is exactly the outcome these tests exist to rule out.
 *
 * `node:zlib` appears here to *build* corrupt fixtures. The module under test
 * never imports it — the inflater is hand-written, and `src/facturx-pdf.ts` has
 * no imports at all.
 */

const FIXTURES = fileURLToPath(new URL("../fixtures/facturx/", import.meta.url));
const read = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(FIXTURES, name)));

const REAL = [
  { file: "facturx-minimum-rechnung.pdf", profile: "minimum", xref: "classic table" },
  { file: "facturx-basic-einfach.pdf", profile: "basic", xref: "xref stream + ObjStm" },
  { file: "facturx-en16931-einfach.pdf", profile: "en16931", xref: "xref stream + ObjStm" },
] as const;

// ---------------------------------------------------------------------------
// Hand-built PDFs
// ---------------------------------------------------------------------------

const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "latin1"));
const concat = (parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/**
 * A minimal, valid, classic-xref PDF with one embedded XML attachment.
 *
 * Built byte by byte with real offsets so the parser is exercised rather than
 * humoured. `options` perturbs exactly one thing at a time, which is what makes
 * each adversarial case below attributable to one cause.
 */
function buildPdf(
  options: {
    attachmentName?: string;
    xml?: string;
    compress?: boolean;
    afRelationship?: string | null;
    omitNames?: boolean;
    omitAf?: boolean;
    subtype?: string;
    startxref?: number | "missing";
    extraAttachment?: { name: string; xml: string };
    /** Extra filter on the embedded-file stream, e.g. LZWDecode / Crypt. */
    streamFilter?: string;
    /** Point /EF at an object number the xref table does not list. */
    danglingEf?: boolean;
    /** Raw bytes to use as the embedded stream, with /Filter /FlateDecode. */
    rawPayload?: Uint8Array;
  } = {},
): Uint8Array {
  const name = options.attachmentName ?? "factur-x.xml";
  const xml =
    options.xml ??
    '<?xml version="1.0" encoding="UTF-8"?>\n<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"/>';
  const payload =
    options.rawPayload ??
    (options.compress
      ? new Uint8Array(deflateSync(Buffer.from(xml, "utf8")))
      : bytes(xml));

  const objects: string[] = [];
  const streams = new Map<number, Uint8Array>();

  objects[1] =
    `<< /Type /Catalog /Pages 2 0 R` +
    (options.omitNames ? "" : ` /Names << /EmbeddedFiles << /Names [ (${name}) 4 0 R ] >> >>`) +
    (options.omitAf ? "" : ` /AF [ 4 0 R ]`) +
    ` >>`;
  objects[2] = `<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>`;
  objects[4] =
    `<< /Type /Filespec /F (${name}) /UF (${name})` +
    (options.afRelationship === null
      ? ""
      : ` /AFRelationship /${options.afRelationship ?? "Alternative"}`) +
    ` /EF << /F ${options.danglingEf ? 99 : 5} 0 R >> >>`;
  const filter =
    options.streamFilter ??
    (options.compress || options.rawPayload ? "FlateDecode" : undefined);
  objects[5] =
    `<< /Type /EmbeddedFile /Subtype /${options.subtype ?? "text#2Fxml"} /Length ${payload.length}` +
    (filter ? ` /Filter /${filter}` : ``) +
    ` >>`;
  streams.set(5, payload);

  if (options.extraAttachment) {
    objects[1] =
      `<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [ (${name}) 4 0 R (${options.extraAttachment.name}) 6 0 R ] >> >> /AF [ 4 0 R 6 0 R ] >>`;
    objects[6] = `<< /Type /Filespec /F (${options.extraAttachment.name}) /UF (${options.extraAttachment.name}) /AFRelationship /Data /EF << /F 7 0 R >> >>`;
    objects[7] = `<< /Type /EmbeddedFile /Subtype /text#2Fxml /Length ${options.extraAttachment.xml.length} >>`;
    streams.set(7, bytes(options.extraAttachment.xml));
  }

  const parts: Uint8Array[] = [bytes("%PDF-1.7\n")];
  let offset = parts[0]!.length;
  const offsets: number[] = [];

  for (let num = 1; num < objects.length; num++) {
    const body = objects[num];
    if (body === undefined) continue;
    offsets[num] = offset;
    const head = bytes(`${num} 0 obj\n${body}\n`);
    const chunks = [head];
    const stream = streams.get(num);
    if (stream) {
      chunks.push(bytes("stream\n"), stream, bytes("\nendstream\n"));
    }
    chunks.push(bytes("endobj\n"));
    for (const c of chunks) {
      parts.push(c);
      offset += c.length;
    }
  }

  const xrefStart = offset;
  const count = objects.length;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let num = 1; num < count; num++) {
    table += `${String(offsets[num] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  table += `trailer\n<< /Size ${count} /Root 1 0 R >>\n`;
  parts.push(bytes(table));

  if (options.startxref !== "missing") {
    parts.push(bytes(`startxref\n${options.startxref ?? xrefStart}\n%%EOF\n`));
  }
  return concat(parts);
}

// ---------------------------------------------------------------------------

describe("extractFacturX: the official sample files", () => {
  for (const { file, profile, xref } of REAL) {
    it(`extracts factur-x.xml from the ${profile} sample (${xref})`, () => {
      const result = extractFacturX(read(file));
      expect(result.attachmentName).toBe("factur-x.xml");
      expect(result.warnings).toEqual([]);
      expect(result.xml).toContain("CrossIndustryInvoice");
      // The extracted bytes must be XML this package can actually read — the
      // point of extraction is the next step, not the string itself.
      const root = parseXml(result.xml);
      expect(root.local).toBe("CrossIndustryInvoice");
    });
  }

  it("the EN16931 sample parses into the invoice model", () => {
    const { xml } = extractFacturX(read("facturx-en16931-einfach.pdf"));
    const parsed = parseCiiInvoice(xml);
    expect(parsed.invoice.seller?.name).toBeTruthy();
    expect(parsed.invoice.lines.length).toBeGreaterThan(0);
  });

  it("extraction is byte-stable: the same PDF twice gives the same XML", () => {
    const a = extractFacturX(read("facturx-basic-einfach.pdf")).xml;
    const b = extractFacturX(read("facturx-basic-einfach.pdf")).xml;
    expect(a).toBe(b);
  });
});

describe("extractFacturX: hand-built documents", () => {
  it("reads an uncompressed attachment from a classic-xref PDF", () => {
    const result = extractFacturX(buildPdf());
    expect(result.attachmentName).toBe("factur-x.xml");
    expect(result.xml).toContain("CrossIndustryInvoice");
    expect(result.warnings).toEqual([]);
  });

  it("reads a FlateDecode attachment", () => {
    const result = extractFacturX(buildPdf({ compress: true }));
    expect(result.xml).toContain("CrossIndustryInvoice");
  });

  it("finds the attachment through /AF when the name tree is absent", () => {
    const result = extractFacturX(buildPdf({ omitNames: true }));
    expect(result.attachmentName).toBe("factur-x.xml");
  });

  it("finds the attachment through the name tree when /AF is absent", () => {
    const result = extractFacturX(buildPdf({ omitAf: true }));
    expect(result.attachmentName).toBe("factur-x.xml");
  });

  it("accepts a non-standard .xml name, and says so", () => {
    const result = extractFacturX(buildPdf({ attachmentName: "invoice.xml" }));
    expect(result.attachmentName).toBe("invoice.xml");
    expect(result.warnings.join(" ")).toMatch(/not one of the standard names/);
  });

  it("prefers factur-x.xml when several XML attachments are present", () => {
    const result = extractFacturX(
      buildPdf({
        attachmentName: "factur-x.xml",
        extraAttachment: { name: "extra.xml", xml: "<other/>" },
      }),
    );
    expect(result.attachmentName).toBe("factur-x.xml");
    expect(result.warnings.join(" ")).toMatch(/2 XML attachments/);
  });

  it("warns when /AFRelationship is missing", () => {
    const result = extractFacturX(buildPdf({ afRelationship: null }));
    expect(result.warnings.join(" ")).toMatch(/no \/AFRelationship/);
  });

  it("warns when /AFRelationship is not one Factur-X expects", () => {
    const result = extractFacturX(buildPdf({ afRelationship: "Unspecified" }));
    expect(result.warnings.join(" ")).toMatch(/Alternative/);
  });

  it("warns when the attachment is XML but not a CrossIndustryInvoice", () => {
    const result = extractFacturX(
      buildPdf({ xml: '<?xml version="1.0"?><Invoice/>' }),
    );
    expect(result.warnings.join(" ")).toMatch(/no rsm:CrossIndustryInvoice/);
  });
});

describe("extractFacturX: malformed and hostile input", () => {
  const expectError = (
    input: Uint8Array,
    type: new (...args: never[]) => PdfError,
    code?: string | RegExp,
  ): PdfError => {
    let caught: unknown;
    try {
      extractFacturX(input);
    } catch (error) {
      caught = error;
    }
    expect(caught, "expected a throw").toBeDefined();
    expect(caught).toBeInstanceOf(type);
    expect(caught).toBeInstanceOf(PdfError);
    const error = caught as PdfError;
    // Never a bare runtime failure escaping the parser.
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(RangeError);
    expect(typeof error.code).toBe("string");
    if (code instanceof RegExp) expect(error.code).toMatch(code);
    else if (code) expect(error.code).toBe(code);
    expect(error.message.length).toBeGreaterThan(40); // it has to teach
    return error;
  };

  it("an empty buffer", () => {
    expectError(new Uint8Array(0), PdfParseError, "pdf_empty");
  });

  it("bytes that are not a PDF at all", () => {
    expectError(bytes("this is a plain text file, not a PDF"), PdfParseError, "pdf_no_header");
  });

  it("a JPEG masquerading as input", () => {
    const jpeg = new Uint8Array(2048);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0], 0);
    expectError(jpeg, PdfParseError, "pdf_no_header");
  });

  it("a PDF with no startxref", () => {
    expectError(buildPdf({ startxref: "missing" }), PdfParseError, "pdf_no_startxref");
  });

  it("a startxref pointing outside the file", () => {
    expectError(buildPdf({ startxref: 9_999_999 }), PdfParseError, "pdf_bad_xref_offset");
  });

  it("a startxref pointing at nonsense inside the file", () => {
    expectError(buildPdf({ startxref: 12 }), PdfParseError);
  });

  it("a truncated file", () => {
    const full = buildPdf();
    expectError(full.subarray(0, Math.floor(full.length / 2)), PdfParseError);
  });

  it("a file truncated in the middle of the xref table", () => {
    const full = buildPdf();
    // The table proper, not the "xref" inside the trailing "startxref".
    const marker = Buffer.from(full).indexOf("\nxref\n");
    expect(marker).toBeGreaterThan(0);
    expectError(full.subarray(0, marker + 14), PdfParseError);
  });

  it("a PDF with no embedded files", () => {
    const error = expectError(
      buildPdf({ omitNames: true, omitAf: true }),
      FacturXNotFoundError,
      "facturx_no_xml_attachment",
    );
    expect(error.message).toMatch(/ordinary PDF/);
  });

  it("an embedded file that is not XML", () => {
    expectError(
      buildPdf({ attachmentName: "invoice.txt" }),
      FacturXNotFoundError,
      "facturx_no_xml_attachment",
    );
  });

  it("an EmbeddedFiles entry pointing at an object that does not exist", () => {
    // The filespec resolves, its /EF does not. A reader that assumed the
    // reference was good would throw a TypeError off `undefined.dict`.
    expectError(buildPdf({ danglingEf: true }), FacturXNotFoundError);
  });

  it("an unsupported filter is named rather than guessed at", () => {
    const error = expectError(
      buildPdf({ streamFilter: "LZWDecode" }),
      PdfUnsupportedFilterError,
      "pdf_unsupported_filter",
    );
    expect(error.message).toContain("LZWDecode");
    expect((error as PdfUnsupportedFilterError).filter).toBe("LZWDecode");
  });

  it("an encrypted document says so", () => {
    const error = expectError(
      buildPdf({ streamFilter: "Crypt" }),
      PdfUnsupportedFilterError,
    );
    expect(error.message).toMatch(/encrypted/);
  });

  it("garbage where the compressed stream should be", () => {
    const garbage = new Uint8Array(64).fill(0xff);
    expectError(buildPdf({ rawPayload: garbage }), PdfParseError, /^pdf_flate_/);
  });

  // --- the bomb and the loops ---------------------------------------------

  it("a flate bomb is stopped by the output cap, not by memory exhaustion", () => {
    // 8 MiB of zeroes compresses to a few KiB. With the cap lowered this must
    // stop early rather than allocate the lot.
    const bomb = new Uint8Array(deflateSync(Buffer.alloc(8 * 1024 * 1024)));
    let caught: unknown;
    try {
      extractFacturX(buildPdf({ rawPayload: bomb }), {
        maxStreamBytes: 64 * 1024,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PdfSecurityError);
    expect((caught as PdfSecurityError).code).toBe("pdf_stream_too_large");
  });

  it("an xref /Prev that points at itself is refused rather than followed", () => {
    const pdf = buildPdf();
    const text = Buffer.from(pdf).toString("latin1");
    const xrefStart = text.lastIndexOf("xref\n0 ");
    const looped = text.replace(
      /trailer\n<< \/Size (\d+) \/Root 1 0 R >>/,
      `trailer\n<< /Size $1 /Root 1 0 R /Prev ${xrefStart} >>`,
    );
    expectError(bytes(looped), PdfParseError, "pdf_xref_loop");
  });

  it("an attachment over the size cap is refused with a clear limit error", () => {
    const big = "<rsm:CrossIndustryInvoice>" + "x".repeat(200_000) + "</rsm:CrossIndustryInvoice>";
    let caught: unknown;
    try {
      extractFacturX(buildPdf({ xml: big }), { maxAttachmentBytes: 1024 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PdfSecurityError);
    expect((caught as PdfSecurityError).code).toBe("pdf_attachment_too_large");
    expect((caught as PdfSecurityError).message).toMatch(/maxAttachmentBytes/);
  });

  it("a deeply nested name tree is refused rather than recursed", () => {
    // /Kids chains referring to each other in a cycle: the depth guard is what
    // stops this, and it must stop it as a security error, not a stack overflow.
    const objects = [
      `<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles 4 0 R >> >>`,
      `<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>`,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>`,
      `<< /Kids [ 5 0 R ] >>`,
      `<< /Kids [ 4 0 R ] >>`,
    ];
    const parts: Uint8Array[] = [bytes("%PDF-1.7\n")];
    let offset = parts[0]!.length;
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets[i + 1] = offset;
      const chunk = bytes(`${i + 1} 0 obj\n${body}\nendobj\n`);
      parts.push(chunk);
      offset += chunk.length;
    });
    let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= objects.length; n++) {
      table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
    }
    table += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
    parts.push(bytes(table));
    parts.push(bytes(`startxref\n${offset}\n%%EOF\n`));
    expectError(concat(parts), PdfSecurityError, "pdf_name_tree_too_deep");
  });

  it("every failure is a PdfError subclass with a stable code", () => {
    // A blunt sweep: mutate the file at many points and assert nothing escapes
    // the taxonomy. This is the test that catches a `TypeError` from a code
    // path no hand-written case happened to reach.
    const pdf = buildPdf({ compress: true });
    for (let cut = 8; cut < pdf.length; cut += 37) {
      const truncated = pdf.subarray(0, cut);
      try {
        extractFacturX(truncated);
      } catch (error) {
        expect(
          error,
          `byte ${cut} produced ${(error as Error).name}: ${(error as Error).message.slice(0, 80)}`,
        ).toBeInstanceOf(PdfError);
      }
    }
  });

  it("never hangs on random bytes", () => {
    // Deterministic pseudo-random so a failure is reproducible.
    let seed = 42;
    const random = new Uint8Array(4096);
    for (let i = 0; i < random.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      random[i] = seed & 0xff;
    }
    random.set(bytes("%PDF-1.7\n"), 0);
    random.set(bytes("startxref\n1234\n%%EOF\n"), random.length - 21);
    try {
      extractFacturX(random);
    } catch (error) {
      expect(error).toBeInstanceOf(PdfError);
    }
  });
});

// ---------------------------------------------------------------------------
// A general classic-xref assembler, for shapes `buildPdf` cannot express.
// ---------------------------------------------------------------------------

/** `objects[n]` is object n's body; `streams` attaches stream data to it. */
function assemble(
  objects: (string | undefined)[],
  streams = new Map<number, Uint8Array>(),
): Uint8Array {
  const parts: Uint8Array[] = [bytes("%PDF-1.7\n")];
  let offset = parts[0]!.length;
  const offsets: number[] = [];
  for (let num = 1; num < objects.length; num++) {
    const body = objects[num];
    if (body === undefined) continue;
    offsets[num] = offset;
    const chunks = [bytes(`${num} 0 obj\n${body}\n`)];
    const stream = streams.get(num);
    if (stream) chunks.push(bytes("stream\n"), stream, bytes("\nendstream\n"));
    chunks.push(bytes("endobj\n"));
    for (const c of chunks) {
      parts.push(c);
      offset += c.length;
    }
  }
  const xrefStart = offset;
  const count = objects.length;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let num = 1; num < count; num++) {
    table += `${String(offsets[num] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  table += `trailer\n<< /Size ${count} /Root 1 0 R >>\n`;
  parts.push(bytes(table));
  parts.push(bytes(`startxref\n${xrefStart}\n%%EOF\n`));
  return concat(parts);
}

/** A catalog naming one filespec, plus that filespec and its embedded stream. */
function oneAttachment(
  filespecBody: string,
  streamBody: string,
  payload: Uint8Array,
  key = "factur-x.xml",
): Uint8Array {
  const objects: (string | undefined)[] = [];
  objects[1] =
    `<< /Type /Catalog /Names << /EmbeddedFiles << /Names [ (${key}) 4 0 R ] >> >> /AF [ 4 0 R ] >>`;
  objects[4] = filespecBody;
  objects[5] = streamBody;
  return assemble(objects, new Map([[5, payload]]));
}

const SAMPLE_XML = '<?xml version="1.0"?><rsm:CrossIndustryInvoice/>';

/** A PDF literal-string body for `s` encoded as UTF-16BE with a byte-order mark. */
function utf16beLiteral(s: string): string {
  const octal = (n: number): string => `\\${n.toString(8).padStart(3, "0")}`;
  let out = octal(0xfe) + octal(0xff);
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += octal(c >> 8) + octal(c & 0xff);
  }
  return out;
}

describe("extractFacturX: attachment names as PDF actually writes them", () => {
  // ISO 32000-1 §7.9.2.2: a text string — which /UF is — is either
  // PDFDocEncoded or UTF-16BE behind a FE FF mark. Reading /UF as raw bytes
  // yielded "þÿ f a c t u r - x . x m l", which fails /\.xml$/, so a
  // conformant file was reported as carrying no XML attachment at all.
  it("reads a UTF-16BE /UF name", () => {
    const payload = bytes(SAMPLE_XML);
    const result = extractFacturX(
      oneAttachment(
        `<< /Type /Filespec /F (factur-x.xml) /UF (${utf16beLiteral("factur-x.xml")})` +
          ` /AFRelationship /Alternative /EF << /F 5 0 R >> >>`,
        `<< /Type /EmbeddedFile /Subtype /text#2Fxml /Length ${payload.length} >>`,
        payload,
      ),
    );
    expect(result.attachmentName).toBe("factur-x.xml");
    expect(result.warnings).toEqual([]);
    expect(result.xml).toContain("CrossIndustryInvoice");
  });

  it("keeps non-ASCII characters in a UTF-16BE name", () => {
    const payload = bytes(SAMPLE_XML);
    const result = extractFacturX(
      oneAttachment(
        `<< /Type /Filespec /UF (${utf16beLiteral("Rechnung-Grün.xml")})` +
          ` /AFRelationship /Alternative /EF << /F 5 0 R >> >>`,
        `<< /Type /EmbeddedFile /Subtype /text#2Fxml /Length ${payload.length} >>`,
        payload,
      ),
    );
    expect(result.attachmentName).toBe("Rechnung-Grün.xml");
  });

  it("reads a UTF-8 /UF name behind the PDF 2.0 byte-order mark", () => {
    const payload = bytes(SAMPLE_XML);
    // EF BB BF, then "factur-x.xml" — every byte is ASCII after the mark.
    const result = extractFacturX(
      oneAttachment(
        `<< /Type /Filespec /UF (\\357\\273\\277factur-x.xml)` +
          ` /AFRelationship /Alternative /EF << /F 5 0 R >> >>`,
        `<< /Type /EmbeddedFile /Subtype /text#2Fxml /Length ${payload.length} >>`,
        payload,
      ),
    );
    expect(result.attachmentName).toBe("factur-x.xml");
  });

  it("a plain Latin-1 name is left exactly as it is", () => {
    // The BOM-sniffing must not corrupt the names that already worked.
    const result = extractFacturX(buildPdf({ attachmentName: "factur-x.xml" }));
    expect(result.attachmentName).toBe("factur-x.xml");
  });

  it("falls back to /F when /UF resolves to something that is not a string", () => {
    const payload = bytes(SAMPLE_XML);
    const result = extractFacturX(
      oneAttachment(
        `<< /Type /Filespec /UF /NotAString /F (factur-x.xml)` +
          ` /AFRelationship /Alternative /EF << /F 5 0 R >> >>`,
        `<< /Type /EmbeddedFile /Subtype /text#2Fxml /Length ${payload.length} >>`,
        payload,
      ),
    );
    expect(result.attachmentName).toBe("factur-x.xml");
  });

  it("continues past a dangling /EF /F to a good /EF /UF", () => {
    // "Dangling entries do not stop the others" has to hold *inside* one
    // /EF dictionary too, not only across filespecs: stopping at the first
    // key present threw away an attachment that was right there under /UF.
    const payload = bytes(SAMPLE_XML);
    const result = extractFacturX(
      oneAttachment(
        `<< /Type /Filespec /F (factur-x.xml) /AFRelationship /Alternative` +
          ` /EF << /F 99 0 R /UF 5 0 R >> >>`,
        `<< /Type /EmbeddedFile /Subtype /text#2Fxml /Length ${payload.length} >>`,
        payload,
      ),
    );
    expect(result.attachmentName).toBe("factur-x.xml");
    expect(result.xml).toContain("CrossIndustryInvoice");
  });
});

describe("extractFacturX: the documented preference order", () => {
  /** A catalog naming several filespecs, each with its own embedded stream. */
  const withNames = (names: string[]): Uint8Array => {
    const objects: (string | undefined)[] = [];
    const streams = new Map<number, Uint8Array>();
    const entries = names
      .map((n, i) => `(${n}) ${10 + i * 2} 0 R`)
      .join(" ");
    objects[1] =
      `<< /Type /Catalog /Names << /EmbeddedFiles << /Names [ ${entries} ] >> >> >>`;
    names.forEach((n, i) => {
      const spec = 10 + i * 2;
      const payload = bytes(`<?xml version="1.0"?><rsm:CrossIndustryInvoice n="${n}"/>`);
      objects[spec] =
        `<< /Type /Filespec /F (${n}) /AFRelationship /Alternative /EF << /F ${spec + 1} 0 R >> >>`;
      objects[spec + 1] =
        `<< /Type /EmbeddedFile /Subtype /text#2Fxml /Length ${payload.length} >>`;
      streams.set(spec + 1, payload);
    });
    return assemble(objects, streams);
  };

  // The doc-comment states factur-x.xml > zugferd-invoice.xml > xrechnung.xml
  // > any other .xml. Each rank is asserted against every lower one, in an
  // order that would be satisfied by accident if the sort were a no-op.
  const ORDER = [
    "factur-x.xml",
    "zugferd-invoice.xml",
    "xrechnung.xml",
  ];

  for (let better = 0; better < ORDER.length; better++) {
    for (let worse = better + 1; worse < ORDER.length; worse++) {
      it(`prefers ${ORDER[better]} to ${ORDER[worse]}, whichever comes first in the tree`, () => {
        const a = ORDER[better] as string;
        const b = ORDER[worse] as string;
        expect(extractFacturX(withNames([a, b])).attachmentName).toBe(a);
        expect(extractFacturX(withNames([b, a])).attachmentName).toBe(a);
      });
    }
  }

  it("prefers every standard name to a house name", () => {
    for (const standard of ORDER) {
      expect(extractFacturX(withNames(["house.xml", standard])).attachmentName).toBe(
        standard,
      );
    }
  });

  it("falls back to the sole .xml when no standard name is present", () => {
    const result = extractFacturX(withNames(["house.xml"]));
    expect(result.attachmentName).toBe("house.xml");
    expect(result.warnings.join(" ")).toMatch(/not one of the standard names/);
  });
});

describe("extractFacturX: predictor and filter parameters", () => {
  const withParms = (parms: string, extraObjects: (string | undefined)[] = []): Uint8Array => {
    const payload = bytes(SAMPLE_XML);
    const objects: (string | undefined)[] = [];
    objects[1] =
      `<< /Type /Catalog /Names << /EmbeddedFiles << /Names [ (factur-x.xml) 4 0 R ] >> >> >>`;
    objects[4] =
      `<< /Type /Filespec /F (factur-x.xml) /AFRelationship /Alternative /EF << /F 5 0 R >> >>`;
    objects[5] =
      `<< /Type /EmbeddedFile /Subtype /text#2Fxml /Length ${payload.length} ${parms} >>`;
    extraObjects.forEach((body, i) => {
      if (body !== undefined) objects[6 + i] = body;
    });
    return assemble(objects, new Map([[5, payload]]));
  };

  it("a negative /Columns is a named error, not `Invalid typed array length`", () => {
    // `new Uint8Array(-25)` is a RangeError, which is exactly the bare runtime
    // failure this module's contract says never escapes.
    let caught: unknown;
    try {
      extractFacturX(withParms("/DecodeParms << /Predictor 12 /Columns -5 >>"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PdfParseError);
    expect(caught).not.toBeInstanceOf(RangeError);
    expect((caught as PdfParseError).code).toBe("pdf_bad_predictor_parms");
  });

  it("an enormous /Columns is refused rather than allocated for", () => {
    // 600 000 000 columns is a 600 MB row buffer for a stream of forty-odd
    // bytes: no row can ever be filled, and committing the allocation is how a
    // Worker dies on a four-kilobyte file.
    let caught: unknown;
    try {
      extractFacturX(withParms("/DecodeParms << /Predictor 12 /Columns 600000000 >>"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PdfParseError);
    expect((caught as PdfParseError).code).toBe("pdf_bad_predictor_parms");
  });

  for (const [what, parms] of [
    ["/Colors", "/DecodeParms << /Predictor 12 /Colors -1 /Columns 4 >>"],
    ["a fractional /Columns", "/DecodeParms << /Predictor 15 /Columns 2.5 >>"],
  ] as const) {
    it(`${what} out of range is a named error`, () => {
      let caught: unknown;
      try {
        extractFacturX(withParms(parms));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PdfError);
      expect(caught).not.toBeInstanceOf(RangeError);
      expect(caught).not.toBeInstanceOf(TypeError);
    });
  }

  it("a /DecodeParms array holding an indirect reference is resolved", () => {
    // `find(p => resolve(p) instanceof Map)` returns the *element*, so an
    // array-valued /DecodeParms — which is how a multi-filter stream writes it —
    // handed a PdfRef to `.get` and produced `parmDict.get is not a function`.
    const result = extractFacturX(
      withParms("/DecodeParms [ 6 0 R ]", ["<< /Predictor 1 >>"]),
    );
    expect(result.attachmentName).toBe("factur-x.xml");
    expect(result.xml).toContain("CrossIndustryInvoice");
  });
});

describe("extractFacturX: work and memory bounds", () => {
  it("a wide name tree is bounded by node count, not only by depth", () => {
    // Thirty dictionaries in a chain, each naming the next one *twice*. Depth
    // is thirty — well inside maxNameTreeDepth — and the number of paths is
    // 2^30. Object caching makes the file that says so about a kilobyte.
    // Measured before the node counter existed: depth 28 took 13.5 seconds,
    // and each extra level doubles it.
    const DEPTH = 30;
    const objects: (string | undefined)[] = [];
    objects[1] = `<< /Type /Catalog /Names << /EmbeddedFiles 4 0 R >> >>`;
    for (let i = 0; i < DEPTH; i++) {
      objects[4 + i] = `<< /Kids [ ${5 + i} 0 R ${5 + i} 0 R ] >>`;
    }
    objects[4 + DEPTH] = `<< /Names [ ] >>`;
    const pdf = assemble(objects);
    expect(pdf.length).toBeLessThan(4096);

    const started = Date.now();
    let caught: unknown;
    try {
      extractFacturX(pdf);
    } catch (error) {
      caught = error;
    }
    expect(Date.now() - started).toBeLessThan(1000);
    // Either the walk is pruned to nothing (no attachment) or the node budget
    // fires — never a 2^30-step traversal.
    expect(caught).toBeInstanceOf(PdfError);
  }, 20_000);

  it("the name-tree node budget is a PdfSecurityError with a stable code", () => {
    const objects: (string | undefined)[] = [];
    const KIDS = 40;
    // A root with many kids, each a distinct leaf, so nothing is deduplicated.
    const refs = Array.from({ length: KIDS }, (_, i) => `${5 + i} 0 R`).join(" ");
    objects[1] = `<< /Type /Catalog /Names << /EmbeddedFiles 4 0 R >> >>`;
    objects[4] = `<< /Kids [ ${refs} ] >>`;
    for (let i = 0; i < KIDS; i++) objects[5 + i] = `<< /Names [ ] >>`;
    let caught: unknown;
    try {
      extractFacturX(assemble(objects), { maxNameTreeNodes: 10 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PdfSecurityError);
    expect((caught as PdfSecurityError).code).toBe("pdf_name_tree_too_large");
  });

  it("a diamond in the name tree is walked once, not twice", () => {
    // The honest version of the shape above: two branches meeting at one leaf.
    // It must still work, and the attachment must appear exactly once.
    const payload = bytes(SAMPLE_XML);
    const objects: (string | undefined)[] = [];
    objects[1] = `<< /Type /Catalog /Names << /EmbeddedFiles 4 0 R >> >>`;
    objects[4] = `<< /Kids [ 6 0 R 7 0 R ] >>`;
    objects[6] = `<< /Kids [ 8 0 R ] >>`;
    objects[7] = `<< /Kids [ 8 0 R ] >>`;
    objects[8] = `<< /Names [ (factur-x.xml) 9 0 R ] >>`;
    objects[9] =
      `<< /Type /Filespec /F (factur-x.xml) /AFRelationship /Alternative /EF << /F 5 0 R >> >>`;
    objects[5] =
      `<< /Type /EmbeddedFile /Subtype /text#2Fxml /Length ${payload.length} >>`;
    const result = extractFacturX(assemble(objects, new Map([[5, payload]])));
    expect(result.attachmentName).toBe("factur-x.xml");
    // Reached twice, it would have been reported as two XML attachments.
    expect(result.warnings).toEqual([]);
  });

  it("the parsed-value budget bounds heap that the byte caps do not", () => {
    // Four megabytes of "0 0 0 …" inside one object stream is a 4 KiB PDF that
    // costs ~70 MB of JavaScript heap once parsed — comfortably inside every
    // byte limit here, and most of a Cloudflare Worker's budget.
    const inner = "[" + "0 ".repeat(400_000) + "]";
    const body = `1000 0\n${inner}`;
    const compressed = new Uint8Array(deflateSync(Buffer.from(body, "latin1")));
    const parts: Uint8Array[] = [bytes("%PDF-1.7\n")];
    let offset = parts[0]!.length;
    const catalogAt = offset;
    const catalog = bytes(
      `1 0 obj\n<< /Type /Catalog /Names << /EmbeddedFiles << /Names [ (a.xml) 1000 0 R ] >> >> >>\nendobj\n`,
    );
    parts.push(catalog);
    offset += catalog.length;
    const objStmAt = offset;
    const head = bytes(
      `5 0 obj\n<< /Type /ObjStm /N 1 /First 7 /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
    );
    parts.push(head, compressed, bytes("\nendstream\nendobj\n"));
    offset += head.length + compressed.length + 18;

    const rows: number[] = [];
    const push = (t: number, a: number, b: number): void => {
      rows.push(t, (a >> 24) & 255, (a >> 16) & 255, (a >> 8) & 255, a & 255, b);
    };
    push(0, 0, 0);
    push(1, catalogAt, 0);
    push(0, 0, 0);
    push(0, 0, 0);
    push(0, 0, 0);
    push(1, objStmAt, 0);
    push(2, 5, 0); // object 1000 lives in object stream 5, at index 0
    const xrefData = new Uint8Array(rows);
    const xrefAt = offset;
    parts.push(
      bytes(
        `6 0 obj\n<< /Type /XRef /Size 1001 /Index [0 6 1000 1] /W [1 4 1] /Root 1 0 R /Length ${xrefData.length} >>\nstream\n`,
      ),
      xrefData,
      bytes("\nendstream\nendobj\n"),
      bytes(`startxref\n${xrefAt}\n%%EOF\n`),
    );
    const pdf = concat(parts);
    expect(pdf.length).toBeLessThan(8192);

    let caught: unknown;
    try {
      extractFacturX(pdf, { maxObjectNodes: 10_000 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PdfSecurityError);
    expect((caught as PdfSecurityError).code).toBe("pdf_too_many_object_nodes");
  }, 60_000);

  it("the document-wide inflate budget catches what maxStreamBytes cannot", () => {
    // One stream under the per-stream cap is not the question; the sum is.
    const bomb = new Uint8Array(deflateSync(Buffer.alloc(2 * 1024 * 1024)));
    let caught: unknown;
    try {
      extractFacturX(buildPdf({ rawPayload: bomb }), {
        maxStreamBytes: 8 * 1024 * 1024,
        maxTotalInflatedBytes: 64 * 1024,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PdfSecurityError);
    expect((caught as PdfSecurityError).code).toBe("pdf_total_inflated_too_large");
    expect((caught as PdfSecurityError).message).toMatch(/maxTotalInflatedBytes/);
  });

  it("a hybrid /XRefStm naming its own offset does not recurse", () => {
    // The /XRefStm branch calls readXrefSection directly, bypassing the /Prev
    // loop guard. It used to recurse until the stack gave out — swallowed by a
    // bare `catch`, which is not the same as bounded.
    const pdf = buildPdf();
    const text = Buffer.from(pdf).toString("latin1");
    const xrefStart = text.lastIndexOf("xref\n0 ");
    const looped = text.replace(
      /trailer\n<< \/Size (\d+) \/Root 1 0 R >>/,
      `trailer\n<< /Size $1 /Root 1 0 R /XRefStm ${xrefStart} >>`,
    );
    const started = Date.now();
    const result = extractFacturX(bytes(looped));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.attachmentName).toBe("factur-x.xml");
  });
});

describe("extractFacturX: DEFLATE edge cases", () => {
  /** Wrap raw DEFLATE bytes as the embedded stream of an otherwise-valid PDF. */
  const withRaw = (raw: Uint8Array): Uint8Array =>
    buildPdf({ rawPayload: raw });

  /** Assemble bits LSB-first into bytes, the way RFC 1951 orders them. */
  class BitWriter {
    private readonly out: number[] = [];
    private acc = 0;
    private n = 0;
    push(value: number, width: number): this {
      for (let i = 0; i < width; i++) {
        this.acc |= ((value >> i) & 1) << this.n;
        if (++this.n === 8) {
          this.out.push(this.acc);
          this.acc = 0;
          this.n = 0;
        }
      }
      return this;
    }
    bytes(): Uint8Array {
      const copy = [...this.out];
      if (this.n > 0) copy.push(this.acc);
      return new Uint8Array(copy);
    }
  }

  it("a stored block whose length complement disagrees is refused", () => {
    // BFINAL=1, BTYPE=00, pad to byte, then LEN=4 and a wrong NLEN.
    const raw = new Uint8Array([0x01, 0x04, 0x00, 0x00, 0x00, 65, 66, 67, 68]);
    let caught: unknown;
    try {
      extractFacturX(withRaw(raw));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PdfParseError);
    expect((caught as PdfParseError).code).toBe("pdf_flate_bad_stored_block");
  });

  it("a correct stored block round-trips", () => {
    const text = SAMPLE_XML;
    const len = text.length;
    const raw = concat([
      new Uint8Array([0x01, len & 0xff, (len >> 8) & 0xff, ~len & 0xff, (~len >> 8) & 0xff]),
      bytes(text),
    ]);
    expect(extractFacturX(withRaw(raw)).xml).toContain("CrossIndustryInvoice");
  });

  it("a DEFLATE block of reserved type 3 is refused", () => {
    const raw = new Uint8Array([0b111, 0, 0, 0]);
    let caught: unknown;
    try {
      extractFacturX(withRaw(raw));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PdfParseError);
    expect((caught as PdfParseError).code).toBe("pdf_flate_bad_block_type");
  });

  it("a back-reference pointing before the start of the output is refused", () => {
    // Fixed Huffman: literal 'A', then length code 257 with distance code 0,
    // which is a distance of 1 — legal — followed by one that is not.
    // Distance 1 at output length 0 is the failure this asserts.
    const w = new BitWriter();
    w.push(1, 1).push(1, 2); // BFINAL=1, BTYPE=01 (fixed)
    // Symbol 257 is 7 bits, code 0000001, written MSB-first per RFC 1951 §3.1.1.
    for (const bit of "0000001") w.push(Number(bit), 1);
    w.push(0, 5); // distance symbol 0 -> distance 1, with nothing yet written
    let caught: unknown;
    try {
      extractFacturX(withRaw(w.bytes()));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PdfParseError);
    expect((caught as PdfParseError).code).toMatch(/^pdf_flate_/);
  });

  it("a dynamic block whose code-length table repeats before defining is refused", () => {
    // HLIT=0, HDIST=0, HCLEN=0 (4 code-length codes), then a table in which
    // symbol 16 — "repeat the previous length" — is the first thing decoded.
    const w = new BitWriter();
    w.push(1, 1).push(2, 2); // BFINAL=1, BTYPE=10 (dynamic)
    w.push(0, 5).push(0, 5).push(0, 4);
    // Code-length order starts 16, 17, 18, 0 — give symbol 16 a 1-bit code.
    w.push(1, 3).push(0, 3).push(0, 3).push(0, 3);
    w.push(0, 1); // decode -> symbol 16, at i === 0
    w.push(0, 2);
    let caught: unknown;
    try {
      extractFacturX(withRaw(w.bytes()));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PdfParseError);
    expect((caught as PdfParseError).code).toMatch(/^pdf_flate_/);
  });

  it("every truncation of a real DEFLATE stream terminates with a PdfError", () => {
    // The inflater must never spin: each block either consumes bits or throws.
    const full = new Uint8Array(deflateSync(Buffer.from(SAMPLE_XML.repeat(40), "utf8")));
    for (let cut = 1; cut < full.length; cut++) {
      try {
        extractFacturX(withRaw(full.subarray(0, cut)));
      } catch (error) {
        expect(error, `truncation at ${cut}`).toBeInstanceOf(PdfError);
      }
    }
  }, 60_000);

  it("every single-byte corruption of a real DEFLATE stream terminates", () => {
    const full = new Uint8Array(deflateSync(Buffer.from(SAMPLE_XML.repeat(40), "utf8")));
    for (let i = 0; i < full.length; i++) {
      for (const mask of [0x01, 0x80, 0xff]) {
        const bad = new Uint8Array(full);
        bad[i] = (bad[i] as number) ^ mask;
        try {
          extractFacturX(withRaw(bad));
        } catch (error) {
          expect(error, `byte ${i} ^ ${mask}`).toBeInstanceOf(PdfError);
        }
      }
    }
  }, 120_000);
});

describe("extractFacturX: limits", () => {
  it("exposes its defaults", () => {
    expect(DEFAULT_PDF_LIMITS.maxAttachmentBytes).toBe(16 * 1024 * 1024);
    expect(DEFAULT_PDF_LIMITS.maxCompressionRatio).toBeGreaterThan(0);
  });

  it("a caller can lower every limit", () => {
    expect(() =>
      extractFacturX(read("facturx-basic-einfach.pdf"), { maxObjects: 2 }),
    ).toThrow(PdfSecurityError);
  });

  it("rejects input that is not a Uint8Array", () => {
    expect(() => extractFacturX("not bytes" as unknown as Uint8Array)).toThrow(
      PdfParseError,
    );
  });
});
