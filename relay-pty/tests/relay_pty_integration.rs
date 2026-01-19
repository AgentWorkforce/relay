use serde_json::json;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tempfile::tempdir;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::process::Command;
use tokio::time::{sleep, timeout, Instant};

async fn wait_for_socket(path: &str) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if Path::new(path).exists() {
            return;
        }
        if Instant::now() >= deadline {
            panic!("Socket did not appear: {}", path);
        }
        sleep(Duration::from_millis(50)).await;
    }
}

async fn send_request(socket_path: &str, request: serde_json::Value) -> serde_json::Value {
    let stream = UnixStream::connect(socket_path).await.unwrap();
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);

    let request_json = serde_json::to_string(&request).unwrap();
    writer.write_all(request_json.as_bytes()).await.unwrap();
    writer.write_all(b"\n").await.unwrap();
    writer.flush().await.unwrap();

    let mut line = String::new();
    reader.read_line(&mut line).await.unwrap();
    serde_json::from_str(line.trim()).unwrap()
}

#[tokio::test]
async fn test_end_to_end_inject_via_socket() {
    let dir = tempdir().unwrap();
    let socket_path = dir.path().join("relay.sock");
    let socket_path_str = socket_path.to_string_lossy().to_string();

    let mut child = Command::new(env!("CARGO_BIN_EXE_relay-pty"))
        .arg("--name")
        .arg("test-agent")
        .arg("--socket")
        .arg(&socket_path_str)
        .arg("--idle-timeout")
        .arg("0")
        .arg("--log-level")
        .arg("error")
        .arg("--rows")
        .arg("24")
        .arg("--cols")
        .arg("80")
        .arg("--")
        .arg("sh")
        .arg("-c")
        .arg("cat")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    wait_for_socket(&socket_path_str).await;

    let response = send_request(
        &socket_path_str,
        json!({
            "type": "inject",
            "id": "msg-1",
            "from": "Tester",
            "body": "Hello",
            "priority": 0
        }),
    )
    .await;

    assert_eq!(response["type"], "inject_result");
    assert_eq!(response["status"], "queued");

    let expected = b"Relay message from Tester [msg-1]: Hello";
    let mut stdout = child.stdout.take().unwrap();
    let mut output = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(3);

    loop {
        if output.windows(expected.len()).any(|w| w == expected) {
            break;
        }
        let now = Instant::now();
        if now >= deadline {
            panic!(
                "Timed out waiting for injected output. Output so far: {}",
                String::from_utf8_lossy(&output)
            );
        }
        let mut buf = [0u8; 512];
        let read = timeout(deadline - now, stdout.read(&mut buf))
            .await
            .unwrap()
            .unwrap();
        if read == 0 {
            break;
        }
        output.extend_from_slice(&buf[..read]);
    }

    let response = send_request(&socket_path_str, json!({"type": "shutdown"})).await;
    assert_eq!(response["type"], "shutdown_ack");

    let _ = timeout(Duration::from_secs(5), child.wait())
        .await
        .unwrap();
}
