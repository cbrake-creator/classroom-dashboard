// avio-capture: AV.io 4K Swift-native capture + H.264 encoder.
//
// Step 3: explicit AVCaptureDevice.activeFormat selection with frame counting.
// Step 4: adds VideoToolbox H.264 encoder, writes Annex-B NAL stream on stdout.
//
// Modes:
//   --list-devices           → print every video device + its formats, exit.
//   (default, no extra flag) → capture for --duration seconds, count + print fps.
//   --output-stdout-nals     → capture + encode to H.264, write NALs on stdout.
//                              Pipe to: ffmpeg -f h264 -i pipe:0 -c:v copy -f rtsp ...

import Foundation
import AVFoundation
import CoreMedia
import CoreVideo
import VideoToolbox

// MARK: - CLI

struct Options {
    var listDevices: Bool = false
    var deviceName: String = "AV.io 4K Video"
    var width: Int = 1920
    var height: Int = 1080
    var fps: Int = 60
    var pixelFormat: String = "nv12"
    var runDurationSec: Double = 10.0
    var help: Bool = false

    // Step 4 additions.
    var outputStdoutNals: Bool = false
    var bitrateKbps: Int = 8000
    var keyframeIntervalSec: Double = 0.25   // GOP duration target
    var profileMain: Bool = true             // false → baseline
}

let prog = (CommandLine.arguments.first.map { URL(fileURLWithPath: $0).lastPathComponent }) ?? "avio-capture"

func usage() {
    print("""
    usage: \(prog) [OPTIONS]

    AV.io 4K Swift-native capture binary (Path C).

    With no options: captures for 10s with frame-counter stats on stderr.

    SOURCE OPTIONS:
      --list-devices              Enumerate AVFoundation video devices; exit after.
      --device <name>             Open device with this localizedName.
                                  Default: "AV.io 4K Video"
      --width <px>                Capture width.   Default: 1920
      --height <px>               Capture height.  Default: 1080
      --fps <n>                   Target framerate. Default: 60
      --pixel-format <name>       Capture format (nv12 | yuvs | bgra). Default: nv12
      --duration <seconds>        How long to run before exit. Default: 10

    ENCODER OPTIONS (Step 4):
      --output-stdout-nals        Encode to H.264 and write Annex-B NAL bytes
                                  on stdout. Without this flag we just count
                                  frames and print stats to stderr.
      --bitrate <kbps>            H.264 target bitrate. Default: 8000
      --keyframe-interval <s>     GOP duration (seconds). Default: 0.25
      --profile baseline|main     H.264 profile. Default: main

      -h, --help                  Show this help and exit.

    EXAMPLES:
      # device enumeration
      \(prog) --list-devices

      # capture + fps stats (no encoding)
      \(prog) --duration 15

      # full encoder pipe → ffmpeg muxer → RTSP
      \(prog) --output-stdout-nals --duration 0 | \\
        ffmpeg -f h264 -i pipe:0 -c:v copy -f rtsp rtsp://127.0.0.1:8554/avio-dev
    """)
}

func parseArgs(_ args: ArraySlice<String>) -> Options {
    var opts = Options()
    var i = args.startIndex

    func nextValue(for flag: String) -> String {
        let next = args.index(after: i)
        guard next < args.endIndex else {
            FileHandle.standardError.write(Data("error: \(flag) requires a value\n".utf8))
            exit(2)
        }
        i = next
        return args[next]
    }

    while i < args.endIndex {
        let arg = args[i]
        switch arg {
        case "-h", "--help":               opts.help = true
        case "--list-devices":             opts.listDevices = true
        case "--device":                   opts.deviceName = nextValue(for: arg)
        case "--width":                    if let v = Int(nextValue(for: arg)) { opts.width = v }
        case "--height":                   if let v = Int(nextValue(for: arg)) { opts.height = v }
        case "--fps":                      if let v = Int(nextValue(for: arg)) { opts.fps = v }
        case "--pixel-format":             opts.pixelFormat = nextValue(for: arg)
        case "--duration":                 if let v = Double(nextValue(for: arg)) { opts.runDurationSec = v }
        case "--output-stdout-nals":       opts.outputStdoutNals = true
        case "--bitrate":                  if let v = Int(nextValue(for: arg)) { opts.bitrateKbps = v }
        case "--keyframe-interval":        if let v = Double(nextValue(for: arg)) { opts.keyframeIntervalSec = v }
        case "--profile":
            let p = nextValue(for: arg).lowercased()
            switch p {
            case "baseline": opts.profileMain = false
            case "main":     opts.profileMain = true
            default:
                FileHandle.standardError.write(Data("error: --profile must be 'baseline' or 'main' (got '\(p)')\n".utf8))
                exit(2)
            }
        default:
            FileHandle.standardError.write(Data("warning: ignoring unknown argument: \(arg)\n".utf8))
        }
        i = args.index(after: i)
    }
    return opts
}

// MARK: - FourCC helpers

func fourCC(_ code: FourCharCode) -> String {
    let bytes: [UInt8] = [
        UInt8((code >> 24) & 0xff),
        UInt8((code >> 16) & 0xff),
        UInt8((code >> 8) & 0xff),
        UInt8(code & 0xff),
    ]
    if bytes.allSatisfy({ (0x20...0x7E).contains($0) }) {
        return String(bytes: bytes, encoding: .ascii) ?? String(format: "0x%08x", code)
    }
    return String(format: "0x%08x", code)
}

func fourCCFromName(_ name: String) -> FourCharCode? {
    switch name.lowercased() {
    case "nv12", "420v", "420f", "420biplanar":
        return kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    case "yuyv", "yuyv422", "yuvs", "yuy2", "uyvy422", "uyvy":
        return kCVPixelFormatType_422YpCbCr8_yuvs
    case "bgra", "32bgra":
        return kCVPixelFormatType_32BGRA
    default:
        return nil
    }
}

func formatRange(_ range: AVFrameRateRange) -> String {
    let lo = range.minFrameRate
    let hi = range.maxFrameRate
    let loStr = (lo.rounded() == lo) ? "\(Int(lo))" : String(format: "%.3f", lo)
    let hiStr = (hi.rounded() == hi) ? "\(Int(hi))" : String(format: "%.3f", hi)
    return lo == hi ? loStr : "\(loStr)-\(hiStr)"
}

// MARK: - device enumeration

func discoverySession() -> AVCaptureDevice.DiscoverySession {
    return AVCaptureDevice.DiscoverySession(
        deviceTypes: [
            .builtInWideAngleCamera,
            .external,
            .deskViewCamera,
            .continuityCamera,
        ],
        mediaType: .video,
        position: .unspecified
    )
}

func listDevices() {
    let devices = discoverySession().devices
    print("Found \(devices.count) video capture device(s).\n")
    for (i, device) in devices.enumerated() {
        print("[\(i)] \(device.localizedName)")
        print("    uniqueID:     \(device.uniqueID)")
        print("    modelID:      \(device.modelID)")
        print("    manufacturer: \(device.manufacturer)")
        print("    deviceType:   \(device.deviceType.rawValue)")
        print("    formats (\(device.formats.count)):")
        for format in device.formats {
            let dim = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            let subtype = CMFormatDescriptionGetMediaSubType(format.formatDescription)
            let pf = fourCC(subtype)
            let ranges = format.videoSupportedFrameRateRanges
                .map(formatRange)
                .joined(separator: ", ")
            let resStr = String(format: "%4dx%-4d", dim.width, dim.height)
            print("      \(resStr)  \(pf)  fps: \(ranges)")
        }
        print("")
    }
}

// MARK: - log helpers
//
// All progress logging goes to STDERR so STDOUT can be a clean H.264 NAL byte
// stream pipeable to ffmpeg. Use logErr() everywhere instead of print().

func logErr(_ s: String) {
    FileHandle.standardError.write(Data((s + "\n").utf8))
}

// MARK: - H.264 encoder (VideoToolbox)

/// Wraps a VTCompressionSession configured for low-latency H.264 encoding.
/// Pixel buffers go in; Annex-B NAL bytes come out via the `onNALs` closure.
final class H264Encoder {
    private var session: VTCompressionSession?
    private let width: Int32
    private let height: Int32
    private let bitrateKbps: Int
    private let keyframeIntervalFrames: Int
    private let profile: CFString
    private let onNALs: (Data) -> Void

    /// Set after the first encoded frame; written ahead of every keyframe as
    /// Annex-B SPS/PPS so the downstream decoder can self-initialize without
    /// out-of-band parameter sets.
    private var paramSetData: Data?

    init(width: Int, height: Int, fps: Int, bitrateKbps: Int, keyframeIntervalSec: Double,
         profileMain: Bool, onNALs: @escaping (Data) -> Void) throws {
        self.width = Int32(width)
        self.height = Int32(height)
        self.bitrateKbps = bitrateKbps
        self.keyframeIntervalFrames = max(1, Int(Double(fps) * keyframeIntervalSec))
        self.profile = profileMain ? kVTProfileLevel_H264_Main_AutoLevel : kVTProfileLevel_H264_Baseline_AutoLevel
        self.onNALs = onNALs

        try createSession()
    }

    deinit {
        if let s = session {
            VTCompressionSessionCompleteFrames(s, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(s)
        }
    }

    private func createSession() throws {
        var s: VTCompressionSession?
        // Outer self captured via Unmanaged so the C callback can hop back into Swift.
        let outputCallback: VTCompressionOutputCallback = { (refcon, _, status, infoFlags, sbuf) in
            guard let refcon = refcon, status == noErr, let sbuf = sbuf else { return }
            let encoder = Unmanaged<H264Encoder>.fromOpaque(refcon).takeUnretainedValue()
            encoder.handleEncodedFrame(sbuf)
        }

        let refcon = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())

        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: outputCallback,
            refcon: refcon,
            compressionSessionOut: &s
        )
        guard status == noErr, let session = s else {
            throw NSError(domain: "H264Encoder", code: Int(status),
                          userInfo: [NSLocalizedDescriptionKey: "VTCompressionSessionCreate failed: \(status)"])
        }
        self.session = session

        // RealTime mode: bias encoder toward consistent latency over quality.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        // Profile/Level. Main allows CABAC (better quality at same bitrate).
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: profile)
        // No B-frames: removes frame-reorder latency.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        // Bitrate target.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate,
                             value: NSNumber(value: bitrateKbps * 1000))
        // Hint max bitrate ceiling for the rate controller (5% headroom).
        let maxBytesPerSec = (bitrateKbps * 1000 * 105 / 100) / 8
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits,
                             value: [maxBytesPerSec, 1] as CFArray)
        // Keyframe interval (in frames AND seconds — we set both).
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
                             value: NSNumber(value: keyframeIntervalFrames))
        // Tell encoder to prepare for streaming output (allocates internal state).
        VTCompressionSessionPrepareToEncodeFrames(session)
    }

    /// Encode a pixel buffer. The presentationTimeStamp is forwarded so the
    /// VT encoder can do rate control correctly across the input cadence.
    func encode(pixelBuffer: CVPixelBuffer, pts: CMTime) {
        guard let session = session else { return }
        VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: pts,
            duration: .invalid,
            frameProperties: nil,
            sourceFrameRefcon: nil,
            infoFlagsOut: nil
        )
    }

    /// Force-flush any buffered frames out of the encoder (e.g. before exit).
    func flush() {
        if let s = session {
            VTCompressionSessionCompleteFrames(s, untilPresentationTimeStamp: .invalid)
        }
    }

    // MARK: - encoded-frame handling (called from VT's worker queue)

    /// Annex-B start code 0x00 00 00 01.
    private static let nalStartCode = Data([0x00, 0x00, 0x00, 0x01])

    /// Convert an encoded CMSampleBuffer (which contains H.264 in AVCC/length-
    /// prefixed format) into Annex-B byte stream with leading start codes.
    /// Prepends SPS/PPS on keyframes so a downstream demuxer can resync.
    private func handleEncodedFrame(_ sampleBuffer: CMSampleBuffer) {
        // Cache SPS/PPS the first time we see them.
        if paramSetData == nil,
           let fd = CMSampleBufferGetFormatDescription(sampleBuffer) {
            paramSetData = extractParameterSets(from: fd)
        }

        // Is this a keyframe? Look at the sync-sample attachments.
        var isKeyFrame = true
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[CFString: Any]],
           let first = attachments.first {
            // NotSync means "depends on other frames" → P-frame.
            if let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool, notSync == true {
                isKeyFrame = false
            }
        }

        // For keyframes, emit SPS+PPS first so any new subscriber can decode.
        if isKeyFrame, let psd = paramSetData {
            onNALs(psd)
        }

        // Convert AVCC NALs (4-byte length-prefixed) to Annex-B (start-code-prefixed).
        guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var totalLength: Int = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(
            dataBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength,
            dataPointerOut: &dataPointer
        )
        guard status == noErr, let dp = dataPointer else { return }
        let buf = UnsafeMutableRawPointer(dp).assumingMemoryBound(to: UInt8.self)

        var offset = 0
        while offset + 4 <= totalLength {
            // 4-byte big-endian length prefix.
            let nalLen =
                (UInt32(buf[offset]) << 24) |
                (UInt32(buf[offset + 1]) << 16) |
                (UInt32(buf[offset + 2]) << 8)  |
                 UInt32(buf[offset + 3])
            offset += 4
            if Int(nalLen) > totalLength - offset { break }   // malformed; bail
            var nal = Data(H264Encoder.nalStartCode)
            nal.append(Data(bytes: buf + offset, count: Int(nalLen)))
            onNALs(nal)
            offset += Int(nalLen)
        }
    }

    /// Extract SPS + PPS from a CMVideoFormatDescription and serialize as a
    /// single Annex-B blob (each parameter set preceded by a 4-byte start code).
    private func extractParameterSets(from fd: CMFormatDescription) -> Data {
        var count: Int = 0
        var nalUnitHeaderLength: Int32 = 0
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            fd, parameterSetIndex: 0,
            parameterSetPointerOut: nil, parameterSetSizeOut: nil,
            parameterSetCountOut: &count, nalUnitHeaderLengthOut: &nalUnitHeaderLength
        )
        var out = Data()
        for i in 0..<count {
            var psPtr: UnsafePointer<UInt8>?
            var psLen: Int = 0
            let s = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                fd, parameterSetIndex: i,
                parameterSetPointerOut: &psPtr, parameterSetSizeOut: &psLen,
                parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil
            )
            guard s == noErr, let ptr = psPtr else { continue }
            out.append(H264Encoder.nalStartCode)
            out.append(Data(bytes: ptr, count: psLen))
        }
        return out
    }
}

// MARK: - frame processor (delegate)
//
// Combines frame counting (always on, for stderr telemetry) and optional
// pixel-buffer-to-encoder forwarding (when --output-stdout-nals is set).

final class FrameProcessor: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let startWall = Date()
    private var lastReportWall: Date
    private var framesSinceLastReport: Int = 0
    private var totalFrames: Int = 0
    private var droppedFrames: Int = 0
    private var firstFrameLogged = false

    /// Optional. If non-nil, every received pixel buffer is forwarded into the
    /// encoder. The encoder calls onNALs (set on construction) for output.
    private let encoder: H264Encoder?

    init(encoder: H264Encoder?) {
        self.encoder = encoder
        self.lastReportWall = Date()
        super.init()
    }

    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        if !firstFrameLogged {
            firstFrameLogged = true
            if let fd = CMSampleBufferGetFormatDescription(sampleBuffer) {
                let dim = CMVideoFormatDescriptionGetDimensions(fd)
                let subtype = CMFormatDescriptionGetMediaSubType(fd)
                let firstFrameLatency = Date().timeIntervalSince(startWall) * 1000.0
                logErr(String(format: "first frame: %dx%d  %@  (open→first-frame latency: %.0fms)",
                              Int(dim.width), Int(dim.height), fourCC(subtype), firstFrameLatency))
            }
        }

        totalFrames += 1
        framesSinceLastReport += 1

        if let enc = encoder, let pb = CMSampleBufferGetImageBuffer(sampleBuffer) {
            enc.encode(pixelBuffer: pb,
                       pts: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        }

        let now = Date()
        let sinceLast = now.timeIntervalSince(lastReportWall)
        if sinceLast >= 1.0 {
            let inst = Double(framesSinceLastReport) / sinceLast
            let cum = Double(totalFrames) / now.timeIntervalSince(startWall)
            logErr(String(format: "  t=%4.1fs   frames=%5d  inst_fps=%5.2f  cumulative_avg=%5.2f  dropped=%d",
                          now.timeIntervalSince(startWall), totalFrames, inst, cum, droppedFrames))
            framesSinceLastReport = 0
            lastReportWall = now
        }
    }

    func captureOutput(_ output: AVCaptureOutput,
                       didDrop sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        droppedFrames += 1
    }

    var summary: String {
        let elapsed = Date().timeIntervalSince(startWall)
        let avg = elapsed > 0 ? Double(totalFrames) / elapsed : 0
        return String(format: "summary: total_frames=%d  avg_fps=%.2f  dropped=%d  elapsed=%.2fs",
                      totalFrames, avg, droppedFrames, elapsed)
    }
}

// MARK: - capture run

func runCapture(opts: Options) {
    guard let requestedFourCC = fourCCFromName(opts.pixelFormat) else {
        logErr("error: unknown pixel format '\(opts.pixelFormat)'")
        exit(2)
    }

    let auth = AVCaptureDevice.authorizationStatus(for: .video)
    switch auth {
    case .authorized:
        break
    case .notDetermined:
        logErr("note: requesting Camera permission (please approve in the macOS prompt) ...")
        let sem = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .video) { ok in granted = ok; sem.signal() }
        sem.wait()
        if !granted {
            logErr("error: Camera access denied by user.")
            exit(1)
        }
    case .denied:
        logErr("error: Camera authorization denied. Grant in System Settings → Privacy & Security → Camera, or run from inside a TCC-allowed bundle.")
        exit(1)
    case .restricted:
        logErr("error: Camera access is restricted (parental controls / MDM).")
        exit(1)
    @unknown default:
        logErr("warning: unknown Camera authorization status \(auth.rawValue)")
    }

    let devices = discoverySession().devices
    guard let device = devices.first(where: { $0.localizedName == opts.deviceName }) else {
        let available = devices.map { "'\($0.localizedName)'" }.joined(separator: ", ")
        logErr("error: device '\(opts.deviceName)' not found. Available: [\(available)]")
        exit(2)
    }

    logErr("Device:    \(device.localizedName) (\(device.uniqueID))")
    logErr("Requested: \(opts.width)x\(opts.height) @ \(opts.fps)fps  format='\(opts.pixelFormat)' (\(fourCC(requestedFourCC)))")

    let targetWidth = Int32(opts.width)
    let targetHeight = Int32(opts.height)
    let targetFps = Double(opts.fps)
    let fpsEpsilon = 0.01

    let matchingFormats = device.formats.filter { format in
        let dim = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
        let subtype = CMFormatDescriptionGetMediaSubType(format.formatDescription)
        guard dim.width == targetWidth, dim.height == targetHeight, subtype == requestedFourCC else {
            return false
        }
        return format.videoSupportedFrameRateRanges.contains { range in
            targetFps >= range.minFrameRate - fpsEpsilon &&
            targetFps <= range.maxFrameRate + fpsEpsilon
        }
    }

    guard let chosenFormat = matchingFormats.first else {
        logErr("error: no format on '\(opts.deviceName)' matches \(opts.width)x\(opts.height) @ \(opts.fps)fps \(fourCC(requestedFourCC)). Try --list-devices.")
        exit(2)
    }

    let chosenDim = CMVideoFormatDescriptionGetDimensions(chosenFormat.formatDescription)
    let chosenSubtype = CMFormatDescriptionGetMediaSubType(chosenFormat.formatDescription)
    let chosenRanges = chosenFormat.videoSupportedFrameRateRanges.map(formatRange).joined(separator: ", ")
    logErr("Chosen:    \(chosenDim.width)x\(chosenDim.height) \(fourCC(chosenSubtype))  ranges: [\(chosenRanges)]")

    guard let targetRange = chosenFormat.videoSupportedFrameRateRanges.first(where: { range in
        targetFps >= range.minFrameRate - fpsEpsilon && targetFps <= range.maxFrameRate + fpsEpsilon
    }) else {
        logErr("internal error: matched format but no matching frame rate range")
        exit(1)
    }
    let pinDuration = targetRange.minFrameDuration
    logErr(String(format: "Pinning frame duration: %d/%d (≈ %.3f fps)",
                  pinDuration.value, pinDuration.timescale,
                  Double(pinDuration.timescale) / Double(pinDuration.value)))

    do {
        try device.lockForConfiguration()
    } catch {
        logErr("error: lockForConfiguration failed: \(error)")
        exit(1)
    }
    device.activeFormat = chosenFormat
    device.activeVideoMinFrameDuration = pinDuration
    device.activeVideoMaxFrameDuration = pinDuration
    device.unlockForConfiguration()

    // Set up encoder if requested.
    var encoder: H264Encoder? = nil
    let stdoutHandle = FileHandle.standardOutput
    let stdoutQueue = DispatchQueue(label: "avio-capture.stdout")
    if opts.outputStdoutNals {
        do {
            encoder = try H264Encoder(
                width: opts.width, height: opts.height, fps: opts.fps,
                bitrateKbps: opts.bitrateKbps,
                keyframeIntervalSec: opts.keyframeIntervalSec,
                profileMain: opts.profileMain
            ) { nals in
                // Serialize writes to stdout via a single queue. NAL byte order
                // is critical for the downstream parser; concurrent writes from
                // multiple VT-worker callbacks would corrupt the stream.
                stdoutQueue.sync {
                    do {
                        try stdoutHandle.write(contentsOf: nals)
                    } catch {
                        // If stdout is closed (downstream pipe died), we should exit.
                        logErr("error: write to stdout failed: \(error)")
                        exit(1)
                    }
                }
            }
            logErr(String(format: "Encoder:   H.264 %@ profile, %dkbps target, keyframe %.2fs (%d frames)",
                          opts.profileMain ? "Main" : "Baseline",
                          opts.bitrateKbps, opts.keyframeIntervalSec,
                          max(1, Int(Double(opts.fps) * opts.keyframeIntervalSec))))
        } catch {
            logErr("error: H264Encoder init failed: \(error)")
            exit(1)
        }
    }

    let session = AVCaptureSession()
    session.beginConfiguration()
    // On macOS the session implicitly switches to .inputPriority when we set
    // activeFormat on the device — no preset to assign here.

    let input: AVCaptureDeviceInput
    do {
        input = try AVCaptureDeviceInput(device: device)
    } catch {
        logErr("error: AVCaptureDeviceInput failed: \(error)")
        exit(1)
    }
    guard session.canAddInput(input) else {
        logErr("error: cannot add input to session")
        exit(1)
    }
    session.addInput(input)

    let output = AVCaptureVideoDataOutput()
    output.alwaysDiscardsLateVideoFrames = true
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: requestedFourCC]

    let processor = FrameProcessor(encoder: encoder)
    let delegateQueue = DispatchQueue(label: "avio-capture.delegate")
    output.setSampleBufferDelegate(processor, queue: delegateQueue)

    guard session.canAddOutput(output) else {
        logErr("error: cannot add output to session")
        exit(1)
    }
    session.addOutput(output)
    session.commitConfiguration()

    logErr("Starting capture for \(opts.runDurationSec)s ...")
    session.startRunning()

    // --duration 0 means run until SIGINT / pipe close (for production).
    if opts.runDurationSec <= 0 {
        // Run indefinitely. Use DispatchSource for signals because Swift can't
        // form C-compatible function pointers from closures that capture context.
        // SIG_IGN the default handlers first so the DispatchSource handlers
        // are what fires.
        let waitSem = DispatchSemaphore(value: 0)
        signal(SIGINT,  SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        signal(SIGPIPE, SIG_IGN)
        let sigintSrc  = DispatchSource.makeSignalSource(signal: SIGINT,  queue: .main)
        let sigtermSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        sigintSrc.setEventHandler  { waitSem.signal() }
        sigtermSrc.setEventHandler { waitSem.signal() }
        sigintSrc.resume()
        sigtermSrc.resume()
        waitSem.wait()
    } else {
        Thread.sleep(forTimeInterval: opts.runDurationSec)
    }

    session.stopRunning()
    encoder?.flush()
    logErr("Capture stopped.")
    logErr(processor.summary)
}

// MARK: - main

let args = CommandLine.arguments.dropFirst()
let opts = parseArgs(args)

if opts.help {
    usage()
    exit(0)
}

if opts.listDevices {
    listDevices()
    exit(0)
}

runCapture(opts: opts)
exit(0)
