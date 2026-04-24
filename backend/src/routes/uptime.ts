// ──────────────────────────────────────────────────────────
//  Uptime + per-room issue history.
//
//  GET /api/uptime                       → all rooms with weekly uptime %
//  GET /api/uptime/:roomId               → device-level breakdown + issues
//  GET /api/uptime/health                → tracker stats (debugging)
// ──────────────────────────────────────────────────────────
import { Router } from 'express';
import { getState } from '../services/roomState.js';
import { computeRoomUptime, computeDeviceUptime, getRoomIssues, getStats } from '../services/uptimeTracker.js';

const router = Router();
const WEEK = 7 * 24 * 60 * 60 * 1000;

router.get('/health', (_req, res) => {
  res.json(getStats());
});

router.get('/', (req, res) => {
  const windowMs = Number(req.query.window) || WEEK;
  const rooms = [];
  for (const c of getState().campuses) {
    for (const r of c.rooms) {
      const ids = r.devices.map((d) => d.id);
      const room = computeRoomUptime(ids, windowMs);
      rooms.push({
        campusId: c.id,
        roomId: r.id,
        roomName: r.name,
        uptimePct: room.uptimePct,
        deviceCount: ids.length,
      });
    }
  }
  rooms.sort((a, b) => a.uptimePct - b.uptimePct); // worst first
  res.json({ windowMs, rooms });
});

router.get('/:roomId', (req, res) => {
  const windowMs = Number(req.query.window) || WEEK;
  let foundRoom: { campusId: string; roomId: string; roomName: string; deviceIds: string[] } | null = null;
  for (const c of getState().campuses) {
    for (const r of c.rooms) {
      if (r.id === req.params.roomId) {
        foundRoom = { campusId: c.id, roomId: r.id, roomName: r.name, deviceIds: r.devices.map((d) => d.id) };
      }
    }
  }
  if (!foundRoom) return res.status(404).json({ error: 'room not found' });
  const room = computeRoomUptime(foundRoom.deviceIds, windowMs);
  const issues = getRoomIssues(foundRoom.deviceIds, windowMs);
  // Per-device detail (with friendly names)
  const devices = [];
  for (const c of getState().campuses) {
    for (const r of c.rooms) {
      if (r.id !== req.params.roomId) continue;
      for (const d of r.devices) {
        devices.push({
          deviceId: d.id,
          name: d.label || d.id,
          type: d.type,
          status: d.status,
          ...computeDeviceUptime(d.id, windowMs),
        });
      }
    }
  }
  res.json({
    ...foundRoom,
    windowMs,
    uptimePct: room.uptimePct,
    devices,
    issues,
  });
});

export default router;
