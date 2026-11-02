//! The TLS client configuration every WebSocket the core opens shares.
//!
//! Trust comes from the platform's root certificates. Reading them walks the
//! keychain and evaluates each certificate's trust settings on macOS, so they
//! are read once per process and the configuration is handed to every
//! connect, instead of tokio-tungstenite reading them again on each one.

use std::sync::{Arc, Mutex};
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

/// The connector for a `wss://` (or plain `ws://`) connect.
pub fn connector() -> Connector {
    static SHARED: Shared = Shared::new();
    Connector::Rustls(SHARED.config(native_roots))
}

fn native_roots() -> rustls::RootCertStore {
    let mut roots = rustls::RootCertStore::empty();
    roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
    roots
}

/// One configuration, built by the first connect while later ones wait for
/// it. A platform that offered no roots is asked again on the next connect.
struct Shared(Mutex<Option<Arc<rustls::ClientConfig>>>);

impl Shared {
    const fn new() -> Shared {
        Shared(Mutex::new(None))
    }

    fn config(&self, roots: impl FnOnce() -> rustls::RootCertStore) -> Arc<rustls::ClientConfig> {
        let mut shared = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(config) = &*shared {
            return config.clone();
        }
        let roots = roots();
        let found = !roots.is_empty();
        let config = Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );
        if found {
            *shared = Some(config.clone());
        }
        config
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn one_root() -> rustls::RootCertStore {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(native_roots().roots.into_iter().take(1));
        roots
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
        let load = |roots: fn() -> rustls::RootCertStore| {
            loads.fetch_add(1, Ordering::SeqCst);
            roots()
        };
        shared.config(|| load(rustls::RootCertStore::empty));
        shared.config(|| load(one_root));
        shared.config(|| load(one_root));
        assert_eq!(loads.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn every_connect_shares_one_configuration() {
        let (Connector::Rustls(first), Connector::Rustls(second)) = (connector(), connector())
        else {
            panic!("a rustls connector");
        };
        assert!(Arc::ptr_eq(&first, &second));
    }
}
