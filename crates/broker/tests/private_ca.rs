//! End-to-end trust proof for a node pointed at a private-CA Relaycast origin.
//!
//! This intentionally uses port 8443, the self-hosting case that exposed the
//! regression. It starts the real broker binary with only a saved credential
//! binding and `SSL_CERT_FILE`: no Relay base URL is present in its environment.

use std::{
    io::Read as _,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use pbkdf2::pbkdf2_hmac;
use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair};
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
use sha2::Sha256;
use tokio::{io::AsyncReadExt, io::AsyncWriteExt, net::TcpListener, sync::oneshot};
use tokio_rustls::TlsAcceptor;

const WORKSPACE_KEY: &str = "rk_live_private_ca_node_up";

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn fingerprint(credential: &str) -> String {
    let mut derived = [0u8; 16];
    pbkdf2_hmac::<Sha256>(
        credential.trim().as_bytes(),
        b"agent-relay:relaycast-origin-binding",
        10_000,
        &mut derived,
    );
    derived.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn private_ca() -> (String, CertificateDer<'static>, PrivatePkcs8KeyDer<'static>) {
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca_key = KeyPair::generate().unwrap();
    let ca = ca_params.self_signed(&ca_key).unwrap();

    let server_key = KeyPair::generate().unwrap();
    let server_params = CertificateParams::new(vec!["localhost".to_string()]).unwrap();
    let server = server_params.signed_by(&server_key, &ca, &ca_key).unwrap();
    (
        ca.pem(),
        server.der().clone(),
        PrivatePkcs8KeyDer::from(server_key.serialize_der()),
    )
}

async fn serve_private_ca_relaycast(
    cert: CertificateDer<'static>,
    key: PrivatePkcs8KeyDer<'static>,
    requests: Arc<Mutex<Vec<String>>>,
    mut shutdown: oneshot::Receiver<()>,
) {
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert], key.into())
        .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:8443").await.unwrap();

    loop {
        let accepted = tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => accepted,
        };
        let Ok((stream, _)) = accepted else { continue };
        let acceptor = acceptor.clone();
        let requests = requests.clone();
        tokio::spawn(async move {
            let Ok(mut stream) = acceptor.accept(stream).await else {
                return;
            };
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 4096];
            while bytes.windows(4).all(|window| window != b"\r\n\r\n") {
                let Ok(read) = stream.read(&mut chunk).await else {
                    return;
                };
                if read == 0 {
                    return;
                }
                bytes.extend_from_slice(&chunk[..read]);
                if bytes.len() > 64 * 1024 {
                    return;
                }
            }
            let request = String::from_utf8_lossy(&bytes);
            let request_line = request.lines().next().unwrap_or_default().to_string();
            requests.lock().unwrap().push(request_line.clone());
            let (status, body) = if request_line.starts_with("POST /v1/agents ") {
                (
                    "200 OK",
                    r#"{"ok":true,"data":{"id":"agent_tls","workspace_id":"ws_tls","name":"tls-node","token":"at_live_tls","status":"online","created_at":"2026-01-01T00:00:00Z"}}"#,
                )
            } else if request_line.starts_with("POST /v1/nodes ") {
                (
                    "200 OK",
                    r#"{"ok":true,"data":{"id":"node_tls","name":"tls-node","kind":"ws","role":"broker","version":"broker/test","status":"online","live":true,"handlers_live":true,"load":0.0,"active_agents":0,"max_agents":0,"created_at":"2026-01-01T00:00:00Z","token":"nt_live_tls"}}"#,
                )
            } else {
                (
                    "404 Not Found",
                    r#"{"ok":false,"error":{"code":"not_found","message":"test endpoint"}}"#,
                )
            };
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;
        });
    }
}

fn write_binding(home: &Path) {
    std::fs::create_dir_all(home).unwrap();
    std::fs::write(
        home.join("relaycast-origins.json"),
        format!(
            "{{\n  \"version\": 1,\n  \"origins\": {{\n    \"{}\": \"https://localhost:8443\"\n  }}\n}}\n",
            fingerprint(WORKSPACE_KEY)
        ),
    )
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_node_up_uses_saved_origin_and_ssl_cert_file_on_8443() {
    let temp = tempfile::tempdir().unwrap();
    let relay_home = temp.path().join("home");
    let state_dir = temp.path().join("state");
    write_binding(&relay_home);

    let (ca_pem, cert, key) = private_ca();
    let ca_path = temp.path().join("internal-ca.pem");
    std::fs::write(&ca_path, ca_pem).unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server = tokio::spawn(serve_private_ca_relaycast(
        cert,
        key,
        requests.clone(),
        shutdown_rx,
    ));
    tokio::time::sleep(Duration::from_millis(50)).await;

    let child = Command::new(env!("CARGO_BIN_EXE_agent-relay-broker"))
        .args([
            "init",
            "--persist",
            "--state-dir",
            state_dir.to_str().unwrap(),
            "--instance-name",
            "tls-node",
        ])
        .env("AGENT_RELAY_HOME", &relay_home)
        .env("RELAY_WORKSPACE_KEY", WORKSPACE_KEY)
        .env("AGENT_RELAY_WORKSPACE_SOURCE", "project")
        .env("SSL_CERT_FILE", &ca_path)
        .env_remove("RELAYCAST_BASE_URL")
        .env_remove("RELAY_BASE_URL")
        .env_remove("AGENT_RELAY_WORKSPACE_KEY")
        .env_remove("RELAY_API_KEY")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut child = ChildGuard(child);

    let connection_path = state_dir.join("connection.json");
    let deadline = Instant::now() + Duration::from_secs(15);
    let connection = loop {
        if let Ok(raw) = std::fs::read_to_string(&connection_path) {
            if let Ok(connection) = serde_json::from_str::<serde_json::Value>(&raw) {
                break connection;
            }
        }
        if let Some(status) = child.0.try_wait().unwrap() {
            let mut stderr = String::new();
            child
                .0
                .stderr
                .as_mut()
                .unwrap()
                .read_to_string(&mut stderr)
                .unwrap();
            panic!("broker exited before becoming ready ({status}): {stderr}");
        }
        assert!(
            Instant::now() < deadline,
            "broker did not write connection.json"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let api_url = connection["url"].as_str().unwrap();
    let api_key = connection["api_key"].as_str().unwrap();
    let client = reqwest::Client::new();
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            let mut stderr = String::new();
            child
                .0
                .stderr
                .as_mut()
                .unwrap()
                .read_to_string(&mut stderr)
                .unwrap();
            panic!("broker exited during Relaycast handshake ({status}): {stderr}");
        }
        if let Ok(response) = client
            .get(format!("{api_url}/api/session"))
            .header("x-api-key", api_key)
            .send()
            .await
        {
            if response.status().is_success() {
                let session: serde_json::Value = response.json().await.unwrap();
                assert_eq!(session["relay_base_url"], "https://localhost:8443");
                assert_eq!(session["default_workspace_id"], "ws_tls");
                break;
            }
        }
        assert!(
            Instant::now() < deadline,
            "broker never completed the private-CA handshake"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let seen = requests.lock().unwrap().clone();
    assert!(
        seen.iter().any(|line| line.starts_with("POST /v1/agents ")),
        "{seen:?}"
    );
    let websocket_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if requests
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.starts_with("GET /v1/node/ws "))
        {
            break;
        }
        assert!(
            Instant::now() < websocket_deadline,
            "node WSS handshake never reached the private-CA server: {:?}",
            requests.lock().unwrap()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let _ = shutdown_tx.send(());
    server.await.unwrap();
}
