// ──────────────────────────────────────────────────────────
//  Socket.IO server.
//
//  - Sends `state:initial` on every connect so a fresh tab
//    paints immediately without waiting for the next poll.
//  - The deviceManager calls broadcastDeviceUpdate / broadcastDeviceError
//    after each poll cycle; those fan out to every connected client.
//
//  CORS is driven by config.allowedOrigins so the same backend
//  can be hit same-origin during local dev or cross-origin from
//  a future WordPress host without code changes.
// ──────────────────────────────────────────────────────────
import type { Server as HttpServer } from 'node:http';
import { Server as IOServer } from 'socket.io';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getState } from '../services/roomState.js';
import type {
  ClientToServerEvents,
  Device,
  Room,
  ServerToClientEvents,
} from '../types.js';

const log = logger.child({ svc: 'socket' });

let io: IOServer<ClientToServerEvents, ServerToClientEvents> | null = null;

export function initSocketServer(httpServer: HttpServer): IOServer {
  io = new IOServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: {
      origin: config.allowedOrigins,
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    log.info({ id: socket.id, addr: socket.handshake.address }, 'client connected');
    socket.emit('state:initial', getState());

    socket.on('disconnect', (reason) => {
      log.info({ id: socket.id, reason }, 'client disconnected');
    });
  });

  return io;
}

export function broadcastDeviceUpdate(campusId: string, roomId: string, device: Device): void {
  if (!io) return;
  io.emit('device:update', { campusId, roomId, device });
}

export function broadcastDeviceError(
  campusId: string,
  roomId: string,
  deviceId: string,
  error: string,
): void {
  if (!io) return;
  io.emit('device:error', { campusId, roomId, deviceId, error });
}

export function broadcastRoomUpdate(campusId: string, room: Room): void {
  if (!io) return;
  io.emit('room:update', { campusId, room });
}
