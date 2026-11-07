import Foundation
import CoreGraphics
import ImageIO

@main struct CoreChecks {
    @MainActor static func main() throws {
        let article = Article(title: "Story", text: "First paragraph.\n\nSecond paragraph here.", tags: ["Travel", "travel", " Food "])
        precondition(article.words == ["First", "paragraph.", "Second", "paragraph", "here."])
        precondition(article.paragraphs.map(\.start) == [0, 2])
        precondition(article.tags == ["food", "travel"])
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = LibraryStore(directory: dir)
        let item = store.add(title: "Story", text: "One two three four five", tags: "")!
        store.setPosition(3, for: item.id); store.setTags("Listen, travel", for: item.id)
        let restored = LibraryStore(directory: dir).article(item.id)!
        precondition(restored.position == 3 && restored.tags == ["listen", "travel"])
        store.setUnread(false, for: item.id)
        store.setPosition(4, for: item.id)
        let read = LibraryStore(directory: dir).article(item.id)!
        precondition(!read.unread && read.position == 4 && read.readUpdated > 0)
        let snapshotURL = dir.appendingPathComponent("library.json")
        var snapshot = try JSONSerialization.jsonObject(with: Data(contentsOf: snapshotURL)) as! [String: Any]
        precondition((snapshot["readDirty"] as? [String]) == [item.id])
        snapshot.removeValue(forKey: "readDirty")
        snapshot.removeValue(forKey: "formattingVersion")
        try JSONSerialization.data(withJSONObject: snapshot).write(to: snapshotURL)
        let oldStore = LibraryStore(directory: dir)
        precondition(oldStore.articles.count == 1)
        oldStore.persist()
        var migrated = try JSONSerialization.jsonObject(with: Data(contentsOf: snapshotURL)) as! [String: Any]
        precondition((migrated["formattingRefresh"] as? [String]) == [item.id])
        migrated["formattingVersion"] = 1; migrated["formattingRefresh"] = []
        try JSONSerialization.data(withJSONObject: migrated).write(to: snapshotURL)
        LibraryStore(directory: dir).persist()
        let quoteUpgrade = try JSONSerialization.jsonObject(with: Data(contentsOf: snapshotURL)) as! [String: Any]
        precondition((quoteUpgrade["formattingRefresh"] as? [String]) == [item.id] && (quoteUpgrade["formattingVersion"] as? Int) == 2)
        let data = Data(#"{"id":"legacy","title":"Old story","words":["one","two"],"position":999}"#.utf8)
        let legacy = try JSONDecoder().decode(Article.self, from: data)
        precondition(legacy.position == 1 && legacy.images.isEmpty && legacy.unread && legacy.readUpdated == 0 && !legacy.deleted && !legacy.archived && legacy.lifecycleUpdated == 0)
        for address in ["http://example.org", "file:///etc/passwd", "https://user:pass@example.org", ""] {
            do { _ = try SyncClient(configuration: SyncConfiguration(siteURL: address), token: "test"); preconditionFailure("Unsafe URL accepted") }
            catch {}
        }
        var local = article, remote = article
        local.position = 3; local.updated = 200; local.metadataUpdated = 100
        remote.position = 1; remote.updated = 150; remote.tags = ["new"]; remote.metadataUpdated = 300
        let merged = local.merging(remote)
        precondition(merged.position == 3 && merged.updated == 200 && merged.tags == ["new"])
        local.unread = false; local.readUpdated = 400
        remote.unread = true; remote.readUpdated = 300; remote.contentUpdated = local.contentUpdated + 1
        precondition(!local.merging(remote).unread)
        remote.readUpdated = 500
        let marked = local.merging(remote)
        precondition(marked.unread && marked.readUpdated == 500 && marked.position == 3)
        let imported = try ArticleImport.html("<html><head><title>Title &amp; more</title></head><article><div>Hello <b><i>world</i></b>.</div><div>Next <a href='/safe'>paragraph</a><script>bad()</script></div></article></html>", source: URL(string: "https://example.com/story")!)
        precondition(imported.words == ["Hello", "world.", "Next", "paragraph"])
        precondition(imported.paragraphs.count == 2 && imported.marks.contains { $0.kind == "bold" && $0.start == 1 && $0.end == 2 })
        let quoted = try ArticleImport.html("<article><p>Before quote.</p><blockquote><p>First quoted paragraph.</p><p>Second <b>quoted</b> paragraph.</p><blockquote><p>Nested quote.</p></blockquote></blockquote><p>After quote.</p></article>", source: URL(string: "https://example.com/story")!)
        precondition(quoted.paragraphs.map(\.kind) == ["paragraph", "blockquote", "blockquote", "blockquote", "paragraph"])
        precondition(quoted.words.joined(separator: " ") == "Before quote. First quoted paragraph. Second quoted paragraph. Nested quote. After quote.")
        precondition(quoted.marks.contains { $0.kind == "bold" && $0.start == 6 && $0.end == 7 })
        precondition(imported.marks.contains { $0.kind == "link" && $0.href == "https://example.com/safe" })
        precondition(ArticleMark.safeLink("javascript:alert(1)") == nil)
        precondition(ArticleMark.safeLink("https://user:pass@example.com") == nil)
        precondition(ArticleMark.safeLink("https://example.com/\n") == nil)
        var markedObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(article)) as! [String: Any]
        markedObject["marks"] = [["start": -1, "end": 100, "kind": "bold"], ["start": 0, "end": 1, "kind": "link", "href": "javascript:bad()"]]
        let sanitized = try JSONDecoder().decode(Article.self, from: JSONSerialization.data(withJSONObject: markedObject))
        precondition(sanitized.marks.isEmpty)
        precondition(legacy.marks.isEmpty)
        let rejectedDelete = try JSONDecoder().decode(SyncClient.LifecycleReceipt.self, from: Data(#"{"archived":true,"deleted":false,"lifecycleUpdated":200}"#.utf8))
        let acceptedDelete = try JSONDecoder().decode(SyncClient.LifecycleReceipt.self, from: Data(#"{"archived":false,"deleted":true,"lifecycleUpdated":201}"#.utf8))
        precondition(!rejectedDelete.deleted && rejectedDelete.lifecycleUpdated == 200 && acceptedDelete.deleted)
        let tombstoneManifest = Data(#"{"documents":[{"id":"deleted-before-upload","updated":0,"metadataUpdated":0,"contentUpdated":0,"archived":false,"deleted":true,"lifecycleUpdated":10}]}"#.utf8)
        let tombstoneList = try JSONDecoder().decode(RemoteLibrary.self, from: tombstoneManifest)
        precondition(tombstoneList.documents.first?.deleted == true)
        var archived = article, active = article
        archived.archived = true; archived.lifecycleUpdated = 10
        active.updated = archived.updated + 100; active.lifecycleUpdated = 0
        precondition(archived.merging(active).archived)
        var tombstone = archived; tombstone.deleted = true; tombstone.lifecycleUpdated = 20
        active.lifecycleUpdated = 100; active.archived = false
        precondition(tombstone.merging(active).deleted && active.merging(tombstone).deleted)
        tombstone.words = []; tombstone.paragraphs = []
        active.contentUpdated = tombstone.contentUpdated + 1
        let inFlightAfterDelete = tombstone.merging(active)
        precondition(inFlightAfterDelete.deleted && inFlightAfterDelete.words.isEmpty && inFlightAfterDelete.images.isEmpty && inFlightAfterDelete.title == "Deleted article")
        store.setLifecycle(for: item.id, archived: true)
        precondition(LibraryStore(directory: dir).article(item.id)!.archived)
        store.setLifecycle(for: item.id, archived: false, deleted: true)
        store.setPosition(2, for: item.id); store.setUnread(true, for: item.id); store.setLifecycle(for: item.id, archived: false)
        let removed = LibraryStore(directory: dir).article(item.id)!
        precondition(removed.deleted && removed.words.isEmpty && removed.position == 0)
        let removedSnapshot = try JSONSerialization.jsonObject(with: Data(contentsOf: snapshotURL)) as! [String: Any]
        precondition((removedSnapshot["lifecycleDirty"] as? [String]) == [item.id])
        for key in ["contentDirty", "tagsDirty", "progressDirty", "readDirty"] { precondition((removedSnapshot[key] as? [String])?.isEmpty == true) }
        precondition(RasterImage.thumbnail(Data("not an image".utf8)) == nil)
        let canvas = CGContext(data: nil, width: 2, height: 2, bitsPerComponent: 8, bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        let png = NSMutableData()
        let encoder = CGImageDestinationCreateWithData(png, "public.png" as CFString, 1, nil)!
        CGImageDestinationAddImage(encoder, canvas.makeImage()!, nil)
        precondition(CGImageDestinationFinalize(encoder))
        precondition(RasterImage.thumbnail(png as Data) != nil)
        print("Native core checks passed: article structure, offline persistence, tag normalization, legacy decoding, HTTPS configuration.")
    }
}
