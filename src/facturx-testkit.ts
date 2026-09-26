import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

/**
 * Hand-built Factur-X PDFs for the tests: the container, one defect at a time.
 *
 * Moved here from facturx-pdf.test.ts when the container's findings began to
 * reach `validate()`, the command line and the exporters, so the four test
 * files build their PDFs one way. Excluded from `dist` by tsconfig, like
 * testkit.ts: nothing here ships, and `node:zlib` is used only to build
 * compressed fixtures — the module under test inflates with its own code.
 */

export const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "latin1"));

export const concat = (parts: Uint8Array[]): Uint8Array => {
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
 * A complete invoice as a Factur-X EN 16931 PDF carries it: the minimal
 * XRechnung CII fixture with BT-24 relabelled to `urn:cen.eu:en16931:2017`,
 * so the default container, whose metadata declares EN 16931, agrees with it.
 */
export const FACTURX_EN16931_XML = readFileSync(
  new URL("../fixtures/xrechnung-cii-minimal.xml", import.meta.url),
  "utf8",
).replace("urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0", "urn:cen.eu:en16931:2017");

const FACTURX_NS = "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#";

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface XmpPacketOptions {
  /** pdfaid:part; null leaves it out. Default "3". */
  part?: string | null;
  /** pdfaid:conformance; null leaves it out. Default "B". */
  conformance?: string | null;
  /** The namespace the Factur-X properties are written in. Default Factur-X's. */
  namespace?: string;
  /** Each Factur-X property; null leaves it out. Defaults: INVOICE, factur-x.xml, 1.0, EN 16931. */
  documentType?: string | null;
  documentFileName?: string | null;
  version?: string | null;
  conformanceLevel?: string | null;
  /** Write every property as an attribute of its rdf:Description, as FeRD's 2.5.2 samples do. */
  attributes?: boolean;
  /** Leave out the x:xmpmeta wrapper, as FeRD's 2.5.2 samples do. */
  bare?: boolean;
  /**
   * Leave out the pdfaExtension:schemas block. It is there by default because
   * real packets carry it, and it names every property as text, which a
   * reader must not take for the properties themselves.
   */
  noExtensionSchema?: boolean;
}

/**
 * An XMP packet as a Factur-X producer writes it: the PDF/A identification,
 * the four Factur-X properties, and the extension schema that describes them.
 * Each option perturbs one thing.
 */
export function xmpPacket(o: XmpPacketOptions = {}): string {
  const pick = (value: string | null | undefined, fallback: string) => (value === undefined ? fallback : value);
  const present = (pairs: [string, string | null][]) =>
    pairs.filter((p): p is [string, string] => p[1] !== null);
  const describe = (prefix: string, uri: string, props: [string, string][]) => {
    if (props.length === 0) return "";
    return o.attributes
      ? `<rdf:Description rdf:about="" xmlns:${prefix}="${uri}" ` +
          props.map(([k, v]) => `${prefix}:${k}="${escapeXml(v)}"`).join(" ") +
          "/>\n"
      : `<rdf:Description rdf:about="" xmlns:${prefix}="${uri}">\n` +
          props.map(([k, v]) => `  <${prefix}:${k}>${escapeXml(v)}</${prefix}:${k}>\n`).join("") +
          "</rdf:Description>\n";
  };
  const extension = o.noExtensionSchema
    ? ""
    : '<rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" ' +
      'xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">\n' +
      "<pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType=\"Resource\">\n" +
      "<pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>\n" +
      `<pdfaSchema:namespaceURI>${o.namespace ?? FACTURX_NS}</pdfaSchema:namespaceURI>\n` +
      "<pdfaSchema:prefix>fx</pdfaSchema:prefix>\n<pdfaSchema:property><rdf:Seq>\n" +
      ["DocumentFileName", "DocumentType", "Version", "ConformanceLevel"]
        .map(
          (name) =>
            `<rdf:li rdf:parseType="Resource"><pdfaProperty:name>${name}</pdfaProperty:name>` +
            "<pdfaProperty:valueType>Text</pdfaProperty:valueType>" +
            "<pdfaProperty:category>external</pdfaProperty:category></rdf:li>\n",
        )
        .join("") +
      "</rdf:Seq></pdfaSchema:property>\n</rdf:li></rdf:Bag></pdfaExtension:schemas>\n</rdf:Description>\n";
  const rdf =
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    describe(
      "pdfaid",
      "http://www.aiim.org/pdfa/ns/id/",
      present([
        ["part", pick(o.part, "3")],
        ["conformance", pick(o.conformance, "B")],
      ]),
    ) +
    describe(
      "fx",
      o.namespace ?? FACTURX_NS,
      present([
        ["DocumentType", pick(o.documentType, "INVOICE")],
        ["DocumentFileName", pick(o.documentFileName, "factur-x.xml")],
        ["Version", pick(o.version, "1.0")],
        ["ConformanceLevel", pick(o.conformanceLevel, "EN 16931")],
      ]),
    ) +
    extension +
    "</rdf:RDF>";
  const body = o.bare ? rdf : `<x:xmpmeta xmlns:x="adobe:ns:meta/">\n${rdf}\n</x:xmpmeta>`;
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n${body}\n<?xpacket end="w"?>`;
}

export interface BuildPdfOptions {
  attachmentName?: string;
  xml?: string;
  compress?: boolean;
  /** The file specification's /AFRelationship; null leaves the key out. Default Alternative. */
  afRelationship?: string | null;
  omitNames?: boolean;
  omitAf?: boolean;
  /** The embedded file's /Subtype, as a PDF name body; null leaves the key out. Default text#2Fxml. */
  subtype?: string | null;
  startxref?: number | "missing";
  extraAttachment?: { name: string; xml: string };
  /** Extra filter on the embedded-file stream, e.g. LZWDecode / Crypt. */
  streamFilter?: string;
  /** Point /EF at an object number the xref table does not list. */
  danglingEf?: boolean;
  /** Raw bytes to use as the embedded stream, with /Filter /FlateDecode. */
  rawPayload?: Uint8Array;
  /**
   * Point /AF at a second file specification under the same name, whose
   * embedded file holds this text instead: two copies of "the" attachment.
   */
  afCopy?: string;
  /**
   * The XMP metadata packet, as text (written as UTF-8); null leaves the
   * catalog without /Metadata. Default: `xmpPacket()` naming the attachment.
   */
  xmp?: string | null;
  /** FlateDecode the metadata stream. */
  xmpCompress?: boolean;
  /** Declare this filter on the metadata stream, over the packet's bytes as they are. */
  xmpFilter?: string;
  /** Raw bytes for the metadata stream, declared FlateDecode. */
  xmpBytes?: Uint8Array;
  /** Raw bytes for the metadata stream, stored as they are with no filter. */
  xmpStored?: Uint8Array;
  /** The /Metadata object's whole body, e.g. a dictionary that is not a stream. */
  metadataObject?: string;
}

/**
 * A minimal, valid, classic-xref PDF with one embedded XML attachment.
 *
 * Built byte by byte with real offsets so the parser is exercised rather than
 * humoured. `options` perturbs exactly one thing at a time, which is what makes
 * each adversarial case attributable to one cause. By default the attachment is
 * registered as Factur-X asks: factur-x.xml, in the name tree and in /AF, with
 * /AFRelationship /Alternative and /Subtype text/xml.
 */
export function buildPdf(options: BuildPdfOptions = {}): Uint8Array {
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

  // The metadata is object 8: a stream by default, or whatever body a test
  // asks for, or absent.
  const packet = options.xmp === undefined ? xmpPacket({ documentFileName: name }) : options.xmp;
  const hasMetadata =
    options.metadataObject !== undefined ||
    options.xmpBytes !== undefined ||
    options.xmpStored !== undefined ||
    packet !== null;
  const metadataRef = hasMetadata ? ` /Metadata 8 0 R` : "";
  if (options.metadataObject !== undefined) {
    objects[8] = options.metadataObject;
  } else if (hasMetadata) {
    const plain = options.xmpStored ?? new Uint8Array(Buffer.from(packet ?? "", "utf8"));
    const stored =
      options.xmpBytes ?? (options.xmpCompress ? new Uint8Array(deflateSync(Buffer.from(plain))) : plain);
    const xmpFilter =
      options.xmpFilter ?? (options.xmpBytes !== undefined || options.xmpCompress ? "FlateDecode" : undefined);
    objects[8] =
      `<< /Type /Metadata /Subtype /XML /Length ${stored.length}` +
      (xmpFilter ? ` /Filter /${xmpFilter}` : "") +
      ` >>`;
    streams.set(8, stored);
  }

  const af = options.afCopy === undefined ? "4 0 R" : "9 0 R";
  objects[1] =
    `<< /Type /Catalog /Pages 2 0 R` +
    (options.omitNames ? "" : ` /Names << /EmbeddedFiles << /Names [ (${name}) 4 0 R ] >> >>`) +
    (options.omitAf ? "" : ` /AF [ ${af} ]`) +
    metadataRef +
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
    `<< /Type /EmbeddedFile` +
    (options.subtype === null ? "" : ` /Subtype /${options.subtype ?? "text#2Fxml"}`) +
    ` /Length ${payload.length}` +
    (filter ? ` /Filter /${filter}` : ``) +
    ` >>`;
  streams.set(5, payload);

  if (options.extraAttachment) {
    objects[1] =
      `<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [ (${name}) 4 0 R (${options.extraAttachment.name}) 6 0 R ] >> >> /AF [ 4 0 R 6 0 R ]${metadataRef} >>`;
    objects[6] = `<< /Type /Filespec /F (${options.extraAttachment.name}) /UF (${options.extraAttachment.name}) /AFRelationship /Data /EF << /F 7 0 R >> >>`;
    objects[7] = `<< /Type /EmbeddedFile /Subtype /text#2Fxml /Length ${options.extraAttachment.xml.length} >>`;
    streams.set(7, bytes(options.extraAttachment.xml));
  }

  if (options.afCopy !== undefined) {
    const copy = bytes(options.afCopy);
    objects[9] = `<< /Type /Filespec /F (${name}) /UF (${name}) /AFRelationship /Alternative /EF << /F 10 0 R >> >>`;
    objects[10] = `<< /Type /EmbeddedFile /Subtype /text#2Fxml /Length ${copy.length} >>`;
    streams.set(10, copy);
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
