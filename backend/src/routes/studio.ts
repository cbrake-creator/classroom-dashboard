// ──────────────────────────────────────────────────────────
//  Studio composite operations.
//
//  These wrap multi-device sequences that the user thinks of
//  as a single action ("prep the studio", "start a session").
//  Implemented as best-effort: each step logs and the response
//  reports per-step success so the UI can show partial state.
// ──────────────────────────────────────────────────────────
import { Router } from 'express';
import { config } from '../config.js';
import * as canon from '../devices/canon.js';
import * as mac from '../devices/mac.js';
import * as pearl from '../devices/pearl.js';
import { logger } from '../logger.js';
import { applyCommand } from '../services/deviceManager.js';
import { getRoom } from '../services/roomState.js';
import type { CameraDevice, DawDevice, MacDevice, PearlDevice } from '../types.js';
import { sendDawCommand } from '../ws/sidecarServer.js';

const log = logger.child({ svc: 'studio' });
const router = Router();

interface StudioRefs {
  pearl: PearlDevice | null;
  mac: MacDevice | null;
  daw: DawDevice | null;
  cams: CameraDevice[];
}

function resolveStudio(roomId: string): StudioRefs | null {
  const found = getRoom(roomId);
  if (!found) return null;
  const refs: StudioRefs = { pearl: null, mac: null, daw: null, cams: [] };
  for (const d of found.room.devices) {
    if (d.type === 'pearl') refs.pearl = d;
    else if (d.type === 'mac') refs.mac = d;
    else if (d.type === 'daw') refs.daw = d;
    else if (d.type === 'camera') refs.cams.push(d);
  }
  return refs;
}

interface StepResult {
  step: string;
  ok: boolean;
  error?: string;
  latencyMs?: number;
}

async function runStep(name: string, fn: () => Promise<unknown>): Promise<StepResult> {
  if (config.deviceMode === 'mock') {
    log.debug({ step: name }, 'mock mode: step skipped');
    return { step: name, ok: true };
  }
  try {
    const result = await fn();
    const r: StepResult = { step: name, ok: true };
    if (result && typeof result === 'object' && 'latencyMs' in result) {
      r.latencyMs = (result as { latencyMs: number }).latencyMs;
    }
    return r;
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown';
    log.warn({ step: name, err: msg }, 'studio step failed');
    return { step: name, ok: false, error: msg };
  }
}

// Prep: launch the apps the host needs and route audio to the Rodecaster.
router.post('/:roomId/prep', async (req, res) => {
  const refs = resolveStudio(req.params.roomId);
  if (!refs) return res.status(404).json({ error: 'room not found' });
  const steps: StepResult[] = [];

  if (refs.mac) {
    const macId = refs.mac.id;
    for (const app of ['OBS Studio', 'Audio Hijack', 'Rode Central']) {
      steps.push(await runStep(`mac.launch.${app}`, () => applyCommand(macId, () => mac.launchApp(app))));
    }
  }

  res.json({ ok: steps.every((s) => s.ok), steps });
});

// Start session: claim cameras, start recorder + publishers.
router.post('/:roomId/start-session', async (req, res) => {
  const refs = resolveStudio(req.params.roomId);
  if (!refs) return res.status(404).json({ error: 'room not found' });
  const steps: StepResult[] = [];

  for (const cam of refs.cams) {
    steps.push(await runStep(`canon.claim.${cam.id}`, () => canon.claim(cam.id, cam.ip)));
  }

  // ── Tightly-synchronized record start ───────────────────────
  //
  // We want the Pearl's one-touch recorders AND the DAW sidecar's multi-track
  // RAW capture to begin as close to the same instant as possible. We can't
  // get sample-level sync across independent clocks (Pearl's internal clock
  // ≠ Rodecaster USB clock), but we can fire both commands in the same
  // Promise.all tick so the wall-clock skew is just network round-trip — a
  // few milliseconds over LAN. Post-production alignment beyond that is the
  // editor's job (clap, count-in, or embedded timecode).
  //
  // Pre-compute the sends. Capture t0 on each as close to dispatch as
  // possible and surface the skew in the step result so the user can see it.
  const starts: Promise<StepResult>[] = [];

  if (refs.pearl) {
    const pearlId = refs.pearl.id;
    const pearlHost = refs.pearl.ip;
    starts.push(runStep('pearl.record-all.start', async () => {
      const t0 = Date.now();
      await applyCommand(pearlId, () => pearl.startAllRecorders(pearlHost));
      return { latencyMs: Date.now() - t0 };
    }));
  }

  if (refs.daw) {
    const dawId = refs.daw.id;
    starts.push(runStep('daw.record-start', async () => {
      const t0 = Date.now();
      const delivered = sendDawCommand(dawId, 'record-start');
      if (!delivered) throw new Error('DAW sidecar not connected');
      return { latencyMs: Date.now() - t0 };
    }));
  }

  // Fire both simultaneously. Promise.all dispatches in the same microtask.
  const results = await Promise.all(starts);
  steps.push(...results);

  // Publishers fire after the record-start wave — streaming latency isn't
  // critical for sync and RTMP negotiation can take a second.
  if (refs.pearl) {
    const pearlId = refs.pearl.id;
    const pearlHost = refs.pearl.ip;
    for (const pub of refs.pearl.publishers) {
      steps.push(
        await runStep(`pearl.publisher.start.${pub.id}`, () =>
          applyCommand(pearlId, () => pearl.startPublisher(pearlHost, pub.channelId, pub.id)),
        ),
      );
    }
  }

  res.json({ ok: steps.every((s) => s.ok), steps });
});

// Stop session: stop publishers + recorder, release cameras.
router.post('/:roomId/stop-session', async (req, res) => {
  const refs = resolveStudio(req.params.roomId);
  if (!refs) return res.status(404).json({ error: 'room not found' });
  const steps: StepResult[] = [];

  // Stop publishers first (streaming can keep finalizing its last segment for
  // a beat), then parallel-fire the Pearl + DAW record stops so the trailing
  // edges are aligned to the same wall-clock instant.
  if (refs.pearl) {
    const pearlId = refs.pearl.id;
    const pearlHost = refs.pearl.ip;
    for (const pub of refs.pearl.publishers) {
      steps.push(
        await runStep(`pearl.publisher.stop.${pub.id}`, () =>
          applyCommand(pearlId, () => pearl.stopPublisher(pearlHost, pub.channelId, pub.id)),
        ),
      );
    }
  }

  const stops: Promise<StepResult>[] = [];
  if (refs.pearl) {
    const pearlId = refs.pearl.id;
    const pearlHost = refs.pearl.ip;
    stops.push(runStep('pearl.record-all.stop', async () => {
      const t0 = Date.now();
      await applyCommand(pearlId, () => pearl.stopAllRecorders(pearlHost));
      return { latencyMs: Date.now() - t0 };
    }));
  }
  if (refs.daw) {
    const dawId = refs.daw.id;
    stops.push(runStep('daw.record-stop', async () => {
      const t0 = Date.now();
      const delivered = sendDawCommand(dawId, 'record-stop');
      if (!delivered) throw new Error('DAW sidecar not connected');
      return { latencyMs: Date.now() - t0 };
    }));
  }
  steps.push(...(await Promise.all(stops)));

  for (const cam of refs.cams) {
    steps.push(await runStep(`canon.release.${cam.id}`, () => canon.release(cam.id, cam.ip)));
  }

  res.json({ ok: steps.every((s) => s.ok), steps });
});

export default router;
