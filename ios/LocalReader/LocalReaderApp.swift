import SwiftUI

@main struct LocalReaderApp: App {
    @StateObject private var library = LibraryStore.shared
    @StateObject private var player = ReaderPlayer()
    @State private var pairing: PairingRequest?
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            LibraryView().environmentObject(library).environmentObject(player)
                .tint(Color(red: 0.28, green: 0.43, blue: 0.33))
                .task {
                    player.attach(library)
                    while !Task.isCancelled {
                        await library.sync()
                        do { try await Task.sleep(for: .seconds(30)) } catch { break }
                    }
                }
                .onOpenURL { url in pairing = PairingRequest(url: url) }
                .sheet(item: $pairing) { request in
                    NavigationStack {
                        VStack(spacing: 24) {
                            Image(systemName: "link.circle.fill").font(.system(size: 60)).foregroundStyle(.green)
                            Text("Connect your library").font(.title2.bold())
                            Text("Sync articles, tags and listening positions with \(request.host).").multilineTextAlignment(.center)
                            Text("Only connect a sync address you recognize from your Mac.").font(.footnote).foregroundStyle(.secondary)
                            Button("Connect and sync") {
                                do { try library.configure(address: request.address, token: request.token); pairing = nil; Task { await library.sync() } }
                                catch { library.error = error.localizedDescription }
                            }.buttonStyle(.borderedProminent)
                            Button("Cancel", role: .cancel) { pairing = nil }
                        }.padding(30)
                    }.presentationDetents([.medium])
                }
                .onChange(of: library.article(player.articleID ?? "")?.deleted ?? false) { _, deleted in if deleted { player.discardDeletedArticle() } }
                .onChange(of: scenePhase) { _, value in
                    library.persist()
                    if value == .active { Task { await library.sync() } }
                }
        }
    }
}

private struct PairingRequest: Identifiable {
    let id = UUID(), address: String, token: String, host: String
    init?(url: URL) {
        guard url.scheme == "localreader", url.host == "pair", let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let address = components.queryItems?.first(where: {$0.name == "url"})?.value,
              let token = components.queryItems?.first(where: {$0.name == "token"})?.value, token.count <= 4096,
              let base = URL(string: address), base.scheme == "https", let host = base.host, base.user == nil, base.password == nil,
              (try? SyncClient(configuration: SyncConfiguration(siteURL: address), token: token)) != nil else { return nil }
        self.address = address; self.token = token; self.host = host
    }
}
