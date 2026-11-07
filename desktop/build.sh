#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="$HERE/build/Local Reader.app"
# The app runs the reader from this checkout unless another absolute path is given.
SOURCE="${1:-$(cd "$HERE/.." && pwd)}"
ICON="$HERE/../assets/AppIcon.icns"
REVISION="$(git -C "$HERE/.." rev-parse HEAD)"
# Check for Updates… only fetches from the GitHub repository this app was built from.
ORIGIN="$(git -C "$HERE/.." remote get-url origin 2>/dev/null || true)"
UPDATE_REPOSITORY="$(printf '%s' "$ORIGIN" | sed -E 's#/$##; s#\.git$##' | sed -nE 's#^(git@github\.com:|ssh://git@github\.com/|https://github\.com/)([A-Za-z0-9-]+/[A-Za-z0-9._-]+)$#\2#p')"
if [[ "$SOURCE" != /* ]]; then
  echo 'Pass an absolute path to the installed Local Reader source directory.' >&2
  exit 1
fi
mkdir -p "$OUTPUT/Contents/MacOS" "$OUTPUT/Contents/Resources" "$HERE/build/module-cache"
xcrun swiftc -swift-version 5 -O -target "$(uname -m)-apple-macosx13.0" \
  -module-cache-path "$HERE/build/module-cache" \
  -framework AppKit -framework WebKit "$HERE/main.swift" \
  -o "$OUTPUT/Contents/MacOS/LocalReader"
if [[ -f "$ICON" ]]; then
  cp "$ICON" "$OUTPUT/Contents/Resources/AppIcon.icns"
fi
/usr/bin/python3 - "$OUTPUT/Contents/Info.plist" "$SOURCE" "$REVISION" "$UPDATE_REPOSITORY" "${LOCAL_READER_PYTHON:-}" <<'PY'
import plistlib, sys
info = {
    'CFBundleName': 'Local Reader',
    'CFBundleIconFile': 'AppIcon',
    'CFBundleDisplayName': 'Local Reader',
    'CFBundleIdentifier': 'com.ethanniser.localreader.mac',
    'CFBundleExecutable': 'LocalReader',
    'CFBundlePackageType': 'APPL',
    'CFBundleShortVersionString': '1.0',
    'CFBundleVersion': '7',
    'LocalReaderRevision': sys.argv[3],
    'LSMinimumSystemVersion': '13.0',
    'NSHighResolutionCapable': True,
    'LocalReaderSourcePath': sys.argv[2],
    'NSAppTransportSecurity': {
        'NSAllowsLocalNetworking': True,
        'NSExceptionDomains': {
            'localhost': {'NSExceptionAllowsInsecureHTTPLoads': True},
            '127.0.0.1': {'NSExceptionAllowsInsecureHTTPLoads': True},
        },
    },
}
if sys.argv[4]:
    info['LocalReaderUpdateRepository'] = sys.argv[4]
if sys.argv[5]:
    info['LocalReaderPython'] = sys.argv[5]  # set LOCAL_READER_PYTHON at build time for a custom venv
with open(sys.argv[1], 'wb') as f:
    plistlib.dump(info, f)
PY
/usr/bin/codesign --force --sign - "$OUTPUT"
echo "$OUTPUT"
