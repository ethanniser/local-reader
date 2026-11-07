import Foundation
import Security

struct SharedConnection: Codable {
    var address: String
    var token: String
    static var group: String? { Bundle.main.object(forInfoDictionaryKey: "SyncKeychainAccessGroup") as? String }
    static func read() -> SharedConnection? {
        guard let group, !group.contains("$(") else { return nil }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.ethanniser.localreader.share-connection", kSecAttrAccessGroup as String: group, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
    static func save(_ value: SharedConnection?) throws {
        guard let group, !group.contains("$(") else { throw SyncError.message("Shared pairing is unavailable in this build.") }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.ethanniser.localreader.share-connection", kSecAttrAccessGroup as String: group]
        guard let value else { let status = SecItemDelete(query as CFDictionary); guard status == errSecSuccess || status == errSecItemNotFound else { throw SyncError.message("Could not disconnect sharing (\(status)).") }; return }
        _ = try SyncClient(configuration: SyncConfiguration(siteURL: value.address), token: value.token)
        let payload = try JSONEncoder().encode(value)
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: payload] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw SyncError.message("Could not update shared pairing (\(update)).") }
        var attributes = query; attributes[kSecValueData as String] = payload; attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw SyncError.message("Could not share pairing with the import extension (\(status)).") }
    }
}
