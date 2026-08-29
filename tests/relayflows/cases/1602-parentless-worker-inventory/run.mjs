#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CASE_ID = '1602-parentless-worker-inventory';
const MARKER = 'RELAY_PR_PROOF_OBSERVATION=';
const PROBE_TEST = 'runtime::fleet::relayflow_1602_probe::relayflow_1602_parentless_worker_inventory_probe';

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedAppend(current, chunk, maximum = 2 * 1024 * 1024) {
  const next = current + chunk;
  return next.length <= maximum ? next : next.slice(-maximum);
}

function proofChildEnvironment() {
  const env = {
    ...process.env,
    CARGO_INCREMENTAL: '0',
    CARGO_PROFILE_DEV_DEBUG: '0',
    CARGO_PROFILE_TEST_DEBUG: '0',
    CARGO_TERM_COLOR: 'never',
    RUST_BACKTRACE: '1',
  };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key) || key.startsWith('RELAY_ATTEST_')) {
      delete env[key];
    }
  }
  return env;
}

async function isExecutable(filePath) {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// A shim is a version-manager stub that dispatches to a real toolchain based
// on the current directory / env. Even when it happens to work end-to-end,
// invoking the toolchain directly is more predictable in a sandbox that has
// nothing but a bare PATH, and avoids surprises like "cargo not found in
// toolchain X" or shim env-loading failures.
export function isShimPath(candidate) {
  const normalized = candidate.replaceAll('\\', '/');
  // Any `.../shims/<name>` path is a version-manager shim (rustup, mise, asdf).
  if (/\/shims\/[^/]+$/.test(normalized)) return true;
  // Volta wraps invocations through the binaries it installs in .volta/bin.
  if (/\/\.volta\/bin\/[^/]+$/.test(normalized)) return true;
  return false;
}

async function defaultRunOnce(command, args, options = {}) {
  const { timeoutMs } = options;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer = null;
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // The child may already be gone; nothing to do.
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
    const finish = (result) => {
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', () => finish({ code: 1, signal: null, stdout, stderr, timedOut }));
    child.on('close', (code, signal) => finish({ code: code ?? 1, signal, stdout, stderr, timedOut }));
  });
}

export async function resolveCargo(options = {}) {
  const {
    env = process.env,
    pathEntries = (env.PATH ?? '').split(path.delimiter).filter(Boolean),
    isExecutable: isExec = isExecutable,
    realpath: realpathFn = (p) => realpath(p).catch(() => p),
    readdir: readdirFn = (p) => readdir(p).catch(() => []),
    runOnce = defaultRunOnce,
    // A hung version-manager shim (lock, network wait) must not wedge the
    // whole probe. 5s is generous for a PATH lookup; a real hang means the
    // shim itself is broken and the next resolver deserves a turn.
    probeTimeoutMs = 5000,
    log = (message) => console.error(message),
    extraSystemPaths = [
      '/usr/local/cargo/bin/cargo',
      '/opt/rust/bin/cargo',
      '/root/.cargo/bin/cargo',
      '/home/daytona/.cargo/bin/cargo',
    ],
  } = options;

  const attempts = [];

  // 1) A direct non-shim cargo on PATH. Rustup's symlink proxy is rejected by
  //    the basename check (realpath's basename is "rustup"); hard-linked or
  //    scripted shims (mise/asdf/volta/rustup) are rejected by isShimPath.
  for (const entry of pathEntries) {
    const candidate = path.join(entry, 'cargo');
    if (!(await isExec(candidate))) continue;
    const resolved = await realpathFn(candidate);
    if (path.basename(resolved) !== 'cargo') {
      attempts.push(`${candidate} -> ${resolved} (rejected: proxy, not named cargo)`);
      continue;
    }
    if (isShimPath(candidate) || isShimPath(resolved)) {
      attempts.push(`${resolved} (rejected: shim path)`);
      continue;
    }
    return resolved;
  }

  // 2) Ask an installed version manager for the toolchain-selected cargo.
  //    `rustup which cargo` (and mise/asdf equivalents) prints the resolved
  //    real binary. This is the reliable path in Cloud sandboxes where only
  //    shims sit on PATH.
  for (const [tool, args] of [
    ['rustup', ['which', 'cargo']],
    ['mise', ['which', 'cargo']],
    ['asdf', ['which', 'cargo']],
  ]) {
    let binary = null;
    for (const entry of pathEntries) {
      const candidate = path.join(entry, tool);
      if (await isExec(candidate)) {
        binary = candidate;
        break;
      }
    }
    if (!binary) {
      attempts.push(`${tool}: not found on PATH`);
      continue;
    }
    let result;
    try {
      const timeoutSentinel = Symbol('probe-timeout');
      let timer = null;
      const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => resolve(timeoutSentinel), probeTimeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      try {
        const raced = await Promise.race([
          runOnce(binary, args, { timeoutMs: probeTimeoutMs }),
          timeoutPromise,
        ]);
        if (raced === timeoutSentinel) {
          log(`[resolveCargo] ${tool} ${args.join(' ')}: timed out after ${probeTimeoutMs}ms; treating as failed probe and trying next resolver`);
          attempts.push(`${tool} ${args.join(' ')}: timed out after ${probeTimeoutMs}ms`);
          continue;
        }
        result = raced;
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (error) {
      attempts.push(`${tool} ${args.join(' ')}: threw ${error?.message ?? error}`);
      continue;
    }
    if (result?.timedOut) {
      log(`[resolveCargo] ${tool} ${args.join(' ')}: timed out after ${probeTimeoutMs}ms; treating as failed probe and trying next resolver`);
      attempts.push(`${tool} ${args.join(' ')}: timed out after ${probeTimeoutMs}ms`);
      continue;
    }
    if (!result || result.code !== 0) {
      attempts.push(`${tool} ${args.join(' ')}: exit ${result?.code ?? 'unknown'}`);
      continue;
    }
    const printed = (result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!printed) {
      attempts.push(`${tool} ${args.join(' ')}: no output`);
      continue;
    }
    if (!(await isExec(printed))) {
      attempts.push(`${tool} ${args.join(' ')} -> ${printed} (not executable)`);
      continue;
    }
    if (path.basename(printed) !== 'cargo' || isShimPath(printed)) {
      attempts.push(`${tool} ${args.join(' ')} -> ${printed} (rejected: still a shim)`);
      continue;
    }
    return printed;
  }

  // 3) Enumerate rustup toolchains under any home we can plausibly infer.
  const homes = new Set();
  for (const entry of pathEntries) {
    const normalized = entry.replaceAll('\\', '/');
    for (const suffix of ['/.local/share/mise/shims', '/.cargo/bin', '/.asdf/shims']) {
      if (normalized.endsWith(suffix)) homes.add(normalized.slice(0, -suffix.length));
    }
  }
  if (env.HOME) homes.add(env.HOME);
  if (env.CARGO_HOME) homes.add(path.dirname(path.resolve(env.CARGO_HOME)));
  if (env.RUSTUP_HOME) homes.add(path.dirname(path.resolve(env.RUSTUP_HOME)));

  for (const home of homes) {
    const toolchains = path.join(home, '.rustup', 'toolchains');
    const entries = await readdirFn(toolchains);
    for (const entry of entries.slice().sort().reverse()) {
      const candidate = path.join(toolchains, entry, 'bin', 'cargo');
      if (await isExec(candidate)) return candidate;
      attempts.push(`${candidate} (missing/not executable)`);
    }
  }

  // 4) System installs.
  for (const candidate of extraSystemPaths) {
    if (!(await isExec(candidate))) continue;
    const resolved = await realpathFn(candidate);
    if (path.basename(resolved) === 'cargo' && !isShimPath(resolved)) return resolved;
    attempts.push(`${candidate} -> ${resolved} (rejected)`);
  }

  const detail = attempts.length ? `; attempts: ${attempts.join('; ')}` : '';
  throw new Error(`could not resolve a real Cargo executable outside a version-manager shim${detail}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout = boundedAppend(stdout, text);
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr = boundedAppend(stderr, text);
      process.stderr.write(text);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
  });
}

const PROBE_SOURCE = String.raw`

#[cfg(all(test, unix))]
mod relayflow_1602_probe {
    use super::*;
    use crate::fleet_wire::{
        BrokerToRelaycast, InventoryAgent, LIVE_AGENT_CAPABILITY_NAME,
    };
    use crate::node_control::{
        run_node_control_client, FleetControlCommand, FleetControlConfig,
        FleetControlEvent, FleetDeliveryBook,
    };
    use crate::protocol::{AgentRuntime, AgentSpec, NodeManifest};
    use crate::relaycast::RelaycastHttpClient;
    use crate::worker::{AgentWorkState, WorkerEvent, WorkerHandle, WorkerRegistry};
    use futures_util::{SinkExt, StreamExt};
    use httpmock::prelude::*;
    use std::process::Stdio;
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::mpsc;
    use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};

    const ADOPTED_NAME: &str = "adopted-worker";
    const ADOPTED_ID: &str = "agent-adopted-id";

    fn adopted_spec() -> AgentSpec {
        AgentSpec {
            name: WorkerName::from(ADOPTED_NAME),
            runtime: AgentRuntime::Pty,
            provider: None,
            cli: Some("codex".to_string()),
            session_id: Some("session-adopted".to_string()),
            harness_config: None,
            model: None,
            cwd: None,
            team: None,
            shadow_of: None,
            shadow_mode: None,
            args: Vec::new(),
            channels: Vec::new(),
            restart_policy: None,
        }
    }

    fn manifest() -> NodeManifest {
        NodeManifest {
            name: "relayflow-1602".to_string(),
            node_id: None,
            capabilities: Vec::new(),
            max_agents: Some(4),
            tags: None,
            repo_keys: None,
            version: Some("relayflow-1602".to_string()),
        }
    }

    async fn next_frame(ws: &mut WebSocketStream<TcpStream>) -> BrokerToRelaycast {
        loop {
            match ws.next().await.expect("node-control frame").expect("valid websocket frame") {
                Message::Text(text) => return serde_json::from_str(&text).expect("valid node frame"),
                Message::Ping(payload) => ws.send(Message::Pong(payload)).await.expect("pong"),
                Message::Close(frame) => panic!("node-control socket closed early: {frame:?}"),
                _ => {}
            }
        }
    }

    fn inventory_has_adopted(sync: &crate::fleet_wire::InventorySync) -> bool {
        sync.agents
            .iter()
            .any(|agent| agent.name == ADOPTED_NAME && agent.agent_id == ADOPTED_ID)
    }

    fn heartbeat_has_adopted(heartbeat: &crate::fleet_wire::NodeHeartbeat) -> bool {
        heartbeat
            .capabilities
            .iter()
            .find(|capability| capability.name == LIVE_AGENT_CAPABILITY_NAME)
            .and_then(|capability| capability.metadata.as_ref())
            .and_then(|metadata| metadata.get("names"))
            .and_then(serde_json::Value::as_array)
            .is_some_and(|names| names.iter().any(|name| name.as_str() == Some(ADOPTED_NAME)))
    }

    async fn observe_first_connection(ws: &mut WebSocketStream<TcpStream>) {
        let mut saw_register = false;
        let mut saw_initial_inventory = false;
        let mut saw_initial_heartbeat = false;
        let mut saw_repaired_inventory = false;
        let mut saw_repaired_heartbeat = false;

        while !(saw_repaired_inventory && saw_repaired_heartbeat) {
            match next_frame(ws).await {
                BrokerToRelaycast::NodeRegister(_) => saw_register = true,
                BrokerToRelaycast::InventorySync(sync) => {
                    if inventory_has_adopted(&sync) {
                        assert_eq!(sync.agents.len(), 2, "repair must retain the existing worker");
                        saw_repaired_inventory = true;
                    } else {
                        assert!(sync.agents.is_empty(), "initial inventory must begin empty");
                        saw_initial_inventory = true;
                    }
                }
                BrokerToRelaycast::NodeHeartbeat(heartbeat) => {
                    if heartbeat_has_adopted(&heartbeat) {
                        saw_repaired_heartbeat = true;
                    } else {
                        saw_initial_heartbeat = true;
                    }
                }
                _ => {}
            }
        }

        assert!(saw_register && saw_initial_inventory && saw_initial_heartbeat);
    }

    async fn observe_reconnect(ws: &mut WebSocketStream<TcpStream>) {
        let mut saw_register = false;
        let mut saw_inventory = false;
        let mut saw_heartbeat = false;
        while !(saw_register && saw_inventory && saw_heartbeat) {
            match next_frame(ws).await {
                BrokerToRelaycast::NodeRegister(_) => saw_register = true,
                BrokerToRelaycast::InventorySync(sync) => {
                    assert!(inventory_has_adopted(&sync), "reconnect sync lost immutable adopted id");
                    assert_eq!(sync.agents.len(), 2, "reconnect sync lost retained inventory");
                    saw_inventory = true;
                }
                BrokerToRelaycast::NodeHeartbeat(heartbeat) => {
                    assert!(heartbeat_has_adopted(&heartbeat), "reconnect heartbeat lost adopted worker");
                    saw_heartbeat = true;
                }
                _ => {}
            }
        }
    }

    #[tokio::test]
    async fn relayflow_1602_parentless_worker_inventory_probe() {
        let temp = tempfile::tempdir().expect("worker registry tempdir");
        let (event_tx, _event_rx) = mpsc::channel::<WorkerEvent>(4);
        let mut workers = WorkerRegistry::new(
            event_tx,
            Vec::new(),
            temp.path().join("worker-logs"),
            Instant::now(),
        );
        let mut child_command = tokio::process::Command::new("sh");
        child_command
            .args(["-c", "sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = child_command.spawn().expect("live adopted PTY fixture");
        let adopted_name = WorkerName::from(ADOPTED_NAME);
        let (worker_command_tx, _worker_command_rx) = mpsc::channel(4);
        workers.workers.insert(
            adopted_name.clone(),
            WorkerHandle {
                generation: Uuid::from_u128(1602),
                spec: adopted_spec(),
                parent: None,
                workspace_id: None,
                child,
                command_tx: worker_command_tx,
                harness_pid: None,
                spawned_at: Instant::now(),
                ready_at: Some(Instant::now()),
                last_activity_at: Instant::now(),
                context_budget_pct: None,
                state: AgentWorkState::Idle,
                exit_reason: None,
            },
        );

        let live_workers = workers.live_fleet_inventory_candidates();
        if live_workers.is_empty() {
            println!(
                "RELAY_PR_PROOF_OBSERVATION={{\"outcome\":\"bug\",\"signature\":\"parentless_worker_excluded_from_reconnect_inventory\",\"details\":\"The exact target's production WorkerRegistry excluded a live parentless adopted PTY before identity-safe reconciliation, so it could not enter reconnect inventory.\"}}"
            );
            return;
        }
        assert_eq!(live_workers.len(), 1, "probe owns exactly one live worker");
        assert_eq!(live_workers[0].name, adopted_name);

        let relaycast = MockServer::start();
        let lookup = relaycast.mock(|when, then| {
            when.method(GET)
                .path("/v1/agents/adopted-worker")
                .header("authorization", "Bearer rk_live_test");
            then.status(200).json_body(serde_json::json!({
                "ok": true,
                "data": {
                    "id": ADOPTED_ID,
                    "name": ADOPTED_NAME,
                    "type": "agent",
                    "status": "offline",
                    "persona": null,
                    "metadata": {}
                }
            }));
        });
        let registration = relaycast.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(500).json_body(serde_json::json!({
                "ok": false,
                "error": { "code": "must_not_register", "message": "must not register" }
            }));
        });

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("node listener");
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, command_rx) = mpsc::channel(32);
        let (control_event_tx, mut control_event_rx) = mpsc::channel(32);
        tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: Some("nt_test".to_string()),
                node_id: "node-relayflow-1602".to_string(),
                node_name: "relayflow-1602".to_string(),
                broker_version: "broker/relayflow-1602".to_string(),
                token_minter: None,
                session_token: None,
                read_idle_timeout: None,
            },
            command_rx,
            control_event_tx,
        ));

        let server = tokio::spawn(async move {
            let (first_stream, _) = listener.accept().await.expect("first node connection");
            let mut first = accept_async(first_stream).await.expect("first websocket");
            observe_first_connection(&mut first).await;
            first.close(None).await.expect("close first connection");

            let (second_stream, _) = listener.accept().await.expect("reconnect");
            let mut second = accept_async(second_stream).await.expect("second websocket");
            observe_reconnect(&mut second).await;
            second.close(None).await.expect("close second connection");
        });

        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: manifest(),
                resume_cursor: None,
            })
            .await
            .expect("register node command");
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), control_event_rx.recv())
                .await
                .expect("node connect timeout"),
            Some(FleetControlEvent::Connected)
        );

        let relaycast_http = RelaycastHttpClient::new(
            Some(relaycast.base_url()),
            "rk_live_test",
            "broker",
            "claude",
        );
        let mut inventory = HashMap::from([(
            WorkerName::from("inventory-worker"),
            InventoryAgent {
                agent_id: "agent-inventory-id".to_string(),
                name: "inventory-worker".to_string(),
                invocation_id: Some("inv-inventory".to_string()),
                session_ref: Some("session-inventory".to_string()),
            },
        )]);
        let mut delivery_book = FleetDeliveryBook::default();
        let mut retry_after = HashMap::new();
        let repaired = reconcile_fleet_inventory_with_live_workers(
            &command_tx,
            &relaycast_http,
            &mut delivery_book,
            &mut inventory,
            &mut retry_after,
            live_workers,
            Instant::now(),
        )
        .await;
        assert_eq!(repaired, 1, "identity-safe reconciliation must repair the adopted worker");
        assert_eq!(delivery_book.active_agent_id(ADOPTED_NAME), Some(ADOPTED_ID));
        command_tx
            .send(FleetControlCommand::HeartbeatNow)
            .await
            .expect("immediate repaired heartbeat");

        tokio::time::timeout(Duration::from_secs(12), server)
            .await
            .expect("initial and reconnect observations timed out")
            .expect("node server task");
        lookup.assert_hits(1);
        registration.assert_hits(0);
        let _ = command_tx.send(FleetControlCommand::Shutdown).await;

        println!(
            "RELAY_PR_PROOF_OBSERVATION={{\"outcome\":\"fixed\",\"signature\":\"parentless_worker_in_sync_and_heartbeat_after_reconnect\",\"details\":\"The exact target included a real live parentless PTY, preserved agent-adopted-id via one read-only name lookup and zero registrations, then emitted that worker in inventory.sync and relay:live-agents:v1 before and after reconnect.\"}}"
        );
    }
}
`;

async function main() {
  if (process.platform === 'win32') {
    throw new Error('The parentless live-PTY proof requires a Unix process fixture');
  }
  const arm = requiredEnvironment('RELAY_PR_PROOF_ARM');
  if (arm !== 'base' && arm !== 'head') throw new Error(`unsupported proof arm: ${arm}`);
  const targetDir = path.resolve(requiredEnvironment('RELAY_PR_PROOF_TARGET_DIR'));
  const resultPath = path.resolve(requiredEnvironment('RELAY_PR_PROOF_RESULT_PATH'));
  const expectedTargetSha = process.env.RELAY_PR_PROOF_TARGET_SHA?.trim();

  const revision = await run('git', ['rev-parse', 'HEAD'], { cwd: targetDir });
  if (revision.code !== 0) throw new Error('could not resolve the target checkout SHA');
  const actualTargetSha = revision.stdout.trim();
  if (expectedTargetSha && actualTargetSha !== expectedTargetSha) {
    throw new Error(`target provenance mismatch: expected ${expectedTargetSha}, got ${actualTargetSha}`);
  }

  const fleetPath = path.join(targetDir, 'crates', 'broker', 'src', 'runtime', 'fleet.rs');
  const original = await readFile(fleetPath, 'utf8');
  if (original.includes('mod relayflow_1602_probe')) {
    throw new Error('target checkout unexpectedly already contains the external probe module');
  }

  let testResult;
  try {
    await writeFile(fleetPath, `${original}${PROBE_SOURCE}`);
    const cargo = await resolveCargo();
    const childEnvironment = proofChildEnvironment();
    childEnvironment.RUSTC = path.join(path.dirname(cargo), 'rustc');
    childEnvironment.RUSTDOC = path.join(path.dirname(cargo), 'rustdoc');
    testResult = await run(
      cargo,
      [
        'test',
        '--locked',
        '-p',
        'agent-relay-broker',
        '--lib',
        PROBE_TEST,
        '--',
        '--exact',
        '--nocapture',
        '--test-threads=1',
      ],
      { cwd: targetDir, env: childEnvironment }
    );
  } finally {
    await writeFile(fleetPath, original);
  }

  if (testResult.code !== 0) {
    throw new Error(
      `production-path probe failed with exit ${testResult.code}${testResult.signal ? ` (${testResult.signal})` : ''}`
    );
  }
  const markerLine = testResult.stdout.split(/\r?\n/).find((line) => line.includes(MARKER));
  if (!markerLine) throw new Error('production-path probe did not emit a structured observation');
  const observation = JSON.parse(markerLine.slice(markerLine.indexOf(MARKER) + MARKER.length));
  if (!observation || typeof observation !== 'object') {
    throw new Error('production-path probe emitted an invalid observation');
  }

  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, ...observation }, null, 2)}\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
