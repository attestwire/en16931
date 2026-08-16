#!/usr/bin/env python3
"""Summarise the reports an official validator writes.

Two report shapes, one reader:

  * SVRL — what `scripts/peppol-check.sh` gets out of the compiled OpenPEPPOL
    and CEN schematrons (`*.svrl`).
  * VARL — what the KoSIT validator writes (`*-report.xml`): its own report
    envelope, with one `rep:message` per finding carrying the rule ID in
    `@code`, plus a per-step verdict (XSD, then each schematron).

A schematron run that finds nothing looks exactly like a schematron run that
never fired, so this prints the fired-rule count next to the finding count.
Both numbers belong in the record: the first says the artefact was exercised,
the second says what it concluded. VARL reports do not carry a fired-rule
count; they carry per-step `valid` flags instead, which answer the same
question ("did the artefact actually run?") and are reported in their place.

Usage:
    svrl-report.py [dir] [--json]

`--json` prints one machine-readable object instead of the text summary, and is
what `benchmark/` consumes — the benchmark does not re-implement this parsing.
"""
import glob
import json
import os
import re
import sys
from xml.etree import ElementTree as ET

SVRL = "{http://purl.oclc.org/dsdl/svrl}"
VARL = "{http://www.xoev.de/de/validator/varl/1}"


def svrl_findings(tree):
    """Findings from an ISO Schematron SVRL report."""
    fired = sum(1 for _ in tree.iter(SVRL + "fired-rule"))
    out = []
    for tag in ("failed-assert", "successful-report"):
        for node in tree.iter(SVRL + tag):
            text = " ".join("".join(node.itertext()).split())
            rule = node.get("id")
            if not rule:
                m = re.match(r"\[([A-Z0-9\-]+)\]", text)
                rule = m.group(1) if m else "(no id)"
            out.append(
                {
                    "tag": tag,
                    "flag": node.get("flag") or "-",
                    "rule": rule,
                    "xpath": node.get("location"),
                    "text": text,
                }
            )
    return fired, out


def varl_findings(tree):
    """Findings from a KoSIT validator report.

    The rule ID is `@code` when the validator supplies one; when it does not
    (an XSD failure, say) the leading `[BR-...]` of the message is tried, and
    the step ID is the last resort. A finding with no ID at all is still
    emitted — dropping it would understate the official verdict, which is the
    one direction this tool must never err in.
    """
    out = []
    steps = []
    for step in tree.iter(VARL + "validationStepResult"):
        steps.append(
            {"id": step.get("id"), "valid": step.get("valid") == "true"}
        )
        for node in step.iter(VARL + "message"):
            text = " ".join("".join(node.itertext()).split())
            rule = node.get("code")
            if not rule:
                m = re.match(r"\[([A-Za-z0-9\-]+)\]", text)
                rule = m.group(1) if m else (step.get("id") or "(no id)")
            out.append(
                {
                    "tag": "failed-assert",
                    "flag": node.get("level") or "-",
                    "rule": rule,
                    "xpath": node.get("xpathLocation"),
                    "text": text,
                }
            )
    return steps, out


def read(path):
    """One report file → a uniform record. Never raises on a bad file."""
    rec = {
        "file": os.path.basename(path),
        "kind": None,
        "fired": None,
        "valid": None,
        "steps": [],
        "findings": [],
        "error": None,
    }
    try:
        tree = ET.parse(path)
    except ET.ParseError as e:
        # A report we cannot read is a fact about the run, not a pass.
        rec["error"] = f"unparsable report: {e}"
        return rec
    root = tree.getroot()
    if root.tag == VARL + "report":
        rec["kind"] = "varl"
        rec["valid"] = root.get("valid") == "true"
        rec["steps"], rec["findings"] = varl_findings(tree)
    else:
        rec["kind"] = "svrl"
        rec["fired"], rec["findings"] = svrl_findings(tree)
        rec["valid"] = not any(f["tag"] == "failed-assert" for f in rec["findings"])
    return rec


def reports(outdir):
    paths = sorted(
        glob.glob(os.path.join(outdir, "*.svrl"))
        + glob.glob(os.path.join(outdir, "*report.xml"))
    )
    return [read(p) for p in paths]


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    as_json = "--json" in argv
    outdir = args[0] if args else "out"
    recs = reports(outdir)

    if as_json:
        json.dump(
            {"dir": os.path.abspath(outdir), "reports": recs,
             "total": sum(len(r["findings"]) for r in recs)},
            sys.stdout,
        )
        sys.stdout.write("\n")
        return 0

    total = 0
    for r in recs:
        total += len(r["findings"])
        if r["error"]:
            print(f"{r['file']}: ERROR {r['error']}")
            continue
        if r["kind"] == "svrl":
            head = f"{r['fired']} rules fired"
        else:
            head = f"{len(r['steps'])} step(s), valid={r['valid']}"
        print(f"{r['file']}: {head}, {len(r['findings'])} finding(s)")
        for f in r["findings"]:
            print(f"    {f['tag']} [{f['flag']}] {f['rule']}: {f['text'][:120]}")
    print()
    print(f"total findings across all reports: {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
