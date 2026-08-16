# Factur-X sample PDFs

Real files from the standard's own publisher, used by `src/facturx-pdf.test.ts`
to prove `extractFacturX` works on documents this package did not produce. A
hand-built PDF can only test the parser against the author's understanding of
the format; these test it against what a conformant producer actually emits.

All three come from **one** official package, retrieved on **2026-08-14**:

- **Package:** FeRD ZUGFeRD 2.5.2 German example package —
  `ZUGFeRD_2.5.2_DE_examples.zip` (11,966,326 bytes; contents dated 2026-07)
- **URL:** <https://www.ferd-net.de/fileadmin/user_upload/FeRD/Downloads/ZUGFeRD_2.5.2_DE_examples.zip>
- **Linked from:** <https://www.ferd-net.de/faqs/zugferd-beispielrechnungen>

| File | Path inside the zip | Profile | Cross-reference style | sha256 |
| --- | --- | --- | --- | --- |
| `facturx-en16931-einfach.pdf` | `3. EN16931/E05_Einfach/E05_01_Einfach_fx.pdf` | EN16931 (`urn:cen.eu:en16931:2017`) | **xref stream** + `/ObjStm` | `a0978983423b7261cea82ed4bea1e7b3062c87521692be83ad52ed27caeb6612` |
| `facturx-basic-einfach.pdf` | `2. BASIC/B01_Einfach/B01_01_Einfach_fx.pdf` | BASIC (`urn:factur-x.eu:1p0:basic`) | **xref stream** + `/ObjStm` | `3272dd58f4f55f8b5970fe6661c5afcc93398971ee3032559086aa91feb474e7` |
| `facturx-minimum-rechnung.pdf` | `0. MINIMUM/MINIMUM_Rechnung/MINIMUM_Rechnung_fx.pdf` | MINIMUM (`urn:factur-x.eu:1p0:minimum`) | **classic xref table** | `4d331416500719b338d8f969c8a414c396adce37e21273efdbf59c6a41920712` |

All three attach the XML as `factur-x.xml`. Verify with `shasum -a 256 *.pdf`.

Both cross-reference styles are represented on purpose — they are two different
code paths in `facturx-pdf.ts`, and a fixture set that exercised only one would
leave the other tested by nothing but its author's imagination. In the two
xref-stream files the file specification and the name tree live *inside* a
compressed `/ObjStm`, so `strings … | grep factur-x.xml` finds nothing; the
attachment name is only recoverable after inflating the object stream. That is
precisely the case that makes a real fixture worth having.

## Why FeRD and not FNFE-MPE

Factur-X and ZUGFeRD are the same standard published by two bodies — FNFE-MPE
in France, FeRD in Germany — and the attachment these files carry is named
`factur-x.xml`, the Factur-X name, in every one.

The French example package was **not** obtainable. `fnfe-mpe.org/factur-x/` and
the pages below it (`/factur-x_en/`, `/implementer-factur-x/`,
`/factur-x-et-zugferd/`, `/ressources/`) link no example archive at all: the
public downloads there are CII schemas, schematron packs, XP Z12 annexes and an
`.xlsm` template, and the example package appears to be behind the members'
area. No URL was guessed and nothing was retrieved from an unofficial mirror,
so the French half of the standard is represented here only in that these German
files carry the Factur-X profile identifiers and the Factur-X attachment name.
If an FNFE package becomes reachable, adding one here is a strict improvement.
