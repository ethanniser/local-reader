import Foundation
import FluidAudio

@main struct PocketSmoke {
    static func main() async throws {
        let destination = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "/tmp/local-reader-native-model-smoke", isDirectory: true)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let manager = PocketTtsSmallManager(model: .english18m, computeUnits: .cpuAndNeuralEngine)
        try await manager.initialize(directory: destination.appendingPathComponent("models", isDirectory: true))
        let result = try await manager.synthesize(text: "Your local reader works on this device.", voice: "alba")
        guard result.count > 1000, result.prefix(4) == Data("RIFF".utf8) else { fatalError("Expected nonempty WAV output") }
        try result.write(to: destination.appendingPathComponent("speech.wav"))
        print("Pocket18M native smoke passed: \(result.count) WAV bytes written to \(destination.appendingPathComponent("speech.wav").path)")
    }
}
