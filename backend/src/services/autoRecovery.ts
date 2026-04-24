// ──────────────────────────────────────────────────────────
//  Auto-recovery scheduler.
//
//  Runs daily at config.autoRecovery.hour local time. For every device
//  whose last poll left it in 'offline' or 'error' state, attempts a
//  device-specific soft reboot, waits ~60s, re-polls, and emails
//  helpdesk if the device hasn't recovered.
//
//  TWO LAYERS OF SAFETY:
//  1. Toggle persisted to data/auto-recovery.json — default DISABLED.
//  2. Email dispatcher in log-only mode by default (no SMTP creds).
//  Flipping either of those flags is a deliberate action.
//
//  Hooks: backend boots autoRecovery.start() unconditionally — the
//  scheduler is always running, but it no-ops every fire if disabled.
// ──────────────────────────────────────────────────────────
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getState } from './roomState.js';
import * as canon from '../devices/canon.js';
import * as pearl from '../devices/pearl.js';
import { send as sendEmail } from './emailer.js';
import { markAutoRecovery } from './uptimeTracker.js';

const log = logger.child({ svc: 'auto-recovery' });
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = resolve(__dirname, '..', '..', 'data');
const STATE_FILE = resolve(DATA_DIR, 'auto-recovery.json');
mkdirSync(DATA_DIR, { recursive: true });

interface PersistedState {
  enabled: boolean;
  lastRunAt: number | null;
  lastRunSummary: RunSummary | null;
}

interface RunSummary {
  startedAt: number;
  finishedAt: number;
  devicesChecked: number;
  rebootAttempts: Array<{ deviceId: string; deviceName: string; type: string; rebooted: boolean; recovered: boolean; error?: string }>;
  emailsSent: number;
}

function loadState(): PersistedState {
  if (!existsSync(STATE_FILE)) {
    return { enabled: config.autoRecovery.enabledByDefault, lastRunAt: null, lastRunSummary: null };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as PersistedState;
  } catch {
    return { enabled: config.autoRecovery.enabledByDefault, lastRunAt: null, lastRunSummary: null };
  }
}

function saveState(state: PersistedState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let state: PersistedState = loadState();
let intervalHandle: NodeJS.Timeout | null = null;
let lastFiredDateKey: string | null = null;

export function isEnabled(): boolean {
  return state.enabled;
}

export function getStatus(): PersistedState & { nextRunAt: number | null; smtpConfigured: boolean } {
  return {
    ...state,
    nextRunAt: state.enabled ? nextFireAt() : null,
    smtpConfigured: Boolean(config.smtp.host && config.smtp.user && config.smtp.password),
  };
}

export function setEnabled(enabled: boolean): void {
  state = { ...state, enabled };
  saveState(state);
  log.info({ enabled }, 'auto-recovery toggle');
}

function nextFireAt(): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(config.autoRecovery.hour, 0, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime();
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// One-minute heartbeat. If the local hour matches and we haven't fired
// today, kick off a run. Cheap and self-correcting after sleep/wake.
function tick(): void {
  if (!state.enabled) return;
  const now = new Date();
  if (now.getHours() !== config.autoRecovery.hour) return;
  const key = todayKey();
  if (lastFiredDateKey === key) return;
  lastFiredDateKey = key;
  void runOnce('scheduled');
}

export function start(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(tick, 60_000);
  log.info(
    { enabled: state.enabled, nextRunAt: state.enabled ? new Date(nextFireAt()).toISOString() : 'disabled' },
    'auto-recovery scheduler started',
  );
}

export function stop(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

// Force a run now — used from the dashboard's "Run now (preview)" button.
export async function runOnce(trigger: 'scheduled' | 'manual'): Promise<RunSummary> {
  const startedAt = Date.now();
  log.info({ trigger }, 'auto-recovery run starting');
  const erroring = collectErroringDevices();
  const attempts: RunSummary['rebootAttempts'] = [];
  let emailsSent = 0;

  for (const d of erroring) {
    log.info({ deviceId: d.deviceId, type: d.type, name: d.deviceName }, 'attempting soft reboot');
    let rebooted = false;
    let recovered = false;
    let attemptError: string | undefined;

    try {
      await rebootByType(d);
      rebooted = true;
    } catch (err) {
      attemptError = (err as Error).message;
      log.warn({ deviceId: d.deviceId, err: attemptError }, 'reboot attempt failed');
    }

    if (rebooted) {
      // Wait a minute, then re-poll the device to see if it came back.
      await new Promise((r) => setTimeout(r, 60_000));
      recovered = await checkRecovered(d.deviceId);
      if (recovered) markAutoRecovery(d.deviceId);
    }

    if (!recovered) {
      const result = await sendEmail({
        to: config.autoRecovery.emailTo,
        subject: `[Classroom Dashboard] Device offline — ${d.deviceName}`,
        body:
          `${d.deviceName} (${d.type}) at ${d.ip} did not recover after a soft reboot at ${new Date().toISOString()}.\n\n` +
          `Room: ${d.roomName}\nLast error: ${d.lastError ?? 'unknown'}\n\n` +
          `Action requested: please troubleshoot.\n\n` +
          `(Sent automatically by classroom-dashboard auto-recovery.)`,
      });
      if (result.delivered || result.mode === 'log-only') emailsSent++;
    }

    attempts.push({
      deviceId: d.deviceId,
      deviceName: d.deviceName,
      type: d.type,
      rebooted,
      recovered,
      error: attemptError,
    });
  }

  const summary: RunSummary = {
    startedAt,
    finishedAt: Date.now(),
    devicesChecked: erroring.length,
    rebootAttempts: attempts,
    emailsSent,
  };
  state = { ...state, lastRunAt: startedAt, lastRunSummary: summary };
  saveState(state);
  log.info({ summary }, 'auto-recovery run complete');
  return summary;
}

interface ErroringDevice {
  deviceId: string;
  deviceName: string;
  type: string;
  ip: string;
  roomId: string;
  roomName: string;
  campusId: string;
  lastError?: string | null;
}

function collectErroringDevices(): ErroringDevice[] {
  const out: ErroringDevice[] = [];
  for (const c of getState().campuses) {
    for (const r of c.rooms) {
      for (const d of r.devices) {
        const erroring = d.status === 'offline' || (d as { healthStatus?: string }).healthStatus === 'Error';
        if (!erroring) continue;
        // Only target device types we know how to soft-reboot.
        if (d.type !== 'camera' && d.type !== 'pearl') continue;
        out.push({
          deviceId: d.id,
          deviceName: d.label || d.id,
          type: d.type,
          ip: d.ip,
          roomId: r.id,
          roomName: r.name,
          campusId: c.id,
          lastError: d.lastError,
        });
      }
    }
  }
  return out;
}

async function rebootByType(d: ErroringDevice): Promise<void> {
  switch (d.type) {
    case 'camera':
      await canon.softReboot(d.ip);
      return;
    case 'pearl':
      await pearl.softReboot(d.ip);
      return;
    default:
      throw new Error(`no reboot handler for ${d.type}`);
  }
}

async function checkRecovered(deviceId: string): Promise<boolean> {
  // Best-effort: read current state from in-memory roomState. Device
  // manager will have polled by now.
  for (const c of getState().campuses) {
    for (const r of c.rooms) {
      for (const d of r.devices) {
        if (d.id === deviceId) return d.status === 'online';
      }
    }
  }
  return false;
}
