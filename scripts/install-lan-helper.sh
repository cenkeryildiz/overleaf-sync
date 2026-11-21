#!/bin/sh
# Registers the "Share on this network" relay helper with Google Chrome on macOS (owner computer only;
# participants need no helper). Run from the repository root:  sh scripts/install-lan-helper.sh   [--uninstall]
set -eu
NAME=com.cenker.latex_lan
EXTENSION_ID=oekjjadnainlmdbgbdjokegaikafafke
APP_DIR="$HOME/Library/Application Support/LaTeX Local"
HOSTS_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
BINARY="$APP_DIR/latex-local-lan"
MANIFEST="$HOSTS_DIR/$NAME.json"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f -- "$MANIFEST" "$BINARY"
  rmdir -- "$APP_DIR" 2>/dev/null || true
  echo "Removed the sharing helper and its Chrome registration."
  exit 0
fi

[ "$(uname -s)" = Darwin ] || { echo "This installer is for macOS." >&2; exit 1; }
[ -f runtime/chrome-extension/lan/Cargo.toml ] || { echo "Run this from the repository root." >&2; exit 1; }
BUILD_DIR=$(mktemp -d)
trap 'rm -rf -- "$BUILD_DIR"' EXIT
CARGO_TARGET_DIR="$BUILD_DIR" cargo build --offline --release --quiet --manifest-path runtime/chrome-extension/lan/Cargo.toml
mkdir -p -- "$APP_DIR" "$HOSTS_DIR"
cp -- "$BUILD_DIR/release/latex-local-lan" "$BINARY"
chmod 755 -- "$BINARY"
cat > "$MANIFEST" <<EOF
{"name":"$NAME","description":"LaTeX Local: Share on this network","path":"$BINARY","type":"stdio","allowed_origins":["chrome-extension://$EXTENSION_ID/"]}
EOF
chmod 644 -- "$MANIFEST"
echo "Installed. Restart Chrome, then use Share in the editor. Remove with: sh scripts/install-lan-helper.sh --uninstall"
