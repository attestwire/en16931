#!/usr/bin/env bash
# Validate the committed fixtures against the OFFICIAL French Flux 1 schemas
# published by the DGFiP in the "spécifications externes B2B" package.
#
# An external review claimed all eleven committed fixtures fail these schemas.
# They do. This script reproduces that and, more usefully, says *why* for each
# one — the three candidate causes (a defective document, a D16B/D22B version
# mismatch, a profile our fixtures never targeted) call for very different
# amounts of work, and only one of them is a bug.
#
# Everything is downloaded into a scratch directory; nothing is installed
# system-wide.
#
# Usage:  ./scripts/dgfip-check.sh [output-dir]
#
# Requires libxml2's xmllint and python3.
set -euo pipefail

DGFIP_VERSION="v3.2"                 # spécifications externes, published 2026-04-30
DGFIP_URL="https://www.impots.gouv.fr/sites/default/files/media/1_metier/2_professionnel/EV/2_gestion/290_facturation_electronique/specification_externes_b2b/specifications-externes-${DGFIP_VERSION}.zip"

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${1:-${TMPDIR:-/tmp}/attestwire-dgfip}"

command -v xmllint >/dev/null || { echo "error: xmllint not found" >&2; exit 127; }
command -v python3 >/dev/null || { echo "error: python3 not found" >&2; exit 127; }

mkdir -p "$WORK_DIR"/out
cd "$WORK_DIR"

if [ ! -d "dgfip/3- XSD_${DGFIP_VERSION}" ]; then
  echo "→ downloading DGFiP spécifications externes ${DGFIP_VERSION}"
  curl -fsSL -A "Mozilla/5.0" -o "specifications-externes-${DGFIP_VERSION}.zip" "$DGFIP_URL"
  mkdir -p dgfip
  unzip -q -o "specifications-externes-${DGFIP_VERSION}.zip" -d dgfip
fi

X="dgfip/3- XSD_${DGFIP_VERSION}/2 - E-invoicing"
F="$PKG_DIR/fixtures"

schema_for() {
  # $1 = fixture basename, $2 = Base|Full
  case "$1:$2" in
    xrechnung-cii-*:Base) echo "$X/F1_BASE_CII_D22B/uncefact/data/standard/F1BASE_CrossIndustryInvoice_100pD22B.xsd" ;;
    xrechnung-cii-*:Full) echo "$X/F1_FULL_CII_D22B/uncefact/data/standard/F1FULL_CrossIndustryInvoice_100pD22B.xsd" ;;
    *credit-note*:Base)   echo "$X/F1_BASE_UBL_2.1/F1BASE_UBL-CreditNote-2.1.xsd" ;;
    *credit-note*:Full)   echo "$X/F1_FULL_UBL_2.1/F1FULL_UBL_CreditNote-2.1.xsd" ;;
    *:Base)               echo "$X/F1_BASE_UBL_2.1/F1BASE_UBL-invoice-2.1.xsd" ;;
    *:Full)               echo "$X/F1_FULL_UBL_2.1/F1FULL_UBL_invoice-2.1.xsd" ;;
  esac
}

schemadir_for() {
  case "$1:$2" in
    xrechnung-cii-*:Base) echo "$X/F1_BASE_CII_D22B" ;;
    xrechnung-cii-*:Full) echo "$X/F1_FULL_CII_D22B" ;;
    *:Base)               echo "$X/F1_BASE_UBL_2.1" ;;
    *:Full)               echo "$X/F1_FULL_UBL_2.1" ;;
  esac
}

echo
echo "=== xmllint verdict (first error per sequence only) ==============="
for f in "$F"/*.xml; do
  b="$(basename "$f" .xml)"
  for profile in Base Full; do
    xsd="$(schema_for "$b" "$profile")"
    if xmllint --noout --schema "$xsd" "$f" >"out/${b}__${profile}.xmllint.txt" 2>&1; then
      echo "  $b  $profile  PASS"
    else
      first=$(grep -m1 'Schemas validity error' "out/${b}__${profile}.xmllint.txt" \
        | grep -o "}[A-Za-z]*'" | head -1 | tr -d "}'")
      echo "  $b  $profile  FAIL  first unexpected element: ${first:-?}"
    fi
  done
done

echo
echo "=== complete disallowed-element inventory, classified ============="
for f in "$F"/*.xml; do
  b="$(basename "$f" .xml)"
  for profile in Base Full; do
    echo "--- $b  $profile"
    python3 "$PKG_DIR/scripts/dgfip-profile-diff.py" "$(schemadir_for "$b" "$profile")" "$f" \
      | tee "out/${b}__${profile}.profile.txt" | tail -1
  done
done

echo
echo "=== is the French CII schema a D22B that refuses D16B? ============"
# The KoSIT XRechnung configuration carries UN/CEFACT's own D16B modules, which
# is what this package emits against. Reuse them as the D16B side of the diff.
KOSIT_ZIP="xrechnung-3.0.2-validator-configuration-2026-01-31.zip"
if [ ! -d "kosit/resources/cii/16b/xsd" ]; then
  echo "→ downloading KoSIT XRechnung 3.0.2 configuration (for its D16B modules)"
  curl -fsSL -o "$KOSIT_ZIP" \
    "https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/download/v2026-01-31/${KOSIT_ZIP}"
  unzip -q -o "$KOSIT_ZIP" -d kosit
fi
python3 "$PKG_DIR/scripts/dgfip-d16b-d22b-diff.py" \
  "kosit/resources/cii/16b/xsd" "$X/F1_FULL_CII_D22B" | tee out/d16b-vs-d22b.txt

echo
echo "Full per-fixture inventories are in $WORK_DIR/out/*.profile.txt"
