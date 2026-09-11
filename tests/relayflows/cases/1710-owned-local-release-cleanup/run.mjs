import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1710-owned-local-release-cleanup';
const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const arm = requiredValue('RELAY_PR_PROOF_ARM');
const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;

if (!['base', 'head'].includes(arm) || !expectedSha) {
  throw new Error('Invalid RelayFlow arm identity.');
}
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact arm SHA ${expectedSha}.`);
}
if (!isWithin(harnessDir, fileURLToPath(import.meta.url))) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const apiSource = readFileSync(path.join(targetDir, 'crates/broker/src/runtime/api.rs'), 'utf8');
const headMarker = 'promote that request to the same';
const headTest = 'name_only_release_of_retired_owned_worker_deletes_directly_and_is_idempotent';
const callerTest = 'caller_owned_release_cannot_be_promoted_to_identity_deletion';
const probeTest = 'relayflow_1710_probe_name_only_release';
const testPath = path.join(targetDir, 'crates/broker/src/runtime/tests.rs');
const PROBE_TEST = String.raw`
#[tokio::test]
async fn ${probeTest}() {
    use crate::listen_api::ListenApiRequest;
    use httpmock::{Method::POST, MockServer};
    use tokio::sync::oneshot;

    let server = MockServer::start();
    let release = server.mock(|when, then| {
        when.method(POST)
            .path("/v1/agents/release")
            .json_body_partial(json!({"delete_agent":true,"expected_token_hash":"bec092bff160b23541205064ab9f4485d6c2089760b1bb4e5f5ce19f0274aad3"}).to_string());
        then.status(200)
            .json_body(json!({"ok":true,"data":{"status":"completed"}}));
    });
    let registry = make_worker_registry_with_worker("relayflow-1710-unrelated").await;
    let mut fixture = worker_event_runtime_fixture(registry, HashMap::new());
    fixture.runtime.relaycast_http = RelaycastHttpClient::new(
        None,
        "rk_live_relayflow",
        "broker",
        "codex",
    );
    let name = WorkerName::from("relayflow-1710-retired");
    let generation = Uuid::new_v4();
    let http = RelaycastHttpClient::new(Some(server.base_url()), "rk_live_relayflow", "broker", "codex");
    http.seed_agent_token(&name, "owned-token");
    fixture.runtime.workers.owned_spawn_generations.insert(name.clone(), (generation, http));
    fixture.runtime.fleet_delivery_book.bind_authoritative_identity(name.to_string(), "relayflow-1710-id");

    let (reply, mut result) = oneshot::channel();
    fixture.runtime.handle_api_request(ListenApiRequest::Release {
        name: name.clone(), reason: None, expected_generation: None, delete_identity: false, reply,
    }).await;
    let deregister = loop {
        match fixture.fleet_control_rx.recv().await.unwrap() {
            FleetControlCommand::DeregisterAgent { reply, .. } => break Some(reply),
            FleetControlCommand::Send(BrokerToRelaycast::AgentDeregister(_)) => break None,
            _ => {}
        }
    };
    if let Some(deregister) = deregister { deregister.send(Ok(())).unwrap(); }
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            fixture.runtime.reconcile_identity_cleanups().await;
            if let Ok(response) = result.try_recv() {
                match response {
                    Ok(response) => {
                        if response["process"] != "stopped" || response["identity"] != "deleted" {
                            panic!(
                                "relayflow_1710_probe_name_only_release detected expected cleanup mismatch: {response}"
                            );
                        }
                    }
                    Err(error) => {
                        panic!(
                            "relayflow_1710_probe_name_only_release detected expected cleanup mismatch: {error}"
                        );
                    }
                }
                break;
            }
            tokio::task::yield_now().await;
        }
    }).await.expect("owned cleanup should complete");
    release.assert_hits(1);

    let (reply, repeated) = oneshot::channel();
    fixture.runtime.handle_api_request(ListenApiRequest::Release {
        name: name.clone(), reason: None, expected_generation: None, delete_identity: false, reply,
    }).await;
    let repeated = repeated.await.unwrap().expect("repeat should be idempotent");
    assert_eq!(repeated["process"], "stopped");
    assert_eq!(repeated["identity"], "deleted");
    release.assert_hits(1);
    assert!(fixture.fleet_control_rx.try_recv().is_err());
    fixture.runtime.workers.release("relayflow-1710-unrelated").await.unwrap();
}
`;

const cargoEnv = sanitizedEnvironment();
const originalTests = await readFile(testPath, 'utf8');
try {
  await writeFile(testPath, `${originalTests}\n${PROBE_TEST}\n`, 'utf8');
  const probe = runCargo(probeTest, cargoEnv);
  const probeOutput = `${probe.stdout}\n${probe.stderr}`;
  const probePassed = probe.status === 0 && probeOutput.includes(`test runtime::tests::${probeTest} ... ok`);
  if (arm === 'base') {
    if (
      probe.status === 0 ||
      !probeOutput.includes(`test runtime::tests::${probeTest} ... FAILED`) ||
      !probeOutput.includes('relayflow_1710_probe_name_only_release detected expected cleanup mismatch')
    ) {
      throw new Error(`Base did not report the expected cleanup mismatch:\n${probeOutput}`);
    }
    await writeResult({
      outcome: 'bug',
      signature: 'release_outcome_not_machine_readable',
      details:
        'The injected executable probe drove the base broker release actor with a retired broker-owned generation and exact local Relaycast mock; process and identity outcomes were not separately machine-readable.',
    });
  } else {
    if (!apiSource.includes(headMarker) || !probePassed) {
      throw new Error(`Head did not pass the generation-bound probe: ${probe.stdout}\n${probe.stderr}`);
    }
    for (const [filter, description] of [
      [headTest, 'direct delete and repeat idempotence'],
      ['owned_cleanup_waits_off_actor_and_retains_custody_until_confirmed', 'replacement custody'],
      [callerTest, 'caller-owned deletion refusal'],
      [
        'owned_cleanup_journal_restores_generation_and_retries_without_plaintext_token',
        'restart journal recovery',
      ],
    ]) {
      const result = runCargo(filter, cargoEnv);
      if (result.status !== 0 || !result.stdout.includes(`test runtime::tests::${filter} ... ok`)) {
        throw new Error(`RelayFlow test did not execute ${description}: ${result.stdout}\n${result.stderr}`);
      }
    }
    await writeResult({
      outcome: 'fixed',
      signature: 'owned_release_deletes_exactly_and_repeats_safely',
      details:
        'Deterministic broker integration drove the real release actor with a loopback Relaycast mock: the same executable probe failed on base and passed on head, while committed tests proved token-hash deletion, repeat idempotence, replacement custody, and caller-owned refusal.',
    });
  }
} finally {
  await writeFile(testPath, originalTests, 'utf8');
}

function runCargo(filter, env) {
  try {
    return {
      status: 0,
      stdout: execFileSync('cargo', ['test', '-p', 'agent-relay-broker', filter, '--lib'], {
        cwd: targetDir,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      stderr: '',
    };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? error.message,
    };
  }
}

function sanitizedEnvironment() {
  const env = { ...process.env, AGENT_RELAY_TELEMETRY_DISABLED: '1' };
  for (const key of Object.keys(env)) {
    if (/(TOKEN|SECRET|PASSWORD|API_KEY|WORKSPACE_KEY)/i.test(key)) delete env[key];
  }
  return env;
}

async function writeResult({ outcome, signature, details }) {
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function requiredDirectory(name) {
  return path.resolve(requiredValue(name));
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
