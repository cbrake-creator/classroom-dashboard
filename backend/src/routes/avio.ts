// ──────────────────────────────────────────────────────────
//  AV.io 4K capture card — REST routes.
//
//  Snapshot + MJPEG: pure proxy to the sidecar's loopback HTTP
//  server on this Mac (127.0.0.1:3301 by default). The
//  sidecar's bundle owns the TCC camera permission that ffmpeg
//  needs to talk to the AV.io.
//
//  Source switching: drives Pearl's outputs/<port>/settings via
//  the pearl client, then kicks the sidecar's ffmpeg so the
//  HDMI link renegotiates. Without the kick, ffmpeg replays
//  pre-switch buffered frames indefinitely.
// ──────────────────────────────────────────────────────────
import { Router } from 'express';
import * as avio from '../devices/avio.js';
import * as pearl from '../devices/pearl.js';
import { getDevice } from '../services/roomState.js';
import type { CaptureCardDevice, PearlDevice } from '../types.js';

const router = Router();

function getCard(deviceId: string):
  | { ok: true; card: CaptureCardDevice }
  | { ok: false; status: number; error: string } {
  const found = getDevice(deviceId);
  if (!found) return { ok: false, status: 404, error: 'device not found' };
  if (found.device.type !== 'avio') return { ok: false, status: 400, error: 'not a capture card' };
  return { ok: true, card: found.device };
}

function getCardWithPearl(deviceId: string):
  | { ok: true; card: CaptureCardDevice; pearlDev: PearlDevice }
  | { ok: false; status: number; error: string } {
  const r = getCard(deviceId);
  if (!r.ok) return r;
  const pearlEntry = getDevice(r.card.pearlDeviceId);
  if (!pearlEntry || pearlEntry.device.type !== 'pearl') {
    return { ok: false, status: 503, error: `linked Pearl ${r.card.pearlDeviceId} not found` };
  }
  return { ok: true, card: r.card, pearlDev: pearlEntry.device };
}

router.get('/:deviceId/snapshot', async (req, res, next) => {
  try {
    const r = getCard(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    try {
      const buf = await avio.snapshot('avio');
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.send(buf);
    } catch (err) {
      // go2rtc unreachable or no producer (sidecar ffmpeg down). Surface a
      // 503 so the <img onerror> handler renders a clean placeholder.
      res.status(503).type('text/plain').send((err as Error).message);
    }
  } catch (err) {
    next(err);
  }
});

// WebRTC SDP-offer/answer proxy — forwards { type:'offer', sdp } from the
// browser to go2rtc's /api/webrtc endpoint and returns { type:'answer', sdp }.
// Media flows directly browser ↔ go2rtc over ICE; this route is just the
// signaling channel.
router.post('/:deviceId/whep', async (req, res, next) => {
  try {
    const r = getCard(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const body = req.body;
    if (!body || typeof body !== 'object' || typeof body.sdp !== 'string') {
      return res.status(400).json({ error: 'expected { type, sdp } JSON body' });
    }
    const result = await avio.whepProxy('avio', { type: body.type ?? 'offer', sdp: body.sdp });
    if (result.status !== 200 || !result.signal) {
      return res.status(result.status || 502).json({ error: 'go2rtc webrtc proxy failed', raw: result.raw.slice(0, 200) });
    }
    res.json(result.signal);
  } catch (err) {
    next(err);
  }
});

// Current Pearl HDMI source mapping for this AV.io. Includes both the raw
// Pearl value (e.g. 'multiview', '1') and a human label, plus the channels
// available on the linked Pearl so the dashboard can render switcher buttons.
router.get('/:deviceId/source', async (req, res, next) => {
  try {
    const r = getCardWithPearl(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const settings = await pearl.getOutputSettings(r.pearlDev.ip, r.card.pearlOutputId);
    res.json({
      source: settings.source,
      audio: settings.audio,
      pearlOutput: r.card.pearlOutputId,
      channels: r.pearlDev.channels.map((c) => ({ id: String(c.id), name: c.name })),
      // Remember the multiview layout so the dashboard can ship it back on
      // a 'multiview' switch — we need it to reconstruct the original grid.
      multiviewLayout: r.card.multiviewLayoutJson,
    });
  } catch (err) {
    next(err);
  }
});

// Change Pearl's HDMI output source. Body: { source: 'multiview' | '<channel-id>' }.
// When switching back to multiview we use the cached layout we captured on a
// prior refresh — if we don't have one, the multiview will still work but
// Pearl will use whatever it has stored on its side. Always kicks the sidecar
// after writing settings; otherwise the dashboard would keep showing the
// pre-switch frames for minutes.
router.post('/:deviceId/source', async (req, res, next) => {
  try {
    const r = getCardWithPearl(req.params.deviceId);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const source = String(req.body?.source ?? '').trim();
    if (!source) return res.status(400).json({ error: 'body must include `source`' });
    const settings: pearl.PearlOutputSettings = { source };
    if (source === 'multiview' && r.card.multiviewLayoutJson) {
      settings.layout = r.card.multiviewLayoutJson;
    }
    await pearl.setOutputSettings(r.pearlDev.ip, r.card.pearlOutputId, settings);
    // Kick the sidecar's ffmpeg so AV.io renegotiates the HDMI link. Wait a
    // beat first so Pearl's output has actually switched before ffmpeg
    // reconnects — otherwise the new ffmpeg captures the pre-switch frame too.
    await new Promise((r) => setTimeout(r, 400));
    const kicked = await avio.restartCapture(r.card.sidecarHost);
    res.json({ ok: true, source, kicked });
  } catch (err) {
    next(err);
  }
});

export default router;
