// ──────────────────────────────────────────────────────────
//  Filesystem browser.
//  Powers the "Browse" button on the DAW card so the user can
//  navigate the host Mac's directory tree and pick an output
//  folder without typing a path. Read-only; lists directories
//  (not files) and reports writability.
// ──────────────────────────────────────────────────────────
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { Router } from 'express';

const router = Router();

async function canWrite(p: string): Promise<boolean> {
  try {
    await fs.access(p, (await import('node:fs')).constants.W_OK);
    return true;
  } catch { return false; }
}

router.get('/browse', async (req, res) => {
  const raw = typeof req.query.path === 'string' && req.query.path ? req.query.path : homedir();
  const path = isAbsolute(raw) ? resolve(raw) : resolve(homedir(), raw);
  try {
    const stat = await fs.stat(path);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'not a directory' });
    const items = await fs.readdir(path, { withFileTypes: true });
    const entries = await Promise.all(
      items
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map(async (e) => {
          const full = join(path, e.name);
          return { name: e.name, path: full, writable: await canWrite(full) };
        }),
    );
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const parent = path === sep ? null : resolve(path, '..');
    res.json({
      path,
      parent,
      home: homedir(),
      writable: await canWrite(path),
      entries,
    });
  } catch (err: any) {
    res.status(err?.code === 'ENOENT' ? 404 : 500)
       .json({ error: err?.message || 'fs error', code: err?.code });
  }
});

export default router;
