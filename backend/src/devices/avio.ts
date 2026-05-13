// ──────────────────────────────────────────────────────────
//  AV.io 4K (Epiphan capture card) client.
//
//  Lives on the studio Mac, plugged in via USB. Captures the
//  Pearl 2's HDMI 1 program output. macOS TCC's camera-access
//  attribution rules mean we can't have the launchd-managed
//  backend spawn ffmpeg directly (silent denial), so the actual
//  ffmpeg invocations happen inside the StudioDAWSidecar bundle
//  via its loopback HTTP server. This file is just the backend's
//  proxy + health probe.
// ──────────────────────────────────────────────────────────
import axios from 'axios';
import http from 'node:http';
import { logger } from '../logger.js';

const log = logger.child({ device: 'avio' });

export interface AvioStatus {
  reachable: boolean;
  signalPresent: boolean;
  lastFrameAt: number | null;
}

// Single-frame probe — also used by the dashboard's Snapshot button. Returns
// the JPEG bytes on success, throws on any failure (timeout, ffmpeg error,
// sidecar unreachable, no signal on HDMI 1).
export async function snapshot(sidecarHost: string): Promise<Buffer> {
  const res = await axios.get(`http://${sidecarHost}/avio/snapshot`, {
    responseType: 'arraybuffer',
    timeout: 10_000,
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    const text = Buffer.from(res.data as ArrayBuffer).toString('utf-8').slice(0, 200);
    throw new Error(`sidecar ${res.status}: ${text}`);
  }
  const buf = Buffer.from(res.data as ArrayBuffer);
  if (buf.length < 16 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error('sidecar did not return JPEG bytes');
  }
  return buf;
}

// Lightweight health check — does the sidecar's HTTP server answer? Doesn't
// open the AV.io device or invoke ffmpeg, so it's safe to call every poll
// cycle without burning CPU on capture-card spin-up.
export async function probeReachable(sidecarHost: string): Promise<boolean> {
  try {
    const res = await axios.get(`http://${sidecarHost}/healthz`, { timeout: 1500 });
    return res.status === 200;
  } catch {
    return false;
  }
}

// Used by deviceManager.refreshDevice. Cheap path: reachability only.
// Snapshot-based signal detection is too expensive (2-3s) to do per-poll;
// we infer signal presence from a delayed cache instead — see deviceManager
// for the schedule.
export async function getStatus(sidecarHost: string): Promise<AvioStatus> {
  const reachable = await probeReachable(sidecarHost);
  return { reachable, signalPresent: false, lastFrameAt: null };
}

// Pipe the sidecar's mpjpeg stream straight to the dashboard client. Used by
// the /api/avio/:id/mjpeg route. One upstream connection per browser viewer
// (each spawns its own ffmpeg subprocess on the sidecar side). When the
// browser disconnects, we destroy the upstream so the sidecar can kill ffmpeg
// and release the AV.io device for the next viewer.
export function pipeMjpeg(sidecarHost: string, res: import('express').Response, onClose?: () => void): void {
  const [host, portStr] = sidecarHost.split(':');
  const port = Number(portStr) || 80;
  const upstream = http.request(
    { host, port, path: '/avio/mjpeg', method: 'GET', timeout: 8000 },
    (up) => {
      const ct = String(up.headers['content-type'] ?? '');
      if (up.statusCode !== 200 || !ct.startsWith('multipart/')) {
        res.status(503).type('text/plain').end(
          `sidecar mjpeg upstream ${up.statusCode} ${ct} — camera permission lost? ffmpeg missing?`
        );
        up.destroy();
        return;
      }
      res.writeHead(200, {
        'Content-Type': ct,
        'Cache-Control': 'no-store',
        'Connection': 'close',
      });
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    log.warn({ err: err.message }, 'avio mjpeg upstream error');
    if (!res.headersSent) res.status(503).type('text/plain').end(`upstream error: ${err.message}`);
  });
  upstream.on('timeout', () => {
    upstream.destroy();
    if (!res.headersSent) res.status(504).type('text/plain').end('upstream timeout');
  });
  // Browser navigated away or closed the tab — kill upstream so the sidecar
  // can tear down ffmpeg and free the AV.io device.
  res.on('close', () => {
    upstream.destroy();
    if (onClose) onClose();
  });
  upstream.end();
}
