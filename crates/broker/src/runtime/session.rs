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
/// Bounding each attempt turns that hang into a fast, retryable error.
const HANDSHAKE_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(5);
/// Default number of handshake attempts (initial try + retries) before giving
/// up. Kept well within the SDK's 45s startup budget at the default timeout so
/// a transient blip recovers in-process instead of failing startup.
const HANDSHAKE_MAX_ATTEMPTS: u32 = 4;
/// Base backoff between handshake attempts; doubles each retry, capped.
const HANDSHAKE_BACKOFF_BASE: Duration = Duration::from_millis(250);
const HANDSHAKE_BACKOFF_MAX: Duration = Duration::from_secs(2);

/// Per-attempt handshake timeout, overridable via
/// `AGENT_RELAY_HANDSHAKE_TIMEOUT_MS` (must be > 0).
fn handshake_attempt_timeout() -> Duration {
    env_positive_u64("AGENT_RELAY_HANDSHAKE_TIMEOUT_MS")
        .map(Duration::from_millis)
        .unwrap_or(HANDSHAKE_ATTEMPT_TIMEOUT)
}

/// Max handshake attempts, overridable via `AGENT_RELAY_HANDSHAKE_ATTEMPTS`
/// (must be >= 1).
fn handshake_max_attempts() -> u32 {
    std::env::var("AGENT_RELAY_HANDSHAKE_ATTEMPTS")
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|&attempts| attempts >= 1)
        .unwrap_or(HANDSHAKE_MAX_ATTEMPTS)
}

/// Parse a strictly-positive `u64` from an environment variable, ignoring
/// empty/invalid/zero values so callers fall back to their default.
fn env_positive_u64(name: &str) -> Option<u64> {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|&value| value > 0)
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
    // Bound each handshake attempt and retry transient failures/timeouts with
    // backoff. The SDK bootstrap calls have no client-side timeout, so without
    // this a stalled relay backend hangs startup until an external supervisor
    // kills the broker (reported to the SDK as an opaque code-null exit). A
    // per-attempt deadline converts that into a retryable error that usually
    // recovers on the next attempt, all within the SDK's startup budget.
    let attempt_timeout = handshake_attempt_timeout();
    let max_attempts = handshake_max_attempts();
    let mut backoff = HANDSHAKE_BACKOFF_BASE;
    let sessions = {
        let mut attempt: u32 = 0;
        loop {
            attempt += 1;
            match timeout(
                attempt_timeout,
                auth.startup_session_set_with_options(
                    Some(opts.requested_name),
                    opts.strict_name,
                    opts.agent_type,
                ),
            )
            .await
            {
                Ok(Ok(sessions)) => break sessions,
                Ok(Err(error)) => {
                    if attempt >= max_attempts {
                        return Err(error).context(format!(
                            "failed to initialize relaycast session after {attempt} attempt(s)"
                        ));
                    }
                    tracing::warn!(
                        attempt,
                        max_attempts,
                        error = %error,
                        "relaycast startup handshake failed; retrying"
                    );
                    log_startup_phase(
                        startup_debug,
                        connect_started,
                        format!(
                            "handshake attempt {attempt}/{max_attempts} failed ({error}); retrying in {}ms",
                            backoff.as_millis()
                        ),
                    );
                }
                Err(_elapsed) => {
                    if attempt >= max_attempts {
                        anyhow::bail!(
                            "relaycast startup handshake timed out after {attempt} attempt(s) of {}ms each; \
                             the relay backend was unreachable or too slow to complete registration",
                            attempt_timeout.as_millis()
                        );
                    }
                    tracing::warn!(
                        attempt,
                        max_attempts,
                        timeout_ms = attempt_timeout.as_millis() as u64,
                        "relaycast startup handshake timed out; retrying"
                    );
                    log_startup_phase(
                        startup_debug,
                        connect_started,
                        format!(
                            "handshake attempt {attempt}/{max_attempts} timed out after {}ms; retrying in {}ms",
                            attempt_timeout.as_millis(),
                            backoff.as_millis()
                        ),
                    );
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(HANDSHAKE_BACKOFF_MAX);
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

    // Note: these two tests read/write distinct process-global env vars, so they
    // do not race each other. Keep all assertions for a given var within one
    // test to avoid cross-test interference under the parallel test runner.

    #[test]
    fn handshake_max_attempts_honors_env_override() {
        std::env::remove_var("AGENT_RELAY_HANDSHAKE_ATTEMPTS");
        assert_eq!(handshake_max_attempts(), HANDSHAKE_MAX_ATTEMPTS);

        std::env::set_var("AGENT_RELAY_HANDSHAKE_ATTEMPTS", "0");
        assert_eq!(
            handshake_max_attempts(),
            HANDSHAKE_MAX_ATTEMPTS,
            "zero attempts is rejected in favor of the default"
        );

        std::env::set_var("AGENT_RELAY_HANDSHAKE_ATTEMPTS", "not-a-number");
        assert_eq!(handshake_max_attempts(), HANDSHAKE_MAX_ATTEMPTS);

        std::env::set_var("AGENT_RELAY_HANDSHAKE_ATTEMPTS", "7");
        assert_eq!(handshake_max_attempts(), 7);

        std::env::remove_var("AGENT_RELAY_HANDSHAKE_ATTEMPTS");
    }

    #[test]
    fn handshake_attempt_timeout_honors_env_override() {
        std::env::remove_var("AGENT_RELAY_HANDSHAKE_TIMEOUT_MS");
        assert_eq!(handshake_attempt_timeout(), HANDSHAKE_ATTEMPT_TIMEOUT);

        std::env::set_var("AGENT_RELAY_HANDSHAKE_TIMEOUT_MS", "0");
        assert_eq!(
            handshake_attempt_timeout(),
            HANDSHAKE_ATTEMPT_TIMEOUT,
            "zero ms is rejected in favor of the default"
        );

        std::env::set_var("AGENT_RELAY_HANDSHAKE_TIMEOUT_MS", "1234");
        assert_eq!(handshake_attempt_timeout(), Duration::from_millis(1234));

        std::env::remove_var("AGENT_RELAY_HANDSHAKE_TIMEOUT_MS");
    }
}
