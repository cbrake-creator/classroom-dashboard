// ──────────────────────────────────────────────────────────
//  Pearl 2 commands. Each handler resolves the Pearl's IP from
//  state (we support multiple Pearls across classrooms now),
//  then runs through applyCommand for snappy re-polling.
// ──────────────────────────────────────────────────────────
import { Router } from 'express';
import * as pearl from '../devices/pearl.js';
import { applyCommand } from '../services/deviceManager.js';
import { getDevice } from '../services/roomState.js';
import type { PearlDevice } from '../types.js';

const router = Router();

function getPearl(deviceId: string):
  | { ok: true; dev: PearlDevice }
  | { ok: false; status: number; error: string } {
  const found = getDevice(deviceId);
  if (!found) return { ok: false, status: 404, error: 'device not found' };
  if (found.device.type !== 'pearl') return { ok: false, status: 400, error: 'not a pearl device' };
  return { ok: true, dev: found.device };
}

// One-touch recording — start/stop every recorder on the Pearl at once.
// Matches the hardware REC button on the front of the device.
router.post('/:deviceId/record-all/:action', async (req, res, next) => {
  try {
    const r = getPearl(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const action = req.params.action;
    if (action !== 'start' && action !== 'stop') {
      return res.status(400).json({ error: "action must be 'start' or 'stop'" });
    }
    await applyCommand(req.params.deviceId, () =>
      action === 'start' ? pearl.startAllRecorders(r.dev.ip) : pearl.stopAllRecorders(r.dev.ip),
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/recorder/:id/start', async (req, res, next) => {
  try {
    const r = getPearl(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    await applyCommand(req.params.deviceId, () => pearl.startRecorder(r.dev.ip, Number(req.params.id)));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/recorder/:id/stop', async (req, res, next) => {
  try {
    const r = getPearl(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    await applyCommand(req.params.deviceId, () => pearl.stopRecorder(r.dev.ip, Number(req.params.id)));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/channel/:channelId/publisher/:id/start', async (req, res, next) => {
  try {
    const r = getPearl(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    await applyCommand(req.params.deviceId, () =>
      pearl.startPublisher(r.dev.ip, Number(req.params.channelId), Number(req.params.id)),
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/channel/:channelId/publisher/:id/stop', async (req, res, next) => {
  try {
    const r = getPearl(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    await applyCommand(req.params.deviceId, () =>
      pearl.stopPublisher(r.dev.ip, Number(req.params.channelId), Number(req.params.id)),
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:deviceId/channel/:channelId/layout', async (req, res, next) => {
  try {
    const r = getPearl(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const layoutId = Number(req.body?.layoutId);
    if (!Number.isFinite(layoutId)) {
      return res.status(400).json({ error: 'layoutId required' });
    }
    await applyCommand(req.params.deviceId, () =>
      pearl.setChannelLayout(r.dev.ip, Number(req.params.channelId), layoutId),
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
