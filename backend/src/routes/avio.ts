// ──────────────────────────────────────────────────────────
//  AV.io 4K capture card — REST routes.
//  Pure proxy: every request is forwarded to the sidecar's
//  loopback HTTP server on this Mac (127.0.0.1:3301 by
//  default). The sidecar's bundle owns the TCC camera
//  permission that ffmpeg needs to talk to the AV.io.
// ──────────────────────────────────────────────────────────
import { Router } from 'express';
import * as avio from '../devices/avio.js';
import { getDevice } from '../services/roomState.js';
import type { CaptureCardDevice } from '../types.js';

const router = Router();

function getCard(deviceId: string):
  | { ok: true; card: CaptureCardDevice }
  | { ok: false; status: number; error: string } {
  const found = getDevice(deviceId);
  if (!found) return { ok: false, status: 404, error: 'device not found' };
  if (found.device.type !== 'avio') return { ok: false, status: 400, error: 'not a capture card' };
  return { ok: true, card: found.device };
}

router.get('/:deviceId/snapshot', async (req, res, next) => {
  try {
    const r = getCard(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    try {
      const buf = await avio.snapshot(r.card.sidecarHost);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.send(buf);
    } catch (err) {
      // Sidecar unreachable, ffmpeg error, no HDMI signal, etc. — surface
      // a 503 so the <img onerror> handler renders a clean placeholder.
      res.status(503).type('text/plain').send((err as Error).message);
    }
  } catch (err) {
    next(err);
  }
});

router.get('/:deviceId/mjpeg', (req, res) => {
  const r = getCard(req.params.deviceId);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  avio.pipeMjpeg(r.card.sidecarHost, res);
});

export default router;
