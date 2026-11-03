//! Sessions a person puts on the relay are uploaded.
//!
//! Every registered session the uploader holds but does not upload yet is
//! included unless Agent Relay put it on the relay by itself: an
//! automatically activated session follows the sharing policy, and is
//! activated only when that policy shares it ([`admitted`]). The rest are
//! included once. An explicit upload exclusion persists across restarts, and
//! joining the relay never silently reverses that saved upload choice. Only
//! a Cloud-confirmed deletion (the `deleted-uploads.json` journal) also takes
//! the matching registered sessions off the relay. Checked whenever the agents
//! change and on every uploader supervision tick. With sharing `all` everything uploads already;
//! an install a newer probe runs is left alone.

use crate::delivery_status::{Inclusion, SessionIdentity};
use crate::relay::daemon::Core;
use crate::relay::state::Listing;
use crate::relay::store::Target as SessionTarget;
use crate::relay::uploader::{SharingMode, Target, Uploader};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// What has been asked for, per attached install.
#[derive(Default)]
pub struct RelayUploads {
    requested: Mutex<(Option<Target>, BTreeSet<String>)>,
    /// The registered sessions the last pass found shared with the
    /// workspace (`shared`): what an agent is doing is published only for
    /// these (`relay::activity`).
    shared: Mutex<BTreeSet<String>>,
    /// One pass at a time.
    running: tokio::sync::Mutex<()>,
    /// The account has looked for this computer's install at least once:
    /// none attached after that means nothing uploads here.
    looked: std::sync::atomic::AtomicBool,
}

/// What the uploader reads for each registered session, by `source:id` key.
pub type Read = BTreeMap<String, Inclusion>;

/// The registered keys the install shares with the workspace: those it
/// uploads. Under sharing `all` that is every one not withheld.
pub fn shared(registered: &BTreeSet<String>, read: &Read) -> BTreeSet<String> {
    registered
        .iter()
        .filter(|key| {
            read.get(*key)
                .is_some_and(|session| session.included && !session.deleted_from_cloud)
        })
        .cloned()
        .collect()
}

/// The keys to include now: registered, selectable, not uploaded, never
/// asked for while on the relay. `requested` keeps only keys still
/// registered.
pub fn pending(
    registered: &BTreeSet<String>,
    mode: SharingMode,
    read: &Read,
    requested: &mut BTreeSet<String>,
) -> Vec<String> {
    requested.retain(|key| registered.contains(key));
    if mode == SharingMode::All {
        return Vec::new();
    }
    registered
        .iter()
        .filter(|key| {
            read.get(*key).is_some_and(|session| {
                session.selectable
                    && !session.included
                    && !session.explicitly_excluded
                    && !session.deleted_from_cloud
            }) && !requested.contains(*key)
        })
        .cloned()
        .collect()
}

/// Which sessions the sharing policy lets Agent Relay put on the relay by
/// itself.
#[derive(Debug, PartialEq, Eq)]
pub enum Admission {
    /// Every one: nothing uploads here, or the install is not this
    /// computer's to read (another workspace's, a newer build's).
    All,
    /// Only these: those the install uploads, and those it never could.
    Only(HashSet<SessionTarget>),
    /// Not known this time, and why when it is worth saying: nothing new
    /// joins and no one leaves until a later pass reads it.
    Unknown(Option<String>),
}

impl Admission {
    pub fn admits(&self, target: &SessionTarget) -> bool {
        match self {
            Admission::All => true,
            Admission::Only(admitted) => admitted.contains(target),
            Admission::Unknown(_) => false,
        }
    }
}

/// Keeps in `found` only the sessions the sharing policy lets join the
/// relay by themselves, and returns those still eligible to stay there.
/// Why the policy could not be read goes on `failures`. An automatically
/// activated agent `/clear` just `moved` to a conversation the policy does
/// not upload is told why it leaves, and how to keep it.
pub async fn admit<T>(
    core: &Core,
    found: &mut std::collections::HashMap<SessionTarget, T>,
    moved: &[SessionTarget],
    failures: &mut Vec<String>,
) -> HashSet<SessionTarget> {
    if found.is_empty() {
        return HashSet::new();
    }
    let admission = admitted(core, found.keys().cloned().collect()).await;
    let eligible: HashSet<SessionTarget> = match &admission {
        Admission::Unknown(why) => {
            failures.extend(why.clone());
            found.keys().cloned().collect()
        }
        _ => found
            .keys()
            .filter(|target| admission.admits(target))
            .cloned()
            .collect(),
    };
    let leaving: Vec<String> = core.store.read(|store| {
        moved
            .iter()
            .filter(|target| !eligible.contains(*target))
            .filter_map(|target| store.registration_for(target))
            .filter(|r| r.auto_activated == Some(true))
            .map(|r| r.display_name().to_owned())
            .collect()
    });
    if !leaving.is_empty() {
        core.hub.activity(
            crate::relay::state::Level::Info,
            format!(
                "Conversation cleared: @{} joined the relay by itself, and its new conversation is not uploaded, so it leaves the relay in a few minutes. Turn on Upload session for the new conversation to keep it.",
                leaving.join(", @")
            ),
        );
    }
    found.retain(|target, _| admission.admits(target));
    eligible
}

/// What the sharing policy admits of `targets`: the sessions the install
/// uploads (under `selected` those a person chose, under `new` those
/// started after setup, under `all` those not withheld), and those the
/// uploader never collects, which are not the policy's to hold back.
pub async fn admitted(core: &Core, targets: Vec<SessionTarget>) -> Admission {
    let account = core.plugins.account.as_ref();
    let uploader = account.map(|a| a.uploader());
    let looked = account.is_some_and(|a| a.looked_for_install());
    let workspace = core.store.read(|store| {
        store
            .cloud
            .as_ref()
            .and_then(|cloud| cloud.account_workspace_id.clone())
    });
    admitted_by(uploader, looked, workspace, targets).await
}

async fn admitted_by(
    uploader: Option<Arc<Uploader>>,
    looked: bool,
    workspace: Option<String>,
    targets: Vec<SessionTarget>,
) -> Admission {
    let Some(uploader) = uploader else {
        return Admission::All;
    };
    let (uncollected, collected): (Vec<_>, Vec<_>) = targets
        .into_iter()
        .map(|target| (target.upload_key(), target))
        .partition(|(key, _)| key.is_none());
    let Some(install) = uploader.install() else {
        // Before the account first looks, wait for it. After, nothing
        // uploads here (never connected, disconnected or signed out), so
        // no session that could upload joins by itself.
        return if looked {
            Admission::Only(uncollected.into_iter().map(|(_, target)| target).collect())
        } else {
            Admission::Unknown(None)
        };
    };
    // Another workspace's install does not decide this relay. With the
    // relay's account workspace unknown, the install here still does.
    if workspace.is_some() && install.target.workspace_id != workspace {
        return Admission::All;
    }
    let Some(directory) = install.directory.map(PathBuf::from) else {
        return Admission::All;
    };
    // A newer build's claim decides only while its process is live.
    let live = directory.clone();
    if tokio::task::spawn_blocking(move || crate::delivery_status::newer_build_live(&live))
        .await
        .unwrap_or(install.upgrade_required)
    {
        return Admission::Unknown(None);
    }
    let identities = collected
        .iter()
        .filter_map(|(key, _)| {
            let (source, session_id) = key.as_deref()?.split_once(':')?;
            Some(SessionIdentity {
                source: source.into(),
                session_id: session_id.into(),
            })
        })
        .collect::<Vec<_>>();
    let reader = match uploader.try_history_reader() {
        Ok(reader) => reader,
        // A collector start or a session reset holds history briefly.
        Err(error) if error.data.kind == crate::relay::protocol::ErrorKind::Busy => {
            return Admission::Unknown(None)
        }
        Err(error) => return Admission::Unknown(Some(unread(&error.message))),
    };
    let read = tokio::task::spawn_blocking(move || {
        crate::delivery_status::inclusion(&directory, &identities)
    })
    .await;
    drop(reader);
    match read {
        Ok(Ok((_, read))) if read.len() == collected.len() => Admission::Only(
            uncollected
                .into_iter()
                .map(|(_, target)| target)
                .chain(
                    collected
                        .into_iter()
                        .zip(read)
                        // A session whose upload Cloud confirmed deleted stays
                        // off, even if the process stopped before its local
                        // exclusion was saved.
                        .filter(|(_, inclusion)| {
                            inclusion.included && !inclusion.deleted_from_cloud
                        })
                        .map(|((_, target), _)| target),
                )
                .collect(),
        ),
        Ok(Ok(_)) => Admission::Unknown(Some(unread("the read was incomplete"))),
        Ok(Err(error)) => Admission::Unknown(Some(unread(&error.to_string()))),
        Err(error) => Admission::Unknown(Some(unread(&error.to_string()))),
    }
}

fn unread(why: &str) -> String {
    format!("Could not read which sessions upload, so no session joins the relay by itself: {why}")
}

/// The upload keys of `registrations`, and of those a person (or the
/// session, asked by its person) put on the relay: an automatically
/// activated one follows the sharing policy instead.
fn registered_keys<'a>(
    registrations: impl Iterator<Item = &'a crate::relay::store::Registration>,
) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut keys = (BTreeSet::new(), BTreeSet::new());
    for r in registrations {
        let Some(key) = r.target.upload_key() else {
            continue;
        };
        if r.auto_activated != Some(true) {
            keys.1.insert(key.clone());
        }
        keys.0.insert(key);
    }
    keys
}

fn belongs_to_upload_workspace(
    registered_key: Option<&crate::relay::workspace::Secret>,
    registered_origin: &str,
    upload_key: &crate::relay::workspace::Secret,
    upload_origin: &str,
) -> bool {
    registered_key == Some(upload_key) && registered_origin == upload_origin
}

impl RelayUploads {
    /// The account looked for this computer's install (`Account::discover`).
    pub fn looked_for_install(&self) {
        self.looked.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// The registered sessions shared with the workspace, as `source:id`
    /// keys, when the last pass looked.
    pub fn has_looked(&self) -> bool {
        self.looked.load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn shared(&self) -> BTreeSet<String> {
        self.shared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// One pass: includes what `pending` names and says so on `invalidated`.
    pub async fn sync(&self, core: &Core, uploader: &Uploader) {
        // One pass at a time; a pass already running sees the same state.
        let Ok(_one) = self.running.try_lock() else {
            return;
        };
        let Some(install) = uploader.install() else {
            // Signed out or detached: nothing is shared any more.
            self.shared
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clear();
            return;
        };
        // A newer build's claim suppresses inclusion only while its process
        // is live: a claim left behind by an exited collector must not stop
        // every pass. An install listed without its directory keeps the
        // cached flag.
        let directory = install.directory.clone().map(PathBuf::from);
        let upgrade_live = match directory.clone() {
            Some(directory) => tokio::task::spawn_blocking(move || {
                crate::delivery_status::newer_build_live(&directory)
            })
            .await
            .unwrap_or(install.upgrade_required),
            None => install.upgrade_required,
        };
        if upgrade_live {
            return;
        }
        let target = install.target;
        // `chosen`: the registered keys a person put on the relay.
        let (registered, chosen, registrations): (
            BTreeSet<String>,
            BTreeSet<String>,
            Vec<crate::relay::store::Registration>,
        ) = core.store.read(|store| {
            // Registrations outlive sign-out and retain their original key.
            // Only the authenticated upload workspace may auto-include them.
            let Some(cloud) = store.cloud.as_ref().filter(|cloud| {
                cloud.account_workspace_id.is_some()
                    && cloud.account_workspace_id == target.workspace_id
            }) else {
                return Default::default();
            };
            let registrations: Vec<_> = store
                .registrations
                .iter()
                .filter(|r| {
                    belongs_to_upload_workspace(
                        r.workspace_key.as_ref(),
                        &r.base_url,
                        &cloud.key,
                        &cloud.base_url,
                    )
                })
                .cloned()
                .collect();
            let (registered, chosen) = registered_keys(registrations.iter());
            (registered, chosen, registrations)
        });
        {
            let mut requested = self.requested.lock().unwrap();
            if requested.0.as_ref() != Some(&target) {
                *requested = (Some(target.clone()), BTreeSet::new());
            }
            if registered.is_empty() {
                requested.1.clear();
                self.shared
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clear();
                return;
            }
        }
        let Some(directory) = directory else {
            return;
        };
        // Only the registered sessions are read, in process: a few indexed
        // lookups, never the listing.
        let sessions: Vec<(String, SessionIdentity)> = registered
            .iter()
            .filter_map(|key| {
                let (source, session_id) = key.split_once(':')?;
                Some((
                    key.clone(),
                    SessionIdentity {
                        source: source.into(),
                        session_id: session_id.into(),
                    },
                ))
            })
            .collect();
        let Ok(reader) = uploader.try_history_reader() else {
            return;
        };
        let identities = sessions
            .iter()
            .map(|(_, identity)| identity.clone())
            .collect::<Vec<_>>();
        let read = tokio::task::spawn_blocking(move || {
            crate::delivery_status::inclusion(&directory, &identities)
        })
        .await;
        drop(reader);
        let Ok(Ok((mode, read))) = read else {
            return;
        };
        if uploader.target().as_ref() != Some(&target) {
            return;
        }
        let read: Read = sessions.into_iter().map(|(key, _)| key).zip(read).collect();
        // Upload Off is an explicit privacy choice. The saved exclusion is
        // authoritative even after this process's requested cache is lost.
        // Only the confirmed Cloud-deletion journal authorizes integration
        // cleanup. A plain exclusion or a missing read never grants it.
        // Manual registrations must leave too, rather than re-upload on restart.
        for registration in registrations {
            let denied = registration
                .target
                .upload_key()
                .and_then(|key| read.get(&key))
                .is_some_and(|session| session.deleted_from_cloud);
            if denied {
                if let Err(error) = core.unregister_upload_excluded(&registration.name).await {
                    core.hub.activity(
                        crate::relay::state::Level::Warning,
                        format!(
                            "Uploads are off, but @{} could not leave Agent Relay yet: {}",
                            registration.name, error.message
                        ),
                    );
                }
            }
        }
        *self.shared.lock().unwrap_or_else(|e| e.into_inner()) = shared(&registered, &read);
        let keys = {
            let mut requested = self.requested.lock().unwrap();
            if requested.0.as_ref() != Some(&target) {
                return;
            }
            let keys = pending(&chosen, mode, &read, &mut requested.1);
            requested.1.extend(keys.iter().cloned());
            keys
        };
        if keys.is_empty() {
            return;
        }
        if uploader
            .sessions_change_for(&target, true, &keys)
            .await
            .is_ok()
        {
            self.shared
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .extend(keys.iter().cloned());
            core.hub.invalidated(Listing::Uploader);
        } else {
            // Not asked after all: the next pass tries again.
            let mut requested = self.requested.lock().unwrap();
            if requested.0.as_ref() == Some(&target) {
                for key in &keys {
                    requested.1.remove(key);
                }
            }
        }
    }
}

/// Runs a pass whenever the agents change, for the daemon's life; the
/// supervision tick runs the others.
pub async fn watch(core: Arc<Core>, uploader: Arc<Uploader>, uploads: Arc<RelayUploads>) {
    use crate::relay::protocol::Topic;
    let mut events = core.hub.subscribe();
    loop {
        match events.recv().await {
            Ok(event) => {
                if event.topic == Topic::Invalidated
                    && matches!(event.data["what"].as_str(), Some("agents" | "uploader"))
                {
                    uploads.sync(&core, &uploader).await;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                uploads.sync(&core, &uploader).await;
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn automatic_uploads_do_not_follow_registrations_into_another_workspace() {
        use crate::relay::workspace::Secret;
        let original = Secret::new("rk_live_original");
        let other = Secret::new("rk_live_other");
        assert!(super::belongs_to_upload_workspace(
            Some(&original),
            "https://cast.agentrelay.com",
            &original,
            "https://cast.agentrelay.com"
        ));
        assert!(!super::belongs_to_upload_workspace(
            Some(&original),
            "https://cast.agentrelay.com",
            &other,
            "https://cast.agentrelay.com"
        ));
        assert!(!super::belongs_to_upload_workspace(
            None,
            "https://cast.agentrelay.com",
            &other,
            "https://cast.agentrelay.com"
        ));
        assert!(!super::belongs_to_upload_workspace(
            Some(&original),
            "https://other.example",
            &original,
            "https://cast.agentrelay.com"
        ));
    }

    use super::*;

    fn keys(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    fn read(sessions: &[(&str, bool, bool)]) -> Read {
        sessions
            .iter()
            .map(|(key, selectable, included)| {
                (
                    key.to_string(),
                    Inclusion {
                        selectable: *selectable,
                        included: *included,
                        explicitly_excluded: false,
                        deleted_from_cloud: false,
                    },
                )
            })
            .collect()
    }

    #[test]
    fn includes_registered_sessions_the_uploader_holds_but_does_not_upload() {
        let registered = keys(&["codex:a", "claude:b", "codex:c", "codex:e"]);
        // `codex:c` is not captured yet; `codex:e` is another session's subagent.
        let sessions = read(&[
            ("codex:a", true, false),
            ("claude:b", true, true),
            ("codex:c", false, false),
            ("codex:e", false, false),
        ]);
        let mut requested = BTreeSet::new();
        assert_eq!(
            pending(&registered, SharingMode::New, &sessions, &mut requested),
            vec!["codex:a"]
        );
    }

    #[test]
    fn only_included_registered_sessions_are_shared() {
        let registered = keys(&["codex:a", "claude:b"]);
        let sessions = read(&[("codex:a", true, false), ("claude:b", true, true)]);
        assert_eq!(shared(&registered, &sessions), keys(&["claude:b"]));
        // Under `all`, a session nobody withheld is included before capture.
        let uncaptured = read(&[("codex:a", false, true), ("claude:b", false, true)]);
        assert_eq!(shared(&registered, &uncaptured), registered);
    }

    #[test]
    fn asks_once_until_the_session_leaves_the_relay() {
        let sessions = read(&[("codex:a", true, false)]);
        let mut requested = keys(&["codex:a"]);
        let on = keys(&["codex:a"]);
        assert!(pending(&on, SharingMode::Selected, &sessions, &mut requested).is_empty());
        // Off the relay: forgotten, so returning asks again.
        assert!(pending(
            &BTreeSet::new(),
            SharingMode::Selected,
            &sessions,
            &mut requested
        )
        .is_empty());
        assert!(requested.is_empty());
        assert_eq!(
            pending(&on, SharingMode::Selected, &sessions, &mut requested),
            vec!["codex:a"]
        );
    }

    #[cfg(feature = "history")]
    #[tokio::test]
    async fn the_installs_sharing_decides_which_sessions_join_by_themselves() {
        use crate::delivery::{self, SessionIdentity};
        use crate::relay::store::SessionKind;
        use crate::relay::uploader::{Install, ProcessRunner};
        let directory = crate::delivery_status::status_tests::install(&[
            "codex:chosen",
            "codex:other",
            "codex:local",
        ]);
        let config_path = directory.path().join("config.json");
        let config = |change: &dyn Fn(&mut serde_json::Value)| {
            let mut config: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
            change(&mut config);
            std::fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        };
        let identity = |id: &str| SessionIdentity {
            source: "codex".into(),
            session_id: id.into(),
        };
        let conn = delivery::open_db(&directory.path().join("history.db")).unwrap();
        let read: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
        let job_id = read["job_id"].as_str().unwrap().to_string();
        let target = |id: &str| SessionTarget::new(SessionKind::Codex, id);
        let (chosen, other, local) = (target("chosen"), target("other"), target("local"));
        let uncollected = SessionTarget::new(SessionKind::OpenClaw, "agent");
        let targets = vec![
            chosen.clone(),
            other.clone(),
            local.clone(),
            uncollected.clone(),
        ];
        let workspace = Some("workspace".to_string());

        // Nothing uploads here: the policy has nothing to hold back.
        assert_eq!(
            admitted_by(None, false, workspace.clone(), targets.clone()).await,
            Admission::All
        );
        let root = tempfile::tempdir().unwrap();
        let uploader = Arc::new(Uploader::new(Arc::new(
            ProcessRunner::new(root.path().join("must-not-run")).with_env("HOME", root.path()),
        )));
        let admitted = |looked: bool, workspace: Option<String>| {
            admitted_by(Some(uploader.clone()), looked, workspace, targets.clone())
        };
        // Not attached before the account looked: wait, quietly. Still
        // none once it looked: nothing uploads here, so only what never
        // could upload joins.
        assert_eq!(
            admitted(false, workspace.clone()).await,
            Admission::Unknown(None)
        );
        assert_eq!(
            admitted(true, workspace.clone()).await,
            Admission::Only(HashSet::from([uncollected.clone()]))
        );
        let attach = |workspace_id: &str| {
            uploader.attach(Install::from_json(&serde_json::json!({
                "site_url": "https://agentrelay.com",
                "workspace_id": workspace_id,
                "directory": directory.path().to_str().unwrap(),
            })));
        };
        attach("workspace");

        // `selected`: only the session a person chose; one never chosen,
        // though captured and not withheld, stays local.
        config(&|c| c["sharing_mode"] = "selected".into());
        delivery::adopt_session_job(&conn, &job_id, &[identity("chosen")]).unwrap();
        assert_eq!(
            admitted(true, workspace.clone()).await,
            Admission::Only(HashSet::from([chosen.clone(), uncollected.clone()]))
        );
        // A session someone stopped uploading leaves under any policy.
        delivery::include_job_session(&conn, &job_id, &identity("other")).unwrap();
        delivery::set_session_excluded(&conn, &identity("other"), true).unwrap();
        assert_eq!(
            admitted(true, workspace.clone()).await,
            Admission::Only(HashSet::from([chosen.clone(), uncollected.clone()]))
        );

        // Another workspace's install does not decide this relay; with the
        // relay's workspace unknown, the install here does.
        assert_eq!(
            admitted(true, None).await,
            Admission::Only(HashSet::from([chosen.clone(), uncollected.clone()]))
        );
        attach("other");
        assert_eq!(admitted(true, workspace.clone()).await, Admission::All);
        attach("workspace");
        // Unreadable: nothing new joins, no one leaves, and it says why.
        std::fs::write(&config_path, b"not json").unwrap();
        assert!(matches!(
            admitted(true, workspace).await,
            Admission::Unknown(Some(_))
        ));
        assert!(!Admission::Unknown(None).admits(&chosen));
        assert!(!Admission::Unknown(None).admits(&local));
    }

    #[test]
    fn automatically_activated_sessions_are_not_asked_to_upload() {
        use crate::relay::store::{Registration, SessionKind};
        let registration = |id: &str, automatic: bool| {
            let mut r: Registration = serde_json::from_value(serde_json::json!({
                "name": id, "agentID": id, "baseURL": "https://cast.agentrelay.com",
                "target": {"kind": "codex", "id": id}, "title": id,
                "registeredAt": "2026-10-29T00:00:00Z",
            }))
            .unwrap();
            r.auto_activated = automatic.then_some(true);
            r
        };
        let added = registration("added", false);
        let automatic = registration("automatic", true);
        let (registered, chosen) = registered_keys([&added, &automatic].into_iter());
        let key = |id| {
            SessionTarget::new(SessionKind::Codex, id)
                .upload_key()
                .unwrap()
        };
        assert_eq!(registered, BTreeSet::from([key("added"), key("automatic")]));
        assert_eq!(chosen, BTreeSet::from([key("added")]));
    }

    #[test]
    fn a_manual_upload_off_survives_a_cold_requested_cache() {
        let registered = keys(&["codex:manual"]);
        let sessions = Read::from([(
            "codex:manual".into(),
            Inclusion {
                selectable: true,
                included: false,
                explicitly_excluded: true,
                deleted_from_cloud: true,
            },
        )]);
        // A fresh core knows nothing about the previous process's requests.
        // The durable exclusion alone must prevent an automatic include.
        assert!(pending(
            &registered,
            SharingMode::Selected,
            &sessions,
            &mut BTreeSet::new()
        )
        .is_empty());
        assert!(pending(
            &registered,
            SharingMode::New,
            &sessions,
            &mut BTreeSet::new()
        )
        .is_empty());
    }

    // Uploads live in the session-history delivery store.
    #[cfg(feature = "history")]
    #[tokio::test]
    async fn manual_upload_off_leaves_relay_and_stays_off_after_core_restart() {
        use crate::delivery;
        use crate::relay::daemon::Config;
        use crate::relay::paths::CorePaths;
        use crate::relay::store::{CloudWorkspace, Registration, SessionKind};
        use crate::relay::uploader::{Install, ProcessRunner};
        use crate::relay::workspace::Secret;
        use std::time::Duration;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let id = "019a0000-0000-7000-8000-000000000001";
        let key = format!("codex:{id}");
        let directory = crate::delivery_status::status_tests::install(&[&key]);
        let config_path = directory.path().join("config.json");
        let mut upload_config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
        upload_config["sharing_mode"] = "selected".into();
        std::fs::write(&config_path, serde_json::to_vec(&upload_config).unwrap()).unwrap();
        let conn = delivery::open_db(&directory.path().join("history.db")).unwrap();
        let identity = delivery::SessionIdentity {
            source: "codex".into(),
            session_id: id.into(),
        };
        let job = upload_config["job_id"].as_str().unwrap();
        delivery::adopt_session_job(&conn, job, std::slice::from_ref(&identity)).unwrap();
        // The completed deletion's durable local consent, independent of this
        // core process or its requested set. Cloud deletion itself is tested
        // by the command and History-service integration fixtures.
        delivery::set_session_excluded(&conn, &identity, true).unwrap();
        delivery::set_job_session(&conn, job, &identity, false).unwrap();
        std::fs::write(
            directory.path().join("deleted-uploads.json"),
            serde_json::to_vec(&BTreeMap::from([(key.clone(), vec![identity.clone()])])).unwrap(),
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                assert_eq!(stream.read(&mut byte).await.unwrap(), 1);
                request.push(byte[0]);
            }
            assert!(String::from_utf8(request)
                .unwrap()
                .starts_with("DELETE /v1/agents/manual "));
            stream
                .write_all(
                    b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });
        let root = tempfile::tempdir().unwrap();
        let config = Config {
            paths: CorePaths::for_socket(root.path().join("core.sock")).unwrap(),
            home: root.path().into(),
            app_data_dir: root.path().join("app-data"),
            env: BTreeMap::new(),
            version: "test".into(),
            host_name: "Test Desk".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: Default::default(),
            delivery_timing: Default::default(),
        };
        let (core, _) = Core::new(config.clone());
        let registration: Registration = serde_json::from_value(serde_json::json!({
            "name":"manual", "agentID":"manual-id", "target":{"kind":"codex","id":id},
            "title":"Manual session", "baseURL":base, "registeredAt":"2026-11-02T00:00:00Z",
            "workspaceKey":"rk_live_test"
        }))
        .unwrap();
        assert_eq!(
            registration.auto_activated, None,
            "the registration is manual"
        );
        core.store
            .update(|store| {
                store.cloud = Some(CloudWorkspace {
                    key: Secret::new("rk_live_test"),
                    base_url: base,
                    account_workspace_id: Some("workspace".into()),
                    ..Default::default()
                });
                assert!(store.add(registration, Secret::new("at_live_test")));
            })
            .unwrap();
        let uploader = Uploader::new(Arc::new(ProcessRunner::new(
            root.path().join("must-not-include"),
        )));
        uploader.attach(Install::from_json(&serde_json::json!({
            "site_url":"https://agentrelay.com", "workspace_id":"workspace",
            "directory":directory.path().to_str().unwrap()
        })));
        tokio::time::timeout(
            Duration::from_secs(5),
            RelayUploads::default().sync(&core, &uploader),
        )
        .await
        .unwrap();
        assert!(core.store.read(|store| store.registrations.is_empty()));
        server.await.unwrap();
        drop(core);
        // A fresh core reloads registrations from disk (none now) and loses
        // its in-memory requests. The saved exclusion outlives the process:
        // its sync, after new local activity, includes nothing again.
        let (restarted, _) = Core::new(config);
        conn.execute(
            "UPDATE sessions SET last_activity_ms=99 WHERE session_id=?",
            [id],
        )
        .unwrap();
        RelayUploads::default().sync(&restarted, &uploader).await;
        assert!(restarted.store.read(|store| store.registrations.is_empty()));
        assert!(delivery::is_explicitly_excluded(&conn, &identity).unwrap());
        assert!(!delivery::job_session_included(&conn, job, &identity).unwrap());
        assert_eq!(
            SessionTarget::new(SessionKind::Codex, id)
                .upload_key()
                .unwrap(),
            key
        );
    }

    #[test]
    fn sharing_everything_needs_nothing() {
        let sessions = read(&[("codex:a", true, false)]);
        let mut requested = BTreeSet::new();
        assert!(pending(
            &keys(&["codex:a"]),
            SharingMode::All,
            &sessions,
            &mut requested
        )
        .is_empty());
    }
}
