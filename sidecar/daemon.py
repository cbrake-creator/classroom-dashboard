#!/usr/bin/env python3
"""
Studio DAW sidecar.

Runs on the studio Mac (next to the Rodecaster Pro II over USB).
Dials OUT to the classroom dashboard's Socket.IO /sidecar namespace —
no inbound ports required on this Mac — and:

  - Emits `hello` on connect with {version, captureDevice, sampleRate, strips}
  - Emits `levels` ~20 Hz with per-channel peak dB
  - On `cmd { op: 'record-start' }` starts a multi-track WAV recording
  - On `cmd { op: 'record-stop' }` closes it and emits the final path
  - Emits `state` / `record` updates as things change

Kept intentionally single-file so deployment = `pip install -r requirements.txt && python daemon.py`.
"""
from __future__ import annotations

import logging
import os
import queue
import signal
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

import numpy as np
import sounddevice as sd
import socketio
import soundfile as sf
from dotenv import load_dotenv

VERSION = "0.1.0"

# ─── Config ──────────────────────────────────────────────────
load_dotenv(Path(__file__).parent / "sidecar.env")


def env(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


def env_int(key: str, default: int) -> int:
    raw = env(key)
    return int(raw) if raw else default


DASHBOARD_URL = env("DASHBOARD_URL", "http://localhost:3000")
SIDECAR_TOKEN = env("SIDECAR_TOKEN")
AUDIO_DEVICE_MATCH = env("AUDIO_DEVICE_MATCH", "RØDECaster")
SAMPLE_RATE = env_int("SAMPLE_RATE", 48000)
CHANNELS = env_int("CHANNELS", 14)
STRIPS = [s.strip() for s in env("STRIPS", "").split(",") if s.strip()]
OUTPUT_DIR = Path(env("OUTPUT_DIR", "Documents/studio-daw-recordings")).expanduser()
if not OUTPUT_DIR.is_absolute():
    OUTPUT_DIR = Path.home() / OUTPUT_DIR
LEVELS_HZ = env_int("LEVELS_HZ", 20)
LOG_LEVEL = env("LOG_LEVEL", "info").upper()

# ── AV.io 4K capture (HDMI 1 program output from the Epiphan Pearl) ──
# The sidecar's TCC bundle has NSCameraUsageDescription so ffmpeg subprocesses
# launched from this daemon inherit camera access via the bundle's identity.
# That's the whole reason the AV.io capture lives here instead of in the
# backend — the backend runs under launchd without bundle-scoped TCC, so any
# ffmpeg it spawned directly would silently hang on AVFoundation device access.
AVIO_HTTP_PORT = env_int("AVIO_HTTP_PORT", 3301)
AVIO_FFMPEG_BIN = env("AVIO_FFMPEG_BIN",
                      str(Path(__file__).parent.parent / "bin" / "ffmpeg"))
AVIO_AVFOUNDATION_INDEX = env("AVIO_AVFOUNDATION_INDEX", "0")  # `ffmpeg -list_devices` index
AVIO_FRAMERATE = env_int("AVIO_FRAMERATE", 15)
AVIO_HEIGHT = env_int("AVIO_HEIGHT", 720)  # output height; width preserves aspect

# Which channels to actually write to disk. Format: "<ch>:<name>,<ch>:<name>..."
# where <ch> is the 1-based channel number and <name> is the filename stem.
# If empty, the sidecar writes one WAV per channel (all CHANNELS channels).
# Used to record only mic isolation tracks (e.g. channels 3/5/7/9) instead of
# every channel including the main mix and empty aux slots.
def _parse_record_channels(raw: str) -> list[tuple[int, str]]:
    pairs: list[tuple[int, str]] = []
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        if ":" not in item:
            log.warning("RECORD_CHANNELS: ignoring malformed entry %r (need ch:name)", item)
            continue
        ch_s, name = item.split(":", 1)
        try:
            ch = int(ch_s.strip())
        except ValueError:
            log.warning("RECORD_CHANNELS: non-integer channel %r", ch_s)
            continue
        if ch < 1 or ch > CHANNELS:
            log.warning("RECORD_CHANNELS: channel %d out of range 1..%d", ch, CHANNELS)
            continue
        pairs.append((ch, name.strip()))
    return pairs

# Actual parse happens below, after `log` is created so warnings surface.
_RECORD_CHANNELS_RAW = env("RECORD_CHANNELS", "")

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s  %(message)s",
)
log = logging.getLogger("sidecar")

if len(STRIPS) != CHANNELS:
    log.warning("STRIPS (%d) doesn't match CHANNELS (%d) — levels will still work but names may misalign",
                len(STRIPS), CHANNELS)
    while len(STRIPS) < CHANNELS:
        STRIPS.append(f"Ch {len(STRIPS)+1}")

RECORD_CHANNELS = _parse_record_channels(_RECORD_CHANNELS_RAW)
if RECORD_CHANNELS:
    log.info("RECORD_CHANNELS: will save %d of %d channels: %s",
             len(RECORD_CHANNELS), CHANNELS,
             ", ".join(f"ch{ch}→{name}" for ch, name in RECORD_CHANNELS))
else:
    log.info("RECORD_CHANNELS not set — saving all %d channels", CHANNELS)

# Best-effort: pre-create OUTPUT_DIR so the dashboard's first record-start has
# somewhere obvious to write. If this fails (e.g. an unmounted external drive
# in sidecar.env), don't crash — the per-record pre-flight will surface a
# structured error to the dashboard later.
try:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
except OSError as e:
    log.warning("OUTPUT_DIR not creatable at startup (%s); record-start will retry and report errors", e)


# ─── Audio device lookup ─────────────────────────────────────
# State for "log on transition only". The supervisor polls find_input_device()
# every second; without this we'd spam the log either with a match (boring) or
# with a mismatch + full input enumeration (very loud).
_last_device_match_log: dict[str, object] = {"present": None, "logged_inputs": False}


def find_input_device() -> Optional[int]:
    """Return the sounddevice index for the first INPUT device whose name
    contains AUDIO_DEVICE_MATCH (case-insensitive). Logs only on state changes
    so the supervisor can poll cheaply."""
    match = AUDIO_DEVICE_MATCH.lower()
    found_idx: Optional[int] = None
    found_dev = None
    for i, dev in enumerate(sd.query_devices()):
        if dev["max_input_channels"] < 1:
            continue
        if match in dev["name"].lower():
            found_idx = i
            found_dev = dev
            break

    was_present = _last_device_match_log["present"]
    if found_idx is not None:
        if was_present is not True:
            log.info("matched input device %d: %s (%d in / %d out)",
                     found_idx, found_dev["name"],
                     found_dev["max_input_channels"], found_dev["max_output_channels"])
            _last_device_match_log["present"] = True
            _last_device_match_log["logged_inputs"] = False
        return found_idx

    if was_present is not False:
        log.error("no input device matched %r. Available inputs:", AUDIO_DEVICE_MATCH)
        for i, dev in enumerate(sd.query_devices()):
            if dev["max_input_channels"] >= 1:
                log.error("  [%d] %s (%d in)", i, dev["name"], dev["max_input_channels"])
        _last_device_match_log["present"] = False
        _last_device_match_log["logged_inputs"] = True
    return None


# ─── macOS microphone permission ─────────────────────────────
# When launchd spawns the sidecar, CoreAudio silently returns zero buffers if
# TCC hasn't granted microphone access. The Swift shim at the bundle's main
# binary is what actually triggers the dialog (it owns the bundle's TCC
# identity); this function is here as a status check so we can surface
# mic_state in health-state events to the dashboard.
def check_macos_mic_permission() -> str:
    if sys.platform != "darwin":
        return "n/a"
    try:
        from AVFoundation import (  # type: ignore
            AVCaptureDevice,
            AVMediaTypeAudio,
            AVAuthorizationStatusAuthorized,
            AVAuthorizationStatusDenied,
            AVAuthorizationStatusRestricted,
            AVAuthorizationStatusNotDetermined,
        )
    except ImportError as e:
        log.info("pyobjc frameworks missing (%s) — skipping mic permission check", e)
        return "unknown"

    status = AVCaptureDevice.authorizationStatusForMediaType_(AVMediaTypeAudio)
    if status == AVAuthorizationStatusAuthorized:
        return "granted"
    if status == AVAuthorizationStatusDenied:
        return "denied"
    if status == AVAuthorizationStatusRestricted:
        return "restricted"
    if status == AVAuthorizationStatusNotDetermined:
        return "not-determined"
    return "unknown"


# ─── Recording state ─────────────────────────────────────────
# One mono WAV per channel so a DAW that only imports stereo (GarageBand) can
# still pull each mic into its own track. File naming: studio_<ts>/ch03-<strip>.wav
@dataclass
class Recording:
    dir: Path                         # folder holding this session's WAVs
    # Each writer is paired with the 0-based source channel index it reads from.
    # When RECORD_CHANNELS is empty we record all channels (channel i → writers[i]);
    # when set, only the configured channels get writers.
    writers: list[tuple[int, sf.SoundFile]]
    started_at: float
    frames_written: int = 0


rec_lock = threading.Lock()
current_rec: Optional[Recording] = None

# Output directory is mutable at runtime — the dashboard UI can set it via
# the 'output-dir' cmd. Reads/writes must hold output_dir_lock.
#
# Runtime overrides persist to STATE_FILE so a daemon restart (KeepAlive
# respawn, sleep/wake recovery, manual bounce) doesn't silently revert the
# user's chosen folder back to the sidecar.env default. Without this, setting
# the output folder via the dashboard appears to work but vanishes on the
# next process restart.
STATE_FILE = Path.home() / "Library/Application Support/studio-daw-sidecar/state.json"


def _load_state() -> dict:
    try:
        import json
        with open(STATE_FILE, "r") as f:
            return json.load(f) or {}
    except (FileNotFoundError, OSError, ValueError):
        return {}


def _save_state(patch: dict) -> None:
    """Merge `patch` into the persisted state file. Best-effort — never raises."""
    try:
        import json
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        current = _load_state()
        current.update(patch)
        tmp = STATE_FILE.with_suffix(".json.tmp")
        with open(tmp, "w") as f:
            json.dump(current, f, indent=2)
        tmp.replace(STATE_FILE)
    except Exception as e:
        log.warning("could not persist state: %s", e)


output_dir_lock = threading.Lock()
# Initialize from persisted state if present, else fall back to env default.
_persisted_output_dir = _load_state().get("output_dir")
if _persisted_output_dir:
    try:
        active_output_dir: Path = Path(_persisted_output_dir).expanduser()
        if not active_output_dir.is_absolute():
            active_output_dir = Path.home() / active_output_dir
        log.info("restored output dir from state: %s", active_output_dir)
    except Exception:
        active_output_dir = OUTPUT_DIR
else:
    active_output_dir: Path = OUTPUT_DIR


def _safe_name(s: str) -> str:
    """Make a strip label safe for a filename — strips the channel suffix
    (' L'/' R' duplicates handled by keeping both files distinct via ch prefix)."""
    keep = [c if c.isalnum() or c in ('-', '_') else '-' for c in s.strip()]
    out = ''.join(keep)
    while '--' in out:
        out = out.replace('--', '-')
    return out.strip('-') or 'ch'


class RecordingPreflightError(Exception):
    """Raised when start_recording can't proceed — surfaced to the dashboard
    as a structured record-event error instead of bubbling silently."""


# Refuse to start a recording if free space drops below this threshold. 14
# channels * 48 kHz * 24-bit = ~2 MB/sec, so 500 MB ≈ 4 min of headroom — well
# above any realistic session length and small enough that healthy disks pass.
MIN_FREE_BYTES = 500 * 1024 * 1024


def _preflight_output_dir(out_base: Path) -> None:
    """Validate the destination dir before we start opening WAV writers.
    Raises RecordingPreflightError with a human-readable message on failure."""
    import shutil
    try:
        out_base.mkdir(parents=True, exist_ok=True)
    except PermissionError as e:
        raise RecordingPreflightError(f"output dir not writable: {out_base} ({e})")
    except OSError as e:
        raise RecordingPreflightError(f"could not create output dir {out_base}: {e}")
    if not os.access(out_base, os.W_OK):
        raise RecordingPreflightError(f"output dir not writable: {out_base}")
    try:
        usage = shutil.disk_usage(out_base)
    except OSError as e:
        raise RecordingPreflightError(f"could not stat disk for {out_base}: {e}")
    if usage.free < MIN_FREE_BYTES:
        raise RecordingPreflightError(
            f"only {usage.free // (1024*1024)} MB free at {out_base} — refuse to start recording (need >= {MIN_FREE_BYTES // (1024*1024)} MB)"
        )


def start_recording() -> Path:
    global current_rec
    with rec_lock:
        if current_rec is not None:
            log.info("record-start ignored; already recording -> %s", current_rec.dir)
            return current_rec.dir
        with output_dir_lock:
            out_base = active_output_dir
        _preflight_output_dir(out_base)
        stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        session_dir = out_base / f"studio_{stamp}"
        try:
            session_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise RecordingPreflightError(f"could not create session dir {session_dir}: {e}")

        # Build the (channel_index, filename) list.
        if RECORD_CHANNELS:
            # User picked specific channels — filename = configured name, no ch prefix.
            plan = [(ch - 1, f"{_safe_name(name)}.wav") for ch, name in RECORD_CHANNELS]
        else:
            plan = []
            for i in range(CHANNELS):
                label = _safe_name(STRIPS[i]) if i < len(STRIPS) else f"ch{i+1:02d}"
                plan.append((i, f"ch{i+1:02d}-{label}.wav"))

        writers: list[tuple[int, sf.SoundFile]] = []
        try:
            for src_idx, fname in plan:
                writers.append((src_idx, sf.SoundFile(
                    str(session_dir / fname), mode="w",
                    samplerate=SAMPLE_RATE, channels=1,
                    subtype="PCM_24", format="WAV",
                )))
        except Exception as e:
            for _, w in writers:
                try: w.close()
                except Exception: pass
            raise RecordingPreflightError(f"could not open WAV writers in {session_dir}: {e}")
        current_rec = Recording(dir=session_dir, writers=writers, started_at=time.time())
        log.info("recording started: %s (%d files)", session_dir, len(writers))
        return session_dir


def stop_recording() -> Optional[Path]:
    global current_rec
    with rec_lock:
        if current_rec is None:
            return None
        rec = current_rec
        for _, w in rec.writers:
            try: w.close()
            except Exception as e: log.warning("error closing writer: %s", e)
        current_rec = None
        duration = time.time() - rec.started_at
        log.info("recording stopped: %s (%.1fs)", rec.dir, duration)
        return rec.dir


def write_frames(frames: np.ndarray) -> None:
    """Called from the audio callback thread while a recording is active.
    Writes one mono WAV per configured channel."""
    rec = current_rec
    if rec is None:
        return
    try:
        # frames.shape == (frames, CHANNELS). For each writer, pull that
        # channel as a 2D slice (channels=1) matching the SoundFile.
        for src_idx, w in rec.writers:
            w.write(frames[:, src_idx:src_idx+1])
        rec.frames_written += frames.shape[0]
    except Exception as e:
        log.exception("error writing frames: %s", e)


def set_output_dir(path_str: str) -> Path:
    """Update where future recordings are saved. A recording already in
    progress continues in its original directory. Persisted to STATE_FILE so
    the choice survives a daemon restart."""
    global active_output_dir
    p = Path(path_str).expanduser()
    if not p.is_absolute():
        p = Path.home() / p
    with output_dir_lock:
        active_output_dir = p
    p.mkdir(parents=True, exist_ok=True)
    _save_state({"output_dir": str(p)})
    log.info("output dir set to: %s (persisted)", p)
    return p


# ─── Level meter ─────────────────────────────────────────────
# Audio callback computes per-channel peak (absolute max) per block.
# The socket client thread reads these on a timer and emits `levels`.
latest_peaks = np.zeros(CHANNELS, dtype=np.float32)
peaks_lock = threading.Lock()

# Watchdog: when the RØDECaster is unplugged mid-stream, sounddevice may stop
# delivering callbacks entirely (no status, no error — just silence). The
# supervisor loop in main() compares time.time() against this timestamp and
# tears down the stream if it goes stale.
last_callback_at: float = 0.0
last_peak_at: float = 0.0

# Partial-stream detection: track which channels have *ever* delivered a
# non-zero sample since the current stream was opened. Reset to all-False in
# the supervisor every time it opens a new stream. Catches the boot-transient
# case where the RØDECaster gets captured before its USB engine fully wakes,
# leaving only ch1 delivering for the lifetime of the stream.
channels_with_audio = np.zeros(CHANNELS, dtype=bool)
channels_with_audio_lock = threading.Lock()

# Continuous partial-stream detection: per-channel timestamp of the last
# non-zero sample. Catches mid-stream degradation that the boot-transient
# detector misses — e.g. RØDECaster power-button-off while USB stays
# enumerated, which keeps callbacks firing but only on ch1 (the chat
# passthrough / monitor mix). The supervisor's watchdog reads this every
# second and tears down if the "channels active in the last 10s" count is
# stuck at 1 for too long.
last_active_at = np.zeros(CHANNELS, dtype=np.float64)
last_active_at_lock = threading.Lock()


def _push_health_now() -> None:
    """Emit a state patch immediately. Called on every tear-down so the
    dashboard's deviceState pill updates within ~50ms instead of waiting for
    the next health_loop tick (~2s)."""
    try:
        if sio.connected:
            sio.emit("state", {"patch": _health_patch()}, namespace="/sidecar")
    except Exception:
        pass


def audio_callback(indata: np.ndarray, frames: int, time_info, status) -> None:
    global last_callback_at, last_peak_at
    now = time.time()
    last_callback_at = now
    if status:
        log.debug("audio status: %s", status)
    # indata shape = (frames, channels)
    if indata.shape[1] < CHANNELS:
        # pad with zeros if the device gave us fewer channels than expected
        padded = np.zeros((frames, CHANNELS), dtype=indata.dtype)
        padded[:, : indata.shape[1]] = indata
        indata = padded
    elif indata.shape[1] > CHANNELS:
        indata = indata[:, :CHANNELS]

    peaks = np.max(np.abs(indata), axis=0)
    if float(peaks.max()) > 0:
        last_peak_at = last_callback_at
    with peaks_lock:
        # Keep the larger of incoming vs retained — decays slowly on the next tick.
        np.maximum(latest_peaks, peaks, out=latest_peaks)
    # Mark which channels delivered a non-zero sample. Cumulative since-open
    # for channels_with_audio (boot-transient detection); per-channel
    # timestamp for last_active_at (continuous degradation detection).
    active_now = np.any(indata != 0, axis=0)
    with channels_with_audio_lock:
        np.logical_or(channels_with_audio, active_now, out=channels_with_audio)
    with last_active_at_lock:
        last_active_at[active_now] = now

    # If recording, write through
    if current_rec is not None:
        write_frames(indata)


def consume_peaks_db() -> list[float]:
    """Drain the retained peaks, return dBFS per channel. -inf → -120."""
    with peaks_lock:
        p = latest_peaks.copy()
        latest_peaks[:] = 0  # reset so next tick starts fresh
    # Convert linear peak to dBFS, clamping at -120 for silence.
    db = np.where(p > 0, 20.0 * np.log10(p + 1e-12), -120.0)
    return [round(float(v), 2) for v in db]


# ─── Socket.IO client ────────────────────────────────────────
sio = socketio.Client(
    reconnection=True,
    reconnection_delay=1,
    reconnection_delay_max=10,
    logger=False, engineio_logger=False,
)


@sio.event(namespace="/sidecar")
def connect() -> None:
    log.info("connected to dashboard /sidecar")
    # Send hello with full device descriptor. find_input_device() may log noise
    # if the RØDECaster is currently unplugged — that's fine, hello goes out
    # either way and the dashboard sees a 'sidecar online, capture missing' state.
    idx = find_input_device()
    device_name = sd.query_devices(idx)["name"] if idx is not None else "unknown"
    with output_dir_lock:
        cur_dir = str(active_output_dir)
    sio.emit(
        "hello",
        {
            "version": VERSION,
            "captureDevice": device_name,
            "sampleRate": SAMPLE_RATE,
            "outputDir": cur_dir,
            "strips": [
                {"name": name, "channel": i + 1, "faderDb": 0.0, "muted": False, "solo": False, "peakDb": None}
                for i, name in enumerate(STRIPS)
            ],
        },
        namespace="/sidecar",
    )
    # Push initial health snapshot so the dashboard doesn't have to wait for the
    # next health_loop tick.
    try:
        sio.emit("state", {"patch": _health_patch()}, namespace="/sidecar")
    except Exception:
        pass


@sio.event(namespace="/sidecar")
def connect_error(data) -> None:
    log.warning("sidecar connect error: %s", data)


@sio.event(namespace="/sidecar")
def disconnect() -> None:
    log.info("disconnected from dashboard /sidecar")


@sio.on("cmd", namespace="/sidecar")
def on_cmd(payload: dict) -> None:
    op = payload.get("op")
    args = payload.get("args") or {}
    log.info("cmd: %s args=%s", op, args)
    try:
        if op == "record-start":
            try:
                path = start_recording()
            except RecordingPreflightError as e:
                log.error("record-start refused: %s", e)
                emit_record_state(active=False, output_path=None, error=str(e))
                return
            emit_record_state(active=True, output_path=str(path))
        elif op == "record-stop":
            path = stop_recording()
            emit_record_state(active=False, output_path=str(path) if path else None)
        elif op == "monitor-start":
            sio.emit("state", {"patch": {"monitoring": True}}, namespace="/sidecar")
        elif op == "monitor-stop":
            sio.emit("state", {"patch": {"monitoring": False}}, namespace="/sidecar")
        elif op == "mute":
            # v1 stub: acknowledge with no Rodecaster-side effect.
            # Real mute control requires Rode Central / USB-HID; future work.
            ch = args.get("channel")
            sio.emit("state", {"patch": {"note": f"mute {ch} — stub, not wired to hardware"}},
                     namespace="/sidecar")
        elif op == "output-dir":
            p = args.get("path")
            if isinstance(p, str) and p.strip():
                new_dir = set_output_dir(p.strip())
                sio.emit("state", {"patch": {"outputDir": str(new_dir)}},
                         namespace="/sidecar")
            else:
                log.warning("output-dir: missing 'path' arg")
        else:
            log.warning("unknown op: %s", op)
    except Exception as e:
        log.exception("cmd handler error: %s", e)


def emit_record_state(*, active: bool, output_path: Optional[str] = None, error: Optional[str] = None) -> None:
    rec = current_rec
    payload = {
        "active": active,
        "startedAt": int(rec.started_at * 1000) if rec else None,
        "durationSec": (time.time() - rec.started_at) if rec else 0,
        "outputPath": output_path,
        "error": error,
    }
    sio.emit("record", payload, namespace="/sidecar")


# ─── Main loops ──────────────────────────────────────────────
def levels_loop() -> None:
    """Emit peak levels at LEVELS_HZ while connected."""
    period = 1.0 / max(1, LEVELS_HZ)
    while True:
        time.sleep(period)
        if not sio.connected:
            continue
        dbs = consume_peaks_db()
        try:
            sio.emit(
                "levels",
                {"strips": [{"channel": i + 1, "peakDb": dbs[i]} for i in range(CHANNELS)]},
                namespace="/sidecar",
            )
        except Exception as e:
            log.debug("levels emit failed (reconnecting?): %s", e)


def record_heartbeat_loop() -> None:
    """Every 500ms while recording, emit a record state update so the
    dashboard's duration UI stays current."""
    while True:
        time.sleep(0.5)
        rec = current_rec
        if rec is not None and sio.connected:
            try:
                emit_record_state(active=True, output_path=str(rec.dir))
            except Exception:
                pass


# ─── Health surface ──────────────────────────────────────────
# Module state that the supervisor writes and health_loop emits. The dashboard
# uses this to show whether the sidecar is healthy beyond just "connected".
mic_state: str = "unknown"           # granted | denied | restricted | not-determined | unknown | n/a
device_state: str = "unknown"        # present | missing | unknown
shutdown_event = threading.Event()


def _health_patch() -> dict:
    age_ms = None
    if last_peak_at:
        age_ms = max(0, int((time.time() - last_peak_at) * 1000))
    with channels_with_audio_lock:
        ch_audio = int(channels_with_audio.sum())
    return {
        "micState": mic_state,
        "deviceState": device_state,
        "lastPeakAgeMs": age_ms,
        "recordingActive": current_rec is not None,
        # Cumulative count of channels that have delivered any non-zero sample
        # since the current stream was opened. Lets the dashboard distinguish
        # "audio capture running" from "audio capture running but only on ch1
        # because the device was caught mid-boot."
        "channelsWithAudio": ch_audio,
        "channelsRequested": CHANNELS,
    }


def health_loop() -> None:
    """Push a state patch every 2s so the dashboard reflects mic/device health
    without each side having to poll the other."""
    while not shutdown_event.is_set():
        time.sleep(2)
        if not sio.connected:
            continue
        try:
            sio.emit("state", {"patch": _health_patch()}, namespace="/sidecar")
        except Exception:
            pass


# ─── Audio supervisor ────────────────────────────────────────
# Owns the InputStream's lifecycle. If the device is missing on startup, we
# wait for it. If the device is yanked mid-stream (callback goes silent), we
# tear down + reopen. The socket connection survives all of this — meters
# freeze at -120 client-side and recover when audio comes back.
audio_lock = threading.Lock()
audio_stream: Optional[sd.InputStream] = None


def _open_stream(idx: int) -> sd.InputStream:
    s = sd.InputStream(
        device=idx,
        channels=CHANNELS,
        samplerate=SAMPLE_RATE,
        dtype="float32",
        blocksize=0,
        callback=audio_callback,
    )
    s.start()
    return s


def _close_stream(s: Optional[sd.InputStream]) -> None:
    if s is None:
        return
    try: s.stop()
    except Exception: pass
    try: s.close()
    except Exception: pass


def _reset_portaudio(quiet: bool = False) -> None:
    """Reset sounddevice's PortAudio session. After macOS sleep/wake or any
    InputStream open that returns paInternalError (-9986), PortAudio's cached
    device descriptors get poisoned — every subsequent open in the same
    process fails the same way even though a fresh process opens fine.
    Terminate + initialize forces PortAudio to re-enumerate from CoreAudio.

    Called in two distinct modes:
      - Loud (default): on watchdog tear-down / open failure / partial stream.
        Logs "PortAudio session reset" and clears the transition-log cache so
        the next find_input_device() will re-announce the state.
      - Quiet (quiet=True): during the missing-device poll loop, where we
        reset every 2s to keep PortAudio's device list fresh for USB hot-plug
        detection. Logging would spam; we want a clean "device came back" log
        only when state actually changes."""
    try:
        sd._terminate()
        sd._initialize()
        if not quiet:
            # Drop our own transition-log cache so the next find_input_device()
            # reports the fresh state instead of inheriting "present" from before.
            _last_device_match_log["present"] = None
            _last_device_match_log["logged_inputs"] = False
            log.info("PortAudio session reset")
    except Exception as e:
        log.warning("PortAudio reset failed: %s", e)


def audio_supervisor_loop() -> None:
    """Keep an InputStream open while a matching device is present; back off
    and retry while it isn't.

    The macOS sleep/wake gotcha lurks in two places: (1) `sd.InputStream(...)`
    fails with paInternalError -9986 because PortAudio's session is poisoned,
    and (2) `sd.query_devices()` returns a stale device list that doesn't
    include the RØDECaster even after it's plugged back in. Both require a
    full PortAudio terminate+initialize to recover. The supervisor calls
    _reset_portaudio() on every transition from a working stream to a
    searching state so the next find_input_device() sees fresh truth."""
    global audio_stream, device_state, last_callback_at
    backoff = 1.0
    consecutive_open_failures = 0
    consecutive_missing = 0
    just_torn_down = False  # True for one iteration after the watchdog killed a stream
    while not shutdown_event.is_set():
        # If we just tore down a stream, reset PortAudio before re-querying.
        # The most common stale-device-list trigger (Mac sleep) ALSO trips the
        # watchdog, so this single reset covers both failure modes.
        if just_torn_down:
            _reset_portaudio()
            just_torn_down = False

        idx = find_input_device()
        if idx is None:
            device_state = "missing"
            consecutive_missing += 1
            # PortAudio caches its device list per session, so sd.query_devices()
            # can't see a freshly-plugged USB device without a reset. Reset
            # every iteration while the device is missing — the cost (~50ms
            # for _terminate + _initialize) is far cheaper than the user
            # waiting 2+ minutes for the next chance at hot-plug detection.
            # Skip on iteration 1 because we just reset in the just_torn_down
            # branch above (no point doing it twice in a row). Quiet=True so
            # the log doesn't spam "PortAudio session reset" every 2s; the
            # one-shot "matched input device" log will still fire when state
            # changes from missing→present.
            if consecutive_missing >= 2:
                _reset_portaudio(quiet=True)
            # Final safety net: if we've been stuck "missing" for ~10 min
            # despite resets, exit non-zero. launchd's KeepAlive will respawn
            # a fresh process, which is the strongest possible PortAudio
            # reset (and recovers from any unknown-unknown stuck state).
            # 60 iterations at 2s sleeps = ~2 min, well under the original
            # 10-15 min budget but still long enough that transient outages
            # don't trigger a process restart.
            if consecutive_missing >= 300:  # ~10 min at 2s sleeps
                log.error("device missing for %d retries — exiting so launchd can respawn", consecutive_missing)
                shutdown_event.set()
                # Don't sys.exit() from this thread — set the event and let
                # main return so signal handlers / shutdown order run cleanly.
                os._exit(1)
            # Fixed 2s poll instead of exponential backoff — USB hot-plug
            # should be detected within ~3 seconds of the user replugging.
            time.sleep(2.0)
            continue
        consecutive_missing = 0

        try:
            with audio_lock:
                _close_stream(audio_stream)
                # Reset the per-channel sample-seen tracker so the partial-stream
                # check below only counts samples from THIS open onward.
                with channels_with_audio_lock:
                    channels_with_audio[:] = False
                # Reset per-channel last-active timestamps so the continuous
                # partial-stream watchdog starts counting from this open.
                with last_active_at_lock:
                    last_active_at[:] = 0.0
                audio_stream = _open_stream(idx)
                last_callback_at = time.time()
            stream_opened_at = time.time()
            device_state = "present"
            backoff = 1.0
            consecutive_open_failures = 0
            try:
                dev_name = sd.query_devices(idx)["name"]
            except Exception:
                dev_name = AUDIO_DEVICE_MATCH
            log.info("audio capture running: device=%s (%s) sr=%d ch=%d", idx, dev_name, SAMPLE_RATE, CHANNELS)
            # Hello only fires on socket connect, which (when the device was
            # absent at boot) leaves the dashboard showing captureDevice='unknown'
            # forever. Push the real device name (and a health snapshot) every
            # time we successfully open a fresh stream so the UI catches up.
            try:
                sio.emit("state", {"patch": {
                    "captureDevice": dev_name,
                    **_health_patch(),
                }}, namespace="/sidecar")
            except Exception:
                pass
        except Exception as e:
            consecutive_open_failures += 1
            log.warning("failed to open audio stream (%d in a row): %s",
                        consecutive_open_failures, e)
            device_state = "missing"
            # After 2 consecutive failures, assume PortAudio is poisoned and
            # reset before the next attempt.
            if consecutive_open_failures >= 2:
                _reset_portaudio()
                consecutive_open_failures = 0
            time.sleep(min(backoff, 15.0))
            backoff = min(backoff * 1.5, 15.0)
            continue

        # Watchdog. Three failure modes detected here:
        #   (a) stale callbacks (no samples at all for >5s) → device unplugged
        #   (b) device no longer in sd.query_devices() → ditto
        #   (c) partial stream (only 1 of N channels delivering for too long)
        #       → RØDECaster powered off via its button while USB stays
        #       enumerated; only chat/monitor passthrough leaks through ch1.
        # All three break out to the outer loop, which resets PortAudio and
        # re-enters the find/open cycle.
        partial_check_done = False
        partial_state_since: Optional[float] = None
        ACTIVE_WINDOW_SEC = 10.0   # how recent a non-zero sample counts as "active"
        PARTIAL_GRACE_SEC = 15.0   # how long we tolerate partial state before tearing down
        while not shutdown_event.is_set():
            time.sleep(1)
            stale = time.time() - last_callback_at
            if stale > 5:
                log.warning("audio callback stale for %.1fs — tearing down stream", stale)
                with audio_lock:
                    _close_stream(audio_stream)
                    audio_stream = None
                device_state = "missing"
                _push_health_now()
                just_torn_down = True
                break
            # Also bail if sounddevice can no longer enumerate the device.
            try:
                if find_input_device() is None:
                    log.warning("matching input device no longer enumerable — tearing down")
                    with audio_lock:
                        _close_stream(audio_stream)
                        audio_stream = None
                    device_state = "missing"
                    _push_health_now()
                    just_torn_down = True
                    break
            except Exception:
                pass
            # (a) one-shot boot-transient check: 5s after open, count channels
            # that ever delivered a non-zero sample. If we requested CHANNELS
            # but only one channel ever sent audio, the RØDECaster was likely
            # captured mid-USB-enumeration; force a clean reopen.
            if not partial_check_done and time.time() - stream_opened_at > 5:
                partial_check_done = True
                with channels_with_audio_lock:
                    delivered = int(channels_with_audio.sum())
                if CHANNELS > 1 and delivered == 1:
                    log.warning(
                        "partial stream detected at open: only 1/%d channels delivered samples in the first 5s — "
                        "forcing PortAudio reset + reopen", CHANNELS,
                    )
                    with audio_lock:
                        _close_stream(audio_stream)
                        audio_stream = None
                    device_state = "missing"
                    _push_health_now()
                    just_torn_down = True
                    break
            # (b) continuous degradation check: count channels that have
            # delivered any non-zero sample in the last ACTIVE_WINDOW_SEC. If
            # the count stays below PARTIAL_THRESHOLD for PARTIAL_GRACE_SEC,
            # treat as device-off-USB-alive. This is the RØDECaster-power-
            # button signature — callbacks keep firing (so the stale-callback
            # watchdog can't catch it) but only a couple of channels leak audio
            # (chat passthrough, system-audio bleed via Studio Display Mic, etc.).
            #
            # Threshold scales with channel count: for a 14-channel Rodecaster
            # we expect 8-10 active in steady state, so ≤2 is clearly broken.
            # For a small (≤4-channel) setup we tighten to ≤1 — a properly-
            # configured 2-channel stereo capture in a quiet room could
            # legitimately have only one channel active, and we don't want to
            # false-trigger.
            PARTIAL_THRESHOLD = 2 if CHANNELS >= 8 else 1
            now = time.time()
            with last_active_at_lock:
                recent_active = int(np.sum(now - last_active_at < ACTIVE_WINDOW_SEC))
            if CHANNELS > 1 and recent_active <= PARTIAL_THRESHOLD and recent_active >= 1:
                if partial_state_since is None:
                    partial_state_since = now
                elif now - partial_state_since > PARTIAL_GRACE_SEC:
                    log.warning(
                        "partial stream sustained: only %d/%d channels delivered samples for %.0fs "
                        "(threshold %d) — RØDECaster likely powered off; forcing PortAudio reset + reopen",
                        recent_active, CHANNELS, now - partial_state_since, PARTIAL_THRESHOLD,
                    )
                    with audio_lock:
                        _close_stream(audio_stream)
                        audio_stream = None
                    device_state = "missing"
                    _push_health_now()
                    partial_state_since = None
                    just_torn_down = True
                    break
            else:
                partial_state_since = None


# ─── AV.io HTTP server ─────────────────────────────────────
# The sidecar runs a small loopback HTTP server alongside the audio supervisor.
# The backend (running under launchd, without bundle-scoped TCC) proxies its
# /api/avio/* routes to this localhost server. ffmpeg is spawned per request as
# a subprocess of this daemon, so it inherits the bundle's camera permission via
# TCC responsibility — which is the whole reason this lives in the sidecar at all.
import http.server
import socketserver
import subprocess


def _ffmpeg_base_args() -> list[str]:
    """Common avfoundation input args. Scale height with -2:HEIGHT so width
    rounds to the nearest even number (yuv420p / mjpeg both need even dims)."""
    return [
        AVIO_FFMPEG_BIN,
        "-nostdin", "-loglevel", "error", "-hide_banner",
        "-f", "avfoundation",
        "-framerate", str(AVIO_FRAMERATE),
        "-pixel_format", "uyvy422",   # AV.io 4K's native format; skip ffmpeg's yuv420p auto-pick that errors
        "-i", AVIO_AVFOUNDATION_INDEX,
        "-vf", f"scale=-2:{AVIO_HEIGHT}",
    ]


class _AvioHandler(http.server.BaseHTTPRequestHandler):
    # Silence per-request stdout noise; we log from the daemon's logger.
    def log_message(self, fmt: str, *args) -> None:
        log.debug("avio-http %s - %s", self.address_string(), fmt % args)

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"ok\n")
            return
        if path == "/avio/snapshot":
            self._serve_snapshot()
            return
        if path == "/avio/mjpeg":
            self._serve_mjpeg()
            return
        self.send_error(404, "unknown path")

    def _serve_snapshot(self) -> None:
        cmd = _ffmpeg_base_args() + [
            "-frames:v", "1", "-q:v", "5",
            "-f", "image2", "pipe:1",
        ]
        try:
            # 8s budget: AVFoundation device open + first-frame negotiation
            # takes ~2-4s on this hardware; pad for hiccups.
            proc = subprocess.run(cmd, capture_output=True, timeout=8)
        except subprocess.TimeoutExpired:
            self.send_error(504, "ffmpeg timeout (camera permission? capture device unplugged?)")
            return
        if proc.returncode != 0 or len(proc.stdout) < 16:
            err = proc.stderr.decode("utf-8", errors="replace")[:200] if proc.stderr else "no output"
            log.warning("avio snapshot ffmpeg failed rc=%d: %s", proc.returncode, err)
            self.send_error(503, f"capture failed: {err}")
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(proc.stdout)))
        self.end_headers()
        self.wfile.write(proc.stdout)

    def _serve_mjpeg(self) -> None:
        # mpjpeg muxer emits a proper multipart/x-mixed-replace stream that
        # browser <img> can render in real time. Boundary tag defaults to
        # "ffmpeg"; advertise it in the Content-Type so the client parses
        # part boundaries correctly.
        cmd = _ffmpeg_base_args() + [
            "-q:v", "5",
            "-f", "mpjpeg", "-boundary_tag", "ffmpeg-avio",
            "pipe:1",
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        try:
            self.send_response(200)
            self.send_header("Content-Type", 'multipart/x-mixed-replace; boundary="ffmpeg-avio"')
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            # Pipe ffmpeg's stdout straight to the client until either side
            # disconnects. 32 KB chunks balance latency vs syscall overhead.
            while True:
                chunk = proc.stdout.read(32 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError) as e:
            log.debug("avio mjpeg client disconnected: %s", e)
        finally:
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
            except Exception:
                pass


class _ThreadedHttpServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    # Threaded so a long-running /mjpeg stream doesn't block /snapshot or /healthz.
    daemon_threads = True
    allow_reuse_address = True


def avio_http_server() -> None:
    if not Path(AVIO_FFMPEG_BIN).is_file():
        log.warning("avio: ffmpeg not found at %s — /api/avio routes will 503. "
                    "Place a static ffmpeg there (see backend/bin/ffmpeg).", AVIO_FFMPEG_BIN)
        # Still start the server so the backend gets a clean 503 instead of a
        # connection refused, which is much easier to debug.
    try:
        server = _ThreadedHttpServer(("127.0.0.1", AVIO_HTTP_PORT), _AvioHandler)
    except OSError as e:
        log.error("avio: could not bind 127.0.0.1:%d (%s) — another sidecar instance running?",
                  AVIO_HTTP_PORT, e)
        return
    log.info("avio: HTTP server listening on 127.0.0.1:%d (ffmpeg=%s)",
             AVIO_HTTP_PORT, AVIO_FFMPEG_BIN)
    server.serve_forever()


def main() -> int:
    global mic_state
    mic_state = check_macos_mic_permission()
    log.info("mic permission: %s", mic_state)
    if mic_state == "denied":
        log.error("mic permission DENIED — sidecar will run but capture zero buffers. "
                  "To fix: run sidecar/macos/build_bundle.sh --reset-tcc and re-launch the bundle.")
    elif mic_state == "not-determined":
        log.error("mic permission NOT-DETERMINED — daemon was started outside the .app bundle. "
                  "Launch via 'open ~/Applications/StudioDAWSidecar.app' so the Swift shim can prompt.")

    threading.Thread(target=audio_supervisor_loop, daemon=True).start()
    threading.Thread(target=levels_loop, daemon=True).start()
    threading.Thread(target=record_heartbeat_loop, daemon=True).start()
    threading.Thread(target=health_loop, daemon=True).start()
    threading.Thread(target=avio_http_server, daemon=True).start()

    # Graceful shutdown: stop loops, close stream + recording + disconnect.
    def shutdown(*_):
        log.info("shutting down")
        shutdown_event.set()
        stop_recording()
        with audio_lock:
            _close_stream(audio_stream)
        try: sio.disconnect()
        except Exception: pass
        # Give threads a moment to notice the event before exit.
        time.sleep(0.2)
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # Connect (blocking with retries until dashboard is up).
    auth = {"token": SIDECAR_TOKEN} if SIDECAR_TOKEN else {}
    while not shutdown_event.is_set():
        try:
            log.info("dialing dashboard at %s ...", DASHBOARD_URL)
            sio.connect(DASHBOARD_URL, namespaces=["/sidecar"], auth=auth, wait=True, wait_timeout=10)
            break
        except Exception as e:
            log.warning("connect failed: %s — retrying in 5s", e)
            time.sleep(5)

    sio.wait()
    return 0


if __name__ == "__main__":
    sys.exit(main())
