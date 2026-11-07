#!/bin/zsh
set -e
reader_root="${0:A:h:h}"
pocket_python="$HOME/Library/Caches/local-reader-pocket/venv/bin/python"
base_python="${LOCAL_READER_PYTHON:-$HOME/Library/Caches/local-reader/venv/bin/python}"
legacy_python="$HOME/Library/Caches/antikythera-local-tts/venv/bin/python"
if [[ -z "${LOCAL_READER_PYTHON:-}" && ! -x "$base_python" && -x "$legacy_python" ]]; then
  base_python="$legacy_python"
fi
uv_cmd="$(command -v uv || true)"
for candidate in "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv "/etc/profiles/per-user/$USER/bin/uv"; do
  if [[ -z "$uv_cmd" && -x "$candidate" ]]; then uv_cmd="$candidate"; fi
done
if [[ -z "$uv_cmd" ]]; then
  echo 'uv is missing. Install it while online before setting up Pocket.'
  exit 1
fi
if [[ ! -x "$pocket_python" ]]; then
  "$uv_cmd" venv --python "$base_python" "${pocket_python:h:h}"
fi
"$uv_cmd" pip install --python "$pocket_python" 'pocket-tts==3.1.0' 'soundfile==0.14.0'
"$pocket_python" "$reader_root/scripts/prepare_pocket.py"
echo 'Pocket is installed. Select Pocket TTS in the reader.'
