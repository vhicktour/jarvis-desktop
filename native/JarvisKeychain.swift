import Foundation
import Security

struct BrokerError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
func fail(_ message: String) -> BrokerError { BrokerError(message: message) }
func keychain(_ account: String, value: String? = nil, delete: Bool = false) throws -> String? {
    guard account.range(of: "^[a-zA-Z0-9._-]{1,100}$", options: .regularExpression) != nil else { throw fail("Invalid credential name.") }
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "personal.jarvis.credentials.v1", kSecAttrAccount as String: account]
    if delete { let status = SecItemDelete(query as CFDictionary); guard status == errSecSuccess || status == errSecItemNotFound else { throw fail("Keychain could not remove this credential.") }; return nil }
    if let value = value {
        let data = Data(value.utf8)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query; insert[kSecValueData as String] = data; insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw fail("Keychain could not save this credential.") }
        } else if status != errSecSuccess { throw fail("Keychain is unavailable. Unlock your Mac and try again.") }
        return nil
    }
    var request = query; request[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail; request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?; let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw fail("Keychain is unavailable. Unlock your Mac and try again.") }
    return String(data: data, encoding: .utf8)
}

while let line = readLine(strippingNewline: true) {
    guard line.utf8.count < 1_048_576, let data = line.data(using: .utf8), let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any], request["version"] as? Int == 1, let id = request["id"] as? String, let method = request["method"] as? String else { continue }
    let p = request["params"] as? [String: Any] ?? [:]
    var response: [String: Any] = ["version": 1, "id": id]
    do {
        switch method {
        case "keychain.get": response["result"] = ["value": try keychain(p["account"] as? String ?? "") as Any? ?? NSNull()]
        case "keychain.set": _ = try keychain(p["account"] as? String ?? "", value: p["value"] as? String ?? ""); response["result"] = true
        case "keychain.delete": _ = try keychain(p["account"] as? String ?? "", delete: true); response["result"] = true
        default: throw fail("Unsupported credential operation.")
        }
    } catch { response["error"] = error.localizedDescription }
    if let encoded = try? JSONSerialization.data(withJSONObject: response) {
        FileHandle.standardOutput.write(encoded); FileHandle.standardOutput.write(Data([10]))
    }
}
