// Bee call audio helper for macOS. Hears everything this Mac plays (all system audio, as Cluely does) except Bee itself, and
// writes it to stdout as raw 16 kHz mono signed 16-bit little-endian PCM. Protocol: native/teams-audio/README.md.
//
// How: ScreenCaptureKit with an SCContentFilter on the main display that excludes only Bee (app.bee.desktop and its helper
// apps), audio on, excludesCurrentProcessAudio. Audio in ScreenCaptureKit is system-wide: every app's sound is heard, whichever
// display shows it. ScreenCaptureKit needs a video stream as well: it is 2 × 2 pixels at one frame a second, and every frame is
// dropped unread.
//
// Floor: macOS 13 (ScreenCaptureKit audio). Permission: Screen Recording ("Screen & System Audio Recording" on macOS 15),
// granted to Bee, which starts this helper. The helper never prompts unless run with --request-permission.
//
// stderr carries status codes only (`status=<code>`, maybe ` err=<n>`): never audio, names or titles. Exit codes: 0 clean
// stop, 2 usage, 3 unsupported, 4 denied, 6 failed (5, "no-teams", is not used since protocol 3: there is no target app).

import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

let protocolVersion = 3
let exitOk: Int32 = 0
let exitUsage: Int32 = 2
let exitUnsupported: Int32 = 3
let exitDenied: Int32 = 4
let exitNoTeams: Int32 = 5
let exitFailed: Int32 = 6

let sampleRate = 16_000
let beeBundleId = "app.bee.desktop"

func status(_ code: String, _ extra: String? = nil) {
    var line = "status=\(code)"
    if let extra = extra { line += " \(extra)" }
    line += "\n"
    _ = line.withCString { pointer in write(STDERR_FILENO, pointer, strlen(pointer)) }
}

func finish(_ code: String, _ exitCode: Int32, _ extra: String? = nil) -> Never {
    status(code, extra)
    exit(exitCode)
}

func writeAll(_ pointer: UnsafeRawPointer, _ count: Int) -> Bool {
    var offset = 0
    while offset < count {
        let written = write(STDOUT_FILENO, pointer + offset, count - offset)
        if written < 0 {
            if errno == EINTR { continue }
            return false
        }
        offset += written
    }
    return true
}

/** Whether a bundle id is Bee or one of Bee's helper apps ("app.bee.desktop.…"). */
func isBee(_ bundleId: String) -> Bool {
    let id = bundleId.lowercased()
    return id == beeBundleId || id.hasPrefix(beeBundleId + ".")
}

func usage(_ error: Bool) {
    let text = """
    Usage: teams-audio-helper [--request-permission] [--protocol] [--version] [--help]
    Writes everything this Mac plays except Bee (all system audio) to stdout as raw 16 kHz mono s16le PCM. Status codes go
    to stderr.

    """
    _ = text.withCString { pointer in write(error ? STDERR_FILENO : STDOUT_FILENO, pointer, strlen(pointer)) }
}

// --protocol: the protocol constants as one JSON object, so CI can compare them with core/teams-audio-protocol.ts.
// Never opens audio. The capture fields describe the filter below: every app except Bee.
func printProtocol() {
    // One += per part: a long chain of + is slow for the Swift type checker.
    var json = "{\"protocol\":\(protocolVersion),\"sampleRate\":\(sampleRate),"
    json += "\"exit\":{\"ok\":\(exitOk),\"usage\":\(exitUsage),\"unsupported\":\(exitUnsupported),"
    json += "\"denied\":\(exitDenied),\"noTeams\":\(exitNoTeams),\"failed\":\(exitFailed)},"
    json += "\"beeBundleId\":\"\(beeBundleId)\","
    json += "\"capture\":{\"source\":\"system\",\"contentFilter\":\"excluding-bee\"}}\n"
    _ = json.withCString { pointer in write(STDOUT_FILENO, pointer, strlen(pointer)) }
}

// ---- Arguments ----

var requestPermission = false
var arguments = CommandLine.arguments.dropFirst().makeIterator()
while let argument = arguments.next() {
    switch argument {
    case "--version":
        print("teams-audio-helper protocol=\(protocolVersion)")
        exit(exitOk)
    case "--protocol":
        printProtocol()
        exit(exitOk)
    case "--help":
        usage(false)
        exit(exitOk)
    case "--request-permission":
        requestPermission = true
    default:
        usage(true)
        exit(exitUsage)
    }
}

signal(SIGPIPE, SIG_IGN)

guard ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 13, minorVersion: 0, patchVersion: 0)) else {
    finish("unsupported", exitUnsupported)
}

// ---- Permission ----

if requestPermission {
    // macOS shows its own prompt once and lists Bee under Screen Recording; later calls only report the state.
    if CGPreflightScreenCaptureAccess() { finish("granted", exitOk) }
    if CGRequestScreenCaptureAccess() { finish("granted", exitOk) }
    finish("denied", exitDenied)
}
// Never prompts during a call: Settings has the button that asks.
guard CGPreflightScreenCaptureAccess() else { finish("denied", exitDenied) }

// ---- Capture ----

func failure(_ error: Error) -> Never {
    let code = (error as NSError).code
    if let streamError = error as? SCStreamError, streamError.code == .userDeclined {
        finish("denied", exitDenied, "err=\(code)")
    }
    finish("failed", exitFailed, "err=\(code)")
}

/** Bee's own apps, which the filter leaves out. */
func beeApps(_ content: SCShareableContent) -> [SCRunningApplication] {
    content.applications.filter { isBee($0.bundleIdentifier) || $0.processID == getpid() }
}

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let audioQueue = DispatchQueue(label: "app.bee.teams-audio.audio")
    private let videoQueue = DispatchQueue(label: "app.bee.teams-audio.video")
    private let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(sampleRate), channels: 1, interleaved: true)!
    // Touched on the main queue only.
    private var stream: SCStream?
    private var stopping = false
    // Touched on the audio queue only.
    private var converter: AVAudioConverter?
    private var converterInput: AVAudioFormat?

    func start() {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
            DispatchQueue.main.async {
                if let error = error { failure(error) }
                guard let content = content else { finish("failed", exitFailed, "content=0") }
                guard let display = content.displays.first else { finish("failed", exitFailed, "display=0") }
                self.open(display: display, excluding: beeApps(content))
            }
        }
    }

    private func configuration() -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = sampleRate
        configuration.channelCount = 1
        // Required by the API, never read: the smallest, slowest video ScreenCaptureKit allows.
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        configuration.showsCursor = false
        return configuration
    }

    private func open(display: SCDisplay, excluding bee: [SCRunningApplication]) {
        // Every app but Bee: ScreenCaptureKit captures the audio of every app the filter does not exclude.
        let filter = SCContentFilter(display: display, excludingApplications: bee, exceptingWindows: [])
        let stream = SCStream(filter: filter, configuration: configuration(), delegate: self)
        do {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: videoQueue)
        } catch {
            failure(error)
        }
        self.stream = stream
        stream.startCapture { error in
            DispatchQueue.main.async {
                if let error = error { failure(error) }
                status("ready")
            }
        }
    }

    func stop(code: String = "stopped", exitCode: Int32 = exitOk) {
        if stopping { return }
        stopping = true
        guard let stream = stream else { finish(code, exitCode) }
        // Exit even if stopCapture never calls back.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { finish(code, exitCode) }
        stream.stopCapture { _ in
            DispatchQueue.main.async { finish(code, exitCode) }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async {
            if self.stopping { return }
            failure(error)
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        // Video frames are dropped here, unread.
        guard type == .audio, sampleBuffer.isValid, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
        let inputFormat = AVAudioFormat(cmAudioFormatDescription: description)
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frames > 0, let input = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: frames) else { return }
        input.frameLength = frames
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(frames), into: input.mutableAudioBufferList) == noErr else { return }
        convert(input)
    }

    /** Any ScreenCaptureKit format → 16 kHz mono s16le on stdout. */
    private func convert(_ input: AVAudioPCMBuffer) {
        if converter == nil || converterInput != input.format {
            converter = AVAudioConverter(from: input.format, to: output)
            converterInput = input.format
        }
        guard let converter = converter else { return }
        let ratio = output.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount((Double(input.frameLength) * ratio).rounded(.up)) + 64
        guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        let result = converter.convert(to: converted, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return input
        }
        guard result != .error, converted.frameLength > 0, let channels = converted.int16ChannelData else { return }
        if !writeAll(channels[0], Int(converted.frameLength) * MemoryLayout<Int16>.size) {
            // Bee stopped reading: a clean stop.
            DispatchQueue.main.async { self.stop() }
        }
    }
}

let capture = Capture()

// Bee closes stdin to stop the helper; if Bee dies, it closes the same way. Watched only when stdin is a pipe or a socket
// (Node gives a child a socket pair), not a terminal. S_IFMT 0o170000, S_IFIFO 0o010000, S_IFSOCK 0o140000 (sys/stat.h), as
// plain integers so the check does not depend on how the SDK imports them.
var stdinInfo = stat()
let stdinKind = fstat(STDIN_FILENO, &stdinInfo) == 0 ? Int(stdinInfo.st_mode) & 0o170000 : 0
if stdinKind == 0o010000 || stdinKind == 0o140000 {
    Thread.detachNewThread {
        var buffer = [UInt8](repeating: 0, count: 256)
        while read(STDIN_FILENO, &buffer, buffer.count) > 0 {}
        DispatchQueue.main.async { capture.stop() }
    }
}

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let signalSources = [SIGTERM, SIGINT].map { number -> DispatchSourceSignal in
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler { capture.stop() }
    source.resume()
    return source
}

capture.start()
dispatchMain()
