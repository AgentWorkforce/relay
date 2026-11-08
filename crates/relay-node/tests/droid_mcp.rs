//! Component proof only: exercise the compiled app-owned MCP CLI with synthetic
//! stdio and isolated storage. This never starts Droid, a model or a core daemon.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn snapshot(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    let mut result = BTreeMap::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let metadata = std::fs::symlink_metadata(&path).unwrap();
        let relative = path.strip_prefix(root).unwrap().to_path_buf();
        if metadata.is_dir() {
            result.insert(relative, None);
            pending.extend(
                std::fs::read_dir(path)
                    .unwrap()
                    .map(|entry| entry.unwrap().path()),
            );
        } else {
            result.insert(
                relative,
                metadata.is_file().then(|| std::fs::read(path).unwrap()),
            );
        }
    }
    result
}

fn input() -> Vec<u8> {
    let requests = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"synthetic-test"},"token":"synthetic-init-must-not-echo"}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"ping"}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/list"}),
        json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"join_relay","arguments":{"name":"synthetic-never-register"}}}),
        json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"send_relay_message","arguments":{"to":"synthetic-peer","text":"synthetic-never-send"}}}),
    ];
    requests
        .iter()
        .map(|row| format!("{row}\n"))
        .collect::<String>()
        .into_bytes()
}

#[test]
fn compiled_factory_helper_is_inert_and_denies_effectful_tools_in_both_build_modes() {
    for development in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let factory = home.path().join(".factory");
        std::fs::create_dir(&factory).unwrap();
        std::fs::write(
            factory.join("mcp.json"),
            b"{\"mcpServers\":{},\"synthetic\":\"config-must-stay-identical\"}",
        )
        .unwrap();
        std::fs::write(
            factory.join("settings.json"),
            b"{\"synthetic\":\"settings-must-stay-identical\"}",
        )
        .unwrap();
        let desktop = home.path().join(".agentworkforce/desktop");
        std::fs::create_dir_all(&desktop).unwrap();
        let socket = home.path().join("component.sock");
        for name in ["relay-socket", "relay-socket.dev"] {
            std::fs::write(desktop.join(name), socket.to_str().unwrap()).unwrap();
        }
        #[cfg(unix)]
        let listener = {
            let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
            listener.set_nonblocking(true).unwrap();
            listener
        };
        let before = snapshot(home.path());
        let mut command = Command::new(env!("CARGO_BIN_EXE_agent-relay-node"));
        command
            .env_clear()
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            .env("FACTORY_HOME_OVERRIDE", home.path())
            .env("AGENT_RELAY_HOME", home.path().join("relay-home"))
            .env("XDG_CONFIG_HOME", home.path().join("config"))
            .env("TMPDIR", home.path())
            .env("TMP", home.path())
            .env("TEMP", home.path())
            .current_dir(home.path())
            .arg("droid-spawn-mcp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // The Windows loader may need this system path; no user credentials or
        // agent environment is inherited on any platform.
        #[cfg(windows)]
        if let Some(system_root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", system_root);
        }
        if development {
            command.arg("--dev");
        }
        let mut child = command.spawn().unwrap();
        child.stdin.take().unwrap().write_all(&input()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("compiled Factory MCP component did not terminate within its bounded test budget");
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let mut stdout = String::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut stdout)
            .unwrap();
        let mut stderr = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        assert!(status.success(), "compiled component failed: {stderr}");
        assert!(stderr.is_empty());
        let rows: Vec<Value> = stdout
            .lines()
            .map(|row| serde_json::from_str(row).unwrap())
            .collect();
        assert_eq!(rows.len(), 5);
        assert_eq!(
            rows[0]["result"]["serverInfo"]["name"],
            "Agent Relay Factory"
        );
        assert_eq!(rows[1]["result"], json!({}));
        assert_eq!(rows[2]["result"], json!({"tools":[]}));
        for row in &rows[3..] {
            assert_eq!(row["result"]["isError"], true);
            assert!(row["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("Factory Droid managed messaging"));
        }
        for never_echo in [
            "synthetic-init-must-not-echo",
            "synthetic-never-register",
            "synthetic-never-send",
        ] {
            assert!(!stdout.contains(never_echo));
        }
        assert_eq!(
            snapshot(home.path()),
            before,
            "the helper changed isolated config or state"
        );
        #[cfg(unix)]
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock,
            "the helper attempted a Relay socket operation"
        );
    }
}
