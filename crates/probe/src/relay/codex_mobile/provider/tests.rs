use super::*;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
const THREAD: &str = "01a16f54-f5f0-7d10-b9d5-bef66e02d007";
fn write_rollout(config: &CodexConfig, client: &str, complete: bool) {
    std::fs::create_dir_all(config.home.join("sessions")).unwrap();
    let mut lines = vec![
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"mobile-turn"}}),
        json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":"mobile-turn","item":{"type":"UserMessage","client_id":client,"content":[{"type":"text","text":"synthetic mobile input"}]}}}),
    ];
    if complete {
        lines.push(
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"mobile-turn"}}),
        );
    }
    std::fs::write(
        config
            .home
            .join("sessions")
            .join(format!("rollout-test-{THREAD}.jsonl")),
        lines
            .iter()
            .map(|line| format!("{line}\n"))
            .collect::<String>(),
    )
    .unwrap();
}
fn read(stream: &mut std::os::unix::net::UnixStream) -> Value {
    let mut header = [0; 4];
    stream.read_exact(&mut header).unwrap();
    let mut body = vec![0; u32::from_le_bytes(header) as usize];
    stream.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}
#[test]
fn temp_window_requires_exact_active_mobile_client_receipt_and_leaves_desktop_ownership() {
    let home = tempfile::tempdir().unwrap();
    let config = CodexConfig {
        home: home.path().join("codex"),
        sqlite_home: home.path().join("codex"),
        executable: None,
        ipc_socket: home.path().join("ipc.sock"),
    };
    write_rollout(&config, "desktop-client", false);
    assert!(Window::open(config.clone(), THREAD, "mobile-client", "owner").is_none());
    write_rollout(&config, "mobile-client", true);
    assert!(Window::open(config.clone(), THREAD, "mobile-client", "owner").is_none());
    write_rollout(&config, "mobile-client", false);
    let listener = UnixListener::bind(&config.ipc_socket).unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        loop {
            let request = read(&mut stream);
            let response = match request["method"].as_str().unwrap() {
                "initialize" => {
                    json!({"type":"response","requestId":request["requestId"],"resultType":"success","result":{"clientId":"test-follower"}})
                }
                "thread-owner-discovery" => {
                    json!({"type":"response","requestId":request["requestId"],"resultType":"success","handledByClientId":"owner"})
                }
                "thread-stream-following-changed" => {
                    assert_eq!(request["targetClientIds"], json!(["owner"]));
                    if request["params"]["following"] == false {
                        break;
                    }
                    json!({"type":"broadcast","method":"thread-stream-state-changed","version":11,"sourceClientId":"owner","params":{"hostId":"local","conversationId":THREAD,"change":{"type":"snapshot","revision":1,"conversationState":{"id":THREAD,"requests":[]}}}})
                }
                other => panic!("observer sent forbidden method {other}"),
            };
            stream
                .write_all(
                    &crate::relay::codex::ipc::encode_frame(
                        &serde_json::to_vec(&response).unwrap(),
                    )
                    .unwrap(),
                )
                .unwrap();
        }
    });
    let mut window = Window::open(config.clone(), THREAD, "mobile-client", "owner").unwrap();
    assert_eq!(window.scope().turn, "mobile-turn");
    assert!(window.poll().unwrap().is_empty());
    write_rollout(&config, "mobile-client", true);
    assert_eq!(window.poll(), Err(Error::Unavailable));
    window.close();
    server.join().unwrap();
}

#[test]
fn home_aliases_share_consumed_identity_and_unknown_roots_are_unavailable() {
    let temp = tempfile::tempdir().unwrap();
    let actual = temp.path().join("actual");
    let alias = temp.path().join("alias");
    std::fs::create_dir(&actual).unwrap();
    std::os::unix::fs::symlink(&actual, &alias).unwrap();
    let mut config = CodexConfig {
        home: actual.clone(),
        sqlite_home: actual,
        executable: None,
        ipc_socket: temp.path().join("unused.sock"),
    };
    let original = home_identity(&config).unwrap();
    config.home = alias.clone();
    config.sqlite_home = alias;
    assert_eq!(home_identity(&config), Some(original));
    config.home = temp.path().join("missing");
    assert_eq!(home_identity(&config), None);
}

#[test]
fn existing_observer_proof_rejects_retargeted_home_even_with_matching_rollout_ids() {
    let temp = tempfile::tempdir().unwrap();
    let first = temp.path().join("first");
    let second = temp.path().join("second");
    let alias = temp.path().join("alias");
    std::fs::create_dir(&first).unwrap();
    std::fs::create_dir(&second).unwrap();
    let make = |home: std::path::PathBuf| CodexConfig {
        home: home.clone(),
        sqlite_home: home,
        executable: None,
        ipc_socket: temp.path().join("unused.sock"),
    };
    write_rollout(&make(first.clone()), "mobile-client", false);
    write_rollout(&make(second.clone()), "mobile-client", false);
    std::os::unix::fs::symlink(&first, &alias).unwrap();
    let config = make(alias.clone());
    let scope = Scope {
        home: home_identity(&config).unwrap(),
        thread: THREAD.into(),
        window: "window".into(),
        generation: "gen".into(),
        message: "mobile-client".into(),
        turn: "mobile-turn".into(),
    };
    assert!(current_turn(&config, &scope));
    std::fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&second, &alias).unwrap();
    assert!(!current_turn(&config, &scope));
}
