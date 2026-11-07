import SwiftUI

struct ReaderView: View {
    let articleID: String
    @EnvironmentObject var library: LibraryStore
    @EnvironmentObject var player: ReaderPlayer
    @State private var tags = ""
    @State private var editingTags = false
    @State private var seekPosition: Double?
    @State private var following = true
    @State private var followRequest = 0
    var article: Article? { guard let article = library.article(articleID), !article.deleted else { return nil }; return article }
    var word: Int { player.articleID == articleID ? player.position : article?.position ?? 0 }
    var body: some View {
        Group {
            if let article {
                VStack(spacing: 0) {
                    SelectableArticleView(article: article, word: word, playing: player.articleID == articleID && player.isPlaying,
                                          following: following, followRequest: followRequest,
                                          imageURLs: article.images.map { library.imageURL($0) },
                                          onBrowse: { following = false },
                                          onPlay: { position in following = true; followRequest += 1; player.play(article, at: position) })
                    VStack(spacing: 13) {
                        if !following {
                            Button { following = true; followRequest += 1 } label: { Label("Return to current", systemImage: "location.fill") }.font(.caption)
                        }
                        Slider(value: Binding(get: { seekPosition ?? Double(word) }, set: { seekPosition = $0 }), in: 0...Double(max(1, article.words.count - 1)), onEditingChanged: { editing in if !editing, let target = seekPosition { library.setPosition(Int(target), for: articleID); player.play(article, at: Int(target)); seekPosition = nil } }).accessibilityLabel("Reading position")
                        HStack(spacing: 28) {
                            Button { player.play(article, at: word - 40) } label: { Image(systemName: "gobackward.15").font(.title2) }
                            Button { if player.articleID == articleID { player.toggle() } else { player.play(article) } } label: { Image(systemName: player.articleID == articleID && player.isPlaying ? "pause.circle.fill" : "play.circle.fill").font(.system(size: 58)) }.accessibilityLabel(player.isPlaying ? "Pause" : "Play")
                            Button { player.play(article, at: word + 40) } label: { Image(systemName: "goforward.15").font(.title2) }
                            Menu { ForEach([0.75, 1.0, 1.25, 1.5, 2.0], id: \.self) { value in Button("\(value.formatted())×") { player.rate = Float(value) } } } label: { Text("\(Double(player.rate).formatted())×").monospacedDigit() }
                        }
                        Text(player.articleID == articleID ? player.status : "Select a word, then choose Listen from here").font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }.padding().background(.thinMaterial)
                }
                .toolbar { Button(article.unread ? "Mark read" : "Mark unread") { library.setUnread(!article.unread, for: articleID) }; Button { tags = article.tags.joined(separator: ", "); editingTags = true } label: { Image(systemName: "tag") }.accessibilityLabel("Edit tags") }
            } else { ContentUnavailableView("Article unavailable", systemImage: "doc") }
        }
        .navigationBarTitleDisplayMode(.inline)
        .alert("Edit tags", isPresented: $editingTags) { TextField("Tags, separated by commas", text: $tags); Button("Save") { library.setTags(tags, for: articleID) }; Button("Cancel", role: .cancel) {} } message: { Text("Use commas to separate tags.") }
    }
}
