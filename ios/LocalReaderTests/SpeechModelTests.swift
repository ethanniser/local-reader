import XCTest
@testable import LocalReader

private actor ControlledSpeechBackend: PocketSpeechBackend {
    let started: XCTestExpectation
    private var continuation: CheckedContinuation<Void, Error>?
    init(_ started: XCTestExpectation) { self.started = started }
    func initialize() async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation; started.fulfill()
        }
    }
    func finish() { continuation?.resume(); continuation = nil }
    func synthesize(text: String, voice: String) async throws -> Data { Data() }
}

@MainActor final class SpeechModelTests: XCTestCase {
    func testEngineChoicePersistsAndNewInstallDefaultsToFull() {
        let name = "SpeechModelTests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let player = ReaderPlayer(preferences: defaults)
        XCTAssertEqual(player.engine, .fullPocket)
        player.engine = .pocket
        XCTAssertEqual(ReaderPlayer(preferences: defaults).engine, .pocket)
        player.engine = .system
        XCTAssertEqual(ReaderPlayer(preferences: defaults).engine, .system)
    }

    func testLateSetupForPreviousEngineCannotMarkNewEngineReady() async throws {
        let name = "SpeechModelTests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fullStarted = expectation(description: "full started")
        let smallStarted = expectation(description: "small started")
        let full = ControlledSpeechBackend(fullStarted), small = ControlledSpeechBackend(smallStarted)
        var engines: [ReaderPlayer.VoiceEngine] = []
        let player = ReaderPlayer(preferences: defaults) { engine, _ in
            engines.append(engine); return engine == .fullPocket ? full : small
        }
        let library = LibraryStore(directory: directory); player.attach(library)
        let fullTask = Task { await player.preparePocket() }
        await fulfillment(of: [fullStarted], timeout: 2)
        XCTAssertTrue(player.isPreparing)
        player.engine = .pocket
        XCTAssertFalse(player.modelReady)
        let smallTask = Task { await player.preparePocket() }
        await fulfillment(of: [smallStarted], timeout: 2)
        await full.finish(); await fullTask.value
        XCTAssertFalse(player.modelReady)
        XCTAssertTrue(player.isPreparing)
        XCTAssertTrue(player.modelStatus.contains("18M"))
        await small.finish(); await smallTask.value
        XCTAssertTrue(player.modelReady)
        XCTAssertFalse(player.isPreparing)
        XCTAssertEqual(engines, [.fullPocket, .pocket])
        player.engine = .system
        XCTAssertFalse(player.modelReady)
        await player.preparePocket()
        XCTAssertEqual(engines.count, 2)
    }

    func testSwitchBeforeQueuedSetupStartsDoesNotCreateStaleBackend() async {
        let name = "SpeechModelTests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let neverStarted = XCTestExpectation(description: "cancelled setup never starts")
        neverStarted.isInverted = true
        let backend = ControlledSpeechBackend(neverStarted)
        var count = 0
        let player = ReaderPlayer(preferences: defaults) { _, _ in count += 1; return backend }
        let library = LibraryStore(directory: directory); player.attach(library)
        let queued = player.startPocketPreparation()
        player.engine = .system
        await queued?.value
        XCTAssertEqual(count, 0)
        XCTAssertFalse(player.isPreparing)
        XCTAssertFalse(player.modelReady)
    }

    func testConcurrentPreparationSharesOneInitialization() async throws {
        let name = "SpeechModelTests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let started = expectation(description: "setup started")
        let backend = ControlledSpeechBackend(started)
        var count = 0
        let player = ReaderPlayer(preferences: defaults) { _, _ in count += 1; return backend }
        let library = LibraryStore(directory: directory); player.attach(library)
        let first = Task { await player.preparePocket() }
        await fulfillment(of: [started], timeout: 2)
        let second = Task { await player.preparePocket() }
        await Task.yield()
        await backend.finish()
        await first.value; await second.value
        XCTAssertEqual(count, 1)
        XCTAssertTrue(player.modelReady)
    }
}
