// Disposable wire peer. It does not run a model, tools or network requests.
use std::io::{self, BufRead, Write};

fn field(line: &str, key: &str) -> String {
    let needle = format!("\"{key}\":");
    let tail = line
        .split_once(&needle)
        .expect("required wire field")
        .1
        .trim_start();
    tail.strip_prefix('"')
        .expect("string field")
        .split('"')
        .next()
        .unwrap()
        .to_owned()
}
fn output(value: &str) {
    println!("{value}");
    io::stdout().flush().unwrap();
}
fn permission(
    lines: &mut impl Iterator<Item = io::Result<String>>,
    id: &str,
    name: &str,
    expected: &str,
) {
    output(&format!(
        r#"{{"factoryApiVersion":"1.0.0","jsonrpc":"2.0","type":"request","id":"{id}","method":"droid.request_permission","params":{{"toolUses":[{{"toolUse":{{"name":"{name}","input":{{"to":"fixture","text":"synthetic proof"}}}}}}]}}}}"#
    ));
    let reply = lines.next().unwrap().unwrap();
    assert_eq!(field(&reply, "id"), id);
    assert_eq!(field(&reply, "type"), "response");
    assert_eq!(field(&reply, "selectedOption"), expected);
}
fn main() {
    assert_eq!(
        std::env::var("FACTORY_DROID_AUTO_UPDATE_ENABLED").as_deref(),
        Ok("false")
    );
    let session = "11111111-2222-4333-8444-555555555555";
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let mut alias = String::new();
    while let Some(line) = lines.next() {
        let line = line.unwrap();
        assert_eq!(field(&line, "factoryApiVersion"), "1.0.0");
        assert_eq!(field(&line, "type"), "request");
        let id = field(&line, "id");
        match field(&line, "method").as_str() {
            "droid.initialize_session" => {
                assert!(
                    line.contains("droid-spawn-mcp"),
                    "missing pinned relay MCP definition"
                );
                assert_eq!(field(&line, "autonomyMode"), "normal");
                alias = field(&line, "name");
                output(&format!(
                    r#"{{"jsonrpc":"2.0","type":"response","id":"{id}","result":{{"sessionId":"{session}"}}}}"#
                ));
            }
            "droid.add_user_message" => {
                assert_eq!(field(&line, "userMessageSource"), "sdk");
                let mut events = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(std::env::var("RELAY_FACTORY_FIXTURE_EVENTS").unwrap())
                    .unwrap();
                writeln!(events, "{} {} {}", std::process::id(), session, id).unwrap();
                output(&format!(
                    r#"{{"jsonrpc":"2.0","type":"response","id":"{id}","result":{{}}}}"#
                ));
                output(&format!(
                    r#"{{"jsonrpc":"2.0","type":"notification","method":"droid.session_notification","params":{{"sessionId":"{session}","notification":{{"type":"droid_working_state_changed","newState":"streaming"}}}}}}"#
                ));
                permission(
                    &mut lines,
                    "permission-pinned",
                    &format!("mcp__{alias}__send_relay_message"),
                    "proceed_once",
                );
                permission(
                    &mut lines,
                    "permission-foreign",
                    "mcp__foreign__send_relay_message",
                    "cancel",
                );
                permission(&mut lines, "permission-execute", "Execute", "cancel");
                output(&format!(
                    r#"{{"jsonrpc":"2.0","type":"notification","method":"droid.session_notification","params":{{"sessionId":"{session}","notification":{{"type":"droid_working_state_changed","newState":"idle"}}}}}}"#
                ));
            }
            _ => panic!("unexpected native method"),
        }
    }
}
