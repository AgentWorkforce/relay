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
            .json_body_partial(json!({"delete_agent":true}).to_string());
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
            if let Ok(response) = result.try_recv() { assert!(response.is_ok()); break; }
            tokio::task::yield_now().await;
        }
    }).await.expect("owned cleanup should complete");
    release.assert_hits(1);

    let (reply, repeated) = oneshot::channel();
    fixture.runtime.handle_api_request(ListenApiRequest::Release {
        name: name.clone(), reason: None, expected_generation: None, delete_identity: false, reply,
    }).await;
    assert!(repeated.await.unwrap().is_ok());
    release.assert_hits(1);
    assert!(fixture.fleet_control_rx.try_recv().is_err());
    fixture.runtime.workers.release("relayflow-1710-unrelated").await.unwrap();
}
`;

if (arm === 'base') {
  if (apiSource.includes(headMarker)) throw new Error('Base unexpectedly contains the head fix.');
}

const cargoEnv = sanitizedEnvironment();
const originalTests = await readFile(testPath, 'utf8');
try {
  await writeFile(testPath, `${originalTests}\n${PROBE_TEST}\n`, 'utf8');
  const probe = runCargo(probeTest, cargoEnv);
  const probePassed = probe.status === 0 && probe.stdout.includes(`test runtime::tests::${probeTest} ... ok`);
  if (arm === 'base') {
    if (probePassed || probe.status === 0) {
      throw new Error(`Base unexpectedly passed the owned name-only release probe: ${probe.stdout}`);
    }
    await writeResult({
      outcome: 'bug',
      signature: 'name_only_release_routes_without_generation_custody',
      details:
        'The injected executable probe drove the base broker release actor with a retired broker-owned generation; the base routed name-only release through the legacy host path instead of direct token-hash-bound cleanup.',
    });
  } else {
    if (!apiSource.includes(headMarker) || !probePassed) {
      throw new Error(`Head did not pass the generation-bound probe: ${probe.stdout}\n${probe.stderr}`);
    }
    for (const [filter, description] of [
      [headTest, 'direct delete and repeat idempotence'],
      ['owned_cleanup_waits_off_actor_and_retains_custody_until_confirmed', 'replacement custody'],
      [callerTest, 'caller-owned deletion refusal'],
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
