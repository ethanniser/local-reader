import Foundation

/// Passive HTML parsing: never executes scripts or loads subresources.
enum ArticleImport {
    static func text(title: String, text: String, source: String = "") throws -> Article {
        guard text.utf8.count <= 5 * 1024 * 1024 else { throw SyncError.message("This article is too large. Share a shorter selection.") }
        var article = Article(title: Article.clipped(title, limit: 300), text: text)
        article.source = ArticleMark.safeLink(source)?.absoluteString ?? ""
        guard !article.words.isEmpty, article.words.count <= 250000, article.words.allSatisfy({ $0.utf16.count <= 10000 }) else { throw SyncError.message("No readable article text was found, or the article is too large.") }
        return article
    }
    static func fromURL(_ url: URL) async throws -> Article {
        guard ArticleMark.safeLink(url.absoluteString) != nil,
              let host = url.host?.lowercased(), !host.contains(":"), !host.hasSuffix(".local"), host != "localhost", !host.allSatisfy({ $0.isNumber || $0 == "." }) else { throw SyncError.message("Share an article website URL or its text.") }
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCache = nil
        let session = URLSession(configuration: config, delegate: ImportRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url); request.timeoutInterval = 25
        let (stream, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
              ["text/html", "text/plain"].contains(response.mimeType?.lowercased() ?? "") else { throw SyncError.message("Open this link in Safari and share the loaded page, or share selected text.") }
        var data = Data()
        for try await byte in stream {
            if data.count >= 5 * 1024 * 1024 { throw SyncError.message("This page is too large. Share selected text instead.") }
            data.append(byte)
        }
        guard let value = String(data: data, encoding: .utf8) else { throw SyncError.message("This page's text encoding is unsupported. Share it from Safari instead.") }
        if response.mimeType == "text/plain" { return try text(title: host, text: value, source: url.absoluteString) }
        return try html(value, source: url)
    }
    static func html(_ html: String, source: URL) throws -> Article {
        guard html.utf8.count <= 5 * 1024 * 1024 else { throw SyncError.message("This page is too large.") }
        let title = matches("(?is)<title[^>]*>(.*?)</title>", html).first.map { decode($0[1]) } ?? source.host ?? "Shared article"
        let body = matches("(?is)<article\\b[^>]*>(.*?)</article>", html).first?[1] ?? matches("(?is)<main\\b[^>]*>(.*?)</main>", html).first?[1] ?? html
        let tokens = matches("(?s)<!--.*?-->|<[^>]*>|[^<]+", body)
        var plain = "", length = 0
        var active: [(tag: String, kind: String, href: String?, start: Int)] = []
        var spans: [(start: Int, end: Int, kind: String, href: String?)] = []
        var images: [(src: String, alt: String, offset: Int)] = []
        var skipped: [String] = []
        var quoteStarts: [Int] = []
        var quoteSpans: [(start: Int, end: Int)] = []
        let blockTags: Set<String> = ["p", "div", "section", "article", "main", "li", "blockquote", "h1", "h2", "h3", "h4", "br"]
        let skipTags: Set<String> = ["script", "style", "noscript", "nav", "header", "footer", "form", "button", "svg", "iframe", "head"]
        func append(_ value: String) { plain += value; length += value.utf16.count }
        func boundary() { if !plain.isEmpty && !plain.hasSuffix("\n\n") { append("\n\n") } }
        for token in tokens.map({ $0[0] }) {
            if token.hasPrefix("<") {
                let name = matches("(?i)^</?\\s*([a-z0-9]+)", token).first?[1].lowercased() ?? ""
                let closing = token.hasPrefix("</")
                if !skipped.isEmpty { if closing && name == skipped.last { skipped.removeLast() } else if !closing && skipTags.contains(name) { skipped.append(name) }; continue }
                if !closing && skipTags.contains(name) { skipped.append(name); continue }
                if closing && name == "blockquote", let start = quoteStarts.popLast() { quoteSpans.append((start, length)) }
                if blockTags.contains(name) { boundary() }
                if !closing && name == "blockquote" { quoteStarts.append(length) }
                if name == "img", !closing, images.count < 20 {
                    let raw = matches("(?is)\\b(?:src|data-src)\\s*=\\s*[\"']([^\"']*)[\"']", token).first?[1]
                    if let raw, let url = URL(string: decode(raw), relativeTo: source)?.absoluteURL, ArticleMark.safeLink(url.absoluteString) != nil {
                        let alt = matches("(?is)\\balt\\s*=\\s*[\"']([^\"']*)[\"']", token).first?[1] ?? ""
                        images.append((url.absoluteString, decode(alt), length))
                    }
                }
                if let kind = ["b":"bold", "strong":"bold", "em":"italic", "i":"italic", "u":"underline", "a":"link"][name] {
                    if closing, let index = active.lastIndex(where: { $0.tag == name }) {
                        let mark = active.remove(at: index)
                        spans.append((mark.start, length, mark.kind, mark.href))
                    } else if !closing {
                        let raw = matches("(?is)\\bhref\\s*=\\s*[\"']([^\"']*)[\"']", token).first?[1]
                        let href = raw.flatMap { URL(string: decode($0), relativeTo: source)?.absoluteURL.absoluteString }
                        active.append((name, kind, href, length))
                    }
                }
            } else if skipped.isEmpty { append(decode(token)) }
        }
        for start in quoteStarts { quoteSpans.append((start, length)) }
        var output = try text(title: title, text: plain, source: source.absoluteString)
        let wordRanges = try NSRegularExpression(pattern: "\\S+").matches(in: plain, range: NSRange(location: 0, length: length)).map(\.range)
        func lowerBound(_ predicate: (NSRange) -> Bool) -> Int {
            var low = 0, high = wordRanges.count
            while low < high { let mid = (low + high) / 2; if predicate(wordRanges[mid]) { high = mid } else { low = mid + 1 } }
            return low
        }
        let quotedWords = quoteSpans.map { span in (start: lowerBound { NSMaxRange($0) > span.start }, end: lowerBound { $0.location >= span.end }) }.sorted { $0.start < $1.start }
        var mergedQuotes: [(start: Int, end: Int)] = []
        for range in quotedWords where range.end > range.start {
            if let last = mergedQuotes.last, range.start <= last.end { mergedQuotes[mergedQuotes.count - 1].end = max(last.end, range.end) }
            else { mergedQuotes.append(range) }
        }
        var quoteIndex = 0
        output.paragraphs = output.paragraphs.map { paragraph in
            var value = paragraph
            while quoteIndex < mergedQuotes.count && mergedQuotes[quoteIndex].end <= paragraph.start { quoteIndex += 1 }
            if quoteIndex < mergedQuotes.count, mergedQuotes[quoteIndex].start <= paragraph.start, paragraph.end <= mergedQuotes[quoteIndex].end { value.kind = "blockquote" }
            return value
        }
        for span in spans.prefix(50000) {
            let start = lowerBound { NSMaxRange($0) > span.start }, end = lowerBound { $0.location >= span.end }
            let mark = ArticleMark(start: start, end: end, kind: span.kind, href: span.href)
            if mark.isValid(wordCount: output.words.count) { output.marks.append(mark) }
        }
        output.images = images.map { image in ArticleImage(src: image.src, alt: image.alt, caption: "", position: lowerBound { $0.location >= image.offset }) }
        return output
    }
    private static func matches(_ pattern: String, _ value: String) -> [[String]] {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = value as NSString
        return expression.matches(in: value, range: NSRange(location: 0, length: ns.length)).map { match in (0..<match.numberOfRanges).map { match.range(at: $0).location == NSNotFound ? "" : ns.substring(with: match.range(at: $0)) } }
    }
    private static func decode(_ text: String) -> String {
        var value = text
        let entities = ["amp":"&", "lt":"<", "gt":">", "quot":"\"", "apos":"'", "nbsp":" ", "ndash":"–", "mdash":"—", "rsquo":"’", "lsquo":"‘", "ldquo":"“", "rdquo":"”", "hellip":"…"]
        for match in matches("&#(x[0-9a-fA-F]+|[0-9]+);", value) {
            let raw = match[1]; let number = raw.hasPrefix("x") ? UInt32(raw.dropFirst(), radix: 16) : UInt32(raw)
            if let number, let scalar = UnicodeScalar(number) { value = value.replacingOccurrences(of: match[0], with: String(scalar)) }
        }
        for (key, replacement) in entities { value = value.replacingOccurrences(of: "&\(key);", with: replacement) }
        return value
    }
}
private final class ImportRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
