// ──────────────────────────────────────────────────────────
//  go2rtc supervisor.
//
//  go2rtc is a tiny Go binary that bridges RTSP push → WebRTC,
//  used to deliver the AV.io capture card feed to the dashboard
//  in <video> with hardware H.264 decode (~50-100ms latency).
//  Architecture: sidecar's ffmpeg pushes H.264 RTSP to localhost
//  8554; go2rtc relays it as WebRTC to the browser via the
//  WHEP signaling proxy in routes/avio.ts.
//
//  We launch go2rtc as a child of the backend so its lifecycle
//  follows the backend's launchd plist — start when backend
//  starts, exit when backend exits. KeepAlive on the backend
//  means a go2rtc crash will be recovered via the next backend
//  restart, but we also try to respawn within the same backend
//  process for fast recovery.
// ──────────────────────────────────────────────────────────
import axios from 'axios';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

const log = logger.child({ svc: 'go2rtc' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// backend/dist/services/go2rtcSupervisor.js → ../../../ = repo root
const repoRoot = resolve(__dirname, '..', '..', '..');
const GO2RTC_BIN = resolve(repoRoot, 'bin', 'go2rtc');
const GO2RTC_CONF = resolve(repoRoot, 'backend', 'go2rtc.yaml');

let proc: ChildProcess | null = null;
let stopRequested = false;
let restartTimer: NodeJS.Timeout | null = null;

export function start(): void {
  if (proc) return;
  stopRequested = false;
  if (!existsSync(GO2RTC_BIN)) {
    log.warn({ bin: GO2RTC_BIN }, 'go2rtc binary missing — AV.io WebRTC will be unavailable');
    return;
  }
  if (!existsSync(GO2RTC_CONF)) {
    log.warn({ conf: GO2RTC_CONF }, 'go2rtc config missing — falling back to defaults');
  }
  const args = existsSync(GO2RTC_CONF) ? ['--config', GO2RTC_CONF] : [];
  log.info({ bin: GO2RTC_BIN, args }, 'spawning go2rtc');
  proc = spawn(GO2RTC_BIN, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  proc.stdout?.on('data', (b: Buffer) => {
    for (const line of b.toString('utf-8').split('\n')) {
      if (line.trim()) log.debug({ go2rtc: line.trim() });
    }
  });
  proc.stderr?.on('data', (b: Buffer) => {
    // go2rtc logs to stderr; promote startup lines to info, runtime to debug.
    for (const line of b.toString('utf-8').split('\n')) {
      if (line.trim()) log.debug({ go2rtc: line.trim() });
    }
  });
  proc.on('exit', (code, signal) => {
    log.warn({ code, signal }, 'go2rtc exited');
    proc = null;
    if (!stopRequested) {
      // Respawn after 3s — handles crashes, OOMs, config reloads, etc.
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = setTimeout(() => { restartTimer = null; start(); }, 3000);
    }
  });
  proc.on('error', (err) => {
    log.error({ err: err.message }, 'go2rtc spawn error');
  });
  // Once go2rtc is up, kick the sidecar's ffmpeg so its RTSP push reconnects
  // to this fresh go2rtc instance. Without this, ffmpeg sits on a dead TCP
  // connection (RTSP push doesn't auto-reconnect on remote close) and go2rtc
  // shows producers=null until something else manually kicks ffmpeg.
  setTimeout(() => kickSidecar(), 2500);
}

async function kickSidecar(): Promise<void> {
  // Sidecar listens on 127.0.0.1:3301; the /avio/restart endpoint kills its
  // running ffmpeg so the supervisor in daemon.py respawns it.
  try {
    await axios.post('http://127.0.0.1:3301/avio/restart', {}, { timeout: 2000 });
    log.info('kicked sidecar ffmpeg to reconnect RTSP push');
  } catch (err) {
    // Sidecar might not be running yet at backend startup — that's fine, its
    // own supervisor will eventually connect on its own.
    log.debug({ err: (err as Error).message }, 'sidecar kick on go2rtc start skipped');
  }
}

export function stop(): void {
  stopRequested = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  const p = proc;
  proc = null;
  if (!p) return;
  log.info('stopping go2rtc');
  try { p.kill('SIGTERM'); } catch {}
  // Hard-kill if it hangs.
  setTimeout(() => {
    if (!p.killed) {
      try { p.kill('SIGKILL'); } catch {}
    }
  }, 2000).unref();
}
