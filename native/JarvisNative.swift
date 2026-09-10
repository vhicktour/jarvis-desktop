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
    var playbackMeter: Timer?
    var audioHistory: AudioHistory?
    var generation = 0
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
    func windows() async throws -> [SCWindow] {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        return content.windows.filter { $0.owningApplication?.bundleIdentifier != "personal.jarvis.desktop" && $0.owningApplication?.processID != ProcessInfo.processInfo.processIdentifier && $0.owningApplication?.applicationName != "Electron" && $0.frame.width > 80 && $0.frame.height > 50 && !($0.title ?? "").isEmpty }
    }
    func execute(_ method: String, _ p: [String: Any]) async throws -> Any {
        switch method {
        case "ping": return ["version": 1, "permissions": permissions(), "reduceMotion": NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, "reduceTransparency": NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency]
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
            if audio.isRunning { return true }
            generation = p["generation"] as? Int ?? generation + 1
            let input = audio.inputNode; let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 && format.channelCount > 0 else { throw fail("No microphone is available.") }
            let path = ephemeral.appendingPathComponent(UUID().uuidString + ".wav")
            let file = try AVAudioFile(forWriting: path, settings: format.settings)
            recording = file; recordPath = path
            let history = AudioHistory(sampleRate: format.sampleRate)
            audioHistory = history
            var frames: Int64 = 0; let session = generation
            input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
                history.append(buffer)
                do { try file.write(from: buffer) } catch { event("audio.error", ["message": "The microphone recording could not be written.", "generation": session]) }
                frames += Int64(buffer.frameLength)
                guard let samples = buffer.floatChannelData?[0] else { return }
                var energy: Float = 0; for i in 0..<Int(buffer.frameLength) { energy += samples[i] * samples[i] }
                let rms = sqrt(energy / Float(max(buffer.frameLength, 1)))
                event("audio.level", ["level": min(1, Double(rms) * 7), "generation": session, "elapsed": Double(frames) / format.sampleRate])
            }
            audio.prepare(); try audio.start(); return ["sampleRate": format.sampleRate, "generation": generation]
        case "audio.preview":
            guard audio.isRunning, let history = audioHistory else { throw fail("No active recording.") }
            let samples = history.snapshot()
            guard !samples.isEmpty, let format = AVAudioFormat(standardFormatWithSampleRate: history.sampleRate, channels: 1), let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else { throw fail("Audio preview is not ready.") }
            buffer.frameLength = AVAudioFrameCount(samples.count)
            samples.withUnsafeBufferPointer { source in buffer.floatChannelData![0].update(from: source.baseAddress!, count: samples.count) }
            let path = ephemeral.appendingPathComponent(UUID().uuidString + ".wav")
            let preview = try AVAudioFile(forWriting: path, settings: format.settings)
            try preview.write(from: buffer)
            return ["path": path.path, "generation": generation]
        case "audio.stop":
            if audio.isRunning { audio.stop(); audio.inputNode.removeTap(onBus: 0) }
            recording = nil
            audioHistory = nil
            guard let path = recordPath else { return ["path": NSNull()] }
            recordPath = nil; return ["path": path.path, "generation": generation]
        case "audio.discard":
            if audio.isRunning { audio.stop(); audio.inputNode.removeTap(onBus: 0) }; recording = nil; audioHistory = nil
            if let path = recordPath { try? FileManager.default.removeItem(at: path) }; recordPath = nil; return true
        case "speech.stop": generation = p["generation"] as? Int ?? generation + 1; playbackMeter?.invalidate(); playbackMeter = nil; player?.stop(); player = nil; playbackGenerations.removeAll(); speech.stopSpeaking(at: .immediate); return ["playing": false, "generation": generation]
        case "speech.status": return ["playing": player?.isPlaying ?? false, "speaking": speech.isSpeaking, "generation": generation, "outputRoute": outputRoute()]
        case "speech.system":
            let text = p["text"] as? String ?? ""; guard text.count <= 12_000 else { throw fail("Speech is too long.") }
            speech.stopSpeaking(at: .immediate); generation = p["generation"] as? Int ?? generation + 1
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = AVSpeechSynthesisVoice.speechVoices().first { $0.language == "en-GB" && $0.gender == .male } ?? AVSpeechSynthesisVoice(language: "en-GB")
            utterance.rate = Float((p["speed"] as? Double ?? 1) * 0.48)
            speechGenerations[ObjectIdentifier(utterance)] = generation
            speech.speak(utterance); return true
        case "speech.play":
            let url = URL(fileURLWithPath: p["path"] as? String ?? "").standardizedFileURL
            guard url.path.hasPrefix(ephemeral.path + "/") else { throw fail("Playback is restricted to temporary audio.") }
            playbackMeter?.invalidate(); player?.stop(); playbackGenerations.removeAll(); speech.stopSpeaking(at: .immediate); generation = p["generation"] as? Int ?? generation + 1
            player = try AVAudioPlayer(contentsOf: url); player?.delegate = self
            if let value = player { playbackGenerations[ObjectIdentifier(value)] = generation }
            player?.isMeteringEnabled = true
            player?.prepareToPlay()
            guard player?.play() == true else { player = nil; throw fail("The audio output route is unavailable.") }
            let session = generation
            playbackMeter = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self = self, let player = self.player, player.isPlaying, session == self.generation else { return }
                    player.updateMeters()
                    let amplitude = min(1, pow(10, Double(player.averagePower(forChannel: 0)) / 20) * 3.2)
                    event("speech.level", ["generation": session, "level": amplitude])
                }
            }
            return true
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
            let cg = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            let bitmap = NSBitmapImageRep(cgImage: cg)
            guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.65]) else { throw fail("Could not encode the selected window.") }
            let path = ephemeral.appendingPathComponent(UUID().uuidString + ".jpg"); try data.write(to: path, options: [.atomic])
            return ["windowId": id, "app": window.owningApplication?.applicationName ?? "Application", "title": window.title ?? "Window", "width": configuration.width, "height": configuration.height, "imagePath": path.path]
        case "context.focus":
            guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication, app.bundleIdentifier != "personal.jarvis.desktop", app.localizedName != "Electron" else { return NSNull() }
            let element = AXUIElementCreateApplication(app.processIdentifier)
            guard let raw = axValue(element, kAXFocusedUIElementAttribute) else { return NSNull() }
            let control = raw as! AXUIElement
            guard let pos = axValue(control, kAXPositionAttribute), let size = axValue(control, kAXSizeAttribute) else { return NSNull() }
            var origin = CGPoint.zero; var dimensions = CGSize.zero
            guard AXValueGetValue(pos as! AXValue, .cgPoint, &origin), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return NSNull() }
            return ["x": origin.x, "y": origin.y, "width": dimensions.width, "height": dimensions.height, "bundleId": app.bundleIdentifier ?? ""]
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
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { if let session = playbackGenerations.removeValue(forKey: ObjectIdentifier(player)) { if self.player === player { playbackMeter?.invalidate(); playbackMeter = nil }; event("speech.finished", ["generation": session, "success": flag]) } }
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
