import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { DeviceMode } from './types.js';

function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v == null || v === '') {
    if (fallback != null) return fallback;
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
}

function envOptional(key: string): string | undefined {
  const v = process.env[key];
  return v == null || v === '' ? undefined : v;
}

function envNumber(key: string, fallback: number): number {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${key} is not a number: ${v}`);
  return n;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

const mode = (envOptional('DEVICE_MODE') ?? 'fallback') as DeviceMode;
if (!['live', 'mock', 'fallback'].includes(mode)) {
  throw new Error(`Invalid DEVICE_MODE: ${mode}. Must be live | mock | fallback.`);
}

export const config = {
  port: envNumber('PORT', 3000),
  nodeEnv: envOptional('NODE_ENV') ?? 'development',
  logLevel: envOptional('LOG_LEVEL') ?? 'info',

  pollIntervalMs: envNumber('DEVICE_POLL_INTERVAL_MS', 5000),
  deviceMode: mode,

  // A list of origin strings, OR the single literal '*' for any origin.
  // Socket.IO + cors() both accept '*' as a wildcard.
  allowedOrigins: (() => {
    const raw = envOptional('ALLOWED_ORIGINS') ?? 'http://localhost:3000';
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return list.length === 1 && list[0] === '*' ? '*' : list;
  })() as string | string[],

  pearl: {
    host: envOptional('PEARL_HOST') ?? '10.56.1.138',
    username: envOptional('PEARL_USERNAME') ?? 'admin',
    password: envOptional('PEARL_PASSWORD') ?? 'replace-me',
  },

  canons: [
    {
      id: 'cam-1',
      host: envOptional('CANON_CAM1_HOST') ?? '10.56.1.101',
    },
    {
      id: 'cam-2',
      host: envOptional('CANON_CAM2_HOST') ?? '10.56.1.102',
    },
    {
      id: 'cam-3',
      host: envOptional('CANON_CAM3_HOST') ?? '10.56.1.103',
    },
  ],
  canonAuth: {
    username: envOptional('CANON_USERNAME') ?? 'admin',
    password: envOptional('CANON_PASSWORD') ?? 'replace-me',
  },

  mac: {
    host: envOptional('MAC_HOST') ?? '10.56.1.10',
    user: envOptional('MAC_USER') ?? 'studio',
    port: envNumber('MAC_PORT', 22),
    keyPath: expandHome(envOptional('MAC_KEY_PATH') ?? '~/.ssh/id_ed25519'),
  },

  // Per-device-call HTTP timeout (ms). Short so a missing device doesn't stall the poller.
  deviceHttpTimeoutMs: 2000,
  deviceSshTimeoutMs: 3000,

  // Shared secret the studio-Mac DAW sidecar presents on connect.
  // Empty string disables auth (dev convenience; set in production .env).
  sidecarToken: envOptional('SIDECAR_TOKEN') ?? '',

  sync: {
    orgId: envOptional('SYNC_ORG_ID') ?? '',
    // Relative paths resolve from the backend cwd (where `npm run dev` runs).
    certPath: envOptional('SYNC_CERT_PATH') ?? './certs/certificate.pem',
    keyPath: envOptional('SYNC_KEY_PATH') ?? './certs/privateKey.pem',
    pollIntervalMs: envNumber('SYNC_POLL_INTERVAL_MS', 60000),
  },

  // Rally Bar local CollabOS admin API — shared credentials across all
  // devices where Local Network Access has been enabled via Sync Portal.
  logitechLocal: {
    username: envOptional('LOGI_LOCAL_USERNAME') ?? '',
    password: envOptional('LOGI_LOCAL_PASSWORD') ?? '',
  },
};

export type AppConfig = typeof config;
