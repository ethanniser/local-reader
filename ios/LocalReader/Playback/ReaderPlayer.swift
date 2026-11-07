import Foundation
import Combine
import AVFoundation
import MediaPlayer
import FluidAudio

@MainActor final class ReaderPlayer: NSObject, ObservableObject, AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
    enum VoiceEngine: String, CaseIterable, Identifiable {
        case fullPocket = "Pocket full · on device", pocket = "Pocket 18M · on device", system = "Apple voice"
        var id: String { rawValue }
        var modelName: String { self == .fullPocket ? "Pocket full" : "Pocket 18M" }
    }
    @Published var engine: VoiceEngine {
        didSet {
            guard engine != oldValue else { return }
            preferences.set(engine.rawValue, forKey: "reader.voiceEngine")
            stop()
            modelID = UUID(); preparation?.cancel(); preparation = nil; backend = nil
            modelReady = false; isPreparing = false
            modelStatus = "Load or download \(engine.modelName) for offline speech"
            status = "Selected \(engine.rawValue)"
        }
    }
    @Published var voice = "alba"
    @Published var rate: Float = 1 { didSet { audio?.rate = rate; updateNowPlaying() } }
    @Published private(set) var articleID: String?
    @Published private(set) var position = 0
    @Published private(set) var isPlaying = false
    @Published private(set) var isPreparing = false
    @Published private(set) var modelReady = false
    @Published private(set) var status = "Ready when you are"
    @Published private(set) var modelStatus = "Download Pocket once for offline speech"
    private let preferences: UserDefaults
    private let makeBackend: (VoiceEngine, URL) -> any PocketSpeechBackend
    private var backend: (any PocketSpeechBackend)?
    private var preparation: Task<Void, Never>?
    private var modelID = UUID()
    private let synthesizer = AVSpeechSynthesizer()
    private var audio: AVAudioPlayer?
    private var systemUtterance: AVSpeechUtterance?
    private var article: Article?
    private weak var library: LibraryStore?
    private var generation: Task<Void, Never>?
    private var prefetch: Task<Data, Error>?
    private var generationID = UUID()
    private var chunkStart = 0, chunkEnd = 0
    private var tick: Timer?
    private var lastSaved: TimeInterval = 0
    private var acceptedProgressTimestamp: Double = 0
    private var observers: [NSObjectProtocol] = []
    private var wasPlayingBeforeInterruption = false

    init(preferences: UserDefaults = .standard,
         makeBackend: @escaping (VoiceEngine, URL) -> any PocketSpeechBackend = { engine, directory in
             if engine == .fullPocket { return FullPocketSpeechBackend(directory: directory.appendingPathComponent("FullEnglishApril2026", isDirectory: true)) }
             return SmallPocketSpeechBackend(directory: directory)
         }) {
        self.preferences = preferences; self.makeBackend = makeBackend
        self.engine = preferences.string(forKey: "reader.voiceEngine").flatMap(VoiceEngine.init(rawValue:)) ?? .fullPocket
        super.init(); synthesizer.delegate = self
        let commands = MPRemoteCommandCenter.shared()
        commands.playCommand.addTarget { [weak self] _ in Task { @MainActor in self?.resume() }; return .success }
        commands.pauseCommand.addTarget { [weak self] _ in Task { @MainActor in self?.pause() }; return .success }
        commands.togglePlayPauseCommand.addTarget { [weak self] _ in Task { @MainActor in self?.toggle() }; return .success }
        commands.skipForwardCommand.preferredIntervals = [15]
        commands.skipBackwardCommand.preferredIntervals = [15]
        commands.skipForwardCommand.addTarget { [weak self] _ in Task { @MainActor in self?.skip(40) }; return .success }
        commands.skipBackwardCommand.addTarget { [weak self] _ in Task { @MainActor in self?.skip(-40) }; return .success }
        #if os(iOS)
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
            let type = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
            let options = AVAudioSession.InterruptionOptions(rawValue: notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            Task { @MainActor in
                guard let self else { return }
                if type == .began { self.wasPlayingBeforeInterruption = self.isPlaying; self.pause() }
                else if options.contains(.shouldResume), self.wasPlayingBeforeInterruption { self.resume() }
            }
        })
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] notification in
            let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { Task { @MainActor in self?.pause() } }
        })
        #endif
        tick = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in Task { @MainActor in self?.advance() } }
    }
    func attach(_ library: LibraryStore) { self.library = library }
    func preparePocket() async { await startPocketPreparation()?.value }
    // Starting is synchronous so a rapid engine switch can invalidate the queued work
    // before its task gets an execution turn; callers share that same task.
    func startPocketPreparation() -> Task<Void, Never>? {
        guard engine != .system, !modelReady else { return nil }
        if let preparation { return preparation }
        let selected = engine, id = modelID
        isPreparing = true; modelStatus = "Loading \(selected.modelName)… First setup downloads the model. Keep the app open."
        let task = Task { [weak self] in
            guard let self, !Task.isCancelled, self.modelID == id, self.engine == selected else { return }
            do {
                guard let directory = self.library?.directory else { throw CocoaError(.fileNoSuchFile) }
                var models = directory.appendingPathComponent("SpeechModels", isDirectory: true)
                try FileManager.default.createDirectory(at: models, withIntermediateDirectories: true)
                var values = URLResourceValues(); values.isExcludedFromBackup = true
                try models.setResourceValues(values)
                let backend = self.makeBackend(selected, models)
                self.backend = backend
                try await backend.initialize()
                guard !Task.isCancelled, self.modelID == id, self.engine == selected else { return }
                self.modelReady = true; self.modelStatus = "\(selected.modelName) is ready offline"
            } catch {
                guard !Task.isCancelled, self.modelID == id, self.engine == selected else { return }
                self.backend = nil
                self.modelStatus = "\(selected.modelName) setup failed: \(error.localizedDescription)"
            }
            guard self.modelID == id else { return }
            self.isPreparing = false; self.preparation = nil
        }
        preparation = task
        return task
    }
    func play(_ value: Article, at word: Int? = nil) {
        let value = library?.article(value.id) ?? value
        guard !value.deleted else { if articleID == value.id { discardDeletedArticle() }; return }
        stop(); article = value; articleID = value.id
        acceptedProgressTimestamp = value.updated
        position = max(0, min(max(0, value.words.count - 1), word ?? value.position))
        guard !value.words.isEmpty else { status = "This article has no text to speak."; return }
        library?.setPosition(position, for: value.id); acceptedProgressTimestamp = library?.article(value.id)?.updated ?? value.updated
        do { try configureAudio() } catch { status = error.localizedDescription; return }
        isPlaying = true
        if engine == .system { speakSystem(); return }
        beginPocketChunk()
    }
    private func configureAudio() throws {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        // Playback already supports AirPlay/A2DP; their explicit options are for playAndRecord.
        try session.setCategory(.playback, mode: .spokenAudio, options: [])
        try session.setActive(true)
        #endif
    }
    func toggle() { isPlaying ? pause() : resume() }
    func pause() {
        if isPlaying { savePosition() }; isPlaying = false; audio?.pause(); synthesizer.pauseSpeaking(at: .immediate)
        status = "Paused · your place is saved"; updateNowPlaying()
    }
    func resume() {
        guard !discardIfDeleted() else { return }
        adoptRemoteProgressIfPaused()
        guard article != nil else { return }
        do { try configureAudio() } catch { status = error.localizedDescription; return }
        isPlaying = true
        if let audio, audio.currentTime < audio.duration { audio.play(); status = "Playing on this device" }
        else if synthesizer.isPaused { synthesizer.continueSpeaking(); status = "Playing with Apple voice" }
        else if generation != nil { status = "Preparing speech…" }
        else if engine == .system { speakSystem() }
        else { beginPocketChunk() }
        updateNowPlaying()
    }
    func skip(_ count: Int) {
        guard let article else { return }; play(article, at: position + count)
    }
    func stop() {
        savePosition(); generationID = UUID(); generation?.cancel(); generation = nil
        prefetch?.cancel(); prefetch = nil; audio?.stop(); audio = nil
        systemUtterance = nil; synthesizer.stopSpeaking(at: .immediate); isPlaying = false; updateNowPlaying()
    }
    func discardDeletedArticle() {
        generationID = UUID(); generation?.cancel(); generation = nil; prefetch?.cancel(); prefetch = nil
        audio?.stop(); audio = nil; systemUtterance = nil; synthesizer.stopSpeaking(at: .immediate)
        isPlaying = false; article = nil; articleID = nil; position = 0; wasPlayingBeforeInterruption = false
        status = "Article deleted"; MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }
    @discardableResult private func discardIfDeleted() -> Bool {
        guard let id = articleID, library?.article(id)?.deleted == true || article?.deleted == true else { return false }
        discardDeletedArticle(); return true
    }
    private func endWord(start: Int) -> Int {
        guard let article else { return start }
        let limit = min(article.words.count, start + 32)
        for i in start..<limit where i - start >= 12 {
            if article.words[i].last.map({ ".!?".contains($0) }) == true { return i + 1 }
        }
        return limit
    }
    private func beginPocketChunk(prefetched: Task<Data, Error>? = nil) {
        guard !discardIfDeleted() else { return }
        guard let article else { return }
        let id = generationID, selected = engine, start = position, end = endWord(start: position)
        guard start < end else { finishArticle(); return }
        let text = article.words[start..<end].joined(separator: " ")
        status = "Preparing speech…"
        generation = Task { [weak self] in
            guard let self, !Task.isCancelled, self.generationID == id, self.engine == selected else { return }
            if !self.modelReady { await self.preparePocket() }
            guard !Task.isCancelled, self.generationID == id, !self.discardIfDeleted() else { return }
            guard self.modelReady, self.engine == selected, let manager = self.backend else { self.isPlaying = false; self.generation = nil; self.status = "Pocket is not ready. Open Settings to retry, or select Apple voice."; return }
            do {
                let data: Data
                if let prefetched { data = try await prefetched.value }
                else { data = try await manager.synthesize(text: text, voice: self.voice) }
                guard !Task.isCancelled, self.generationID == id, !self.discardIfDeleted() else { return }
                let player = try AVAudioPlayer(data: data)
                player.delegate = self; player.enableRate = true; player.rate = self.rate; player.prepareToPlay()
                self.audio = player; self.chunkStart = start; self.chunkEnd = end; self.generation = nil
                if self.isPlaying { player.play(); self.status = "Playing with \(selected.rawValue)" }
                self.updateNowPlaying()
                if end < article.words.count {
                    let nextEnd = self.endWord(start: end), next = article.words[end..<nextEnd].joined(separator: " "), voice = self.voice
                    self.prefetch = Task { try Task.checkCancellation(); return try await manager.synthesize(text: next, voice: voice) }
                }
            } catch {
                guard self.generationID == id else { return }
                self.isPlaying = false; self.generation = nil; self.status = "Speech stopped: \(error.localizedDescription)"; self.savePosition(); self.updateNowPlaying()
            }
        }
    }
    private func speakSystem() {
        guard !discardIfDeleted() else { return }
        guard let article else { return }
        chunkStart = position; chunkEnd = endWord(start: position)
        guard chunkStart < chunkEnd else { finishArticle(); return }
        let utterance = AVSpeechUtterance(string: article.words[chunkStart..<chunkEnd].joined(separator: " "))
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = min(AVSpeechUtteranceMaximumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * rate)
        systemUtterance = utterance; synthesizer.speak(utterance); status = "Playing with Apple voice"; updateNowPlaying()
    }
    private func advance() {
        guard !discardIfDeleted() else { return }
        guard isPlaying, let audio, audio.duration > 0 else { return }
        position = min(chunkEnd - 1, chunkStart + Int(Double(chunkEnd - chunkStart) * audio.currentTime / audio.duration))
        if Date().timeIntervalSince1970 - lastSaved >= 2 { savePosition(); updateNowPlaying() }
    }
    private func adoptRemoteProgressIfPaused() {
        guard !isPlaying, let articleID, let latest = library?.article(articleID),
              latest.updated > acceptedProgressTimestamp || latest.contentUpdated > (article?.contentUpdated ?? 0) else { return }
        generationID = UUID(); generation?.cancel(); generation = nil; prefetch?.cancel(); prefetch = nil
        audio?.stop(); audio = nil; systemUtterance = nil; synthesizer.stopSpeaking(at: .immediate)
        article = latest; position = latest.position; acceptedProgressTimestamp = latest.updated
    }
    private func savePosition() {
        guard let articleID, let latest = library?.article(articleID), !latest.deleted else { return }
        if !isPlaying && (latest.updated > acceptedProgressTimestamp || latest.contentUpdated > (article?.contentUpdated ?? 0)) { return }
        library?.setPosition(position, for: articleID)
        acceptedProgressTimestamp = library?.article(articleID)?.updated ?? latest.updated
        lastSaved = Date().timeIntervalSince1970
    }
    private func finishArticle() {
        position = max(0, (article?.words.count ?? 1) - 1); savePosition(); isPlaying = false; status = "Finished · your place is saved"; updateNowPlaying()
    }
    private func updateNowPlaying() {
        guard let article, !article.deleted, library?.article(article.id)?.deleted != true else { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil; return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [MPMediaItemPropertyTitle: article.title, MPMediaItemPropertyArtist: "Local Reader", MPMediaItemPropertyPlaybackDuration: Double(article.words.count) / 2.75, MPNowPlayingInfoPropertyElapsedPlaybackTime: Double(position) / 2.75, MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? rate : 0]
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard let self, self.audio === player, self.isPlaying else { return }
            guard flag else { self.pause(); self.audio = nil; self.status = "Audio playback failed. Press play to retry from your saved place."; return }
            self.position = self.chunkEnd; self.audio = nil; self.savePosition()
            guard self.position < (self.article?.words.count ?? 0) else { self.finishArticle(); return }
            let prepared = self.prefetch; self.prefetch = nil; self.beginPocketChunk(prefetched: prepared)
        }
    }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor [weak self] in
            guard let self, self.audio === player else { return }
            self.pause(); self.audio = nil; self.status = "Audio could not be decoded. Press play to retry."
        }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString range: NSRange, utterance: AVSpeechUtterance) {
        let prefix = (utterance.speechString as NSString).substring(to: range.location)
        let count = prefix.split(whereSeparator: { $0.isWhitespace }).count
        Task { @MainActor [weak self] in guard let self, self.isPlaying, self.systemUtterance === utterance else { return }; self.position = self.chunkStart + count; if Date().timeIntervalSince1970 - self.lastSaved >= 2 { self.savePosition(); self.updateNowPlaying() } }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self, self.isPlaying, self.engine == .system, self.systemUtterance === utterance else { return }
            self.position = self.chunkEnd; self.savePosition()
            if self.position < (self.article?.words.count ?? 0) { self.speakSystem() } else { self.finishArticle() }
        }
    }
}
