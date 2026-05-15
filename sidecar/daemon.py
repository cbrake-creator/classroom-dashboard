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
#
# Architecture: ffmpeg captures from AV.io via AVFoundation and pushes the
# encoded H.264 stream as RTSP to a local go2rtc instance. go2rtc translates
# the RTSP stream into WebRTC (via WHEP) for the browser, which gives us
# OBS-tier latency (~50-100ms end-to-end) with hardware H.264 decode in the
# <video> element. The previous JPEG/HTTP-polling path was dropped because
# Chrome dropped multipart/x-mixed-replace support in <img> and per-frame
# HTTP polling capped latency at ~150-250ms.
AVIO_HTTP_PORT = env_int("AVIO_HTTP_PORT", 3301)
AVIO_FFMPEG_BIN = env("AVIO_FFMPEG_BIN",
                      str(Path(__file__).parent.parent / "bin" / "ffmpeg"))
AVIO_AVFOUNDATION_INDEX = env("AVIO_AVFOUNDATION_INDEX", "AV.io 4K Video")
# ↑ AVFoundation accepts either an integer index OR the device's name. We use
# the name because USB unplug/replug cycles (firmware updates, hub flakiness,
# etc.) reorder the index list — and after several such cycles, "0" stops
# being AV.io and becomes whatever video device was discovered first (often
# the Mac's built-in webcam or a Studio Display's camera). Pinning by name
# survives reorderings as long as AV.io reports the same device name to
# AVFoundation, which it has across all firmware versions we've seen.
# If AV.io is unplugged entirely, ffmpeg fails open with a clear error
# ("Configuration of video device failed") rather than silently capturing
# the wrong device.
AVIO_FRAMERATE = env_int("AVIO_FRAMERATE", 30)   # AV.io 4K firmware 4.0.0 dropped
                                                  # 60fps from its USB mode list — the
                                                  # max it advertises at 1080p is 30fps.
                                                  # We were briefly at 60 with firmware
                                                  # 3.2 (and only realized ~27 due to
                                                  # USB negotiation) but 4.0 won't even
                                                  # accept the request. Setting 60 here
                                                  # would cause ffmpeg to fail-open with
                                                  # Input/output error against the 4.0
                                                  # firmware.
AVIO_WIDTH = env_int("AVIO_WIDTH", 1920)         # Pin AVFoundation to ask the
AVIO_HEIGHT = env_int("AVIO_HEIGHT", 1080)       # device for 1920x1080 directly.
                                                  # Without -video_size, AVFoundation
                                                  # was picking the AV.io's 4K DCI
                                                  # mode (4096x2160) and AV.io was
                                                  # internally upscaling Pearl's
                                                  # 1080p signal to 4K — saturating
                                                  # USB 3 bandwidth (~530 MB/s) and
                                                  # capping realized capture at ~13 fps.
AVIO_RTSP_URL = env("AVIO_RTSP_URL", "rtsp://127.0.0.1:8554/avio")
AVIO_BITRATE_KBPS = env_int("AVIO_BITRATE_KBPS", 8000)   # bumped for 1080p quality at libx264 veryfast

# Path C: switch between legacy ffmpeg capture+encode and the Swift-native
# avio-capture + ffmpeg muxer pipeline. Default stays "ffmpeg" (production
# unchanged) — set AVIO_CAPTURE_MODE=swift in launchd plist to flip.
AVIO_CAPTURE_MODE = env("AVIO_CAPTURE_MODE", "ffmpeg").lower()
AVIO_SWIFT_BIN = env("AVIO_SWIFT_BIN",
    "/Users/greenteam/Projects/classroom-dashboard-pathc/sidecar/swift-capture/.build/arm64-apple-macosx/release/avio-capture")

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
# /api/avio/* routes to this localhost server. ffmpeg runs inside this daemon
# as a subprocess, so it inherits the bundle's camera permission via TCC
# responsibility — which is the whole reason this lives in the sidecar at all.
#
# Architecture: ONE long-running ffmpeg subprocess emits JPEGs continuously
# to stdout via the image2pipe muxer. A reader thread parses each frame and
# stores the bytes in `latest_frame` (lock-protected). The HTTP /snapshot
# handler returns the cached bytes in O(1), so the dashboard can poll it
# every ~100ms without spawning a new ffmpeg per request. This replaces the
# original "spawn-per-request" model + the mpjpeg endpoint, both of which
# Chrome's evolving multipart/x-mixed-replace support broke in <img> tags.
import hashlib
import http.server
import socketserver
import subprocess


def _ffmpeg_capture_args() -> list[str]:
    """Args for the long-running capture subprocess. Encodes AV.io's UYVY422
    feed as H.264 with VideoToolbox (Apple hardware encoder) and pushes the
    stream over RTSP to a local go2rtc instance, which exposes it to the
    browser as WebRTC.

    Low-latency tuning:
      -g <fps>            keyframe every 1s for fast WebRTC connect-time
      -bf 0               no B-frames (B-frames need future-frame context →
                          enforced encode latency); WebRTC clients work better
                          without them anyway
      -realtime 1         VideoToolbox flag: encode in realtime mode, dropping
                          quality before queuing frames
      -allow_sw 1         fall back to software encode if VT unavailable
      -rtsp_transport tcp localhost RTSP is reliable; UDP just complicates this
    """
    return [
        AVIO_FFMPEG_BIN,
        "-nostdin", "-loglevel", "error", "-hide_banner",
        "-f", "avfoundation",
        "-framerate", str(AVIO_FRAMERATE),
        # NV12: 4:2:0 chroma, ~33% less data than UYVY422 over USB. Tested
        # both formats under firmware 4.0.0 (2026-05-15): they deliver
        # essentially the same realized framerate (~24 fps NV12 vs ~23 fps
        # UYVY422), and the encoder produces yuv420p for WebRTC either way
        # so the 4:2:2-vs-4:2:0 chroma quality difference doesn't visually
        # materialize. NV12 wins on bandwidth and CPU.
        "-pixel_format", "nv12",
        # Pin the resolution to the AV.io's native 1080p mode. Without this,
        # AVFoundation defaulted to 4K DCI (4096x2160) which forced AV.io to
        # internally upscale Pearl's 1920x1080 HDMI signal — saturating USB 3
        # bandwidth and capping us at ~13 fps. Asking for 1920x1080 directly
        # uses AV.io's pass-through path and unlocks the full 60 fps Pearl
        # provides.
        "-video_size", f"{AVIO_WIDTH}x{AVIO_HEIGHT}",
        # Small queue: enough for jitter absorption, not so large that frames
        # pile up under back-pressure (was 512 — ~17s of buffer at 30fps).
        "-thread_queue_size", "16",
        "-i", AVIO_AVFOUNDATION_INDEX,
        # Pass each input frame through to the encoder exactly once. Without
        # this, ffmpeg's default vsync treats -framerate as a CFR output target
        # and synthesizes thousands of duplicate frames per second when the
        # device delivers fewer frames than requested — which is what AV.io
        # does (one good buffer at startup, then near-zero throughput).
        "-fps_mode", "passthrough",
        # Scale filter removed — input is now exactly 1920x1080 from
        # AVFoundation, matching Pearl's HDMI output, so no resampling needed.
        # libx264 with hand-picked low-latency + quality flags.
        #
        # -preset veryfast: real-time-capable preset that ENABLES deblocking,
        # sub-pixel motion estimation, multiple-reference frames, and trellis
        # quantization — all of which were OFF in ultrafast and were the
        # source of visible blockiness/pixelation. veryfast at 1080p on
        # Apple Silicon still runs faster than realtime with headroom.
        #
        # -profile:v main: enables CABAC entropy coding (~15% better quality
        # at same bitrate vs baseline's CAVLC) and 8x8 DCT. We keep -bf 0 so
        # no B-frames are introduced — main profile would normally allow them.
        #
        # -x264-params sliced-threads=1 is the critical low-latency knob.
        # x264's default is FRAME-level threading (pipelines ~CPU-count
        # frames in parallel for throughput), which adds hundreds of ms of
        # encoder latency. Slice-level threading keeps multi-core throughput
        # but processes a single frame at a time → near-zero added latency.
        # aq-mode=1 = variance-based adaptive quantization (better detail
        # preservation in flat regions). ref=2 = 2 reference frames (slight
        # compression improvement, negligible latency).
        #
        # CRITICAL: we deliberately avoid -tune zerolatency because it also
        # sets force-cfr=1, which combined with our -fps_mode passthrough
        # input wedges the encoder onto the first received frame and emits it
        # forever (observed during debugging: 5/5 byte-identical JPEGs at
        # ~239 kbps).
        "-c:v", "libx264",
        # superfast vs veryfast: same CABAC + deblock + weightp, only diff is
        # subme (1 vs 2) and slightly less aggressive motion estimation. The
        # CPU savings let realized fps climb significantly closer to source rate.
        "-preset", "superfast",
        "-profile:v", "main",
        "-x264-params", "sliced-threads=1:sync-lookahead=0:aq-mode=1",
        "-b:v", f"{AVIO_BITRATE_KBPS}k",
        # 5% headroom over target keeps motion spikes from running away.
        "-maxrate", f"{int(AVIO_BITRATE_KBPS * 1.05)}k",
        # 500k rate-control buffer at 8 Mbps ≈ ~60ms. Tried 250k briefly to
        # save ~30ms more — caused visible rate-control oscillation/jitter
        # because 1080p keyframes (50-300 KB) routinely overflow a 30ms buffer,
        # making the rate controller crush subsequent P-frames. 500k is the
        # sweet spot for smooth output at our 8 Mbps / 4-keyframes-per-second
        # operating point.
        "-bufsize", "500k",
        # Keyframe every ~0.25s. RTSP push doesn't support PLI/NACK feedback
        # from the WebRTC side, so if the browser's decoder loses a frame it
        # has to wait until the next scheduled keyframe to recover. We tried
        # GOP 4 (0.13s) for faster recovery but it produced too many heavy
        # I-frames per second for our bufsize to ride out smoothly. GOP 7
        # restores smoothness.
        "-g", str(max(1, AVIO_FRAMERATE // 4)),
        "-keyint_min", str(max(1, AVIO_FRAMERATE // 4)),
        "-bf", "0",   # redundant with -tune zerolatency; kept explicit
        # Force a keyframe every 0.25s (matches -g above).
        "-force_key_frames", "expr:gte(t,n_forced*0.25)",
        "-pix_fmt", "yuv420p",       # WebRTC requires 4:2:0 chroma
        # Push packets to the muxer as soon as the encoder emits them, instead
        # of batching. Combined with -muxdelay 0 / -muxpreload 0 this strips
        # ffmpeg's RTSP-output startup buffer (default ~700ms of preload).
        "-flush_packets", "1",
        "-muxdelay", "0",
        "-muxpreload", "0",
        "-f", "rtsp",
        # TCP for the RTSP push. go2rtc 1.9.14's RTSP server only accepts
        # TCP SETUP — UDP push gets rejected with 461 Unsupported transport
        # — so we use TCP even though Nagle/slow-start add a small fixed
        # latency. Could be revisited if we ever swap go2rtc for an RTSP
        # server that accepts UDP push (mediamtx, simple-rtsp-server, etc.).
        "-rtsp_transport", "tcp",
        AVIO_RTSP_URL,
    ]


# Holds the currently-running ffmpeg subprocess so the /avio/restart HTTP
# endpoint can kill it. Killing makes the capture loop's wait() return, the
# outer while spins up a fresh ffmpeg with a fresh RTSP push session. This is
# the only known way to make AV.io re-negotiate its HDMI link after Pearl
# changes the output source — without it, ffmpeg pushes pre-switch buffered
# frames to go2rtc indefinitely.
avio_proc_lock = threading.Lock()
avio_proc: Optional[subprocess.Popen] = None

# When set, avio_capture_loop pauses ffmpeg respawning so an alternate AV.io
# consumer (e.g. the avio-capture Swift binary spawned by /avio/probe-swift)
# can hold the device for a focused test. Released by the probe handler when
# the alternate consumer exits.
avio_pause_capture = False


def avio_kick_capture() -> bool:
    """Signal the capture loop to drop its current ffmpeg and start fresh.
    Returns True if we actually killed a running process."""
    with avio_proc_lock:
        proc = avio_proc
    if proc is None:
        return False
    try:
        log.info("avio: kicking ffmpeg (pid=%s) — forcing fresh HDMI handshake", proc.pid)
        proc.kill()
        return True
    except Exception as e:
        log.warning("avio: kick failed: %s", e)
        return False


def _start_stderr_drain(proc: subprocess.Popen, label: str) -> None:
    """Start a daemon thread that reads `proc`'s stderr line-by-line and
    forwards each line to the sidecar log under `[label]`. Used to surface
    ffmpeg / Swift errors during steady-state operation. Handles both binary
    and text stderr streams since we mix bufsize=0/text=True across processes
    in the same pipeline."""
    def _drain() -> None:
        try:
            assert proc.stderr is not None
            for line in proc.stderr:
                if isinstance(line, bytes):
                    line = line.decode("utf-8", errors="replace")
                line = line.rstrip()
                if line:
                    log.info("avio[%s]: %s", label, line)
        except Exception as e:
            log.debug("avio: %s stderr drain ended: %s", label, e)
    threading.Thread(target=_drain, daemon=True).start()


def _swift_pipeline_cmds() -> tuple[list[str], list[str]]:
    """Return the (swift_cmd, ffmpeg_muxer_cmd) tuple for Path C.

    The Swift binary captures from AV.io directly via AVCaptureSession,
    encodes H.264 NALs via VideoToolbox, and writes Annex-B bytes to stdout.
    ffmpeg here only muxes those pre-encoded NALs into RTSP — no decoding
    or re-encoding. This eliminates ffmpeg's AVFoundation indev as the
    capture mechanism (which had explicit-format-selection limitations
    that capped realized fps under the device's advertised rate)."""
    swift_cmd = [
        AVIO_SWIFT_BIN,
        "--device", "AV.io 4K Video",
        "--width", str(1920), "--height", str(1080),
        "--fps", "60",                # device delivers ~30 even when 60 requested
        "--pixel-format", "nv12",
        "--bitrate", str(AVIO_BITRATE_KBPS),
        "--keyframe-interval", "0.25",
        "--profile", "main",
        "--output-stdout-nals",
        "--duration", "0",            # run until SIGTERM
    ]
    ffmpeg_cmd = [
        AVIO_FFMPEG_BIN,
        "-nostdin", "-loglevel", "error", "-hide_banner",
        "-fflags", "+genpts",
        "-f", "h264", "-i", "pipe:0",
        "-c:v", "copy",
        "-flush_packets", "1",
        "-muxdelay", "0",
        "-muxpreload", "0",
        "-f", "rtsp", "-rtsp_transport", "tcp",
        AVIO_RTSP_URL,
    ]
    return swift_cmd, ffmpeg_cmd


def avio_capture_loop() -> None:
    """Keep the AV.io capture pipeline running continuously. The active
    pipeline depends on AVIO_CAPTURE_MODE:

    - "ffmpeg" (default, legacy): one ffmpeg subprocess captures via
      AVFoundation indev + encodes via libx264 + RTSP push to go2rtc.

    - "swift" (Path C): two subprocesses chained — avio-capture (Swift)
      drives AVCaptureSession directly + VideoToolbox H.264, pipes Annex-B
      NALs to a slim ffmpeg muxer that does RTSP push (`-c:v copy`, no
      re-encode). The Swift process is the "primary" — kicking it via
      avio_kick_capture() cascades EOF down to the ffmpeg muxer.

    Either pipeline pushes to AVIO_RTSP_URL (= the 'avio' stream that the
    dashboard's WHEP client subscribes to), so the dashboard sees Path C
    output transparently when mode flips.
    """
    global avio_proc
    if not Path(AVIO_FFMPEG_BIN).is_file():
        log.warning("avio: ffmpeg not found at %s — capture loop won't start", AVIO_FFMPEG_BIN)
        return
    if AVIO_CAPTURE_MODE == "swift" and not Path(AVIO_SWIFT_BIN).is_file():
        log.warning("avio: AVIO_CAPTURE_MODE=swift but avio-capture binary not found at %s — capture loop won't start. Build it with `cd sidecar/swift-capture && swift build -c release`.", AVIO_SWIFT_BIN)
        return
    log.info("avio: capture mode = %s", AVIO_CAPTURE_MODE)

    backoff = 1.0
    while not shutdown_event.is_set():
        # Honor the probe pause flag — set by /avio/probe-swift{,-pipeline}
        # while an alternate consumer holds the device.
        if avio_pause_capture:
            time.sleep(0.5)
            continue

        # Each iteration spawns a fresh set of processes for the current mode.
        # `all_procs` is everything we need to clean up; `primary` is what
        # /avio/restart kicks (typically the upstream-most process in the
        # pipeline, so EOF cascades cleanly to anything reading from it).
        all_procs: list[subprocess.Popen] = []
        primary: Optional[subprocess.Popen] = None
        started_at = time.time()
        try:
            if AVIO_CAPTURE_MODE == "swift":
                swift_cmd, ffmpeg_cmd = _swift_pipeline_cmds()
                log.info("avio: starting swift|ffmpeg pipeline → %s (target %d fps @ 1080p, %dk h264)",
                         AVIO_RTSP_URL, AVIO_FRAMERATE, AVIO_BITRATE_KBPS)
                swift_proc = subprocess.Popen(
                    swift_cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    bufsize=0,
                )
                ffmpeg_proc = subprocess.Popen(
                    ffmpeg_cmd,
                    stdin=swift_proc.stdout,
                    stderr=subprocess.PIPE,
                    bufsize=1,
                    text=True,
                )
                # Close parent's reference so ffmpeg gets EOF when swift exits.
                swift_proc.stdout.close()
                # swift_proc.stderr is binary (bufsize=0 implies no text mode);
                # the drain function decodes bytes per-line.
                _start_stderr_drain(swift_proc, "swift")
                _start_stderr_drain(ffmpeg_proc, "ffmpeg-mux")
                all_procs = [swift_proc, ffmpeg_proc]
                primary = swift_proc
            else:  # "ffmpeg" (legacy)
                cmd = _ffmpeg_capture_args()
                log.info("avio: starting ffmpeg → %s (%d fps @ %dp, %dk h264)",
                         AVIO_RTSP_URL, AVIO_FRAMERATE, AVIO_HEIGHT, AVIO_BITRATE_KBPS)
                ff_proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    bufsize=1,
                    text=True,
                )
                _start_stderr_drain(ff_proc, "ffmpeg")
                all_procs = [ff_proc]
                primary = ff_proc

            with avio_proc_lock:
                avio_proc = primary

            # Wait for ANY process in the pipeline to exit (or shutdown).
            while not shutdown_event.is_set():
                if any(p.poll() is not None for p in all_procs):
                    break
                time.sleep(0.5)

            uptime = time.time() - started_at
            # Log exit status of each.
            labels = (["swift", "ffmpeg-mux"] if AVIO_CAPTURE_MODE == "swift" else ["ffmpeg"])
            for p, label in zip(all_procs, labels):
                rc = p.poll()
                if rc is None:
                    continue
                if rc == -9 and uptime > 1.0:
                    log.info("avio: %s killed after %.1fs uptime (likely source switch / kick)", label, uptime)
                elif rc == 0:
                    log.info("avio: %s exited cleanly after %.1fs", label, uptime)
                else:
                    log.warning("avio: %s exited rc=%s after %.1fs", label, rc, uptime)
            backoff = 1.0 if uptime > 5.0 else min(backoff * 1.5, 15.0)
        except Exception as e:
            log.warning("avio: capture loop error: %s", e)
            backoff = min(backoff * 1.5, 15.0)
        finally:
            with avio_proc_lock:
                avio_proc = None
            # Tear down every process in the pipeline. ffmpeg sometimes needs
            # SIGKILL after SIGTERM since it can be stuck in a blocking read
            # against AVFoundation or stdin pipe.
            for p in all_procs:
                if p.poll() is None:
                    try:
                        p.terminate()
                        p.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        p.kill()
                    except Exception:
                        pass
        if shutdown_event.is_set():
            break
        time.sleep(backoff)


class _AvioHandler(http.server.BaseHTTPRequestHandler):
    # Sidecar's loopback HTTP server is now just a health probe + restart
    # hook. Snapshots and MJPEG were retired when we switched to RTSP push +
    # go2rtc/WebRTC — the dashboard hits go2rtc directly (proxied by the
    # backend) for frames and live video.
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
        self.send_error(404, "unknown path")

    def do_POST(self) -> None:
        global avio_pause_capture  # used by /avio/probe-swift{,-pipeline}
        path = self.path.split("?", 1)[0]
        # POST /avio/restart — kill the running ffmpeg subprocess. The capture
        # loop's outer while spins it back up automatically. Used after Pearl
        # source changes to force AV.io to renegotiate the HDMI handshake;
        # without this, ffmpeg keeps pushing its pre-switch buffered frames
        # to go2rtc and the dashboard shows the old content indefinitely.
        if path == "/avio/restart":
            killed = avio_kick_capture()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true,"killed":' + (b'true' if killed else b'false') + b'}')
            return
        # POST /avio/probe-swift-pipeline — Path C Step 5: pipe avio-capture's
        # Annex-B NAL stream into a slim ffmpeg muxer pushing to go2rtc's
        # avio-dev stream. Lets us compare the full Path C pipeline side-by-side
        # with the production avio stream without disturbing production. The
        # avio-dev stream is created dynamically via go2rtc's PUT /api/streams
        # so no go2rtc restart is needed.
        #
        # Query params:
        #   duration=<seconds>   How long to run the pipeline (default: 30)
        if path == "/avio/probe-swift-pipeline":
            qs2 = self.path.split("?", 1)[1] if "?" in self.path else ""
            params2 = dict(p.split("=", 1) for p in qs2.split("&") if "=" in p) if qs2 else {}
            duration_s = int(params2.get("duration", "30"))

            swift_bin = "/Users/greenteam/Projects/classroom-dashboard-pathc/sidecar/swift-capture/.build/arm64-apple-macosx/release/avio-capture"
            ffmpeg_bin = AVIO_FFMPEG_BIN
            if not Path(swift_bin).is_file() or not Path(ffmpeg_bin).is_file():
                self.send_error(503, "binary not found")
                return

            # Ensure go2rtc has the avio-dev stream registered (idempotent).
            output_lines = []
            try:
                import urllib.request
                req = urllib.request.Request(
                    "http://127.0.0.1:1984/api/streams?name=avio-dev&src=",
                    method="PUT"
                )
                with urllib.request.urlopen(req, timeout=2) as resp:
                    output_lines.append(f"go2rtc PUT /api/streams?name=avio-dev: HTTP {resp.status}")
            except Exception as e:
                output_lines.append(f"go2rtc PUT /api/streams: warning: {e!r} (continuing)")

            swift_proc = None
            ffmpeg_proc = None
            avio_pause_capture = True
            try:
                log.info("probe-swift-pipeline: pausing ffmpeg, killing prod ffmpeg")
                avio_kick_capture()
                time.sleep(1.5)

                swift_cmd = [
                    swift_bin,
                    "--device", "AV.io 4K Video",
                    "--width", "1920", "--height", "1080",
                    "--fps", "60", "--pixel-format", "nv12",
                    "--bitrate", "8000",
                    "--keyframe-interval", "0.25",
                    "--profile", "main",
                    "--output-stdout-nals",
                    "--duration", "0",   # run until SIGTERM
                ]
                # ffmpeg here only muxes the pre-encoded H.264 into RTSP — no
                # decoding, no re-encoding. -c:v copy = passthrough. The
                # critical input flag is "-f h264" so ffmpeg's h264 demuxer
                # parses our Annex-B stream correctly.
                ffmpeg_cmd = [
                    ffmpeg_bin,
                    "-nostdin", "-loglevel", "error", "-hide_banner",
                    "-fflags", "+genpts",      # generate pts from input order
                    "-f", "h264", "-i", "pipe:0",
                    "-c:v", "copy",
                    "-flush_packets", "1",
                    "-muxdelay", "0", "-muxpreload", "0",
                    "-f", "rtsp", "-rtsp_transport", "tcp",
                    "rtsp://127.0.0.1:8554/avio-dev",
                ]

                log.info("probe-swift-pipeline: spawning swift+ffmpeg muxer for %ds", duration_s)
                swift_proc = subprocess.Popen(swift_cmd,
                                              stdout=subprocess.PIPE,
                                              stderr=subprocess.PIPE)
                ffmpeg_proc = subprocess.Popen(ffmpeg_cmd,
                                               stdin=swift_proc.stdout,
                                               stderr=subprocess.PIPE)
                # Important: close the parent's reference so ffmpeg sees EOF
                # when swift exits. Without this, ffmpeg hangs on EOF detection.
                swift_proc.stdout.close()

                # Run pipeline for the requested duration.
                time.sleep(duration_s)

                # Query go2rtc for the avio-dev stream stats mid-run.
                try:
                    import urllib.request as _u
                    with _u.urlopen("http://127.0.0.1:1984/api/streams", timeout=2) as resp:
                        import json as _j
                        streams = _j.loads(resp.read())
                        if "avio-dev" in streams:
                            info = streams["avio-dev"]
                            prods = info.get("producers") or []
                            cons  = info.get("consumers") or []
                            output_lines.append(
                                f"avio-dev: {len(prods)} producer(s), {len(cons)} consumer(s)")
                            for p in prods:
                                output_lines.append(
                                    f"  PROD bytes_recv={p.get('bytes_recv')}  "
                                    f"recv_ids={[r.get('id') for r in (p.get('receivers') or [])]}")
                                for r in (p.get("receivers") or []):
                                    c = r.get("codec", {})
                                    output_lines.append(
                                        f"    codec={c.get('codec_name')} "
                                        f"profile={c.get('profile')} "
                                        f"level={c.get('level')}")
                        else:
                            output_lines.append("avio-dev: STREAM NOT FOUND in go2rtc/api/streams")
                except Exception as e:
                    output_lines.append(f"go2rtc /api/streams query failed: {e!r}")

                # Tear down.
                log.info("probe-swift-pipeline: tearing down")
                ffmpeg_proc.terminate()
                swift_proc.terminate()
                try: ffmpeg_proc.wait(timeout=3)
                except subprocess.TimeoutExpired: ffmpeg_proc.kill()
                try: swift_proc.wait(timeout=3)
                except subprocess.TimeoutExpired: swift_proc.kill()

                swift_stderr = swift_proc.stderr.read().decode("utf-8", errors="replace") if swift_proc.stderr else ""
                ffmpeg_stderr = ffmpeg_proc.stderr.read().decode("utf-8", errors="replace") if ffmpeg_proc.stderr else ""

                output_lines.append(
                    f"swift exit={swift_proc.returncode}  ffmpeg exit={ffmpeg_proc.returncode}")
                output_lines.append(f"=== swift stderr (tail) ===\n{swift_stderr[-2000:]}")
                output_lines.append(f"=== ffmpeg stderr ===\n{ffmpeg_stderr}")

            except Exception as e:
                output_lines.append(f"probe-swift-pipeline error: {e!r}")
                log.warning("probe-swift-pipeline failed: %s", e)
                for p in (ffmpeg_proc, swift_proc):
                    if p is not None and p.poll() is None:
                        try: p.kill()
                        except Exception: pass
            finally:
                avio_pause_capture = False
                log.info("probe-swift-pipeline: unpaused ffmpeg respawn loop")

            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write("\n".join(output_lines).encode("utf-8"))
            return

        # POST /avio/probe-swift — temporarily pause ffmpeg, run the Path C
        # avio-capture Swift binary as a subprocess (inheriting this daemon's
        # bundle-context Camera TCC), and return its stderr (and basic encoder
        # output stats if mode=h264). Used for Path C validation. Removed
        # once Path C is fully integrated (Step 7).
        #
        # Query params:
        #   mode=count (default) — run in frame-counting mode (fps stats only)
        #   mode=h264            — run with --output-stdout-nals, capture H.264
        #                          NAL stream to /tmp/swift_test.h264, report
        #                          file size + NAL start-code count
        if path == "/avio/probe-swift":
            # parse query string
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p) if qs else {}
            mode = params.get("mode", "count")

            swift_bin = "/Users/greenteam/Projects/classroom-dashboard-pathc/sidecar/swift-capture/.build/arm64-apple-macosx/release/avio-capture"
            if not Path(swift_bin).is_file():
                self.send_response(503)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(f"avio-capture not found at {swift_bin}\n".encode())
                return

            duration_s = 12
            output_text = ""
            avio_pause_capture = True
            try:
                log.info("probe-swift mode=%s: pausing ffmpeg, killing current proc", mode)
                avio_kick_capture()
                time.sleep(1.5)

                base_args = [
                    swift_bin,
                    "--device", "AV.io 4K Video",
                    "--width", "1920", "--height", "1080",
                    "--fps", "60", "--pixel-format", "nv12",
                    "--duration", str(duration_s),
                ]

                if mode == "h264":
                    nal_path = "/tmp/swift_test.h264"
                    Path(nal_path).unlink(missing_ok=True)
                    args = base_args + ["--output-stdout-nals"]
                    log.info("probe-swift h264: spawning %s, writing NALs to %s", swift_bin, nal_path)
                    with open(nal_path, "wb") as nal_file:
                        result = subprocess.run(
                            args,
                            stdout=nal_file,
                            stderr=subprocess.PIPE,
                            timeout=duration_s + 10,
                        )
                    stderr_text = result.stderr.decode("utf-8", errors="replace")
                    # Analyze the NAL file: size, count of Annex-B start codes (0x00000001).
                    nal_size = Path(nal_path).stat().st_size if Path(nal_path).is_file() else 0
                    start_code_count = 0
                    first_nal_type = None
                    if nal_size > 0:
                        with open(nal_path, "rb") as f:
                            data = f.read(min(nal_size, 1024 * 1024))  # sample first 1MB
                        start_code_count = data.count(b"\x00\x00\x00\x01")
                        # First NAL type byte = first byte after the first start code.
                        idx = data.find(b"\x00\x00\x00\x01")
                        if idx >= 0 and idx + 4 < len(data):
                            first_nal_type = data[idx + 4] & 0x1F
                    output_text = (
                        f"=== mode: h264 ===\n"
                        f"=== exit code: {result.returncode} ===\n"
                        f"=== NAL output: {nal_path} ===\n"
                        f"  file size:           {nal_size} bytes ({nal_size / 1024:.1f} KB)\n"
                        f"  bitrate over {duration_s}s: {(nal_size * 8 / duration_s / 1000):.1f} kbps\n"
                        f"  NAL start codes:     {start_code_count}\n"
                        f"  first NAL unit type: {first_nal_type} "
                        f"({'SPS (7)' if first_nal_type==7 else 'PPS (8)' if first_nal_type==8 else 'IDR (5)' if first_nal_type==5 else 'P-slice (1)' if first_nal_type==1 else '?'})\n"
                        f"  expected for valid H.264: file >0B, >0 start codes, first NAL type 7 (SPS)\n"
                        f"=== avio-capture stderr ===\n{stderr_text}\n"
                    )
                else:
                    log.info("probe-swift count: spawning %s for %ds", swift_bin, duration_s)
                    result = subprocess.run(
                        base_args,
                        capture_output=True, text=True, timeout=duration_s + 10,
                    )
                    output_text = (
                        "=== mode: count ===\n=== exit code: %d ===\n=== stdout ===\n%s\n=== stderr ===\n%s\n"
                        % (result.returncode, result.stdout, result.stderr)
                    )

                log.info("probe-swift: exit=%d", result.returncode)
            except subprocess.TimeoutExpired:
                output_text = "probe-swift: TIMEOUT after %ds\n" % (duration_s + 10)
                log.warning("probe-swift: timeout")
            except Exception as e:
                output_text = "probe-swift error: %r\n" % e
                log.warning("probe-swift failed: %s", e)
            finally:
                avio_pause_capture = False
                log.info("probe-swift: unpaused ffmpeg loop")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(output_text.encode("utf-8"))
            return
        self.send_error(404, "unknown path")


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
    threading.Thread(target=avio_capture_loop, daemon=True).start()

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
