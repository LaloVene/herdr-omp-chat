#!/usr/bin/env bash
# Installs omp-chat into the Herdr app home and the omp extension folder.
#   ./install.sh              install (refuses to overwrite anything it didn't install)
#   ./install.sh --update     replace a copy this script installed (development)
#   ./install.sh --uninstall  remove everything this script installed
#   --dry-run                 with any of them: print what would change, change nothing
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
EXT_DIR="$HOME/.omp/agent/extensions"
MOD="$APP/mods/omp-chat"
# Clones of Herdr's sidebar and bar mods (spaces, agents, the brand/footer chrome, tabs):
# status-colored icons, chat-pane omps listed, the rail only below 120px, icon-only panel buttons.
RAILS=(omp-chat-spaces omp-chat-agents omp-chat-chrome omp-chat-tabs)
LAYOUT="$APP/layouts/omp-chat.json"
PREVIEW="$APP/layouts/omp-chat.svg"
# The frosted glass: a blurred copy of the desktop picture painted behind the translucent panels.
BACKDROP="$APP/backgrounds/omp-chat-glass.jpg"
LINK="$EXT_DIR/omp-chat-bridge.ts"
MARKER="$MOD/.installed-by-herdr-omp-chat"
KEY_SECTION="layout:omp-chat"

mode=install
dry=0
for arg in "$@"; do
  case "$arg" in
    --update) mode=update ;;
    --uninstall) mode=uninstall ;;
    --dry-run) dry=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

run() {
  if [ "$dry" = 1 ]; then echo "would: $*"; else "$@"; fi
}

die() { echo "omp-chat: $*" >&2; exit 1; }

# keys.json: add or remove the layout:omp-chat section; never replace a key the person uses.
keys() {
  local action="$1"
  python3 - "$APP/keys.json" "$action" "$dry" "$KEY_SECTION" <<'PY'
import json, os, sys
path, action, dry, section = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4]
want = {"cmd-j": "omp-chat.toggle", "cmd-shift-j": "layout.toggle:omp-btw"}
# Bindings an earlier version of this script added: replaced or removed like the current ones.
ours = lambda v: v in want.values() or (isinstance(v, str) and v.startswith("omp-chat."))
data = json.load(open(path)) if os.path.exists(path) else {}
if action == "add":
    have = data.get(section, {})
    clash = {k: v for k, v in have.items() if k in want and not ours(v)}
    if clash:
        sys.exit(f"keys.json already binds {clash} in {section}; remove them or edit by hand")
    merged = {**{k: v for k, v in have.items() if not ours(v)}, **want}
    if merged == have:
        sys.exit(0)
    data[section] = merged
else:
    have = data.get(section)
    if have is None:
        sys.exit(0)
    rest = {k: v for k, v in have.items() if not ours(v)}
    if rest: data[section] = rest
    else: del data[section]
if dry:
    print(f"would: {'add' if action == 'add' else 'remove'} {section} keys in {path}")
else:
    tmp = path + ".omp-chat-tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)
PY
}

# Blur the current desktop picture into $BACKDROP (OMP_CHAT_WALLPAPER picks another picture).
# Without one the layout still works, on a plain dark canvas.
backdrop() {
  local pic="${OMP_CHAT_WALLPAPER:-}"
  [ -n "$pic" ] || pic=$(osascript -e 'tell application "System Events" to get picture of desktop 1' 2>/dev/null || true)
  if [ ! -f "$pic" ] || ! command -v swift >/dev/null; then
    echo "omp-chat: no frosted backdrop (needs swift and a desktop picture file; set OMP_CHAT_WALLPAPER)" >&2
    return
  fi
  run mkdir -p "${BACKDROP%/*}"
  run swift "$HERE/tools/glass-backdrop.swift" "$pic" "$BACKDROP" || echo "omp-chat: could not blur $pic" >&2
}

copy_files() {
  run mkdir -p "$MOD" "$APP/layouts" "$EXT_DIR"
  # Files an earlier version shipped must not linger (the marker is hidden, so it stays).
  [ "$mode" = update ] && run find "$MOD" -mindepth 1 -maxdepth 1 ! -name '.*' -exec rm -rf {} +
  # The mods link omp-chat-shared.js from mod/shared (Herdr won't import across mods): copy the file itself.
  for f in "$HERE"/mod/omp-chat/* "$HERE/NOTICE.md"; do
    case "${f##*/}" in gpui-kit.d.ts | jsconfig.json) continue ;; esac
    run cp -L "$f" "$MOD/"
  done
  for m in "${RAILS[@]}"; do run rm -rf "$APP/mods/$m"; run cp -RL "$HERE/mod/$m" "$APP/mods/$m"; done
  run cp "$HERE/layouts/omp-chat.json" "$LAYOUT"
  run cp "$HERE/layouts/omp-chat.svg" "$PREVIEW"
  [ "$dry" = 1 ] && echo "would: write $MARKER" || date -u +%FT%TZ > "$MARKER"
  run ln -sfn "$HERE/extension/omp-chat-bridge.ts" "$LINK"
  backdrop
}

ours_link() { [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$HERE/extension/omp-chat-bridge.ts" ]; }

case "$mode" in
  install)
    command -v bun >/dev/null || die "bun is required (the chat reads sessions with it)"
    [ -e "$MOD" ] && die "$MOD exists; use --update if this script installed it"
    for m in "${RAILS[@]}"; do [ -e "$APP/mods/$m" ] && die "$APP/mods/$m exists"; done
    [ -e "$LAYOUT" ] && die "$LAYOUT exists"
    [ -e "$PREVIEW" ] && die "$PREVIEW exists"
    [ -e "$LINK" ] || [ -L "$LINK" ] && die "$LINK exists"
    run mkdir -p "$APP"
    keys add
    copy_files
    echo "Installed. Restart omp sessions to load the bridge; switch layout with: herdr-app do layout.switch --name omp-chat"
    ;;
  update)
    [ -f "$MARKER" ] || die "no copy installed by this script at $MOD"
    if [ -e "$LINK" ] || [ -L "$LINK" ]; then ours_link || die "$LINK is not this repo's link"; fi
    keys add
    copy_files
    ;;
  uninstall)
    [ -f "$MARKER" ] || die "no copy installed by this script at $MOD"
    # Chat panes park their omp terminals: give each its pane back before the mod goes.
    if command -v herdr-app >/dev/null && [ -f "$APP/shared.json" ]; then
      python3 -c 'import json,sys; [print(p, t) for p, t in (json.load(open(sys.argv[1])).get("omp-chat.panes") or {}).items()]' "$APP/shared.json" |
      while read -r pane terminal; do
        run herdr-app do pane.focus "{\"pane\":\"$pane\"}" >/dev/null || continue
        run herdr-app do terminal.keep "{\"terminal\":\"$terminal\",\"place\":\"right\"}" >/dev/null || continue
        [ "$dry" = 1 ] || sleep 1
        run herdr-app do pane.close "{\"pane\":\"$pane\"}" >/dev/null || true
      done
    fi
    if command -v herdr-app >/dev/null; then
      status=$(herdr-app status 2>/dev/null || true)
      if [[ $status == *'"layout": "omp-chat"'* ]]; then run herdr-app do layout.switch --name main; fi
    fi
    run rm -rf "$MOD" "${RAILS[@]/#/$APP/mods/}"
    run rm -f "$LAYOUT" "$PREVIEW" "$BACKDROP"
    # backgrounds/ only if the backdrop was all it held.
    [ -d "${BACKDROP%/*}" ] && run rmdir "${BACKDROP%/*}" 2>/dev/null || true
    run rm -f "$APP/layouts/.state/omp-chat.json"
    ours_link && run rm -f "$LINK"
    run rm -rf "$APP/data/omp-chat" "$APP/data/omp-chat-render" "$APP/data/omp-chat-stream"
    keys remove
    echo "Uninstalled. Running omp sessions keep the bridge until they restart."
    ;;
esac
if [ "$mode" != uninstall ] && command -v herdr-app >/dev/null; then
  for m in "$MOD" "${RAILS[@]/#/$APP/mods/}"; do run herdr-app check "$m"; done
fi
