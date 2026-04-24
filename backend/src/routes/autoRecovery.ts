// ──────────────────────────────────────────────────────────
//  Auto-recovery toggle + manual-run endpoints.
//
//  GET  /api/auto-recovery          → status (enabled, lastRun, nextRun, smtpConfigured)
//  POST /api/auto-recovery/toggle   → flip enabled
//  POST /api/auto-recovery/run-now  → trigger a recovery sweep right now
// ──────────────────────────────────────────────────────────
import { Router } from 'express';
import * as auto from '../services/autoRecovery.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(auto.getStatus());
});

router.post('/toggle', (req, res) => {
  const next = req.body?.enabled === undefined ? !auto.isEnabled() : Boolean(req.body.enabled);
  auto.setEnabled(next);
  res.json({ enabled: next });
});

router.post('/run-now', async (_req, res, next) => {
  try {
    const summary = await auto.runOnce('manual');
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

export default router;
