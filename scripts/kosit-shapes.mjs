// Writes the document shapes the 0.14.0 build can newly produce, as XRechnung
// UBL and CII, for a one-off run through the official KoSIT validator.
// Usage: node scripts/kosit-shapes.mjs "$PWD/dist/index.js" <out dir>   (from packages/en16931; see kosit-check.md)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [engineEntry, out] = process.argv.slice(2);
const en = await import(engineEntry);
mkdirSync(out, { recursive: true });

const seller = {
  name: "Acme GmbH",
  vatId: "DE123456789",
  address: { line1: "Chausseestr. 1", city: "Berlin", postalCode: "10115", countryCode: "DE" },
  electronicAddress: { schemeId: "EM", value: "rechnungen@acme.example" },
  contact: { name: "Buchhaltung", phone: "+49 30 1234567", email: "rechnungen@acme.example" },
};
const frBuyer = {
  name: "Client SARL",
  vatId: "FR12345678901",
  address: { line1: "1 rue de la République", city: "Lyon", postalCode: "69001", countryCode: "FR" },
  electronicAddress: { schemeId: "EM", value: "factures@client.example" },
};
const chBuyer = {
  name: "Kunde AG",
  address: { line1: "Bahnhofstrasse 1", city: "Zürich", postalCode: "8001", countryCode: "CH" },
  electronicAddress: { schemeId: "EM", value: "kreditoren@kunde.example" },
};
const deBuyer = {
  name: "Stadt Bonn",
  address: { line1: "Berliner Platz 2", city: "Bonn", postalCode: "53111", countryCode: "DE" },
  electronicAddress: { schemeId: "0204", value: "04011000-1234512345-06" },
};
const base = {
  profile: "xrechnung-ubl",
  issueDate: "2026-09-01",
  currency: "EUR",
  buyerReference: "PO-4711",
  deliveryDate: "2026-08-31",
  seller,
  payment: { iban: "DE02120300000000202051", accountName: "Acme GmbH" }, // means code inferred
};

const shapes = {
  "k-intra-eu-goods": {
    ...base, invoiceNumber: "2026-K-001", buyer: frBuyer,
    deliverTo: { line1: "1 rue de la République", city: "Lyon", postalCode: "69001", countryCode: "FR" },
    lines: [
      { id: "1", description: "Widgets", quantity: 20, unitCode: "H87", unitPrice: 12.5, vatScenario: "intra-eu-goods" },
      { id: "2", description: "Gadgets", quantity: 5, unitCode: "H87", unitPrice: 40, vatScenario: "intra-eu-goods" },
    ],
  },
  "ae-intra-eu-services": {
    ...base, invoiceNumber: "2026-AE-001", buyer: frBuyer,
    lines: [{ id: "1", description: "Consulting, August 2026", quantity: 10, unitCode: "HUR", unitPrice: 150, vatScenario: "intra-eu-services" }],
  },
  "g-export": {
    ...base, invoiceNumber: "2026-G-001", buyer: chBuyer,
    lines: [{ id: "1", description: "Machine part", quantity: 2, unitCode: "H87", unitPrice: 800, vatScenario: "export" }],
  },
  "e-small-business-de": {
    ...base, invoiceNumber: "2026-E-001", buyer: deBuyer, buyerReference: "04011000-1234512345-06",
    seller: { ...seller, vatId: undefined, taxRegistrationId: "201/123/45678", identifier: { value: "ACME-001" } },
    vatScenario: "small-business-exemption",
    lines: [{ id: "1", description: "Gartenpflege", quantity: 8, unitCode: "HUR", unitPrice: 45 }],
  },
  "pm30-non-sepa-iban": {
    ...base, invoiceNumber: "2026-P30-001", buyer: deBuyer, buyerReference: "04011000-1234512345-06",
    payment: { iban: "TR330006100519786457841326", accountName: "Acme GmbH" },
    lines: [{ id: "1", description: "Consulting", quantity: 1, unitCode: "HUR", unitPrice: 100, vatScenario: "domestic", vatRate: 19 }],
  },
  "pm59-direct-debit": {
    ...base, invoiceNumber: "2026-P59-001", buyer: deBuyer, buyerReference: "04011000-1234512345-06",
    payment: { directDebit: { mandateReference: "MANDATE-001", creditorIdentifier: "DE98ZZZ09999999999", debitedAccount: "DE02120300000000202051" } },
    lines: [{ id: "1", description: "Abonnement September", quantity: 1, unitCode: "MON", unitPrice: 29, vatScenario: "domestic", vatRate: 19 }],
  },
};

// Credit notes built from the originals, full and partial.
const expand = (inv) => en.applyDefaults(inv).invoice;
shapes["cn-from-k"] = en.createCreditNote(expand(shapes["k-intra-eu-goods"]), { invoiceNumber: "2026-K-CN-001", issueDate: "2026-09-10", reason: "Rücksendung" });
shapes["cn-from-ae"] = en.createCreditNote(expand(shapes["ae-intra-eu-services"]), { invoiceNumber: "2026-AE-CN-001", issueDate: "2026-09-10" });
shapes["cn-partial-k"] = en.createCreditNote(expand(shapes["k-intra-eu-goods"]), { invoiceNumber: "2026-K-CN-002", issueDate: "2026-09-11", lines: ["2"], reason: "Teilgutschrift Position 2" });

let written = 0;
for (const [name, inv] of Object.entries(shapes)) {
  const v = en.validateInput(inv);
  if (!v.valid) {
    console.log(`SKIP ${name}: ${v.errors.map((e) => `${e.rule} ${e.message.slice(0, 90)}`).join(" | ")}`);
    continue;
  }
  writeFileSync(join(out, `${name}-ubl.xml`), en.generateXRechnungUBL({ ...inv, profile: "xrechnung-ubl" }));
  writeFileSync(join(out, `${name}-cii.xml`), en.generateCii({ ...inv, profile: "xrechnung-cii" }));
  written += 2;
  console.log(`ok   ${name} (${v.warnings.length} warnings, ${v.information.length} information)`);
}
console.log(`${written} documents written to ${out}`);
