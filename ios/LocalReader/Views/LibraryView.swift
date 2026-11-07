import SwiftUI

struct LibraryView: View {
    @EnvironmentObject var library: LibraryStore
    @EnvironmentObject var player: ReaderPlayer
    @State private var search = ""
    @State private var unreadOnly = false
    @State private var showArchive = false
    @State private var deleting: Article?
    @State private var tag: String?
    @State private var showImport = false
    @State private var showSettings = false
    var filtered: [Article] {
        library.articles.filter { !$0.deleted && $0.archived == showArchive && (!unreadOnly || $0.unread) && (tag == nil || $0.tags.contains(tag!)) && (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) || $0.tags.contains { $0.localizedCaseInsensitiveContains(search) }) }
            .sorted { max($0.updated, $0.contentUpdated) == max($1.updated, $1.contentUpdated) ? $0.id < $1.id : max($0.updated, $0.contentUpdated) > max($1.updated, $1.contentUpdated) }
    }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !library.allTags.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack { tagChip("All", value: nil); ForEach(library.allTags, id: \.self) { tagChip($0, value: $0) } }.padding(.horizontal).padding(.vertical, 10)
                    }
                }
                Picker("Library", selection: $showArchive) { Text("Recent").tag(false); Text("Archive").tag(true) }.pickerStyle(.segmented).padding(.horizontal).padding(.top, 8)
                Toggle("Unread only", isOn: $unreadOnly).padding(.horizontal).padding(.vertical, 8)
                List {
                    if filtered.isEmpty {
                        ContentUnavailableView(!library.articles.contains(where: { !$0.deleted }) ? "A little room for listening" : "No matching articles", systemImage: "headphones", description: Text(!library.articles.contains(where: { !$0.deleted }) ? "Add some text, or connect sync to bring your Mac library here." : "Try another tag or search."))
                    }
                    ForEach(filtered) { article in
                        NavigationLink(value: article.id) {
                            VStack(alignment: .leading, spacing: 7) {
                                Text(article.title).font(.headline).foregroundStyle(.primary)
                                Text(article.tags.isEmpty ? "Untagged" : article.tags.map { "#" + $0 }.joined(separator: "  ")).font(.caption).foregroundStyle(.secondary)
                                HStack { Text(article.unread ? "Unread" : "Read"); Text("\(article.remainingMinutes) min left"); Spacer(); if article.position > 0 { Text("\(Int(article.progress * 100))%") } }.font(.caption).foregroundStyle(.secondary)
                                if article.position > 0 { ProgressView(value: article.progress) }
                            }.padding(.vertical, 5)
                        }.contextMenu {
                            Button(article.unread ? "Mark read" : "Mark unread") { library.setUnread(!article.unread, for: article.id) }
                            Button(article.archived ? "Unarchive" : "Archive") { library.setLifecycle(for: article.id, archived: !article.archived) }
                            Button("Delete", role: .destructive) { deleting = article }
                        }
                    }
                }.listStyle(.plain)
                if let id = player.articleID, let article = library.article(id), !article.deleted {
                    HStack {
                        NavigationLink(value: id) { VStack(alignment: .leading) { Text(article.title).lineLimit(1).font(.subheadline.bold()); Text(player.status).lineLimit(1).font(.caption).foregroundStyle(.secondary) } }.buttonStyle(.plain)
                        Spacer()
                        Button(action: player.toggle) { Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.title2).frame(width: 44, height: 44) }.accessibilityLabel(player.isPlaying ? "Pause" : "Play")
                    }.padding().background(.thinMaterial)
                }
                Text(library.syncStatus).font(.caption2).foregroundStyle(.secondary).padding(.bottom, 5)
            }
            .navigationTitle("Local Reader")
            .searchable(text: $search, prompt: "Search articles or tags")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button { showSettings = true } label: { Image(systemName: "gearshape") }.accessibilityLabel("Settings") }
                ToolbarItem(placement: .topBarTrailing) { Button { showImport = true } label: { Image(systemName: "plus") }.accessibilityLabel("Add article") }
            }
            .navigationDestination(for: String.self) { ReaderView(articleID: $0) }
            .refreshable { await library.sync() }
            .confirmationDialog("Delete this article?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
                Button("Delete from library", role: .destructive) { if let article = deleting { library.setLifecycle(for: article.id, archived: false, deleted: true) }; deleting = nil }
                Button("Cancel", role: .cancel) { deleting = nil }
            } message: { Text("This removes the article from your synced library and cannot be undone. Archive it to keep it for later.") }
            .sheet(isPresented: $showImport) { ImportView() }
            .sheet(isPresented: $showSettings) { SettingsView() }
        }
    }
    func tagChip(_ title: String, value: String?) -> some View {
        Button { tag = value } label: { Text(title).font(.subheadline).padding(.horizontal, 13).padding(.vertical, 7).background(tag == value ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.08), in: Capsule()) }.buttonStyle(.plain)
    }
}

struct ImportView: View {
    @EnvironmentObject var library: LibraryStore
    @Environment(\.dismiss) var dismiss
    @State private var title = ""
    @State private var text = ""
    @State private var tags = ""
    var body: some View {
        NavigationStack {
            Form {
                Section { TextField("Title", text: $title); TextField("Tags, separated by commas", text: $tags).textInputAutocapitalization(.never) }
                Section("Article text") { TextEditor(text: $text).frame(minHeight: 250).accessibilityLabel("Article text") }
                if let error = library.error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
                Section { Text("Saved on your device. If sync is connected, this article will also appear on your Mac.").font(.footnote).foregroundStyle(.secondary) }
            }
            .navigationTitle("Add an article")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Add") { if library.add(title: title, text: text, tags: tags) != nil { dismiss() } }.disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }
        }
    }
}
