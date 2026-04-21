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
import { createHash } from 'node:crypto';
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
  const run = async () => {
    const sid = await ensureClaimed(camId, host);
    const res = await client(host).get('/control.cgi', {
      params: { s: sid, [param]: String(value) },
      responseType: 'text',
    });
    assertNotErrorBody(String(res.data));
  };
  try {
    await run();
  } catch (err) {
    // The camera purges sessions after reboot / timeout / when another
    // client claims. Detect "Unknown Connection ID", drop our cached
    // session, open a new one, and retry once.
    const msg = (err as Error).message ?? '';
    if (/Unknown Connection ID|Invalid Session/i.test(msg)) {
      log.warn({ camId, msg }, 'canon session invalid — re-opening');
      const sess = getSession(camId);
      sess.sessionId = null;
      sess.claimed = false;
      await run();
      return;
    }
    throw err;
  }
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

// ─── Auto Tracking app (Canon RA-AT001) ────────────────────
//
// Canon Auto Tracking is a licensed ADD-ON APPLICATION that runs on the
// camera, exposed under `/cgi-addon/Auto_Tracking_RA-AT001/app_ctrl/*.cgi`
// with HTTP Digest auth (not Basic). The app is pre-installed on every
// CR-N300 but needs a valid license to start. When running and licensed,
// it drives pan/tilt/zoom itself to follow a detected subject.
//
// This is completely separate from `c.1.focus.auto.track` which is a
// focus-AF parameter (subject-sharpness follow, not camera-movement
// follow). The original dashboard button wrote the focus key and silently
// failed — never moved the camera.
//
// Endpoints (see /app_ctrl/get_capability.cgi for the full list):
//   get_config.cgi   → { trackingEnable: "0"|"1", zoomControlEnable, ... }
//   update_config.cgi?trackingEnable=N → toggle
//   track_info.cgi   → live subject-detection + PTZ state (~20 fields)
//   save_config.cgi  → persist current config across reboots

export interface AutoTrackStatus {
  available: boolean;      // app is running AND license valid
  enabled: boolean;        // trackingEnable=1 (tracking is actively on)
  startupReason?: string;  // when available=false, human-readable why
}

// Manual Digest auth — axios/node don't ship with it. Two round-trips:
// first 401 carries the challenge, second includes the computed response.
// `params` get URL-encoded onto the path for the signed URI.
async function digestRequest<T = unknown>(
  host: string,
  pathAndQuery: string,
): Promise<T> {
  const url = `http://${host}${pathAndQuery}`;
  const first = await axios.get(url, { validateStatus: () => true });
  if (first.status === 200) return first.data as T;
  if (first.status !== 401) {
    throw new Error(`digest: unexpected ${first.status}: ${typeof first.data === 'string' ? first.data.slice(0, 200) : JSON.stringify(first.data).slice(0, 200)}`);
  }
  const auth = String(first.headers['www-authenticate'] ?? '');
  if (!auth.toLowerCase().startsWith('digest ')) {
    throw new Error(`digest: no challenge (got ${auth || 'empty'})`);
  }
  const parts: Record<string, string> = {};
  for (const m of auth.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,]+))/g)) {
    parts[m[1]!] = m[2] ?? m[3] ?? '';
  }
  const user = config.canonAuth.username;
  const pass = config.canonAuth.password;
  const realm = parts.realm ?? '';
  const nonce = parts.nonce ?? '';
  const qop = parts.qop ?? '';
  const opaque = parts.opaque;
  const md5 = (s: string) => createHash('md5').update(s).digest('hex');
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`GET:${pathAndQuery}`);
  const nc = '00000001';
  const cnonce = Math.random().toString(16).slice(2, 10);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  const header =
    `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${pathAndQuery}", ` +
    `response="${response}", algorithm=MD5` +
    (qop ? `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"` : '') +
    (opaque ? `, opaque="${opaque}"` : '');
  const second = await axios.get(url, {
    headers: { Authorization: header },
    validateStatus: () => true,
  });
  if (second.status !== 200) {
    const body = typeof second.data === 'string' ? second.data : JSON.stringify(second.data);
    throw new Error(`digest: ${second.status} ${body.slice(0, 200)}`);
  }
  return second.data as T;
}

// Back-compat alias.
async function digestGet<T = unknown>(host: string, path: string): Promise<T> {
  return digestRequest<T>(host, path);
}

export async function getAutoTrackStatus(host: string): Promise<AutoTrackStatus> {
  try {
    const cfg = await digestGet<Record<string, unknown>>(
      host,
      '/cgi-addon/Auto_Tracking_RA-AT001/app_ctrl/get_config.cgi',
    );
    const enabled = String(cfg.trackingEnable ?? '0') === '1';
    return { available: true, enabled };
  } catch (err) {
    const msg = (err as Error).message ?? '';
    // 409 "application must be started" means app is installed but not
    // running (unlicensed, or manually stopped).
    if (msg.includes('409') || /must be started/i.test(msg)) {
      return { available: false, enabled: false, startupReason: 'not running (license required)' };
    }
    return { available: false, enabled: false, startupReason: msg };
  }
}

// Toggle Canon Auto Tracking app (RA-AT001) via its /app_ctrl endpoint.
// `update_config.cgi?trackingEnable=0|1` is live-effective AND survives
// via an implicit save on the camera side (confirmed by reading back
// get_config after a power-cycle during earlier testing).
export async function setAutoTrack(camId: string, host: string, enabled: boolean): Promise<void> {
  const v = enabled ? '1' : '0';
  const path = `/cgi-addon/Auto_Tracking_RA-AT001/app_ctrl/update_config.cgi?trackingEnable=${v}`;
  const result = await digestRequest<{ status_code: string; description: string }>(host, path);
  if (result.status_code && result.status_code !== 'G0_100') {
    throw new Error(`autotrack: ${result.status_code} ${result.description ?? ''}`);
  }
  log.info({ camId, host, enabled }, 'canon autotrack set');
}
