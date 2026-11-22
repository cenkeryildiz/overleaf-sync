#!/bin/sh
# Installs the "Share on this network" helper on macOS for every Chrome-family browser that is present.
# Every computer that shares or joins needs it once. From the extension package double-click "Install Sharing Helper",
# or run  sh sharing-helper/install.sh   (repository: sh scripts/install-lan-helper.sh)   [--uninstall]
set -eu
NAME=com.cenker.latex_lan
TEX_NAME=com.cenker.latex_local   # stage 3: runs the TeX installation the participant chooses, for "Help compile for the group"
EXTENSION_ID=oekjjadnainlmdbgbdjokegaikafafke
SUPPORT="$HOME/Library/Application Support"
APP_DIR="$SUPPORT/LaTeX Local"
BINARY="$APP_DIR/latex-local-lan"
TEX_BINARY="$APP_DIR/latex-local-host"
FIREWALL=/usr/libexec/ApplicationFirewall/socketfilterfw
# Each browser reads native-messaging hosts from <its support folder>/NativeMessagingHosts.
BROWSERS="Google/Chrome
Google/Chrome Beta
Google/Chrome Dev
Google/Chrome Canary
Google/Chrome for Testing
Chromium
Microsoft Edge
Microsoft Edge Beta
Microsoft Edge Dev
Microsoft Edge Canary
BraveSoftware/Brave-Browser
BraveSoftware/Brave-Browser-Beta
Vivaldi"

if [ "${1:-}" = "--uninstall" ]; then
  echo "$BROWSERS" | while IFS= read -r browser; do rm -f -- "$SUPPORT/$browser/NativeMessagingHosts/$NAME.json" "$SUPPORT/$browser/NativeMessagingHosts/$TEX_NAME.json"; done
  rm -f -- "$BINARY" "$TEX_BINARY" "$APP_DIR/settings.json"; rmdir -- "$APP_DIR" 2>/dev/null || true
  echo "Removed the sharing helper and its browser registrations."
  exit 0
fi

[ "$(uname -s)" = Darwin ] || { echo "This installer is for macOS." >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
if [ -f "$HERE/latex-local-lan" ]; then SOURCE="$HERE/latex-local-lan"; TEX_SOURCE="$HERE/latex-local-host"   # ready-built copies shipped with the extension
else
  [ -f runtime/chrome-extension/lan/Cargo.toml ] || { echo "Run this from the extension's sharing-helper folder or the repository root." >&2; exit 1; }
  BUILD_DIR=$(mktemp -d); trap 'rm -rf -- "$BUILD_DIR"' EXIT
  CARGO_TARGET_DIR="$BUILD_DIR" cargo build --offline --release --quiet --manifest-path runtime/chrome-extension/lan/Cargo.toml
  CARGO_TARGET_DIR="$BUILD_DIR" cargo build --offline --release --quiet --manifest-path runtime/chrome-extension/native/Cargo.toml
  SOURCE="$BUILD_DIR/release/latex-local-lan"; TEX_SOURCE="$BUILD_DIR/release/latex-local-host"
fi
mkdir -p -- "$APP_DIR"
cp -- "$SOURCE" "$BINARY"
cp -- "$TEX_SOURCE" "$TEX_BINARY"
chmod 755 "$BINARY" "$TEX_BINARY"
xattr -d com.apple.quarantine "$BINARY" "$TEX_BINARY" 2>/dev/null || true   # copied via AirDrop/ZIP: macOS would refuse to start it

count=0
for browser in $(echo "$BROWSERS" | tr ' ' '\001'); do
  browser=$(echo "$browser" | tr '\001' ' ')
  [ -d "$SUPPORT/$browser" ] || continue   # browser not installed or never opened
  mkdir -p -- "$SUPPORT/$browser/NativeMessagingHosts"
  printf '{"name":"%s","description":"LaTeX Local: Share on this network","path":"%s","type":"stdio","allowed_origins":["chrome-extension://%s/"]}\n' \
    "$NAME" "$BINARY" "$EXTENSION_ID" > "$SUPPORT/$browser/NativeMessagingHosts/$NAME.json"
  printf '{"name":"%s","description":"LaTeX Local: your chosen TeX installation","path":"%s","type":"stdio","allowed_origins":["chrome-extension://%s/"]}\n' \
    "$TEX_NAME" "$TEX_BINARY" "$EXTENSION_ID" > "$SUPPORT/$browser/NativeMessagingHosts/$TEX_NAME.json"
  chmod 644 "$SUPPORT/$browser/NativeMessagingHosts/$NAME.json" "$SUPPORT/$browser/NativeMessagingHosts/$TEX_NAME.json"
  echo "Registered for $browser"; count=$((count + 1))
done
[ "$count" -gt 0 ] || { echo "No Chrome-family browser found. Open Chrome once, then run this again." >&2; exit 1; }

# The owner's computer must accept incoming connections from the participants.
if "$FIREWALL" --getglobalstate 2>/dev/null | grep -q enabled; then
  echo "The macOS firewall is on: allowing the helper to accept connections (your password may be asked)."
  if sudo "$FIREWALL" --add "$BINARY" >/dev/null && sudo "$FIREWALL" --unblockapp "$BINARY" >/dev/null; then echo "Firewall: allowed."
  else echo "Firewall not changed. To share from this computer later, run: sudo $FIREWALL --add \"$BINARY\"; sudo $FIREWALL --unblockapp \"$BINARY\""; fi
fi
echo "Installed. Quit and reopen the browser (Cmd+Q), then use Share or Join."
