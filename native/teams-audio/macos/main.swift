// Bee call audio helper for macOS. Hears one call app alone (Teams by default; Zoom or a browser running Google Meet when Bee
// names it with --bundle-id), never all system audio and never the screen, and writes it to stdout as raw 16 kHz mono signed
// 16-bit little-endian PCM. Protocol: native/teams-audio/README.md.
//
// How: ScreenCaptureKit with an SCContentFilter that includes only the target apps (by default new Teams com.microsoft.teams2,
// classic com.microsoft.teams, and their helper apps "<id>.…"), audio on. --bundle-id accepts call apps only (targetBundleIds):
// never a music or video app. ScreenCaptureKit needs a video stream as well: it is 2 × 2 pixels at one frame a second, and
// every frame is dropped unread. Bee (app.bee.desktop) is never included.
//
// Floor: macOS 13 (ScreenCaptureKit audio). Permission: Screen Recording ("Screen & System Audio Recording" on macOS 15),
// granted to Bee, which starts this helper. The helper never prompts unless run with --request-permission.
//
// stderr carries status codes only (`status=<code>`, maybe ` err=<n>`): never audio, names or titles. Exit codes: 0 clean
// stop, 2 usage, 3 unsupported, 4 denied, 5 target app not running ("no-teams", the code's old name), 6 failed.

import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

let protocolVersion = 2
let exitOk: Int32 = 0
let exitUsage: Int32 = 2
let exitUnsupported: Int32 = 3
let exitDenied: Int32 = 4
let exitNoTeams: Int32 = 5
let exitFailed: Int32 = 6

let sampleRate = 16_000
// Teams desktop apps by bundle id: the default target. Their helper apps ("com.microsoft.teams2.helper") are Teams too.
let teamsBundleIds = ["com.microsoft.teams2", "com.microsoft.teams"]
// Every bundle id --bundle-id accepts: Teams, Zoom and the browsers that may run a Google Meet call (Safari is not one: WebKit
// plays sound from shared system processes). Same list and order as src/core/teams-audio-protocol.ts CALL_AUDIO_MAC_BUNDLE_IDS
// (CI compares --protocol).
let targetBundleIds = teamsBundleIds + [
    "us.zoom.xos", "com.google.chrome", "org.chromium.chromium", "com.microsoft.edgemac", "com.brave.browser",
    "company.thebrowser.browser", "org.mozilla.firefox", "com.vivaldi.vivaldi", "com.operasoftware.opera",
]
let beeBundleId = "app.bee.desktop"
// How often the helper checks the target is still running and follows its apps that started or quit.
let watchSeconds = 5.0

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

/** Whether a bundle id is one of these apps or one of their helper apps ("<id>.…"). Never Bee. */
func matches(_ bundleId: String, _ allowed: [String]) -> Bool {
    let id = bundleId.lowercased()
    if id == beeBundleId || id.hasPrefix(beeBundleId + ".") { return false }
    return allowed.contains { id == $0 || id.hasPrefix($0 + ".") }
}

func usage(_ error: Bool) {
    let text = """
    Usage: teams-audio-helper [--bundle-id <call app bundle id>]… [--pid <process id>] [--request-permission] [--protocol] [--version] [--help]
    Writes one call app's audio alone (Microsoft Teams unless --bundle-id names Zoom or a browser) to stdout as raw 16 kHz
    mono s16le PCM. Status codes go to stderr.

    """
    _ = text.withCString { pointer in write(error ? STDERR_FILENO : STDOUT_FILENO, pointer, strlen(pointer)) }
}

// --protocol: the protocol constants as one JSON object, so CI can compare them with core/teams-audio-protocol.ts.
// Never opens audio. The capture fields describe the filter below: the target apps only (including), Bee never captured.
func printProtocol() {
    func quoted(_ list: [String]) -> String { list.map { "\"\($0)\"" }.joined(separator: ",") }
    // One += per part: a long chain of + is slow for the Swift type checker.
    var json = "{\"protocol\":\(protocolVersion),\"sampleRate\":\(sampleRate),"
    json += "\"exit\":{\"ok\":\(exitOk),\"usage\":\(exitUsage),\"unsupported\":\(exitUnsupported),"
    json += "\"denied\":\(exitDenied),\"noTeams\":\(exitNoTeams),\"failed\":\(exitFailed)},"
    json += "\"teamsBundleIds\":[\(quoted(teamsBundleIds))],\"targetBundleIds\":[\(quoted(targetBundleIds))],"
    json += "\"beeBundleId\":\"\(beeBundleId)\","
    json += "\"capture\":{\"contentFilter\":\"including-apps\",\"excludesBee\":\(!matches(beeBundleId, targetBundleIds))}}\n"
    _ = json.withCString { pointer in write(STDOUT_FILENO, pointer, strlen(pointer)) }
}

// ---- Arguments ----

var bundleIds: [String] = []
var requestedPid: pid_t? = nil
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
    case "--bundle-id":
        // Call apps only: an id outside targetBundleIds is a usage error, so Bee can never point the helper elsewhere.
        guard let id = arguments.next(), matches(id, targetBundleIds) else {
            usage(true)
            exit(exitUsage)
        }
        bundleIds.append(id.lowercased())
    case "--pid":
        guard let value = arguments.next(), let pid = pid_t(value) else {
            usage(true)
            exit(exitUsage)
        }
        requestedPid = pid
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

/** The apps to hear: by bundle id (Bee's, or every Teams id), and by process id if Bee named one. */
func targetApps(_ content: SCShareableContent) -> [SCRunningApplication] {
    let wanted = bundleIds.isEmpty ? teamsBundleIds : bundleIds
    return content.applications.filter { app in
        let id = app.bundleIdentifier.lowercased()
        guard matches(id, wanted), app.processID != getpid() else { return false }
        // A process id from Bee narrows it to that app; its helper apps stay in.
        if let pid = requestedPid, app.processID != pid, !wanted.contains(where: { id.hasPrefix($0 + ".") }) { return false }
        return true
    }
}

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let audioQueue = DispatchQueue(label: "app.bee.teams-audio.audio")
    private let videoQueue = DispatchQueue(label: "app.bee.teams-audio.video")
    private let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(sampleRate), channels: 1, interleaved: true)!
    // Touched on the main queue only.
    private var stream: SCStream?
    private var included: Set<pid_t> = []
    private var stopping = false
    // Touched on the audio queue only.
    private var converter: AVAudioConverter?
    private var converterInput: AVAudioFormat?

    func start() {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
            DispatchQueue.main.async {
                if let error = error { failure(error) }
                guard let content = content else { finish("failed", exitFailed, "content=0") }
                let apps = targetApps(content)
                if apps.isEmpty { finish("no-teams", exitNoTeams) }
                guard let display = content.displays.first else { finish("failed", exitFailed, "display=0") }
                self.open(display: display, apps: apps)
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

    private func open(display: SCDisplay, apps: [SCRunningApplication]) {
        // Only the target apps: ScreenCaptureKit captures the audio of the apps a filter includes, and nothing else.
        let filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
        let stream = SCStream(filter: filter, configuration: configuration(), delegate: self)
        do {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: videoQueue)
        } catch {
            failure(error)
        }
        self.stream = stream
        included = Set(apps.map { $0.processID })
        stream.startCapture { error in
            DispatchQueue.main.async {
                if let error = error { failure(error) }
                status("ready")
                self.watch(display: display)
            }
        }
    }

    /** Every few seconds: stop if the target quit; follow its helper apps that started or quit. */
    private func watch(display: SCDisplay) {
        DispatchQueue.main.asyncAfter(deadline: .now() + watchSeconds) {
            if self.stopping { return }
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, _ in
                DispatchQueue.main.async {
                    guard !self.stopping, let content = content else {
                        self.watch(display: display)
                        return
                    }
                    let apps = targetApps(content)
                    if apps.isEmpty {
                        self.stop(code: "no-teams", exitCode: exitNoTeams)
                        return
                    }
                    let pids = Set(apps.map { $0.processID })
                    if pids != self.included, let stream = self.stream {
                        self.included = pids
                        let target = content.displays.first(where: { $0.displayID == display.displayID }) ?? content.displays.first ?? display
                        stream.updateContentFilter(SCContentFilter(display: target, including: apps, exceptingWindows: [])) { _ in }
                    }
                    self.watch(display: display)
                }
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
