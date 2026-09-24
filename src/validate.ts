/**
 * `validate` — a file in, findings out.
 *
 * Checking an existing invoice used to be four decisions the caller had to
 * get right before any rule ran: is this a PDF (then `extractFacturX`), what
 * encoding is the XML in, is it UBL or CII (then `parseUbl` or
 * `parseCiiInvoice`), and only then `validateInput`. The command line made all
 * four, and the hosted API made them again in its own code, so the two could
 * drift. This is those decisions, once, for everyone.
 *
 * It never throws for anything about the document. A file that cannot be read
 * comes back as a result with one fatal finding saying what the file actually
 * is (a ZIP, an HTML login page, a PDF with no invoice inside) and `error`
 * holding the reader's own exception, whose `code` says why. It throws only
 * for a programming error, such as passing a number.
 *
 * Every finding carries a `location` in the caller's file: see locate.ts.
 */

import { extractFacturX, type PdfLimits } from "./facturx-pdf.js";
import { CII_NAMESPACES } from "./generate-cii.js";
import { locateFinding } from "./locate.js";
import { parseCiiTree } from "./parse-cii.js";
import { parseUblTree, type ParsedInvoice, type UnmappedElement } from "./parse.js";
import { runInputRules } from "./rules.js";
import type { BusinessTerm, InvoiceInput, Profile, TeachingError } from "./types.js";
import { parseXml, type XmlElement, type XmlLimits } from "./xml-parse.js";

export interface ValidateOptions {
  /**
   * Judge the document against this profile instead of the one it declares.
   * A profile in the other syntax adds a warning, because the answer is then
   * about a document that could not exist.
   */
  profile?: Profile;
  /** Raise the XML reader's caps for a document that is genuinely this large. */
  limits?: Partial<XmlLimits>;
  /** Raise the PDF reader's caps. */
  pdfLimits?: Partial<PdfLimits>;
}

/**
 * A finding from `validate`. Rule findings are ordinary `TeachingError`s. A
 * document that could not be read at all gets one finding whose rule starts
 * `AW-`, whose field is `"document"`, and which has no rules page.
 */
export type DocumentFinding = Omit<TeachingError, "field" | "docsUrl"> & {
  field: BusinessTerm | BusinessTerm[] | "document";
  docsUrl?: string;
};

export interface DocumentValidation {
  /** False when any finding is fatal, including "this could not be read". */
  valid: boolean;
  /** Null when the document could not be read. */
  syntax: "ubl" | "cii" | null;
  profile: Profile | null;
  /** The attachment's name, when the XML came out of a Factur-X / ZUGFeRD PDF. */
  container: string | null;
  errors: DocumentFinding[];
  warnings: DocumentFinding[];
  information: DocumentFinding[];
  /** The invoice as read, ready for `generateCii` or `generateXRechnungUBL`. */
  invoice: InvoiceInput | null;
  /** Elements the reader did not map, and which no rule therefore saw. */
  unmapped: UnmappedElement[];
  /** BT-24 exactly as the document states it. */
  customizationId?: string;
  /** Why the document could not be read: the reader's exception, with its `code`. */
  error?: Error & { code: string };
}

/**
 * Validate an e-invoice as a file: UBL or CII XML, or a Factur-X / ZUGFeRD PDF.
 *
 * Pass the bytes (a `Uint8Array`, which a Node `Buffer` is) when you have a
 * file, so the encoding the document declares is honoured and a PDF is
 * recognised. A string is taken as XML text that is already decoded.
 *
 * ```ts
 * const result = validate(await readFile("invoice.xml"));
 * for (const f of result.errors) console.log(f.location?.line, f.rule, f.fix);
 * ```
 */
export function validate(
  document: string | Uint8Array | ArrayBuffer,
  options: ValidateOptions = {},
): DocumentValidation {
  let xml: string;
  let container: string | null = null;

  if (typeof document === "string") {
    if (document.startsWith("%PDF")) {
      return unreadable(
        "AW-PDF",
        "This is a PDF passed as text. A PDF's bytes do not survive being decoded to a string.",
        "Pass the file's bytes: validate(await readFile(path)) in Node, or new Uint8Array(await file.arrayBuffer()) in a browser.",
      );
    }
    xml = document;
  } else {
    let bytes: Uint8Array;
    if (document instanceof Uint8Array) bytes = document;
    else if (document instanceof ArrayBuffer) bytes = new Uint8Array(document);
    else throw new TypeError("validate() takes the document as a string, a Uint8Array or an ArrayBuffer.");

    // A PDF is recognised by its first bytes, not its name: a Factur-X saved as
    // .xml by a mail client is still a Factur-X.
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      try {
        const extracted = extractFacturX(bytes, options.pdfLimits);
        xml = extracted.xml;
        container = extracted.attachmentName ?? "embedded XML";
      } catch (err) {
        if (!isReadFailure(err)) throw err;
        if (SIZE_CODES.has(err.code)) return tooLarge(err);
        return unreadable(
          "AW-PDF",
          err.code === "facturx_no_xml_attachment"
            ? "This is a PDF with no invoice XML inside, so it is not a Factur-X / ZUGFeRD e-invoice."
            : `This could not be read as a Factur-X / ZUGFeRD PDF: ${err.message}`,
          err.code === "facturx_no_xml_attachment"
            ? "A plain PDF is not an e-invoice. Export a Factur-X / ZUGFeRD PDF, or the XRechnung XML, from your invoicing tool."
            : "Check the file is a PDF/A-3 with an EN 16931 CII attachment, or validate the XML payload directly.",
          err,
        );
      }
    } else {
      const kind = notXml(bytes);
      if (kind) return unreadable("AW-PARSE", `This is ${kind.what}.`, kind.fix);
      const decoded = decodeXml(bytes);
      if (typeof decoded !== "string") {
        return unreadable(
          "AW-PARSE",
          `This could not be decoded: ${decoded.problem}.`,
          "Save the file as UTF-8, or declare the encoding it is actually in.",
        );
      }
      xml = decoded;
    }
  }

  let root: XmlElement;
  let syntax: "ubl" | "cii";
  let parsed: ParsedInvoice;
  try {
    root = parseXml(xml, options.limits);
    syntax = root.namespace === CII_NAMESPACES.rsm && root.local === "CrossIndustryInvoice" ? "cii" : "ubl";
    parsed = syntax === "cii" ? parseCiiTree(root) : parseUblTree(root);
  } catch (err) {
    if (!isReadFailure(err)) throw err;
    const result = SIZE_CODES.has(err.code)
      ? tooLarge(err)
      : unreadable(
          "AW-PARSE",
          `This is not an invoice this validator can read: ${err.message}`,
          "Supply a UBL 2.1 Invoice or CreditNote, or a UN/CEFACT CrossIndustryInvoice (XRechnung, Peppol, Factur-X).",
          err,
        );
    return { ...result, container };
  }

  const invoice = options.profile ? { ...parsed.invoice, profile: options.profile } : parsed.invoice;
  const findings: DocumentFinding[] = runInputRules(invoice).map((f) => {
    const { location, xpath } = locateFinding(f.xpath, root, syntax);
    const out: DocumentFinding = { ...f, location: container === null ? location : { ...location, attachment: container } };
    if (xpath === undefined) delete out.xpath;
    else out.xpath = xpath;
    return out;
  });

  const sub = subInvoiceProfile(parsed.customizationId);
  if (sub) {
    findings.unshift({
      rule: "AW-PROFILE-SUBSET",
      field: "BT-24",
      severity: "fatal",
      message: `This is a Factur-X ${sub} document. ${sub} carries too little to be an EN 16931 invoice, which is why the rules below fail; it is a booking aid, not a valid e-invoice in Germany or France.`,
      fix: "Export at the EN 16931 (COMFORT) or EXTENDED profile instead.",
    });
  }
  const expected = options.profile ? PROFILE_SYNTAX[options.profile] : undefined;
  if (expected && expected !== syntax) {
    findings.unshift({
      rule: "AW-PROFILE-SYNTAX",
      field: "BT-24",
      severity: "warning",
      message: `The profile asked for, ${options.profile}, is a ${expected.toUpperCase()} profile, but this document is ${syntax.toUpperCase()}.`,
      fix: `Leave the profile out to use the one the document declares, or pick a ${syntax.toUpperCase()} profile.`,
    });
  }

  return {
    valid: findings.every((f) => f.severity !== "fatal"),
    syntax,
    profile: invoice.profile,
    container,
    errors: findings.filter((f) => f.severity === "fatal"),
    warnings: findings.filter((f) => f.severity === "warning"),
    information: findings.filter((f) => f.severity === "information"),
    invoice,
    unmapped: parsed.unmapped,
    customizationId: parsed.customizationId,
  };
}

// ---------------------------------------------------------------------------

function unreadable(rule: string, message: string, fix: string, error?: Error & { code: string }): DocumentValidation {
  const result: DocumentValidation = {
    valid: false,
    syntax: null,
    profile: null,
    container: null,
    errors: [{ rule, field: "document", severity: "fatal", message, fix }],
    warnings: [],
    information: [],
    invoice: null,
    unmapped: [],
  };
  if (error) result.error = error;
  return result;
}

function tooLarge(err: Error & { code: string }): DocumentValidation {
  return unreadable(
    "AW-SIZE",
    `This is larger than the default limits: ${err.message.split(". ")[0]}.`,
    "If a document this size is expected, raise the limit it names through the limits (XML) or pdfLimits (PDF) option.",
    err,
  );
}

/** Does this error come from the engine's own readers (ParseError, PdfError)? */
function isReadFailure(err: unknown): err is Error & { code: string } {
  const code = (err as { code?: unknown } | null)?.code;
  return /^(xml_|unsupported_|pdf_|facturx_)/.test(String(code ?? ""));
}

/** Reader codes that mean "too big", not "broken". */
export const SIZE_CODES: ReadonlySet<string> = new Set([
  "xml_too_large",
  "xml_too_many_elements",
  "pdf_stream_too_large",
  "pdf_total_inflated_too_large",
  "pdf_attachment_too_large",
]);

/**
 * What a file that is not an invoice actually is, from its first bytes, so
 * the answer is "this is a ZIP archive" rather than an XML parser's complaint
 * about character 0. Null when it looks like it could be XML.
 */
export function notXml(bytes: Uint8Array): { what: string; fix: string } | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 512));
  if (bytes.length === 0) return { what: "an empty file", fix: "Check the export wrote the invoice." };
  if (head.startsWith("PK\x03\x04")) {
    return { what: "a ZIP archive", fix: "Unpack it and pass the XML or PDF files inside (or the folder)." };
  }
  const text = head.replace(/^﻿|^\xEF\xBB\xBF/, "").trimStart();
  if (text.startsWith("{") || text.startsWith("[")) {
    return {
      what: "JSON, not XML",
      fix: "This reads UBL or CII XML. If the JSON is an invoice object for this library, call validateInput() on it from code.",
    };
  }
  if (/^(<!--[\s\S]*?-->\s*)*<(!doctype\s+html|html[\s>])/i.test(text)) {
    return { what: "an HTML page", fix: "It may be a download or login page saved in place of the invoice. Download the XML again." };
  }
  if (head.includes("\0") && !(bytes[0] === 0xff && bytes[1] === 0xfe) && !(bytes[0] === 0xfe && bytes[1] === 0xff)) {
    return { what: "a binary file, not XML", fix: "Pass the invoice's .xml file, or a Factur-X / ZUGFeRD .pdf." };
  }
  return null;
}

/**
 * Bytes to text, honouring the byte-order mark and the XML declaration.
 *
 * The engine takes a string and does not read the declaration, so a
 * windows-1252 invoice decoded as UTF-8 would reach the rules with every "ü"
 * replaced, and pass. Decoding is strict: bytes that are not valid in the
 * declared encoding are a finding, not a replacement character.
 */
function decodeXml(bytes: Uint8Array): string | { problem: string } {
  let label = "utf-8";
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) [label, start] = ["utf-16le", 2];
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) [label, start] = ["utf-16be", 2];
  else {
    // The declaration is ASCII in every encoding this can apply to.
    const head = String.fromCharCode(...bytes.subarray(0, 200));
    const declared = /^<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1];
    if (declared) label = declared.toLowerCase();
  }
  let decoder: TextDecoder;
  try {
    // ignoreBOM: the mark is skipped above, by hand, and a SECOND one is a
    // character of the document that TextDecoder would otherwise eat too.
    decoder = new TextDecoder(label, { fatal: true, ignoreBOM: true });
  } catch {
    return { problem: `it declares encoding "${label}", which this runtime cannot decode` };
  }
  try {
    // The mark goes back on as U+FEFF, so the text is exactly what a caller
    // who decoded the file themselves would pass, and a column on line 1
    // means the same thing whichever way the document arrived.
    return (start > 0 ? "\uFEFF" : "") + decoder.decode(bytes.subarray(start));
  } catch {
    return { problem: `it contains bytes that are not valid ${label}` };
  }
}

/** Profiles that exist in only one syntax. en16931 is either. */
const PROFILE_SYNTAX: Partial<Record<Profile, "ubl" | "cii">> = {
  "xrechnung-ubl": "ubl",
  "peppol-bis-3": "ubl",
  "xrechnung-cii": "cii",
  "facturx-en16931": "cii",
};

/** Factur-X / ZUGFeRD profiles below EN 16931: they are not full invoices. */
function subInvoiceProfile(customizationId: string | undefined): string | null {
  const id = (customizationId ?? "").toLowerCase();
  if (/factur-x\.eu:1p0:minimum|zugferd.*:minimum/.test(id)) return "MINIMUM";
  if (/factur-x\.eu:1p0:basicwl|zugferd.*:basicwl/.test(id)) return "BASIC WL";
  return null;
}
