import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PDF_LIMITS,
  FacturXEncodingError,
  FacturXNotFoundError,
  PdfError,
  PdfParseError,
  PdfSecurityError,
  PdfUnsupportedFilterError,
  extractFacturX,
} from "./facturx-pdf.js";
import { FACTURX_OBSERVATIONS } from "./facturx-findings.js";
import { buildPdf, bytes, concat, xmpPacket } from "./facturx-testkit.js";
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
 * never imports it — the inflater is hand-written, and `src/facturx-pdf.ts`
 * imports nothing but this package's own XML decoder (`xml-decode.ts`).
 */

const FIXTURES = fileURLToPath(new URL("../fixtures/facturx/", import.meta.url));
const read = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(FIXTURES, name)));

const REAL = [
  { file: "facturx-minimum-rechnung.pdf", profile: "minimum", xref: "classic table" },
  { file: "facturx-basic-einfach.pdf", profile: "basic", xref: "xref stream + ObjStm" },
  { file: "facturx-en16931-einfach.pdf", profile: "en16931", xref: "xref stream + ObjStm" },
] as const;

// The hand-built PDFs (buildPdf, and the bytes and concat helpers) live in
// facturx-testkit.ts, shared with the validate, command-line and export tests.

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

describe("extractFacturX: the attachment's encoding", () => {
  // The attachment used to be decoded as UTF-8 with replacement, whatever it
  // declared: an ISO-8859-1 factur-x.xml came back as "Hafenstra\uFFFDe 12",
  // with no warning. Factur-X attachments are UTF-8 (see "The attachment's
  // text" in facturx-pdf.ts); these pin what happens to one that is not.
  const cii = (declaration: string, street = "Hafenstraße 12") =>
    `<?xml version="1.0"${declaration}?>\n` +
    `<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100">` +
    `<rsm:Street>${street}</rsm:Street></rsm:CrossIndustryInvoice>`;
  const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
  const latin1 = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
  const attached = (payload: Uint8Array) =>
    buildPdf({ rawPayload: new Uint8Array(deflateSync(payload)) });

  const refusal = (payload: Uint8Array): FacturXEncodingError => {
    let caught: unknown;
    try {
      extractFacturX(attached(payload));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FacturXEncodingError);
    expect(caught).toBeInstanceOf(PdfError);
    const error = caught as FacturXEncodingError;
    expect(error.code).toBe("facturx_xml_encoding");
    expect(error.attachmentName).toBe("factur-x.xml");
    expect(error.message).toMatch(/^The XML attached as "factur-x\.xml" /);
    expect(error.message).not.toContain("\uFFFD");
    return error;
  };

  it("returns a UTF-8 attachment's text exactly, non-ASCII characters and all", () => {
    for (const declaration of [' encoding="UTF-8"', ' encoding="utf-8"', ""]) {
      const result = extractFacturX(attached(utf8(cii(declaration))));
      expect(result.xml, declaration).toBe(cii(declaration));
      expect(result.warnings, declaration).toEqual([]);
    }
  });

  it("drops a UTF-8 byte-order mark, which is not part of the XML, and keeps a second one, which is", () => {
    const bom = [0xef, 0xbb, 0xbf];
    const once = extractFacturX(attached(new Uint8Array([...bom, ...utf8(cii(' encoding="UTF-8"'))])));
    expect(once.xml).toBe(cii(' encoding="UTF-8"'));
    const twice = extractFacturX(attached(new Uint8Array([...bom, ...bom, ...utf8(cii(""))])));
    expect(twice.xml).toBe(`\uFEFF${cii("")}`);
  });

  it("refuses an ISO-8859-1 attachment by name, rather than returning replacement characters", () => {
    const error = refusal(latin1(cii(' encoding="ISO-8859-1"')));
    expect(error.encoding).toBe("iso-8859-1");
    expect(error.message).toMatch(/is in iso-8859-1, not UTF-8/);
    expect(error.message).toMatch(/whatever they declare/);
  });

  it("refuses a windows-1252 attachment too, though every byte of it decodes", () => {
    // 0x80 is "€" in windows-1252: nothing here is invalid, only not UTF-8.
    const error = refusal(latin1(cii(' encoding="windows-1252"', "Hafenstraße 12, 5 \x80")));
    expect(error.encoding).toBe("windows-1252");
  });

  it("refuses a UTF-16 attachment, in either byte order", () => {
    const le = new Uint8Array([0xff, 0xfe, ...Buffer.from(cii(' encoding="UTF-16"'), "utf16le")]);
    expect(refusal(le).encoding).toBe("utf-16le");
    const be = new Uint8Array([0xfe, 0xff, ...Buffer.from(cii(' encoding="UTF-16"'), "utf16le").swap16()]);
    expect(refusal(be).encoding).toBe("utf-16be");
  });

  it("refuses bytes that are not valid UTF-8 when the attachment names no other encoding", () => {
    for (const declaration of [' encoding="UTF-8"', ""]) {
      const error = refusal(latin1(cii(declaration)));
      expect(error.encoding, declaration).toBe("utf-8");
      expect(error.message, declaration).toMatch(/contains bytes that are not valid utf-8/);
    }
  });

  it("refuses UTF-8 bytes under a stale single-byte declaration, naming both", () => {
    // What a conversion to UTF-8 that forgot the declaration leaves behind. A
    // receiver that honours the declaration reads "HafenstraÃŸe 12".
    const error = refusal(utf8(cii(' encoding="ISO-8859-1"')));
    expect(error.encoding).toBe("iso-8859-1");
    expect(error.message).toMatch(/declares encoding "iso-8859-1", but its bytes are UTF-8/);
  });

  it("names an encoding this runtime cannot decode", () => {
    const error = refusal(latin1(cii(' encoding="x-nonsense"')));
    expect(error.encoding).toBe("x-nonsense");
    expect(error.message).toMatch(/cannot decode/);
  });

  it("returns plain ASCII under another declaration, which reads the same either way, and says so", () => {
    const ascii = cii(' encoding="ISO-8859-1"', "Hafenstrasse 12");
    const result = extractFacturX(attached(latin1(ascii)));
    expect(result.xml).toBe(ascii);
    expect(result.warnings.join(" ")).toMatch(/declares encoding "iso-8859-1".*only ASCII/);
  });

  it("does not take ASCII bytes for ASCII text: ISO-2022-JP spells kanji in them", () => {
    // ESC $ B switches to JIS X 0208, where 0x467C 0x4B5C is 日本. Every byte
    // is below 0x80, and a UTF-8 reader would see different text.
    const jis = new Uint8Array([
      ...latin1(`<?xml version="1.0" encoding="ISO-2022-JP"?>\n<rsm:CrossIndustryInvoice xmlns:rsm="x">`),
      0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x1b, 0x28, 0x42,
      ...latin1("</rsm:CrossIndustryInvoice>"),
    ]);
    expect(refusal(jis).encoding).toBe("iso-2022-jp");
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

// ---------------------------------------------------------------------------
// The container's findings
// ---------------------------------------------------------------------------

describe("extractFacturX: the container's findings", () => {
  const ids = (pdf: Uint8Array) => extractFacturX(pdf).findings.map((f) => f.id);
  const only = (pdf: Uint8Array, id: string) => {
    const found = extractFacturX(pdf).findings.filter((f) => f.id === id);
    expect(found, `${id} raised ${found.length} times`).toHaveLength(1);
    return found[0]!;
  };

  it("a file registered the way Factur-X asks has none", () => {
    const result = extractFacturX(buildPdf());
    expect(result.findings).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.relationship).toBe("Alternative");
  });

  it("FeRD's samples register their attachment the way Factur-X asks", () => {
    for (const { file } of REAL) {
      const rules = extractFacturX(read(file)).findings.map((f) => f.rule);
      expect(rules.filter((r) => !r.startsWith("AW-PDF-XMP")), file).toEqual([]);
    }
  });

  it("a house name is AW-PDF-ATTACHMENT, a warning that names the standard ones", () => {
    const f = only(buildPdf({ attachmentName: "invoice.xml" }), "attachment_name");
    expect(f).toMatchObject({ rule: "AW-PDF-ATTACHMENT", field: "document", severity: "warning" });
    expect(f.message).toContain('attached as "invoice.xml"');
    expect(f.message).toMatch(/factur-x\.xml.*zugferd-invoice\.xml.*xrechnung\.xml/);
    expect(f.fix).toMatch(/^Attach the invoice XML as factur-x\.xml/);
  });

  it("a second XML attachment beside factur-x.xml is information: the standard name decides", () => {
    const f = only(
      buildPdf({ extraAttachment: { name: "timesheet.xml", xml: "<other/>" } }),
      "attachment_extra",
    );
    expect(f).toMatchObject({ rule: "AW-PDF-ATTACHMENT", severity: "information" });
    expect(f.message).toContain('read from "factur-x.xml"');
    expect(f.message).toContain('"timesheet.xml"');
  });

  it("several XML attachments with no standard name, or two, are a warning: nothing says which is the invoice", () => {
    const none = buildPdf({ attachmentName: "a.xml", extraAttachment: { name: "b.xml", xml: "<other/>" } });
    expect(only(none, "attachment_ambiguous")).toMatchObject({ severity: "warning" });
    expect(only(none, "attachment_ambiguous").message).toContain("none has a standard name");
    expect(ids(none)).toContain("attachment_name");

    const two = buildPdf({ extraAttachment: { name: "xrechnung.xml", xml: "<other/>" } });
    expect(only(two, "attachment_ambiguous").message).toContain("2 have a standard name");
    expect(ids(two)).not.toContain("attachment_extra");
  });

  it("ASCII under a declaration other than UTF-8 is a warning, and the XML still comes back", () => {
    const ascii =
      '<?xml version="1.0" encoding="ISO-8859-1"?>\n' +
      '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"/>';
    const result = extractFacturX(
      buildPdf({ rawPayload: new Uint8Array(deflateSync(Buffer.from(ascii, "latin1"))) }),
    );
    expect(result.xml).toBe(ascii);
    const f = result.findings.find((x) => x.id === "attachment_encoding");
    expect(f).toMatchObject({ rule: "AW-PDF-ATTACHMENT", severity: "warning" });
    expect(f!.message).toContain('declares encoding "iso-8859-1"');
    expect(f!.fix).toContain('encoding="UTF-8"');
  });

  it("an attachment that is not CII is a warning, with or without an XML declaration", () => {
    for (const xml of ['<?xml version="1.0"?><Invoice/>', "<Invoice/>"]) {
      expect(only(buildPdf({ xml }), "attachment_not_cii"), xml).toMatchObject({
        rule: "AW-PDF-ATTACHMENT",
        severity: "warning",
      });
    }
  });

  it("two different files under one name are AW-PDF-AF, reported once", () => {
    const f = only(buildPdf({ afCopy: "<rsm:CrossIndustryInvoice/>" }), "af_streams_differ");
    expect(f).toMatchObject({ rule: "AW-PDF-AF", severity: "warning" });
    expect(f.message).toContain("two versions of the invoice XML");
  });

  it("an attachment missing from /AF, or from the name tree, is AW-PDF-AF", () => {
    expect(only(buildPdf({ omitAf: true }), "af_missing")).toMatchObject({
      rule: "AW-PDF-AF",
      severity: "warning",
    });
    expect(only(buildPdf({ omitNames: true }), "af_name_tree_missing")).toMatchObject({
      rule: "AW-PDF-AF",
      severity: "warning",
    });
    // Neither was ever a warning, and `warnings` keeps saying what it said.
    expect(extractFacturX(buildPdf({ omitAf: true })).warnings).toEqual([]);
    expect(extractFacturX(buildPdf({ omitNames: true })).warnings).toEqual([]);
  });

  it("counts an /AF entry that holds the attachment's stream under no name of its own", () => {
    // The name tree names the file; /AF lists a second file specification with
    // no /F or /UF that embeds the same stream. That is the attachment in /AF.
    const payload = bytes(SAMPLE_XML);
    const objects: (string | undefined)[] = [];
    objects[1] =
      `<< /Type /Catalog /Names << /EmbeddedFiles << /Names [ (factur-x.xml) 4 0 R ] >> >> /AF [ 6 0 R ] >>`;
    objects[4] =
      `<< /Type /Filespec /F (factur-x.xml) /UF (factur-x.xml) /AFRelationship /Alternative /EF << /F 5 0 R >> >>`;
    objects[5] = `<< /Type /EmbeddedFile /Subtype /text#2Fxml /Length ${payload.length} >>`;
    objects[6] = `<< /Type /Filespec /AFRelationship /Alternative /EF << /F 5 0 R >> >>`;
    const result = extractFacturX(assemble(objects, new Map([[5, payload]])));
    expect(result.attachmentName).toBe("factur-x.xml");
    expect(result.findings.map((f) => f.id)).not.toContain("af_missing");
    expect(result.findings.map((f) => f.id)).not.toContain("af_name_tree_missing");
  });

  it("no /AFRelationship, or one Factur-X does not allow, is AW-PDF-RELATIONSHIP", () => {
    const missing = extractFacturX(buildPdf({ afRelationship: null }));
    expect(missing.relationship).toBeUndefined();
    expect(missing.findings).toMatchObject([
      { rule: "AW-PDF-RELATIONSHIP", id: "relationship_missing", severity: "warning" },
    ]);

    for (const rel of ["Unspecified", "Supplement"]) {
      const f = only(buildPdf({ afRelationship: rel }), "relationship_unexpected");
      expect(f.message, rel).toContain(`/AFRelationship /${rel}`);
      expect(f.fix, rel).toMatch(/\/Alternative/);
    }
    for (const rel of ["Alternative", "Data", "Source"]) {
      const result = extractFacturX(buildPdf({ afRelationship: rel }));
      expect(result.relationship, rel).toBe(rel);
      expect(result.findings, rel).toEqual([]);
    }
  });

  it("a media type that is not XML, or none, is AW-PDF-MIME", () => {
    const octet = only(buildPdf({ subtype: "application#2Foctet-stream" }), "mime_not_xml");
    expect(octet).toMatchObject({ rule: "AW-PDF-MIME", severity: "warning" });
    expect(octet.message).toContain("application/octet-stream");
    expect(only(buildPdf({ subtype: null }), "mime_missing")).toMatchObject({
      rule: "AW-PDF-MIME",
      severity: "warning",
    });
    // application/xml is an XML type too: FeRD's own samples use it.
    expect(extractFacturX(buildPdf({ subtype: "application#2Fxml" })).findings).toEqual([]);
  });

  it("every finding has the shape validate() reports, is never fatal, and comes in rule order", () => {
    const pdfs = [
      buildPdf({ attachmentName: "a.xml", extraAttachment: { name: "b.xml", xml: "<other/>" } }),
      buildPdf({ afRelationship: null, subtype: null, omitAf: true }),
      buildPdf({ afCopy: "<x/>", afRelationship: "Unspecified", xml: "<Invoice/>" }),
    ];
    const order = ["AW-PDF-ATTACHMENT", "AW-PDF-AF", "AW-PDF-RELATIONSHIP", "AW-PDF-MIME"];
    for (const pdf of pdfs) {
      const { findings } = extractFacturX(pdf);
      expect(findings.length).toBeGreaterThan(1);
      for (const f of findings) {
        expect(Object.keys(f).sort()).toEqual(["field", "fix", "id", "message", "rule", "severity"]);
        expect(["warning", "information"]).toContain(f.severity);
        expect(f.rule).toMatch(/^AW-PDF-[A-Z]+(-[A-Z]+)*$/);
        expect(f.message.length).toBeGreaterThan(80); // it has to teach
        expect(f.fix.length).toBeGreaterThan(20);
      }
      const ranks = findings.map((f) => order.indexOf(f.rule));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    }
  });

  it("every sentence `warnings` carries has a finding beside it, so the two views cannot drift", () => {
    const cases = [
      buildPdf({ attachmentName: "invoice.xml" }),
      buildPdf({ extraAttachment: { name: "extra.xml", xml: "<other/>" } }),
      buildPdf({ afRelationship: null }),
      buildPdf({ afRelationship: "Unspecified" }),
      buildPdf({ subtype: "application#2Foctet-stream" }),
      buildPdf({ afCopy: "<x/>" }),
      buildPdf({ xml: '<?xml version="1.0"?><Invoice/>' }),
    ];
    for (const pdf of cases) {
      const { warnings, findings } = extractFacturX(pdf);
      expect(warnings.length).toBeGreaterThan(0);
      expect(findings.length).toBe(warnings.length);
    }
  });
});

describe("extractFacturX: the XMP metadata", () => {
  const FX = "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#";
  const DECLARED = {
    pdfaPart: "3",
    pdfaConformance: "B",
    namespace: FX,
    schema: "factur-x",
    documentType: "INVOICE",
    documentFileName: "factur-x.xml",
    version: "1.0",
    conformanceLevel: "EN 16931",
  };
  const only = (pdf: Uint8Array, id: string) => {
    const result = extractFacturX(pdf);
    const found = result.findings.filter((f) => f.id === id);
    expect(found, `${id} raised ${found.length} times among ${result.findings.map((f) => f.id)}`).toHaveLength(1);
    return found[0]!;
  };

  it("reads the packet stored or FlateDecode'd, as elements or attributes, in x:xmpmeta or bare", () => {
    const cases: [string, Parameters<typeof buildPdf>[0]][] = [
      ["stored, elements, wrapped", {}],
      ["FlateDecode", { xmpCompress: true }],
      ["attributes", { xmp: xmpPacket({ attributes: true }) }],
      ["bare rdf:RDF with attributes, FlateDecode, as FeRD writes it", { xmp: xmpPacket({ attributes: true, bare: true }), xmpCompress: true }],
      ["no extension schema", { xmp: xmpPacket({ noExtensionSchema: true }) }],
    ];
    for (const [label, options] of cases) {
      const result = extractFacturX(buildPdf(options));
      expect(result.xmp, label).toEqual(DECLARED);
      expect(result.findings, label).toEqual([]);
    }
  });

  it("does not take the extension schema's property names for the properties", () => {
    // The pdfaExtension block names all four as text. With the properties
    // themselves gone, what remains is a file that declares none of them.
    const result = extractFacturX(
      buildPdf({ xmp: xmpPacket({ documentType: null, documentFileName: null, version: null, conformanceLevel: null }) }),
    );
    expect(result.xmp).toEqual({ pdfaPart: "3", pdfaConformance: "B" });
    expect(result.findings.map((f) => f.id)).toEqual(["xmp_facturx_missing"]);
  });

  it("reads FeRD's samples: MINIMUM declares itself in full, BASIC and EN 16931 claim PDF/A-3 and nothing more", () => {
    const minimum = extractFacturX(read("facturx-minimum-rechnung.pdf"));
    expect(minimum.xmp).toEqual({ ...DECLARED, conformanceLevel: "MINIMUM" });
    expect(minimum.findings).toEqual([]);
    for (const file of ["facturx-basic-einfach.pdf", "facturx-en16931-einfach.pdf"]) {
      // FlateDecode, bare rdf:RDF, pdfaid as attributes, and no Factur-X
      // properties at all: Mustang reports four errors for each of them.
      const result = extractFacturX(read(file));
      expect(result.xmp, file).toEqual({ pdfaPart: "3", pdfaConformance: "U" });
      expect(result.findings.map((f) => f.id), file).toEqual(["xmp_facturx_missing"]);
      expect(result.warnings, file).toEqual([]);
    }
  });

  it("no metadata is AW-PDF-XMP, a warning, and `xmp` is null", () => {
    const result = extractFacturX(buildPdf({ xmp: null }));
    expect(result.xmp).toBeNull();
    expect(result.findings).toMatchObject([{ rule: "AW-PDF-XMP", id: "xmp_missing", severity: "warning" }]);
    expect(result.findings[0]!.message).toMatch(/no \/Metadata stream/);
  });

  it("metadata that cannot be read is a finding, never a throw, and the invoice still comes back", () => {
    const cases: [string, Parameters<typeof buildPdf>[0], RegExp][] = [
      ["not a stream", { metadataObject: "<< /Type /Metadata /Subtype /XML >>" }, /not a stream/],
      ["an unimplemented filter", { xmpFilter: "LZWDecode" }, /encoded with the LZWDecode filter/],
      ["corrupt FlateDecode", { xmpBytes: new Uint8Array(64).fill(0xff) }, /DEFLATE|stream/],
      ["not valid UTF-8", { xmpBytes: new Uint8Array(deflateSync(Buffer.from([0x3c, 0x78, 0x3e, 0xff, 0x3c, 0x2f, 0x78, 0x3e]))) }, /not valid utf-8/],
      ["not well-formed", { xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF></x:xmpmeta>' }, /could not be read: /],
      ["XML that is not XMP", { xmp: '<?xml version="1.0"?><html/>' }, /not XMP: it has no rdf:RDF element \(its root element is <html>\)/],
      ["a DOCTYPE", { xmp: '<!DOCTYPE x [<!ENTITY a "b">]><x/>' }, /DOCTYPE/],
    ];
    for (const [label, options, detail] of cases) {
      let result: ReturnType<typeof extractFacturX> | undefined;
      expect(() => (result = extractFacturX(buildPdf(options))), label).not.toThrow();
      expect(result!.xml, label).toContain("CrossIndustryInvoice");
      expect(result!.xmp, label).toBeNull();
      const [f] = result!.findings;
      expect(result!.findings, label).toHaveLength(1);
      expect(f, label).toMatchObject({ rule: "AW-PDF-XMP", id: "xmp_unreadable", severity: "warning" });
      expect(f!.message, label).toMatch(detail);
      expect(f!.message, label).toMatch(/[.!?)] A receiver reads the file's PDF\/A claim/);
    }
  });

  it("a metadata flate bomb stops at the limit, as a finding; the invoice is read regardless", () => {
    const bomb = new Uint8Array(deflateSync(Buffer.alloc(2 * 1024 * 1024)));
    const result = extractFacturX(buildPdf({ xmpBytes: bomb }), { maxStreamBytes: 64 * 1024 });
    expect(result.xml).toContain("CrossIndustryInvoice");
    expect(only(buildPdf({ xmpBytes: bomb }), "xmp_unreadable")).toBeDefined();
    expect(result.findings[0]!.message).toMatch(/inflated past the 65536-byte limit/);
  });

  it("a file that claims no PDF/A, another part, or no level of it, says so", () => {
    const none = only(buildPdf({ xmp: xmpPacket({ part: null, conformance: null }) }), "xmp_pdfa_missing");
    expect(none).toMatchObject({ rule: "AW-PDF-XMP", severity: "warning" });
    expect(none.message).toContain("no pdfaid:part and no pdfaid:conformance");

    expect(only(buildPdf({ xmp: xmpPacket({ part: "1" }) }), "xmp_pdfa_part").message).toMatch(/PDF\/A-1 forbids embedded files/);
    expect(only(buildPdf({ xmp: xmpPacket({ part: "2" }) }), "xmp_pdfa_part").message).toMatch(
      /identifies this file as PDF\/A-2 .*PDF\/A-2 allows only PDF\/A files to be embedded/,
    );
    expect(only(buildPdf({ xmp: xmpPacket({ part: "4", conformance: null }) }), "xmp_pdfa_part").message).toMatch(
      /PDF\/A-4 .*finds a claim to something else/,
    );

    expect(only(buildPdf({ xmp: xmpPacket({ conformance: null }) }), "xmp_pdfa_conformance").message).toContain(
      "no conformance level",
    );
    expect(only(buildPdf({ xmp: xmpPacket({ conformance: "X" }) }), "xmp_pdfa_conformance").message).toContain(
      'the conformance level "X"',
    );
    for (const level of ["A", "B", "U"]) {
      expect(extractFacturX(buildPdf({ xmp: xmpPacket({ conformance: level }) })).findings, level).toEqual([]);
    }
  });

  it("some of the Factur-X properties, not all, names the missing ones", () => {
    const f = only(buildPdf({ xmp: xmpPacket({ documentType: null, version: null }) }), "xmp_facturx_incomplete");
    expect(f).toMatchObject({ rule: "AW-PDF-XMP", severity: "warning" });
    expect(f.message).toContain("but not DocumentType, Version.");
    expect(f.fix).toContain(`in the namespace ${FX}`);
    // An empty value is no value.
    expect(only(buildPdf({ xmp: xmpPacket({ version: "  " }) }), "xmp_facturx_incomplete").message).toContain(
      "but not Version.",
    );
  });

  it("the properties in a namespace no format defines are still read, and reported as unseen", () => {
    const pdf = buildPdf({ xmp: xmpPacket({ namespace: "urn:example:factur-x#", documentFileName: "other.xml" }) });
    const result = extractFacturX(pdf);
    expect(result.xmp).toEqual({ ...DECLARED, namespace: "urn:example:factur-x#", schema: undefined, documentFileName: "other.xml" });
    expect(result.xmp).not.toHaveProperty("schema");
    expect(result.findings.map((f) => f.id)).toEqual(["xmp_facturx_namespace", "xmp_file_name"]);
    expect(only(pdf, "xmp_facturx_namespace").message).toContain('in the namespace "urn:example:factur-x#"');
  });

  it("a producer's own Version or DocumentType property is not taken for Factur-X's", () => {
    const own =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="3" pdfaid:conformance="B"/>' +
      '<rdf:Description rdf:about="" xmlns:acme="urn:example:acme#" acme:Version="7" acme:DocumentType="brochure"/>' +
      "</rdf:RDF></x:xmpmeta>";
    const result = extractFacturX(buildPdf({ xmp: own }));
    expect(result.xmp).toEqual({ pdfaPart: "3", pdfaConformance: "B" });
    expect(result.findings.map((f) => f.id)).toEqual(["xmp_facturx_missing"]);
  });

  it("the ZUGFeRD 2.0 and 1.0 namespaces are recognised, each with the levels it defines", () => {
    const zf2 = extractFacturX(
      buildPdf({
        attachmentName: "zugferd-invoice.xml",
        xmp: xmpPacket({ namespace: "urn:zugferd:pdfa:CrossIndustryDocument:invoice:2p0#", documentFileName: "zugferd-invoice.xml" }),
      }),
    );
    expect(zf2.xmp?.schema).toBe("zugferd-2.0");
    expect(zf2.findings).toEqual([]);

    const zf1 = extractFacturX(
      buildPdf({
        attachmentName: "ZUGFeRD-invoice.xml",
        xmp: xmpPacket({
          namespace: "urn:ferd:pdfa:CrossIndustryDocument:invoice:1p0#",
          documentFileName: "ZUGFeRD-invoice.xml",
          conformanceLevel: "COMFORT",
        }),
      }),
    );
    expect(zf1.xmp?.schema).toBe("zugferd-1.0");
    expect(zf1.findings).toEqual([]);

    const f = only(
      buildPdf({ xmp: xmpPacket({ namespace: "urn:zugferd:pdfa:CrossIndustryDocument:invoice:2p0#", conformanceLevel: "XRECHNUNG" }) }),
      "xmp_level_unknown",
    );
    expect(f.message).toContain("not one the ZUGFeRD 2.0 metadata defines (MINIMUM, BASIC WL, BASIC, EN 16931, EXTENDED)");
  });

  it("DocumentType and DocumentFileName are checked against the file", () => {
    const type = only(buildPdf({ xmp: xmpPacket({ documentType: "ORDER" }) }), "xmp_document_type");
    expect(type).toMatchObject({ rule: "AW-PDF-XMP", severity: "warning" });
    expect(type.message).toContain('DocumentType "ORDER"');

    const name = only(buildPdf({ xmp: xmpPacket({ documentFileName: "zugferd-invoice.xml" }) }), "xmp_file_name");
    expect(name.message).toContain('names the invoice attachment "zugferd-invoice.xml"');
    expect(name.message).toContain('attached as "factur-x.xml"');
  });

  it("a level the schema does not define is AW-PDF-XMP-PROFILE, with the spelling it meant", () => {
    const level = (value: string) => only(buildPdf({ xmp: xmpPacket({ conformanceLevel: value }) }), "xmp_level_unknown");
    expect(level("COMFORT")).toMatchObject({ rule: "AW-PDF-XMP-PROFILE", field: "document", severity: "warning" });
    expect(level("COMFORT").message).toContain("COMFORT is ZUGFeRD 1.0's name for the profile Factur-X and later ZUGFeRD call EN 16931.");
    expect(level("EN16931").message).toContain("The level is spelled EN 16931.");
    expect(level("basic wl").message).toContain("The level is spelled BASIC WL.");
    expect(level("PREMIUM").message).not.toContain("spelled");
    for (const known of ["MINIMUM", "BASIC WL", "BASIC", "EN 16931", "EXTENDED", "XRECHNUNG"]) {
      expect(extractFacturX(buildPdf({ xmp: xmpPacket({ conformanceLevel: known }) })).findings, known).toEqual([]);
    }
  });

  it("never throws for metadata, however it is corrupted: the invoice comes back and the damage is a finding", () => {
    // Every byte of a real packet flipped three ways, stored and compressed.
    // Whatever the packet turns into, extraction returns the XML, and every
    // finding about it is one of the metadata's own.
    const packet = Buffer.from(xmpPacket(), "utf8");
    const own = new Set(FACTURX_OBSERVATIONS.filter((id) => id.startsWith("xmp_")));
    for (let i = 0; i < packet.length; i += 7) {
      for (const mask of [0x01, 0x20, 0xff]) {
        const bad = Buffer.from(packet);
        bad[i] = (bad[i] as number) ^ mask;
        for (const compress of [false, true]) {
          const pdf = compress
            ? buildPdf({ xmpBytes: new Uint8Array(deflateSync(bad)) })
            : buildPdf({ xmpStored: new Uint8Array(bad) });
          let result: ReturnType<typeof extractFacturX> | undefined;
          expect(() => (result = extractFacturX(pdf)), `byte ${i} ^ ${mask}`).not.toThrow();
          expect(result!.xml).toContain("CrossIndustryInvoice");
          for (const f of result!.findings) expect(own.has(f.id), `${f.id} at byte ${i} ^ ${mask}`).toBe(true);
        }
      }
    }
  }, 60_000);

  it("reaches every observation that the PDF alone decides", () => {
    // The other two, xmp_level_mismatch and relationship_not_alternative, need
    // the XML's BT-24 and are covered where validate() supplies it.
    const pdfs = [
      buildPdf({ attachmentName: "a.xml", extraAttachment: { name: "b.xml", xml: "<x/>" }, afRelationship: "Unspecified", subtype: "image#2Fpng" }),
      buildPdf({ extraAttachment: { name: "t.xml", xml: "<x/>" }, xml: "<Invoice/>", subtype: null, afRelationship: null }),
      buildPdf({ omitAf: true }),
      buildPdf({ omitNames: true, xmp: null }),
      buildPdf({ afCopy: "<x/>", xmpFilter: "LZWDecode" }),
      buildPdf({ rawPayload: new Uint8Array(deflateSync(Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rsm:CrossIndustryInvoice/>', "latin1"))) }),
      buildPdf({ xmp: xmpPacket({ part: null, conformance: null, documentType: null, documentFileName: null, version: null, conformanceLevel: null }) }),
      buildPdf({ xmp: xmpPacket({ part: "2", version: null, documentType: "ORDER", documentFileName: "x.xml", conformanceLevel: "GOLD" }) }),
      buildPdf({ xmp: xmpPacket({ conformance: null, namespace: "urn:example:fx#" }) }),
    ];
    const seen = new Set(pdfs.flatMap((pdf) => extractFacturX(pdf).findings.map((f) => f.id)));
    const needBt24 = ["xmp_level_mismatch", "relationship_not_alternative"];
    expect(FACTURX_OBSERVATIONS.filter((id) => !seen.has(id) && !needBt24.includes(id))).toEqual([]);
  });
});
