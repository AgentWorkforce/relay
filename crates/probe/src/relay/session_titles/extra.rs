//! Native metadata routes for the other harnesses. Unsupported routes never
//! fall back to an agent prompt or a label stored only in Relay.
use super::{supported, unsupported};
use crate::relay::contract::agents::SessionTitleCapability;
use crate::relay::local::LocalConfig;
use crate::relay::process::ProcessTable;
use crate::relay::store::is_uuid;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub fn capability(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    source: &str,
    id: &str,
) -> SessionTitleCapability {
    match source {
        "pi" if crate::relay::pi::can_set_title(&config.pi, table, config.uid, id) => supported(),
        "pi" => unsupported("Open this Pi session and run /reload to enable title editing."),
        "grok" if grok_binding(config, table, id).is_some() => supported(),
        "grok" => unsupported("Connect this Grok session to Agent Relay with its leader running to edit its title."),
        "openclaw" if openclaw_identity(config, id).is_some() && config.openclaw.as_ref().is_some_and(|c| crate::relay::openclaw::gateway(c).is_ok()) => supported(),
        "openclaw" => unsupported("Connect the OpenClaw Gateway to edit a conversation title. Agent names are separate."),
        "hermes" if hermes_session(config, id).is_some() && hermes_executable().is_some() => supported(),
        "hermes" => unsupported("Install Hermes and keep this session in a configured local Hermes profile to edit its title."),
        "muse" => unsupported("Muse only allows its owning session host to rename this session. Rename it in Muse with /name."),
        "devin" if devin_title(&config.devin.cli().join("sessions.db"), id).is_some() => supported(),
        "devin" => unsupported("This Devin Cloud session has no local title record. Rename it in Devin."),
        "cursor" => unsupported("Cursor does not expose a title-editing API to Agent Relay. Rename this session in Cursor."),
        "omp" => unsupported("Oh My Pi does not expose a title-editing route to Agent Relay yet. Rename this session in Oh My Pi."),
        "antigravity" => unsupported("Antigravity does not expose a title-editing route to Agent Relay yet. Rename this session in Antigravity."),
        "capy" => unsupported("Capy does not expose a title-editing route to Agent Relay yet. Rename this thread in Capy."),
        "replicas" => unsupported("Replicas does not expose a title-editing route to Agent Relay yet."),
        "cursor-cloud" => unsupported("Rename this agent in Cursor Cloud."),
        _ => unsupported("This harness does not expose a title-editing route to Agent Relay yet."),
    }
}

pub fn set(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    source: &str,
    id: &str,
    title: &str,
) -> Result<String, String> {
    let available = capability(config, table, source, id);
    if !available.supported {
        return Err(available.reason.unwrap_or_default());
    }
    match source {
        "pi" => crate::relay::pi::set_title(&config.pi, table, config.uid, id, title),
        "grok" => grok_set(config, table, id, title),
        "openclaw" => openclaw_set(config, id, title),
        "hermes" => hermes_set(config, id, title),
        "devin" => devin_set(&config.devin.cli().join("sessions.db"), id, title),
        _ => Err("This harness cannot update the original session title.".into()),
    }
}

fn grok_binding(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    id: &str,
) -> Option<crate::relay::existing_session::Binding> {
    if !is_uuid(id) {
        return None;
    }
    let existing = config
        .existing_grok
        .as_ref()
        .filter(|p| p.bindings.is_dir())
        .and_then(|p| crate::relay::existing_session::enablement::Registry::open(&p.bindings).ok())
        .and_then(|r| r.stored(id).ok().flatten());
    let spawned = config
        .spawned_grok
        .as_ref()
        .and_then(|p| crate::relay::harness::grok::read_spawned_record(p, id))
        .map(|r| r.binding);
    [existing, spawned].into_iter().flatten().find(|binding| {
        binding.session_id == id
            && binding.owner_uid == config.uid
            && crate::relay::existing_session::grok::verify_title_binding(table, binding)
    })
}

fn grok_set(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    id: &str,
    title: &str,
) -> Result<String, String> {
    use crate::relay::existing_session::grok::{verify_title_binding, LeaderClient};
    let binding =
        grok_binding(config, table, id).ok_or("The Grok session is no longer connected.")?;
    let mut client = LeaderClient::start(&binding.executable, &binding.socket_path, &binding.cwd)
        .ok_or("Could not connect to the Grok session.")?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let Some(Ok(initialized)) = client.initialize(deadline) else {
        return Err("Grok did not accept the connection.".into());
    };
    if initialized["protocolVersion"] != 1 || !verify_title_binding(table, &binding) {
        return Err("The Grok session connection changed. Try again.".into());
    }
    // This is the same metadata RPC Grok's /rename uses. It never loads or prompts a session.
    match client.request(
        "x.ai/session/rename",
        json!({"sessionId":id,"title":title,"cwd":binding.cwd}),
        deadline,
    ) {
        Some(Ok(_)) => Ok(title.to_owned()),
        Some(Err(_)) => Err(
            "This Grok version could not rename the session. Update Grok or rename it there."
                .into(),
        ),
        None => {
            Err("Grok did not confirm the title. Check the session before trying again.".into())
        }
    }
}

// Source IDs are conversation keys namespaced by the native state root and
// agent, not upstream transcript UUIDs. Match the pinned history provider's
// identity, then prove the gateway window exists in that local agent store.
fn openclaw_identity(config: &LocalConfig, id: &str) -> Option<(PathBuf, String, String)> {
    let (root, custom) = config
        .openclaw
        .as_ref()?
        .title_history_root(&config.devin.home)?;
    let local = if custom {
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(root.as_os_str().as_encoded_bytes());
        let prefix: String = hash[..6].iter().map(|b| format!("{b:02x}")).collect();
        id.strip_prefix(&format!("root-{prefix}:"))?
    } else {
        id
    };
    let (agent, name) = local.split_once(':')?;
    if agent.is_empty()
        || agent.starts_with('.')
        || name.is_empty()
        || !agent
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return None;
    }
    Some((root, agent.to_owned(), name.to_owned()))
}

fn openclaw_set(config: &LocalConfig, id: &str, title: &str) -> Result<String, String> {
    use crate::relay::openclaw::{gateway, Connection};
    let (root, agent, name) = openclaw_identity(config, id)
        .ok_or("This conversation does not belong to the configured local OpenClaw Gateway.")?;
    let config = config.openclaw.as_ref().ok_or("OpenClaw is unavailable.")?;
    let gateway = gateway(config).map_err(|e| e.reason())?;
    let mut connection =
        Connection::open(config, &gateway).map_err(|_| "Could not connect to OpenClaw.")?;
    let listed = connection
        .call("sessions.list", json!({"limit":10000}))
        .map_err(|_| "Could not find this conversation in OpenClaw.")?;
    let legacy = root
        .join("agents")
        .join(&agent)
        .join("agent/openclaw-agent.sqlite")
        .try_exists()
        .is_ok_and(|exists| !exists);
    let (key, native) = openclaw_key(&listed, &agent, &name, legacy)
        .filter(|(key, native)| openclaw_local_window(&root, &agent, key, native))
        .ok_or("This conversation is unavailable or ambiguous in the local OpenClaw store.")?;
    let result = connection
        .call(
            "sessions.patch",
            json!({"key":key,"label":title,"expectedSessionId":native}),
        )
        .map_err(|_| {
            "OpenClaw could not confirm the title. Check the conversation before trying again."
        })?;
    if result["ok"].as_bool() == Some(false) {
        return Err("OpenClaw rejected the title.".into());
    }
    Ok(title.to_owned())
}

fn openclaw_key(listed: &Value, agent: &str, name: &str, legacy: bool) -> Option<(String, String)> {
    use sha2::{Digest, Sha256};
    let mut found = listed["sessions"].as_array()?.iter().filter_map(|s| {
        let key = s["key"].as_str()?;
        let native = s["sessionId"].as_str().filter(|id| is_uuid(id))?;
        let own = format!("agent:{agent}:");
        let rest = key.strip_prefix(&own)?;
        if rest.is_empty() || rest.starts_with(':') {
            return None;
        }
        // Isolated cron runs are grouped into the job by history. Never rename
        // one run while claiming the whole conversation was changed.
        let parts: Vec<_> = rest.split(':').collect();
        if parts.len() == 4
            && parts[0].eq_ignore_ascii_case("cron")
            && parts[2].eq_ignore_ascii_case("run")
        {
            return None;
        }
        let mut ledger_name = if rest.starts_with("key=") || rest.starts_with("sha=") {
            format!("key={key}")
        } else {
            rest.to_owned()
        };
        if ledger_name.len() > 512
            || ledger_name.trim() != ledger_name
            || ledger_name.chars().any(char::is_control)
        {
            let hash: String = Sha256::digest(key.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            ledger_name = format!("sha={hash}");
        }
        (if legacy {
            name == native
        } else {
            name == ledger_name
        })
        .then(|| (key.to_owned(), native.to_owned()))
    });
    let first = found.next()?;
    found.next().is_none().then_some(first)
}

fn openclaw_local_window(root: &Path, agent: &str, key: &str, native: &str) -> bool {
    let agent_home = root.join("agents").join(agent);
    let path = agent_home.join("agent/openclaw-agent.sqlite");
    let contained = |path: &Path| {
        root.canonicalize()
            .ok()
            .zip(path.canonicalize().ok())
            .is_some_and(|(root, path)| path.starts_with(root))
    };
    if contained(&path) {
        if let Ok(db) =
            rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        {
            let _ = db.busy_timeout(Duration::from_millis(250));
            if db
                .query_row(
                    "SELECT 1 FROM session_windows WHERE session_id=?1 AND session_key=?2",
                    [native, key],
                    |_| Ok(()),
                )
                .is_ok()
            {
                return true;
            }
        }
    }
    let index = agent_home.join("sessions/sessions.json");
    if !contained(&index) || !index.metadata().is_ok_and(|m| m.len() <= 16 * 1024 * 1024) {
        return false;
    }
    std::fs::read(&index)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|index| index[key]["sessionId"].as_str() == Some(native))
}

// Devin CLI stores the native title in this column (the same field its own
// session_db updater writes). Never create a database or touch conversation
// activity timestamps. Cloud IDs have no local rename route.
fn devin_title(path: &Path, id: &str) -> Option<String> {
    if crate::relay::devin_cloud::is_cloud_session_id(id) || id.is_empty() {
        return None;
    }
    let db = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    db.busy_timeout(Duration::from_millis(250)).ok()?;
    db.query_row(
        "SELECT COALESCE(title, '') FROM sessions WHERE id = ?1",
        [id],
        |r| r.get(0),
    )
    .ok()
}

fn devin_set(path: &Path, id: &str, title: &str) -> Result<String, String> {
    if devin_title(path, id).is_none() {
        return Err("The local Devin session is unavailable.".into());
    }
    let mut db = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "Could not open Devin's session metadata.")?;
    db.busy_timeout(Duration::from_secs(2))
        .map_err(|_| "Could not open Devin's session metadata.")?;
    let transaction = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| "Devin is updating this session. Try again in a moment.")?;
    let changed = transaction
        .execute("UPDATE sessions SET title = ?1 WHERE id = ?2", [title, id])
        .map_err(|_| "Could not save the Devin title.")?;
    if changed != 1 {
        return Err("The Devin session identity changed. Try again.".into());
    }
    let saved: String = transaction
        .query_row("SELECT title FROM sessions WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .map_err(|_| "Could not verify the Devin title.")?;
    transaction
        .commit()
        .map_err(|_| "Could not finish saving the Devin title.")?;
    Ok(saved)
}

fn hermes_session(config: &LocalConfig, id: &str) -> Option<(PathBuf, String)> {
    config.hermes.as_ref()?;
    // Use the importer's own frozen resolver. Explicit HERMES_HOME roots have
    // hash identities even when they happen to name ~/.hermes; only a native
    // default root gets the portable default/profile namespaces.
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let roots = serde_json::to_value(ai_hist::ProviderRoots::from_env(home)).ok()?;
    let paths: Vec<PathBuf> =
        serde_json::from_value(roots["provider_roots"]["hermes"].clone()).ok()?;
    let default: Option<PathBuf> =
        serde_json::from_value(roots["provider_default_roots"]["hermes"].clone()).ok();
    hermes_catalog_session(&paths, default.as_deref(), id)
}

fn hermes_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hermes_catalog_session(
    roots: &[PathBuf],
    default: Option<&Path>,
    id: &str,
) -> Option<(PathBuf, String)> {
    let (namespace, encoded) = id.rsplit_once(':')?;
    let native = hermes_native_id(encoded)?;
    let mut matched = hermes_candidates(roots).into_iter().filter(|home| {
        hermes_namespace(home, default).as_deref() == Some(namespace)
            && hermes_title(home, &native).is_some()
    });
    let home = matched.next()?;
    if matched.next().is_some() {
        return None;
    }
    Some((home, native))
}

fn hermes_native_id(encoded: &str) -> Option<String> {
    if encoded.is_empty()
        || encoded.len() % 2 != 0
        || !encoded
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let bytes: Option<Vec<u8>> = encoded
        .as_bytes()
        .chunks_exact(2)
        .map(|chunk| u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok())
        .collect();
    let native = String::from_utf8(bytes?).ok()?;
    if native.trim().is_empty() || native.chars().any(char::is_control) {
        return None;
    }
    Some(native)
}

fn hermes_candidates(roots: &[PathBuf]) -> std::collections::BTreeSet<PathBuf> {
    let mut candidates = std::collections::BTreeSet::new();
    for root in roots {
        // Match the importer's state.db parent spelling, including removal of
        // a trailing separator before computing a custom-root namespace.
        let database = root.join("state.db");
        let Some(root) = database.parent() else {
            continue;
        };
        let trusted = match root.canonicalize() {
            Ok(path) => path,
            Err(_) => continue,
        };
        candidates.insert(root.to_path_buf());
        // Construct candidates from trusted roots, never by joining a decoded
        // profile path from the request (which could contain ../ or symlinks).
        if let Ok(entries) = std::fs::read_dir(root.join("profiles")) {
            for entry in entries.take(1024).flatten() {
                if entry.file_type().is_ok_and(|kind| kind.is_dir())
                    && entry
                        .path()
                        .canonicalize()
                        .is_ok_and(|path| path.starts_with(&trusted))
                {
                    candidates.insert(entry.path());
                }
            }
        }
    }
    candidates
}

fn hermes_namespace(home: &Path, default: Option<&Path>) -> Option<String> {
    use sha2::{Digest, Sha256};
    Some(match default {
        Some(default) if home == default => "default".to_owned(),
        Some(default) if home.starts_with(default.join("profiles")) => {
            let relative = home.strip_prefix(default.join("profiles")).ok()?;
            format!(
                "profile:{}",
                hermes_hex(relative.as_os_str().as_encoded_bytes())
            )
        }
        _ => format!(
            "root:{:x}",
            Sha256::digest(home.as_os_str().as_encoded_bytes())
        ),
    })
}

fn hermes_title(home: &Path, id: &str) -> Option<String> {
    let path = home.join("state.db");
    if !std::fs::symlink_metadata(&path).ok()?.file_type().is_file()
        || !path
            .canonicalize()
            .ok()?
            .starts_with(home.canonicalize().ok()?)
    {
        return None;
    }
    let db = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    db.busy_timeout(Duration::from_millis(250)).ok()?;
    // Exact ID prevents Hermes's human-friendly prefix/name resolution selecting another session.
    db.query_row(
        "SELECT COALESCE(title, '') FROM sessions WHERE id = ?1",
        [id],
        |r| r.get(0),
    )
    .ok()
}

fn hermes_executable() -> Option<PathBuf> {
    // Hermes is not offered on Windows (see `relay::hermes`).
    if cfg!(windows) {
        return None;
    }
    let mut paths = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        paths.push(PathBuf::from(home).join(".local/bin/hermes"));
    }
    paths.extend([
        PathBuf::from("/opt/homebrew/bin/hermes"),
        PathBuf::from("/usr/local/bin/hermes"),
    ]);
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(
            std::env::split_paths(&path)
                .filter(|p| p.is_absolute())
                .map(|p| p.join("hermes")),
        );
    }
    paths
        .into_iter()
        .find(|p| crate::platform::exe::is_executable(p))
}

fn hermes_set(config: &LocalConfig, id: &str, title: &str) -> Result<String, String> {
    use crate::relay::claude::{CommandRunner, RunOutcome, SystemRunner};
    if title.chars().count() > 100 {
        return Err("Hermes titles must be 100 characters or fewer.".into());
    }
    let (home, native_id) =
        hermes_session(config, id).ok_or("This Hermes session is unavailable or ambiguous.")?;
    let executable = hermes_executable().ok_or("Hermes is not installed.")?;
    let environment_home = home.clone();
    let runner = SystemRunner {
        environment: Some(std::sync::Arc::new(move |_, mut env| {
            env.insert(
                "HERMES_HOME".into(),
                environment_home.to_string_lossy().into_owned(),
            );
            env.remove("HERMES_PROFILE");
            env
        })),
    };
    let args = ["sessions", "rename", "--", native_id.as_str(), title].map(str::to_owned);
    let result = runner.run(&executable, &args, &[], Duration::from_secs(10));
    if matches!(result, RunOutcome::Exited { code: 0, .. }) {
        return hermes_title(&home, &native_id)
            .filter(|s| s == title)
            .ok_or_else(|| "Hermes did not confirm the requested title.".into());
    }
    Err("Hermes could not rename the session. The title may already be in use.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gateway_mapping_requires_exact_conversation_and_native_window() {
        let native = "11111111-1111-4111-8111-111111111111";
        let listed = json!({"sessions":[{"sessionId":native,"key":"agent:main:main"}]});
        assert_eq!(
            openclaw_key(&listed, "main", "main", false),
            Some(("agent:main:main".into(), native.into()))
        );
        assert!(openclaw_key(&listed, "other", "main", false).is_none());
        assert!(openclaw_key(&listed, "main", "other", false).is_none());
        assert!(openclaw_key(&json!({"sessions":[{"sessionId":native,"key":"agent:main:main"},{"sessionId":native,"key":"agent:main:main"}]}), "main", "main", false).is_none());
        assert!(openclaw_key(
            &json!({"sessions":[{"sessionId":native,"key":"agent:main:cron:job:run:one"}]}),
            "main",
            "cron:job",
            false
        )
        .is_none());
        assert!(openclaw_key(&listed, "main", native, false).is_none());
        assert!(openclaw_key(&listed, "main", native, true).is_some());
        let temp = tempfile::tempdir().unwrap();
        assert!(!openclaw_local_window(
            temp.path(),
            "main",
            "agent:main:main",
            native
        ));
        let dir = temp.path().join("agents/main/agent");
        std::fs::create_dir_all(&dir).unwrap();
        let db = rusqlite::Connection::open(dir.join("openclaw-agent.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE session_windows (session_id TEXT, session_key TEXT);")
            .unwrap();
        db.execute(
            "INSERT INTO session_windows VALUES (?1, ?2)",
            [native, "agent:main:main"],
        )
        .unwrap();
        assert!(openclaw_local_window(
            temp.path(),
            "main",
            "agent:main:main",
            native
        ));
        assert!(!openclaw_local_window(
            temp.path(),
            "main",
            "agent:main:other",
            native
        ));
    }
    #[test]
    fn devin_renames_only_the_exact_local_metadata_row() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("sessions.db");
        assert!(devin_set(&path, "real-gallium", "new").is_err());
        assert!(!path.exists());
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, last_activity_at INTEGER, transcript TEXT); INSERT INTO sessions VALUES ('real-gallium', 'Old', 42, 'retained'); INSERT INTO sessions VALUES ('other', 'Other', 9, 'other transcript');").unwrap();
        assert_eq!(devin_set(&path, "real-gallium", "New").unwrap(), "New");
        assert!(devin_set(&path, "real", "Wrong").is_err());
        assert_eq!(
            db.query_row(
                "SELECT last_activity_at FROM sessions WHERE id='real-gallium'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            42
        );
        assert_eq!(
            db.query_row(
                "SELECT transcript FROM sessions WHERE id='real-gallium'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "retained"
        );
        assert_eq!(devin_title(&path, "other").as_deref(), Some("Other"));
    }
    // Symlinks need a privilege on Windows that the test runner lacks.
    #[cfg(unix)]
    #[test]
    fn hermes_catalog_namespaces_resolve_exact_native_ids_in_trusted_roots() {
        use sha2::{Digest, Sha256};
        let root = tempfile::tempdir().unwrap();
        let default = root.path().join(".hermes");
        let profile = default.join("profiles/work");
        let custom = root.path().join("custom");
        for home in [&default, &profile, &custom] {
            std::fs::create_dir_all(home).unwrap();
            let db = rusqlite::Connection::open(home.join("state.db")).unwrap();
            db.execute_batch("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT); INSERT INTO sessions VALUES ('native-one', 'Original');").unwrap();
        }
        let roots = vec![default.clone(), custom.clone()];
        let native = hermes_hex(b"native-one");
        assert_eq!(
            hermes_catalog_session(&roots, Some(&default), &format!("default:{native}")),
            Some((default.clone(), "native-one".into()))
        );
        assert_eq!(
            hermes_catalog_session(
                &roots,
                Some(&default),
                &format!("profile:{}:{native}", hermes_hex(b"work"))
            ),
            Some((profile.clone(), "native-one".into()))
        );
        let hashed = format!(
            "root:{:x}:{native}",
            Sha256::digest(custom.as_os_str().as_encoded_bytes())
        );
        assert_eq!(
            hermes_catalog_session(&roots, Some(&default), &hashed),
            Some((custom.clone(), "native-one".into()))
        );
        let trailing_root = PathBuf::from(format!("{}/", custom.display()));
        assert_eq!(
            hermes_catalog_session(&[trailing_root], None, &hashed),
            Some((custom.clone(), "native-one".into()))
        );
        assert!(hermes_catalog_session(&roots, None, &format!("default:{native}")).is_none());
        assert!(hermes_catalog_session(
            &roots,
            None,
            &format!("profile:{}:{native}", hermes_hex(b"work"))
        )
        .is_none());
        assert!(hermes_catalog_session(
            &roots,
            None,
            &format!(
                "root:{:x}:{native}",
                Sha256::digest(profile.as_os_str().as_encoded_bytes())
            )
        )
        .is_some());
        for bad in [
            "native-one".to_owned(),
            "default:zz".to_owned(),
            format!("profile:{}:{native}", hermes_hex(b"../custom")),
            format!("default:{}", hermes_hex(b"native")),
        ] {
            assert!(hermes_catalog_session(&roots, Some(&default), &bad).is_none());
        }
        let escaped = default.join("profiles/escape");
        std::os::unix::fs::symlink(&custom, &escaped).unwrap();
        assert!(hermes_catalog_session(
            &roots,
            Some(&default),
            &format!("profile:{}:{native}", hermes_hex(b"escape"))
        )
        .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn hermes_rejects_database_and_profile_parent_symlink_escapes() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("hermes");
        let outside = root.path().join("outside");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(outside.join("work")).unwrap();
        let db = rusqlite::Connection::open(outside.join("work/state.db")).unwrap();
        db.execute_batch("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT); INSERT INTO sessions VALUES ('one', 'Outside');").unwrap();
        std::os::unix::fs::symlink(outside.join("work/state.db"), home.join("state.db")).unwrap();
        assert!(hermes_title(&home, "one").is_none());
        std::os::unix::fs::symlink(&outside, home.join("profiles")).unwrap();
        assert!(hermes_catalog_session(
            &[home.clone()],
            Some(&home),
            &format!("profile:{}:{}", hermes_hex(b"work"), hermes_hex(b"one"))
        )
        .is_none());
    }

    #[test]
    fn hermes_lookup_is_exact_and_never_creates_a_store() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(hermes_title(home.path(), "one"), None);
        assert!(!home.path().join("state.db").exists());
        let db = rusqlite::Connection::open(home.path().join("state.db")).unwrap();
        db.execute_batch("CREATE TABLE sessions (id TEXT, title TEXT); INSERT INTO sessions VALUES ('one', 'Original');").unwrap();
        assert_eq!(
            hermes_title(home.path(), "one").as_deref(),
            Some("Original")
        );
        assert_eq!(hermes_title(home.path(), "on"), None);
        assert_eq!(hermes_title(home.path(), "Original"), None);
    }
}
