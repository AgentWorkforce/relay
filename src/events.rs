use std::io::{self, Write};

use anyhow::Result;
use chrono::Utc;
use serde::Serialize;
use serde_json::json;
use tracing_subscriber::{fmt, EnvFilter};

use crate::config::Config;

pub fn init_logging(cfg: &Config) -> Result<()> {
    let filter =
        EnvFilter::try_new(cfg.log_level.clone()).unwrap_or_else(|_| EnvFilter::new("info"));
    let subscriber = fmt::Subscriber::builder()
        .with_env_filter(filter)
        .with_target(true)
        .with_ansi(true)
        .finish();

    tracing::subscriber::set_global_default(subscriber)?;

    if let Some(path) = &cfg.log_file {
        tracing::warn!(target = "relay_broker::logging", file = %path, "--log-file is currently accepted but not persisted in this build");
    }

    Ok(())
}

#[derive(Clone, Debug)]
pub struct EventEmitter {
    json_output: bool,
}

impl EventEmitter {
    pub fn new(json_output: bool) -> Self {
        Self { json_output }
    }

    pub fn emit<T: Serialize>(&self, event_type: &str, payload: T) {
        if !self.json_output {
            return;
        }

        let line = json!({
            "ts": Utc::now().to_rfc3339(),
            "type": event_type,
            "payload": payload,
        });

        let mut stderr = io::stderr().lock();
        let _ = writeln!(stderr, "{}", line);
    }
}

#[cfg(test)]
mod tests {
    use super::EventEmitter;
    use serde_json::json;

    #[test]
    fn emit_disabled_is_noop() {
        let emitter = EventEmitter::new(false);
        emitter.emit("test", json!({"key": "value"}));
    }

    #[test]
    fn emit_enabled_no_panic() {
        let emitter = EventEmitter::new(true);
        emitter.emit("connection", json!({"status": "connected"}));
        emitter.emit("inject_result", "plain string payload");
        emitter.emit("backpressure", 42);
    }
}
