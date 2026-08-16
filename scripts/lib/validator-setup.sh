#!/usr/bin/env bash
# Shared setup for every script that runs an OFFICIAL validator.
#
# WHY THIS FILE EXISTS. `kosit-check.sh` and `peppol-check.sh` each grew their
# own copy of "download the jar, unzip the configuration, compile the
# schematrons". `benchmark/` needs the same three things a third time, and a
# third copy would mean three different pinned versions the day one of them is
# bumped — which is the failure mode where a benchmark and a check script
# quietly disagree about what "the official validator" means.
#
# So the versions and the downloads live here, once, and the callers source
# this file. The scratch directories are UNCHANGED from what those two scripts
# used before (${TMPDIR}/attestwire-kosit and ${TMPDIR}/attestwire-peppol), so
# an existing warm cache stays warm and nothing is installed system-wide.
#
# Usage:
#   . "$(dirname "$0")/lib/validator-setup.sh"
#   require_java
#   ensure_kosit  "$WORK_DIR"        # jar + XRechnung configuration
#   ensure_peppol "$WORK_DIR"        # schematrons, UBL XSD, Saxon, compiled XSLT
#
# Everything is idempotent: each step is skipped if its artefact is already on
# disk, so a second run is offline.

# --- pinned artefact versions ------------------------------------------------
# One place. Bump here and every caller moves together.
KOSIT_VALIDATOR_VERSION="${KOSIT_VALIDATOR_VERSION:-1.6.2}"
KOSIT_CONFIG_VERSION="${KOSIT_CONFIG_VERSION:-2026-01-31}"
KOSIT_CONFIG_XR_VERSION="${KOSIT_CONFIG_XR_VERSION:-3.0.2}"

PEPPOL_TAG="${PEPPOL_TAG:-v3.0.20}"          # OpenPEPPOL/peppol-bis-invoice-3
UBL_ZIP="${UBL_ZIP:-UBL-2.1.zip}"            # OASIS UBL 2.1 OS
SAXON_VERSION="${SAXON_VERSION:-12.5}"       # net.sf.saxon:Saxon-HE
XMLRESOLVER_VERSION="${XMLRESOLVER_VERSION:-5.2.2}"
SCHEMATRON_REF="${SCHEMATRON_REF:-77dcd36c53d12ed786c144ece3b2af7694abdc56}"

JAVA_BIN="${JAVA_BIN:-java}"

# Emit the pinned versions as JSON, so a benchmark run can record exactly which
# artefacts produced its numbers. A verdict without a version is an anecdote.
validator_versions_json() {
  cat <<JSON
{
  "kositValidator": "${KOSIT_VALIDATOR_VERSION}",
  "kositConfig": "${KOSIT_CONFIG_VERSION}",
  "kositConfigXRechnung": "${KOSIT_CONFIG_XR_VERSION}",
  "peppolBis": "${PEPPOL_TAG}",
  "saxon": "${SAXON_VERSION}",
  "schematronSkeleton": "${SCHEMATRON_REF}"
}
JSON
}

# --- prerequisites -----------------------------------------------------------

require_java() {
  if ! "$JAVA_BIN" -version >/dev/null 2>&1; then
    echo "error: no Java runtime found." >&2
    echo "       Install a JDK 11+ and re-run, or point JAVA_BIN at one:" >&2
    echo "       JAVA_BIN=/path/to/bin/java $0" >&2
    return 127
  fi
}

require_cmd() {
  command -v "$1" >/dev/null || { echo "error: $1 not found" >&2; return 127; }
}

# --- KoSIT: the German regulator's own validator ------------------------------
# Leaves $1/validator-<v>-standalone.jar and $1/config/scenarios.xml in place.

ensure_kosit() {
  local work="$1"
  mkdir -p "$work"/{in,out,config}
  local jar="validator-${KOSIT_VALIDATOR_VERSION}-standalone.jar"
  local zip="xrechnung-${KOSIT_CONFIG_XR_VERSION}-validator-configuration-${KOSIT_CONFIG_VERSION}.zip"

  ( cd "$work" || return 1
    if [ ! -f "$jar" ]; then
      echo "→ downloading KoSIT validator ${KOSIT_VALIDATOR_VERSION}" >&2
      curl -fsSL -o "$jar" \
        "https://github.com/itplr-kosit/validator/releases/download/v${KOSIT_VALIDATOR_VERSION}/${jar}"
    fi
    if [ ! -f "config/scenarios.xml" ]; then
      echo "→ downloading XRechnung ${KOSIT_CONFIG_XR_VERSION} configuration (${KOSIT_CONFIG_VERSION})" >&2
      [ -f "$zip" ] || curl -fsSL -o "$zip" \
        "https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/download/v${KOSIT_CONFIG_VERSION}/${zip}"
      unzip -q -o "$zip" -d config
    fi
  )
}

kosit_jar_path() { echo "$1/validator-${KOSIT_VALIDATOR_VERSION}-standalone.jar"; }

# Run the KoSIT validator over every XML in $2, writing reports into $3.
kosit_run() {
  local work="$1" indir="$2" outdir="$3"
  mkdir -p "$outdir"
  "$JAVA_BIN" -jar "$(kosit_jar_path "$work")" \
    -s "$work/config/scenarios.xml" -r "$work/config" -o "$outdir" "$indir"/*.xml
}

# --- Peppol / CEN: OpenPEPPOL artefacts, compiled with ISO Schematron ---------
# Leaves $1/xslt/{CEN,PEPPOL}-EN16931-{UBL,CII}.xsl and $1/ubl/xsd/... in place.

peppol_sch_dir() { echo "$1/peppol-bis-invoice-3-${PEPPOL_TAG#v}/rules/sch"; }

saxon() { "$JAVA_BIN" -cp "$SAXON_LIB_DIR/*" net.sf.saxon.Transform "$@"; }

ensure_peppol() {
  local work="$1"
  mkdir -p "$work"/{lib,iso,xslt,in,out}
  SAXON_LIB_DIR="$work/lib"

  ( cd "$work" || return 1
    # 1. official Peppol BIS Billing 3.0 schematrons (they carry the CEN
    #    EN 16931 schematrons alongside their own CIUS rules)
    if [ ! -d "peppol-bis-invoice-3-${PEPPOL_TAG#v}/rules/sch" ]; then
      echo "→ downloading OpenPEPPOL peppol-bis-invoice-3 ${PEPPOL_TAG}" >&2
      curl -fsSL -o "peppol-${PEPPOL_TAG}.tar.gz" \
        "https://github.com/OpenPEPPOL/peppol-bis-invoice-3/archive/refs/tags/${PEPPOL_TAG}.tar.gz"
      tar xzf "peppol-${PEPPOL_TAG}.tar.gz"
    fi

    # 2. OASIS UBL 2.1 XML Schema
    if [ ! -f "ubl/xsd/maindoc/UBL-Invoice-2.1.xsd" ]; then
      echo "→ downloading OASIS UBL 2.1 OS schemas" >&2
      curl -fsSL -o "$UBL_ZIP" "https://docs.oasis-open.org/ubl/os-UBL-2.1/UBL-2.1.zip"
      unzip -q -o "$UBL_ZIP" -d ubl
    fi

    # 3. Saxon-HE, to run the XSLT2 the schematrons compile to
    if [ ! -f "lib/Saxon-HE-${SAXON_VERSION}.jar" ]; then
      echo "→ downloading Saxon-HE ${SAXON_VERSION}" >&2
      curl -fsSL -o "lib/Saxon-HE-${SAXON_VERSION}.jar" \
        "https://repo1.maven.org/maven2/net/sf/saxon/Saxon-HE/${SAXON_VERSION}/Saxon-HE-${SAXON_VERSION}.jar"
      for a in "xmlresolver-${XMLRESOLVER_VERSION}.jar" "xmlresolver-${XMLRESOLVER_VERSION}-data.jar"; do
        curl -fsSL -o "lib/$a" \
          "https://repo1.maven.org/maven2/org/xmlresolver/xmlresolver/${XMLRESOLVER_VERSION}/$a"
      done
    fi

    # 4. ISO Schematron reference implementation. OpenPEPPOL ships .sch, not
    #    compiled XSLT, so the compiler is ours and its version is part of the
    #    record.
    if [ ! -f "iso/iso_svrl_for_xslt2.xsl" ]; then
      echo "→ downloading ISO Schematron skeleton (${SCHEMATRON_REF:0:7})" >&2
      for f in iso_dsdl_include.xsl iso_abstract_expand.xsl iso_svrl_for_xslt2.xsl \
               iso_schematron_skeleton_for_saxon.xsl; do
        curl -fsSL -o "iso/$f" \
          "https://raw.githubusercontent.com/Schematron/schematron/${SCHEMATRON_REF}/trunk/schematron/code/$f"
      done
    fi

    # 5. compile each schematron to SVRL-emitting XSLT
    local sch_dir="peppol-bis-invoice-3-${PEPPOL_TAG#v}/rules/sch"
    for s in CEN-EN16931-UBL PEPPOL-EN16931-UBL CEN-EN16931-CII PEPPOL-EN16931-CII; do
      if [ ! -f "xslt/$s.xsl" ]; then
        echo "→ compiling $s.sch" >&2
        saxon -s:"$sch_dir/$s.sch"   -xsl:iso/iso_dsdl_include.xsl    -o:"xslt/$s.step1.sch"
        saxon -s:"xslt/$s.step1.sch" -xsl:iso/iso_abstract_expand.xsl -o:"xslt/$s.step2.sch"
        saxon -s:"xslt/$s.step2.sch" -xsl:iso/iso_svrl_for_xslt2.xsl  -o:"xslt/$s.xsl" allow-foreign=true
      fi
    done
  )
  SAXON_LIB_DIR="$work/lib"
}
