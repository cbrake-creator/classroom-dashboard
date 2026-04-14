// ──────────────────────────────────────────────────────────
//  In-memory canonical state.
//  All reads and writes go through here so the deviceManager
//  can broadcast diffs without callers needing to know.
// ──────────────────────────────────────────────────────────
import type { Campus, DashboardState, Device, Room } from '../types.js';
import { buildInitialState } from '../fixtures/rooms.js';

let state: DashboardState = buildInitialState();

export function getState(): DashboardState {
  return state;
}

export function getCampus(campusId: string): Campus | undefined {
  return state.campuses.find((c) => c.id === campusId);
}

export function getRoom(roomId: string): { campus: Campus; room: Room } | undefined {
  for (const campus of state.campuses) {
    const room = campus.rooms.find((r) => r.id === roomId);
    if (room) return { campus, room };
  }
  return undefined;
}

export function getDevice(deviceId: string): { campus: Campus; room: Room; device: Device } | undefined {
  for (const campus of state.campuses) {
    for (const room of campus.rooms) {
      const device = room.devices.find((d) => d.id === deviceId);
      if (device) return { campus, room, device };
    }
  }
  return undefined;
}

export function patchDevice(deviceId: string, patch: Partial<Device>): { campus: Campus; room: Room; device: Device } | undefined {
  const found = getDevice(deviceId);
  if (!found) return undefined;
  Object.assign(found.device, patch);
  found.device.lastSeen = Date.now();
  return found;
}

export function resetState(): void {
  state = buildInitialState();
}
