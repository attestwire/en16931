#!/usr/bin/env python3
"""Complete inventory of the elements a fixture uses that a DGFiP Flux 1 schema
does not allow, and why.

`xmllint --schema` stops at the first unexpected element in a sequence, so it
can tell you a document fails and not how far it is from the profile. This
walks the document against the schema's own type graph and reports every
element the schema refuses, classified:

  COMMENTED-OUT  the declaration is present in the DGFiP file but inside an XML
                 comment — UBL 2.1 / CII D22B has the element and the DGFiP
                 removed it for Flux 1. A profile restriction.
  ABSENT         the syntax itself never declared it. A document defect, or a
                 genuine version mismatch.

The distinction is the whole point: it is what separates "our document is
wrong" from "our document is a different profile". The schema is read with
comments preserved so the two cases are separable at all.

Usage:
  python3 scripts/dgfip-profile-diff.py <schema-dir> <fixture.xml>
"""
import glob
import re
import sys
from xml.etree import ElementTree as ET

XS = "{http://www.w3.org/2001/XMLSchema}"


def parse_with_comments(path):
    return ET.parse(path, ET.XMLParser(target=ET.TreeBuilder(insert_comments=True)))


def local(qname):
    return qname.split(":")[-1] if qname else qname


def collect(paths):
    """active[type] -> child names; commented[type] -> child names removed;
    eltype[(type, child)] -> child's type name."""
    active, commented, eltype = {}, {}, {}
    for path in paths:
        root = parse_with_comments(path).getroot()
        for ct in root.iter(XS + "complexType"):
            name = ct.get("name")
            if not name:
                continue
            for group in list(ct):
                if group.tag not in (XS + "sequence", XS + "choice", XS + "all"):
                    continue
                for child in list(group):
                    if child.tag is ET.Comment:
                        commented.setdefault(name, []).extend(
                            local(n) for n in
                            re.findall(r'<xsd:element (?:name|ref)="([^"]+)"', child.text or "")
                        )
                    elif child.tag == XS + "element":
                        n = local(child.get("name") or child.get("ref"))
                        active.setdefault(name, []).append(n)
                        if child.get("name") and child.get("type"):
                            eltype.setdefault((name, n), local(child.get("type")))
        for el in root.findall(XS + "element"):
            if el.get("name") and el.get("type"):
                eltype.setdefault((None, el.get("name")), local(el.get("type")))
    return active, commented, eltype


def walk(node, tname, active, commented, eltype, path, out):
    if tname not in active:
        return  # a datatype (udt:/qdt:/cbc:) — its content is not a profile question
    allowed = set(active[tname])
    removed = set(commented.get(tname, []))
    for child in node:
        n = child.tag.split("}")[-1]
        p = f"{path}/{n}"
        if n not in allowed:
            out.append((p, "COMMENTED-OUT" if n in removed else "ABSENT"))
            continue  # do not descend: children of a refused element are moot
        walk(child, eltype.get((tname, n)) or eltype.get((None, n)),
             active, commented, eltype, p, out)


def main(schemadir, fixture):
    paths = [p for p in glob.glob(schemadir + "/**/*.xsd", recursive=True)
             if "codelist" not in p and "identifierlist" not in p]
    active, commented, eltype = collect(paths)
    doc = ET.parse(fixture)
    root = doc.getroot().tag.split("}")[-1]
    roottype = None
    for path in paths:
        for el in parse_with_comments(path).getroot().findall(XS + "element"):
            if el.get("name") == root:
                roottype = local(el.get("type"))
    if roottype is None:
        print(f"  root element {root} is not declared in this schema")
        return 1
    out, seen, uniq = [], set(), []
    walk(doc.getroot(), roottype, active, commented, eltype, root, out)
    for p, status in out:
        if (p, status) in seen:
            continue
        seen.add((p, status))
        uniq.append((p, status))
    for p, status in uniq:
        print(f"  {status:14s} {p}")
    n_com = sum(1 for _, s in uniq if s == "COMMENTED-OUT")
    n_abs = sum(1 for _, s in uniq if s == "ABSENT")
    print(f"  -> {len(uniq)} distinct disallowed paths "
          f"({n_com} commented-out, {n_abs} absent)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
