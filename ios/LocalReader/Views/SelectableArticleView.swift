import SwiftUI
import UIKit

/// One native text surface keeps selection, Copy, links and selection handles working
/// across paragraph boundaries. Speech coordinates remain the article's word indices.
struct SelectableArticleView: UIViewRepresentable {
    @Environment(\.sizeCategory) private var sizeCategory
    let article: Article
    let word: Int
    let playing: Bool
    let following: Bool
    let followRequest: Int
    let imageURLs: [URL?]
    let onBrowse: () -> Void
    let onPlay: (Int) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView(usingTextLayoutManager: false)
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 18, left: 24, bottom: 36, right: 24)
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
        view.delegate = context.coordinator
        view.alwaysBounceVertical = true
        context.coordinator.view = view
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        _ = sizeCategory
        context.coordinator.update(self, view: view)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: SelectableArticleView
        weak var view: UITextView?
        var rendered: Article?
        var renderedURLs: [URL?] = []
        var layout: ReaderTextLayout?
        var highlighted: NSRange?
        var lastWord: Int?
        var lastFollowRequest = -1
        var changingText = false
        var imageTasks: [Task<Void, Never>] = []
        var pendingImages: [(ReaderImageAttachment, CGImage)] = []
        var generation = 0
        var renderedCategory: UIContentSizeCategory?

        init(_ parent: SelectableArticleView) { self.parent = parent }
        deinit { imageTasks.forEach { $0.cancel() } }

        func update(_ parent: SelectableArticleView, view: UITextView) {
            self.parent = parent
            let requested = lastFollowRequest != parent.followRequest
            if requested && lastFollowRequest >= 0 {
                changingText = true
                view.selectedRange = NSRange(location: view.selectedRange.location, length: 0)
                view.resignFirstResponder()
                changingText = false
            }
            let contentChanged = rendered.map {
                $0.id != parent.article.id || $0.title != parent.article.title || $0.source != parent.article.source ||
                $0.words != parent.article.words || $0.paragraphs != parent.article.paragraphs ||
                $0.marks != parent.article.marks || $0.images != parent.article.images || $0.tags != parent.article.tags || $0.unread != parent.article.unread
            } ?? true
            // Remote image arrivals must not dismiss a selection or its edit menu.
            if (contentChanged || renderedURLs != parent.imageURLs || renderedCategory != view.traitCollection.preferredContentSizeCategory), view.selectedRange.length == 0 {
                rebuild(view)
            }
            flushImages(view)
            if let layout, lastWord != parent.word {
                changingText = true
                if let highlighted { view.textStorage.removeAttribute(.backgroundColor, range: highlighted) }
                highlighted = layout.range(forWord: parent.word)
                if let highlighted { view.textStorage.addAttribute(.backgroundColor, value: UIColor.systemGreen.withAlphaComponent(0.18), range: highlighted) }
                changingText = false
            }
            if requested || (parent.playing && parent.following && lastWord != parent.word) {
                // UIKit finishes laying out after the SwiftUI update transaction.
                DispatchQueue.main.async { [weak self, weak view] in
                    guard let self, let view, self.parent.following,
                          view.selectedRange.length == 0, !view.isDragging, !view.isDecelerating else { return }
                    self.centerCurrentWord(view, animated: !requested)
                }
            }
            lastFollowRequest = parent.followRequest
            lastWord = parent.word
        }

        func rebuild(_ view: UITextView) {
            generation += 1
            let revision = generation
            imageTasks.forEach { $0.cancel() }; imageTasks.removeAll()
            pendingImages.removeAll()
            let layout = ReaderTextLayout(article: parent.article, traits: view.traitCollection)
            self.layout = layout
            rendered = parent.article; renderedURLs = parent.imageURLs
            renderedCategory = view.traitCollection.preferredContentSizeCategory
            changingText = true
            let offset = view.contentOffset
            view.attributedText = layout.text
            view.contentOffset = offset
            changingText = false
            highlighted = nil; lastWord = nil
            for (index, attachment) in layout.attachments {
                guard parent.imageURLs.indices.contains(index), let url = parent.imageURLs[index] else { continue }
                imageTasks.append(Task { [weak self, weak view] in
                    let decoded = await Task.detached(priority: .utility) { () -> CGImage? in
                        guard let data = try? Data(contentsOf: url) else { return nil }
                        return RasterImage.thumbnail(data)
                    }.value
                    guard !Task.isCancelled, let self, let view, self.generation == revision, let decoded else { return }
                    self.pendingImages.append((attachment, decoded))
                    self.flushImages(view)
                })
            }
        }

        func centerCurrentWord(_ view: UITextView, animated: Bool) {
            guard let range = layout?.range(forWord: parent.word) else { return }
            view.layoutManager.ensureLayout(for: view.textContainer)
            let glyphs = view.layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            let rect = view.layoutManager.boundingRect(forGlyphRange: glyphs, in: view.textContainer)
            let top = -view.adjustedContentInset.top
            let bottom = max(top, view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom)
            let y = min(bottom, max(top, rect.midY + view.textContainerInset.top - view.bounds.height / 2))
            view.setContentOffset(CGPoint(x: 0, y: y), animated: animated)
        }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) { parent.onBrowse() }

        func textViewDidChangeSelection(_ textView: UITextView) {
            guard !changingText else { return }
            if textView.selectedRange.length > 0 { parent.onBrowse() }
            else {
                // A paused reader may receive no other SwiftUI update after selection.
                DispatchQueue.main.async { [weak self, weak textView] in
                    guard let self, let textView, textView.selectedRange.length == 0 else { return }
                    self.update(self.parent, view: textView)
                    self.flushImages(textView)
                }
            }
        }

        func flushImages(_ view: UITextView) {
            guard view.selectedRange.length == 0, !pendingImages.isEmpty else { return }
            for (attachment, decoded) in pendingImages { attachment.image = UIImage(cgImage: decoded) }
            pendingImages.removeAll()
            view.layoutManager.invalidateLayout(forCharacterRange: NSRange(location: 0, length: view.textStorage.length), actualCharacterRange: nil)
            view.setNeedsLayout()
        }

        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            guard let word = layout?.firstWord(in: range) else { return UIMenu(children: suggestedActions) }
            let listen = UIAction(title: "Listen from here", image: UIImage(systemName: "play.fill")) { [weak self, weak textView] _ in
                guard let self else { return }
                // A sync may replace article text while the native selection is open.
                // Never apply an old displayed word offset to new article text.
                guard self.rendered?.id == self.parent.article.id, self.rendered?.words == self.parent.article.words else { return }
                textView?.selectedRange = NSRange(location: range.location, length: 0)
                textView?.resignFirstResponder()
                self.parent.onPlay(word)
            }
            return UIMenu(children: [listen] + suggestedActions)
        }
    }
}

/// UTF-16 ranges match UIKit's selection coordinates, including emoji and combining marks.
struct ReaderTextLayout {
    let text: NSAttributedString
    let wordRanges: [NSRange]
    let attachments: [(Int, ReaderImageAttachment)]

    func range(forWord word: Int) -> NSRange? {
        guard wordRanges.indices.contains(word), wordRanges[word].location != NSNotFound else { return nil }
        return wordRanges[word]
    }

    func firstWord(in selection: NSRange) -> Int? {
        guard selection.location != NSNotFound, selection.length > 0 else { return nil }
        return wordRanges.firstIndex { $0.location != NSNotFound && NSIntersectionRange($0, selection).length > 0 }
    }

    init(article: Article, traits: UITraitCollection? = nil) {
        let result = NSMutableAttributedString(string: "")
        var ranges = Array(repeating: NSRange(location: NSNotFound, length: 0), count: article.words.count)
        var images: [(Int, ReaderImageAttachment)] = []
        let body = UIFontMetrics(forTextStyle: .body).scaledFont(for: UIFont(descriptor: UIFont.systemFont(ofSize: 20).fontDescriptor.withDesign(.serif)!, size: 20), compatibleWith: traits)
        let paragraphStyle = NSMutableParagraphStyle(); paragraphStyle.lineSpacing = 8; paragraphStyle.paragraphSpacing = 22
        let base: [NSAttributedString.Key: Any] = [.font: body, .foregroundColor: UIColor.label, .paragraphStyle: paragraphStyle]
        let titleFont = UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: UIFont(descriptor: body.fontDescriptor, size: 32), compatibleWith: traits)
        result.append(NSAttributedString(string: article.title + "\n", attributes: [.font: titleFont, .foregroundColor: UIColor.label, .paragraphStyle: paragraphStyle]))
        let detail: [NSAttributedString.Key: Any] = [.font: UIFont.preferredFont(forTextStyle: .caption1, compatibleWith: traits), .foregroundColor: UIColor.secondaryLabel, .paragraphStyle: paragraphStyle]
        result.append(NSAttributedString(string: "\(article.unread ? "Unread" : "Read")   \(article.words.count.formatted()) words", attributes: detail))
        if let url = ArticleMark.safeLink(article.source) {
            result.append(NSAttributedString(string: "   Original ↗", attributes: detail.merging([.link: url]) { _, new in new }))
        }
        if !article.tags.isEmpty { result.append(NSAttributedString(string: "\n" + article.tags.map { "#" + $0 }.joined(separator: "  "), attributes: detail)) }
        result.append(NSAttributedString(string: "\n\n", attributes: detail))
        func appendImage(_ index: Int, _ image: ArticleImage) {
            let attachment = ReaderImageAttachment()
            images.append((index, attachment))
            result.append(NSAttributedString(attachment: attachment))
            result.append(NSAttributedString(string: "\n", attributes: detail))
            let caption = image.caption.isEmpty ? image.alt : image.caption
            if !caption.isEmpty { result.append(NSAttributedString(string: caption + "\n", attributes: detail)) }
        }
        for paragraph in article.paragraphs {
            let lower = max(0, min(article.words.count, paragraph.start))
            let upper = max(lower, min(article.words.count, paragraph.end))
            for (index, image) in article.images.enumerated() where image.position >= lower && image.position < upper { appendImage(index, image) }
            let start = result.length
            for index in lower..<upper {
                ranges[index] = NSRange(location: result.length, length: article.words[index].utf16.count)
                result.append(NSAttributedString(string: article.words[index], attributes: base))
                if index + 1 < upper { result.append(NSAttributedString(string: " ", attributes: base)) }
            }
            result.append(NSAttributedString(string: "\n", attributes: base))
            let paragraphRange = NSRange(location: start, length: result.length - start)
            if paragraph.kind == "heading" { result.addAttribute(.font, value: UIFont.preferredFont(forTextStyle: .headline, compatibleWith: traits), range: paragraphRange) }
            if paragraph.kind == "blockquote" {
                let quote = paragraphStyle.mutableCopy() as! NSMutableParagraphStyle
                quote.firstLineHeadIndent = 18; quote.headIndent = 18; quote.tailIndent = -12
                result.addAttributes([.paragraphStyle: quote, .foregroundColor: UIColor.secondaryLabel], range: paragraphRange)
            }
        }
        for (index, image) in article.images.enumerated() where image.position >= article.words.count { appendImage(index, image) }
        for mark in article.marks where mark.start >= 0 && mark.end <= ranges.count && mark.end > mark.start {
          // Marks address article words only; inserted image captions are not in
          // that coordinate space, even when a mark crosses paragraph boundaries.
          for paragraph in article.paragraphs where paragraph.end > mark.start && paragraph.start < mark.end {
            let lower = max(mark.start, max(0, paragraph.start)), upper = min(mark.end, paragraph.end)
            guard lower < upper else { continue }
            let first = ranges[lower], last = ranges[upper - 1]
            guard first.location != NSNotFound, last.location != NSNotFound else { continue }
            let range = NSRange(location: first.location, length: NSMaxRange(last) - first.location)
            switch mark.kind {
            case "bold", "italic":
                result.enumerateAttribute(.font, in: range) { value, run, _ in
                    guard let font = value as? UIFont else { return }
                    let trait: UIFontDescriptor.SymbolicTraits = mark.kind == "bold" ? .traitBold : .traitItalic
                    if let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(trait)) {
                        result.addAttribute(.font, value: UIFont(descriptor: descriptor, size: font.pointSize), range: run)
                    }
                }
            case "underline": result.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: range)
            case "link": if let url = ArticleMark.safeLink(mark.href) { result.addAttribute(.link, value: url, range: range) }
            default: break
            }
          }
        }
        text = result; wordRanges = ranges; attachments = images
    }
}

final class ReaderImageAttachment: NSTextAttachment {
    override func attachmentBounds(for textContainer: NSTextContainer?, proposedLineFragment lineFrag: CGRect, glyphPosition position: CGPoint, characterIndex charIndex: Int) -> CGRect {
        let width = max(1, lineFrag.width)
        guard let image, image.size.width > 0 else { return CGRect(x: 0, y: 0, width: width, height: 1) }
        return CGRect(x: 0, y: 0, width: width, height: width * image.size.height / image.size.width)
    }
}
