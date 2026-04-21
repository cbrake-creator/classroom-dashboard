// ──────────────────────────────────────────────────────────
//  Device manager: poll loop + broadcast.
//
//  Every DEVICE_POLL_INTERVAL_MS, walks every device in state
//  and (in 'live' or 'fallback' mode) tries to refresh it from
//  its real client. Successful results merge into state and
//  emit a `device:update`. Failures bump a counter and either
//  mark the device offline (live mode) or fall back to fixture
//  state (fallback mode).
//
//  REST handlers also call `applyCommand(deviceId, fn)` which
//  runs the action, then immediately re-polls that device for
//  a snappy UX (no 5-second wait).
// ──────────────────────────────────────────────────────────
import { config } from '../config.js';
import { logger } from '../logger.js';
import type {
  CameraDevice,
  Device,
  MacDevice,
  PearlDevice,
  RodecasterDevice,
} from '../types.js';
import * as pearl from '../devices/pearl.js';
import * as canon from '../devices/canon.js';
import * as mac from '../devices/mac.js';
import * as rodecaster from '../devices/rodecaster.js';
import { getDevice, getState, patchDevice } from './roomState.js';
import { broadcastDeviceUpdate, broadcastDeviceError } from '../ws/socketServer.js';

const log = logger.child({ svc: 'deviceManager' });

const failureCounts = new Map<string, number>();
const FAILURE_THRESHOLD = 3;

let pollHandle: NodeJS.Timeout | null = null;

// ─── Per-device refresh ────────────────────────────────────
async function refreshPearl(device: PearlDevice): Promise<Partial<PearlDevice>> {
  const host = device.ip;
  const [sys, storage, channels, recorders, sources] = await Promise.all([
    pearl.getSystemStatus(host),
    pearl.getStorage(host),
    pearl.getChannels(host),
    pearl.getRecorders(host),
    pearl.getSources(host),
  ]);
  const publishers = (
    await Promise.all(channels.map((ch) => pearl.getPublishers(host, ch.id).catch(() => [])))
  ).flat();
  return {
    status: 'online',
    cpu: sys.cpu,
    temp: sys.temp,
    uptime: sys.uptime,
    firmware: sys.firmware,
    storage,
    channels,
    recorders,
    publishers,
    sources,
    lastError: null,
  };
}

async function refreshCanon(device: CameraDevice): Promise<Partial<CameraDevice>> {
  // Two independent reads: the XC info.cgi for PTZ + power, and the Auto
  // Tracking add-on app's get_config.cgi for real subject-follow state.
  // The latter lives behind HTTP Digest auth at /cgi-addon/Auto_Tracking_RA-AT001.
  const [info, at] = await Promise.all([
    canon.getInfo(device.ip),
    canon.getAutoTrackStatus(device.ip).catch(() => ({ available: false, enabled: false, startupReason: 'probe failed' })),
  ]);
  return {
    status: 'online',
    power: info.power,
    panPos: info.panPos,
    tiltPos: info.tiltPos,
    zoomPos: info.zoomPos,
    autoTrack: at.enabled,
    autoTrackAvailable: at.available,
    autoTrackReason: at.startupReason,
    livescopeStatus: info.livescopeStatus,
    livescopeMsg: info.livescopeMsg,
    lastError: null,
  };
}

async function refreshMac(device: MacDevice): Promise<Partial<MacDevice>> {
  const [metrics, disk, audio, apps] = await Promise.all([
    mac.getMetrics(),
    mac.getDisk(),
    mac.getAudio(),
    mac.getApps(device.apps.map((a) => a.name)),
  ]);
  return {
    status: 'online',
    cpu: metrics.cpu,
    mem: metrics.mem,
    uptime: metrics.uptime,
    disk,
    audio,
    apps,
    lastError: null,
  };
}

async function refreshRodecaster(device: RodecasterDevice): Promise<Partial<RodecasterDevice>> {
  const presence = await rodecaster.getPresence();
  return {
    status: presence.connected ? 'online' : 'offline',
    serial: presence.serial ?? device.serial,
    lastError: null,
  };
}

// ─── Refresh dispatcher ────────────────────────────────────
async function refreshDevice(device: Device): Promise<Partial<Device> | null> {
  switch (device.type) {
    case 'pearl':
      return refreshPearl(device);
    case 'camera':
      return refreshCanon(device);
    case 'mac':
      return refreshMac(device);
    case 'rodecaster':
      return refreshRodecaster(device);
    // The Logitech / NUC / display / switch types don't have real clients
    // wired up yet — they'll come from SNMP / vendor APIs in a later pass.
    // Until then we leave them as the fixture data so the UI keeps rendering.
    default:
      return null;
  }
}

// Compose a globally-unique failure-count key. Device IDs like `cam-1`,
// `nuc-1`, `tv-1` repeat across every classroom, so keying by id alone would
// collide across rooms.
function failKey(campusId: string, roomId: string, deviceId: string): string {
  return `${campusId}/${roomId}/${deviceId}`;
}

// ─── Poll one device with mode handling ────────────────────
// Operates on the device reference directly so we don't depend on the
// (currently non-unique) device-id lookup in roomState.
async function pollDeviceRef(campusId: string, roomId: string, device: Device): Promise<void> {
  if (config.deviceMode === 'mock') {
    device.lastSeen = Date.now();
    return;
  }

  const key = failKey(campusId, roomId, device.id);

  try {
    const patch = await refreshDevice(device);
    if (patch) {
      Object.assign(device, patch);
      device.lastSeen = Date.now();
      failureCounts.delete(key);
      broadcastDeviceUpdate(campusId, roomId, device);
    } else if (config.deviceMode === 'live' && device.status !== 'unknown') {
      // No real client for this device type yet. Don't let the fixture's
      // default 'online' mislead the UI in live mode — show 'unknown'.
      device.status = 'unknown';
      device.lastSeen = Date.now();
      broadcastDeviceUpdate(campusId, roomId, device);
    }
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown';
    const count = (failureCounts.get(key) ?? 0) + 1;
    failureCounts.set(key, count);
    // First few failures log at info so troubleshooting on a fresh machine
    // (no LOG_LEVEL=debug) still shows why a device went offline.
    const level = count <= FAILURE_THRESHOLD ? 'info' : 'debug';
    log[level]({ key, count, err: msg }, 'device poll failed');

    if (config.deviceMode === 'live') {
      if (count >= FAILURE_THRESHOLD && device.status !== 'offline') {
        device.status = 'offline';
        device.lastError = msg;
        device.lastSeen = Date.now();
        broadcastDeviceUpdate(campusId, roomId, device);
      }
      broadcastDeviceError(campusId, roomId, device.id, msg);
    } else {
      // fallback mode: just stamp lastError but keep showing the fixture data
      device.lastError = msg;
    }
  }
}

// Retained for REST-triggered refreshes. Still uses the id-based lookup,
// which picks the first match when ids collide — acceptable for now since
// the routes that call applyCommand operate on the studio room where ids
// are unique.
async function pollDevice(deviceId: string): Promise<void> {
  const found = getDevice(deviceId);
  if (!found) return;
  await pollDeviceRef(found.campus.id, found.room.id, found.device);
}

// ─── Public API ────────────────────────────────────────────
async function pollAll(): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const campus of getState().campuses) {
    for (const room of campus.rooms) {
      for (const device of room.devices) {
        jobs.push(pollDeviceRef(campus.id, room.id, device));
      }
    }
  }
  await Promise.allSettled(jobs);
}

export function startPolling(): void {
  if (pollHandle) return;
  log.info({ intervalMs: config.pollIntervalMs, mode: config.deviceMode }, 'starting device poller');
  // Fire once on boot so the initial state has any quickly-reachable real values.
  void pollAll();
  pollHandle = setInterval(() => void pollAll(), config.pollIntervalMs);
}

export function stopPolling(): void {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

// Run a command, then immediately re-poll the device so the UI updates fast.
// In mock mode, commands are no-ops so the UI is exercise-able without real hardware.
export async function applyCommand<T>(deviceId: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (config.deviceMode === 'mock') {
    log.debug({ deviceId }, 'mock mode: command skipped');
    await pollDevice(deviceId).catch(() => {});
    return undefined;
  }
  const result = await fn();
  // Best-effort refresh; ignore errors.
  await pollDevice(deviceId).catch(() => {});
  return result;
}
