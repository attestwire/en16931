import type { CreditNoteOptions, InvoiceFacts, InvoiceInput } from "./types.js";

/**
 * A credit note built from the invoice it credits.
 *
 * Credit notes go wrong in three recurring ways: negative amounts on a
 * document whose type already says "credit", no reference to the invoice
 * being credited, and parties or references that drift from the original.
 * None of them needs EN 16931 knowledge to avoid if the credit note is
 * derived rather than typed, which is what this does.
 *
 * The result is an ordinary `InvoiceInput` with BT-3 = 381: the generators
 * turn it into a `ubl:CreditNote` or a CII document with `ram:TypeCode` 381,
 * exactly as they would a credit note written by hand. Nothing is validated
 * here; `validateInput` judges the result like any other input.
 */

/** BT-3 for a commercial credit note (UNTDID 1001). */
const CREDIT_NOTE = "381";

/** A deep copy of plain data, so the credit note shares no object with the original. */
const copy = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, copy(entry)]),
    ) as T;
  }
  return value;
};

/**
 * Build the credit note for an invoice, or for some of its lines.
 *
 * ```ts
 * const creditNote = createCreditNote(invoice, {
 *   invoiceNumber: "2026-G00021",
 *   issueDate: "2026-09-01",
 *   lines: ["2"],
 *   reason: "Line 2 was not delivered.",
 * });
 * ```
 *
 * What the credit note gets:
 *
 * - BT-3 `"381"`, the new number and issue date, and `reason` as its note
 *   (BT-22).
 * - A preceding invoice reference (BG-3) to the original: its number (BT-25)
 *   and issue date (BT-26).
 * - The original's profile, currency, parties (seller, buyer, payee, tax
 *   representative), payment instructions and payment terms, buyer and order
 *   references, delivery details, invoicing period, `vatScenario`, VAT
 *   exemption reasons and VAT accounting currency, all as deep copies.
 * - The credited lines, each exactly as on the original: same identifier,
 *   same positive quantity and price. A credit note states positive amounts;
 *   its type is what says the money goes back.
 *
 * What it does not get, because it belongs to the original's settlement
 * rather than to the supply: the due date (BT-9), the VAT point date (BT-7),
 * the paid amount (BT-113), the rounding amount (BT-114), declared totals,
 * supporting documents (BG-24), the original's own note and preceding
 * references. Two more are kept only when every line is credited: the
 * document level allowances and charges (BG-20, BG-21), because the share of
 * a discount that belongs to some of the lines is a commercial decision this
 * cannot make, and the VAT total in the accounting currency (BT-111), because
 * it depends on an exchange rate. For a partial credit, add them yourself;
 * `validateInput` reports BT-111 as missing (BR-53) when BT-6 is there.
 *
 * A project reference (BT-11) is kept, and a UBL credit note has no element
 * for it: `validateInput` warns (`ATW-CREDIT-NOTE-PROJECT-REFERENCE-UNBOUND`)
 * rather than this function dropping it unannounced.
 *
 * Accepts the facts form too (`vatScenario`, an inferred payment means code);
 * the credit note then states the same facts and becomes the same codes.
 * Pure: the original is not modified.
 *
 * @throws RangeError when `lines` is empty or names a line the original does
 * not have. Crediting fewer lines than intended because of a typo is the
 * mistake this refuses to make silently.
 */
export function createCreditNote(original: InvoiceInput, options: CreditNoteOptions): InvoiceInput;
export function createCreditNote(original: InvoiceFacts, options: CreditNoteOptions): InvoiceFacts;
export function createCreditNote(
  original: InvoiceInput | InvoiceFacts,
  options: CreditNoteOptions,
): InvoiceInput | InvoiceFacts {
  const {
    invoiceNumber,
    issueDate,
    invoiceTypeCode: _type,
    note: _note,
    noteSubjectCode: _noteSubject,
    dueDate: _dueDate,
    taxPointDate: _taxPoint,
    paidAmount: _paid,
    roundingAmount: _rounding,
    declaredTotals: _declared,
    precedingInvoices: _preceding,
    supportingDocuments: _supporting,
    lines,
    allowances,
    charges,
    taxAmountInAccountingCurrency,
    ...kept
  } = original;

  const originalLines: readonly (typeof lines)[number][] = Array.isArray(lines) ? lines : [];
  let credited = originalLines;
  if (options.lines !== undefined) {
    const wanted = new Set(options.lines);
    if (wanted.size === 0) {
      throw new RangeError(
        `createCreditNote: options.lines is empty, so the credit note for invoice ${invoiceNumber} would have no lines (BR-16). Leave it out to credit every line.`,
      );
    }
    const known = new Set(originalLines.map((line) => line?.id));
    const unknown = [...wanted].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new RangeError(
        `createCreditNote: invoice ${invoiceNumber} has no line ${unknown.map((id) => JSON.stringify(id)).join(", ")}. Its lines are ${[...known].map((id) => JSON.stringify(id)).join(", ")}.`,
      );
    }
    credited = originalLines.filter((line) => wanted.has(line?.id));
  }
  const everyLine = credited.length === originalLines.length;

  const creditNote: Record<string, unknown> = {
    ...copy(kept),
    invoiceNumber: options.invoiceNumber,
    issueDate: options.issueDate,
    invoiceTypeCode: CREDIT_NOTE,
    precedingInvoices: [
      issueDate === undefined ? { invoiceNumber } : { invoiceNumber, issueDate },
    ],
    lines: copy(credited),
  };
  if (options.reason !== undefined) creditNote.note = options.reason;
  if (everyLine) {
    if (allowances !== undefined) creditNote.allowances = copy(allowances);
    if (charges !== undefined) creditNote.charges = copy(charges);
    if (taxAmountInAccountingCurrency !== undefined) {
      creditNote.taxAmountInAccountingCurrency = taxAmountInAccountingCurrency;
    }
  }
  return creditNote as unknown as InvoiceInput | InvoiceFacts;
}
