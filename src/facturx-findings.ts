/**
 * The Factur-X / ZUGFeRD container's own findings: what the PDF around the
 * invoice XML says about that XML, checked against what the formats ask.
 *
 * `extractFacturX` has noticed some of this since 0.7.0 — a house name for
 * the attachment, a missing `/AFRelationship`, a media type that is not XML —
 * and said so in `warnings`, a list of sentences only the browser checker
 * showed. `validate()` dropped them, so the API, the command line and the
 * GitHub Action judged the XML and said nothing about the file it came in.
 * Every observation now has a stable `id`, a severity, a message that says why
 * it matters and a fix, and `validate()` reports it under one of six `AW-PDF-*`
 * ids, one per part of the file a producer fixes:
 *
 *   AW-PDF-ATTACHMENT    the XML attachment itself: its name, whether it is the
 *                        only one, its encoding declaration, whether it is CII
 *   AW-PDF-AF            where it is registered: the catalog's /AF array and
 *                        the EmbeddedFiles name tree
 *   AW-PDF-RELATIONSHIP  its /AFRelationship
 *   AW-PDF-MIME          its media type, the embedded file's /Subtype
 *   AW-PDF-XMP           the XMP metadata: there, readable, claiming PDF/A-3,
 *                        carrying the four Factur-X properties, naming the
 *                        attachment that is there
 *   AW-PDF-XMP-PROFILE   the profile the metadata declares: a level the format
 *                        defines, and the one the XML's BT-24 declares
 *
 * Most are decided by the PDF alone and come from `extractFacturX`. Two need
 * the XML's BT-24, which only a parse of the XML knows, and come from
 * `facturXProfileFindings`, which `validate()` calls with the BT-24 it read:
 * the metadata's level against BT-24's, and an /AFRelationship of Data or
 * Source on a profile Germany asks Alternative for.
 *
 * NONE IS FATAL. `fatal` means the document is rejected, and none of these can
 * say that with certainty: every one describes a file this reader could read,
 * and whether another reader can depends on how it looks for the invoice. Each
 * severity is justified where it is set.
 *
 * NO LOCATION. A finding's `location` is a line and column in the file (or in
 * the attachment `location.attachment` names), and a PDF dictionary key has
 * neither. The hosted API documents, and its tests hold, that an `AW-` finding
 * carries no `location`, `xpath` or `docsUrl`; the GitHub Action reads
 * `location.line` wherever a `location` exists. So each message names the
 * place instead: the attachment by its name, the PDF key and the XMP property
 * by their own.
 *
 * NOT A PDF/A VERDICT. These read the claims a file makes about itself and
 * check them against the XML beside them. Whether the file is the PDF/A-3 it
 * claims to be (fonts, colour, the rest of ISO 19005-3) is veraPDF's question.
 */

import type { FacturXExtraction } from "./facturx-pdf.js";
import type { Severity } from "./types.js";
import { FACTURX_XMP_NAMESPACES, FACTURX_XMP_PROPERTIES, type FacturXXmp, type FacturXXmpSchema } from "./xmp.js";

/** The `validate()` finding ids for the container. Ordered as `validate()` lists them. */
export const FACTURX_RULES = [
  "AW-PDF-ATTACHMENT",
  "AW-PDF-AF",
  "AW-PDF-RELATIONSHIP",
  "AW-PDF-MIME",
  "AW-PDF-XMP",
  "AW-PDF-XMP-PROFILE",
] as const;

export type FacturXRule = (typeof FACTURX_RULES)[number];

/** Every observation id, grouped by the rule it is reported under. */
export const FACTURX_OBSERVATIONS = [
  "attachment_name",
  "attachment_ambiguous",
  "attachment_extra",
  "attachment_encoding",
  "attachment_not_cii",
  "af_streams_differ",
  "af_missing",
  "af_name_tree_missing",
  "relationship_missing",
  "relationship_unexpected",
  "relationship_not_alternative",
  "mime_not_xml",
  "mime_missing",
  "xmp_missing",
  "xmp_unreadable",
  "xmp_pdfa_missing",
  "xmp_pdfa_part",
  "xmp_pdfa_conformance",
  "xmp_facturx_missing",
  "xmp_facturx_incomplete",
  "xmp_facturx_namespace",
  "xmp_document_type",
  "xmp_file_name",
  "xmp_level_unknown",
  "xmp_level_mismatch",
] as const;

/**
 * One observation's stable id, finer than its rule: code that needs to tell
 * "no /AFRelationship" from "an unexpected one" branches on this, not on the
 * message, which may be reworded.
 */
export type FacturXObservation = (typeof FACTURX_OBSERVATIONS)[number];

/** One thing the container says, as a finding. `validate()` reports it without `id`. */
export interface FacturXFinding {
  /** The `validate()` finding id this is reported under. */
  rule: FacturXRule;
  /** This observation's own stable id. */
  id: FacturXObservation;
  /**
   * `"document"`: the finding is about the file. `"BT-24"` when it sets the
   * metadata against the specification identifier the XML declares.
   */
  field: "document" | "BT-24";
  /** Never `"fatal"`: see the module note. */
  severity: Exclude<Severity, "fatal">;
  /** What the file says, and why it matters. */
  message: string;
  /** What to change, concretely. */
  fix: string;
}

const finding = (
  rule: FacturXRule,
  id: FacturXObservation,
  severity: Exclude<Severity, "fatal">,
  message: string,
  fix: string,
  field: FacturXFinding["field"] = "document",
): FacturXFinding => ({ rule, id, field, severity, message, fix });

/** Container findings in `FACTURX_RULES` order, each rule's in the order they were raised. */
export function sortFacturXFindings<T extends { rule: string }>(findings: readonly T[]): T[] {
  const rank = (f: T) => {
    const at = (FACTURX_RULES as readonly string[]).indexOf(f.rule);
    return at === -1 ? FACTURX_RULES.length : at;
  };
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
    .map(({ f }) => f);
}

const quoted = (names: readonly string[]) => names.map((n) => `"${n}"`).join(", ");

const NAME_FIX =
  "Attach the invoice XML as factur-x.xml (xrechnung.xml for the XRECHNUNG profile), and give the " +
  "XMP property DocumentFileName the same name.";

const RELATIONSHIP_FIX =
  "Set /AFRelationship /Alternative on the XML's file specification, which Germany requires for the " +
  "BASIC, EN 16931, EXTENDED and XRECHNUNG profiles, or /Data for MINIMUM and BASIC WL.";

const MIME_FIX = "Set /Subtype /text#2Fxml (text/xml) on the embedded file stream.";

// ---------------------------------------------------------------------------
// AW-PDF-ATTACHMENT: the XML attachment itself
// ---------------------------------------------------------------------------

/**
 * The XML is attached under a name the formats do not define.
 *
 * A warning, not fatal: this reader, like others, takes the only XML attachment
 * whatever it is called, so some receivers do find the invoice. A receiver that
 * looks it up by name does not, and Mustang's validator reports the
 * DocumentFileName that goes with it as an error.
 */
export function attachmentName(name: string): FacturXFinding {
  return finding(
    "AW-PDF-ATTACHMENT",
    "attachment_name",
    "warning",
    `The invoice XML is attached as "${name}", which is not a name the formats define: factur-x.xml, ` +
      `zugferd-invoice.xml (older ZUGFeRD files) or xrechnung.xml (the XRECHNUNG profile). It was read ` +
      `here anyway, but a receiver that looks the invoice up by name, as Factur-X readers do, finds none ` +
      `in this file.`,
    NAME_FIX,
  );
}

/**
 * Several XML attachments, and nothing says which is the invoice: none has a
 * standard name, or more than one has.
 *
 * A warning: two receivers can read two different documents from this file, and
 * the verdict here is about the one this reader chose. Not fatal, because each
 * receiver still finds an invoice.
 */
export function attachmentAmbiguous(names: readonly string[], chosen: string, standard: number): FacturXFinding {
  return finding(
    "AW-PDF-ATTACHMENT",
    "attachment_ambiguous",
    "warning",
    `This PDF carries ${names.length} XML attachments (${quoted(names)}), and nothing in it says which ` +
      `one is the invoice: ${standard === 0 ? "none has a standard name" : `${standard} have a standard name`}. ` +
      `"${chosen}" was read here. A receiver that picks another one validates and books a different ` +
      `document from the one checked here.`,
    "Keep exactly one XML attachment under a standard name: factur-x.xml, or xrechnung.xml for the " +
      "XRECHNUNG profile. Give supporting XML files other names.",
  );
}

/**
 * Several XML attachments, exactly one under a standard name, and that one was
 * read.
 *
 * Information: Factur-X allows other attachments, and the one under the
 * standard name is the one a receiver reads, so this is a fact about the file,
 * not a defect. It is reported because nothing here checked the others.
 */
export function attachmentExtra(names: readonly string[], chosen: string): FacturXFinding {
  return finding(
    "AW-PDF-ATTACHMENT",
    "attachment_extra",
    "information",
    `This PDF carries ${names.length} XML attachments (${quoted(names)}). The invoice was read from ` +
      `"${chosen}", the only one under a standard name and the one a receiver reads; the others were ` +
      `not read, and nothing here checked them.`,
    "Nothing to change if the other XML files are supporting documents. An /AFRelationship of " +
      "/Supplement on each says so to every reader.",
  );
}

/**
 * The attachment declares an encoding other than UTF-8 and holds only ASCII.
 *
 * A warning: today every receiver reads the same invoice, because ASCII reads
 * the same in both encodings, but the declaration contradicts the format, and
 * the producer behind it ships a different invoice to different receivers the
 * first time a name carries an umlaut.
 */
export function attachmentEncoding(name: string, label: string): FacturXFinding {
  return finding(
    "AW-PDF-ATTACHMENT",
    "attachment_encoding",
    "warning",
    `The attachment "${name}" declares encoding "${label}", but Factur-X and ZUGFeRD attachments are ` +
      `UTF-8. This one holds only ASCII, which reads the same either way, so every receiver sees the same ` +
      `invoice today. The first "ß" or "é" its producer writes will read differently in a receiver that ` +
      `follows the declaration and in one that reads UTF-8, as the format says to.`,
    `Have the producer write the XML in UTF-8 and declare it as encoding="UTF-8".`,
  );
}

/**
 * The attachment is not a CII CrossIndustryInvoice.
 *
 * A warning, not fatal: the verdict below is about whatever the XML is (a UBL
 * invoice is judged as one; a ZUGFeRD 1.0 document is refused as unreadable
 * on its own), and some exchanges do carry other XML in a PDF. A receiver that
 * expects Factur-X cannot process it.
 */
export function attachmentNotCii(name: string): FacturXFinding {
  return finding(
    "AW-PDF-ATTACHMENT",
    "attachment_not_cii",
    "warning",
    `The attachment "${name}" is not a UN/CEFACT CII CrossIndustryInvoice, which is what Factur-X and ` +
      `ZUGFeRD 2 carry: it may be a ZUGFeRD 1.0 CrossIndustryDocument, which this validator does not read, ` +
      `a UBL invoice, or not an invoice at all. A receiver that reads the file as Factur-X finds no ` +
      `invoice it can process.`,
    "Attach the invoice as UN/CEFACT CII, with the root element rsm:CrossIndustryInvoice, which is the " +
      "syntax Factur-X and ZUGFeRD receivers read.",
  );
}

// ---------------------------------------------------------------------------
// AW-PDF-AF: where the attachment is registered
// ---------------------------------------------------------------------------

/**
 * The name tree and /AF name the same attachment and point at different files.
 *
 * A warning: two readers can see two different invoices in one PDF. Not fatal,
 * because each of them does find one.
 */
export function afStreamsDiffer(name: string): FacturXFinding {
  return finding(
    "AW-PDF-AF",
    "af_streams_differ",
    "warning",
    `The EmbeddedFiles name tree and the /AF array both list "${name}" but point at different embedded ` +
      `files, so this PDF holds two versions of the invoice XML. The name tree's copy was read here; a ` +
      `reader that follows /AF reads the other one, and may see a different invoice.`,
    "Reference one embedded file from both places: the name tree entry and the /AF entry should be the " +
      "same file specification.",
  );
}

/**
 * The attachment is in the name tree and not in /AF.
 *
 * A warning: /AF is how PDF/A-3 associates an embedded file with the document,
 * and Factur-X requires the XML in both places. Most readers also search the
 * name tree, so the invoice is usually still found; one that follows /AF alone
 * finds nothing.
 */
export function afMissing(name: string): FacturXFinding {
  return finding(
    "AW-PDF-AF",
    "af_missing",
    "warning",
    `The attachment "${name}" is registered in the EmbeddedFiles name tree but not in the catalog's /AF ` +
      `array. PDF/A-3 associates an embedded file with the document through /AF, and Factur-X requires the ` +
      `invoice XML to be listed there as well as in the name tree: a reader that looks only at /AF finds ` +
      `no invoice in this file.`,
    "Add the attachment's file specification to the catalog's /AF array.",
  );
}

/**
 * The attachment is in /AF and not in the name tree.
 *
 * A warning for the mirror reason: viewers and many readers list attachments
 * from the name tree, and Factur-X requires the XML there too.
 */
export function afNameTreeMissing(name: string): FacturXFinding {
  return finding(
    "AW-PDF-AF",
    "af_name_tree_missing",
    "warning",
    `The attachment "${name}" is listed in the catalog's /AF array but not in the EmbeddedFiles name ` +
      `tree. PDF viewers show attachments from that name tree, and Factur-X requires the invoice XML to be ` +
      `registered there as well as in /AF: a reader that looks only at the name tree finds no invoice in ` +
      `this file.`,
    `Register the file specification in the catalog's /Names /EmbeddedFiles name tree, under "${name}".`,
  );
}

// ---------------------------------------------------------------------------
// AW-PDF-RELATIONSHIP: /AFRelationship
// ---------------------------------------------------------------------------

/**
 * No /AFRelationship on the XML's file specification.
 *
 * A warning: ISO 19005-3 makes the key required on an associated file, so the
 * file is not valid PDF/A-3, which Factur-X is defined on. Not fatal: a reader
 * that only wants the XML still finds it.
 */
export function relationshipMissing(name: string): FacturXFinding {
  return finding(
    "AW-PDF-RELATIONSHIP",
    "relationship_missing",
    "warning",
    `The file specification of "${name}" has no /AFRelationship. PDF/A-3 requires the key on every ` +
      `associated file, and Factur-X requires Data, Source or Alternative on the invoice XML, so the file ` +
      `is not valid PDF/A-3 and a reader cannot tell how the XML relates to the page.`,
    RELATIONSHIP_FIX,
  );
}

/**
 * An /AFRelationship other than Data, Source or Alternative.
 *
 * A warning: Supplement, Unspecified and the rest say the XML is not the
 * invoice, which a receiver may take at its word. Not fatal: the XML is still
 * there to read.
 */
export function relationshipUnexpected(name: string, relationship: string): FacturXFinding {
  return finding(
    "AW-PDF-RELATIONSHIP",
    "relationship_unexpected",
    "warning",
    `The file specification of "${name}" declares /AFRelationship /${relationship}. For the invoice XML, ` +
      `Factur-X allows Data, Source or Alternative: the XML is the data behind the page, its source, or ` +
      `the same invoice in another form. /${relationship} says it is none of these, so a receiver may not ` +
      `treat the attachment as the invoice.`,
    RELATIONSHIP_FIX,
  );
}

/** The profiles for which Germany asks Alternative: the ones that are invoices. */
const ALTERNATIVE_IN_GERMANY: ReadonlySet<string> = new Set(["BASIC", "EN 16931", "EXTENDED", "XRECHNUNG"]);

/**
 * /AFRelationship Data or Source on an invoice whose BT-24 declares BASIC,
 * EN 16931, EXTENDED or XRECHNUNG.
 *
 * Factur-X allows Data, Source and Alternative for these profiles, and so do
 * French receivers. For use in Germany the specification requires Alternative
 * with them, which says the page and the XML are the same invoice in two
 * forms. The sources, as far as they can be read from here (the specification
 * itself ships inside FeRD's download package):
 *
 *   - Mustang, the open-source ZUGFeRD library, writes Alternative for every
 *     profile except MINIMUM and BASIC WL, which get Data, citing "ZUGFeRD
 *     2.1.1 Technical Supplement | Part A | 2.2.2. Data Relationship"
 *     (ZUGFeRDExporterFromA3.java in github.com/ZUGFeRD/mustangproject,
 *     master, read 2026-09-25).
 *   - Section 6.2.2 of the Factur-X specification, as quoted in the Prince
 *     forum's AFRelationship thread (princexml.com/forum/topic/5033,
 *     2024-08-28): for use in Germany "it is imperative to use the value
 *     Alternative".
 *   - PDFlib's ZUGFeRD and Factur-X knowledge-base page reads ZUGFeRD 2.1 the
 *     same way, and allows Source for BASIC, EN 16931 and EXTENDED when the
 *     recipient is outside Germany and the PDF was generated from the XML.
 *
 * INFORMATION, NOT A WARNING. The requirement is Germany's, not the format's,
 * and nothing in the file says where it is going. Files that ignore it are
 * common and are received: FeRD's own sample files use Data (PDFlib noted it
 * of the 2.1 samples; the BASIC and EN 16931 samples in fixtures/facturx
 * still do).
 */
export function relationshipNotAlternative(name: string, relationship: string, level: string): FacturXFinding {
  return finding(
    "AW-PDF-RELATIONSHIP",
    "relationship_not_alternative",
    "information",
    `The invoice XML "${name}" is attached with /AFRelationship /${relationship}, and its BT-24 declares the ` +
      `${level} profile. Factur-X accepts ${relationship} there, and so does France, but for invoices in ` +
      `Germany the ZUGFeRD specification requires Alternative with the BASIC, EN 16931, EXTENDED and ` +
      `XRECHNUNG profiles: it says the page and the XML are the same invoice in two forms.`,
    `For an invoice to a receiver in Germany, set /AFRelationship /Alternative on the XML's file ` +
      `specification. For France, /${relationship} can stay.`,
  );
}

// ---------------------------------------------------------------------------
// AW-PDF-MIME: the embedded file's /Subtype
// ---------------------------------------------------------------------------

/**
 * A media type that is not XML.
 *
 * A warning: Factur-X asks for text/xml and a reader that selects attachments
 * by media type skips this one; most look at the name, so the invoice is
 * usually found.
 */
export function mimeNotXml(name: string, subtype: string): FacturXFinding {
  return finding(
    "AW-PDF-MIME",
    "mime_not_xml",
    "warning",
    `The embedded file "${name}" declares the media type ${subtype} (its /Subtype), which is not an XML ` +
      `type. Factur-X asks for text/xml, and a reader that picks attachments by media type passes over ` +
      `this one.`,
    MIME_FIX,
  );
}

/**
 * No media type at all.
 *
 * A warning: PDF/A-3 requires an embedded file to state its media type, so the
 * file is not valid PDF/A-3. Not fatal, for the reason above.
 */
export function mimeMissing(name: string): FacturXFinding {
  return finding(
    "AW-PDF-MIME",
    "mime_missing",
    "warning",
    `The embedded file "${name}" declares no media type: its stream has no /Subtype. PDF/A-3 requires ` +
      `every embedded file to state one, and Factur-X asks for text/xml.`,
    MIME_FIX,
  );
}

// ---------------------------------------------------------------------------
// The profile the XML declares, in the metadata's words
// ---------------------------------------------------------------------------

/** A Factur-X / ZUGFeRD profile, as the XMP ConformanceLevel property spells it. */
export type FacturXLevel = "MINIMUM" | "BASIC WL" | "BASIC" | "EN 16931" | "EXTENDED" | "XRECHNUNG";

/**
 * BT-24 → the Factur-X / ZUGFeRD profile it declares, spelled as the XMP
 * ConformanceLevel property spells it, or undefined when it declares none this
 * recognises (Peppol BIS, say, or Factur-X's French EXTENDED-CTC-FR, whose
 * metadata level this build does not assert).
 *
 * This is the reading the engine already gave BT-24, in one place. MINIMUM and
 * BASIC WL match by the patterns AW-PROFILE-SUBSET has always used, and
 * `validate` now asks this function for that finding too, so the two cannot
 * disagree. XRECHNUNG is recognised by the word, as the CII reader recognises
 * the xrechnung-cii profile, and EN 16931 by its exact identifier. BASIC and
 * EXTENDED by the Factur-X and ZUGFeRD 2.0 identifiers FeRD's samples and
 * Mustang's profile list use (`urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic`,
 * `…#conformant#urn:factur-x.eu:1p0:extended`). The level names are the ones
 * Mustang writes into the metadata (`Profile.getXMPName`: BASICWL is "BASIC
 * WL", EN16931 is "EN 16931").
 */
export function facturXLevel(customizationId: string | undefined): FacturXLevel | undefined {
  const id = (customizationId ?? "").trim().toLowerCase();
  if (id === "") return undefined;
  if (/factur-x\.eu:1p0:minimum|zugferd.*:minimum/.test(id)) return "MINIMUM";
  if (/factur-x\.eu:1p0:basicwl|zugferd.*:basicwl/.test(id)) return "BASIC WL";
  if (/(factur-x\.eu:1p0|zugferd\.de:2p0):basic$/.test(id)) return "BASIC";
  if (/(factur-x\.eu:1p0|zugferd\.de:2p0):extended$/.test(id)) return "EXTENDED";
  if (id.includes("xrechnung")) return "XRECHNUNG";
  if (id === "urn:cen.eu:en16931:2017") return "EN 16931";
  return undefined;
}

/**
 * The ConformanceLevel values each metadata schema defines. Factur-X's is the
 * list Mustang's validator accepts, without the two it keeps for older files
 * (COMFORT, which is ZUGFeRD 1.0's, and CIUS); ZUGFeRD 1.0 had three profiles.
 */
const XMP_LEVELS: Readonly<Record<FacturXXmpSchema, readonly string[]>> = {
  "factur-x": ["MINIMUM", "BASIC WL", "BASIC", "EN 16931", "EXTENDED", "XRECHNUNG"],
  "zugferd-2.0": ["MINIMUM", "BASIC WL", "BASIC", "EN 16931", "EXTENDED"],
  "zugferd-1.0": ["BASIC", "COMFORT", "EXTENDED"],
};

/** The levels a packet's schema defines; every one of them when the namespace is not a format's. */
function levelsOf(schema: FacturXXmpSchema | undefined): readonly string[] {
  return schema ? XMP_LEVELS[schema] : [...new Set(Object.values(XMP_LEVELS).flat())];
}

const SCHEMA_NAME: Readonly<Record<FacturXXmpSchema, string>> = {
  "factur-x": "Factur-X",
  "zugferd-2.0": "ZUGFeRD 2.0",
  "zugferd-1.0": "ZUGFeRD 1.0",
};

/** A level's usual misspellings, by the letters left once case, spaces, hyphens and underscores go. */
const LEVEL_BY_LETTERS: Readonly<Record<string, string>> = {
  MINIMUM: "MINIMUM",
  BASICWL: "BASIC WL",
  BASIC: "BASIC",
  EN16931: "EN 16931",
  EXTENDED: "EXTENDED",
  XRECHNUNG: "XRECHNUNG",
  COMFORT: "COMFORT",
};

/** " It is spelled EN 16931." and the like, or nothing. */
function spellingHint(level: string, known: readonly string[]): string {
  const meant = LEVEL_BY_LETTERS[level.toUpperCase().replace(/[\s_-]+/g, "")];
  if (meant === "COMFORT" && !known.includes("COMFORT")) {
    return " COMFORT is ZUGFeRD 1.0's name for the profile Factur-X and later ZUGFeRD call EN 16931.";
  }
  return meant !== undefined && known.includes(meant) ? ` The level is spelled ${meant}.` : "";
}

// ---------------------------------------------------------------------------
// AW-PDF-XMP: the XMP metadata
// ---------------------------------------------------------------------------

const XMP_FIX =
  "Produce the PDF with XMP metadata that identifies it as PDF/A-3 (pdfaid:part 3, pdfaid:conformance B) " +
  "and carries the Factur-X properties DocumentType, DocumentFileName, Version and ConformanceLevel.";

/**
 * No XMP metadata at all.
 *
 * A warning: PDF/A requires it, and it is where Factur-X declares the
 * attachment and its profile; Mustang's validator reports its absence as an
 * error. Not fatal: the invoice XML is still there, and read.
 */
export function xmpMissing(): FacturXFinding {
  return finding(
    "AW-PDF-XMP",
    "xmp_missing",
    "warning",
    "This PDF has no XMP metadata: its catalog has no /Metadata stream. That metadata is where a file " +
      "claims to be PDF/A-3, which Factur-X and ZUGFeRD are defined on, and where it declares the invoice " +
      "attachment's name and profile. A file without it claims neither, and validators of the format, " +
      "Mustang among them, reject it.",
    XMP_FIX,
  );
}

/**
 * Metadata that is there and cannot be read: not a stream, a filter this
 * reader lacks, bytes that are not text, XML that is not well-formed, or XML
 * that is not XMP. Never an exception: the invoice was read, and this is a
 * fact about the file around it.
 *
 * A warning, for the reason `xmpMissing` is one: to a reader, unreadable
 * metadata claims nothing. Mustang reports unparseable metadata as an error.
 */
export function xmpUnreadable(detail: string): FacturXFinding {
  const said = detail.trim();
  return finding(
    "AW-PDF-XMP",
    "xmp_unreadable",
    "warning",
    `The PDF's XMP metadata (/Metadata) could not be read: ${/[.!?]$/.test(said) ? said : `${said}.`} A ` +
      `receiver reads the file's PDF/A claim and its Factur-X profile from there, so to it this file claims ` +
      `neither.`,
    "Have the PDF producer write the metadata as a well-formed XMP packet: UTF-8 XML, an rdf:RDF element " +
      "(inside x:xmpmeta) holding rdf:Description elements.",
  );
}

/**
 * No `pdfaid:part`: the file does not claim to be PDF/A.
 *
 * A warning: Factur-X and ZUGFeRD are PDF/A-3 files, and Mustang reports one
 * that is not as an error. Not fatal, for the reason above.
 */
export function xmpPdfaMissing(conformance: string | undefined): FacturXFinding {
  return finding(
    "AW-PDF-XMP",
    "xmp_pdfa_missing",
    "warning",
    `The XMP metadata has no PDF/A identification: no pdfaid:part` +
      (conformance === undefined ? " and no pdfaid:conformance" : ` (only pdfaid:conformance ${conformance})`) +
      `. So this file does not claim to be PDF/A at all, while Factur-X and ZUGFeRD are defined as PDF/A-3 ` +
      `files, and a validator of the format rejects one that does not claim it.`,
    "Produce the PDF as PDF/A-3, which writes pdfaid:part 3 and pdfaid:conformance (B for most generated " +
      "invoices) to its XMP metadata.",
  );
}

/**
 * A PDF/A part other than 3.
 *
 * A warning: the formats are defined on PDF/A-3, the part that lets any file
 * be embedded. PDF/A-1 forbids embedded files and PDF/A-2 admits only PDF/A
 * ones, so a validator judging the file by the part it claims fails it for the
 * invoice XML; Mustang reports "Not a PDF/A-3".
 */
export function xmpPdfaPart(part: string): FacturXFinding {
  const consequence =
    part === "1"
      ? " PDF/A-1 forbids embedded files, so a PDF/A validator judging this file as it claims fails it for carrying the invoice XML."
      : part === "2"
        ? " PDF/A-2 allows only PDF/A files to be embedded, so a PDF/A validator judging this file as it claims fails it for carrying the invoice XML."
        : " A validator of the format checks for PDF/A-3 and finds a claim to something else.";
  return finding(
    "AW-PDF-XMP",
    "xmp_pdfa_part",
    "warning",
    `The XMP metadata identifies this file as PDF/A-${part} (pdfaid:part ${part}), but Factur-X and ZUGFeRD ` +
      `are defined as PDF/A-3 files, the part that allows any file to be embedded.${consequence}`,
    "Produce the PDF as PDF/A-3 and write pdfaid:part 3 to its XMP metadata.",
  );
}

/**
 * PDF/A-3 with no conformance level, or one PDF/A-3 does not have.
 *
 * A warning: the claim is incomplete, and a validator needs the level to know
 * which rules it claims to meet.
 */
export function xmpPdfaConformance(conformance: string | undefined): FacturXFinding {
  return finding(
    "AW-PDF-XMP",
    "xmp_pdfa_conformance",
    "warning",
    `The XMP metadata identifies PDF/A-3 with ` +
      (conformance === undefined
        ? "no conformance level (pdfaid:conformance)"
        : `the conformance level "${conformance}" (pdfaid:conformance)`) +
      `. PDF/A-3 has three, A, B and U, and a validator needs the one the file claims to know which rules ` +
      `to apply.`,
    "Write the level the file meets to pdfaid:conformance: B for most generated invoices, U when all its " +
      "text maps to Unicode, A when it is also tagged.",
  );
}

/**
 * None of the four Factur-X properties.
 *
 * A warning: the metadata does not say the file is Factur-X at all, and
 * Mustang's validator reports each missing property as an error. FeRD's own
 * BASIC and EN 16931 sample files (fixtures/facturx) are like this. Not fatal: a reader
 * that looks for the attachment by name still finds the invoice.
 */
export function xmpFacturXMissing(attachment: string): FacturXFinding {
  return finding(
    "AW-PDF-XMP",
    "xmp_facturx_missing",
    "warning",
    "The XMP metadata does not declare this file as Factur-X or ZUGFeRD: none of the four properties the " +
      "format adds to it (DocumentType, DocumentFileName, Version, ConformanceLevel) is there. Receivers " +
      "read them to find the invoice attachment and its profile without opening the XML, and Mustang " +
      "rejects a file that lacks them.",
    `Write the Factur-X properties in the namespace ${FACTURX_XMP_NAMESPACES["factur-x"]}: DocumentType ` +
      `INVOICE, DocumentFileName ${attachment}, Version 1.0, and ConformanceLevel with the profile the XML ` +
      `declares (EN 16931, for example). PDF/A also requires the namespace to be described in a ` +
      `pdfaExtension:schemas block.`,
  );
}

/**
 * Some of the four Factur-X properties, not all.
 *
 * A warning: the format requires all four, and Mustang reports each missing
 * one as an error.
 */
export function xmpFacturXIncomplete(missing: readonly string[], namespace: string): FacturXFinding {
  const list = missing.join(", ");
  return finding(
    "AW-PDF-XMP",
    "xmp_facturx_incomplete",
    "warning",
    `The XMP metadata declares Factur-X properties but not ${list}. The format requires all four, ` +
      `DocumentType, DocumentFileName, Version and ConformanceLevel, and Mustang reports each missing one as ` +
      `an error.`,
    `Add ${list} to the XMP metadata, in the namespace ${namespace}.`,
  );
}

/**
 * The properties are there, in a namespace none of the formats defines.
 *
 * A warning: XMP and PDF/A tools match properties by namespace and do not see
 * these, although Mustang, which matches by local name, does.
 */
export function xmpFacturXNamespace(namespace: string): FacturXFinding {
  return finding(
    "AW-PDF-XMP",
    "xmp_facturx_namespace",
    "warning",
    `The XMP metadata has Factur-X properties in the namespace "${namespace}", which is none of the ` +
      `three the formats define (${Object.values(FACTURX_XMP_NAMESPACES).join(", ")}). A reader that ` +
      `matches them by namespace, as XMP and PDF/A tools do, does not see them.`,
    `Write the properties in the namespace ${FACTURX_XMP_NAMESPACES["factur-x"]}, and describe it in the ` +
      `pdfaExtension:schemas block.`,
  );
}

/**
 * A DocumentType other than INVOICE.
 *
 * A warning: it is the property that tells an invoice from an Order-X order,
 * and Mustang reports a value it does not know as an error.
 */
export function xmpDocumentType(value: string): FacturXFinding {
  return finding(
    "AW-PDF-XMP",
    "xmp_document_type",
    "warning",
    `The XMP metadata declares DocumentType "${value}", but an invoice, credit notes included, declares ` +
      `INVOICE. A receiver that sorts hybrid documents by this property will not treat this file as an ` +
      `invoice.`,
    "Write INVOICE to DocumentType.",
  );
}

/**
 * DocumentFileName names an attachment that is not the one there.
 *
 * A warning: a reader that follows the metadata to the attachment finds
 * nothing. Not fatal: a reader that looks the name up itself does.
 */
export function xmpFileName(declared: string, actual: string): FacturXFinding {
  return finding(
    "AW-PDF-XMP",
    "xmp_file_name",
    "warning",
    `The XMP metadata names the invoice attachment "${declared}" (DocumentFileName), but the XML is ` +
      `attached as "${actual}". A receiver that follows the metadata to the attachment looks for a file ` +
      `this PDF does not contain.`,
    "Make DocumentFileName and the attachment's name the same, and make it the standard one: factur-x.xml, " +
      "or xrechnung.xml for the XRECHNUNG profile.",
  );
}

// ---------------------------------------------------------------------------
// AW-PDF-XMP-PROFILE: the profile the metadata declares
// ---------------------------------------------------------------------------

/**
 * A ConformanceLevel the metadata schema does not define.
 *
 * A warning: Mustang reports an unknown level as an error, and a receiver
 * that routes on the level cannot tell which profile this is.
 */
export function xmpLevelUnknown(level: string, schema: FacturXXmpSchema | undefined): FacturXFinding {
  const known = levelsOf(schema);
  const defined = schema ? `the ${SCHEMA_NAME[schema]} metadata defines` : "Factur-X or ZUGFeRD defines";
  return finding(
    "AW-PDF-XMP-PROFILE",
    "xmp_level_unknown",
    "warning",
    `The XMP metadata declares the conformance level "${level}", which is not one ${defined} ` +
      `(${known.join(", ")}).${spellingHint(level, known)} Mustang rejects a level it does not know, and a ` +
      `receiver that routes on it cannot tell which profile this is.`,
    `Write the level of the profile the XML declares, spelled as the format spells it: ${known.join(", ")}.`,
  );
}

/**
 * The metadata declares one profile and BT-24 another.
 *
 * A warning: a receiver can take the profile from the metadata without
 * opening the XML, and then applies another profile's rules to this invoice.
 * Not fatal: which of the two a receiver believes is its own choice, and the
 * rules here judged the XML.
 */
export function xmpLevelMismatch(declared: string, expected: FacturXLevel, customizationId: string): FacturXFinding {
  return finding(
    "AW-PDF-XMP-PROFILE",
    "xmp_level_mismatch",
    "warning",
    `The XMP metadata declares the ${declared} profile (ConformanceLevel), but the XML declares ` +
      `${expected}: its BT-24 is "${customizationId.trim()}". A receiver that takes the profile from the ` +
      `metadata, which it can read without opening the XML, applies another profile's rules to this invoice.`,
    `Write ${expected} to the XMP ConformanceLevel. If ${declared} is the profile you meant, export the XML ` +
      `at that profile instead.`,
    "BT-24",
  );
}

// ---------------------------------------------------------------------------
// Which of them apply
// ---------------------------------------------------------------------------

const STANDARD_NAME = /^(factur-x|xrechnung|zugferd-invoice)\.xml$/i;

/**
 * The metadata's own findings: everything that can be said from the packet
 * and the attachment's name, without the XML. `extractFacturX` returns these.
 */
export function xmpFindings(xmp: FacturXXmp, attachment: string): FacturXFinding[] {
  const out: FacturXFinding[] = [];

  if (xmp.pdfaPart === undefined) out.push(xmpPdfaMissing(xmp.pdfaConformance));
  else if (xmp.pdfaPart !== "3") out.push(xmpPdfaPart(xmp.pdfaPart));
  else if (!["A", "B", "U"].includes(xmp.pdfaConformance ?? "")) out.push(xmpPdfaConformance(xmp.pdfaConformance));

  if (xmp.namespace === undefined) {
    out.push(xmpFacturXMissing(STANDARD_NAME.test(attachment) ? attachment : "factur-x.xml"));
    return out;
  }
  if (xmp.schema === undefined) out.push(xmpFacturXNamespace(xmp.namespace));
  const stated: Record<(typeof FACTURX_XMP_PROPERTIES)[number], string | undefined> = {
    DocumentType: xmp.documentType,
    DocumentFileName: xmp.documentFileName,
    Version: xmp.version,
    ConformanceLevel: xmp.conformanceLevel,
  };
  const missing = FACTURX_XMP_PROPERTIES.filter((name) => stated[name] === undefined);
  if (missing.length > 0) out.push(xmpFacturXIncomplete(missing, xmp.namespace));
  if (xmp.documentType !== undefined && xmp.documentType !== "INVOICE") out.push(xmpDocumentType(xmp.documentType));
  if (xmp.documentFileName !== undefined && xmp.documentFileName !== attachment) {
    out.push(xmpFileName(xmp.documentFileName, attachment));
  }
  if (xmp.conformanceLevel !== undefined && !levelsOf(xmp.schema).includes(xmp.conformanceLevel)) {
    out.push(xmpLevelUnknown(xmp.conformanceLevel, xmp.schema));
  }
  return out;
}

/**
 * The container findings that need the XML's BT-24: the profile the metadata
 * declares against the one the XML does, and an /AFRelationship of Data or
 * Source on a profile Germany asks Alternative for.
 *
 * `extractFacturX` cannot know BT-24 without parsing the XML, which is
 * `validate`'s job, and parsing it twice would double the cost of the most
 * expensive step on a large invoice. So `validate` calls this with the BT-24
 * it read; a caller holding `extractFacturX`'s result and a BT-24 of its own
 * can call it the same way. Nothing is reported when BT-24 declares no profile
 * this recognises (`facturXLevel`), or when the metadata's level is one
 * `xmpFindings` has already called unknown.
 */
export function facturXProfileFindings(
  container: Pick<FacturXExtraction, "attachmentName" | "relationship" | "xmp">,
  customizationId: string | undefined,
): FacturXFinding[] {
  const level = facturXLevel(customizationId);
  if (level === undefined || customizationId === undefined) return [];
  const out: FacturXFinding[] = [];
  const relationship = container.relationship;
  if ((relationship === "Data" || relationship === "Source") && ALTERNATIVE_IN_GERMANY.has(level)) {
    out.push(relationshipNotAlternative(container.attachmentName, relationship, level));
  }
  const declared = container.xmp?.conformanceLevel;
  if (declared !== undefined && levelsOf(container.xmp?.schema).includes(declared) && declared !== level) {
    out.push(xmpLevelMismatch(declared, level, customizationId));
  }
  return out;
}
