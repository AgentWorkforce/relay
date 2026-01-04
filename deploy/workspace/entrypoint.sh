#!/usr/bin/env bash

set -euo pipefail

log() {
  echo "[workspace] $*"
}

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
  cat > "/tmp/gh-token-helper.sh" <<'GHEOF'
#!/usr/bin/env bash
# Fetch fresh token for gh CLI
response=$(curl -sf \
  -H "Authorization: Bearer ${WORKSPACE_TOKEN}" \
  "${CLOUD_API_URL}/api/git/token?workspaceId=${WORKSPACE_ID}" 2>/dev/null)
if [[ -n "$response" ]]; then
  echo "$response" | jq -r '.token // empty'
fi
GHEOF
  chmod +x "/tmp/gh-token-helper.sh"

  # gh CLI will use GH_TOKEN if set; we export a function to refresh it
  # For now, set it once at startup (will be refreshed by the credential helper for git operations)
  export GH_TOKEN=$(/tmp/gh-token-helper.sh 2>/dev/null || echo "")
  if [[ -n "${GH_TOKEN}" ]]; then
    log "GitHub CLI configured with fresh token"
  else
    log "WARN: Could not fetch GitHub token for gh CLI"
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
}

if [[ -n "${REPO_LIST}" ]]; then
  if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    log "WARN: REPOSITORIES set but no GITHUB_TOKEN provided; clones may fail."
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

# Claude CLI expects ~/.claude/credentials.json
if [[ -n "${ANTHROPIC_TOKEN:-}" ]]; then
  log "Configuring Claude credentials..."
  mkdir -p "${HOME}/.claude"
  cat > "${HOME}/.claude/credentials.json" <<EOF
{
  "oauth_token": "${ANTHROPIC_TOKEN}",
  "expires_at": null
}
EOF
  chmod 600 "${HOME}/.claude/credentials.json"
fi

# Codex CLI expects ~/.codex/credentials.json
if [[ -n "${OPENAI_TOKEN:-}" ]]; then
  log "Configuring Codex credentials..."
  mkdir -p "${HOME}/.codex"
  cat > "${HOME}/.codex/credentials.json" <<EOF
{
  "token": "${OPENAI_TOKEN}",
  "expires_at": null
}
EOF
  chmod 600 "${HOME}/.codex/credentials.json"
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

log "Starting agent-relay daemon on port ${PORT}"
args=(/app/dist/cli/index.js up --port "${PORT}")

if [[ "${SUPERVISOR_ENABLED:-true}" == "true" ]]; then
  args+=("--watch")
fi

exec node "${args[@]}"
