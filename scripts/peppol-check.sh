#!/usr/bin/env bash
# Validate this library's `peppol-bis-3` output against the OFFICIAL OpenPeppol
# BIS Billing 3.0 validation artefacts.
#
# `scripts/kosit-check.sh` covers the XRechnung path with the German
# regulator's own tool. This is the same idea for Peppol: the package has
# advertised a `peppol-bis-3` profile since 0.3.0 and, until this script, it had
# never been put to OpenPeppol's schematrons. Everything is downloaded into a
# scratch directory; nothing is installed system-wide.
#
# Usage:  ./scripts/peppol-check.sh [output-dir]
#
# Requires Java 11+ and libxml2's xmllint. If `java` is not on PATH, set
# JAVA_BIN, e.g.
#   JAVA_BIN=/opt/homebrew/opt/openjdk@17/bin/java ./scripts/peppol-check.sh
set -euo pipefail

# --- pinned artefact versions ------------------------------------------------
PEPPOL_TAG="v3.0.20"                 # OpenPEPPOL/peppol-bis-invoice-3, 2025 November release
UBL_ZIP="UBL-2.1.zip"                # OASIS UBL 2.1 OS, docs.oasis-open.org
SAXON_VERSION="12.5"                 # net.sf.saxon:Saxon-HE, Maven Central
XMLRESOLVER_VERSION="5.2.2"          # Saxon 12 runtime dependency
SCHEMATRON_REF="77dcd36c53d12ed786c144ece3b2af7694abdc56"  # Schematron/schematron

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${1:-${TMPDIR:-/tmp}/attestwire-peppol}"
JAVA_BIN="${JAVA_BIN:-java}"

if ! "$JAVA_BIN" -version >/dev/null 2>&1; then
  echo "error: no Java runtime found." >&2
  echo "       Install a JDK 11+ and re-run, or point JAVA_BIN at one:" >&2
  echo "       JAVA_BIN=/path/to/bin/java $0" >&2
  exit 127
fi
command -v xmllint >/dev/null || { echo "error: xmllint not found" >&2; exit 127; }

mkdir -p "$WORK_DIR"/{lib,iso,xslt,in,out}
cd "$WORK_DIR"

# --- 1. official Peppol BIS Billing 3.0 schematrons --------------------------
SCH_DIR="peppol-bis-invoice-3-${PEPPOL_TAG#v}/rules/sch"
if [ ! -d "$SCH_DIR" ]; then
  echo "→ downloading OpenPEPPOL peppol-bis-invoice-3 ${PEPPOL_TAG}"
  curl -fsSL -o "peppol-${PEPPOL_TAG}.tar.gz" \
    "https://github.com/OpenPEPPOL/peppol-bis-invoice-3/archive/refs/tags/${PEPPOL_TAG}.tar.gz"
  tar xzf "peppol-${PEPPOL_TAG}.tar.gz"
fi

# --- 2. official OASIS UBL 2.1 XML Schema ------------------------------------
if [ ! -f "ubl/xsd/maindoc/UBL-Invoice-2.1.xsd" ]; then
  echo "→ downloading OASIS UBL 2.1 OS schemas"
  curl -fsSL -o "$UBL_ZIP" "https://docs.oasis-open.org/ubl/os-UBL-2.1/UBL-2.1.zip"
  unzip -q -o "$UBL_ZIP" -d ubl
fi

# --- 3. Saxon-HE, to run the XSLT2 the schematrons compile to ----------------
if [ ! -f "lib/Saxon-HE-${SAXON_VERSION}.jar" ]; then
  echo "→ downloading Saxon-HE ${SAXON_VERSION}"
  curl -fsSL -o "lib/Saxon-HE-${SAXON_VERSION}.jar" \
    "https://repo1.maven.org/maven2/net/sf/saxon/Saxon-HE/${SAXON_VERSION}/Saxon-HE-${SAXON_VERSION}.jar"
  for a in "xmlresolver-${XMLRESOLVER_VERSION}.jar" "xmlresolver-${XMLRESOLVER_VERSION}-data.jar"; do
    curl -fsSL -o "lib/$a" \
      "https://repo1.maven.org/maven2/org/xmlresolver/xmlresolver/${XMLRESOLVER_VERSION}/$a"
  done
fi

# --- 4. ISO Schematron reference implementation ------------------------------
# OpenPEPPOL ships .sch, not compiled XSLT, so the compiler is ours and its
# version is part of the record.
if [ ! -f "iso/iso_svrl_for_xslt2.xsl" ]; then
  echo "→ downloading ISO Schematron skeleton (${SCHEMATRON_REF:0:7})"
  for f in iso_dsdl_include.xsl iso_abstract_expand.xsl iso_svrl_for_xslt2.xsl \
           iso_schematron_skeleton_for_saxon.xsl; do
    curl -fsSL -o "iso/$f" \
      "https://raw.githubusercontent.com/Schematron/schematron/${SCHEMATRON_REF}/trunk/schematron/code/$f"
  done
fi

saxon() { "$JAVA_BIN" -cp "lib/*" net.sf.saxon.Transform "$@"; }

for s in CEN-EN16931-UBL PEPPOL-EN16931-UBL CEN-EN16931-CII PEPPOL-EN16931-CII; do
  if [ ! -f "xslt/$s.xsl" ]; then
    echo "→ compiling $s.sch"
    saxon -s:"$SCH_DIR/$s.sch"   -xsl:iso/iso_dsdl_include.xsl    -o:"xslt/$s.step1.sch"
    saxon -s:"xslt/$s.step1.sch" -xsl:iso/iso_abstract_expand.xsl -o:"xslt/$s.step2.sch"
    saxon -s:"xslt/$s.step2.sch" -xsl:iso/iso_svrl_for_xslt2.xsl  -o:"xslt/$s.xsl" allow-foreign=true
  fi
done

# --- 5. generate the peppol-bis-3 documents and judge them -------------------
rm -f in/*.xml out/*.svrl
node "$PKG_DIR/scripts/emit-peppol-fixtures.mjs" in
echo
echo "→ validating $(ls in | wc -l | tr -d ' ') document(s)"
echo

for f in in/*.xml; do
  b="$(basename "$f" .xml)"
  # Syntax comes from the filename, and the two syntaxes are judged by
  # different artefacts. Running the UBL schematron over a CII document does
  # not fail loudly — it matches no context, fires zero rules and reports
  # nothing, which reads exactly like a clean pass. Routing is the guard.
  case "$b" in
    peppol-cii-*)
      # No XSD leg. The OpenPEPPOL package ships no schemas at all (the UBL
      # ones above come from OASIS), and UN/CEFACT does not publish the D16B
      # CrossIndustryInvoice XSD from a stable URL this script could pin. The
      # CII documents are therefore schematron-checked only here; their XSD
      # validity is covered by `scripts/kosit-check.sh`, which runs the
      # regulator's own tool over the same generator's output.
      xsd_verdict="n/a"
      xsd="(none — see comment)"
      saxon -s:"$f" -xsl:xslt/CEN-EN16931-CII.xsl    -o:"out/$b.cen.svrl"
      saxon -s:"$f" -xsl:xslt/PEPPOL-EN16931-CII.xsl -o:"out/$b.peppol.svrl"
      ;;
    *)
      case "$b" in
        *credit-note*) xsd="ubl/xsd/maindoc/UBL-CreditNote-2.1.xsd" ;;
        *)             xsd="ubl/xsd/maindoc/UBL-Invoice-2.1.xsd" ;;
      esac
      if xmllint --noout --schema "$xsd" "$f" >"out/$b.xsd.txt" 2>&1; then
        xsd_verdict="pass"
      else
        xsd_verdict="FAIL"
      fi
      xsd="$(basename "$xsd")"
      saxon -s:"$f" -xsl:xslt/CEN-EN16931-UBL.xsl    -o:"out/$b.cen.svrl"
      saxon -s:"$f" -xsl:xslt/PEPPOL-EN16931-UBL.xsl -o:"out/$b.peppol.svrl"
      ;;
  esac
  echo "$b  xsd=$xsd_verdict  $xsd"
done

echo
python3 "$PKG_DIR/scripts/svrl-report.py" out
