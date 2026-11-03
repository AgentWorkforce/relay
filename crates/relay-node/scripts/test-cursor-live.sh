#!/usr/bin/env bash
#
# test-cursor-live.sh -- deliver into a real, disposable Cursor CLI session.
# Developer-only.
#
# Starts `cursor-agent` in a throwaway project with the inbox in a throwaway
# home. cursor-agent does not run a project's .cursor/hooks.json, so this
# checkout's probe hook is added to your real ~/.cursor/hooks.json for the
# run (through a symlink, to the file it points at). At exit the file is put
# back byte for byte (or removed, if there was none); if it changed during
# the run, only this run's entries are removed from it. The edits are plain
# read, edit and rename: do not run this while Cursor, Agent Relay's
# Settings or anything else may edit ~/.cursor/hooks.json, or an edit made
# meanwhile can be lost. A killed run (SIGKILL) leaves the test entries in
# place. So it refuses to run unless RELAY_CURSOR_LIVE_ALLOW_USER_HOOKS=1.
#
# Agent Relay's own inbox is not touched. It uses the signed-in Cursor CLI
# account and a model turn (`--model auto`, which the Free plan allows), and
# needs python3 for the terminal. The session is stopped at the end. The
# test messages come from an agent that does not exist and ask for no reply:
# an Agent Relay older than this change identifies a Cursor tool process as
# whichever session started Cursor, so a reply would go out as it.
#
set -euo pipefail

if [[ "${RELAY_CURSOR_LIVE_ALLOW_USER_HOOKS:-}" != 1 ]]; then
  echo "This test edits your ~/.cursor/hooks.json for the run and restores it at exit." >&2
  echo "Close Cursor and anything else that edits that file, then rerun with" >&2
  echo "RELAY_CURSOR_LIVE_ALLOW_USER_HOOKS=1." >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/relay-cursor-live.XXXXXX")"
mkdir -p "$WORK/home" "$WORK/project"
git -C "$WORK/project" init -q

DATA="${CURSOR_DATA_DIR:-$HOME/.cursor}"
# Through a symlinked hooks file to the file itself, so staging and renaming
# beside it keep the link.
USER_HOOKS="$(python3 -I -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$HOME/.cursor/hooks.json")"
STAGED="$USER_HOOKS.relay-live.$$"
# Each edit is written beside the hooks file and renamed into place, so
# Cursor never reads half a file.
cat > "$WORK/hooks.py" <<'HOOKS'
import json, os, shutil, sys

mode, path, staged, hook, ours, orig = sys.argv[1:7]

def read(p):
    try:
        with open(p, "rb") as f:
            return f.read()
    except FileNotFoundError:
        return None

def install(before):
    data = json.loads(before) if before is not None else {"version": 1}
    for event in ("postToolUse", "stop"):
        data.setdefault("hooks", {}).setdefault(event, []).append({"command": hook, "timeout": 10})
    return json.dumps(data, indent=2).encode()

def restore(before):
    if before is None:
        return None
    if before == read(ours):
        # Untouched since the run's own edit: put the original back.
        return read(orig) if os.path.exists(orig) else b""
    print(path + " changed during the run; removing only this run's hook from it.", file=sys.stderr)
    data = json.loads(before)
    original = json.loads(read(orig) or b"{}") if os.path.exists(orig) else {}
    kept = set(original.get("hooks", {})) if isinstance(original, dict) else set()
    for event, entries in list(data.get("hooks", {}).items()):
        if isinstance(entries, list):
            entries = [e for e in entries if not (isinstance(e, dict) and e.get("command") == hook)]
            # An event key this run added goes once its list is empty.
            if entries or event in kept:
                data["hooks"][event] = entries
            else:
                del data["hooks"][event]
    return json.dumps(data, indent=2).encode()

before = read(path)
after = (install if mode == "install" else restore)(before)
if after is None:
    sys.exit(0)
if mode == "restore" and after == b"" and not os.path.exists(orig):
    os.remove(path)
    sys.exit(0)
with open(staged, "wb") as out:
    out.write(after)
if before is not None:
    shutil.copymode(path, staged)
os.replace(staged, path)
if mode == "install":
    shutil.copy2(path, ours)
HOOKS
if [[ -e "$USER_HOOKS" ]]; then cp -p "$USER_HOOKS" "$WORK/hooks.json.orig"; fi
HOOK=""
restore() {
  if [[ -n "${AGENT:-}" ]]; then kill "$AGENT" 2>/dev/null || true; fi
  if [[ -e "$WORK/hooks.json.ours" ]] \
    && ! python3 -I "$WORK/hooks.py" restore "$USER_HOOKS" "$STAGED" "$HOOK" \
      "$WORK/hooks.json.ours" "$WORK/hooks.json.orig"; then
    echo "Could not restore $USER_HOOKS; remove every entry whose command is:" >&2
    echo "  $HOOK" >&2
  fi
  rm -f "$STAGED"
  if [[ -n "${CREATED_CURSOR_DIR:-}" ]]; then rmdir "$CREATED_CURSOR_DIR" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap restore EXIT

cargo build --quiet --manifest-path "$REPO_ROOT/Cargo.toml" --bin agent-relay-node
PROBE="${CARGO_TARGET_DIR:-$REPO_ROOT/target}/debug/agent-relay-node"
printf -v HOOK 'env HOME=%q CURSOR_DATA_DIR=%q %q cursor-hook' "$WORK/home" "$DATA" "$PROBE"
# Remember whether ~/.cursor existed, so restore leaves none behind.
if [[ ! -d "$(dirname "$USER_HOOKS")" ]]; then CREATED_CURSOR_DIR="$(dirname "$USER_HOOKS")"; fi
mkdir -p "$(dirname "$USER_HOOKS")"
python3 -I "$WORK/hooks.py" install "$USER_HOOKS" "$STAGED" "$HOOK" \
  "$WORK/hooks.json.ours" "$WORK/hooks.json.orig"

PROMPT="Run the shell command 'sleep 40' and then reply in one short line."
python3 -I - "$WORK/project" "$PROMPT" > "$WORK/screen.log" 2>&1 <<'PY' &
import os, pty, select, signal, sys
directory, prompt = sys.argv[1], sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(directory)
    os.execvp("cursor-agent", ["cursor-agent", "--force", "--trust", "--model", "auto", prompt])
def stop(*_):
    os.kill(pid, signal.SIGTERM)
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
replies = {b"\x1b]11;?": b"\x1b]11;rgb:0000/0000/0000\x1b\\", b"\x1b]10;?": b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
           b"\x1b[?u": b"\x1b[?0u", b"\x1b[c": b"\x1b[?62;22c", b"\x1b[6n": b"\x1b[1;1R"}
while True:
    ready, _, _ = select.select([fd], [], [], 1)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        sys.stdout.buffer.write(chunk); sys.stdout.flush()
        for query, answer in replies.items():
            if query in chunk:
                os.write(fd, answer)
PY
AGENT=$!

RELAY_CURSOR_LIVE_HOME="$WORK/home" RELAY_CURSOR_LIVE_DIR="$WORK/project" CURSOR_DATA_DIR="$DATA" \
  cargo test --manifest-path "$REPO_ROOT/Cargo.toml" --lib \
  relay::cursor_cli::tests::live_cursor_session_gets_its_messages_once -- --ignored --nocapture
