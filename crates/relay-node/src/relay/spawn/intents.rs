//! Spawns in flight, kept on disk until their agent is saved: the core
//! registers the agent on Relaycast and launches it (up to about half a
//! minute) before the registration reaches the store, and a core that
//! restarts in between would otherwise leave a running agent with no row,
//! place or release path. Each spawn writes what it knows as it learns it
//! (`<app data>/spawn-intents.json`, 0600, as it holds agent tokens), and a
//! restarted core settles what is left once its node connects
//! (`recover`).

use super::launch::{SpawnedProcess, TaskHandoff};
use super::wire::HarnessId;
use crate::relay::store::{iso8601_now, Registration, SpawnOrigin, SpawnRequester, Target};
use crate::relay::workspace::Secret;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const INTENTS_FILE: &str = "spawn-intents.json";

/// One file per core; writes are whole and one at a time.
static WRITING: Mutex<()> = Mutex::new(());

/// Records no write could save (`hold`), by app data folder: listed by
/// `load`, so recovery still settles them, until a write persists them.
static HELD: Mutex<Vec<(PathBuf, Intent)>> = Mutex::new(Vec::new());

/// A spawn between the place it took and its saved registration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Intent {
    #[serde(rename = "invocationID")]
    pub invocation_id: String,
    pub name: String,
    pub harness: HarnessId,
    #[serde(rename = "nodeID")]
    pub node_id: String,
    #[serde(rename = "nodeName")]
    pub node_name: String,
    pub title: String,
    #[serde(rename = "baseURL")]
    pub base_url: String,
    #[serde(rename = "workspaceKey")]
    pub workspace_key: Secret,
    /// The Relaycast workspace id, when the workspace's source records it:
    /// it still names the workspace after its key is rotated.
    #[serde(
        rename = "workspaceID",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub workspace_id: Option<String>,
    #[serde(rename = "machinePrefix")]
    pub machine_prefix: String,
    /// Codex's `clientUserMessageId` for the first turn.
    #[serde(rename = "messageID")]
    pub message_id: String,
    /// Claude's `--session-id`, decided before it starts.
    #[serde(rename = "sessionID")]
    pub session_id: String,
    /// When the spawn began, in Unix milliseconds.
    #[serde(rename = "createdMs", default)]
    pub created_ms: i64,
    /// Ended after a restart: only taking it off the node is left, sent
    /// again on each connection until Relaycast answers.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ended: bool,
    /// Set when its launch failed, so recovery never keeps what the launch
    /// left as a successful agent, even without a saved failure receipt.
    #[serde(
        rename = "launchFailed",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub launch_failed: bool,
    /// Set once `agent.register` is sent and until Relaycast refuses it:
    /// an agent may be registered whose id never arrived (the answer late,
    /// or the spawn cancelled), and recovery has to find it (`unanswered`).
    #[serde(
        rename = "registerSent",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub register_sent: bool,
    /// Set once Relaycast registered the agent.
    #[serde(rename = "agentID", default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<Secret>,
    /// Set once Relaycast named the agent that asked for the spawn, so a
    /// registration saved after a restart is still owed its final answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requester: Option<SpawnRequester>,
    /// Set once the launch started the agent's session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<SpawnedProcess>,
}

impl Intent {
    /// The registration the spawn saves for its agent, on `node`.
    pub fn registration(
        &self,
        agent_id: &str,
        target: Target,
        process: Option<SpawnedProcess>,
        (node_id, node_name): (&str, &str),
    ) -> Registration {
        // Native Muse uses the same courier as already-open Muse sessions.
        // Pin the actual discovered session, including when recovering an
        // interrupted launch; the preallocated launch id is only a marker.
        let route_binding = (self.harness == crate::relay::harness::muse::ID
            && target.kind == crate::relay::store::SessionKind::MuseOpen)
            .then(|| crate::relay::existing_session::muse_open::courier_reference(&target.id));
        Registration {
            name: self.name.clone(),
            agent_id: agent_id.to_string(),
            target,
            title: self.title.clone(),
            base_url: self.base_url.clone(),
            registered_at: iso8601_now(),
            workspace_key: Some(self.workspace_key.clone()),
            machine_prefix: Some(self.machine_prefix.clone()),
            added_by_session: None,
            auto_activated: None,
            missing_since: None,
            archived_at: None,
            webhook: None,
            reply_with_final_answer: None,
            integration_channel_id: None,
            integration_channel_name: None,
            integrations: None,
            route_binding,
            mcp: None,
            alias: None,
            retired_aliases: None,
            cleared: None,
            spawn: Some(SpawnOrigin {
                node_id: node_id.to_string(),
                node_name: node_name.to_string(),
                invocation_id: self.invocation_id.clone(),
                harness: self.harness.name().to_string(),
                requester: self.requester.clone(),
                process,
                // Relaycast's spawn invoke carries no owner it vouches for
                // (only caller-aware `action` capabilities get `caller_id`,
                // and that names the invoking agent, not a person), so the
                // owner stays unknown. Never read from the input.
                owner: None,
                taken_over_at: None,
                // Unconfirmed unless the launch saw the harness take its
                // task (`with_task`): a spawn kept after a restart never
                // saw its launch finish.
                task_unconfirmed: Some(INTERRUPTED.to_string()),
            }),
        }
    }
}

/// The verification of a spawn whose launch a restart interrupted.
pub const INTERRUPTED: &str = "interrupted";

/// The registration of a launch that finished, with its first task's
/// handoff as the launch saw it.
pub(super) fn with_task(mut registration: Registration, task: TaskHandoff) -> Registration {
    if let Some(spawn) = registration.spawn.as_mut() {
        spawn.task_unconfirmed = match task {
            TaskHandoff::Confirmed => None,
            TaskHandoff::Unconfirmed(verification) => Some(verification.to_string()),
        };
    }
    registration
}

/// The title a spawned agent's row shows: its task's first line.
pub fn title(task: &str, name: &str) -> String {
    task.lines()
        .next()
        .filter(|line| !line.is_empty())
        .unwrap_or(name)
        .chars()
        .take(70)
        .collect()
}

fn file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(INTENTS_FILE)
}

/// The spawns in flight, as last written, with those held in memory; none
/// on disk when the file is missing or unreadable.
pub fn load(app_data_dir: &Path) -> Vec<Intent> {
    let mut intents: Vec<Intent> = std::fs::read(file(app_data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let held = HELD.lock().unwrap_or_else(|e| e.into_inner());
    for (_, kept) in held.iter().filter(|(dir, _)| dir == app_data_dir) {
        intents.retain(|current| !same_attempt(current, kept));
        intents.push(kept.clone());
    }
    intents
}

/// Changes the intents in one whole write. Held records it wrote are on
/// disk now; one it could not write stays held as the change left it.
fn change(app_data_dir: &Path, change: impl FnOnce(&mut Vec<Intent>)) -> std::io::Result<()> {
    let _writing = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let mut intents = load(app_data_dir);
    change(&mut intents);
    let written = write_all(app_data_dir, &intents);
    let mut held = HELD.lock().unwrap_or_else(|e| e.into_inner());
    held.retain_mut(|(dir, kept)| {
        if dir != app_data_dir {
            return true;
        }
        match intents.iter().find(|current| same_attempt(current, kept)) {
            Some(current) if written.is_err() => {
                *kept = current.clone();
                true
            }
            _ => false,
        }
    });
    written
}

fn write_all(app_data_dir: &Path, intents: &[Intent]) -> std::io::Result<()> {
    let path = file(app_data_dir);
    if intents.is_empty() {
        return match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        };
    }
    std::fs::create_dir_all(app_data_dir)?;
    write(&path, &serde_json::to_vec_pretty(intents)?)
}

/// Keeps `intent` in memory when it cannot be written: listed by `load`
/// for this core's recovery, and persisted by the next write that succeeds.
fn hold(app_data_dir: &Path, intent: &Intent) {
    let _writing = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let mut held = HELD.lock().unwrap_or_else(|e| e.into_inner());
    held.retain(|(dir, kept)| !(dir == app_data_dir && same_attempt(kept, intent)));
    held.push((app_data_dir.to_path_buf(), intent.clone()));
}

fn write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let temporary = path.with_extension("json.tmp");
    let mut file = crate::platform::fs::private(
        std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true),
    )
    .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(temporary, path)
}

/// Records `intent`, replacing what was known of its invocation.
pub fn put(app_data_dir: &Path, intent: &Intent) -> std::io::Result<()> {
    change(app_data_dir, |intents| {
        intents.retain(|kept| kept.invocation_id != intent.invocation_id);
        intents.push(intent.clone());
    })
}

/// Changes only this launch attempt, preserving fields a callback learned
/// since the caller's snapshot. A late callback cannot recreate a settled
/// record or replace a retry under the same invocation id.
pub fn update_attempt(
    app_data_dir: &Path,
    expected: &Intent,
    update: impl FnOnce(&mut Intent),
) -> std::io::Result<Option<Intent>> {
    let mut updated = None;
    change(app_data_dir, |intents| {
        if let Some(current) = intents
            .iter_mut()
            .find(|current| same_attempt(current, expected))
        {
            update(current);
            updated = Some(current.clone());
        }
    })?;
    Ok(updated)
}

/// Replaces `expected`'s attempt with `replacement`, or forgets it with
/// none, in one write and only while `still` holds of it as written. False
/// when a retry replaced it, it is gone, or it could not be written.
pub fn change_attempt(
    app_data_dir: &Path,
    expected: &Intent,
    still: impl Fn(&Intent) -> bool,
    replacement: Option<&Intent>,
) -> bool {
    let mut changed = false;
    let written = change(app_data_dir, |intents| {
        let Some(index) = intents
            .iter()
            .position(|current| same_attempt(current, expected) && still(current))
        else {
            return;
        };
        match replacement {
            Some(replacement) => intents[index] = replacement.clone(),
            None => {
                intents.remove(index);
            }
        }
        changed = true;
    });
    changed && written.is_ok()
}

/// Records `intent` only when no attempt of its invocation is on disk: one
/// whose record went while its agent was still to be taken off. Held in
/// memory when it cannot be written. False when another attempt is there.
pub fn put_if_absent(app_data_dir: &Path, intent: &Intent) -> bool {
    let mut added = false;
    let written = change(app_data_dir, |intents| {
        if !intents
            .iter()
            .any(|kept| kept.invocation_id == intent.invocation_id)
        {
            intents.push(intent.clone());
            added = true;
        }
    });
    if added && written.is_err() {
        hold(app_data_dir, intent);
    }
    added
}

/// Forgets every intent `which` picks, in one write.
pub(super) fn forget(app_data_dir: &Path, which: impl Fn(&Intent) -> bool) -> std::io::Result<()> {
    change(app_data_dir, |intents| intents.retain(|kept| !which(kept)))
}

fn same_attempt(current: &Intent, expected: &Intent) -> bool {
    current.invocation_id == expected.invocation_id && current.session_id == expected.session_id
}

/// Forgets only the attempt whose agent was saved or ended. A cleanup
/// acknowledgement for an older attempt must leave a retry's intent intact.
pub fn remove(app_data_dir: &Path, expected: &Intent) -> std::io::Result<()> {
    change(app_data_dir, |intents| {
        intents.retain(|kept| !same_attempt(kept, expected))
    })
}

/// A spawn's durable recovery record. Cancellation drops this guard too,
/// so only a saved registration or a confirmed deregistration explicitly
/// clears a registered intent.
/// Failed launches remain marked ended until recovery confirms cleanup.
pub(super) struct InFlight {
    pub(super) app_data_dir: PathBuf,
    pub(super) intent: Intent,
}

impl InFlight {
    /// Saves the intent before anything starts. A spawn that cannot save it
    /// must not register or launch: a restart would find nothing to settle.
    pub(super) fn begin(&self) -> std::io::Result<()> {
        put(&self.app_data_dir, &self.intent)
    }

    /// Records what the spawn learned. An error means it is not on disk
    /// (the write failed, or this attempt's record is gone): a spawn must
    /// not go on to start anything on evidence a restart could not find.
    pub(super) fn update(&mut self, update: impl FnOnce(&mut Intent)) -> std::io::Result<()> {
        let expected = self.intent.clone();
        let mut update = Some(update);
        let written = update_attempt(&self.app_data_dir, &expected, |current| {
            // What only memory knows (an identity whose write failed) is
            // written with this change, never dropped by it.
            known(current, &expected);
            if let Some(update) = update.take() {
                update(current);
            }
            self.intent = current.clone();
        });
        // Keep local registration evidence even if persistence failed or a
        // newer attempt replaced this record; Drop still must not erase it.
        if let Some(update) = update {
            update(&mut self.intent);
        }
        match written? {
            Some(_) => Ok(()),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "the spawn's recovery record is gone",
            )),
        }
    }

    /// The registration is durable, or the agent confirmed off the node, so
    /// the intent no longer owns recovery.
    pub(super) fn settled(&self) {
        let _ = remove(&self.app_data_dir, &self.intent);
    }

    /// Keeps the record of a registered agent not confirmed off the node,
    /// ended so recovery only takes it off: on disk when it can be written,
    /// held in memory otherwise, never dropped on an unanswered request.
    pub(super) fn leave_for_recovery(&mut self) {
        if self.update(|intent| intent.ended = true).is_err() {
            hold(&self.app_data_dir, &self.intent);
        }
    }
}

/// Fills what `current`, this attempt's record, lacks from `memory`.
fn known(current: &mut Intent, memory: &Intent) {
    current.ended |= memory.ended;
    current.register_sent |= memory.register_sent;
    current.launch_failed |= memory.launch_failed;
    if current.agent_id.is_none() {
        (current.agent_id, current.token) = (memory.agent_id.clone(), memory.token.clone());
    }
    if current.target.is_none() {
        (current.target, current.process) = (memory.target.clone(), memory.process);
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        // No launch can start before Relaycast returns the agent identity.
        // Once it is asked for, cancellation must leave the last known
        // evidence.
        if !self.intent.register_sent
            && self.intent.agent_id.is_none()
            && self.intent.target.is_none()
        {
            let _ = remove(&self.app_data_dir, &self.intent);
        }
    }
}

#[cfg(test)]
#[path = "intents_attempt_tests.rs"]
mod attempt_tests;

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::relay::harness::claude;
    use crate::relay::store::SessionKind;

    pub(crate) fn intent(name: &str) -> Intent {
        Intent {
            invocation_id: format!("inv_{name}"),
            name: name.into(),
            harness: claude::ID,
            node_id: "node_desktop_1".into(),
            node_name: "test-desk-desktop".into(),
            title: "Fix CI".into(),
            base_url: "https://cast.example".into(),
            workspace_key: Secret::new("rk_live_test0000".to_string()),
            workspace_id: None,
            machine_prefix: "test-desk".into(),
            message_id: format!("spawn-inv_{name}"),
            session_id: "0b6f2d0e-8a51-4a5c-9c3e-5d1f0a2b3c4d".into(),
            created_ms: 0,
            ended: false,
            launch_failed: false,
            register_sent: false,
            agent_id: None,
            token: None,
            requester: None,
            target: None,
            process: None,
        }
    }

    #[test]
    fn intents_are_kept_whole_privately_and_removed_when_settled() {
        let folder = tempfile::tempdir().unwrap();
        assert!(load(folder.path()).is_empty());
        let mut first = intent("w1");
        put(folder.path(), &first).unwrap();
        put(folder.path(), &intent("w2")).unwrap();
        first.agent_id = Some("agent_w1".into());
        first.target = Some(Target::new(SessionKind::ClaudeTerminal, &first.session_id));
        put(folder.path(), &first).unwrap();
        let kept = load(folder.path());
        assert_eq!(kept.len(), 2);
        assert_eq!(kept.iter().find(|i| i.name == "w1"), Some(&first));
        // Windows has no mode bits; the private folder's access list applies.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(folder.path().join(INTENTS_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        remove(folder.path(), &first).unwrap();
        remove(folder.path(), &intent("w2")).unwrap();
        assert!(load(folder.path()).is_empty());
        assert!(!folder.path().join(INTENTS_FILE).exists());
    }

    #[test]
    fn native_muse_keeps_its_exact_courier_route_when_saved_or_recovered() {
        use crate::relay::existing_session::muse_open;
        use crate::relay::harness::{codex, devin, grok, muse, opencode};
        let folder = tempfile::tempdir().unwrap();
        let mut pending = intent("native-muse");
        pending.harness = muse::ID;
        // Muse discovers its real session after launch. The launch marker
        // must never become the courier's destination instead.
        let target = Target::new(
            SessionKind::MuseOpen,
            "01a140cb-ff81-7302-806e-2e34501ed437",
        );
        assert_ne!(target.id, pending.session_id);
        let process = Some(SpawnedProcess {
            pid: 12345,
            start: 71,
        });
        pending.target = Some(target.clone());
        pending.process = process;
        put(folder.path(), &pending).unwrap();
        let recovered = load(folder.path()).pop().unwrap();
        for current in [&pending, &recovered] {
            let registration = current.registration(
                "agent-native-muse",
                target.clone(),
                process,
                ("node_desktop_1", "test-desk-desktop"),
            );
            assert_eq!(
                registration.route_binding.as_deref(),
                Some(muse_open::courier_reference(&target.id).as_str())
            );
            assert_eq!(registration.target, target);
            assert_eq!(registration.spawn.unwrap().process, process);
        }
        // Adding Muse must not change the other harnesses' delivery routes,
        // nor pin a mismatched harness/session pair to a Muse courier.
        for (harness, kind) in [
            (codex::ID, SessionKind::Codex),
            (claude::ID, SessionKind::ClaudeTerminal),
            (opencode::ID, SessionKind::OpenCode),
            (grok::ID, SessionKind::Grok),
            (devin::ID, SessionKind::Devin),
            (claude::ID, SessionKind::MuseOpen),
            (muse::ID, SessionKind::ClaudeTerminal),
        ] {
            pending.harness = harness;
            let registration = pending.registration(
                "agent-other",
                Target::new(kind, &target.id),
                process,
                ("node_desktop_1", "test-desk-desktop"),
            );
            assert!(registration.route_binding.is_none());
        }
    }

    #[test]
    fn only_a_launch_that_saw_its_task_taken_is_saved_as_confirmed() {
        let pending = intent("w1");
        let target = Target::new(SessionKind::ClaudeTerminal, &pending.session_id);
        let node = ("node_desktop_1", "test-desk-desktop");
        let task = |registration: Registration| registration.spawn.unwrap().task_unconfirmed;
        // Kept after a restart: its launch was never seen to finish.
        let kept = pending.registration("agent_w1", target.clone(), None, node);
        assert_eq!(task(kept.clone()).as_deref(), Some(INTERRUPTED));
        assert_eq!(task(with_task(kept.clone(), TaskHandoff::Confirmed)), None);
        assert_eq!(
            task(with_task(kept, TaskHandoff::Unconfirmed("in_doubt"))).as_deref(),
            Some("in_doubt")
        );
    }

    #[test]
    fn a_title_is_the_task_s_first_line_or_the_name() {
        assert_eq!(title("Fix CI\nthen deploy", "w1"), "Fix CI");
        assert_eq!(title("", "w1"), "w1");
        assert_eq!(title(&"x".repeat(90), "w1").len(), 70);
    }

    #[test]
    fn a_rewrite_keeps_a_launch_failure_known_only_in_memory() {
        let mut memory = intent("w1");
        memory.launch_failed = true;
        let mut current = intent("w1");
        known(&mut current, &memory);
        assert!(current.launch_failed);
    }
}
