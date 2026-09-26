/**
 * Reading a PDF's XMP metadata packet, for the few properties a Factur-X /
 * ZUGFeRD file declares there: its PDF/A identification, and the four
 * properties the format adds (DocumentType, DocumentFileName, Version,
 * ConformanceLevel).
 *
 * XMP is RDF written as XML (ISO 16684-1), and a simple property can be
 * written two ways, both of which producers use: as an element inside an
 * `rdf:Description` (`<pdfaid:part>3</pdfaid:part>`, as the factur-x Python
 * library that made FeRD's MINIMUM sample, and this project's own PDF writer,
 * do) or as an attribute of it (`pdfaid:part="3"`, as FeRD's own BASIC and
 * EN 16931 sample files do). The packet may sit in an `x:xmpmeta` wrapper or be a bare
 * `rdf:RDF` (FeRD's samples again). Both forms and both shapes are read, and
 * properties are matched by namespace URI, never by prefix, which is only a
 * spelling.
 *
 * THIS IS NOT A PDF/A CHECK. It reads the claim a file makes; whether the file
 * keeps it (embedded fonts, colour profiles, the `pdfaExtension` description
 * PDF/A requires for the Factur-X namespace, the rest of ISO 19005-3) is a
 * question for a PDF/A validator such as veraPDF, and nothing here answers it.
 *
 * The packet goes through `parseXml`, this package's one hardened XML reader,
 * with limits sized for metadata: a real packet is a few kilobytes, and one
 * that carries a thumbnail a few hundred. The `<?xpacket?>` processing
 * instructions around it are skipped, as every processing instruction is.
 */

import { ParseError, parseXml, type XmlElement, type XmlLimits } from "./xml-parse.js";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const PDFAID = "http://www.aiim.org/pdfa/ns/id/";

/** Which format a Factur-X / ZUGFeRD XMP namespace belongs to. */
export type FacturXXmpSchema = "factur-x" | "zugferd-2.0" | "zugferd-1.0";

/**
 * The namespaces the formats have defined for their XMP properties.
 *
 * `factur-x` is Factur-X's, which ZUGFeRD adopted from 2.1 on; `zugferd-2.0`
 * and `zugferd-1.0` are those two releases' own. The same URIs are what
 * Mustang, the open-source ZUGFeRD library, writes for each
 * (`ZUGFeRDExporterFromA3.getNamespaceForVersion`).
 */
export const FACTURX_XMP_NAMESPACES: Readonly<Record<FacturXXmpSchema, string>> = {
  "factur-x": "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#",
  "zugferd-2.0": "urn:zugferd:pdfa:CrossIndustryDocument:invoice:2p0#",
  "zugferd-1.0": "urn:ferd:pdfa:CrossIndustryDocument:invoice:1p0#",
};

/** The four properties, by local name, in the order the format lists them. */
export const FACTURX_XMP_PROPERTIES = ["DocumentType", "DocumentFileName", "Version", "ConformanceLevel"] as const;

/**
 * What a PDF's XMP metadata states about the file. Every value is as the
 * packet writes it, trimmed; a property the packet does not state, or states
 * empty, is absent.
 */
export interface FacturXXmp {
  /** `pdfaid:part`: `"3"` for PDF/A-3. */
  pdfaPart?: string;
  /** `pdfaid:conformance`: `"A"`, `"B"` or `"U"` for PDF/A-3. */
  pdfaConformance?: string;
  /**
   * The namespace the Factur-X / ZUGFeRD properties were found in. Absent when
   * the packet has none of them.
   */
  namespace?: string;
  /**
   * Which format that namespace belongs to. Absent when the properties are in
   * a namespace none of them defines, where a reader that matches by
   * namespace does not see them.
   */
  schema?: FacturXXmpSchema;
  /** `DocumentType`: `"INVOICE"` for an invoice or a credit note. */
  documentType?: string;
  /** `DocumentFileName`: the attachment's name, e.g. `"factur-x.xml"`. */
  documentFileName?: string;
  /** `Version`: the version of the format's XMP schema, e.g. `"1.0"`. */
  version?: string;
  /** `ConformanceLevel`: the profile, e.g. `"EN 16931"` or `"BASIC WL"`. */
  conformanceLevel?: string;
}

/** Caps for a metadata packet: far above any real one, far below the defaults for an invoice. */
const XMP_LIMITS: Partial<XmlLimits> = {
  maxCharacters: 4_000_000,
  maxElements: 20_000,
  maxDepth: 64,
};

/** An element's text, its descendants' included, as an XPath string value reads it. */
function textOf(el: XmlElement): string {
  return el.children.length === 0 ? el.text : el.children.map(textOf).join("");
}

/** The `rdf:RDF` element: the root itself, or the first one below it. */
function findRdf(el: XmlElement): XmlElement | undefined {
  if (el.namespace === RDF && el.local === "RDF") return el;
  for (const child of el.children) {
    const found = findRdf(child);
    if (found) return found;
  }
  return undefined;
}

/**
 * Read the properties a Factur-X / ZUGFeRD file declares in its XMP metadata.
 *
 * @throws {ParseError} when the packet is not well-formed XML (an
 *   `XmlSyntaxError` or `XmlSecurityError` from `parseXml`), or is XML with no
 *   `rdf:RDF` element, code `xmp_no_rdf`. Nothing else: a property that is
 *   missing is absent from the result, never an error.
 */
export function readXmp(text: string): FacturXXmp {
  const root = parseXml(text, XMP_LIMITS);
  const rdf = findRdf(root);
  if (!rdf) {
    throw new ParseError(
      "xmp_no_rdf",
      `The metadata is XML, but not XMP: it has no rdf:RDF element (its root element is <${root.qname}>).`,
    );
  }

  // namespace → local name → value. The first statement of a property wins,
  // as it does for an attribute stated twice.
  const properties = new Map<string, Map<string, string>>();
  const state = (namespace: string, local: string, value: string) => {
    let inNamespace = properties.get(namespace);
    if (!inNamespace) properties.set(namespace, (inNamespace = new Map()));
    const trimmed = value.trim();
    if (trimmed !== "" && !inNamespace.has(local)) inNamespace.set(local, trimmed);
  };
  for (const description of rdf.children) {
    if (description.namespace !== RDF || description.local !== "Description") continue;
    for (const a of description.attributes) {
      // rdf:about and the namespace declarations are not properties; an
      // unprefixed attribute is in no namespace and so cannot be one either.
      if (a.namespace === "" || a.namespace === RDF || a.qname === "xmlns" || a.qname.startsWith("xmlns:")) continue;
      state(a.namespace, a.local, a.value);
    }
    for (const property of description.children) state(property.namespace, property.local, textOf(property));
  }

  const result: FacturXXmp = {};
  const pdfaid = properties.get(PDFAID);
  const part = pdfaid?.get("part");
  const conformance = pdfaid?.get("conformance");
  if (part !== undefined) result.pdfaPart = part;
  if (conformance !== undefined) result.pdfaConformance = conformance;

  const hasAny = (values: Map<string, string>) => FACTURX_XMP_PROPERTIES.some((name) => values.has(name));
  let found: { namespace: string; schema?: FacturXXmpSchema; values: Map<string, string> } | undefined;
  for (const [schema, namespace] of Object.entries(FACTURX_XMP_NAMESPACES) as [FacturXXmpSchema, string][]) {
    const values = properties.get(namespace);
    if (values && hasAny(values)) {
      found = { namespace, schema, values };
      break;
    }
  }
  // Mustang's validator finds these properties by local name alone, in any
  // namespace. A file that relies on that is read here too, so its values are
  // still checked, and reported as sitting in a namespace no format defines.
  // Only the two names no other schema uses qualify a namespace: "Version" or
  // "DocumentType" alone is as likely to be some producer's own metadata.
  if (!found) {
    for (const [namespace, values] of properties) {
      if (namespace !== PDFAID && (values.has("ConformanceLevel") || values.has("DocumentFileName"))) {
        found = { namespace, values };
        break;
      }
    }
  }
  if (found) {
    result.namespace = found.namespace;
    if (found.schema) result.schema = found.schema;
    const { values } = found;
    const value = (name: (typeof FACTURX_XMP_PROPERTIES)[number]) => values.get(name);
    const documentType = value("DocumentType");
    const documentFileName = value("DocumentFileName");
    const version = value("Version");
    const conformanceLevel = value("ConformanceLevel");
    if (documentType !== undefined) result.documentType = documentType;
    if (documentFileName !== undefined) result.documentFileName = documentFileName;
    if (version !== undefined) result.version = version;
    if (conformanceLevel !== undefined) result.conformanceLevel = conformanceLevel;
  }
  return result;
}
