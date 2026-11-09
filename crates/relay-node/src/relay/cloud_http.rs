//! One JSON request to Agent Relay Cloud.
//!
//! Requests never follow a redirect, so a bearer stays with the origin it
//! was issued for; only https origins (http for `localhost`/`127.0.0.1`)
//! are called; bodies are bounded; and a provider's body never reaches an
//! error beyond Cloud's own one-line `message`.

use serde_json::Value;
use std::error::Error;
use std::io::Read;
use std::time::Duration;

/// The largest body read from Cloud.
const MAX_BODY: u64 = 4 * 1024 * 1024;

/// What Cloud answered: any status, with its JSON body (`Null` when empty or
/// unreadable).
#[derive(Clone, Debug, PartialEq)]
pub struct Answer {
    pub status: u16,
    pub body: Value,
}

impl Answer {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// The body, or its `data` object when Cloud wrapped it in an envelope.
    pub fn inner(&self) -> &Value {
        match self.body.get("data") {
            Some(data) if data.is_object() => data,
            _ => &self.body,
        }
    }

    /// Cloud's own one-line message for a failure, when it sent one.
    pub fn message(&self) -> Option<String> {
        let body = &self.body;
        let message = body["error"]["message"]
            .as_str()
            .or(body["message"].as_str())
            .or(body["error"].as_str())?
            .trim();
        (!message.is_empty() && message.len() <= 300 && !message.contains('\n'))
            .then(|| message.to_string())
    }
}

/// Cloud could not be reached, or the address is not one a credential may
/// be sent to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Unreachable;

/// Whether `url` may carry a credential: https, or http on loopback.
pub fn sendable(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1"));
    parsed.scheme() == "https" || (parsed.scheme() == "http" && local)
}

/// One request with a raw body: any status, with at most 4 MiB of body.
pub struct Raw {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Why a raw request got no answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RawError {
    /// No answer. The cause names the step that failed (`dns`, `connect`,
    /// `io`, ...) for the log; it never carries the URL or a credential.
    Unreachable(&'static str),
    TimedOut,
    /// The body is larger than 4 MiB.
    Oversized,
}

fn is_timeout(error: &(dyn Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(candidate) = current {
        if candidate
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::TimedOut)
        {
            return true;
        }
        current = candidate.source();
    }
    false
}

impl RawError {
    /// A short, credential-free name for the log.
    pub fn cause(&self) -> &'static str {
        match self {
            RawError::Unreachable(cause) => cause,
            RawError::TimedOut => "timeout",
            RawError::Oversized => "oversized",
        }
    }
}

fn transport_cause(error: &ureq::Transport) -> &'static str {
    match error.kind() {
        ureq::ErrorKind::Dns => "dns",
        ureq::ErrorKind::ConnectionFailed => "connect",
        ureq::ErrorKind::Io => "io",
        ureq::ErrorKind::BadStatus | ureq::ErrorKind::BadHeader => "bad_response",
        ureq::ErrorKind::TooManyRedirects => "redirect",
        ureq::ErrorKind::ProxyConnect
        | ureq::ErrorKind::ProxyUnauthorized
        | ureq::ErrorKind::InvalidProxyUrl => "proxy",
        _ => "transport",
    }
}

fn http_agent(timeout: Duration, tls: std::sync::Arc<rustls::ClientConfig>) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .tls_config(tls)
        .redirects(0)
        .timeout(timeout)
        .build()
}

/// Sends one request with `headers` and a raw body. Blocking.
pub fn send_raw_blocking(
    method: &str,
    url: &str,
    bearer: Option<&str>,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    timeout: Duration,
) -> Result<Raw, RawError> {
    let request = body
        .and_then(|body| serde_json::from_slice::<Value>(body).ok())
        .unwrap_or(Value::Null);
    let mut capture =
        super::request_log::Capture::start("Cloud", method, url, &request, bearer.unwrap_or(""));
    let mut received_status = None;
    let result = (|| {
        if !sendable(url) {
            return Err(RawError::Unreachable("unsendable_url"));
        }
        if !super::websocket_tls::platform_root_environment_is_safe() {
            return Err(RawError::Unreachable("tls_roots"));
        }
        let agent = http_agent(timeout, super::websocket_tls::client_config());
        let mut request = agent
            .request(method, url)
            .set("Accept", "application/json")
            .set(
                "User-Agent",
                &format!("AgentRelayDesktop/{}", crate::VERSION),
            );
        if let Some(bearer) = bearer {
            request = request.set("Authorization", &format!("Bearer {bearer}"));
        }
        for (name, value) in headers {
            request = request.set(name, value);
        }
        let response = match body {
            Some(body) => request.send_bytes(body),
            None => request.call(),
        };
        let response = match response {
            Ok(response) => response,
            Err(ureq::Error::Status(_, response)) => response,
            Err(ureq::Error::Transport(error)) if is_timeout(&error) => {
                return Err(RawError::TimedOut)
            }
            Err(ureq::Error::Transport(error)) => {
                return Err(RawError::Unreachable(transport_cause(&error)))
            }
        };
        let status = response.status();
        received_status = Some(status);
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(MAX_BODY + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::TimedOut {
                    RawError::TimedOut
                } else {
                    RawError::Unreachable("read")
                }
            })?;
        if bytes.len() as u64 > MAX_BODY {
            return Err(RawError::Oversized);
        }
        Ok(Raw {
            status,
            body: bytes,
        })
    })();
    match &result {
        Ok(raw) => capture.finish(Some(raw.status), !(200..300).contains(&raw.status), &serde_json::from_slice::<Value>(&raw.body).unwrap_or_else(|_| serde_json::json!({"result": "Non-JSON response", "excerpt": String::from_utf8_lossy(&raw.body), "bytes": raw.body.len()}))),
        Err(error) => capture.finish(received_status, true, &serde_json::json!({"error": format!("{error:?}")})),
    }
    result
}

/// Sends one JSON request and reads the answer. Blocking; async callers use
/// [`send`].
pub fn send_blocking(
    method: &str,
    url: &str,
    bearer: Option<&str>,
    body: Option<&Value>,
    timeout: Duration,
) -> Result<Answer, Unreachable> {
    send_blocking_with_headers(method, url, bearer, &[], body, timeout).map_err(|_| Unreachable)
}

/// Sends one JSON request with additional headers. Blocking.
pub fn send_blocking_with_headers(
    method: &str,
    url: &str,
    bearer: Option<&str>,
    extra_headers: &[(&str, &str)],
    body: Option<&Value>,
    timeout: Duration,
) -> Result<Answer, RawError> {
    let encoded = body.map(|body| serde_json::to_vec(body).unwrap_or_default());
    let mut headers = extra_headers.to_vec();
    if encoded.is_some() {
        headers.push(("Content-Type", "application/json"));
    }
    let raw = send_raw_blocking(method, url, bearer, &headers, encoded.as_deref(), timeout)?;
    let body = if raw.body.iter().all(u8::is_ascii_whitespace) {
        Value::Null
    } else {
        serde_json::from_slice(&raw.body).unwrap_or(Value::Null)
    };
    Ok(Answer {
        status: raw.status,
        body,
    })
}

/// [`send_blocking`] on a blocking thread.
pub async fn send(
    method: &'static str,
    url: String,
    bearer: Option<String>,
    body: Option<Value>,
    timeout: Duration,
) -> Result<Answer, Unreachable> {
    tokio::task::spawn_blocking(move || {
        send_blocking(method, &url, bearer.as_deref(), body.as_ref(), timeout)
    })
    .await
    .unwrap_or(Err(Unreachable))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn test_tls() -> std::sync::Arc<rustls::ClientConfig> {
        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(rustls::pki_types::CertificateDer::from(
                include_bytes!("../../tests/fixtures/platform-tls/ca.der").to_vec(),
            ))
            .unwrap();
        std::sync::Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        )
    }

    fn certificate_rejection(error: &ureq::Error) -> Option<rustls::CertificateError> {
        let mut current: Option<&(dyn Error + 'static)> = Some(error);
        while let Some(error) = current {
            if let Some(rustls::Error::InvalidCertificate(cause)) =
                error.downcast_ref::<rustls::Error>()
            {
                return Some(cause.clone());
            }
            current = error
                .downcast_ref::<std::io::Error>()
                .and_then(std::io::Error::get_ref)
                .map(|inner| inner as &(dyn Error + 'static))
                .or_else(|| error.source());
        }
        None
    }

    #[test]
    fn a_transport_timeout_is_not_certificate_rejection() {
        let timeout = ureq::Error::from(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "synthetic transport timeout",
        ));
        assert!(is_timeout(&timeout));
        assert_eq!(certificate_rejection(&timeout), None);
    }

    fn tls_server() -> (std::net::SocketAddr, thread::JoinHandle<bool>) {
        tls_server_waiting(Duration::from_secs(3))
    }

    fn tls_server_waiting(
        accept_timeout: Duration,
    ) -> (std::net::SocketAddr, thread::JoinHandle<bool>) {
        let cert = rustls::pki_types::CertificateDer::from(
            include_bytes!("../../tests/fixtures/platform-tls/localhost.der").to_vec(),
        );
        let key = rustls::pki_types::PrivatePkcs8KeyDer::from(
            include_bytes!("../../tests/fixtures/platform-tls/localhost-key.der").to_vec(),
        );
        let config = std::sync::Arc::new(
            rustls::ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(vec![cert], key.into())
                .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let server = thread::spawn(move || {
            let deadline = std::time::Instant::now() + accept_timeout;
            let tcp = loop {
                match listener.accept() {
                    Ok((tcp, _)) => break tcp,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() >= deadline {
                            return false;
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => return false,
                }
            };
            tcp.set_nonblocking(false).unwrap();
            tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            tcp.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
            let session = rustls::ServerConnection::new(config).unwrap();
            let mut stream = rustls::StreamOwned::new(session, tcp);
            let mut bytes = [0; 4096];
            if !matches!(stream.read(&mut bytes), Ok(n) if n > 0) {
                return false;
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .unwrap();
            true
        });
        (address, server)
    }

    #[test]
    fn tls_diagnostic_default_sdk_client_preserves_root_environment() {
        let names = ["SSL_CERT_FILE", "SSL_CERT_DIR"];
        let before = names.map(std::env::var_os);
        let _client = relaycast::RelayCast::new(
            relaycast::RelayCastOptions::new("rk_synthetic_diagnostic")
                .with_base_url("http://127.0.0.1:1"),
        )
        .unwrap();
        let after = names.map(std::env::var_os);
        for (index, name) in names.iter().enumerate() {
            eprintln!(
                "TLS default SDK client {name} before_present={} after_present={}",
                before[index]
                    .as_ref()
                    .is_some_and(|value| !value.is_empty()),
                after[index].as_ref().is_some_and(|value| !value.is_empty())
            );
        }
        assert!(
            before == after,
            "constructing the default SDK HTTP client changed file-root environment"
        );
    }

    #[test]
    fn tls_diagnostic_server_finishes_when_refusal_precedes_connection() {
        for name in ["SSL_CERT_FILE", "SSL_CERT_DIR"] {
            eprintln!(
                "TLS test process {name} present={}",
                std::env::var_os(name).is_some_and(|value| !value.is_empty())
            );
        }
        let (_address, server) = tls_server_waiting(Duration::from_millis(50));
        assert!(!server.join().unwrap());
    }

    #[test]
    fn verified_tls_matches_host_and_refuses_wrong_host_or_untrusted_ca() {
        let (address, server) = tls_server();
        let answer = http_agent(Duration::from_secs(3), test_tls())
            .get(&format!("https://localhost:{}/", address.port()))
            .call()
            .unwrap();
        assert_eq!(answer.status(), 200);
        assert!(server.join().unwrap());

        let (address, server) = tls_server();
        let rejected = http_agent(Duration::from_secs(3), test_tls())
            .get(&format!("https://127.0.0.1:{}/", address.port()))
            .call()
            .unwrap_err();
        assert!(
            matches!(
                certificate_rejection(&rejected),
                Some(
                    rustls::CertificateError::NotValidForName
                        | rustls::CertificateError::NotValidForNameContext { .. }
                )
            ),
            "expected hostname certificate rejection: {rejected:?}"
        );
        assert!(
            !server.join().unwrap(),
            "wrong hostname must send no HTTP request"
        );

        let (address, server) = tls_server();
        let rejected = http_agent(
            Duration::from_secs(3),
            super::super::websocket_tls::client_config(),
        )
        .get(&format!("https://localhost:{}/", address.port()))
        .call()
        .unwrap_err();
        assert_eq!(
            certificate_rejection(&rejected),
            Some(rustls::CertificateError::UnknownIssuer),
            "expected untrusted certificate rejection: {rejected:?}"
        );
        assert!(
            !server.join().unwrap(),
            "an untrusted CA must send no HTTP request"
        );
    }

    #[test]
    fn root_override_child_refuses_before_connect() {
        if std::env::var("RELAY_TLS_ENV_CHILD").as_deref() != Ok("1") {
            return;
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let result = send_raw_blocking(
            "GET",
            &format!("http://{}/", listener.local_addr().unwrap()),
            Some("synthetic-test-bearer"),
            &[],
            None,
            Duration::from_secs(1),
        );
        assert!(matches!(result, Err(RawError::Unreachable("tls_roots"))));
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn file_trust_overrides_refuse_before_credentials_or_connection() {
        for name in ["SSL_CERT_FILE", "SSL_CERT_DIR"] {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "relay::cloud_http::tests::root_override_child_refuses_before_connect",
                ])
                .env("RELAY_TLS_ENV_CHILD", "1")
                .env(name, "unused-root-override")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(status.success());
        }
    }

    #[test]
    fn websocket_root_override_child_cannot_contaminate_later_http() {
        if std::env::var("RELAY_TLS_CACHE_CHILD").as_deref() != Ok("1") {
            return;
        }
        use base64::Engine;
        let directory = tempfile::tempdir().unwrap();
        let ca = directory.path().join("throwaway-test-ca.pem");
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(include_bytes!("../../tests/fixtures/platform-tls/ca.der"));
        std::fs::write(
            &ca,
            format!("-----BEGIN CERTIFICATE-----\n{encoded}\n-----END CERTIFICATE-----\n"),
        )
        .unwrap();
        std::env::set_var("SSL_CERT_FILE", &ca);
        let _websocket = super::super::websocket_tls::connector();
        std::env::remove_var("SSL_CERT_FILE");
        let (address, server) = tls_server();
        let rejected = http_agent(
            Duration::from_secs(3),
            super::super::websocket_tls::client_config(),
        )
        .get(&format!("https://localhost:{}/", address.port()))
        .call()
        .unwrap_err();
        assert_eq!(
            certificate_rejection(&rejected),
            Some(rustls::CertificateError::UnknownIssuer),
            "expected untrusted certificate rejection: {rejected:?}"
        );
        assert!(
            !server.join().unwrap(),
            "a WebSocket must not seed file-derived trust for HTTP"
        );
    }

    #[test]
    fn shared_cache_never_retains_file_selected_roots() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "relay::cloud_http::tests::websocket_root_override_child_cannot_contaminate_later_http"])
            .env_remove("SSL_CERT_FILE").env_remove("SSL_CERT_DIR")
            .env("RELAY_TLS_CACHE_CHILD", "1").output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    }

    /// An operator can qualify the production client against an existing
    /// OS-trusted HTTPS health endpoint. No root file or credential is read.
    #[test]
    #[ignore = "requires an explicitly selected HTTPS endpoint trusted by the local OS"]
    fn operating_system_trust_reaches_selected_https_health_endpoint() {
        let url =
            std::env::var("RELAY_TLS_OS_PROBE_URL").expect("explicit HTTPS health URL required");
        assert!(url.starts_with("https://"));
        let response =
            send_raw_blocking("GET", &url, None, &[], None, Duration::from_secs(15)).unwrap();
        assert_eq!(response.status, 200);
    }

    #[test]
    fn only_https_or_loopback_http_carries_credentials() {
        assert!(sendable("https://agentrelay.com/cloud/api/v1/members"));
        assert!(sendable("http://127.0.0.1:4000/cloud"));
        assert!(sendable("http://localhost:4000/cloud"));
        assert!(!sendable("http://agentrelay.com/cloud"));
        assert!(!sendable("ftp://agentrelay.com"));
        assert!(!sendable("not a url"));
    }

    #[test]
    fn a_failure_keeps_only_cloud_s_one_line_message() {
        let answer = |body| Answer { status: 400, body };
        assert_eq!(
            answer(json!({"error": {"message": "Workspace not found"}})).message(),
            Some("Workspace not found".into())
        );
        assert_eq!(
            answer(json!({"message": "Nope"})).message(),
            Some("Nope".into())
        );
        assert_eq!(
            answer(json!({"error": "denied"})).message(),
            Some("denied".into())
        );
        assert_eq!(answer(json!({"message": "line\nstack"})).message(), None);
        assert_eq!(answer(json!({"message": "x".repeat(400)})).message(), None);
        assert_eq!(answer(Value::Null).message(), None);
    }

    #[test]
    fn an_envelope_is_unwrapped() {
        let answer = Answer {
            status: 200,
            body: json!({"ok": true, "data": {"a": 1}}),
        };
        assert_eq!(answer.inner(), &json!({"a": 1}));
        let bare = Answer {
            status: 200,
            body: json!({"a": 2}),
        };
        assert_eq!(bare.inner(), &json!({"a": 2}));
    }

    #[test]
    fn json_requests_carry_additional_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            // TCP can split headers and body across reads. Consume the full
            // request before closing so unread body bytes cannot reset the reply.
            let mut reader = std::io::BufReader::new(&mut stream);
            let mut request = String::new();
            loop {
                let mut line = String::new();
                assert!(std::io::BufRead::read_line(&mut reader, &mut line).unwrap() > 0);
                let headers_done = line == "\r\n";
                request.push_str(&line);
                if headers_done {
                    break;
                }
            }
            let request = request.to_ascii_lowercase();
            assert!(request.contains("idempotency-key: retry-key-123456"));
            assert!(request.contains("content-length: 2\r\n"));
            let mut body = [0; 2];
            reader.read_exact(&mut body).unwrap();
            assert_eq!(&body, b"{}");
            drop(reader);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                .unwrap();
        });
        let answer = send_blocking_with_headers(
            "POST",
            &format!("http://{address}/join"),
            None,
            &[("Idempotency-Key", "retry-key-123456")],
            Some(&json!({})),
            Duration::from_secs(1),
        )
        .unwrap();
        assert!(answer.ok());
        server.join().unwrap();
        let entry = super::super::request_log::snapshot()
            .entries
            .into_iter()
            .find(|entry| entry.endpoint == format!("http://{address}/join"))
            .unwrap();
        assert_eq!(entry.status, Some(200));
        assert!(!entry.failed);
        assert_eq!(entry.response, "{}");
        assert_eq!(entry.method, "POST");
    }

    #[test]
    fn overall_request_timeouts_remain_distinguishable() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_millis(100));
        });
        assert!(matches!(
            send_raw_blocking(
                "GET",
                &format!("http://{address}/slow"),
                None,
                &[],
                None,
                Duration::from_millis(10),
            ),
            Err(RawError::TimedOut)
        ));
        server.join().unwrap();
        let entry = super::super::request_log::snapshot()
            .entries
            .into_iter()
            .find(|entry| entry.endpoint == format!("http://{address}/slow"))
            .unwrap();
        assert!(entry.failed);
        assert!(entry.response.contains("TimedOut"));
    }

    #[test]
    fn unanswered_requests_name_the_step_that_failed() {
        let refused = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = refused.local_addr().unwrap();
        drop(refused);
        let error = send_raw_blocking(
            "GET",
            &format!("http://{address}/"),
            None,
            &[],
            None,
            Duration::from_secs(2),
        )
        .err()
        .unwrap();
        assert_eq!(error.cause(), "connect");

        let error = send_raw_blocking(
            "GET",
            "http://example.com/",
            Some("token"),
            &[],
            None,
            Duration::from_secs(2),
        )
        .err()
        .unwrap();
        assert_eq!(error, RawError::Unreachable("unsendable_url"));
        assert_eq!(RawError::TimedOut.cause(), "timeout");
    }
}
