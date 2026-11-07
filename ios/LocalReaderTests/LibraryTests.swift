import XCTest
@testable import LocalReader

@MainActor final class LibraryTests: XCTestCase {
    func testTextImportPreservesParagraphOffsets() {
        let article = Article(title: "Story", text: "First paragraph.\n\nSecond paragraph here.", tags: ["Travel", "travel", " Food "])
        XCTAssertEqual(article.words, ["First", "paragraph.", "Second", "paragraph", "here."])
        XCTAssertEqual(article.paragraphs.map(\.start), [0, 2])
        XCTAssertEqual(article.paragraphs.map(\.end), [2, 5])
        XCTAssertEqual(article.tags, ["food", "travel"])
    }
    func testOfflineProgressAndTagsSurviveRestart() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = LibraryStore(directory: dir)
        let article = try XCTUnwrap(store.add(title: "Story", text: "One two three four five", tags: ""))
        store.setPosition(3, for: article.id); store.setTags("Listen, travel", for: article.id)
        let restored = LibraryStore(directory: dir)
        let saved = try XCTUnwrap(restored.article(article.id))
        XCTAssertEqual(saved.position, 3)
        XCTAssertEqual(saved.tags, ["listen", "travel"])
        XCTAssertGreaterThan(saved.updated, 0)
        XCTAssertGreaterThan(saved.metadataUpdated, 0)
    }
    func testLegacyArticleDecodesWithoutNewFields() throws {
        let data = Data(#"{"id":"legacy","title":"Old story","words":["one","two"],"position":999}"#.utf8)
        let article = try JSONDecoder().decode(Article.self, from: data)
        XCTAssertEqual(article.position, 1)
        XCTAssertEqual(article.tags, [])
        XCTAssertEqual(article.images, [])
    }
    func testPausedPlayerAdoptsNewerRemotePosition() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let library = LibraryStore(directory: dir)
        let article = try XCTUnwrap(library.add(title: "Story", text: "One two three four five six seven eight", tags: ""))
        let player = ReaderPlayer(); player.attach(library); player.engine = .system
        player.play(article, at: 1); player.pause()
        library.setPosition(5, for: article.id)
        player.resume()
        XCTAssertEqual(player.position, 5)
        player.pause(); player.stop()
        XCTAssertEqual(library.article(article.id)?.position, 5)
    }
    func testDeletedArticleCannotResumeFromRetainedPlayer() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let library = LibraryStore(directory: dir)
        let article = try XCTUnwrap(library.add(title: "Story", text: "One two three four five", tags: ""))
        let player = ReaderPlayer(); player.attach(library); player.engine = .system
        player.play(article); player.pause()
        library.setLifecycle(for: article.id, archived: false, deleted: true)
        player.resume(); player.skip(40); player.play(article)
        XCTAssertNil(player.articleID); XCTAssertFalse(player.isPlaying)
        XCTAssertTrue(library.article(article.id)!.words.isEmpty)
    }
    func testMetadataAndProgressMergeIndependently() {
        var local = Article(title: "Story", text: "One two three four five")
        var remote = local
        local.position = 3; local.updated = 200; local.metadataUpdated = 100
        remote.position = 1; remote.updated = 150; remote.tags = ["new"]; remote.metadataUpdated = 300
        let merged = local.merging(remote)
        XCTAssertEqual(merged.position, 3)
        XCTAssertEqual(merged.updated, 200)
        XCTAssertEqual(merged.tags, ["new"])
    }
    func testSyncRejectsUnsafeOrMissingConfiguration() {
        for address in ["http://example.org", "file:///etc/passwd", "https://user:pass@example.org", ""] {
            XCTAssertThrowsError(try SyncClient(configuration: SyncConfiguration(siteURL: address), token: "test"))
        }
        XCTAssertThrowsError(try SyncClient(configuration: SyncConfiguration(siteURL: "https://example.org"), token: ""))
    }
}
