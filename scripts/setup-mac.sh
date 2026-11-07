#!/bin/bash
# One-time setup for a fresh Local Reader checkout on an Apple Silicon Mac.
#
#   ./scripts/setup-mac.sh             frontend, Python environment, Kokoro model
#   ./scripts/setup-mac.sh --app       ...and build "desktop/build/Local Reader.app"
#   ./scripts/setup-mac.sh --pocket    ...and install the optional Pocket TTS engine
#   ./scripts/setup-mac.sh --lock      only regenerate requirements-macos.lock (maintainers)
#
# Run it again at any time; every step is idempotent. Needs network access.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHES="$HOME/Library/Caches"
LEGACY_VENV="$CACHES/antikythera-local-tts/venv"
if [[ -n "${LOCAL_READER_VENV:-}" ]]; then
  VENV="$LOCAL_READER_VENV"
elif [[ ! -x "$CACHES/local-reader/venv/bin/python" && -x "$LEGACY_VENV/bin/python" ]]; then
  VENV="$LEGACY_VENV" # keep using an environment created by an earlier version
else
  VENV="$CACHES/local-reader/venv"
fi
KOKORO_MODEL="mlx-community/Kokoro-82M-bf16"
BUILD_APP=0
INSTALL_POCKET=0

for arg in "$@"; do
  case "$arg" in
    --app) BUILD_APP=1 ;;
    --pocket) INSTALL_POCKET=1 ;;
    --lock)
      cd "$ROOT"
      MACOSX_DEPLOYMENT_TARGET=14.0 uv pip compile --quiet --python-platform aarch64-apple-darwin \
        --python-version 3.12 --custom-compile-command './scripts/setup-mac.sh --lock' \
        requirements.txt -o requirements-macos.lock
      echo 'Updated requirements-macos.lock. Test speech with it before committing.'
      exit 0 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing $1. $2" >&2
    exit 1
  fi
}

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'Local Reader for Mac needs an Apple Silicon Mac (Kokoro runs on MLX/Metal).' >&2
  exit 1
fi
if (( "$(sw_vers -productVersion | cut -d. -f1)" < 14 )); then
  echo 'Local Reader needs macOS 14 or newer (MLX, which runs Kokoro, has no macOS 13 build).' >&2
  exit 1
fi
need bun 'Install it from https://bun.sh.'
need uv 'Install it from https://docs.astral.sh/uv/.'
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo 'Note: FFmpeg is not installed. Playback above 1.5x needs it for pitch-preserving speed-up (brew install ffmpeg).'
fi

step 'Building the reader UI'
cd "$ROOT"
bun install --frozen-lockfile
bun run build

step "Creating the Python environment at $VENV"
if [[ ! -x "$VENV/bin/python" ]]; then
  uv venv --python 3.12 "$VENV"
fi
VENV="$(cd "$VENV" && pwd)" # the app records this path, so make it absolute
# The lock pins every package to versions tested together on Apple Silicon.
uv pip install --python "$VENV/bin/python" -r "$ROOT/requirements-macos.lock"

step "Downloading the Kokoro model ($KOKORO_MODEL, about 370 MB)"
"$VENV/bin/python" - "$KOKORO_MODEL" <<'PY'
import sys
from huggingface_hub import snapshot_download
print(snapshot_download(sys.argv[1]))
PY

if [[ "$INSTALL_POCKET" == 1 ]]; then
  step 'Installing Pocket TTS'
  LOCAL_READER_PYTHON="$VENV/bin/python" zsh "$ROOT/scripts/install-pocket.command"
fi

if [[ "$BUILD_APP" == 1 ]]; then
  step 'Building Local Reader.app'
  # A custom environment is recorded in the app, which can't see shell variables.
  if [[ "$VENV" != "$CACHES/local-reader/venv" && "$VENV" != "$LEGACY_VENV" ]]; then
    LOCAL_READER_PYTHON="$VENV/bin/python" "$ROOT/desktop/build.sh"
  else
    "$ROOT/desktop/build.sh"
  fi
  echo 'Copy it to /Applications with: ditto "desktop/build/Local Reader.app" "/Applications/Local Reader.app"'
fi

step 'Done'
if [[ "$VENV" != "$CACHES/local-reader/venv" && "$VENV" != "$LEGACY_VENV" ]]; then
  echo "Custom environment: export LOCAL_READER_PYTHON=\"$VENV/bin/python\" when using launch.py or the scripts."
fi
echo "Start the reader with:  python3 launch.py   (or build the Mac app with --app)"
