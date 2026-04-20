# Studio DAW Sidecar

Runs on the studio Mac next to the Rodecaster Pro II (USB). Dials OUT to the classroom dashboard's Socket.IO `/sidecar` namespace and gives it live per-channel meters + multi-track WAV recording.

## Setup on the studio Mac (plug-and-play)

1. **Copy the whole `sidecar/` folder** to `~/Projects/classroom-dashboard/sidecar/` on the Mac Studio.
2. **Plug in the Rodecaster** over USB; make sure it's in Multi-Channel mode (14-channel output) in its own settings.
3. **Double-click `START SIDECAR.command`.**
   - First run: creates a Python 3 venv in `./venv/`, installs sounddevice + soundfile + python-socketio (~1 min). Then copies `sidecar.env.example` → `sidecar.env` and opens it for editing.
   - Edit `sidecar.env`:
     - `DASHBOARD_URL=http://<dashboard-host>:3000` (the Mac running `classroom-dashboard/backend` — LAN IP or hostname)
     - `SIDECAR_TOKEN=<shared-secret>` if the dashboard has one set
     - `AUDIO_DEVICE_MATCH=RØDECaster` (default matches; change if you renamed the device in Audio MIDI Setup)
   - Save, close, and double-click `START SIDECAR.command` again.
4. The daemon dials out, emits `hello`, and starts streaming peak meters at ~20 Hz. Click into the DAW card on the dashboard — you should see the meters wiggling and the status flip to "Sidecar connected".

If Python 3 is missing, the launcher tells you where to install it (`https://www.python.org/downloads/`, 3.11+).

## What works in v1

- **Live levels** — 14 channels of peak dBFS, ~20 Hz to the dashboard.
- **Multi-track recording** — `cmd record-start` opens a 24-bit 48 kHz multichannel WAV in `~/Documents/studio-daw-recordings/` (one file per session, all channels interleaved). `cmd record-stop` closes it and emits the path.
- **Auto-reconnect** — if the dashboard restarts, the sidecar keeps retrying the handshake.
- **Graceful shutdown** — Ctrl+C closes audio + recording + socket cleanly.

## Not yet wired

- **Mute / fader / solo writeback to Rodecaster hardware** — acknowledged but stubbed. Real control needs Rodecaster's USB-HID protocol or the Rode Central SDK; not shipped with the unit. Dashboard state updates are cosmetic until this lands.
- **Monitor routing** — likewise cosmetic.
- **Preset recall** — sidecar-side; mixer page has the UI.
- **Real-time audio back to the dashboard UI** — meters yes, actual audio preview no.

## Auto-start at login (optional)

Edit the bundled `com.dts.studio-daw-sidecar.plist` — replace the two path strings with your actual install paths — then:

```
cp com.dts.studio-daw-sidecar.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.dts.studio-daw-sidecar.plist
```

Logs go to `~/Library/Logs/studio-daw-sidecar.log`. To uninstall, `launchctl unload` the same path.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `no input device matched 'RØDECaster'` | Run Audio MIDI Setup, confirm the Rodecaster shows as an input. If renamed, update `AUDIO_DEVICE_MATCH` in `sidecar.env`. The sidecar prints every available input device when it can't match. |
| `sidecar connect error: websocket-transport-error` | Dashboard isn't reachable at `DASHBOARD_URL`. Verify `ping <dashboard-ip>`, check the macOS firewall on the dashboard Mac allows inbound port 3000, and that `ALLOWED_ORIGINS` in the dashboard `.env` is `*` or includes the sidecar's origin. |
| `unauthorized` | `SIDECAR_TOKEN` mismatch between sidecar `sidecar.env` and dashboard `backend/.env`. |
| Meters show nothing but no errors | Rodecaster probably isn't in Multi-Channel mode. Open its on-device settings → USB → Stream/Multi-track. |

## How the sidecar talks to the dashboard

Outbound events (sidecar → dashboard, all in `/sidecar` namespace):

- `hello` `{version, captureDevice, sampleRate, strips[]}` — on connect
- `levels` `{strips: [{channel, peakDb}]}` — ~20 Hz
- `state` `{patch: Partial<DawDevice>}` — when anything else changes
- `record` `{active, startedAt, durationSec, outputPath}` — on start/stop + every 500 ms while active

Inbound events (dashboard → sidecar):

- `cmd` `{op, args?}` — ops currently handled: `record-start`, `record-stop`, `monitor-start`, `monitor-stop`, `mute` (stub)

This mirrors `backend/src/ws/sidecarServer.ts` — update both sides together.
