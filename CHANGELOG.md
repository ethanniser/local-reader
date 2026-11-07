# Changelog

All notable changes to Local Reader are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and repository
releases use [Semantic Versioning](https://semver.org/) (`vMAJOR.MINOR.PATCH`
tags, matching `version` in `package.json`).

Each release section notes the component versions it ships: the Mac app
(`desktop/build.sh`), the iPhone app (`ios/project.yml`), the Chrome extension
(`extension/manifest.json`), and whether the sync API (`convex/`) changed. See
[docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

## [0.1.0] - 2026-11-08

First public release.

Components: Mac app 1.0 (build 7), iPhone app 1.0 (build 6), Chrome extension 2.2.1, sync API protocol `format=2`.

### Added

- Reader with on-device speech: Kokoro on Apple Silicon (MLX), Pocket TTS, and macOS voices. Includes word highlighting, click-to-listen from any word, paragraph skipping, follow-along scrolling with **Back to reading**, and 0.5–4× playback with pitch preserved.
- Imports from links, pasted text, and TXT, Markdown, HTML, or text-based PDF files. Headings, quote blocks, bold, italic, underline, safe links, and article images are kept.
- Library organization: flat tags, search, Recent and All works views, read/unread separate from listening progress, archive and restore, and confirmed delete.
- Native Mac app (AppKit and WKWebView) around the local server, with opt-in **Check for Updates…** that fetches only from the GitHub repository the app was built from, builds and tests each update before installing it, and rolls back on failure.
- iPhone app (SwiftUI): offline library, Pocket TTS through Core ML (full and 18M models), Apple voice fallback, lock-screen controls, native text selection with **Listen from here**, a share extension, and two Shortcuts actions.
- Chrome extension: one-click capture of the current page or selection, direct upload to the sync API, background image copying, and a persistent queue of pending imports with retry.
- Self-hosted sync on Convex: articles, images, tags, progress, read status, and archive/delete state, each with its own timestamp. Clients pair with a private QR code or link.
- `scripts/setup-mac.sh` sets up a fresh checkout in one command, installing from `requirements-macos.lock` (pinned, tested versions).
- iOS bundle identifiers and signing team are set in a gitignored `ios/Signing.local.xcconfig`, so forks can sign without editing tracked files.
- CI for the reader UI, server, sync API, extension, Mac wrapper, shared Swift code, and the iOS simulator build. Tagged releases publish notes from this changelog and attach a packaged extension.

[Unreleased]: https://github.com/ethanniser/local-reader/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ethanniser/local-reader/releases/tag/v0.1.0
