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
  CaptureCardDevice,
  DawDevice,
  Device,
  MacDevice,
  PearlDevice,
  RodecasterDevice,
} from '../types.js';
import * as avio from '../devices/avio.js';
import * as pearl from '../devices/pearl.js';
import * as canon from '../devices/canon.js';
import * as mac from '../devices/mac.js';
import * as rodecaster from '../devices/rodecaster.js';
import * as sync from '../devices/logitechSync.js';
import * as logiLocal from '../devices/logitechLocal.js';
import { ping } from '../devices/pinger.js';
import { getDevice, getState, patchDevice } from './roomState.js';
import { broadcastDeviceUpdate, broadcastDeviceError } from '../ws/socketServer.js';
import { recordStatus } from './uptimeTracker.js';

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
    case 'rally-bar':
      return refreshRallyBar(device);
    case 'tap':
    case 'sight':
      return refreshLogitechPeripheral(device);
    case 'nuc':
    case 'display':
    case 'network-switch':
    case 'audio':
      return refreshViaPing(device);
    case 'daw':
      return refreshDaw(device);
    case 'avio':
      return refreshAvio(device);
    default:
      return null;
  }
}

// Capture-card refresh: just probe the sidecar's /healthz. Doing a real
// snapshot here would burn ~2s per poll cycle and pin the AV.io device,
// blocking the dashboard's live MJPEG viewers. Signal-present detection
// happens lazily when someone actually requests a snapshot.
async function refreshAvio(device: CaptureCardDevice): Promise<Partial<Device>> {
  const reachable = await avio.probeReachable(device.sidecarHost);
  return {
    status: reachable ? 'online' : 'offline',
    sidecarReachable: reachable,
    lastError: reachable ? null : 'sidecar HTTP server not reachable',
  } as Partial<Device>;
}

// DAW status is push, not polled — the sidecar opens a Socket.IO connection
// and the hello/disconnect handlers in sidecarServer maintain sidecarConnected.
// All this poller does is mirror that boolean into the standard device.status
// field so the rest of the UI (which keys off status) lights up correctly.
async function refreshDaw(device: DawDevice): Promise<Partial<Device>> {
  return {
    status: device.sidecarConnected ? 'online' : 'offline',
    lastError: device.sidecarConnected ? null : 'sidecar not connected',
  } as Partial<Device>;
}

// Rally Bar: stack three data sources, best-to-fallback:
//  1. Sync Cloud (60s cached, org-wide) — healthStatus, peripheral counts
//  2. Local CollabOS API (per device, sub-second, when Local Network Access
//     is enabled in Sync Portal) — live device/mic/speaker state, occupancy,
//     environmental sensors, actual connected peripherals
//  3. ICMP ping — online/offline floor when neither above reachable
// Cloud + local run in parallel; if both available we merge.
async function refreshRallyBar(device: Device & { ip: string }): Promise<Partial<Device>> {
  const [cloudResult, localResult] = await Promise.allSettled([
    Promise.resolve(sync.findByIp(device.ip)),
    logiLocal.getAll(device.ip),
  ]);
  const cloud = cloudResult.status === 'fulfilled' ? cloudResult.value : undefined;
  const local = localResult.status === 'fulfilled' ? localResult.value : undefined;

  // Derive base status: cloud's InUse is authoritative for "is there a call",
  // local's deviceState is more granular (IDLE vs AUDIO_ONLY vs IN_USE).
  const cloudOnline = cloud && (cloud.status === 'Online' || cloud.status === 'InUse');
  const localOnline = Boolean(local?.deviceInsights);
  const onlineLike = cloudOnline || localOnline;

  // If neither cloud nor local say anything, ping as last resort.
  if (!cloud && !localOnline) {
    return refreshViaPing(device);
  }

  const patch: Partial<Device> = {
    status: onlineLike ? 'online' : 'offline',
    inCall: Boolean(cloud?.status === 'InUse' || local?.deviceInsights?.deviceState === 'IN_USE'),
    firmware: local?.config?.collabOSVersion ?? cloud?.firmware ?? undefined,
    healthStatus: cloud?.health,
    peripherals: cloud?.peripherals ?? undefined,
    lastError: cloud?.health === 'Error' ? 'Logitech Sync flagged Error' : null,
    localAdminEnabled: localOnline,
  } as Partial<Device>;

  if (local?.deviceInsights) {
    patch.deviceState = local.deviceInsights.deviceState;
    patch.micMuted = local.deviceInsights.micState === 'MUTED';
    patch.speakerMuted = local.deviceInsights.speakerState === 'MUTED';
    patch.speakerVolume = local.deviceInsights.speakerVolume;
    patch.speakerMaxVolume = local.deviceInsights.speakerMaxVolume;
  }
  if (local?.roomInsights) {
    patch.occupancyCount = local.roomInsights.occupancyCount;
    if (local.roomInsights.environmentalData) {
      const e = local.roomInsights.environmentalData;
      patch.environmental = {
        co2: e.co2,
        tempC: e.temp,
        humidity: e.relativeHumidity,
        pm25: e.pm25,
        presence: e.presence,
      };
    }
  }
  if (local?.config) {
    patch.serial = local.config.serialNumber;
    patch.hostName = local.config.systemName;
  }
  if (local?.peripherals) {
    patch.connectedDisplays = local.peripherals.displays.map((d) => ({
      hdmiPort: d.hdmiPort,
      width: d.width,
      height: d.height,
      refreshRate: d.refreshRate,
    }));
    patch.connectedUsbDevices = local.peripherals.usbDevices.map((u) => ({
      name: u.name,
      pid: u.pid,
      vid: u.vid,
    }));
  }
  return patch;
}

// Tap / Sight are USB-chained to a Rally Bar so they have no IP, but Sync
// tracks them as independent device rows with their OWN healthStatus.
// Match the peripheral to its room via the hosting Rally Bar's IP and
// surface Sync's per-peripheral health flag — not the Rally Bar's.
async function refreshLogitechPeripheral(device: Device & { ip: string; type: 'tap' | 'sight' }): Promise<Partial<Device>> {
  const ipMatch = device.ip.match(/(\d+\.\d+\.\d+\.\d+)/);
  if (!ipMatch) return { status: 'unknown' } as Partial<Device>;
  const rallyBarIp = ipMatch[1]!;
  const deviceName = device.type === 'tap' ? 'Tap' : 'Sight';
  const peripheralLive = sync.findPeripheralByRallyBarIp(rallyBarIp, deviceName);
  if (peripheralLive) {
    const onlineLike = peripheralLive.status === 'Online' || peripheralLive.status === 'InUse';
    return {
      status: onlineLike ? 'online' : 'offline',
      healthStatus: peripheralLive.health,
      firmware: peripheralLive.firmware ?? undefined,
      lastError: peripheralLive.health === 'Error' ? 'Sync flagged Error — check portal' : null,
    } as Partial<Device>;
  }
  // Peripheral isn't in Sync (or Rally Bar missing from Sync) — ping the
  // Rally Bar as a health-by-proxy fallback.
  const rallyLive = sync.findByIp(rallyBarIp);
  if (rallyLive) {
    const onlineLike = rallyLive.status === 'Online' || rallyLive.status === 'InUse';
    return { status: onlineLike ? 'online' : 'offline' } as Partial<Device>;
  }
  const r = await ping(rallyBarIp, 1000);
  return { status: r.reachable ? 'online' : 'offline' } as Partial<Device>;
}

// Ping-only refresh: for devices where we have no vendor API wired yet,
// online/offline + latency is still useful signal.
async function refreshViaPing(device: Device & { ip: string }): Promise<Partial<Device>> {
  // Skip virtual IPs ("via 10.56.1.238" = USB-chained peripheral; "via mac-1 USB"
  // = detected over SSH from the host Mac). Those don't have their own IP.
  if (!device.ip || device.ip.startsWith('via ')) return { status: device.status };

  // Skip legacy placeholder IPs from the old fixture (10.1.*.*, 10.2.*.*, etc.
  // when dashboard was mock-only). Pinging them in live mode would always fail
  // and mislead the user into thinking the device is offline when really we
  // just don't have a real IP yet. Mark as 'unknown' with a helpful hint.
  if (!/^10\.56\./.test(device.ip)) {
    return {
      status: 'unknown',
      lastError: 'IP not wired to real device yet (placeholder from legacy fixture)',
    } as Partial<Device>;
  }

  const r = await ping(device.ip, 1000);
  return {
    status: r.reachable ? 'online' : 'offline',
    latencyMs: r.latencyMs ?? undefined,
    lastError: r.reachable ? null : (r.error ?? 'unreachable'),
  } as Partial<Device>;
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
      recordStatus({ campusId, roomId, deviceId: device.id, deviceType: device.type, status: device.status, lastError: device.lastError });
    } else if (config.deviceMode === 'live' && device.status !== 'unknown') {
      // No real client for this device type yet. Don't let the fixture's
      // default 'online' mislead the UI in live mode — show 'unknown'.
      device.status = 'unknown';
      device.lastSeen = Date.now();
      broadcastDeviceUpdate(campusId, roomId, device);
      recordStatus({ campusId, roomId, deviceId: device.id, deviceType: device.type, status: device.status, lastError: device.lastError });
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
      recordStatus({ campusId, roomId, deviceId: device.id, deviceType: device.type, status: device.status, lastError: device.lastError });
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
