//! SDK HTTP transports share the same guarded platform trust as Cloud and sockets.
use relaycast::{ClientOptions, HttpClient, RelayError};
use std::sync::Arc;
use std::time::Duration;

/// Refuse file-selected roots even when a transport's platform config is cached.
pub(crate) fn environment_is_safe() -> relaycast::Result<()> {
    if super::websocket_tls::platform_root_environment_is_safe() {
        Ok(())
    } else {
        Err(RelayError::InvalidResponse(
            "Platform certificate file overrides are not supported".into(),
        ))
    }
}

fn transport(tls: Arc<rustls::ClientConfig>) -> relaycast::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .use_preconfigured_tls((*tls).clone())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()?)
}

/// Construct immediately before an SDK operation; no environment can seed the
/// platform cache or select additional trust files. SDK retries keep this client.
pub fn client(options: ClientOptions) -> relaycast::Result<HttpClient> {
    environment_is_safe()?;
    let tls = super::websocket_tls::client_config();
    Ok(HttpClient::with_http_client(options, transport(tls)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn test_tls() -> Arc<rustls::ClientConfig> {
        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(rustls::pki_types::CertificateDer::from(
                include_bytes!("../../tests/fixtures/platform-tls/ca.der").to_vec(),
            ))
            .unwrap();
        Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        )
    }
    fn tls_server() -> (std::net::SocketAddr, thread::JoinHandle<bool>) {
        let cert = rustls::pki_types::CertificateDer::from(
            include_bytes!("../../tests/fixtures/platform-tls/localhost.der").to_vec(),
        );
        let key = rustls::pki_types::PrivatePkcs8KeyDer::from(
            include_bytes!("../../tests/fixtures/platform-tls/localhost-key.der").to_vec(),
        );
        let config = Arc::new(
            rustls::ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(vec![cert], key.into())
                .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            tcp.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut stream =
                rustls::StreamOwned::new(rustls::ServerConnection::new(config).unwrap(), tcp);
            let mut bytes = [0; 4096];
            if !matches!(stream.read(&mut bytes),Ok(n) if n>0) {
                return false;
            }
            let body = b"{\"ok\":true,\"data\":{\"trusted\":true}}";
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
            stream.write_all(body).unwrap();
            true
        });
        (address, server)
    }
    #[tokio::test]
    async fn actual_sdk_and_rekey_keep_trust_and_reject_wrong_host_or_untrusted_ca() {
        for rekey in [false, true] {
            let (address, server) = tls_server();
            let http = HttpClient::with_http_client(
                ClientOptions::new("synthetic-test-only")
                    .with_base_url(format!("https://localhost:{}", address.port())),
                transport(test_tls()).unwrap(),
            );
            let http = if rekey {
                http.with_api_key("replacement-test-only").unwrap()
            } else {
                http
            };
            assert_eq!(
                http.get::<Value>("/v1/workspace", None, None)
                    .await
                    .unwrap()["trusted"],
                true
            );
            assert!(server.join().unwrap());
        }
        let (address, server) = tls_server();
        let http = HttpClient::with_http_client(
            ClientOptions::new("synthetic-test-only")
                .with_base_url(format!("https://127.0.0.1:{}", address.port())),
            transport(test_tls()).unwrap(),
        );
        assert!(http
            .get::<Value>("/v1/workspace", None, None)
            .await
            .is_err());
        assert!(
            !server.join().unwrap(),
            "wrong host must receive no HTTP credential"
        );
        let (address, server) = tls_server();
        let http = client(
            ClientOptions::new("synthetic-test-only")
                .with_base_url(format!("https://localhost:{}", address.port())),
        )
        .unwrap();
        assert!(http
            .get::<Value>("/v1/workspace", None, None)
            .await
            .is_err());
        assert!(
            !server.join().unwrap(),
            "untrusted CA must receive no HTTP credential"
        );
    }
    #[tokio::test]
    async fn injected_core_transport_never_follows_redirects_after_key_change() {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let destination = format!("http://{}/no-credential", target.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut tcp, _) = listener.accept().unwrap();
            let mut bytes = [0; 4096];
            tcp.read(&mut bytes).unwrap();
            let body = b"{\"ok\":true,\"data\":null}";
            write!(tcp,"HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",destination,body.len()).unwrap();
            tcp.write_all(body).unwrap();
        });
        client(ClientOptions::new("test-only").with_base_url(origin))
            .unwrap()
            .with_api_key("replacement-test-only")
            .unwrap()
            .get::<Value>("/one", None, None)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(
            target.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
    #[tokio::test]
    async fn sdk_environment_guard_child() {
        if std::env::var("RELAY_SDK_ENV_CHILD").as_deref() != Ok("1") {
            return;
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        for construct in [0, 1, 2] {
            let result = match construct {
                0 => client(ClientOptions::new("test-only").with_base_url(&origin)).map(|_| ()),
                1 => super::super::client::workspace_client(
                    &origin,
                    &super::super::workspace::Secret::new("test-only"),
                )
                .map(|_| ()),
                _ => super::super::client::agent_client(
                    &origin,
                    &super::super::workspace::Secret::new("test-only"),
                )
                .map(|_| ()),
            };
            assert!(result.is_err());
        }
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
    #[test]
    fn all_core_sdk_constructors_refuse_file_overrides_before_connect() {
        for name in ["SSL_CERT_FILE", "SSL_CERT_DIR"] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "relay::sdk_http::tests::sdk_environment_guard_child",
                ])
                .env("RELAY_SDK_ENV_CHILD", "1")
                .env(name, "not-a-root-file")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        }
    }
    #[tokio::test]
    async fn cached_transport_wrapper_environment_guard_child() {
        if std::env::var("RELAY_SDK_WRAPPER_CHILD").as_deref() != Ok("1") {
            return;
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let http = super::super::diagnostic_http::HttpClient::new(
            ClientOptions::new("test-only").with_base_url(&origin),
        )
        .unwrap();
        std::env::set_var("SSL_CERT_DIR", "not-a-root-directory");
        assert!(http
            .get::<Value>("/one", Some(&[("api_key", "test-only")]), None)
            .await
            .is_err());
        assert!(http
            .post::<Value>(
                "/two",
                Some(serde_json::json!({"credential":"test-only"})),
                None
            )
            .await
            .is_err());
        assert!(http.delete("/three", None).await.is_err());
        let entries: Vec<_> = super::super::request_log::snapshot()
            .entries
            .into_iter()
            .filter(|entry| entry.endpoint.starts_with(&origin))
            .collect();
        assert_eq!(
            entries.len(),
            3,
            "each refused verb must finish a diagnostic entry"
        );
        for (method, path) in [("GET", "/one"), ("POST", "/two"), ("DELETE", "/three")] {
            let entry = entries
                .iter()
                .find(|entry| entry.method == method && entry.endpoint == format!("{origin}{path}"))
                .unwrap();
            assert!(entry.failed);
            assert_eq!(
                entry.status, None,
                "no HTTP status exists without a request"
            );
            assert!(entry.duration_ms.is_some());
            assert!(entry
                .response
                .contains("Platform certificate file overrides"));
            assert!(!entry.request.contains("test-only"));
            assert!(!entry.response.contains("test-only"));
            assert!(!entry.response.contains("not-a-root-directory"));
        }
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
    #[tokio::test]
    async fn websocket_file_roots_cannot_seed_sdk_trust_child() {
        if std::env::var("RELAY_SDK_CACHE_CHILD").as_deref() != Ok("1") {
            return;
        }
        use base64::Engine;
        let directory = tempfile::tempdir().unwrap();
        let ca = directory.path().join("fixture-ca.pem");
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(include_bytes!("../../tests/fixtures/platform-tls/ca.der"));
        std::fs::write(
            &ca,
            format!("-----BEGIN CERTIFICATE-----\n{encoded}\n-----END CERTIFICATE-----\n"),
        )
        .unwrap();
        std::env::set_var("SSL_CERT_FILE", &ca);
        let _ = super::super::websocket_tls::client_config();
        std::env::remove_var("SSL_CERT_FILE");
        let (address, server) = tls_server();
        let http = client(
            ClientOptions::new("test-only")
                .with_base_url(format!("https://localhost:{}", address.port())),
        )
        .unwrap();
        assert!(http.get::<Value>("/one", None, None).await.is_err());
        assert!(!server.join().unwrap());
    }
    #[test]
    fn cached_clients_and_shared_roots_cannot_bypass_environment_refusal() {
        for (child, flag) in [
            (
                "cached_transport_wrapper_environment_guard_child",
                "RELAY_SDK_WRAPPER_CHILD",
            ),
            (
                "websocket_file_roots_cannot_seed_sdk_trust_child",
                "RELAY_SDK_CACHE_CHILD",
            ),
        ] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", &format!("relay::sdk_http::tests::{child}")])
                .env_remove("SSL_CERT_FILE")
                .env_remove("SSL_CERT_DIR")
                .env(flag, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        }
    }
}
