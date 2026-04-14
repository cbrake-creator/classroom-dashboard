// ──────────────────────────────────────────────────────────
//  Pearl 2 commands. Each handler runs through
//  applyCommand(deviceId, fn) so the device is re-polled
//  immediately after the command, giving the UI a snappy update
//  without waiting for the next poll cycle.
// ──────────────────────────────────────────────────────────
import { Router } from 'express';
import * as pearl from '../devices/pearl.js';
import { applyCommand } from '../services/deviceManager.js';
import { getDevice } from '../services/roomState.js';

const router = Router();

function ensurePearl(deviceId: string): { ok: true } | { ok: false; status: number; error: string } {
  const found = getDevice(deviceId);
  if (!found) return { ok: false, status: 404, error: 'device not found' };
  if (found.device.type !== 'pearl') return { ok: false, status: 400, error: 'not a pearl device' };
  return { ok: true };
}

router.post('/:deviceId/recorder/:id/start', async (req, res, next) => {
  try {
    const check = ensurePearl(req.params.deviceId);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    await applyCommand(req.params.deviceId, () => pearl.startRecorder(Number(req.params.id)));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/recorder/:id/stop', async (req, res, next) => {
  try {
    const check = ensurePearl(req.params.deviceId);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    await applyCommand(req.params.deviceId, () => pearl.stopRecorder(Number(req.params.id)));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/channel/:channelId/publisher/:id/start', async (req, res, next) => {
  try {
    const check = ensurePearl(req.params.deviceId);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    await applyCommand(req.params.deviceId, () =>
      pearl.startPublisher(Number(req.params.channelId), Number(req.params.id)),
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/channel/:channelId/publisher/:id/stop', async (req, res, next) => {
  try {
    const check = ensurePearl(req.params.deviceId);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    await applyCommand(req.params.deviceId, () =>
      pearl.stopPublisher(Number(req.params.channelId), Number(req.params.id)),
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/channel/:channelId/layout', async (req, res, next) => {
  try {
    const check = ensurePearl(req.params.deviceId);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    const layoutId = Number(req.body?.layoutId);
    if (!Number.isFinite(layoutId)) {
      return res.status(400).json({ error: 'layoutId required' });
    }
    await applyCommand(req.params.deviceId, () =>
      pearl.setChannelLayout(Number(req.params.channelId), layoutId),
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
