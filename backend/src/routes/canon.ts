// ──────────────────────────────────────────────────────────
//  Canon CR-N300 commands. Each handler resolves the camera's
//  IP from the in-memory state, then calls the canon client.
// ──────────────────────────────────────────────────────────
import http from 'node:http';
import { Router } from 'express';
import { config } from '../config.js';
import * as canon from '../devices/canon.js';
import { applyCommand } from '../services/deviceManager.js';
import { getDevice } from '../services/roomState.js';
import type { CameraDevice } from '../types.js';

const router = Router();

function getCamera(deviceId: string):
  | { ok: true; cam: CameraDevice }
  | { ok: false; status: number; error: string } {
  const found = getDevice(deviceId);
  if (!found) return { ok: false, status: 404, error: 'device not found' };
  if (found.device.type !== 'camera') return { ok: false, status: 400, error: 'not a camera' };
  return { ok: true, cam: found.device };
}

router.post('/:deviceId/claim', async (req, res, next) => {
  try {
    const r = getCamera(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    await applyCommand(req.params.deviceId, () => canon.claim(r.cam.id, r.cam.ip));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/release', async (req, res, next) => {
  try {
    const r = getCamera(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    await applyCommand(req.params.deviceId, () => canon.release(r.cam.id, r.cam.ip));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/ptz', async (req, res, next) => {
  try {
    const r = getCamera(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const action = req.body?.action;
    if (!['pan-left', 'pan-right', 'tilt-up', 'tilt-down'].includes(action)) {
      return res.status(400).json({ error: 'invalid ptz action' });
    }
    await applyCommand(req.params.deviceId, () => canon.ptz(r.cam.id, r.cam.ip, action));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/zoom', async (req, res, next) => {
  try {
    const r = getCamera(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const direction = req.body?.direction;
    if (direction !== 'in' && direction !== 'out') {
      return res.status(400).json({ error: 'direction must be in|out' });
    }
    await applyCommand(req.params.deviceId, () => canon.zoom(r.cam.id, r.cam.ip, direction));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/home', async (req, res, next) => {
  try {
    const r = getCamera(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    await applyCommand(req.params.deviceId, () => canon.home(r.cam.id, r.cam.ip));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/standby', async (req, res, next) => {
  try {
    const r = getCamera(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const on = Boolean(req.body?.on);
    await applyCommand(req.params.deviceId, () => canon.setStandby(r.cam.ip, on));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/autotrack', async (req, res, next) => {
  try {
    const r = getCamera(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const enabled = Boolean(req.body?.enabled);
    await applyCommand(req.params.deviceId, () => canon.setAutoTrack(r.cam.id, r.cam.ip, enabled));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/:deviceId/snapshot', async (req, res, next) => {
  try {
    const r = getCamera(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    try {
      const buf = await canon.snapshot(r.cam.ip);
      res.setHeader('Content-Type', 'image/jpeg');
      // Don't let browsers cache a snapshot — each request should be fresh.
      res.setHeader('Cache-Control', 'no-store');
      res.send(buf);
    } catch (err) {
      // Standby / unreachable / error-body. Return 503 so the <img>
      // onerror handler fires cleanly instead of rendering broken bytes.
      res.status(503).type('text/plain').send((err as Error).message);
    }
  } catch (err) {
    next(err);
  }
});

// MJPEG streaming proxy — pipes Canon's /video.cgi (multipart/x-mixed-replace)
// straight through to the browser. One upstream connection per client request.
// Much better than snapshot polling: true live video, no per-frame HTTP overhead.
router.get('/:deviceId/mjpeg', (req, res) => {
  const r = getCamera(req.params.deviceId);
  if (!r.ok) return res.status(r.status).json({ error: r.error });

  const upstream = http.request(
    {
      host: r.cam.ip,
      port: 80,
      path: '/-wvhttp-01-/video.cgi',
      method: 'GET',
      auth: `${config.canonAuth.username}:${config.canonAuth.password}`,
      timeout: 5000,
    },
    (up) => {
      if (up.statusCode !== 200 || !String(up.headers['content-type'] ?? '').startsWith('multipart/')) {
        res.status(503).type('text/plain').end('camera not streaming (standby?)');
        up.destroy();
        return;
      }
      res.writeHead(200, {
        'Content-Type': up.headers['content-type'],
        'Cache-Control': 'no-store',
        'Connection': 'close',
      });
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) res.status(503).type('text/plain').end(`upstream error: ${err.message}`);
  });
  upstream.on('timeout', () => {
    upstream.destroy();
    if (!res.headersSent) res.status(504).type('text/plain').end('upstream timeout');
  });
  // Browser navigated away — kill the upstream to free the Canon slot.
  req.on('close', () => upstream.destroy());
  upstream.end();
});

export default router;
