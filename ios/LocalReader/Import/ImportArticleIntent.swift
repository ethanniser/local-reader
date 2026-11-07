import AppIntents

struct ImportArticleIntent: AppIntent {
    static var title: LocalizedStringResource = "Save Text to Local Reader"
    static var description = IntentDescription("Save article text in your offline library. Use Get Article using Safari Reader or Get Text before this action for web pages.")
    static var openAppWhenRun = true
    @Parameter(title: "Title", default: "Shared article") var title: String
    @Parameter(title: "Text") var text: String
    @Parameter(title: "Tags", default: "") var tags: String
    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
        let store = LibraryStore.shared
        guard store.add(title: title, text: text, tags: tags) != nil else { throw SyncError.message(store.error ?? "Could not save the article.") }
        return .result(dialog: "Saved in Local Reader.")
    }
}
struct ImportURLIntent: AppIntent {
    static var title: LocalizedStringResource = "Save Web Article to Local Reader"
    static var description = IntentDescription("Download an article without browser cookies. For pages you signed into, share the loaded page from Safari instead.")
    static var openAppWhenRun = true
    @Parameter(title: "Article URL") var url: URL
    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
        let article = try await ArticleImport.fromURL(url)
        try LibraryStore.shared.addImported(article)
        await LibraryStore.shared.cacheImportedImages(article)
        return .result(dialog: "Saved in Local Reader.")
    }
}
