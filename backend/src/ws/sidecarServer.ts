// ──────────────────────────────────────────────────────────
//  Sidecar Socket.IO namespace.
//
//  The DAW runs on the studio Mac next to the Rodecaster
//  because PortAudio has to sit on the hardware. A tiny
//  sidecar process on that Mac opens a persistent Socket.IO
//  connection OUT to this dashboard (on /sidecar), so no
//  inbound ports on the Mac are required.
//
//  Protocol (stub — expand as the sidecar gains surface):
//
//    sidecar → server
//      hello  { token, version, captureDevice, sampleRate, strips }
//      levels { strips: [{channel, peakDb}] }             (~20 Hz)
//      state  { patch: Partial<DawDevice> }               (fader moves, mute, etc.)
//      record { active, startedAt?, durationSec, outputPath? }
//
//    server → sidecar
//      cmd    { op: 'fader'|'mute'|'solo'|'preset'|'record-start'|'record-stop'|..., args: any }
//      ping
//
//  This file is intentionally thin. It owns:
//    - auth on connect
//    - finding/patching the DAW device (by room+id) so the
//      rest of the dashboard sees sidecar events as normal
//      device:update broadcasts
//    - a sendDawCommand() the REST layer can call
// ──────────────────────────────────────────────────────────
import type { Server as IOServer, Socket } from 'socket.io';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getState } from '../services/roomState.js';
import type { Campus, DawDevice, Room } from '../types.js';
import { broadcastDeviceUpdate } from './socketServer.js';

const log = logger.child({ svc: 'sidecar' });

// Single sidecar per DAW device. Keyed by device id.
const connected = new Map<string, Socket>();

function findDaw(): { campus: Campus; room: Room; device: DawDevice } | undefined {
  for (const campus of getState().campuses) {
    for (const room of campus.rooms) {
      for (const device of room.devices) {
        if (device.type === 'daw') return { campus, room, device };
      }
    }
  }
  return undefined;
}

function patchAndBroadcast(patch: Partial<DawDevice>): void {
  const found = findDaw();
  if (!found) return;
  Object.assign(found.device, patch);
  found.device.lastSeen = Date.now();
  broadcastDeviceUpdate(found.campus.id, found.room.id, found.device);
}

export function initSidecarNamespace(io: IOServer): void {
  const nsp = io.of('/sidecar');

  nsp.use((socket, next) => {
    const token = (socket.handshake.auth?.token as string | undefined) ?? '';
    if (config.sidecarToken && token !== config.sidecarToken) {
      log.warn({ id: socket.id }, 'sidecar auth failed');
      next(new Error('unauthorized'));
      return;
    }
    next();
  });

  nsp.on('connection', (socket) => {
    log.info({ id: socket.id, addr: socket.handshake.address }, 'sidecar connected');

    socket.on('hello', (payload: {
      version?: string;
      captureDevice?: string;
      sampleRate?: number;
      outputDir?: string;
      strips?: DawDevice['strips'];
    }) => {
      const found = findDaw();
      if (!found) {
        log.warn('sidecar hello but no DAW device in state');
        return;
      }
      connected.set(found.device.id, socket);
      patchAndBroadcast({
        status: 'online',
        sidecarConnected: true,
        sidecarVersion: payload.version ?? null,
        captureDevice: payload.captureDevice ?? found.device.captureDevice,
        sampleRate: payload.sampleRate ?? found.device.sampleRate,
        outputDir: payload.outputDir ?? found.device.outputDir,
        strips: payload.strips ?? found.device.strips,
      });
    });

    socket.on('levels', (payload: { strips: { channel: number; peakDb: number }[] }) => {
      const found = findDaw();
      if (!found) return;
      const byChannel = new Map(payload.strips.map((s) => [s.channel, s.peakDb]));
      const strips = found.device.strips.map((s) =>
        byChannel.has(s.channel) ? { ...s, peakDb: byChannel.get(s.channel)! } : s,
      );
      patchAndBroadcast({ strips });
    });

    socket.on('state', (payload: { patch: Partial<DawDevice> }) => {
      patchAndBroadcast(payload.patch);
    });

    socket.on('record', (payload: DawDevice['recording']) => {
      patchAndBroadcast({ recording: payload });
    });

    socket.on('disconnect', (reason) => {
      log.info({ id: socket.id, reason }, 'sidecar disconnected');
      const found = findDaw();
      if (found && connected.get(found.device.id) === socket) {
        connected.delete(found.device.id);
        patchAndBroadcast({
          status: 'offline',
          sidecarConnected: false,
          // Null out peaks so meters freeze instead of lying.
          strips: found.device.strips.map((s) => ({ ...s, peakDb: null })),
        });
      }
    });
  });
}

// Called by REST routes. Returns true if delivered.
export function sendDawCommand(deviceId: string, op: string, args?: unknown): boolean {
  const socket = connected.get(deviceId);
  if (!socket) return false;
  socket.emit('cmd', { op, args });
  return true;
}
