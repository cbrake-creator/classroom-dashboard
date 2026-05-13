// ──────────────────────────────────────────────────────────
//  DAW REST routes.
//  Every command forwards to the studio-Mac sidecar over the
//  /sidecar Socket.IO namespace. If the sidecar isn't
//  connected we fail fast with 503.
//
//  Recordings are listed and streamed directly from the host
//  Mac's filesystem (the sidecar runs on the same Mac as this
//  backend), so the dashboard can play back / download multitrack
//  WAVs without going through the sidecar.
// ──────────────────────────────────────────────────────────
import { createReadStream, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { Router } from 'express';
import { getDevice } from '../services/roomState.js';
import { sendDawCommand } from '../ws/sidecarServer.js';
import type { DawDevice } from '../types.js';

const router = Router();

function ensureDaw(deviceId: string): { ok: true; device: DawDevice } | { ok: false; status: number; error: string } {
  const found = getDevice(deviceId);
  if (!found) return { ok: false, status: 404, error: 'device not found' };
  if (found.device.type !== 'daw') return { ok: false, status: 400, error: 'not a DAW device' };
  return { ok: true, device: found.device };
}

router.post('/:deviceId/cmd', (req, res) => {
  const check = ensureDaw(req.params.deviceId);
  if (!check.ok) return res.status(check.status).json({ error: check.error });
  const { op, args } = req.body ?? {};
  if (typeof op !== 'string' || !op) return res.status(400).json({ error: 'op required' });
  const delivered = sendDawCommand(req.params.deviceId, op, args);
  if (!delivered) return res.status(503).json({ error: 'sidecar not connected' });
  res.json({ ok: true });
});

// ── Recordings list ───────────────────────────────────────
// Each record-start in the sidecar writes to a `studio_<timestamp>/` subdir
// under outputDir, with one mono 24-bit WAV per recorded channel. List those
// sessions newest-first. Used by the DAW card's "Recent Recordings" panel.
function resolveOutputDir(device: DawDevice): string {
  const raw = device.outputDir || join(homedir(), 'Documents/studio-daw-recordings');
  return isAbsolute(raw) ? resolve(raw) : resolve(homedir(), raw);
}

// Guard: the streaming route reads files by `session/file` from the URL. We
// resolve under the device's outputDir and reject if the resolved path
// escapes that root — protects against `../` traversal regardless of how the
// outputDir was configured.
function safeJoin(root: string, ...parts: string[]): string | null {
  const joined = resolve(root, ...parts);
  if (joined !== root && !joined.startsWith(root + sep)) return null;
  return joined;
}

router.get('/:deviceId/recordings', async (req, res) => {
  const check = ensureDaw(req.params.deviceId);
  if (!check.ok) return res.status(check.status).json({ error: check.error });
  const root = resolveOutputDir(check.device);
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) return res.json({ outputDir: root, sessions: [] });
  } catch {
    return res.json({ outputDir: root, sessions: [] });
  }
  const dirents = await fs.readdir(root, { withFileTypes: true });
  const sessionDirs = dirents
    .filter((d) => d.isDirectory() && d.name.startsWith('studio_'))
    .map((d) => d.name);

  const sessions = await Promise.all(sessionDirs.map(async (name) => {
    const sessionPath = join(root, name);
    let files: { name: string; sizeBytes: number; durationSec: number | null }[] = [];
    let createdMs = 0;
    try {
      const entries = await fs.readdir(sessionPath, { withFileTypes: true });
      const wavEntries = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.wav'));
      files = await Promise.all(wavEntries.map(async (e) => {
        const filePath = join(sessionPath, e.name);
        const fileStat = await fs.stat(filePath);
        // Duration from raw size: mono 24-bit @ sampleRate. (3 bytes/sample,
        // minus the ~44-byte WAV header which is negligible at session length.)
        // Safer than parsing the header for our single-format use case.
        const sr = check.device.sampleRate || 48000;
        const samples = Math.max(0, fileStat.size - 44) / 3;
        const durationSec = sr > 0 ? samples / sr : null;
        return { name: e.name, sizeBytes: fileStat.size, durationSec };
      }));
      const sessionStat = await fs.stat(sessionPath);
      createdMs = sessionStat.birthtimeMs || sessionStat.ctimeMs || 0;
    } catch {
      // Silently skip sessions we can't read (permission flap, etc.).
    }
    const totalBytes = files.reduce((s, f) => s + f.sizeBytes, 0);
    const durationSec = files.length ? Math.max(...files.map((f) => f.durationSec ?? 0)) : 0;
    return { name, createdMs, durationSec, totalBytes, files };
  }));

  sessions.sort((a, b) => b.createdMs - a.createdMs);
  res.json({ outputDir: root, sessions });
});

// ── Single-file stream (for in-browser playback / download) ──
router.get('/:deviceId/recordings/:session/:file', async (req, res) => {
  const check = ensureDaw(req.params.deviceId);
  if (!check.ok) return res.status(check.status).json({ error: check.error });
  const root = resolveOutputDir(check.device);
  const { session, file } = req.params;
  if (!session.startsWith('studio_') || !file.toLowerCase().endsWith('.wav')) {
    return res.status(400).json({ error: 'bad session or file name' });
  }
  const target = safeJoin(root, session, file);
  if (!target) return res.status(400).json({ error: 'path escapes output dir' });
  try {
    const stat = await fs.stat(target);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', String(stat.size));
    // Use inline disposition so <audio src> can play; ?download=1 forces save.
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${basename(target)}"`);
    } else {
      res.setHeader('Accept-Ranges', 'bytes');
    }
    createReadStream(target).pipe(res);
  } catch (err: any) {
    res.status(err?.code === 'ENOENT' ? 404 : 500)
       .json({ error: err?.message || 'fs error', code: err?.code });
  }
});

export default router;
