# Classroom Dashboard — New Machine Setup

Instructions for Claude Code (or any developer) to clone this repo onto a fresh Mac and bring the dashboard up end-to-end.

## What this dashboard does

Single-page health + control dashboard for DTS Dallas classroom + conference-room AV gear. Live status for:

- **Canon CR-N300 cameras** (×17): PTZ, MJPEG previews, Auto Tracking, snapshots
- **Epiphan Pearl 2 encoders** (×5): one-touch record, recordings playback with in-browser player
- **Logitech Rally Bars + Taps + Sights** (15 rooms): via Sync Cloud API (mTLS) + local CollabOS API on each device
- **Studio DAW sidecar** (Python, runs on studio Mac): multi-track Rodecaster capture, records synced with Pearl

Stack: Node 22 + TypeScript + Express + Socket.IO backend, single-file vanilla JS dashboard, Python sidecar. No build step for the frontend.

---

## Step 1 — Install prerequisites

```bash
# Check Node.js — need 20+ (22 recommended)
node --version

# If missing, install from https://nodejs.org (LTS installer)
# Or via homebrew:
brew install node

# Check git
git --version

# Optional but useful:
brew install jq
```

## Step 2 — Clone the repo

```bash
mkdir -p ~/Projects
cd ~/Projects
git clone https://github.com/cbrake-creator/classroom-dashboard.git
cd classroom-dashboard
```

⚠️ **Must live under `~/Projects/` or a non-iCloud-synced path.** Do NOT put it in `~/Desktop/` or `~/Documents/` — those fight with `node_modules`.

## Step 3 — Install backend dependencies

```bash
cd backend
npm install
```

Takes about 30 seconds.

## Step 4 — Create the `.env` file

`backend/.env` is **gitignored** (contains secrets). Copy the example and fill in:

```bash
cp .env.example .env
```

Then edit `backend/.env` to match:

```bash
# ─── Core ──────────────────────────────────────────────────
PORT=3000
DEVICE_MODE=live          # 'live' against real devices; 'fallback' for mock/dev
LOG_LEVEL=info
ALLOWED_ORIGINS=*         # LAN-only deployment — wildcard is fine

# ─── Canon cameras ─────────────────────────────────────────
CANON_USERNAME=admin
CANON_PASSWORD=Cr3@t1v$

# ─── Epiphan Pearl 2 ───────────────────────────────────────
PEARL_HOST=10.56.1.250    # Faculty Podcast default; per-device IPs live in fixtures
PEARL_USERNAME=admin
PEARL_PASSWORD=Cr3@t1v$

# ─── Studio Mac (SSH for Rodecaster detection) ─────────────
MAC_HOST=10.56.1.10
MAC_USER=studio
MAC_KEY_PATH=~/.ssh/id_ed25519

# ─── DAW sidecar shared secret (leave blank if LAN-only) ──
SIDECAR_TOKEN=

# ─── Logitech Sync Cloud API ───────────────────────────────
SYNC_ORG_ID=KdoyuVqvMFf1epNQfWKPKOnAJdsv4TBf
SYNC_CERT_PATH=./certs/certificate.pem
SYNC_KEY_PATH=./certs/privateKey.pem
SYNC_POLL_INTERVAL_MS=60000

# ─── Logitech CollabOS local API (per-device HTTPS admin) ──
LOGI_LOCAL_USERNAME=admin
LOGI_LOCAL_PASSWORD=Cr3@t1v$
```

## Step 5 — Drop in the Logitech Sync cert files

The Sync Cloud API uses mTLS. The cert + private key files are **NOT in git** (sensitive) but must be at `backend/certs/`:

```bash
mkdir -p certs
# Then either:
#   a) Copy from the DTS external drive: /Volumes/Hard Drive/DAW/certs/
#   b) Generate new ones from the Sync Portal:
#      https://sync.logitech.com/system/org/KdoyuVqvMFf1epNQfWKPKOnAJdsv4TBf/sync-api
#      → "Sync API client certificates" section → Generate new certificate
#      → Download both files → save as certs/certificate.pem and certs/privateKey.pem
chmod 600 certs/privateKey.pem
```

Verify:

```bash
ls -la certs/
# Should show certificate.pem and privateKey.pem
```

## Step 6 — macOS firewall (if hosting for other LAN devices)

If this machine is the *dashboard host* that other 10.56 devices will connect to:

1. System Settings → Network → Firewall → Options
2. Allow incoming connections for `node`
3. Test from another device: `curl http://<this-host-ip>:3000/healthz`

## Step 7 — Start the backend

```bash
npm run dev
```

You should see:

```
[time] INFO: classroom-dashboard backend listening
    port: 3000
    mode: "live"
[time] INFO: starting device poller
[time] INFO: sync polling started
[time] INFO: sync places refreshed  count: 40  rooms: 15
```

Health check:

```bash
curl http://localhost:3000/healthz
# {"ok":true,"mode":"live"}
```

## Step 8 — Open the dashboard

Browser → `http://localhost:3000`

From another LAN device → `http://<host-ip>:3000`

You should see Dallas campus with 33 rooms. Conference rooms should show Rally Bar status within 60 seconds. Cameras in classrooms show live MJPEG once you click into a room.

---

## Studio DAW sidecar (separate machine)

The Python sidecar runs on the **studio Mac** (next to the Rodecaster), not the dashboard host. See `sidecar/README.md` for its install. Summary:

```bash
cd sidecar
./START\ SIDECAR.command     # double-click launcher, auto-installs venv
```

First run prompts for `sidecar.env` edits — set `DASHBOARD_URL` to `http://<dashboard-host-ip>:3000`.

## External-drive plug-and-play alternative

If the DTS USB drive is handy (`/Volumes/Hard Drive/DAW/` on the DTS-issued Mac), there's a pre-baked version of this setup that just requires double-clicking a launcher. See `README.md` or the `DAW/README.md` on the drive.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Every Rally Bar shows offline | Check you're on the 10.56 network and the dashboard host can ping `10.56.1.*` |
| Sync API 403 / cert errors | Cert expired (they last ~90 days on trial). Regenerate from Sync Portal. |
| Canon cameras show "Preview unavailable" | Camera is in standby — click Wake button, or it's off the 10.56 network |
| Pearl recorders show offline | Pearl is unpowered or IP changed — verify with `ping 10.56.1.250` |
| Port 3000 already in use | `lsof -ti :3000 \| xargs kill` |
| `npm run dev` says `tsx: command not found` | Run `npm install` again |
| Logitech local API rate-limited (429) | Dashboard polls too fast — already rate-limited in code to ~6 calls/min/device; if still an issue, bump `SYNC_POLL_INTERVAL_MS` in .env |

## Key external services + credentials needed

| Service | How we authenticate | Where the secret lives |
|---|---|---|
| Canon cameras | HTTP Basic (`admin` / password) | `backend/.env` (`CANON_PASSWORD`) |
| Canon Auto Tracking app | HTTP Digest (same creds) | Shares Canon creds |
| Epiphan Pearls | HTTP Basic | `backend/.env` (`PEARL_PASSWORD`) |
| Studio Mac | SSH key | `~/.ssh/id_ed25519` on dashboard host |
| Logitech Sync Cloud | mTLS client cert | `backend/certs/certificate.pem` + `privateKey.pem` |
| Logitech CollabOS local | HTTP Basic then JWT | `backend/.env` (`LOGI_LOCAL_USERNAME` / `LOGI_LOCAL_PASSWORD`) |
| DAW sidecar → dashboard | Optional shared token | `backend/.env` (`SIDECAR_TOKEN`) |
| Teams Rooms Pro (planned) | OAuth2 client-credentials | Not yet wired — Entra app `f6e7addb-1af8-46b9-9d91-cdd5ab8d1559` |

## Repo layout

```
classroom-dashboard/
├── dashboard.html              # Single-file UI — vanilla JS/CSS
├── backend/
│   ├── src/
│   │   ├── index.ts            # Express + Socket.IO entry
│   │   ├── config.ts           # .env loader
│   │   ├── devices/            # Per-vendor clients (canon, pearl, mac,
│   │   │                       #   rodecaster, logitechSync, logitechLocal,
│   │   │                       #   pinger)
│   │   ├── routes/             # REST handlers
│   │   ├── services/           # deviceManager, roomState, presets
│   │   ├── ws/                 # Socket.IO + /sidecar namespace
│   │   └── fixtures/rooms.ts   # Every campus/room/device
│   ├── .env                    # Secrets — NOT in git
│   └── certs/                  # Logitech mTLS — NOT in git
├── sidecar/                    # Python daemon for studio Mac (separate host)
├── studio-daw/                 # Legacy mixer SPA click-through
└── canon-xc-api-reference.md   # Canon XC protocol notes (the official
                                #   reference was wrong on 3 endpoints —
                                #   see canon.ts for what actually works)
```

## Current state (as of last commit — check `git log` for latest)

- **Canon cameras**: PTZ, MJPEG previews, Auto Tracking read + write — all working
- **Epiphan Pearls**: one-touch record + recordings playback
- **Logitech Rally Bars**: ALL 15 conference rooms live (cloud + local API)
- **DAW sidecar**: code ready, needs install on studio Mac
- **Teams Rooms Pro control**: Entra app registered, waiting on `TeamworkDevice.Read.All` permission grant from DTS admin (Pranutha) to wire in remote reboot + diagnostics per conference room

## Project notes for Claude Code

- Backend runs via `tsx watch` (dev). For production, `npm run build` + `node dist/index.js` + a launchd plist.
- Frontend is single-file `dashboard.html` — no bundler, no React. Edit inline and reload.
- Device refresh runs every 5 seconds; Sync Cloud polls every 60; Rally Bar local API insights cache 20s (rate-limited 10/min/device).
- The Canon XC reference doc bundled in the repo is **unreliable** — it lies about auth, PTZ param names, image endpoints, and standby command syntax. `backend/src/devices/canon.ts` has the actually-working protocol.
- The dashboard backend binds `0.0.0.0:3000` by default. Firewall is the #1 thing that breaks LAN access.
- Socket.IO CORS: set via `ALLOWED_ORIGINS` env. `*` is fine on LAN-only.
