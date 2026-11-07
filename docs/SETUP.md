# Setup and everyday use

1. [Mac](#mac)
2. [Chrome extension](#chrome-extension)
3. [Sync backend (optional)](#sync-backend-optional)
4. [iPhone](#iphone)
5. [Using the library](#using-the-library)
6. [Data and troubleshooting](#data-and-troubleshooting)

## Mac

Requirements: an Apple Silicon Mac on macOS 14 or newer (MLX, which runs Kokoro, needs it), the Xcode command-line tools (`xcode-select --install`), [Bun](https://bun.sh), and [uv](https://docs.astral.sh/uv/). [FFmpeg](https://ffmpeg.org) is optional and only needed for playback above 1.5×, where it keeps the pitch natural.

```sh
git clone https://github.com/ethanniser/local-reader.git
cd local-reader
./scripts/setup-mac.sh --app          # add --pocket to also install Pocket TTS
ditto "desktop/build/Local Reader.app" "/Applications/Local Reader.app"
open "/Applications/Local Reader.app"
```

The setup script:

1. Runs `bun install` and builds the reader UI into `dist/`.
2. Creates a Python 3.12 environment at `~/Library/Caches/local-reader/venv` and installs `requirements-macos.lock`. That file pins every package (Kokoro, MLX, PyTorch, spaCy's English model, and the rest) to versions tested together. Maintainers regenerate it from `requirements.txt` with `./scripts/setup-mac.sh --lock`.
3. Downloads `mlx-community/Kokoro-82M-bf16` (about 370 MB) into the Hugging Face cache.
4. With `--pocket`, runs `scripts/install-pocket.command`, which creates a separate environment at `~/Library/Caches/local-reader-pocket/` and downloads the Pocket model and its eight preset voices.
5. With `--app`, builds `desktop/build/Local Reader.app`.

Every step can be repeated safely. Run it again after pulling changes that touch `requirements.txt`.

The app is a native window around a Python server that runs **from your checkout**. Keep the checkout in a stable place: its path is recorded in the app, so rebuild the app (`./desktop/build.sh`) if you move it. The app is ad-hoc signed for your Mac and is not notarized, so build it on the Mac that will run it.

The server listens only on `127.0.0.1:8787`. If you'd rather use a browser than the app window, run `python3 launch.py` and it opens `http://127.0.0.1:8787` for you. Quitting the app window leaves the server running, so speech and sync keep going.

### Environment overrides

| Variable | Effect |
| --- | --- |
| `LOCAL_READER_PYTHON` | Python executable for the server (default: the setup script's environment). Set while running `desktop/build.sh` to record it in the app. |
| `LOCAL_READER_DATA` | Server data directory, for testing. The app, the updater, and log files always use `~/Library/Application Support/Local Reader`. |
| `LOCAL_READER_SOURCE` | Checkout the Mac app runs from (default: the one it was built from) |
| `LOCAL_READER_UPDATE_REPOSITORY` | `owner/name` of the GitHub repository updates may come from |
| `LOCAL_READER_VENV` | Where `setup-mac.sh` creates the environment (keep the path short: espeak-ng fails on very long paths) |

Apps opened from Finder or the Dock do not see shell variables, so these matter mostly when you run `launch.py`, the scripts, or the app's executable from a terminal.

### Updating

Choose **Check for Updates…** in the app menu. The app also checks quietly at launch and hourly, and shows **Update available** in the title bar when there are new commits on `main`. Nothing installs until you confirm. Installing interrupts playback, so pick a good moment. Before your source is touched, the updater builds and tests the new revision in a temporary worktree and backs up the app, UI, and database. If anything fails, it restores what it replaced. [Releasing](RELEASING.md#updating-a-source-install) has the details and the command-line equivalent.

Updates come only from the GitHub repository the app was built from, which is your clone's `origin`. That remote must be a plain `https://github.com/owner/name` or `git@github.com:owner/name` URL; SSH host aliases are not recognized. Your checkout must be clean and on `main`; the updater never discards local edits.

## Chrome extension

1. Open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**.
2. Select the checkout's `extension/` folder (or an unzipped `local-reader-chrome-extension-*.zip` from a release). Pin **Send to Local Reader**.
3. Pair it with your library: in the Mac reader, open **Library sync → Copy pairing link**. In the extension's **Library settings**, paste the link and choose **Connect library**. This requires the [sync backend](#sync-backend-optional).
4. On an article you can read, open the extension and choose **Import this page**. That one click saves it; there is no review step. Each paired reader picks it up on its next sync.

The extension uploads straight to your sync API, so the Mac does not need to be on. If you select text first, only the selection is imported. Full-page imports bring up to 20 images: the text saves first, then the images copy in the background. Clicking **Import this page** also asks Chrome for optional access to all websites. The extension uses it only to fetch article images from their original sites and CDNs. If you decline, the text and any images readable from the page itself still save, and the rest are skipped. You can grant it later with **Allow remaining images**.

Opening the popup only shows connection and import status. It never captures a page, copies images, or resumes earlier work on its own. Unfinished imports stay under **Library settings → Pending imports** (up to 20), where you can retry, grant image access, or discard them. The extension never sends browser cookies anywhere and does not get around paywalls.

After pulling a new version, click **Reload** on the extension at `chrome://extensions`. If you loaded a copied folder, update that copy instead.

## Sync backend (optional)

Without sync, the Mac library stays on the Mac. To sync with an iPhone or use the Chrome extension, deploy the API in `convex/` to your own free [Convex](https://www.convex.dev) account. The API serves a **single library** protected by one pairing token you generate. It is not a multi-user service.

```sh
bunx convex dev --once            # log in, create a project, and push the functions
bunx convex deploy                # deploy to the project's production deployment
bunx convex env set --prod SYNC_TOKEN "$(openssl rand -hex 32)"
```

The pairing token must be at least 32 characters. Your sync address is the deployment's **HTTP Actions URL**, which looks like `https://your-deployment-123.convex.site` and is shown in the Convex dashboard under Settings → URL & Deploy Key. Check it with `curl https://your-deployment-123.convex.site/health`.

### Pair the Mac

The Mac reads its sync settings from a private file. Create it with your address and the token you set above (`bunx convex env get --prod SYNC_TOKEN` prints it):

```sh
cd ~/Library/Application\ Support/Local\ Reader
umask 077
cat > sync.json <<'JSON'
{ "url": "https://your-deployment-123.convex.site", "token": "PASTE-THE-SYNC-TOKEN" }
JSON
```

Then open **Library sync** in the reader and choose **Sync now**. The Mac syncs about every 20 seconds while the server runs. Its first sync uploads your existing library.

Treat the token, `sync.json`, the pairing link, and the pairing QR code as passwords. Anyone who has one can read and change your library. If one leaks, set a new `SYNC_TOKEN`, update `sync.json`, and pair every device again. Never put a Convex deploy key or admin key in a client.

Redeploying code (`bunx convex deploy`) leaves `SYNC_TOKEN` alone. You only need to re-pair when the token itself changes.

## iPhone

Requirements: Xcode 26 with the iOS platform installed, [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`), [Node.js](https://nodejs.org) (used by `prepare.sh`), and an iPhone on iOS 18 or newer. A free Apple ID signing team works for installing on your own phone.

```sh
./ios/prepare.sh
open ios/LocalReader.xcodeproj
```

Run `prepare.sh` before the first build. It checks out the pinned [FluidAudio](https://github.com/FluidInference/FluidAudio) SDK under `ios/.build/` (ignored by Git), generates the share extension's Safari preprocessing script from the Chrome extractor, and regenerates the Xcode project.

**Use your own bundle identifiers and team.** App IDs are unique across Apple accounts, so create `ios/Signing.local.xcconfig` (ignored by Git) before you sign:

```
LOCAL_READER_BUNDLE_PREFIX = com.yourname
DEVELOPMENT_TEAM = ABCDE12345
```

Every target, the shared keychain group, and `scripts/update-ios.py` use this file. Find your team ID in Xcode under Settings → Accounts. Don't change these values in Xcode's Signing & Capabilities pane or in `project.yml`: edits to tracked files leave the checkout dirty, and the Mac and iPhone updaters refuse to run on a dirty checkout. Then choose the **LocalReader** scheme, select your iPhone, and run.

On the phone:

1. Open **Settings**, choose a speech engine (**Pocket full**, **Pocket 18M**, or **Apple voice**), and download its model while online. Keep the app open while the model downloads and compiles.
2. Pair: in the Mac reader, open **Library sync** and scan the QR code with the iPhone camera, then confirm the server hostname in Local Reader. You can also type the address and token into Settings. The token is stored in the iOS Keychain.
3. Let the articles and images download. After that, reading and listening work offline, and the Mac can be off.

Pocket full uses the same English checkpoint as the Mac. Pocket 18M is smaller and faster. If generation can't keep up at your playback speed, especially with the phone locked, switch to 18M or Apple voice. Simulator builds can't confirm locked-screen performance, so try a long article on your own phone before relying on it.

Free-team provisioning profiles expire after seven days. When the app stops launching, rebuild and install it again from Xcode, or use `scripts/update-ios.py` ([Releasing](RELEASING.md#updating-the-iphone-app)). **Don't delete the app to update it**: that deletes its local library.

### Share sheet and Shortcuts

Open the main app once after installing, so its pairing is shared with the share extension. Then in Safari, choose **Share → Local Reader** to import the loaded page, a URL, or selected text straight into your synced library. Sharing a loaded page keeps its formatting and images. Sharing only a URL fetches the public page without your cookies. If the extension can't read the app's pairing, its **Connect sharing** section accepts the pairing link. Failed uploads wait in a queue of up to 20 and retry later.

In the Shortcuts app you'll find two actions:

- **Save Text to Local Reader** takes a title, text, and comma-separated tags. It saves on the phone even when offline, then syncs.
- **Save Web Article to Local Reader** takes a URL, fetches the public page, and saves it.

## Using the library

**Adding things.** On the Mac, **Add something to read** accepts a link, pasted text, or a TXT, Markdown, HTML, or text-based PDF file up to 20 MB. Scanned PDFs need OCR first. Link imports fetch public pages. For pages that need your login, use the Chrome extension.

**Listening.** Press Play or click any word. Space toggles playback, the left and right arrow keys jump 25 words, and the buttons beside Play move by paragraph. Choose the engine, voice, and pace (0.5–4×) in the player. Kokoro's word timings come from the model itself. Pocket and system-voice highlighting is estimated. Scrolling manually pauses follow-along, and **Back to reading** returns to the current word. Your position saves continuously.

**Organizing.** Every work can have tags, edited as a comma-separated list under the title. **Recent** (the default view) lists newly imported and recently played works first. **All works** is alphabetical. Search covers titles and tags. **Mark as read/unread** is separate from listening progress. In the Mac sidebar, right-click a work (or press Shift-F10) to mark it read or unread, **Archive** it (reversible, via the **Archived** view), or **Delete…** it (asks first, can't be undone). All of these sync. On iPhone, the same actions are in the article toolbar and the library's context menu, and **Listen from here** appears when you select text.

## Data and troubleshooting

| Location | Contents |
| --- | --- |
| `~/Library/Application Support/Local Reader/library.sqlite3` | Mac library: articles, tags, progress, sync state |
| …`/images/`, …`/audio/` | Saved images; generated speech cache (safe to delete with the server stopped) |
| …`/server.log`, …`/pocket.log`, …`/update.log` | Diagnostics |
| …`/sync.json` | Sync address and token (private) |
| `~/Library/Caches/local-reader/` | Python environment |
| `~/.cache/huggingface/` | Downloaded models |
| iPhone Application Support `LocalReader/` | Phone library, images, and speech models |

Back up the Mac data directory with the server stopped. Sync copies your library to other devices, but it does not keep old versions, so it is not a backup.

**The page won't load.** Make sure the server is running: open the app, or run `python3 launch.py`. Then check `server.log`. Use `http://127.0.0.1:8787`, not `https`.

**"Local voice ready" never appears, or speech is silent.** The first passage after startup is slower while the model loads. Check the Mac's output device, then pause and play again. If an engine shows "not installed", run `./scripts/setup-mac.sh` (Kokoro) or `./scripts/setup-mac.sh --pocket` while online.

**Playback can't keep up.** Try a lower speed, close other GPU-heavy apps, or switch engines. Speech is generated about 30 seconds ahead.

**Long listening sessions.** Sleep stops local generation. Keep the Mac awake (for example, `caffeinate -i -t 21600` keeps it awake for six hours).

**Sync errors.** Reading and listening keep working offline, and changes upload once the connection is back. Check the address and token in `sync.json`, and test the address with `curl <address>/health`. Log files can contain article text, so share only the lines you need when asking for help.
