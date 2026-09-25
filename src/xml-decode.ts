/**
 * Bytes to XML text, the way an XML processor reads them.
 *
 * One decoder, two callers: `validate` reads a file with it, and
 * `extractFacturX` the XML attached to a PDF, so the same bytes cannot be read
 * two ways. They were read two ways until this module existed. The PDF reader
 * decoded its attachment as UTF-8 and replaced whatever did not decode,
 * whatever the attachment declared, so an ISO-8859-1 `factur-x.xml` reached
 * the rules with U+FFFD in place of every "ß" and could come back valid.
 *
 * The byte-order mark decides first, then the encoding the XML declaration
 * names, then UTF-8, which XML 1.0 makes the default. Decoding is strict:
 * bytes that are not valid in that encoding are a problem to report, never a
 * replacement character to judge.
 *
 * ONE KIND OF DECLARATION IS NOT BELIEVED. A declaration naming a single-byte
 * encoding (ISO-8859-1, windows-1252 and the rest) over bytes that are valid
 * UTF-8, and not plain ASCII, is almost always a file that something converted
 * to UTF-8 while leaving its declaration alone. Every byte is valid in a
 * single-byte encoding, so such a file decodes "successfully" into mojibake —
 * "Straße" as "StraÃŸe" — and an invoice read that way passes with the
 * corruption in it. A genuine single-byte file is practically never valid
 * UTF-8: each "ß" or "é" in it would have to be followed, every time, by
 * exactly the bytes UTF-8 requires after that lead byte. So the combination is
 * reported by name and decoded neither way. Read as declared, the invoice
 * would be judged corrupted; read as UTF-8, it would be judged as a document
 * that no XML processor, honouring the declaration, would ever see.
 */

/** Bytes that decoded, and how. */
export interface DecodedXml {
  /**
   * The document's text. A byte-order mark stays on as U+FEFF, so the text is
   * exactly what a caller who decoded the file themselves would pass, and a
   * column on line 1 means the same thing whichever way the document arrived.
   */
  text: string;
  /** The WHATWG name of the encoding the bytes were read in: `utf-8`, `utf-16le`, `windows-1252`. */
  encoding: string;
  /**
   * The encoding as the byte-order mark or the declaration names it,
   * lower-cased: `iso-8859-1` where `encoding` says `windows-1252`, which is how
   * the WHATWG Encoding Standard, and so every runtime, reads that label.
   * `utf-8` when nothing names one.
   */
  label: string;
}

/** Bytes that did not decode, and why. */
export interface UndecodableXml {
  /**
   * `unsupported`: the declaration names an encoding this runtime has no
   * decoder for. `invalid`: the bytes are not valid in the encoding named (or
   * in UTF-8, when none is). `mislabelled`: the declaration names a
   * single-byte encoding and the bytes are UTF-8 (see the module comment).
   */
  problem: "unsupported" | "invalid" | "mislabelled";
  /** As on `DecodedXml`. */
  label: string;
}

/**
 * Decode an XML document's bytes: byte-order mark, then declaration, then
 * UTF-8, strictly. See the module comment for the one declaration it refuses
 * to believe.
 */
export function decodeXml(bytes: Uint8Array): DecodedXml | UndecodableXml {
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
    return { problem: "unsupported", label };
  }
  const body = bytes.subarray(start);
  // Only a declaration can name a single-byte encoding: a byte-order mark
  // names UTF-8 or UTF-16.
  if (SINGLE_BYTE.has(decoder.encoding) && isMultiByteUtf8(body)) {
    return { problem: "mislabelled", label };
  }
  try {
    return { text: (start > 0 ? "\uFEFF" : "") + decoder.decode(body), encoding: decoder.encoding, label };
  } catch {
    return { problem: "invalid", label };
  }
}

/**
 * The WHATWG Encoding Standard's single-byte encodings, by the names
 * `TextDecoder` reports. ISO-8859-1 and US-ASCII are here as `windows-1252`,
 * which is what the standard reads both labels as.
 */
const SINGLE_BYTE: ReadonlySet<string> = new Set([
  "ibm866",
  "iso-8859-2",
  "iso-8859-3",
  "iso-8859-4",
  "iso-8859-5",
  "iso-8859-6",
  "iso-8859-7",
  "iso-8859-8",
  "iso-8859-8-i",
  "iso-8859-10",
  "iso-8859-13",
  "iso-8859-14",
  "iso-8859-15",
  "iso-8859-16",
  "koi8-r",
  "koi8-u",
  "macintosh",
  "windows-874",
  "windows-1250",
  "windows-1251",
  "windows-1252",
  "windows-1253",
  "windows-1254",
  "windows-1255",
  "windows-1256",
  "windows-1257",
  "windows-1258",
  "x-mac-cyrillic",
]);

/**
 * Valid UTF-8 that is not plain ASCII: text no single-byte label describes.
 * ASCII is excluded because it reads the same in every one of them, so a
 * declaration over ASCII bytes cannot be wrong in a way that matters.
 */
function isMultiByteUtf8(bytes: Uint8Array): boolean {
  if (!bytes.some((b) => b >= 0x80)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
