# avio-capture (Path C)

Swift-native replacement for ffmpeg's `-f avfoundation` capture stage. Captures
the AV.io 4K device with explicit `AVCaptureDevice.activeFormat` selection,
encodes via VideoToolbox, and pipes a raw H.264 Annex-B NAL stream on stdout
that ffmpeg can mux into RTSP for go2rtc.

Replaces only the capture+encode stage of the pipeline. ffmpeg, go2rtc, the
backend, and the dashboard's WHEP client are all unchanged.

## Why

ffmpeg's `-f avfoundation` indev wraps `AVCaptureSession` but doesn't expose
explicit `activeFormat` selection — it picks a "preferred" mode based on the
device's default exposed mode list. On AV.io 4K firmware 4.0.0 (and 3.2.0)
this auto-pick lands on the 4K DCI mode by default, which forces AV.io to
internally upscale Pearl's 1080p HDMI signal to 4K, saturating USB bandwidth
and capping realized capture at 13-24 fps. By driving `AVCaptureSession`
directly we can enumerate every (resolution, pixel format, framerate) combo
the device advertises and lock the session to whichever is fastest at 1080p.

This is "Path C" of the three options laid out in the 2026-05-15 session:
keep go2rtc as the WebRTC gateway, keep ffmpeg for the RTSP muxer, replace
only the avfoundation→encoder stage that's been the bottleneck.

## Status

Scope of this commit (Step 2 of the Path C plan):
- Scaffolding only. `swift build` produces a binary; `--list-devices` prints
  every video device AVFoundation sees on this Mac.

Coming up:
- Step 3: open the AV.io device and select its highest-framerate 1080p format.
- Step 4: wire up VideoToolbox H.264 encoder and stream Annex-B NALs on stdout.
- Step 5: integrate with ffmpeg's RTSP muxer.

## Build

```
cd sidecar/swift-capture
swift build -c release
```

Binary lands at `.build/release/avio-capture` (or `.build/arm64-apple-macosx/release/avio-capture`).

## Usage (Step 2)

```
.build/release/avio-capture --list-devices
```

That's it for now. Prints every video capture device the OS exposes, including
AV.io 4K (when plugged in) and the Mac's built-in / Studio Display webcam.
Each device's full format list is printed — every supported (resolution,
pixel format FourCC, framerate range) combo.

## TCC (Camera permission)

When run from a regular Terminal / iTerm, macOS will request Camera permission
on first run. Once granted to Terminal, all child binaries inherit. For
production deployment (Step 7) the Swift binary will live inside
`StudioDAWSidecar.app` so it inherits the bundle's already-granted Camera
permission via TCC responsibility — same pattern the current ffmpeg
subprocess uses.

## Layout

```
swift-capture/
├── Package.swift              # SPM manifest
├── Sources/
│   └── AvioCapture/
│       └── main.swift         # entry point + CLI parsing
└── README.md                  # this file
```
