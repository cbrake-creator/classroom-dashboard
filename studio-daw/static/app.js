// ═══════════════════════════════════════════════════════
// RØDE Console — Local DAW
// Backend-connected mixing console
// ═══════════════════════════════════════════════════════

const CHANNEL_MAP = [
  { name: 'Main Mix', channels: [0,1], color: 0 },
  { name: 'Mic 1',   channels: [2,3], color: 1 },
  { name: 'Mic 2',   channels: [4,5], color: 2 },
  { name: 'Mic 3',   channels: [6,7], color: 3 },
  { name: 'Mic 4',   channels: [8,9], color: 4 },
  { name: 'USB / BT', channels: [10,11], color: 5 },
  { name: 'Pads',    channels: [12,13], color: 6 },
];

const STRIP_COLORS = ['#e8a824','#4a9eff','#3ddc84','#e84040','#c77dff','#00d4aa','#ff6b9d'];

// ═══════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════
const state = {
  // Audio engine
  audioCtx: null,
  masterGain: null,
  masterLimiter: null,
  limiterEnabled: true,
  masterGainValue: 1.0,

  // Views
  currentView: 'mixer',

  // Channel mixer (input monitoring)
  channels: CHANNEL_MAP.map((ch, i) => ({
    ...ch, index: i,
    fader: 1.0, trim: 0, pan: 0,
    mute: false, solo: false, pfl: false,
    meterL: 0, meterR: 0, peakL: 0, peakR: 0,
  })),

  // Backend connection
  selectedDeviceId: null,
  isMonitoring: false,
  levelSource: null,
  backendChannelMap: [],

  // Recording
  isRecording: false,
  recordStartTime: null,
  recTimerRAF: null,

  // Playback tracks
  tracks: [],
  isPlaying: false,
  startTime: 0,
  pauseOffset: 0,
  animFrameId: null,
  selectedFxTrack: null,
  nextColorIndex: 0,
};

// ═══════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════
function gainToDb(gain) {
  if (gain <= 0) return '-∞';
  const db = 20 * Math.log10(gain);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function formatTime(seconds) {
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(seconds % 60)).padStart(2, '0');
  const ms = String(Math.floor((seconds % 1) * 1000)).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

function getMaxDuration() {
  if (state.tracks.length === 0) return 0;
  return Math.max(...state.tracks.map(t => t.audioBuffer ? t.audioBuffer.duration : 0));
}

function getCurrentTime() {
  if (!state.audioCtx) return 0;
  if (state.isPlaying) return state.audioCtx.currentTime - state.startTime;
  return state.pauseOffset;
}

function levelToPercent(level) {
  if (level <= 0) return 0;
  return Math.min(100, Math.max(0, (1 + 20 * Math.log10(Math.max(level, 0.0001)) / 60) * 100));
}

// ═══════════════════════════════════════════════════════
// AUDIO CONTEXT
// ═══════════════════════════════════════════════════════
function initAudio() {
  if (state.audioCtx) return;
  state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  state.masterGain = state.audioCtx.createGain();
  state.masterGain.gain.value = state.masterGainValue;

  state.masterLimiter = state.audioCtx.createDynamicsCompressor();
  state.masterLimiter.threshold.value = -1;
  state.masterLimiter.ratio.value = 20;
  state.masterLimiter.attack.value = 0.003;
  state.masterLimiter.release.value = 0.01;
  state.masterLimiter.knee.value = 0;

  state.masterGain.connect(state.masterLimiter);
  state.masterLimiter.connect(state.audioCtx.destination);
}

// ═══════════════════════════════════════════════════════
// VIEW SWITCHING
// ═══════════════════════════════════════════════════════
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    state.currentView = view;
  });
});

// ═══════════════════════════════════════════════════════
// BUILD MIXER CHANNEL STRIPS
// ═══════════════════════════════════════════════════════
function buildMixer() {
  const scroll = document.getElementById('mixerScroll');
  scroll.innerHTML = '';

  state.channels.forEach((ch, idx) => {
    const strip = document.createElement('div');
    strip.className = `channel-strip strip-color-${ch.color}`;
    strip.dataset.index = idx;

    strip.innerHTML = `
      <div class="strip-label">${ch.name}</div>
      <div class="meter-container">
        <div class="meter-bar"><div class="meter-fill" id="meterL${idx}" style="height:0%"></div><div class="meter-peak" id="peakL${idx}" style="bottom:0%"></div></div>
        <div class="meter-bar"><div class="meter-fill" id="meterR${idx}" style="height:0%"></div><div class="meter-peak" id="peakR${idx}" style="bottom:0%"></div></div>
      </div>
      <div class="knob-row">
        <div class="knob-group">
          <div class="knob-label">Trim</div>
          <div class="knob" data-param="trim" data-ch="${idx}" data-min="-12" data-max="12" data-value="${ch.trim}" title="Trim: ${ch.trim} dB">
            <div class="knob-bg" style="--knob-pct:50%"></div>
            <div class="knob-cap"></div>
            <div class="knob-indicator" style="--knob-angle:0deg"></div>
          </div>
        </div>
        <div class="knob-group">
          <div class="knob-label">Pan</div>
          <div class="knob" data-param="pan" data-ch="${idx}" data-min="-1" data-max="1" data-value="${ch.pan}" title="Pan: C">
            <div class="knob-bg" style="--knob-pct:50%"></div>
            <div class="knob-cap"></div>
            <div class="knob-indicator" style="--knob-angle:0deg"></div>
          </div>
        </div>
      </div>
      <div class="fader-section">
        <div class="fader-track-container" data-ch="${idx}" data-value="${ch.fader}" data-max="1.5">
          <div class="fader-track"></div>
          <div class="fader-fill-bar" style="height:${(ch.fader/1.5)*100}%"></div>
          <div class="fader-thumb" style="bottom:calc(${(ch.fader/1.5)*100}% - 6px)"></div>
        </div>
        <div class="fader-value">${ch.fader === 1 ? '0.0 dB' : gainToDb(ch.fader)}</div>
      </div>
      <div class="btn-row">
        <button class="strip-btn${ch.mute?' active-mute':''}" data-action="mute" data-ch="${idx}">M</button>
        <button class="strip-btn${ch.solo?' active-solo':''}" data-action="solo" data-ch="${idx}">S</button>
        <button class="strip-btn${ch.pfl?' active-pfl':''}" data-action="pfl" data-ch="${idx}">PFL</button>
      </div>
      <button class="strip-btn" data-action="fx" data-ch="${idx}" style="width:100%;margin-top:2px;font-size:10px;">EQ / FX</button>
    `;

    scroll.appendChild(strip);
  });

  attachMixerEvents();
}

// ═══════════════════════════════════════════════════════
// FADER & KNOB INTERACTION
// ═══════════════════════════════════════════════════════
function attachMixerEvents() {
  // Faders (channel + master)
  document.querySelectorAll('.fader-track-container').forEach(container => {
    let dragging = false;

    const updateFader = (e) => {
      const rect = container.getBoundingClientRect();
      const y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
      const maxVal = parseFloat(container.dataset.max);
      const value = y * maxVal;

      container.querySelector('.fader-fill-bar').style.height = `${y * 100}%`;
      container.querySelector('.fader-thumb').style.bottom = `calc(${y * 100}% - 6px)`;

      const label = container.parentElement.querySelector('.fader-value');

      if (container.dataset.ch !== undefined) {
        const chIdx = parseInt(container.dataset.ch);
        state.channels[chIdx].fader = value;
        if (label) label.textContent = gainToDb(value);
      } else if (container.id === 'masterFader') {
        state.masterGainValue = value;
        if (state.masterGain) state.masterGain.gain.value = value;
        if (label) label.textContent = gainToDb(value);
      }
    };

    container.addEventListener('mousedown', (e) => { dragging = true; updateFader(e); e.preventDefault(); });
    window.addEventListener('mousemove', (e) => { if (dragging) updateFader(e); });
    window.addEventListener('mouseup', () => { dragging = false; });
  });

  // Strip buttons (mute/solo/pfl/fx)
  document.querySelectorAll('.strip-btn[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const ch = parseInt(btn.dataset.ch);

      if (action === 'mute') {
        state.channels[ch].mute = !state.channels[ch].mute;
        btn.classList.toggle('active-mute');
        btn.closest('.channel-strip').classList.toggle('muted', state.channels[ch].mute);
      } else if (action === 'solo') {
        state.channels[ch].solo = !state.channels[ch].solo;
        btn.classList.toggle('active-solo');
        btn.closest('.channel-strip').classList.toggle('soloed', state.channels[ch].solo);
      } else if (action === 'pfl') {
        state.channels[ch].pfl = !state.channels[ch].pfl;
        btn.classList.toggle('active-pfl');
      } else if (action === 'fx') {
        openFxDrawer(ch);
      }
    });
  });

  // Knobs (trim/pan)
  document.querySelectorAll('.knob').forEach(knob => {
    let dragging = false;
    let startY = 0;
    let startValue = 0;

    const updateKnob = (value) => {
      const min = parseFloat(knob.dataset.min);
      const max = parseFloat(knob.dataset.max);
      value = Math.max(min, Math.min(max, value));
      knob.dataset.value = value;

      const pct = ((value - min) / (max - min)) * 75;
      const angle = ((value - min) / (max - min)) * 270 - 135;

      knob.querySelector('.knob-bg').style.setProperty('--knob-pct', `${pct}%`);
      knob.querySelector('.knob-indicator').style.setProperty('--knob-angle', `${angle}deg`);

      const param = knob.dataset.param;
      const ch = parseInt(knob.dataset.ch);
      if (param === 'trim') state.channels[ch].trim = value;
      if (param === 'pan') state.channels[ch].pan = value;
    };

    knob.addEventListener('mousedown', (e) => {
      dragging = true;
      startY = e.clientY;
      startValue = parseFloat(knob.dataset.value);
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const delta = (startY - e.clientY) * 0.1;
      const range = parseFloat(knob.dataset.max) - parseFloat(knob.dataset.min);
      updateKnob(startValue + delta * range * 0.01);
    });

    window.addEventListener('mouseup', () => { dragging = false; });
    updateKnob(parseFloat(knob.dataset.value));
  });
}

// ═══════════════════════════════════════════════════════
// FX DRAWER (EQ + Compressor per channel)
// ═══════════════════════════════════════════════════════
function openFxDrawer(chIdx) {
  const drawer = document.getElementById('fxDrawer');
  const title = document.getElementById('fxDrawerTitle');
  const content = document.getElementById('fxContent');
  const ch = state.channels[chIdx];

  state.selectedFxTrack = chIdx;
  title.textContent = `EQ & Dynamics — ${ch.name}`;
  drawer.classList.add('open');

  // Initialize EQ/comp state if not present
  if (!ch.eq) ch.eq = { low: 0, mid: 0, high: 0 };
  if (!ch.comp) ch.comp = { threshold: -24, ratio: 4, attack: 3, release: 250, knee: 30 };

  content.innerHTML = `
    <div class="fx-section">
      <div class="fx-section-title">Equalizer</div>
      <div class="fx-knobs">
        ${fxKnobHTML('Low', 'eq-low', ch.eq.low, -24, 24, 'dB', chIdx)}
        ${fxKnobHTML('Mid', 'eq-mid', ch.eq.mid, -24, 24, 'dB', chIdx)}
        ${fxKnobHTML('High', 'eq-high', ch.eq.high, -24, 24, 'dB', chIdx)}
      </div>
    </div>
    <div style="width:1px;background:var(--border-groove);align-self:stretch;margin:0 4px"></div>
    <div class="fx-section">
      <div class="fx-section-title">Compressor</div>
      <div class="fx-knobs">
        ${fxKnobHTML('Thresh', 'comp-threshold', ch.comp.threshold, -60, 0, 'dB', chIdx)}
        ${fxKnobHTML('Ratio', 'comp-ratio', ch.comp.ratio, 1, 20, ':1', chIdx)}
        ${fxKnobHTML('Attack', 'comp-attack', ch.comp.attack, 0, 500, 'ms', chIdx)}
        ${fxKnobHTML('Release', 'comp-release', ch.comp.release, 10, 1000, 'ms', chIdx)}
        ${fxKnobHTML('Knee', 'comp-knee', ch.comp.knee, 0, 40, 'dB', chIdx)}
      </div>
    </div>
    <div style="width:1px;background:var(--border-groove);align-self:stretch;margin:0 4px"></div>
    <div class="fx-section">
      <div class="fx-section-title">Freq Reference</div>
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-tertiary);line-height:1.6;">
        Low Shelf: 320 Hz<br>
        Mid Peak: 1 kHz (Q=1)<br>
        High Shelf: 3.2 kHz
      </div>
    </div>
  `;

  // Attach FX knob drag events
  content.querySelectorAll('.fx-knob').forEach(knob => {
    let dragging = false;
    let startY = 0;
    let startValue = 0;

    const updateFxKnob = (value) => {
      const min = parseFloat(knob.dataset.min);
      const max = parseFloat(knob.dataset.max);
      value = Math.max(min, Math.min(max, value));
      knob.dataset.value = value;

      const pct = ((value - min) / (max - min)) * 75;
      const angle = ((value - min) / (max - min)) * 270 - 135;

      knob.querySelector('.knob-bg').style.setProperty('--knob-pct', `${pct}%`);
      knob.querySelector('.knob-indicator').style.setProperty('--knob-angle', `${angle}deg`);

      const valEl = knob.parentElement.querySelector('.fx-knob-value');
      const unit = knob.dataset.unit;
      valEl.textContent = `${Math.round(value * 10) / 10}${unit}`;

      // Update channel state
      const param = knob.dataset.param;
      const chI = parseInt(knob.dataset.ch);
      if (!state.channels[chI].eq) state.channels[chI].eq = { low: 0, mid: 0, high: 0 };
      if (!state.channels[chI].comp) state.channels[chI].comp = { threshold: -24, ratio: 4, attack: 3, release: 250, knee: 30 };
      if (param === 'eq-low') state.channels[chI].eq.low = value;
      if (param === 'eq-mid') state.channels[chI].eq.mid = value;
      if (param === 'eq-high') state.channels[chI].eq.high = value;
      if (param === 'comp-threshold') state.channels[chI].comp.threshold = value;
      if (param === 'comp-ratio') state.channels[chI].comp.ratio = value;
      if (param === 'comp-attack') state.channels[chI].comp.attack = value;
      if (param === 'comp-release') state.channels[chI].comp.release = value;
      if (param === 'comp-knee') state.channels[chI].comp.knee = value;
    };

    knob.addEventListener('mousedown', (e) => {
      dragging = true;
      startY = e.clientY;
      startValue = parseFloat(knob.dataset.value);
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const range = parseFloat(knob.dataset.max) - parseFloat(knob.dataset.min);
      const delta = (startY - e.clientY) * range * 0.005;
      updateFxKnob(startValue + delta);
    });

    window.addEventListener('mouseup', () => { dragging = false; });
    updateFxKnob(parseFloat(knob.dataset.value));
  });
}

function fxKnobHTML(label, param, value, min, max, unit, ch) {
  return `
    <div class="fx-knob-group">
      <div class="fx-knob-label">${label}</div>
      <div class="fx-knob" data-param="${param}" data-ch="${ch}" data-min="${min}" data-max="${max}" data-value="${value}" data-unit="${unit}">
        <div class="knob-bg" style="--knob-pct:50%"></div>
        <div class="knob-cap"></div>
        <div class="knob-indicator" style="--knob-angle:0deg"></div>
      </div>
      <div class="fx-knob-value">${Math.round(value * 10) / 10}${unit}</div>
    </div>
  `;
}

document.getElementById('fxCloseBtn').addEventListener('click', () => {
  document.getElementById('fxDrawer').classList.remove('open');
});

// ═══════════════════════════════════════════════════════
// RECORDING VIEW — Meter pairs
// ═══════════════════════════════════════════════════════
function buildRecordMeters() {
  const container = document.getElementById('recInputMeters');
  container.innerHTML = '';
  const labels = ['Main', 'Mic 1', 'Mic 2', 'Mic 3', 'Mic 4', 'USB', 'Pads'];

  labels.forEach((label, i) => {
    const pair = document.createElement('div');
    pair.className = 'rec-meter-pair';
    pair.innerHTML = `
      <div class="meter-container" style="height:80px;padding:4px 6px">
        <div class="meter-bar" style="width:6px"><div class="meter-fill" id="recMeterL${i}" style="height:0%"></div></div>
        <div class="meter-bar" style="width:6px"><div class="meter-fill" id="recMeterR${i}" style="height:0%"></div></div>
      </div>
      <div class="rec-meter-label">${label}</div>
    `;
    container.appendChild(pair);
  });
}

// ═══════════════════════════════════════════════════════
// TRACK MANAGEMENT (Web Audio playback tracks)
// ═══════════════════════════════════════════════════════
function createTrackNodes(track) {
  const ctx = state.audioCtx;

  track.gainNode = ctx.createGain();
  track.gainNode.gain.value = track.volume;

  track.panNode = ctx.createStereoPanner();
  track.panNode.pan.value = track.pan;

  track.eqLow = ctx.createBiquadFilter();
  track.eqLow.type = 'lowshelf'; track.eqLow.frequency.value = 320; track.eqLow.gain.value = 0;

  track.eqMid = ctx.createBiquadFilter();
  track.eqMid.type = 'peaking'; track.eqMid.frequency.value = 1000; track.eqMid.Q.value = 1; track.eqMid.gain.value = 0;

  track.eqHigh = ctx.createBiquadFilter();
  track.eqHigh.type = 'highshelf'; track.eqHigh.frequency.value = 3200; track.eqHigh.gain.value = 0;

  track.compressor = ctx.createDynamicsCompressor();
  track.compressor.threshold.value = -24;
  track.compressor.ratio.value = 4;
  track.compressor.attack.value = 0.003;
  track.compressor.release.value = 0.25;
  track.compressor.knee.value = 30;

  track.analyser = ctx.createAnalyser();
  track.analyser.fftSize = 2048;
  track.analyser.smoothingTimeConstant = 0.8;

  // Chain: EQ → Comp → Gain → Pan → Analyser → Master
  track.eqLow.connect(track.eqMid);
  track.eqMid.connect(track.eqHigh);
  track.eqHigh.connect(track.compressor);
  track.compressor.connect(track.gainNode);
  track.gainNode.connect(track.panNode);
  track.panNode.connect(track.analyser);
  track.analyser.connect(state.masterGain);
}

function createTrack(filename, url, audioBuffer, info) {
  const id = 'track-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
  const track = {
    id, name: filename.replace(/\.wav$/i, ''),
    color: STRIP_COLORS[state.nextColorIndex % STRIP_COLORS.length],
    filename, url, audioBuffer, info,
    volume: 1.0, pan: 0, muted: false, soloed: false,
    sourceNode: null, gainNode: null, panNode: null,
    eqLow: null, eqMid: null, eqHigh: null,
    compressor: null, analyser: null,
  };
  state.nextColorIndex++;

  createTrackNodes(track);
  state.tracks.push(track);
  renderTrackLane(track);
  updateTrackInfo();
  return track;
}

function removeTrack(trackId) {
  const idx = state.tracks.findIndex(t => t.id === trackId);
  if (idx === -1) return;
  const track = state.tracks[idx];
  if (track.sourceNode) { track.sourceNode.stop(); track.sourceNode.disconnect(); }
  track.eqLow.disconnect(); track.eqMid.disconnect(); track.eqHigh.disconnect();
  track.compressor.disconnect(); track.gainNode.disconnect();
  track.panNode.disconnect(); track.analyser.disconnect();
  state.tracks.splice(idx, 1);
  const el = document.getElementById(trackId);
  if (el) el.remove();
  updateTrackInfo();
  updateMuteSoloState();
}

function updateMuteSoloState() {
  const anySoloed = state.tracks.some(t => t.soloed);
  for (const track of state.tracks) {
    const shouldMute = anySoloed ? !track.soloed : track.muted;
    track.gainNode.gain.value = shouldMute ? 0 : track.volume;
  }
}

function updateTrackInfo() {
  document.getElementById('infoTracks').textContent = state.tracks.length;
  const dropZone = document.getElementById('trackDropZone');
  if (dropZone) dropZone.style.display = state.tracks.length === 0 ? '' : 'none';
}

// ═══════════════════════════════════════════════════════
// TRACK LANE RENDERING (Tracks View)
// ═══════════════════════════════════════════════════════
function renderTrackLane(track) {
  const container = document.getElementById('tracksScroll');
  const lane = document.createElement('div');
  lane.className = 'track-lane';
  lane.id = track.id;

  const info = track.info || {};
  const durStr = info.duration ? `${info.duration.toFixed(1)}s` : '';
  const chStr = info.channels === 1 ? 'Mono' : info.channels === 2 ? 'Stereo' : `${info.channels}ch`;
  const metaStr = [durStr, chStr].filter(Boolean).join(' · ');

  lane.innerHTML = `
    <div class="track-header">
      <div class="track-name" style="border-left:3px solid ${track.color};padding-left:6px">${track.name}</div>
      <div class="track-meta">${metaStr}</div>
      <div class="track-mini-btns">
        <button class="track-mini-btn btn-mute" data-track="${track.id}">M</button>
        <button class="track-mini-btn btn-solo" data-track="${track.id}">S</button>
        <button class="track-mini-btn btn-remove" data-track="${track.id}">&times;</button>
      </div>
    </div>
    <div class="track-waveform-area">
      <div class="waveform-block">
        <canvas class="waveform-canvas"></canvas>
      </div>
    </div>
  `;

  container.appendChild(lane);

  // Draw waveform
  const canvas = lane.querySelector('.waveform-canvas');
  requestAnimationFrame(() => drawWaveform(canvas, track.audioBuffer, track.color));

  const resizeObserver = new ResizeObserver(() => {
    if (track.audioBuffer) drawWaveform(canvas, track.audioBuffer, track.color);
  });
  resizeObserver.observe(lane.querySelector('.track-waveform-area'));

  // Button events
  lane.querySelector('.btn-mute').addEventListener('click', (e) => {
    track.muted = !track.muted;
    e.target.classList.toggle('active-mute', track.muted);
    updateMuteSoloState();
  });
  lane.querySelector('.btn-solo').addEventListener('click', (e) => {
    track.soloed = !track.soloed;
    e.target.classList.toggle('active-solo', track.soloed);
    updateMuteSoloState();
  });
  lane.querySelector('.btn-remove').addEventListener('click', () => removeTrack(track.id));

  // Click waveform to seek
  lane.querySelector('.track-waveform-area').addEventListener('click', (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    seek(frac * getMaxDuration());
  });
}

// ═══════════════════════════════════════════════════════
// WAVEFORM DRAWING
// ═══════════════════════════════════════════════════════
function drawWaveform(canvas, audioBuffer, color) {
  if (!audioBuffer) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;

  ctx.fillStyle = 'rgba(255,255,255,0.02)';
  ctx.fillRect(0, 0, width, height);

  const samples = audioBuffer.getChannelData(0);
  const samplesPerPixel = Math.ceil(samples.length / width);
  const mid = height / 2;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let x = 0; x < width; x++) {
    const start = Math.floor(x * samplesPerPixel);
    const end = Math.min(start + samplesPerPixel, samples.length);
    let min = 1, max = -1;
    for (let i = start; i < end; i++) {
      if (samples[i] < min) min = samples[i];
      if (samples[i] > max) max = samples[i];
    }
    ctx.moveTo(x, mid + min * mid);
    ctx.lineTo(x, mid + max * mid);
  }
  ctx.stroke();

  // Center line
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(width, mid);
  ctx.stroke();
}

// ═══════════════════════════════════════════════════════
// TIMELINE RULER
// ═══════════════════════════════════════════════════════
function buildTimeline() {
  const marks = document.getElementById('rulerMarks');
  marks.innerHTML = '';
  const total = getMaxDuration();
  const step = total <= 10 ? 1 : total <= 60 ? 5 : total <= 300 ? 10 : 30;
  const numMarks = total > 0 ? Math.ceil(total / step) + 1 : 12;
  const markWidth = total > 0 ? 100 : 100;

  for (let i = 0; i < numMarks; i++) {
    const mark = document.createElement('div');
    mark.className = 'ruler-mark';
    mark.style.width = `${markWidth}px`;
    const sec = i * (total > 0 ? step : 5);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    mark.innerHTML = `<span>${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}</span>`;
    marks.appendChild(mark);
  }
}

function updatePlayhead() {
  const total = getMaxDuration();
  const current = getCurrentTime();
  if (total <= 0) return;
  const rulerEl = document.getElementById('timelineRuler');
  if (!rulerEl) return;
  const rulerWidth = rulerEl.scrollWidth - 180; // subtract track header width
  const px = 180 + (current / total) * rulerWidth;
  document.getElementById('playhead').style.left = `${px}px`;
}

// ═══════════════════════════════════════════════════════
// TRANSPORT (Play / Pause / Stop / Seek)
// ═══════════════════════════════════════════════════════
function play() {
  if (state.isPlaying || state.tracks.length === 0) return;
  initAudio();
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

  if (state.pauseOffset >= getMaxDuration()) state.pauseOffset = 0;
  state.startTime = state.audioCtx.currentTime - state.pauseOffset;

  for (const track of state.tracks) {
    if (!track.audioBuffer) continue;
    const source = state.audioCtx.createBufferSource();
    source.buffer = track.audioBuffer;
    source.connect(track.eqLow);
    source.start(0, state.pauseOffset);
    track.sourceNode = source;
    source.onended = () => { if (track.sourceNode === source) track.sourceNode = null; };
  }

  state.isPlaying = true;
  document.getElementById('btnPlay').classList.add('active-play');
  document.getElementById('btnPlay').innerHTML = '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="5" height="14" rx="1"/><rect x="14" y="5" width="5" height="14" rx="1"/></svg>';
  startAnimationLoop();
}

function pause() {
  if (!state.isPlaying) return;
  state.pauseOffset = state.audioCtx.currentTime - state.startTime;
  for (const track of state.tracks) {
    if (track.sourceNode) {
      track.sourceNode.onended = null;
      track.sourceNode.stop();
      track.sourceNode.disconnect();
      track.sourceNode = null;
    }
  }
  state.isPlaying = false;
  document.getElementById('btnPlay').classList.remove('active-play');
  document.getElementById('btnPlay').innerHTML = '<svg viewBox="0 0 24 24"><polygon points="8,5 20,12 8,19"/></svg>';
  cancelAnimationFrame(state.animFrameId);
}

function stop() {
  if (state.isPlaying) pause();
  state.pauseOffset = 0;
  updateTransportTime();
  updatePlayhead();
}

function seek(time) {
  const wasPlaying = state.isPlaying;
  if (wasPlaying) pause();
  state.pauseOffset = Math.max(0, Math.min(time, getMaxDuration()));
  updateTransportTime();
  updatePlayhead();
  if (wasPlaying) play();
}

// ═══════════════════════════════════════════════════════
// ANIMATION LOOP
// ═══════════════════════════════════════════════════════
function startAnimationLoop() {
  function loop() {
    if (!state.isPlaying) return;
    updateTransportTime();
    updatePlayhead();
    if (getCurrentTime() >= getMaxDuration()) {
      pause();
      state.pauseOffset = getMaxDuration();
      updateTransportTime();
      updatePlayhead();
      return;
    }
    state.animFrameId = requestAnimationFrame(loop);
  }
  state.animFrameId = requestAnimationFrame(loop);
}

function updateTransportTime() {
  document.getElementById('transportTime').textContent = formatTime(getCurrentTime());
}

// ═══════════════════════════════════════════════════════
// WAV ENCODING
// ═══════════════════════════════════════════════════════
function encodeWAV(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function ws(o, s) { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }
  ws(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ws(8, 'WAVE'); ws(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  ws(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(audioBuffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample * 0x7FFF, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// ═══════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════
async function exportTrack(track) {
  const ctx = new OfflineAudioContext(track.audioBuffer.numberOfChannels, track.audioBuffer.length, track.audioBuffer.sampleRate);
  const source = ctx.createBufferSource();
  source.buffer = track.audioBuffer;

  const eqLow = ctx.createBiquadFilter(); eqLow.type = 'lowshelf'; eqLow.frequency.value = 320; eqLow.gain.value = track.eqLow.gain.value;
  const eqMid = ctx.createBiquadFilter(); eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 1; eqMid.gain.value = track.eqMid.gain.value;
  const eqHigh = ctx.createBiquadFilter(); eqHigh.type = 'highshelf'; eqHigh.frequency.value = 3200; eqHigh.gain.value = track.eqHigh.gain.value;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = track.compressor.threshold.value;
  comp.ratio.value = track.compressor.ratio.value;
  comp.attack.value = track.compressor.attack.value;
  comp.release.value = track.compressor.release.value;
  comp.knee.value = track.compressor.knee.value;
  const gain = ctx.createGain(); gain.gain.value = track.volume;
  const pan = ctx.createStereoPanner(); pan.pan.value = track.pan;

  source.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh);
  eqHigh.connect(comp); comp.connect(gain); gain.connect(pan);
  pan.connect(ctx.destination);
  source.start(0);

  const rendered = await ctx.startRendering();
  const wavBlob = encodeWAV(rendered);

  const formData = new FormData();
  formData.append('file', wavBlob, `${track.name}.wav`);
  formData.append('filename', `${track.name}.wav`);
  return await (await fetch('/api/export', { method: 'POST', body: formData })).json();
}

async function exportAllTracks() {
  if (state.tracks.length === 0) return;
  const btn = document.getElementById('btnExportAll');
  const origText = btn.textContent;
  btn.textContent = 'Exporting...';
  btn.disabled = true;

  const results = [];
  for (const track of state.tracks) {
    try { results.push({ track: track.name, ...(await exportTrack(track)) }); }
    catch (err) { results.push({ track: track.name, error: err.message }); }
  }

  btn.textContent = origText;
  btn.disabled = false;
  const ok = results.filter(r => !r.error).length;
  alert(`Exported ${ok}/${state.tracks.length} tracks.\n\n${results.map(r => r.error ? `${r.track}: ERROR` : `${r.track} → ${r.path}`).join('\n')}`);
}

// ═══════════════════════════════════════════════════════
// FILE IMPORT
// ═══════════════════════════════════════════════════════
async function importFiles(files) {
  initAudio();
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.wav')) continue;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const data = await (await fetch('/api/upload', { method: 'POST', body: formData })).json();
      const arrayBuffer = await (await fetch(data.url)).arrayBuffer();
      const audioBuffer = await state.audioCtx.decodeAudioData(arrayBuffer);
      createTrack(data.filename, data.url, audioBuffer, data.info);
    } catch (err) {
      console.error(`Failed to import ${file.name}:`, err);
    }
  }
  buildTimeline();
}

// ═══════════════════════════════════════════════════════
// BACKEND: DEVICE DETECTION & MONITORING
// ═══════════════════════════════════════════════════════
async function loadDevices() {
  try {
    const devices = await (await fetch('/api/devices')).json();
    const rodecaster = devices.find(d => d.isRodecaster);
    const device = rodecaster || devices[0];

    if (device) {
      state.selectedDeviceId = device.id;
      document.getElementById('deviceDot').classList.add('online');
      document.getElementById('deviceStatus').textContent = device.name;
      document.getElementById('recDeviceName').textContent = device.name;
      document.getElementById('recDeviceSpec').textContent = `${device.channels}ch / ${device.sampleRate}Hz / 16-bit PCM`;
      document.getElementById('infoFormat').textContent = `WAV ${device.sampleRate / 1000}k`;
      startMonitoring(device.id);
    } else {
      document.getElementById('deviceStatus').textContent = 'No device found';
    }
  } catch (err) {
    console.error('Failed to load devices:', err);
    document.getElementById('deviceStatus').textContent = 'Connection error';
  }
}

async function loadChannelMap() {
  try {
    state.backendChannelMap = await (await fetch('/api/channel-map')).json();
  } catch (err) {
    console.error('Failed to load channel map:', err);
  }
}

async function startMonitoring(deviceId) {
  try {
    const resp = await fetch('/api/monitor/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: parseInt(deviceId) }),
    });
    const data = await resp.json();
    if (data.error) { console.error('Monitor error:', data.error); return; }
    state.isMonitoring = true;
    connectLevelStream();
  } catch (err) {
    console.error('Failed to start monitoring:', err);
  }
}

function connectLevelStream() {
  if (state.levelSource) { state.levelSource.close(); state.levelSource = null; }

  state.levelSource = new EventSource('/api/levels');
  state.levelSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    updateMetersFromSSE(data.levels);

    if (data.isRecording && state.isRecording) {
      document.getElementById('recStatusLabel').textContent = `REC ${formatTime(data.elapsed)}`;
    }
  };
  state.levelSource.onerror = () => {
    state.levelSource.close();
    setTimeout(connectLevelStream, 1000);
  };
}

function getChannelEffectiveGain(chIdx) {
  const ch = state.channels[chIdx];
  if (!ch) return 1.0;
  const anySoloed = state.channels.some(c => c.solo);
  if (anySoloed && !ch.solo) return 0;
  if (ch.mute) return 0;
  const trimLinear = Math.pow(10, ch.trim / 20);
  return ch.fader * trimLinear;
}

function updateMetersFromSSE(levels) {
  // Update channel meters in mixer view
  for (let pairIdx = 0; pairIdx < CHANNEL_MAP.length; pairIdx++) {
    const pair = CHANNEL_MAP[pairIdx].channels;
    const ch = state.channels[pairIdx];
    const isPfl = ch && ch.pfl;

    for (let c = 0; c < 2; c++) {
      const chNum = pair[c];
      if (chNum >= levels.length) continue;

      const rawLevel = levels[chNum];
      const displayLevel = isPfl ? rawLevel : rawLevel * getChannelEffectiveGain(pairIdx);

      // Mixer meters
      const side = c === 0 ? 'L' : 'R';
      const meterEl = document.getElementById(`meter${side}${pairIdx}`);
      if (meterEl) meterEl.style.height = `${levelToPercent(displayLevel)}%`;

      // Peak hold
      const peakKey = c === 0 ? 'peakL' : 'peakR';
      if (rawLevel > (ch[peakKey] || 0)) {
        ch[peakKey] = rawLevel;
        const peakEl = document.getElementById(`peak${side}${pairIdx}`);
        if (peakEl) peakEl.style.bottom = `${levelToPercent(rawLevel)}%`;
      } else {
        ch[peakKey] = (ch[peakKey] || 0) * 0.995;
      }

      // Record view meters
      const recEl = document.getElementById(`recMeter${side}${pairIdx}`);
      if (recEl) recEl.style.height = `${levelToPercent(displayLevel)}%`;
    }
  }

  // Master meters (average of unmuted channels)
  let masterL = 0, masterR = 0, count = 0;
  for (let i = 0; i < CHANNEL_MAP.length; i++) {
    const pair = CHANNEL_MAP[i].channels;
    const gain = getChannelEffectiveGain(i);
    if (gain <= 0) continue;
    masterL += (levels[pair[0]] || 0) * gain;
    masterR += (levels[pair[1]] || 0) * gain;
    count++;
  }
  if (count > 0) { masterL /= count; masterR /= count; }
  masterL *= state.masterGainValue;
  masterR *= state.masterGainValue;

  const mL = document.getElementById('masterMeterL');
  const mR = document.getElementById('masterMeterR');
  if (mL) mL.style.height = `${levelToPercent(masterL)}%`;
  if (mR) mR.style.height = `${levelToPercent(masterR)}%`;
}

// ═══════════════════════════════════════════════════════
// RECORDING (backend-driven)
// ═══════════════════════════════════════════════════════
async function startRecording() {
  if (state.isRecording) return;
  if (!state.selectedDeviceId) {
    alert('No audio device detected. Please check your Rodecaster connection.');
    return;
  }

  try {
    const resp = await fetch('/api/record/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: parseInt(state.selectedDeviceId) }),
    });
    const data = await resp.json();
    if (data.error) { alert(`Recording failed: ${data.error}`); return; }

    state.isRecording = true;
    state.recordStartTime = Date.now();

    // UI updates
    document.getElementById('recButton').classList.add('recording');
    document.getElementById('btnRecord').classList.add('active-rec');
    document.getElementById('recTimer').classList.add('active');
    document.getElementById('deviceDot').classList.add('recording');
    document.getElementById('recStatusLabel').textContent = 'REC 00:00:00.000';

    updateRecTimer();
  } catch (err) {
    alert(`Recording failed: ${err.message}`);
  }
}

async function stopRecording() {
  if (!state.isRecording) return;

  document.getElementById('recStatusLabel').textContent = 'Stopping...';

  try {
    const resp = await fetch('/api/record/stop', { method: 'POST' });
    const data = await resp.json();

    state.isRecording = false;
    state.recordStartTime = null;

    document.getElementById('recButton').classList.remove('recording');
    document.getElementById('btnRecord').classList.remove('active-rec');
    document.getElementById('recTimer').classList.remove('active');
    document.getElementById('deviceDot').classList.remove('recording');
    document.getElementById('recStatusLabel').textContent = `Saved ${data.duration}s`;

    pollForSaveResult();
  } catch (err) {
    console.error('Stop recording failed:', err);
    document.getElementById('recStatusLabel').textContent = 'Error!';
  }
}

function toggleRecord() {
  if (state.isRecording) stopRecording();
  else startRecording();
}

function updateRecTimer() {
  if (!state.isRecording) return;
  const elapsed = (Date.now() - state.recordStartTime) / 1000;
  document.getElementById('recTimer').textContent = formatTime(elapsed).substring(0, 8); // HH:MM:SS
  requestAnimationFrame(updateRecTimer);
}

async function pollForSaveResult() {
  let attempts = 0;
  const poll = async () => {
    attempts++;
    try {
      const resp = await fetch('/api/record/status');
      const data = await resp.json();
      if (data.lastSave && data.lastSave.status === 'complete') {
        await loadRecordedFiles(data.lastSave.files);
        document.getElementById('recStatusLabel').textContent =
          `Session: ${data.lastSave.files.length} tracks`;
        document.getElementById('infoSession').textContent =
          `${data.lastSave.files.filter(f => !f.silent).length} tracks`;

        // Switch to tracks view
        document.querySelector('.tab-btn[data-view="tracks"]').click();
        return;
      }
    } catch (err) { /* retry */ }
    if (attempts < 30) setTimeout(poll, 500);
    else document.getElementById('recStatusLabel').textContent = 'Save timed out';
  };
  setTimeout(poll, 500);
}

async function loadRecordedFiles(files) {
  initAudio();
  for (const file of files) {
    if (file.silent) continue;
    try {
      const arrayBuffer = await (await fetch(file.url)).arrayBuffer();
      const audioBuffer = await state.audioCtx.decodeAudioData(arrayBuffer);

      const chMapIdx = state.backendChannelMap.findIndex(ch => file.label === ch.label);
      const chState = chMapIdx >= 0 ? state.channels[chMapIdx] : null;

      const track = createTrack(file.filename, file.url, audioBuffer, {
        sampleRate: audioBuffer.sampleRate,
        channels: audioBuffer.numberOfChannels,
        bitDepth: 16,
        duration: audioBuffer.duration,
        frames: audioBuffer.length,
      });

      // Apply channel strip color
      if (chMapIdx >= 0) {
        track.color = STRIP_COLORS[chMapIdx % STRIP_COLORS.length];
        track.name = file.label;
        const nameEl = document.querySelector(`#${track.id} .track-name`);
        if (nameEl) { nameEl.textContent = file.label; nameEl.style.borderLeftColor = track.color; }
        const canvas = document.querySelector(`#${track.id} .waveform-canvas`);
        if (canvas) drawWaveform(canvas, audioBuffer, track.color);
      }

      // Apply channel mixer state to playback track
      if (chState) {
        const trimLinear = Math.pow(10, chState.trim / 20);
        track.volume = chState.fader * trimLinear;
        track.pan = chState.pan;
        track.muted = chState.mute;
        track.gainNode.gain.value = chState.mute ? 0 : track.volume;
        track.panNode.pan.value = chState.pan;

        // Apply EQ if set
        if (chState.eq) {
          track.eqLow.gain.value = chState.eq.low;
          track.eqMid.gain.value = chState.eq.mid;
          track.eqHigh.gain.value = chState.eq.high;
        }
        // Apply compressor if set
        if (chState.comp) {
          track.compressor.threshold.value = chState.comp.threshold;
          track.compressor.ratio.value = chState.comp.ratio;
          track.compressor.attack.value = (chState.comp.attack || 3) / 1000; // ms → s
          track.compressor.release.value = (chState.comp.release || 250) / 1000;
          track.compressor.knee.value = chState.comp.knee;
        }

        if (chState.mute) {
          const muteBtn = document.querySelector(`#${track.id} .btn-mute`);
          if (muteBtn) muteBtn.classList.add('active-mute');
        }
      }
    } catch (err) {
      console.error(`Failed to load ${file.filename}:`, err);
    }
  }
  updateMuteSoloState();
  buildTimeline();
}

// ═══════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════
async function loadConfig() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    state.outputFolder = cfg.outputFolder || '';
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

// ═══════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

  if (e.code === 'Space') {
    e.preventDefault();
    if (state.isPlaying) pause(); else play();
  } else if (e.code === 'Home') {
    e.preventDefault();
    stop();
  } else if (e.code === 'KeyR' && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    toggleRecord();
  }
});

// ═══════════════════════════════════════════════════════
// LIMITER TOGGLE
// ═══════════════════════════════════════════════════════
document.getElementById('limiterToggle').addEventListener('click', function() {
  state.limiterEnabled = !state.limiterEnabled;
  this.classList.toggle('active', state.limiterEnabled);

  if (state.masterGain && state.masterLimiter) {
    state.masterGain.disconnect();
    if (state.limiterEnabled) {
      state.masterGain.connect(state.masterLimiter);
      state.masterLimiter.connect(state.audioCtx.destination);
    } else {
      state.masterLimiter.disconnect();
      state.masterGain.connect(state.audioCtx.destination);
    }
  }
});

// ═══════════════════════════════════════════════════════
// TRANSPORT BUTTONS
// ═══════════════════════════════════════════════════════
document.getElementById('btnPlay').addEventListener('click', () => {
  if (state.isPlaying) pause(); else play();
});

document.getElementById('btnStop').addEventListener('click', stop);

document.getElementById('btnRecord').addEventListener('click', toggleRecord);
document.getElementById('recButton').addEventListener('click', toggleRecord);

// ═══════════════════════════════════════════════════════
// TRACKS VIEW BUTTONS
// ═══════════════════════════════════════════════════════
document.getElementById('btnImport').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});

document.getElementById('fileInput').addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    importFiles(Array.from(e.target.files));
    e.target.value = '';
  }
});

document.getElementById('btnExportAll').addEventListener('click', exportAllTracks);

document.getElementById('btnLoadSession').addEventListener('click', async () => {
  try {
    const data = await (await fetch('/api/record/status')).json();
    if (data.lastSave && data.lastSave.files) {
      await loadRecordedFiles(data.lastSave.files);
    } else {
      alert('No recent session found.');
    }
  } catch (err) { alert('Failed to load session.'); }
});

// Timeline seek
document.getElementById('timelineRuler').addEventListener('click', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left - 180; // offset for track header
  const width = rect.width - 180;
  if (x >= 0 && width > 0) {
    seek((x / width) * getMaxDuration());
  }
});

// ═══════════════════════════════════════════════════════
// DRAG & DROP
// ═══════════════════════════════════════════════════════
const dropZone = document.getElementById('trackDropZone');

document.body.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  if (dropZone) dropZone.classList.add('drag-over');
});

document.body.addEventListener('dragleave', () => {
  if (dropZone) dropZone.classList.remove('drag-over');
});

document.body.addEventListener('drop', (e) => {
  e.preventDefault();
  if (dropZone) dropZone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.wav'));
  if (files.length > 0) {
    // Switch to tracks view
    document.querySelector('.tab-btn[data-view="tracks"]').click();
    importFiles(files);
  }
});

// ═══════════════════════════════════════════════════════
// PRESETS (20 slots: channel strips + master + limiter + device)
// ═══════════════════════════════════════════════════════
const PRESET_COUNT = 20;
state.presets = [];
state.selectedPresetSlot = 0;

function snapshotPreset() {
  return {
    channels: state.channels.map(ch => ({
      fader: ch.fader, trim: ch.trim, pan: ch.pan,
      mute: ch.mute, solo: ch.solo, pfl: ch.pfl,
      eq: ch.eq ? { ...ch.eq } : null,
      comp: ch.comp ? { ...ch.comp } : null,
    })),
    masterGainValue: state.masterGainValue,
    limiterEnabled: state.limiterEnabled,
    selectedDeviceId: state.selectedDeviceId,
  };
}

function applyPreset(data) {
  if (!data) return;
  // Channels
  if (Array.isArray(data.channels)) {
    data.channels.forEach((saved, i) => {
      if (!state.channels[i]) return;
      const ch = state.channels[i];
      ch.fader = saved.fader ?? ch.fader;
      ch.trim  = saved.trim  ?? ch.trim;
      ch.pan   = saved.pan   ?? ch.pan;
      ch.mute  = !!saved.mute;
      ch.solo  = !!saved.solo;
      ch.pfl   = !!saved.pfl;
      if (saved.eq)   ch.eq   = { ...saved.eq };
      if (saved.comp) ch.comp = { ...saved.comp };
    });
  }

  // Master fader
  if (typeof data.masterGainValue === 'number') {
    state.masterGainValue = data.masterGainValue;
    if (state.masterGain) state.masterGain.gain.value = data.masterGainValue;
    const mf = document.getElementById('masterFader');
    if (mf) {
      mf.dataset.value = data.masterGainValue;
      const pct = (data.masterGainValue / 1.5) * 100;
      mf.querySelector('.fader-fill-bar').style.height = pct + '%';
      mf.querySelector('.fader-thumb').style.bottom = `calc(${pct}% - 6px)`;
      document.getElementById('masterFaderVal').textContent =
        data.masterGainValue === 1 ? '0.0 dB' : gainToDb(data.masterGainValue);
    }
  }

  // Limiter
  if (typeof data.limiterEnabled === 'boolean' && data.limiterEnabled !== state.limiterEnabled) {
    document.getElementById('limiterToggle').click();
  }

  // Rebuild mixer UI from new channel state
  buildMixer();

  // Device swap
  if (data.selectedDeviceId != null && data.selectedDeviceId !== state.selectedDeviceId) {
    state.selectedDeviceId = data.selectedDeviceId;
    startMonitoring(data.selectedDeviceId);
  }
}

function renderPresetSelect() {
  const sel = document.getElementById('presetSelect');
  sel.innerHTML = '';
  state.presets.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    const filled = p.data ? '●' : '○';
    opt.textContent = `${String(i + 1).padStart(2, '0')}  ${filled}  ${p.name}`;
    sel.appendChild(opt);
  });
  sel.value = state.selectedPresetSlot;
  const current = state.presets[state.selectedPresetSlot];
  document.getElementById('presetName').value = current ? current.name : '';
}

function setPresetStatus(msg, cls) {
  const el = document.getElementById('presetStatus');
  el.textContent = msg;
  el.className = 'preset-status' + (cls ? ' ' + cls : '');
  if (msg) setTimeout(() => {
    if (el.textContent === msg) { el.textContent = ''; el.className = 'preset-status'; }
  }, 2500);
}

async function loadPresets() {
  try {
    const resp = await fetch('/api/presets');
    state.presets = await resp.json();
  } catch (err) {
    console.error('Failed to load presets:', err);
    state.presets = Array.from({ length: PRESET_COUNT }, (_, i) => ({ name: `Preset ${i + 1}`, data: null }));
  }
  renderPresetSelect();
}

document.getElementById('presetSelect').addEventListener('change', (e) => {
  state.selectedPresetSlot = parseInt(e.target.value, 10);
  const p = state.presets[state.selectedPresetSlot];
  document.getElementById('presetName').value = p ? p.name : '';
});

document.getElementById('presetName').addEventListener('change', async (e) => {
  const slot = state.selectedPresetSlot;
  const name = e.target.value.trim() || `Preset ${slot + 1}`;
  try {
    const resp = await fetch(`/api/presets/${slot}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    state.presets[slot] = await resp.json();
    renderPresetSelect();
  } catch (err) { setPresetStatus('Rename failed', 'err'); }
});

document.getElementById('presetLoad').addEventListener('click', () => {
  const p = state.presets[state.selectedPresetSlot];
  if (!p || !p.data) { setPresetStatus('Slot is empty', 'err'); return; }
  applyPreset(p.data);
  setPresetStatus(`Loaded: ${p.name}`, 'ok');
});

document.getElementById('presetSave').addEventListener('click', async () => {
  const slot = state.selectedPresetSlot;
  const name = document.getElementById('presetName').value.trim() || `Preset ${slot + 1}`;
  const data = snapshotPreset();
  try {
    const resp = await fetch(`/api/presets/${slot}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, data }),
    });
    state.presets[slot] = await resp.json();
    renderPresetSelect();
    setPresetStatus(`Saved: ${name}`, 'ok');
  } catch (err) { setPresetStatus('Save failed', 'err'); }
});

document.getElementById('presetClear').addEventListener('click', async () => {
  const slot = state.selectedPresetSlot;
  try {
    const resp = await fetch(`/api/presets/${slot}`, { method: 'DELETE' });
    state.presets[slot] = await resp.json();
    renderPresetSelect();
    setPresetStatus('Cleared', 'ok');
  } catch (err) { setPresetStatus('Clear failed', 'err'); }
});

// ═══════════════════════════════════════════════════════
// DEFAULT PRESET (separate, protected slot)
// ═══════════════════════════════════════════════════════
state.defaultPreset = null;

function renderDefaultLabel() {
  const label = document.getElementById('presetDefaultLabel');
  const name = document.getElementById('presetDefaultName');
  const hasData = state.defaultPreset && state.defaultPreset.data;
  name.textContent = hasData ? state.defaultPreset.name : '(unset)';
  label.classList.toggle('unset', !hasData);
}

async function loadDefaultPreset(autoApply) {
  try {
    const resp = await fetch('/api/preset-default');
    state.defaultPreset = await resp.json();
    renderDefaultLabel();
    if (autoApply && state.defaultPreset && state.defaultPreset.data) {
      applyPreset(state.defaultPreset.data);
    }
  } catch (err) {
    console.error('Failed to load default preset:', err);
  }
}

document.getElementById('presetDefaultLoad').addEventListener('click', () => {
  if (!state.defaultPreset || !state.defaultPreset.data) {
    setPresetStatus('No default set', 'err'); return;
  }
  applyPreset(state.defaultPreset.data);
  setPresetStatus(`Loaded default: ${state.defaultPreset.name}`, 'ok');
});

document.getElementById('presetDefaultSave').addEventListener('click', async () => {
  const hasExisting = state.defaultPreset && state.defaultPreset.data;
  const name = (document.getElementById('presetName').value.trim()
    || (state.defaultPreset && state.defaultPreset.name) || 'Default');

  if (hasExisting) {
    const typed = prompt(
      `A default preset is already set ("${state.defaultPreset.name}").\n\n` +
      `To overwrite, type OVERWRITE below.\n` +
      `New default name will be: "${name}"`
    );
    if (typed !== 'OVERWRITE') { setPresetStatus('Cancelled', 'err'); return; }
  } else {
    if (!confirm(`Save current mix as Default ("${name}")?`)) return;
  }

  const data = snapshotPreset();
  try {
    const resp = await fetch('/api/preset-default', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, data, confirm: hasExisting ? 'OVERWRITE' : undefined }),
    });
    if (!resp.ok) { const err = await resp.json(); setPresetStatus(err.error || 'Save failed', 'err'); return; }
    state.defaultPreset = await resp.json();
    renderDefaultLabel();
    setPresetStatus(`Default set: ${state.defaultPreset.name}`, 'ok');
  } catch (err) { setPresetStatus('Save failed', 'err'); }
});

document.getElementById('presetDefaultClear').addEventListener('click', async () => {
  if (!state.defaultPreset || !state.defaultPreset.data) {
    setPresetStatus('No default to clear', 'err'); return;
  }
  if (!confirm(`Clear the default preset ("${state.defaultPreset.name}")?\nThis cannot be undone.`)) return;
  const typed = prompt('Type DELETE to confirm clearing the default preset:');
  if (typed !== 'DELETE') { setPresetStatus('Cancelled', 'err'); return; }
  try {
    const resp = await fetch('/api/preset-default', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE' }),
    });
    state.defaultPreset = await resp.json();
    renderDefaultLabel();
    setPresetStatus('Default cleared', 'ok');
  } catch (err) { setPresetStatus('Clear failed', 'err'); }
});

// ═══════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════
buildMixer();
buildRecordMeters();
buildTimeline();
loadConfig();
loadPresets();
// Load and auto-apply default preset on startup (after mixer exists & devices loading)
setTimeout(() => loadDefaultPreset(true), 500);
loadChannelMap().then(() => loadDevices());
