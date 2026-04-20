// ──────────────────────────────────────────────────────────
//  Canon CR-N300 / XC HTTP CGI client.
//  See ~/Projects/classroom-dashboard/canon-xc-api-reference.md
//
//  Base: http://<host>/-wvhttp-01-/
//  Auth: HTTP Basic
//
//  Session lifecycle:
//    open.cgi → claim.cgi → operate → yield.cgi → close.cgi
//  Each camera has at most one session at a time.
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

// Parse the simple key=value response Canon returns from CGIs.
function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

// ─── Reads ─────────────────────────────────────────────────
export async function getInfo(host: string): Promise<CanonInfo> {
  const res = await client(host).get('/info.cgi', { responseType: 'text' });
  const kv = parseKv(String(res.data));
  // `f.standby` is the authoritative power-state key: 'standby' or 'idle'.
  // When the camera is in standby, `c.1.power` is absent entirely, so the
  // old `kv['c.1.power'] !== 'off'` check reported every standby cam as on.
  const inStandby = kv['f.standby'] === 'standby';
  return {
    power: !inStandby,
    panPos: Number(kv['c.1.pt.pan.position'] ?? 0),
    tiltPos: Number(kv['c.1.pt.tilt.position'] ?? 0),
    zoomPos: Number(kv['c.1.zoom.position'] ?? 0),
    autoTrack: kv['c.1.tracking.mode'] === 'on',
    livescopeStatus: inStandby ? 509 : Number(kv['s.livescope.status'] ?? 0),
    livescopeMsg: inStandby ? 'Standby' : (kv['s.livescope.message'] ?? 'OK'),
  };
}

// Canon returns 200 with a short ASCII error body ("--- WebView Livescope
// Http Server Error --- Standby") when the camera isn't serving live video.
// Detect by JPEG magic bytes (FF D8) and surface a real error upstream.
export async function snapshot(host: string): Promise<Buffer> {
  // NB: the XC API reference says /image.cgi?w=1 but on CR-N300 firmware 1.7.0
  // that returns "Invalid Parameter Value parameter=w". Calling bare /image.cgi
  // returns a real 1280x720 JPEG.
  const res = await client(host).get('/image.cgi', { responseType: 'arraybuffer' });
  const buf = Buffer.from(res.data as ArrayBuffer);
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    const text = buf.toString('utf8').trim();
    throw new Error(`camera did not return JPEG: ${text.slice(0, 120)}`);
  }
  return buf;
}

// ─── Session management ────────────────────────────────────
export async function claim(camId: string, host: string): Promise<void> {
  const c = client(host);
  const sess = getSession(camId);
  if (!sess.sessionId) {
    const open = await c.get('/open.cgi', { responseType: 'text' });
    const kv = parseKv(String(open.data));
    sess.sessionId = kv['s.session.id'] ?? null;
  }
  if (sess.sessionId) {
    await c.get(`/claim.cgi?s.session.id=${sess.sessionId}`);
    sess.claimed = true;
    log.info({ camId, sessionId: sess.sessionId }, 'canon control claimed');
  }
}

export async function release(camId: string, host: string): Promise<void> {
  const c = client(host);
  const sess = getSession(camId);
  if (!sess.sessionId) return;
  try {
    await c.get(`/yield.cgi?s.session.id=${sess.sessionId}`);
    await c.get(`/close.cgi?s.session.id=${sess.sessionId}`);
  } finally {
    sess.sessionId = null;
    sess.claimed = false;
    log.info({ camId }, 'canon control released');
  }
}

// ─── PTZ ───────────────────────────────────────────────────
type PtzAction = 'pan-left' | 'pan-right' | 'tilt-up' | 'tilt-down';

export async function ptz(camId: string, host: string, action: PtzAction): Promise<void> {
  const sess = getSession(camId);
  if (!sess.sessionId) await claim(camId, host);
  const params: Record<string, string> = { 's.session.id': sess.sessionId ?? '' };
  switch (action) {
    case 'pan-left':
      params['c.1.pt.pan.target'] = '-100';
      break;
    case 'pan-right':
      params['c.1.pt.pan.target'] = '+100';
      break;
    case 'tilt-up':
      params['c.1.pt.tilt.target'] = '+50';
      break;
    case 'tilt-down':
      params['c.1.pt.tilt.target'] = '-50';
      break;
  }
  await client(host).get('/control.cgi', { params });
  log.info({ camId, action }, 'canon ptz');
}

export async function zoom(camId: string, host: string, direction: 'in' | 'out'): Promise<void> {
  const sess = getSession(camId);
  if (!sess.sessionId) await claim(camId, host);
  await client(host).get('/control.cgi', {
    params: {
      's.session.id': sess.sessionId ?? '',
      'c.1.zoom.target': direction === 'in' ? '+200' : '-200',
    },
  });
  log.info({ camId, direction }, 'canon zoom');
}

export async function home(camId: string, host: string): Promise<void> {
  const sess = getSession(camId);
  if (!sess.sessionId) await claim(camId, host);
  await client(host).get('/control.cgi', {
    params: {
      's.session.id': sess.sessionId ?? '',
      'c.1.preset.recall': 'home',
    },
  });
  log.info({ camId }, 'canon home preset');
}

// `on=true` → put the camera to sleep, `on=false` → wake it.
// CR-N300 firmware 1.7.0 accepts cmd=idle (wake) and cmd=standby (sleep).
// The reference doc's cmd=on|off is rejected as "Invalid Parameter Value".
export async function setStandby(host: string, on: boolean): Promise<void> {
  await client(host).get('/standby.cgi', { params: { cmd: on ? 'standby' : 'idle' } });
  log.info({ host, on }, 'canon standby');
}

export async function setAutoTrack(camId: string, host: string, enabled: boolean): Promise<void> {
  const sess = getSession(camId);
  if (!sess.sessionId) await claim(camId, host);
  await client(host).get('/control.cgi', {
    params: {
      's.session.id': sess.sessionId ?? '',
      'c.1.tracking.mode': enabled ? 'on' : 'off',
    },
  });
  log.info({ camId, enabled }, 'canon autotrack');
}
