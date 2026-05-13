// ──────────────────────────────────────────────────────────
//  Entry point.
//
//  - Boots Express + Socket.IO on the same HTTP server so the
//    websocket upgrade works on the same origin/port as the
//    REST API and the static dashboard HTML.
//  - Serves ../dashboard.html (and any sibling assets) from
//    the project root so visiting http://localhost:3000/ gives
//    you the same UI you'd get opening the file directly.
//  - Starts the device polling loop after the server is up.
// ──────────────────────────────────────────────────────────
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import avioRouter from './routes/avio.js';
import canonRouter from './routes/canon.js';
import dawRouter from './routes/daw.js';
import fsRouter from './routes/fs.js';
import macRouter from './routes/mac.js';
import autoRecoveryRouter from './routes/autoRecovery.js';
import pearlRouter from './routes/pearl.js';
import presetsRouter from './routes/presets.js';
import roomsRouter from './routes/rooms.js';
import uptimeRouter from './routes/uptime.js';
import studioRouter from './routes/studio.js';
import { startPolling, stopPolling } from './services/deviceManager.js';
import * as logitechSync from './devices/logitechSync.js';
import * as autoRecovery from './services/autoRecovery.js';
import * as macClient from './devices/mac.js';
import { initSocketServer } from './ws/socketServer.js';
import { initSidecarNamespace } from './ws/sidecarServer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// repo root holds dashboard.html — backend/src/index.ts → ../../
const repoRoot = resolve(__dirname, '..', '..');

const app = express();

app.use(
  pinoHttp({
    logger,
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'debug';
    },
  }),
);
app.use(cors({ origin: config.allowedOrigins, credentials: true }));
app.use(express.json());

// REST API
app.use('/api', roomsRouter);
app.use('/api/pearl', pearlRouter);
app.use('/api/canon', canonRouter);
app.use('/api/mac', macRouter);
app.use('/api/studio', studioRouter);
app.use('/api/daw', dawRouter);
app.use('/api/avio', avioRouter);
app.use('/api/fs', fsRouter);
app.use('/api/presets', presetsRouter);
app.use('/api/uptime', uptimeRouter);
app.use('/api/auto-recovery', autoRecoveryRouter);

// Health probe — handy for systemd / nginx
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, mode: config.deviceMode });
});

// Static dashboard. Mount AFTER /api so the catch-all index doesn't shadow API routes.
app.get('/', (_req, res) => {
  res.sendFile(resolve(repoRoot, 'dashboard.html'));
});
// Standalone mixer app (ported from local-daw) — click-through from the DAW card.
app.use('/studio/daw', express.static(resolve(repoRoot, 'studio-daw'), { extensions: ['html'] }));
app.use(express.static(repoRoot, { extensions: ['html'] }));

// Error handler — last middleware
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  logger.error({ err }, 'request failed');
  res.status(500).json({ error: (err as Error).message ?? 'internal error' });
};
app.use(errorHandler);

const httpServer = createServer(app);
const io = initSocketServer(httpServer);
initSidecarNamespace(io);

httpServer.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      mode: config.deviceMode,
      origins: config.allowedOrigins,
      docroot: repoRoot,
    },
    'classroom-dashboard backend listening',
  );
  startPolling();
  // Logitech Sync Cloud poll loop (independent of the device-manager poll
  // since it has its own rate limit and runs less frequently).
  logitechSync.startPolling();
  // Auto-recovery scheduler: starts unconditionally, but no-ops every
  // fire if the persisted toggle (data/auto-recovery.json) says disabled.
  autoRecovery.start();
});

// Graceful shutdown
function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  stopPolling();
  logitechSync.stopPolling();
  autoRecovery.stop();
  macClient.disconnect();
  httpServer.close(() => process.exit(0));
  // Hard-exit if close hangs
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
