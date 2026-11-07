#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SDK="$ROOT/.build/FluidAudio"
REVISION=e396cf780c4abf8e395087467c0585d3b0d17f68
mkdir -p "$ROOT/.build"
if [ ! -d "$SDK/.git" ]; then
  git clone https://github.com/FluidInference/FluidAudio.git "$SDK"
fi
if ! git -C "$SDK" cat-file -e "$REVISION^{commit}" 2>/dev/null; then
  git -C "$SDK" fetch origin "$REVISION"
fi
git -C "$SDK" checkout --detach "$REVISION"
# Xcode 26.0 does not propagate SwiftPM traits. The upstream compatibility
# manifest defines TTS explicitly and exposes the exact same pinned sources.
# Use that manifest rather than disabling Pocket or changing SDK source code.
rm -f "$SDK/Package@swift-6.2.swift"
node "$ROOT/prepare-share.mjs"
xcodegen generate --spec "$ROOT/project.yml"
