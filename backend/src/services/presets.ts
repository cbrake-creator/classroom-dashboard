// ──────────────────────────────────────────────────────────
//  Multi-cam presets.
//
//  A preset captures a pan/tilt/zoom position for every camera
//  in a room, so one click can move all 3 Faculty Podcast
//  Studio cameras to a pre-designated layout (Host-close,
//  Guest-wide, Two-shot, etc).
//
//  20 slots per room. Names are editable from the GUI. Positions
//  are captured from whatever the cameras are currently pointing
//  at, then recalled on demand.
//
//  Storage: JSON on disk, outside the repo (backend/data/presets.json).
//  Tiny file (~a few KB) so we rewrite it whole on every change.
// ──────────────────────────────────────────────────────────
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

const log = logger.child({ svc: 'presets' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FILE = resolve(__dirname, '..', '..', 'data', 'presets.json');

export interface CamPosition {
  pan: number;
  tilt: number;
  zoom: number;
}

export interface Preset {
  slot: number; // 1..20
  name: string;
  // Map of cam deviceId → position. Empty object = unset.
  positions: Record<string, CamPosition>;
}

export interface PresetFile {
  rooms: Record<string, Preset[]>; // roomId → 20-slot array
}

const SLOT_COUNT = 20;

function emptyRoom(): Preset[] {
  return Array.from({ length: SLOT_COUNT }, (_, i) => ({
    slot: i + 1,
    name: `Preset ${i + 1}`,
    positions: {},
  }));
}

let cache: PresetFile = { rooms: {} };
let loaded = false;

async function load(): Promise<void> {
  if (loaded) return;
  try {
    const text = await readFile(FILE, 'utf8');
    cache = JSON.parse(text) as PresetFile;
    // Make sure every room entry has exactly SLOT_COUNT presets.
    for (const roomId of Object.keys(cache.rooms)) {
      const arr = cache.rooms[roomId]!;
      while (arr.length < SLOT_COUNT) arr.push({ slot: arr.length + 1, name: `Preset ${arr.length + 1}`, positions: {} });
    }
    loaded = true;
    log.info({ file: FILE, rooms: Object.keys(cache.rooms).length }, 'presets loaded');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = { rooms: {} };
      loaded = true;
      log.info({ file: FILE }, 'no presets file yet; starting empty');
    } else {
      throw err;
    }
  }
}

async function save(): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(cache, null, 2), 'utf8');
}

export async function getRoomPresets(roomId: string): Promise<Preset[]> {
  await load();
  if (!cache.rooms[roomId]) cache.rooms[roomId] = emptyRoom();
  return cache.rooms[roomId]!;
}

export async function updatePreset(
  roomId: string,
  slot: number,
  patch: { name?: string; positions?: Record<string, CamPosition> },
): Promise<Preset> {
  await load();
  if (slot < 1 || slot > SLOT_COUNT) throw new Error(`slot ${slot} out of range`);
  const presets = await getRoomPresets(roomId);
  const entry = presets[slot - 1]!;
  if (patch.name !== undefined) entry.name = patch.name;
  if (patch.positions !== undefined) entry.positions = patch.positions;
  await save();
  return entry;
}
