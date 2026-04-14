// ──────────────────────────────────────────────────────────
//  Mac Studio commands. The :deviceId param is currently
//  cosmetic — there's only one Mac in the fixture — but the
//  shape lets us trivially support multiple Macs later.
// ──────────────────────────────────────────────────────────
import { Router } from 'express';
import * as mac from '../devices/mac.js';
import { applyCommand } from '../services/deviceManager.js';
import { getDevice } from '../services/roomState.js';

const router = Router();

function ensureMac(deviceId: string): { ok: true } | { ok: false; status: number; error: string } {
  const found = getDevice(deviceId);
  if (!found) return { ok: false, status: 404, error: 'device not found' };
  if (found.device.type !== 'mac') return { ok: false, status: 400, error: 'not a mac device' };
  return { ok: true };
}

router.post('/:deviceId/app/:name/restart', async (req, res, next) => {
  try {
    const check = ensureMac(req.params.deviceId);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    await applyCommand(req.params.deviceId, () => mac.restartApp(req.params.name));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/app/:name/launch', async (req, res, next) => {
  try {
    const check = ensureMac(req.params.deviceId);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    await applyCommand(req.params.deviceId, () => mac.launchApp(req.params.name));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/app/:name/quit', async (req, res, next) => {
  try {
    const check = ensureMac(req.params.deviceId);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    await applyCommand(req.params.deviceId, () => mac.quitApp(req.params.name));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/volume', async (req, res, next) => {
  try {
    const check = ensureMac(req.params.deviceId);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    const value = Number(req.body?.value);
    if (!Number.isFinite(value)) return res.status(400).json({ error: 'value required' });
    await applyCommand(req.params.deviceId, () => mac.setVolume(value));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/sleep', async (req, res, next) => {
  try {
    const check = ensureMac(req.params.deviceId);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    await applyCommand(req.params.deviceId, () => mac.sleepMac());
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/reboot', async (req, res, next) => {
  try {
    const check = ensureMac(req.params.deviceId);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    await applyCommand(req.params.deviceId, () => mac.rebootMac());
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
