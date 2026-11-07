# Versions, changelog, and releases

Local Reader ships as source. A **release** is a Git tag with GitHub release notes and a packaged Chrome extension. Nothing is uploaded to the App Store, TestFlight, or the Chrome Web Store, and tagging or pushing never changes an installed app. Installed copies update only when their owner chooses to (see [Updating a source install](#updating-a-source-install)).

## Version numbers

| What | Where | Bump when |
| --- | --- | --- |
| Repository release | `package.json` `version`, tag `vX.Y.Z` | Every release (Semantic Versioning) |
| Mac app | `desktop/build.sh`: `CFBundleShortVersionString`, `CFBundleVersion` | Mac wrapper or user-visible Mac behavior changes (always bump the build number) |
| iPhone app | `ios/project.yml`: `MARKETING_VERSION`, `CURRENT_PROJECT_VERSION` (app and share extension must match) | iOS code changes; run `./ios/prepare.sh` afterwards to regenerate the project |
| Chrome extension | `extension/manifest.json` `version` | Any change under `extension/` |
| Sync API | `convex/` (no number) | Record in the changelog whenever it changed and needs redeploying |

The repository version describes the whole project. Component versions move on their own and are listed in each changelog section.

## Changelog

[CHANGELOG.md](../CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Add entries under `## [Unreleased]` as part of each change, grouped as **Added**, **Changed**, **Fixed**, **Removed**, or **Security**. Write for people running the app, not for reviewers of the diff. Call out anything that needs action: redeploying `convex/`, re-pairing, running `setup-mac.sh` again, or reloading the extension.

`node scripts/release-notes.mjs --check` (run in CI) validates the headings. It also checks that the newest released section matches `package.json`.

## Making a release

1. Make sure `main` is green in CI.
2. Bump component versions that changed (table above).
3. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`. Add the component versions line, then start a fresh empty `## [Unreleased]` above it. Update the link references at the bottom:

   ```md
   [Unreleased]: https://github.com/ethanniser/local-reader/compare/vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/ethanniser/local-reader/compare/vPREVIOUS...vX.Y.Z
   ```

   For the first release, link `[X.Y.Z]` to `https://github.com/ethanniser/local-reader/releases/tag/vX.Y.Z` instead.
4. Set `version` in `package.json` to `X.Y.Z`.
5. Preview the notes: `node scripts/release-notes.mjs X.Y.Z`.
6. Commit (`Release vX.Y.Z`), tag, and push:

   ```sh
   git tag -a vX.Y.Z -m "Local Reader vX.Y.Z"
   git push origin main vX.Y.Z
   ```

The [release workflow](../.github/workflows/release.yml) runs the full CI suite on the tag, then creates the GitHub release. It uses the changelog section as the notes and attaches `local-reader-chrome-extension-<version>.zip`. It fails without publishing anything if the tag doesn't match `package.json` or the changelog section is missing.

## Checks before a release

CI covers builds and automated tests. Everything in it can also run locally:

```sh
bun install --frozen-lockfile && bun run build
bun test tests
bun run test:convex
bun run test:extension
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
python3 -m unittest discover -s scripts -p 'test_updates.py'
python3 desktop/test_update_notice.py
./desktop/build.sh
./ios/prepare.sh && xcodebuild -project ios/LocalReader.xcodeproj -scheme LocalReader \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

For capture changes, also run `node extension/test-extraction.cjs` and `node extension/test-image-cache.cjs` with Chrome installed and `PLAYWRIGHT_MODULE` pointing at a `playwright-core` install (CI does this). For iOS unit tests, pick a simulator in Xcode and use Product → Test.

Automated checks can't cover everything. When the affected areas changed, also test by hand:

- **Mac:** launch without Terminal, import a link and a file, play with each engine, reopen the window, and run **Check for Updates…**.
- **iPhone (real device):** long playback with the screen locked, lock-screen pause/resume, interruptions, offline playback with the Mac off, pairing, Safari sharing, and both Shortcuts actions.
- **Chrome:** pair, run a one-click import with the Mac closed, and check image retry and the pending-import queue.
- **Sync:** after deploying, check `/health`, confirm unauthenticated requests are rejected, and sync between two devices. Deletion must stick even when a stale client syncs later.

## Updating a source install

### Mac

Use **Check for Updates…** in the app, or from the command line:

```sh
python3 scripts/update-mac.py --check --json          # add --dry-run to skip fetching
# quit the app window, then install exactly the revision you reviewed:
python3 scripts/update-mac.py --install --revision FULL_COMMIT_SHA
```

`--source` defaults to the checkout that contains the script. The app must be installed at `/Applications/Local Reader.app`, the path the updater replaces. The updater:

1. Requires a clean checkout on `main` whose `origin` is the expected GitHub repository: the one recorded in the installed app at build time, `LOCAL_READER_UPDATE_REPOSITORY`, or upstream `ethanniser/local-reader` for apps built before that was recorded. The update must be a fast-forward.
2. Builds and tests the candidate (frontend, Python tests, timeline tests, native wrapper) in a temporary worktree while the current server keeps running. It never runs `pip` or changes the Python environment. When a release changes `requirements-macos.lock`, its changelog says so; run `./scripts/setup-mac.sh` before updating. A missing dependency usually makes the candidate's tests fail, which stops the update, but a dependency that is only imported at runtime would not be caught.
3. Backs up the app, frontend, and SQLite database under `~/Library/Application Support/Local Reader/updates/`. Models, images, and credentials stay where they are.
4. Stops only the server process it can confirm belongs to this install, fast-forwards the source, replaces the app and UI, starts the new server, and confirms it is the one responding.
5. If any step fails, it restores the previous app, frontend, source, and database where it safely can, and keeps the backups.

The menu action writes progress to `update.log` and a summary to `update-result.json` in the data directory.

### Updating the iPhone app

Install over the existing app with the same bundle ID and signing team. Deleting the app deletes its library.

```sh
python3 scripts/update-ios.py --device DEVICE_ID --team TEAM_ID \
  --revision FULL_COMMIT_SHA --source "$PWD" --dry-run
```

Remove `--dry-run` to prepare the SDK, build, verify the signing team, and install with `devicectl`. Add `--allow-provisioning` if Xcode needs to register the device or renew the free-team profile. The script refuses to run when the checkout is dirty or isn't at the given revision. The bundle ID comes from `ios/Signing.local.xcconfig` when present ([Setup](SETUP.md#iphone)).

### Chrome extension

Pull, then click **Reload** on the extension at `chrome://extensions`. If you installed from a release zip, replace the folder with the new one and reload.

### Sync API

After the Convex typecheck and tests pass:

```sh
bunx convex deploy
```

Confirm the deployment it targets before you approve. Deploying code never changes `SYNC_TOKEN`. Never put the pairing token, a Convex deploy key, `sync.json`, or a pairing QR code in release notes, logs, or screenshots.
