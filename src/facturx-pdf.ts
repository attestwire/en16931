/**
 * Reading the Factur-X / ZUGFeRD PDF container.
 *
 * **This reverses a documented invariant, deliberately and by half.** Every
 * previous release of this package said the PDF/A-3 container was neither read
 * nor built, and the generator doc-comments still say — correctly — that
 * `generateCii` emits the XML half only. As of 0.7.0 the container is *read*:
 * `extractFacturX` pulls the invoice XML out of a Factur-X, ZUGFeRD or
 * XRechnung-CII PDF so it can be parsed and validated by the rest of this
 * package. **It is still never built.** Writing a PDF/A-3 means font
 * embedding, colour profiles, XMP metadata and a conformance claim that a
 * validator will check, and shipping a half-conformant writer would produce
 * files that look like Factur-X and are not. Extraction has no such failure
 * mode: either the attachment is there and comes out byte-identical, or it is
 * not and this throws.
 *
 * ## Zero dependencies, including the decompressor
 *
 * The obvious implementation reaches for `DecompressionStream`, which exists in
 * Node 18+ and every modern browser. It is not used here, and the reason is the
 * signature: `DecompressionStream` is asynchronous, every other entry point in
 * this package is synchronous, and making the one PDF function `async` would
 * push a promise through every caller — `validateInput(await extract(...))` —
 * for an operation that is pure CPU over a buffer already in memory. So RFC
 * 1951 DEFLATE is implemented below, in about two hundred lines. It has no
 * feature-detection hole, works identically in Node, Bun, Deno, Workers and
 * browsers, and keeps the whole package callable from synchronous code.
 *
 * ## What it parses
 *
 * Enough PDF to find an attachment, and no more: classic cross-reference
 * tables, cross-reference streams (PDF 1.5+), object streams, `/Prev` chains,
 * and the `FlateDecode` filter with PNG predictors. It does not render, does
 * not decrypt, and does not implement `LZWDecode`, `/Crypt` or any of the image
 * filters — it names them and refuses instead, because a wrong answer about the
 * contents of a tax document is worse than no answer.
 *
 * ## Hostile input
 *
 * The bytes come from someone else, so every loop here is bounded: output size
 * and compression ratio per stream *and summed across the document* (a flate
 * bomb inflates to a cap and throws), object count, parsed-value count,
 * `/Prev` chain length, name-tree depth *and node count*, and object streams,
 * which may not contain object streams. Malformed input produces a named error
 * with a stable `code` and a byte offset where one is known; it never hangs and
 * never throws a bare `TypeError` from inside the parser.
 *
 * Two of those bounds exist because the obvious ones are not sufficient, and
 * the reasoning is worth keeping:
 *
 * - **Depth does not bound a tree.** Thirty name-tree dictionaries, each naming
 *   the next one twice in `/Kids`, never exceed depth thirty and describe 2³⁰
 *   paths. Object caching makes the file about a kilobyte. `maxNameTreeNodes`
 *   is what terminates it; `maxNameTreeDepth` never fires.
 * - **Bytes do not bound memory.** Four megabytes of `0 0 0 …` inside one
 *   object stream is a four-kilobyte PDF that costs roughly seventy megabytes
 *   of JavaScript heap once parsed, because a parsed value is much larger than
 *   the byte it came from. `maxObjectNodes` is the cap that corresponds to what
 *   a Cloudflare Worker actually runs out of.
 */

/** Caps on what a hostile or accidental PDF can make this do. */
export interface PdfLimits {
  /** Bytes any one stream may inflate to. */
  maxStreamBytes: number;
  /**
   * Bytes *every* stream in the document may inflate to, added up.
   *
   * `maxStreamBytes` bounds one stream; without a running total a file can
   * simply carry many of them. A 4 KiB PDF holding one object stream that
   * inflates to 4 MB of `0 0 0 …` costs ~68 MB of JavaScript heap once parsed,
   * because a parsed array element costs far more than the byte it came from —
   * so the byte cap that matters is the one summed across the document.
   */
  maxTotalInflatedBytes: number;
  /** Bytes the returned XML attachment may occupy. */
  maxAttachmentBytes: number;
  /** Maximum decompressed:compressed ratio for a single stream — the flate-bomb guard. */
  maxCompressionRatio: number;
  /** Maximum indirect objects resolved in one extraction. */
  maxObjects: number;
  /** Maximum `/Prev` hops when following the cross-reference chain. */
  maxXrefSections: number;
  /** Maximum `/Kids` depth in the EmbeddedFiles name tree. */
  maxNameTreeDepth: number;
  /**
   * Maximum nodes visited while walking the EmbeddedFiles name tree.
   *
   * Depth alone does not bound the walk. A chain of 30 dictionaries whose
   * `/Kids` each name the *same* next dictionary twice is 30 levels deep and
   * 2³⁰ nodes wide, and object caching means it costs almost nothing to write.
   * This counter is what actually terminates it.
   */
  maxNameTreeNodes: number;
  /** Maximum nesting depth of arrays and dictionaries in the object lexer. */
  maxObjectDepth: number;
  /**
   * Maximum values parsed across the whole extraction — every array element,
   * dictionary entry, number and name.
   *
   * This is the memory cap that `maxStreamBytes` is not. Bytes and heap are not
   * the same currency: an object stream inflating to 4 MB of `0 0 0 …` sits
   * comfortably inside every byte limit here and still costs about 70 MB of
   * JavaScript heap once parsed, which is most of a Cloudflare Worker's budget
   * spent by a four-kilobyte file.
   */
  maxObjectNodes: number;
}

export const DEFAULT_PDF_LIMITS: PdfLimits = {
  maxStreamBytes: 32 * 1024 * 1024,
  maxTotalInflatedBytes: 64 * 1024 * 1024,
  maxAttachmentBytes: 16 * 1024 * 1024,
  maxCompressionRatio: 2000,
  maxObjects: 50_000,
  maxXrefSections: 64,
  maxNameTreeDepth: 64,
  maxNameTreeNodes: 10_000,
  maxObjectDepth: 64,
  // The three FeRD sample files need 44, 646 and 646. Half a million leaves
  // three orders of magnitude of headroom for a genuinely large document while
  // still bounding the parse at roughly twenty megabytes of heap.
  maxObjectNodes: 500_000,
};

/** Base class for everything this module throws, so one `catch` covers it. */
export class PdfError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The bytes are not a PDF we can read: bad syntax, broken offsets, missing objects. */
export class PdfParseError extends PdfError {}

/** A limit in `PdfLimits` was hit. Distinct from a syntax error: the file may be valid and simply too big. */
export class PdfSecurityError extends PdfError {}

/** The PDF parsed, and carries no XML attachment we can return. */
export class FacturXNotFoundError extends PdfError {
  constructor(message: string) {
    super("facturx_no_xml_attachment", message);
  }
}

/** A filter we do not implement — named rather than guessed at. */
export class PdfUnsupportedFilterError extends PdfError {
  readonly filter: string;
  constructor(filter: string, extra = "") {
    super(
      "pdf_unsupported_filter",
      `This PDF uses the ${filter} filter, which this reader does not implement.${extra ? ` ${extra}` : ""} ` +
        `Only FlateDecode (with PNG predictors) is supported: it is what every Factur-X and ` +
        `ZUGFeRD producer uses for embedded files. Re-save the document without ${filter}, or ` +
        `extract the attachment with a full PDF library.`,
    );
    this.filter = filter;
  }
}

export interface FacturXExtraction {
  /** The embedded XML, decoded as UTF-8. */
  xml: string;
  /** The attachment's filename as the PDF states it, e.g. `factur-x.xml`. */
  attachmentName: string;
  /** Recoverable oddities. Empty means nothing surprising was seen. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// DEFLATE (RFC 1951) and zlib (RFC 1950)
// ---------------------------------------------------------------------------

const LENGTH_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
]);
const LENGTH_EXTRA = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
]);
const DIST_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]);
const DIST_EXTRA = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
]);
const CODE_LENGTH_ORDER = new Uint8Array([
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
]);

/** Canonical Huffman decoding table: counts per bit length plus symbols in order. */
interface Huffman {
  counts: Int32Array;
  symbols: Int32Array;
}

function buildHuffman(lengths: Uint8Array): Huffman {
  const counts = new Int32Array(16);
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i] as number;
    counts[len] = (counts[len] as number) + 1;
  }
  counts[0] = 0;
  const offsets = new Int32Array(16);
  for (let i = 1; i < 16; i++) {
    offsets[i] = (offsets[i - 1] as number) + (counts[i - 1] as number);
  }
  const symbols = new Int32Array(lengths.length);
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym] as number;
    if (len === 0) continue;
    const at = offsets[len] as number;
    symbols[at] = sym;
    offsets[len] = at + 1;
  }
  return { counts, symbols };
}

class BitReader {
  private pos = 0;
  private bitBuf = 0;
  private bitCount = 0;
  constructor(private readonly data: Uint8Array) {}

  bits(need: number): number {
    while (this.bitCount < need) {
      if (this.pos >= this.data.length) {
        throw new PdfParseError(
          "pdf_flate_truncated",
          "A compressed stream ended in the middle of a DEFLATE block. The PDF is truncated or corrupt.",
        );
      }
      this.bitBuf |= (this.data[this.pos++] as number) << this.bitCount;
      this.bitCount += 8;
    }
    const value = this.bitBuf & ((1 << need) - 1);
    this.bitBuf >>>= need;
    this.bitCount -= need;
    return value;
  }

  decode(table: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.bits(1);
      const count = table.counts[len] as number;
      if (code - first < count) {
        return table.symbols[index + (code - first)] as number;
      }
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new PdfParseError(
      "pdf_flate_bad_code",
      "A compressed stream contains a Huffman code no table defines. The PDF is corrupt.",
    );
  }

  alignToByte(): void {
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  get bytePos(): number {
    return this.pos;
  }
  set bytePos(v: number) {
    this.pos = v;
  }
}

/**
 * Raw DEFLATE, capped.
 *
 * `maxOutput` is checked as the window grows rather than at the end, so a
 * stream that would inflate to a gigabyte is stopped after the first megabyte
 * instead of after the allocation.
 */
function inflateRaw(data: Uint8Array, maxOutput: number): Uint8Array {
  const reader = new BitReader(data);
  let out = new Uint8Array(Math.min(maxOutput, Math.max(1024, data.length * 4)));
  let length = 0;

  const ensure = (extra: number): void => {
    if (length + extra > maxOutput) {
      throw new PdfSecurityError(
        "pdf_stream_too_large",
        `A compressed stream inflated past the ${maxOutput}-byte limit. This is the ` +
          `decompression-bomb guard; raise maxStreamBytes if the document really is this large.`,
      );
    }
    if (length + extra <= out.length) return;
    let size = out.length * 2;
    while (size < length + extra) size *= 2;
    const bigger = new Uint8Array(Math.min(size, maxOutput));
    bigger.set(out.subarray(0, length));
    out = bigger;
  };

  let fixedLit: Huffman | undefined;
  let fixedDist: Huffman | undefined;

  for (;;) {
    const last = reader.bits(1);
    const type = reader.bits(2);

    if (type === 0) {
      reader.alignToByte();
      const pos = reader.bytePos;
      if (pos + 4 > data.length) {
        throw new PdfParseError(
          "pdf_flate_truncated",
          "A stored DEFLATE block header runs past the end of the stream.",
        );
      }
      const len = (data[pos] as number) | ((data[pos + 1] as number) << 8);
      const nlen = (data[pos + 2] as number) | ((data[pos + 3] as number) << 8);
      if ((len ^ 0xffff) !== nlen) {
        throw new PdfParseError(
          "pdf_flate_bad_stored_block",
          "A stored DEFLATE block's length and its complement disagree. The stream is corrupt.",
        );
      }
      if (pos + 4 + len > data.length) {
        throw new PdfParseError(
          "pdf_flate_truncated",
          "A stored DEFLATE block runs past the end of the stream.",
        );
      }
      ensure(len);
      out.set(data.subarray(pos + 4, pos + 4 + len), length);
      length += len;
      reader.bytePos = pos + 4 + len;
    } else if (type === 1 || type === 2) {
      let lit: Huffman;
      let dist: Huffman;
      if (type === 1) {
        if (!fixedLit) {
          const litLengths = new Uint8Array(288);
          litLengths.fill(8, 0, 144);
          litLengths.fill(9, 144, 256);
          litLengths.fill(7, 256, 280);
          litLengths.fill(8, 280, 288);
          fixedLit = buildHuffman(litLengths);
          fixedDist = buildHuffman(new Uint8Array(30).fill(5));
        }
        lit = fixedLit;
        dist = fixedDist as Huffman;
      } else {
        const hlit = reader.bits(5) + 257;
        const hdist = reader.bits(5) + 1;
        const hclen = reader.bits(4) + 4;
        const codeLengths = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) {
          codeLengths[CODE_LENGTH_ORDER[i] as number] = reader.bits(3);
        }
        const codeTable = buildHuffman(codeLengths);
        const lengths = new Uint8Array(hlit + hdist);
        for (let i = 0; i < lengths.length; ) {
          const symbol = reader.decode(codeTable);
          if (symbol < 16) {
            lengths[i++] = symbol;
          } else if (symbol === 16) {
            if (i === 0) {
              throw new PdfParseError(
                "pdf_flate_bad_code",
                "A DEFLATE code-length table repeats a symbol before defining one.",
              );
            }
            const prev = lengths[i - 1] as number;
            let repeat = 3 + reader.bits(2);
            while (repeat-- > 0 && i < lengths.length) lengths[i++] = prev;
          } else if (symbol === 17) {
            let repeat = 3 + reader.bits(3);
            while (repeat-- > 0 && i < lengths.length) lengths[i++] = 0;
          } else {
            let repeat = 11 + reader.bits(7);
            while (repeat-- > 0 && i < lengths.length) lengths[i++] = 0;
          }
        }
        lit = buildHuffman(lengths.subarray(0, hlit));
        dist = buildHuffman(lengths.subarray(hlit));
      }

      for (;;) {
        const symbol = reader.decode(lit);
        if (symbol === 256) break;
        if (symbol < 256) {
          ensure(1);
          out[length++] = symbol;
          continue;
        }
        const lengthIndex = symbol - 257;
        if (lengthIndex >= LENGTH_BASE.length) {
          throw new PdfParseError(
            "pdf_flate_bad_code",
            "A DEFLATE length symbol is outside the defined range.",
          );
        }
        const copyLength =
          (LENGTH_BASE[lengthIndex] as number) +
          reader.bits(LENGTH_EXTRA[lengthIndex] as number);
        const distSymbol = reader.decode(dist);
        if (distSymbol >= DIST_BASE.length) {
          throw new PdfParseError(
            "pdf_flate_bad_code",
            "A DEFLATE distance symbol is outside the defined range.",
          );
        }
        const distance =
          (DIST_BASE[distSymbol] as number) +
          reader.bits(DIST_EXTRA[distSymbol] as number);
        if (distance > length) {
          throw new PdfParseError(
            "pdf_flate_bad_distance",
            "A DEFLATE back-reference points before the start of the output. The stream is corrupt.",
          );
        }
        ensure(copyLength);
        let from = length - distance;
        for (let i = 0; i < copyLength; i++) out[length++] = out[from++] as number;
      }
    } else {
      throw new PdfParseError(
        "pdf_flate_bad_block_type",
        "A DEFLATE block declares reserved type 3. The stream is corrupt.",
      );
    }

    if (last) break;
  }

  return out.subarray(0, length);
}

/** zlib wrapper if present, raw DEFLATE otherwise. */
function inflate(data: Uint8Array, maxOutput: number): Uint8Array {
  if (data.length === 0) return data;
  const cmf = data[0] as number;
  const flg = data[1] as number;
  const looksZlib =
    data.length > 2 && (cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0;
  if (looksZlib) {
    try {
      return inflateRaw(data.subarray(2), maxOutput);
    } catch (error) {
      if (error instanceof PdfSecurityError) throw error;
      // Some producers write a raw stream whose first two bytes happen to pass
      // the zlib check. Falling back costs one retry and rescues those.
      return inflateRaw(data, maxOutput);
    }
  }
  return inflateRaw(data, maxOutput);
}

// ---------------------------------------------------------------------------
// PDF object model
// ---------------------------------------------------------------------------

export class PdfName {
  constructor(readonly name: string) {}
}
export class PdfRef {
  constructor(
    readonly num: number,
    readonly gen: number,
  ) {}
}
export class PdfStream {
  constructor(
    readonly dict: PdfDict,
    readonly raw: Uint8Array,
  ) {}
}
export type PdfDict = Map<string, PdfObject>;
export type PdfObject =
  | number
  | boolean
  | null
  | string
  | PdfName
  | PdfRef
  | PdfStream
  | PdfObject[]
  | PdfDict;

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([
  0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25,
]);

function isRegular(byte: number): boolean {
  return !WHITESPACE.has(byte) && !DELIMITERS.has(byte);
}

/** Latin-1 decode — PDF names and keywords are ASCII, and this never throws on a stray byte. */
function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i] as number);
  }
  return s;
}

class Lexer {
  pos = 0;
  constructor(
    readonly data: Uint8Array,
    private readonly limits: PdfLimits,
    /**
     * Shared across every lexer in one document, so the budget is on the
     * extraction rather than on each object separately.
     */
    private readonly budget: { nodes: number } = { nodes: 0 },
  ) {}

  /**
   * One byte, or `-1` past the end.
   *
   * Every read goes through here so that running off the end of the buffer is a
   * value the comparisons below already handle rather than an `undefined` that
   * turns into a `NaN` three lines later. `-1` is not a byte, so no equality
   * test against a real character can accidentally match it.
   */
  private byte(at: number): number {
    const value = this.data[at];
    return value === undefined ? -1 : value;
  }

  private fail(code: string, message: string): never {
    throw new PdfParseError(code, `${message} (at byte ${this.pos})`);
  }

  skipWhitespace(): void {
    for (;;) {
      while (this.pos < this.data.length && WHITESPACE.has(this.byte(this.pos))) {
        this.pos++;
      }
      if (this.byte(this.pos) === 0x25) {
        // comment to end of line
        while (
          this.pos < this.data.length &&
          this.byte(this.pos) !== 0x0a &&
          this.byte(this.pos) !== 0x0d
        ) {
          this.pos++;
        }
        continue;
      }
      return;
    }
  }

  readToken(): string {
    this.skipWhitespace();
    const start = this.pos;
    while (this.pos < this.data.length && isRegular(this.byte(this.pos))) {
      this.pos++;
    }
    if (this.pos === start) {
      this.fail(
        "pdf_unexpected_byte",
        "Expected a PDF token (a number, keyword, name or delimiter) and found a " +
          "delimiter or end of input instead. This usually means an offset in the " +
          "cross-reference table points somewhere that is not the start of an object",
      );
    }
    return latin1(this.data.subarray(start, this.pos));
  }

  peekByte(): number {
    this.skipWhitespace();
    return this.byte(this.pos);
  }

  /** Parse one object. `depth` bounds array/dict nesting. */
  parseObject(depth = 0): PdfObject {
    if (++this.budget.nodes > this.limits.maxObjectNodes) {
      throw new PdfSecurityError(
        "pdf_too_many_object_nodes",
        `Parsing this document produced more than ${this.limits.maxObjectNodes} values ` +
          `(array elements, dictionary entries, numbers). A byte cap does not bound this: ` +
          `four megabytes of "0 0 0 …" inside one object stream costs tens of megabytes of ` +
          `heap once parsed, because a parsed value is far larger than the byte it came from.`,
      );
    }
    if (depth > this.limits.maxObjectDepth) {
      throw new PdfSecurityError(
        "pdf_object_too_deep",
        `Arrays and dictionaries nest more than ${this.limits.maxObjectDepth} deep. ` +
          `Refusing rather than recursing.`,
      );
    }
    this.skipWhitespace();
    if (this.pos >= this.data.length) {
      this.fail(
        "pdf_truncated",
        "The file ends where an indirect object was expected. It was truncated in " +
          "transit, or the cross-reference table points past the end of the data",
      );
    }
    const byte = this.byte(this.pos);

    if (byte === 0x2f) return this.parseName();
    if (byte === 0x28) return this.parseLiteralString();
    if (byte === 0x5b) return this.parseArray(depth);
    if (byte === 0x3c) {
      if (this.byte(this.pos + 1) === 0x3c) return this.parseDictOrStream(depth);
      return this.parseHexString();
    }
    if (byte === 0x5d || byte === 0x3e) {
      this.fail(
        "pdf_unexpected_byte",
        "Found an array or dictionary close with no matching open. The object " +
          "structure is corrupt, or an offset points into the middle of one",
      );
    }

    const token = this.readToken();
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;

    if (/^[+-]?[\d.]+$/.test(token)) {
      // Possible "N G R" indirect reference — look ahead, and rewind if not.
      if (/^\d+$/.test(token)) {
        const save = this.pos;
        this.skipWhitespace();
        const genStart = this.pos;
        if (this.pos < this.data.length && /\d/.test(String.fromCharCode(this.byte(this.pos)))) {
          const gen = this.readToken();
          this.skipWhitespace();
          if (/^\d+$/.test(gen) && this.byte(this.pos) === 0x52 /* R */) {
            this.pos++;
            return new PdfRef(Number(token), Number(gen));
          }
        }
        this.pos = save;
        void genStart;
      }
      const value = Number(token);
      if (Number.isNaN(value)) {
        this.fail(
        "pdf_bad_number",
        `"${token}" appears where a number was expected and cannot be read as one`,
      );
      }
      return value;
    }

    this.fail(
      "pdf_unexpected_token",
      `Unexpected token "${token}". This is not a PDF object: the reader expected a ` +
        `number, name, string, array, dictionary, or one of true/false/null`,
    );
  }

  private parseName(): PdfName {
    this.pos++; // slash
    let name = "";
    while (this.pos < this.data.length && isRegular(this.byte(this.pos))) {
      const byte = this.byte(this.pos);
      if (byte === 0x23 && this.pos + 2 < this.data.length) {
        const hex = latin1(this.data.subarray(this.pos + 1, this.pos + 3));
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          name += String.fromCharCode(parseInt(hex, 16));
          this.pos += 3;
          continue;
        }
      }
      name += String.fromCharCode(byte);
      this.pos++;
    }
    return new PdfName(name);
  }

  private parseLiteralString(): string {
    this.pos++; // (
    let depth = 1;
    let out = "";
    while (this.pos < this.data.length) {
      const byte = this.byte(this.pos++);
      if (byte === 0x5c) {
        const next = this.byte(this.pos++);
        switch (next) {
          case 0x6e: out += "\n"; break;
          case 0x72: out += "\r"; break;
          case 0x74: out += "\t"; break;
          case 0x62: out += "\b"; break;
          case 0x66: out += "\f"; break;
          case 0x0a: break;
          case 0x0d: if (this.byte(this.pos) === 0x0a) this.pos++; break;
          default:
            if (next >= 0x30 && next <= 0x37) {
              let octal = String.fromCharCode(next);
              for (let i = 0; i < 2; i++) {
                const d = this.byte(this.pos);
                if (d >= 0x30 && d <= 0x37) {
                  octal += String.fromCharCode(d);
                  this.pos++;
                }
              }
              out += String.fromCharCode(parseInt(octal, 8) & 0xff);
            } else {
              out += String.fromCharCode(next);
            }
        }
        continue;
      }
      if (byte === 0x28) depth++;
      if (byte === 0x29) {
        depth--;
        if (depth === 0) return out;
      }
      out += String.fromCharCode(byte);
    }
    this.fail("pdf_truncated", "A literal string is never closed");
  }

  private parseHexString(): string {
    this.pos++; // <
    let hex = "";
    while (this.pos < this.data.length && this.byte(this.pos) !== 0x3e) {
      const ch = String.fromCharCode(this.byte(this.pos++));
      if (/[0-9a-fA-F]/.test(ch)) hex += ch;
    }
    if (this.pos >= this.data.length) {
      this.fail(
        "pdf_truncated",
        "A hexadecimal <…> string is opened and never closed before the end of the file",
      );
    }
    this.pos++; // >
    if (hex.length % 2 === 1) hex += "0";
    let out = "";
    for (let i = 0; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return out;
  }

  private parseArray(depth: number): PdfObject[] {
    this.pos++; // [
    const items: PdfObject[] = [];
    for (;;) {
      this.skipWhitespace();
      if (this.pos >= this.data.length) {
        this.fail(
          "pdf_truncated",
          "An array is opened and never closed before the end of the file",
        );
      }
      if (this.byte(this.pos) === 0x5d) {
        this.pos++;
        return items;
      }
      items.push(this.parseObject(depth + 1));
    }
  }

  private parseDictOrStream(depth: number): PdfDict | PdfStream {
    this.pos += 2; // <<
    const dict: PdfDict = new Map();
    for (;;) {
      this.skipWhitespace();
      if (this.pos + 1 < this.data.length && this.byte(this.pos) === 0x3e && this.byte(this.pos + 1) === 0x3e) {
        this.pos += 2;
        break;
      }
      if (this.pos >= this.data.length) {
        this.fail(
          "pdf_truncated",
          "A dictionary is opened and never closed before the end of the file",
        );
      }
      if (this.byte(this.pos) !== 0x2f) {
        this.fail(
        "pdf_bad_dict_key",
        "A dictionary key is not a /Name. Every key in a PDF dictionary must begin " +
          "with a slash, so the bytes here are not a dictionary",
      );
      }
      const key = this.parseName().name;
      dict.set(key, this.parseObject(depth + 1));
    }

    const save = this.pos;
    this.skipWhitespace();
    if (latin1(this.data.subarray(this.pos, this.pos + 6)) === "stream") {
      this.pos += 6;
      if (this.byte(this.pos) === 0x0d) this.pos++;
      if (this.byte(this.pos) === 0x0a) this.pos++;
      const start = this.pos;
      const declared = dict.get("Length");
      let end: number;
      if (typeof declared === "number" && start + declared <= this.data.length) {
        end = start + declared;
        // Trust but verify: `endstream` should follow. Producers get Length
        // wrong often enough that scanning is the safer primary.
        const after = latin1(this.data.subarray(end, end + 20));
        if (!/^\s*endstream/.test(after)) {
          end = this.findEndstream(start);
        }
      } else {
        end = this.findEndstream(start);
      }
      this.pos = end;
      this.skipWhitespace();
      if (latin1(this.data.subarray(this.pos, this.pos + 9)) === "endstream") {
        this.pos += 9;
      }
      return new PdfStream(dict, this.data.subarray(start, end));
    }
    this.pos = save;
    return dict;
  }

  private findEndstream(start: number): number {
    const needle = "endstream";
    for (let i = start; i <= this.data.length - needle.length; i++) {
      if (this.byte(i) !== 0x65) continue;
      if (latin1(this.data.subarray(i, i + needle.length)) === needle) {
        let end = i;
        if (end > start && this.byte(end - 1) === 0x0a) end--;
        if (end > start && this.byte(end - 1) === 0x0d) end--;
        return end;
      }
    }
    throw new PdfParseError(
      "pdf_truncated",
      `A stream beginning at byte ${start} is never terminated by "endstream".`,
    );
  }
}

// ---------------------------------------------------------------------------
// Document: cross-reference resolution
// ---------------------------------------------------------------------------

interface XrefEntry {
  offset?: number;
  objStm?: { num: number; index: number };
}

class PdfDocument {
  private readonly entries = new Map<number, XrefEntry>();
  private readonly cache = new Map<number, PdfObject>();
  private readonly objStmCache = new Map<number, Map<number, PdfObject>>();
  private resolvedCount = 0;
  private inflatedTotal = 0;
  /** Every xref offset already read, shared by the /Prev loop and /XRefStm. */
  private readonly seenXrefOffsets = new Set<number>();
  /** One parsed-value budget for the whole document, shared by every lexer. */
  private readonly nodeBudget = { nodes: 0 };
  trailer: PdfDict = new Map();

  constructor(
    readonly data: Uint8Array,
    readonly limits: PdfLimits,
  ) {
    this.readXrefChain();
  }


  /**
   * One byte, or `-1` past the end.
   *
   * Every read goes through here so that running off the end of the buffer is a
   * value the comparisons below already handle rather than an `undefined` that
   * turns into a `NaN` three lines later. `-1` is not a byte, so no equality
   * test against a real character can accidentally match it.
   */
  private byte(at: number): number {
    const value = this.data[at];
    return value === undefined ? -1 : value;
  }

  private lexer(at: number): Lexer {
    const lexer = new Lexer(this.data, this.limits, this.nodeBudget);
    lexer.pos = at;
    return lexer;
  }

  private readXrefChain(): void {
    const tail = latin1(
      this.data.subarray(Math.max(0, this.data.length - 2048)),
    );
    const marker = tail.lastIndexOf("startxref");
    if (marker === -1) {
      throw new PdfParseError(
        "pdf_no_startxref",
        "No `startxref` keyword in the last 2 KiB of the file. Either this is not a PDF, " +
          "or it was truncated in transit — a complete PDF always ends with startxref and %%EOF.",
      );
    }
    const offsetText = /startxref\s+(\d+)/.exec(tail.slice(marker));
    if (!offsetText) {
      throw new PdfParseError(
        "pdf_bad_startxref",
        "The `startxref` keyword is not followed by a byte offset.",
      );
    }

    let next: number | undefined = Number(offsetText[1]);
    const seen = this.seenXrefOffsets;
    let sections = 0;

    while (next !== undefined) {
      if (seen.has(next)) {
        throw new PdfParseError(
          "pdf_xref_loop",
          `The cross-reference chain revisits byte ${next}, so it is a loop. ` +
            `Refusing rather than following it forever.`,
        );
      }
      seen.add(next);
      if (++sections > this.limits.maxXrefSections) {
        throw new PdfSecurityError(
          "pdf_xref_chain_too_long",
          `The cross-reference chain is longer than ${this.limits.maxXrefSections} sections.`,
        );
      }
      if (next < 0 || next >= this.data.length) {
        throw new PdfParseError(
          "pdf_bad_xref_offset",
          `A cross-reference section claims to start at byte ${next}, outside a ` +
            `${this.data.length}-byte file.`,
        );
      }
      next = this.readXrefSection(next);
    }

    if (!this.trailer.has("Root")) {
      throw new PdfParseError(
        "pdf_no_root",
        "No /Root entry in any trailer, so the document catalog cannot be found.",
      );
    }
  }

  /** Reads one section and returns its `/Prev` offset, if any. */
  private readXrefSection(offset: number): number | undefined {
    const lexer = this.lexer(offset);
    lexer.skipWhitespace();

    if (latin1(this.data.subarray(lexer.pos, lexer.pos + 4)) === "xref") {
      lexer.pos += 4;
      // Classic table: repeated "start count" subsections of 20-byte entries.
      for (;;) {
        lexer.skipWhitespace();
        if (latin1(this.data.subarray(lexer.pos, lexer.pos + 7)) === "trailer") {
          lexer.pos += 7;
          break;
        }
        const start = lexer.readToken();
        const count = lexer.readToken();
        if (!/^\d+$/.test(start) || !/^\d+$/.test(count)) {
          throw new PdfParseError(
            "pdf_bad_xref_table",
            `A cross-reference subsection header reads "${start} ${count}", which is not two integers.`,
          );
        }
        const first = Number(start);
        const total = Number(count);
        if (total > this.limits.maxObjects) {
          throw new PdfSecurityError(
            "pdf_too_many_objects",
            `A cross-reference subsection declares ${total} entries, over the ` +
              `${this.limits.maxObjects} limit.`,
          );
        }
        for (let i = 0; i < total; i++) {
          lexer.skipWhitespace();
          const entryStart = lexer.pos;
          const entry = latin1(this.data.subarray(entryStart, entryStart + 20));
          const match = /^(\d{10})\s(\d{5})\s([nf])/.exec(entry);
          if (!match) {
            throw new PdfParseError(
              "pdf_bad_xref_table",
              `Cross-reference entry ${first + i} at byte ${entryStart} is malformed.`,
            );
          }
          lexer.pos = entryStart + (entry[19] === "\n" || entry[19] === "\r" ? 20 : 19);
          if (match[3] === "n" && !this.entries.has(first + i)) {
            this.entries.set(first + i, { offset: Number(match[1]) });
          }
        }
      }
      const trailer = lexer.parseObject();
      if (!(trailer instanceof Map)) {
        throw new PdfParseError(
          "pdf_bad_trailer",
          "The `trailer` keyword is not followed by a dictionary.",
        );
      }
      for (const [key, value] of trailer) {
        if (!this.trailer.has(key)) this.trailer.set(key, value);
      }
      // A hybrid file points at a parallel xref stream; read it for the
      // entries the table omits.
      // A hybrid file's /XRefStm is followed by a direct recursive call, so it
      // does not pass through the loop guard in readXrefChain. Without its own
      // check, a table whose /XRefStm names its own offset recurses until the
      // stack gives out — caught below, but only by accident, and only after
      // re-parsing the whole table once per frame.
      const xrefStm = trailer.get("XRefStm");
      if (
        typeof xrefStm === "number" &&
        !this.seenXrefOffsets.has(xrefStm) &&
        xrefStm >= 0 &&
        xrefStm < this.data.length
      ) {
        this.seenXrefOffsets.add(xrefStm);
        try {
          this.readXrefSection(xrefStm);
        } catch {
          // A broken /XRefStm in a hybrid file is recoverable: the classic
          // table we just read is authoritative for every object it lists.
        }
      }
      const prev = trailer.get("Prev");
      return typeof prev === "number" ? prev : undefined;
    }

    // Cross-reference stream: "N G obj <<...>> stream".
    lexer.readToken(); // object number
    lexer.readToken(); // generation
    const keyword = lexer.readToken();
    if (keyword !== "obj") {
      throw new PdfParseError(
        "pdf_bad_xref_offset",
        `Byte ${offset} is neither an \`xref\` table nor an indirect object, so it ` +
          `cannot be a cross-reference section.`,
      );
    }
    const stream = lexer.parseObject();
    if (!(stream instanceof PdfStream)) {
      throw new PdfParseError(
        "pdf_bad_xref_stream",
        `The object at byte ${offset} is not a stream, so it cannot be a cross-reference stream.`,
      );
    }
    this.readXrefStream(stream);
    for (const [key, value] of stream.dict) {
      if (!this.trailer.has(key)) this.trailer.set(key, value);
    }
    const prev = stream.dict.get("Prev");
    return typeof prev === "number" ? prev : undefined;
  }

  private readXrefStream(stream: PdfStream): void {
    const data = this.decodeStream(stream);
    const w = stream.dict.get("W");
    if (!Array.isArray(w) || w.length < 3) {
      throw new PdfParseError(
        "pdf_bad_xref_stream",
        "A cross-reference stream has no usable /W field-width array.",
      );
    }
    const widths = w.map((n) => (typeof n === "number" ? n : 0));
    const rowLength = widths.reduce((a, b) => a + b, 0);
    if (rowLength === 0) {
      throw new PdfParseError(
        "pdf_bad_xref_stream",
        "A cross-reference stream declares zero-width fields.",
      );
    }

    const size = stream.dict.get("Size");
    let index = stream.dict.get("Index");
    if (!Array.isArray(index)) {
      index = [0, typeof size === "number" ? size : 0];
    }

    let pos = 0;
    for (let pair = 0; pair + 1 < index.length; pair += 2) {
      const first = Number(index[pair]);
      const count = Number(index[pair + 1]);
      if (!Number.isFinite(first) || !Number.isFinite(count) || count < 0) {
        throw new PdfParseError(
          "pdf_bad_xref_stream",
          "A cross-reference stream's /Index is not a list of integer pairs.",
        );
      }
      if (count > this.limits.maxObjects) {
        throw new PdfSecurityError(
          "pdf_too_many_objects",
          `A cross-reference stream declares ${count} entries, over the ${this.limits.maxObjects} limit.`,
        );
      }
      for (let i = 0; i < count; i++) {
        if (pos + rowLength > data.length) return; // truncated tail: keep what parsed
        const fields: number[] = [];
        for (const width of widths) {
          let value = 0;
          for (let b = 0; b < width; b++) {
            value = value * 256 + (data[pos++] as number);
          }
          fields.push(value);
        }
        const type = widths[0] === 0 ? 1 : (fields[0] as number);
        const num = first + i;
        if (this.entries.has(num)) continue;
        if (type === 1) {
          this.entries.set(num, { offset: fields[1] as number });
        } else if (type === 2) {
          this.entries.set(num, {
            objStm: { num: fields[1] as number, index: fields[2] as number },
          });
        }
      }
    }
  }

  /** Applies filters. Only FlateDecode (optionally PNG-predicted) is implemented. */
  decodeStream(stream: PdfStream): Uint8Array {
    const filter = this.resolve(stream.dict.get("Filter") ?? null);
    const filters: PdfName[] = filter instanceof PdfName
      ? [filter]
      : Array.isArray(filter)
        ? filter.filter((f): f is PdfName => f instanceof PdfName)
        : [];

    let data = stream.raw;
    for (const f of filters) {
      if (f.name === "FlateDecode" || f.name === "Fl") {
        // The document-wide budget is folded into the per-stream cap rather
        // than checked afterwards, so a stream that would exhaust it stops
        // inflating at the boundary instead of allocating past it first.
        const remaining = Math.max(
          0,
          this.limits.maxTotalInflatedBytes - this.inflatedTotal,
        );
        const perStream = Math.min(
          this.limits.maxStreamBytes,
          Math.max(4096, data.length * this.limits.maxCompressionRatio),
        );
        const cap = Math.min(perStream, remaining);
        const budgetBound = remaining < perStream;
        const exhausted = (): never => {
          throw new PdfSecurityError(
            "pdf_total_inflated_too_large",
            `The streams in this document inflate to more than the ` +
              `${this.limits.maxTotalInflatedBytes}-byte document-wide limit. One stream may sit ` +
              `under maxStreamBytes and a hundred of them still not; raise ` +
              `maxTotalInflatedBytes if the document really is this large.`,
          );
        };
        if (cap === 0) exhausted();
        try {
          data = inflate(data, cap);
        } catch (error) {
          if (
            budgetBound &&
            error instanceof PdfSecurityError &&
            error.code === "pdf_stream_too_large"
          ) {
            exhausted();
          }
          throw error;
        }
        this.inflatedTotal += data.length;
      } else if (f.name === "Crypt") {
        throw new PdfUnsupportedFilterError(
          "Crypt",
          "The document appears to be encrypted.",
        );
      } else {
        throw new PdfUnsupportedFilterError(f.name);
      }
    }

    const parms = this.resolve(
      stream.dict.get("DecodeParms") ?? stream.dict.get("DP") ?? null,
    );
    // `find` returns the *element*, which in an array-valued /DecodeParms is
    // routinely an indirect reference. Resolving after the search — as this
    // used to — hands a PdfRef to code that then calls `.get` on it.
    const parmDict = parms instanceof Map
      ? parms
      : Array.isArray(parms)
        ? parms
            .map((p) => this.resolve(p))
            .find((p): p is PdfDict => p instanceof Map)
        : undefined;
    if (parmDict) {
      const predictor = Number(this.resolve(parmDict.get("Predictor") ?? 1));
      if (predictor >= 10) {
        data = applyPngPredictor(
          data,
          Number(this.resolve(parmDict.get("Colors") ?? 1)) || 1,
          Number(this.resolve(parmDict.get("BitsPerComponent") ?? 8)) || 8,
          Number(this.resolve(parmDict.get("Columns") ?? 1)) || 1,
        );
      } else if (predictor === 2) {
        throw new PdfUnsupportedFilterError(
          "TIFF predictor 2",
          "It does not occur in Factur-X files.",
        );
      }
    }
    return data;
  }

  /** One dereference step. Non-references pass through. */
  resolve(object: PdfObject): PdfObject {
    let current = object;
    let hops = 0;
    while (current instanceof PdfRef) {
      if (++hops > 32) {
        throw new PdfParseError(
          "pdf_reference_loop",
          "An indirect reference chain is more than 32 hops long, so it is a loop.",
        );
      }
      current = this.getObject(current.num);
    }
    return current;
  }

  getObject(num: number): PdfObject {
    const cached = this.cache.get(num);
    if (cached !== undefined) return cached;
    if (++this.resolvedCount > this.limits.maxObjects) {
      throw new PdfSecurityError(
        "pdf_too_many_objects",
        `Resolving this document needed more than ${this.limits.maxObjects} objects.`,
      );
    }

    const entry = this.entries.get(num);
    if (!entry) {
      throw new PdfParseError(
        "pdf_missing_object",
        `Object ${num} is referenced but the cross-reference table does not list it.`,
      );
    }

    let value: PdfObject;
    if (entry.objStm) {
      value = this.getFromObjectStream(entry.objStm.num, entry.objStm.index, num);
    } else {
      const offset = entry.offset ?? -1;
      if (offset < 0 || offset >= this.data.length) {
        throw new PdfParseError(
          "pdf_bad_object_offset",
          `Object ${num} is listed at byte ${offset}, outside a ${this.data.length}-byte file.`,
        );
      }
      const lexer = this.lexer(offset);
      const declaredNum = lexer.readToken();
      lexer.readToken();
      const keyword = lexer.readToken();
      if (keyword !== "obj") {
        throw new PdfParseError(
          "pdf_bad_object_header",
          `Byte ${offset} should begin object ${num} but reads "${declaredNum} … ${keyword}".`,
        );
      }
      value = lexer.parseObject();
    }
    this.cache.set(num, value);
    return value;
  }

  private getFromObjectStream(
    stmNum: number,
    index: number,
    wantedNum: number,
  ): PdfObject {
    let parsed = this.objStmCache.get(stmNum);
    if (!parsed) {
      const entry = this.entries.get(stmNum);
      if (entry?.objStm) {
        // An object stream inside an object stream is forbidden by the spec
        // (ISO 32000-1 §7.5.7) and is the shape a recursive-decompression
        // attack takes, so it is refused by name rather than by depth counter.
        throw new PdfParseError(
          "pdf_nested_object_stream",
          `Object stream ${stmNum} is itself stored inside an object stream. The PDF ` +
            `specification forbids that, and following it is how a decompression loop starts.`,
        );
      }
      const stream = this.resolve(new PdfRef(stmNum, 0));
      if (!(stream instanceof PdfStream)) {
        throw new PdfParseError(
          "pdf_bad_object_stream",
          `Object ${stmNum} is referenced as an object stream but is not a stream.`,
        );
      }
      const data = this.decodeStream(stream);
      const count = Number(this.resolve(stream.dict.get("N") ?? 0));
      const first = Number(this.resolve(stream.dict.get("First") ?? 0));
      if (!Number.isFinite(count) || !Number.isFinite(first) || count < 0) {
        throw new PdfParseError(
          "pdf_bad_object_stream",
          `Object stream ${stmNum} has no usable /N and /First.`,
        );
      }
      if (count > this.limits.maxObjects) {
        throw new PdfSecurityError(
          "pdf_too_many_objects",
          `Object stream ${stmNum} declares ${count} objects, over the ${this.limits.maxObjects} limit.`,
        );
      }
      const header = new Lexer(data, this.limits, this.nodeBudget);
      const pairs: [number, number][] = [];
      for (let i = 0; i < count; i++) {
        const objNum = Number(header.readToken());
        const objOff = Number(header.readToken());
        if (!Number.isFinite(objNum) || !Number.isFinite(objOff)) {
          throw new PdfParseError(
            "pdf_bad_object_stream",
            `Object stream ${stmNum} has a malformed offset table.`,
          );
        }
        pairs.push([objNum, objOff]);
      }
      parsed = new Map();
      for (const [objNum, objOff] of pairs) {
        const at = first + objOff;
        if (at < 0 || at >= data.length) continue;
        const lexer = new Lexer(data, this.limits, this.nodeBudget);
        lexer.pos = at;
        try {
          parsed.set(objNum, lexer.parseObject());
        } catch (error) {
          // One unreadable member does not condemn the rest of the stream —
          // but a *limit* is not an unreadable member. Swallowing it here let
          // a member large enough to blow the parsed-value budget be retried
          // as the next member, and the next, with the budget already spent.
          if (error instanceof PdfSecurityError) throw error;
        }
      }
      this.objStmCache.set(stmNum, parsed);
    }
    void index;
    const value = parsed.get(wantedNum);
    if (value === undefined) {
      throw new PdfParseError(
        "pdf_missing_object",
        `Object ${wantedNum} is listed as living in object stream ${stmNum}, which does not contain it.`,
      );
    }
    return value;
  }

  dictGet(dict: PdfDict, key: string): PdfObject {
    return this.resolve(dict.get(key) ?? null);
  }
}

/**
 * Undo the PNG row filters a cross-reference stream is normally written with.
 *
 * The three parameters come out of a dictionary an attacker writes, so they are
 * checked before they reach arithmetic. `/Columns -5` used to produce a
 * negative row length and a bare `RangeError: Invalid typed array length` from
 * `new Uint8Array(-25)`, and `/Columns 600000000` used to commit a 600 MB
 * allocation for a row buffer no byte of the stream could ever fill.
 */
function applyPngPredictor(
  data: Uint8Array,
  colors: number,
  bits: number,
  columns: number,
): Uint8Array {
  if (data.length === 0) return data;
  const sane = (value: number, name: string, max: number): number => {
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new PdfParseError(
        "pdf_bad_predictor_parms",
        `A stream's predictor declares /${name} ${value}, which is not a positive ` +
          `integer no larger than ${max}. Predictor parameters are read from the ` +
          `document, so an impossible one is refused rather than turned into an ` +
          `allocation size.`,
      );
    }
    return value;
  };
  colors = sane(colors, "Colors", 32);
  bits = sane(bits, "BitsPerComponent", 32);
  // A row cannot be longer than the data it is filtered out of: every row costs
  // at least its own length plus a filter byte, so a larger /Columns describes
  // rows that cannot exist and must not be allocated for.
  columns = sane(columns, "Columns", Math.max(1, data.length));

  const bpp = Math.max(1, Math.ceil((colors * bits) / 8));
  const rowLength = Math.ceil((colors * bits * columns) / 8);
  // No complete row fits, so there is nothing to unfilter — and in particular
  // no reason to allocate a row buffer of that size.
  if (rowLength + 1 > data.length) return new Uint8Array(0);
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = new Uint8Array(rows * rowLength);
  let prev = new Uint8Array(rowLength);

  for (let r = 0; r < rows; r++) {
    const filter = data[r * (rowLength + 1)] as number;
    const row = data.subarray(
      r * (rowLength + 1) + 1,
      r * (rowLength + 1) + 1 + rowLength,
    );
    const current = new Uint8Array(row);
    for (let i = 0; i < rowLength; i++) {
      const left = i >= bpp ? (current[i - bpp] as number) : 0;
      const up = prev[i] as number;
      const upLeft = i >= bpp ? (prev[i - bpp] as number) : 0;
      switch (filter) {
        case 0: break;
        case 1: current[i] = ((current[i] as number) + left) & 0xff; break;
        case 2: current[i] = ((current[i] as number) + up) & 0xff; break;
        case 3: current[i] = ((current[i] as number) + ((left + up) >> 1)) & 0xff; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const best = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          current[i] = ((current[i] as number) + best) & 0xff;
          break;
        }
        default:
          throw new PdfParseError(
            "pdf_bad_predictor",
            `A stream uses PNG row filter ${filter}, which is not one of the five defined.`,
          );
      }
    }
    out.set(current, r * rowLength);
    prev = current;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Finding the attachment
// ---------------------------------------------------------------------------

/**
 * The filenames the standards mandate, best first.
 *
 * `factur-x.xml` is the Factur-X / ZUGFeRD 2.x name, `zugferd-invoice.xml` the
 * ZUGFeRD 1.0 one, and `xrechnung.xml` the name the XRECHNUNG reference profile
 * uses. Any other `.xml` attachment is accepted with a warning rather than
 * refused: a file that carries exactly one XML attachment under a house name is
 * still a file whose invoice we can read, and refusing it would help nobody.
 */
const PREFERRED_NAMES = ["factur-x.xml", "zugferd-invoice.xml", "xrechnung.xml"];

interface Candidate {
  name: string;
  stream: PdfStream;
  source: "name-tree" | "AF";
  relationship?: string;
  subtype?: string;
}

/**
 * One `/Filespec` → a candidate, or `undefined` if it does not resolve to one.
 *
 * Resolution failures are swallowed deliberately. A PDF may list several
 * attachments, and one dangling reference must not stop the others being
 * found — the caller's question is "is there an invoice in here", and the
 * honest answer to a file with one broken entry and one good one is the good
 * one. When *every* entry fails, the caller gets `FacturXNotFoundError`, which
 * says what was actually observed, rather than an object-numbering error that
 * only a PDF implementer could act on.
 */
function fileSpecCandidate(
  doc: PdfDocument,
  spec: PdfObject,
  source: Candidate["source"],
): Candidate | undefined {
  try {
    return fileSpecCandidateStrict(doc, spec, source);
  } catch (error) {
    if (error instanceof PdfSecurityError) throw error; // a limit still stops us
    return undefined;
  }
}

function fileSpecCandidateStrict(
  doc: PdfDocument,
  spec: PdfObject,
  source: Candidate["source"],
): Candidate | undefined {
  const dict = doc.resolve(spec);
  if (!(dict instanceof Map)) return undefined;
  const ef = doc.dictGet(dict, "EF");
  if (!(ef instanceof Map)) return undefined;
  // Each key in turn, not the first key that is *present*: a file whose /F is a
  // dangling reference and whose /UF is good is a file whose attachment we can
  // still return, and stopping at /F would have thrown that away.
  let stream: PdfObject = null;
  for (const key of ["F", "UF", "DOS", "Mac", "Unix"]) {
    if (!ef.has(key)) continue;
    let resolved: PdfObject;
    try {
      resolved = doc.resolve(ef.get(key) ?? null);
    } catch (error) {
      if (error instanceof PdfSecurityError) throw error;
      continue;
    }
    if (resolved instanceof PdfStream) {
      stream = resolved;
      break;
    }
  }
  if (!(stream instanceof PdfStream)) return undefined;

  // /UF first — it is the Unicode one, and the one PDF 2.0 prefers — but fall
  // through to /F when /UF is absent or is not a string at all.
  const rawName = [doc.dictGet(dict, "UF"), doc.dictGet(dict, "F")].find(
    (v): v is string => typeof v === "string",
  );
  const name = rawName === undefined ? undefined : decodePdfTextString(rawName);
  const relationship = doc.dictGet(dict, "AFRelationship");
  const subtype = doc.dictGet(stream.dict, "Subtype");

  return {
    name: (name ?? "").replace(/^.*[\\/]/, ""),
    stream,
    source,
    relationship: relationship instanceof PdfName ? relationship.name : undefined,
    subtype: subtype instanceof PdfName ? subtype.name : undefined,
  };
}

/**
 * Walk the EmbeddedFiles name tree, bounded in depth *and* in total nodes.
 *
 * The depth cap alone is not a bound. Thirty dictionaries in a chain, each
 * naming the next one twice in its `/Kids`, never exceed depth thirty and
 * describe 2³⁰ paths; because `getObject` caches, the file that says so is
 * about a kilobyte. Measured before this counter existed, depth 28 took 13.5
 * seconds and depth 40 would not have finished. `visited` handles the honest
 * half of the same shape — a diamond, where one node is legitimately reachable
 * by two routes — and the counter catches everything else.
 */
function walkNameTree(
  doc: PdfDocument,
  node: PdfObject,
  out: Candidate[],
  depth: number,
  state: {
    nodes: number;
    visited: Set<PdfObject>;
    path: Set<PdfObject>;
  } = { nodes: 0, visited: new Set(), path: new Set() },
): void {
  if (depth > doc.limits.maxNameTreeDepth) {
    throw new PdfSecurityError(
      "pdf_name_tree_too_deep",
      `The EmbeddedFiles name tree nests more than ${doc.limits.maxNameTreeDepth} levels deep.`,
    );
  }
  if (++state.nodes > doc.limits.maxNameTreeNodes) {
    throw new PdfSecurityError(
      "pdf_name_tree_too_large",
      `The EmbeddedFiles name tree has more than ${doc.limits.maxNameTreeNodes} nodes. ` +
        `A tree whose /Kids revisit each other describes exponentially many paths ` +
        `through very few objects, so the node count is what bounds the walk, not the depth.`,
    );
  }
  const dict = doc.resolve(node);
  if (!(dict instanceof Map)) return;
  // Reached again from a *different* branch — a diamond. Its subtree is already
  // collected, so walking it again can only duplicate candidates and multiply
  // the work; this is the prune that turns 2^30 paths back into 30 nodes.
  //
  // Reached again from *within itself* is a different thing: a cycle, which is
  // a corrupt file rather than a redundant one. That case deliberately falls
  // through to the depth counter, so it is still reported as the structural
  // defect it is instead of being quietly read as an empty tree.
  if (state.visited.has(dict) && !state.path.has(dict)) return;
  state.visited.add(dict);
  state.path.add(dict);

  const names = doc.dictGet(dict, "Names");
  if (Array.isArray(names)) {
    for (let i = 0; i + 1 < names.length; i += 2) {
      const key = doc.resolve(names[i] as PdfObject);
      const candidate = fileSpecCandidate(
        doc,
        names[i + 1] as PdfObject,
        "name-tree",
      );
      if (candidate) {
        if (!candidate.name && typeof key === "string") {
          candidate.name = decodePdfTextString(key);
        }
        out.push(candidate);
      }
    }
  }

  const kids = doc.dictGet(dict, "Kids");
  if (Array.isArray(kids)) {
    for (const kid of kids) walkNameTree(doc, kid, out, depth + 1, state);
  }
  state.path.delete(dict);
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Decode a PDF *text string* into real characters.
 *
 * The lexer hands strings back one byte per code unit, which is right for the
 * byte strings PDF uses for things like `/F`, and wrong for the text strings it
 * uses for `/UF`. ISO 32000-1 §7.9.2.2 says a text string is either
 * PDFDocEncoded or UTF-16BE introduced by a `FE FF` byte-order mark, and
 * §7.9.2.2.1 of PDF 2.0 adds UTF-8 behind `EF BB BF`. Every Factur-X producer
 * writes `/UF (þÿ\0f\0a\0c…)`, so skipping this step made the attachment name
 * come back as `þÿ f a c t u r - x . x m l` — which does not match `/\.xml$/`,
 * and the extractor reported a conformant file as carrying no XML at all.
 *
 * A string with no BOM is left alone: PDFDocEncoding agrees with Latin-1 over
 * every character a filename realistically uses, and guessing beyond that would
 * corrupt names this already reads correctly.
 */
function decodePdfTextString(value: string): string {
  if (value.charCodeAt(0) === 0xfe && value.charCodeAt(1) === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < value.length; i += 2) {
      out += String.fromCharCode((value.charCodeAt(i) << 8) | value.charCodeAt(i + 1));
    }
    return out;
  }
  // Not in the specification, but written by enough producers to be worth
  // reading: the little-endian mark. Nothing legitimate starts `ÿþ` otherwise.
  if (value.charCodeAt(0) === 0xff && value.charCodeAt(1) === 0xfe) {
    let out = "";
    for (let i = 2; i + 1 < value.length; i += 2) {
      out += String.fromCharCode((value.charCodeAt(i + 1) << 8) | value.charCodeAt(i));
    }
    return out;
  }
  if (
    value.charCodeAt(0) === 0xef &&
    value.charCodeAt(1) === 0xbb &&
    value.charCodeAt(2) === 0xbf
  ) {
    const raw = new Uint8Array(value.length - 3);
    for (let i = 3; i < value.length; i++) raw[i - 3] = value.charCodeAt(i) & 0xff;
    return utf8(raw);
  }
  return value;
}

/**
 * Pull the invoice XML out of a Factur-X / ZUGFeRD / XRechnung-CII PDF.
 *
 * Extraction only — this never writes a PDF. The returned `xml` is the
 * attachment's bytes decoded as UTF-8 and is suitable input for
 * `parseCiiInvoice`.
 *
 * Throws `FacturXNotFoundError` when the document carries no XML attachment,
 * `PdfParseError` when the bytes are not a readable PDF, `PdfSecurityError`
 * when a limit in `PdfLimits` is hit, and `PdfUnsupportedFilterError` for a
 * compression filter this reader does not implement. It does not return a
 * partial result and it does not throw anything else.
 */
export function extractFacturX(
  bytes: Uint8Array,
  limits: Partial<PdfLimits> = {},
): FacturXExtraction {
  const lim: PdfLimits = { ...DEFAULT_PDF_LIMITS, ...limits };

  if (!(bytes instanceof Uint8Array)) {
    throw new PdfParseError(
      "pdf_not_bytes",
      "extractFacturX expects the PDF as a Uint8Array.",
    );
  }
  if (bytes.length === 0) {
    throw new PdfParseError(
      "pdf_empty",
      "The input is zero bytes long, so there is no PDF to read.",
    );
  }
  const header = latin1(bytes.subarray(0, 1024));
  if (!header.startsWith("%PDF-") && !header.includes("%PDF-")) {
    throw new PdfParseError(
      "pdf_no_header",
      "The input does not begin with %PDF-. A Factur-X file is a PDF; if you have the " +
        "XML on its own, pass it to parseCiiInvoice instead of this function.",
    );
  }

  const warnings: string[] = [];
  const doc = new PdfDocument(bytes, lim);

  const root = doc.resolve(doc.trailer.get("Root") ?? null);
  if (!(root instanceof Map)) {
    throw new PdfParseError(
      "pdf_no_catalog",
      "The /Root entry does not resolve to a document catalog dictionary.",
    );
  }

  const candidates: Candidate[] = [];

  // 1. /Names /EmbeddedFiles — where the attachment is registered.
  const names = doc.dictGet(root, "Names");
  if (names instanceof Map) {
    const embedded = doc.dictGet(names, "EmbeddedFiles");
    if (embedded instanceof Map) walkNameTree(doc, embedded, candidates, 0);
  }

  // 2. /AF — the PDF/A-3 associated-files array. Factur-X requires both, and
  // a file that has only one of them still opens, so both are read.
  const af = doc.dictGet(root, "AF");
  if (Array.isArray(af)) {
    for (const spec of af) {
      const candidate = fileSpecCandidate(doc, spec, "AF");
      if (candidate) candidates.push(candidate);
    }
  }

  if (candidates.length === 0) {
    throw new FacturXNotFoundError(
      "This PDF has no embedded files: neither a /Names /EmbeddedFiles name tree nor an " +
        "/AF array names one. It is an ordinary PDF, not a Factur-X or ZUGFeRD file — " +
        "the XML invoice is what makes it one, and there is no XML here.",
    );
  }

  // Deduplicate: the same stream normally appears in both the name tree and
  // /AF, which is correct and not worth a warning. Two *different* streams
  // under one name is worth one.
  const unique: Candidate[] = [];
  for (const candidate of candidates) {
    const twin = unique.find(
      (u) => u.name.toLowerCase() === candidate.name.toLowerCase(),
    );
    if (!twin) {
      unique.push(candidate);
      continue;
    }
    if (twin.stream !== candidate.stream) {
      warnings.push(
        `The name tree and the /AF array both name "${candidate.name}" but point at different ` +
          `embedded streams. The name-tree copy was used. A conformant file has one attachment ` +
          `referenced from both places.`,
      );
    }
  }

  const xmlCandidates = unique.filter((c) => /\.xml$/i.test(c.name));
  if (xmlCandidates.length === 0) {
    throw new FacturXNotFoundError(
      `This PDF has ${unique.length} embedded file(s) — ${unique
        .map((c) => `"${c.name}"`)
        .join(", ")} — and none of them is an .xml file. Factur-X and ZUGFeRD carry the ` +
        `invoice as XML attached under factur-x.xml, zugferd-invoice.xml or xrechnung.xml.`,
    );
  }

  const ranked = [...xmlCandidates].sort((a, b) => {
    const ai = PREFERRED_NAMES.indexOf(a.name.toLowerCase());
    const bi = PREFERRED_NAMES.indexOf(b.name.toLowerCase());
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  const chosen = ranked[0] as Candidate;

  if (ranked.length > 1) {
    warnings.push(
      `This PDF carries ${ranked.length} XML attachments (${ranked
        .map((c) => `"${c.name}"`)
        .join(", ")}). "${chosen.name}" was returned. A conformant Factur-X file has exactly one.`,
    );
  }
  if (!PREFERRED_NAMES.includes(chosen.name.toLowerCase())) {
    warnings.push(
      `The XML is attached as "${chosen.name}", which is not one of the standard names ` +
        `(${PREFERRED_NAMES.join(", ")}). The XML was returned anyway, but a receiver that ` +
        `looks the attachment up by name — as Factur-X readers are entitled to — will not find it.`,
    );
  }
  if (chosen.relationship === undefined) {
    warnings.push(
      `The attachment declares no /AFRelationship. PDF/A-3 requires one, and Germany requires ` +
        `"Alternative" for the BASIC, EN 16931, EXTENDED and XRECHNUNG profiles.`,
    );
  } else if (!["Alternative", "Data", "Source"].includes(chosen.relationship)) {
    warnings.push(
      `The attachment declares /AFRelationship "${chosen.relationship}". Factur-X expects ` +
        `"Alternative" (the XML and the page image are the same invoice).`,
    );
  }
  if (chosen.subtype && !/xml/i.test(chosen.subtype)) {
    warnings.push(
      `The embedded file's /Subtype is "${chosen.subtype}" rather than an XML media type.`,
    );
  }

  const raw = doc.decodeStream(chosen.stream);
  if (raw.length > lim.maxAttachmentBytes) {
    throw new PdfSecurityError(
      "pdf_attachment_too_large",
      `The embedded XML is ${raw.length} bytes, over the ${lim.maxAttachmentBytes}-byte limit. ` +
        `Raise maxAttachmentBytes if an invoice this size is expected.`,
    );
  }

  const xml = utf8(raw).replace(/^﻿/, "");
  if (!/<[^>]*CrossIndustryInvoice/i.test(xml) && !/<\?xml/i.test(xml)) {
    warnings.push(
      `The attachment "${chosen.name}" does not begin with an XML declaration and contains no ` +
        `CrossIndustryInvoice element, so it may not be an invoice at all. It was returned ` +
        `unchanged for you to inspect.`,
    );
  } else if (!/CrossIndustryInvoice/i.test(xml)) {
    warnings.push(
      `The attachment is XML but has no rsm:CrossIndustryInvoice root. Factur-X and ZUGFeRD 2.x ` +
        `carry UN/CEFACT CII; this may be a ZUGFeRD 1.0 document or another syntax entirely.`,
    );
  }

  return { xml, attachmentName: chosen.name, warnings };
}
