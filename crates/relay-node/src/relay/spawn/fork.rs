//! Forking: a spawn that starts as a copy of another agent's session on
//! this computer (`fork_from`), in that session's folder, with its whole
//! conversation, through the harness's own fork (`claude --resume
//! --fork-session`, Codex's `thread/fork`, Grok's `_x.ai/session/fork`).
//! The original session is left as it was. Only the verified machine owner
//! may fork, since the copy hands the source's transcript to whoever asked.

use super::invoke::SpawnError;
use super::launch::DirectoryError;
use super::report_back;
use super::wire::{HarnessId, SpawnRequest};
use crate::relay::daemon::Core;
use crate::relay::harness::{claude, codex, grok};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Harnesses whose spawns can start as a copy of a session.
pub fn supported(harness: HarnessId) -> bool {
    [claude::ID, codex::ID, grok::ID].contains(&harness)
}

/// A fork whose source's folder is gone. It names no path: the folder came
/// from the source session, not from whoever asked.
pub(crate) const FOLDER_GONE: &str =
    "spawn_fork_not_found: the folder of the session to copy is no longer on this computer";

/// The session a fork copies, by the harness's own id, and where it runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForkSource {
    pub session_id: String,
    pub directory: PathBuf,
}

/// How long finding the source session's folder may take: it reads the
/// harness's own records, which may be on a slow or sleeping volume.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);

// A timed-out lookup cannot be cancelled: its permit stays with the worker
// until the read finishes, so stalled volumes cannot pile up blocking threads
// (the same rule as the working-folder check in `invoke`).
static FORK_LOOKUPS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

/// A fork runs where its source runs, so a requested folder must be that one.
fn folder_matches(asked: Option<&Path>, source: &Path) -> bool {
    asked.is_none_or(|asked| asked == source)
}

impl Core {
    pub(super) async fn fork_source(
        &self,
        request: &SpawnRequest,
        source: &str,
    ) -> Result<ForkSource, SpawnError> {
        let label = request.harness.label();
        if !supported(request.harness) {
            return Err(format!(
                "spawn_fork_unsupported: {label} cannot start as a copy of a session yet"
            )
            .into());
        }
        let workspace = self
            .workspace()
            .ok_or("spawn_failed: this computer has no Agent Relay workspace")?;
        let registration = self
            .store
            .read(|store| {
                store
                    .registrations
                    .iter()
                    .find(|r| {
                        r.name == source
                            && r.archived_at.is_none()
                            && r.base_url == workspace.base_url
                            && r.workspace_key.as_ref() == Some(&workspace.key)
                    })
                    .cloned()
            })
            .ok_or_else(|| {
                format!("spawn_fork_not_found: @{source} is not an agent on this computer")
            })?;
        let requester = report_back::requester(
            &workspace,
            &self.config.app_data_dir,
            &request.invocation_id,
        )
        .await;
        let owner = self.verified_owner(&registration).await;
        // The verified owner may have asked as the requester or as the
        // launcher that invoked the spawn for it.
        let asked_by_owner = match (&requester, &owner) {
            (Some(asked), Some((_, owner_id))) => asked.includes(owner_id),
            _ => false,
        };
        if !asked_by_owner {
            return Err(
                "spawn_fork_refused: only this computer's verified owner can fork its sessions"
                    .into(),
            );
        }
        let spawner = self.plugins.spawner.clone();
        let (harness, target) = (request.harness, registration.target.clone());
        let lookup = async move {
            let permit = FORK_LOOKUPS.acquire().await.ok()?;
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                spawner.fork_directory(harness, &target)
            })
            .await
            .ok()
            .flatten()
        };
        let directory = tokio::time::timeout(LOOKUP_TIMEOUT, lookup)
            .await
            .ok()
            .flatten()
            .ok_or_else(|| {
                format!("spawn_fork_unavailable: {label} on this computer cannot copy @{source}'s session")
            })?;
        if !folder_matches(request.directory.as_deref(), &directory) {
            return Err(
                "spawn_invalid_input: a fork runs in the folder of the session it copies".into(),
            );
        }
        Ok(ForkSource {
            session_id: registration.target.id,
            directory,
        })
    }
}

/// Why a spawn cannot start in its folder. A fork's folder is its
/// source's, not the requester's input: one that is gone is
/// `FOLDER_GONE`, and one that cannot be read keeps its reason, which
/// names what to allow.
pub(super) fn directory_refusal(error: &DirectoryError, fork: bool) -> String {
    match (error, fork) {
        (DirectoryError::Missing(_), true) => FOLDER_GONE.into(),
        (DirectoryError::Unreadable(reason), true) => {
            format!("spawn_fork_unavailable: {reason}")
        }
        (error, false) => format!("spawn_invalid_input: {error}"),
    }
}

/// The first turn of a fork: who it is now, then what the person asked.
pub fn first_task(source: &str, task: &str) -> String {
    let lead = format!(
        "This session is a fork of @{source}'s conversation, started from the Agent Relay app. \
         You are a new agent with your own name; @{source} keeps running separately. \
         Continue from where the conversation left off."
    );
    match task.trim() {
        "" => lead,
        task => format!("{lead}\n\n{task}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::cloud_session::{AgentOwner, CloudAccess, CloudAccount, CloudError};
    use crate::relay::daemon::{Config, Plugins};
    use crate::relay::spawn::launch::{
        Launch, LaunchError, Launched, SpawnedProcess, Spawner, Started,
    };
    use crate::relay::store::Target;
    use crate::relay::workspace::{Secret, Workspace};
    use futures_util::future::BoxFuture;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    const SESSION: &str = "0b6f2d0e-8a51-4a5c-9c3e-5d1f0a2b3c4d";
    const KEY: &str = "rk_live_test0000";
    const OWNER: &str = "agent_owner";

    #[test]
    fn only_claude_codex_and_grok_fork() {
        assert!(supported(claude::ID));
        assert!(supported(codex::ID));
        assert!(supported(grok::ID));
        assert!(!supported(crate::relay::harness::opencode::ID));
    }

    #[test]
    fn a_fork_runs_only_in_its_sources_folder() {
        let source = Path::new("/work/app");
        assert!(folder_matches(None, source));
        assert!(folder_matches(Some(source), source));
        assert!(!folder_matches(Some(Path::new("/work/other")), source));
    }

    #[test]
    fn the_first_turn_names_the_source_then_the_request() {
        let text = first_task("planner", " add tests ");
        assert!(text.contains("fork of @planner"));
        assert!(text.ends_with("\n\nadd tests"));
        assert!(!first_task("planner", "").contains("\n\n"));
    }

    /// The folder a fork copies. `slow` does not answer within the lookup
    /// limit, which is the same failure as no folder. `spawns` offers
    /// Codex, the harness `request` asks for, so a whole spawn reaches its
    /// folder check; it is set once the computer is claimed, since offering
    /// a harness starts a spawn node that reports its own claim.
    struct Folders {
        path: Mutex<Option<PathBuf>>,
        slow: AtomicBool,
        spawns: AtomicBool,
    }

    impl Spawner for Folders {
        fn available(&self) -> Vec<HarnessId> {
            if self.spawns.load(Ordering::SeqCst) {
                vec![codex::ID]
            } else {
                vec![]
            }
        }
        fn launch(&self, _: &Launch, _: Started) -> Result<Launched, LaunchError> {
            Err(LaunchError::Failed("not here".into()))
        }
        fn alive(&self, _: &Target, _: Option<&SpawnedProcess>) -> bool {
            false
        }
        fn stop(&self, _: &Target, _: Option<&SpawnedProcess>) {}
        fn fork_directory(&self, _: HarnessId, _: &Target) -> Option<PathBuf> {
            if self.slow.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_secs(12));
            }
            self.path.lock().unwrap().clone()
        }
    }

    /// Signed in as the owner whose relay id is [`OWNER`].
    struct SignedIn {
        base: String,
    }

    impl CloudAccess for SignedIn {
        fn account(&self) -> Option<CloudAccount> {
            Some(CloudAccount {
                site_url: self.base.clone(),
                workspace_id: "cloud-workspace".into(),
                user_id: Some("person".into()),
            })
        }
        fn agent_owner(&self) -> Option<AgentOwner> {
            Some(AgentOwner {
                user_id: "person".into(),
                workspace_id: Some("cloud-workspace".into()),
            })
        }
        fn request(
            &self,
            _: &'static str,
            path: String,
            _: Option<Value>,
        ) -> BoxFuture<'_, Result<Value, CloudError>> {
            let base = self.base.clone();
            Box::pin(async move {
                Ok(if path.ends_with("/messaging/identity/credential") {
                    json!({"identity": {
                        "name": "owner", "agentId": OWNER, "token": "at_owner",
                        "relaycastUrl": base
                    }})
                } else {
                    Value::Null
                })
            })
        }
    }

    /// Relaycast answering who invoked the spawn and who the owner is.
    fn relaycast(caller_id: &'static str) -> String {
        relaycast_invoked(json!({"caller_id": caller_id, "caller_name": "owner"}))
    }

    /// Relaycast answering with `invocation` as the spawn's record, so a
    /// desktop spawn can name a requester apart from the launcher that
    /// invoked it.
    fn relaycast_invoked(invocation: Value) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                while !String::from_utf8_lossy(&request).contains("\r\n\r\n") {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => request.extend_from_slice(&buffer[..read]),
                    }
                }
                let text = String::from_utf8_lossy(&request).to_string();
                let (status, body) = if text.contains("GET /v1/actions/spawn/invocations/inv_fork")
                {
                    ("200 OK", json!({"ok": true, "data": invocation.clone()}))
                } else if text.contains("GET /v1/agents/owner") {
                    (
                        "200 OK",
                        json!({"ok": true, "data": {"id": OWNER, "name": "owner"}}),
                    )
                } else {
                    (
                        "404 Not Found",
                        json!({"ok": false, "error": {"code": "not_found", "message": "not here"}}),
                    )
                };
                let body = body.to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        base
    }

    fn opened(home: &Path, base: &str, folders: Arc<Folders>) -> Arc<Core> {
        let config = Config {
            paths: crate::relay::paths::CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.into(),
            app_data_dir: home.join("app-data"),
            env: [(
                "RELAYCAST_URL".to_string(),
                "http://localhost:9".to_string(),
            )]
            .into(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: crate::relay::push::PushTiming::default(),
            delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
        };
        let (core, _) = Core::with_plugins(
            config,
            Plugins {
                cloud: Arc::new(SignedIn {
                    base: base.to_string(),
                }),
                spawner: folders,
                ..Plugins::default()
            },
        );
        *core.workspace.lock().unwrap() = Some(Workspace {
            key: Secret::new(KEY),
            base_url: base.into(),
            workspace_id: None,
            source: Default::default(),
            control_url: None,
            gate_url: None,
        });
        core
    }

    /// The startup pass writes a spawn status of its own. Wait for that,
    /// then record the computer as claimed by the signed-in person.
    async fn claim(core: &Core) {
        let _ = core.person_identity(false).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            while core.status().spawn.is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await;
        core.hub.update(|status| {
            status.spawn = Some(crate::relay::state::SpawnStatus {
                claim: Some(crate::relay::state::SpawnClaim {
                    state: crate::relay::state::SpawnClaimState::Claimed,
                    note: None,
                }),
                ..Default::default()
            });
        });
    }

    fn register(core: &Core, name: &str, archived: bool, key: &str) {
        let registration: crate::relay::store::Registration = serde_json::from_value(json!({
            "name": name,
            "agentID": format!("agent_{name}"),
            "target": {"kind": "codex", "id": if name == "planner" { SESSION } else { "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }},
            "title": name,
            "baseURL": core.workspace().unwrap().base_url,
            "workspaceKey": key,
            "registeredAt": "2026-11-11T00:00:00Z",
            "archivedAt": archived.then_some("2026-11-11T01:00:00Z"),
        }))
        .unwrap();
        assert!(core
            .store
            .update(|store| store.add(registration, Secret::new(format!("at_live_{name}"))))
            .unwrap());
    }

    fn request(directory: Option<&Path>) -> SpawnRequest {
        SpawnRequest {
            invocation_id: "inv_fork".into(),
            harness: codex::ID,
            name: "planner-fork".into(),
            task: "go on".into(),
            directory: directory.map(Path::to_path_buf),
            fork_from: Some("planner".into()),
            approval_profile: None,
            launch_credential: None,
        }
    }

    fn folder() -> PathBuf {
        PathBuf::from(if cfg!(windows) {
            r"C:\work\repo"
        } else {
            "/work/repo"
        })
    }

    #[tokio::test]
    async fn a_fork_is_refused_before_any_lookup() {
        let folders = Arc::new(Folders {
            path: Mutex::new(Some(folder())),
            slow: AtomicBool::new(false),
            spawns: AtomicBool::new(false),
        });
        let home = tempfile::tempdir().unwrap();
        let core = opened(home.path(), "http://127.0.0.1:9", folders);
        let unsupported = SpawnRequest {
            harness: crate::relay::harness::opencode::ID,
            ..request(None)
        };
        let error = core.fork_source(&unsupported, "planner").await.unwrap_err();
        assert!(
            error.text().starts_with("spawn_fork_unsupported"),
            "{error:?}"
        );

        *core.workspace.lock().unwrap() = None;
        let error = core
            .fork_source(&request(None), "planner")
            .await
            .unwrap_err();
        assert!(error.text().starts_with("spawn_failed"), "{error:?}");
    }

    #[tokio::test]
    async fn a_fork_finds_only_a_live_agent_in_this_workspace() {
        let folders = Arc::new(Folders {
            path: Mutex::new(Some(folder())),
            slow: AtomicBool::new(false),
            spawns: AtomicBool::new(false),
        });
        let home = tempfile::tempdir().unwrap();
        let core = opened(home.path(), "http://127.0.0.1:9", folders);
        let missing = core
            .fork_source(&request(None), "planner")
            .await
            .unwrap_err();
        assert!(
            missing.text().starts_with("spawn_fork_not_found"),
            "{missing:?}"
        );
        register(&core, "planner", true, KEY);
        let archived = core
            .fork_source(&request(None), "planner")
            .await
            .unwrap_err();
        assert!(
            archived.text().starts_with("spawn_fork_not_found"),
            "{archived:?}"
        );
        register(&core, "other", false, "rk_live_someoneelse");
        let elsewhere = core.fork_source(&request(None), "other").await.unwrap_err();
        assert!(
            elsewhere.text().starts_with("spawn_fork_not_found"),
            "{elsewhere:?}"
        );
    }

    // A workspace leader is never the owner: its fork is refused like
    // anyone else's. `fork_source` never consults the leaders list, so this
    // holds by construction; the list is set only to pin that down.
    #[tokio::test]
    async fn a_workspace_leader_cannot_fork_as_fork_never_reads_the_leaders() {
        use crate::relay::contract::agents::{WorkspaceLeader, WorkspaceLeaders};
        let folders = Arc::new(Folders {
            path: Mutex::new(Some(folder())),
            slow: AtomicBool::new(false),
            spawns: AtomicBool::new(false),
        });
        let base = relaycast("agent_leader");
        let home = tempfile::tempdir().unwrap();
        let core = opened(home.path(), &base, folders);
        register(&core, "planner", false, KEY);
        claim(&core).await;
        core.leaders.set(
            &core.workspace().unwrap(),
            WorkspaceLeaders {
                leaders: vec![WorkspaceLeader {
                    name: "owner".into(),
                    agent_id: "agent_leader".into(),
                }],
                patterns: vec!["owner".into()],
            },
        );
        let refused = core
            .fork_source(&request(None), "planner")
            .await
            .unwrap_err();
        assert!(
            refused.text().starts_with("spawn_fork_refused"),
            "{refused:?}"
        );
    }

    #[tokio::test]
    async fn only_the_verified_owner_can_fork_and_only_in_the_sources_folder() {
        let source = folder();
        let folders = Arc::new(Folders {
            path: Mutex::new(Some(source.clone())),
            slow: AtomicBool::new(false),
            spawns: AtomicBool::new(false),
        });
        let base = relaycast(OWNER);
        let home = tempfile::tempdir().unwrap();
        let core = opened(home.path(), &base, folders.clone());
        register(&core, "planner", false, KEY);

        let refused = core
            .fork_source(&request(None), "planner")
            .await
            .unwrap_err();
        assert!(
            refused.text().starts_with("spawn_fork_refused"),
            "{refused:?}"
        );

        let stranger = relaycast("agent_other");
        let home = tempfile::tempdir().unwrap();
        let core = opened(home.path(), &stranger, folders.clone());
        register(&core, "planner", false, KEY);
        claim(&core).await;
        let other = core
            .fork_source(&request(None), "planner")
            .await
            .unwrap_err();
        assert!(other.text().starts_with("spawn_fork_refused"), "{other:?}");

        let home = tempfile::tempdir().unwrap();
        let core = opened(home.path(), &base, folders.clone());
        register(&core, "planner", false, KEY);
        claim(&core).await;
        let copied = core.fork_source(&request(None), "planner").await.unwrap();
        assert_eq!(copied.session_id, SESSION);
        assert_eq!(copied.directory, source);
        let same = core
            .fork_source(&request(Some(&source)), "planner")
            .await
            .unwrap();
        assert_eq!(same.directory, source);
        let other_folder = source.join("other");
        let mismatch = core
            .fork_source(&request(Some(&other_folder)), "planner")
            .await
            .unwrap_err();
        assert!(
            mismatch.text().starts_with("spawn_invalid_input"),
            "{mismatch:?}"
        );

        *folders.path.lock().unwrap() = None;
        let missing = core
            .fork_source(&request(None), "planner")
            .await
            .unwrap_err();
        assert!(
            missing.text().starts_with("spawn_fork_unavailable"),
            "{missing:?}"
        );
    }

    /// Forks `planner` on a claimed computer whose spawn invocation names
    /// `requester` as the desktop identity that asked and `launcher` as the
    /// participant that invoked it.
    async fn fork_asked_by(
        requester: &'static str,
        launcher: &'static str,
    ) -> Result<ForkSource, SpawnError> {
        let folders = Arc::new(Folders {
            path: Mutex::new(Some(folder())),
            slow: AtomicBool::new(false),
            spawns: AtomicBool::new(false),
        });
        let base = relaycast_invoked(json!({
            "caller_id": launcher, "caller_name": "launcher-person",
            "requester_agent_id": requester, "requester_name": "person-chat"
        }));
        let home = tempfile::tempdir().unwrap();
        let core = opened(home.path(), &base, folders);
        register(&core, "planner", false, KEY);
        claim(&core).await;
        core.fork_source(&request(None), "planner").await
    }

    #[tokio::test]
    async fn a_fork_the_owner_asked_for_through_a_launcher_keeps_its_source() {
        let copied = fork_asked_by(OWNER, "agent_launcher").await.unwrap();
        assert_eq!(copied.session_id, SESSION);
        assert_eq!(copied.directory, folder());
    }

    #[tokio::test]
    async fn a_fork_the_owner_launched_for_another_requester_keeps_its_source() {
        let copied = fork_asked_by("agent_person_chat", OWNER).await.unwrap();
        assert_eq!(copied.session_id, SESSION);
        assert_eq!(copied.directory, folder());
    }

    #[tokio::test]
    async fn a_fork_neither_asked_for_nor_launched_by_the_owner_is_refused() {
        let refused = fork_asked_by("agent_person_chat", "agent_launcher")
            .await
            .unwrap_err();
        assert!(
            refused.text().starts_with("spawn_fork_refused"),
            "{refused:?}"
        );
    }

    /// The answer to a whole spawn of `request` by the owner, on a claimed
    /// computer where `planner`'s session is in `source`.
    async fn spawn_from(source: &Path, request: SpawnRequest) -> Result<Value, SpawnError> {
        let folders = Arc::new(Folders {
            path: Mutex::new(Some(source.to_path_buf())),
            slow: AtomicBool::new(false),
            spawns: AtomicBool::new(false),
        });
        let base = relaycast(OWNER);
        let home = tempfile::tempdir().unwrap();
        let core = opened(home.path(), &base, folders.clone());
        register(&core, "planner", false, KEY);
        claim(&core).await;
        folders.spawns.store(true, Ordering::SeqCst);
        let (link, _sent) = super::super::node::NodeLink::detached(super::super::node::NodeInfo {
            node_id: "node_desktop_1".into(),
            node_name: "test-desk-desktop".into(),
        });
        core.spawn_agent(&link, &request, &mut None).await
    }

    #[tokio::test]
    async fn a_fork_whose_folder_is_gone_says_so_without_naming_it() {
        let parent = tempfile::tempdir().unwrap();
        let source = parent.path().join("project");
        std::fs::create_dir(&source).unwrap();
        std::fs::remove_dir(&source).unwrap();
        let error = spawn_from(&source, request(None)).await.unwrap_err().text();
        assert_eq!(error, FOLDER_GONE);
        assert!(!error.contains(&*source.to_string_lossy()), "{error}");
    }

    #[tokio::test]
    async fn a_spawn_that_is_not_a_fork_names_the_missing_folder_it_was_given() {
        let parent = tempfile::tempdir().unwrap();
        let missing = parent.path().join("project");
        let error = spawn_from(
            &folder(),
            SpawnRequest {
                fork_from: None,
                ..request(Some(&missing))
            },
        )
        .await
        .unwrap_err()
        .text();
        assert_eq!(
            error,
            format!(
                "spawn_invalid_input: {} is not a folder on this computer",
                missing.display()
            )
        );
    }

    // Root reads any folder, and Windows has no mode bits to deny it with.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_fork_whose_folder_cannot_be_read_names_it_but_is_not_bad_input() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let source = tempfile::tempdir().unwrap();
        std::fs::set_permissions(source.path(), std::fs::Permissions::from_mode(0o111)).unwrap();
        let result = spawn_from(source.path(), request(None)).await;
        std::fs::set_permissions(source.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let error = result.unwrap_err().text();
        assert!(
            error.starts_with(
                "spawn_fork_unavailable: Agent Relay could not read the working folder"
            ),
            "{error}"
        );
        assert!(error.contains(&*source.path().to_string_lossy()), "{error}");
    }

    #[test]
    fn a_fork_code_is_kept_when_its_error_is_redacted() {
        let error = SpawnError::from(format!("{FOLDER_GONE} rk_live_secret")).redacted();
        assert_eq!(error.text(), format!("{FOLDER_GONE} [redacted]"));
        let text = "rk_live_secret: is not a code";
        let error = SpawnError::from(text).redacted();
        assert_eq!(
            error.text(),
            crate::relay::harness::diagnostics::redact(text)
        );
        assert!(!error.text().contains("rk_live_secret"));
    }

    #[test]
    fn a_folder_refusal_says_whose_folder_it_was() {
        let folder = folder();
        let missing = DirectoryError::Missing(folder.clone());
        assert_eq!(directory_refusal(&missing, true), FOLDER_GONE);
        assert_eq!(
            directory_refusal(&missing, false),
            format!(
                "spawn_invalid_input: {} is not a folder on this computer",
                folder.display()
            )
        );
        let unreadable = DirectoryError::Unreadable("cannot read it".into());
        assert_eq!(
            directory_refusal(&unreadable, true),
            "spawn_fork_unavailable: cannot read it"
        );
        assert_eq!(
            directory_refusal(&unreadable, false),
            "spawn_invalid_input: cannot read it"
        );
    }

    #[tokio::test]
    async fn a_lookup_that_does_not_finish_cannot_be_forked() {
        let folders = Arc::new(Folders {
            path: Mutex::new(Some(folder())),
            slow: AtomicBool::new(true),
            spawns: AtomicBool::new(false),
        });
        let base = relaycast(OWNER);
        let home = tempfile::tempdir().unwrap();
        let core = opened(home.path(), &base, folders);
        register(&core, "planner", false, KEY);
        claim(&core).await;
        let error = tokio::time::timeout(
            Duration::from_secs(15),
            core.fork_source(&request(None), "planner"),
        )
        .await
        .expect("the lookup wait returns")
        .unwrap_err();
        assert!(
            error.text().starts_with("spawn_fork_unavailable"),
            "{error:?}"
        );
    }
}
