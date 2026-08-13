/**
 * What kind of document BT-3 asks for.
 *
 * EN 16931 has one semantic model and two document types on top of it. Which
 * one you are looking at is decided by a single business term — BT-3, the
 * document type code from UNTDID 1001 — and the two syntaxes disagree about
 * what that means structurally:
 *
 *   - **UBL** splits the type code across two elements on two different root
 *     elements. `cbc:InvoiceTypeCode` lives on `ubl:Invoice`; a credit note is
 *     a separate `ubl:CreditNote` document, in its own namespace, carrying
 *     `cbc:CreditNoteTypeCode` and `cac:CreditNoteLine` /
 *     `cbc:CreditedQuantity`. Putting `381` on an `ubl:Invoice` is not a credit
 *     note — it is a document the EN 16931 schematron rejects under BR-CL-01,
 *     because the invoice half of UNTDID 1001 does not contain `381`.
 *   - **CII** has no such split. One root element, `rsm:CrossIndustryInvoice`,
 *     one type-code element, `ram:TypeCode`, and BR-CL-01 admits the *union* of
 *     the two code lists there (verified against
 *     `EN16931-CII-validation.xsl` @ validation-1.3.15, which tests membership
 *     of a single 62-code literal).
 *
 * So the caller sets one field and this module decides what that means. There
 * is no `documentType` discriminant in the input model on purpose: BT-3 already
 * *is* the discriminant, the regulation says so, and a second field would let a
 * caller state `{ documentType: "invoice", invoiceTypeCode: "381" }` — a
 * contradiction the model should not be able to express.
 *
 * Nothing here is a code list. `INVOICE_TYPE_CODES` and
 * `CREDIT_NOTE_TYPE_CODES_CL` in `codelists/invoice-type.ts` are generated from
 * the schematron and are what BR-CL-01 tests; this module only routes.
 */

import {
  CREDIT_NOTE_TYPE_CODES_CL,
  INVOICE_TYPE_CODES_SET,
} from "./codelists/invoice-type.js";

/** Default BT-3 document type code: 380 = commercial invoice (UNTDID 1001). */
export const DEFAULT_INVOICE_TYPE_CODE = "380";

/** The two document types EN 16931 defines over one semantic model. */
export type DocumentKind = "invoice" | "credit-note";

/**
 * BT-3 values that make the document a credit note rather than an invoice.
 *
 * Derived, not typed out: it is every code on the credit-note half of BR-CL-01
 * that is **not** also on the invoice half. That exclusion is the whole subtlety
 * of UNTDID 1001 in EN 16931 — the two lists overlap. `81` ("Credit note related
 * to goods or services") appears on *both*, so a document carrying it is
 * ambiguous, and this build resolves the ambiguity towards an invoice: `81` on
 * an `ubl:Invoice` passes BR-CL-01, so routing it to a `CreditNote` would change
 * the document a caller has been getting since 0.1.0 for no gain. State `381`
 * if you mean a credit note; that is what everyone else means by one.
 *
 * ⚠ **The meaning of this set changed in 0.5.0.** Until 0.4.0 it held six
 * hand-picked codes and was the set generation *refused*. It is now the set that
 * selects the credit-note binding, and it is derived from the code list rather
 * than curated, so it also covers `83`, `420`, `458`, `502`, `503` and `532` —
 * codes that used to produce an `ubl:Invoice` that BR-CL-01 rejected.
 */
export const CREDIT_NOTE_TYPE_CODES: ReadonlySet<string> = new Set(
  CREDIT_NOTE_TYPE_CODES_CL.filter((code) => !INVOICE_TYPE_CODES_SET.has(code)),
);

/** BT-3 as the document states it: trimmed, with the default applied. */
export const resolveTypeCode = (invoiceTypeCode: string | undefined): string =>
  (invoiceTypeCode ?? DEFAULT_INVOICE_TYPE_CODE).trim();

/** Which document type a BT-3 code asks for. */
export const documentKindOf = (invoiceTypeCode: string | undefined): DocumentKind =>
  CREDIT_NOTE_TYPE_CODES.has(resolveTypeCode(invoiceTypeCode))
    ? "credit-note"
    : "invoice";

/**
 * True when this input describes a credit note.
 *
 * ```ts
 * isCreditNote({ invoiceTypeCode: "381" }); // true
 * isCreditNote({});                          // false — defaults to 380
 * ```
 *
 * Exported because a caller branching on the document type should not have to
 * re-derive the code list: `generateXRechnungUBL` emits a `ubl:CreditNote` for
 * exactly the inputs this returns `true` for.
 */
export const isCreditNote = (input: { invoiceTypeCode?: string }): boolean =>
  documentKindOf(input?.invoiceTypeCode) === "credit-note";

/**
 * "credit note" / "invoice", for a message that has to name the document it is
 * talking about. Findings read badly when they say "invoice" at a caller who
 * asked for a credit note, and every rule message in this package is meant to
 * be readable by someone who has never opened the standard.
 */
export const documentNoun = (input: { invoiceTypeCode?: string }): string =>
  isCreditNote(input) ? "credit note" : "invoice";

/**
 * Root element path prefix for a `TeachingError.xpath`, per document type.
 *
 * `/ubl:Invoice` and `/ubl:CreditNote` are different documents, and an XPath
 * that names the wrong root resolves to nothing in the file the reader is
 * looking at.
 */
export const xpathRoot = (input: { invoiceTypeCode?: string }): string =>
  isCreditNote(input) ? "/ubl:CreditNote" : "/ubl:Invoice";
