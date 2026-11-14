//! The platform TLS client configuration shared by HTTP and WebSocket clients.
//!
//! Trust comes from the platform's root certificates. Reading them walks the
//! keychain and evaluates each certificate's trust settings on macOS, so they
//! are read once and the configuration is handed to every connect, instead
//! of tokio-tungstenite reading them again on each one. The configuration is
//! read again after `REFRESH_AFTER`, so a CA added to or removed from the
//! platform store (a corporate or development proxy's) applies without a
//! restart. A read that reported errors is kept for `PARTIAL_REFRESH_AFTER`
//! instead, so it is retried sooner without reading on every connect.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, handshake::client::Response, protocol::WebSocketConfig, Error,
};
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};

/// Opens a WebSocket over the shared TLS configuration.
pub async fn connect(
    request: impl IntoClientRequest + Unpin,
    config: Option<WebSocketConfig>,
) -> Result<(WebSocketStream<MaybeTlsStream<TcpStream>>, Response), Error> {
    if !platform_root_environment_is_safe() {
        report_file_root_override();
        return Err(Error::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "file-selected TLS roots are unsupported; use the operating system trust store",
        )));
    }
    tokio_tungstenite::connect_async_tls_with_config(request, config, false, Some(connector()))
        .await
}

/// How long one read of the platform's roots is kept.
const REFRESH_AFTER: Duration = Duration::from_secs(10 * 60);

/// How long a read that reported errors (a stray file in a certificate
/// directory, a keychain entry that will not parse) is kept before trying
/// again. Never zero: such a host reports the same errors on every read.
const PARTIAL_REFRESH_AFTER: Duration = Duration::from_secs(60);

/// The connector for a `wss://` (or plain `ws://`) connect.
pub fn connector() -> Connector {
    Connector::Rustls(client_config())
}

/// Strict platform trust shared by HTTP and WebSocket clients. Certificate
/// chains and hostnames retain rustls's normal verification.
pub fn client_config() -> Arc<rustls::ClientConfig> {
    static SHARED: Shared = Shared::new();
    SHARED.config(native_roots)
}

/// The shared Cloud HTTP/WebSocket clients never use file-selected roots.
pub fn platform_root_environment_is_safe() -> bool {
    platform_root_environment_is_safe_with(|name| std::env::var_os(name))
}

fn platform_root_environment_is_safe_with(
    get: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> bool {
    ["SSL_CERT_FILE", "SSL_CERT_DIR"]
        .iter()
        .all(|name| get(name).is_none_or(|value| value.is_empty()))
}

fn report_file_root_override() {
    static REPORTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !REPORTED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        crate::relay::diagnostics::write(format_args!(
            "relay: file-selected TLS roots are unsupported; unset SSL_CERT_FILE and SSL_CERT_DIR and install the CA in the operating system trust store"
        ));
    }
}

/// The platform's roots, and whether they were all read: a load error or a
/// certificate that would not parse is logged, once per read.
fn native_roots() -> Roots {
    // The cache is shared with WebSockets. Refuse here too, so a WebSocket
    // cannot seed it from an override that HTTP no longer sees after removal.
    if !platform_root_environment_is_safe() {
        report_file_root_override();
        return Roots {
            complete: false,
            store: rustls::RootCertStore::empty(),
        };
    }
    roots_from_native(rustls_native_certs::load_native_certs(), |message| {
        crate::relay::diagnostics::write(format_args!("{message}"));
    })
}

fn roots_from_native(
    loaded: rustls_native_certs::CertificateResult,
    mut report: impl FnMut(String),
) -> Roots {
    for error in &loaded.errors {
        report(format!(
            "relay: could not read a platform root certificate store: {error}"
        ));
    }
    let mut store = rustls::RootCertStore::empty();
    let (_, unparsable) = store.add_parsable_certificates(loaded.certs);
    if unparsable > 0 {
        report(format!(
            "relay: skipped {unparsable} platform root certificates that would not parse"
        ));
    }
    if store.is_empty() {
        report("relay: the operating system TLS trust store contains no usable root certificates; install system CA certificates or the site's CA in that store; no bundled or file-root fallback is used".into());
    }
    Roots {
        complete: loaded.errors.is_empty() && unparsable == 0,
        store,
    }
}

struct Roots {
    store: rustls::RootCertStore,
    /// Every root the platform offered was read.
    complete: bool,
}

/// One configuration, built by the first connect while later ones wait for
/// it, and read again once it is `REFRESH_AFTER` old (`PARTIAL_REFRESH_AFTER`
/// for a read that reported errors). A platform that offered no roots is
/// asked again on the next connect.
struct Shared(Mutex<Option<(Instant, Duration, Arc<rustls::ClientConfig>)>>);

impl Shared {
    const fn new() -> Shared {
        Shared(Mutex::new(None))
    }

    fn config(&self, roots: impl FnOnce() -> Roots) -> Arc<rustls::ClientConfig> {
        self.config_at(Instant::now(), roots)
    }

    fn config_at(&self, now: Instant, roots: impl FnOnce() -> Roots) -> Arc<rustls::ClientConfig> {
        let mut shared = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some((read, keep_for, config)) = &*shared {
            if now.saturating_duration_since(*read) < *keep_for {
                return config.clone();
            }
        }
        let Roots { store, complete } = roots();
        let keep = !store.is_empty();
        let keep_for = if complete {
            REFRESH_AFTER
        } else {
            PARTIAL_REFRESH_AFTER
        };
        let config = Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(store)
                .with_no_client_auth(),
        );
        if keep {
            *shared = Some((now, keep_for, config.clone()));
        }
        config
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// One fixed root, so the tests do not depend on the host's store.
    fn one_root() -> Roots {
        let mut store = rustls::RootCertStore::empty();
        store.roots.push(rustls::pki_types::TrustAnchor {
            subject: rustls::pki_types::Der::from_slice(b"subject"),
            subject_public_key_info: rustls::pki_types::Der::from_slice(b"key"),
            name_constraints: None,
        });
        Roots {
            store,
            complete: true,
        }
    }

    fn no_roots() -> Roots {
        Roots {
            store: rustls::RootCertStore::empty(),
            complete: true,
        }
    }

    #[test]
    fn an_empty_native_store_is_diagnosed_without_fallback_roots() {
        let mut messages = Vec::new();
        let roots = roots_from_native(Default::default(), |message| messages.push(message));
        assert!(roots.store.is_empty());
        assert!(messages
            .iter()
            .any(|message| message.contains("no usable root certificates")));
        assert!(messages
            .iter()
            .any(|message| message.contains("no bundled or file-root fallback")));

        let mut loaded = rustls_native_certs::CertificateResult::default();
        loaded.certs.push(rustls::pki_types::CertificateDer::from(
            include_bytes!("../../tests/fixtures/platform-tls/ca.der").to_vec(),
        ));
        messages.clear();
        let roots = roots_from_native(loaded, |message| messages.push(message));
        assert_eq!(roots.store.len(), 1);
        assert!(messages.is_empty());
    }

    #[test]
    fn file_root_overrides_are_refused_without_reading_them() {
        assert!(platform_root_environment_is_safe_with(|_| None));
        assert!(platform_root_environment_is_safe_with(|_| Some("".into())));
        for name in ["SSL_CERT_FILE", "SSL_CERT_DIR"] {
            assert!(!platform_root_environment_is_safe_with(|key| {
                (key == name).then(|| "unused-test-root-path".into())
            }));
        }
    }

    #[tokio::test]
    async fn websocket_override_child_refuses_before_tcp_and_reports_once() {
        if std::env::var("RELAY_WS_OVERRIDE_CHILD").as_deref() != Ok("1") {
            return;
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        for _ in 0..2 {
            let result = tokio::time::timeout(
                Duration::from_secs(1),
                connect(format!("wss://{}/", listener.local_addr().unwrap()), None),
            )
            .await
            .expect("override must refuse without a network wait");
            assert!(
                matches!(result, Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::PermissionDenied)
            );
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        }
        // A direct shared-config caller must neither load file roots nor log again.
        let _ = connector();
    }

    #[test]
    fn websocket_overrides_refuse_before_tcp_without_reconnect_log_spam() {
        for name in ["SSL_CERT_FILE", "SSL_CERT_DIR"] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "relay::websocket_tls::tests::websocket_override_child_refuses_before_tcp_and_reports_once", "--nocapture"])
                .env_remove("SSL_CERT_FILE")
                .env_remove("SSL_CERT_DIR")
                .env("RELAY_WS_OVERRIDE_CHILD", "1")
                .env(name, "synthetic-unsupported-file-root")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
            assert_eq!(
                String::from_utf8_lossy(&output.stderr)
                    .matches("relay: file-selected TLS roots are unsupported")
                    .count(),
                1
            );
        }
    }

    #[test]
    fn concurrent_first_connects_read_the_roots_once() {
        let shared = Arc::new(Shared::new());
        let loads = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (shared, loads, start) = (shared.clone(), loads.clone(), start.clone());
                std::thread::spawn(move || {
                    start.wait();
                    shared.config(|| {
                        loads.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(20));
                        one_root()
                    })
                })
            })
            .collect();
        let configs: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        assert!(configs
            .iter()
            .all(|config| Arc::ptr_eq(config, &configs[0])));
    }

    #[test]
    fn no_roots_are_asked_for_again() {
        let shared = Shared::new();
        let loads = AtomicUsize::new(0);
        let load = |roots: fn() -> Roots| {
            loads.fetch_add(1, Ordering::SeqCst);
            roots()
        };
        shared.config(|| load(no_roots));
        shared.config(|| load(one_root));
        shared.config(|| load(one_root));
        assert_eq!(loads.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_read_with_errors_is_reused_then_read_again_sooner() {
        let shared = Shared::new();
        let loads = AtomicUsize::new(0);
        let partial = || {
            loads.fetch_add(1, Ordering::SeqCst);
            Roots {
                complete: false,
                ..one_root()
            }
        };
        let start = Instant::now();
        let first = shared.config_at(start, partial);
        let kept = shared.config_at(start + PARTIAL_REFRESH_AFTER / 2, partial);
        assert!(Arc::ptr_eq(&first, &kept));
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        let again = shared.config_at(start + PARTIAL_REFRESH_AFTER, partial);
        assert!(!Arc::ptr_eq(&first, &again));
        assert_eq!(loads.load(Ordering::SeqCst), 2);
        assert!(PARTIAL_REFRESH_AFTER > Duration::ZERO && PARTIAL_REFRESH_AFTER < REFRESH_AFTER);
    }

    #[test]
    fn the_roots_are_read_again_once_old() {
        let shared = Shared::new();
        let start = Instant::now();
        let first = shared.config_at(start, one_root);
        let kept = shared.config_at(start + REFRESH_AFTER / 2, one_root);
        assert!(Arc::ptr_eq(&first, &kept));
        let refreshed = shared.config_at(start + REFRESH_AFTER, one_root);
        assert!(!Arc::ptr_eq(&first, &refreshed));
    }

    /// Reads the host's store: on a host with no roots (a minimal container)
    /// nothing is kept, and there is nothing to share.
    #[test]
    fn every_connect_shares_one_configuration() {
        let roots = native_roots();
        if !roots.complete || roots.store.is_empty() {
            return;
        }
        let (Connector::Rustls(first), Connector::Rustls(second)) = (connector(), connector())
        else {
            panic!("a rustls connector");
        };
        assert!(Arc::ptr_eq(&first, &second));
    }
}
