import UIKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor final class ShareViewController: UIViewController {
    private let model = ShareModel()
    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareView(model: model, close: { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) }))
        addChild(host); view.addSubview(host.view); host.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor), host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor), host.view.topAnchor.constraint(equalTo: view.topAnchor), host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)])
        host.didMove(toParent: self)
        Task { await model.load(extensionContext?.inputItems as? [NSExtensionItem] ?? []) }
    }
}

@MainActor final class ShareModel: ObservableObject {
    @Published var status = "Reading shared article…"
    @Published var title = ""
    @Published var busy = true
    @Published var needsPairing = false
    @Published var pairingLink = ""
    @Published var canRetry = false
    private var article: Article?
    private var task: Task<Void, Never>?
    private struct Pending: Codable { var article: Article; var address: String }
    private var connection: SharedConnection? {
        if let shared = SharedConnection.read() { return shared }
        let address = UserDefaults.standard.string(forKey: "shareSyncAddress") ?? "", token = CredentialStore.read()
        return address.isEmpty || token.isEmpty ? nil : SharedConnection(address: address, token: token)
    }
    private var queueURL: URL { FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("pending-imports.json") }
    private func queue() -> [Pending] { (try? JSONDecoder().decode([Pending].self, from: Data(contentsOf: queueURL))) ?? [] }
    private func saveQueue(_ values: [Pending]) throws {
        try FileManager.default.createDirectory(at: queueURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(values).write(to: queueURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var url = queueURL; var resource = URLResourceValues(); resource.isExcludedFromBackup = true; try? url.setResourceValues(resource)
    }
    func load(_ items: [NSExtensionItem]) async {
        do {
            let providers = items.flatMap { $0.attachments ?? [] }
            for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier) {
                let value = try await item(provider, type: UTType.propertyList.identifier)
                if let dictionary = value as? NSDictionary, let payload = dictionary[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any] {
                    if let error = payload["error"] as? String { throw SyncError.message(error) }
                    if let encoded = payload["article"] as? [String: Any] {
                        let data = try JSONSerialization.data(withJSONObject: encoded)
                        guard data.count <= 5 * 1024 * 1024 else { throw SyncError.message("This article is too large. Share selected text.") }
                        var object = encoded
                        let now = Date().timeIntervalSince1970
                        object["id"] = UUID().uuidString; object["updated"] = now; object["contentUpdated"] = now; object["metadataUpdated"] = now; object["readUpdated"] = now; object["unread"] = true
                        article = try JSONDecoder().decode(Article.self, from: JSONSerialization.data(withJSONObject: object))
                        break
                    }
                }
            }
            // Prefer explicitly shared text over a URL that may require browser login.
            var sharedText: String?
            if article == nil {
                for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    if let text = try? await item(provider, type: UTType.plainText.identifier) as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { sharedText = text; break }
                }
                if let text = sharedText {
                    let stripped = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if ArticleMark.safeLink(stripped) == nil || stripped.contains(where: { $0.isWhitespace }) { article = try ArticleImport.text(title: items.first?.attributedTitle?.string ?? "Shared article", text: text) }
                }
            }
            if article == nil {
                for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    if let url = try await item(provider, type: UTType.url.identifier) as? URL { article = try await ArticleImport.fromURL(url); break }
                }
            }
            if article == nil, let text = sharedText, let url = ArticleMark.safeLink(text.trimmingCharacters(in: .whitespacesAndNewlines)) { article = try await ArticleImport.fromURL(url) }
            guard let article, !article.words.isEmpty, article.words.count <= 250000, article.words.allSatisfy({ $0.utf16.count <= 10000 }) else { throw SyncError.message("No article text was shared. In Safari, open the page and share it again, or select some text.") }
            var clean = article
            clean.title = Article.clipped(article.title, limit: 300); if clean.title.isEmpty { clean.title = "Shared article" }
            clean.source = ArticleMark.safeLink(article.source)?.absoluteString ?? ""
            clean.tags = Array(Article.normalizeTags(article.tags).prefix(20))
            var previousEnd = 0
            let validParagraphs = article.paragraphs.allSatisfy { value in
                guard value.start == previousEnd, value.end > value.start, value.end <= article.words.count, ["paragraph", "heading", "blockquote"].contains(value.kind) else { return false }
                previousEnd = value.end; return true
            } && previousEnd == article.words.count
            if !validParagraphs { clean.paragraphs = [Paragraph(start: 0, end: article.words.count, kind: "paragraph")] }
            clean.images = Array(article.images.prefix(20)).map { image in var value = image; value.position = max(0, min(article.words.count, image.position)); value.alt = Article.clipped(value.alt, limit: 2000); value.caption = Article.clipped(value.caption, limit: 4000); return value }
            clean.marks = clean.marks.map { mark in var result = mark; result.href = mark.kind == "link" ? ArticleMark.safeLink(mark.href)?.absoluteString : nil; return result }
            guard try JSONEncoder().encode(clean).count <= 20 * 1024 * 1024 else { throw SyncError.message("This article is too large to sync.") }
            self.article = clean
            title = clean.title
            if connection == nil { busy = false; needsPairing = true; status = "Connect Local Reader in the app, then share again. You can also paste its pairing link below." }
            else { await send() }
        } catch { busy = false; status = error.localizedDescription }
    }
    private func item(_ provider: NSItemProvider, type: String) async throws -> NSSecureCoding {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { value, error in
                if let error { continuation.resume(throwing: error) }
                else if let value { continuation.resume(returning: value) }
                else { continuation.resume(throwing: SyncError.message("This shared item is unavailable.")) }
            }
        }
    }
    var pairingHost: String? {
        guard let parts = URLComponents(string: pairingLink), parts.scheme == "localreader", parts.host == "pair",
              let address = parts.queryItems?.first(where: { $0.name == "url" })?.value,
              let token = parts.queryItems?.first(where: { $0.name == "token" })?.value,
              let client = try? SyncClient(configuration: SyncConfiguration(siteURL: address), token: token) else { return nil }
        return client.base.host
    }
    func connect() {
        do {
            guard let url = URLComponents(string: pairingLink), url.scheme == "localreader", url.host == "pair",
                  let address = url.queryItems?.first(where: { $0.name == "url" })?.value,
                  let token = url.queryItems?.first(where: { $0.name == "token" })?.value, token.count <= 4096 else { throw SyncError.message("Paste a Local Reader pairing link from your trusted settings.") }
            _ = try SyncClient(configuration: SyncConfiguration(siteURL: address), token: token)
            try CredentialStore.save(token); UserDefaults.standard.set(address, forKey: "shareSyncAddress")
            // Main-app pairing remains separate if shared keychain is unavailable.
            needsPairing = false; pairingLink = ""
            task = Task { await send() }
        } catch { status = error.localizedDescription }
    }
    func retry() { task = Task { await send() } }
    private func send() async {
        guard let article, let connection else { busy = false; needsPairing = true; return }
        busy = true; canRetry = false; status = "Saving to your library…"
        do {
            let client = try SyncClient(configuration: SyncConfiguration(siteURL: connection.address), token: connection.token)
            var pending = queue()
            if !pending.contains(where: { $0.article.id == article.id }) {
                guard pending.count < 20 else { throw SyncError.message("The share extension has 20 waiting imports. Reconnect and retry before sharing more.") }
                pending.append(Pending(article: article, address: client.base.absoluteString)); try saveQueue(pending)
            }
            var imageFailures = 0, deletedImports = 0
            var currentDeleted = false
            for item in pending where item.address == client.base.absoluteString {
                var upload = item.article
                upload.images = []
                let imageDeadline = Date().addingTimeInterval(15)
                var imageBytes = 0
                for image in item.article.images.prefix(20) {
                    if Date() > imageDeadline || imageBytes >= 30 * 1024 * 1024 { imageFailures += 1; continue }
                    do {
                        let data = try await ImportImages.png(image.src)
                        guard imageBytes + data.count <= 30 * 1024 * 1024 else { imageFailures += 1; continue }
                        imageBytes += data.count
                        let response = try await client.request("images", method: "POST", body: data, contentType: "image/png")
                        struct SavedImage: Decodable { var url: String }
                        var saved = image; saved.src = try JSONDecoder().decode(SavedImage.self, from: response).url
                        upload.images.append(saved)
                    } catch { imageFailures += 1 }
                }
                let receipt = try await client.upload(upload)
                if receipt.deleted == true || receipt.document?.deleted == true {
                    deletedImports += 1; if item.article.id == article.id { currentDeleted = true }
                }
                var remaining = queue(); remaining.removeAll { $0.article.id == item.article.id }; try saveQueue(remaining)
            }
            if currentDeleted { status = "This queued article was deleted from your library. It was not restored. Share the page again to create a new copy." }
            else if deletedImports > 0 { status = "Saved this article. \(deletedImports) previously deleted queued imports were discarded." }
            else { status = imageFailures == 0 ? "Saved. Open Local Reader to sync and listen." : "Article saved. \(imageFailures) images were unavailable. Open Local Reader to sync and listen." }
        } catch { canRetry = true; status = "\(error.localizedDescription) This import stays in the share extension; use Retry or share another article when online." }
        busy = false
    }
}
private struct ShareView: View {
    @ObservedObject var model: ShareModel
    let close: () -> Void
    var body: some View {
        NavigationStack {
            Form {
                if !model.title.isEmpty { Text(model.title).font(.headline) }
                Section { if model.busy { ProgressView() }; Text(model.status) }
                if model.needsPairing {
                    Section("Connect sharing") {
                        SecureField("Pairing link", text: $model.pairingLink).textInputAutocapitalization(.never).autocorrectionDisabled()
                        if let host = model.pairingHost { Text("Import to \(host)").font(.footnote) }
                        Button("Connect and import", action: model.connect).disabled(model.pairingHost == nil)
                    }
                }
                if model.canRetry { Button("Retry", action: model.retry) }
            }
            .navigationTitle("Local Reader")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: close) } }
        }
    }
}
