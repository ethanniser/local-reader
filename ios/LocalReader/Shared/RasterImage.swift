import Foundation
import ImageIO
import CoreGraphics

/// Decode a bounded thumbnail before accepting an image into the offline cache.
/// Using the same thumbnail path in the view avoids full-resolution allocations.
enum RasterImage {
    static func thumbnail(_ data: Data) -> CGImage? {
        guard data.count <= 5 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let kind = CGImageSourceGetType(source) as String?,
              ["public.png", "public.jpeg", "com.compuserve.gif", "org.webmproject.webp"].contains(kind),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 24000000 / height else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 2048,
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary)
    }
}
