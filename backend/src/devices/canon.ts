// ──────────────────────────────────────────────────────────
//  Canon CR-N300 client.
//
//  The bundled `canon-xc-api-reference.md` proved unreliable
//  against CR-N300 firmware 1.7.0 — the real protocol (tested
//  live against 10.56.24.217) is:
//
//    Base: http://<host>/-wvhttp-01-/
//    Auth: HTTP Basic
//
//    open.cgi            → returns a body whose first line is
//                          `s:=<session-id>` (NOT `s.session.id:=`)
//    claim.cgi?s=<sid>   → promotes this session to control master
//    yield.cgi?s=<sid>   → releases control
//    close.cgi?s=<sid>   → ends the session
//
//    control.cgi?s=<sid>&c.1.pan=<v>   → absolute pan (-17000..17000)
//    control.cgi?s=<sid>&c.1.tilt=<v>  → absolute tilt (-3000..10000)
//    control.cgi?s=<sid>&c.1.zoom=<v>  → absolute zoom (340..6340)
//    control.cgi?s=<sid>&c.1.focus.auto.track=on|off
//
//    standby.cgi?cmd=idle     → wake
//    standby.cgi?cmd=standby  → sleep
//
//    image.cgi   → single JPEG (NO `w` param — passing one errors)
//    video.cgi   → live MJPEG multipart/x-mixed-replace stream
//
//    f.standby   → 'idle' | 'standby' (authoritative power state;
//                  c.1.power is absent during standby)
// ──────────────────────────────────────────────────────────
import axios, { AxiosInstance } from 'axios';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger.child({ device: 'canon' });

export interface CanonInfo {
  power: boolean;
  panPos: number;
  tiltPos: number;
  zoomPos: number;
  autoTrack: boolean;
  livescopeStatus: number;
  livescopeMsg: string;
}

interface SessionState {
  sessionId: string | null;
  claimed: boolean;
}
const sessions = new Map<string, SessionState>();

// PTZ step sizes. Pan/tilt are ~±10°/click; zoom is ~1 step of the wide→tele range.
const PAN_STEP = 500;
const TILT_STEP = 300;
const ZOOM_STEP = 300;

function client(host: string): AxiosInstance {
  return axios.create({
    baseURL: `http://${host}/-wvhttp-01-`,
    timeout: config.deviceHttpTimeoutMs,
    auth: { username: config.canonAuth.username, password: config.canonAuth.password },
  });
}

function getSession(camId: string): SessionState {
  if (!sessions.has(camId)) sessions.set(camId, { sessionId: null, claimed: false });
  return sessions.get(camId)!;
}

// Parse the simple key=value response Canon returns. Each line looks like
// `key:=value`. Canon also uses `key==value` in some responses (e.g.
// s.duration==0). Handle both.
function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([^=]+?):?==?(.*)$/);
    if (m) out[m[1]!.trim()] = m[2]!.trim();
  }
  return out;
}

// Any Canon CGI can return HTTP 200 with an ASCII error body
// ('--- WebView Livescope Http Server Error --- <reason>'). Detect and throw
// so callers can react instead of treating success as a silent failure.
function assertNotErrorBody(text: string): void {
  if (text.startsWith('--- WebView Livescope Http Server Error ---')) {
    const reason = text.split('\n').slice(1).join(' ').trim();
    throw new Error(`canon error: ${reason || 'unknown'}`);
  }
}

// ─── Reads ─────────────────────────────────────────────────
export async function getInfo(host: string): Promise<CanonInfo> {
  const res = await client(host).get('/info.cgi', { responseType: 'text' });
  const kv = parseKv(String(res.data));
  const inStandby = kv['f.standby'] === 'standby';
  return {
    power: !inStandby,
    panPos: Number(kv['c.1.pan'] ?? 0),
    tiltPos: Number(kv['c.1.tilt'] ?? 0),
    zoomPos: Number(kv['c.1.zoom'] ?? 0),
    autoTrack: kv['c.1.focus.auto.track'] === 'on',
    livescopeStatus: inStandby ? 509 : 0,
    livescopeMsg: inStandby ? 'Standby' : 'OK',
  };
}

// Canon returns 200 with an ASCII error body when the camera isn't serving
// live video (standby, booting, etc). Validate JPEG magic bytes.
export async function snapshot(host: string): Promise<Buffer> {
  const res = await client(host).get('/image.cgi', { responseType: 'arraybuffer' });
  const buf = Buffer.from(res.data as ArrayBuffer);
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    const text = buf.toString('utf8').trim();
    throw new Error(`camera did not return JPEG: ${text.slice(0, 120)}`);
  }
  return buf;
}

// ─── Session management ────────────────────────────────────
async function ensureClaimed(camId: string, host: string): Promise<string> {
  const sess = getSession(camId);
  if (sess.sessionId && sess.claimed) return sess.sessionId;

  const c = client(host);
  if (!sess.sessionId) {
    const open = await c.get('/open.cgi', { responseType: 'text' });
    const body = String(open.data);
    assertNotErrorBody(body);
    const kv = parseKv(body);
    // open.cgi puts the session id in `s:=...` on the first line.
    const sid = kv['s'] ?? null;
    if (!sid) throw new Error('canon open.cgi returned no session id');
    sess.sessionId = sid;
  }
  const claimRes = await c.get('/claim.cgi', {
    params: { s: sess.sessionId },
    responseType: 'text',
  });
  assertNotErrorBody(String(claimRes.data));
  sess.claimed = true;
  log.info({ camId, sessionId: sess.sessionId }, 'canon control claimed');
  return sess.sessionId;
}

export async function claim(camId: string, host: string): Promise<void> {
  await ensureClaimed(camId, host);
}

export async function release(camId: string, host: string): Promise<void> {
  const c = client(host);
  const sess = getSession(camId);
  if (!sess.sessionId) return;
  try {
    if (sess.claimed) await c.get('/yield.cgi', { params: { s: sess.sessionId } }).catch(() => {});
    await c.get('/close.cgi', { params: { s: sess.sessionId } }).catch(() => {});
  } finally {
    sess.sessionId = null;
    sess.claimed = false;
    log.info({ camId }, 'canon control released');
  }
}

async function sendControl(camId: string, host: string, param: string, value: string | number): Promise<void> {
  const sid = await ensureClaimed(camId, host);
  const res = await client(host).get('/control.cgi', {
    params: { s: sid, [param]: String(value) },
    responseType: 'text',
  });
  assertNotErrorBody(String(res.data));
}

// Canon control params are absolute positions, so nudging means fetch + add + send.
async function adjust(camId: string, host: string, param: 'c.1.pan' | 'c.1.tilt' | 'c.1.zoom', delta: number, min: number, max: number): Promise<void> {
  const info = await getInfo(host);
  const current = param === 'c.1.pan' ? info.panPos : param === 'c.1.tilt' ? info.tiltPos : info.zoomPos;
  const target = Math.max(min, Math.min(max, current + delta));
  await sendControl(camId, host, param, target);
}

// ─── PTZ ───────────────────────────────────────────────────
type PtzAction = 'pan-left' | 'pan-right' | 'tilt-up' | 'tilt-down';

export async function ptz(camId: string, host: string, action: PtzAction): Promise<void> {
  switch (action) {
    case 'pan-left':
      await adjust(camId, host, 'c.1.pan', -PAN_STEP, -17000, 17000);
      break;
    case 'pan-right':
      await adjust(camId, host, 'c.1.pan', +PAN_STEP, -17000, 17000);
      break;
    case 'tilt-up':
      await adjust(camId, host, 'c.1.tilt', +TILT_STEP, -3000, 10000);
      break;
    case 'tilt-down':
      await adjust(camId, host, 'c.1.tilt', -TILT_STEP, -3000, 10000);
      break;
  }
  log.info({ camId, action }, 'canon ptz');
}

export async function zoom(camId: string, host: string, direction: 'in' | 'out'): Promise<void> {
  // CR-N300: c.1.zoom.min (340) is actually the most-telephoto end; increasing
  // the value widens the field of view. So `in` means *decrease* c.1.zoom.
  await adjust(camId, host, 'c.1.zoom', direction === 'in' ? -ZOOM_STEP : +ZOOM_STEP, 340, 6340);
  log.info({ camId, direction }, 'canon zoom');
}

// "Home" → pan 0, tilt 0, modest zoom.
export async function home(camId: string, host: string): Promise<void> {
  await sendControl(camId, host, 'c.1.pan', 0);
  await sendControl(camId, host, 'c.1.tilt', 0);
  await sendControl(camId, host, 'c.1.zoom', 1000);
  log.info({ camId }, 'canon home');
}

// Absolute move — used by preset recall to jump every camera to a saved spot.
export async function moveTo(camId: string, host: string, pan: number, tilt: number, zoom: number): Promise<void> {
  await sendControl(camId, host, 'c.1.pan', Math.max(-17000, Math.min(17000, pan)));
  await sendControl(camId, host, 'c.1.tilt', Math.max(-3000, Math.min(10000, tilt)));
  await sendControl(camId, host, 'c.1.zoom', Math.max(340, Math.min(6340, zoom)));
  log.info({ camId, pan, tilt, zoom }, 'canon moveTo');
}

export async function setStandby(host: string, on: boolean): Promise<void> {
  // cmd=idle wakes, cmd=standby sleeps. Reference doc's on|off is rejected.
  const res = await client(host).get('/standby.cgi', {
    params: { cmd: on ? 'standby' : 'idle' },
    responseType: 'text',
  });
  assertNotErrorBody(String(res.data));
  log.info({ host, on }, 'canon standby');
}

export async function setAutoTrack(camId: string, host: string, enabled: boolean): Promise<void> {
  await sendControl(camId, host, 'c.1.focus.auto.track', enabled ? 'on' : 'off');
  log.info({ camId, enabled }, 'canon autotrack');
}
