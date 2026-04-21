// ──────────────────────────────────────────────────────────
//  Logitech Sync Cloud API client.
//
//  Auth: mTLS (client certificate + private key).
//  Base: https://api.sync.logitech.com/v1
//  Docs: https://api.sync.logitech.com/v1/openapi.yaml (the OpenAPI spec)
//
//  One endpoint is all we use right now:
//    GET /org/{orgId}/place → every room + device with live status.
//
//  We poll this every SYNC_POLL_INTERVAL_MS (default 60s) — well below
//  the 10 req/sec + 14,400/day rate limit — and cache the result in
//  memory keyed by Rally Bar IP + MAC so the device manager can match
//  its fixture Rally Bars against Sync's live data.
// ──────────────────────────────────────────────────────────
import axios, { AxiosInstance } from 'axios';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger.child({ svc: 'logitech-sync' });

export interface SyncDeviceLive {
  roomName: string;
  roomLocation: string;
  deviceType: 'Logitech' | 'Computer' | 'Generic';
  name: string; // "Rally Bar", "Tap", "Sight", etc.
  serial?: string;
  firmware?: string;
  status: 'Offline' | 'Online' | 'InUse';
  health: 'NoIssues' | 'Warning' | 'Error';
  ip?: string;
  mac?: string;
  hostName?: string;
  peripherals?: Record<string, { expected: number; actual: number }>;
  lastSeen?: number;
  occupancy?: number; // room-level — propagated to each device for easy lookup
}

let cached: { fetchedAt: number; devices: SyncDeviceLive[] } | null = null;
let httpClient: AxiosInstance | null = null;

function client(): AxiosInstance {
  if (httpClient) return httpClient;
  const certPath = resolve(process.cwd(), config.sync.certPath);
  const keyPath = resolve(process.cwd(), config.sync.keyPath);
  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);
  httpClient = axios.create({
    baseURL: 'https://api.sync.logitech.com/v1',
    httpsAgent: new https.Agent({ cert, key, keepAlive: true }),
    timeout: 10000,
    headers: { Accept: 'application/json' },
  });
  return httpClient;
}

interface RawDevice {
  id: string;
  type: 'Logitech' | 'Computer' | 'Generic';
  name?: string;
  version?: string;
  serial?: string;
  status?: 'Offline' | 'Online' | 'InUse';
  healthStatus?: 'NoIssues' | 'Warning' | 'Error';
  network?: { ip?: string; mac?: string; hostName?: string };
  peripherals?: Record<string, { count?: { expected?: number; actual?: number } }>;
  lastSeen?: number;
}

interface RawRoom {
  id: string;
  type: 'Room' | 'Desk';
  name?: string;
  location?: string;
  occupancy?: number;
  devices?: RawDevice[];
}

// Flatten the Sync response: one row per device (not per room) — the shape
// our device manager wants to iterate over.
function flatten(rooms: RawRoom[]): SyncDeviceLive[] {
  const out: SyncDeviceLive[] = [];
  for (const r of rooms) {
    if (r.type !== 'Room') continue;
    for (const d of r.devices ?? []) {
      const peripherals: Record<string, { expected: number; actual: number }> = {};
      for (const [k, v] of Object.entries(d.peripherals ?? {})) {
        if (v?.count) peripherals[k] = { expected: v.count.expected ?? 0, actual: v.count.actual ?? 0 };
      }
      out.push({
        roomName: r.name ?? '(unnamed)',
        roomLocation: r.location ?? '',
        deviceType: d.type,
        name: d.name ?? d.type,
        serial: d.serial,
        firmware: d.version,
        status: d.status ?? 'Offline',
        health: d.healthStatus ?? 'NoIssues',
        ip: d.network?.ip,
        mac: d.network?.mac?.toLowerCase(),
        hostName: d.network?.hostName,
        peripherals: Object.keys(peripherals).length > 0 ? peripherals : undefined,
        lastSeen: d.lastSeen,
        occupancy: r.occupancy,
      });
    }
  }
  return out;
}

export async function refresh(): Promise<SyncDeviceLive[]> {
  const orgId = config.sync.orgId;
  if (!orgId) throw new Error('SYNC_ORG_ID not configured');
  const c = client();
  // Include peripherals + device network info in the projection.
  const projection = 'place.info,place.occupancy,place.device,place.device.info,place.device.status';
  const res = await c.get(`/org/${orgId}/place`, { params: { projection, unlicensed: true } });
  const devices = flatten(res.data?.places ?? []);
  cached = { fetchedAt: Date.now(), devices };
  log.info({ count: devices.length, rooms: new Set(devices.map((d) => d.roomName)).size }, 'sync places refreshed');
  return devices;
}

export function getCached(): SyncDeviceLive[] {
  return cached?.devices ?? [];
}

// Fast lookup helpers — device manager calls these on every Rally Bar
// refresh to merge live Sync data with ping results.
export function findByIp(ip: string): SyncDeviceLive | undefined {
  return getCached().find((d) => d.ip === ip);
}

export function findByMac(mac: string): SyncDeviceLive | undefined {
  const lower = mac.toLowerCase();
  return getCached().find((d) => d.mac === lower);
}

// Periodic refresh loop — kicks off once when the server boots.
let pollHandle: NodeJS.Timeout | null = null;
export function startPolling(): void {
  if (!config.sync.orgId) {
    log.info('SYNC_ORG_ID not set — Sync polling disabled');
    return;
  }
  if (pollHandle) return;
  const run = async () => {
    try {
      await refresh();
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'sync refresh failed');
    }
  };
  void run();
  pollHandle = setInterval(() => void run(), config.sync.pollIntervalMs);
  log.info({ intervalMs: config.sync.pollIntervalMs }, 'sync polling started');
}

export function stopPolling(): void {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}
