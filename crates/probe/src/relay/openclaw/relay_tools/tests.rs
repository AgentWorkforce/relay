use super::cli::{await_login, from_dirs, from_gateway, LoginLines, Step};
use super::*;
use crate::relay::process::{FakeProcess, FakeProcesses};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const SITE: &str = "https://agentrelay.com";
const URL: &str = "https://agentrelay.com/cloud/api/v1/mcp/shared-sessions";
const CONSENT: &str = "https://agentrelay.com/oauth/authorize?client_id=c&state=0123456789abcdef";

/// A fake `openclaw` that logs each call and answers from files beside it:
/// `status.json` (+ `status.exit`), `login.help`, `login.out`, `login.err`,
/// `login.sleep`, `login.after`, `login.exit`, `add.err` (+ `add.exit`)
/// and `configure.exit`.
const FAKE: &str = r#"#!/bin/sh
dir=$(dirname "$0")
echo "$* | $OPENCLAW_CONFIG_PATH" >> "$dir/calls.log"
if [ "$1 $2 $3" = "mcp login --help" ]; then
  if [ -f "$dir/login.help" ]; then cat "$dir/login.help"
  else echo "  --code <code>  Authorization code from the OAuth redirect"; fi
  exit 0
fi
case "$1 $2" in
  "mcp status")
    sleep $(cat "$dir/status.sleep" 2>/dev/null || echo 0)
    cat "$dir/status.json" 2>/dev/null
    exit $(cat "$dir/status.exit" 2>/dev/null || echo 0) ;;
  "mcp add")
    cat "$dir/add.err" >&2 2>/dev/null
    exit $(cat "$dir/add.exit" 2>/dev/null || echo 0) ;;
  "mcp configure") exit $(cat "$dir/configure.exit" 2>/dev/null || echo 0) ;;
  "mcp login")
    cat "$dir/login.out" 2>/dev/null
    cat "$dir/login.err" >&2 2>/dev/null
    sleep $(cat "$dir/login.sleep" 2>/dev/null || echo 0) &
    echo $! > "$dir/login.child"
    wait
    cat "$dir/login.after" 2>/dev/null
    exit $(cat "$dir/login.exit" 2>/dev/null || echo 0) ;;
esac
exit 2
"#;

struct Fixture {
    _dir: tempfile::TempDir,
    bin: PathBuf,
    config: OpenClawConfig,
}

impl Fixture {
    fn new(servers: &str) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(
            state.join("openclaw.json"),
            format!("// OpenClaw\n{{ gateway: {{}}, mcp: {{ servers: {servers} }} }}\n"),
        )
        .unwrap();
        let script = bin.join("openclaw");
        std::fs::write(&script, FAKE).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let env = BTreeMap::from([
            (
                "OPENCLAW_STATE_DIR".to_string(),
                state.display().to_string(),
            ),
            (
                "PATH".to_string(),
                std::env::var("PATH").unwrap_or_default(),
            ),
        ]);
        let config = OpenClawConfig::new(&env, dir.path(), &dir.path().join("app"));
        // This core has met a current Gateway (2026.10.4: sessions can be
        // limited); `tests::relay_tools` covers the handshake itself.
        let current = serde_json::json!({"server": {"version": "2026.10.4"}, "protocol": 4});
        config
            .seen
            .record(&crate::relay::openclaw::Features::from_hello(&current));
        Fixture {
            _dir: dir,
            bin,
            config,
        }
    }

    fn file(&self, name: &str, text: &str) {
        std::fs::write(self.bin.join(name), text).unwrap();
    }

    fn tools(&self) -> RelayTools {
        let dirs = vec![self.bin.clone()];
        RelayTools::new(&self.config, move || from_dirs(&dirs))
    }

    /// Every call but the help reads that check `mcp login` exists.
    fn calls(&self) -> Vec<String> {
        std::fs::read_to_string(self.bin.join("calls.log"))
            .unwrap_or_default()
            .lines()
            .filter(|call| !call.starts_with("mcp login --help"))
            .map(str::to_string)
            .collect()
    }

    fn authorized(&self, name: &str) {
        self.file(
            "status.json",
            &format!(
                r#"{{"path":"x","servers":[{{"name":"{name}","launch":"{URL}","auth":"oauth","authStatus":{{"state":"authorized","hasTokens":true,"requiresAuthorization":false}}}}]}}"#
            ),
        );
    }

    fn consent(&self) {
        self.file(
            "login.out",
            &format!("Open this URL to authorize \"agent_relay\":\n{CONSENT}\nWaiting for the browser to return to OpenClaw...\n"),
        );
    }
}

fn wait_for(tools: &RelayTools, state: OpenClawToolsState) -> OpenClawToolsStatus {
    let end = Instant::now() + Duration::from_secs(15);
    loop {
        let status = tools.status(SITE);
        if status.state == state || Instant::now() > end {
            return status;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn the_login_lines_give_the_url_once_it_waits_for_the_browser() {
    let mut read = LoginLines::default();
    assert_eq!(
        read.feed("Open this URL to authorize \"agent_relay\":"),
        Step::More
    );
    assert_eq!(read.feed(CONSENT), Step::More);
    assert_eq!(
        read.feed("Waiting for the browser to return to OpenClaw..."),
        Step::Url(CONSENT.into())
    );
    assert_eq!(
        LoginLines::default().feed("MCP OAuth credentials saved for \"agent_relay\"."),
        Step::Saved
    );
    assert_eq!(
        LoginLines::default()
            .feed("After approval, run openclaw mcp login agent_relay --code <code>."),
        Step::Manual
    );
    assert_eq!(
        LoginLines::default().feed("error: unknown command 'login'"),
        Step::Unsupported
    );
    // A URL before the prompt is not the authorization URL.
    let mut early = LoginLines::default();
    early.feed("https://docs.openclaw.ai");
    assert_eq!(early.url(), None);
}

#[test]
fn a_url_without_the_waiting_line_counts_at_the_deadline() {
    let (send, lines) = std::sync::mpsc::channel();
    send.send("Open this URL to authorize \"x\":".to_string())
        .unwrap();
    send.send(CONSENT.to_string()).unwrap();
    let step = await_login(&lines, Instant::now() + Duration::from_millis(100));
    assert_eq!(step, Some(Step::Url(CONSENT.into())));
    drop(send);
}

#[test]
fn connect_adds_the_server_then_waits_for_the_browser() {
    let fixture = Fixture::new("{ docs: { url: 'https://docs.example/mcp' } }");
    fixture.consent();
    fixture.file("login.sleep", "1");
    fixture.file(
        "login.after",
        "MCP OAuth credentials saved for \"agent_relay\".\n",
    );
    let tools = fixture.tools();
    assert_eq!(tools.status(SITE).state, OpenClawToolsState::NotConnected);
    let connected = tools.connect(SITE).unwrap();
    assert_eq!(connected.state, OpenClawToolsState::Waiting);
    assert_eq!(connected.authorization_url.as_deref(), Some(CONSENT));
    let calls = fixture.calls();
    let config = fixture.config.config_path.display().to_string();
    assert_eq!(
        calls,
        [
            format!("{} | {config}", add_args(URL).join(" ")),
            format!("mcp login agent_relay | {config}"),
        ]
    );
    assert_eq!(
        add_args(URL).join(" "),
        format!(
            "mcp add agent_relay --url {URL} --transport streamable-http --auth oauth --no-probe"
        )
    );
    // Asked again while it waits: the same page, no second login.
    assert_eq!(tools.status(SITE).state, OpenClawToolsState::Waiting);
    assert_eq!(
        tools.connect(SITE).unwrap().authorization_url.as_deref(),
        Some(CONSENT)
    );
    assert_eq!(fixture.calls().len(), 2);
    // OpenClaw saved the server, and once the browser returned, the
    // credentials.
    std::fs::write(
        &fixture.config.config_path,
        format!("{{ mcp: {{ servers: {{ agent_relay: {{ url: '{URL}', auth: 'oauth' }} }} }} }}"),
    )
    .unwrap();
    fixture.authorized("agent_relay");
    let status = wait_for(&tools, OpenClawToolsState::Connected);
    assert_eq!(status.state, OpenClawToolsState::Connected, "{status:?}");
}

#[test]
fn an_authorized_openclaw_connects_at_once() {
    let fixture = Fixture::new(&format!(
        "{{ agent_relay: {{ url: '{URL}', auth: 'oauth' }} }}"
    ));
    fixture.file(
        "login.out",
        "MCP OAuth credentials saved for \"agent_relay\".\n",
    );
    let tools = fixture.tools();
    let connected = tools.connect(SITE).unwrap();
    assert_eq!(connected.state, OpenClawToolsState::Connected);
    assert_eq!(connected.authorization_url, None);
    assert_eq!(tools.status(SITE).state, OpenClawToolsState::Connected);
    assert!(fixture
        .calls()
        .iter()
        .all(|call| !call.starts_with("mcp add")));
}

#[test]
fn a_server_at_the_url_is_reused_whatever_its_name() {
    let fixture = Fixture::new(&format!("{{ relay: {{ url: '{URL}/', auth: 'oauth' }} }}"));
    fixture.consent();
    fixture.file("login.sleep", "5");
    let tools = fixture.tools();
    tools.connect(SITE).unwrap();
    let calls = fixture.calls();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].starts_with("mcp login relay |"), "{calls:?}");
    // Stopping the login stops what the launcher started too (OpenClaw's
    // launcher runs the CLI in a child that holds the callback port).
    let file = fixture.bin.join("login.child");
    let end = Instant::now() + Duration::from_secs(5);
    while !file.exists() && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(20));
    }
    let child = std::fs::read_to_string(&file).unwrap().trim().to_string();
    let pid: i32 = child.parse().unwrap();
    // Alive, and (where /proc exists) not a zombie waiting to be reaped.
    let running = || {
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
            && std::fs::read_to_string(format!("/proc/{child}/stat"))
                .map_or(true, |stat| !stat.contains(") Z "))
    };
    assert!(running());
    tools.stop();
    let end = Instant::now() + Duration::from_secs(5);
    while running() && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!running(), "the launcher's child outlived the login");
}

#[test]
fn an_agent_relay_server_elsewhere_is_left_alone() {
    let fixture = Fixture::new("{ agent_relay: { url: 'https://example.com/mcp' } }");
    let tools = fixture.tools();
    assert_eq!(tools.connect(SITE), Err(CONFLICT.to_string()));
    let status = tools.status(SITE);
    assert_eq!(status.state, OpenClawToolsState::Unavailable);
    assert_eq!(status.detail.as_deref(), Some(CONFLICT));
    assert!(fixture.calls().is_empty());
}

#[test]
fn status_reads_the_servers_authorization() {
    let listing = r#"[{"name":"agent_relay","authStatus":{"state":"requires-authorization"}},{"name":"b","authStatus":{"state":"authorized"}},{"name":"c","auth":"oauth"}]"#;
    assert_eq!(
        authorization(listing, "agent_relay"),
        Authorization::NotAuthorized
    );
    assert_eq!(authorization(listing, "b"), Authorization::Authorized);
    assert_eq!(authorization(listing, "c"), Authorization::Unsupported);
    assert_eq!(authorization(listing, "d"), Authorization::Missing);
    let wrapped = format!("[plugins] loaded\n{{\"path\":\"p\",\"servers\":{listing}}}");
    assert_eq!(authorization(&wrapped, "b"), Authorization::Authorized);
    assert_eq!(
        authorization("No MCP servers configured.", "b"),
        Authorization::Unsupported
    );

    let fixture = Fixture::new(&format!(
        "{{ agent_relay: {{ url: '{URL}', auth: 'oauth' }} }}"
    ));
    fixture.file("status.json", listing);
    assert_eq!(
        fixture.tools().status(SITE).state,
        OpenClawToolsState::NotConnected
    );
    let fixture = Fixture::new(&format!(
        "{{ agent_relay: {{ url: '{URL}', auth: 'oauth' }} }}"
    ));
    fixture.file("status.exit", "1");
    let status = fixture.tools().status(SITE);
    assert_eq!(status.detail.as_deref(), Some(LOGIN_UNSUPPORTED));
}

#[test]
fn without_the_cli_the_tools_are_unavailable() {
    let fixture = Fixture::new("{}");
    let tools = RelayTools::new(&fixture.config, || None);
    let status = tools.status(SITE);
    assert_eq!(status.state, OpenClawToolsState::Unavailable);
    assert_eq!(status.detail.as_deref(), Some(CLI_MISSING));
    assert_eq!(tools.connect(SITE), Err(CLI_MISSING.to_string()));
}

#[test]
fn an_openclaw_without_mcp_login_says_to_update() {
    let fixture = Fixture::new(&format!(
        "{{ agent_relay: {{ url: '{URL}', auth: 'oauth' }} }}"
    ));
    fixture.file("login.err", "error: unknown command 'login'\n");
    fixture.file("login.exit", "1");
    assert_eq!(
        fixture.tools().connect(SITE),
        Err(LOGIN_UNSUPPORTED.to_string())
    );
}

#[test]
fn a_login_that_needs_a_pasted_code_or_ends_early_fails() {
    let fixture = Fixture::new(&format!(
        "{{ agent_relay: {{ url: '{URL}', auth: 'oauth' }} }}"
    ));
    fixture.file(
        "login.out",
        &format!("Open this URL to authorize \"agent_relay\":\n{CONSENT}\nAfter approval, run openclaw mcp login agent_relay --code <code>.\n"),
    );
    assert_eq!(fixture.tools().connect(SITE), Err(LOGIN_FAILED.to_string()));

    // The browser never came back: the login ends, and Connect is offered
    // again with why.
    let fixture = Fixture::new(&format!(
        "{{ agent_relay: {{ url: '{URL}', auth: 'oauth' }} }}"
    ));
    fixture.consent();
    fixture.file("login.exit", "1");
    fixture.file(
        "status.json",
        r#"[{"name":"agent_relay","authStatus":{"state":"unauthenticated"}}]"#,
    );
    let tools = fixture.tools();
    let told = Arc::new(AtomicBool::new(false));
    let tell = told.clone();
    tools.on_change(Arc::new(move || tell.store(true, Ordering::SeqCst)));
    assert_eq!(
        tools.connect(SITE).unwrap().state,
        OpenClawToolsState::Waiting
    );
    let status = wait_for(&tools, OpenClawToolsState::NotConnected);
    assert_eq!(status.state, OpenClawToolsState::NotConnected);
    assert_eq!(status.detail.as_deref(), Some(LOGIN_FAILED));
    // The apps were told to read Settings again when the login ended.
    assert!(told.load(Ordering::SeqCst));
}

#[test]
fn turned_off_or_missing_openclaw_is_unavailable() {
    let fixture = Fixture::new("{}");
    let settings = super::super::OpenClawSettings::new(&fixture.config);
    use crate::relay::agents::SettingsExtension;
    settings
        .set(super::super::SETTING, &Value::Bool(false))
        .unwrap()
        .unwrap();
    let status = fixture.tools().status(SITE);
    assert_eq!(status.detail.as_deref(), Some(TURNED_OFF));
    std::fs::remove_file(&fixture.config.config_path).unwrap();
    let status = fixture.tools().status(SITE);
    assert_eq!(status.state, OpenClawToolsState::Unavailable);
    assert_eq!(
        status.detail.as_deref(),
        Some("OpenClaw is not set up on this computer.")
    );
}

#[test]
fn the_cli_is_found_from_the_running_gateway() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("lib/node_modules/openclaw/dist/index.js");
    std::fs::create_dir_all(script.parent().unwrap()).unwrap();
    std::fs::write(&script, "").unwrap();
    let table = FakeProcesses::default();
    let gateway = |uid: u32| FakeProcess {
        parent: 1,
        uid,
        executable: Some("/opt/homebrew/bin/node".into()),
        arguments: vec![
            "node".into(),
            script.display().to_string(),
            "gateway".into(),
        ],
        ..FakeProcess::default()
    };
    table.insert(40, gateway(502));
    assert_eq!(from_gateway(&table, 501), None, "another user's Gateway");
    table.insert(41, gateway(501));
    let found = from_gateway(&table, 501).unwrap();
    assert_eq!(found.program, Path::new("/opt/homebrew/bin/node"));
    assert_eq!(found.leading, [script.display().to_string()]);
    assert_eq!(mcp_url("https://agentrelay.com/"), URL);
    assert!(is_relay_mcp_url(&format!("{URL}/")));
}

#[test]
fn a_gateway_that_cannot_limit_sessions_withholds_the_tools() {
    let fixture = Fixture::new(&format!(
        "{{ agent_relay: {{ url: '{URL}', auth: 'oauth' }} }}"
    ));
    fixture.authorized("agent_relay");
    let tools = fixture.tools();
    assert_eq!(tools.status(SITE).state, OpenClawToolsState::Connected);
    // The Gateway this core connects to is 2026.7.33: no session limits.
    let hello = serde_json::json!({"server": {"version": "2026.7.33"}, "protocol": 3});
    fixture
        .config
        .seen
        .record(&crate::relay::openclaw::Features::from_hello(&hello));
    let withheld = "OpenClaw 2026.7.33 can't keep these tools away from people who aren't trusted senders. Updating OpenClaw to 2026.8.1 or later lets you connect them.";
    assert_eq!(unlimited("2026.7.33"), withheld);
    // Already signed in, it is still not connected.
    let status = tools.status(SITE);
    assert_eq!(status.state, OpenClawToolsState::Unavailable);
    assert_eq!(status.detail.as_deref(), Some(withheld));
    assert_eq!(tools.connect(SITE), Err(withheld.to_string()));
    assert!(fixture
        .calls()
        .iter()
        .all(|call| !call.starts_with("mcp login")));
}

#[test]
fn a_disabled_server_is_not_connected_and_connect_turns_it_on() {
    let fixture = Fixture::new(&format!(
        "{{ agent_relay: {{ url: '{URL}', auth: 'oauth', enabled: false }} }}"
    ));
    fixture.file(
        "status.json",
        r#"[{"name":"agent_relay","enabled":false,"authStatus":{"state":"authorized"}}]"#,
    );
    assert_eq!(
        authorization(
            r#"[{"name":"a","enabled":false,"authStatus":{"state":"authorized"}}]"#,
            "a"
        ),
        Authorization::Disabled
    );
    let tools = fixture.tools();
    assert_eq!(tools.status(SITE).state, OpenClawToolsState::NotConnected);
    fixture.file(
        "login.out",
        "MCP OAuth credentials saved for \"agent_relay\".\n",
    );
    assert_eq!(
        tools.connect(SITE).unwrap().state,
        OpenClawToolsState::Connected
    );
    let calls = fixture.calls();
    assert!(
        calls[0].starts_with("mcp configure agent_relay --enable |"),
        "{calls:?}"
    );
    assert!(calls[1].starts_with("mcp login agent_relay |"), "{calls:?}");
}

#[test]
fn an_openclaw_without_mcp_login_and_no_server_offers_no_connect() {
    let fixture = Fixture::new("{}");
    fixture.file("login.help", "Usage: openclaw mcp [options] [command]\n");
    let tools = fixture.tools();
    let status = tools.status(SITE);
    assert_eq!(status.state, OpenClawToolsState::Unavailable);
    assert_eq!(status.detail.as_deref(), Some(LOGIN_UNSUPPORTED));
    assert_eq!(tools.connect(SITE), Err(LOGIN_UNSUPPORTED.to_string()));
    // Nothing was added to openclaw.json.
    assert!(fixture.calls().is_empty());
}

#[test]
fn a_gateway_that_owns_the_state_is_never_stopped() {
    let refusal = "Cannot admit mcp.login for MCP credentials and configuration in state root /x: This operation requires exclusive offline state ownership. No local mutation was attempted.";
    let fixture = Fixture::new(&format!(
        "{{ agent_relay: {{ url: '{URL}', auth: 'oauth' }} }}"
    ));
    fixture.file("login.err", &format!("{refusal}\n"));
    fixture.file("login.exit", "1");
    assert_eq!(fixture.tools().connect(SITE), Err(GATEWAY_OWNS.to_string()));
    let fixture = Fixture::new("{}");
    fixture.file("add.err", &format!("{refusal}\n"));
    fixture.file("add.exit", "1");
    assert_eq!(fixture.tools().connect(SITE), Err(GATEWAY_OWNS.to_string()));
    // Only `mcp add` ran: nothing touched the Gateway.
    assert_eq!(fixture.calls().len(), 1);
}

#[test]
fn a_title_only_gateway_finds_the_launcher_beside_its_runtime() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join(".nvm/versions/node/v22.1.0/bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("node"), "").unwrap();
    std::fs::write(bin.join("openclaw"), "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(bin.join("openclaw"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let table = FakeProcesses::default();
    table.insert(
        42,
        FakeProcess {
            parent: 1,
            uid: 501,
            executable: Some(bin.join("node")),
            arguments: vec!["openclaw-gateway".into()],
            ..FakeProcess::default()
        },
    );
    let found = from_gateway(&table, 501).unwrap();
    assert_eq!(found.program, bin.join("openclaw"));
    assert!(found.leading.is_empty());
}

#[test]
fn a_server_turned_off_in_openclaw_json_is_not_connected_whatever_the_cli_says() {
    let fixture = Fixture::new(&format!(
        "{{ agent_relay: {{ url: '{URL}', auth: 'oauth', enabled: false }} }}"
    ));
    // An OpenClaw whose status names neither `enabled` nor `authStatus`.
    fixture.file("status.json", r#"[{"name":"agent_relay"}]"#);
    let status = fixture.tools().status(SITE);
    assert_eq!(status.state, OpenClawToolsState::NotConnected);
    assert_eq!(status.detail, None);
    assert_eq!(
        authorization(r#"[{"name":"a","enabled":false}]"#, "a"),
        Authorization::Disabled
    );
}

#[test]
fn a_status_read_that_began_before_connect_does_not_hide_the_login() {
    let fixture = Fixture::new(&format!(
        "{{ agent_relay: {{ url: '{URL}', auth: 'oauth' }} }}"
    ));
    fixture.file(
        "status.json",
        r#"[{"name":"agent_relay","authStatus":{"state":"unauthenticated"}}]"#,
    );
    fixture.file("status.sleep", "2");
    fixture.consent();
    fixture.file("login.sleep", "10");
    let tools = Arc::new(fixture.tools());
    // A status read starts, and its `mcp status` takes two seconds.
    let reading = {
        let tools = tools.clone();
        std::thread::spawn(move || tools.status(SITE))
    };
    std::thread::sleep(Duration::from_millis(300));
    // Connect starts the login while that read is under way.
    assert_eq!(
        tools.connect(SITE).unwrap().state,
        OpenClawToolsState::Waiting
    );
    // The read finishes after: it reports the login, not its old snapshot.
    assert_eq!(reading.join().unwrap().state, OpenClawToolsState::Waiting);
    assert_eq!(tools.status(SITE).state, OpenClawToolsState::Waiting);
    tools.stop();
}
