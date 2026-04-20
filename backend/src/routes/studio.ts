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
import type { CameraDevice, MacDevice, PearlDevice } from '../types.js';

const log = logger.child({ svc: 'studio' });
const router = Router();

interface StudioRefs {
  pearl: PearlDevice | null;
  mac: MacDevice | null;
  cams: CameraDevice[];
}

function resolveStudio(roomId: string): StudioRefs | null {
  const found = getRoom(roomId);
  if (!found) return null;
  const refs: StudioRefs = { pearl: null, mac: null, cams: [] };
  for (const d of found.room.devices) {
    if (d.type === 'pearl') refs.pearl = d;
    else if (d.type === 'mac') refs.mac = d;
    else if (d.type === 'camera') refs.cams.push(d);
  }
  return refs;
}

interface StepResult {
  step: string;
  ok: boolean;
  error?: string;
}

async function runStep(name: string, fn: () => Promise<unknown>): Promise<StepResult> {
  if (config.deviceMode === 'mock') {
    log.debug({ step: name }, 'mock mode: step skipped');
    return { step: name, ok: true };
  }
  try {
    await fn();
    return { step: name, ok: true };
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

  if (refs.pearl) {
    const pearlId = refs.pearl.id;
    const pearlHost = refs.pearl.ip;
    for (const rec of refs.pearl.recorders) {
      steps.push(
        await runStep(`pearl.recorder.start.${rec.id}`, () =>
          applyCommand(pearlId, () => pearl.startRecorder(pearlHost, rec.id)),
        ),
      );
    }
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
    for (const rec of refs.pearl.recorders) {
      steps.push(
        await runStep(`pearl.recorder.stop.${rec.id}`, () =>
          applyCommand(pearlId, () => pearl.stopRecorder(pearlHost, rec.id)),
        ),
      );
    }
  }

  for (const cam of refs.cams) {
    steps.push(await runStep(`canon.release.${cam.id}`, () => canon.release(cam.id, cam.ip)));
  }

  res.json({ ok: steps.every((s) => s.ok), steps });
});

export default router;
