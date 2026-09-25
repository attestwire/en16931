export * from "./types.js";
export { runInputRules, inputRules } from "./rules.js";
export {
  generateXRechnungUBL,
  CUSTOMIZATION_IDS,
  PROFILE_IDS,
  DEFAULT_INVOICE_TYPE_CODE,
  INVOICED_OBJECT_DOCUMENT_TYPE_CODE,
  UBL_GENERATABLE_PROFILES,
  CREDIT_NOTE_TYPE_CODES,
  documentKindOf,
  isCreditNote,
  type DocumentKind,
  GenerationError,
  UnsupportedProfileError,
  UnsupportedDocumentTypeError,
  type GenerateOptions,
  type UblGeneratableProfile,
} from "./generate.js";
export {
  generateCii,
  CII_GENERATABLE_PROFILES,
  CII_NAMESPACES,
  SUPPORTING_DOCUMENT_TYPE_CODE,
  TENDER_OR_LOT_DOCUMENT_TYPE_CODE,
  UnsupportedCiiProfileError,
  toCiiDate,
  type CiiGeneratableProfile,
} from "./generate-cii.js";
export {
  parseUbl,
  parseUblInvoice,
  UnsupportedSyntaxError,
  UnsupportedCreditNoteError,
  type ParsedInvoice,
  type ParseUblOptions,
  type UnmappedElement,
} from "./parse.js";
export {
  parseCiiInvoice,
  UnsupportedCiiSyntaxError,
  fromCiiDate,
  type ParseCiiOptions,
} from "./parse-cii.js";
/**
 * Reading the Factur-X / ZUGFeRD PDF container — new in 0.7.0.
 *
 * Extraction only. The container is read; it is still never built. See the
 * module doc-comment in `facturx-pdf.ts` for why that asymmetry is deliberate.
 */
export {
  extractFacturX,
  DEFAULT_PDF_LIMITS,
  PdfError,
  PdfParseError,
  PdfSecurityError,
  PdfUnsupportedFilterError,
  FacturXNotFoundError,
  FacturXEncodingError,
  type PdfLimits,
  type FacturXExtraction,
} from "./facturx-pdf.js";

/**
 * One call for an existing file — new in 0.10.0.
 *
 * XML (UBL or CII, any declared encoding) or a Factur-X / ZUGFeRD PDF in, the
 * same findings as `validateInput` out, each with the line and column of the
 * element in the caller's file. Never throws for anything about the document.
 */
export {
  validate,
  type ValidateOptions,
  type DocumentValidation,
  type DocumentFinding,
} from "./validate.js";

/**
 * Findings → SARIF 2.1.0 and JUnit XML, for CI pipelines — new in 0.7.0.
 *
 * Both are pure functions over the findings `validateInput` already returns;
 * neither reads the clock or the filesystem.
 */
export {
  toSarif,
  toJunitXml,
  type ExportProvenance,
  type JunitOptions,
  type Findings,
} from "./export.js";

export {
  parseXml,
  attr,
  firstChild,
  childrenNamed,
  ParseError,
  XmlSyntaxError,
  XmlSecurityError,
  DEFAULT_XML_LIMITS,
  type XmlLimits,
  type XmlElement,
  type XmlAttribute,
} from "./xml-parse.js";
export {
  MAX_MONETARY_AMOUNT,
  AmountRangeError,
  computeTotals,
  lineNetAmount,
  round2,
  formatAmount,
  effectiveRate,
  effectiveAllowanceChargeRate,
  DEFAULT_EXEMPTION_REASONS,
} from "./totals.js";

export {
  minimalXRechnung,
  reverseChargeXRechnung,
  discountedXRechnung,
  minimalXRechnungCii,
  reverseChargeXRechnungCii,
  discountedXRechnungCii,
  extendedXRechnungCii,
  creditNoteXRechnung,
  creditNoteDiscountXRechnung,
  creditNoteXRechnungCii,
  creditNoteDiscountXRechnungCii,
} from "./fixtures.js";

/**
 * The EN 16931 code lists the BR-CL-* rules enforce, as frozen arrays and
 * membership sets — useful for building a unit picker or a currency dropdown
 * that cannot offer a value the validator will then reject.
 *
 * Each list lives in its own side-effect-free module under `src/codelists/`, so
 * a bundler drops the ones you do not reference — which matters mainly for
 * `UNIT_CODES`, whose 2,162 entries are most of the package's data weight.
 */
export * from "./codelists/index.js";

import { runInputRules } from "./rules.js";
import type { InvoiceInput, Profile, ValidationResult } from "./types.js";

/**
 * Validate an invoice object (the `InvoiceInput` model) against EN 16931 / CIUS
 * business rules. To check an existing file — UBL, CII, or a Factur-X /
 * ZUGFeRD PDF — use `validate()`, which reads it and runs these same rules,
 * with each finding's line in the file.
 *
 * Returns every finding, not just the first, each as a `TeachingError`: a
 * teaching error is only useful if you can see the whole set of things wrong
 * with the document at once. It does
 * not throw for anything about the input: a value that is not an invoice object
 * at all (`undefined`, XML text, a file's bytes) is one fatal `ATW-INPUT-TYPE`
 * finding that says which function wanted it.
 *
 * Findings are split three ways, matching the three flags KoSIT's schematron
 * uses. `information` is deliberately *not* folded into `warnings`: a caller
 * whose build fails on a non-empty `warnings` array should not be stopped by a
 * finding the official validator raises and then accepts.
 */
export function validateInput(inv: InvoiceInput): ValidationResult {
  const findings = runInputRules(inv);
  return {
    valid: findings.every((e) => e.severity !== "fatal"),
    // Read defensively: a JavaScript caller can pass anything, and the
    // finding for a non-object is more use than a TypeError here.
    profile: (inv as Partial<InvoiceInput> | null | undefined)?.profile as Profile,
    errors: findings.filter((e) => e.severity === "fatal"),
    warnings: findings.filter((e) => e.severity === "warning"),
    information: findings.filter((e) => e.severity === "information"),
  };
}
