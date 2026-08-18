# Contributing

Pull requests are welcome. One thing to know first: this repository works
differently from most, and it's better you hear it now than after you've done
the work.

## How development flows

This repository is a **flattened export** of one package from a private
monorepo. Development happens upstream; the export is published here at release
tags. So `main` is the canonical published source at each release, the exact
code that ships to npm as `@attestwire/en16931`. It is not a working branch.

The practical consequence: **there are no direct merges into this repository.**
Your pull request will not get a merge commit here, and its branch will not
appear in the history. That is not a rejection.

## What happens to your pull request

1. The maintainer reads it here, on GitHub, like any other PR.
2. If it's accepted, the change is applied in the private monorepo with you
   credited by name in the CHANGELOG entry.
3. It lands in the next release export, and the PR is closed with a pointer to
   the release that carries it.

Open a PR the normal way. Discussion, review comments and back-and-forth all
happen in the PR thread. The only difference from a typical open-source repo is
the shape of the history at the end.

## What to contribute

The most useful thing you can send is a failing XML snippet plus the rule ID you
expected. E-invoicing bugs are almost always specific: one element, one binding,
one rule that fired when it shouldn't have or stayed quiet when it should have
spoken. A report that names the document, the rule and the expected verdict
turns a fix into an afternoon.

Even better: a runnable fixture. Test fixtures live in [`fixtures/`](fixtures),
and the test files sit beside the source in `src/*.test.ts`. Drop a document
into a test that asserts the verdict you expect, watch it fail, and open the PR
with the failing test in it. Fixing that is nearly automatic.

**Rule-coverage gaps.** A rule from a CIUS or a national extension that this
engine doesn't implement yet. Say which rule set, which rule IDs, and, if you
can, where a sample document lives. There's an issue form for this.

**Wrong verdicts.** Anything where this engine disagrees with KoSIT, the CEN
schematrons or a Peppol access point. Both directions matter: a false positive
that blocks a good invoice, and a false negative that lets a bad one through.
Name the official validator and what it said.

Documentation fixes count too. A wrong XPath, a stale example, an error message
whose `fix` text sends you somewhere unhelpful. The teaching errors are the
product, so a message that teaches the wrong thing is a real bug.

## Running the tests

Node 18 or newer.

```bash
npm install
npm test          # vitest run — the whole suite
npm run build     # tsc, into dist/
```

To run one file while you iterate:

```bash
npx vitest run src/rules-de.test.ts
```

There are no runtime dependencies to install, and nothing in the test suite
makes a network call.

Two extra scripts check the committed fixtures against the official validators.
They need a JDK and they download the validator on first run, so they're not
part of `npm test`:

```bash
npm run kosit     # KoSIT validator, XRechnung configuration
npm run peppol    # Peppol BIS Billing 3.0
```

There's a third, `npm run dgfip`, which checks the fixtures against the DGFiP's
published French schemas. It wants `xmllint` and `python3` instead of a JDK.

If your change touches generation, run `npm run kosit` before opening the PR.
If it touches only rules or parsing, `npm test` is enough.

## Coding notes

- Zero runtime dependencies is a hard constraint. If a change needs a package at
  runtime, it needs a different design.
- The same build has to run in Node, Deno, Bun, Cloudflare Workers and the
  browser, so nothing platform-specific.
- Every rule ID in the source must be either fired by `src/rules-invariants.test.ts`
  or listed there with the reason no input can reach it. A new rule with neither
  fails the suite.
- Amounts round half-up at two decimals, per line, and sums are taken over the
  rounded values. `round2` exists because both obvious JavaScript approaches are
  wrong for tax.

## Questions

[GitHub Discussions](https://github.com/attestwire/en16931/discussions) for
anything you'd like other users to see: which rule sets you need, how to model
a document, whether something is a bug. Email hello@attestwire.com if it's
better off private.

Security issues go to hello@attestwire.com, not to an issue. See
[SECURITY.md](SECURITY.md).

## Licence

MIT. By contributing, you agree your contribution ships under it.
