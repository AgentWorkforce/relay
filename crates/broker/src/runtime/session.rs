use super::*;

/// Shared Relaycast connection state used by run_init and run_wrap.
#[derive(Clone)]
pub(crate) struct RelayWorkspace {
    pub(crate) workspace_id: WorkspaceId,
    pub(crate) workspace_alias: Option<WorkspaceAlias>,
    pub(crate) relay_workspace_key: String,
    pub(crate) self_name: String,
    pub(crate) self_agent_id: AgentId,
    pub(crate) self_names: HashSet<String>,
    pub(crate) self_agent_ids: HashSet<AgentId>,
    pub(crate) http_client: RelaycastHttpClient,
    pub(crate) ws_control_tx: mpsc::Sender<WsControl>,
}

pub(crate) struct RelaySession {
    pub(crate) configured_base: Option<String>,
    pub(crate) default_workspace_id: Option<WorkspaceId>,
    pub(crate) workspaces: Vec<RelayWorkspace>,
    pub(crate) ws_inbound_rx: mpsc::Receiver<WorkspaceInboundMessage>,
}

#[derive(Clone)]
pub(crate) struct RelayReadyState {
    pub(super) workspace_key: String,
    pub(super) memberships: Vec<WorkspaceMembershipSummary>,
    pub(super) default_workspace_id: Option<WorkspaceId>,
}

pub(crate) async fn serve_startup_api_until_ready(
    listener: tokio::net::TcpListener,
    relay_ready: Arc<Notify>,
) -> tokio::net::TcpListener {
    loop {
        tokio::select! {
            _ = relay_ready.notified() => {
                return listener;
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _addr)) => {
                        tokio::spawn(handle_startup_api_connection(stream));
                    }
                    Err(error) => {
                        tracing::warn!(error = %error, "startup API accept failed");
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }
        }
    }
}

pub(crate) async fn handle_startup_api_connection(mut stream: tokio::net::TcpStream) {
    let mut buffer = [0_u8; 1024];
    let read = match timeout(Duration::from_secs(5), stream.read(&mut buffer)).await {
        Ok(Ok(read)) => read,
        Ok(Err(error)) => {
            tracing::debug!(error = %error, "failed reading startup API request");
            return;
        }
        Err(_) => return,
    };

    let request = String::from_utf8_lossy(&buffer[..read]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    let (status, content_type, body) = if path == "/health" {
        (
            "200 OK",
            "application/json",
            listen_api::listen_api_health_payload(None, vec![]).to_string(),
        )
    } else {
        (
            "503 Service Unavailable",
            "text/plain; charset=utf-8",
            "Broker is starting, please retry".to_string(),
        )
    };
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    if let Err(error) = stream.write_all(response.as_bytes()).await {
        tracing::debug!(error = %error, "failed writing startup API response");
    }
}

/// Build the standard env-var array passed to every spawned child agent.
pub(crate) fn normalize_initial_task(task: Option<String>) -> Option<String> {
    task.filter(|value| !value.trim().is_empty())
}

const EXIT_AFTER_TASK_INSTRUCTION: &str = "## Post-task exit\n\
When the requested task is fully complete and you have reported the final outcome, output `/exit` on its own line so the Agent Relay harness exits cleanly. Do not output `/exit` before the task is complete.";

pub(crate) fn apply_exit_after_task_instruction(task: Option<String>) -> String {
    match normalize_initial_task(task) {
        Some(task) => format!("{task}\n\n{EXIT_AFTER_TASK_INSTRUCTION}"),
        None => EXIT_AFTER_TASK_INSTRUCTION.to_string(),
    }
}

/// Resolve a spawn request's effective `exit_after_task` lifecycle flag from its
/// `spawn_mode` selector and any explicit `exit_after_task` boolean.
///
/// Shared by the local HTTP spawn API and the engine-dispatched node spawn so
/// task-exit semantics are identical on both paths: a `spawn_mode` of
/// `task_exit`/`single_shot` — or an explicit `exit_after_task: true` — makes
/// the agent exit once its task is done; `interactive`/absent keeps it running.
/// An unrecognized `spawn_mode` is rejected with a caller-facing message.
pub(crate) fn resolve_exit_after_task(
    spawn_mode: Option<&str>,
    exit_after_task: Option<bool>,
) -> Result<bool, String> {
    let normalized = spawn_mode.map(|value| value.trim().to_ascii_lowercase());
    let spawn_mode_exit_after_task = match normalized.as_deref() {
        None | Some("") | Some("interactive") => false,
        Some("task_exit" | "task-exit" | "single_shot" | "single-shot") => true,
        Some(other) => {
            return Err(format!(
                "unsupported spawnMode '{other}' (expected 'interactive' or 'task_exit')"
            ));
        }
    };
    Ok(exit_after_task.unwrap_or(false) || spawn_mode_exit_after_task)
}

pub(crate) struct RelaySessionOptions<'a> {
    pub(crate) paths: &'a RuntimePaths,
    pub(crate) requested_name: &'a str,
    pub(crate) channels: Vec<String>,
    pub(crate) strict_name: bool,
    pub(crate) agent_type: Option<&'a str>,
    /// Read .mcp.json for additional self-name identities
    pub(crate) read_mcp_identity: bool,
    pub(crate) runtime_cwd: &'a Path,
}

/// Default per-attempt timeout for the initial Relaycast handshake
/// (`startup_session_set_with_options`). The underlying SDK bootstrap calls
/// (`create_workspace` / agent registration) build a timeout-less reqwest
/// client, so a stalled connection to the relay backend would otherwise hang
/// startup indefinitely — long enough for an external supervisor (the CLI's
/// `down --force`, a test watchdog) to reap the broker, which surfaces to the
/// SDK as an opaque "broker exited with code null during initial handshake".
/// Bounding each attempt turns that hang into a retryable error. Production
/// workspace creation has returned successfully in 7.4-9.5s, so the default
/// leaves headroom above that measured latency instead of abandoning a request
/// the backend is about to answer.
const HANDSHAKE_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(12);
/// Default number of handshake attempts (initial try + retries) before giving
/// up. Three 12s attempts plus the default 250ms and 500ms backoffs take at
/// most 36.75s, inside the harness SDK's 45s startup budget, so a transient
/// blip can still recover in-process without moving the timeout into the SDK.
const HANDSHAKE_MAX_ATTEMPTS: u32 = 3;
/// Base backoff between handshake attempts; doubles each retry, capped.
const HANDSHAKE_BACKOFF_BASE: Duration = Duration::from_millis(250);
const HANDSHAKE_BACKOFF_MAX: Duration = Duration::from_secs(2);
/// Aggregate ceiling for every handshake attempt and backoff. The harness SDK
/// starts its 45s polling deadline when the broker announces its bound API port,
/// before connection-file and startup-listener setup reaches `connect_relay`.
/// Reserving five seconds for that post-announcement work lets the broker surface
/// the specific handshake error first. This also bounds membership-scaled
/// deadlines and oversized environment overrides.
const HANDSHAKE_TOTAL_TIMEOUT: Duration = Duration::from_secs(40);
#[cfg(test)]
const HANDSHAKE_POST_ANNOUNCEMENT_RESERVE: Duration = Duration::from_secs(5);

/// Per-attempt handshake timeout, overridable via
/// `AGENT_RELAY_HANDSHAKE_TIMEOUT_MS` (must be > 0).
fn handshake_attempt_timeout() -> Duration {
    parse_handshake_timeout(
        std::env::var("AGENT_RELAY_HANDSHAKE_TIMEOUT_MS")
            .ok()
            .as_deref(),
    )
}

/// Max handshake attempts, overridable via `AGENT_RELAY_HANDSHAKE_ATTEMPTS`
/// (must be >= 1).
fn handshake_max_attempts() -> u32 {
    parse_handshake_attempts(
        std::env::var("AGENT_RELAY_HANDSHAKE_ATTEMPTS")
            .ok()
            .as_deref(),
    )
}

/// Number of workspaces the broker will register during the handshake, used to
/// scale the per-attempt deadline: `startup_session_set_with_options` registers
/// each `RELAY_WORKSPACES_JSON` membership serially, so a healthy multi-workspace
/// startup legitimately takes longer than a single-workspace one and must not be
/// cut off by the single-request timeout. Falls back to 1 when unset/unparseable.
fn configured_membership_count() -> u32 {
    parse_membership_count(std::env::var("RELAY_WORKSPACES_JSON").ok().as_deref())
}

/// Parse the per-attempt timeout from an optional raw string (e.g. an env var),
/// falling back to [`HANDSHAKE_ATTEMPT_TIMEOUT`] for missing/empty/invalid/zero
/// values. Pure so it can be unit-tested without mutating process env.
fn parse_handshake_timeout(raw: Option<&str>) -> Duration {
    raw.and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|&ms| ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(HANDSHAKE_ATTEMPT_TIMEOUT)
}

/// Parse the max attempt count from an optional raw string (e.g. an env var),
/// falling back to [`HANDSHAKE_MAX_ATTEMPTS`] for missing/empty/invalid/zero
/// values. Pure so it can be unit-tested without mutating process env.
fn parse_handshake_attempts(raw: Option<&str>) -> u32 {
    raw.and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|&attempts| attempts >= 1)
        .unwrap_or(HANDSHAKE_MAX_ATTEMPTS)
}

/// Cap the next attempt to the aggregate handshake time that remains. Returning
/// `None` means the broker has no time left to start another request.
fn handshake_attempt_timeout_within_budget(
    attempt_timeout: Duration,
    elapsed: Duration,
) -> Option<Duration> {
    let remaining = HANDSHAKE_TOTAL_TIMEOUT.saturating_sub(elapsed);
    (!remaining.is_zero()).then_some(attempt_timeout.min(remaining))
}

fn handshake_retry_fits_within_budget(elapsed: Duration, backoff: Duration) -> bool {
    HANDSHAKE_TOTAL_TIMEOUT.saturating_sub(elapsed) > backoff
}

fn format_handshake_timeout_error(
    attempts: u32,
    attempt_timeout: Duration,
    elapsed: Duration,
) -> String {
    format!(
        "relaycast startup handshake received no response before its deadlines after {attempts} \
         attempt(s) (up to {}ms per attempt, {}ms total elapsed; {}ms aggregate limit); \
         registration was not confirmed and may still have completed server-side after the client \
         stopped waiting",
        attempt_timeout.as_millis(),
        elapsed.as_millis(),
        HANDSHAKE_TOTAL_TIMEOUT.as_millis()
    )
}

/// Parse the number of configured memberships from an optional
/// `RELAY_WORKSPACES_JSON` string, mirroring how `load_workspace_sources_from_env`
/// (in `relaycast/auth.rs`) interprets the same value: a top-level JSON array, an
/// object with a `memberships` array, or a bare single-membership object (count
/// 1). The result is clamped to at least 1; anything absent/empty/unparseable
/// also yields 1. Pure so it can be unit-tested without mutating process env.
fn parse_membership_count(raw: Option<&str>) -> u32 {
    let count = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
        .map(|value| {
            if let Some(entries) = value.as_array() {
                entries.len()
            } else if let Some(entries) = value
                .get("memberships")
                .and_then(serde_json::Value::as_array)
            {
                entries.len()
            } else {
                // A bare object is treated as a single membership, matching
                // `load_workspace_sources_from_env`'s `vec![value]` fallback.
                1
            }
        })
        .and_then(|len| u32::try_from(len).ok())
        .unwrap_or(1);
    count.max(1)
}

pub(crate) async fn connect_relay(opts: RelaySessionOptions<'_>) -> Result<RelaySession> {
    let startup_debug = startup_debug_enabled();
    let connect_started = Instant::now();
    let configured_base: Option<String> = std::env::var("RELAYCAST_BASE_URL")
        .ok()
        .or_else(|| std::env::var("RELAY_BASE_URL").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // WS override (rare); else the SDK derives wss from the base.
    let configured_ws: Option<String> = std::env::var("RELAYCAST_WS_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| configured_base.clone());

    log_startup_phase(
        startup_debug,
        connect_started,
        format!(
            "connect_relay begin requested_name='{}' channels={}",
            opts.requested_name,
            opts.channels.join(",")
        ),
    );
    let auth = AuthClient::new(configured_base.clone());
    // Bound the handshake so a hung relay connection can't stall startup. The
    // SDK bootstrap calls (`create_workspace` / agent registration) build a
    // timeout-less reqwest client, so without this a stalled backend hangs
    // startup indefinitely until an external supervisor reaps the broker
    // (reported to the SDK as an opaque code-null exit). We ONLY retry on
    // timeout: a returned error is a definite server response, and replaying
    // `startup_session_set_with_options` would re-run workspace creation and
    // agent registration from scratch — risking duplicate Relaycast resources —
    // so returned errors surface immediately (preserving the pre-retry
    // behavior). The residual for a timeout retry is narrow (the backend both
    // completed the request AND failed to answer within the deadline); the
    // per-attempt deadline is scaled by the configured workspace count so a
    // healthy multi-workspace startup, which registers each membership serially,
    // is not cut off mid-flight. The final attempt is shortened to whatever
    // remains of HANDSHAKE_TOTAL_TIMEOUT so membership scaling and environment
    // overrides cannot move exhaustion past the SDK startup deadline.
    let membership_count = configured_membership_count();
    let attempt_timeout = handshake_attempt_timeout().saturating_mul(membership_count);
    let max_attempts = handshake_max_attempts();
    let mut backoff = HANDSHAKE_BACKOFF_BASE;
    let handshake_started = Instant::now();
    // Prove this is the SAME node restarting, not a different one squatting
    // the name: honor an explicit override, else fall back to a value stable
    // across restarts of this node's own persisted state directory. Without
    // this, a node killed and restarted before its stale registration is
    // reaped would collide on its own name and be fail-closed rejected —
    // the spawn-admission gate can't tell "myself, restarting" from "a
    // stranger" unless something proves it.
    let derived_identity_key =
        agent_identity_key().unwrap_or_else(|| stable_node_identity_key(&opts.paths.state));
    let sessions = {
        let mut attempt: u32 = 0;
        loop {
            let Some(current_attempt_timeout) = handshake_attempt_timeout_within_budget(
                attempt_timeout,
                handshake_started.elapsed(),
            ) else {
                anyhow::bail!(format_handshake_timeout_error(
                    attempt,
                    attempt_timeout,
                    handshake_started.elapsed()
                ));
            };
            attempt += 1;
            match timeout(
                current_attempt_timeout,
                auth.startup_session_set_with_identity(
                    Some(opts.requested_name),
                    opts.strict_name,
                    opts.agent_type,
                    Some(derived_identity_key.as_str()),
                ),
            )
            .await
            {
                // Success, or a definite failure from the backend: return
                // immediately in both cases (never replay a returned error).
                Ok(result) => {
                    break result.context("failed to initialize relaycast session")?;
                }
                Err(_elapsed) => {
                    let handshake_elapsed = handshake_started.elapsed();
                    if attempt >= max_attempts
                        || !handshake_retry_fits_within_budget(handshake_elapsed, backoff)
                    {
                        anyhow::bail!(format_handshake_timeout_error(
                            attempt,
                            attempt_timeout,
                            handshake_elapsed
                        ));
                    }
                    tracing::warn!(
                        attempt,
                        max_attempts,
                        timeout_ms = current_attempt_timeout.as_millis() as u64,
                        "relaycast startup handshake received no response before deadline; retrying"
                    );
                    log_startup_phase(
                        startup_debug,
                        connect_started,
                        format!(
                            "handshake attempt {attempt}/{max_attempts} received no response within {}ms; retrying in {}ms",
                            current_attempt_timeout.as_millis(),
                            backoff.as_millis()
                        ),
                    );
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(HANDSHAKE_BACKOFF_MAX);
                }
            }
        }
    };
    log_startup_phase(
        startup_debug,
        connect_started,
        format!(
            "startup_session_set_with_options complete memberships={}",
            sessions.memberships.len()
        ),
    );

    let default_session = sessions
        .default_session()
        .or_else(|| sessions.memberships.first())
        .context("no relaycast memberships were initialized")?;
    let self_agent_id = default_session.credentials.agent_id.clone();
    let agent_name = default_session
        .credentials
        .agent_name
        .clone()
        .unwrap_or_else(|| opts.requested_name.to_string());

    let identity_debug = format!(
        "agent_name='{}'
requested='{}'
agent_id='{}'
default_workspace='{}'
workspace_count='{}'
timestamp='{}'
",
        agent_name,
        opts.requested_name,
        self_agent_id,
        default_session.credentials.workspace_id,
        sessions.memberships.len(),
        chrono::Utc::now().to_rfc3339()
    );
    let debug_path = opts
        .paths
        .state
        .parent()
        .unwrap()
        .join("identity-debug.txt");
    if std::env::var("AGENT_RELAY_NO_DEBUG_FILES").is_err() {
        let _ = std::fs::write(&debug_path, &identity_debug);
        eprintln!(
            "[agent-relay] identity debug written to {}",
            debug_path.display()
        );
    }
    if agent_name != opts.requested_name {
        eprintln!(
            "[agent-relay] WARNING: registered as '{}' (requested '{}')",
            agent_name, opts.requested_name
        );
    }

    log_startup_phase(
        startup_debug,
        connect_started,
        "MultiWorkspaceSession::new begin",
    );
    let mut multi = MultiWorkspaceSession::new(
        configured_base.clone(),
        configured_ws,
        auth,
        sessions,
        opts.channels,
        opts.read_mcp_identity,
        opts.runtime_cwd,
        crate::events::EventEmitter::new(false),
    );
    log_startup_phase(
        startup_debug,
        connect_started,
        format!(
            "MultiWorkspaceSession::new complete handles={} default_workspace={:?}",
            multi.handles.len(),
            multi.default_workspace_id
        ),
    );

    let default_workspace_id = multi.default_workspace_id.clone();
    let workspaces = multi
        .handles
        .drain(..)
        .map(|handle| RelayWorkspace {
            workspace_id: handle.workspace_id,
            workspace_alias: handle.workspace_alias,
            relay_workspace_key: handle.relay_workspace_key,
            self_name: handle.self_name,
            self_agent_id: handle.self_agent_id,
            self_names: handle.self_names,
            self_agent_ids: handle.self_agent_ids,
            http_client: handle.http_client,
            ws_control_tx: handle.ws_control_tx,
        })
        .collect();

    Ok(RelaySession {
        configured_base,
        default_workspace_id,
        workspaces,
        ws_inbound_rx: multi.inbound_rx,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // These exercise the pure parse helpers directly rather than mutating
    // process-global env (`std::env::set_var`/`remove_var` are unsound under the
    // parallel test runner: other threads may be reading the environment
    // concurrently).

    #[test]
    fn parse_handshake_attempts_defaults_and_overrides() {
        assert_eq!(parse_handshake_attempts(None), HANDSHAKE_MAX_ATTEMPTS);
        assert_eq!(parse_handshake_attempts(Some("")), HANDSHAKE_MAX_ATTEMPTS);
        assert_eq!(
            parse_handshake_attempts(Some("0")),
            HANDSHAKE_MAX_ATTEMPTS,
            "zero attempts is rejected in favor of the default"
        );
        assert_eq!(
            parse_handshake_attempts(Some("not-a-number")),
            HANDSHAKE_MAX_ATTEMPTS
        );
        assert_eq!(parse_handshake_attempts(Some(" 7 ")), 7);
    }

    #[test]
    fn parse_handshake_timeout_defaults_and_overrides() {
        assert_eq!(parse_handshake_timeout(None), HANDSHAKE_ATTEMPT_TIMEOUT);
        assert_eq!(parse_handshake_timeout(Some("")), HANDSHAKE_ATTEMPT_TIMEOUT);
        assert_eq!(
            parse_handshake_timeout(Some("0")),
            HANDSHAKE_ATTEMPT_TIMEOUT,
            "zero ms is rejected in favor of the default"
        );
        assert_eq!(
            parse_handshake_timeout(Some("nope")),
            HANDSHAKE_ATTEMPT_TIMEOUT
        );
        assert_eq!(
            parse_handshake_timeout(Some("1234")),
            Duration::from_millis(1234)
        );
    }

    #[test]
    fn default_handshake_budget_accepts_measured_latency_and_stays_inside_sdk_deadline() {
        // Production returned successful workspace creates in as much as 9.5s.
        // A default below that latency abandons a request the backend is about
        // to answer, so the first attempt must still be alive at that point.
        let attempt_timeout = parse_handshake_timeout(None);
        let measured_success_latency = Duration::from_millis(9_500);
        assert!(
            measured_success_latency < attempt_timeout,
            "a backend responding successfully in 9.5s must beat the default per-attempt deadline"
        );

        // packages/harness-driver/src/spawn-config.ts defaults
        // startupTimeoutMs to 45_000, and client.ts uses that as the post-bind
        // handshake polling budget. Include every retry backoff so a backend
        // that never responds still fails before the SDK gives up.
        let max_attempts = parse_handshake_attempts(None);
        let mut never_responds_budget = attempt_timeout.saturating_mul(max_attempts);
        let mut backoff = HANDSHAKE_BACKOFF_BASE;
        for _ in 1..max_attempts {
            never_responds_budget = never_responds_budget.saturating_add(backoff);
            backoff = (backoff * 2).min(HANDSHAKE_BACKOFF_MAX);
        }
        let sdk_startup_budget = Duration::from_secs(45);
        assert!(never_responds_budget < HANDSHAKE_TOTAL_TIMEOUT);
        assert!(
            never_responds_budget < sdk_startup_budget,
            "a backend that never responds must exhaust the default handshake budget before the SDK's 45s deadline"
        );
    }

    #[test]
    fn multi_membership_default_budget_stays_inside_sdk_deadline() {
        let membership_count = 2;
        let attempt_timeout = parse_handshake_timeout(None).saturating_mul(membership_count);
        let max_attempts = parse_handshake_attempts(None);
        let mut never_responds_budget = Duration::ZERO;
        let mut backoff = HANDSHAKE_BACKOFF_BASE;
        let mut attempt_deadlines = Vec::new();
        for attempt in 0..max_attempts {
            let Some(current_attempt_timeout) =
                handshake_attempt_timeout_within_budget(attempt_timeout, never_responds_budget)
            else {
                break;
            };
            attempt_deadlines.push(current_attempt_timeout);
            never_responds_budget = never_responds_budget.saturating_add(current_attempt_timeout);
            if attempt + 1 >= max_attempts
                || !handshake_retry_fits_within_budget(never_responds_budget, backoff)
            {
                break;
            }
            never_responds_budget = never_responds_budget.saturating_add(backoff);
            backoff = (backoff * 2).min(HANDSHAKE_BACKOFF_MAX);
        }

        assert_eq!(
            attempt_deadlines,
            vec![Duration::from_secs(24), Duration::from_millis(15_750)],
            "the second attempt uses the aggregate budget remaining after the first timeout and backoff"
        );
        assert_eq!(never_responds_budget, HANDSHAKE_TOTAL_TIMEOUT);
        assert!(
            never_responds_budget < Duration::from_secs(45),
            "membership-scaled retries must still exhaust before the SDK deadline"
        );
    }

    #[test]
    fn aggregate_budget_reserves_post_announcement_setup_time() {
        // The SDK starts its 45s polling deadline as soon as the broker prints
        // the bound API port. A small amount of connection-file and startup API
        // setup happens before connect_relay starts its own clock, so the
        // handshake cannot consume all but one second of the outer deadline.
        let sdk_startup_budget = Duration::from_secs(45);
        assert!(
            HANDSHAKE_TOTAL_TIMEOUT
                <= sdk_startup_budget.saturating_sub(HANDSHAKE_POST_ANNOUNCEMENT_RESERVE),
            "the aggregate handshake limit must leave explicit time for setup after API announcement"
        );
    }

    #[test]
    fn handshake_timeout_diagnostic_reports_an_unconfirmed_response() {
        let message = format_handshake_timeout_error(
            3,
            Duration::from_secs(12),
            Duration::from_millis(36_750),
        );
        assert!(message.contains("received no response before its deadlines"));
        assert!(message.contains("40000ms aggregate limit"));
        assert!(message.contains("may still have completed server-side"));
        assert!(
            !message.contains("was unreachable"),
            "deadline exhaustion cannot prove that the backend was unreachable"
        );
    }

    #[test]
    fn parse_membership_count_scales_with_configured_workspaces() {
        // Absent / empty / empty-array / unparseable all fall back to a single
        // workspace so the timeout is never scaled below the base.
        assert_eq!(parse_membership_count(None), 1);
        assert_eq!(parse_membership_count(Some("   ")), 1);
        assert_eq!(parse_membership_count(Some("[]")), 1);
        assert_eq!(parse_membership_count(Some("not json")), 1);
        // A bare single-membership object counts as one (matching
        // load_workspace_sources_from_env's `vec![value]` fallback).
        assert_eq!(parse_membership_count(Some("{\"api_key\":\"rk_a\"}")), 1);
        // Top-level array form scales by its length.
        assert_eq!(
            parse_membership_count(Some(
                "[{\"api_key\":\"rk_a\"},{\"api_key\":\"rk_b\"},{\"api_key\":\"rk_c\"}]"
            )),
            3
        );
        // Object-with-`memberships`-array form also scales by array length.
        assert_eq!(
            parse_membership_count(Some(
                "{\"memberships\":[{\"api_key\":\"rk_a\"},{\"api_key\":\"rk_b\"}],\"default_workspace_id\":\"ws_a\"}"
            )),
            2
        );
        // An empty `memberships` array clamps to the single-workspace minimum.
        assert_eq!(parse_membership_count(Some("{\"memberships\":[]}")), 1);
    }
}
