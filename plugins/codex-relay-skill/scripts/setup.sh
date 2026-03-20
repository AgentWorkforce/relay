#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SKILL_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TARGET_ROOT="${1:-$PWD}"
CODEX_DIR="${TARGET_ROOT}/.codex"
AGENTS_DIR="${CODEX_DIR}/agents"
CONFIG_FILE="${CODEX_DIR}/config.toml"
HOOKS_FILE="${CODEX_DIR}/hooks.json"
WORKER_SOURCE="${SKILL_DIR}/codex-config/relay-worker.toml"
WORKER_TARGET="${AGENTS_DIR}/relay-worker.toml"

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

write_if_changed() {
  local path="$1"
  local tmp="$2"

  if [ -f "$path" ] && cmp -s "$path" "$tmp"; then
    rm -f "$tmp"
    return
  fi

  mv "$tmp" "$path"
}

ensure_features_codex_hooks() {
  local file="$1"
  local tmp
  tmp=$(mktemp)

  awk '
    BEGIN {
      in_features = 0
      features_seen = 0
      codex_hooks_written = 0
    }
    function write_codex_hooks() {
      if (!codex_hooks_written) {
        print "codex_hooks = true"
        codex_hooks_written = 1
      }
    }
    {
      if ($0 ~ /^[[:space:]]*features[.]codex_hooks[[:space:]]*=/) {
        print "features.codex_hooks = true"
        codex_hooks_written = 1
        next
      }

      if ($0 ~ /^\[[^]]+\][[:space:]]*$/) {
        if (in_features) {
          write_codex_hooks()
        }
        if ($0 == "[features]") {
          in_features = 1
          features_seen = 1
        } else {
          in_features = 0
        }
        print
        next
      }

      if (in_features && $0 ~ /^[[:space:]]*codex_hooks[[:space:]]*=/) {
        write_codex_hooks()
        next
      }

      print
    }
    END {
      if (in_features) {
        write_codex_hooks()
      }
      if (!features_seen && !codex_hooks_written) {
        if (NR > 0) {
          print ""
        }
        print "[features]"
        print "codex_hooks = true"
      }
    }
  ' "$file" > "$tmp"

  write_if_changed "$file" "$tmp"
}

ensure_relaycast_mcp_block() {
  local file="$1"
  local tmp
  tmp=$(mktemp)

  awk '
    BEGIN {
      in_block = 0
      block_seen = 0
      dotted_seen = 0
      command_seen = 0
      args_seen = 0
      env_seen = 0
      command_line = "command = \"npx\""
      args_line = "args = [\"-y\", \"@relaycast/mcp\"]"
      env_line = "env = { RELAY_API_KEY = \"\", RELAY_BASE_URL = \"https://api.relaycast.dev\", RELAY_AGENT_TYPE = \"agent\" }"
    }
    function write_missing_keys() {
      if (!command_seen) {
        print command_line
        command_seen = 1
      }
      if (!args_seen) {
        print args_line
        args_seen = 1
      }
      if (!env_seen) {
        print env_line
        env_seen = 1
      }
    }
    {
      if (!in_block && $0 ~ /^[[:space:]]*mcp_servers[.]relaycast[.]command[[:space:]]*=/) {
        block_seen = 1
        dotted_seen = 1
        command_seen = 1
        command_line = $0
        sub(/^[[:space:]]*mcp_servers[.]relaycast[.]command[[:space:]]*=/, "command =", command_line)
        next
      }
      if (!in_block && $0 ~ /^[[:space:]]*mcp_servers[.]relaycast[.]args[[:space:]]*=/) {
        block_seen = 1
        dotted_seen = 1
        args_seen = 1
        args_line = $0
        sub(/^[[:space:]]*mcp_servers[.]relaycast[.]args[[:space:]]*=/, "args =", args_line)
        next
      }
      if (!in_block && $0 ~ /^[[:space:]]*mcp_servers[.]relaycast[.]env[[:space:]]*=/) {
        block_seen = 1
        dotted_seen = 1
        env_seen = 1
        env_line = $0
        sub(/^[[:space:]]*mcp_servers[.]relaycast[.]env[[:space:]]*=/, "env =", env_line)
        next
      }

      if ($0 ~ /^\[[^]]+\][[:space:]]*$/) {
        if (in_block) {
          write_missing_keys()
        }
        if ($0 == "[mcp_servers.relaycast]") {
          in_block = 1
          block_seen = 1
        } else {
          in_block = 0
        }
        print
        next
      }

      if (in_block) {
        if ($0 ~ /^[[:space:]]*command[[:space:]]*=/) {
          command_seen = 1
          print
          next
        }
        if ($0 ~ /^[[:space:]]*args[[:space:]]*=/) {
          args_seen = 1
          print
          next
        }
        if ($0 ~ /^[[:space:]]*env[[:space:]]*=/) {
          env_seen = 1
          print
          next
        }
      }

      print
    }
    END {
      if (in_block) {
        write_missing_keys()
      }
      if (dotted_seen && !in_block) {
        if (NR > 0) {
          print ""
        }
        print "[mcp_servers.relaycast]"
        print command_line
        print args_line
        print env_line
      } else if (!block_seen) {
        if (NR > 0) {
          print ""
        }
        print "[mcp_servers.relaycast]"
        print command_line
        print args_line
        print env_line
      }
    }
  ' "$file" > "$tmp"

  write_if_changed "$file" "$tmp"
}

desired_hooks_json() {
  local session_cmd prompt_cmd stop_cmd
  session_cmd="bash $(shell_quote "${SKILL_DIR}/hooks/session-start.sh")"
  prompt_cmd="bash $(shell_quote "${SKILL_DIR}/hooks/prompt-inbox.sh")"
  stop_cmd="bash $(shell_quote "${SKILL_DIR}/hooks/stop-inbox.sh")"

  jq -n \
    --arg session_cmd "$session_cmd" \
    --arg prompt_cmd "$prompt_cmd" \
    --arg stop_cmd "$stop_cmd" \
    '{
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: $session_cmd,
                timeoutSec: 15,
                statusMessage: "Connecting Relaycast"
              }
            ]
          }
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: $prompt_cmd,
                timeoutSec: 5,
                statusMessage: "Checking relay inbox"
              }
            ]
          }
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: $stop_cmd,
                timeoutSec: 5,
                statusMessage: "Verifying relay inbox"
              }
            ]
          }
        ]
      }
    }'
}

merge_hooks_file() {
  local desired_json="$1"
  local tmp
  tmp=$(mktemp)

  if [ -f "$HOOKS_FILE" ] && jq empty "$HOOKS_FILE" >/dev/null 2>&1; then
    jq \
      --argjson desired "$desired_json" \
      '
        def remove_owned_groups($event; $status; $script):
          .hooks[$event] = (
            (.hooks[$event] // [])
            | map(
                select(
                  (
                    (.hooks // [])
                    | any(
                        ((.statusMessage // "") == $status) or
                        (((.command // "") | tostring) | contains($script))
                      )
                  ) | not
                )
              )
          );

        .hooks = (.hooks // {})
        | remove_owned_groups("SessionStart"; "Connecting Relaycast"; "session-start.sh")
        | remove_owned_groups("UserPromptSubmit"; "Checking relay inbox"; "prompt-inbox.sh")
        | remove_owned_groups("Stop"; "Verifying relay inbox"; "stop-inbox.sh")
        | .hooks.SessionStart = ((.hooks.SessionStart // []) + $desired.hooks.SessionStart)
        | .hooks.UserPromptSubmit = ((.hooks.UserPromptSubmit // []) + $desired.hooks.UserPromptSubmit)
        | .hooks.Stop = ((.hooks.Stop // []) + $desired.hooks.Stop)
      ' "$HOOKS_FILE" > "$tmp"
  else
    printf '%s\n' "$desired_json" > "$tmp"
  fi

  write_if_changed "$HOOKS_FILE" "$tmp"
}

install_worker_agent() {
  if [ ! -f "$WORKER_SOURCE" ]; then
    return
  fi

  local tmp
  tmp=$(mktemp)
  cp "$WORKER_SOURCE" "$tmp"
  write_if_changed "$WORKER_TARGET" "$tmp"
}

main() {
  if ! command_exists jq; then
    exit 0
  fi

  mkdir -p "$CODEX_DIR" "$AGENTS_DIR"
  touch "$CONFIG_FILE"

  chmod +x "${SKILL_DIR}/scripts/setup.sh" "${SKILL_DIR}/hooks/"*.sh 2>/dev/null || true

  ensure_features_codex_hooks "$CONFIG_FILE"
  ensure_relaycast_mcp_block "$CONFIG_FILE"
  merge_hooks_file "$(desired_hooks_json)"
  install_worker_agent
}

main "$@"
