#!/usr/bin/env python3
"""Summarise the SVRL reports written by `scripts/peppol-check.sh`.

A schematron run that finds nothing looks exactly like a schematron run that
never fired, so this prints the fired-rule count next to the finding count.
Both numbers belong in the record: the first says the artefact was exercised,
the second says what it concluded.
"""
import glob
import os
import re
import sys
from xml.etree import ElementTree as ET

SVRL = "{http://purl.oclc.org/dsdl/svrl}"


def findings(path):
    tree = ET.parse(path)
    fired = sum(1 for _ in tree.iter(SVRL + "fired-rule"))
    out = []
    for tag in ("failed-assert", "successful-report"):
        for node in tree.iter(SVRL + tag):
            text = " ".join("".join(node.itertext()).split())
            rule = node.get("id")
            if not rule:
                m = re.match(r"\[([A-Z0-9\-]+)\]", text)
                rule = m.group(1) if m else "(no id)"
            out.append((tag, node.get("flag") or "-", rule, text))
    return fired, out


def main(outdir):
    total = 0
    for path in sorted(glob.glob(os.path.join(outdir, "*.svrl"))):
        fired, hits = findings(path)
        total += len(hits)
        name = os.path.basename(path)
        print(f"{name}: {fired} rules fired, {len(hits)} finding(s)")
        for tag, flag, rule, text in hits:
            print(f"    {tag} [{flag}] {rule}: {text[:120]}")
    print()
    print(f"total findings across all reports: {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "out"))
