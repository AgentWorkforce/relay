//! Prompt-based naming shared by every desktop UI. Reads local counts only;
//! generation uses the existing, consented Cloud session brief, never an injected
//! provider turn and never a change to sharing. Offline/pending keeps both names.
use crate::relay::{
    cloud_session::CloudAccount, contract::agents::SessionTitleSetParams, daemon::Core,
    protocol::ErrorKind, sessions::DiscoveredSession, store::Registration,
};
use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, path::Path, sync::Arc, time::Duration};

const PROMPTS: u64 = 10;
const RETRY_MS: i64 = 5 * 60 * 1000;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct PromptCheckpoint {
    pub count: u64,
    pub latest_prompt_ms: Option<i64>,
}

/// Probe helpers always return an object, including absent local evidence.
#[derive(Deserialize, Serialize)]
pub struct PromptCheckpointResponse {
    pub checkpoint: Option<PromptCheckpoint>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct Entry {
    count: u64,
    title: String,
    name: String,
    retry_after_ms: i64,
    #[serde(default)]
    observed: PromptCheckpoint,
    #[serde(default)]
    observed_at_ms: i64,
}
impl Entry {
    fn baseline(prompts: &PromptCheckpoint, row: &Registration) -> Self {
        Self {
            count: prompts.count,
            title: row.title.clone(),
            name: row.display_name().into(),
            retry_after_ms: 0,
            observed: prompts.clone(),
            observed_at_ms: 0,
        }
    }
    fn observed_checkpoint(&self, row: &Registration, now: i64) -> Option<PromptCheckpoint> {
        (self.title == row.title
            && self.name == row.display_name()
            && now >= self.observed_at_ms
            && now - self.observed_at_ms < RETRY_MS)
            .then(|| self.observed.clone())
    }

    fn due(&mut self, prompts: &PromptCheckpoint, row: &Registration, now: i64) -> bool {
        // Manual edits and a rebuilt/reset reader start a fresh interval.
        if self.title != row.title || self.name != row.display_name() || prompts.count < self.count
        {
            *self = Self::baseline(prompts, row);
        }
        prompts.count.saturating_sub(self.count) >= PROMPTS && now >= self.retry_after_ms
    }
}

#[derive(Default, Deserialize, Serialize)]
struct Journal {
    entries: BTreeMap<String, Entry>,
    // Retry pacing is process-local; only prompt baselines require durable storage.
    #[serde(skip)]
    evidence_attempts: BTreeMap<String, i64>,
}
impl Journal {
    fn awaiting_evidence(&self, key: &str, now: i64) -> bool {
        self.evidence_attempts
            .get(key)
            .is_some_and(|observed| now >= *observed && now - observed < RETRY_MS)
    }

    fn load(path: &Path) -> anyhow::Result<Self> {
        match std::fs::read(path) {
            Ok(bytes) => {
                anyhow::ensure!(
                    bytes.len() <= 2 * 1024 * 1024,
                    "Naming journal is too large."
                );
                Ok(serde_json::from_slice(&bytes)?)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error.into()),
        }
    }
    fn save(&self, path: &Path) -> anyhow::Result<()> {
        crate::platform::fs::create_private_dir_all(
            path.parent()
                .context("Naming checkpoint has no parent directory")?,
        )?;
        crate::relay::outbox::write_atomic(path, &serde_json::to_vec(self)?)?;
        Ok(())
    }
}

fn authority(core: &Core, account: &CloudAccount, generation: u64) -> bool {
    let active = core.workspace();
    let verified = core.verified_workspace_id();
    core.plugins.cloud.may_sync_identities()
        && core.plugins.cloud.identity_sync_generation() == generation
        && core.plugins.cloud.account().as_ref() == Some(account)
        && core.store.read(|store| {
            store.cloud.as_ref().is_some_and(|cloud| {
                cloud.account_workspace_id.as_deref() == Some(account.workspace_id.as_str())
                    && active.as_ref().is_some_and(|active| {
                        active.base_url == cloud.base_url
                            && (active.key == cloud.key
                                || (cloud.workspace_id.is_some() && verified == cloud.workspace_id))
                    })
            })
        })
}

/// Automatic edits carry the account and exact registration they were based
/// on, including across native-title and remote-alias lock waits. They are
/// checked (`current`) just before the write, under the title's own lock;
/// rename, archive and removal take the registration's lock instead, so one
/// landing between that check and the write is not fenced, only made
/// unlikely.
pub(crate) struct AutomaticEdit {
    pub registration: Registration,
    pub account: CloudAccount,
    pub generation: u64,
}
impl AutomaticEdit {
    pub(crate) fn current(&self, core: &Core) -> bool {
        authority(core, &self.account, self.generation)
            && eligible(core, &self.registration, &self.account)
            && core.store.read(|store| {
                store
                    .registrations
                    .iter()
                    .any(|row| row == &self.registration)
            })
    }
}

fn eligible(core: &Core, row: &Registration, account: &CloudAccount) -> bool {
    row.spawn.is_none()
        && row.archived_at.is_none()
        && row.missing_since.is_none()
        && core.store.read(|store| {
            store.agent_owners.get(&row.agent_id).is_some_and(|owner| {
                Some(owner.user_id.as_str()) == account.user_id.as_deref()
                    && owner.workspace_id.as_deref() == Some(account.workspace_id.as_str())
            })
        })
        && core.workspace().is_some_and(|workspace| {
            row.base_url == workspace.base_url && core.key_for(row).as_ref() == Some(&workspace.key)
        })
}

fn ready_title(value: &Value, row: &Registration, prompts: &PromptCheckpoint) -> Option<String> {
    if value["sessionId"].as_str()? != row.target.id
        || value["sourceProvider"].as_str()? != row.target.kind.source()
        || value["status"] != "ready"
        || value["stale"] != false
    {
        return None;
    }
    let generated = chrono::DateTime::parse_from_rfc3339(value["generatedAt"].as_str()?)
        .ok()?
        .timestamp_millis();
    if generated < prompts.latest_prompt_ms? {
        return None;
    }
    crate::relay::session_titles::validate_title(value["brief"]["title"].as_str()?).ok()
}

pub(crate) async fn watch(core: Arc<Core>) {
    let path = core.config.app_data_dir.join("session-naming.json");
    let Ok(mut journal) = Journal::load(&path) else {
        core.hub.activity(
            crate::relay::state::Level::Warning,
            "Automatic naming could not read its saved checkpoint. Existing names are unchanged.",
        );
        return;
    };
    let mut ticks = tokio::time::interval(Duration::from_secs(60));
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticks.tick().await;
        if pass(&core, &mut journal, &path).await.is_err() {
            // A failed durable checkpoint must never turn into a rename loop.
            core.hub.activity(crate::relay::state::Level::Warning, "Automatic naming could not save its checkpoint. Existing names will be kept until Relay restarts.");
            return;
        }
    }
}

async fn pass(core: &Arc<Core>, journal: &mut Journal, path: &Path) -> anyhow::Result<()> {
    let Some(account) = core.plugins.cloud.account() else {
        return Ok(());
    };
    let generation = core.plugins.cloud.identity_sync_generation();
    if !authority(core, &account, generation) {
        return Ok(());
    }
    let Some(uploader) = core
        .plugins
        .account
        .as_ref()
        .map(|account| account.uploader())
    else {
        return Ok(());
    };
    let sessions = core
        .session_snapshot
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .1
        .clone();
    // Bound work to live, owned registrations. Prune departed registrations,
    // but keep other account checkpoints so switching workspaces cannot replay.
    let ids = core.store.read(|store| {
        store
            .registrations
            .iter()
            .map(|row| row.agent_id.clone())
            .collect::<std::collections::HashSet<_>>()
    });
    journal
        .entries
        .retain(|key, _| ids.iter().any(|id| key.ends_with(&format!("\n{id}"))));
    journal
        .evidence_attempts
        .retain(|key, _| ids.iter().any(|id| key.ends_with(&format!("\n{id}"))));
    for session in sessions.iter().filter(|session| session.live) {
        refresh_session(
            core, journal, path, session, &account, generation, &uploader,
        )
        .await?;
    }
    Ok(())
}

async fn refresh_session(
    core: &Arc<Core>,
    journal: &mut Journal,
    path: &Path,
    session: &DiscoveredSession,
    account: &CloudAccount,
    generation: u64,
    uploader: &crate::relay::uploader::Uploader,
) -> anyhow::Result<()> {
    let Some(row) = core
        .store
        .read(|store| store.registration_for(&session.target).cloned())
    else {
        return Ok(());
    };
    if !eligible(core, &row, account) || !authority(core, account, generation) {
        return Ok(());
    }
    let key = format!(
        "{}\n{}\n{}\n{}",
        account.site_url,
        account.workspace_id,
        account.user_id.as_deref().unwrap_or_default(),
        row.agent_id
    );
    let now = chrono::Utc::now().timestamp_millis();
    if journal.awaiting_evidence(&key, now) {
        return Ok(());
    }
    // Bound expensive native hydration for every provider, including active
    // transcripts and sources without timestamps. Manual edits reset promptly.
    let cached = journal
        .entries
        .get(&key)
        .and_then(|entry| entry.observed_checkpoint(&row, now));
    let hydrated = cached.is_none();
    let prompts = match cached {
        Some(prompts) => prompts,
        None => match uploader
            .naming_checkpoint(row.target.kind.source(), &row.target.id)
            .await
        {
            Ok(prompts) => prompts,
            Err(_) => {
                // Retry pacing starts when the helper attempt finishes.
                journal
                    .evidence_attempts
                    .insert(key, chrono::Utc::now().timestamp_millis());
                return Ok(());
            }
        },
    };
    journal.evidence_attempts.remove(&key);
    let previous = journal.entries.get(&key).cloned();
    let entry = journal
        .entries
        .entry(key)
        .or_insert_with(|| Entry::baseline(&prompts, &row));
    let due = entry.due(&prompts, &row, now);
    entry.observed = prompts.clone();
    if hydrated {
        entry.observed_at_ms = now;
    }
    // Persist before touching native metadata or creating a remote alias.
    if due {
        entry.retry_after_ms = now + RETRY_MS;
    }
    if previous.as_ref() != Some(entry) {
        journal.save(path)?;
    }
    if !due {
        return Ok(());
    }
    let route = crate::relay::methods::session_path_for(&account.workspace_id, &row.target.id)
        .map_err(|e| anyhow::anyhow!(e.message))?;
    let request = core.plugins.cloud.request(
        "GET",
        format!("{route}/brief?source={}", row.target.kind.source()),
        None,
    );
    let Ok(Ok(value)) = tokio::time::timeout(Duration::from_secs(20), request).await else {
        return Ok(());
    };
    let Some(title) = ready_title(&value, &row, &prompts) else {
        return Ok(());
    };
    if !authority(core, account, generation) || !eligible(core, &row, account) {
        return Ok(());
    }
    let key = format!(
        "{}\n{}\n{}\n{}",
        account.site_url,
        account.workspace_id,
        account.user_id.as_deref().unwrap_or_default(),
        row.agent_id
    );
    let Some(entry) = journal.entries.get_mut(&key) else {
        return Ok(());
    };
    if apply(core, &row, session, &title, entry, account, generation).await {
        entry.count = prompts.count;
        entry.retry_after_ms = 0;
    }
    journal.save(path)?;
    Ok(())
}

async fn apply(
    core: &Arc<Core>,
    expected: &Registration,
    session: &DiscoveredSession,
    title: &str,
    entry: &mut Entry,
    account: &CloudAccount,
    generation: u64,
) -> bool {
    let current = || {
        core.store.read(|store| {
            store
                .registrations
                .iter()
                .find(|row| row.agent_id == expected.agent_id)
                .cloned()
        })
    };
    if current().as_ref() != Some(expected) {
        return false;
    }
    if expected.title != title {
        if crate::relay::session_titles::set_native_title_if_current(
            core,
            SessionTitleSetParams {
                source: expected.target.kind.source().into(),
                session_id: expected.target.id.clone(),
                title: title.into(),
            },
            AutomaticEdit {
                registration: expected.clone(),
                account: account.clone(),
                generation,
            },
        )
        .await
        .is_err()
        {
            return false;
        }
        entry.title = title.into();
    }
    let Some(row) = current() else { return false };
    if !authority(core, account, generation)
        || row.title != title
        || row.display_name() != entry.name
    {
        return false;
    }
    let mut named = session.clone();
    named.title = title.into();
    let base = crate::relay::agents::suggested_name(&named);
    for number in 1..=10 {
        let name = if number == 1 {
            base.clone()
        } else {
            let suffix = format!("-{number}");
            format!(
                "{}{}",
                base[..base
                    .len()
                    .min(crate::relay::agents::NAME_MAX - suffix.len())]
                    .trim_end_matches('-'),
                suffix
            )
        };
        match core
            .rename_if_current(
                &AutomaticEdit {
                    registration: row.clone(),
                    account: account.clone(),
                    generation,
                },
                &name,
            )
            .await
        {
            Ok(renamed) => {
                entry.name = renamed.name;
                return true;
            }
            Err(error) if error.data.kind == ErrorKind::Conflict => continue,
            Err(_) => return false,
        }
    }
    false
}

#[cfg(test)]
mod tests;
