import { validateInput } from "./index.js";
import type { InvoiceInput, InvoiceLine, TeachingError } from "./types.js";

/**
 * Shared fixtures for the rule-family test files. Excluded from `dist` by
 * tsconfig, so nothing here ships.
 *
 * `clean` is deliberately stricter than the `base` fixture in rules.test.ts:
 * it carries a delivery date, so a well-formed invoice produces *no* findings
 * at all — neither errors nor warnings. That matters, because most of what the
 * new families assert is silence on good input, and a fixture that always
 * emits one warning makes "no new warnings" impossible to state.
 */

export const cleanLine = (overrides: Partial<InvoiceLine> = {}): InvoiceLine => ({
  id: "1",
  description: "Senior engineering consultancy",
  quantity: 10,
  unitCode: "HUR",
  unitPrice: 150,
  vatCategory: "S",
  vatRate: 19,
  ...overrides,
});

export const clean: InvoiceInput = {
  profile: "xrechnung-ubl",
  invoiceNumber: "2026-000142",
  issueDate: "2026-08-09",
  currency: "EUR",
  buyerReference: "04011000-1234512345-06",
  deliveryDate: "2026-08-05",
  seller: {
    name: "Acme GmbH",
    vatId: "DE123456789",
    address: { city: "Berlin", postalCode: "10115", countryCode: "DE" },
    electronicAddress: { schemeId: "9930", value: "DE123456789" },
    contact: {
      name: "Buchhaltung",
      phone: "+49 30 1234567",
      email: "rechnungen@acme.example",
    },
  },
  buyer: {
    name: "Kunde GmbH",
    vatId: "DE987654321",
    address: { city: "München", postalCode: "80331", countryCode: "DE" },
    electronicAddress: { schemeId: "9930", value: "DE987654321" },
  },
  payment: {
    meansCode: "58",
    iban: "DE02120300000000202051",
    accountName: "Acme GmbH",
  },
  lines: [cleanLine()],
};

/** `clean`, with the given top-level fields replaced. */
export const withInvoice = (overrides: Partial<InvoiceInput>): InvoiceInput => ({
  ...clean,
  ...overrides,
});

/** `clean`, with its single line replaced by one carrying `overrides`. */
export const withLine = (overrides: Partial<InvoiceLine>): InvoiceInput =>
  withInvoice({ lines: [cleanLine(overrides)] });

/** Every finding (fatal and warning), in emission order. */
export const findings = (inv: InvoiceInput): TeachingError[] => {
  const result = validateInput(inv);
  return [...result.errors, ...result.warnings];
};

/** Rule ids of the fatal findings only. */
export const errorIds = (inv: InvoiceInput): string[] =>
  validateInput(inv).errors.map((e) => e.rule);

/** Rule ids of the warnings only. */
export const warningIds = (inv: InvoiceInput): string[] =>
  validateInput(inv).warnings.map((e) => e.rule);

/** Rule ids of every finding. */
export const allIds = (inv: InvoiceInput): string[] =>
  findings(inv).map((e) => e.rule);

/** The first finding carrying `rule`, or undefined. */
export const findingFor = (
  inv: InvoiceInput,
  rule: string,
): TeachingError | undefined => findings(inv).find((e) => e.rule === rule);
