# Local Reader for macOS

This native AppKit application embeds Local Reader in a persistent WKWebView window. It starts the existing loopback-only Python server if needed, opens no Terminal or browser window, and keeps the same SQLite library, downloaded speech models, and article images.

Build on this Mac with Xcode command-line tools:

```sh
./desktop/build.sh
open "desktop/build/Local Reader.app"
```

`scripts/setup-mac.sh --app` runs this for you. The optional first argument is an absolute path to the checkout the app should run; the default is the checkout containing `build.sh`. The path is embedded in `Info.plist`; `LOCAL_READER_SOURCE` can override it when launching the executable directly. Install it at `/Applications/Local Reader.app`: **Check for Updates…** replaces the app at that path. Rebuild it if the checkout moves. The build also records the GitHub repository of the checkout's `origin` as the only place **Check for Updates…** may fetch from.

The app window runs on macOS 13 or newer, but Kokoro (MLX) needs macOS 14. It also needs the built `dist/` folder, and the Python environment created by `scripts/setup-mac.sh` (`~/Library/Caches/local-reader/venv`, or `LOCAL_READER_PYTHON`). It is a local wrapper, **not a self-contained distributable**: it does not bundle Python, speech models, or application source and is only ad-hoc signed, not notarized. Normal Launch Services launches reuse the existing app instance.

Cmd-R reconnects/reloads the reader. Cmd-W closes the window; click the Dock icon or use File → Open Reader Window to reopen it. Cmd-Q quits the window application. The local server stays running, and library data remains on disk; Chrome imports do not depend on it. External article links and requested downloads open the default browser rather than navigating the embedded reader away from localhost. File imports use the standard macOS file picker. WebView browser storage is separate from Chrome, while the library and saved listening positions are shared through the server.

## Chrome imports

The Chrome extension imports an article directly into the paired Convex library after you click **Import this page**; opening its popup does not capture or copy images. It works with the Mac app and Python server closed. Pair it through **Library sync → Copy pairing link** and the extension's **Library settings**. There is no native-messaging host to install. See [Setup](../docs/SETUP.md) and [Architecture](../docs/ARCHITECTURE.md) for the current flow.

## Update availability

The app checks its update repository quietly on launch, hourly while running, and when activated if its last check was at least an hour ago. A title-bar **Update available** button and **Update Available…** menu item remain visible when a newer revision is known. Offline or failed checks do not show modal alerts or erase a previously found update. Checks only fetch Git metadata; they never install, restart the server, or interrupt playback. Click the indicator to recheck and review the existing **Install and Relaunch / Later** confirmation.

Run `python3 desktop/test_update_notice.py` to exercise the real native check path against an isolated fake updater, without opening the reader or touching its server/library.
