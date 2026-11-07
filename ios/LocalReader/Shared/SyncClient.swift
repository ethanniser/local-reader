import Foundation
import Security

struct SyncConfiguration: Codable, Equatable { var siteURL: String = "" }

enum CredentialStore {
    static let service = "com.ethanniser.local-reader.sync"
    static func read() -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
    static func save(_ token: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        SecItemDelete(query as CFDictionary)
        guard !token.isEmpty else { return }
        var attributes = query
        attributes[kSecValueData as String] = Data(token.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw SyncError.message("Could not save the sync key securely (\(status)).") }
    }
}

enum SyncError: LocalizedError {
    case message(String)
    case http(Int)
    var errorDescription: String? { switch self { case .message(let text): return text; case .http(let code): return "Sync failed (HTTP \(code)). Your local articles are safe." } }
}

private final class NoSyncRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

struct SyncClient: Sendable {
    let base: URL
    let token: String
    init(configuration: SyncConfiguration, token: String) throws {
        guard let url = URL(string: configuration.siteURL.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil, ["", "/"].contains(url.path), url.query == nil, url.fragment == nil, !token.isEmpty else {
            throw SyncError.message("Add your HTTPS sync address and pairing key in Settings.")
        }
        base = url; self.token = token
    }
    func request(_ path: String, method: String = "GET", body: Data? = nil, contentType: String = "application/json") async throws -> Data {
        guard let url = URL(string: path, relativeTo: base.absoluteString.hasSuffix("/") ? base : base.appendingPathComponent("/"))?.absoluteURL,
              url.scheme == "https", url.host == base.host else { throw SyncError.message("Invalid sync address.") }
        var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body { request.httpBody = body; request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await URLSession.shared.data(for: request, delegate: NoSyncRedirects())
        guard let response = response as? HTTPURLResponse else { throw SyncError.message("The sync service did not respond.") }
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 401 || response.statusCode == 403 { throw SyncError.message("Pairing key rejected. Check Settings.") }
            throw SyncError.http(response.statusCode)
        }
        return data
    }
    func library() async throws -> RemoteLibrary { try JSONDecoder().decode(RemoteLibrary.self, from: await request("sync?format=2")) }
    func article(_ id: String) async throws -> Article {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+?#"))) ?? id
        return try JSONDecoder().decode(Article.self, from: await request("documents?id=\(encoded)&format=2"))
    }
    struct UploadReceipt: Decodable { var document: RemoteArticle?; var deleted: Bool?; var ignored: Bool? }
    @discardableResult func upload(_ article: Article) async throws -> UploadReceipt {
        try JSONDecoder().decode(UploadReceipt.self, from: await request("documents", method: "POST", body: JSONEncoder().encode(article)))
    }
    func progress(_ article: Article) async throws {
        struct Body: Encodable { let id: String; let position: Int; let updated: Double }
        _ = try await request("progress", method: "PUT", body: JSONEncoder().encode(Body(id: article.id, position: article.position, updated: article.updated)))
    }
    struct LifecycleReceipt: Decodable { var archived: Bool; var deleted: Bool; var lifecycleUpdated: Double }
    @discardableResult func lifecycle(_ article: Article) async throws -> LifecycleReceipt {
        struct Body: Encodable { let id: String; let archived: Bool; let deleted: Bool; let lifecycleUpdated: Double }
        return try JSONDecoder().decode(LifecycleReceipt.self, from: await request("lifecycle", method: "PUT", body: JSONEncoder().encode(Body(id: article.id, archived: article.archived, deleted: article.deleted, lifecycleUpdated: article.lifecycleUpdated))))
    }
    func readStatus(_ article: Article) async throws {
        struct Body: Encodable { let id: String; let unread: Bool; let readUpdated: Double }
        _ = try await request("read-status", method: "PUT", body: JSONEncoder().encode(Body(id: article.id, unread: article.unread, readUpdated: article.readUpdated)))
    }
    func tags(_ article: Article) async throws {
        struct Body: Encodable { let id: String; let tags: [String]; let metadataUpdated: Double }
        _ = try await request("tags", method: "PUT", body: JSONEncoder().encode(Body(id: article.id, tags: article.tags, metadataUpdated: article.metadataUpdated)))
    }
}
