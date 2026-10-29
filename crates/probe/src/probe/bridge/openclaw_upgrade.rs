//! One pass, once per install, that carries the desktop's choices from
//! OpenClaw's old session IDs to its conversations.
//!
//! relayhistory 0.49 records one OpenClaw session per conversation key
//! instead of one per transcript window (every heartbeat or cron run opened a
//! window). The old window IDs (`<agent>:<window session id>`) retire on the
//! next sweep; each conversation keeps a `session:<window session id>` marker
//! per window. A conversation inherits the choices made about its windows:
//! selected, excluded or deleted from the cloud.
//!
//! Choices are added, never moved. The old IDs keep their membership and
//! their absence of exclusion, so the deletion records their retirement emits
//! still pass consent and remove the old copies from the cloud. Hydration
//! passes over them (see [`hydratable`]): nothing local is left to read.
use super::{deleted_uploads, mode, saved, selected, SharingMode};
use crate::{save_json, Config};
use agent_relay_probe::delivery::{self, SessionIdentity};
use ai_hist::{Source, SyncOptions};
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

const STATE: &str = "openclaw-conversations.json";
const SOURCE: &str = "openclaw";
/// Sweeps that may fail before the carry-over uses whatever conversations the
/// store already holds: a broken OpenClaw store must not stop delivery.
const ATTEMPTS: u32 = 3;
const LOCK_WAIT_MS: u64 = 30_000;

#[derive(Default, Serialize, Deserialize)]
struct Upgrade {
    done: bool,
    #[serde(default)]
    failed_sweeps: u32,
    /// Old window ID → its conversation's ID.
    #[serde(default)]
    renamed: BTreeMap<String, String>,
}

fn load(directory: &Path) -> Result<Upgrade> {
    saved(&directory.join(STATE))
}

/// [`super::enforce_selection`] for a delivery pass: before delivery can see
/// an OpenClaw conversation, it inherits its windows' choices.
pub(crate) fn enforce_selection(directory: &Path, config: &Config) -> Result<()> {
    migrate(directory, mode(config) == SharingMode::Selected)?;
    super::enforce_selection(directory, config)
}

/// Delivery-thread variant reusing its validated connection.
pub(crate) fn enforce_selection_from(
    conn: &Connection,
    directory: &Path,
    config: &Config,
) -> Result<()> {
    migrate(directory, mode(config) == SharingMode::Selected)?;
    super::enforce_selection_from(conn, directory, config)
}

/// `members` without the old OpenClaw window IDs a conversation replaced:
/// they stay members only so their deletions are sent, and hydrating one
/// fails.
pub(crate) fn hydratable(directory: &Path, members: Vec<SessionIdentity>) -> Vec<SessionIdentity> {
    let renamed = load(directory).map(|s| s.renamed).unwrap_or_default();
    members
        .into_iter()
        .filter(|m| m.source != SOURCE || !renamed.contains_key(&m.session_id))
        .collect()
}

fn migrate(directory: &Path, selected_mode: bool) -> Result<()> {
    migrate_with(directory, selected_mode, || {
        let store = crate::history::open(&directory.join("history.db"))?;
        let mut options = SyncOptions::default();
        options.sources = Some(vec![Source::OpenClaw]);
        options.lock_timeout_ms = LOCK_WAIT_MS;
        store.sync(options)?;
        Ok(())
    })
}

/// [`migrate`] with the OpenClaw sweep supplied, which records each
/// conversation's window markers and retires the old window rows. The
/// caller holds the collector lock.
pub(super) fn migrate_with(
    directory: &Path,
    selected_mode: bool,
    sweep: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let mut state = load(directory)?;
    if state.done {
        return Ok(());
    }
    let conn = delivery::open_db(&directory.join("history.db"))?;
    let named = named(directory, &conn)?;
    if !named.is_empty() {
        if let Err(error) = sweep() {
            // Another sweep holding the store is not a failure of OpenClaw's.
            let locked = matches!(
                error.downcast_ref::<ai_hist::Error>(),
                Some(ai_hist::Error::SyncLocked { .. })
            );
            if !locked {
                state.failed_sweeps += 1;
                save_json(&directory.join(STATE), &state)?;
            }
            if locked || state.failed_sweeps < ATTEMPTS {
                return Err(error.context("OpenClaw sessions are being upgraded"));
            }
        }
        state.renamed = conversations(&conn, &named)?;
        carry_over(directory, &conn, selected_mode, &state.renamed)?;
    }
    state.done = true;
    save_json(&directory.join(STATE), &state)
}

fn column(conn: &Connection, sql: &str) -> Result<Vec<String>> {
    Ok(conn
        .prepare(sql)?
        .query_map([SOURCE], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

const EXCLUDED: &str = "SELECT session_id FROM delivery_exclusions WHERE source=?";

/// Every OpenClaw ID a choice names: selected, a member of any job, excluded,
/// or deleted from the cloud.
fn named(directory: &Path, conn: &Connection) -> Result<HashSet<String>> {
    let mut ids: HashSet<String> = selected(directory)?
        .into_iter()
        .chain(deleted_uploads(directory)?.into_values().flatten())
        .filter(|identity| identity.source == SOURCE)
        .map(|identity| identity.session_id)
        .collect();
    ids.extend(column(
        conn,
        "SELECT session_id FROM delivery_session_members WHERE source=?",
    )?);
    ids.extend(column(conn, EXCLUDED)?);
    Ok(ids)
}

/// Which conversation holds each named window, from the conversations' own
/// window markers. A window ID still recorded as a session of its own (a
/// legacy transcript nothing imported) keeps its identity.
fn conversations(conn: &Connection, named: &HashSet<String>) -> Result<BTreeMap<String, String>> {
    let windows = conn
        .prepare(
            "SELECT session_id, substr(marker_uid, 9) FROM session_markers \
             WHERE source=?1 AND kind='session_metadata' AND marker_uid LIKE 'session:%'",
        )?
        .query_map([SOURCE], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut renamed = BTreeMap::new();
    for (conversation, window) in windows {
        // `<namespace>:<window>` for the conversation `<namespace>:<name>`.
        let Some(old) = named.iter().find(|old| {
            old.strip_suffix(window.as_str())
                .is_some_and(|ns| ns.ends_with(':') && conversation.starts_with(ns))
        }) else {
            continue;
        };
        if *old != conversation && !recorded(conn, old)? {
            renamed.insert(old.clone(), conversation);
        }
    }
    Ok(renamed)
}

fn recorded(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sessions WHERE source=? AND session_id=?",
            params![SOURCE, id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn identity(session_id: &str) -> SessionIdentity {
    SessionIdentity {
        source: SOURCE.into(),
        session_id: session_id.into(),
    }
}

/// What a conversation inherits from its windows. A window deleted from the
/// cloud withholds it: the cloud stopped accepting the window's ID, not the
/// conversation's. So does an excluded window, except where another window
/// was selected: switching to selected sharing excludes every session it does
/// not name, and that baseline must not undo a person's choice. Withheld
/// conversations are excluded first, so none becomes a member it is withheld
/// from.
fn carry_over(
    directory: &Path,
    conn: &Connection,
    selected_mode: bool,
    renamed: &BTreeMap<String, String>,
) -> Result<()> {
    if renamed.is_empty() {
        return Ok(());
    }
    let to = |ids: Vec<String>| -> HashSet<String> {
        ids.iter()
            .filter_map(|id| renamed.get(id).cloned())
            .collect()
    };
    let excluded = to(column(conn, EXCLUDED)?);
    let members = live_members(conn)?;
    let chosen = to(selected(directory)?
        .into_iter()
        .filter(|identity| identity.source == SOURCE)
        .map(|identity| identity.session_id)
        .chain(members.iter().map(|(_, id)| id.clone()))
        .collect());
    let deleted = carry_deleted(directory, renamed)?;
    let withheld = excluded
        .iter()
        .filter(|id| !(selected_mode && chosen.contains(*id)));
    for id in deleted.iter().chain(withheld) {
        delivery::set_session_excluded(conn, &identity(id), true)?;
    }
    carry_selected(directory, renamed, &deleted)?;
    for (job, old) in members {
        if let Some(id) = renamed.get(&old).filter(|id| !deleted.contains(*id)) {
            delivery::set_job_session(conn, &job, &identity(id), true)
                .with_context(|| format!("carry an OpenClaw selection over to {id}"))?;
        }
    }
    Ok(())
}

/// `(job, session)` for each OpenClaw member chosen in its own right.
fn live_members(conn: &Connection) -> Result<Vec<(String, String)>> {
    Ok(conn
        .prepare(
            "SELECT m.job_id, m.session_id FROM delivery_session_members m \
             JOIN delivery_jobs j ON j.id=m.job_id \
             WHERE m.source=? AND m.delegated=0 AND j.state<>'cancelled'",
        )?
        .query_map([SOURCE], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

/// Each deleted family gains its windows' conversations, so a restore
/// re-enables them with it. Returns the conversations a deletion withholds.
fn carry_deleted(directory: &Path, renamed: &BTreeMap<String, String>) -> Result<HashSet<String>> {
    let mut families = deleted_uploads(directory)?;
    let mut deleted = HashSet::new();
    let mut changed = false;
    for family in families.values_mut() {
        let added: HashSet<String> = family
            .iter()
            .filter(|member| member.source == SOURCE)
            .filter_map(|member| renamed.get(&member.session_id).cloned())
            .collect();
        for id in added {
            if !family.contains(&identity(&id)) {
                family.push(identity(&id));
                changed = true;
            }
            deleted.insert(id);
        }
    }
    if changed {
        save_json(&directory.join("deleted-uploads.json"), &families)?;
    }
    Ok(deleted)
}

fn carry_selected(
    directory: &Path,
    renamed: &BTreeMap<String, String>,
    deleted: &HashSet<String>,
) -> Result<()> {
    let mut list = selected(directory)?;
    let added: Vec<_> = list
        .iter()
        .filter(|identity| identity.source == SOURCE)
        .filter_map(|identity| renamed.get(&identity.session_id))
        .filter(|id| !deleted.contains(*id))
        .map(|id| identity(id))
        .collect();
    let before = list.len();
    for conversation in added {
        if !list.contains(&conversation) {
            list.push(conversation);
        }
    }
    if list.len() != before {
        save_json(&directory.join("selected.json"), &list)?;
    }
    Ok(())
}
