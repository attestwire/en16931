import { LIMITS_DOCS } from "./rule-kit.js";
import { MAX_MONETARY_AMOUNT } from "./totals.js";
import type { RuleFn } from "./rule-kit.js";
import type { BusinessTerm, InvoiceInput, TeachingError } from "./types.js";

/**
 * ATW-* findings for input the generators cannot write faithfully.
 *
 * A fuzz run on 2026-09-23 found inputs that `validateInput` passed and the
 * generators then mangled or refused: text that was nothing but a NUL or a
 * lone surrogate (stripped on output, leaving a mandatory field empty), a NaN
 * allowance percentage or a gross price of 1e21 (a bare RangeError from
 * `generateCii`), and a VAT rate of 1e308 (a BigInt RangeError from
 * `computeTotals`). The contract is that anything `validateInput` passes can be
 * generated, so these are findings here instead of surprises there.
 *
 * Values the regulation's own rules already judge are left to them: a NaN
 * quantity, price or rate is BR-22 / BR-24 / BR-S-05, and an amount past the
 * monetary ceiling is ATW-AMOUNT-OUT-OF-RANGE.
 */

/** What an XML 1.0 document cannot carry, and what the generators strip. */
const NOT_XML =
  /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Numbers the generators format but no other rule checks for finiteness, or
 * whose magnitude can reach 1e21, where `toFixed` switches to exponent
 * notation and `xs:decimal` has no exponent form.
 */
const FORMATTED_NUMBERS = new Set(["percentage", "baseAmount", "grossUnitPrice", "priceDiscount", "baseQuantity", "quantity"]);
const EXPONENT_LIMIT = 1e21;
/** No VAT regime charges more than the price itself. */
const MAX_VAT_RATE = 100;

/**
 * Fields the model types as numbers, and as text, by key. A JavaScript or JSON
 * caller can still pass null, "5" or 5 in the wrong place; a second fuzz run
 * (2026-09-23) found those passing validation and then crashing a generator or
 * breaking the round trip. Each is one ATW-INPUT-TYPE finding, naming the path.
 */
const NUMBER_KEYS = new Set([
  "quantity", "unitPrice", "grossUnitPrice", "priceDiscount", "baseQuantity", "vatRate", "rate",
  "amount", "baseAmount", "percentage", "paidAmount", "roundingAmount", "taxAmountInAccountingCurrency",
  "lineExtensionAmount", "taxExclusiveAmount", "taxInclusiveAmount", "payableAmount",
  "allowanceTotalAmount", "chargeTotalAmount", "taxAmount", "taxableAmount",
]);
const STRING_KEYS = new Set([
  "invoiceNumber", "issueDate", "currency", "invoiceTypeCode", "dueDate", "note", "noteSubjectCode",
  "buyerReference", "orderReference", "salesOrderReference", "projectReference", "contractReference",
  "despatchAdviceReference", "receivingAdviceReference", "tenderOrLotReference", "buyerAccountingReference",
  "taxPointDate", "paymentTerms", "deliveryDate", "vatAccountingCurrency", "startDate", "endDate",
  "descriptionCode", "name", "vatId", "taxRegistrationId", "legalRegistrationId", "legalRegistrationSchemeId",
  "additionalLegalInformation", "tradingName", "legalName", "schemeId", "value", "email", "phone",
  "line1", "line2", "line3", "city", "postalCode", "countrySubdivision", "countryCode", "id", "description",
  "longDescription", "unitCode", "sellerItemId", "buyerItemId", "orderLineReference", "originCountryCode",
  "meansCode", "meansName", "iban", "accountName", "bic", "remittanceInformation", "reason", "reasonCode",
  "category", "vatCategory", "exemptionReason", "exemptionReasonCode", "mimeCode", "filename", "externalUri",
  "reference", "content", "code", "text",
  // Missing until 2026-09-23 (review): an object in any of these passed
  // validation and then made the generator throw.
  "deliverToName", "schemeVersion", "mandateReference", "creditorIdentifier", "debitedAccount",
  "holderName", "primaryAccountNumber",
  // declaredTotals.syntax ("ubl" | "cii"): set by the readers, but a caller
  // can set it too, and it switches on the stated-breakdown checks.
  "syntax",
]);
/** Arrays whose entries must be objects. */
const OBJECT_ARRAYS = new Set([
  "lines", "allowances", "charges", "supportingDocuments", "precedingInvoices", "itemAttributes",
  "itemClassifications", "subtotals",
]);
/** Maps whose values must be text. */
const STRING_MAPS = new Set(["vatExemptionReasons", "vatExemptionReasonCodes"]);
/** Reader-internal bookkeeping in declaredTotals, not caller input. */
const SKIPPED_DECLARED = new Set(["defects", "overPrecise"]);

const PROFILES = new Set(["en16931", "xrechnung-ubl", "xrechnung-cii", "facturx-en16931", "peppol-bis-3"]);

const kindOf = (v: unknown) =>
  v === null
    ? "null"
    : Array.isArray(v)
      ? "an array"
      : typeof v === "string"
        ? `the text ${JSON.stringify(v).slice(0, 40)}`
        : `${/^[aeiou]/.test(typeof v) ? "an" : "a"} ${typeof v}`;

/** The business group or term a path lies in, for `field`. */
const ROOT_TERMS: Record<string, BusinessTerm> = {
  invoiceNumber: "BT-1",
  issueDate: "BT-2",
  invoiceTypeCode: "BT-3",
  currency: "BT-5",
  dueDate: "BT-9",
  buyerReference: "BT-10",
  projectReference: "BT-11",
  contractReference: "BT-12",
  orderReference: "BT-13",
  salesOrderReference: "BT-14",
  paymentTerms: "BT-20",
  note: "BT-22",
  seller: "BG-4",
  buyer: "BG-7",
  payee: "BG-10",
  taxRepresentative: "BG-11",
  invoicingPeriod: "BG-14",
  payment: "BG-16",
  allowances: "BG-20",
  charges: "BG-21",
  supportingDocuments: "BG-24",
  lines: "BG-25",
  precedingInvoices: "BG-3",
};

function termOf(path: (string | number)[]): BusinessTerm | BusinessTerm[] {
  const [root, , key] = path;
  if (root === "lines" && key === "allowances") return "BG-27";
  if (root === "lines" && key === "charges") return "BG-28";
  return ROOT_TERMS[String(root)] ?? [];
}

const show = (path: (string | number)[]) =>
  path.map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? p : `.${p}`)).join("");

function finding(
  path: (string | number)[],
  rule: string,
  severity: TeachingError["severity"],
  message: string,
  fix: string,
): TeachingError {
  return { rule, field: termOf(path), severity, message, fix, docsUrl: LIMITS_DOCS };
}

function wrongType(path: (string | number)[], expected: string, value: unknown): TeachingError {
  return finding(
    path,
    "ATW-INPUT-TYPE",
    "fatal",
    `${show(path)} should be ${expected}, but it is ${kindOf(value)}. The rules and the generators rely on the InvoiceInput types.`,
    `Set ${show(path)} to ${expected}, or leave it out. A value parsed from JSON or a form is the usual cause: "19" where 19 is expected, or null for a field that is simply absent.`,
  );
}

function walk(value: unknown, path: (string | number)[], out: TeachingError[], seen: Set<object>): void {
  const key = path[path.length - 1];
  const parent = path[path.length - 2];
  const inDeclared = path[0] === "declaredTotals";
  if (value === undefined) return;
  if (typeof key === "string") {
    if (NUMBER_KEYS.has(key) && typeof value !== "number") {
      out.push(wrongType(path, "a number", value));
      return;
    }
    // legalRegistrationId is text on a party and { value, schemeId } on the
    // payee (BT-61), the one key the model types two ways.
    const payeeShape =
      path[0] === "payee" && key === "legalRegistrationId" && value !== null && typeof value === "object" && !Array.isArray(value);
    if (STRING_KEYS.has(key) && typeof value !== "string" && !payeeShape) {
      out.push(wrongType(path, "text", value));
      return;
    }
    if (OBJECT_ARRAYS.has(key) && !Array.isArray(value)) {
      out.push(wrongType(path, "a list", value));
      return;
    }
  }
  if (typeof key === "number" && typeof parent === "string" && OBJECT_ARRAYS.has(parent) &&
      (value === null || typeof value !== "object" || Array.isArray(value))) {
    out.push(wrongType(path, "an object", value));
    return;
  }
  if (typeof parent === "string" && STRING_MAPS.has(parent) && typeof value !== "string") {
    out.push(wrongType(path, "text", value));
    return;
  }
  const declaredFigure =
    inDeclared &&
    typeof value === "number" &&
    ((typeof key === "string" && key !== "rate" && key !== "taxTotalsInInvoiceCurrency") ||
      (typeof key === "number" && parent === "lineNetAmounts"));
  if (declaredFigure) {
    // Stated figures: the declared-totals rules report a non-finite top-level
    // total by name; everything else, and any figure past the monetary
    // ceiling, is reported here, because the comparisons cannot compute it.
    const topLevel = path.length === 2;
    if (!Number.isFinite(value) && !topLevel) {
      out.push(finding(path, "ATW-NUMBER-NOT-FINITE", "fatal", `${show(path)} is ${value}, which no document can state.`, "Check the arithmetic that produced it."));
    } else if (Number.isFinite(value) && Math.abs(value) > MAX_MONETARY_AMOUNT) {
      out.push(finding(path, "ATW-NUMBER-TOO-LARGE", "fatal", `${show(path)} is ${value}, beyond the ${MAX_MONETARY_AMOUNT} this library computes exactly.`, "Check the unit: a figure this size is almost always a slip upstream."));
    }
    return;
  }
  if (inDeclared && key === "rate" && typeof value === "number" && !Number.isFinite(value)) {
    out.push(finding(path, "ATW-NUMBER-NOT-FINITE", "fatal", `${show(path)} is ${value}, which no document can state.`, "Check the arithmetic that produced it."));
    return;
  }
  if (typeof value === "string") {
    const bad = value.match(NOT_XML);
    if (!bad) return;
    const left = value.replace(NOT_XML, "").trim();
    const codes = [...new Set(bad)].map((c) => `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
    out.push(
      finding(
        path,
        "ATW-TEXT-NOT-XML",
        left === "" ? "fatal" : "warning",
        `${show(path)} contains ${codes.join(", ")}, which an XML document cannot carry. The generators remove ` +
          (left === ""
            ? "them, and nothing is left: the field would be written empty."
            : "them, so the document would say something slightly different from your input."),
        "Remove control characters and unpaired surrogates from the text before building the invoice. They usually come from a copy-paste or a broken encoding upstream.",
      ),
    );
    return;
  }
  if (typeof value === "number") {
    const key = path[path.length - 1];
    if ((key === "vatRate" || key === "rate") && Number.isFinite(value) && Math.abs(value) > MAX_VAT_RATE) {
      out.push(
        finding(
          path,
          "ATW-VAT-RATE-OUT-OF-RANGE",
          "fatal",
          `${show(path)} is ${value}%. No VAT regime charges more than the price itself, and a rate this size cannot be computed exactly.`,
          "Set the rate as a percentage: 19 for 19%, not 0.19 or 1900.",
        ),
      );
    } else if (typeof key === "string" && FORMATTED_NUMBERS.has(key)) {
      if (!Number.isFinite(value)) {
        out.push(
          finding(
            path,
            "ATW-NUMBER-NOT-FINITE",
            "fatal",
            `${show(path)} is ${value}. The XML type behind it, xs:decimal, has no NaN or infinity, so the document cannot be written.`,
            "Check the arithmetic that produced it: a division by zero, or a sum over a missing value, is the usual cause.",
          ),
        );
      } else if (Math.abs(value) >= EXPONENT_LIMIT) {
        out.push(
          finding(
            path,
            "ATW-NUMBER-TOO-LARGE",
            "fatal",
            `${show(path)} is ${value}, at or above 1e21, which cannot be written as an xs:decimal without exponent notation.`,
            "Check the unit: a value this size is almost always a slip upstream.",
          ),
        );
      }
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, [...path, i], out, seen));
    return;
  }
  for (const [k, item] of Object.entries(value)) {
    if (path.length === 1 && path[0] === "declaredTotals" && SKIPPED_DECLARED.has(k)) continue;
    walk(item, [...path, k], out, seen);
  }
}

export const representableRules: RuleFn[] = [
  (inv: InvoiceInput) => {
    const out: TeachingError[] = [];
    walk(inv, [], out, new Set());
    // An unknown profile validated clean and was then refused by the
    // generator (fuzz run, 2026-09-23).
    const profile = (inv as { profile?: unknown }).profile;
    if (typeof profile !== "string" || !PROFILES.has(profile)) {
      out.push({
        rule: "ATW-PROFILE-UNKNOWN",
        field: "BT-24",
        severity: "fatal",
        message: `profile is ${kindOf(profile)}, which is not a profile this library knows. It decides which rule set applies and which document the generators write.`,
        fix: `Set profile to one of ${[...PROFILES].join(", ")}.`,
        docsUrl: LIMITS_DOCS,
      });
    }
    return out;
  },
];
