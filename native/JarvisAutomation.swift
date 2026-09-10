import AppKit

struct AutomationError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
func fail(_ message: String) -> AutomationError { AutomationError(message: message) }
func scriptValue(_ descriptor: NSAppleEventDescriptor) -> Any {
    if descriptor.descriptorType == typeAEList { return (1...max(1, descriptor.numberOfItems)).compactMap { descriptor.atIndex($0) }.map(scriptValue) }
    return descriptor.stringValue ?? ""
}
func appleScript(_ source: String) throws -> Any {
    guard let script = NSAppleScript(source: source) else { throw fail("The native application script could not be compiled.") }
    var error: NSDictionary?
    let result = script.executeAndReturnError(&error)
    if let error = error { throw fail(error[NSAppleScript.errorMessage] as? String ?? "macOS Automation access was not granted.") }
    return scriptValue(result)
}

@MainActor func execute(_ method: String, _ p: [String: Any]) throws -> Any {
    switch method {
        case "apple.mail.selected":
            return try appleScript("""
                tell application "Mail"
                    set resultItems to {}
                    set chosenMessages to selection
                    if (count of chosenMessages) > 10 then error "Select at most ten messages to share."
                    repeat with messageItem in chosenMessages
                        set messageText to content of messageItem
                        if (length of messageText) > 12000 then set messageText to text 1 thru 12000 of messageText
                        set end of resultItems to {id of messageItem as string, subject of messageItem, sender of messageItem, messageText}
                    end repeat
                    return resultItems
                end tell
                """)
        case "browser.tabs":
            var result: [[String: Any]] = []
            for browser in ["Safari", "Google Chrome"] {
                let running = NSWorkspace.shared.runningApplications.contains { $0.localizedName == browser }
                if !running { continue }
                let script = browser == "Safari" ? """
                    tell application "Safari"
                        set resultItems to {}
                        repeat with browserWindow in windows
                            repeat with browserTab in tabs of browserWindow
                                set end of resultItems to {id of browserWindow as string, index of browserTab as string, name of browserTab, URL of browserTab}
                            end repeat
                        end repeat
                        return resultItems
                    end tell
                    """ : """
                    tell application "Google Chrome"
                        set resultItems to {}
                        repeat with browserWindow in windows
                            repeat with browserTab in tabs of browserWindow
                                set end of resultItems to {id of browserWindow as string, id of browserTab as string, title of browserTab, URL of browserTab}
                            end repeat
                        end repeat
                        return resultItems
                    end tell
                    """
                let items = try appleScript(script) as? [[String]] ?? []
                for item in items.prefix(100) where item.count == 4 { result.append(["browser": browser, "windowId": item[0], "tabId": item[1], "title": item[2], "url": item[3]]) }
            }
            return result

        default: throw fail("Unsupported application integration.")
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        guard line.utf8.count < 1_048_576, let data = line.data(using: .utf8), let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any], request["version"] as? Int == 1, let id = request["id"] as? String, let method = request["method"] as? String else { continue }
        Task { @MainActor in
            var response: [String: Any] = ["version": 1, "id": id]
            do { response["result"] = try execute(method, request["params"] as? [String: Any] ?? [:]) }
            catch { response["error"] = error.localizedDescription }
            if let encoded = try? JSONSerialization.data(withJSONObject: response), encoded.count < 1_048_576 {
                FileHandle.standardOutput.write(encoded); FileHandle.standardOutput.write(Data([10]))
            }
        }
    }
    DispatchQueue.main.async { NSApp.terminate(nil) }
}
app.run()
