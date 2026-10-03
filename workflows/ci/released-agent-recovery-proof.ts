/**
 * Red/green proof for released broker worker identity recovery.
 *
 * Cloud's default executor gives each deterministic step a fresh sandbox. The
 * complete process lifecycle therefore runs in one recorded scenario step;
 * only the durable verdict is handed to the final gate through Relayfile.
 *
 * Run with:
 *   agent-relay cloud run workflows/ci/released-agent-recovery-proof.ts --sync-code
 */

import { workflow } from '@relayflows/core';

const artifacts = '.workflow-artifacts/released-agent-recovery-proof';
const suffix = `recovery-${Date.now()}`;
const target = `relay-recover-proof-${suffix}`;
const control = `relay-recover-control-${suffix}`;

async function main(): Promise<void> {
  const result = await workflow('released-agent-recovery-proof')
    .description('Release a throwaway broker worker and prove its immutable identity is recoverable.')
    .pattern('pipeline')
    .channel('wf-released-agent-recovery-proof')
    .maxConcurrency(1)
    .timeout(1_800_000)
    .onError('continue')

    .step('release-respawn-scenario', {
      type: 'deterministic',
      captureOutput: true,
      failOnError: true,
      command: String.raw`
set -euo pipefail

ARTIFACTS='${artifacts}'
TARGET='${target}'
CONTROL='${control}'
STATE=$(mktemp -d /tmp/relay-recover-state.XXXXXX)
DEFAULT_CONNECTION="$PWD/.agentworkforce/relay/connection.json"
mkdir -p "$ARTIFACTS"
rm -f "$ARTIFACTS/desired-verdict.txt"

cleanup() {
  set +e
  relay node agent release "$TARGET" >/dev/null 2>&1
  relay node agent release "$CONTROL" >/dev/null 2>&1
  relay agent remove "$TARGET" >/dev/null 2>&1
  relay agent remove "$CONTROL" >/dev/null 2>&1
  relay node down --state-dir "$STATE" >/dev/null 2>&1
  rm -f "$DEFAULT_CONNECTION"
}
trap cleanup EXIT

command -v jq >/dev/null
command -v curl >/dev/null
command -v sha256sum >/dev/null

PROVIDER=''
for candidate in codex claude opencode gemini; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PROVIDER="$candidate"
    break
  fi
done
test -n "$PROVIDER"

relay node up --background --no-spawn --state-dir "$STATE"
CONNECTION="$STATE/connection.json"
test -s "$CONNECTION"
test ! -e "$DEFAULT_CONNECTION"
mkdir -p "$(dirname "$DEFAULT_CONNECTION")"
cp "$CONNECTION" "$DEFAULT_CONNECTION"
chmod 600 "$DEFAULT_CONNECTION"
export RELAY_BROKER_URL
export RELAY_BROKER_API_KEY
RELAY_BROKER_URL=$(jq -er '.url' "$CONNECTION")
RELAY_BROKER_API_KEY=$(jq -er '.api_key' "$CONNECTION")

BROKER_READY=0
for attempt in $(seq 1 30); do
  if curl -fsS -H "X-API-Key: $RELAY_BROKER_API_KEY" "$RELAY_BROKER_URL/api/status" > "$ARTIFACTS/broker-status.json"; then
    BROKER_READY=1
    break
  fi
  sleep 1
done
test "$BROKER_READY" -eq 1
echo "PREFLIGHT_OK provider=$PROVIDER target=$TARGET control=$CONTROL"

relay node agent spawn "$PROVIDER" --name "$TARGET" --runtime pty
for attempt in $(seq 1 30); do
  curl -fsS -H "X-API-Key: $RELAY_BROKER_API_KEY" "$RELAY_BROKER_URL/api/spawned" > "$ARTIFACTS/target-local-live.json"
  jq -e --arg name "$TARGET" '.agents[] | select(.name == $name and (.pid | type == "number"))' "$ARTIFACTS/target-local-live.json" >/dev/null && break
  sleep 1
done
TARGET_PID=$(jq -er --arg name "$TARGET" '.agents[] | select(.name == $name) | .pid' "$ARTIFACTS/target-local-live.json")

for attempt in $(seq 1 30); do
  relay agent list > "$ARTIFACTS/target-roster-before.json"
  jq -e --arg name "$TARGET" '.[] | select(.name == $name)' "$ARTIFACTS/target-roster-before.json" >/dev/null && break
  sleep 1
done
TARGET_ID=$(jq -er --arg name "$TARGET" '.[] | select(.name == $name) | .id' "$ARTIFACTS/target-roster-before.json")
test -r "/proc/$TARGET_PID/environ"
OLD_TOKEN_HASH=$(tr '\0' '\n' < "/proc/$TARGET_PID/environ" | grep -a '^RELAY_AGENT_TOKEN=.' | sed 's/^RELAY_AGENT_TOKEN=//' | sha256sum | awk '{print $1}')
test -n "$OLD_TOKEN_HASH"
printf '%s\n' "$TARGET_ID" > "$ARTIFACTS/expected-agent-id.txt"
printf '%s\n' "$OLD_TOKEN_HASH" > "$ARTIFACTS/old-token-hash.txt"
echo "TARGET_LIVE name=$TARGET agent_id=$TARGET_ID credential_hash_recorded=yes"

relay node agent release "$TARGET"
for attempt in $(seq 1 30); do
  curl -fsS -H "X-API-Key: $RELAY_BROKER_API_KEY" "$RELAY_BROKER_URL/api/spawned" > "$ARTIFACTS/target-local-after-release.json"
  if ! jq -e --arg name "$TARGET" '.agents[] | select(.name == $name)' "$ARTIFACTS/target-local-after-release.json" >/dev/null; then
    break
  fi
  sleep 1
done
if jq -e --arg name "$TARGET" '.agents[] | select(.name == $name)' "$ARTIFACTS/target-local-after-release.json" >/dev/null; then
  echo "TARGET_STILL_LOCAL_AFTER_RELEASE name=$TARGET"
  exit 1
fi

relay agent list > "$ARTIFACTS/target-roster-after-release.json"
RELEASED_ID=$(jq -er --arg name "$TARGET" '.[] | select(.name == $name) | .id' "$ARTIFACTS/target-roster-after-release.json")
test "$RELEASED_ID" = "$TARGET_ID"
echo "TARGET_RELEASED local_process=absent retained_agent_id=$RELEASED_ID"

relay node agent spawn "$PROVIDER" --name "$CONTROL" --runtime pty
curl -fsS -H "X-API-Key: $RELAY_BROKER_API_KEY" "$RELAY_BROKER_URL/api/spawned" > "$ARTIFACTS/control-local-live.json"
jq -e --arg name "$CONTROL" '.agents[] | select(.name == $name)' "$ARTIFACTS/control-local-live.json" >/dev/null
relay agent list > "$ARTIFACTS/control-roster.json"
CONTROL_ID=$(jq -er --arg name "$CONTROL" '.[] | select(.name == $name) | .id' "$ARTIFACTS/control-roster.json")
relay node agent release "$CONTROL"
echo "FRESH_NAME_CONTROL_OK name=$CONTROL agent_id=$CONTROL_ID"

set +e
relay node agent spawn "$PROVIDER" --name "$TARGET" --runtime pty > "$ARTIFACTS/respawn.log" 2>&1
RESPAWN_EXIT=$?
set -e
printf '%s\n' "$RESPAWN_EXIT" > "$ARTIFACTS/respawn-exit.txt"

if [ "$RESPAWN_EXIT" -ne 0 ]; then
  if ! grep -Ei 'already exists|create-only|recover|takeover|conflict' "$ARTIFACTS/respawn.log" >/dev/null; then
    echo "UNEXPECTED_RESPAWN_FAILURE exit=$RESPAWN_EXIT"
    sed -n '1,80p' "$ARTIFACTS/respawn.log"
    exit 1
  fi
  printf 'FAIL\n' > "$ARTIFACTS/desired-verdict.txt"
  echo "DEFECT_CONFIRMED exact_name_respawn=failed retained_agent_id=$TARGET_ID"
  sed -n '1,80p' "$ARTIFACTS/respawn.log"
  exit 0
fi

for attempt in $(seq 1 30); do
  curl -fsS -H "X-API-Key: $RELAY_BROKER_API_KEY" "$RELAY_BROKER_URL/api/spawned" > "$ARTIFACTS/respawn-local-live.json"
  jq -e --arg name "$TARGET" '.agents[] | select(.name == $name and (.pid | type == "number"))' "$ARTIFACTS/respawn-local-live.json" >/dev/null && break
  sleep 1
done
RECOVERED_PID=$(jq -er --arg name "$TARGET" '.agents[] | select(.name == $name) | .pid' "$ARTIFACTS/respawn-local-live.json")
relay agent list > "$ARTIFACTS/respawn-roster.json"
RECOVERED_ID=$(jq -er --arg name "$TARGET" '.[] | select(.name == $name) | .id' "$ARTIFACTS/respawn-roster.json")
test "$RECOVERED_ID" = "$TARGET_ID"
test -r "/proc/$RECOVERED_PID/environ"
NEW_TOKEN_HASH=$(tr '\0' '\n' < "/proc/$RECOVERED_PID/environ" | grep -a '^RELAY_AGENT_TOKEN=.' | sed 's/^RELAY_AGENT_TOKEN=//' | sha256sum | awk '{print $1}')
test -n "$NEW_TOKEN_HASH"
test "$NEW_TOKEN_HASH" != "$OLD_TOKEN_HASH"
printf '%s\n' "$NEW_TOKEN_HASH" > "$ARTIFACTS/new-token-hash.txt"
printf 'PASS\n' > "$ARTIFACTS/desired-verdict.txt"
echo "RECOVERY_OK name=$TARGET immutable_agent_id=$RECOVERED_ID credential_nonce_rotated=yes"
`,
    })

    .step('enforce-verdict', {
      type: 'deterministic',
      dependsOn: ['release-respawn-scenario'],
      captureOutput: true,
      failOnError: true,
      command: String.raw`
set -euo pipefail
VERDICT=$(cat '${artifacts}/desired-verdict.txt')
echo "RECOVERY_PROOF_VERDICT=$VERDICT target=${target}"
test "$VERDICT" = PASS
`,
    })
    .run({ cwd: process.cwd() });

  console.log(`workflow_status=${result.status}`);
  if (result.status !== 'completed') process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
