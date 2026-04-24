// ──────────────────────────────────────────────────────────
//  Uptime tracking + per-device event log.
//
//  Every time deviceManager broadcasts a status change (online ↔ offline
//  ↔ unknown), we append one line to data/events.jsonl. The dashboard
//  computes uptime % over a window (default 7 days) by replaying that
//  log, alternating online/offline durations.
//
//  Append-only JSONL keeps things simple — no DB dependency, easy to
//  inspect manually (`cat data/events.jsonl | tail`). At ~150 transitions
//  per device per week worst case × 60 devices = ~9k lines/week, the
//  file is small (a few hundred KB after a year of operation).
// ──────────────────────────────────────────────────────────
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

const log = logger.child({ svc: 'uptime' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = resolve(__dirname, '..', '..', 'data');
const EVENT_LOG = resolve(DATA_DIR, 'events.jsonl');

mkdirSync(DATA_DIR, { recursive: true });

export type DeviceStatusKind = 'online' | 'offline' | 'unknown';

export interface DeviceEvent {
  ts: number;            // epoch ms
  campusId: string;
  roomId: string;
  deviceId: string;
  deviceType: string;
  status: DeviceStatusKind;
  lastError?: string;
  // Set true on the transition that ends a downtime window — useful for
  // counting "auto-recovered after reboot" later.
  recoveredAfter?: 'reboot' | 'natural';
}

// In-memory tracker of last-known status per device, used to detect
// transitions worth logging.
const lastStatus = new Map<string, DeviceStatusKind>();

// Cache of all events loaded at boot — small enough to keep in memory.
let eventsCache: DeviceEvent[] = [];

function loadCache(): void {
  if (!existsSync(EVENT_LOG)) {
    eventsCache = [];
    return;
  }
  try {
    const raw = readFileSync(EVENT_LOG, 'utf8');
    eventsCache = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as DeviceEvent);
    // Hydrate lastStatus from the most recent event per device.
    for (const e of eventsCache) {
      lastStatus.set(e.deviceId, e.status);
    }
    log.info({ count: eventsCache.length, deviceCount: lastStatus.size }, 'event log loaded');
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'failed to load event log; starting fresh');
    eventsCache = [];
  }
}

loadCache();

// Public API ────────────────────────────────────────────────

// Called by deviceManager whenever a device gets refreshed. Only logs
// transitions, not steady state.
export function recordStatus(opts: {
  campusId: string;
  roomId: string;
  deviceId: string;
  deviceType: string;
  status: DeviceStatusKind;
  lastError?: string | null;
}): void {
  const prev = lastStatus.get(opts.deviceId);
  if (prev === opts.status) return; // no change, don't log
  const event: DeviceEvent = {
    ts: Date.now(),
    campusId: opts.campusId,
    roomId: opts.roomId,
    deviceId: opts.deviceId,
    deviceType: opts.deviceType,
    status: opts.status,
    lastError: opts.lastError ?? undefined,
  };
  if (opts.status === 'online' && (prev === 'offline' || prev === 'unknown')) {
    event.recoveredAfter = 'natural';
  }
  appendFileSync(EVENT_LOG, JSON.stringify(event) + '\n');
  eventsCache.push(event);
  lastStatus.set(opts.deviceId, opts.status);
  log.debug({ deviceId: opts.deviceId, prev, next: opts.status }, 'status transition');
}

// Compute uptime % for a single device over a rolling time window.
// Returns { uptimePct, windowMs, downtimeMs, transitionCount }.
export function computeDeviceUptime(deviceId: string, windowMs: number = 7 * 24 * 60 * 60 * 1000): {
  uptimePct: number;
  downtimeMs: number;
  windowMs: number;
  transitionCount: number;
} {
  const now = Date.now();
  const windowStart = now - windowMs;
  const events = eventsCache
    .filter((e) => e.deviceId === deviceId && e.ts >= windowStart - 1000)
    .sort((a, b) => a.ts - b.ts);

  // No events yet → assume 100% online (give it the benefit of the doubt).
  if (events.length === 0) {
    return { uptimePct: 100, downtimeMs: 0, windowMs, transitionCount: 0 };
  }

  // Walk through the window, summing time spent in 'offline' or 'unknown'.
  // Start state: whatever we were in just before the window.
  const earlierEvents = eventsCache
    .filter((e) => e.deviceId === deviceId && e.ts < windowStart)
    .sort((a, b) => b.ts - a.ts);
  let state: DeviceStatusKind = earlierEvents[0]?.status ?? 'online';
  let cursor = windowStart;
  let downtime = 0;
  for (const e of events) {
    const elapsed = Math.max(0, Math.min(now, e.ts) - cursor);
    if (state !== 'online') downtime += elapsed;
    state = e.status;
    cursor = e.ts;
  }
  // Final segment from last event to now
  const tail = Math.max(0, now - cursor);
  if (state !== 'online') downtime += tail;

  const uptimePct = Math.max(0, Math.min(100, ((windowMs - downtime) / windowMs) * 100));
  return {
    uptimePct: Math.round(uptimePct * 100) / 100,
    downtimeMs: downtime,
    windowMs,
    transitionCount: events.length,
  };
}

// Aggregate uptime across all devices in a room — average of each device's
// uptime so a single offline TV doesn't tank the room's score by 100%.
export function computeRoomUptime(deviceIds: string[], windowMs: number = 7 * 24 * 60 * 60 * 1000): {
  uptimePct: number;
  byDevice: Array<{ deviceId: string; uptimePct: number }>;
} {
  const byDevice = deviceIds.map((id) => ({
    deviceId: id,
    uptimePct: computeDeviceUptime(id, windowMs).uptimePct,
  }));
  if (byDevice.length === 0) return { uptimePct: 100, byDevice: [] };
  const avg = byDevice.reduce((s, d) => s + d.uptimePct, 0) / byDevice.length;
  return { uptimePct: Math.round(avg * 100) / 100, byDevice };
}

// Recent issues for a room — last N error/offline events grouped by error
// message, returns counts so the UI can show "5 timeouts, 2 auth fails".
export function getRoomIssues(deviceIds: string[], windowMs: number = 7 * 24 * 60 * 60 * 1000): {
  total: number;
  byError: Array<{ error: string; count: number; lastSeen: number }>;
  recent: DeviceEvent[];
} {
  const since = Date.now() - windowMs;
  const ids = new Set(deviceIds);
  const events = eventsCache
    .filter((e) => e.ts >= since && ids.has(e.deviceId) && e.status !== 'online')
    .sort((a, b) => b.ts - a.ts);

  const byError = new Map<string, { count: number; lastSeen: number }>();
  for (const e of events) {
    const key = e.lastError || `Status: ${e.status}`;
    const cur = byError.get(key) ?? { count: 0, lastSeen: 0 };
    cur.count++;
    cur.lastSeen = Math.max(cur.lastSeen, e.ts);
    byError.set(key, cur);
  }

  return {
    total: events.length,
    byError: [...byError.entries()]
      .map(([error, v]) => ({ error, count: v.count, lastSeen: v.lastSeen }))
      .sort((a, b) => b.count - a.count),
    recent: events.slice(0, 20),
  };
}

// Mark an event as "recoveredAfter: reboot" — used by the auto-recovery
// scheduler so we can later count how many auto-fixes worked.
export function markAutoRecovery(deviceId: string): void {
  const event: DeviceEvent = {
    ts: Date.now(),
    campusId: '',
    roomId: '',
    deviceId,
    deviceType: '',
    status: 'online',
    recoveredAfter: 'reboot',
  };
  appendFileSync(EVENT_LOG, JSON.stringify(event) + '\n');
  eventsCache.push(event);
}

// Snapshot for /api/uptime/health debugging.
export function getStats(): { events: number; devices: number; firstEventAt: number | null; lastEventAt: number | null } {
  return {
    events: eventsCache.length,
    devices: lastStatus.size,
    firstEventAt: eventsCache[0]?.ts ?? null,
    lastEventAt: eventsCache[eventsCache.length - 1]?.ts ?? null,
  };
}
