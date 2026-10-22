#!/bin/bash
# Echo Lean - makes the BlueBubbles server light enough for an 8 GB Mac, and
# keeps it up.
#
#   curl -fsSL https://raw.githubusercontent.com/leoble123/echo-updates/main/mac/echo-lean.sh | bash
#   ... | bash -s -- report      what's using memory, and what's crashed
#   ... | bash -s -- undo        put BlueBubbles' settings back, remove the guardian
#
# What it does:
#  1. Turns off what BlueBubbles runs that Echo doesn't need: its window
#     (headless: a whole browser engine), the graphics process, the FaceTime
#     helper (which keeps FaceTime.app running) and opening Find My at start.
#     Your settings are backed up first; `undo` restores them.
#  2. Installs Echo Guardian: a check that runs for about a second each
#     minute and then exits, so it costs no memory. It restarts BlueBubbles if
#     it stops answering or grows too big, quits Find My and FaceTime when
#     they're left running in the background, frees BlueBubbles' attachment
#     cache when the disk runs low, and gives everything a fresh start at
#     4 a.m. Each thing it does is logged to ~/Library/Logs/Echo/guardian.log.
#
# Written for macOS's own bash (3.2): no associative arrays or newer syntax.

set -u
ECHO_DIR="$HOME/Library/Application Support/Echo"
LOG_DIR="$HOME/Library/Logs/Echo"
BB_DIR="$HOME/Library/Application Support/bluebubbles-server"
CFG="$BB_DIR/config.db"
AGENT="$HOME/Library/LaunchAgents/com.echo.guardian.plist"
GUARD="$ECHO_DIR/guardian.sh"

say() { printf '%s\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

need_mac() {
  if [ "$(uname)" != "Darwin" ]; then say "This is for the Mac running BlueBubbles."; exit 1; fi
  if [ ! -f "$CFG" ]; then say "Couldn't find BlueBubbles' settings at $CFG - is BlueBubbles set up on this Mac?"; exit 1; fi
}

cfg_get() { sqlite3 "$CFG" "select value from config where name='$1';" 2>/dev/null; }
cfg_set() {
  sqlite3 "$CFG" "insert into config(name, value) values('$1', '$2') on conflict(name) do update set value=excluded.value;" 2>/dev/null \
    || sqlite3 "$CFG" "update config set value='$2' where name='$1';"
}

bb_running() { pgrep -f "BlueBubbles.app/Contents/MacOS/BlueBubbles" >/dev/null 2>&1; }

quit_bb() {
  osascript -e 'quit app "BlueBubbles"' >/dev/null 2>&1
  for _ in 1 2 3 4 5 6 7 8 9 10; do bb_running || return 0; sleep 1; done
  pkill -f "BlueBubbles.app/Contents/MacOS/BlueBubbles" 2>/dev/null
  sleep 2
}

# --- the guardian (written out by `install`) ------------------------------------

write_guardian() {
  mkdir -p "$ECHO_DIR" "$LOG_DIR"
  cat > "$GUARD" <<'GUARDIAN'
#!/bin/bash
# Echo Guardian: one pass, then exit. launchd runs it every minute.
set -u
STATE="$HOME/Library/Application Support/Echo"
LOG="$HOME/Library/Logs/Echo/guardian.log"
BB_DIR="$HOME/Library/Application Support/bluebubbles-server"
CFG="$BB_DIR/config.db"
mkdir -p "$STATE" "$(dirname "$LOG")"

# Limits, sized for an 8 GB Mac. Override in ~/Library/Application Support/Echo/limits.
BB_LIMIT_MB=1100         # BlueBubbles, all its processes together
MESSAGES_LIMIT_MB=1400   # Messages
LOW_FREE_PCT=8           # system memory free below this is "pressure"
LOW_DISK_GB=10
FRESH_START_HOUR=4
[ -f "$STATE/limits" ] && . "$STATE/limits"

now() { date '+%Y-%m-%d %H:%M:%S'; }
log() {
  echo "$(now) $*" >> "$LOG"
  # Keep the log small.
  if [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 524288 ]; then mv -f "$LOG" "$LOG.1"; fi
}
cfg() { sqlite3 "$CFG" "select value from config where name='$1';" 2>/dev/null; }
count() { cat "$STATE/$1" 2>/dev/null || echo 0; }
setcount() { echo "$2" > "$STATE/$1"; }

rss_mb() { ps -axo rss=,command= | grep -F "$1" | grep -v grep | awk '{s+=$1} END {print int(s/1024)}'; }
running() { pgrep -f "$1" >/dev/null 2>&1; }
front_app() { lsappinfo info -only name "$(lsappinfo front 2>/dev/null)" 2>/dev/null | sed -n 's/.*"LSDisplayName"="\(.*\)".*/\1/p'; }

BB_BIN="BlueBubbles.app/Contents/MacOS/BlueBubbles"
BB_ALL="BlueBubbles.app/"
MESSAGES_BIN="Messages.app/Contents/MacOS/Messages"

restart_bb() {
  log "restarting BlueBubbles: $1"
  osascript -e 'quit app "BlueBubbles"' >/dev/null 2>&1
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do running "$BB_BIN" || break; sleep 1; done
  pkill -f "$BB_BIN" 2>/dev/null
  # Messages too, if asked: BlueBubbles starts it again with its helper loaded.
  if [ "${2:-}" = "with-messages" ]; then
    osascript -e 'quit app "Messages"' >/dev/null 2>&1
    sleep 3
    pkill -f "$MESSAGES_BIN" 2>/dev/null
  fi
  sleep 2
  open -g -a BlueBubbles
  setcount fails 0
  setcount restarts $(( $(count restarts) + 1 ))
}

# 1. BlueBubbles should be running.
if ! running "$BB_BIN"; then
  log "BlueBubbles wasn't running - starting it"
  open -g -a BlueBubbles
  exit 0
fi

# 2. ...and answering. Three missed minutes in a row and it's restarted.
PORT=$(cfg socket_port); PORT=${PORT:-1234}
PW=$(cfg password)
if curl -s -m 10 -G --data-urlencode "password=$PW" "http://127.0.0.1:$PORT/api/v1/ping" | grep -q pong; then
  setcount fails 0
else
  F=$(( $(count fails) + 1 ))
  setcount fails $F
  log "BlueBubbles didn't answer ($F/3)"
  if [ $F -ge 3 ]; then restart_bb "not answering for 3 minutes" with-messages; exit 0; fi
fi

# 3. Memory: BlueBubbles and Messages slowly grow; past their limit, a fresh start.
BB_MB=$(rss_mb "$BB_ALL")
MSG_MB=$(rss_mb "$MESSAGES_BIN")
FREE_PCT=$(memory_pressure -Q 2>/dev/null | awk -F': ' '/percentage/ {gsub("%","",$2); print int($2)}')
FREE_PCT=${FREE_PCT:-100}
echo "{\"at\":\"$(now)\",\"blueBubblesMB\":$BB_MB,\"messagesMB\":$MSG_MB,\"freePct\":$FREE_PCT,\"restarts\":$(count restarts)}" > "$STATE/status.json"
if [ "$BB_MB" -gt "$BB_LIMIT_MB" ]; then
  restart_bb "using ${BB_MB} MB (limit ${BB_LIMIT_MB})"; exit 0
fi
if [ "$MSG_MB" -gt "$MESSAGES_LIMIT_MB" ]; then
  restart_bb "Messages using ${MSG_MB} MB (limit ${MESSAGES_LIMIT_MB})" with-messages; exit 0
fi
if [ "$FREE_PCT" -lt "$LOW_FREE_PCT" ] && [ "$BB_MB" -gt 600 ]; then
  restart_bb "the Mac is low on memory (${FREE_PCT}% free) and BlueBubbles is at ${BB_MB} MB"; exit 0
fi

# 4. Apps BlueBubbles opens and leaves behind, each a few hundred MB.
FRONT=$(front_app)
for APP in "FindMy:Find My" "FaceTime:FaceTime"; do
  BIN="${APP%%:*}"; NAME="${APP#*:}"
  if running "$BIN.app/Contents/MacOS/$BIN" && [ "$FRONT" != "$NAME" ] && [ "$FRONT" != "$BIN" ]; then
    SEEN=$(count "seen-$BIN")
    if [ "$SEEN" -ge 3 ]; then
      osascript -e "quit app \"$NAME\"" >/dev/null 2>&1
      log "quit $NAME (left running in the background)"
      setcount "seen-$BIN" 0
    else
      setcount "seen-$BIN" $(( SEEN + 1 ))
    fi
  else
    setcount "seen-$BIN" 0
  fi
done

# 5. A full disk means no room to swap, which on 8 GB means crashes.
FREE_GB=$(df -g / | awk 'NR==2 {print $4}')
if [ "${FREE_GB:-100}" -lt "$LOW_DISK_GB" ]; then
  BEFORE=$(du -sm "$BB_DIR/Attachments" "$BB_DIR/Convert" 2>/dev/null | awk '{s+=$1} END {print s+0}')
  rm -rf "$BB_DIR/Attachments/Cached/"* "$BB_DIR/Convert/"* 2>/dev/null
  log "disk low (${FREE_GB} GB free) - cleared ${BEFORE} MB of BlueBubbles' attachment cache"
fi

# 6. A fresh start every night, before anything's had a chance to leak far.
TODAY=$(date +%Y-%m-%d)
if [ "$(date +%H)" -eq "$FRESH_START_HOUR" ] && [ "$(cat "$STATE/fresh" 2>/dev/null)" != "$TODAY" ]; then
  echo "$TODAY" > "$STATE/fresh"
  restart_bb "nightly fresh start" with-messages
fi
GUARDIAN
  chmod +x "$GUARD"
}

write_agent() {
  mkdir -p "$(dirname "$AGENT")"
  cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.echo.guardian</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$GUARD</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/guardian.err</string>
</dict>
</plist>
PLIST
  launchctl unload "$AGENT" >/dev/null 2>&1
  launchctl load -w "$AGENT"
}

# --- the commands --------------------------------------------------------------------

install() {
  need_mac
  bold "Echo Lean"
  say "Slimming BlueBubbles down and installing Echo Guardian."
  say ""
  mkdir -p "$ECHO_DIR" "$LOG_DIR"
  if [ ! -f "$ECHO_DIR/config-before-lean.db" ]; then cp "$CFG" "$ECHO_DIR/config-before-lean.db"; fi

  local was_running=0
  if bb_running; then was_running=1; say "• Pausing BlueBubbles for a moment…"; quit_bb; fi

  # Off: things Echo doesn't use that cost memory every minute of every day.
  cfg_set headless 1               # no window: a whole browser engine, gone
  cfg_set disable_gpu 1            # no graphics process
  cfg_set start_minimized 1
  cfg_set hide_dock_icon 1         # still in the menu bar
  cfg_set enable_ft_private_api 0  # FaceTime helper: keeps FaceTime.app running
  cfg_set facetime_calling 0
  cfg_set open_findmy_on_startup 0 # Find My opens only when you look at it
  cfg_set auto_install_updates 0   # updates still offered; never mid-day restarts
  cfg_set dock_badge 0
  # On: keep the Mac awake so the server is there.
  cfg_set auto_caffeinate 1
  # Start with the Mac.
  cfg_set auto_start 1

  say "• BlueBubbles: headless, no graphics process, no FaceTime helper, Find My only on demand."
  write_guardian
  write_agent
  say "• Echo Guardian installed - checks once a minute, costs nothing in between."
  if [ $was_running -eq 1 ] || true; then open -g -a BlueBubbles; fi
  say ""
  bold "Done."
  say "BlueBubbles now lives in the menu bar only. To see its window again, click its"
  say "menu bar icon and turn Headless Mode off."
  say "What the guardian does is logged in ~/Library/Logs/Echo/guardian.log."
  say ""
  report
}

report() {
  need_mac
  bold "What's using memory"
  local total_mb; total_mb=$(( $(sysctl -n hw.memsize) / 1048576 ))
  printf '  %-26s %6s MB\n' "Mac total" "$total_mb"
  for p in "BlueBubbles.app/:BlueBubbles (all)" "Messages.app/Contents/MacOS/Messages:Messages" "FaceTime.app/Contents/MacOS/FaceTime:FaceTime" \
           "FindMy.app/Contents/MacOS/FindMy:Find My" "imagent:imagent" "cloudflared:cloudflared" "ngrok:ngrok" "WindowServer:WindowServer" \
           "Safari.app:Safari" "Google Chrome:Chrome" "Photos.app:Photos"; do
    local pat="${p%%:*}" name="${p#*:}"
    local mb; mb=$(ps -axo rss=,command= | grep -F "$pat" | grep -v grep | awk '{s+=$1} END {print int(s/1024)}')
    [ "${mb:-0}" -gt 0 ] && printf '  %-26s %6s MB\n' "$name" "$mb"
  done
  say ""
  say "  $(memory_pressure -Q 2>/dev/null | grep -i percentage | sed 's/^ *//')"
  say "  Swap: $(sysctl -n vm.swapusage 2>/dev/null)"
  say "  Disk free: $(df -h / | awk 'NR==2 {print $4}')"
  say ""
  bold "Biggest apps right now"
  ps -axo rss=,comm= | sort -rn | head -8 | awk '{mb=int($1/1024); $1=""; sub(/^ /,""); n=split($0,a,"/"); printf "  %-26s %6d MB\n", a[n], mb}'
  say ""
  bold "Crashes in the last 3 days"
  local dr="$HOME/Library/Logs/DiagnosticReports"
  local bbc mc jet
  bbc=$(find "$dr" -mtime -3 -iname '*BlueBubbles*' 2>/dev/null | wc -l | tr -d ' ')
  mc=$(find "$dr" -mtime -3 \( -iname 'Messages*' -o -iname 'imagent*' \) 2>/dev/null | wc -l | tr -d ' ')
  jet=$(find /Library/Logs/DiagnosticReports -mtime -3 -iname 'JetsamEvent*' 2>/dev/null | wc -l | tr -d ' ')
  say "  BlueBubbles: $bbc   Messages/imagent: $mc   Out-of-memory events (Jetsam): $jet"
  say ""
  bold "BlueBubbles settings"
  for k in headless disable_gpu enable_private_api enable_ft_private_api facetime_calling open_findmy_on_startup auto_caffeinate proxy_service db_poll_interval; do
    printf '  %-24s %s\n' "$k" "$(cfg_get $k)"
  done
  if [ -f "$LOG_DIR/guardian.log" ]; then
    say ""
    bold "Guardian, recently"
    tail -n 12 "$LOG_DIR/guardian.log" | sed 's/^/  /'
  fi
}

undo() {
  need_mac
  launchctl unload "$AGENT" >/dev/null 2>&1
  rm -f "$AGENT" "$GUARD"
  if [ -f "$ECHO_DIR/config-before-lean.db" ]; then
    bb_running && quit_bb
    cp "$ECHO_DIR/config-before-lean.db" "$CFG"
    rm -f "$ECHO_DIR/config-before-lean.db"
    open -g -a BlueBubbles
    say "BlueBubbles' settings are back the way they were, and Echo Guardian is gone."
  else
    say "Echo Guardian removed. (No saved settings to restore.)"
  fi
}

case "${1:-install}" in
  install) install ;;
  report) report ;;
  undo|uninstall) undo ;;
  *) say "Usage: echo-lean.sh [install|report|undo]"; exit 1 ;;
esac
