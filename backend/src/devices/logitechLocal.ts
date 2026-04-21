// ──────────────────────────────────────────────────────────
//  Logitech CollabOS local Device Management API (v1.0).
//
//  Runs on each Rally Bar / Rally Bar Mini at https://<ip>/api/v1/*
//  when Local Network Access has been enabled via the Sync Portal
//  (Device → System → Local Network Access → Enable).
//
//  Auth: POST /signin returns a JWT valid 15 minutes. We cache it
//  per device with a 13-minute TTL and auto-refresh on 401.
//
//  Endpoints used (all GET after signin):
//    /device             → collabOSVersion, modelName, serial, hostname
//    /peripherals        → remotes, sights, displays, Tap controllers, USB
//    /insights/device    → deviceState (IDLE/AUDIO_ONLY/IN_USE), mic/speaker
//    /insights/room      → occupancy count + environmental (CollabOS 1.15+)
//
//  Rate limits per device: signin 5/min, others 10/min. We're well under.
// ──────────────────────────────────────────────────────────
import axios, { AxiosInstance } from 'axios';
import https from 'node:https';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger.child({ svc: 'logi-local' });

// Reject self-signed cert? No — CollabOS ships a self-signed cert per device,
// installing per-device trust across 15 Rally Bars is not realistic. We're on
// a trusted LAN anyway.
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

interface TokenEntry {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, TokenEntry>();
const TOKEN_TTL_MS = 13 * 60 * 1000;

function client(ip: string, headers: Record<string, string> = {}): AxiosInstance {
  return axios.create({
    baseURL: `https://${ip}`,
    httpsAgent: agent,
    timeout: 5000,
    headers: { 'Content-Type': 'application/json', ...headers },
    validateStatus: () => true,
  });
}

async function signIn(ip: string): Promise<string> {
  const { username, password } = config.logitechLocal;
  if (!username || !password) throw new Error('LOGI_LOCAL_USERNAME / PASSWORD not configured');
  const res = await client(ip).post('/api/v1/signin', { username, password });
  if (res.status !== 200 || !res.data?.result?.auth_token) {
    throw new Error(`signin failed: ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  const token = String(res.data.result.auth_token);
  tokenCache.set(ip, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

async function ensureToken(ip: string): Promise<string> {
  const entry = tokenCache.get(ip);
  if (entry && entry.expiresAt > Date.now()) return entry.token;
  return signIn(ip);
}

// Authenticated GET with one-shot retry on 401 (token may have been revoked
// server-side before TTL — reset cache and try again).
async function authedGet<T = unknown>(ip: string, path: string): Promise<T> {
  let token = await ensureToken(ip);
  let res = await client(ip, { Authorization: `Bearer ${token}` }).get(path);
  if (res.status === 401) {
    tokenCache.delete(ip);
    token = await signIn(ip);
    res = await client(ip, { Authorization: `Bearer ${token}` }).get(path);
  }
  if (res.status !== 200) {
    throw new Error(`${path}: HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  return res.data?.result as T;
}

// ─── Typed shapes matching the OpenAPI spec ────────────────
export interface LocalDeviceConfig {
  collabOSVersion: string;
  deviceConfiguration: string;
  ethernetMAC: string;
  hwVersion: string;
  modelName: string;
  serialNumber: string;
  systemName: string;
  wifiMAC: string;
  deviceName: string;
  serviceProvider: string;
}

export interface LocalPeripherals {
  remotes: Array<{ macAddress: string; name: string }>;
  sights: Array<{ id: string; cameraConnected: boolean; microphoneConnected: boolean; firmwareVersion: string }>;
  displays: Array<{ id: number; hdmiPort: number; height: number; width: number; refreshRate: number }>;
  ipControllers: Array<{ name: string; manufacturer: string; firmwareVersion: string; serialNumber: string; ipAddress: string; deviceName: string }>;
  usbControllers: Array<{ name: string; manufacturer: string; firmwareVersion: string; swMcuVersion: string; hwMcuVersion: string; hdmiVersion: string; orientation: string }>;
  usbDevices: Array<{ id: string; isAudioDevice: boolean; isVideoDevice: boolean; audioFirmwareVersion: string; videoFirmwareVersion: string; name: string; pid: string; vid: string }>;
}

export interface LocalDeviceInsights {
  deviceState: 'IDLE' | 'AUDIO_ONLY' | 'IN_USE';
  micState: 'MUTED' | 'UNMUTED' | 'NOT_SUPPORTED';
  speakerState: 'MUTED' | 'UNMUTED' | 'NOT_SUPPORTED';
  speakerMaxVolume: number;
  speakerVolume: number;
}

export interface LocalRoomInsights {
  occupancyCount: number;
  occupancyMode: string;
  environmentalData?: {
    co2?: number;
    temp?: number;
    tvoc?: number;
    relativeHumidity?: number;
    pm10?: number;
    pm25?: number;
    pressure?: number;
    presence?: 'OCCUPIED' | 'UNOCCUPIED';
  };
}

// Per-(ip, path) response cache with configurable TTL. Rally Bars rate-limit
// at 10 non-signin calls/min/device; the dashboard's 5s poll × 4 endpoints
// × 15 devices would blow that budget instantly. TTLs are picked so a single
// Rally Bar sees at most ~6 calls/min (well under 10) even at steady state.
interface CacheEntry { value: unknown; expiresAt: number }
const respCache = new Map<string, CacheEntry>();

async function cachedGet<T>(ip: string, path: string, ttlMs: number): Promise<T> {
  const key = `${ip}${path}`;
  const hit = respCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await authedGet<T>(ip, path);
  respCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

// Static info — config + peripherals — rarely change. 5-minute cache.
const STATIC_TTL = 5 * 60 * 1000;
// Live state — device + room insights — want sub-minute fresh. 20s cache.
// At 15 devices × 2 endpoints / 20s = 9 calls/min/device, under 10/min limit.
const LIVE_TTL = 20 * 1000;

export const getDeviceConfig = (ip: string) => cachedGet<LocalDeviceConfig>(ip, '/api/v1/device', STATIC_TTL);
export const getPeripherals = (ip: string) => cachedGet<LocalPeripherals>(ip, '/api/v1/peripherals', STATIC_TTL);
export const getDeviceInsights = (ip: string) => cachedGet<LocalDeviceInsights>(ip, '/api/v1/insights/device', LIVE_TTL);
export const getRoomInsights = (ip: string) => cachedGet<LocalRoomInsights>(ip, '/api/v1/insights/room', LIVE_TTL);

// Aggregate: pull all 4 in parallel for a given Rally Bar IP. Used by the
// device manager to hydrate its refreshRallyBar result.
export interface LocalRallyBarState {
  config?: LocalDeviceConfig;
  peripherals?: LocalPeripherals;
  deviceInsights?: LocalDeviceInsights;
  roomInsights?: LocalRoomInsights;
  error?: string;
}

export async function getAll(ip: string): Promise<LocalRallyBarState> {
  try {
    const [cfg, per, dev, room] = await Promise.allSettled([
      getDeviceConfig(ip),
      getPeripherals(ip),
      getDeviceInsights(ip),
      getRoomInsights(ip),
    ]);
    return {
      config: cfg.status === 'fulfilled' ? cfg.value : undefined,
      peripherals: per.status === 'fulfilled' ? per.value : undefined,
      deviceInsights: dev.status === 'fulfilled' ? dev.value : undefined,
      roomInsights: room.status === 'fulfilled' ? room.value : undefined,
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// Is the local API reachable on this IP? Used to decide whether to skip
// when Local Network Access hasn't been enabled yet.
export async function available(ip: string): Promise<boolean> {
  try {
    await ensureToken(ip);
    return true;
  } catch {
    return false;
  }
}

export function clearTokenCache(): void {
  tokenCache.clear();
}
