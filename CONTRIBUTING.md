# Contributing

Local Reader is a personal project shared in the hope it's useful. Issues and pull requests are welcome. Reviews happen when there's time, and changes that don't fit the project's direction may be declined. For anything large, open an issue first.

## Getting set up

Follow [Setup](docs/SETUP.md#mac) on an Apple Silicon Mac. Server, UI, sync API, and extension work also runs on Linux. You won't have Kokoro there, but the tests don't need it:

```sh
bun install --frozen-lockfile && bun run build
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt
```

## Before opening a pull request

- Run the checks from [Releasing](docs/RELEASING.md#checks-before-a-release) that cover what you changed. CI runs all of them.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- Keep the existing guarantees: the server binds only to loopback, sync clients never follow redirects with credentials, imports never execute page scripts, and nothing installs or restarts without an explicit user action.
- Don't commit personal data: real article text, `sync.json`, pairing tokens or QR codes, signing team IDs, or device identifiers. Test fixtures use public-domain or invented text.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
