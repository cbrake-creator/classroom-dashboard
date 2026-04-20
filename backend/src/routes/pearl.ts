// ──────────────────────────────────────────────────────────
//  Pearl 2 commands. Each handler resolves the Pearl's IP from
//  state (we support multiple Pearls across classrooms now),
//  then runs through applyCommand for snappy re-polling.
// ──────────────────────────────────────────────────────────
import http from 'node:http';
import { Router } from 'express';
import { config } from '../config.js';
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

// List recent recordings across every recorder on this Pearl.
router.get('/:deviceId/recordings', async (req, res, next) => {
  try {
    const r = getPearl(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const recorderIds = (r.dev.recorders ?? []).map((x) => x.id);
    const files = await pearl.listArchive(r.dev.ip, recorderIds);
    res.json({ files });
  } catch (err) {
    next(err);
  }
});

// Stream an MP4 from Pearl's archive. Proxies with Basic auth + forwards
// Range headers so the browser <video> can seek. Pearl's endpoint is:
//   GET /api/v2.0/recorders/{rec}/archive/files/{fileId}/stream
router.get('/:deviceId/recordings/:recorderId/:fileId/stream', (req, res) => {
  const r = getPearl(req.params.deviceId);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const headers: http.OutgoingHttpHeaders = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const upstream = http.request(
    {
      host: r.dev.ip,
      port: 80,
      method: 'GET',
      path: `/api/v2.0/recorders/${encodeURIComponent(req.params.recorderId)}/archive/files/${encodeURIComponent(req.params.fileId)}/stream`,
      auth: `${config.pearl.username}:${config.pearl.password}`,
      headers,
      timeout: 15000,
    },
    (up) => {
      // Forward content headers and status so <video> seeking works.
      const out: Record<string, string> = {};
      for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
        const v = up.headers[k];
        if (typeof v === 'string') out[k] = v;
      }
      res.writeHead(up.statusCode ?? 200, out);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) res.status(502).type('text/plain').end(`upstream error: ${err.message}`);
  });
  req.on('close', () => upstream.destroy());
  upstream.end();
});

export default router;
