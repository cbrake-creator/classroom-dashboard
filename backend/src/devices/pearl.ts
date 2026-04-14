// ──────────────────────────────────────────────────────────
//  Epiphan Pearl 2 — REST API v2.0 client.
//  Docs: https://epiphan-video.github.io/pearl_api_swagger_ui/
//
//  Auth: HTTP Basic
//  Base: http://<host>/api/v2.0
//
//  All methods return shapes that match the PearlDevice type
//  (or partials thereof). Errors throw — the caller (deviceManager)
//  decides how to handle them (mark offline, fall back, etc.).
// ──────────────────────────────────────────────────────────
import axios, { AxiosInstance } from 'axios';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { PearlChannel, PearlPublisher, PearlRecorder, PearlSource } from '../types.js';

const log = logger.child({ device: 'pearl' });

function client(): AxiosInstance {
  return axios.create({
    baseURL: `http://${config.pearl.host}/api/v2.0`,
    timeout: config.deviceHttpTimeoutMs,
    auth: { username: config.pearl.username, password: config.pearl.password },
    headers: { Accept: 'application/json' },
  });
}

// ─── Reads ─────────────────────────────────────────────────
export async function getSystemStatus(): Promise<{
  cpu: number;
  temp: number;
  uptime: string;
  firmware: string;
}> {
  const c = client();
  // Pearl exposes /system/status, /system/info — we coalesce.
  const [statusRes, infoRes] = await Promise.all([
    c.get('/system/status'),
    c.get('/system/info'),
  ]);
  const s = statusRes.data?.result ?? statusRes.data ?? {};
  const i = infoRes.data?.result ?? infoRes.data ?? {};
  return {
    cpu: Number(s.cpuLoad ?? s.cpu ?? 0),
    temp: Number(s.cpuTemp ?? s.temperature ?? 0),
    uptime: String(s.uptime ?? s.systemUptime ?? '—'),
    firmware: String(i.firmwareVersion ?? i.version ?? '—'),
  };
}

export async function getStorage(): Promise<{ freeGb: number; totalGb: number }> {
  const c = client();
  const res = await c.get('/system/storage');
  const s = res.data?.result ?? res.data ?? {};
  // Pearl returns bytes; convert.
  const total = Number(s.totalSpace ?? s.total ?? 0);
  const free = Number(s.freeSpace ?? s.free ?? 0);
  return {
    totalGb: Math.round(total / 1e9),
    freeGb: Math.round(free / 1e9),
  };
}

export async function getChannels(): Promise<PearlChannel[]> {
  const c = client();
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

export async function getRecorders(): Promise<PearlRecorder[]> {
  const c = client();
  const res = await c.get('/recorders');
  const list = (res.data?.result ?? res.data ?? []) as Array<Record<string, unknown>>;
  return Promise.all(
    list.map(async (r) => {
      const id = Number(r.id);
      const status = await c
        .get(`/recorders/${id}/status`)
        .then((rr) => rr.data?.result ?? rr.data ?? {})
        .catch(() => ({}));
      return {
        id,
        name: String(r.name ?? `Recorder ${id}`),
        state: (status.state ?? 'stopped') as PearlRecorder['state'],
        durationSec: Number(status.duration ?? 0),
      };
    }),
  );
}

export async function getPublishers(channelId: number): Promise<PearlPublisher[]> {
  const c = client();
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

export async function getSources(): Promise<PearlSource[]> {
  const c = client();
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
export async function startRecorder(id: number): Promise<void> {
  await client().post(`/recorders/${id}/control/start`);
  log.info({ id }, 'pearl recorder start');
}

export async function stopRecorder(id: number): Promise<void> {
  await client().post(`/recorders/${id}/control/stop`);
  log.info({ id }, 'pearl recorder stop');
}

export async function startPublisher(channelId: number, publisherId: number): Promise<void> {
  await client().post(`/channels/${channelId}/publishers/${publisherId}/control/start`);
  log.info({ channelId, publisherId }, 'pearl publisher start');
}

export async function stopPublisher(channelId: number, publisherId: number): Promise<void> {
  await client().post(`/channels/${channelId}/publishers/${publisherId}/control/stop`);
  log.info({ channelId, publisherId }, 'pearl publisher stop');
}

export async function setChannelLayout(channelId: number, layoutId: number): Promise<void> {
  await client().post(`/channels/${channelId}/layouts/${layoutId}/activate`);
  log.info({ channelId, layoutId }, 'pearl layout switch');
}
