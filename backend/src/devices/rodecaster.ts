// ──────────────────────────────────────────────────────────
//  Rodecaster Pro II — USB-only device.
//
//  Rode does not publish a documented network API. Today this
//  client just probes the Mac it's plugged into for USB presence.
//
//  When a "Rodecaster bridge daemon" exists on the Mac side
//  (USB MIDI/HID → HTTP), this file will gain methods to read
//  channel meters, mute states, and to set them. Until then,
//  strip levels are static fixture data.
// ──────────────────────────────────────────────────────────
import * as mac from './mac.js';
import { logger } from '../logger.js';

const log = logger.child({ device: 'rodecaster' });

export async function getPresence(): Promise<{ connected: boolean; serial: string | null }> {
  try {
    return await mac.getRodecasterUsb();
  } catch (e) {
    log.debug({ err: (e as Error).message }, 'rodecaster usb probe failed');
    return { connected: false, serial: null };
  }
}

// TODO when bridge daemon exists:
// export async function getStrips(): Promise<RodecasterStrip[]> { ... }
// export async function setMute(stripIdx: number, muted: boolean): Promise<void> { ... }
// export async function setLevel(stripIdx: number, db: number): Promise<void> { ... }
