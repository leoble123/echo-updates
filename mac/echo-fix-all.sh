#!/bin/bash
# Echo - Mac Fix-All.
#
# A check-up for the Mac that runs Echo Server, and everything it can fix in
# one go:
#
#   1. A check-up        - memory, disk, power, Echo Server, the Private API,
#                           permissions, typing, your permanent address.
#   2. Clears out the     - BlueBubbles left running beside Echo Server, and
#      old BlueBubbles       the jobs older Echo scripts installed for it: a
#      set-up               4:15 a.m. restart of Messages (which drops the
#                           Private API), a watchdog, and a login item that
#                           reopened BlueBubbles. Echo Guard, inside Echo
#                           Server, does that job now - without restarting
#                           anything at night.
#   3. Never sleeps       - the Mac stays awake on power, wakes for the network
#                           and starts again by itself after a power cut.
#   4. No surprise        - macOS stops installing big updates (and restarting)
#      restarts             on its own. Security fixes still install.
#   5. No App Nap         - macOS stops pausing Echo Server and Messages when
#                           they're in the background.
#   6. Starts at login    - Echo Server and Echo for Mac come back by
#                           themselves after a restart.
#   7. Tidy-up            - old converted copies of attachments (the server
#                           remakes them when needed) are cleared.
#
# It asks before changing anything, and asks for your Mac password once (for
# the power and update settings). Safe to run again; run it with --undo to put
# the power, update and App Nap settings back. (To remove Echo Server itself:
# Echo for Mac → Uninstall, or echo-server.sh uninstall.)
#
# If double-clicking says you don't have permission: open Terminal, type
# "bash " (with the space), drag this file in, press Return.
#
# Written for macOS's own bash (3.2).

set -u
BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; OFF=$'\033[0m'
say()   { printf '%s\n' "$*"; }
step()  { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$OFF"; }
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$*"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$*"; }
bad()   { printf '  %s✗%s %s\n' "$RED" "$OFF" "$*"; }
info()  { printf '  %s%s%s\n' "$DIM" "$*" "$OFF"; }
finish() { printf '\n'; read -r -p "Press Return to close." _; exit "${1:-0}"; }
ask()   { local a; read -r -p "$1 [Y/n] " a; [[ ! "$a" =~ ^[Nn] ]]; }

[ "$(uname)" = "Darwin" ] || { say "Run this on the Mac that runs Echo Server."; exit 1; }

UID_N=$(id -u)
ECHO_DIR="$HOME/Library/Application Support/Echo"
AGENTS="$HOME/Library/LaunchAgents"
BB_DIR="$HOME/Library/Application Support/bluebubbles-server"   # Echo Server keeps BlueBubbles' settings
BB_DB="$BB_DIR/config.db"
SERVER_APP="/Applications/Echo Server.app"
SERVER_BIN="Echo Server.app/Contents/MacOS/Echo Server"
SERVER_LABEL="com.echo.server"
ECHO_APP="/Applications/Echo.app"
ECHO_APP_LABEL="com.echo.app"
INSTALLER="https://raw.githubusercontent.com/leoble123/echo-updates/main/mac/echo-server.sh"
mkdir -p "$ECHO_DIR" "$AGENTS"

# Jobs older Echo scripts installed for BlueBubbles. Each one now gets in the way.
OLD_JOBS="app.echo.watchdog app.echo.login-apps app.echo.nightly-restart com.echo.guardian"
old_job_name() {
    case "$1" in
        app.echo.nightly-restart) echo "the 4:15 a.m. restart of Messages (it drops the Private API every night)" ;;
        app.echo.watchdog) echo "the old watchdog (it restarted BlueBubbles and Messages behind Echo Guard's back)" ;;
        app.echo.login-apps) echo "the old login item (it reopened BlueBubbles at every login)" ;;
        com.echo.guardian) echo "Echo Lean's guardian (made for BlueBubbles)" ;;
    esac
}
BUNDLES="com.echo.server-app com.apple.MobileSMS com.apple.FaceTime com.apple.findmy"

loaded() { launchctl print "gui/$UID_N/$1" >/dev/null 2>&1; }
unload() { launchctl bootout "gui/$UID_N/$1" 2>/dev/null; rm -f "$AGENTS/$1.plist"; }
server_running() { pgrep -fq "$SERVER_BIN"; }
bb_running() { pgrep -xq BlueBubbles; }

# --- undo ------------------------------------------------------------------
if [ "${1:-}" = "--undo" ]; then
    step "Putting this Mac's settings back"
    for b in $BUNDLES; do defaults delete "$b" NSAppSleepDisabled 2>/dev/null; done
    ok "App Nap back to normal"
    say "${DIM}Your Mac password, to put the power and update settings back:${OFF}"
    if sudo -v; then
        sudo pmset -a restoredefaults >/dev/null 2>&1 && ok "Power settings back to macOS's defaults"
        sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool true
        ok "macOS updates install automatically again"
    fi
    info "Echo Server itself is left as it is. To remove it: Echo for Mac → Uninstall."
    finish
fi

# --- 1. check-up -------------------------------------------------------------
say "${BOLD}Echo Mac Fix-All${OFF}  ${DIM}- a check-up first; nothing changes until you say so.${OFF}"

step "This Mac"
OSV=$(sw_vers -productVersion)
MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
LAPTOP=0; pmset -g batt 2>/dev/null | grep -q InternalBattery && LAPTOP=1
say "  macOS $OSV · ${MEM_GB} GB memory · $( [ $LAPTOP = 1 ] && echo laptop || echo desktop ) · up $(uptime | sed 's/.*up \([^,]*\),.*/\1/')"
[ "$(uname -m)" = "arm64" ] || bad "This is an Intel Mac. Echo Server is built for Apple Silicon only."
FREE_GB=$(df -g / | awk 'NR==2 {print $4}')
if [ "${FREE_GB:-0}" -lt 10 ]; then bad "Only ${FREE_GB} GB free on the disk. Messages and the server need room - aim for 20 GB."
else ok "${FREE_GB} GB free on the disk"; fi
SWAP=$(sysctl -n vm.swapusage 2>/dev/null | awk '{print $6}')
FREE_PCT=$(memory_pressure 2>/dev/null | awk -F': ' '/System-wide memory free percentage/ {print $2}' | tr -d '%')
if [ -n "$FREE_PCT" ] && [ "$FREE_PCT" -lt 15 ]; then warn "Memory is tight (${FREE_PCT}% free, ${SWAP} swapped to disk). Echo Guard restarts what grows too big."
else ok "Memory: ${FREE_PCT:-?}% free, ${SWAP:-?} swapped"; fi
if [ $LAPTOP = 1 ]; then
    if pmset -g batt | grep -q "AC Power"; then ok "Plugged in"; else bad "Running on battery - keep it plugged in."; fi
    info "A closed lid puts a laptop to sleep unless an external display is connected."
fi
WIFI_DEV=$(networksetup -listallhardwareports 2>/dev/null | awk '/Hardware Port: (Wi-Fi|AirPort)/ {getline; print $2; exit}')
NET_DEV=$(route -n get default 2>/dev/null | awk '/interface:/ {print $2}')
if [ -n "$WIFI_DEV" ] && [ "$NET_DEV" = "$WIFI_DEV" ]; then
    info "On Wi-Fi. An Ethernet cable, if you can run one, is steadier for a Mac that's always on."
elif [ -n "$NET_DEV" ]; then
    ok "On a wired connection"
fi

step "Echo Server"
INSTALLED=0; [ -d "$SERVER_APP" ] && INSTALLED=1
PORT=""; PASSWORD=""; ADDRESS=""; PROXY=""
if [ -f "$BB_DB" ] && command -v sqlite3 >/dev/null; then
    q() { sqlite3 "$BB_DB" "select value from config where name='$1';" 2>/dev/null; }
    PORT=$(q socket_port | tr -dc '0-9'); PASSWORD=$(q password); ADDRESS=$(q server_address)
    PROXY=$(q proxy_service | tr 'A-Z' 'a-z' | tr -dc 'a-z')
fi
PORT=${PORT:-1234}
enc() { local s="$1" o="" c i; for ((i=0; i<${#s}; i++)); do c=${s:i:1}; case "$c" in [a-zA-Z0-9.~_-]) o+="$c";; *) o+=$(printf '%%%02X' "'$c");; esac; done; printf '%s' "$o"; }
PW_Q=$(enc "$PASSWORD")
# One call to the server's API, and one field out of its JSON answer.
get() { curl -s -m 10 "http://127.0.0.1:$PORT/api/v1/$1?password=$PW_Q" 2>/dev/null; }
field() { printf '%s' "$1" | plutil -extract "data.$2" raw -o - - 2>/dev/null; }

STATUS=""; PRIVATE_ON=""; HELPER=""; FULLDISK=""; ACCESS=""; HEARD=""; UPTIME=0
if [ $INSTALLED = 0 ]; then
    bad "Echo Server isn't installed - this Mac is still on BlueBubbles, or on nothing."
else
    if server_running; then ok "Running"; else bad "Echo Server isn't running."; fi
    if loaded "$SERVER_LABEL"; then ok "Starts by itself (and restarts if it ever stops)"
    else warn "Not set to start by itself - fixed below."; fi
    CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "http://127.0.0.1:$PORT/api/v1/ping?password=$PW_Q")
    if [ "$CODE" = 200 ]; then ok "Answering on port $PORT"; else bad "Not answering on port $PORT (got $CODE)."; fi
    STATUS=$(get echo/status)
    SINFO=$(get server/info)
    VER=$(field "$STATUS" version); [ -n "$VER" ] && info "Version $VER"
    UPTIME=$(field "$STATUS" uptimeSec); UPTIME=${UPTIME:-0}
    PRIVATE_ON=$(field "$SINFO" private_api); HELPER=$(field "$STATUS" privateApi)
    if [ "$PRIVATE_ON" = true ]; then
        if [ "$HELPER" = true ]; then ok "Private API on and connected - typing, tapbacks, edits and unsend all work"
        else bad "Private API is on but not connected to Messages. Echo Guard reconnects it within ten minutes; if it never does, see the list at the end."; fi
    else
        warn "Private API is off. Messages still send, but no typing, tapbacks, editing or unsend."
    fi
    FULLDISK=$(field "$STATUS" permissions.fullDisk); ACCESS=$(field "$STATUS" permissions.accessibility)
    [ "$FULLDISK" = false ] && bad "Echo Server doesn't have Full Disk Access - it can't read your messages."
    [ "$FULLDISK" = true ] && ok "Full Disk Access"
    [ "$ACCESS" = false ] && warn "No Accessibility access - some Mac controls won't work."
    HEARD=$(field "$STATUS" typing.heard)
    if [ "$HELPER" = true ]; then
        if [ "${HEARD:-0}" -gt 0 ] 2>/dev/null; then ok "Typing indicators: heard someone typing $HEARD times since Echo Server started"
        elif [ "$UPTIME" -gt 3600 ]; then warn "Typing indicators: none heard in $(( UPTIME / 3600 )) hours. If people have typed to you, the helper isn't getting typing on this macOS."
        else info "Typing indicators: nothing heard yet (Echo Server started $(( UPTIME / 60 )) minutes ago)"; fi
    fi
fi
# The permanent address: a Tailscale name or your own domain never moves; a
# temporary tunnel gets a new address at every restart.
PERMANENT=0
case "$ADDRESS" in *.ts.net*) PERMANENT=1 ;; https://*) [ "$PROXY" = dynamicdns ] && PERMANENT=1 ;; esac
case "$ADDRESS" in
    *.ts.net*)
        CHECK_OK=$(field "$STATUS" addressCheck.ok); CHECK=$(field "$STATUS" addressCheck.detail)
        if [ "$CHECK_OK" = false ]; then bad "Permanent address $ADDRESS: ${CHECK:-not reachable}. Echo Server keeps trying to turn it back on."
        else ok "Permanent address: $ADDRESS${CHECK:+ ($CHECK)}"; fi ;;
    "") warn "No address for your phone to reach this Mac from outside." ;;
    *) [ $PERMANENT = 1 ] && ok "Permanent address: $ADDRESS" || warn "Address $ADDRESS isn't permanent - it can change when Echo Server restarts, and your phone loses the Mac. Run Echo Permanent Address.command." ;;
esac

step "Left over from BlueBubbles"
LEFTOVERS=0
if bb_running; then
    bad "BlueBubbles is running beside Echo Server. Two servers fight over Messages and the Private API."
    LEFTOVERS=1
fi
BB_LOGIN=0
if [ -f "$AGENTS/com.bluebubbles.server.plist" ] || osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null | grep -q BlueBubbles; then
    BB_LOGIN=1; LEFTOVERS=1
    warn "BlueBubbles still opens at login."
fi
FOUND_JOBS=""
for j in $OLD_JOBS; do
    if [ -f "$AGENTS/$j.plist" ] || loaded "$j"; then
        FOUND_JOBS="$FOUND_JOBS $j"; LEFTOVERS=1
        warn "Found $(old_job_name "$j")."
    fi
done
[ $LEFTOVERS = 0 ] && ok "Nothing left over"

step "Echo for Mac"
if [ -d "$ECHO_APP" ]; then
    if pgrep -xq Echo; then ok "In the menu bar"; else warn "Installed, but not open - fixed below."; fi
else
    info "Not installed. It comes with the next Echo Server update, or the installer."
fi

step "Messages and friends"
for app in Messages FaceTime FindMy; do
    if pgrep -xq "$app"; then ok "$app is open"; else info "$app isn't open"; fi
done
info "Echo Server opens Messages itself, with the Private API helper loaded."
SIP=$(csrutil status 2>/dev/null | tr 'A-Z' 'a-z')
case "$SIP" in *disabled*) info "System Integrity Protection is off (the Private API needs it partly off)";; esac
TS=""
for c in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then TS="$c"; break; fi
done
if [ -n "$TS" ]; then
    if "$TS" status >/dev/null 2>&1; then ok "Tailscale connected"; else bad "Tailscale isn't connected. Open it and sign in."; fi
fi

step "Startup"
if [ "$(fdesetup status 2>/dev/null | grep -c 'is On')" = 1 ]; then
    FILEVAULT=1; info "FileVault is on: after a power cut the Mac waits at the login screen until someone types the password."
else
    FILEVAULT=0
    if defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser >/dev/null 2>&1; then ok "Logs in automatically"
    else warn "Doesn't log in by itself, so after a restart nothing runs until someone logs in."; fi
fi

events=$(printf '%s' "$STATUS" | plutil -extract data.events json -o - - 2>/dev/null | grep -o '"text":"[^"]*"' | tail -n 5 | sed 's/"text":"//; s/"$//')
if [ -n "$events" ]; then
    step "What Echo Guard did lately"
    printf '%s\n' "$events" | sed 's/^/  /'
fi

# --- 2. fixes ----------------------------------------------------------------
step "Fixes"
INSTALL=0
if [ $INSTALLED = 0 ]; then
    if ask "Install Echo Server now? (BlueBubbles stays in Applications, untouched, as a fallback)"; then INSTALL=1; fi
fi
say "Here's what will change:"
[ $INSTALL = 1 ] && say "  • Install Echo Server and Echo for Mac"
[ $LEFTOVERS = 1 ] && say "  • Stop BlueBubbles, and remove the old BlueBubbles-era jobs listed above"
say "  • Never sleep$( [ $LAPTOP = 1 ] && echo ' while plugged in'), wake for network, restart after a power cut"
say "  • Big macOS updates wait for you (security fixes still install)"
say "  • App Nap off for Echo Server, Messages, FaceTime and Find My"
say "  • Echo Server and Echo for Mac start by themselves at login"
say "  • Old converted attachment copies (over 30 days) cleared"
info "No watchdog and no nightly restart: Echo Guard, inside Echo Server, looks after it."
ask "Make all of these changes?" || { say "Nothing changed."; finish; }

if [ $INSTALL = 1 ]; then
    step "Installing Echo Server"
    curl -fsSL "$INSTALLER" | bash -s -- install || bad "The install didn't finish - see what it said above."
    [ -d "$SERVER_APP" ] && INSTALLED=1
fi

if [ $LEFTOVERS = 1 ]; then
    for j in $FOUND_JOBS; do unload "$j"; done
    rm -f "$ECHO_DIR/watchdog.sh" "$ECHO_DIR/nightly-restart.sh" "$ECHO_DIR/login-apps.sh" "$ECHO_DIR/guardian.sh"
    rm -rf "$ECHO_DIR/watchdog-state"
    [ -n "$FOUND_JOBS" ] && ok "Old jobs removed - nothing restarts Messages at night any more"
    if bb_running; then
        osascript -e 'quit app "BlueBubbles"' >/dev/null 2>&1
        for _ in 1 2 3 4 5 6 7 8 9 10; do bb_running || break; sleep 1; done
        pkill -x BlueBubbles 2>/dev/null
        ok "BlueBubbles stopped (it stays in Applications as a fallback)"
    fi
    if [ $BB_LOGIN = 1 ]; then
        if [ -f "$AGENTS/com.bluebubbles.server.plist" ]; then
            launchctl bootout "gui/$UID_N/com.bluebubbles.server" 2>/dev/null
            mv "$AGENTS/com.bluebubbles.server.plist" "$AGENTS/com.bluebubbles.server.plist.echo-disabled"
        fi
        osascript -e 'tell application "System Events" to delete (every login item whose name is "BlueBubbles")' >/dev/null 2>&1
        ok "BlueBubbles no longer opens at login"
    fi
fi

say "${DIM}Your Mac password, for the power and update settings (it isn't stored):${OFF}"
if sudo -v; then
    PM="sleep 0 disksleep 0 displaysleep 15 womp 1 powernap 0 tcpkeepalive 1 standby 0"
    pmset -g custom > "$ECHO_DIR/pmset-before.txt" 2>/dev/null
    if [ $LAPTOP = 1 ]; then sudo pmset -c $PM >/dev/null 2>&1; else sudo pmset -a $PM >/dev/null 2>&1; fi
    sudo pmset -a autorestart 1 >/dev/null 2>&1
    ok "Stays awake$( [ $LAPTOP = 1 ] && echo ' on power'), wakes for the network, restarts after a power cut"
    SU=/Library/Preferences/com.apple.SoftwareUpdate
    sudo defaults write $SU AutomaticallyInstallMacOSUpdates -bool false
    sudo defaults write $SU CriticalUpdateInstall -bool true
    sudo defaults write $SU ConfigDataInstall -bool true
    ok "macOS updates wait for you; security fixes still install"
else
    warn "Skipped the power and update settings (no password)."
fi

for b in $BUNDLES; do defaults write "$b" NSAppSleepDisabled -bool YES 2>/dev/null; done
ok "App Nap off (takes effect the next time each app opens)"

# Starting by itself: the launch agents the installer wrote. launchd brings
# Echo Server back if it ever stops, and opens it at every login.
if [ $INSTALLED = 1 ]; then
    if ! loaded "$SERVER_LABEL" && [ -f "$AGENTS/$SERVER_LABEL.plist" ]; then
        launchctl bootstrap "gui/$UID_N" "$AGENTS/$SERVER_LABEL.plist" 2>/dev/null
    fi
    if ! loaded "$SERVER_LABEL"; then
        warn "Echo Server's start-at-login is missing - reinstalling puts it back:"
        info "curl -fsSL $INSTALLER | bash -s -- update"
    elif ! server_running; then
        launchctl kickstart "gui/$UID_N/$SERVER_LABEL" 2>/dev/null
    fi
    loaded "$SERVER_LABEL" && ok "Echo Server starts at login and restarts if it stops"
    if [ -d "$ECHO_APP" ]; then
        if ! loaded "$ECHO_APP_LABEL" && [ -f "$AGENTS/$ECHO_APP_LABEL.plist" ]; then
            launchctl bootstrap "gui/$UID_N" "$AGENTS/$ECHO_APP_LABEL.plist" 2>/dev/null
        fi
        pgrep -xq Echo || open -gj "$ECHO_APP" 2>/dev/null
        ok "Echo for Mac starts at login"
    fi
fi

# Tidy-up: copies the server converted (HEIC to JPEG, CAF to MP3) and cached.
CLEARED=0
for d in "$BB_DIR/Convert" "$BB_DIR/Attachments/Cached"; do
    [ -d "$d" ] || continue
    n=$(find "$d" -type f -mtime +30 2>/dev/null | wc -l | tr -d ' ')
    find "$d" -type f -mtime +30 -delete 2>/dev/null
    CLEARED=$(( CLEARED + n ))
done
ok "Cleared $CLEARED old converted copies"

if [ $INSTALLED = 1 ] && [ $INSTALL = 0 ] && ask "Restart Echo Server now, so App Nap and a clean start take effect? (Messages restarts with it; takes about a minute)"; then
    launchctl kickstart -k "gui/$UID_N/$SERVER_LABEL" 2>/dev/null
    say "  ${DIM}Waiting for it to come back and reconnect the Private API…${OFF}"
    up=0
    for _ in $(seq 1 30); do
        sleep 4
        s=$(get echo/status)
        if [ "$(field "$s" privateApi)" = true ]; then up=2; break; fi
        [ -n "$s" ] && up=1
    done
    case $up in
        2) ok "Back, with the Private API connected"; HELPER=true ;;
        1) warn "Back, but the Private API hasn't reconnected yet. Echo Guard keeps trying." ;;
        *) bad "Echo Server hasn't come back yet - see ~/Library/Logs/Echo/server.log" ;;
    esac
fi

# --- 3. what's left for you --------------------------------------------------
step "Done. A few things only you can do"
n=0
item() { n=$((n+1)); printf '  %s%d.%s %s\n' "$BOLD" "$n" "$OFF" "$*"; }
if [ "$FULLDISK" = false ]; then
    item "Give Echo Server Full Disk Access: System Settings → Privacy & Security → Full Disk Access → turn on Echo Server (use + to add it from Applications)."
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2>/dev/null
fi
[ "$ACCESS" = false ] && item "Give Echo Server Accessibility: System Settings → Privacy & Security → Accessibility → Echo Server."
if [ "$FILEVAULT" = 0 ] && ! defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser >/dev/null 2>&1; then
    item "Log in automatically: System Settings → Users & Groups → Automatically log in as → you."
fi
if [ "$PRIVATE_ON" != true ]; then
    item "Turn on the Private API (typing, tapbacks, edits, unsend). It needs System Integrity Protection partly off - the guide: https://docs.bluebubbles.app/private-api - then turn it on in Echo for Mac's settings."
elif [ "$HELPER" != true ]; then
    item "The Private API is on but not connecting. Check System Integrity Protection is still partly off (csrutil status in Terminal); a macOS update can turn it back on."
fi
[ $PERMANENT = 1 ] || item "Give this Mac an address that never moves: run Echo Permanent Address.command."
[ -n "$TS" ] && item "Tailscale's menu-bar icon → make sure it opens at login."
item "Green bubbles from your Mac (only if you have an iPhone): on the iPhone, Settings → Messages → Text Message Forwarding → this Mac."
item "Keep 20 GB or more free on the disk."
say ""
say "${DIM}Echo Guard's history is on your phone: Settings → Your Mac. Run this again any time for a fresh check-up.${OFF}"
finish
