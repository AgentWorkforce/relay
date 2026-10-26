use crate::config::{normalize_origin, ConfigStore, LocalEngine};
use anyhow::Result;

/// Describe the embedded local message engine. The probe API and the message
/// engine deliberately share one loopback listener, so local mode requires no
/// Node runtime, container daemon, or separately installed service.
pub fn initialize(store: &ConfigStore, port: u16) -> Result<(String, LocalEngine)> {
    let origin = normalize_origin(&format!("http://127.0.0.1:{port}"))?;
    Ok((
        origin,
        LocalEngine {
            port,
            pid: None,
            database: store.root().join("local-messages.jsonl"),
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_engine_is_bound_to_the_probe_and_relay_home() {
        let store = ConfigStore::new(std::path::PathBuf::from("/tmp/example-relay-home"));
        let (origin, engine) = initialize(&store, 32123).unwrap();
        assert_eq!(origin, "http://127.0.0.1:32123");
        assert_eq!(engine.port, 32123);
        assert_eq!(
            engine.database,
            std::path::PathBuf::from("/tmp/example-relay-home/local-messages.jsonl")
        );
    }
}
