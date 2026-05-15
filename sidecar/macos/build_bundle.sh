#!/bin/bash
# Build (or rebuild) ~/Applications/StudioDAWSidecar.app from sources here.
#
# Produces a bundle whose main binary is a real Mach-O (compiled from
# main.swift). That's what lets macOS treat it as the bundle's identity for
# TCC microphone permission. The Python daemon is exec'd from the Swift shim
# via Contents/Resources/run.sh.
#
# Idempotent. Safe to run repeatedly. Does NOT reset TCC by itself — pass
# --reset-tcc to also wipe the Microphone permission for our bundle id.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${STUDIO_DAW_SIDECAR_APP:-$HOME/Applications/StudioDAWSidecar.app}"
RESET_TCC=0
for arg in "$@"; do
  case "$arg" in
    --reset-tcc) RESET_TCC=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

echo "==> building bundle at $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
cp "$HERE/run.sh"     "$APP/Contents/Resources/run.sh"
chmod +x              "$APP/Contents/Resources/run.sh"

echo "==> compiling Swift shim"
xcrun swiftc \
  -O \
  -target arm64-apple-macosx12.0 \
  -framework AppKit -framework AVFoundation -framework Foundation \
  -o "$APP/Contents/MacOS/StudioDAWSidecar" \
  "$HERE/main.swift"

echo "==> ad-hoc signing bundle"
codesign --force --sign - --identifier com.dts.studio-daw-sidecar \
  --options runtime \
  "$APP/Contents/MacOS/StudioDAWSidecar"
codesign --force --sign - --identifier com.dts.studio-daw-sidecar \
  "$APP"

echo "==> verifying signature"
codesign -dvv "$APP" 2>&1 | grep -E '^(Identifier|Signature|Format|Sealed)' || true

if [[ $RESET_TCC -eq 1 ]]; then
  echo "==> resetting TCC microphone + camera permission for com.dts.studio-daw-sidecar"
  tccutil reset Microphone com.dts.studio-daw-sidecar || true
  tccutil reset Camera     com.dts.studio-daw-sidecar || true
fi

echo "==> done. Launch with:  open '$APP'"
echo "    First launch should render the microphone permission dialog."
