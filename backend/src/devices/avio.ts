// ──────────────────────────────────────────────────────────
//  AV.io 4K (Epiphan capture card) client.
//
//  Lives on the studio Mac, plugged in via USB. Captures the
//  Pearl 2's HDMI 1 program output. macOS TCC's camera-access
//  attribution rules mean we can't have the launchd-managed
//  backend spawn ffmpeg directly (silent denial), so the actual
//  ffmpeg invocations happen inside the StudioDAWSidecar bundle.
//  The bundle's ffmpeg pushes H.264 over RTSP to a local go2rtc
//  instance; go2rtc translates the RTSP into WebRTC (via WHEP)
//  for browser clients. Backend proxies snapshot + WHEP requests
//  through to go2rtc; the sidecar's HTTP endpoint exists only
//  for /healthz and /restart.
// ──────────────────────────────────────────────────────────
import axios from 'axios';
import { logger } from '../logger.js';

const log = logger.child({ device: 'avio' });

// go2rtc REST API base. Configurable via env so a future deployment can move
// it; default matches what backend/go2rtc.yaml binds to.
const GO2RTC_BASE = process.env.GO2RTC_BASE ?? 'http://127.0.0.1:1984';

export interface AvioStatus {
  reachable: boolean;
  signalPresent: boolean;
  lastFrameAt: number | null;
}

// Single JPEG frame, fetched from go2rtc's built-in /api/frame.jpeg endpoint.
// Used by the dashboard's Snapshot button. Returns the JPEG bytes on success,
// throws on any failure (no producer, go2rtc unreachable, etc.).
export async function snapshot(streamName: string = 'avio'): Promise<Buffer> {
  const res = await axios.get(`${GO2RTC_BASE}/api/frame.jpeg`, {
    params: { src: streamName },
    responseType: 'arraybuffer',
    timeout: 5_000,
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    const text = Buffer.from(res.data as ArrayBuffer).toString('utf-8').slice(0, 200);
    throw new Error(`go2rtc ${res.status}: ${text}`);
  }
  const buf = Buffer.from(res.data as ArrayBuffer);
  if (buf.length < 16 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error('go2rtc did not return JPEG bytes (capture loop down?)');
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

// Tell the sidecar to kill its running ffmpeg subprocess. The capture loop's
// outer while spins a fresh one up automatically. We call this after every
// Pearl source-change because AV.io's HDMI link doesn't renegotiate cleanly
// inside an existing avfoundation stream — without a fresh ffmpeg, the
// dashboard keeps showing pre-switch buffered frames.
export async function restartCapture(sidecarHost: string): Promise<boolean> {
  try {
    const res = await axios.post(`http://${sidecarHost}/avio/restart`, {}, { timeout: 3_000 });
    return res.status === 200 && res.data?.ok === true;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'avio restart failed');
    return false;
  }
}

// Forward a WebRTC SDP-offer/answer exchange to go2rtc. The browser POSTs
// a JSON envelope { type: 'offer', sdp } to our /api/avio/:id/whep route;
// we forward to go2rtc /api/webrtc?src=avio with the same JSON shape and
// return go2rtc's { type: 'answer', sdp } unchanged. Media flows directly
// between the browser and go2rtc's WebRTC ports (8555 UDP/TCP) over ICE —
// this is only the signaling channel, body sizes are <10KB.
//
// (go2rtc 1.9.x doesn't expose a strict WHEP endpoint; this is the "legacy"
// JSON-wrapped form. The route on our backend is still named /whep because
// the externally-facing protocol is conceptually WHEP-shaped.)
export interface WebRtcSignal {
  type: 'offer' | 'answer';
  sdp: string;
}

export async function whepProxy(
  streamName: string,
  signal: WebRtcSignal,
): Promise<{ status: number; signal: WebRtcSignal | null; raw: string }> {
  const res = await axios.post(`${GO2RTC_BASE}/api/webrtc`, signal, {
    params: { src: streamName },
    headers: { 'Content-Type': 'application/json' },
    responseType: 'text',
    timeout: 8_000,
    validateStatus: () => true,
  });
  const raw = String(res.data);
  if (res.status === 200) {
    try { return { status: 200, signal: JSON.parse(raw) as WebRtcSignal, raw }; }
    catch { /* fall through to raw */ }
  }
  return { status: res.status, signal: null, raw };
}
