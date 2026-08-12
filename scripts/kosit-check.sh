#!/usr/bin/env bash
# Validate the committed fixtures against the OFFICIAL KoSIT validator.
#
# Our own rule engine is a reimplementation, and the only way to know the XML it
# produces agrees with the regulator is to run the regulator's own tool over it.
# Scope: every fixture in fixtures/, not the rule set — this is a conformance
# check on those documents, not a schematron parity suite. Everything is
# downloaded into a scratch
# directory; nothing is installed system-wide.
#
# Usage:  ./scripts/kosit-check.sh [output-dir]
#
# Requires Java 11+. If `java` is not on PATH, set JAVA_BIN, e.g.
#   JAVA_BIN=/opt/homebrew/opt/openjdk@17/bin/java ./scripts/kosit-check.sh
set -euo pipefail

VALIDATOR_VERSION="1.6.2"
CONFIG_VERSION="2026-01-31"
CONFIG_XR_VERSION="3.0.2"

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${1:-${TMPDIR:-/tmp}/attestwire-kosit}"
JAVA_BIN="${JAVA_BIN:-java}"

if ! "$JAVA_BIN" -version >/dev/null 2>&1; then
  echo "error: no Java runtime found." >&2
  echo "       Install a JDK 11+ and re-run, or point JAVA_BIN at one:" >&2
  echo "       JAVA_BIN=/path/to/bin/java $0" >&2
  exit 127
fi

mkdir -p "$WORK_DIR"/{in,out,config}
cd "$WORK_DIR"

VALIDATOR_JAR="validator-${VALIDATOR_VERSION}-standalone.jar"
CONFIG_ZIP="xrechnung-${CONFIG_XR_VERSION}-validator-configuration-${CONFIG_VERSION}.zip"

if [ ! -f "$VALIDATOR_JAR" ]; then
  echo "→ downloading KoSIT validator ${VALIDATOR_VERSION}"
  curl -fsSL -o "$VALIDATOR_JAR" \
    "https://github.com/itplr-kosit/validator/releases/download/v${VALIDATOR_VERSION}/${VALIDATOR_JAR}"
fi

if [ ! -f "config/scenarios.xml" ]; then
  echo "→ downloading XRechnung ${CONFIG_XR_VERSION} configuration (${CONFIG_VERSION})"
  curl -fsSL -o "$CONFIG_ZIP" \
    "https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/download/v${CONFIG_VERSION}/${CONFIG_ZIP}"
  unzip -q -o "$CONFIG_ZIP" -d config
fi

cp "$PKG_DIR"/fixtures/*.xml in/
echo "→ validating $(ls in | wc -l | tr -d ' ') fixture(s)"

"$JAVA_BIN" -jar "$VALIDATOR_JAR" -s config/scenarios.xml -r config -o out in/*.xml
