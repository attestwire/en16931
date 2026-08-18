# Security

## Reporting

Email **hello@attestwire.com**. The maintainer reads these directly.

Include what you found, how to reproduce it, and the version you were on. A
document that triggers it is ideal — attach it, or paste the smallest snippet
that still does the job.

Please don't open a public issue for a security report.

There's no bug bounty. If you'd like credit, say so and you'll be named in the
CHANGELOG entry for the release that fixes it.

## What counts as a security issue here

This library parses XML that arrives from someone else, which is where the real
attack surface is:

- External entity resolution, DTD processing, or anything else that makes the
  parser read a local file or open a network connection.
- Entity expansion or any input that turns a small document into unbounded
  memory or CPU: billion laughs and its relatives.
- A document that gets past the size, depth, element or attribute caps and still
  exhausts memory, or one where a cap can be bypassed.
- A crash on malformed input that isn't one of the named `ParseError` or
  `PdfError` types.
- Anything in the Factur-X PDF reader that escapes the container: the
  cross-reference walker, the object-stream reader, or the DEFLATE
  implementation.
- Any path where this package makes a network call. It shouldn't make any.

## What doesn't

**A wrong verdict is a bug, not a vulnerability.** A rule that fires when it
shouldn't, a rule that stays quiet when it should fire, a document this engine
accepts and KoSIT rejects — these are important, and they get fixed fast, but
report them as issues so the discussion is public and other people can find it.

The exception is when the wrong verdict is reachable as an exploit: input
crafted so a document validates clean *because* of a parsing flaw rather than a
rule flaw. That's a security report. If you're unsure which side of the line
you're on, email it.

Handing your own process a deliberately enormous document and watching it fall
over isn't a vulnerability in this library. You chose to accept that document.
The caps are adjustable per call, and raising them is your decision.
