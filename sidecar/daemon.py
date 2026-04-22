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

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


# ─── Audio device lookup ─────────────────────────────────────
def find_input_device() -> Optional[int]:
    """Return the sounddevice index for the first INPUT device whose name
    contains AUDIO_DEVICE_MATCH (case-insensitive)."""
    match = AUDIO_DEVICE_MATCH.lower()
    for i, dev in enumerate(sd.query_devices()):
        if dev["max_input_channels"] < 1:
            continue
        if match in dev["name"].lower():
            log.info("matched input device %d: %s (%d in / %d out)",
                     i, dev["name"], dev["max_input_channels"], dev["max_output_channels"])
            return i
    log.error("no input device matched %r. Available inputs:", AUDIO_DEVICE_MATCH)
    for i, dev in enumerate(sd.query_devices()):
        if dev["max_input_channels"] >= 1:
            log.error("  [%d] %s (%d in)", i, dev["name"], dev["max_input_channels"])
    return None


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
output_dir_lock = threading.Lock()
active_output_dir: Path = OUTPUT_DIR


def _safe_name(s: str) -> str:
    """Make a strip label safe for a filename — strips the channel suffix
    (' L'/' R' duplicates handled by keeping both files distinct via ch prefix)."""
    keep = [c if c.isalnum() or c in ('-', '_') else '-' for c in s.strip()]
    out = ''.join(keep)
    while '--' in out:
        out = out.replace('--', '-')
    return out.strip('-') or 'ch'


def start_recording() -> Path:
    global current_rec
    with rec_lock:
        if current_rec is not None:
            log.info("record-start ignored; already recording -> %s", current_rec.dir)
            return current_rec.dir
        stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        with output_dir_lock:
            out_base = active_output_dir
        out_base.mkdir(parents=True, exist_ok=True)
        session_dir = out_base / f"studio_{stamp}"
        session_dir.mkdir(parents=True, exist_ok=True)

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
        except Exception:
            for _, w in writers:
                try: w.close()
                except Exception: pass
            raise
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
    progress continues in its original directory."""
    global active_output_dir
    p = Path(path_str).expanduser()
    if not p.is_absolute():
        p = Path.home() / p
    with output_dir_lock:
        active_output_dir = p
    p.mkdir(parents=True, exist_ok=True)
    log.info("output dir set to: %s", p)
    return p


# ─── Level meter ─────────────────────────────────────────────
# Audio callback computes per-channel peak (absolute max) per block.
# The socket client thread reads these on a timer and emits `levels`.
latest_peaks = np.zeros(CHANNELS, dtype=np.float32)
peaks_lock = threading.Lock()


def audio_callback(indata: np.ndarray, frames: int, time_info, status) -> None:
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
    with peaks_lock:
        # Keep the larger of incoming vs retained — decays slowly on the next tick.
        np.maximum(latest_peaks, peaks, out=latest_peaks)

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
    # Send hello with full device descriptor.
    device_name = sd.query_devices(find_input_device())["name"] if find_input_device() is not None else "unknown"
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
            path = start_recording()
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


def emit_record_state(*, active: bool, output_path: Optional[str] = None) -> None:
    rec = current_rec
    payload = {
        "active": active,
        "startedAt": int(rec.started_at * 1000) if rec else None,
        "durationSec": (time.time() - rec.started_at) if rec else 0,
        "outputPath": output_path,
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
        if current_rec is not None and sio.connected:
            try:
                emit_record_state(active=True, output_path=str(current_rec.path))
            except Exception:
                pass


def main() -> int:
    idx = find_input_device()
    if idx is None:
        return 2

    # Start the input stream in the background.
    stream = sd.InputStream(
        device=idx,
        channels=CHANNELS,
        samplerate=SAMPLE_RATE,
        dtype="float32",
        blocksize=0,
        callback=audio_callback,
    )
    stream.start()
    log.info("audio capture running: device=%s sr=%d ch=%d", idx, SAMPLE_RATE, CHANNELS)

    threading.Thread(target=levels_loop, daemon=True).start()
    threading.Thread(target=record_heartbeat_loop, daemon=True).start()

    # Graceful shutdown: close stream + recording + disconnect.
    def shutdown(*_):
        log.info("shutting down")
        stop_recording()
        try: stream.stop(); stream.close()
        except Exception: pass
        try: sio.disconnect()
        except Exception: pass
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # Connect (blocking with retries until dashboard is up).
    auth = {"token": SIDECAR_TOKEN} if SIDECAR_TOKEN else {}
    while True:
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
