//! An embedding crate constructs the options through the transport's public
//! API, without depending on the core's particular SDK source or version.
use agent_relay_node::relay::diagnostic_http::{HttpClient, RequestOptions};
use relaycast::ClientOptions;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
use std::time::Duration;

#[test]
fn an_embedding_app_can_keep_the_idempotency_key_with_transport_owned_options() {
    if ["SSL_CERT_FILE", "SSL_CERT_DIR"]
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
    {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "an_embedding_app_can_keep_the_idempotency_key_with_transport_owned_options",
                "--nocapture",
            ])
            .env_remove("SSL_CERT_FILE")
            .env_remove("SSL_CERT_DIR")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "child failed: {}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        return;
    }
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(verify_public_options());
}

async fn verify_public_options() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = Vec::new();
        loop {
            let mut bytes = [0; 4096];
            let count = stream.read(&mut bytes).unwrap();
            assert!(count > 0);
            request.extend_from_slice(&bytes[..count]);
            assert!(request.len() <= 8192);
            let Some(end) = request.windows(4).position(|s| s == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..end]);
            let length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            if request.len() < end + 4 + length {
                continue;
            }
            assert!(headers.starts_with("POST /v1/agents/release-exact HTTP/1.1"));
            assert!(headers
                .lines()
                .any(|line| line.eq_ignore_ascii_case("idempotency-key: synthetic-release-once")));
            let body: Value = serde_json::from_slice(&request[end + 4..end + 4 + length]).unwrap();
            assert_eq!(body["expected_agent_id"], "synthetic-worker-id");
            let answer = r#"{"ok":true,"data":{"released":true}}"#;
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",answer.len(),answer).unwrap();
            break;
        }
    });
    let http =
        HttpClient::new(ClientOptions::new("synthetic-credential").with_base_url(base)).unwrap();
    let result: Value = http
        .post(
            "/v1/agents/release-exact",
            Some(json!({"expected_agent_id":"synthetic-worker-id"})),
            Some(RequestOptions::with_idempotency_key(
                "synthetic-release-once",
            )),
        )
        .await
        .unwrap();
    assert_eq!(result["released"], true);
    server.join().unwrap();
}
