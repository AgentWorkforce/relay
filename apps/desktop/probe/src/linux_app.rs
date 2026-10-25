//! The Linux and Windows app (`agent-relay-desktop`). Everything but `ui` builds and tests on
//! any Unix without GTK; `ui`, the window, needs the `gtk` feature.
//!
//! | Module | Owns |
//! |---|---|
//! | `prefs` | The app's own preferences (`desktop.json`): appearance, automatic update checks |
//! | `install` | Where this install lives: its kind, tree, per-user root and bundled core |
//! | `updates` | Software updates from the public GitHub release; the per-user launcher entry |
//! | `bridge` | The client of the relay core: handshake, events, pooled typed calls, reconnects |
//! | `host` | The core the app hosts as its child when no other answers |
//! | `service` | The `agent-relay.service` systemd user unit |
//! | `fake_core` | An in-process fake of the core's socket, for tests and `agent-relay-fake-core` |
//! | `models` | The view layer's words: what the app says about the core's typed answers, with the Mac's wording |
//! | `ui` | The GTK 4 window, with the `gtk` feature |

pub mod bridge;
pub mod fake_core;
pub mod host;
pub mod install;
pub mod launch;
pub mod models;
pub mod prefs;
pub mod service;
#[cfg(feature = "gtk")]
pub mod ui;
pub mod updates;

/// Capy is used on this computer: its device connector creates `~/.capy`
/// on a paired computer. The Mac also looks for `Capy.app`.
pub fn capy_installed(home: &std::path::Path) -> bool {
    home.join(".capy").is_dir()
}

/// Whether a stored JSON value counts as set: `null`, `false`, zero, and
/// empty strings, arrays and objects do not.
fn truthy(value: &serde_json::Value) -> bool {
    use serde_json::Value;
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(fields) => !fields.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn capy_is_detected_by_its_connector_directory() {
        let home = tempfile::tempdir().unwrap();
        assert!(!super::capy_installed(home.path()));
        std::fs::write(home.path().join(".capy"), "").unwrap();
        assert!(
            !super::capy_installed(home.path()),
            "a file named .capy is not the connector's directory"
        );
        std::fs::remove_file(home.path().join(".capy")).unwrap();
        std::fs::create_dir(home.path().join(".capy")).unwrap();
        assert!(super::capy_installed(home.path()));
    }
}
