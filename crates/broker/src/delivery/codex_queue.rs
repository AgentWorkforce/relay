use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;

use super::backend::{
    DeliveryBackend, DeliveryBackendFuture, DeliveryError, HandoverState, ObservedAck, RouteId,
    SendRequest, SendStatus, SettleRequest, SettleStatus, TransportStatus,
};
use crate::cli::command_parse::{normalize_cli_name, parse_cli_command};
use crate::delivery::codex_thread::{CodexMarkerObservation, CodexThreadSession};
use crate::ids::WorkerName;
use crate::protocol::{AgentSpec, ResolvedHarnessConfig};
use crate::worker::WorkerRegistry;

const CODEX_QUEUE_TIMEOUT: Duration = Duration::from_secs(15);
const CODEX_QUEUE_ERROR_MAX_BYTES: usize = 2_048;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexQueueTarget {
    command: String,
    global_args: Vec<String>,
    env: Vec<(String, String)>,
    cwd: Option<PathBuf>,
    thread: CodexThreadSession,
    allow_bundle_fallbacks: bool,
}

impl CodexQueueTarget {
    pub(crate) fn attached(
        thread_id: impl Into<String>,
        codex_home: Option<PathBuf>,
        rollout_path: PathBuf,
        cwd: Option<PathBuf>,
    ) -> Result<Self, String> {
        let mut env = Vec::new();
        if let Some(home) = codex_home.as_ref() {
            env.push((
                "CODEX_HOME".to_string(),
                home.to_string_lossy().into_owned(),
            ));
        }
        let thread = CodexThreadSession::new(thread_id, Some(rollout_path))
            .ok_or_else(|| "invalid Codex thread id".to_string())?
            .with_codex_home(codex_home);
        Ok(Self {
            // The authenticated broker, not the MCP caller, resolves the
            // executable. A bare name also enables the broker's trusted app
            // bundle fallbacks when the desktop Codex is newer than PATH.
            command: "codex".to_string(),
            global_args: Vec::new(),
            env,
            cwd,
            thread,
            allow_bundle_fallbacks: true,
        })
    }

    pub(crate) fn thread_id(&self) -> &str {
        self.thread.thread_id()
    }

    pub(crate) fn has_verified_rollout_path(&self) -> bool {
        self.thread.has_rollout_path()
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(
        command: impl Into<String>,
        global_args: Vec<String>,
        cwd: Option<PathBuf>,
        thread_id: impl Into<String>,
        rollout_path: Option<PathBuf>,
    ) -> Self {
        Self {
            command: command.into(),
            global_args,
            env: Vec::new(),
            cwd,
            thread: CodexThreadSession::new(thread_id, rollout_path).expect("test thread id"),
            allow_bundle_fallbacks: false,
        }
    }

    fn route_id(&self) -> RouteId {
        RouteId::new(format!("codex-queue:{}", self.thread.thread_id()))
    }
}

/// Native Codex delivery over the public `codex queue` command.
///
/// This backend is intentionally selectable only when Relay already has a
/// stable thread id for the worker. It does not infer ownership from Codex's
/// SQLite state; that file is only a settlement/verification index.
pub(crate) struct CodexQueueBackend {
    target: Option<CodexQueueTarget>,
}

impl CodexQueueBackend {
    pub(crate) fn for_worker(workers: &WorkerRegistry, worker_name: &WorkerName) -> Self {
        Self {
            target: workers
                .native_codex_target(worker_name)
                .cloned()
                .or_else(|| target_for_worker(workers, worker_name)),
        }
    }

    pub(crate) fn is_selectable(&self) -> bool {
        self.target.is_some()
    }

    #[cfg(test)]
    pub(crate) fn for_target(target: CodexQueueTarget) -> Self {
        Self {
            target: Some(target),
        }
    }
}

impl DeliveryBackend for CodexQueueBackend {
    fn route_id(&self) -> RouteId {
        self.target
            .as_ref()
            .map(CodexQueueTarget::route_id)
            .unwrap_or_else(|| RouteId::new("codex-queue"))
    }

    fn transport_status(&mut self) -> TransportStatus {
        match self.target.as_ref() {
            Some(_) => TransportStatus::Available,
            None => TransportStatus::Unavailable(
                "Codex queue route requires a Codex worker with a known thread id".to_string(),
            ),
        }
    }

    fn send<'a>(
        &'a mut self,
        request: &'a SendRequest,
    ) -> DeliveryBackendFuture<'a, Result<SendStatus, DeliveryError>> {
        Box::pin(async move {
            let target = self.target.as_ref().ok_or_else(|| {
                DeliveryError::unavailable(
                    "Codex queue route requires a Codex worker with a known thread id",
                )
            })?;
            let queue_command = target.ensure_queue_capability().await?;
            target.queue_message(request, &queue_command).await?;
            Ok(SendStatus::HandedOver(HandoverState::HandedOver))
        })
    }

    /// Settle from Codex's own records.
    ///
    /// Only a CONSUMED user input item in the thread's rollout produces an
    /// acknowledgement. A message still sitting in `queued_items` is durably
    /// delivered to the transport and read by nobody, so it settles as
    /// `HandedOver` — the same answer an unreadable store gives, because both
    /// mean "not observed to have been read", and neither licenses the read
    /// receipt `runtime/maintenance.rs` publishes off an ack. Seam rule 4.
    fn settle<'a>(
        &'a mut self,
        request: &'a SettleRequest,
    ) -> DeliveryBackendFuture<'a, SettleStatus> {
        Box::pin(async move {
            let Some(target) = self.target.as_ref() else {
                return SettleStatus::HandedOver(HandoverState::HandedOver);
            };
            match target.thread.observe_marker(&request.delivery_id).await {
                CodexMarkerObservation::Consumed { source, offset } => {
                    SettleStatus::Acked(ObservedAck::transcript(source, offset))
                }
                CodexMarkerObservation::Queued { source } => {
                    tracing::debug!(
                        target = "agent_relay::broker",
                        thread_id = %target.thread_id(),
                        delivery_id = %request.delivery_id,
                        source = %source,
                        "Codex holds this delivery in its durable queue; not acknowledged \
                         until a turn consumes it"
                    );
                    SettleStatus::HandedOver(HandoverState::HandedOver)
                }
                CodexMarkerObservation::Unknown => {
                    SettleStatus::HandedOver(HandoverState::HandedOver)
                }
            }
        })
    }
}

impl CodexQueueTarget {
    async fn ensure_queue_capability(&self) -> Result<String, DeliveryError> {
        crate::codex_session::resolve_queue_capable_codex_command(
            &self.command,
            &self.global_args,
            self.cwd.as_deref(),
            &self.env,
            self.allow_bundle_fallbacks,
        )
        .await
        .ok_or_else(|| {
            DeliveryError::unavailable(
                "installed Codex does not expose `codex queue --thread --message`",
            )
        })
    }

    async fn queue_message(
        &self,
        request: &SendRequest,
        queue_command: &str,
    ) -> Result<(), DeliveryError> {
        let body = CodexThreadSession::body_with_marker(&request.body, &request.delivery_id);
        let mut command = self.command(queue_command);
        command
            .arg("queue")
            .arg("--thread")
            .arg(self.thread.thread_id())
            .arg(format!("--message={body}"))
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = command
            .spawn()
            .map_err(|_| DeliveryError::unavailable("Codex queue command could not start"))?;
        let output = tokio::time::timeout(CODEX_QUEUE_TIMEOUT, child.wait_with_output())
            .await
            .map_err(|_| {
                DeliveryError::committed(format!(
                    "Codex queue did not exit within {}ms",
                    CODEX_QUEUE_TIMEOUT.as_millis()
                ))
            })?
            .map_err(|_| DeliveryError::committed("Codex queue wait failed"))?;
        if output.status.success() {
            Ok(())
        } else {
            let detail = bounded_redacted_stderr(&output.stderr);
            Err(DeliveryError::committed(format!(
                "Codex queue exited with status {}{}",
                output.status.code().unwrap_or(-1),
                if detail.is_empty() {
                    String::new()
                } else {
                    format!(": {detail}")
                }
            )))
        }
    }

    fn command(&self, program: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(program);
        command.args(&self.global_args);
        for (key, value) in &self.env {
            command.env(key, value);
        }
        if let Some(cwd) = self.cwd.as_deref() {
            command.current_dir(cwd);
        }
        command.stdin(Stdio::null());
        command
    }
}

fn bounded_redacted_stderr(stderr: &[u8]) -> String {
    let mut detail = crate::redact::redact(String::from_utf8_lossy(stderr).trim());
    if detail.len() > CODEX_QUEUE_ERROR_MAX_BYTES {
        let mut end = CODEX_QUEUE_ERROR_MAX_BYTES;
        while end > 0 && !detail.is_char_boundary(end) {
            end -= 1;
        }
        detail.truncate(end);
        detail.push('…');
    }
    detail
}

fn target_for_worker(
    workers: &WorkerRegistry,
    worker_name: &WorkerName,
) -> Option<CodexQueueTarget> {
    target_for_spec(&workers.workers.get(worker_name)?.spec)
}

/// The selection guard, over the one thing it actually depends on.
///
/// Two independent conditions, both required: the worker's resolved command
/// must normalize to `codex`, and relay must already hold a stable thread id
/// for it. Everything the parity answer claims about non-Codex CLIs rests on
/// this being structural rather than on per-CLI runs, so it is lifted out of
/// the registry lookup where a test can drive it directly.
fn target_for_spec(spec: &AgentSpec) -> Option<CodexQueueTarget> {
    let CommandParts {
        command,
        cli_args,
        metadata,
        env,
    } = codex_command_parts(spec)?;
    let (command, cli_args) = metadata
        .and_then(metadata_codex_queue_command)
        .unwrap_or((command, cli_args));
    let normalized = normalize_cli_name(&command).to_lowercase();
    if normalized != "codex" && normalized != "codex.exe" {
        return None;
    }
    let thread_id = spec.session_id.as_deref().or_else(|| {
        spec.harness_config
            .as_ref()
            .and_then(ResolvedHarnessConfig::session_id)
    })?;
    let rollout_path = metadata.and_then(metadata_rollout_path);
    let env = codex_queue_env(metadata, env);
    let codex_home = env
        .iter()
        .find(|(key, _)| key == "CODEX_HOME")
        .map(|(_, value)| PathBuf::from(value));
    Some(CodexQueueTarget {
        command,
        global_args: codex_queue_global_args(&cli_args),
        env,
        cwd: spec.cwd.as_deref().map(PathBuf::from),
        thread: CodexThreadSession::new(thread_id, rollout_path)?.with_codex_home(codex_home),
        // A broker-owned terminal must only use the exact Codex binary it
        // launched. A different app-bundle binary may expose `queue` while the
        // running TUI does not consume that queue, which silently strands the
        // message. Attached desktop sessions deliberately allow the trusted
        // app-bundle fallback in `CodexQueueTarget::attached`.
        allow_bundle_fallbacks: false,
    })
}

struct CommandParts<'a> {
    command: String,
    cli_args: Vec<String>,
    metadata: Option<&'a HashMap<String, Value>>,
    env: Option<&'a HashMap<String, String>>,
}

fn codex_command_parts(spec: &AgentSpec) -> Option<CommandParts<'_>> {
    match spec.harness_config.as_ref() {
        Some(ResolvedHarnessConfig::Pty(config)) => {
            let (command, mut args) = parse_cli_command(&config.command).ok()?;
            args.extend(config.args.clone());
            Some(CommandParts {
                command,
                cli_args: args,
                metadata: config.metadata.as_ref(),
                env: config.env.as_ref(),
            })
        }
        Some(ResolvedHarnessConfig::Headless(config)) => {
            let cli = spec.cli.as_deref()?;
            let (command, mut args) = parse_cli_command(cli).ok()?;
            args.extend(spec.args.clone());
            Some(CommandParts {
                command,
                cli_args: args,
                metadata: config.metadata.as_ref(),
                env: None,
            })
        }
        Some(ResolvedHarnessConfig::Native(config)) => {
            let (command, mut args) = parse_cli_command(&config.command).ok()?;
            args.extend(config.args.clone());
            Some(CommandParts {
                command,
                cli_args: args,
                metadata: config.metadata.as_ref(),
                env: config.env.as_ref(),
            })
        }
        _ => {
            let cli = spec.cli.as_deref()?;
            let (command, mut args) = parse_cli_command(cli).ok()?;
            args.extend(spec.args.clone());
            Some(CommandParts {
                command,
                cli_args: args,
                metadata: None,
                env: None,
            })
        }
    }
}

fn metadata_rollout_path(metadata: &HashMap<String, Value>) -> Option<PathBuf> {
    metadata
        .get("rollout_path")
        .or_else(|| metadata.get("rolloutPath"))
        .or_else(|| metadata.get("codex_rollout_path"))
        .or_else(|| metadata.get("codexRolloutPath"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn metadata_codex_queue_command(
    metadata: &HashMap<String, Value>,
) -> Option<(String, Vec<String>)> {
    metadata
        .get("codex_queue_command")
        .or_else(|| metadata.get("codexQueueCommand"))
        .or_else(|| metadata.get("codex_command"))
        .or_else(|| metadata.get("codexCommand"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| parse_cli_command(value).ok())
}

fn metadata_codex_home(metadata: &HashMap<String, Value>) -> Option<String> {
    metadata
        .get("codex_home")
        .or_else(|| metadata.get("codexHome"))
        .or_else(|| metadata.get("CODEX_HOME"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn codex_queue_env(
    metadata: Option<&HashMap<String, Value>>,
    env: Option<&HashMap<String, String>>,
) -> Vec<(String, String)> {
    if let Some(value) = env
        .and_then(|env| env.get("CODEX_HOME"))
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return vec![("CODEX_HOME".to_string(), value.to_string())];
    }
    metadata
        .and_then(metadata_codex_home)
        .map(|value| vec![("CODEX_HOME".to_string(), value)])
        .unwrap_or_default()
}

pub(crate) fn codex_queue_global_args(args: &[String]) -> Vec<String> {
    const VALUE_FLAGS: &[&str] = &[
        "--profile",
        "--config",
        "-c",
        "--cd",
        "--cwd",
        "--sandbox",
        "-s",
        "--ask-for-approval",
        "--approval-policy",
    ];
    const BOOL_FLAGS: &[&str] = &[
        "--dangerously-bypass-approvals-and-sandbox",
        "--dangerously-bypass-hook-trust",
        "--full-auto",
        "--strict-config",
    ];
    let mut out = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "--" || arg == "resume" || arg == "fork" {
            break;
        }
        if let Some((flag, _)) = arg.split_once('=') {
            if VALUE_FLAGS.contains(&flag) {
                out.push(arg.to_string());
            }
            index += 1;
            continue;
        }
        if VALUE_FLAGS.contains(&arg) {
            if let Some(value) = args.get(index + 1) {
                out.push(arg.to_string());
                out.push(value.clone());
                index += 2;
                continue;
            }
            break;
        }
        if BOOL_FLAGS.contains(&arg) {
            out.push(arg.to_string());
            index += 1;
            continue;
        }
        index += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delivery::{DeliverySeam, SendOutcome};
    use std::os::unix::fs::PermissionsExt;

    #[cfg(unix)]
    fn fake_codex(script: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("codex");
        std::fs::write(&path, script).expect("write fake codex");
        let mut permissions = std::fs::metadata(&path).expect("metadata").permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).expect("chmod");
        (dir, path)
    }

    struct FallbackProbe {
        sends: usize,
    }

    impl DeliveryBackend for FallbackProbe {
        fn route_id(&self) -> RouteId {
            RouteId::new("pty")
        }

        fn transport_status(&mut self) -> TransportStatus {
            TransportStatus::Available
        }

        fn send<'a>(
            &'a mut self,
            _request: &'a SendRequest,
        ) -> DeliveryBackendFuture<'a, Result<SendStatus, DeliveryError>> {
            self.sends += 1;
            Box::pin(async { Ok(SendStatus::HandedOver(HandoverState::HandedOver)) })
        }

        fn settle<'a>(
            &'a mut self,
            _request: &'a SettleRequest,
        ) -> DeliveryBackendFuture<'a, SettleStatus> {
            Box::pin(async { SettleStatus::HandedOver(HandoverState::HandedOver) })
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unavailable_queue_capability_falls_back_before_write() {
        let (_dir, codex) = fake_codex(
            r#"#!/bin/sh
exit 2
"#,
        );
        let target = CodexQueueTarget::new_for_test(
            codex.display().to_string(),
            vec![],
            None,
            "thread-1",
            None,
        );
        let mut codex = CodexQueueBackend::for_target(target);
        let mut fallback = FallbackProbe { sends: 0 };
        let mut seam = DeliverySeam::new();

        let outcome = seam
            .send(
                &mut [&mut codex, &mut fallback],
                SendRequest::new("del_capability", "hello"),
            )
            .await
            .expect("fallback accepts");

        assert!(matches!(
            outcome,
            SendOutcome::Fresh(ref receipt) if receipt.route.as_str() == "pty"
        ));
        assert_eq!(fallback.sends, 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn queue_process_failure_is_committed_and_does_not_fall_back() {
        let (_dir, codex) = fake_codex(
            r#"#!/bin/sh
if [ "$1" = "queue" ] && [ "$2" = "--help" ]; then
  printf '%s\n' 'Usage: codex queue --thread <id> --message=<text>'
  exit 0
fi
printf '%s\n' 'api_key=do-not-leak queue target was rejected' >&2
exit 7
"#,
        );
        let target = CodexQueueTarget::new_for_test(
            codex.display().to_string(),
            vec![],
            None,
            "thread-1",
            None,
        );
        let mut codex = CodexQueueBackend::for_target(target);
        let mut fallback = FallbackProbe { sends: 0 };
        let mut seam = DeliverySeam::new();

        let error = seam
            .send(
                &mut [&mut codex, &mut fallback],
                SendRequest::new("del_committed", "hello"),
            )
            .await
            .expect_err("queue process started, so failure is committed");

        let DeliveryError::CommittedError { reason } = error else {
            panic!("queue process failure must be committed");
        };
        assert!(reason.contains("queue target was rejected"));
        assert!(reason.contains("[REDACTED]"));
        assert!(!reason.contains("do-not-leak"));
        assert_eq!(fallback.sends, 0);
        assert!(seam
            .recorded_route(&crate::ids::DeliveryId::new("del_committed"))
            .is_some());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn successful_queue_send_is_handed_over_not_acked() {
        let dir = tempfile::tempdir().expect("temp dir");
        let record = dir.path().join("queued.txt");
        let (_script_dir, codex) = fake_codex(&format!(
            r#"#!/bin/sh
if [ "$1" = "queue" ] && [ "$2" = "--help" ]; then
  printf '%s\n' 'Usage: codex queue --thread <id> --message=<text>'
  exit 0
fi
printf '%s\n' "$@" > '{}'
exit 0
"#,
            record.display()
        ));
        let target = CodexQueueTarget::new_for_test(
            codex.display().to_string(),
            vec![],
            None,
            "thread-1",
            None,
        );
        let mut codex = CodexQueueBackend::for_target(target);
        let mut seam = DeliverySeam::new();

        let outcome = seam
            .send(&mut [&mut codex], SendRequest::new("del_ok", "hello"))
            .await
            .expect("queue succeeds");

        let SendOutcome::Fresh(receipt) = outcome else {
            panic!("first send must be fresh");
        };
        assert_eq!(
            receipt.status,
            SendStatus::HandedOver(HandoverState::HandedOver)
        );
        assert!(std::fs::read_to_string(record)
            .expect("recorded args")
            .contains("relay-delivery-id:del_ok"));
    }

    /// Seam rule 2, on the real transport: one delivery id, one `codex queue`
    /// child. The recorded receipt — not the absence of an error — is what
    /// stops the second attempt, so the count is read off the fake Codex's own
    /// log rather than off the seam's answer.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_repeated_send_never_queues_the_same_delivery_twice() {
        let dir = tempfile::tempdir().expect("temp dir");
        let log = dir.path().join("invocations.log");
        let (_script_dir, codex) = fake_codex(&format!(
            r#"#!/bin/sh
if [ "$1" = "queue" ] && [ "$2" = "--help" ]; then
  printf '%s\n' 'Usage: codex queue --thread <id> --message=<text>'
  exit 0
fi
printf '%s\n' "$*" >> '{}'
exit 0
"#,
            log.display()
        ));
        let queue_writes = || {
            std::fs::read_to_string(&log)
                .map(|text| {
                    text.lines()
                        .filter(|line| line.starts_with("queue "))
                        .count()
                })
                .unwrap_or(0)
        };
        let target = CodexQueueTarget::new_for_test(
            codex.display().to_string(),
            vec![],
            None,
            "thread-dup",
            None,
        );
        let mut backend = CodexQueueBackend::for_target(target);
        let mut seam = DeliverySeam::new();

        let first = seam
            .send(&mut [&mut backend], SendRequest::new("del_dup", "hello"))
            .await
            .expect("first queue send succeeds");
        assert!(matches!(first, SendOutcome::Fresh(_)), "{first:?}");
        assert_eq!(queue_writes(), 1, "precondition: the first send wrote once");

        let second = seam
            .send(&mut [&mut backend], SendRequest::new("del_dup", "hello"))
            .await
            .expect("a repeat of a recorded delivery is not an error");

        assert!(
            matches!(second, SendOutcome::AlreadySent(_)),
            "a delivery id the seam already routed must not reach the backend again, got {second:?}"
        );
        assert_eq!(
            queue_writes(),
            1,
            "a second `codex queue` child for one delivery id is a double delivery"
        );
    }

    /// Rule 2's cancellation half, on the real transport. A dropped send future
    /// cannot prove the child never wrote, so the provisional receipt stands
    /// and the next attempt must not spawn a second `codex queue`.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_cancelled_queue_send_is_not_retried_on_the_codex_route() {
        let dir = tempfile::tempdir().expect("temp dir");
        let log = dir.path().join("invocations.log");
        let (_script_dir, codex) = fake_codex(&format!(
            r#"#!/bin/sh
if [ "$1" = "queue" ] && [ "$2" = "--help" ]; then
  printf '%s\n' 'Usage: codex queue --thread <id> --message=<text>'
  exit 0
fi
printf '%s\n' "$*" >> '{}'
sleep 30
exit 0
"#,
            log.display()
        ));
        let queue_writes = || {
            std::fs::read_to_string(&log)
                .map(|text| {
                    text.lines()
                        .filter(|line| line.starts_with("queue "))
                        .count()
                })
                .unwrap_or(0)
        };
        let target = CodexQueueTarget::new_for_test(
            codex.display().to_string(),
            vec![],
            None,
            "thread-cancel",
            None,
        );
        let mut backend = CodexQueueBackend::for_target(target);
        let mut seam = DeliverySeam::new();

        let cancelled = tokio::time::timeout(
            Duration::from_millis(250),
            seam.send(
                &mut [&mut backend],
                SendRequest::new("del_cancelled", "hello"),
            ),
        )
        .await;
        assert!(
            cancelled.is_err(),
            "fixture must actually cancel the send mid-write"
        );

        let retried = seam
            .send(
                &mut [&mut backend],
                SendRequest::new("del_cancelled", "hello"),
            )
            .await
            .expect("a cancelled delivery is recorded, not an error");

        assert!(
            matches!(retried, SendOutcome::AlreadySent(_)),
            "a cancelled send may have written; it must never be handed to the route again, \
             got {retried:?}"
        );
        assert!(
            queue_writes() <= 1,
            "a cancelled send must not produce a second `codex queue` child"
        );
    }

    /// Seam rule 3, on the real transport: settlement asks the route that
    /// accepted the send, identified by its thread, and never a
    /// differently-threaded Codex.
    ///
    /// The decoy thread's rollout carries the same marker, so a settlement that
    /// resolved by "whatever codex backend is in the slice" would acknowledge
    /// from the wrong session's file.
    #[cfg(unix)]
    #[tokio::test]
    async fn settlement_uses_the_recorded_thread_route_and_never_another_codex() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (_script_dir, codex) = fake_codex(
            r#"#!/bin/sh
if [ "$1" = "queue" ] && [ "$2" = "--help" ]; then
  printf '%s\n' 'Usage: codex queue --thread <id> --message=<text>'
  exit 0
fi
exit 0
"#,
        );
        let consumed = |path: &std::path::Path| {
            std::fs::write(
                path,
                concat!(
                    r#"{"type":"response_item","payload":{"type":"message","role":"user","#,
                    r#""content":[{"type":"input_text","text":"hello\n\n<!-- relay-delivery-id:del_route -->"}]}}"#,
                    "\n",
                ),
            )
            .expect("write rollout");
        };
        let sent_rollout = dir.path().join("sent-thread.jsonl");
        let decoy_rollout = dir.path().join("decoy-thread.jsonl");
        consumed(&sent_rollout);
        consumed(&decoy_rollout);

        let mut sent = CodexQueueBackend::for_target(CodexQueueTarget::new_for_test(
            codex.display().to_string(),
            vec![],
            None,
            "thread-sent",
            Some(sent_rollout.clone()),
        ));
        let mut decoy = CodexQueueBackend::for_target(CodexQueueTarget::new_for_test(
            codex.display().to_string(),
            vec![],
            None,
            "thread-decoy",
            Some(decoy_rollout),
        ));
        let mut seam = DeliverySeam::new();
        let delivery_id = crate::ids::DeliveryId::new("del_route");

        seam.send(
            &mut [&mut sent],
            SendRequest::new(delivery_id.clone(), "hello"),
        )
        .await
        .expect("queue send succeeds");
        assert_eq!(
            seam.recorded_route(&delivery_id).map(RouteId::as_str),
            Some("codex-queue:thread-sent"),
            "precondition: the send is recorded against its own thread"
        );

        // Only the decoy is offered. The recorded route is not in the slice, so
        // settlement must report that — not settle against the other thread.
        assert_eq!(
            seam.settle(&mut [&mut decoy], &delivery_id).await,
            crate::delivery::SettleOutcome::RouteUnavailable(RouteId::new(
                "codex-queue:thread-sent"
            )),
            "settling through a differently-threaded Codex would acknowledge from a session \
             this delivery was never sent to"
        );

        // With the recorded route present, settlement resolves through it.
        let settled = seam
            .settle(&mut [&mut decoy, &mut sent], &delivery_id)
            .await;
        let crate::delivery::SettleOutcome::Settled(SettleStatus::Acked(ack)) = settled else {
            panic!("the recorded route observed the consumed marker, got {settled:?}");
        };
        let crate::delivery::AckEvidence::Transcript { source, .. } = ack.evidence() else {
            panic!("a codex-queue acknowledgement must name the transcript it read");
        };
        assert_eq!(
            source,
            &sent_rollout.display().to_string(),
            "settlement must read the thread it sent to"
        );
    }

    fn spec_for(cli: &str, session_id: Option<&str>) -> AgentSpec {
        let mut value = serde_json::json!({
            "name": "selection-guard",
            "runtime": "pty",
            "cli": cli,
            "args": [],
            "channels": [],
        });
        if let Some(session_id) = session_id {
            value["sessionId"] = Value::String(session_id.to_string());
        }
        serde_json::from_value(value).expect("agent spec")
    }

    /// The selection guard the parity answer rests on: a worker is only routed
    /// over `codex queue` when it IS codex and relay already knows its thread.
    /// The positive case is asserted in the same test so a guard that refused
    /// everything could not pass it.
    #[test]
    fn only_a_codex_worker_with_a_known_thread_selects_the_codex_queue_route() {
        for cli in [
            "claude",
            "gemini",
            "opencode",
            "grok",
            "droid",
            "cursor-agent",
        ] {
            let backend = CodexQueueBackend {
                target: target_for_spec(&spec_for(cli, Some("thread-1"))),
            };
            assert!(
                !backend.is_selectable(),
                "{cli} is not codex and must never take the codex queue route"
            );
        }

        let no_session = CodexQueueBackend {
            target: target_for_spec(&spec_for("codex", None)),
        };
        assert!(
            !no_session.is_selectable(),
            "a codex worker with no known thread id has nothing to queue against"
        );

        let selectable = CodexQueueBackend {
            target: target_for_spec(&spec_for("codex", Some("thread-1"))),
        };
        assert!(
            selectable.is_selectable(),
            "control: a codex worker with a known thread id IS selectable, so the two \
             refusals above are about the guard and not about the fixture"
        );
    }

    /// An unselectable backend must refuse BEFORE any write, so the seam falls
    /// back to the PTY instead of failing the message (rule 1).
    #[tokio::test]
    async fn an_unselectable_codex_backend_refuses_before_any_write() {
        let mut backend = CodexQueueBackend {
            target: target_for_spec(&spec_for("claude", Some("thread-1"))),
        };
        assert!(matches!(
            backend.transport_status(),
            TransportStatus::Unavailable(_)
        ));

        let error = backend
            .send(&SendRequest::new("del_unselectable", "hello"))
            .await
            .expect_err("an unselectable route cannot accept a send");
        assert!(
            error.is_pre_write(),
            "refusing for lack of a target is strictly pre-write, got {error:?}"
        );
    }

    #[test]
    fn queue_global_args_keep_only_codex_global_options() {
        let args = vec![
            "--profile".to_string(),
            "work".to_string(),
            "--config=model=\"gpt-5\"".to_string(),
            "resume".to_string(),
            "thread-1".to_string(),
        ];
        assert_eq!(
            codex_queue_global_args(&args),
            vec![
                "--profile".to_string(),
                "work".to_string(),
                "--config=model=\"gpt-5\"".to_string(),
            ]
        );
    }

    #[test]
    fn headless_codex_config_supplies_session_metadata_to_queue_route() {
        let spec: AgentSpec = serde_json::from_value(serde_json::json!({
            "name": "codex-attached",
            "runtime": "headless",
            "cli": "codex",
            "args": [],
            "channels": [],
            "harnessConfig": {
                "runtime": "headless",
                "driver": "app_server",
                "protocol": "codex",
                "endpoint": "stdio://codex-app-server/12345",
                "sessionId": "thread-123",
                "host": {"ownership": "attached", "pid": 12345},
                "release": "detach",
                "metadata": {
                    "rollout_path": "/tmp/codex-rollout.jsonl",
                    "codex_home": "/tmp/codex-home"
                }
            }
        }))
        .expect("agent spec");

        let parts = codex_command_parts(&spec).expect("codex command parts");

        assert_eq!(parts.command, "codex");
        assert_eq!(
            parts.metadata.and_then(metadata_rollout_path),
            Some(PathBuf::from("/tmp/codex-rollout.jsonl"))
        );
        assert_eq!(
            codex_queue_env(parts.metadata, parts.env),
            vec![("CODEX_HOME".to_string(), "/tmp/codex-home".to_string())]
        );
    }

    #[test]
    fn native_handle_can_name_a_separate_codex_queue_command() {
        let spec: AgentSpec = serde_json::from_value(serde_json::json!({
            "name": "codex-attached",
            "runtime": "headless",
            "cli": "codex",
            "args": [],
            "channels": [],
            "harnessConfig": {
                "runtime": "native",
                "command": "node",
                "args": ["synthetic-native-codex-sidecar"],
                "sessionId": "thread-123",
                "metadata": {
                    "codex_queue_command": "/opt/homebrew/bin/codex",
                    "codex_home": "/tmp/codex-home"
                }
            }
        }))
        .expect("agent spec");

        let parts = codex_command_parts(&spec).expect("codex command parts");
        let metadata = parts.metadata;
        let env = parts.env;
        let (command, args) = metadata
            .and_then(metadata_codex_queue_command)
            .unwrap_or((parts.command, parts.cli_args));

        assert_eq!(command, "/opt/homebrew/bin/codex");
        assert!(args.is_empty());
        assert_eq!(
            codex_queue_env(metadata, env),
            vec![("CODEX_HOME".to_string(), "/tmp/codex-home".to_string())]
        );
    }
}
