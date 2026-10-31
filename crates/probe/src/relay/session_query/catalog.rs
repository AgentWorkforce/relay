use super::*;
use ai_hist::{
    CatalogQuery, ChangeKind, ChangeQuery, SessionQuery, SessionRef, SessionScope, SessionStore,
    StoreOptions, Watermark,
};
use std::path::{Path, PathBuf};
/// Private provenance for a page token. SQLite's data_version belongs to this
/// reader connection; candidate epoch fences keep it with the same index.
pub(crate) struct CatalogVersion {
    pub revision: u64,
    data_version: u64,
    generation: u64,
}

/// A persistent SDK reader and an in-memory, rebuildable projection. No writes
/// to the person's history store, and no local copies of its SQL schema.
pub(crate) struct CatalogIndex {
    pub index: Index,
    store: SessionStore,
    watermark: Watermark,
    retention_generation: u64,
    path: PathBuf,
    home: PathBuf,
    relay_home: PathBuf,
    ignored: HashSet<crate::delivery::SessionIdentity>,
    identity: crate::delivery::DatabaseIdentity,
    projects: HashMap<String, Option<String>>,
    pub(super) project_resolved_at: HashMap<String, std::time::Instant>,
    pending_projects: HashSet<String>,
    project_queue: std::collections::VecDeque<String>,
    project_in_flight: Vec<String>,
    pub(super) project_expiry:
        std::collections::BinaryHeap<std::cmp::Reverse<(std::time::Instant, String)>>,
    pub(super) projects_seeded: bool,
    by_cwd: HashMap<String, HashSet<String>>,
    settings: String,
    links: HashMap<(ai_hist::Source, String, String), String>,
    delivery: Connection,
    positions: crate::delivery::UploadPositions,
    policy_revision: i64,
    execution: execution::ExecutionCache,
}
impl CatalogIndex {
    pub fn open(path: &Path, home: &Path, relay_home: &Path) -> Result<Self, RpcError> {
        let mut options = StoreOptions::default();
        options.db_path = Some(path.to_owned());
        options.read_only = true;
        let store = SessionStore::open(options).map_err(|e| read_error(e.into()))?;
        // Fence the seed before enumeration: changes during/after the seed are
        // replayed by identity, so newer catalog rows cannot be lost.
        let watermark = store.head_revision().map_err(|_| failed())?;
        let retention_generation = store.retention_generation().map_err(|_| failed())?;
        let index = Index::new()?;
        let baseline = home.join(".agentworkforce/session-reset-baseline.json");
        let ignored = if baseline.exists() {
            serde_json::from_slice(&std::fs::read(baseline).map_err(|_| failed())?)
                .map_err(|_| failed())?
        } else {
            HashSet::new()
        };
        let directory = path.parent().ok_or_else(failed)?;
        let config: serde_json::Value = serde_json::from_slice(
            &std::fs::read(directory.join("config.json")).map_err(|_| failed())?,
        )
        .map_err(|_| failed())?;
        let job = config["job_id"].as_str().ok_or_else(failed)?;
        let delivery = crate::delivery::open_db_readonly(path).map_err(read_error)?;
        let policy_revision = crate::delivery::policy_revision(&delivery).map_err(read_error)?;
        let positions = crate::delivery::upload_positions(&delivery, job).map_err(|_| failed())?;
        let mut result = Self {
            index,
            store,
            watermark,
            retention_generation,
            delivery,
            positions,
            policy_revision,
            execution: execution::ExecutionCache::default(),
            path: path.to_owned(),
            home: home.to_owned(),
            relay_home: relay_home.to_owned(),
            ignored,
            identity: identity(path)?,
            projects: HashMap::new(),
            project_resolved_at: HashMap::new(),
            pending_projects: HashSet::new(),
            project_queue: std::collections::VecDeque::new(),
            project_in_flight: vec![],
            project_expiry: std::collections::BinaryHeap::new(),
            projects_seeded: false,
            by_cwd: HashMap::new(),
            settings: settings_signature(path, home, relay_home),
            links: HashMap::new(),
        };
        result.seed()?;
        result.retention_current()?;
        result.refresh()?;
        Ok(result)
    }
    fn seed(&mut self) -> Result<(), RpcError> {
        let relationships = self
            .store
            .changes_since(
                Watermark::START,
                ChangeQuery::default()
                    .kinds([ChangeKind::Relationship])
                    .batch(PAGE_ROWS),
            )
            .map_err(|_| failed())?;
        for change in relationships {
            let change = change.map_err(|_| failed())?;
            if let (Some(source), ai_hist::ChangeOp::Upsert(evidence)) = (change.source, change.op)
            {
                if let ai_hist::EvidenceRow::Relationship(row) = *evidence {
                    if let Some(child) = row.child_session_id {
                        self.links
                            .insert((source, change.session_id, change.record_key), child);
                    }
                }
            }
        }
        let mut query = CatalogQuery::default();
        query.scope = SessionScope::All;
        query.exclude_delegated = true;
        query.page_size = PAGE_ROWS as i64;
        for row in self.store.sessions(query) {
            let row = row.map_err(|_| failed())?;
            let upload = self.catalog_row(&row);
            if !self.ignored.contains(&crate::delivery::SessionIdentity {
                source: upload.source.clone(),
                session_id: upload.session_id.clone(),
            }) {
                self.index.put(LocalSessionRow {
                    upload: Some(upload),
                    relay: None,
                })?;
            } else {
                self.execution
                    .forget(&format!("{}:{}", upload.source, upload.session_id));
            }
        }
        Ok(())
    }
    pub fn settings_current(&self) -> bool {
        self.retention_current().is_ok()
            && self.settings == settings_signature(&self.path, &self.home, &self.relay_home)
            && crate::delivery::policy_revision(&self.delivery).ok() == Some(self.policy_revision)
            && identity(&self.path)
                .ok()
                .is_some_and(|identity| identity == self.identity)
    }
    pub fn version(
        &self,
        request: &SessionQueryParams,
        generation: u64,
    ) -> Result<CatalogVersion, RpcError> {
        self.retention_current()?;
        let data_version: u64 = self
            .delivery
            .query_row("PRAGMA data_version", [], |row| row.get(0))
            .map_err(|_| failed())?;
        self.version_at(
            request,
            CatalogVersion {
                revision: 0,
                data_version,
                generation,
            },
        )
    }
    fn version_at(
        &self,
        request: &SessionQueryParams,
        snapshot: CatalogVersion,
    ) -> Result<CatalogVersion, RpcError> {
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        let mut request = request.clone();
        request.known_revision = None;
        (
            self.index.epoch,
            self.index.revision,
            snapshot.data_version,
            snapshot.generation,
            serde_json::to_string(&request).map_err(|_| failed())?,
        )
            .hash(&mut hash);
        Ok(CatalogVersion {
            revision: (hash.finish() & i64::MAX as u64).max(1),
            ..snapshot
        })
    }
    fn refresh_settings(&mut self) -> Result<(), RpcError> {
        let settings = settings_signature(&self.path, &self.home, &self.relay_home);
        let policy_revision =
            crate::delivery::policy_revision(&self.delivery).map_err(read_error)?;
        if settings == self.settings && policy_revision == self.policy_revision {
            return Ok(());
        }
        self.index.epoch = self.index.epoch.wrapping_add(1);
        self.execution.restore(&mut self.index)?;
        let directory = self.path.parent().ok_or_else(failed)?;
        let config: serde_json::Value = serde_json::from_slice(
            &std::fs::read(directory.join("config.json")).map_err(|_| failed())?,
        )
        .map_err(|_| failed())?;
        self.positions = crate::delivery::upload_positions(
            &self.delivery,
            config["job_id"].as_str().ok_or_else(failed)?,
        )
        .map_err(|_| failed())?;
        let baseline = self
            .home
            .join(".agentworkforce/session-reset-baseline.json");
        let old_ignored = self.ignored.clone();
        self.ignored = if baseline.exists() {
            serde_json::from_slice(&std::fs::read(baseline).map_err(|_| failed())?)
                .map_err(|_| failed())?
        } else {
            HashSet::new()
        };
        self.reset_ignored(old_ignored)?;
        self.refresh_inclusion()?;
        self.settings = settings;
        self.policy_revision = policy_revision;
        Ok(())
    }
    fn refresh_inclusion(&mut self) -> Result<(), RpcError> {
        let rows: Vec<String> = self
            .index
            .db
            .prepare("SELECT payload FROM rows WHERE valid_to IS NULL")
            .map_err(|_| failed())?
            .query_map([], |r| r.get(0))
            .map_err(|_| failed())?
            .collect::<Result<_, _>>()
            .map_err(|_| failed())?;
        for payload in rows {
            let mut row: LocalSessionRow = serde_json::from_str(&payload).map_err(|_| failed())?;
            if let Some(upload) = row.upload.as_mut() {
                let identity = crate::delivery::SessionIdentity {
                    source: upload.source.clone(),
                    session_id: upload.session_id.clone(),
                };
                if self.ignored.contains(&identity) {
                    self.execution.forget(&row.key());
                    self.index.remove(&row.key())?;
                    continue;
                }
                upload.included = crate::delivery::is_shareable(&self.delivery, &identity)
                    .map_err(|_| failed())?
                    && (!self.positions.scoped() || self.positions.member(&identity));
                self.index.put(row)?;
            }
        }
        Ok(())
    }
    fn reset_ignored(
        &mut self,
        old_ignored: HashSet<crate::delivery::SessionIdentity>,
    ) -> Result<(), RpcError> {
        if self.ignored != old_ignored {
            self.index.epoch = self.index.epoch.wrapping_add(1);
            let restored: Vec<_> = old_ignored.difference(&self.ignored).cloned().collect();
            for identity in restored {
                if let Some(source) = ai_hist::Source::parse(&identity.source) {
                    self.repair(source, identity.session_id)?;
                }
            }
        }
        Ok(())
    }
    pub fn refresh(&mut self) -> Result<(), RpcError> {
        if identity(&self.path)? != self.identity {
            *self = Self::open(
                &self.path.clone(),
                &self.home.clone(),
                &self.relay_home.clone(),
            )?;
            return Ok(());
        }
        let generation = self.store.retention_generation().map_err(|_| failed())?;
        if generation != self.retention_generation {
            self.reseed_after_retention(generation)?;
        }
        self.refresh_settings()?;
        let head = self.store.head_revision().map_err(|_| failed())?;
        if head.epoch != self.watermark.epoch || head.revision < self.watermark.revision {
            *self = Self::open(
                &self.path.clone(),
                &self.home.clone(),
                &self.relay_home.clone(),
            )?;
            return Ok(());
        }
        if head == self.watermark {
            return self.retention_current();
        }
        let (identities, position) = self.changed_identities()?;
        for (source, id) in identities {
            self.repair(source, id)?;
        }
        self.watermark = position;
        self.retention_current()
    }
    fn changed_identities(
        &mut self,
    ) -> Result<(HashSet<(ai_hist::Source, String)>, Watermark), RpcError> {
        let kinds = [
            ChangeKind::Session,
            ChangeKind::Presence,
            ChangeKind::Relationship,
        ];
        let mut changes = self
            .store
            .changes_since(
                self.watermark,
                ChangeQuery::default().kinds(kinds).batch(PAGE_ROWS),
            )
            .map_err(|_| failed())?;
        let mut identities = HashSet::new();
        for change in changes.by_ref().take(PAGE_ROWS) {
            let change = change.map_err(|_| failed())?;
            if let Some(source) = change.source {
                identities.insert((source, change.session_id.clone()));
            }
            self.changed_relation(change, &mut identities);
        }
        Ok((identities, changes.position()))
    }
    fn changed_relation(
        &mut self,
        change: ai_hist::Change,
        identities: &mut HashSet<(ai_hist::Source, String)>,
    ) {
        if change.kind == ChangeKind::Relationship {
            if let Some(source) = change.source {
                let key = (source, change.session_id.clone(), change.record_key);
                if let Some(child) = self.links.remove(&key) {
                    identities.insert((source, child));
                }
                if let ai_hist::ChangeOp::Upsert(evidence) = change.op {
                    if let ai_hist::EvidenceRow::Relationship(row) = *evidence {
                        if let Some(child) = row.child_session_id {
                            identities.insert((source, child.clone()));
                            self.links.insert(key, child);
                        }
                    }
                }
            }
        }
    }
    fn repair(&mut self, source: ai_hist::Source, id: String) -> Result<(), RpcError> {
        let key = format!("{}:{id}", source.as_str());
        let mut query = SessionQuery::default();
        query.kinds = Some(vec![]);
        query.include_text = true;
        let ignored = self.ignored.contains(&crate::delivery::SessionIdentity {
            source: source.as_str().into(),
            session_id: id.clone(),
        });
        let delegated = self
            .store
            .delegated_by(&ai_hist::SessionIdentity::new(source.as_str(), &id))
            .map_err(|_| failed())?;
        if delegated.is_empty() && !ignored {
            if let Some(evidence) = self
                .store
                .session(&SessionRef::id(source, &id), query)
                .map_err(|_| failed())?
                .filter(|row| {
                    source != ai_hist::Source::Grok
                        || row.session.session_kind.as_deref() != Some("subagent")
                })
            {
                let relay = self.index.get(&key)?.and_then(|r| r.relay);
                let upload = self.catalog_row(&evidence.session);
                self.index.put(LocalSessionRow {
                    upload: Some(upload),
                    relay,
                })?;
                return Ok(());
            }
        }
        self.execution.forget(&key);
        self.index.remove(&key)?;
        Ok(())
    }
}

impl CatalogIndex {
    fn catalog_row(&mut self, row: &ai_hist::CatalogSession) -> UploadSession {
        let key = format!("{}:{}", row.source.as_str(), row.session_id);
        let project = row.cwd.as_ref().map(|cwd| {
            self.by_cwd
                .entry(cwd.clone())
                .or_default()
                .insert(key.clone());
            if let Some(project) = self.projects.get(cwd) {
                project.clone().unwrap_or_default()
            } else {
                if self.pending_projects.insert(cwd.clone()) {
                    self.project_queue.push_back(cwd.clone());
                }
                String::new()
            }
        });
        let title = catalog_title(row);
        let identity = crate::delivery::SessionIdentity {
            source: row.source.as_str().into(),
            session_id: row.session_id.clone(),
        };
        let included = crate::delivery::is_shareable(&self.delivery, &identity).unwrap_or(false)
            && (!self.positions.scoped() || self.positions.member(&identity));
        let (models, reasoning_effort) = self.execution.project(
            &key,
            row.models.clone(),
            row.raw_path.as_deref(),
            self.index.epoch,
        );
        UploadSession {
            // Profile artwork is read only by bounded keyed helper enrichment.
            avatar: None,
            source: row.source.as_str().into(),
            session_id: row.session_id.clone(),
            title,
            cwd: row.cwd.clone(),
            project,
            git_branch: row.git_branch.clone(),
            first_activity_ms: row.first_activity_ms,
            last_activity_ms: row.last_activity_ms,
            is_agent: row.originator.as_deref().is_some_and(|s| {
                let s = s.trim().to_lowercase();
                (matches!(s.as_str(), "agent-relay" | "codex_exec") || s.starts_with("codex_sdk"))
                    && !row
                        .cwd
                        .as_deref()
                        .is_some_and(crate::relay::conductor::is_workspace)
            }),
            host: crate::relay::conductor::host(row.cwd.as_deref()),
            models,
            reasoning_effort,
            included,
            status: if included {
                crate::relay::contract::account::UploadShareStatus::Checking
            } else {
                crate::relay::contract::account::UploadShareStatus::NotShared
            },
        }
    }
}

fn identity(path: &Path) -> Result<crate::delivery::DatabaseIdentity, RpcError> {
    crate::delivery::DatabaseIdentity::read(path).map_err(|_| failed())
}

/// Shared with the helper: provider preambles and title fallback stay identical.
pub fn catalog_title(row: &ai_hist::CatalogSession) -> String {
    let text = |value: &Option<String>| {
        value
            .as_deref()
            .map(crate::relay::conductor::without_preamble)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    row.title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| text(&row.first_prompt))
        .or_else(|| text(&row.last_assistant_text))
        .unwrap_or_else(|| row.session_id.clone())
        .chars()
        .take(120)
        .collect()
}

/// Files that can change indexed inclusion or visibility without an SDK
/// catalog change or a delivery policy revision.
fn settings_signature(path: &Path, home: &Path, relay_home: &Path) -> String {
    let Some(directory) = path.parent() else {
        return String::new();
    };
    [
        directory.join("config.json"),
        directory.join("selected.json"),
        directory.join("deleted-uploads.json"),
        directory.join("sharing-change.json"),
        relay_home.join(crate::relay::claude_dirs::FILE),
        home.join(".agentworkforce/session-reset-baseline.json"),
    ]
    .iter()
    .map(|path| {
        std::fs::metadata(path)
            .ok()
            .map(|m| format!("{:?}:{}", m.modified(), m.len()))
            .unwrap_or_default()
    })
    .collect::<Vec<_>>()
    .join("|")
}

fn read_error(error: anyhow::Error) -> RpcError {
    if crate::delivery::is_upgrade_pending(&error) {
        RpcError::new(ErrorKind::Busy, "Local history is preparing. Agent Relay will retry after the collector finishes upgrading it.")
    } else {
        failed()
    }
}

mod execution;
mod projects;
mod retention;
