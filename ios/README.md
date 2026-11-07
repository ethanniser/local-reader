# Local Reader for iPhone

Native SwiftUI reader with a local library, flat tags, offline reading, on-device Pocket TTS and authenticated Convex sync. The Mac does not need to be running once the phone has synced its articles and downloaded the speech model.

## Build

Requirements: Xcode 26 with the iOS platform installed, iOS 18 or newer, XcodeGen, and Node.js.

```sh
./ios/prepare.sh
xcodebuild -project ios/LocalReader.xcodeproj -scheme LocalReader \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/local-reader-ios-build CODE_SIGNING_ALLOWED=NO build
```

The preparation script installs a pinned SDK checkout under ignored `ios/.build/` and selects upstream’s Swift 6.0 compatibility manifest. Xcode 26.0 does not propagate SwiftPM traits, so the newer trait-based manifest otherwise compiles without TTS symbols. SDK source code is unchanged.

Put your own bundle prefix and team in `ios/Signing.local.xcconfig` (see [Setup](../docs/SETUP.md#iphone); `Signing.xcconfig` documents the format), then open `ios/LocalReader.xcodeproj` and run on an iPhone. Don't set the team in Xcode's Signing pane: that edits the tracked project. No signing identity or account credential is stored in the project. The shared Foundation models, persistence and sync client live in `LocalReader/Shared` for reuse by a native Mac app.

Run core checks without an iOS simulator:

```sh
swiftc -module-cache-path /tmp/local-reader-swift-module-cache -swift-version 5 \
  -parse-as-library ios/LocalReader/Shared/*.swift ios/Checks/CoreChecks.swift \
  -o /tmp/local-reader-core-checks
/tmp/local-reader-core-checks
```

The Xcode test scheme includes persistence, document decoding and configuration validation tests.

## Speech

Pocket uses FluidAudio pinned to commit `e396cf780c4abf8e395087467c0585d3b0d17f68`. The full option uses `PocketTtsManager(language: .english2026Apr, placement: .ane)` with explicit CPU/Neural Engine conditioning, FlowLM and flow decoder, plus CPU-only Mimi decoding. Temperature is 0.3 to match the Mac April checkpoint configuration. This avoids the SDK default GPU routing; actual physical-device speed and locked-screen continuity still require validation. The smaller fallback uses `PocketTtsSmallManager(model: .english18m, computeUnits: .cpuAndNeuralEngine)` and the fp32 CPU Mimi decoder. The model downloads on first setup into Application Support and is retained for offline use. Keep the app foregrounded during the first download and Core ML compilation.

Playback uses AVAudioSession's playback/spoken-audio category, background audio mode, lock-screen commands, interruption recovery and headphone-disconnect pausing. Next chunks are synthesized ahead of playback. Pocket word positioning is approximate; Apple voice is an explicit alternative. A physical-device locked-screen run is required to verify sustained inference/playback for the chosen iPhone and OS; simulator builds alone cannot prove that behavior.

## Sync and pairing

Settings accepts an HTTPS Convex HTTP-actions address and pairing key. The key is stored in Keychain with after-first-unlock accessibility, never in the library JSON. The app also accepts `localreader://pair?url=...&token=...` links and asks for confirmation of the server hostname before connecting.

The client uses authenticated GET `/sync?format=2`, GET `/documents?id=...&format=2`, POST `/documents`, PUT `/tags`, PUT `/progress`, PUT `/read-status`, PUT `/lifecycle`, POST `/images`, and GET `/images?id=...`. Content, metadata, progress, read status, and archive/delete state use separate timestamps. Offline changes are persisted before upload; sync failures leave them queued. Redirects are refused to avoid forwarding the pairing key to another host. Synced images are downloaded locally; remote image URLs are never loaded directly by the reader view.

## Attribution

- [FluidAudio](https://github.com/FluidInference/FluidAudio), FluidInference: Apache 2.0.
- [Pocket TTS](https://huggingface.co/kyutai/pocket-tts), Kyutai: CC BY 4.0 model weights.
- [FluidAudio Core ML conversion](https://huggingface.co/FluidInference/pocket-tts-coreml).

The app offers public preset voices only; it does not record or clone a user's voice.

## Import on iPhone

The bundled **Local Reader** Share extension imports a loaded Safari page, selected text, or a web URL directly into the paired cloud library. It does not need the Mac running. Open the main app once after upgrading to publish the existing pairing into the shared Keychain group. The extension shows connection/import status and also accepts a trusted pairing link as a fallback, showing the destination hostname before connecting. Both targets keep their original default Keychain group and add the same explicit shared group; no App Groups entitlement or shared filesystem container is used. Unsigned simulator builds do not exercise this entitlement; it is checked when you sign for a device.

Safari preprocessing captures visible content and supported formatting from the open page, without copying cookies. `prepare.sh` regenerates `ShareExtension/Preprocess.js` from the same reviewed extractor as Chrome. A URL-only import fetches HTML anonymously without scripts, cookies, subresources, or redirects. Login-protected or redirected pages should be shared after opening in Safari, or shared as selected text. Native fetching rejects obvious local hostnames and literal addresses; it is not a DNS-pinned network isolation service.

Failed cloud imports remain in the extension's protected local queue (up to 20), associated with the pairing address that accepted them. Retry there or share again when online. They appear in the main app after upload and sync; the extension cannot write the main app's private files. Optional image failures do not block article text. Successful images are decoded, bounded and uploaded as PNGs.

Shortcuts exposes **Save Text to Local Reader** (Title, Text, Tags) and **Save Web Article to Local Reader** (Article URL). These actions open the main app and save to its local library, then use normal sync. Text imports work offline. URL imports need network access to initially retrieve the article; subsequent reading and speech work offline. To use a shortcut from the Share Sheet, enable **Show in Share Sheet**, pass the shared text to the text action or a URL to the web action. For authenticated pages, Safari's Share extension is the preferred path.

Block quotes retain their own paragraph kind and display with an inset and secondary text color, including quote paragraphs nested inside a blockquote. Formatting uses optional global word ranges for bold, italic, underline and HTTP(S) links. Old local libraries refresh missing formatting once without changing their content timestamps. The article is one native selectable text surface: select and copy across paragraphs, or select a word and choose **Listen from here**. Selecting or scrolling suspends automatic following; **Return to current** resumes it. Links retain native interaction.

## Library status and deletion

The library defaults to **Recent**, ordered by the newer of import time and listening activity. Its context menu offers independent read/unread, Archive/Unarchive, and Delete actions. The Archive filter shows retained archived articles; archiving keeps their content and playback position. Delete requires confirmation and is permanent for that article ID across synced devices. The phone hides the entry, clears its local article text, and stops its playback.

Lifecycle state has its own persisted queue and timestamp, independent of tags, read status and progress. The client requests `/sync?format=2`, applies deletion tombstones before uploading pending changes, and handles a deletion racing a request by refreshing its tombstone. Deleted article IDs are never uploaded as live content. Quote-capable document requests use `format=2`; earlier local formatting caches refresh paragraph kinds and marks once without changing listening progress.
