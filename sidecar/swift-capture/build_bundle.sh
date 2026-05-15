#!/bin/bash
# build_bundle.sh — wrap the compiled avio-capture binary into a minimal
# macOS app bundle at ~/Applications/AvioCaptureDev.app so it has a real
# Info.plist (with NSCameraUsageDescription) and a stable bundle identity
# for TCC. Without this, running the binary bare from the shell will
# silently fail Camera permission requests because macOS refuses to prompt
# for binaries that lack a usage-description Info.plist.
#
# This bundle is dev-only — separate from the production
# StudioDAWSidecar.app bundle. Step 7 of the Path C plan replaces this
# with proper integration into the existing production bundle.
#
# Idempotent. Safe to run repeatedly.
#
# Usage:
#   ./build_bundle.sh             # build + bundle + ad-hoc sign
#   ./build_bundle.sh --reset-tcc # ALSO reset Camera TCC for the bundle id
#                                 # (forces the prompt to reappear next run)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${AVIO_CAPTURE_DEV_APP:-$HOME/Applications/AvioCaptureDev.app}"
BUNDLE_ID="com.dts.avio-capture-dev"

RESET_TCC=0
for arg in "$@"; do
  case "$arg" in
    --reset-tcc) RESET_TCC=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

echo "==> ensuring binary is built (swift build -c release)"
( cd "$HERE" && swift build -c release ) >/dev/null

# Find the built binary — SPM picks an arch-specific dir on Apple Silicon.
BIN=""
for cand in \
  "$HERE/.build/arm64-apple-macosx/release/avio-capture" \
  "$HERE/.build/release/avio-capture"; do
  if [[ -x "$cand" ]]; then BIN="$cand"; break; fi
done
if [[ -z "$BIN" ]]; then
  echo "error: could not find built avio-capture binary under $HERE/.build" >&2
  exit 1
fi
echo "    binary: $BIN"

echo "==> building bundle at $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
cp "$BIN"             "$APP/Contents/MacOS/avio-capture"
chmod +x              "$APP/Contents/MacOS/avio-capture"

echo "==> ad-hoc signing bundle (identifier=$BUNDLE_ID)"
codesign --force --sign - --identifier "$BUNDLE_ID" \
  --options runtime \
  "$APP/Contents/MacOS/avio-capture"
codesign --force --sign - --identifier "$BUNDLE_ID" \
  "$APP"

echo "==> verifying signature"
codesign -dvv "$APP" 2>&1 | grep -E '^(Identifier|Signature|Format|Sealed)' || true

if [[ $RESET_TCC -eq 1 ]]; then
  echo "==> resetting Camera TCC for $BUNDLE_ID"
  tccutil reset Camera "$BUNDLE_ID" || true
fi

echo ""
echo "==> done."
echo "    Launch with:"
echo "      $APP/Contents/MacOS/avio-capture --duration 10"
echo ""
echo "    First launch will render a Camera permission dialog. Approve it."
echo "    To force the prompt to reappear, run:  $0 --reset-tcc"
