#!/bin/bash
# Double-click launcher for the studio-daw sidecar on the Mac Studio.
# First run: creates a Python venv and installs deps. Subsequent runs: just start.

set -e
cd "$(dirname "$0")"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  DTS Studio DAW Sidecar"
echo "  Running from: $(pwd)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: Python 3 is not installed on this Mac."
  echo "Install from https://www.python.org/downloads/ (3.11+ recommended) then re-run."
  echo
  read -p "Press Enter to close..."
  exit 1
fi

if [ ! -d venv ]; then
  echo "First run — creating Python venv and installing audio deps (~1 min)..."
  python3 -m venv venv
  ./venv/bin/pip install --upgrade pip
  ./venv/bin/pip install -r requirements.txt
fi

if [ ! -f sidecar.env ]; then
  echo "Creating sidecar.env from the example — EDIT IT before first real use to"
  echo "set DASHBOARD_URL and SIDECAR_TOKEN."
  cp sidecar.env.example sidecar.env
  echo
  echo "Opened in your default editor — save, then re-run this launcher."
  open -t sidecar.env
  exit 0
fi

echo
echo "Starting sidecar. Press Ctrl+C to stop."
echo
exec ./venv/bin/python daemon.py
