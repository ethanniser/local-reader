import Foundation
import ImageIO

/// Image failures never prevent the article text from being imported.
enum ImportImages {
    static func png(_ source: String) async throws -> Data {
        let data: Data
        if source.hasPrefix("data:image/"), let comma = source.firstIndex(of: ","), source[..<comma].hasSuffix(";base64") {
            guard source.utf8.count <= 7 * 1024 * 1024, let decoded = Data(base64Encoded: String(source[source.index(after: comma)...])) else { throw SyncError.message("Image too large.") }
            data = decoded
        } else {
            guard let url = ArticleMark.safeLink(source), let host = url.host?.lowercased(), !host.contains(":"), host != "localhost", !host.hasSuffix(".local"), !host.allSatisfy({ $0.isNumber || $0 == "." }) else { throw SyncError.message("Unsupported image URL.") }
            let config = URLSessionConfiguration.ephemeral; config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCache = nil
            let session = URLSession(configuration: config, delegate: NoImageRedirects(), delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            var request = URLRequest(url: url); request.timeoutInterval = 8
            let (bytes, response) = try await session.bytes(for: request)
            guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else { throw SyncError.message("Image unavailable.") }
            var received = Data()
            for try await byte in bytes { guard received.count < 5 * 1024 * 1024 else { throw SyncError.message("Image too large.") }; received.append(byte) }
            data = received
        }
        guard let image = RasterImage.thumbnail(data) else { throw SyncError.message("Unsupported image format.") }
        let png = NSMutableData()
        guard let encoder = CGImageDestinationCreateWithData(png, "public.png" as CFString, 1, nil) else { throw SyncError.message("Image unavailable.") }
        CGImageDestinationAddImage(encoder, image, nil)
        guard CGImageDestinationFinalize(encoder), png.length <= 5 * 1024 * 1024 else { throw SyncError.message("Image too large.") }
        return png as Data
    }
}
private final class NoImageRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
