#!/bin/bash
# Python launcher for the Studio DAW sidecar.
#
# Lives at Contents/Resources/run.sh inside the bundle. Invoked by the Swift
# shim (Contents/MacOS/StudioDAWSidecar) AFTER the TCC microphone prompt has
# been answered. Forces arm64 because /bin/bash via LaunchServices sometimes
# resolves x86_64 and our venv has arm64-only numpy wheels (dyld fails with
# "incompatible architecture" otherwise).
set -u
SIDECAR_DIR="${STUDIO_DAW_SIDECAR_DIR:-$HOME/Projects/classroom-dashboard/sidecar}"
LOG="$HOME/Library/Logs/studio-daw-sidecar.log"
ERR="$HOME/Library/Logs/studio-daw-sidecar.err.log"
mkdir -p "$(dirname "$LOG")"
cd "$SIDECAR_DIR" || { echo "sidecar dir missing: $SIDECAR_DIR" >> "$ERR"; exit 1; }
exec /usr/bin/arch -arm64 "$SIDECAR_DIR/venv/bin/python" "$SIDECAR_DIR/daemon.py" \
  >> "$LOG" 2>> "$ERR"
