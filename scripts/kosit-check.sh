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

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${1:-${TMPDIR:-/tmp}/attestwire-kosit}"

# Pinned versions and the download itself live in one place now, shared with
# scripts/peppol-check.sh and with benchmark/ — see lib/validator-setup.sh.
# The scratch directory and the artefacts are byte-identical to before.
. "$(dirname "${BASH_SOURCE[0]}")/lib/validator-setup.sh"

require_java || exit 127
ensure_kosit "$WORK_DIR"

cp "$PKG_DIR"/fixtures/*.xml "$WORK_DIR"/in/
echo "→ validating $(ls "$WORK_DIR"/in | wc -l | tr -d ' ') fixture(s)"

kosit_run "$WORK_DIR" "$WORK_DIR/in" "$WORK_DIR/out"
