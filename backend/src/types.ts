// ──────────────────────────────────────────────────────────
//  Shared types between frontend and backend.
//  Mirrors the shapes the existing dashboard.html renders.
// ──────────────────────────────────────────────────────────

export type DeviceStatus = 'online' | 'offline' | 'unknown';
export type DeviceMode = 'live' | 'mock' | 'fallback';

// ─── Common ────────────────────────────────────────────────
export interface BasicAuth {
  enabled: boolean;
  username: string;
  password: string; // value or "env:VAR_NAME"
}

export interface BaseDevice {
  id: string;
  type: string;
  brand: string;
  model: string;
  ip: string;
  status: DeviceStatus;
  power?: boolean;
  label?: string;
  lastSeen?: number;
  lastError?: string | null;
  // ICMP ping round-trip latency from the dashboard host, when the device's
  // refresh path is ping-based (Rally Bars, NUCs, displays, switches, audio).
  latencyMs?: number;
}

// ─── Camera (Canon CR-N300, XC HTTP CGI) ───────────────────
export interface CameraDevice extends BaseDevice {
  type: 'camera';
  apiBase: string;
  auth: BasicAuth;
  // Canon's real Auto Tracking app (RA-AT001) — available when the app is
  // running + licensed; enabled when tracking is actively on.
  autoTrack: boolean;
  autoTrackAvailable?: boolean;
  autoTrackReason?: string;
  panPos: number;
  tiltPos: number;
  zoomPos: number;
  sessionActive: boolean;
  controlClaimed: boolean;
  livescopeStatus: number;
  livescopeMsg: string;
  powerTransition: 'standby-pending' | 'waking' | null;
}

// ─── NUC ───────────────────────────────────────────────────
export interface NucDevice extends BaseDevice {
  type: 'nuc';
  cpu: number;
  mem: number;
}

// ─── Network switch ────────────────────────────────────────
export interface SwitchPort {
  num: number;
  up: boolean;
}
export interface NetworkSwitchDevice extends BaseDevice {
  type: 'network-switch';
  ports: SwitchPort[];
}

// ─── Display ───────────────────────────────────────────────
export interface DisplayDevice extends BaseDevice {
  type: 'display';
  currentInput: string;
  correctInput: string;
}

// ─── Logitech room kit ─────────────────────────────────────
// healthStatus + peripherals come from Logitech Sync Cloud API when the
// org has a valid Select/Essential/SyncPlus license and a cert is wired.
// Otherwise they stay undefined and the dashboard falls back to ICMP ping.
export interface RallyBarDevice extends BaseDevice {
  type: 'rally-bar';
  inCall: boolean;
  firmware: string;
  healthStatus?: 'NoIssues' | 'Warning' | 'Error';
  peripherals?: Record<string, { expected: number; actual: number }>;
  // Live state from Rally Bar's local CollabOS admin API (when enabled).
  deviceState?: 'IDLE' | 'AUDIO_ONLY' | 'IN_USE';
  micMuted?: boolean;
  speakerMuted?: boolean;
  speakerVolume?: number;
  speakerMaxVolume?: number;
  occupancyCount?: number;
  environmental?: {
    co2?: number;
    tempC?: number;
    humidity?: number;
    pm25?: number;
    presence?: 'OCCUPIED' | 'UNOCCUPIED';
  };
  // Actual connected peripherals from the local API.
  connectedDisplays?: Array<{ hdmiPort: number; width: number; height: number; refreshRate: number }>;
  connectedUsbDevices?: Array<{ name: string; pid: string; vid: string }>;
  serial?: string;
  hostName?: string;
  localAdminEnabled?: boolean;
}
export interface TapDevice extends BaseDevice {
  type: 'tap';
  healthStatus?: 'NoIssues' | 'Warning' | 'Error';
}
export interface SightDevice extends BaseDevice {
  type: 'sight';
  healthStatus?: 'NoIssues' | 'Warning' | 'Error';
}
export interface AudioDevice extends BaseDevice {
  type: 'audio';
}

// ─── Epiphan Pearl 2 (REST API v2.0) ───────────────────────
export interface PearlChannel {
  id: number;
  name: string;
  encoderState: 'running' | 'stopped' | 'error';
  fps: number;
  bitrateKbps: number;
  currentLayout: string;
}
export interface PearlRecorder {
  id: number;
  name: string;
  state: 'recording' | 'stopped' | 'error';
  durationSec: number;
}
export interface PearlPublisher {
  id: number;
  channelId: number;
  type: string; // 'RTMP' | 'RTSP' | ...
  destination: string;
  state: 'streaming' | 'stopped' | 'error';
}
export interface PearlSource {
  id: string;
  name: string;
  connected: boolean;
  label: string;
}
export interface PearlDevice extends BaseDevice {
  type: 'pearl';
  apiBase: string;
  auth: BasicAuth;
  // MAC address (colon or dash separated) used for Wake-on-LAN. Optional —
  // WOL only works if the Pearl has it enabled in BIOS and we're on the
  // same L2 broadcast domain. When absent, Prep skips the wake step.
  wolMac?: string;
  firmware: string;
  cpu: number;
  temp: number;
  uptime: string;
  storage: { freeGb: number; totalGb: number };
  channels: PearlChannel[];
  recorders: PearlRecorder[];
  publishers: PearlPublisher[];
  sources: PearlSource[];
}

// ─── Mac Studio (SSH) ──────────────────────────────────────
export interface MacApp {
  name: string;
  running: boolean;
  pid: number | null;
}
export interface MacAudio {
  output: string;
  input: string;
  volume: number;
}
export interface MacSshConfig {
  host: string;
  user: string;
  port: number;
  keyPath: string;
}
export interface MacDevice extends BaseDevice {
  type: 'mac';
  ssh: MacSshConfig;
  cpu: number;
  mem: number;
  disk: { freeGb: number; totalGb: number };
  uptime: string;
  audio: MacAudio;
  apps: MacApp[];
}

// ─── Rodecaster Pro II (USB via Mac) ───────────────────────
export interface RodecasterStrip {
  name: string;
  levelDb: number | null;
  muted: boolean;
}
export interface RodecasterDevice extends BaseDevice {
  type: 'rodecaster';
  detectedVia: string; // device id of the Mac it's plugged into
  firmware: string;
  serial: string;
  strips: RodecasterStrip[];
}

// ─── DAW sidecar (runs on the studio Mac, dials out to us) ─
// The DAW lives on the studio Mac next to the Rodecaster (PortAudio
// must be local to the hardware). A small sidecar process opens a
// persistent Socket.IO connection out to the dashboard on the
// `/sidecar` namespace; the dashboard relays commands down and
// receives level/state updates back up. Mixer params are shallow-
// persisted on the sidecar so remote clients can all observe the
// same state.
export interface DawStrip {
  name: string;
  channel: number;       // 1-based channel on the capture device
  faderDb: number;       // -inf..+6; UI shows dB
  muted: boolean;
  solo: boolean;
  peakDb: number | null; // most recent peak for meter; null when sidecar offline
}
export interface DawRecordingState {
  active: boolean;
  startedAt: number | null;
  durationSec: number;
  outputPath: string | null;
}
export interface DawDevice extends BaseDevice {
  type: 'daw';
  sidecarConnected: boolean;
  sidecarVersion: string | null;
  captureDevice: string | null;    // e.g. 'Rodecaster Pro II'
  sampleRate: number;
  presetSlot: number | null;
  strips: DawStrip[];
  recording: DawRecordingState;
  monitoring: boolean;
  outputDir: string | null;        // folder where the sidecar writes per-channel WAVs
  // Sidecar self-reported health, pushed every 2s. Lets the dashboard
  // distinguish "sidecar online but mic blocked" from "sidecar offline" etc.
  micState?: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown' | 'n/a';
  deviceState?: 'present' | 'missing' | 'unknown';
  lastPeakAgeMs?: number | null;   // ms since the last non-zero audio sample; null = never
  recordingActive?: boolean;
}

// ─── Union ─────────────────────────────────────────────────
export type Device =
  | CameraDevice
  | NucDevice
  | NetworkSwitchDevice
  | DisplayDevice
  | RallyBarDevice
  | TapDevice
  | SightDevice
  | AudioDevice
  | PearlDevice
  | MacDevice
  | RodecasterDevice
  | DawDevice;

// ─── Rooms / campuses ──────────────────────────────────────
export type RoomType = 'classroom' | 'conference' | 'studio';

export interface Room {
  id: string;
  name: string;
  type: RoomType;
  devices: Device[];
}

export interface Campus {
  id: string;
  name: string;
  isHome: boolean;
  rooms: Room[];
}

export interface DashboardState {
  campuses: Campus[];
}

// ─── Socket.IO event payloads ──────────────────────────────
export interface ServerToClientEvents {
  'state:initial': (state: DashboardState) => void;
  'room:update': (payload: { campusId: string; room: Room }) => void;
  'device:update': (payload: { campusId: string; roomId: string; device: Device }) => void;
  'device:error': (payload: { campusId: string; roomId: string; deviceId: string; error: string }) => void;
}

export interface ClientToServerEvents {
  // none — commands flow over REST and effects come back over the events above
  ping: () => void;
}
