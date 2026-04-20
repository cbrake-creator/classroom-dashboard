// ──────────────────────────────────────────────────────────
//  Preset routes.
//
//    GET  /api/presets/:roomId                  → all 20 presets for room
//    PUT  /api/presets/:roomId/:slot            → { name?, positions? }
//    POST /api/presets/:roomId/:slot/capture    → read current cam positions,
//                                                 save as this preset
//    POST /api/presets/:roomId/:slot/recall     → move all room cameras to
//                                                 the preset's saved positions
// ──────────────────────────────────────────────────────────
import { Router } from 'express';
import * as canon from '../devices/canon.js';
import { getState } from '../services/roomState.js';
import { getRoomPresets, updatePreset, type CamPosition } from '../services/presets.js';
import type { CameraDevice, Room } from '../types.js';

const router = Router();

function findRoom(roomId: string): Room | undefined {
  for (const campus of getState().campuses) {
    for (const room of campus.rooms) {
      if (room.id === roomId) return room;
    }
  }
  return undefined;
}

function roomCameras(room: Room): CameraDevice[] {
  return room.devices.filter((d): d is CameraDevice => d.type === 'camera');
}

router.get('/:roomId', async (req, res, next) => {
  try {
    const room = findRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'room not found' });
    const presets = await getRoomPresets(req.params.roomId);
    res.json({ roomId: room.id, cameras: roomCameras(room).map((c) => ({ id: c.id, label: c.label ?? c.id })), presets });
  } catch (err) {
    next(err);
  }
});

router.put('/:roomId/:slot', async (req, res, next) => {
  try {
    const room = findRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'room not found' });
    const slot = Number(req.params.slot);
    const { name, positions } = req.body ?? {};
    const patch: { name?: string; positions?: Record<string, CamPosition> } = {};
    if (typeof name === 'string') patch.name = name;
    if (positions && typeof positions === 'object') patch.positions = positions as Record<string, CamPosition>;
    const entry = await updatePreset(req.params.roomId, slot, patch);
    res.json(entry);
  } catch (err) {
    next(err);
  }
});

router.post('/:roomId/:slot/capture', async (req, res, next) => {
  try {
    const room = findRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'room not found' });
    const cams = roomCameras(room);
    const positions: Record<string, CamPosition> = {};
    // Read every camera's current pan/tilt/zoom in parallel. A failed cam is
    // just omitted from the preset — the recall will skip it.
    await Promise.all(
      cams.map(async (cam) => {
        try {
          const info = await canon.getInfo(cam.ip);
          positions[cam.id] = { pan: info.panPos, tilt: info.tiltPos, zoom: info.zoomPos };
        } catch {
          // skip unreachable
        }
      }),
    );
    const entry = await updatePreset(req.params.roomId, Number(req.params.slot), { positions });
    res.json(entry);
  } catch (err) {
    next(err);
  }
});

router.post('/:roomId/:slot/recall', async (req, res, next) => {
  try {
    const room = findRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'room not found' });
    const presets = await getRoomPresets(req.params.roomId);
    const slot = Number(req.params.slot);
    if (slot < 1 || slot > 20) return res.status(400).json({ error: 'slot must be 1..20' });
    const preset = presets[slot - 1]!;
    const cams = roomCameras(room);
    const results = await Promise.allSettled(
      cams.map(async (cam) => {
        const pos = preset.positions[cam.id];
        if (!pos) return { id: cam.id, skipped: true };
        await canon.moveTo(cam.id, cam.ip, pos.pan, pos.tilt, pos.zoom);
        return { id: cam.id, skipped: false };
      }),
    );
    res.json({
      preset: preset.name,
      results: results.map((r, i) =>
        r.status === 'fulfilled'
          ? r.value
          : { id: cams[i]!.id, error: (r.reason as Error).message },
      ),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
