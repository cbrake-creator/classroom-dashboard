// ──────────────────────────────────────────────────────────
//  Mac Studio control via SSH (node-ssh).
//
//  Connection is lazy and persistent — first call dials, subsequent
//  calls reuse. On disconnect we throw and the deviceManager will retry.
//
//  Required tools on the Mac side:
//    - SwitchAudioSource (brew install switchaudio-osx)   ← optional, gracefully degrades
//    - osascript (built in)
//    - top, vm_stat, df, system_profiler (built in)
//    - pgrep (built in)
// ──────────────────────────────────────────────────────────
import { NodeSSH } from 'node-ssh';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { MacApp, MacAudio } from '../types.js';

const log = logger.child({ device: 'mac' });

const ssh = new NodeSSH();
let connecting: Promise<void> | null = null;

async function ensureConnected(): Promise<void> {
  if (ssh.isConnected()) return;
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      await ssh.connect({
        host: config.mac.host,
        username: config.mac.user,
        port: config.mac.port,
        privateKeyPath: config.mac.keyPath,
        readyTimeout: config.deviceSshTimeoutMs,
      });
      log.info({ host: config.mac.host }, 'mac ssh connected');
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

async function exec(command: string): Promise<string> {
  await ensureConnected();
  const result = await ssh.execCommand(command);
  if (result.code !== 0 && result.code !== null) {
    throw new Error(`mac exec failed (${result.code}): ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

// ─── Reads ─────────────────────────────────────────────────
export async function getMetrics(): Promise<{ cpu: number; mem: number; uptime: string }> {
  // CPU: top in batch mode (1 sample), parse "CPU usage: 12.34% user"
  const top = await exec('top -l 1 -n 0 | grep "CPU usage"').catch(() => '');
  const cpuMatch = top.match(/(\d+(?:\.\d+)?)% user[,\s]+(\d+(?:\.\d+)?)% sys/);
  const cpu = cpuMatch ? Math.round(Number(cpuMatch[1]) + Number(cpuMatch[2])) : 0;

  // Memory: vm_stat → pages free / total
  const vm = await exec('vm_stat').catch(() => '');
  const pageSize = 4096;
  const grab = (key: string): number => {
    const m = vm.match(new RegExp(`${key}:\\s+(\\d+)`));
    return m ? Number(m[1]) * pageSize : 0;
  };
  const free = grab('Pages free') + grab('Pages inactive');
  const wired = grab('Pages wired down');
  const active = grab('Pages active');
  const total = free + wired + active + grab('Pages speculative') + grab('Pages occupied by compressor');
  const mem = total > 0 ? Math.round(((total - free) / total) * 100) : 0;

  // Uptime
  const uptimeRaw = await exec('uptime').catch(() => '');
  const upMatch = uptimeRaw.match(/up\s+([^,]+)/);
  const uptime = upMatch ? upMatch[1]!.trim() : '—';

  return { cpu, mem, uptime };
}

export async function getDisk(): Promise<{ freeGb: number; totalGb: number }> {
  const out = await exec("df -k / | tail -1 | awk '{print $2, $4}'");
  const [totalK, freeK] = out.split(/\s+/).map(Number);
  return {
    totalGb: Math.round((totalK ?? 0) / 1024 / 1024),
    freeGb: Math.round((freeK ?? 0) / 1024 / 1024),
  };
}

export async function getAudio(): Promise<MacAudio> {
  // Gracefully degrade if SwitchAudioSource isn't installed.
  const out = await exec('which SwitchAudioSource && SwitchAudioSource -c -t output && SwitchAudioSource -c -t input').catch(() => '');
  const lines = out.split('\n').filter(Boolean);
  const output = lines[1] ?? 'Unknown';
  const input = lines[2] ?? 'Unknown';
  // Volume via osascript
  const volStr = await exec("osascript -e 'output volume of (get volume settings)'").catch(() => '0');
  return { output, input, volume: Number(volStr) || 0 };
}

export async function getApps(watched: string[]): Promise<MacApp[]> {
  // For each watched app, pgrep -lf returns "<pid> <command>"; first match wins.
  return Promise.all(
    watched.map(async (name) => {
      const out = await exec(`pgrep -lf ${JSON.stringify(name)} | head -1`).catch(() => '');
      const m = out.match(/^(\d+)\s/);
      return { name, running: !!m, pid: m ? Number(m[1]) : null };
    }),
  );
}

export async function getRodecasterUsb(): Promise<{ connected: boolean; serial: string | null }> {
  const out = await exec('system_profiler SPUSBDataType 2>/dev/null | grep -A 6 -i RØDE').catch(() => '');
  if (!out) return { connected: false, serial: null };
  const serialMatch = out.match(/Serial Number:\s*(\S+)/);
  return { connected: true, serial: serialMatch ? serialMatch[1]! : null };
}

// ─── Writes ────────────────────────────────────────────────
export async function restartApp(name: string): Promise<void> {
  await exec(`osascript -e 'tell application ${JSON.stringify(name)} to quit' || true`);
  await exec(`open -a ${JSON.stringify(name)}`);
  log.info({ name }, 'mac restart app');
}

export async function launchApp(name: string): Promise<void> {
  await exec(`open -a ${JSON.stringify(name)}`);
  log.info({ name }, 'mac launch app');
}

export async function quitApp(name: string): Promise<void> {
  await exec(`osascript -e 'tell application ${JSON.stringify(name)} to quit'`);
  log.info({ name }, 'mac quit app');
}

export async function setVolume(value: number): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  await exec(`osascript -e 'set volume output volume ${clamped}'`);
  log.info({ value: clamped }, 'mac set volume');
}

export async function sleepMac(): Promise<void> {
  await exec("osascript -e 'tell application \"System Events\" to sleep'");
  log.info('mac sleep');
}

export async function rebootMac(): Promise<void> {
  // Requires NOPASSWD sudo for reboot. Document this in SETUP-NEW-MAC.md.
  await exec('sudo shutdown -r now');
  log.info('mac reboot');
}

// Cleanup on shutdown
export function disconnect(): void {
  if (ssh.isConnected()) {
    ssh.dispose();
    log.info('mac ssh disconnected');
  }
}
