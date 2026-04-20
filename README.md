# Classroom Dashboard — Dashboard Host Setup

This is the Mac that runs the Express + Socket.IO backend (`backend/`) and serves the single-page dashboard (`dashboard.html`). Other devices on 10.56 load the dashboard from this host's IP in a browser; the studio-Mac sidecar also dials in here over WebSocket.

For setup on the **studio Mac** (Rodecaster + DAW capture), see `sidecar/README.md` instead — that's a different machine.

## 1. Get the code

```bash
mkdir -p ~/Projects
cd ~/Projects
git clone https://github.com/cbrake-creator/classroom-dashboard.git
```

Or copy from the external drive if that's how it's arriving. Place in `~/Projects/` (NOT Desktop or Documents — iCloud-synced dirs fight with `node_modules`).

## 2. Install Node.js 20+

If missing: `https://nodejs.org/` → LTS installer.

```bash
cd ~/Projects/classroom-dashboard/backend
npm install
cp .env.example .env      # then edit — see below
npm run dev
```

You should see `classroom-dashboard backend listening port=3000 mode=live`.

## 3. Configure `.env`

Minimum fields:

```
DEVICE_MODE=live              # or 'fallback' for local dev with mock data
CANON_USERNAME=admin
CANON_PASSWORD=<the-canon-password>
PEARL_USERNAME=admin
PEARL_PASSWORD=<the-pearl-password>
ALLOWED_ORIGINS=*             # lets any LAN browser load the dashboard
SIDECAR_TOKEN=                # leave blank for LAN-only; set a shared secret for auth
```

## 4. **Allow inbound port 3000 through macOS Firewall**

**Without this, no other LAN device can load the dashboard.** The sidecar can still dial out and half-connect (outbound works regardless), but browsers on laptops/iPads get connection-refused.

- System Settings → Network → Firewall → **Options**
- Find `node` in the app list (or use `+` to add `/usr/local/bin/node` — the path depends on where Node was installed)
- Set to **Allow incoming connections**

Verify from another 10.56 device:

```bash
curl http://<this-mac's-ip>:3000/healthz
# {"ok":true,"mode":"live"}
```

If that fails, the firewall is the likely culprit.

## 5. Auto-start at login (optional)

See `claudeCode/launch.json` — the preview server config is included. For a production auto-start, wrap `npm start` in a launchd plist following the same pattern as `sidecar/com.dts.studio-daw-sidecar.plist`.

## 6. Where does the dashboard show?

- On this Mac: `http://localhost:3000`
- From any other 10.56 device: `http://<this-mac's-ip>:3000`

All browsers share state — if one of them starts a Pearl recording or moves a camera, every other browser sees the update instantly.

## 7. Studio DAW — separate Mac

The Mac Studio next to the Rodecaster runs the sidecar daemon. See `sidecar/README.md`. It dials OUT to the dashboard's `/sidecar` namespace on port 3000, so it needs no inbound ports open on its end. Just needs the dashboard host's IP in its `sidecar.env`.

## Project topology

```
┌──────────────────┐        ┌──────────────────────┐        ┌──────────────────┐
│  Any browser on  │  HTTP  │  Dashboard backend   │  WS    │  Mac Studio      │
│  10.56 (laptop,  │──────▶ │  (this host at       │ ◀───── │  (sidecar dials  │
│  iPad, etc.)     │  WS    │   10.56.x.y:3000)    │        │   OUT on boot)   │
└──────────────────┘        └──────────────────────┘        └──────────────────┘
         │                             │                              │
         │                             ▼                              │
         │            ┌────────────────────────────────┐              │
         └───────────▶│  REST polls & command relays:  │              │
                      │    Canon CR-N300 cameras       │              │
                      │    Epiphan Pearl 2 encoders    │              │
                      │    Studio Mac (SSH)            │              │
                      └────────────────────────────────┘              │
                                                                      ▼
                                                            Rodecaster Pro II
                                                            (14-ch USB capture)
```

## Repo layout

| Path | What it is |
|------|-----------|
| `dashboard.html` | Single-page UI — vanilla JS + CSS + embedded Socket.IO client |
| `backend/` | Express + Socket.IO TypeScript server (entry: `src/index.ts`) |
| `backend/src/devices/` | Canon / Pearl / Mac / Rodecaster clients |
| `backend/src/routes/` | REST handlers |
| `backend/src/ws/` | Socket.IO (dashboard broadcast + sidecar namespace) |
| `backend/src/services/` | Device poller, room state, preset storage |
| `backend/src/fixtures/rooms.ts` | Initial state — every campus / room / device mapping |
| `sidecar/` | Python daemon for the studio Mac (separate deploy) |
| `studio-daw/` | Mixer SPA click-through at `/studio/daw` (legacy; superseded by sidecar for recording) |
| `canon-xc-api-reference.md` | Canon XC protocol notes (the reference doc is WRONG on several endpoints — see canon.ts for what actually works against CR-N300 fw 1.7.0) |
