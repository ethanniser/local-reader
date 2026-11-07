import Foundation
import Combine
import CryptoKit

@MainActor final class LibraryStore: ObservableObject {
    static let shared = LibraryStore()
    @Published private(set) var articles: [Article] = []
    @Published var configuration = SyncConfiguration()
    @Published var syncStatus = "On this device"
    @Published var isSyncing = false
    @Published var error: String?
    private var contentDirty: Set<String> = [], tagsDirty: Set<String> = [], progressDirty: Set<String> = [], readDirty: Set<String> = [], lifecycleDirty: Set<String> = []
    private var formattingRefresh: Set<String> = []
    private var syncTask: Task<Void, Never>?
    private var activeSyncTask: Task<Void, Never>?
    private var syncGeneration = UUID()
    let directory: URL
    private struct Snapshot: Codable {
        var articles: [Article]; var configuration: SyncConfiguration
        var contentDirty: Set<String>; var tagsDirty: Set<String>; var progressDirty: Set<String>; var readDirty: Set<String>?; var lifecycleDirty: Set<String>?
        var formattingVersion: Int?; var formattingRefresh: Set<String>?
    }
    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("LocalReader", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
            #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: self.directory.path)
            #endif
            let path = self.directory.appendingPathComponent("library.json")
            if FileManager.default.fileExists(atPath: path.path) {
                let saved = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: path))
                articles = saved.articles; configuration = saved.configuration
                contentDirty = saved.contentDirty; tagsDirty = saved.tagsDirty; progressDirty = saved.progressDirty; readDirty = saved.readDirty ?? []; lifecycleDirty = saved.lifecycleDirty ?? []
                formattingRefresh = saved.formattingRefresh ?? []
                if (saved.formattingVersion ?? 0) < 2 { formattingRefresh.formUnion(articles.map(\.id)) }
            }
            if !configuration.siteURL.isEmpty, !CredentialStore.read().isEmpty { try? SharedConnection.save(SharedConnection(address: configuration.siteURL, token: CredentialStore.read())) }
        } catch { self.error = "Could not open the local library: \(error.localizedDescription)" }
    }
    func article(_ id: String) -> Article? { articles.first { $0.id == id } }
    var allTags: [String] { Array(Set(articles.filter { !$0.deleted }.flatMap(\.tags))).sorted() }
    var isConfigured: Bool { !configuration.siteURL.isEmpty && !CredentialStore.read().isEmpty }
    func add(title: String, text: String, tags: String) -> Article? {
        let article = Article(title: title.trimmingCharacters(in: .whitespacesAndNewlines), text: text, tags: tags.components(separatedBy: ","))
        guard !article.title.isEmpty, !article.words.isEmpty else { error = "Add a title and some text first."; return nil }
        guard article.title.utf16.count <= 300 else { error = "Keep the title under 300 characters."; return nil }
        guard article.tags.count <= 20 else { error = "Use at most 20 tags."; return nil }
        guard !article.words.contains(where: { $0.utf16.count > 10000 }) else { error = "This text contains a word or link that is too long to sync."; return nil }
        guard article.words.count <= 250000 else { error = "Please split articles larger than 250,000 words."; return nil }
        articles.insert(article, at: 0); contentDirty.insert(article.id); persist(); scheduleSync(); return article
    }
    func addImported(_ article: Article) throws {
        guard !article.title.isEmpty, article.title.utf16.count <= 300, !article.words.isEmpty, article.words.count <= 250000,
              article.words.allSatisfy({ $0.utf16.count <= 10000 }) else { throw SyncError.message("This article is empty or too large.") }
        guard try JSONEncoder().encode(article).count <= 20 * 1024 * 1024 else { throw SyncError.message("This article is too large to sync.") }
        articles.insert(article, at: 0); contentDirty.insert(article.id); persist(); scheduleSync()
    }
    func setTags(_ values: String, for id: String) {
        guard let i = articles.firstIndex(where: {$0.id == id}), !articles[i].deleted else { return }
        let normalized = Article.normalizeTags(values.components(separatedBy: ","))
        guard normalized.count <= 20 else { error = "Use at most 20 tags."; return }
        articles[i].tags = normalized
        articles[i].metadataUpdated = Date().timeIntervalSince1970; tagsDirty.insert(id); persist(); scheduleSync()
    }
    func setLifecycle(for id: String, archived: Bool, deleted: Bool = false) {
        guard let index = articles.firstIndex(where: { $0.id == id }), !articles[index].deleted else { return }
        guard articles[index].archived != archived || deleted else { return }
        articles[index].archived = archived; articles[index].deleted = deleted
        articles[index].lifecycleUpdated = max(Date().timeIntervalSince1970, articles[index].lifecycleUpdated + 0.001)
        lifecycleDirty.insert(id)
        if deleted { discardContentWrites(id); scrubDeleted(index) }
        persist(); scheduleSync()
    }
    private func scrubDeleted(_ index: Int) {
        articles[index].title = "Deleted article"; articles[index].source = ""
        articles[index].words = []; articles[index].paragraphs = []; articles[index].images = []; articles[index].marks = []; articles[index].tags = []; articles[index].position = 0
    }
    private func discardContentWrites(_ id: String) {
        contentDirty.remove(id); tagsDirty.remove(id); progressDirty.remove(id); readDirty.remove(id); formattingRefresh.remove(id)
    }
    private func applyTombstone(_ item: RemoteArticle) {
        guard item.deleted == true else { return }
        if let index = articles.firstIndex(where: { $0.id == item.id }) {
            articles[index].deleted = true; articles[index].archived = item.archived ?? false
            articles[index].lifecycleUpdated = max(articles[index].lifecycleUpdated, item.lifecycleUpdated ?? 0)
            scrubDeleted(index)
        } else {
            var value = Article(id: item.id, title: "Deleted article", text: "")
            value.deleted = true; value.archived = item.archived ?? false; value.lifecycleUpdated = item.lifecycleUpdated ?? 0
            value.updated = 0; value.metadataUpdated = 0; value.contentUpdated = 0; value.readUpdated = 0
            articles.append(value)
        }
        discardContentWrites(item.id); lifecycleDirty.remove(item.id)
    }
    private func writeHandlingDeletion(id: String, client: SyncClient, generation: UUID, operation: () async throws -> Void) async throws -> Bool {
        try checkSync(generation)
        do { try await operation(); try checkSync(generation); return true }
        catch SyncError.http(404) {
            try checkSync(generation); let latest = try await client.library(); try checkSync(generation)
            guard let tombstone = latest.documents.first(where: { $0.id == id && $0.deleted == true }) else { throw SyncError.http(404) }
            applyTombstone(tombstone); persist(); return false
        }
    }
    private func fetchHandlingDeletion(id: String, client: SyncClient, generation: UUID) async throws -> Article? {
        try checkSync(generation)
        do { let result = try await client.article(id); try checkSync(generation); return result }
        catch SyncError.http(404) {
            try checkSync(generation); let latest = try await client.library(); try checkSync(generation)
            guard let tombstone = latest.documents.first(where: { $0.id == id && $0.deleted == true }) else { throw SyncError.http(404) }
            applyTombstone(tombstone); persist(); return nil
        }
    }
    func setUnread(_ unread: Bool, for id: String) {
        guard let i = articles.firstIndex(where: { $0.id == id }), !articles[i].deleted, articles[i].unread != unread else { return }
        articles[i].unread = unread
        articles[i].readUpdated = max(Date().timeIntervalSince1970, articles[i].readUpdated + 0.001)
        readDirty.insert(id); persist(); scheduleSync()
    }
    func setPosition(_ position: Int, for id: String) {
        guard let i = articles.firstIndex(where: {$0.id == id}), !articles[i].deleted else { return }
        let value = max(0, min(max(0, articles[i].words.count - 1), position))
        guard articles[i].position != value else { return }
        articles[i].position = value; articles[i].updated = Date().timeIntervalSince1970
        progressDirty.insert(id); persist(); scheduleSync()
    }
    func configure(address: String, token: String) throws {
        let config = SyncConfiguration(siteURL: address.trimmingCharacters(in: .whitespacesAndNewlines))
        _ = try SyncClient(configuration: config, token: token)
        // Update shared pairing first; failure leaves both app and extension on the old account.
        if SharedConnection.group != nil { try SharedConnection.save(SharedConnection(address: config.siteURL, token: token)) }
        do { try CredentialStore.save(token) }
        catch { try? SharedConnection.save(nil); throw error }
        invalidateSync(); configuration = config
        contentDirty.formUnion(articles.filter { !$0.deleted }.map(\.id)); persist(); scheduleSync()
    }
    @discardableResult func disconnect() -> Bool {
        do {
            if SharedConnection.group != nil { try SharedConnection.save(nil) }
            try CredentialStore.save("")
            invalidateSync(); configuration = SyncConfiguration(); persist(); syncStatus = "On this device"; return true
        } catch { self.error = error.localizedDescription; return false }
    }
    private func invalidateSync() {
        syncGeneration = UUID(); syncTask?.cancel(); syncTask = nil
        activeSyncTask?.cancel(); activeSyncTask = nil; isSyncing = false
    }
    private func checkSync(_ generation: UUID) throws {
        try Task.checkCancellation()
        guard generation == syncGeneration else { throw CancellationError() }
    }
    func persist() {
        do {
            let data = try JSONEncoder().encode(Snapshot(articles: articles, configuration: configuration, contentDirty: contentDirty, tagsDirty: tagsDirty, progressDirty: progressDirty, readDirty: readDirty, lifecycleDirty: lifecycleDirty, formattingVersion: 2, formattingRefresh: formattingRefresh))
            try data.write(to: directory.appendingPathComponent("library.json"), options: .atomic)
            #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.appendingPathComponent("library.json").path)
            #endif
        } catch { self.error = "Could not save this device's library: \(error.localizedDescription)" }
    }
    func scheduleSync() {
        guard isConfigured, syncTask == nil else { return }
        let generation = syncGeneration
        syncTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled, let self else { return }
            guard generation == self.syncGeneration else { return }
            await self.sync(); if generation == self.syncGeneration { self.syncTask = nil }
        }
    }
    func sync() async {
        guard isConfigured, activeSyncTask == nil else { return }
        let generation = syncGeneration
        let task = Task<Void, Never> { [weak self] in guard let self else { return }; await self.performSync(generation: generation) }
        activeSyncTask = task
        await activeSyncTask?.value
        if generation == syncGeneration { activeSyncTask = nil }
    }
    private func performSync(generation: UUID) async {
        guard generation == syncGeneration, isConfigured else { return }
        isSyncing = true; syncStatus = "Syncing…"
        defer { if generation == syncGeneration { isSyncing = false } }
        do {
            try checkSync(generation)
            let client = try SyncClient(configuration: configuration, token: CredentialStore.read())
            // Consume cloud tombstones before any older queued writes.
            let initial = try await client.library(); try checkSync(generation)
            for item in initial.documents {
                if item.deleted == true { applyTombstone(item); continue }
                if lifecycleDirty.contains(item.id), let index = articles.firstIndex(where: { $0.id == item.id }), articles[index].deleted,
                   (item.lifecycleUpdated ?? 0) >= articles[index].lifecycleUpdated {
                    // Preserve an explicit pending delete after learning of a newer archive edit.
                    articles[index].lifecycleUpdated = max(Date().timeIntervalSince1970, (item.lifecycleUpdated ?? 0) + 0.001)
                }
            }
            persist()
            for id in Array(lifecycleDirty) {
                guard let value = article(id), value.deleted else { continue }
                try checkSync(generation); let receipt = try await client.lifecycle(value); try checkSync(generation)
                if receipt.deleted { lifecycleDirty.remove(id) }
                else if let index = articles.firstIndex(where: { $0.id == id }), articles[index].deleted {
                    // A concurrent archive may have won after the initial manifest. Keep the delete queued.
                    articles[index].lifecycleUpdated = max(articles[index].lifecycleUpdated, max(Date().timeIntervalSince1970, receipt.lifecycleUpdated + 0.001))
                }
                persist()
            }
            for id in Array(contentDirty) {
                guard let value = article(id), !value.deleted else { continue }
                try checkSync(generation); let upload = try await prepareImageUpload(value, client: client, generation: generation); try checkSync(generation)
                guard article(id)?.deleted != true else { continue }
                let receipt = try await client.upload(upload); try checkSync(generation)
                if let tombstone = receipt.document, tombstone.deleted == true { applyTombstone(tombstone); persist(); continue }
                if let index = articles.firstIndex(where: { $0.id == id }), !articles[index].deleted, articles[index].contentUpdated == value.contentUpdated {
                    articles[index].images = upload.images; contentDirty.remove(id)
                }
            }
            for id in Array(lifecycleDirty) {
                guard let value = article(id), !value.deleted else { continue }
                _ = try await writeHandlingDeletion(id: id, client: client, generation: generation) { _ = try await client.lifecycle(value) }
                if article(id)?.lifecycleUpdated == value.lifecycleUpdated { lifecycleDirty.remove(id) }
            }
            for id in Array(tagsDirty) {
                guard let value = article(id), !value.deleted else { continue }; try checkSync(generation); _ = try await writeHandlingDeletion(id: id, client: client, generation: generation) { try await client.tags(value) }; try checkSync(generation)
                if article(id)?.metadataUpdated == value.metadataUpdated { tagsDirty.remove(id) }
            }
            for id in Array(progressDirty) {
                guard let value = article(id), !value.deleted else { continue }; try checkSync(generation); _ = try await writeHandlingDeletion(id: id, client: client, generation: generation) { try await client.progress(value) }; try checkSync(generation)
                if article(id)?.updated == value.updated { progressDirty.remove(id) }
            }
            for id in Array(readDirty) {
                guard let value = article(id), !value.deleted else { continue }
                try checkSync(generation); _ = try await writeHandlingDeletion(id: id, client: client, generation: generation) { try await client.readStatus(value) }; try checkSync(generation)
                if article(id)?.readUpdated == value.readUpdated { readDirty.remove(id) }
            }
            try checkSync(generation); let manifest = try await client.library(); try checkSync(generation)
            for item in manifest.documents {
                if item.deleted == true { applyTombstone(item); persist(); continue }
                let local = article(item.id)
                if local?.deleted == true { continue }
                guard formattingRefresh.contains(item.id) || local == nil || item.contentUpdated > local!.contentUpdated || item.metadataUpdated > local!.metadataUpdated || item.updated > local!.updated || (item.readUpdated ?? 0) > local!.readUpdated || (item.lifecycleUpdated ?? 0) > local!.lifecycleUpdated else { continue }
                try checkSync(generation); guard let remote = try await fetchHandlingDeletion(id: item.id, client: client, generation: generation) else { continue }; try checkSync(generation)
                if article(remote.id)?.deleted == true { continue }
                if let index = articles.firstIndex(where: {$0.id == remote.id}) {
                    let refreshMarks = formattingRefresh.contains(remote.id) && articles[index].contentUpdated == remote.contentUpdated
                    articles[index] = articles[index].merging(remote)
                    if refreshMarks { articles[index].marks = remote.marks; articles[index].paragraphs = remote.paragraphs }
                } else { articles.insert(remote, at: 0) }
                formattingRefresh.remove(remote.id); persist()
            }
            for value in articles where !value.deleted { try checkSync(generation); await cacheImages(value, client: client, generation: generation); try checkSync(generation) }
            persist(); error = nil; syncStatus = lifecycleDirty.contains(where: { article($0)?.deleted == true }) ? "Delete pending · retrying next sync" : "Synced \(Date().formatted(date: .omitted, time: .shortened))"
        } catch { guard generation == syncGeneration, !(error is CancellationError) else { return }; syncStatus = "Offline · changes saved here"; self.error = error.localizedDescription; persist() }
    }
    func cacheImportedImages(_ article: Article) async {
        var byteCount = 0
        let deadline = Date().addingTimeInterval(15)
        for image in article.images.prefix(20) where imageURL(image) == nil {
            guard Date() < deadline, byteCount < 30 * 1024 * 1024 else { break }
            do { let data = try await ImportImages.png(image.src); guard byteCount + data.count <= 30 * 1024 * 1024 else { break }; byteCount += data.count; try saveImage(data, source: image.src) } catch { /* Imported text remains available. */ }
        }
        objectWillChange.send()
    }
    private func saveImage(_ data: Data, source: String) throws {
        let folder = directory.appendingPathComponent("Images", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let key = SHA256.hash(data: Data(source.utf8)).map { String(format: "%02x", $0) }.joined()
        try data.write(to: folder.appendingPathComponent(key), options: .atomic)
    }
    private func prepareImageUpload(_ article: Article, client: SyncClient, generation: UUID) async throws -> Article {
        var result = article; result.images = []
        let deadline = Date().addingTimeInterval(15)
        var byteCount = 0
        for image in article.images.prefix(20) {
            if let url = URL(string: image.src, relativeTo: client.base), url.host == client.base.host, url.path == "/images" { result.images.append(image); continue }
            guard Date() < deadline, byteCount < 30 * 1024 * 1024 else { continue }
            do {
                let data: Data
                if let local = imageURL(image) { data = try Data(contentsOf: local) }
                else { data = try await ImportImages.png(image.src); try checkSync(generation); try saveImage(data, source: image.src) }
                guard byteCount + data.count <= 30 * 1024 * 1024 else { continue }
                byteCount += data.count
                try checkSync(generation)
                let response = try await client.request("images", method: "POST", body: data, contentType: "image/png")
                try checkSync(generation)
                struct Saved: Decodable { var url: String }
                var saved = image; saved.src = try JSONDecoder().decode(Saved.self, from: response).url
                try saveImage(data, source: saved.src)
                result.images.append(saved)
            } catch { try checkSync(generation) /* Optional image failure must not block text upload. */ }
        }
        return result
    }
    func imageURL(_ image: ArticleImage) -> URL? {
        let key = SHA256.hash(data: Data(image.src.utf8)).map { String(format: "%02x", $0) }.joined()
        let url = directory.appendingPathComponent("Images", isDirectory: true).appendingPathComponent(key)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }
    private func cacheImages(_ article: Article, client: SyncClient, generation: UUID) async {
        let folder = directory.appendingPathComponent("Images", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for image in article.images.prefix(20) where imageURL(image) == nil {
            guard let parsed = URL(string: image.src, relativeTo: client.base), parsed.host == client.base.host, parsed.path == "/images" else { continue }
            do {
                try checkSync(generation)
                let data = try await client.request(parsed.path + (parsed.query.map { "?" + $0 } ?? ""))
                try checkSync(generation)
                guard data.count <= 5 * 1024 * 1024 else { continue }
                let valid = await Task.detached(priority: .utility) { RasterImage.thumbnail(data) != nil }.value
                try checkSync(generation)
                guard valid else { continue }
                let key = SHA256.hash(data: Data(image.src.utf8)).map { String(format: "%02x", $0) }.joined()
                try data.write(to: folder.appendingPathComponent(key), options: .atomic)
            } catch { /* Text remains available if an image cannot be downloaded. */ }
        }
    }
}
