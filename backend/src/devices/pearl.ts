// ──────────────────────────────────────────────────────────
//  Epiphan Pearl 2 — REST API v2.0 client.
//  Docs: https://epiphan-video.github.io/pearl_api_swagger_ui/
//
//  Auth: HTTP Basic
//  Base: http://<host>/api/v2.0
//
//  Every call takes `host` as the first argument because DTS has
//  multiple Pearls on the network (Todd 313/315/317 classrooms
//  plus Tech Talks). Callers pass the per-device IP.
// ──────────────────────────────────────────────────────────
import axios, { AxiosInstance } from 'axios';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { PearlChannel, PearlPublisher, PearlRecorder, PearlSource } from '../types.js';

const log = logger.child({ device: 'pearl' });

function client(host: string): AxiosInstance {
  return axios.create({
    baseURL: `http://${host}/api/v2.0`,
    timeout: config.deviceHttpTimeoutMs,
    auth: { username: config.pearl.username, password: config.pearl.password },
    headers: { Accept: 'application/json' },
  });
}

// ─── Reads ─────────────────────────────────────────────────
export async function getSystemStatus(host: string): Promise<{
  cpu: number;
  temp: number;
  uptime: string;
  firmware: string;
}> {
  const c = client(host);
  const [statusRes, infoRes] = await Promise.all([
    c.get('/system/status'),
    c.get('/system/info').catch(() => ({ data: {} })),
  ]);
  const s = statusRes.data?.result ?? statusRes.data ?? {};
  const i = infoRes.data?.result ?? infoRes.data ?? {};
  // Pearl 2 firmware 4.x returns `cpuload` (lowercase, no camel) and `cputemp`.
  const uptimeSec = Number(s.uptime ?? s.systemUptime ?? 0);
  const uptimeStr = uptimeSec
    ? `${Math.floor(uptimeSec / 86400)}d ${Math.floor((uptimeSec % 86400) / 3600)}h`
    : String(s.uptime ?? '—');
  return {
    cpu: Number(s.cpuload ?? s.cpuLoad ?? s.cpu ?? 0),
    temp: Number(s.cputemp ?? s.cpuTemp ?? s.temperature ?? 0),
    uptime: uptimeStr,
    firmware: String(i.firmwareVersion ?? i.version ?? '—'),
  };
}

export async function getStorage(host: string): Promise<{ freeGb: number; totalGb: number }> {
  const c = client(host);
  const res = await c.get('/system/storage').catch(() => ({ data: {} }));
  const s = (res as { data?: { result?: Record<string, unknown> } }).data?.result ?? {};
  const total = Number(s.totalSpace ?? s.total ?? 0);
  const free = Number(s.freeSpace ?? s.free ?? 0);
  return {
    totalGb: Math.round(total / 1e9),
    freeGb: Math.round(free / 1e9),
  };
}

export async function getChannels(host: string): Promise<PearlChannel[]> {
  const c = client(host);
  const res = await c.get('/channels');
  const list = (res.data?.result ?? res.data ?? []) as Array<Record<string, unknown>>;
  return Promise.all(
    list.map(async (ch) => {
      const id = Number(ch.id);
      const status = await c
        .get(`/channels/${id}/status`)
        .then((r) => r.data?.result ?? r.data ?? {})
        .catch(() => ({}));
      return {
        id,
        name: String(ch.name ?? `Channel ${id}`),
        encoderState: (status.state ?? 'stopped') as PearlChannel['encoderState'],
        fps: Number(status.framerate ?? status.fps ?? 0),
        bitrateKbps: Math.round(Number(status.bitrate ?? 0) / 1000),
        currentLayout: String(status.activeLayout ?? '—'),
      };
    }),
  );
}

export async function getRecorders(host: string): Promise<PearlRecorder[]> {
  const c = client(host);
  const res = await c.get('/recorders');
  const list = (res.data?.result ?? res.data ?? []) as Array<Record<string, unknown>>;
  return Promise.all(
    list.map(async (r) => {
      const id = Number(r.id);
      const status = await c
        .get(`/recorders/${id}/status`)
        .then((rr) => rr.data?.result ?? rr.data ?? {})
        .catch(() => ({}));
      // Pearl firmware 4.x reports state as 'started' | 'stopped'. Normalize
      // to the PearlRecorder 'recording' | 'stopped' enum the dashboard uses.
      const raw = String(status.state ?? 'stopped');
      const state: PearlRecorder['state'] = raw === 'started' ? 'recording' : 'stopped';
      return {
        id,
        name: String(r.name ?? `Recorder ${id}`),
        state,
        durationSec: Number(status.duration ?? 0),
      };
    }),
  );
}

export async function getPublishers(host: string, channelId: number): Promise<PearlPublisher[]> {
  const c = client(host);
  const res = await c.get(`/channels/${channelId}/publishers`);
  const list = (res.data?.result ?? res.data ?? []) as Array<Record<string, unknown>>;
  return list.map((p) => {
    const status = (p.status as Record<string, unknown> | undefined) ?? {};
    return {
      id: Number(p.id),
      channelId,
      type: String(p.type ?? '—'),
      destination: String(p.name ?? p.url ?? '—'),
      state: (status.state ?? p.state ?? 'stopped') as PearlPublisher['state'],
    };
  });
}

export async function getSources(host: string): Promise<PearlSource[]> {
  const c = client(host);
  const res = await c.get('/sources');
  const list = (res.data?.result ?? res.data ?? []) as Array<Record<string, unknown>>;
  return list.map((s) => ({
    id: String(s.id),
    name: String(s.name ?? s.id),
    connected: Boolean(s.signal ?? s.connected ?? false),
    label: String(s.label ?? s.name ?? '—'),
  }));
}

// ─── Writes / commands ─────────────────────────────────────
// One-touch recording: Pearl has a batch endpoint that starts/stops every
// recorder in parallel — matches the hardware button on the front of the
// device. Use this instead of looping if you want all recorders to start
// at exactly the same moment.
export async function startAllRecorders(host: string): Promise<void> {
  await client(host).post('/recorders/control/start');
  log.info({ host }, 'pearl one-touch record start');
}

export async function stopAllRecorders(host: string): Promise<void> {
  await client(host).post('/recorders/control/stop');
  log.info({ host }, 'pearl one-touch record stop');
}

export async function startRecorder(host: string, id: number): Promise<void> {
  await client(host).post(`/recorders/${id}/control/start`);
  log.info({ host, id }, 'pearl recorder start');
}

export async function stopRecorder(host: string, id: number): Promise<void> {
  await client(host).post(`/recorders/${id}/control/stop`);
  log.info({ host, id }, 'pearl recorder stop');
}

export async function startPublisher(host: string, channelId: number, publisherId: number): Promise<void> {
  await client(host).post(`/channels/${channelId}/publishers/${publisherId}/control/start`);
  log.info({ host, channelId, publisherId }, 'pearl publisher start');
}

export async function stopPublisher(host: string, channelId: number, publisherId: number): Promise<void> {
  await client(host).post(`/channels/${channelId}/publishers/${publisherId}/control/stop`);
  log.info({ host, channelId, publisherId }, 'pearl publisher stop');
}

export async function setChannelLayout(host: string, channelId: number, layoutId: number): Promise<void> {
  await client(host).post(`/channels/${channelId}/layouts/${layoutId}/activate`);
  log.info({ host, channelId, layoutId }, 'pearl layout switch');
}

// ─── Archive (recorded files) ──────────────────────────────
export interface PearlArchiveFile {
  id: string;           // Pearl's internal file id, URL-encoded into stream path
  name: string;         // friendly display name
  recorderId: number;
  extension: string;
  created: string;      // ISO-ish from Pearl
  duration: number;     // seconds
  sizeBytes: number;
  recording: boolean;   // still being written
}

export async function listArchive(host: string, recorderIds: number[]): Promise<PearlArchiveFile[]> {
  const c = client(host);
  const all: PearlArchiveFile[] = [];
  await Promise.all(
    recorderIds.map(async (id) => {
      try {
        const res = await c.get(`/recorders/${id}/archive/files`);
        const list = (res.data?.result ?? []) as Array<Record<string, unknown>>;
        for (const f of list) {
          all.push({
            id: String(f.id),
            name: String(f.name ?? f.id),
            recorderId: id,
            extension: String(f.extension ?? 'mp4'),
            created: String(f.created ?? ''),
            duration: Number(f.duration ?? 0),
            sizeBytes: Number(f.size ?? 0),
            recording: Boolean(f.recording ?? false),
          });
        }
      } catch {
        // skip recorder on failure
      }
    }),
  );
  // Newest first.
  all.sort((a, b) => (b.created > a.created ? 1 : -1));
  return all;
}
