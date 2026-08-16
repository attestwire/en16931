#!/usr/bin/env python3
"""Does the French Flux 1 CII schema accept a D16B-shaped document?

Factur-X 1.09.2 is CII D22B and is documented as backward compatible with D16B.
This package emits D16B. Whether that is true *of the French schemas* decides
how much work a `france-2026` capability is, so it is measured here rather than
taken on trust.

Compares, declaration by declaration and in document order:
  A) the UN/CEFACT CII D16B modules shipped in KoSIT's XRechnung configuration
  B) the CII D22B modules shipped in the DGFiP spécifications externes

Reading *through* the DGFiP comment markers, so the comparison is against
UN/CEFACT D22B and not against the French subset. Reports:

  - target namespaces on both sides (a mismatch would reject every document
    before any content model is consulted)
  - declarations present in one and not the other
  - complexTypes where the two disagree on the ORDER of the shared elements
  - cardinality differences

Usage:
  python3 scripts/dgfip-d16b-d22b-diff.py <d16b-xsd-dir> <d22b-xsd-dir>
"""
import glob
import os
import re
import sys

MODULES = [
    ("root", "CrossIndustryInvoice_100p"),
    ("RAM", "CrossIndustryInvoice_ReusableAggregateBusinessInformationEntity_100p"),
    ("QDT", "CrossIndustryInvoice_QualifiedDataType_100p"),
    ("UDT", "CrossIndustryInvoice_UnqualifiedDataType_100p"),
]


def find(directory, stem):
    hits = [p for p in glob.glob(directory + "/**/*.xsd", recursive=True)
            if os.path.basename(p).replace("F1FULL_", "").replace("F1BASE_", "").startswith(stem)]
    return hits[0] if hits else None


def read(path):
    return open(path, encoding="utf-8").read()


def declarations(text):
    """(complexType, normalised element declaration) in document order, reading
    through comments so removed declarations still count."""
    out = []
    for m in re.finditer(r'<xsd:complexType name="([^"]+)">(.*?)</xsd:complexType>', text, re.S):
        for d in re.findall(r'<xsd:element name="[^"]*"[^/>]*/?>', m.group(2)):
            out.append((m.group(1), re.sub(r"\s+", " ", d).strip()))
    return out


def names(text):
    return re.findall(r'<xsd:(?:element|complexType|simpleType) name="([^"]+)"', text)


def attr(decl, key, default):
    m = re.search(key + r'="([^"]+)"', decl)
    return m.group(1) if m else default


def main(d16dir, d22dir):
    print("== target namespaces")
    for tag, stem in MODULES:
        a, b = find(d16dir, stem), find(d22dir, stem)
        if not a or not b:
            print(f"  {tag}: MODULE NOT FOUND ({a} / {b})")
            continue
        na = re.search(r'targetNamespace="([^"]+)"', read(a)).group(1)
        nb = re.search(r'targetNamespace="([^"]+)"', read(b)).group(1)
        print(f"  {tag}: {'SAME' if na == nb else 'DIFFERENT'}  {na}")
        if na != nb:
            print(f"        D22B: {nb}")

    print()
    print("== declaration inventory (reading through DGFiP comment markers)")
    for tag, stem in MODULES:
        a, b = find(d16dir, stem), find(d22dir, stem)
        if not a or not b:
            continue
        sa, sb = names(read(a)), names(read(b))
        same = sa == sb
        print(f"  {tag}: D16B={len(sa)} D22B={len(sb)} identical ordered sequence: {same}")
        if not same:
            onlya = [x for x in sa if x not in set(sb)]
            onlyb = [x for x in sb if x not in set(sa)]
            print(f"        only in D16B: {onlya}")
            print(f"        only in D22B: {onlyb}")

    print()
    print("== element order and cardinality, RAM module")
    a = declarations(read(find(d16dir, MODULES[1][1])))
    b = declarations(read(find(d22dir, MODULES[1][1])))
    if [t for t, _ in a] != [t for t, _ in b] or len(a) != len(b):
        print("  the two modules do not line up declaration for declaration; "
              "order comparison skipped")
        return 1
    reordered = [t for (t, x), (_, y) in zip(a, b)
                 if attr(x, "name", "") != attr(y, "name", "")]
    print(f"  elements whose position differs: {len(reordered)}")
    diffs = [(t, x, y) for (t, x), (_, y) in zip(a, b) if x != y]
    print(f"  declarations differing at all: {len(diffs)} of {len(a)}")
    for t, x, y in diffs:
        n = attr(x, "name", "?")
        print(f"    {t}/{n}: D16B {attr(x,'minOccurs','1')}..{attr(x,'maxOccurs','1')}"
              f"  ->  DGFiP-D22B {attr(y,'minOccurs','1')}..{attr(y,'maxOccurs','1')}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
