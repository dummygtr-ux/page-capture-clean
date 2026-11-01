#!/usr/bin/env bash
# Page Capture — fetch a release and unpack it into a stable folder.
#
#   curl -fsSL https://raw.githubusercontent.com/dummygtr-ux/page-capture-clean/main/scripts/install.sh | bash
#   ./install.sh --from ~/Downloads/page-capture-chrome.zip
#   ./install.sh --from https://github.com/dummygtr-ux/page-capture-clean/releases/latest/download/page-capture-chrome.zip
set -euo pipefail

REPO="${PAGECAPTURE_REPO:-dummygtr-ux/page-capture-clean}"
TARGET="${PAGECAPTURE_DIR:-$HOME/.local/share/page-capture}"
FROM=""

while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --to) TARGET="$2"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ZIP="$TMP/page-capture.zip"

if [ -n "$FROM" ]; then
  case "$FROM" in
    http*) echo "downloading $FROM"; curl -fL --retry 3 -o "$ZIP" "$FROM" ;;
    *) [ -f "$FROM" ] || { echo "no such file: $FROM" >&2; exit 1; }; cp "$FROM" "$ZIP" ;;
  esac
else
  URL="https://github.com/${REPO}/releases/latest/download/page-capture-chrome.zip"
  echo "downloading $URL"
  curl -fL --retry 3 -o "$ZIP" "$URL" || {
    echo "download failed. Pass --from <zip|url> or set PAGECAPTURE_REPO=owner/repo" >&2; exit 1; }
fi

mkdir -p "$TARGET"
unzip -oq "$ZIP" -d "$TARGET"

if [ ! -f "$TARGET/manifest.json" ]; then
  echo "unpacked, but manifest.json is not at the top of $TARGET" >&2
  echo "look for a nested folder and point your browser there instead" >&2
  exit 1
fi

echo
echo "Installed to: $TARGET"
echo
echo "Now, once:"
echo "  1. open  chrome://extensions  (or edge://extensions / brave://extensions)"
echo "  2. turn on 'Developer mode'"
echo "  3. 'Load unpacked' -> select  $TARGET"
echo "  4. set the shortcut at chrome://extensions/shortcuts"
echo
echo "Keep that folder where it is; moving it breaks the extension."
