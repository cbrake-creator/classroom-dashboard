// StudioDAWSidecar — TCC microphone-permission shim.
//
// macOS attributes microphone access to the *running process's* code-signing
// identity. When the bundle's main binary is a shell script, the process is
// /bin/bash (signed by Apple), not our bundle, so TCC silently denies and
// never renders the prompt. This Mach-O binary IS the bundle's main process,
// so requestAccess(for: .audio) renders the dialog and the granted entry
// persists by bundle identity (com.dts.studio-daw-sidecar) thereafter.
//
// Sequence:
//   1. Become an Accessory app (no Dock, no Cmd-Tab, but still a UI process).
//   2. Synchronously request microphone access. Pump the run loop until the
//      user answers OR a timeout fires.
//   3. exec the Python wrapper (Contents/Resources/run.sh). The shim's PID is
//      replaced by the wrapper's, which keeps a clean process tree under
//      launchd / Login Items.

import Foundation
import AVFoundation
import AppKit

// Write to a dedicated file because launchd / `open` discard stderr.
let logPath: String = {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let dir = "\(home)/Library/Logs"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return "\(dir)/studio-daw-sidecar-shim.log"
}()
let logFH: FileHandle? = {
    if !FileManager.default.fileExists(atPath: logPath) {
        FileManager.default.createFile(atPath: logPath, contents: nil)
    }
    let fh = FileHandle(forWritingAtPath: logPath)
    fh?.seekToEndOfFile()
    return fh
}()
let log: (String) -> Void = { msg in
    let ts = ISO8601DateFormatter().string(from: Date())
    let line = "[\(ts)] sidecar-shim: \(msg)\n"
    logFH?.write(Data(line.utf8))
    FileHandle.standardError.write(Data(line.utf8))
}

// 1. Accessory activation policy — required for TCC to render the dialog
//    from a launchd-spawned process. A pure background tool can't show UI.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// 2. Request mic + camera access (or skip what we already have).
//    Mic is for the RØDECaster Pro II multitrack capture; camera is for the
//    AV.io 4K capture card relaying the Pearl's HDMI 1 program output.
//    Both run inside the same Python daemon downstream so they share this
//    bundle's TCC identity (com.dts.studio-daw-sidecar). On a first-time
//    install the user clicks Allow twice; subsequent launches skip both.
func requestAccess(for mediaType: AVMediaType, label: String) {
    let status = AVCaptureDevice.authorizationStatus(for: mediaType)
    log("\(label) auth status on entry: \(status.rawValue)")
    if status == .authorized {
        log("\(label) already granted — skipping prompt")
        return
    }
    if status == .denied || status == .restricted {
        log("\(label) access \(status == .denied ? "denied" : "restricted") — capture path will fail until re-granted in System Settings")
        return
    }
    log("requesting \(label) access — dialog should appear")
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: mediaType) { ok in
        granted = ok
        sem.signal()
    }
    let deadline = Date().addingTimeInterval(120)
    while sem.wait(timeout: .now() + .milliseconds(50)) == .timedOut {
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        if Date() > deadline {
            log("\(label) access request timed out after 120s")
            break
        }
    }
    log("\(label) access result: \(granted ? "granted" : "denied")")
}

requestAccess(for: .audio, label: "mic")
requestAccess(for: .video, label: "camera")

// 3. exec the Python wrapper. It lives in Contents/Resources/ so it isn't
//    mistaken for a second main binary.
guard let bundlePath = Bundle.main.bundlePath as String? else {
    log("FATAL: could not resolve bundle path")
    exit(2)
}
let wrapper = "\(bundlePath)/Contents/Resources/run.sh"
guard FileManager.default.isExecutableFile(atPath: wrapper) else {
    log("FATAL: wrapper not found or not executable at \(wrapper)")
    exit(2)
}

log("exec \(wrapper)")
let argv: [String] = [wrapper]
let cArgs: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) } + [nil]
execv(wrapper, cArgs)

// execv only returns on failure.
log("FATAL: execv failed: \(String(cString: strerror(errno)))")
exit(2)
