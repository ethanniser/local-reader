import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var library: LibraryStore
    @EnvironmentObject var player: ReaderPlayer
    @Environment(\.dismiss) var dismiss
    @State private var address = ""
    @State private var key = ""
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("Speech on this device") {
                    Picker("Engine", selection: $player.engine) { ForEach(ReaderPlayer.VoiceEngine.allCases) { Text($0.rawValue).tag($0) } }
                    if player.engine != .system {
                        Picker("Voice", selection: $player.voice) { ForEach(["alba", "anna", "charles", "jean", "marius", "paul", "vera"], id: \.self) { Text($0.capitalized).tag($0) } }.onChange(of: player.voice) { _, _ in player.stop() }
                        Text(player.modelStatus).font(.footnote)
                        Button(player.modelReady ? "\(player.engine.modelName) ready offline" : "Load or download \(player.engine.modelName)") { Task { await player.preparePocket() } }.disabled(player.modelReady || player.isPreparing)
                        if player.isPreparing { ProgressView() }
                        Text(player.engine == .fullPocket ? "Full Pocket uses the same English April 2026 checkpoint as the Mac, converted to Core ML. This is an on-device trial: speed and sustained locked-screen playback need testing on your phone. Keep the app open for the first download. You can switch back to 18M." : "Pocket 18M is the smaller on-device model. Keep the app open for the first download. Downloaded models remain available when you switch engines.").font(.caption).foregroundStyle(.secondary)
                    }
                    Text("Background audio and lock-screen controls are enabled. Pocket word highlighting is approximate.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Sync your library") {
                    TextField("https://your-deployment.convex.site", text: $address).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    SecureField("Pairing key", text: $key).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Connect and sync") {
                        do { try library.configure(address: address, token: key); error = nil; Task { await library.sync() } } catch { self.error = error.localizedDescription }
                    }.disabled(address.isEmpty || key.isEmpty)
                    if library.isConfigured { Button("Sync now") { Task { await library.sync() } }.disabled(library.isSyncing); Button("Disconnect", role: .destructive) { if library.disconnect() { address = ""; key = "" } } }
                    Text(library.syncStatus).font(.footnote)
                    if let error = error ?? library.error { Text(error).font(.footnote).foregroundStyle(.red) }
                    Text("Sync keeps articles, tags and listening positions available on your Mac and phone. Your downloaded library and speech work when the Mac is off. The pairing key stays in this device's Keychain.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Updates") {
                    Text("Install updates from your Mac with this iPhone connected and unlocked. The update installs over this app and keeps your library, downloaded speech model, and pairing.").font(.footnote)
                    Text("Keep Local Reader installed. Deleting the app also removes its local downloads.").font(.footnote).foregroundStyle(.secondary)
                    if let expiration = signingExpiration {
                        LabeledContent("Development signing expires", value: expiration.formatted(date: .abbreviated, time: .omitted))
                        Text("If signing expires, install a renewed build from your Mac to open the app again. This personal development build does not use automatic App Store or TestFlight updates.").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("This development build is updated from the Mac. App Store and TestFlight delivery are not configured.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section("About") {
                    LabeledContent("Version", value: appVersion)
                    Text("Pocket TTS by Kyutai · CC BY 4.0"); Text("FluidAudio by FluidInference · Apache 2.0"); Link("Model and SDK attribution", destination: URL(string: "https://github.com/FluidInference/FluidAudio")!) }
            }
            .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear { address = library.configuration.siteURL; key = CredentialStore.read() }
        }
    }
    private var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "Unknown"
        return "\(version) (\(build))"
    }
    private var signingExpiration: Date? {
        // Read only the expiry from the embedded, OS-verified development profile.
        // Do not expose its device identifiers, certificates, or entitlements.
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex),
              let profile = try? PropertyListSerialization.propertyList(from: data.subdata(in: start.lowerBound..<end.upperBound), format: nil) as? [String: Any] else { return nil }
        return profile["ExpirationDate"] as? Date
    }

}
