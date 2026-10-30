#!/bin/bash
#
# Try `relay init` end to end without touching your real setup.
#
# Runs a published agent-relay in a throwaway HOME with its own Agent Relay
# core and local Relaycast server, so the desktop app, its core socket and your
# real ~/.claude, ~/.codex and ~/.agentworkforce are left alone. It then starts
# real Claude Code and Codex sessions in tmux, checks that each joins Relay by
# itself, sends each a DM, waits for the reply, checks for approval prompts,
# runs `init --uninstall` and `init --stop`, and cleans up.
#
# Usage:
#   ./scripts/try-relay-init.sh                         # agent-relay@next, claude + codex
#   ./scripts/try-relay-init.sh --version 15.0.0-next.6
#   ./scripts/try-relay-init.sh --tools codex           # Codex only (no Claude token needed)
#   ./scripts/try-relay-init.sh --keep                  # leave the sessions running to poke at
#   ./scripts/try-relay-init.sh --cleanup               # tear down a --keep run
#
# Claude needs a long-lived token (`claude setup-token`), because Claude Code
# can't use your keychain login from a throwaway HOME. The script takes it from
# CLAUDE_CODE_OAUTH_TOKEN, from 1Password with --op <op://vault/item/field>, or
# asks for it. It is only ever held in the private tmux server's environment.
#
# Codex uses a copy of ~/.codex/auth.json, deleted on cleanup.
#
# Requires: macOS or Linux, node/npx, tmux, and claude and/or codex on PATH.

set -euo pipefail

VERSION="next"
TOOLS="claude,codex"
PORT=8791
KEEP=false
CLEANUP_ONLY=false
OP_REF=""
TIMEOUT=180

usage() { sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --version) VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --tools) TOOLS="$2"; shift 2 ;;
    --tools=*) TOOLS="${1#*=}"; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --op) OP_REF="$2"; shift 2 ;;
    --op=*) OP_REF="${1#*=}"; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --keep) KEEP=true; shift ;;
    --cleanup) CLEANUP_ONLY=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# Relay credentials or overrides inherited from the caller would outrank the
# throwaway workspace and send the test to a real one.
while IFS= read -r var; do unset "$var"; done < <(env | sed -n -E 's/^((AGENT_RELAY|RELAY|RELAYCAST)_[A-Za-z0-9_]*)=.*/\1/p')

REAL_HOME="$HOME"
# Short and per-user: macOS caps Unix socket paths at 104 bytes.
E="/tmp/relay-try-$(id -u)"
# Not under /tmp or $TMPDIR: sessions there never join Relay by themselves.
PROJ="$REAL_HOME/relay-try-project"
TMUX_SERVER="relay-try-$(id -u)"
PKG="agent-relay@$VERSION"
MARKER=.relay-try-owned

TRY_HOME="$E/home"
ENV_FILE="$E/env.sh"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
redact() { sed -E 's/(sk-ant-|rk_|at_|nt_|phc_)[A-Za-z0-9_-]+/\1<redacted>/g'; }

# The throwaway environment, for this script's own commands.
use_env() {
  export HOME="$TRY_HOME"
  export AGENT_RELAY_HOME="$E/relay"
  export INSTALL_DIR="$E/install"
  export CODEX_HOME="$TRY_HOME/.codex"
  export XDG_CONFIG_HOME="$TRY_HOME/.config"
  export XDG_DATA_HOME="$TRY_HOME/.local/share"
  export XDG_STATE_HOME="$TRY_HOME/.local/state"
  export XDG_CACHE_HOME="$TRY_HOME/.cache"
  export AGENT_RELAY_CORE_SOCKET="$TRY_HOME/.agentworkforce/desktop/core.sock"
  export AGENT_RELAY_TELEMETRY_DISABLED=1
  export npm_config_cache="$REAL_HOME/.npm"
  # mise keeps its trust decisions under HOME; point it at the real ones so a
  # trusted ~/mise.toml above the project doesn't prompt inside the sessions.
  if command -v mise >/dev/null; then
    export MISE_CONFIG_DIR="${MISE_CONFIG_DIR:-$REAL_HOME/.config/mise}"
    export MISE_DATA_DIR="${MISE_DATA_DIR:-$REAL_HOME/.local/share/mise}"
    export MISE_STATE_DIR="${MISE_STATE_DIR:-$REAL_HOME/.local/state/mise}"
    export MISE_CACHE_DIR="${MISE_CACHE_DIR:-$REAL_HOME/Library/Caches/mise}"
  fi
}

# The same environment as a file the tmux windows source.
write_env() {
  (
    use_env
    for v in HOME AGENT_RELAY_HOME INSTALL_DIR CODEX_HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME \
      XDG_CACHE_HOME AGENT_RELAY_CORE_SOCKET AGENT_RELAY_TELEMETRY_DISABLED npm_config_cache \
      MISE_CONFIG_DIR MISE_DATA_DIR MISE_STATE_DIR MISE_CACHE_DIR; do
      [[ -n "${!v:-}" ]] && printf 'export %s=%q\n' "$v" "${!v}"
    done
    printf 'cd %q\n' "$PROJ"
  ) > "$ENV_FILE"
}

# Runs agent-relay inside the throwaway environment.
relay() { (use_env; cd "$PROJ"; npx -y "$PKG" "$@") 2> >(grep -v -E '^npm (warn|notice)' >&2); }

# A directory this script made: owned by this user and carrying its marker.
owned() { [[ -d "$1" && -O "$1" && -f "$1/$MARKER" && -O "$1/$MARKER" ]]; }

cleanup() {
  step "Cleaning up"
  if owned "$E" && [[ -d "$E/relay" ]]; then
    relay init --uninstall 2>&1 | redact | tail -3 || true
    relay init --stop 2>&1 | redact | tail -2 || true
  fi
  tmux -L "$TMUX_SERVER" kill-server 2>/dev/null || true
  # Processes the tools left running from the throwaway HOME (e.g. Codex's
  # app-server). Wait for them to exit: one still shutting down can recreate
  # its folders after they are removed.
  local pattern="(/private)?$E/"
  pkill -U "$(id -u)" -f "$pattern" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -U "$(id -u)" -f "$pattern" >/dev/null || break
    sleep 1
  done
  pkill -9 -U "$(id -u)" -f "$pattern" 2>/dev/null || true
  for d in "$E" "$PROJ"; do
    if owned "$d"; then
      rm -rf "$d" && echo "Removed $d."
    elif [[ -e "$d" ]]; then
      red "Left $d alone: this script did not create it."
    fi
  done
}

if $CLEANUP_ONLY; then cleanup; exit 0; fi

for d in "$E" "$PROJ"; do
  if [[ -e "$d" ]]; then
    if owned "$d"; then red "$d is left from an earlier run. Run with --cleanup first."
    else red "$d already exists and was not made by this script. Move it out of the way first."; fi
    exit 1
  fi
done

IFS=',' read -r -a TOOL_LIST <<< "$TOOLS"
has_tool() { [[ ",$TOOLS," == *",$1,"* ]]; }
# The real binary, resolved before HOME changes: a version-manager shim (mise,
# asdf) would stop at a trust prompt under the throwaway HOME.
resolve_bin() {
  local bin
  bin="$(command -v "$1")" || return 1
  if [[ $bin == */shims/* ]]; then
    { command -v mise >/dev/null && mise which "$1" 2>/dev/null; } ||
      { command -v asdf >/dev/null && asdf which "$1" 2>/dev/null; } || echo "$bin"
  else
    echo "$bin"
  fi
}
for t in "${TOOL_LIST[@]}"; do
  case $t in claude|codex) ;;
    *) red "Only claude and codex are supported here (got $t)"; exit 1 ;;
  esac
  bin="$(resolve_bin "$t")" || { red "$t is not on PATH"; exit 1; }
  printf -v "BIN_$t" '%s' "$bin"
done
command -v tmux >/dev/null || { red "tmux is required"; exit 1; }
command -v npx >/dev/null || { red "node/npx is required"; exit 1; }

TOKEN=""
if has_tool claude; then
  if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    TOKEN="$CLAUDE_CODE_OAUTH_TOKEN"
  elif [[ -n "$OP_REF" ]]; then
    TOKEN="$(op read "$OP_REF")" || { red "op read failed (approve the 1Password prompt and retry)"; exit 1; }
  else
    read -r -s -p "Claude token (from 'claude setup-token'): " TOKEN; echo
  fi
  # A trailing newline makes Claude reject the header and echo the token back.
  TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
  [[ -n "$TOKEN" ]] || { red "No Claude token given"; exit 1; }
fi

# From here on, any exit (a failed command, Ctrl-C) cleans up unless --keep.
on_exit() {
  local status=$?
  trap - EXIT INT TERM
  # A --keep run that got as far as leaving its sessions up stays up.
  if [[ ${KEPT:-} != yes ]]; then cleanup; fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

step "Setting up a throwaway HOME in $E"
(umask 077 && mkdir "$E" "$PROJ")
touch "$E/$MARKER" "$PROJ/$MARKER"
mkdir -p "$TRY_HOME/.codex" "$E/relay" "$E/install"
write_env
(cd "$PROJ" && git init -q && echo "# relay-try" > README.md && printf '%s\n' "$MARKER" > .gitignore)
if has_tool codex; then
  (umask 077 && cp "$REAL_HOME/.codex/auth.json" "$TRY_HOME/.codex/auth.json")
  printf '[projects."%s"]\ntrust_level = "trusted"\n' "$PROJ" > "$TRY_HOME/.codex/config.toml"
fi
if has_tool claude; then
  # Skip onboarding and the trust dialog, and keep any ~/.mcp.json above the
  # project from prompting.
  disabled="[]"
  if [[ -f "$REAL_HOME/.mcp.json" ]]; then
    disabled="$(node -e 'try{console.log(JSON.stringify(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).mcpServers||{})))}catch{console.log("[]")}' "$REAL_HOME/.mcp.json")"
  fi
  node -e 'const [f,p,d]=process.argv.slice(1);require("fs").writeFileSync(f,JSON.stringify({hasCompletedOnboarding:true,theme:"dark",projects:{[p]:{hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true,disabledMcpjsonServers:JSON.parse(d)}}}))' \
    "$TRY_HOME/.claude.json" "$PROJ" "$disabled"
fi

step "relay init from $PKG"
relay init --yes --tools "$TOOLS" --port "$PORT" 2>&1 | redact

shell_cmd() { printf 'bash -c %q' "source $(printf '%q' "$ENV_FILE"); exec $*"; }
tmux -L "$TMUX_SERVER" new-session -d -s relay-try -n shell "$(shell_cmd bash -i)"
if [[ -n "$TOKEN" ]]; then tmux -L "$TMUX_SERVER" set-environment -g CLAUDE_CODE_OAUTH_TOKEN "$TOKEN"; fi
TOKEN=""

step "Starting real sessions"
for t in "${TOOL_LIST[@]}"; do
  bin_var="BIN_$t"
  cmd="$(printf '%q' "${!bin_var}")"
  [[ $t == claude ]] && cmd="$cmd --permission-mode manual"
  tmux -L "$TMUX_SERVER" new-window -d -t relay-try -n "$t" "$(shell_cmd "$cmd")"
done
sleep 8
for t in "${TOOL_LIST[@]}"; do
  tmux -L "$TMUX_SERVER" send-keys -t "relay-try:$t" -l "Reply with just the word ready."
  sleep 1
  tmux -L "$TMUX_SERVER" send-keys -t "relay-try:$t" Enter
done

# Per-tool values without associative arrays (macOS ships bash 3.2).
setv() { printf -v "V_$1_$2" '%s' "$3"; }
getv() { local v="V_$1_$2"; printf '%s' "${!v:-}"; }

kind_of() { case $1 in claude) echo claude-terminal ;; codex) echo codex ;; esac; }
FAILED=false

step "Waiting for each session to join Relay"
deadline=$((SECONDS + TIMEOUT))
while (( SECONDS < deadline )); do
  roster="$(relay agent list 2>/dev/null || echo '[]')"
  missing=0
  for t in "${TOOL_LIST[@]}"; do
    n="$(printf '%s' "$roster" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s).find(x=>x.metadata&&x.metadata.session_kind===process.argv[1]);console.log(a?a.name:"")}catch{console.log("")}})' "$(kind_of "$t")")"
    if [[ -n "$n" ]]; then setv NAME "$t" "$n"; else missing=1; fi
  done
  (( missing == 0 )) && break
  sleep 3
done
for t in "${TOOL_LIST[@]}"; do
  if [[ -n "$(getv NAME "$t")" ]]; then green "  ✓ $t joined as $(getv NAME "$t")"; else red "  ✗ $t never joined"; FAILED=true; fi
done

step "DM round trip"
relay agent register alice >/dev/null 2>&1 || true
for t in "${TOOL_LIST[@]}"; do
  [[ -n "$(getv NAME "$t")" ]] || continue
  relay message dm send "$(getv NAME "$t")" "Hi, this is alice testing Agent Relay. Please reply to me (alice) over Agent Relay with exactly pong-$t and nothing else." --as alice >/dev/null
  echo "  sent a DM to $(getv NAME "$t")"
done
prompted() {
  case $1 in
    claude) tmux -L "$TMUX_SERVER" capture-pane -p -t "relay-try:claude" | grep -q -E "Do you want to proceed|requires approval" ;;
    codex) tmux -L "$TMUX_SERVER" capture-pane -p -t "relay-try:codex" | grep -q -i -E "allow command|approve|Would you like to run" ;;
  esac
}
deadline=$((SECONDS + TIMEOUT))
while (( SECONDS < deadline )); do
  inbox="$(relay message inbox check --as alice 2>/dev/null || echo '{}')"
  pending=0
  for t in "${TOOL_LIST[@]}"; do
    [[ -n "$(getv NAME "$t")" && -z "$(getv GOT "$t")" ]] || continue
    if printf '%s' "$inbox" | grep -q "pong-$t"; then setv GOT "$t" 1; else
      if prompted "$t"; then setv PROMPT "$t" 1; fi
      pending=1
    fi
  done
  (( pending == 0 )) && break
  sleep 3
done
for t in "${TOOL_LIST[@]}"; do
  [[ -n "$(getv NAME "$t")" ]] || continue
  if [[ -n "$(getv GOT "$t")" ]]; then
    if [[ -n "$(getv PROMPT "$t")" ]]; then red "  ✗ $t replied, but only after an approval prompt"; FAILED=true
    else green "  ✓ $t: DM injected and the reply reached alice, with no approval prompt"; fi
  else
    if [[ -n "$(getv PROMPT "$t")" ]]; then red "  ✗ $t is waiting on an approval prompt (tmux -L $TMUX_SERVER attach -t relay-try:$t)"
    else red "  ✗ no reply from $t within ${TIMEOUT}s"; fi
    FAILED=true
  fi
done

if $KEEP; then
  KEPT=yes
  step "Left running (--keep)"
  cat <<EOF
  Attach:   tmux -L $TMUX_SERVER attach -t relay-try        (windows: shell, ${TOOLS//,/, })
  In the 'shell' window, npx -y $PKG ... runs against the throwaway setup.
  Tear down: $0 --cleanup
EOF
  if $FAILED; then exit 1; fi
  exit 0
fi

step "Uninstall"
for t in "${TOOL_LIST[@]}"; do tmux -L "$TMUX_SERVER" kill-window -t "relay-try:$t" 2>/dev/null || true; done
relay init --uninstall 2>&1 | redact | tail -3
leftovers=""
for f in "$TRY_HOME/.claude/settings.json" "$TRY_HOME/.claude/settings.json.relay-desktop-backup" \
  "$TRY_HOME/.codex/hooks.json" "$TRY_HOME/.codex/hooks.json.relay-desktop-backup" \
  "$TRY_HOME/.codex/rules/agent-relay.rules" \
  "$PROJ/.mcp.json" "$PROJ/.claude/settings.json" "$PROJ/.claude/settings.local.json" "$PROJ/.codex/config.toml"; do
  if [[ -e "$f" ]]; then leftovers+="      $f"$'\n'; fi
done
if grep -q -E 'hooks\.state|agent-relay' "$TRY_HOME/.codex/config.toml" 2>/dev/null; then
  leftovers+="      $TRY_HOME/.codex/config.toml (Relay entries)"$'\n'
fi
if [[ -z "$leftovers" ]]; then green "  ✓ --uninstall left no Relay files behind"
else red "  ✗ left behind:"; printf '%s' "$leftovers"; FAILED=true; fi

echo
if $FAILED; then red "Some checks failed."; exit 1; fi
green "All checks passed for ${TOOLS//,/, } with $PKG."
