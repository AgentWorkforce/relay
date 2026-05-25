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
    pub(crate) http_base: String,
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
    task.and_then(|value| {
        if value.trim().is_empty() {
            None
        } else {
            Some(value)
        }
    })
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

pub(crate) async fn connect_relay(opts: RelaySessionOptions<'_>) -> Result<RelaySession> {
    let startup_debug = startup_debug_enabled();
    let connect_started = Instant::now();
    let http_base = std::env::var("RELAYCAST_BASE_URL")
        .ok()
        .or_else(|| std::env::var("RELAY_BASE_URL").ok())
        .unwrap_or_else(|| DEFAULT_RELAYCAST_BASE_URL.to_string());
    let ws_base = std::env::var("RELAYCAST_WS_URL")
        .unwrap_or_else(|_| derive_ws_base_url_from_http(&http_base));

    log_startup_phase(
        startup_debug,
        connect_started,
        format!(
            "connect_relay begin requested_name='{}' channels={}",
            opts.requested_name,
            opts.channels.join(",")
        ),
    );
    let auth = AuthClient::new(http_base.clone());
    let sessions = auth
        .startup_session_set_with_options(
            Some(opts.requested_name),
            opts.strict_name,
            opts.agent_type,
        )
        .await
        .context("failed to initialize relaycast session")?;
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
        http_base.clone(),
        ws_base,
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
        http_base,
        default_workspace_id,
        workspaces,
        ws_inbound_rx: multi.inbound_rx,
    })
}
