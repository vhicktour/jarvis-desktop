import AppKit
import AVFoundation
import ApplicationServices
import EventKit
import ScreenCaptureKit
import Darwin
import CoreAudio

let outputLock = NSLock()
func send(_ value: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), data.count < 1_048_576 else { return }
    outputLock.lock(); defer { outputLock.unlock() }
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
func event(_ name: String, _ value: [String: Any]) { send(["version": 1, "method": name, "params": value]) }
enum NativeError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
func fail(_ text: String) -> NativeError { .message(text) }
func outputRoute() -> String {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var device: AudioDeviceID = 0; var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr else { return "Unavailable" }
    address.mSelector = kAudioObjectPropertyName
    var name: Unmanaged<CFString>?; size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &name) == noErr, let name else { return "Unknown output" }
    return name.takeRetainedValue() as String
}
func axValue(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?; guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }; return value
}
func axString(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = axValue(element, name) as? String, !value.isEmpty else { return nil }
    return value
}
func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    (axValue(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}
func axActions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return (names as? [String]) ?? []
}
func axFrame(_ element: AXUIElement) -> CGRect? {
    guard let position = axValue(element, kAXPositionAttribute), let size = axValue(element, kAXSizeAttribute) else { return nil }
    var origin = CGPoint.zero; var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &origin), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
    return CGRect(origin: origin, size: dimensions)
}
/** The label a person would read on the control, in the order Accessibility offers it. */
func axLabel(_ element: AXUIElement) -> String {
    axString(element, kAXTitleAttribute as String)
        ?? axString(element, kAXDescriptionAttribute as String)
        ?? axString(element, kAXValueAttribute as String)
        ?? ""
}
/** Only controls that actually declare a press are listed; a role allowlist would over-promise. */
func axDescribe(_ element: AXUIElement, path: [Int], depth: Int, into found: inout [[String: Any]], limit: Int) {
    if found.count >= limit || depth > 12 { return }
    let role = axString(element, kAXRoleAttribute as String) ?? ""
    // A closed menu's items report an empty frame and would fill the budget with things that
    // are not on screen. What cannot be seen cannot be pointed at, so neither is listed.
    if role == (kAXMenuRole as String) { return }
    let label = axLabel(element)
    let frame = axFrame(element) ?? .zero
    if !label.isEmpty, frame.width >= 1, frame.height >= 1, axActions(element).contains(kAXPressAction as String) {
        found.append([
            "path": path, "role": role, "label": String(label.prefix(200)),
            "enabled": (axValue(element, kAXEnabledAttribute as String) as? Bool) ?? true,
            "x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height,
        ])
    }
    let children = axChildren(element).enumerated().map { (index: $0.offset, element: $0.element) }
    let ordered = depth == 0
        ? children.filter { axString($0.element, kAXRoleAttribute as String) == (kAXWindowRole as String) }
            + children.filter { axString($0.element, kAXRoleAttribute as String) != (kAXWindowRole as String) }
        : children
    for child in ordered {
        axDescribe(child.element, path: path + [child.index], depth: depth + 1, into: &found, limit: limit)
    }
}

final class AudioHistory {
    private let lock = NSLock()
    private var samples: [Float]
    private var cursor = 0
    private var count = 0
    let sampleRate: Double
    init(sampleRate: Double) { self.sampleRate = sampleRate; samples = Array(repeating: 0, count: Int(sampleRate * 8)) }
    func append(_ buffer: AVAudioPCMBuffer) {
        guard let input = buffer.floatChannelData?[0] else { return }
        lock.lock(); defer { lock.unlock() }
        for i in 0..<Int(buffer.frameLength) { samples[cursor] = input[i]; cursor = (cursor + 1) % samples.count; count = min(count + 1, samples.count) }
    }
    func snapshot() -> [Float] {
        lock.lock(); defer { lock.unlock() }
        return (0..<count).map { samples[(cursor - count + $0 + samples.count) % samples.count] }
    }
}

@MainActor final class Companion: NSObject, @preconcurrency AVAudioPlayerDelegate, @preconcurrency AVSpeechSynthesizerDelegate {
    let audio = AVAudioEngine()
    let speech = AVSpeechSynthesizer()
    var speechGenerations: [ObjectIdentifier: Int] = [:]
    var playbackGenerations: [ObjectIdentifier: Int] = [:]
    let events = EKEventStore()
    var recording: AVAudioFile?
    var recordPath: URL?
    var player: AVAudioPlayer?
    // Sentences of one reply, waiting their turn. A reply spoken in pieces is still one utterance,
    // so it keeps one generation and reports finishing once, when the last piece has played.
    var playbackQueue: [URL] = []
    /**
     * While the microphone is open, replies play through the engine's own output, because that is
     * the signal Apple's echo cancellation subtracts. A player outside the engine reaches the
     * speaker by a route the canceller never sees, and the open microphone would hear the reply as
     * somebody talking.
     */
    let playerNode = AVAudioPlayerNode()
    var playerAttached = false
    var playerFormat: AVAudioFormat?
    var nodeSession = 0
    /** Pieces scheduled on the player node that have not finished playing. */
    var nodePending = 0
    var nodeDurations: [Double] = []
    /** The engine was asked to stop while a reply was still playing through it. */
    var stopEngineWhenIdle = false
    /** Whether Apple's echo cancellation is actually on, which is not the same as having asked. */
    var voiceProcessing = false
    /** Listening with nowhere to write: the rolling history only, so nothing reaches disk. */
    var listening = false
    var playbackMeter: Timer?
    var audioHistory: AudioHistory?
    var captureGeneration = 0
    var captureRate: Double = 16000
    var generation = 0
    var streamGeneration: Int?
    var completionReported = true
    var playbackEpoch = 0
    var playedSeconds: Double = 0
    var pieceStartedAt: Date?
    var pieceDuration: Double = 0
    let ephemeral: URL
    override init() {
        let supplied = CommandLine.arguments.dropFirst().first ?? NSTemporaryDirectory() + "jarvis-native"
        ephemeral = URL(fileURLWithPath: supplied).resolvingSymlinksInPath().appendingPathComponent("ephemeral", isDirectory: true)
        super.init()
        try? FileManager.default.createDirectory(at: ephemeral, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        speech.delegate = self
    }
    func permissions() -> [String: Any] {
        let microphone: String
        switch AVCaptureDevice.authorizationStatus(for: .audio) { case .authorized: microphone = "granted"; case .denied: microphone = "denied"; case .restricted: microphone = "restricted"; default: microphone = "not-determined" }
        return ["microphone": microphone, "screen": CGPreflightScreenCaptureAccess() ? "granted" : "not-determined", "accessibility": AXIsProcessTrusted(), "calendars": String(describing: EKEventStore.authorizationStatus(for: .event)), "reminders": String(describing: EKEventStore.authorizationStatus(for: .reminder))]
    }
    func isOwn(_ window: SCWindow) -> Bool {
        window.owningApplication?.bundleIdentifier == "personal.jarvis.desktop" || window.owningApplication?.processID == ProcessInfo.processInfo.processIdentifier || window.owningApplication?.applicationName == "Electron"
    }
    func windows() async throws -> [SCWindow] {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        return content.windows.filter { !isOwn($0) && $0.frame.width > 80 && $0.frame.height > 50 && !($0.title ?? "").isEmpty }
    }
    func writeCapture(_ image: CGImage) throws -> URL {
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.65]) else { throw fail("Could not encode the capture.") }
        let path = ephemeral.appendingPathComponent(UUID().uuidString + ".jpg")
        try data.write(to: path, options: [.atomic])
        return path
    }
    func execute(_ method: String, _ p: [String: Any]) async throws -> Any {
        switch method {
        case "ping": return ["version": 1, "permissions": permissions(), "voiceProcessing": voiceProcessing, "playbackCancelled": playerAttached, "listening": listening, "reduceMotion": NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, "reduceTransparency": NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency]
        case "permissions": return permissions()
        case "permission.request":
            switch p["permission"] as? String {
            case "microphone": _ = await AVCaptureDevice.requestAccess(for: .audio)
            case "screen": _ = CGRequestScreenCaptureAccess()
            case "accessibility": _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            case "calendars": _ = try await events.requestFullAccessToEvents()
            case "reminders": _ = try await events.requestFullAccessToReminders()
            default: throw fail("Unknown permission.")
            }; return permissions()
        case "audio.start":
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { throw fail("Allow microphone access in Settings first.") }
            if audio.isRunning && recording != nil { return true }
            // Already listening: take the tap over and start the file without stopping the engine,
            // so a turn that begins on a wake word does not lose the words already in the air.
            let takeover = listening
            let history = takeover ? audioHistory?.snapshot() ?? [] : []
            let seconds = min(3, max(0, p["preRollSeconds"] as? Double ?? 1))
            let carried = Array(history.suffix(Int((audioHistory?.sampleRate ?? 16000) * seconds)))
            captureGeneration = p["generation"] as? Int ?? captureGeneration + 1
            captureRate = 16000
            let path = ephemeral.appendingPathComponent(UUID().uuidString + ".wav")
            let started = try openTap(writeTo: path, preRoll: carried)
            recordPath = path
            listening = false
            return ["sampleRate": started.sampleRate, "generation": captureGeneration, "voiceProcessing": voiceProcessing, "playbackCancelled": playerAttached, "preRoll": started.preRoll]
        case "listen.start":
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { throw fail("Allow microphone access in Settings first.") }
            let requestedRate = p["sampleRate"] as? Double ?? 16000
            guard [16000.0, 24000.0].contains(requestedRate) else { throw fail("Unsupported microphone sample rate.") }
            if audio.isRunning && listening && captureRate == requestedRate { return ["sampleRate": captureRate, "generation": captureGeneration, "voiceProcessing": voiceProcessing, "playbackCancelled": playerAttached] }
            guard recording == nil else { throw fail("A recording is already in progress.") }
            let carrySeconds = min(8, max(0, p["preRollSeconds"] as? Double ?? 0))
            let carried = try historyPCM(seconds: carrySeconds, rate: requestedRate)
            captureGeneration = p["generation"] as? Int ?? captureGeneration + 1
            captureRate = requestedRate
            _ = try openTap(writeTo: nil, preRoll: [])
            listening = true
            return ["sampleRate": captureRate, "generation": captureGeneration, "voiceProcessing": voiceProcessing, "playbackCancelled": playerAttached, "preRollPCM": carried]
        case "listen.stop":
            // Safe when nothing is listening: a caller should not have to track that for us.
            if listening && (p["generation"] == nil || p["generation"] as? Int == captureGeneration) {
                stopEngine()
                audioHistory = nil
                listening = false
            }
            return true
        case "audio.preview":
            guard audio.isRunning, let history = audioHistory else { throw fail("No active recording.") }
            let seconds = min(8, max(0.1, p["seconds"] as? Double ?? 8))
            let samples = Array(history.snapshot().suffix(Int(history.sampleRate * seconds)))
            guard !samples.isEmpty, let format = AVAudioFormat(standardFormatWithSampleRate: history.sampleRate, channels: 1), let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else { throw fail("Audio preview is not ready.") }
            buffer.frameLength = AVAudioFrameCount(samples.count)
            samples.withUnsafeBufferPointer { source in buffer.floatChannelData![0].update(from: source.baseAddress!, count: samples.count) }
            let path = ephemeral.appendingPathComponent(UUID().uuidString + ".wav")
            let preview = try AVAudioFile(forWriting: path, settings: format.settings)
            try preview.write(from: buffer)
            return ["path": path.path, "generation": captureGeneration]
        case "audio.stop":
            stopEngine()
            listening = false
            recording = nil
            audioHistory = nil
            guard let path = recordPath else { return ["path": NSNull()] }
            recordPath = nil; return ["path": path.path, "generation": captureGeneration]
        case "audio.discard":
            stopEngine(); listening = false; recording = nil; audioHistory = nil
            if let path = recordPath { try? FileManager.default.removeItem(at: path) }; recordPath = nil; return true
        case "speech.stop":
            let heard = playedSeconds + min(pieceDuration, pieceStartedAt.map { Date().timeIntervalSince($0) } ?? 0)
            generation = p["generation"] as? Int ?? generation + 1
            streamGeneration = nil; completionReported = true
            playbackMeter?.invalidate(); playbackMeter = nil; player?.stop(); player = nil; playbackQueue.removeAll(); playbackGenerations.removeAll(); speech.stopSpeaking(at: .immediate)
            stopNodePlayback()
            return ["playing": false, "generation": generation, "playedMs": Int(heard * 1000)]
        case "speech.begin":
            generation = p["generation"] as? Int ?? generation + 1
            streamGeneration = generation; completionReported = false
            playedSeconds = 0; pieceStartedAt = nil; pieceDuration = 0
            return ["generation": generation]
        case "speech.end":
            guard p["generation"] as? Int == generation else { return false }
            streamGeneration = nil
            finishPlayback(generation)
            return true
        case "speech.status": return ["playing": player?.isPlaying ?? false || nodePending > 0, "speaking": speech.isSpeaking, "generation": generation, "outputRoute": outputRoute()]
        case "speech.system":
            let text = p["text"] as? String ?? ""; guard text.count <= 12_000 else { throw fail("Speech is too long.") }
            speech.stopSpeaking(at: .immediate); generation = p["generation"] as? Int ?? generation + 1
            streamGeneration = nil; completionReported = false
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = AVSpeechSynthesisVoice.speechVoices().first { $0.language == "en-GB" && $0.gender == .male } ?? AVSpeechSynthesisVoice(language: "en-GB")
            utterance.rate = Float((p["speed"] as? Double ?? 1) * 0.48)
            speechGenerations[ObjectIdentifier(utterance)] = generation
            speech.speak(utterance); return true
        case "speech.play":
            let url = try playableURL(p["path"] as? String ?? "")
            playbackMeter?.invalidate(); player?.stop(); playbackQueue.removeAll(); playbackGenerations.removeAll(); speech.stopSpeaking(at: .immediate); stopNodePlayback(); generation = p["generation"] as? Int ?? generation + 1
            streamGeneration = nil; completionReported = false
            playedSeconds = 0; pieceStartedAt = nil; pieceDuration = 0
            try startPlayback(url, session: generation)
            return true
        case "speech.enqueue":
            // A reply spoken sentence by sentence: the pieces follow one another without a gap,
            // and the whole reply reports finishing once, when the last of them has played.
            let url = try playableURL(p["path"] as? String ?? "")
            let session = p["generation"] as? Int ?? generation
            guard session == generation else { return ["queued": false, "generation": generation] }
            if nodePending > 0 && nodeSession == session {
                // The node plays scheduled pieces back to back on its own.
                try playThroughEngine(url, session: session)
            } else if player?.isPlaying == true {
                playbackQueue.append(url)
            } else {
                try startPlayback(url, session: session)
            }
            return ["queued": true, "generation": generation]
        case "speech.chunk":
            guard let session = p["generation"] as? Int, session == generation, streamGeneration == session else { return ["queued": false] }
            guard let encoded = p["pcm"] as? String, let data = Data(base64Encoded: encoded), !data.isEmpty, data.count <= 24000 * 2 * 2, data.count % 2 == 0,
                  let format = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1),
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(data.count / 2)) else { throw fail("Invalid speech audio chunk.") }
            guard audio.isRunning && playerAttached else { throw fail("Open the audio engine before streaming speech.") }
            buffer.frameLength = buffer.frameCapacity
            data.withUnsafeBytes { raw in
                for index in 0..<Int(buffer.frameLength) {
                    buffer.floatChannelData![0][index] = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))) / 32768
                }
            }
            if playerFormat?.isEqual(format) != true {
                audio.connect(playerNode, to: audio.mainMixerNode, format: format); playerFormat = format
            }
            schedulePiece(session, duration: Double(buffer.frameLength) / 24000) { completion in
                self.playerNode.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack, completionHandler: completion)
            }
            return ["queued": true]
        case "file.create":
            guard let root = p["root"] as? String, let relative = p["relativePath"] as? String, let text = p["content"] as? String, text.utf8.count <= 100_000 else { throw fail("Invalid bounded file proposal.") }
            let parts = relative.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            guard !relative.hasPrefix("/"), !parts.isEmpty, parts.allSatisfy({ !$0.isEmpty && ![".", "..", ".git", ".env", ".ssh", ".codex"].contains($0) }) else { throw fail("The proposed file path is outside scope.") }
            var directory = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
            guard directory >= 0 else { throw fail("The selected repository is unavailable or has become a symbolic link.") }
            defer { close(directory) }
            for component in parts.dropLast() {
                if mkdirat(directory, component, 0o700) != 0 && errno != EEXIST { throw fail("The file's parent directory could not be created.") }
                let next = openat(directory, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
                guard next >= 0 else { throw fail("The file tool cannot follow symbolic links.") }
                close(directory); directory = next
            }
            let fd = openat(directory, parts.last!, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
            guard fd >= 0 else { throw fail("The file already exists or cannot be created. Nothing was overwritten.") }
            defer { close(fd) }
            let data = Data(text.utf8)
            try data.withUnsafeBytes { raw in
                var offset = 0
                while offset < data.count {
                    let count = write(fd, raw.baseAddress!.advanced(by: offset), data.count - offset)
                    if count < 0 { if errno == EINTR { continue }; throw fail("The file write was interrupted. Inspect the result before retrying.") }
                    offset += count
                }
            }
            guard fsync(fd) == 0 else { throw fail("The file could not be flushed to disk.") }
            return ["path": root + "/" + relative, "bytes": data.count]
        case "context.windows": return try await windows().map { ["id": Int($0.windowID), "app": $0.owningApplication?.applicationName ?? "Application", "title": $0.title ?? "Window", "bundleId": $0.owningApplication?.bundleIdentifier ?? ""] }
        case "context.capture":
            let id = p["windowId"] as? Int ?? 0
            guard let window = try await windows().first(where: { Int($0.windowID) == id }) else { throw fail("The selected window is no longer available.") }
            let excluded = p["excludedApps"] as? [String] ?? []
            guard !excluded.contains(window.owningApplication?.bundleIdentifier ?? "") else { throw fail("This application is excluded from shared attention.") }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let configuration = SCStreamConfiguration(); let scale = min(1, 1280 / window.frame.width)
            configuration.width = Int(window.frame.width * scale); configuration.height = Int(window.frame.height * scale); configuration.showsCursor = false; configuration.ignoreShadowsSingleWindow = true
            let path = try writeCapture(try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration))
            return ["windowId": id, "app": window.owningApplication?.applicationName ?? "Application", "title": window.title ?? "Window", "width": configuration.width, "height": configuration.height, "imagePath": path.path]
        case "context.displays":
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            return content.displays.map { ["id": Int($0.displayID), "x": $0.frame.minX, "y": $0.frame.minY, "width": $0.frame.width, "height": $0.frame.height] }
        case "context.region":
            guard let width = p["width"] as? Double, let height = p["height"] as? Double, width >= 16, height >= 16 else { throw fail("Draw a larger area to share.") }
            let requested = CGRect(x: p["x"] as? Double ?? 0, y: p["y"] as? Double ?? 0, width: width, height: height)
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            let centre = CGPoint(x: requested.midX, y: requested.midY)
            guard let display = content.displays.first(where: { $0.frame.contains(centre) }) ?? content.displays.first(where: { $0.frame.intersects(requested) }) else { throw fail("That area is not on a connected display.") }
            let excluded = Set(p["excludedApps"] as? [String] ?? [])
            guard !content.windows.contains(where: { excluded.contains($0.owningApplication?.bundleIdentifier ?? "") && $0.frame.intersects(requested) }) else { throw fail("A protected application is inside that area. Choose another one.") }
            let local = requested.intersection(display.frame).offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
            guard local.width >= 16, local.height >= 16 else { throw fail("Draw a larger area to share.") }
            let configuration = SCStreamConfiguration()
            configuration.sourceRect = local
            let scale = min(1, 1280 / local.width)
            configuration.width = Int(local.width * scale); configuration.height = Int(local.height * scale); configuration.showsCursor = false
            // Jarvis's own surfaces are excluded so the selection overlay never appears in the shot.
            let filter = SCContentFilter(display: display, excludingWindows: content.windows.filter { isOwn($0) })
            let path = try writeCapture(try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration))
            let captured = local.offsetBy(dx: display.frame.minX, dy: display.frame.minY)
            return ["windowId": 0, "app": "Selected area", "title": "\(Int(local.width)) × \(Int(local.height)) points", "width": configuration.width, "height": configuration.height, "imagePath": path.path, "capturedX": captured.minX, "capturedY": captured.minY, "capturedWidth": captured.width, "capturedHeight": captured.height]
        case "context.focus":
            guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication, app.bundleIdentifier != "personal.jarvis.desktop", app.localizedName != "Electron" else { return NSNull() }
            let element = AXUIElementCreateApplication(app.processIdentifier)
            guard let raw = axValue(element, kAXFocusedUIElementAttribute) else { return NSNull() }
            let control = raw as! AXUIElement
            guard let pos = axValue(control, kAXPositionAttribute), let size = axValue(control, kAXSizeAttribute) else { return NSNull() }
            var origin = CGPoint.zero; var dimensions = CGSize.zero
            guard AXValueGetValue(pos as! AXValue, .cgPoint, &origin), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return NSNull() }
            return ["x": origin.x, "y": origin.y, "width": dimensions.width, "height": dimensions.height, "bundleId": app.bundleIdentifier ?? ""]
        case "ui.applications":
            guard AXIsProcessTrusted() else { throw fail("Allow Accessibility for Jarvis in Privacy & access first.") }
            return NSWorkspace.shared.runningApplications
                .filter { $0.activationPolicy == .regular && $0.bundleIdentifier != "personal.jarvis.desktop" && $0.bundleIdentifier != nil }
                .map { ["bundleId": $0.bundleIdentifier ?? "", "app": $0.localizedName ?? "Application", "frontmost": $0.isActive] }
        case "ui.elements":
            guard AXIsProcessTrusted() else { throw fail("Allow Accessibility for Jarvis in Privacy & access first.") }
            let wanted = p["bundleId"] as? String
            guard let app = NSWorkspace.shared.runningApplications.first(where: { wanted == nil ? $0.isActive : $0.bundleIdentifier == wanted }), app.bundleIdentifier != "personal.jarvis.desktop" else { throw fail("Choose a running application other than Jarvis.") }
            var found: [[String: Any]] = []
            axDescribe(AXUIElementCreateApplication(app.processIdentifier), path: [], depth: 0, into: &found, limit: min(p["limit"] as? Int ?? 200, 400))
            return ["bundleId": app.bundleIdentifier ?? "", "app": app.localizedName ?? "Application", "frontmost": app.isActive, "elements": found]
        case "ui.press":
            guard AXIsProcessTrusted() else { throw fail("Allow Accessibility for Jarvis in Privacy & access first.") }
            guard let bundleId = p["bundleId"] as? String, let path = p["path"] as? [Int], let role = p["role"] as? String, let label = p["label"] as? String else { throw fail("A control needs its application, path, role, and label.") }
            guard bundleId != "personal.jarvis.desktop" else { throw fail("Jarvis does not press its own controls.") }
            guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundleId }) else { throw fail("That application is no longer running.") }
            // The path is re-walked every time; a control that moved is refused rather than guessed at.
            var element = AXUIElementCreateApplication(app.processIdentifier)
            for index in path {
                let children = axChildren(element)
                guard index >= 0, index < children.count else { throw fail("The control is no longer where it was. Look at the application again.") }
                element = children[index]
            }
            guard (axString(element, kAXRoleAttribute as String) ?? "") == role, axLabel(element) == label else { throw fail("A different control is in that position now. Look at the application again.") }
            guard (axValue(element, kAXEnabledAttribute as String) as? Bool) ?? true else { throw fail("That control is disabled.") }
            guard axActions(element).contains(kAXPressAction as String) else { throw fail("That control cannot be pressed.") }
            let frame = axFrame(element) ?? .zero
            let target: [String: Any] = ["bundleId": bundleId, "app": app.localizedName ?? "Application", "role": role, "label": label, "frontmost": app.isActive, "x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
            if p["dryRun"] as? Bool == true { return target.merging(["pressed": false, "resolved": true]) { current, _ in current } }
            guard app.isActive else { throw fail("Bring that application to the front before its control is pressed.") }
            guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else { throw fail("The application refused the press.") }
            // Whatever the control reads as now is the only evidence the press did anything.
            return target.merging(["pressed": true, "resolved": true, "labelAfter": axLabel(element)]) { current, _ in current }
        case "apple.calendars": return events.calendars(for: .event).map { ["id": $0.calendarIdentifier, "title": $0.title, "writable": $0.allowsContentModifications] }
        case "apple.reminder.lists": return events.calendars(for: .reminder).map { ["id": $0.calendarIdentifier, "title": $0.title, "writable": $0.allowsContentModifications, "isDefault": $0.calendarIdentifier == events.defaultCalendarForNewReminders()?.calendarIdentifier] }
        case "apple.event.get":
            guard let value = events.event(withIdentifier: p["id"] as? String ?? "") else { throw fail("This event is no longer available.") }
            return ["id": value.eventIdentifier ?? "", "title": value.title ?? "", "calendarId": value.calendar.calendarIdentifier, "start": ISO8601DateFormatter().string(from: value.startDate), "end": ISO8601DateFormatter().string(from: value.endDate)]
        case "apple.reminder.get":
            guard let value = events.calendarItem(withIdentifier: p["id"] as? String ?? "") as? EKReminder else { throw fail("This reminder is no longer available.") }
            return ["id": value.calendarItemIdentifier, "title": value.title ?? "", "calendarId": value.calendar.calendarIdentifier, "completed": value.isCompleted]
        case "apple.events":
            let start = Date(); let end = Calendar.current.date(byAdding: .day, value: 7, to: start)!
            return events.events(matching: events.predicateForEvents(withStart: start, end: end, calendars: nil)).prefix(200).map { ["id": $0.eventIdentifier ?? "", "title": $0.title ?? "Untitled", "start": ISO8601DateFormatter().string(from: $0.startDate), "end": ISO8601DateFormatter().string(from: $0.endDate), "calendar": $0.calendar.title] }
        case "apple.reminders":
            return await withCheckedContinuation { continuation in events.fetchReminders(matching: events.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)) { reminders in continuation.resume(returning: (reminders ?? []).prefix(200).map { ["id": $0.calendarItemIdentifier, "title": $0.title ?? "Untitled", "list": $0.calendar.title] }) } }
        case "apple.event.create":
            guard let title = p["title"] as? String, let start = ISO8601DateFormatter().date(from: p["start"] as? String ?? ""), let end = ISO8601DateFormatter().date(from: p["end"] as? String ?? ""), end > start, let calendar = events.calendar(withIdentifier: p["calendarId"] as? String ?? ""), calendar.allowsContentModifications else { throw fail("Choose an editable calendar and valid event dates.") }
            let value = EKEvent(eventStore: events); value.title = title; value.startDate = start; value.endDate = end; value.calendar = calendar; value.notes = p["notes"] as? String
            try events.save(value, span: .thisEvent, commit: true); return ["id": value.eventIdentifier ?? "", "title": value.title ?? ""]
        case "apple.reminder.create":
            guard let title = p["title"] as? String, !title.isEmpty, let calendar = events.calendar(withIdentifier: p["calendarId"] as? String ?? ""), calendar.allowsContentModifications else { throw fail("Choose an editable Reminders list first.") }
            let value = EKReminder(eventStore: events); value.title = title; value.calendar = calendar; value.notes = p["notes"] as? String
            try events.save(value, commit: true); return ["id": value.calendarItemIdentifier, "title": value.title ?? ""]
        case "ephemeral.delete":
            let path = URL(fileURLWithPath: p["path"] as? String ?? "").standardizedFileURL
            guard path.path.hasPrefix(ephemeral.path + "/") else { throw fail("This file is outside temporary storage.") }; try? FileManager.default.removeItem(at: path); return true
        default: throw fail("Unsupported native request: \(method)")
        }
    }
    struct TapStart { let sampleRate: Double; let preRoll: Bool }
    func historyPCM(seconds: Double, rate: Double) throws -> String {
        guard seconds > 0, let history = audioHistory else { return "" }
        let samples = Array(history.snapshot().suffix(Int(history.sampleRate * seconds)))
        guard !samples.isEmpty,
              let source = AVAudioFormat(standardFormatWithSampleRate: history.sampleRate, channels: 1),
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true),
              let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(samples.count)),
              let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(Double(samples.count) * rate / history.sampleRate) + 32),
              let converter = AVAudioConverter(from: source, to: target) else { return "" }
        input.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { input.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        var supplied = false
        var error: NSError?
        // Conversion consumes this private buffer synchronously before the method returns.
        nonisolated(unsafe) let convertedInput = input
        converter.convert(to: output, error: &error) { _, status in
            if supplied { status.pointee = .endOfStream; return nil }
            supplied = true; status.pointee = .haveData; return convertedInput
        }
        if let error { throw error }
        guard let data = output.int16ChannelData?[0] else { return "" }
        return Data(bytes: data, count: Int(output.frameLength) * 2).base64EncodedString()
    }
    /**
     * One microphone tap, with or without a file behind it. Apple's echo cancellation is asked for
     * once, before anything reads the format — it can change the sample rate and channel count, so
     * everything below is derived after it, not before.
     */
    func openTap(writeTo path: URL?, preRoll carried: [Float]) throws -> TapStart {
        let input = audio.inputNode
        if !voiceProcessing && !audio.isRunning {
            do {
                try input.setVoiceProcessingEnabled(true)
                try audio.outputNode.setVoiceProcessingEnabled(true)
                voiceProcessing = true
            } catch {
                // Some routes refuse it. Say so rather than assume, so barge-in can stay shut.
                voiceProcessing = false
            }
        }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 && format.channelCount > 0 else { throw fail("No microphone is available.") }
        guard let captureFormat = AVAudioFormat(standardFormatWithSampleRate: format.sampleRate, channels: 1) else { throw fail("The microphone format is unavailable.") }
        var file: AVAudioFile?
        var seeded = false
        if let path {
            let opened = try AVAudioFile(forWriting: path, settings: captureFormat.settings)
            // The rolling history and the recording contain the same microphone channel.
            if !carried.isEmpty,
               let buffer = AVAudioPCMBuffer(pcmFormat: captureFormat, frameCapacity: AVAudioFrameCount(carried.count)),
               let channels = buffer.floatChannelData {
                buffer.frameLength = AVAudioFrameCount(carried.count)
                carried.withUnsafeBufferPointer { source in
                    channels[0].update(from: source.baseAddress!, count: carried.count)
                }
                if (try? opened.write(from: buffer)) != nil { seeded = true }
            }
            file = opened
            recording = opened
        } else {
            recording = nil
        }
        let history = AudioHistory(sampleRate: format.sampleRate)
        audioHistory = history
        var frames: Int64 = 0
        let session = captureGeneration
        // The model runtime hears this same microphone as a stream of 16 kHz frames, so speech is
        // judged as it happens rather than from snapshots written to disk every second or so.
        let rate = captureRate
        let stream = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true)
        let converter = stream.flatMap { AVAudioConverter(from: captureFormat, to: $0) }
        // A tap opening while a reply still plays through the engine keeps the engine it found running.
        stopEngineWhenIdle = false
        if !playerAttached && !audio.isRunning {
            // Attached before the engine starts, so playing a reply later never reconfigures a
            // running graph. Replies are 24 kHz mono; a piece in another format reconnects.
            audio.attach(playerNode)
            playerFormat = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)
            audio.connect(playerNode, to: audio.mainMixerNode, format: playerFormat)
            // Left to itself the engine joins the mixer to the output at 44.1 kHz stereo, which the
            // voice-processing output refuses (error -10875, observed here with a USB microphone and
            // the built-in speakers). Joined at the microphone's rate, it starts.
            audio.connect(audio.mainMixerNode, to: audio.outputNode, format: AVAudioFormat(standardFormatWithSampleRate: format.sampleRate, channels: 2))
            playerNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
                guard let samples = buffer.floatChannelData?[0] else { return }
                var energy: Float = 0; for i in 0..<Int(buffer.frameLength) { energy += samples[i] * samples[i] }
                let amplitude = min(1, Double(sqrt(energy / Float(max(buffer.frameLength, 1)))) * 3.2)
                Task { @MainActor in
                    guard let self, self.nodePending > 0 else { return }
                    event("speech.level", ["generation": self.nodeSession, "level": amplitude])
                }
            }
            playerAttached = true
        }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            // Voice processing can expose an aggregate format (nine channels on this Mac).
            // Its default downmix produced all-zero PCM despite a live first channel. Select
            // that microphone channel before resampling, and use it for the file and meter too.
            guard let source = buffer.floatChannelData?[0],
                  let captured = AVAudioPCMBuffer(pcmFormat: captureFormat, frameCapacity: buffer.frameLength),
                  let samples = captured.floatChannelData?[0] else { return }
            captured.frameLength = buffer.frameLength
            var energy: Float = 0
            for i in 0..<Int(buffer.frameLength) {
                let value = source[i * Int(buffer.stride)]
                samples[i] = value
                energy += value * value
            }
            history.append(captured)
            if let file {
                do { try file.write(from: captured) } catch { event("audio.error", ["message": "The microphone recording could not be written.", "generation": session]) }
            }
            frames += Int64(buffer.frameLength)
            let rms = sqrt(energy / Float(max(buffer.frameLength, 1)))
            var payload: [String: Any] = ["level": min(1, Double(rms) * 7), "generation": session, "elapsed": Double(frames) / format.sampleRate, "sampleRate": rate, "inputSampleRate": format.sampleRate, "inputChannels": Int(format.channelCount)]
            if let converter, let stream,
               let out = AVAudioPCMBuffer(pcmFormat: stream, frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * rate / format.sampleRate) + 32) {
                var consumed = false
                var error: NSError?
                _ = converter.convert(to: out, error: &error) { _, status in
                    if consumed { status.pointee = .noDataNow; return nil }
                    consumed = true
                    status.pointee = .haveData
                    return captured
                }
                if error == nil, out.frameLength > 0, let data = out.int16ChannelData {
                    payload["pcm"] = Data(bytes: data[0], count: Int(out.frameLength) * 2).base64EncodedString()
                    var pcmEnergy = 0.0
                    for i in 0..<Int(out.frameLength) {
                        let sample = Double(data[0][i]) / 32768
                        pcmEnergy += sample * sample
                    }
                    payload["pcmLevel"] = min(1, sqrt(pcmEnergy / Double(out.frameLength)) * 7)
                }
            }
            event("audio.level", payload)
        }
        if !audio.isRunning {
            audio.prepare()
            do { try audio.start() } catch {
                // A route that refuses the reply path still has to listen. Try once more with the
                // graph the microphone alone needs, and say so: replies will then play outside the
                // engine, where echo cancellation cannot see them, and interrupting is not offered.
                guard playerAttached else { throw fail("The audio engine could not start (\(error.localizedDescription)). Microphone \(audio.inputNode.inputFormat(forBus: 0)) heard as \(format); speaker \(outputRoute()) \(audio.outputNode.inputFormat(forBus: 0)).") }
                playerNode.removeTap(onBus: 0)
                audio.disconnectNodeOutput(playerNode)
                audio.disconnectNodeInput(audio.outputNode)
                audio.detach(playerNode)
                playerAttached = false
                playerFormat = nil
                audio.prepare()
                do { try audio.start() } catch {
                    throw fail("The audio engine could not start (\(error.localizedDescription)). Microphone \(audio.inputNode.inputFormat(forBus: 0)) heard as \(format); speaker \(outputRoute()) \(audio.outputNode.inputFormat(forBus: 0)).")
                }
            }
        }
        return TapStart(sampleRate: format.sampleRate, preRoll: seeded)
    }
    /** The microphone closes at once; the engine follows only when no reply still plays through it. */
    func stopEngine() {
        guard audio.isRunning else { return }
        audio.inputNode.removeTap(onBus: 0)
        if nodePending > 0 { stopEngineWhenIdle = true } else { audio.stop() }
    }
    func playThroughEngine(_ url: URL, session: Int) throws {
        let file = try AVAudioFile(forReading: url)
        guard audio.isRunning else { throw fail("The audio engine is not running, so the reply cannot play through it.") }
        if playerFormat?.isEqual(file.processingFormat) != true {
            audio.connect(playerNode, to: audio.mainMixerNode, format: file.processingFormat)
            playerFormat = file.processingFormat
        }
        schedulePiece(session, duration: Double(file.length) / file.processingFormat.sampleRate) { completion in
            self.playerNode.scheduleFile(file, at: nil, completionCallbackType: .dataPlayedBack, completionHandler: completion)
        }
    }
    func schedulePiece(_ session: Int, duration: Double, schedule: (_ completion: @escaping @Sendable (AVAudioPlayerNodeCompletionCallbackType) -> Void) -> Void) {
        if nodeSession != session { nodeSession = session; nodePending = 0; nodeDurations.removeAll() }
        if nodePending == 0 { pieceStartedAt = Date(); pieceDuration = duration }
        nodePending += 1; nodeDurations.append(duration)
        let epoch = playbackEpoch
        schedule { [weak self] _ in
            Task { @MainActor in
                guard let self, epoch == self.playbackEpoch else { return }
                self.nodePieceFinished(session)
            }
        }
        if !playerNode.isPlaying { playerNode.play() }
    }
    func nodePieceFinished(_ session: Int) {
        guard session == nodeSession, nodePending > 0 else { return }
        nodePending -= 1
        playedSeconds += nodeDurations.removeFirst()
        pieceStartedAt = nodePending > 0 ? Date() : nil
        pieceDuration = nodeDurations.first ?? 0
        if nodePending > 0 { return }
        playerNode.stop()
        if stopEngineWhenIdle { stopEngineWhenIdle = false; audio.stop() }
        finishPlayback(session)
    }
    func finishPlayback(_ session: Int, success: Bool = true) {
        guard session == generation, streamGeneration != session, !completionReported,
              nodePending == 0, player?.isPlaying != true, playbackQueue.isEmpty else { return }
        completionReported = true
        event("speech.finished", ["generation": session, "success": success, "playedMs": Int(playedSeconds * 1000)])
    }
    func stopNodePlayback() {
        playbackEpoch += 1
        nodePending = 0
        nodeDurations.removeAll(); pieceStartedAt = nil; pieceDuration = 0
        nodeSession = generation
        playerNode.stop()
        if stopEngineWhenIdle { stopEngineWhenIdle = false; audio.stop() }
    }
    func playableURL(_ path: String) throws -> URL {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        guard url.path.hasPrefix(ephemeral.path + "/") else { throw fail("Playback is restricted to temporary audio.") }
        return url
    }
    func startPlayback(_ url: URL, session: Int) throws {
        playbackMeter?.invalidate()
        // With the microphone open the engine is running, and the reply has to go through it.
        if audio.isRunning && playerAttached { try playThroughEngine(url, session: session); return }
        player = try AVAudioPlayer(contentsOf: url); player?.delegate = self
        if let value = player { playbackGenerations[ObjectIdentifier(value)] = session }
        player?.isMeteringEnabled = true
        player?.prepareToPlay()
        guard player?.play() == true else { player = nil; throw fail("The audio output route is unavailable.") }
        pieceStartedAt = Date(); pieceDuration = player?.duration ?? 0
        playbackMeter = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self = self, let player = self.player, player.isPlaying, session == self.generation else { return }
                player.updateMeters()
                let amplitude = min(1, pow(10, Double(player.averagePower(forChannel: 0)) / 20) * 3.2)
                event("speech.level", ["generation": session, "level": amplitude])
            }
        }
    }
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        guard let session = playbackGenerations.removeValue(forKey: ObjectIdentifier(player)) else { return }
        if self.player === player { playedSeconds += player.duration; pieceStartedAt = nil; pieceDuration = 0 }
        // The next sentence of the same reply follows straight on; only the last one reports done.
        if self.player === player, session == generation, flag, !playbackQueue.isEmpty {
            let next = playbackQueue.removeFirst()
            if (try? startPlayback(next, session: session)) != nil { return }
        }
        if self.player === player { playbackMeter?.invalidate(); playbackMeter = nil; playbackQueue.removeAll(); self.player = nil }
        finishPlayback(session, success: flag)
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { if let session = speechGenerations.removeValue(forKey: ObjectIdentifier(utterance)) { event("speech.finished", ["generation": session, "success": true]) } }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { speechGenerations.removeValue(forKey: ObjectIdentifier(utterance)) }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let companion = MainActor.assumeIsolated { Companion() }
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        guard line.utf8.count <= 1_048_576, let data = line.data(using: .utf8), let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let method = message["method"] as? String else { continue }
        let id = message["id"] as? String ?? ""
        Task { @MainActor in
            do { guard message["version"] as? Int == 1 else { throw fail("Unsupported protocol version.") }; let result = try await companion.execute(method, message["params"] as? [String: Any] ?? [:]); if !id.isEmpty { send(["version": 1, "id": id, "result": result]) } }
            catch { if !id.isEmpty { send(["version": 1, "id": id, "error": error.localizedDescription]) } }
        }
    }
    DispatchQueue.main.async { NSApp.terminate(nil) }
}
app.run()
