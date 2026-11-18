#!/bin/bash
# Echo Server - installs, updates or removes Echo Server, the Echo build of the
# BlueBubbles server, on the Mac that sends your iMessages.
#
#   curl -fsSL https://raw.githubusercontent.com/leoble123/echo-updates/main/mac/echo-server.sh | bash
#   ... | bash -s -- update      fetch the newest Echo Server and swap it in
#   ... | bash -s -- status      is it running, how much memory, what has Echo Guard done
#   ... | bash -s -- uninstall   remove Echo Server and put BlueBubbles back
#
# Install:
#  1. Downloads the newest Echo Server build and checks its checksum.
#  2. Signs it on this Mac with a key made here that never leaves it. macOS ties
#     permissions such as Full Disk Access to that signature, so you grant them
#     once and they survive every update.
#  3. Stops BlueBubbles (it stays in /Applications, untouched, as a fallback) and
#     stops it opening at login.
#  4. Starts Echo Server under launchd, which restarts it if it ever stops.
# Echo Server uses BlueBubbles' settings, so your address, password and phone
# setup carry over as they are.
#
# Written for macOS's own bash (3.2).

set -u
REPO="leoble123/echo-updates"
APP="/Applications/Echo Server.app"
ECHO_DIR="$HOME/Library/Application Support/Echo"
KEYCHAIN="$ECHO_DIR/signing.keychain-db"
KEYPASS_FILE="$ECHO_DIR/.signing-pass"
CERT_NAME="Echo Server (this Mac)"
LABEL="com.echo.server"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
BB_AGENT="$HOME/Library/LaunchAgents/com.bluebubbles.server.plist"
GUARDIAN_AGENT="$HOME/Library/LaunchAgents/com.echo.guardian.plist"
BB_DIR="$HOME/Library/Application Support/bluebubbles-server"
UID_N=$(id -u)
# Echo for Mac: the app you see, which watches and manages the engine.
ECHO_APP="/Applications/Echo.app"
APP_LABEL="com.echo.app"
APP_AGENT="$HOME/Library/LaunchAgents/$APP_LABEL.plist"

say() { printf '%s\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

need_mac() {
  [ "$(uname)" = "Darwin" ] || fail "This is for the Mac that runs your iMessage server."
  [ "$(uname -m)" = "arm64" ] || fail "Echo Server is built for Apple Silicon Macs."
}

# --- Download -----------------------------------------------------------------

latest_zip_url() {
  # Echo Server builds are tagged server-<version>-<build>. The releases API
  # doesn't reliably return them newest first, so pick the highest build
  # number ourselves. Builds before 5 were test builds and are never installed.
  curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=100" \
    | grep -o '"browser_download_url": *"[^"]*/server-[^"]*/EchoServer-[^"]*\.zip"' \
    | sed 's/.*"\(https[^"]*\)"$/\1/' \
    | awk -F'[-.]' '{ n = $(NF-1) + 0; if (n >= 5 && n > best) { best = n; url = $0 } } END { if (url) print url }'
}

download() {
  local url tmp
  url=$(latest_zip_url)
  [ -n "$url" ] || fail "Couldn't find an Echo Server build to download."
  mkdir -p "$ECHO_DIR"
  printf '%s\n' "$url" > "$ECHO_DIR/.latest-url"
  tmp=$(mktemp -d)
  say "Downloading $(basename "$url")…" >&2
  curl -fL --progress-bar -o "$tmp/server.zip" "$url" || fail "Download failed."
  curl -fsSL -o "$tmp/server.zip.sha256" "$url.sha256" || fail "Couldn't fetch the checksum."
  local want got
  want=$(awk '{print $1}' "$tmp/server.zip.sha256")
  got=$(shasum -a 256 "$tmp/server.zip" | awk '{print $1}')
  [ "$want" = "$got" ] || fail "The download doesn't match its checksum - not installing it."
  ditto -x -k "$tmp/server.zip" "$tmp/x" || fail "Couldn't unpack the download."
  local found
  found=$(find "$tmp/x" -maxdepth 1 -name "*.app" | head -1)
  [ -n "$found" ] || fail "The download didn't contain an app."
  xattr -dr com.apple.quarantine "$found" 2>/dev/null
  printf '%s\n' "$found"
}

# The build number of a download URL: .../EchoServer-1.9.9-14.zip -> 14
build_of() { basename "$1" .zip | awk -F- '{print $NF}'; }

# Echo.app from the same release as the engine, if that release has one.
download_echo_app() {
  local url build app_url tmp want got found
  url=$(cat "$ECHO_DIR/.latest-url" 2>/dev/null)
  [ -n "$url" ] || return 1
  build=$(build_of "$url")
  app_url="${url%/*}/Echo-$build.zip"
  curl -fsIL "$app_url" >/dev/null 2>&1 || return 1
  tmp=$(mktemp -d)
  say "Downloading Echo for Mac…" >&2
  curl -fL --progress-bar -o "$tmp/echo.zip" "$app_url" || return 1
  curl -fsSL -o "$tmp/echo.zip.sha256" "$app_url.sha256" || return 1
  want=$(awk '{print $1}' "$tmp/echo.zip.sha256")
  got=$(shasum -a 256 "$tmp/echo.zip" | awk '{print $1}')
  [ "$want" = "$got" ] || { say "Echo for Mac doesn't match its checksum - skipping it." >&2; return 1; }
  ditto -x -k "$tmp/echo.zip" "$tmp/x" || return 1
  found=$(find "$tmp/x" -maxdepth 1 -name "Echo.app" | head -1)
  [ -n "$found" ] || return 1
  xattr -dr com.apple.quarantine "$found" 2>/dev/null
  printf '%s\n' "$found"
}

write_app_agent() {
  cat > "$APP_AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$APP_LABEL</string>
    <key>Program</key><string>$ECHO_APP/Contents/MacOS/Echo</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key><false/>
    </dict>
    <key>ProcessType</key><string>Interactive</string>
    <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
EOF
}

# Puts Echo.app in place and keeps it running at login. Quitting it (from its
# menu) is respected until the next login; a crash brings it back.
install_echo_app() {
  local new
  new=$(download_echo_app) || { say "(Echo for Mac isn't in this build yet - the engine is updated on its own.)"; return 0; }
  sign_app "$new"
  rm -rf "$ECHO_APP.old"
  [ -d "$ECHO_APP" ] && mv "$ECHO_APP" "$ECHO_APP.old"
  ditto "$new" "$ECHO_APP" || { [ -d "$ECHO_APP.old" ] && mv "$ECHO_APP.old" "$ECHO_APP"; say "Couldn't copy Echo into Applications."; return 0; }
  rm -rf "$ECHO_APP.old" "$(dirname "$new")"
  write_app_agent
  if [ "${ECHO_FROM_APP:-}" = "1" ]; then
    # Echo ran this update; it switches to the new copy itself when we finish.
    launchctl bootstrap "gui/$UID_N" "$APP_AGENT" 2>/dev/null
  else
    launchctl bootout "gui/$UID_N/$APP_LABEL" 2>/dev/null
    pkill -x Echo 2>/dev/null
    sleep 1
    launchctl bootstrap "gui/$UID_N" "$APP_AGENT" 2>/dev/null || launchctl kickstart -k "gui/$UID_N/$APP_LABEL"
  fi
  say "Echo for Mac is in your menu bar."
}

record_build() {
  local url; url=$(cat "$ECHO_DIR/.latest-url" 2>/dev/null)
  [ -n "$url" ] && build_of "$url" > "$ECHO_DIR/installed-build"
}

# --- Signing --------------------------------------------------------------------

keychain_pass() { cat "$KEYPASS_FILE"; }

identity_hash() {
  security find-certificate -c "$CERT_NAME" -Z "$KEYCHAIN" 2>/dev/null | awk '/SHA-1 hash:/{print $3; exit}'
}

ensure_identity() {
  mkdir -p "$ECHO_DIR"
  if [ -f "$KEYCHAIN" ] && [ -n "$(identity_hash)" ]; then
    security unlock-keychain -p "$(keychain_pass)" "$KEYCHAIN" >/dev/null 2>&1
    return
  fi
  say "Making this Mac's signing key (once)…"
  local tmp; tmp=$(mktemp -d)
  ( umask 077; LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32 > "$KEYPASS_FILE" )
  cat > "$tmp/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $CERT_NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 7300 \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -config "$tmp/cert.cnf" >/dev/null 2>&1 \
    || fail "Couldn't make a signing certificate."
  /usr/bin/openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
    -out "$tmp/id.p12" -passout pass:echo >/dev/null 2>&1 || fail "Couldn't package the signing key."
  rm -f "$KEYCHAIN"
  security create-keychain -p "$(keychain_pass)" "$KEYCHAIN" || fail "Couldn't create the signing keychain."
  security set-keychain-settings "$KEYCHAIN"   # no auto-lock
  security unlock-keychain -p "$(keychain_pass)" "$KEYCHAIN"
  security import "$tmp/id.p12" -k "$KEYCHAIN" -P echo -T /usr/bin/codesign >/dev/null \
    || fail "Couldn't import the signing key."
  security set-key-partition-list -S apple-tool:,apple: -s -k "$(keychain_pass)" "$KEYCHAIN" >/dev/null 2>&1
  rm -rf "$tmp"   # the private key now lives only in the keychain
}

sign_app() {
  local app="$1" id
  ensure_identity
  id=$(identity_hash)
  [ -n "$id" ] || fail "The signing key is missing."
  say "Signing with this Mac's key…"
  if ! codesign --force --deep --keychain "$KEYCHAIN" -s "$id" "$app" 2>/tmp/echo-sign.err; then
    # Some macOS versions only sign with a certificate the user trusts for code signing.
    say "macOS needs you to trust the signing certificate once (it may ask for your password)."
    security find-certificate -c "$CERT_NAME" -p "$KEYCHAIN" > "$ECHO_DIR/signing-cert.pem"
    security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$ECHO_DIR/signing-cert.pem" \
      || fail "Couldn't trust the certificate: $(cat /tmp/echo-sign.err)"
    codesign --force --deep --keychain "$KEYCHAIN" -s "$id" "$app" || fail "Signing failed."
  fi
  codesign --verify --deep "$app" 2>/dev/null || say "(Signature check reported a warning; carrying on.)"
}

# --- Services -------------------------------------------------------------------

stop_bluebubbles() {
  if pgrep -xq BlueBubbles; then
    say "Stopping BlueBubbles…"
    osascript -e 'quit app "BlueBubbles"' >/dev/null 2>&1
    for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -xq BlueBubbles || break; sleep 1; done
    pkill -x BlueBubbles 2>/dev/null
  fi
  # Don't let it come back at login: its launch agent and login item.
  if [ -f "$BB_AGENT" ]; then
    launchctl bootout "gui/$UID_N/com.bluebubbles.server" 2>/dev/null
    mv "$BB_AGENT" "$BB_AGENT.echo-disabled"
  fi
  osascript -e 'tell application "System Events" to delete (every login item whose name is "BlueBubbles")' >/dev/null 2>&1
  # Echo Lean's guardian looked after BlueBubbles; Echo Server has its own.
  if [ -f "$GUARDIAN_AGENT" ]; then
    launchctl bootout "gui/$UID_N/com.echo.guardian" 2>/dev/null
    rm -f "$GUARDIAN_AGENT"
  fi
}

write_agent() {
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/Echo"
  cat > "$AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>AssociatedBundleIdentifiers</key><array><string>com.echo.server-app</string></array>
    <key>Program</key><string>$APP/Contents/MacOS/Echo Server</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key><false/>
        <key>Crashed</key><true/>
    </dict>
    <key>ProcessType</key><string>Interactive</string>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>$HOME/Library/Logs/Echo/server.log</string>
    <key>StandardErrorPath</key><string>$HOME/Library/Logs/Echo/server.log</string>
</dict>
</plist>
EOF
}

start_server() {
  launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null
  sleep 1
  launchctl bootstrap "gui/$UID_N" "$AGENT" 2>/dev/null || launchctl kickstart -k "gui/$UID_N/$LABEL"
}

stop_server() {
  launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -fq "Echo Server.app/Contents/MacOS/Echo Server" || break; sleep 1; done
  pkill -f "Echo Server.app/Contents/MacOS/Echo Server" 2>/dev/null
}

place_app() {
  local new="$1"
  rm -rf "$APP.old"
  [ -d "$APP" ] && mv "$APP" "$APP.old"
  ditto "$new" "$APP" || { [ -d "$APP.old" ] && mv "$APP.old" "$APP"; fail "Couldn't copy Echo Server into Applications."; }
  rm -rf "$APP.old" "$(dirname "$new")"
}

# --- Commands -------------------------------------------------------------------

install() {
  need_mac
  [ -f "$BB_DIR/config.db" ] || say "Note: no BlueBubbles settings found - you'll set Echo Server up from scratch."
  bold "Installing Echo Server"
  local new; new=$(download) || exit 1
  sign_app "$new"
  stop_bluebubbles
  stop_server
  place_app "$new"
  write_agent
  start_server
  record_build
  install_echo_app
  sleep 8
  if pgrep -fq "Echo Server.app/Contents/MacOS/Echo Server"; then
    bold "Echo Server is running."
  else
    say "Echo Server didn't stay up - see ~/Library/Logs/Echo/server.log"
  fi
  say ""
  say "First time only: macOS needs to let Echo Server read your messages."
  say "In the window that opens, switch on Echo Server under Full Disk Access"
  say "(use + to add it from Applications if it isn't listed). It restarts itself after."
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2>/dev/null
  say ""
  say "Also allow Contacts, Accessibility and Automation if macOS asks."
  say "To go back to BlueBubbles at any time:  … | bash -s -- uninstall"
}

update() {
  need_mac
  [ -d "$APP" ] || { install; return; }
  bold "Updating Echo Server"
  local new; new=$(download) || exit 1
  sign_app "$new"
  stop_server
  place_app "$new"
  write_agent
  start_server
  record_build
  install_echo_app
  bold "Updated to build $(cat "$ECHO_DIR/installed-build" 2>/dev/null)."
}

status() {
  need_mac
  if pgrep -fq "Echo Server.app/Contents/MacOS/Echo Server"; then
    bold "Echo Server is running"
  else
    bold "Echo Server is NOT running"
  fi
  launchctl print "gui/$UID_N/$LABEL" 2>/dev/null | grep -E "state =|last exit|runs =" | sed 's/^[[:space:]]*/  /'
  say ""
  say "Memory (MB):"
  ps -axo rss=,comm= | awk '
    /Echo Server/ {s+=$1}
    /Messages.app\/Contents\/MacOS\/Messages$/ {m+=$1}
    /FindMy.app/ {f+=$1}
    /FaceTime.app/ {t+=$1}
    END {printf "  Echo Server %d\n  Messages    %d\n  Find My     %d\n  FaceTime    %d\n", s/1024, m/1024, f/1024, t/1024}'
  say "  Free disk   $(df -g "$HOME" | awk 'NR==2{print $4}') GB"
  say ""
  say "Recent Echo Guard actions:"
  local log; log=$(ls -t "$HOME/Library/Logs/bluebubbles-server/"*.log 2>/dev/null | head -1)
  if [ -n "$log" ]; then grep -h "EchoGuard" "$log" | tail -n 10 | sed 's/^/  /'; else say "  (no log yet)"; fi
}

uninstall() {
  need_mac
  bold "Removing Echo Server"
  stop_server
  rm -f "$AGENT"
  rm -rf "$APP"
  launchctl bootout "gui/$UID_N/$APP_LABEL" 2>/dev/null
  pkill -x Echo 2>/dev/null
  rm -f "$APP_AGENT"
  rm -rf "$ECHO_APP"
  if [ -f "$BB_AGENT.echo-disabled" ]; then
    mv "$BB_AGENT.echo-disabled" "$BB_AGENT"
    launchctl bootstrap "gui/$UID_N" "$BB_AGENT" 2>/dev/null
  fi
  if [ -d "/Applications/BlueBubbles.app" ]; then
    open -a BlueBubbles
    say "BlueBubbles is back, with the same settings."
  fi
  say "The signing key is kept in $ECHO_DIR in case you reinstall."
}

case "${1:-install}" in
  install) install ;;
  update) update ;;
  status|report) status ;;
  uninstall|undo) uninstall ;;
  *) say "Usage: echo-server.sh [install|update|status|uninstall]"; exit 1 ;;
esac
