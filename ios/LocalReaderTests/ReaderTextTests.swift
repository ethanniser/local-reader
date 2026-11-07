import XCTest
import UIKit
@testable import LocalReader

@MainActor final class ReaderTextTests: XCTestCase {
    func testSelectionMapsUTF16OffsetsAcrossImagesAndParagraphs() throws {
        var article = Article(title: "Title 👩🏽‍🚀", text: "One 👩🏽‍🚀 cafe\u{301}.\n\nSecond paragraph.")
        article.images = [ArticleImage(src: "/images/a", alt: "Image caption", caption: "", position: 3)]
        let layout = ReaderTextLayout(article: article)
        let text = layout.text.string as NSString
        for (index, word) in article.words.enumerated() {
            let range = try XCTUnwrap(layout.range(forWord: index))
            XCTAssertEqual(text.substring(with: range), word)
            XCTAssertEqual(layout.firstWord(in: range), index)
        }
        let emoji = try XCTUnwrap(layout.range(forWord: 1))
        XCTAssertEqual(layout.firstWord(in: NSRange(location: emoji.location + 1, length: 1)), 1)
        let second = try XCTUnwrap(layout.range(forWord: 3))
        XCTAssertEqual(layout.firstWord(in: NSRange(location: emoji.location, length: NSMaxRange(second) - emoji.location)), 1)
        XCTAssertNil(layout.firstWord(in: text.range(of: "Title")))
        XCTAssertNil(layout.firstWord(in: text.range(of: "Image caption")))
    }

    func testOverlappingMarksAndQuoteFormattingSurvive() throws {
        var article = Article(title: "Title", text: "One two three.")
        article.paragraphs[0].kind = "blockquote"
        article.marks = [ArticleMark(start: 0, end: 2, kind: "bold"), ArticleMark(start: 1, end: 3, kind: "italic"), ArticleMark(start: 1, end: 2, kind: "underline"), ArticleMark(start: 1, end: 2, kind: "link", href: "https://example.com")]
        let layout = ReaderTextLayout(article: article)
        let range = try XCTUnwrap(layout.range(forWord: 1))
        let attributes = layout.text.attributes(at: range.location, effectiveRange: nil)
        let font = try XCTUnwrap(attributes[.font] as? UIFont)
        XCTAssertTrue(font.fontDescriptor.symbolicTraits.contains(.traitBold))
        XCTAssertTrue(font.fontDescriptor.symbolicTraits.contains(.traitItalic))
        XCTAssertEqual(attributes[.underlineStyle] as? Int, NSUnderlineStyle.single.rawValue)
        XCTAssertEqual((attributes[.link] as? URL)?.absoluteString, "https://example.com")
        XCTAssertEqual((attributes[.paragraphStyle] as? NSParagraphStyle)?.headIndent, 18)
    }

    func testCrossParagraphLinkDoesNotLeakOntoInsertedCaption() throws {
        var article = Article(title: "Title", text: "One two.\n\nThree four.")
        article.images = [ArticleImage(src: "/images/a", alt: "", caption: "Caption", position: 2)]
        article.marks = [ArticleMark(start: 1, end: 3, kind: "link", href: "https://example.com")]
        let layout = ReaderTextLayout(article: article)
        let caption = (layout.text.string as NSString).range(of: "Caption")
        XCTAssertNil(layout.text.attribute(.link, at: caption.location, effectiveRange: nil))
        for word in [1, 2] {
            let range = try XCTUnwrap(layout.range(forWord: word))
            XCTAssertNotNil(layout.text.attribute(.link, at: range.location, effectiveRange: nil))
        }
    }

    func testPlaybackHighlightDoesNotReplaceTextOrClearSelection() throws {
        let article = Article(title: "Title", text: "One two three.\n\nFour five.")
        func representable(_ word: Int) -> SelectableArticleView {
            SelectableArticleView(article: article, word: word, playing: true, following: false, followRequest: 0, imageURLs: [], onBrowse: {}, onPlay: { _ in })
        }
        let view = UITextView(usingTextLayoutManager: false)
        view.isEditable = false
        let coordinator = representable(0).makeCoordinator()
        coordinator.view = view; view.delegate = coordinator
        coordinator.update(representable(0), view: view)
        let layout = try XCTUnwrap(coordinator.layout)
        let start = try XCTUnwrap(layout.range(forWord: 1)), end = try XCTUnwrap(layout.range(forWord: 4))
        let selection = NSRange(location: start.location, length: NSMaxRange(end) - start.location)
        view.selectedRange = selection
        let generation = coordinator.generation
        coordinator.update(representable(3), view: view)
        XCTAssertEqual(view.selectedRange, selection)
        XCTAssertEqual(coordinator.generation, generation)
        XCTAssertEqual(view.attributedText.string, layout.text.string)
        let highlight = try XCTUnwrap(layout.range(forWord: 3))
        XCTAssertNotNil(view.textStorage.attribute(.backgroundColor, at: highlight.location, effectiveRange: nil))
    }

    func testReturnToCurrentClearsSelectionAndKeepsStandardMenuActions() throws {
        let article = Article(title: "Title", text: "One two three.")
        let initial = SelectableArticleView(article: article, word: 2, playing: false, following: false, followRequest: 0, imageURLs: [], onBrowse: {}, onPlay: { _ in })
        let view = UITextView(usingTextLayoutManager: false)
        let coordinator = initial.makeCoordinator()
        coordinator.view = view; view.delegate = coordinator
        coordinator.update(initial, view: view)
        let range = try XCTUnwrap(coordinator.layout?.range(forWord: 1))
        view.selectedRange = range
        let copy = UIAction(title: "Copy") { _ in }
        let menu = try XCTUnwrap(coordinator.textView(view, editMenuForTextIn: range, suggestedActions: [copy]))
        XCTAssertEqual(menu.children.compactMap { ($0 as? UIAction)?.title }, ["Listen from here", "Copy"])
        let following = SelectableArticleView(article: article, word: 2, playing: false, following: true, followRequest: 1, imageURLs: [], onBrowse: {}, onPlay: { _ in })
        coordinator.update(following, view: view)
        XCTAssertEqual(view.selectedRange.length, 0)
        XCTAssertEqual(coordinator.lastFollowRequest, 1)
    }

    func testReturnToCurrentFlushesImagesDeferredDuringSelection() throws {
        let article = Article(title: "Title", text: "One two.")
        let initial = SelectableArticleView(article: article, word: 0, playing: false, following: false, followRequest: 0, imageURLs: [], onBrowse: {}, onPlay: { _ in })
        let view = UITextView(usingTextLayoutManager: false)
        let coordinator = initial.makeCoordinator()
        coordinator.update(initial, view: view)
        view.selectedRange = try XCTUnwrap(coordinator.layout?.range(forWord: 0))
        let attachment = ReaderImageAttachment()
        let image = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { context in
            UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        }
        coordinator.pendingImages = [(attachment, try XCTUnwrap(image.cgImage))]
        coordinator.flushImages(view)
        XCTAssertNil(attachment.image)
        let following = SelectableArticleView(article: article, word: 0, playing: false, following: true, followRequest: 1, imageURLs: [], onBrowse: {}, onPlay: { _ in })
        coordinator.update(following, view: view)
        XCTAssertNotNil(attachment.image)
        XCTAssertTrue(coordinator.pendingImages.isEmpty)
    }
}
