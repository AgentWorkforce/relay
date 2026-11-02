//! The TLS client configuration every WebSocket the core opens shares.
//!
//! Trust comes from the platform's root certificates. Reading them walks the
//! keychain and evaluates each certificate's trust settings on macOS, so they
//! are read once and the configuration is handed to every connect, instead
//! of tokio-tungstenite reading them again on each one. The configuration is
//! read again after `REFRESH_AFTER`, so a CA added to or removed from the
//! platform store (a corporate or development proxy's) applies without a
//! restart; a read that reported errors is not kept.

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
    tokio_tungstenite::connect_async_tls_with_config(request, config, false, Some(connector()))
        .await
}

/// How long one read of the platform's roots is kept.
const REFRESH_AFTER: Duration = Duration::from_secs(10 * 60);

/// The connector for a `wss://` (or plain `ws://`) connect.
pub fn connector() -> Connector {
    static SHARED: Shared = Shared::new();
    Connector::Rustls(SHARED.config(native_roots))
}

/// The platform's roots, and whether they were all read: a load error or a
/// certificate that would not parse is logged, and that read is not kept.
fn native_roots() -> Roots {
    let loaded = rustls_native_certs::load_native_certs();
    for error in &loaded.errors {
        crate::relay::diagnostics::write(format_args!(
            "relay: could not read a platform root certificate store: {error}"
        ));
    }
    let mut store = rustls::RootCertStore::empty();
    let (_, unparsable) = store.add_parsable_certificates(loaded.certs);
    if unparsable > 0 {
        crate::relay::diagnostics::write(format_args!(
            "relay: skipped {unparsable} platform root certificates that would not parse"
        ));
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
/// it, and read again once it is `REFRESH_AFTER` old. A platform that
/// offered no roots, or reported errors, is asked again on the next connect.
struct Shared(Mutex<Option<(Instant, Arc<rustls::ClientConfig>)>>);

impl Shared {
    const fn new() -> Shared {
        Shared(Mutex::new(None))
    }

    fn config(&self, roots: impl FnOnce() -> Roots) -> Arc<rustls::ClientConfig> {
        self.config_at(Instant::now(), roots)
    }

    fn config_at(&self, now: Instant, roots: impl FnOnce() -> Roots) -> Arc<rustls::ClientConfig> {
        let mut shared = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some((read, config)) = &*shared {
            if now.saturating_duration_since(*read) < REFRESH_AFTER {
                return config.clone();
            }
        }
        let Roots { store, complete } = roots();
        let keep = complete && !store.is_empty();
        let config = Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(store)
                .with_no_client_auth(),
        );
        if keep {
            *shared = Some((now, config.clone()));
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
    fn a_read_with_errors_is_asked_for_again() {
        let shared = Shared::new();
        let loads = AtomicUsize::new(0);
        let partial = || Roots {
            complete: false,
            ..one_root()
        };
        shared.config(|| {
            loads.fetch_add(1, Ordering::SeqCst);
            partial()
        });
        shared.config(|| {
            loads.fetch_add(1, Ordering::SeqCst);
            one_root()
        });
        shared.config(|| {
            loads.fetch_add(1, Ordering::SeqCst);
            one_root()
        });
        assert_eq!(loads.load(Ordering::SeqCst), 2);
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
