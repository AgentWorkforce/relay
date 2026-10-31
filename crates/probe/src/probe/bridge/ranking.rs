//! Bounded local metadata enrichment shared by every session listing.
use super::*;

/// A bounded over-read lets a transcript whose catalog row is stale move into
/// the requested page and gives user-driven sessions room to move ahead of
/// headless runs. Only one extra requested page is read, capped for unusually
/// large explicit limits.
pub(super) const MAX_RECENCY_OVERREAD: usize = 1_000;
/// Transcript stats get a small slice of the interactive request. The upload
/// status work retains its existing five-second budget after this phase.
pub(super) const RECENCY_METADATA_BUDGET: Duration = Duration::from_secs(1);
/// Slow or disconnected mounts cannot create unbounded threads or queued work.
pub(super) const RECENCY_METADATA_QUEUE: usize = 2_048;

pub(super) struct RankedSession {
    pub(super) profile: Option<ai_hist::SessionProfile>,
    pub(super) metadata: SessionMetadata,
    pub(super) session: ai_hist::CatalogSession,
    pub(super) last_activity_ms: Option<i64>,
    pub(super) is_agent: bool,
}

pub(super) struct MetadataJob {
    pub(super) profile_request: Option<(ai_hist::SessionStore, ai_hist::SessionRef)>,
    pub(super) refresh_activity: bool,
    pub(super) source: String,
    pub(super) index: usize,
    pub(super) path: std::path::PathBuf,
    pub(super) catalog_activity_ms: Option<i64>,
    pub(super) response: SyncSender<(
        usize,
        Option<i64>,
        SessionMetadata,
        Option<ai_hist::SessionProfile>,
    )>,
}

static METADATA_QUEUE: OnceLock<SyncSender<MetadataJob>> = OnceLock::new();

pub(super) fn recency_candidate_limit(limit: usize) -> usize {
    limit.saturating_add(limit.min(MAX_RECENCY_OVERREAD))
}

pub(super) fn transcript_path(session: &ai_hist::CatalogSession) -> Option<std::path::PathBuf> {
    session
        .raw_path
        .as_deref()
        // A provider database can back every session for that provider; its
        // mtime says the database changed, not that this particular session
        // did. Per-transcript files are the independent recency signal.
        .filter(|path| {
            !matches!(
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("db" | "sqlite" | "sqlite3")
            )
        })
        .map(Path::to_path_buf)
}

pub(super) fn effective_last_activity(
    path: &Path,
    catalog_activity_ms: Option<i64>,
) -> Option<i64> {
    let file_ms = fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX));
    match (catalog_activity_ms, file_ms) {
        (Some(catalog), Some(file)) => Some(catalog.max(file)),
        (catalog, file) => catalog.or(file),
    }
}

pub(super) fn metadata_queue() -> &'static SyncSender<MetadataJob> {
    METADATA_QUEUE.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel::<MetadataJob>(RECENCY_METADATA_QUEUE);
        let receiver = Arc::new(Mutex::new(receiver));
        let workers = std::thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(4)
            .clamp(4, 16);
        for index in 0..workers {
            let receiver = Arc::clone(&receiver);
            let _ = std::thread::Builder::new()
                .name(format!("session-metadata-{index}"))
                .spawn(move || loop {
                    let job = match receiver.lock() {
                        Ok(receiver) => receiver.recv(),
                        Err(_) => return,
                    };
                    let Ok(job) = job else {
                        return;
                    };
                    let activity = if job.refresh_activity {
                        effective_last_activity(&job.path, job.catalog_activity_ms)
                    } else {
                        job.catalog_activity_ms
                    };
                    let metadata = super::super::session_metadata::read(&job.source, &job.path);
                    let profile = job.profile_request.and_then(|(store, reference)| {
                        store.session_profile(&reference).ok().flatten()
                    });
                    let _ = job
                        .response
                        .try_send((job.index, activity, metadata, profile));
                });
        }
        sender
    })
}

/// Whether a session ran headless, started by a program rather than a
/// person. Conductor drives its Codex sessions through the Codex SDK, but a
/// person chats in each one, in a workspace under `conductor/workspaces`.
pub(super) fn headless_session(originator: Option<&str>, cwd: Option<&str>) -> bool {
    headless_originator(originator) && !cwd.is_some_and(conductor::is_workspace)
}

pub(super) fn headless_originator(originator: Option<&str>) -> bool {
    let Some(originator) = originator else {
        return false;
    };
    let originator = originator.trim().to_ascii_lowercase();
    matches!(originator.as_str(), "agent-relay" | "codex_exec")
        || originator.starts_with("codex_sdk")
}

pub(super) fn rank_sessions(
    sessions: Vec<ai_hist::CatalogSession>,
    limit: usize,
    store: &ai_hist::SessionStore,
) -> Vec<RankedSession> {
    rank_catalog(sessions, limit, true, store)
}

pub(super) fn rank_catalog(
    sessions: Vec<ai_hist::CatalogSession>,
    limit: usize,
    enrich: bool,
    store: &ai_hist::SessionStore,
) -> Vec<RankedSession> {
    let mut ranked: Vec<_> = sessions
        .into_iter()
        .map(|session| RankedSession {
            profile: None,
            metadata: SessionMetadata::default(),
            last_activity_ms: session.last_activity_ms,
            is_agent: headless_session(session.originator.as_deref(), session.cwd.as_deref()),
            session,
        })
        .collect();
    refresh_last_activity(&mut ranked, store, enrich);
    ranked.sort_by(|left, right| {
        left.is_agent
            .cmp(&right.is_agent)
            .then_with(|| right.last_activity_ms.cmp(&left.last_activity_ms))
            .then_with(|| {
                left.session
                    .source
                    .as_str()
                    .cmp(right.session.source.as_str())
            })
            .then_with(|| left.session.session_id.cmp(&right.session.session_id))
    });
    ranked.truncate(limit);
    ranked
}

/// Metadata reads can block indefinitely on a disconnected filesystem. A
/// process-wide bounded queue contains those blocked calls, while the request
/// consumes only results that arrive within its own deadline.
pub(super) fn refresh_last_activity(
    ranked: &mut [RankedSession],
    store: &ai_hist::SessionStore,
    refresh_activity: bool,
) {
    refresh_last_activity_with(
        ranked,
        RECENCY_METADATA_BUDGET,
        Some(store),
        refresh_activity,
        |job| metadata_queue().try_send(job),
    );
}

pub(super) fn refresh_last_activity_with(
    ranked: &mut [RankedSession],
    budget: Duration,
    store: Option<&ai_hist::SessionStore>,
    refresh_activity: bool,
    mut enqueue: impl FnMut(MetadataJob) -> Result<(), TrySendError<MetadataJob>>,
) {
    if ranked.is_empty() {
        return;
    }
    let mut activity: Vec<_> = ranked.iter().map(|row| row.last_activity_ms).collect();
    let (sender, receiver) = mpsc::sync_channel(ranked.len());
    let mut pending = 0;
    for (index, row) in ranked.iter().enumerate() {
        if !refresh_activity && row.session.source != ai_hist::Source::GrokBot {
            continue;
        }
        let Some(path) = transcript_path(&row.session) else {
            continue;
        };
        let job = MetadataJob {
            profile_request: store
                .filter(|_| row.session.source == ai_hist::Source::GrokBot)
                .map(|store| (store.clone(), row.session.session_ref())),
            refresh_activity,
            source: row.session.source.as_str().into(),
            index,
            path,
            catalog_activity_ms: row.last_activity_ms,
            response: sender.clone(),
        };
        match enqueue(job) {
            Ok(()) => pending += 1,
            Err(TrySendError::Full(_)) => break,
            Err(TrySendError::Disconnected(_)) => return,
        }
    }
    drop(sender);
    let deadline = Instant::now() + budget;
    while pending > 0 {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        match receiver.recv_timeout(remaining) {
            Ok((index, last_activity_ms, metadata, profile)) => {
                if let Some(name) = profile.as_ref().and_then(|profile| profile.name.as_ref()) {
                    ranked[index].session.title = Some(name.clone());
                }
                ranked[index].profile = profile;
                ranked[index].metadata = metadata;
                activity[index] = last_activity_ms;
                pending -= 1;
            }
            Err(_) => break,
        }
    }
    for (row, last_activity_ms) in ranked.iter_mut().zip(activity) {
        row.last_activity_ms = last_activity_ms;
    }
}
