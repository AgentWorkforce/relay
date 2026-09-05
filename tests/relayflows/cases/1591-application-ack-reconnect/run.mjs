import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CASE_ID = '1591-application-ack-reconnect';
const MARKER = 'RELAYFLOW_APPLICATION_ACK_RECONNECTED=';

function fail(message) {
  throw new Error(`[${CASE_ID}] ${message}`);
}

const arm = process.env.RELAY_PR_PROOF_ARM;
if (arm !== 'base' && arm !== 'head') fail(`invalid RELAY_PR_PROOF_ARM: ${arm ?? '<missing>'}`);

const targetDir = resolve(process.env.RELAY_PR_PROOF_TARGET_DIR ?? '');
const resultPath = resolve(process.env.RELAY_PR_PROOF_RESULT_PATH ?? '');
if (!process.env.RELAY_PR_PROOF_TARGET_DIR) fail('RELAY_PR_PROOF_TARGET_DIR is required');
if (!process.env.RELAY_PR_PROOF_RESULT_PATH) fail('RELAY_PR_PROOF_RESULT_PATH is required');

const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) fail(`missing expected ${arm} SHA`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (targetSha !== expectedSha) fail(`target SHA ${targetSha} does not match ${arm} SHA ${expectedSha}`);

const scratch = mkdtempSync(join(tmpdir(), `relayflow-${CASE_ID}-`));
const checkout = join(scratch, 'target');

try {
  cpSync(targetDir, checkout, {
    recursive: true,
    filter: (source) =>
      !source.includes(`${join(targetDir, '.git')}`) && !source.includes(`${join(targetDir, 'target')}`),
  });

  const sourcePath = join(checkout, 'crates/broker/src/node_control.rs');
  const source = readFileSync(sourcePath, 'utf8');
  const cadence = 'const INVENTORY_REFRESH_INTERVAL: Duration = Duration::from_secs(60);';
  if (!source.includes(cadence)) fail('base/head-common inventory refresh constant was not found');
  writeFileSync(
    sourcePath,
    source.replace(cadence, 'const INVENTORY_REFRESH_INTERVAL: Duration = Duration::from_millis(100);')
  );
  appendFileSync(
    sourcePath,
    String.raw`

pub async fn relayflow_application_ack_reconnect_probe() -> bool {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, command_rx) = tokio::sync::mpsc::channel(8);
        let (event_tx, _event_rx) = tokio::sync::mpsc::channel(8);
        let client = tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: Some("nt_relayflow".to_string()),
                node_id: "node-relayflow".to_string(),
                node_name: "relayflow-loopback".to_string(),
                broker_version: "relayflow/head-authored".to_string(),
                token_minter: None,
                session_token: None,
                read_idle_timeout: Some(Duration::from_millis(400)),
            },
            command_rx,
            event_tx,
        ));
        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: NodeManifest {
                    name: "relayflow-loopback".to_string(),
                    node_id: Some("node-relayflow".to_string()),
                    capabilities: Vec::new(),
                    max_agents: Some(1),
                    tags: None,
                    repo_keys: None,
                    version: Some("relayflow/head-authored".to_string()),
                },
                resume_cursor: None,
            })
            .await
            .unwrap();

        let (stream, _) = listener.accept().await.unwrap();
        let mut first = tokio_tungstenite::accept_async(stream).await.unwrap();
        let mut shutdown_ws = None;
        let reconnected = tokio::time::timeout(Duration::from_millis(2500), async {
            loop {
                match first.next().await {
                    Some(Ok(Message::Ping(payload))) => {
                        if first.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break,
                }
            }
            let (stream, _) = listener.accept().await.unwrap();
            shutdown_ws = Some(tokio_tungstenite::accept_async(stream).await.unwrap());
            true
        })
        .await
        .unwrap_or(false);

        client.abort();
        let _ = client.await;
        drop(shutdown_ws);
        reconnected
}
`
  );

  const libPath = join(checkout, 'crates/broker/src/lib.rs');
  const libSource = readFileSync(libPath, 'utf8');
  const privateModule = 'pub(crate) mod node_control;';
  if (!libSource.includes(privateModule)) fail('base/head-common node_control module was not found');
  writeFileSync(libPath, libSource.replace(privateModule, 'pub mod node_control;'));
  appendFileSync(
    join(checkout, 'crates/broker/Cargo.toml'),
    '\n[[bin]]\nname = "relayflow-application-ack-reconnect"\npath = "src/bin/relayflow_application_ack_reconnect.rs"\n'
  );
  const binDir = join(checkout, 'crates/broker/src/bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, 'relayflow_application_ack_reconnect.rs'),
    `#[tokio::main]\nasync fn main() {\n    let reconnected = relay_broker::node_control::relayflow_application_ack_reconnect_probe().await;\n    println!("${MARKER}{}", if reconnected { "true" } else { "false" });\n}\n`
  );

  const run = spawnSync(
    'cargo',
    ['run', '-p', 'agent-relay-broker', '--bin', 'relayflow-application-ack-reconnect'],
    {
      cwd: checkout,
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '1',
        CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL ?? '0',
        CARGO_PROFILE_DEV_DEBUG: process.env.CARGO_PROFILE_DEV_DEBUG ?? '0',
        RUSTFLAGS: process.env.RUSTFLAGS ?? '-C debuginfo=0 -C codegen-units=256',
      },
    }
  );
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  if (run.error) fail(`cargo run infrastructure failure: ${run.error.message}`);
  if (run.status !== 0) fail(`cargo run infrastructure failure (exit ${run.status})`);

  const matches = [...(run.stdout ?? '').matchAll(new RegExp(`${MARKER}(true|false)`, 'g'))];
  if (matches.length !== 1) fail(`expected exactly one observation marker, found ${matches.length}`);
  const reconnected = matches[0][1] === 'true';
  const observation = reconnected
    ? {
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: 'fixed',
        signature: 'application_ack_stall_reconnects',
        details:
          'The production node-control client reconnected while loopback WebSocket pongs continued and inventory.sync acknowledgements were withheld.',
      }
    : {
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: 'bug',
        signature: 'application_ack_stall_not_detected',
        details:
          'The production node-control client did not reconnect while loopback WebSocket pongs continued and inventory.sync acknowledgements were withheld.',
      };
  writeFileSync(resultPath, `${JSON.stringify(observation, null, 2)}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
