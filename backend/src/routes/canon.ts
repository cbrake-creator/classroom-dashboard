// ──────────────────────────────────────────────────────────
//  Canon CR-N300 commands. Each handler resolves the camera's
//  IP from the in-memory state, then calls the canon client.
// ──────────────────────────────────────────────────────────
import { Router } from 'express';
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
    const buf = await canon.snapshot(r.cam.ip);
    res.setHeader('Content-Type', 'image/jpeg');
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

export default router;
