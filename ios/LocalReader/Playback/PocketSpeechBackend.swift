import Foundation
import CoreML
import FluidAudio

/// A separate instance per selected model prevents readiness and synthesis crossing engines.
protocol PocketSpeechBackend: Sendable {
    func initialize() async throws
    func synthesize(text: String, voice: String) async throws -> Data
}

struct FullPocketSpeechBackend: PocketSpeechBackend {
    let manager: PocketTtsManager
    init(directory: URL) {
        // Match the Mac's April 2026 checkpoint and temperature. Explicit routing
        // keeps all speech stages off the GPU, including conditioner defaults.
        manager = PocketTtsManager(language: .english2026Apr, directory: directory, placement: .ane,
            computeUnits: PocketTtsComputeUnits(conditioner: .cpuAndNeuralEngine,
                flowLM: .cpuAndNeuralEngine, flowDecoder: .cpuAndNeuralEngine,
                mimiDecoder: .cpuOnly, mimiEncoder: .cpuOnly))
    }
    func initialize() async throws { try await manager.initialize() }
    func synthesize(text: String, voice: String) async throws -> Data {
        try await manager.synthesize(text: text, voice: voice, temperature: 0.3)
    }
}

struct SmallPocketSpeechBackend: PocketSpeechBackend {
    let directory: URL
    let manager = PocketTtsSmallManager(model: .english18m, computeUnits: .cpuAndNeuralEngine)
    func initialize() async throws { try await manager.initialize(directory: directory) }
    func synthesize(text: String, voice: String) async throws -> Data {
        try await manager.synthesize(text: text, voice: voice)
    }
}
