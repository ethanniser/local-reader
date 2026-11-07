import Foundation

struct Paragraph: Codable, Hashable { var start: Int; var end: Int; var kind: String }
struct ArticleImage: Codable, Hashable { var src: String; var alt: String; var caption: String; var position: Int }
struct ArticleMark: Codable, Hashable {
    var start: Int; var end: Int; var kind: String; var href: String?
    enum CodingKeys: String, CodingKey { case start, end, kind, href }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(start, forKey: .start); try values.encode(end, forKey: .end); try values.encode(kind, forKey: .kind)
        if kind == "link", let url = Self.safeLink(href) { try values.encode(url.absoluteString, forKey: .href) }
    }
    static func safeLink(_ value: String?) -> URL? {
        guard let value, value.utf16.count <= 4096, !value.contains("\\"), ["http://", "https://"].contains(where: { value.lowercased().hasPrefix($0) }), !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil, url.user == nil, url.password == nil, url.absoluteString.utf16.count <= 4096 else { return nil }
        return url
    }
    func isValid(wordCount: Int) -> Bool {
        start >= 0 && end > start && end <= wordCount && ["bold", "italic", "underline", "link"].contains(kind) && (kind != "link" || Self.safeLink(href) != nil)
    }
}
struct Article: Codable, Identifiable, Hashable {
    var id: String
    var title: String
    var source: String
    var words: [String]
    var paragraphs: [Paragraph]
    var images: [ArticleImage]
    var marks: [ArticleMark]
    var tags: [String]
    var position: Int
    var updated: Double
    var metadataUpdated: Double
    var unread: Bool
    var readUpdated: Double
    var archived: Bool
    var deleted: Bool
    var lifecycleUpdated: Double
    var contentUpdated: Double

    init(id: String = UUID().uuidString, title: String, text: String, tags: [String] = []) {
        self.id = id; self.title = title; source = ""; words = []; paragraphs = []; images = []; marks = []
        for line in text.components(separatedBy: "\n\n") {
            let values = line.split(whereSeparator: { $0.isWhitespace }).map(String.init)
            guard !values.isEmpty else { continue }
            paragraphs.append(Paragraph(start: words.count, end: words.count + values.count, kind: "paragraph"))
            words += values
        }
        self.tags = Self.normalizeTags(tags); position = 0
        updated = Date().timeIntervalSince1970; metadataUpdated = updated; contentUpdated = updated; unread = true; readUpdated = updated; archived = false; deleted = false; lifecycleUpdated = 0
    }
    enum CodingKeys: String, CodingKey { case id, title, source, words, paragraphs, images, marks, tags, position, updated, metadataUpdated, contentUpdated, unread, readUpdated, archived, deleted, lifecycleUpdated }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id); title = try c.decode(String.self, forKey: .title)
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? ""
        words = try c.decode([String].self, forKey: .words)
        paragraphs = try c.decodeIfPresent([Paragraph].self, forKey: .paragraphs) ?? []
        images = try c.decodeIfPresent([ArticleImage].self, forKey: .images) ?? []
        let wordCount = words.count
        marks = ((try? c.decode([ArticleMark].self, forKey: .marks)) ?? []).prefix(50000).filter { $0.isValid(wordCount: wordCount) }
        tags = Self.normalizeTags(try c.decodeIfPresent([String].self, forKey: .tags) ?? [])
        position = max(0, min(max(0, words.count - 1), try c.decodeIfPresent(Int.self, forKey: .position) ?? 0))
        updated = try c.decodeIfPresent(Double.self, forKey: .updated) ?? 0
        metadataUpdated = try c.decodeIfPresent(Double.self, forKey: .metadataUpdated) ?? 0
        unread = try c.decodeIfPresent(Bool.self, forKey: .unread) ?? true
        readUpdated = try c.decodeIfPresent(Double.self, forKey: .readUpdated) ?? 0
        archived = try c.decodeIfPresent(Bool.self, forKey: .archived) ?? false
        deleted = try c.decodeIfPresent(Bool.self, forKey: .deleted) ?? false
        lifecycleUpdated = try c.decodeIfPresent(Double.self, forKey: .lifecycleUpdated) ?? 0
        contentUpdated = try c.decodeIfPresent(Double.self, forKey: .contentUpdated) ?? 0
    }
    static func clipped(_ value: String, limit: Int) -> String {
        var count = 0
        return String(value.prefix { character in count += String(character).utf16.count; return count <= limit })
    }
    static func normalizeTags(_ values: [String]) -> [String] {
        Array(Set(values.map { $0.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").lowercased() }.filter { !$0.isEmpty }.map { Self.clipped($0, limit: 60) })).sorted()
    }
    func merging(_ remote: Article) -> Article {
        guard remote.id == id else { return self }
        var result = remote.contentUpdated > contentUpdated ? remote : self
        if remote.metadataUpdated > metadataUpdated { result.tags = remote.tags; result.title = remote.title; result.source = remote.source; result.metadataUpdated = remote.metadataUpdated }
        else { result.tags = tags; result.title = title; result.source = source; result.metadataUpdated = metadataUpdated }
        if remote.updated > updated { result.position = remote.position; result.updated = remote.updated }
        else { result.position = position; result.updated = updated }
        if remote.readUpdated > readUpdated { result.unread = remote.unread; result.readUpdated = remote.readUpdated }
        else { result.unread = unread; result.readUpdated = readUpdated }
        result.archived = remote.lifecycleUpdated > lifecycleUpdated ? remote.archived : archived
        result.deleted = deleted || remote.deleted
        result.lifecycleUpdated = max(lifecycleUpdated, remote.lifecycleUpdated)
        if result.deleted {
            result.title = "Deleted article"; result.source = ""; result.words = []; result.paragraphs = []; result.images = []; result.marks = []; result.tags = []; result.position = 0
        }
        result.position = max(0, min(result.position, max(0, result.words.count - 1)))
        return result
    }
    var progress: Double { words.isEmpty ? 0 : Double(position) / Double(words.count) }
    var remainingMinutes: Int { max(1, Int(ceil(Double(words.count - position) / 165))) }
}

struct RemoteLibrary: Decodable { var documents: [RemoteArticle]; var serverTime: Double? }
struct RemoteArticle: Decodable { var id: String; var updated: Double; var metadataUpdated: Double; var contentUpdated: Double; var readUpdated: Double?; var archived: Bool?; var deleted: Bool?; var lifecycleUpdated: Double? }
