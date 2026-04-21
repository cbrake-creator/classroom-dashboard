// ──────────────────────────────────────────────────────────
//  ICMP ping helper.
//
//  Shells out to the system `ping` (macOS + Linux) rather than
//  opening a raw ICMP socket — raw sockets need root on most
//  OSes, and we'd rather keep the dashboard unprivileged.
//
//  One-shot: one packet, short timeout. Returns reachability
//  and round-trip latency if we got a response.
// ──────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';

export interface PingResult {
  reachable: boolean;
  latencyMs: number | null;
  error?: string;
}

// macOS `ping -W` is milliseconds; Linux `ping -W` is seconds. Detect.
const IS_MAC = process.platform === 'darwin';

export async function ping(host: string, timeoutMs = 1000): Promise<PingResult> {
  return new Promise((resolve) => {
    const wArg = IS_MAC ? String(timeoutMs) : String(Math.max(1, Math.ceil(timeoutMs / 1000)));
    const proc = spawn('ping', ['-c', '1', '-W', wArg, host], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout.on('data', (b) => (stdout += b));
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ reachable: false, latencyMs: null, error: 'timeout' });
    }, timeoutMs + 500);
    proc.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        resolve({ reachable: false, latencyMs: null });
        return;
      }
      // Parse "time=1.234 ms" from the one reply line.
      const m = stdout.match(/time[=<]([\d.]+)\s*ms/);
      resolve({ reachable: true, latencyMs: m ? Number(m[1]) : null });
    });
    proc.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({ reachable: false, latencyMs: null, error: err.message });
    });
  });
}
