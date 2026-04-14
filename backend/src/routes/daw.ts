// ──────────────────────────────────────────────────────────
//  DAW REST routes.
//  Every command forwards to the studio-Mac sidecar over the
//  /sidecar Socket.IO namespace. If the sidecar isn't
//  connected we fail fast with 503.
// ──────────────────────────────────────────────────────────
import { Router } from 'express';
import { getDevice } from '../services/roomState.js';
import { sendDawCommand } from '../ws/sidecarServer.js';

const router = Router();

function ensureDaw(deviceId: string): { ok: true } | { ok: false; status: number; error: string } {
  const found = getDevice(deviceId);
  if (!found) return { ok: false, status: 404, error: 'device not found' };
  if (found.device.type !== 'daw') return { ok: false, status: 400, error: 'not a DAW device' };
  return { ok: true };
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

export default router;
