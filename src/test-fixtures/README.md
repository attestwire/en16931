# Test fixtures — third-party schemas

Checked in so the export tests validate against the *published* artefacts rather
than against our reading of them. Neither file is shipped: `package.json`'s
`files` list publishes `dist`, `fixtures`, README, CHANGELOG and LICENSE, and
these live in `src/test-fixtures/`, are read only by `src/export.test.ts`, and
are never imported by anything under `dist`.

Both were retrieved on **2026-08-14**. Verify with `shasum -a 256`.

## `sarif-schema-2.1.0.json`

- Source: <https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/sarif-2.1/schema/sarif-schema-2.1.0.json>
- Retrieved: 2026-08-14
- sha256: `c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e`
- Bytes: 112,768
- Schema `id`: `https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json`
- Declares `"$schema": "http://json-schema.org/draft-04/schema#"` — the official
  OASIS copy is draft-04, not draft-07. It uses only keywords the two drafts
  share (`type`, `required` as an array, `properties`,
  `additionalProperties`, `items`, `enum`, `$ref`, `oneOf`, `anyOf`, `pattern`,
  `minimum`, `maximum`, `minItems`, `uniqueItems`, `format`), every `$ref` is
  local (`#/definitions/…`), and there is no `exclusiveMinimum`, no `$id` and no
  boolean schema — so the subset validator in `export.test.ts` covers it
  exactly rather than approximately.
- This is the **normative** SARIF 2.1.0 schema. `additionalProperties: false`
  holds at the root and on every object definition, which is what makes the
  test able to catch a misspelled property rather than merely a missing one.

## `junit-10.xsd`

- Source: <https://raw.githubusercontent.com/jenkinsci/xunit-plugin/master/src/main/resources/org/jenkinsci/plugins/xunit/types/model/xsd/junit-10.xsd>
- Retrieved: 2026-08-14
- sha256: `a1a816f58d1bf95ebabf371994df0b9246dee66ea9572fbec4f9296f1b2c0ff6`
- Bytes: 6,555
- Licence: MIT, © 2014 Gregory Boissinot — the licence text is inside the file
  and is left there verbatim.

**There is no official JUnit XML schema, and this file is not one.** JUnit
itself never specified the format; what every CI system consumes is the output
of Ant's `junitreport` task as extended by Maven Surefire. This XSD is the
Jenkins xUnit plugin's model of that, and it is the closest thing to a
de-facto authority — Jenkins is the consumer that most JUnit XML in the world
is written for. Passing it means "Jenkins' own parser model accepts this"; it
does not and cannot mean "conforms to the JUnit standard", because there is
none. The tests say the same thing, and check structure directly as well.

The Windy Road copy (`windyroad/JUnit-Schema`) is the other candidate. It was
not used: its bytes are not valid UTF-8 despite declaring
`encoding="UTF-8"` (the copyright sign in the header), so `xmllint` refuses to
load it, and a schema that cannot be loaded cannot validate anything.

`xmllint` is used opportunistically. The test that shells out to it skips when
`/usr/bin/xmllint` is absent, so the suite still runs on a machine without
libxml2 — but the well-formedness and structural assertions do not depend on
it, and they run everywhere.
