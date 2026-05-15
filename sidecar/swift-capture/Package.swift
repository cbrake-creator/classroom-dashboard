// swift-tools-version:5.9
//
// avio-capture: Swift-native AV.io 4K capture binary.
//
// Replaces ffmpeg's "-f avfoundation" input stage with a direct AVCaptureSession,
// which lets us explicitly select AVCaptureDevice.activeFormat (instead of relying
// on AVFoundation's auto-pick that occasionally lands on a slow USB mode).
//
// Step 2 scope (this file's commit): scaffolding + device-enumeration stub.
// Later steps add VideoToolbox H.264 encoding and an stdout NAL pipeline that
// ffmpeg's RTSP muxer can consume.
//
// Build:   swift build -c release
// Binary:  .build/release/avio-capture
// List:    .build/release/avio-capture --list-devices
//
import PackageDescription

let package = Package(
    name: "AvioCapture",
    platforms: [
        // macOS 14+ for the modern AVCaptureDevice.DeviceType.external constant.
        // Older host's .externalUnknown still works on 14+ but is deprecated.
        .macOS(.v14),
    ],
    products: [
        .executable(name: "avio-capture", targets: ["AvioCapture"]),
    ],
    targets: [
        .executableTarget(
            name: "AvioCapture",
            path: "Sources/AvioCapture",
            linkerSettings: [
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("VideoToolbox"),
            ]
        ),
    ]
)
