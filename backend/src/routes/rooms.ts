// ──────────────────────────────────────────────────────────
//  Read-only state endpoints. The frontend hits /api/rooms
//  once on boot (or any time it wants a fresh snapshot
//  outside the socket stream).
// ──────────────────────────────────────────────────────────
import { Router } from 'express';
import { getCampus, getDevice, getRoom, getState } from '../services/roomState.js';

const router = Router();

router.get('/rooms', (_req, res) => {
  res.json(getState());
});

router.get('/campus/:campusId', (req, res) => {
  const campus = getCampus(req.params.campusId);
  if (!campus) {
    res.status(404).json({ error: 'campus not found' });
    return;
  }
  res.json(campus);
});

router.get('/room/:roomId', (req, res) => {
  const found = getRoom(req.params.roomId);
  if (!found) {
    res.status(404).json({ error: 'room not found' });
    return;
  }
  res.json({ campusId: found.campus.id, room: found.room });
});

router.get('/device/:deviceId', (req, res) => {
  const found = getDevice(req.params.deviceId);
  if (!found) {
    res.status(404).json({ error: 'device not found' });
    return;
  }
  res.json({ campusId: found.campus.id, roomId: found.room.id, device: found.device });
});

export default router;
