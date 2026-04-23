// ──────────────────────────────────────────────────────────
//  Rooms / campuses fixture data.
//  Ported from the original CONFIG block in dashboard.html.
//  This is the canonical "looks-pristine" state served when
//  real device polls fail (DEVICE_MODE=fallback or mock).
// ──────────────────────────────────────────────────────────
import type {
  CameraDevice,
  Campus,
  DashboardState,
  DawDevice,
  DawStrip,
  DisplayDevice,
  MacDevice,
  NetworkSwitchDevice,
  NucDevice,
  PearlDevice,
  RallyBarDevice,
  Room,
  SightDevice,
  TapDevice,
} from '../types.js';
import { config } from '../config.js';

const camAuth = { enabled: true, username: 'admin', password: 'env:CAM_PASS' };

// ─── Helpers (mirror the dashboard.html factories) ─────────
function makeClassroomDevices(subnet: number, tvCount: number) {
  const base = `10.1.${subnet}`;
  const devices: Array<CameraDevice | NucDevice | NetworkSwitchDevice | DisplayDevice> = [
    {
      id: 'cam-1',
      type: 'camera',
      brand: 'Canon',
      model: 'CR-N300',
      ip: `${base}.100`,
      apiBase: `http://${base}.100/-wvhttp-01-`,
      auth: camAuth,
      status: 'online',
      autoTrack: true,
      power: true,
      panPos: 0,
      tiltPos: 0,
      zoomPos: 50,
      sessionActive: false,
      controlClaimed: false,
      livescopeStatus: 0,
      livescopeMsg: 'OK',
      powerTransition: null,
    },
    {
      id: 'nuc-1',
      type: 'nuc',
      brand: 'Intel',
      model: 'NUC 12',
      ip: `${base}.101`,
      status: 'online',
      power: true,
      cpu: Math.floor(Math.random() * 30) + 5,
      mem: Math.floor(Math.random() * 30) + 25,
    },
    {
      id: 'sw-1',
      type: 'network-switch',
      brand: 'Netgear',
      model: 'M4250',
      ip: `${base}.102`,
      status: 'online',
      ports: Array.from({ length: 6 }, (_, i) => ({ num: i + 1, up: true })),
    },
  ];
  const brands = ['Samsung', 'LG', 'Samsung', 'Sony', 'LG', 'Samsung', 'Sony'];
  const models = ['QBR 65"', 'UL3J 55"', 'QBR 65"', 'BZ40J 55"', 'UL3J 55"', 'QBR 65"', 'BZ40J 55"'];
  for (let i = 0; i < tvCount; i++) {
    devices.push({
      id: `tv-${i + 1}`,
      type: 'display',
      brand: brands[i % brands.length]!,
      model: models[i % models.length]!,
      ip: `${base}.${110 + i}`,
      status: 'online',
      power: true,
      currentInput: 'HDMI1',
      correctInput: 'HDMI1',
    });
  }
  return devices;
}

function makeClassroom(
  id: string,
  name: string,
  subnet: number,
  tvCount: number,
  cameraIp?: string,
  override?: (r: Room) => void,
  type: Room['type'] = 'classroom',
  pearlIp?: string,
): Room {
  const room: Room = {
    id,
    name,
    type,
    devices: makeClassroomDevices(subnet, tvCount),
  };
  if (cameraIp) {
    const cam = room.devices[0] as CameraDevice;
    cam.ip = cameraIp;
    cam.apiBase = `http://${cameraIp}/-wvhttp-01-`;
  }
  if (pearlIp) {
    room.devices.push(makePearlStub(pearlIp, `${name} Pearl`));
  }
  if (override) override(room);
  return room;
}

// Minimal Pearl device stub — deviceManager will overwrite every field via
// live polling on boot. Name is cosmetic; the IP is what matters.
function makePearlStub(ip: string, name: string): PearlDevice {
  return {
    id: 'pearl-1',
    type: 'pearl',
    brand: 'Epiphan',
    model: 'Pearl 2',
    ip,
    apiBase: `http://${ip}/api/v2.0`,
    auth: { enabled: true, username: config.pearl.username, password: 'env:PEARL_PASSWORD' },
    status: 'online',
    power: true,
    firmware: '—',
    cpu: 0,
    temp: 0,
    uptime: '—',
    storage: { freeGb: 0, totalGb: 0 },
    channels: [],
    recorders: [],
    publishers: [],
    sources: [],
  };
}

function makeHybridClassroomDevices(subnet: number, tvCount: number) {
  const base = `10.1.${subnet}`;
  const devices: Array<RallyBarDevice | TapDevice | SightDevice | NucDevice | NetworkSwitchDevice | DisplayDevice> = [
    {
      id: 'rally-bar-1',
      type: 'rally-bar',
      brand: 'Logitech',
      model: 'Rally Bar',
      ip: `${base}.100`,
      status: 'online',
      power: true,
      inCall: false,
      firmware: '1.12.150',
    },
    { id: 'tap-1', type: 'tap', brand: 'Logitech', model: 'Tap', ip: `${base}.101`, status: 'online', power: true },
    { id: 'sight-1', type: 'sight', brand: 'Logitech', model: 'Sight Triple', ip: `${base}.102`, status: 'online', power: true },
    {
      id: 'nuc-1',
      type: 'nuc',
      brand: 'Intel',
      model: 'NUC 12',
      ip: `${base}.103`,
      status: 'online',
      power: true,
      cpu: Math.floor(Math.random() * 30) + 5,
      mem: Math.floor(Math.random() * 30) + 25,
    },
    {
      id: 'sw-1',
      type: 'network-switch',
      brand: 'Netgear',
      model: 'M4250',
      ip: `${base}.104`,
      status: 'online',
      ports: Array.from({ length: 6 }, (_, i) => ({ num: i + 1, up: true })),
    },
  ];
  const brands = ['Samsung', 'LG', 'Samsung', 'Sony', 'LG', 'Samsung', 'Sony'];
  const models = ['QBR 65"', 'UL3J 55"', 'QBR 65"', 'BZ40J 55"', 'UL3J 55"', 'QBR 65"', 'BZ40J 55"'];
  for (let i = 0; i < tvCount; i++) {
    devices.push({
      id: `tv-${i + 1}`,
      type: 'display',
      brand: brands[i % brands.length]!,
      model: models[i % models.length]!,
      ip: `${base}.${110 + i}`,
      status: 'online',
      power: true,
      currentInput: 'HDMI1',
      correctInput: 'HDMI1',
    });
  }
  return devices;
}

function makeHybridClassroom(id: string, name: string, subnet: number, tvCount: number): Room {
  return { id, name, type: 'classroom', devices: makeHybridClassroomDevices(subnet, tvCount) };
}

function makeConference(
  id: string,
  name: string,
  subnet: number,
  override?: (r: Room) => void,
  opts?: { rallyBarIp?: string; rallyBarMini?: boolean; firmware?: string },
): Room {
  const base = `10.1.${subnet}`;
  const rbIp = opts?.rallyBarIp ?? `${base}.100`;
  const devices: Array<RallyBarDevice | TapDevice | SightDevice> = [
    {
      id: 'rally-bar-1',
      type: 'rally-bar',
      brand: 'Logitech',
      model: opts?.rallyBarMini ? 'Rally Bar Mini' : 'Rally Bar',
      ip: rbIp,
      status: 'online',
      power: true,
      inCall: false,
      firmware: opts?.firmware ?? '—',
    },
    // Tap + Sight don't have IPs — they chain off the Rally Bar via USB.
    // Their reachability rides on the Rally Bar's ping.
    { id: 'tap-1', type: 'tap', brand: 'Logitech', model: 'Tap', ip: `via ${rbIp}`, status: 'online', power: true },
    { id: 'sight-1', type: 'sight', brand: 'Logitech', model: 'Sight', ip: `via ${rbIp}`, status: 'online', power: true },
  ];
  const room: Room = { id, name, type: 'conference', devices };
  if (override) override(room);
  return room;
}

// ─── Faculty Podcast Studio (Faculty studio on 10.56) ──────
function makeFacultyPodcastStudio(): Room {
  const cam = (n: number, ipLast: number, label: string): CameraDevice => ({
    id: `studio-cam-${n}`,
    type: 'camera',
    brand: 'Canon',
    model: 'CR-N300',
    label,
    ip: `10.56.1.${ipLast}`,
    apiBase: `http://10.56.1.${ipLast}/-wvhttp-01-`,
    auth: { enabled: true, username: 'admin', password: 'env:CAM_PASS' },
    status: 'online',
    autoTrack: false,
    power: true,
    panPos: 0,
    tiltPos: 0,
    zoomPos: 50,
    sessionActive: false,
    controlClaimed: false,
    livescopeStatus: 0,
    livescopeMsg: 'OK',
    powerTransition: null,
  });

  // Faculty Podcast Studio's Pearl 2 — mDNS-advertised as its serial
  // "TS25901165" instead of a friendly name, which is why it didn't show up
  // in the first "Pearl"-filtered scan.
  const pearl = makePearlStub('10.56.1.236', 'Faculty Podcast Pearl');
  // Captured from ARP on the dashboard Mac; needed for Prep Studio's WOL.
  // If the Pearl gets replaced, update this from: arp -an | grep 10.56.1.236
  pearl.wolMac = '00:05:b7:f8:3c:ba';

  const mac: MacDevice = {
    id: 'mac-1',
    type: 'mac',
    brand: 'Apple',
    model: 'Mac Studio (M2 Max)',
    ip: config.mac.host,
    ssh: {
      host: config.mac.host,
      user: config.mac.user,
      port: config.mac.port,
      keyPath: config.mac.keyPath,
    },
    status: 'online',
    power: true,
    cpu: 22,
    mem: 41,
    disk: { freeGb: 780, totalGb: 2000 },
    uptime: '3d 14h',
    audio: { output: 'Rodecaster Pro II', input: 'Rodecaster Pro II Main', volume: 65 },
    apps: [
      { name: 'OBS Studio', running: true, pid: 4421 },
      { name: 'Audio Hijack', running: true, pid: 4520 },
      { name: 'Rode Central', running: true, pid: 4610 },
      { name: 'Zoom', running: false, pid: null },
    ],
  };

  // The DAW is a logical device — a sidecar process on the Mac above
  // opens a Socket.IO connection to us and owns the real audio I/O.
  // Until the sidecar dials in, status is 'offline' and sidecarConnected
  // is false; the sidecarServer flips these on connect. Strip labels below
  // are the defaults shown before the sidecar's hello arrives; once it does,
  // they're replaced by whatever STRIPS= in sidecar.env says.
  const dawStrips = [
    'Main Mix L',
    'Main Mix R',
    'Mic 1 (Host) L',
    'Mic 1 (Host) R',
    'Mic 2 (Guest A) L',
    'Mic 2 (Guest A) R',
    'Mic 3 (Guest B) L',
    'Mic 3 (Guest B) R',
    'Mic 4 (Guest C) L',
    'Mic 4 (Guest C) R',
    'Ch 11',
    'Ch 12',
    'Ch 13',
    'Ch 14',
  ].map((name, i): DawStrip => ({
    name,
    channel: i + 1,
    faderDb: 0,
    muted: i >= 10,
    solo: false,
    peakDb: null,
  }));

  const daw: DawDevice = {
    id: 'daw-1',
    type: 'daw',
    brand: 'DTS',
    model: 'Studio DAW (sidecar)',
    ip: `via ${config.mac.host}`,
    status: 'offline',
    power: true,
    sidecarConnected: false,
    sidecarVersion: null,
    captureDevice: 'Rodecaster Pro II',
    sampleRate: 48000,
    presetSlot: null,
    strips: dawStrips,
    recording: { active: false, startedAt: null, durationSec: 0, outputPath: null },
    monitoring: false,
    outputDir: null,
  };

  return {
    id: 'faculty-podcast',
    name: 'Faculty Podcast Studio',
    type: 'studio',
    devices: [pearl, cam(1, 244, 'Left'), cam(2, 242, 'Center'), cam(3, 243, 'Right'), mac, daw],
  };
}

// ─── Tech Talks Studio ─────────────────────────────────────
// Student tech talks — separate from Faculty Podcast. Has its own Pearl 2
// at 10.56.1.246 (mDNS name: "Tech Talk Pearl"). Cameras/Mac/etc unknown,
// so just the encoder for now.
function makeTechTalksStudio(): Room {
  return {
    id: 'tech-talks',
    name: 'Tech Talks Studio',
    type: 'studio',
    devices: [makePearlStub('10.56.1.246', 'Tech Talk Pearl')],
  };
}

// ─── Campuses ──────────────────────────────────────────────
export function buildInitialState(): DashboardState {
  const dallas: Campus = {
    id: 'dallas',
    name: 'Dallas',
    isHome: true,
    rooms: [
      // Hybrid classrooms
      makeHybridClassroom('cac-201', 'CAC 201', 33, 4),
      makeHybridClassroom('cac-202', 'CAC 202', 34, 4),
      // CAC 102 — conference room that uses classroom-style tech (camera, NUC, switch, TVs)
      makeClassroom('cac-102', 'CAC 102', 32, 4, '10.56.24.240', undefined, 'conference'),
      // Regular classrooms
      makeClassroom('cac-203', 'CAC 203', 1, 7, '10.56.24.198'),
      makeClassroom('cac-204', 'CAC 204', 2, 4, '10.56.24.217'),
      makeClassroom('cac-205', 'CAC 205', 3, 4, '10.56.24.232'),
      makeClassroom('cac-206', 'CAC 206', 4, 4, '10.56.24.222'),
      makeClassroom('cac-207', 'CAC 207', 5, 4, '10.56.24.229'),
      makeClassroom('cac-208', 'CAC 208', 6, 4, '10.56.24.233', (r) => {
        // Demo issue: NUC offline
        const nuc = r.devices[1] as NucDevice;
        nuc.status = 'offline';
        nuc.power = false;
        nuc.cpu = 0;
        nuc.mem = 0;
      }),
      makeClassroom('cac-211', 'CAC 211', 7, 4, '10.56.24.225'),
      makeClassroom('todd-114', 'Todd 114', 8, 4, '10.56.24.237'),
      makeClassroom('todd-115', 'Todd 115', 9, 4, '10.56.24.238'),
      makeClassroom('todd-215', 'Todd 215', 10, 4, '10.56.24.197'),
      makeHybridClassroom('todd-216', 'Todd 216', 35, 4),
      makeClassroom('todd-217', 'Todd 217', 11, 4, '10.56.24.227', (r) => {
        const sw = r.devices[2] as NetworkSwitchDevice;
        sw.ports[3]!.up = false;
        const tv = r.devices[4] as DisplayDevice;
        tv.status = 'offline';
        tv.power = false;
      }),
      makeClassroom('todd-218', 'Todd 218', 12, 4, '10.56.24.230'),
      // Preaching labs — each has a Pearl 2 encoder.
      makeClassroom('todd-313', 'Todd 313', 13, 4, '10.56.24.212', undefined, 'classroom', '10.56.1.204'),
      makeClassroom('todd-315', 'Todd 315', 14, 4, '10.56.24.235', undefined, 'classroom', '10.56.1.186'),
      makeClassroom('todd-317', 'Todd 317', 15, 4, '10.56.24.236', undefined, 'classroom', '10.56.1.135'),
      makeClassroom('todd-320', 'Todd 320', 16, 4, '10.56.1.224'),
      makeHybridClassroom('wsc-333', 'WSC 333', 36, 4),
      makeHybridClassroom('wsc-334', 'WSC 334', 37, 4),
      // Conference rooms — Rally Bar IPs sourced from Logitech Sync CSV export
      // (Device_export_2026-04-21). Firmware versions from same export.
      makeConference('bailey-101a', 'Bailey 101a', 38, undefined, { rallyBarIp: '10.56.1.238', firmware: '2.0.105' }),
      makeConference('bailey-101b', 'Bailey 101b', 39, undefined, { rallyBarIp: '10.56.1.194' }),
      makeConference('mosher-109', 'Mosher 109', 20, undefined, { rallyBarIp: '10.56.1.207' }),
      makeConference('mosher-110', 'Mosher 110', 21, undefined, { rallyBarIp: '10.56.1.221' }),
      makeConference('mosher-204', 'Mosher 204', 22, undefined, { rallyBarIp: '10.56.1.217' }),
      makeConference('mosher-205', 'Mosher 205', 23, undefined, { rallyBarIp: '10.56.1.220' }),
      makeConference('stearns-208', 'Stearns 208', 24, undefined, { rallyBarIp: '10.56.24.201', rallyBarMini: true }),
      makeConference('stearns-003', 'Stearns 003', 25, undefined, { rallyBarIp: '10.56.24.206', rallyBarMini: true }),
      makeConference('stearns-206', 'Stearns 206', 40, undefined, { rallyBarIp: '10.56.24.199', rallyBarMini: true }),
      makeConference('wsc-108h', 'WSC 108h', 26, undefined, { rallyBarIp: '10.56.24.195', rallyBarMini: true }),
      makeConference('wsc-206', 'WSC 206', 27, undefined, { rallyBarIp: '10.56.1.201' }),
      makeConference('horner-204', 'Horner 204', 28, undefined, { rallyBarIp: '10.56.1.182' }),
      makeConference('horner-304', 'Horner 304', 29, (r) => {
        r.devices.push(
          {
            id: 'nuc-1',
            type: 'nuc',
            brand: 'Intel',
            model: 'NUC 12',
            ip: '10.1.29.103',
            status: 'online',
            power: true,
            cpu: Math.floor(Math.random() * 20) + 5,
            mem: Math.floor(Math.random() * 20) + 25,
          },
          {
            id: 'yamaha-1',
            type: 'audio',
            brand: 'Yamaha',
            model: 'Audio System',
            ip: '10.1.29.104',
            status: 'online',
            power: true,
          },
        );
      }, { rallyBarIp: '10.56.1.247' }),
      makeConference('mitchell-109e', 'Mitchell 109E', 30, undefined, { rallyBarIp: '10.56.24.211', rallyBarMini: true }),
      makeConference('hendricks-207', 'Hendricks 207 (Seay Library)', 31, undefined, { rallyBarIp: '10.56.1.187' }),
      // Studios
      makeFacultyPodcastStudio(),
      makeTechTalksStudio(),
    ],
  };

  const houston: Campus = {
    id: 'houston',
    name: 'Houston',
    isHome: false,
    rooms: [
      {
        id: 'h-c101',
        name: 'Classroom 101',
        type: 'classroom',
        devices: [
          {
            id: 'cam-1',
            type: 'camera',
            brand: 'Canon',
            model: 'CR-N300',
            ip: '10.2.1.100',
            apiBase: 'http://10.2.1.100/-wvhttp-01-',
            auth: camAuth,
            status: 'online',
            autoTrack: true,
            power: true,
            panPos: 0,
            tiltPos: 0,
            zoomPos: 50,
            sessionActive: false,
            controlClaimed: false,
            livescopeStatus: 0,
            livescopeMsg: 'OK',
            powerTransition: null,
          },
          { id: 'nuc-1', type: 'nuc', brand: 'Intel', model: 'NUC 12', ip: '10.2.1.101', status: 'online', power: true, cpu: 15, mem: 45 },
          { id: 'tv-1', type: 'display', brand: 'Samsung', model: 'QBR 65"', ip: '10.2.1.110', status: 'online', power: true, currentInput: 'HDMI1', correctInput: 'HDMI1' },
          { id: 'tv-2', type: 'display', brand: 'Samsung', model: 'QBR 65"', ip: '10.2.1.111', status: 'online', power: true, currentInput: 'HDMI1', correctInput: 'HDMI1' },
        ],
      },
      {
        id: 'h-c102',
        name: 'Classroom 102',
        type: 'classroom',
        devices: [
          {
            id: 'cam-1',
            type: 'camera',
            brand: 'Canon',
            model: 'CR-N300',
            ip: '10.2.2.100',
            apiBase: 'http://10.2.2.100/-wvhttp-01-',
            auth: camAuth,
            status: 'online',
            autoTrack: true,
            power: true,
            panPos: 0,
            tiltPos: 0,
            zoomPos: 50,
            sessionActive: false,
            controlClaimed: false,
            livescopeStatus: 0,
            livescopeMsg: 'OK',
            powerTransition: null,
          },
          { id: 'nuc-1', type: 'nuc', brand: 'Intel', model: 'NUC 12', ip: '10.2.2.101', status: 'online', power: true, cpu: 9, mem: 38 },
          { id: 'tv-1', type: 'display', brand: 'LG', model: 'UL3J 55"', ip: '10.2.2.110', status: 'online', power: true, currentInput: 'HDMI1', correctInput: 'HDMI1' },
          { id: 'tv-2', type: 'display', brand: 'LG', model: 'UL3J 55"', ip: '10.2.2.111', status: 'online', power: true, currentInput: 'HDMI1', correctInput: 'HDMI1' },
        ],
      },
      {
        id: 'h-conf-1',
        name: 'Conference 1',
        type: 'conference',
        devices: [
          { id: 'tv-1', type: 'display', brand: 'Samsung', model: 'QBR 75"', ip: '10.2.10.110', status: 'online', power: true, currentInput: 'HDMI1', correctInput: 'HDMI1' },
          { id: 'nuc-1', type: 'nuc', brand: 'Intel', model: 'NUC 12', ip: '10.2.10.101', status: 'online', power: true, cpu: 4, mem: 20 },
        ],
      },
    ],
  };

  const fortworth: Campus = {
    id: 'fortworth',
    name: 'Fort Worth',
    isHome: false,
    rooms: [
      {
        id: 'fw-c101',
        name: 'Classroom 101',
        type: 'classroom',
        devices: [
          {
            id: 'cam-1',
            type: 'camera',
            brand: 'Canon',
            model: 'CR-N300',
            ip: '10.3.1.100',
            apiBase: 'http://10.3.1.100/-wvhttp-01-',
            auth: camAuth,
            status: 'offline',
            autoTrack: false,
            power: false,
            panPos: 0,
            tiltPos: 0,
            zoomPos: 0,
            sessionActive: false,
            controlClaimed: false,
            livescopeStatus: 0,
            livescopeMsg: 'OK',
            powerTransition: null,
          },
          { id: 'nuc-1', type: 'nuc', brand: 'Intel', model: 'NUC 12', ip: '10.3.1.101', status: 'online', power: true, cpu: 18, mem: 50 },
          { id: 'tv-1', type: 'display', brand: 'LG', model: 'UL3J 55"', ip: '10.3.1.110', status: 'online', power: true, currentInput: 'HDMI1', correctInput: 'HDMI1' },
        ],
      },
      {
        id: 'fw-conf-1',
        name: 'Conference 1',
        type: 'conference',
        devices: [{ id: 'tv-1', type: 'display', brand: 'Samsung', model: 'QBR 65"', ip: '10.3.10.110', status: 'online', power: true, currentInput: 'HDMI1', correctInput: 'HDMI1' }],
      },
    ],
  };

  const dc: Campus = {
    id: 'dc',
    name: 'Washington DC',
    isHome: false,
    rooms: [
      {
        id: 'dc-c101',
        name: 'Classroom 101',
        type: 'classroom',
        devices: [
          {
            id: 'cam-1',
            type: 'camera',
            brand: 'Canon',
            model: 'CR-N300',
            ip: '10.4.1.100',
            apiBase: 'http://10.4.1.100/-wvhttp-01-',
            auth: camAuth,
            status: 'online',
            autoTrack: true,
            power: true,
            panPos: 0,
            tiltPos: 0,
            zoomPos: 50,
            sessionActive: false,
            controlClaimed: false,
            livescopeStatus: 0,
            livescopeMsg: 'OK',
            powerTransition: null,
          },
          { id: 'nuc-1', type: 'nuc', brand: 'Intel', model: 'NUC 12', ip: '10.4.1.101', status: 'online', power: true, cpu: 11, mem: 40 },
          { id: 'tv-1', type: 'display', brand: 'Samsung', model: 'QBR 65"', ip: '10.4.1.110', status: 'online', power: true, currentInput: 'HDMI1', correctInput: 'HDMI1' },
        ],
      },
      {
        id: 'dc-conf-1',
        name: 'Conference 1',
        type: 'conference',
        devices: [{ id: 'tv-1', type: 'display', brand: 'LG', model: 'UL3J 65"', ip: '10.4.10.110', status: 'online', power: true, currentInput: 'HDMI1', correctInput: 'HDMI1' }],
      },
    ],
  };

  const austin: Campus = {
    id: 'austin',
    name: 'Austin',
    isHome: false,
    rooms: [
      {
        id: 'au-c101',
        name: 'Classroom 101',
        type: 'classroom',
        devices: [
          {
            id: 'cam-1',
            type: 'camera',
            brand: 'Canon',
            model: 'CR-N300',
            ip: '10.5.1.100',
            apiBase: 'http://10.5.1.100/-wvhttp-01-',
            auth: camAuth,
            status: 'online',
            autoTrack: true,
            power: true,
            panPos: 0,
            tiltPos: 0,
            zoomPos: 50,
            sessionActive: false,
            controlClaimed: false,
            livescopeStatus: 0,
            livescopeMsg: 'OK',
            powerTransition: null,
          },
          { id: 'nuc-1', type: 'nuc', brand: 'Intel', model: 'NUC 12', ip: '10.5.1.101', status: 'online', power: true, cpu: 6, mem: 31 },
          { id: 'tv-1', type: 'display', brand: 'Samsung', model: 'QBR 65"', ip: '10.5.1.110', status: 'online', power: true, currentInput: 'HDMI1', correctInput: 'HDMI1' },
        ],
      },
      {
        id: 'au-conf-1',
        name: 'Conference 1',
        type: 'conference',
        devices: [{ id: 'tv-1', type: 'display', brand: 'Samsung', model: 'QBR 55"', ip: '10.5.10.110', status: 'online', power: true, currentInput: 'HDMI1', correctInput: 'HDMI1' }],
      },
    ],
  };

  const state: DashboardState = { campuses: [dallas, houston, fortworth, dc, austin] };
  namespaceDeviceIds(state);
  return state;
}

// Every room used to declare its own cam-1 / nuc-1 / tv-1 / sw-1, so
// roomState.getDevice(id) would silently return the first match across
// the whole campus list — commands aimed at Todd 217's camera would
// hit CAC 201's. We sidestep that by rewriting every device id to
// `${roomId}--${deviceId}` after fixtures are built. Internal
// references that point at device ids (e.g. Rodecaster.detectedVia)
// are rewritten to match.
function namespaceDeviceIds(state: DashboardState): void {
  for (const campus of state.campuses) {
    for (const room of campus.rooms) {
      const rename = new Map<string, string>();
      for (const device of room.devices) {
        const newId = `${room.id}--${device.id}`;
        rename.set(device.id, newId);
        device.id = newId;
      }
      for (const device of room.devices) {
        if (device.type === 'rodecaster') {
          const mapped = rename.get(device.detectedVia);
          if (mapped) device.detectedVia = mapped;
        }
      }
    }
  }
}
