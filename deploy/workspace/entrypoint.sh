#!/usr/bin/env bash

set -euo pipefail

log() {
  echo "[workspace] $*"
}

# Drop to workspace user if running as root
if [[ "$(id -u)" == "0" ]]; then
  log "Dropping privileges to workspace user..."
  exec gosu workspace "$0" "$@"
fi

PORT="${AGENT_RELAY_DASHBOARD_PORT:-${PORT:-3888}}"
export AGENT_RELAY_DASHBOARD_PORT="${PORT}"
export PORT="${PORT}"

WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
REPO_LIST="${REPOSITORIES:-}"

mkdir -p "${WORKSPACE_DIR}"
cd "${WORKSPACE_DIR}"

# Configure Git credentials via the gateway (tokens auto-refresh via Nango)
# The credential helper fetches fresh tokens from the cloud API on each git operation
if [[ -n "${CLOUD_API_URL:-}" && -n "${WORKSPACE_ID:-}" && -n "${WORKSPACE_TOKEN:-}" ]]; then
  log "Configuring git credential helper (gateway mode)"
  git config --global credential.helper "/usr/local/bin/git-credential-relay"
  git config --global credential.useHttpPath true
  export GIT_TERMINAL_PROMPT=0

  # Configure git identity for commits
  # Use env vars if set, otherwise default to "Agent Relay" / "agent@agent-relay.com"
  DEFAULT_GIT_EMAIL="${AGENT_NAME:-agent}@agent-relay.com"
  git config --global user.name "${GIT_USER_NAME:-Agent Relay}"
  git config --global user.email "${GIT_USER_EMAIL:-${DEFAULT_GIT_EMAIL}}"
  log "Git identity configured: ${GIT_USER_NAME:-Agent Relay} <${GIT_USER_EMAIL:-${DEFAULT_GIT_EMAIL}}>"

  # Configure gh CLI to use the same token mechanism
  # gh auth login expects a token via stdin or GH_TOKEN env var
  # We'll set up a wrapper that fetches fresh tokens
  mkdir -p "${HOME}/.config/gh"
  cat > "${HOME}/.config/gh/hosts.yml" <<EOF
github.com:
  oauth_token: placeholder
  git_protocol: https
EOF

  # Create gh token wrapper script
  # Uses userToken (OAuth) for gh CLI, not installation token
  cat > "/tmp/gh-token-helper.sh" <<'GHEOF'
#!/usr/bin/env bash
# Fetch fresh user OAuth token for gh CLI
response=$(curl -sf \
  -H "Authorization: Bearer ${WORKSPACE_TOKEN}" \
  "${CLOUD_API_URL}/api/git/token?workspaceId=${WORKSPACE_ID}" 2>/dev/null)
if [[ -n "$response" ]]; then
  # Prefer userToken (OAuth) for gh CLI, fall back to installation token
  user_token=$(echo "$response" | jq -r '.userToken // empty')
  if [[ -n "$user_token" && "$user_token" != "null" ]]; then
    echo "$user_token"
  else
    echo "$response" | jq -r '.token // empty'
  fi
fi
GHEOF
  chmod +x "/tmp/gh-token-helper.sh"

  # Create gh wrapper that auto-refreshes token on each invocation
  # This ensures gh always has a valid token without agents needing to do anything
  GH_REAL=$(which gh 2>/dev/null || echo "/usr/bin/gh")
  if [[ -x "${GH_REAL}" ]]; then
    cat > "/tmp/gh-wrapper" <<GHWRAPPER
#!/usr/bin/env bash
# Auto-refreshing gh wrapper - fetches fresh token on each invocation
export GH_TOKEN=\$(/tmp/gh-token-helper.sh 2>/dev/null)
if [[ -z "\${GH_TOKEN}" ]]; then
  echo "gh-wrapper: Failed to fetch GitHub token" >&2
  echo "gh-wrapper: Check CLOUD_API_URL, WORKSPACE_ID, and WORKSPACE_TOKEN are set" >&2
  exit 1
fi
exec "${GH_REAL}" "\$@"
GHWRAPPER
    chmod +x "/tmp/gh-wrapper"

    # Create symlink or copy to override the real gh
    # We use /usr/local/bin which comes before /usr/bin in PATH
    if [[ -w "/usr/local/bin" ]]; then
      cp "/tmp/gh-wrapper" "/usr/local/bin/gh"
      log "Installed auto-refreshing gh wrapper to /usr/local/bin/gh"
    else
      # If we can't write to /usr/local/bin, add /tmp to PATH
      export PATH="/tmp:${PATH}"
      mv "/tmp/gh-wrapper" "/tmp/gh"
      log "Added auto-refreshing gh wrapper to PATH"
    fi
  fi

  # Also set GH_TOKEN at startup for any tools that read it directly
  # (The wrapper handles runtime refresh, this is just for initialization)
  export GH_TOKEN=""
  for attempt in 1 2 3; do
    GH_TOKEN=$(/tmp/gh-token-helper.sh 2>/dev/null || echo "")
    if [[ -n "${GH_TOKEN}" ]]; then
      break
    fi
    sleep 1
  done
  if [[ -n "${GH_TOKEN}" ]]; then
    log "GitHub CLI configured with fresh token"
  else
    log "WARN: Could not fetch initial GitHub token for gh CLI"
  fi

# Fallback: Use static GITHUB_TOKEN if provided (legacy mode)
elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
  log "Configuring git credentials (legacy static token mode)"
  GIT_ASKPASS_SCRIPT="/tmp/git-askpass.sh"
  cat > "${GIT_ASKPASS_SCRIPT}" <<'EOF'
#!/usr/bin/env bash
prompt="${1:-}"
if [[ "${prompt}" == *"Username"* ]]; then
  echo "x-access-token"
else
  echo "${GITHUB_TOKEN}"
fi
EOF
  chmod +x "${GIT_ASKPASS_SCRIPT}"
  export GIT_ASKPASS="${GIT_ASKPASS_SCRIPT}"
  export GIT_TERMINAL_PROMPT=0
  export GH_TOKEN="${GITHUB_TOKEN}"

  # Configure git identity for commits
  DEFAULT_GIT_EMAIL="${AGENT_NAME:-agent}@agent-relay.com"
  git config --global user.name "${GIT_USER_NAME:-Agent Relay}"
  git config --global user.email "${GIT_USER_EMAIL:-${DEFAULT_GIT_EMAIL}}"
  log "Git identity configured: ${GIT_USER_NAME:-Agent Relay} <${GIT_USER_EMAIL:-${DEFAULT_GIT_EMAIL}}>"
fi

clone_or_update_repo() {
  local repo="$1"
  repo="${repo// /}"
  if [[ -z "${repo}" ]]; then
    return
  fi

  local repo_name
  repo_name="$(basename "${repo}")"
  local target="${WORKSPACE_DIR}/${repo_name}"
  local url="https://github.com/${repo}.git"

  if [[ -d "${target}/.git" ]]; then
    log "Updating ${repo}..."
    git -C "${target}" remote set-url origin "${url}" >/dev/null 2>&1 || true
    git -C "${target}" fetch --all --prune >/dev/null 2>&1 || true
    git -C "${target}" pull --ff-only >/dev/null 2>&1 || true
  else
    log "Cloning ${repo}..."
    git clone "${url}" "${target}" >/dev/null 2>&1 || {
      log "WARN: Failed to clone ${repo}"
    }
  fi

  # Mark directory as safe to prevent "dubious ownership" errors
  # This is needed when git runs as a different user (e.g., root via SSH)
  if [[ -d "${target}/.git" ]]; then
    git config --global --add safe.directory "${target}" 2>/dev/null || true
  fi
}

if [[ -n "${REPO_LIST}" ]]; then
  # Check if we have credentials configured (gateway mode or static token)
  if [[ -z "${GITHUB_TOKEN:-}" && -z "${CLOUD_API_URL:-}" ]]; then
    log "WARN: REPOSITORIES set but no credentials configured; clones may fail."
  fi

  IFS=',' read -ra repos <<< "${REPO_LIST}"
  for repo in "${repos[@]}"; do
    clone_or_update_repo "${repo}"
  done
fi

# ============================================================================
# Configure agent policy enforcement for cloud workspaces
# Policy is fetched from cloud API and enforced at runtime
# ============================================================================

if [[ -n "${CLOUD_API_URL:-}" && -n "${WORKSPACE_ID:-}" ]]; then
  log "Enabling agent policy enforcement"
  export AGENT_POLICY_ENFORCEMENT=1
  # Policy is fetched from ${CLOUD_API_URL}/api/policy/${WORKSPACE_ID}/internal
fi

# ============================================================================
# Configure AI provider credentials
# Create credential files that CLIs expect from ENV vars passed by provisioner
# ============================================================================

# Claude CLI expects ~/.claude/.credentials.json (note the dot prefix on filename)
# Format: { claudeAiOauth: { accessToken: "...", refreshToken: "...", expiresAt: ... } }
if [[ -n "${ANTHROPIC_TOKEN:-}" ]]; then
  log "Configuring Claude credentials..."
  mkdir -p "${HOME}/.claude"
  cat > "${HOME}/.claude/.credentials.json" <<EOF
{
  "claudeAiOauth": {
    "accessToken": "${ANTHROPIC_TOKEN}",
    "refreshToken": "${ANTHROPIC_REFRESH_TOKEN:-}",
    "expiresAt": ${ANTHROPIC_TOKEN_EXPIRES_AT:-null}
  }
}
EOF
  chmod 600 "${HOME}/.claude/.credentials.json"
fi

# Configure Claude Code for cloud workspaces
# Create both settings and instructions files
log "Configuring Claude Code for cloud workspace..."
mkdir -p "${HOME}/.claude"

# Create settings.json to auto-accept permissions (required for cloud workspaces)
# This tells Claude Code to skip the "Ready to code here?" permission prompt
# Reference: Claude Code uses this for headless/automated environments
cat > "${HOME}/.claude/settings.json" <<'SETTINGSEOF'
{
  "permissions": {
    "allow": [
      "Read",
      "Edit",
      "Write",
      "Bash",
      "Glob",
      "Grep",
      "Task",
      "WebFetch",
      "WebSearch",
      "NotebookEdit",
      "TodoWrite"
    ],
    "deny": []
  },
  "autoApproveApiRequest": true
}
SETTINGSEOF
chmod 600 "${HOME}/.claude/settings.json"
log "Created Claude Code settings (auto-approve enabled)"

# Create CLAUDE.md with agent relay protocol instructions
# This is loaded automatically by Claude Code and provides the relay protocol
if [[ -f "/app/docs/agent-relay-snippet.md" ]]; then
  cp "/app/docs/agent-relay-snippet.md" "${HOME}/.claude/CLAUDE.md"
  log "Copied relay protocol from /app/docs/agent-relay-snippet.md"
else
  # Fallback: create minimal instructions
  log "WARN: /app/docs/agent-relay-snippet.md not found, creating minimal instructions"
  cat > "${HOME}/.claude/CLAUDE.md" <<'RELAYEOF'
# Agent Relay

Real-time agent-to-agent messaging. Output `->relay:` patterns to communicate.

## Sending Messages

Use fenced format for reliable delivery:
```
->relay:AgentName <<<
Your message here.>>>
```

Broadcast to all: `->relay:* <<<message>>>`

## Protocol

1. ACK immediately when you receive a task
2. Do the work
3. Send DONE: summary when complete

## Session Persistence

Output periodically to checkpoint progress:
```
[[SUMMARY]]{"currentTask":"...","completedTasks":[...],"context":"..."}[[/SUMMARY]]
```

When session is complete:
```
[[SESSION_END]]{"summary":"...","completedTasks":[...]}[[/SESSION_END]]
```
RELAYEOF
fi
log "Claude Code configuration complete"

# Codex CLI expects ~/.codex/auth.json
# Format: { tokens: { access_token: "...", refresh_token: "...", ... } }
if [[ -n "${OPENAI_TOKEN:-}" ]]; then
  log "Configuring Codex credentials..."
  mkdir -p "${HOME}/.codex"
  cat > "${HOME}/.codex/auth.json" <<EOF
{
  "tokens": {
    "access_token": "${OPENAI_TOKEN}",
    "refresh_token": "${OPENAI_REFRESH_TOKEN:-}"
  }
}
EOF
  chmod 600 "${HOME}/.codex/auth.json"
fi

# Google/Gemini - uses application default credentials
if [[ -n "${GOOGLE_TOKEN:-}" ]]; then
  log "Configuring Google credentials..."
  mkdir -p "${HOME}/.config/gcloud"
  cat > "${HOME}/.config/gcloud/application_default_credentials.json" <<EOF
{
  "type": "authorized_user",
  "access_token": "${GOOGLE_TOKEN}"
}
EOF
  chmod 600 "${HOME}/.config/gcloud/application_default_credentials.json"
fi

# ============================================================================
# Detect workspace path and start daemon
# The daemon must start from the same directory that spawned agents will use
# to ensure consistent socket paths
# ============================================================================

# Function to detect the actual workspace path (same logic as project-namespace.ts)
detect_workspace_path() {
  local base_dir="${1}"

  # 1. Explicit override via env var
  if [[ -n "${WORKSPACE_CWD:-}" ]]; then
    echo "${WORKSPACE_CWD}"
    return
  fi

  # 2. Check if base_dir itself is a git repo
  if [[ -d "${base_dir}/.git" ]]; then
    echo "${base_dir}"
    return
  fi

  # 3. Scan for cloned repos (directories with .git)
  local first_repo=""
  for dir in "${base_dir}"/*/; do
    if [[ -d "${dir}.git" ]]; then
      # Use first repo found (alphabetically sorted by bash glob)
      first_repo="${dir%/}"
      break
    fi
  done

  if [[ -n "${first_repo}" ]]; then
    echo "${first_repo}"
    return
  fi

  # 4. Fall back to base_dir
  echo "${base_dir}"
}

# Detect the actual workspace path
ACTUAL_WORKSPACE=$(detect_workspace_path "${WORKSPACE_DIR}")
log "Detected workspace path: ${ACTUAL_WORKSPACE}"

# Change to the detected workspace before starting daemon
cd "${ACTUAL_WORKSPACE}"

log "Starting agent-relay daemon on port ${PORT} from ${ACTUAL_WORKSPACE}"
args=(/app/dist/cli/index.js up --port "${PORT}")

if [[ "${SUPERVISOR_ENABLED:-true}" == "true" ]]; then
  args+=("--watch")
fi

exec node "${args[@]}"
