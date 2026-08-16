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

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${1:-${TMPDIR:-/tmp}/attestwire-peppol}"

# Pinned artefact versions, the downloads and the schematron compilation live
# in one place now, shared with scripts/kosit-check.sh and with benchmark/ —
# see lib/validator-setup.sh. Same scratch directory, same artefacts, same
# pins as before this file was split.
. "$(dirname "${BASH_SOURCE[0]}")/lib/validator-setup.sh"

require_java || exit 127
require_cmd xmllint || exit 127

ensure_peppol "$WORK_DIR"
SCH_DIR="$(peppol_sch_dir "$WORK_DIR")"
cd "$WORK_DIR"

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
