//! Native title metadata mutations. No provider receives a model prompt and no
//! Relay-only alias is persisted. UI clients may optimistically display a title,
//! but success means the provider acknowledged its own metadata change.

pub(crate) mod claude;
pub mod extra;
pub(crate) mod opencode;

use crate::relay::contract::agents::{
    SessionTitleCapability, SessionTitleSetParams, SessionTitleUpdated,
};
use crate::relay::daemon::Core;
use crate::relay::local::LocalConfig;
use crate::relay::process::ProcessTable;
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::state::Listing;
use std::sync::Arc;

pub fn unsupported(reason: impl Into<String>) -> SessionTitleCapability {
    SessionTitleCapability {
        supported: false,
        reason: Some(reason.into()),
    }
}
pub fn supported() -> SessionTitleCapability {
    SessionTitleCapability {
        supported: true,
        reason: None,
    }
}

pub fn validate_identity(source: &str, id: &str) -> Result<(), RpcError> {
    if source.is_empty()
        || source.len() > 64
        || !source
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b == b'-' || b.is_ascii_digit())
        || id.is_empty()
        || id.len() > 512
        || id.chars().any(char::is_control)
    {
        return Err(RpcError::invalid_params(
            "Give a valid session source and session id.",
        ));
    }
    Ok(())
}

pub fn validate_title(title: &str) -> Result<String, RpcError> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 200 || title.chars().any(|ch| ch.is_control() || matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{200b}' | '\u{feff}')) {
        return Err(RpcError::invalid_params("Enter a title of 1–200 characters without control characters."));
    }
    Ok(title.to_owned())
}

pub fn capability(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    source: &str,
    id: &str,
) -> SessionTitleCapability {
    if validate_identity(source, id).is_err() {
        return unsupported("This session has an invalid identity.");
    }
    match source {
        "codex" => {
            if config.codex.executable.is_none() {
                return unsupported("Install Codex to edit this session title.");
            }
            if crate::relay::codex::threads::contains_unarchived(&config.codex, id) != Some(true) {
                return unsupported("This Codex thread is unavailable or archived.");
            }
            supported()
        }
        "claude" => claude::capability(&config.claude, id),
        "opencode" => opencode::capability(config, table, id),
        _ => extra::capability(config, table, source, id),
    }
}

pub fn set(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    source: &str,
    id: &str,
    title: &str,
) -> Result<String, String> {
    validate_identity(source, id).map_err(|e| e.message)?;
    let title = validate_title(title).map_err(|e| e.message)?;
    match source {
        "codex" => {
            use crate::relay::codex::{
                app_server,
                runner::{CodexRunner, SystemRunner},
            };
            let status = capability(config, table, source, id);
            if !status.supported {
                return Err(status.reason.unwrap_or_default());
            }
            let executable = config
                .codex
                .executable
                .as_ref()
                .ok_or("Codex is not installed.")?;
            let mut stream = SystemRunner
                .proxy_in_home(executable, &config.codex.home, &config.codex.sqlite_home)
                .map_err(|_| "Could not connect to Codex. Open Codex and try again.".to_string())?;
            app_server::set_thread_name(stream.as_mut(), id, &title, app_server::SEND_TIMEOUT)?;
            Ok(title)
        }
        "claude" => claude::set(&config.claude, id, &title),
        "opencode" => opencode::set(config, table, id, &title),
        _ => extra::set(config, table, source, id, &title),
    }
}

pub async fn set_native_title(
    core: &Arc<Core>,
    params: SessionTitleSetParams,
) -> Result<SessionTitleUpdated, RpcError> {
    validate_identity(&params.source, &params.session_id)?;
    let title = validate_title(&params.title)?;
    let key = format!("title:{}:{}", params.source, params.session_id);
    let guard = core.target_locks.get(&key).lock_owned().await;
    let sessions = core.plugins.sessions.clone();
    let source = params.source.clone();
    let id = params.session_id.clone();
    // Keep the native write AND its snapshot publication under the same lock.
    // This also completes publication if the requesting client disconnects.
    let published = core.clone();
    let title = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let title = sessions.set_title(&source, &id, &title)?;
        publish_title(&published, &source, &id, &title);
        Ok::<_, String>(title)
    })
    .await
    .map_err(|_| RpcError::new(ErrorKind::Internal, "Could not update the session title."))?
    .map_err(|message| RpcError::new(ErrorKind::Internal, message))?;
    Ok(SessionTitleUpdated { title })
}

fn publish_title(core: &Core, source: &str, id: &str, title: &str) {
    let mut snapshot = core
        .session_snapshot
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    patch_snapshot(&mut snapshot, source, id, title);
    drop(snapshot);
    core.hub.invalidated(Listing::Sessions);
    core.hub.invalidated(Listing::Uploader);
}

fn patch_snapshot(
    snapshot: &mut (u64, Vec<crate::relay::sessions::DiscoveredSession>),
    source: &str,
    id: &str,
    title: &str,
) {
    // Discovery started before this native mutation must not overwrite it.
    snapshot.0 = snapshot.0.wrapping_add(1);
    for session in &mut snapshot.1 {
        if session.target.kind.source() == source && session.target.id == id {
            session.title = title.to_owned();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publication_fences_stale_discovery_and_only_changes_exact_identity() {
        use crate::relay::{
            sessions::DiscoveredSession,
            store::{SessionKind, Target},
        };
        let row = |kind, id: &str| DiscoveredSession {
            target: Target::new(kind, id),
            title: "Original".into(),
            directory: None,
            updated_at_ms: Some(42),
            host: None,
            live: true,
            holder: None,
        };
        let mut snapshot = (
            7,
            vec![
                row(SessionKind::Codex, "one"),
                row(SessionKind::ClaudeTerminal, "one"),
                row(SessionKind::Codex, "two"),
            ],
        );
        let in_flight_generation = snapshot.0;
        patch_snapshot(&mut snapshot, "codex", "one", "First");
        assert_ne!(snapshot.0, in_flight_generation);
        patch_snapshot(&mut snapshot, "codex", "one", "Second");
        assert_eq!(snapshot.0, 9);
        assert_eq!(
            snapshot
                .1
                .iter()
                .map(|s| s.title.as_str())
                .collect::<Vec<_>>(),
            ["Second", "Original", "Original"]
        );
        assert!(snapshot.1.iter().all(|s| s.updated_at_ms == Some(42)));
        patch_snapshot(&mut snapshot, "codex", "history-only", "History");
        assert_eq!(snapshot.0, 10);
    }

    #[test]
    fn validates_titles_without_changing_literal_text() {
        assert_eq!(
            validate_title("  Fix \"login\" $(whoami)  ").unwrap(),
            "Fix \"login\" $(whoami)"
        );
        for bad in [
            "",
            "  ",
            "hello\nworld",
            "foo\0",
            "\u{202e}evil",
            "\u{200b}",
        ] {
            assert!(validate_title(bad).is_err());
        }
        assert!(validate_title(&"é".repeat(200)).is_ok());
        assert!(validate_title(&"é".repeat(201)).is_err());
    }
    #[test]
    fn validates_identity_before_any_provider_action() {
        for (source, id) in [
            ("", "id"),
            ("Codex", "id"),
            ("codex", ""),
            ("../codex", "id"),
            ("claude", "foo\nbar"),
        ] {
            assert!(validate_identity(source, id).is_err());
        }
        assert!(validate_identity("openclaw", "main:workspace:id").is_ok());
    }
}
