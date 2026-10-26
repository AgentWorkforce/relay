//! Desktop bridge v1. Credentials stay in the probe; only safe status is emitted.
//! Sharing changes stop the collector and persist a replayable plan before
//! replacing a delivery generation. An interrupted change fences startup until
//! recovery completes, so it cannot accidentally broaden sharing.
pub(super) mod openclaw_upgrade;
mod session_rows;
use super::session_metadata::SessionMetadata;
use super::{collector, lock, read_config, save_json, user_error, Config, Target};
use agent_relay_probe::delivery::{self, DeliveryJobConfig, SessionIdentity};
use agent_relay_probe::relay::conductor;
use anyhow::{ensure, Context, Result};
use clap::{Args, Subcommand, ValueEnum};
use fs2::FileExt;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(test)]
use session_rows::{pending_batches, session_rows_selected_within};
#[cfg(test)]
use session_rows::{session_rows, session_rows_within};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender, TrySendError},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};

static JSON: AtomicBool = AtomicBool::new(false);
/// Grok's pre-upgrade catalog rows have no `session_kind`. A selected-mode
/// process refreshes each explicitly selected Grok ID's provider catalog once
/// before its first delivery, then ordinary inventory watches later changes.
static GROK_SELECTION_DISCOVERED: OnceLock<Mutex<HashMap<PathBuf, HashSet<String>>>> =
    OnceLock::new();
pub fn set_json(value: bool) {
    JSON.store(value, Ordering::Relaxed);
}
pub fn json_mode() -> bool {
    JSON.load(Ordering::Relaxed)
}
pub fn emit(mut value: Value) {
    value["bridge_version"] = json!(1);
    println!("{value}");
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum SharingMode {
    All,
    New,
    Selected,
}
pub fn mode(config: &Config) -> SharingMode {
    config.sharing_mode.unwrap_or(if config.include_existing {
        SharingMode::All
    } else {
        SharingMode::New
    })
}

#[derive(Subcommand)]
pub enum SessionCommand {
    List(SessionList),
    /// Read a local conversation without uploading it.
    Read(super::transcript::ReadSession),
    /// Local-only shallow catalog; never reads delivery batches or sends data.
    Preview(SessionPreview),
    Include(SessionMutation),
    Exclude(SessionMutation),
    /// Delete the cloud copy and stop future uploads; local history is retained.
    Delete(SessionMutation),
    /// Reset sessions; --local starts over locally without deleting cloud sessions.
    Reset(SessionReset),
}
#[derive(Args)]
pub struct SessionList {
    /// Read the persisted catalog without filesystem discovery or delivery scans.
    #[arg(long)]
    catalog_only: bool,
    /// Enrich only these catalog identities (at most 200); no prefix scan.
    #[arg(long = "key")]
    keys: Vec<String>,
    #[command(flatten)]
    target: Target,
    #[arg(long, default_value_t = 500)]
    limit: usize,
}
#[derive(Args)]
pub struct SessionPreview {
    #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u16).range(1..=100))]
    limit: u16,
    #[arg(long)]
    refresh: bool,
}
#[derive(Args)]
pub struct SessionReset {
    /// Clear local state and reset exclusions; rediscover original conversations.
    /// Keeps sign-in and cloud sessions. Requires RESET LOCAL SESSIONS confirmation.
    #[arg(long)]
    local: bool,
    #[command(flatten)]
    target: Target,
    #[arg(long)]
    confirmation: String,
}
#[derive(Args)]
pub struct SessionMutation {
    #[command(flatten)]
    target: Target,
    #[arg(long = "session", required = true)]
    keys: Vec<String>,
}
#[derive(Subcommand)]
pub enum SharingCommand {
    /// What each install on this computer shares. With no account and
    /// workspace it lists every install. Reads only each install's
    /// configuration, never local history, so it answers while a sync runs.
    Status(SharingStatus),
    Set(SharingSet),
}
#[derive(Args)]
pub struct SharingStatus {
    /// Only installs for this site.
    #[arg(long)]
    site_url: Option<String>,
    #[arg(long, requires = "workspace")]
    account: Option<String>,
    #[arg(long, requires = "account")]
    workspace: Option<String>,
}
#[derive(Args)]
pub struct SharingSet {
    #[command(flatten)]
    target: Target,
    #[arg(long, value_enum)]
    mode: SharingMode,
}

pub fn control_lock(directory: &Path) -> Result<fs::File> {
    super::private_directory(directory)?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("desktop.lock"))?;
    file.try_lock_exclusive().map_err(|_| {
        if collector::replacement_in_progress(directory) {
            super::user_error(
                "Agent Relay is replacing the uploader. Wait for it to finish, then try again.",
            )
        } else {
            super::user_error("Another setup or upload change is in progress. Please try again.")
        }
    })?;
    Ok(file)
}

/// How long setup waits for a directory's control lock. A `reclaim` pass holds
/// it for bounded work, but opening a store an older build left behind can
/// migrate it, which takes minutes on a large one.
pub const SETUP_WAIT: Duration = Duration::from_secs(600);

/// Setup's control lock. Setup is a reconnect as often as a first sign-in, so
/// it waits out whatever holds the lock rather than fail: a `reclaim` pass on
/// a decommissioned directory, a replacement handoff starting a new build's
/// collector, or another control action. Each releases the collector lock
/// before this one.
pub fn setup_lock(directory: &Path, wait: Duration) -> Result<fs::File> {
    let deadline = std::time::Instant::now() + wait;
    loop {
        match control_lock(directory) {
            Err(error)
                if error.downcast_ref::<super::UserError>().is_some()
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(100));
            }
            result => return result,
        }
    }
}

fn wait_for_control_lock(directory: &Path) -> Result<fs::File> {
    super::private_directory(directory)?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("desktop.lock"))?;
    file.lock_exclusive()?;
    Ok(file)
}
/// The install's store as its owner, which holds the collector lock.
fn db(directory: &Path) -> Result<Connection> {
    let conn = agent_relay_probe::delivery::open_db(&directory.join("history.db"))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(conn)
}
/// The install's store for a control action that may run beside the collector.
pub(super) fn control_db(directory: &Path) -> Result<Connection> {
    let conn = open_control(directory)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(conn)
}
/// A control action's store, refused in the desktop's words while the
/// collector upgrades local history.
pub(super) fn open_control(directory: &Path) -> Result<Connection> {
    delivery::open_control_db(&directory.join("history.db")).map_err(|error| {
        if delivery::is_upgrade_pending(&error) {
            user_error(UPGRADING)
        } else {
            error
        }
    })
}
fn read_db(directory: &Path) -> Result<Connection> {
    let conn = delivery::open_db_readonly(&directory.join("history.db"))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(conn)
}
/// A saved JSON file, or its default when there is none.
fn saved<T: serde::de::DeserializeOwned + Default>(path: &Path) -> Result<T> {
    if !path.exists() {
        return Ok(T::default());
    }
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
fn selected(directory: &Path) -> Result<Vec<SessionIdentity>> {
    saved(&directory.join("selected.json"))
}
fn excluded(conn: &Connection) -> Result<HashSet<SessionIdentity>> {
    let mut statement = conn.prepare("SELECT source,session_id FROM delivery_exclusions")?;
    let rows = statement.query_map([], |r| {
        Ok(SessionIdentity {
            source: r.get(0)?,
            session_id: r.get(1)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
pub fn enforce_selection(directory: &Path, config: &Config) -> Result<()> {
    if mode(config) != SharingMode::Selected {
        return Ok(());
    }
    enforce_selection_from(&db(directory)?, directory, config)
}

pub(crate) fn enforce_selection_from(
    conn: &Connection,
    directory: &Path,
    config: &Config,
) -> Result<()> {
    if mode(config) != SharingMode::Selected {
        return Ok(());
    }
    let selected = selected(directory)?;
    let session_job = delivery::is_session_job(&conn, &config.job_id)?;
    let explicit = if session_job {
        delivery::job_selected_sessions(&conn, &config.job_id)?
    } else {
        selected.clone()
    };
    let grok_ids: HashSet<String> = selected
        .iter()
        .chain(&explicit)
        .filter(|identity| identity.source == "grok")
        .map(|identity| identity.session_id.clone())
        .collect();
    if !grok_ids.is_empty() {
        let discovered = GROK_SELECTION_DISCOVERED.get_or_init(|| Mutex::new(HashMap::new()));
        let needs_refresh = {
            let entries = discovered.lock().unwrap_or_else(|e| e.into_inner());
            !entries
                .get(directory)
                .is_some_and(|seen| grok_ids.is_subset(seen))
        };
        if needs_refresh {
            // Shallow discovery updates old NULL kinds from `summary.json`.
            // It must finish before a selected-mode job can claim a batch.
            super::history::discover_grok_selection_checked(
                &directory.join("history.db"),
                &grok_ids.iter().cloned().collect::<Vec<_>>(),
                || false,
            )?;
            discovered
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .entry(directory.to_path_buf())
                .or_default()
                .extend(grok_ids);
        }
    }
    let mut kept = Vec::with_capacity(selected.len());
    for identity in &selected {
        if !delivery::native_grok_subagent(&conn, identity)? {
            kept.push(identity.clone());
        }
    }
    if !session_job {
        delivery::adopt_session_job(&conn, &config.job_id, &kept)?;
    } else if explicit.iter().try_fold(false, |found, identity| {
        Ok::<_, anyhow::Error>(found || delivery::native_grok_subagent(&conn, identity)?)
    })? {
        // This fences pending batches as well as removing the old member.
        // A child with an observed parent may still join through that parent.
        delivery::sync_delegated_members(&conn, &config.job_id)?;
    }
    if kept != selected {
        save_json(&directory.join("selected.json"), &kept)?;
    }
    Ok(())
}

fn profile(directory: &Path, config: &Config, paused: bool) -> Result<Value> {
    Ok(
        json!({"directory":directory, "site_url":config.site_url, "account_id":config.account_id,
        "account_email":config.account_email, "account_name":config.account_name,
        "account_avatar_url":config.account_avatar_url,
        "workspace_id":config.workspace_id, "workspace_name":config.workspace_name, "org_id":config.org_id, "sharing_mode":mode(config),
        "running":collector::running(directory)?, "paused":paused}),
    )
}
pub fn installs() -> Result<()> {
    emit(installs_value(
        &super::home()?.join(".agentworkforce/probe"),
    )?);
    Ok(())
}
/// Every install under `root` with a `config.json`. A decommissioned install
/// has none, so it is never listed.
///
/// A listed install is connected, whatever this build can read of it: one a
/// newer build set up or last ran carries `upgrade_required`, and a store this
/// build cannot read leaves `paused` unknown. A workspace whose collector is
/// running is never reported as signed out.
fn installs_value(root: &Path) -> Result<Value> {
    let mut installs = Vec::new();
    if root.exists() {
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            if let Some(install) = listed_install(&entry.path()) {
                installs.push(install);
            }
        }
    }
    installs.sort_by_key(|v| v["directory"].as_str().unwrap_or_default().to_owned());
    Ok(json!({"installs":installs}))
}
fn listed_install(directory: &Path) -> Option<Value> {
    let mut install = match read_config(directory) {
        Ok(config) => {
            let paused = paused(directory, &config).ok();
            let mut install = profile(directory, &config, paused.unwrap_or(false)).ok()?;
            install["paused"] = json!(paused);
            install["upgrade_required"] = json!(collector::newer_build(directory));
            install
        }
        Err(_) => newer_install(directory)?,
    };
    install["collector_version"] = json!(collector::collector_version(directory));
    Some(install)
}
/// Whether the install's delivery job is paused. Reads only the job's state,
/// which every build's store keeps.
fn paused(directory: &Path, config: &Config) -> Result<bool> {
    let conn = read_db(directory)?;
    let state: String = conn.query_row(
        "SELECT state FROM delivery_jobs WHERE id=?",
        [&config.job_id],
        |row| row.get(0),
    )?;
    Ok(state == "paused")
}
/// The identity of an install whose `config.json` a newer build wrote in a
/// format this build does not read. A malformed config in this build's own
/// format is not an install.
fn newer_install(directory: &Path) -> Option<Value> {
    let config: Value =
        serde_json::from_slice(&fs::read(directory.join("config.json")).ok()?).ok()?;
    if config["version"].as_u64()? <= u64::from(super::CONFIG_VERSION) {
        return None;
    }
    let field = |name: &str| config[name].as_str();
    Some(json!({"directory":directory, "site_url":field("site_url")?,
        "account_id":field("account_id")?, "account_email":field("account_email"),
        "account_name":field("account_name"), "account_avatar_url":field("account_avatar_url"),
        "workspace_id":field("workspace_id")?, "org_id":field("org_id"),
        "running":collector::running(directory).ok()?, "paused":null, "upgrade_required":true}))
}
pub fn start(directory: &Path) -> Result<()> {
    let _control = control_lock(directory)?;
    // A collector keeps running the build that launched it, so an update
    // reaches uploads only once that collector is replaced.
    if collector::running(directory)? && collector::outdated(directory) {
        collector::stop_for_replacement(directory)?;
    }
    let running = collector::running(directory)?;
    if !running {
        // A live newer build claims this collector and may have upgraded its
        // store past what this build reads; a dead claim refuses nothing.
        collector::ensure_no_live_newer_claim(directory)?;
        start_stopped(directory)?;
    }
    emit(json!({"running":true, "started":!running}));
    Ok(())
}

pub fn start_stopped(directory: &Path) -> Result<()> {
    let guard = lock(directory)?;
    recover(directory)?;
    read_config(directory)?;
    drop(guard);
    collector::start_background(directory)
}

/// A bounded interactive replacement hands ownership to this detached helper.
/// It holds the desktop control lock until the old generation releases the
/// collector lock, then starts the new build. If another generation has
/// already replaced the expected one, that owner wins and this helper exits.
pub fn complete_replacement(directory: &Path, expected_startup_id: &str) -> Result<()> {
    complete_replacement_with(directory, expected_startup_id, &start_stopped)
}

fn complete_replacement_with(
    directory: &Path,
    expected_startup_id: &str,
    start: &dyn Fn(&Path) -> Result<()>,
) -> Result<()> {
    let _control = wait_for_control_lock(directory)?;
    while collector::running(directory)? {
        let current = fs::read(directory.join("runtime.json"))
            .ok()
            .and_then(|data| serde_json::from_slice::<Value>(&data).ok())
            .and_then(|runtime| runtime["startup_id"].as_str().map(str::to_owned));
        if current
            .as_deref()
            .is_some_and(|id| id != expected_startup_id)
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    start(directory)
}
pub fn status(directory: &Path) -> Result<()> {
    emit(status_value(directory)?);
    Ok(())
}
/// What the desktop shows while local history waits for the collector to
/// upgrade it.
const UPGRADING: &str =
    "Agent Relay is upgrading local history. Uploads continue when it finishes.";
fn status_value(directory: &Path) -> Result<Value> {
    let config = read_config(directory)?;
    // The collector keeps running when it cannot read the store and reports
    // why: an open that fails, or a damaged table. Status fails on the same
    // store, so it answers with that report, the one thing a person can act
    // on, rather than fail.
    store_status(directory, &config).or_else(|error| {
        match collector::current_cycle_report(directory) {
            Some(report) if report["ok"] == false => {
                let mut result = profile(directory, &config, false)?;
                result["probe_version"] = json!(agent_relay_probe::VERSION);
                result["last_cycle"] = report;
                result["collector_outdated"] =
                    json!(result["running"] == true && collector::outdated(directory));
                result["collector_replacing"] =
                    json!(collector::replacement_in_progress(directory));
                result["upgrade_required_live"] = json!(collector::newer_build_live(directory));
                Ok(result)
            }
            _ => Err(error),
        }
    })
}
fn store_status(directory: &Path, config: &Config) -> Result<Value> {
    let conn = read_db(directory)?;
    let job = delivery::status(&conn, &config.job_id)?;
    let withheld = excluded(&conn)?;
    // Status answers while the collector upgrades local history, so the
    // desktop can say so rather than report a failed read or a stale verdict.
    let upgrading = match delivery::ensure_current(&directory.join("history.db")) {
        Err(error) if delivery::is_upgrade_pending(&error) => true,
        checked => {
            checked?;
            false
        }
    };
    let rows = if upgrading {
        Vec::new()
    } else {
        delivery::selectable_session_identities(&conn)?
    };
    let scoped = delivery::is_session_job(&conn, &config.job_id)?;
    let members: HashSet<_> = if scoped {
        delivery::job_sessions(&conn, &config.job_id)?
            .into_iter()
            .collect()
    } else {
        HashSet::new()
    };
    let shared = rows
        .iter()
        .filter(|r| !withheld.contains(*r) && (!scoped || members.contains(*r)))
        .count();
    let mut result = profile(directory, config, job.state == "paused")?;
    result["probe_version"] = json!(agent_relay_probe::VERSION);
    // How long the oldest unacknowledged batch has waited: the queue's lag.
    let oldest_pending_age_ms = job
        .oldest_pending_ms
        .map(|oldest| collector::now().saturating_sub(oldest).max(0));
    result["delivery"] = serde_json::to_value(job)?;
    result["delivery"]["oldest_pending_age_ms"] = json!(oldest_pending_age_ms);
    // Do not expose job configuration or arbitrary receiver error strings.
    result["delivery"].as_object_mut().unwrap().remove("config");
    if let Some(failure) = result["delivery"]["failure"].as_str() {
        let message = delivery_failure_message(failure);
        let code = delivery_failure_code(failure);
        result["delivery"]["failure"] = json!(message);
        if let Some(code) = code {
            result["delivery"]["failure_code"] = json!(code);
        }
        // A job waiting on sign-in says why renewing it failed.
        if code == Some("authentication_required") {
            if let Some(renewal) = collector::renewal_failure(directory) {
                result["delivery"]["failure"] = json!(collector::renewal_failure_message(renewal));
                result["delivery"]["renewal_failure"] = json!(renewal.code());
            }
        }
    }
    result["sessions"] = json!({"total":rows.len(), "shared":shared, "excluded":rows.len()-shared});
    let upgrading_report = json!({"at_ms":collector::now(), "ok":false, "error_class":"upgrading", "message":UPGRADING});
    result["last_cycle"] = match collector::current_cycle_report(directory) {
        // The live run reported a failure while the store still waits for its
        // upgrade: the upgrade failed, and its cause is what a person acts on.
        Some(report) if report["ok"] == false => report,
        _ if upgrading => upgrading_report,
        report => report.unwrap_or(Value::Null),
    };
    result["collector_outdated"] =
        json!(result["running"] == true && collector::outdated(directory));
    result["collector_replacing"] = json!(collector::replacement_in_progress(directory));
    result["upgrade_required_live"] = json!(collector::newer_build_live(directory));
    Ok(result)
}

fn delivery_failure_message(failure: &str) -> &'static str {
    match failure {
        "receiver_rejected" => {
            "The server rejected an upload. Uploads are paused until an update or retry; queued records are preserved."
        }
        "invalid_payload" => {
            "An upload could not be prepared safely. Uploads are stopped until a retry or update; queued records are preserved."
        }
        "authentication_required" => {
            "Uploads need you to sign in to Agent Relay again. Queued records are preserved."
        }
        "permission_denied" => {
            "The server refused permission to upload. Check this workspace connection."
        }
        "unsupported_evidence" | "mapping_version_mismatch" => {
            "The server does not support this upload yet. Queued records are preserved."
        }
        "delivery_conflict" => {
            "History delivery has a receiver conflict. Queued records are preserved for repair."
        }
        "rate_limited" => "The server asked uploads to slow down. Agent Relay will retry.",
        "transient" => "The upload service is temporarily unavailable. Agent Relay will retry.",
        _ => "The upload service is temporarily unavailable. Agent Relay will retry.",
    }
}

/// Only core-owned failure classes cross the status boundary. The sentence
/// stays suitable for display while the allowlisted code lets Relay derive a
/// truthful stage after restart, when no live cycle verdict is available.
fn delivery_failure_code(failure: &str) -> Option<&'static str> {
    match failure {
        "transient" => Some("transient"),
        "rate_limited" => Some("rate_limited"),
        "authentication_required" => Some("authentication_required"),
        "permission_denied" => Some("permission_denied"),
        "invalid_payload" => Some("invalid_payload"),
        "receiver_rejected" => Some("receiver_rejected"),
        "unsupported_evidence" => Some("unsupported_evidence"),
        "mapping_version_mismatch" => Some("mapping_version_mismatch"),
        "delivery_conflict" => Some("delivery_conflict"),
        _ => None,
    }
}
pub fn sessions(command: SessionCommand) -> Result<()> {
    if let SessionCommand::Reset(options) = command {
        return if options.local {
            super::session_reset::reset_mode(
                &options.target.directory()?,
                &options.confirmation,
                true,
            )
        } else {
            super::session_reset::reset(&options.target.directory()?, &options.confirmation)
        };
    }
    let _reader = matches!(
        &command,
        SessionCommand::Read(_) | SessionCommand::List(_) | SessionCommand::Preview(_)
    )
    .then(super::session_reset::reader_lock)
    .transpose()?;
    match command {
        SessionCommand::Reset(_) => unreachable!(),
        SessionCommand::Read(options) => super::transcript::read(options)?,
        SessionCommand::Preview(options) => {
            let directory = super::home()?.join(".agentworkforce/session-preview");
            super::private_directory(&directory)?;
            let db = directory.join("catalog.db");
            let candidate_limit = recency_candidate_limit(options.limit as usize);
            if options.refresh {
                // A separate local metadata cache cannot wait behind the capture writer
                // or accidentally add unselected sessions to a delivery generation.
                super::history::discover(&db, Some(candidate_limit), || false)?;
            }
            let rows = if db.exists() {
                // The preview's own cache holds catalog metadata only, so it
                // is small, and no collector migrates it: it migrates here.
                let store = match super::history::open_read(&db) {
                    Err(error) if delivery::is_upgrade_pending(&error) => {
                        super::history::open(&db)?;
                        super::history::open_read(&db)?
                    }
                    opened => opened?,
                };
                let sessions =
                    super::history::catalog(&store, ai_hist::SessionScope::Local, candidate_limit)?;
                rank_sessions(sessions, options.limit as usize)
                    .into_iter()
                    .map(Preview::from)
                    .collect()
            } else {
                Vec::new()
            };
            let response = preview_response(&rows);
            super::save_json(&directory.join("sessions.json"), &response)?;
            emit(response);
        }
        SessionCommand::List(options) => session_rows::list(options)?,
        SessionCommand::Include(options) => {
            change(&options.target.directory()?, None, &options.keys, true)?
        }
        SessionCommand::Delete(options) => change_with_cloud(
            &options.target.directory()?,
            None,
            &options.keys,
            false,
            true,
        )?,
        SessionCommand::Exclude(options) => {
            change(&options.target.directory()?, None, &options.keys, false)?
        }
    }
    Ok(())
}
/// The catalog fields a preview row carries: metadata and the local title,
/// never transcript text beyond it or the provider file's location.
struct Preview {
    models: Vec<String>,
    reasoning_effort: Option<String>,
    source: &'static str,
    session_id: String,
    title: Option<String>,
    first_prompt: Option<String>,
    cwd: Option<String>,
    git_branch: Option<String>,
    first_activity_ms: Option<i64>,
    last_activity_ms: Option<i64>,
    is_agent: bool,
}
impl From<RankedSession> for Preview {
    fn from(row: RankedSession) -> Self {
        let session = row.session;
        Self {
            models: row
                .metadata
                .model
                .map(|model| vec![model])
                .unwrap_or(session.models),
            reasoning_effort: row.metadata.reasoning_effort,
            source: session.source.as_str(),
            session_id: session.session_id,
            title: session.title,
            first_prompt: session.first_prompt,
            cwd: session.cwd,
            git_branch: session.git_branch,
            first_activity_ms: session.first_activity_ms,
            last_activity_ms: row.last_activity_ms,
            is_agent: row.is_agent,
        }
    }
}
fn preview_response(rows: &[Preview]) -> Value {
    let sessions: Vec<_> = rows.iter().map(|row| json!({
        "source": row.source, "session_id": row.session_id,
        "title": catalog_title(row.title.as_deref()).or_else(|| row.first_prompt.as_deref().map(conductor::without_preamble))
            .filter(|title| !title.is_empty()).unwrap_or(&row.session_id),
        "cwd": row.cwd, "git_branch": row.git_branch,
        "first_activity_ms": row.first_activity_ms, "last_activity_ms": row.last_activity_ms,
        "is_agent": row.is_agent, "host": conductor::host(row.cwd.as_deref()),
        "included": false, "status": "unknown",
        "models": row.models, "reasoning_effort": row.reasoning_effort
    })).collect();
    json!({"bridge_version":1, "sessions":sessions})
}

/// Where a session listing keeps its proofs of what is uploaded.
const STATUS_CACHE: &str = "session-status.json";

/// A bounded over-read lets a transcript whose catalog row is stale move into
/// the requested page and gives user-driven sessions room to move ahead of
/// headless runs. Only one extra requested page is read, capped for unusually
/// large explicit limits.
const MAX_RECENCY_OVERREAD: usize = 1_000;
/// Transcript stats get a small slice of the interactive request. The upload
/// status work retains its existing five-second budget after this phase.
const RECENCY_METADATA_BUDGET: Duration = Duration::from_secs(1);
/// Slow or disconnected mounts cannot create unbounded threads or queued work.
const RECENCY_METADATA_QUEUE: usize = 2_048;

struct RankedSession {
    metadata: SessionMetadata,
    session: ai_hist::CatalogSession,
    last_activity_ms: Option<i64>,
    is_agent: bool,
}

struct MetadataJob {
    source: String,
    index: usize,
    path: std::path::PathBuf,
    catalog_activity_ms: Option<i64>,
    response: SyncSender<(usize, Option<i64>, SessionMetadata)>,
}

static METADATA_QUEUE: OnceLock<SyncSender<MetadataJob>> = OnceLock::new();

fn recency_candidate_limit(limit: usize) -> usize {
    limit.saturating_add(limit.min(MAX_RECENCY_OVERREAD))
}

fn transcript_path(session: &ai_hist::CatalogSession) -> Option<std::path::PathBuf> {
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

fn effective_last_activity(path: &Path, catalog_activity_ms: Option<i64>) -> Option<i64> {
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

fn metadata_queue() -> &'static SyncSender<MetadataJob> {
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
                    let activity = effective_last_activity(&job.path, job.catalog_activity_ms);
                    let metadata = super::session_metadata::read(&job.source, &job.path);
                    let _ = job.response.try_send((job.index, activity, metadata));
                });
        }
        sender
    })
}

/// Whether a session ran headless, started by a program rather than a
/// person. Conductor drives its Codex sessions through the Codex SDK, but a
/// person chats in each one, in a workspace under `conductor/workspaces`.
fn headless_session(originator: Option<&str>, cwd: Option<&str>) -> bool {
    headless_originator(originator) && !cwd.is_some_and(conductor::is_workspace)
}

fn headless_originator(originator: Option<&str>) -> bool {
    let Some(originator) = originator else {
        return false;
    };
    let originator = originator.trim().to_ascii_lowercase();
    matches!(originator.as_str(), "agent-relay" | "codex_exec")
        || originator.starts_with("codex_sdk")
}

fn rank_sessions(sessions: Vec<ai_hist::CatalogSession>, limit: usize) -> Vec<RankedSession> {
    rank_catalog(sessions, limit, true)
}

fn rank_catalog(
    sessions: Vec<ai_hist::CatalogSession>,
    limit: usize,
    enrich: bool,
) -> Vec<RankedSession> {
    let mut ranked: Vec<_> = sessions
        .into_iter()
        .map(|session| RankedSession {
            metadata: SessionMetadata::default(),
            last_activity_ms: session.last_activity_ms,
            is_agent: headless_session(session.originator.as_deref(), session.cwd.as_deref()),
            session,
        })
        .collect();
    if enrich {
        refresh_last_activity(&mut ranked);
    }
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
fn refresh_last_activity(ranked: &mut [RankedSession]) {
    refresh_last_activity_with(ranked, RECENCY_METADATA_BUDGET, |job| {
        metadata_queue().try_send(job)
    });
}

fn refresh_last_activity_with(
    ranked: &mut [RankedSession],
    budget: Duration,
    mut enqueue: impl FnMut(MetadataJob) -> Result<(), TrySendError<MetadataJob>>,
) {
    if ranked.is_empty() {
        return;
    }
    let mut activity: Vec<_> = ranked.iter().map(|row| row.last_activity_ms).collect();
    let (sender, receiver) = mpsc::sync_channel(ranked.len());
    let mut pending = 0;
    for (index, row) in ranked.iter().enumerate() {
        let Some(path) = transcript_path(&row.session) else {
            continue;
        };
        let job = MetadataJob {
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
            Ok((index, last_activity_ms, metadata)) => {
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

/// A fast first paint from the collector's durable inventory. No transcript
/// opens, pending-batch parsing, or proof of upload completion is required.
/// Included rows stay "checking" until the background pass proves their state.
fn catalog_session_rows(directory: &Path, config: &Config, limit: usize) -> Result<Vec<Value>> {
    let conn = read_db(directory)?;
    let positions = delivery::upload_positions(&conn, &config.job_id)?;
    let store = super::history::open_read(&directory.join("history.db"))?;
    let sessions = super::history::catalog(
        &store,
        ai_hist::SessionScope::All,
        recency_candidate_limit(limit),
    )?;
    rank_catalog(sessions, limit, false).into_iter().map(|ranked| {
        let session = ranked.session;
        let identity = SessionIdentity { source: session.source.as_str().into(), session_id: session.session_id.clone() };
        let included = delivery::is_shareable(&conn, &identity)?
            && (!positions.scoped() || positions.member(&identity));
        Ok(json!({"models":session.models, "source":identity.source,"session_id":identity.session_id,
            "cwd":session.cwd,"git_branch":session.git_branch,
            "first_activity_ms":session.first_activity_ms,"last_activity_ms":ranked.last_activity_ms,
            "is_agent":ranked.is_agent,"host":conductor::host(session.cwd.as_deref()),"title":title(&session),
            "included":included,"status":if included {"checking"} else {"not_shared"}}))
    }).collect()
}

/// The harness's title from RelayHistory, when present and non-blank.
fn catalog_title(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|title| !title.is_empty())
}

/// The catalog title, else the first prompt, last assistant text or session id,
/// trimmed of surrounding spaces and cut to 120 characters.
fn title(session: &ai_hist::CatalogSession) -> String {
    let text = |value: &Option<String>| {
        value
            .as_deref()
            .map(|text| conductor::without_preamble(text).trim_matches(' '))
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    catalog_title(session.title.as_deref())
        .map(str::to_owned)
        .or_else(|| text(&session.first_prompt))
        .or_else(|| text(&session.last_assistant_text))
        .unwrap_or_else(|| session.session_id.clone())
        .chars()
        .take(120)
        .collect()
}
fn mark_pending(
    pending: &mut HashMap<SessionIdentity, bool>,
    identity: SessionIdentity,
    leased: bool,
) {
    pending
        .entry(identity)
        .and_modify(|active| *active |= leased)
        .or_insert(leased);
}
/// How a person is told what `mode` shares.
pub fn describe_sharing(mode: SharingMode) -> &'static str {
    match mode {
        SharingMode::All => "all sessions, including ones from before setup",
        SharingMode::New => "only sessions started after setup",
        SharingMode::Selected => "only the sessions you selected",
    }
}
/// One install's sharing, from its configuration alone.
fn sharing_entry(directory: &Path, config: &Config) -> Value {
    json!({
        "directory": directory,
        "site_url": config.site_url,
        "account_id": config.account_id,
        "workspace_id": config.workspace_id,
        "sharing_mode": mode(config),
        "change_pending": directory.join("sharing-change.json").exists(),
        "upgrade_required": false,
    })
}
/// An install a newer build set up, in a configuration format this build
/// does not read: listed by identity, its sharing unknown here.
fn newer_sharing_entry(directory: &Path) -> Option<Value> {
    let install = newer_install(directory)?;
    Some(json!({
        "directory": directory,
        "site_url": install["site_url"],
        "account_id": install["account_id"],
        "workspace_id": install["workspace_id"],
        "sharing_mode": null,
        "change_pending": directory.join("sharing-change.json").exists(),
        "upgrade_required": true,
    }))
}
/// The sharing of every install under `root` matching `options`. With an
/// account and workspace it names exactly that install (on `--site-url`, or
/// agentrelay.com) and fails when it is not set up here.
fn sharing_status_value(root: &Path, options: &SharingStatus) -> Result<Value> {
    let site = options
        .site_url
        .as_deref()
        .map(super::cloud::site_origin)
        .transpose()?;
    let target = options.account.as_deref().zip(options.workspace.as_deref());
    let target_site = site
        .clone()
        .unwrap_or_else(|| "https://agentrelay.com".into());
    let mut installs = Vec::new();
    if root.exists() {
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let directory = entry.path();
            let entry = match read_config(&directory) {
                Ok(config) => sharing_entry(&directory, &config),
                Err(_) => match newer_sharing_entry(&directory) {
                    Some(entry) => entry,
                    None => continue,
                },
            };
            let field = |name: &str| entry[name].as_str().unwrap_or_default();
            let wanted = match target {
                Some((account, workspace)) => {
                    field("site_url") == target_site
                        && field("account_id") == account
                        && field("workspace_id") == workspace
                }
                None => site.as_ref().is_none_or(|site| site == field("site_url")),
            };
            if wanted {
                installs.push(entry);
            }
        }
    }
    if target.is_some() && installs.is_empty() {
        return Err(user_error(
            "No install for that account and workspace is set up on this computer.",
        ));
    }
    installs.sort_by_key(|v| v["directory"].as_str().unwrap_or_default().to_owned());
    Ok(json!({ "installs": installs }))
}
fn sharing_status(options: &SharingStatus) -> Result<()> {
    let value = sharing_status_value(&super::home()?.join(".agentworkforce/probe"), options)?;
    if json_mode() {
        emit(value);
        return Ok(());
    }
    let installs = value["installs"].as_array().cloned().unwrap_or_default();
    if installs.is_empty() {
        println!("No installs are set up on this computer.");
    }
    for install in installs {
        let shares = match serde_json::from_value(install["sharing_mode"].clone()) {
            Ok(mode) => format!("shares {}", describe_sharing(mode)),
            Err(_) => "set up by a newer version; update to see what it shares".into(),
        };
        println!(
            "{} account {} workspace {}: {}{}.",
            install["site_url"].as_str().unwrap_or_default(),
            install["account_id"].as_str().unwrap_or_default(),
            install["workspace_id"].as_str().unwrap_or_default(),
            shares,
            if install["change_pending"] == true {
                " (a sharing change is being applied)"
            } else {
                ""
            },
        );
    }
    Ok(())
}
/// The sharing line plain `status` prints; nothing when the install's
/// configuration is unreadable.
pub fn print_sharing_line(directory: &Path) {
    if let Some(line) = sharing_line(directory) {
        humanln!("{line}");
    }
}
fn sharing_line(directory: &Path) -> Option<String> {
    let config = read_config(directory).ok()?;
    Some(format!("Sharing: {}.", describe_sharing(mode(&config))))
}
pub fn sharing(command: SharingCommand) -> Result<()> {
    match command {
        SharingCommand::Status(options) => sharing_status(&options),
        SharingCommand::Set(options) => {
            change(&options.target.directory()?, Some(options.mode), &[], true)
        }
    }
}

#[derive(Serialize, Deserialize)]
struct ChangePlan {
    config: Config,
    job: DeliveryJobConfig,
    selected: Vec<SessionIdentity>,
    excluded: Vec<SessionIdentity>,
    paused: bool,
    #[serde(default)]
    delta: Option<(Vec<SessionIdentity>, bool)>,
    #[serde(default)]
    cloud_selection: Option<CloudSelection>,
}
#[derive(Serialize, Deserialize)]
struct CloudSelection {
    enabled: bool,
    sessions: Vec<SessionIdentity>,
    deleted: HashMap<String, Vec<SessionIdentity>>,
}
fn deleted_uploads(directory: &Path) -> Result<HashMap<String, Vec<SessionIdentity>>> {
    saved(&directory.join("deleted-uploads.json"))
}
fn cloud_selection(
    directory: &Path,
    keys: &[String],
    include: bool,
    delete: bool,
) -> Result<Option<CloudSelection>> {
    let mut deleted = deleted_uploads(directory)?;
    let mut sessions = Vec::new();
    for key in keys {
        if include {
            if let Some(family) = deleted.remove(key) {
                sessions.extend(family);
            }
        } else if delete {
            let root = parse_key(key)?;
            let store = super::history::open_read(&directory.join("history.db"))?;
            let children = store.delegated_descendants(&[ai_hist::SessionIdentity::new(
                root.source.as_str(),
                root.session_id.as_str(),
            )])?;
            let mut family = vec![root];
            family.extend(children.into_iter().map(|id| SessionIdentity {
                source: id.source_name,
                session_id: id.session_id,
            }));
            // A retry also deletes children discovered before a partial failure.
            if let Some(previous) = deleted.get(key) {
                family.extend(previous.clone());
            }
            let mut seen = HashSet::new();
            family.retain(|identity| seen.insert(identity.clone()));
            sessions.extend(family.clone());
            deleted.insert(key.clone(), family);
        }
    }
    let mut seen = HashSet::new();
    sessions.retain(|identity| seen.insert(identity.clone()));
    Ok((!sessions.is_empty()).then_some(CloudSelection {
        enabled: include,
        sessions,
        deleted,
    }))
}
fn parse_key(key: &str) -> Result<SessionIdentity> {
    let (source, id) = key
        .split_once(':')
        .ok_or_else(|| user_error("Invalid session key. Use SOURCE:ID from sessions list."))?;
    ensure!(
        !source.is_empty() && !id.is_empty(),
        user_error("Invalid session key. Use SOURCE:ID from sessions list.")
    );
    Ok(SessionIdentity {
        source: source.into(),
        session_id: id.into(),
    })
}
fn change(
    directory: &Path,
    requested: Option<SharingMode>,
    keys: &[String],
    include: bool,
) -> Result<()> {
    change_with_cloud(directory, requested, keys, include, false)
}
fn change_with_cloud(
    directory: &Path,
    requested: Option<SharingMode>,
    keys: &[String],
    include: bool,
    delete: bool,
) -> Result<()> {
    // Independent row requests queue here instead of rejecting another row as busy.
    let _control = wait_for_control_lock(directory)?;
    ensure!(
        !matches!(requested, Some(SharingMode::All | SharingMode::New))
            || super::session_reset::baseline()?.is_empty(),
        user_error("After resetting history, select individual new sessions to upload.")
    );
    if include && requested.is_none() {
        let forgotten = super::session_reset::baseline()?;
        for key in keys {
            ensure!(
                !forgotten.contains(&parse_key(key)?),
                user_error(
                    "This session was removed by a reset. Start a new session to share again."
                )
            );
        }
    }
    let identities_requested: Vec<_> = keys
        .iter()
        .map(|key| parse_key(key))
        .collect::<Result<_>>()?;
    // Reject stale keys while the collector is still running. Rebuild the plan
    // under collector.lock after stopping so newly captured sessions are seen.
    let was_running = collector::running(directory)?;
    let config = read_config(directory)?;
    let deleted = deleted_uploads(directory)?;
    if !delete
        && !keys.iter().any(|key| deleted.contains_key(key))
        && requested.is_none()
        && mode(&config) == SharingMode::Selected
        && !directory.join("sharing-change.json").exists()
    {
        let conn = read_db(directory)?;
        if delivery::is_session_job(&conn, &config.job_id)? {
            validate_identities(&conn, &identities_requested)?;
            let unchanged = identities_requested
                .iter()
                .map(|id| {
                    let member = delivery::job_session_included(&conn, &config.job_id, id)?;
                    let shareable = delivery::is_shareable(&conn, id)?;
                    Ok(member == include && (!include || shareable))
                })
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .all(|v| v);
            if unchanged {
                if include {
                    emit(json!({"included":keys,"regenerated":false}));
                } else {
                    emit(json!({"excluded":keys,"regenerated":false}));
                }
                return Ok(());
            }
        }
    }
    make_plan(
        &read_db(directory)?,
        directory,
        config.clone(),
        requested,
        &identities_requested,
        include,
    )?;
    if delete {
        agent_relay_probe::destination::require_session_deletion(
            &config.history_url,
            &config.delivery_account,
        )?;
    }
    let changed = (|| -> Result<()> {
        if was_running {
            collector::stop_for_change(directory)?;
        }
        let _guard = lock(directory)?;
        recover(directory)?;
        let config = read_config(directory)?;
        let conn = db(directory)?;
        let mut plan = make_plan(
            &conn,
            directory,
            config,
            requested,
            &identities_requested,
            include,
        )?;
        let restored_keys = if requested == Some(SharingMode::All) {
            deleted_uploads(directory)?.into_keys().collect::<Vec<_>>()
        } else {
            keys.to_vec()
        };
        plan.cloud_selection = cloud_selection(directory, &restored_keys, include, delete)?;
        save_json(&directory.join("sharing-change.json"), &plan)?;
        apply_plan(directory, plan)
    })();
    // A child refuses to run while a durable change is pending. Finish its
    // replay under collector.lock before launching the replacement process.
    let restart = (|| -> Result<bool> {
        if was_running && !collector::running(directory)? {
            let recovered = prepare_restart(directory)?;
            collector::start_background(directory)?;
            return Ok(recovered);
        }
        Ok(false)
    })();
    match (changed, restart) {
        (Err(change), Err(restart)) => {
            return Err(anyhow::anyhow!(
                "sharing change failed: {change:#}; collector restoration also failed: {restart:#}"
            ))
        }
        // A transient apply failure can be fully resolved by replaying the
        // durable plan before restart; report success once it is committed.
        (Err(_), Ok(true)) => {}
        (Err(change), Ok(false)) => return Err(change),
        (Ok(()), Err(restart)) => return Err(restart),
        (Ok(()), Ok(_)) => {}
    }
    let regenerated =
        requested.is_some() || mode(&read_config(directory)?) != SharingMode::Selected;
    if let Some(mode) = requested {
        emit(json!({"sharing_mode":mode,"regenerated":regenerated}));
    } else if include {
        emit(json!({"included":keys,"regenerated":regenerated}));
    } else {
        emit(json!({"excluded":keys,"regenerated":regenerated}));
    }
    Ok(())
}
fn prepare_restart(directory: &Path) -> Result<bool> {
    let _guard = lock(directory)?;
    let pending = directory.join("sharing-change.json").exists();
    recover(directory)?;
    Ok(pending)
}
fn validate_identities(conn: &Connection, identities_requested: &[SessionIdentity]) -> Result<()> {
    let mut known = true;
    for id in identities_requested {
        known &= delivery::has_session(conn, id)?;
    }
    ensure!(
        known,
        user_error("Unknown session. Refresh sessions list and try again.")
    );
    for id in identities_requested {
        ensure!(
            delivery::delegating_session(conn, id)?.is_none(),
            user_error("This is a subagent of another session and is shared with it. Select that session instead.")
        );
        ensure!(
            !delivery::native_grok_subagent(conn, id)?,
            user_error("This is a Grok subagent and cannot be selected on its own.")
        );
    }
    Ok(())
}
fn make_plan(
    conn: &Connection,
    directory: &Path,
    mut config: Config,
    requested: Option<SharingMode>,
    identities_requested: &[SessionIdentity],
    include: bool,
) -> Result<ChangePlan> {
    validate_identities(conn, identities_requested)?;
    let old = delivery::status(conn, &config.job_id)?;
    let mut selected = selected(directory)?;
    let incremental = requested.is_none() && mode(&config) == SharingMode::Selected;
    let mut withheld = if incremental {
        HashSet::new()
    } else {
        excluded(conn)?
    };
    if let Some(mode) = requested {
        config.sharing_mode = Some(mode);
        config.include_existing = mode == SharingMode::All;
        withheld = if mode == SharingMode::All {
            HashSet::new()
        } else {
            delivery::session_identities(conn)?
                .into_iter()
                .filter(|id| !selected.contains(id))
                .collect()
        };
    } else {
        for id in identities_requested.iter().cloned() {
            if include {
                withheld.remove(&id);
                if !selected.contains(&id) {
                    selected.push(id);
                }
            } else {
                selected.retain(|v| v != &id);
                withheld.insert(id);
            }
        }
    }
    // A subagent is part of its session, never a selection of its own: one
    // the manifest kept from before it was known to be one is dropped, and is
    // shared through its session.
    let mut kept = Vec::with_capacity(selected.len());
    for id in selected {
        if delivery::delegating_session(conn, &id)?.is_none()
            && !delivery::native_grok_subagent(conn, &id)?
        {
            kept.push(id);
        }
    }
    let selected = kept;
    let mut job = old.config;
    job.selection = collector::selection(mode(&config) == SharingMode::All);
    Ok(ChangePlan {
        config,
        job,
        selected,
        excluded: withheld.into_iter().collect(),
        paused: old.state == "paused",
        delta: incremental.then(|| (identities_requested.to_vec(), include)),
        cloud_selection: None,
    })
}
/// Caller owns collector.lock and desktop.lock. A durable plan survives every
/// partial write; replay is idempotent, with delivery stopped until completion.
pub fn recover(directory: &Path) -> Result<()> {
    super::session_reset::recover(directory)?;
    let path = directory.join("sharing-change.json");
    if path.exists() {
        apply_plan(directory, serde_json::from_slice(&fs::read(path)?)?)?;
    }
    Ok(())
}
fn apply_plan(directory: &Path, plan: ChangePlan) -> Result<()> {
    apply_plan_with_cloud(directory, plan, |config, origin, selection| {
        agent_relay_probe::destination::set_session_uploads(
            &config.history_url,
            &config.delivery_account,
            &config.account_id,
            origin,
            &selection.sessions,
            selection.enabled,
        )
    })
}
fn apply_plan_with_cloud(
    directory: &Path,
    mut plan: ChangePlan,
    send: impl Fn(&Config, &str, &CloudSelection) -> Result<()>,
) -> Result<()> {
    let conn = db(directory)?;
    if let Some(selection) = &plan.cloud_selection {
        let origin: String = conn.query_row(
            "SELECT origin_id FROM delivery_origin WHERE singleton=1",
            [],
            |row| row.get(0),
        )?;
        send(&plan.config, &origin, selection)?;
        save_json(&directory.join("deleted-uploads.json"), &selection.deleted)?;
    }
    if let Some((identities, include)) = &plan.delta {
        // Adoption preserves pending batches and retries. It is idempotent
        // across a crash between any two steps of this intent.
        delivery::adopt_session_job(&conn, &plan.config.job_id, &selected(directory)?)?;
        for identity in identities {
            if *include {
                delivery::include_job_session(&conn, &plan.config.job_id, identity)?;
            } else {
                delivery::set_job_session(&conn, &plan.config.job_id, identity, false)?;
            }
        }
        save_json(&directory.join("selected.json"), &plan.selected)?;
        save_json(&directory.join("config.json"), &plan.config)?;
        fs::remove_file(directory.join("sharing-change.json"))?;
        return Ok(());
    }
    for job in delivery::list_jobs(&conn)? {
        if job.state != "cancelled"
            && job.config.destination_id == plan.job.destination_id
            && job.config.instance_id == plan.job.instance_id
            && job.config.account_id == plan.job.account_id
        {
            delivery::cancel_job(&conn, &job.job_id)?;
        }
    }
    let wanted: HashSet<_> = plan.excluded.iter().cloned().collect();
    for id in excluded(&conn)? {
        if !wanted.contains(&id) {
            delivery::set_session_excluded(&conn, &id, false)?;
        }
    }
    let current = excluded(&conn)?;
    for id in wanted.difference(&current) {
        delivery::set_session_excluded(&conn, id, true)?;
    }
    let job = if mode(&plan.config) == SharingMode::Selected {
        let job = delivery::create_session_job(&conn, &plan.job, collector::now())?;
        for identity in &plan.selected {
            delivery::set_job_session(&conn, &job.job_id, identity, true)?;
        }
        job
    } else {
        delivery::create_job(&conn, &plan.job, collector::now())?
    };
    if plan.paused {
        delivery::pause_job(&conn, &job.job_id)?;
    }
    plan.config.job_id = job.job_id;
    save_json(&directory.join("selected.json"), &plan.selected)?;
    save_json(&directory.join("config.json"), &plan.config)?;
    fs::remove_file(directory.join("sharing-change.json"))?;
    Ok(())
}
pub fn disconnect(directory: &Path) -> Result<()> {
    let _control = control_lock(directory)?;
    collector::stop(directory)?;
    let _guard = lock(directory)?;
    let config = super::saved_config(directory)?.context("No saved workspace connection")?;
    std::env::set_var("RELAYHISTORY_HOME", directory);
    if let Ok(Some(auth)) = agent_relay_probe::cloud::load_auth(Some(&config.history_url)) {
        let token = auth.refresh_token.as_deref().unwrap_or(&auth.access_token);
        let _ = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(5))
            .redirects(0)
            .build()
            .post(&format!("{}/v1/auth/token/revoke", config.history_url))
            .send_json(json!({"token":token}));
    }
    retain_signed_out_install(directory)?;
    emit(json!({"disconnected":true}));
    Ok(())
}

/// Keep the exact job, pending batches, acknowledgements and selection. Without
/// config.json neither discovery nor a collector can restart this installation.
/// The rename is the sign-out fence; retries finish credential cleanup even if
/// the process stopped immediately after it. Only authenticated setup restores it.
fn retain_signed_out_install(directory: &Path) -> Result<()> {
    let config = directory.join("config.json");
    if config.exists() {
        fs::rename(config, directory.join("signed-out.json"))?;
    }
    let stages = directory.join("stages");
    if stages.exists() {
        fs::remove_dir_all(stages)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::control::{compact_value, pause, retry_value};
    #[test]
    fn preview_contains_titles_without_upload_permission_or_transcript_data() {
        let response = super::preview_response(&[super::Preview {
            models: vec![],
            reasoning_effort: None,
            source: "codex",
            session_id: "one".into(),
            title: None,
            first_prompt: Some("A local title".into()),
            cwd: None,
            git_branch: None,
            first_activity_ms: None,
            last_activity_ms: Some(1234),
            is_agent: false,
        }]);
        let row = &response["sessions"][0];
        assert_eq!(row["title"], "A local title");
        assert_eq!(row["included"], false);
        assert_eq!(row["status"], "unknown");
        assert_eq!(row["last_activity_ms"], 1234);
        assert_eq!(row["is_agent"], false);
        assert!(row.get("last_assistant_text").is_none());
        assert!(row.get("raw_path").is_none());
        assert!(row["host"].is_null());
    }

    #[test]
    fn a_conductor_session_is_badged_in_the_preview_too() {
        let response = super::preview_response(&[super::Preview {
            models: vec![],
            reasoning_effort: None,
            source: "codex",
            session_id: "one".into(),
            title: None,
            first_prompt: Some("Check in".into()),
            cwd: Some("/Users/me/conductor/workspaces/app/caracas".into()),
            git_branch: None,
            first_activity_ms: None,
            last_activity_ms: None,
            is_agent: false,
        }]);
        assert_eq!(response["sessions"][0]["host"], "conductor");
        let response = super::preview_response(&[super::Preview {
            models: vec![],
            reasoning_effort: None,
            source: "codex",
            session_id: "one".into(),
            title: None,
            first_prompt: Some(
                "<system_instruction>\nYou are working inside Conductor.\n</system_instruction>\n\nCheck in".into(),
            ),
            cwd: Some("/Users/me/conductor/workspaces/app/caracas".into()),
            git_branch: None,
            first_activity_ms: None,
            last_activity_ms: None,
            is_agent: false,
        }]);
        assert_eq!(response["sessions"][0]["title"], "Check in");
    }

    use super::*;
    use clap::Parser;

    #[test]
    fn delivery_failures_are_truthful_and_never_echo_receiver_content() {
        assert!(delivery_failure_message("receiver_rejected")
            .starts_with("The server rejected an upload."));
        assert!(delivery_failure_message("receiver_rejected").contains("Uploads are paused"));
        assert!(delivery_failure_message("invalid_payload").contains("prepared safely"));
        assert!(delivery_failure_message("authentication_required").contains("sign in"));
        assert!(delivery_failure_message("rate_limited").contains("retry"));
        assert!(delivery_failure_message("delivery_conflict").contains("conflict"));
        assert_eq!(
            delivery_failure_code("delivery_conflict"),
            Some("delivery_conflict")
        );
        assert_eq!(delivery_failure_code("untrusted receiver body"), None);
        assert!(!delivery_failure_message("transient").contains("connection"));
        assert_eq!(
            delivery_failure_message("untrusted receiver body"),
            delivery_failure_message("transient")
        );
    }

    /// A job waiting on sign-in reports why renewal failed, as a code and a
    /// fixed sentence, until renewal succeeds.
    #[test]
    fn a_job_blocked_on_sign_in_names_why_renewal_failed() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        conn.execute(
            "UPDATE delivery_jobs SET state='blocked', failure='authentication_required' WHERE id=?",
            [&config.job_id],
        )
        .unwrap();
        drop(conn);
        let status = status_value(dir.path()).unwrap();
        assert_eq!(
            status["delivery"]["failure_code"],
            "authentication_required"
        );
        assert!(status["delivery"].get("renewal_failure").is_none());

        fs::write(
            dir.path().join("renewal.json"),
            json!({"failure": "cloud_refused", "at_ms": 1}).to_string(),
        )
        .unwrap();
        let status = status_value(dir.path()).unwrap();
        assert_eq!(status["delivery"]["renewal_failure"], "cloud_refused");
        assert!(status["delivery"]["failure"]
            .as_str()
            .unwrap()
            .contains("refused to renew"));
    }

    /// Like pause, retry waits for an interrupted sharing update to recover.
    #[test]
    fn retry_refuses_while_a_sharing_update_is_incomplete() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        conn.execute(
            "UPDATE delivery_jobs SET state='blocked', failure='invalid_payload' WHERE id=?",
            [&config.job_id],
        )
        .unwrap();
        save_json(&dir.path().join("sharing-change.json"), &json!({})).unwrap();
        let error = retry_value(dir.path()).unwrap_err();
        assert!(error.to_string().contains("Run start"));
        assert_eq!(
            delivery::status(&conn, &config.job_id).unwrap().state,
            "blocked"
        );
    }

    /// Retry restarts a stopped job; a paused one stays paused.
    #[test]
    fn retry_restarts_a_stopped_job_and_leaves_a_paused_one() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        conn.execute(
            "UPDATE delivery_jobs SET state='blocked', failure='invalid_payload' WHERE id=?",
            [&config.job_id],
        )
        .unwrap();
        assert_eq!(retry_value(dir.path()).unwrap()["retried"], true);
        let job = delivery::status(&conn, &config.job_id).unwrap();
        assert_eq!(job.state, "active");
        assert_eq!(job.failure, None);
        assert_eq!(job.next_attempt_ms, 0);

        delivery::pause_job(&conn, &config.job_id).unwrap();
        assert_eq!(retry_value(dir.path()).unwrap()["retried"], false);
        assert_eq!(
            delivery::status(&conn, &config.job_id).unwrap().state,
            "paused"
        );
    }

    /// Retry also wakes an active job waiting out a transient failure's
    /// backoff, so a receiver that recovered is tried at once; a
    /// rate-limited wait stands.
    #[test]
    fn retry_wakes_a_transient_backoff_and_leaves_a_rate_limit() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        let later = chrono::Utc::now().timestamp_millis() + 20 * 60 * 1_000;
        conn.execute(
            "UPDATE delivery_jobs SET state='active',failure='rate_limited',attempts=15,next_attempt_ms=? WHERE id=?",
            rusqlite::params![later, &config.job_id],
        )
        .unwrap();
        assert_eq!(retry_value(dir.path()).unwrap()["retried"], false);
        assert_eq!(
            delivery::status(&conn, &config.job_id)
                .unwrap()
                .next_attempt_ms,
            later
        );

        conn.execute(
            "UPDATE delivery_jobs SET failure='transient' WHERE id=?",
            [&config.job_id],
        )
        .unwrap();
        assert_eq!(retry_value(dir.path()).unwrap()["retried"], true);
        let job = delivery::status(&conn, &config.job_id).unwrap();
        assert_eq!(job.state, "active");
        assert_eq!(job.failure, None);
        assert_eq!(job.next_attempt_ms, 0);
        assert_eq!(job.attempts, 15);
    }

    #[test]
    fn persisted_conflict_without_a_cycle_keeps_its_typed_restart_stage() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        conn.execute(
            "UPDATE delivery_jobs SET state='blocked', failure='delivery_conflict' WHERE id=?",
            [&config.job_id],
        )
        .unwrap();
        drop(conn);

        let mut status = status_value(dir.path()).unwrap();
        assert!(status["last_cycle"].is_null());
        assert_eq!(status["delivery"]["failure_code"], "delivery_conflict");
        assert!(status["delivery"]["failure"]
            .as_str()
            .unwrap()
            .contains("conflict"));
        // A restarted Relay sees the persisted database status before a new
        // collector cycle exists. Exercise that boundary without depending on
        // a process table fixture for the test.
        status["running"] = json!(true);
        status["paused"] = json!(false);
        let status = crate::relay::uploader::with_derived(status);
        assert_eq!(status["stage"], "conflict");
        assert!(status["stage_message"]
            .as_str()
            .unwrap()
            .contains("remain queued for repair"));
        let contract = crate::relay::contract::account::UploaderStatus::from_probe(&status);
        assert_eq!(contract.stage, crate::relay::uploader::Stage::Conflict);
        assert!(contract.delivery.failure.unwrap().contains("conflict"));
    }

    /// Writes an install's configuration under `root` for sharing status.
    fn sharing_install(root: &Path, name: &str, site: &str, account: &str, mode: SharingMode) {
        let directory = root.join(name);
        fs::create_dir_all(&directory).unwrap();
        let config = Config {
            version: 1,
            site_url: site.into(),
            account_id: account.into(),
            account_email: None,
            account_name: None,
            account_avatar_url: None,
            workspace_name: None,
            org_id: "org".into(),
            workspace_id: "workspace".into(),
            history_url: if site.starts_with("http://127.0.0.1") {
                "http://127.0.0.1:8788".into()
            } else {
                "https://history.agentrelay.com".into()
            },
            delivery_account: agent_relay_probe::destination::account_id("org", Some("workspace")),
            job_id: "job".into(),
            include_existing: mode == SharingMode::All,
            sharing_mode: Some(mode),
            acknowledge_uninspected_schedules: false,
        };
        save_json(&directory.join("config.json"), &config).unwrap();
    }
    fn sharing_options(site: Option<&str>, target: Option<(&str, &str)>) -> SharingStatus {
        SharingStatus {
            site_url: site.map(Into::into),
            account: target.map(|t| t.0.into()),
            workspace: target.map(|t| t.1.into()),
        }
    }

    #[test]
    fn sharing_status_lists_every_install_from_configuration_alone() {
        let root = tempfile::tempdir().unwrap();
        sharing_install(
            root.path(),
            "b",
            "https://agentrelay.com",
            "two",
            SharingMode::New,
        );
        sharing_install(
            root.path(),
            "a",
            "https://agentrelay.com",
            "one",
            SharingMode::All,
        );
        fs::create_dir_all(root.path().join("unreadable")).unwrap();
        fs::write(root.path().join("stray-file"), "x").unwrap();
        fs::write(root.path().join("b/sharing-change.json"), "{}").unwrap();

        let value = sharing_status_value(root.path(), &sharing_options(None, None)).unwrap();
        let installs = value["installs"].as_array().unwrap();
        assert_eq!(installs.len(), 2);
        assert_eq!(installs[0]["account_id"], "one");
        assert_eq!(installs[0]["sharing_mode"], "all");
        assert_eq!(installs[0]["change_pending"], false);
        assert_eq!(installs[1]["account_id"], "two");
        assert_eq!(installs[1]["sharing_mode"], "new");
        assert_eq!(installs[1]["change_pending"], true);
        assert!(!root.path().join("a/history.db").exists());
    }

    #[test]
    fn sharing_status_filters_by_site_and_names_one_target() {
        let root = tempfile::tempdir().unwrap();
        sharing_install(
            root.path(),
            "a",
            "https://agentrelay.com",
            "one",
            SharingMode::All,
        );
        sharing_install(
            root.path(),
            "b",
            "http://127.0.0.1:8787",
            "one",
            SharingMode::Selected,
        );

        let value = sharing_status_value(
            root.path(),
            &sharing_options(Some("http://127.0.0.1:8787/"), None),
        )
        .unwrap();
        assert_eq!(value["installs"].as_array().unwrap().len(), 1);
        assert_eq!(value["installs"][0]["sharing_mode"], "selected");

        let value = sharing_status_value(
            root.path(),
            &sharing_options(None, Some(("one", "workspace"))),
        )
        .unwrap();
        assert_eq!(value["installs"].as_array().unwrap().len(), 1);
        assert_eq!(value["installs"][0]["site_url"], "https://agentrelay.com");

        let value = sharing_status_value(
            root.path(),
            &sharing_options(Some("http://127.0.0.1:8787"), Some(("one", "workspace"))),
        )
        .unwrap();
        assert_eq!(value["installs"][0]["site_url"], "http://127.0.0.1:8787");
    }

    #[test]
    fn sharing_status_lists_an_install_a_newer_build_set_up() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("newer");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("config.json"),
            json!({"version": u64::from(super::super::CONFIG_VERSION) + 1,
                "site_url": "https://agentrelay.com", "account_id": "one",
                "workspace_id": "workspace"})
            .to_string(),
        )
        .unwrap();
        let value = sharing_status_value(
            root.path(),
            &sharing_options(None, Some(("one", "workspace"))),
        )
        .unwrap();
        assert_eq!(value["installs"][0]["upgrade_required"], true);
        assert_eq!(value["installs"][0]["sharing_mode"], Value::Null);
    }

    #[test]
    fn sharing_status_for_a_missing_target_is_a_user_error() {
        let root = tempfile::tempdir().unwrap();
        sharing_install(
            root.path(),
            "a",
            "https://agentrelay.com",
            "one",
            SharingMode::All,
        );
        let error = sharing_status_value(
            root.path(),
            &sharing_options(None, Some(("other", "workspace"))),
        )
        .unwrap_err();
        let safe = error.downcast_ref::<super::super::UserError>().unwrap();
        assert!(safe.to_string().contains("No install for that account"));

        let empty = tempfile::tempdir().unwrap();
        let value =
            sharing_status_value(&empty.path().join("absent"), &sharing_options(None, None))
                .unwrap();
        assert_eq!(value["installs"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn plain_status_names_what_the_install_shares() {
        let root = tempfile::tempdir().unwrap();
        sharing_install(
            root.path(),
            "a",
            "https://agentrelay.com",
            "one",
            SharingMode::New,
        );
        assert_eq!(
            sharing_line(&root.path().join("a")).as_deref(),
            Some("Sharing: only sessions started after setup.")
        );
        assert_eq!(sharing_line(&root.path().join("missing")), None);
    }

    #[test]
    fn sharing_status_parses_its_flags() {
        let cli = super::super::Cli::try_parse_from([
            "probe",
            "sharing",
            "status",
            "--account",
            "one",
            "--workspace",
            "w",
        ]);
        assert!(cli.is_ok());
        assert!(super::super::Cli::try_parse_from([
            "probe",
            "sharing",
            "status",
            "--account",
            "one"
        ])
        .is_err());
    }

    fn fixture(mode: SharingMode) -> (tempfile::TempDir, Config) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db(dir.path()).unwrap();
        conn.execute("INSERT INTO sessions(source,session_id,first_prompt,last_activity_ms) VALUES ('claude','old','Fix authentication',10),('codex','recent','Add tests',20)", []).unwrap();
        let job = DeliveryJobConfig {
            destination_id: "relayhistory".into(),
            instance_id: "teams-probe".into(),
            account_id: agent_relay_probe::destination::account_id("org", Some("workspace")),
            mapping_version: agent_relay_probe::destination::MAPPING_VERSION.into(),
            selection: collector::selection(mode == SharingMode::All),
            limits: Default::default(),
        };
        if mode != SharingMode::All {
            collector::record_baseline(&conn, false).unwrap();
        }
        let job = delivery::create_job(&conn, &job, collector::now()).unwrap();
        let config = Config {
            version: 1,
            site_url: "https://agentrelay.com".into(),
            account_id: "account".into(),
            account_email: Some("person@example.com".into()),
            account_name: Some("Example Person".into()),
            account_avatar_url: Some("https://example.com/avatar.png".into()),
            workspace_name: Some("Acme".into()),
            org_id: "org".into(),
            workspace_id: "workspace".into(),
            history_url: "https://history.agentrelay.com".into(),
            delivery_account: job.config.account_id,
            job_id: job.job_id,
            include_existing: mode == SharingMode::All,
            sharing_mode: Some(mode),
            acknowledge_uninspected_schedules: false,
        };
        save_json(&dir.path().join("config.json"), &config).unwrap();
        (dir, config)
    }

    #[test]
    fn cloud_deletion_includes_children_and_retains_their_identity_for_restore() {
        let (dir, _) = fixture(SharingMode::Selected);
        let conn = db(dir.path()).unwrap();
        conn.execute("INSERT INTO sessions(source,session_id,first_prompt,last_activity_ms) VALUES('claude','child','Child task',30)", []).unwrap();
        conn.execute("INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) VALUES('claude','old','edge','child','delegated','observed','fixture',1,1)", []).unwrap();
        let keys = vec!["claude:old".into()];
        let deletion = cloud_selection(dir.path(), &keys, false, true)
            .unwrap()
            .unwrap();
        assert!(deletion
            .sessions
            .contains(&parse_key("claude:old").unwrap()));
        assert!(deletion
            .sessions
            .contains(&parse_key("claude:child").unwrap()));
        save_json(&dir.path().join("deleted-uploads.json"), &deletion.deleted).unwrap();
        conn.execute("DELETE FROM session_relationships", [])
            .unwrap();
        let restore = cloud_selection(dir.path(), &keys, true, false)
            .unwrap()
            .unwrap();
        assert!(restore
            .sessions
            .contains(&parse_key("claude:child").unwrap()));
        assert!(restore.deleted.is_empty());
    }

    #[test]
    fn cloud_deletion_replays_failed_intent_preserves_local_history_and_restores_explicitly() {
        let (dir, config) = fixture(SharingMode::Selected);
        let keys = vec!["codex:recent".to_string()];
        let identities = vec![parse_key(&keys[0]).unwrap()];
        let conn = db(dir.path()).unwrap();
        let initial = make_plan(&conn, dir.path(), config, None, &identities, true).unwrap();
        save_json(&dir.path().join("sharing-change.json"), &initial).unwrap();
        apply_plan(dir.path(), initial).unwrap();
        let config = read_config(dir.path()).unwrap();
        assert!(delivery::job_session_included(
            &conn,
            &config.job_id,
            &parse_key(&keys[0]).unwrap()
        )
        .unwrap());
        let mut plan = make_plan(&conn, dir.path(), config, None, &identities, false).unwrap();
        plan.cloud_selection = cloud_selection(dir.path(), &keys, false, true).unwrap();
        let path = dir.path().join("sharing-change.json");
        save_json(&path, &plan).unwrap();
        let result = apply_plan_with_cloud(dir.path(), plan, |_, _, _| anyhow::bail!("offline"));
        assert!(result.is_err());
        assert!(
            path.exists(),
            "An uncertain deletion must remain replayable, never silently resume uploading"
        );
        let plan = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        apply_plan_with_cloud(dir.path(), plan, |config, origin, selection| {
            assert!(!origin.is_empty());
            assert_eq!(config.workspace_id, "workspace");
            assert!(!selection.enabled);
            assert_eq!(selection.sessions, vec![parse_key("codex:recent").unwrap()]);
            Ok(())
        })
        .unwrap();
        assert!(!path.exists());
        let config = read_config(dir.path()).unwrap();
        assert!(!delivery::job_session_included(
            &conn,
            &config.job_id,
            &parse_key(&keys[0]).unwrap()
        )
        .unwrap());
        assert!(
            delivery::has_session(&conn, &parse_key(&keys[0]).unwrap()).unwrap(),
            "Local history is retained"
        );
        assert!(deleted_uploads(dir.path()).unwrap().contains_key(&keys[0]));
        let mut plan = make_plan(&conn, dir.path(), config, None, &identities, true).unwrap();
        plan.cloud_selection = cloud_selection(dir.path(), &keys, true, false).unwrap();
        save_json(&path, &plan).unwrap();
        apply_plan_with_cloud(dir.path(), plan, |_, _, selection| {
            assert!(selection.enabled);
            assert_eq!(selection.sessions.len(), 1);
            Ok(())
        })
        .unwrap();
        assert!(deleted_uploads(dir.path()).unwrap().is_empty());
        let config = read_config(dir.path()).unwrap();
        assert!(delivery::job_session_included(
            &conn,
            &config.job_id,
            &parse_key(&keys[0]).unwrap()
        )
        .unwrap());
    }

    #[test]
    fn catalog_titles_reach_preview_and_upload_session_lists() {
        let (dir, config) = fixture(SharingMode::Selected);
        let conn = db(dir.path()).unwrap();
        conn.execute(
            "UPDATE sessions SET title=?1, first_prompt=?2 WHERE session_id='recent'",
            [
                "  Fix session names  ",
                "<external_codex_apps_open_page>{\"page_id\":null}</external_codex_apps_open_page>",
            ],
        )
        .unwrap();
        let store = super::super::history::open_read(&dir.path().join("history.db")).unwrap();
        let previews: Vec<Preview> = rank_sessions(
            super::super::history::catalog(&store, ai_hist::SessionScope::All, 10).unwrap(),
            10,
        )
        .into_iter()
        .map(Preview::from)
        .collect();
        assert_eq!(
            preview_response(&previews)["sessions"][0]["title"],
            "Fix session names"
        );
        assert_eq!(
            session_rows(dir.path(), &config, 10).unwrap()[0]["title"],
            "Fix session names"
        );
    }

    #[test]
    fn catalog_titles_keep_legacy_fallbacks_when_missing_or_blank() {
        let (dir, config) = fixture(SharingMode::Selected);
        let conn = db(dir.path()).unwrap();
        for missing in [None, Some(" \n\t ")] {
            conn.execute(
                "UPDATE sessions SET title=?1 WHERE session_id='recent'",
                [missing],
            )
            .unwrap();
            let store = super::super::history::open_read(&dir.path().join("history.db")).unwrap();
            let previews: Vec<Preview> = rank_sessions(
                super::super::history::catalog(&store, ai_hist::SessionScope::All, 10).unwrap(),
                10,
            )
            .into_iter()
            .map(Preview::from)
            .collect();
            assert_eq!(
                preview_response(&previews)["sessions"][0]["title"],
                "Add tests"
            );
            assert_eq!(
                session_rows(dir.path(), &config, 10).unwrap()[0]["title"],
                "Add tests"
            );
        }
        conn.execute("UPDATE sessions SET first_prompt=NULL, last_assistant_text='Assistant fallback' WHERE session_id='recent'", []).unwrap();
        assert_eq!(
            session_rows(dir.path(), &config, 10).unwrap()[0]["title"],
            "Assistant fallback"
        );
        conn.execute(
            "UPDATE sessions SET last_assistant_text=NULL WHERE session_id='recent'",
            [],
        )
        .unwrap();
        assert_eq!(
            session_rows(dir.path(), &config, 10).unwrap()[0]["title"],
            "recent"
        );
    }
    fn apply(
        dir: &Path,
        config: Config,
        mode: Option<SharingMode>,
        keys: &[&str],
        include: bool,
    ) -> Config {
        let conn = db(dir).unwrap();
        let keys: Vec<_> = keys.iter().map(|key| parse_key(key).unwrap()).collect();
        let plan = make_plan(&conn, dir, config, mode, &keys, include).unwrap();
        save_json(&dir.join("sharing-change.json"), &plan).unwrap();
        recover(dir).unwrap();
        read_config(dir).unwrap()
    }

    /// Deliver every prepared batch through the core API alone, leaving
    /// settled receipts in place for the compaction under test.
    fn acknowledge_everything(conn: &Connection, job_id: &str) {
        for _ in 0..100 {
            let now = collector::now();
            let prepared = delivery::prepare_batch(conn, job_id, now).unwrap();
            if prepared.batch_id.is_none() {
                if prepared.bootstrap_complete && prepared.scanned_records == 0 {
                    return;
                }
                continue;
            }
            let claim = delivery::claim_batch(conn, job_id, "test", 30_000, &|| now)
                .unwrap()
                .unwrap();
            delivery::store_prepared_payload(
                conn,
                &claim.lease,
                &claim.batch.mapping_version,
                "application/json",
                "{}",
                &|| now,
            )
            .unwrap();
            let ack = delivery::DeliveryAcknowledgment {
                batch_id: claim.batch.batch_id.clone(),
                accepted_revision_ids: claim
                    .batch
                    .records
                    .iter()
                    .map(|record| record.revision_id.clone())
                    .collect(),
                unsupported_revision_ids: vec![],
                suppressed_revision_ids: vec![],
                rejected_revision_ids: vec![],
                isolation_frontier: vec![],
                acceptance_level: delivery::AcceptanceLevel::Durable,
            };
            delivery::acknowledge(conn, &claim.lease, &ack, &|| now).unwrap();
        }
        panic!("bounded fixture failed to drain");
    }

    /// Status carries no journal usage, and compaction releases settled
    /// receipts while pending batches stay queued.
    #[test]
    fn compact_releases_settled_receipts_and_keeps_pending_batches() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        let settled: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM delivery_batches WHERE state='acknowledged'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(settled > 0);
        conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES('claude','old','queued',1,'user','text','synthetic transcript line')",[]).unwrap();
        let pending = delivery::prepare_batch(&conn, &config.job_id, collector::now())
            .unwrap()
            .batch_id
            .unwrap();
        assert!(status_value(dir.path()).unwrap().get("retention").is_none());

        let compacted = compact_value(dir.path()).unwrap();
        assert_eq!(compacted["removed_records"], settled);
        assert!(compacted.get("retention").is_none());
        let remaining: Vec<String> = conn
            .prepare("SELECT id FROM delivery_batches")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(remaining, vec![pending]);
        assert_eq!(compact_value(dir.path()).unwrap()["removed_records"], 0);
    }

    /// Compaction is a user action against the database capture also writes.
    /// A source ingest holding the write lock for several seconds delays it;
    /// it does not abandon the pass with no count reported.
    #[test]
    fn compact_waits_out_a_writer_holding_the_lock_past_the_interactive_timeout() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        let path = dir.path().join("history.db");
        let (locked, taken) = std::sync::mpsc::channel();
        let holding = std::thread::spawn(move || {
            let blocker = agent_relay_probe::delivery::open_db(&path).unwrap();
            blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
            locked.send(()).unwrap();
            // Longer than the interactive timeout, well inside the shared
            // busy policy's grace.
            std::thread::sleep(Duration::from_secs(6));
            blocker.execute_batch("ROLLBACK").unwrap();
        });
        taken.recv().unwrap();
        let compacted = compact_value(dir.path()).unwrap();
        holding.join().unwrap();
        assert_eq!(compacted["removed_records"], 1);
    }

    #[test]
    fn a_listed_install_includes_the_signed_in_profile() {
        let (dir, _) = fixture(SharingMode::Selected);
        let value = listed_install(dir.path()).unwrap();
        assert_eq!(value["account_email"], "person@example.com");
        assert_eq!(value["account_name"], "Example Person");
        assert_eq!(
            value["account_avatar_url"],
            "https://example.com/avatar.png"
        );
        assert_eq!(value["paused"], false);
        assert_eq!(value["upgrade_required"], false);
    }

    /// A store another build wrote, which this build cannot read, still lists
    /// the install: it is connected, whether or not its state can be read.
    #[test]
    fn an_install_whose_store_this_build_cannot_read_is_listed() {
        let (dir, _) = fixture(SharingMode::All);
        db(dir.path())
            .unwrap()
            .execute_batch("DROP TABLE delivery_jobs")
            .unwrap();
        let value = listed_install(dir.path()).unwrap();
        assert_eq!(value["workspace_id"], "workspace");
        assert_eq!(value["paused"], Value::Null);
    }

    #[test]
    fn an_install_a_newer_build_last_ran_requires_an_upgrade() {
        let (dir, _) = fixture(SharingMode::All);
        save_json(
            &dir.path().join("runtime.json"),
            &json!({"startup_id":"live","ready":true,"version":"999999.0.0"}),
        )
        .unwrap();
        let value = listed_install(dir.path()).unwrap();
        assert_eq!(value["upgrade_required"], true);
        assert_eq!(value["collector_version"], "999999.0.0");
    }

    /// Start never launches this build over a store a live newer build
    /// claims; a claim whose process exited refuses nothing.
    #[test]
    fn start_defers_only_to_a_live_newer_claim() {
        let (dir, _) = fixture(SharingMode::All);
        // Simulate the live claimant: the claim record plus the collector
        // lock it holds for its whole run.
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.path().join("collector.lock"))
            .unwrap();
        FileExt::lock_exclusive(&lock).unwrap();
        save_json(
            &dir.path().join("runtime.json"),
            &json!({"startup_id":"live","pid":std::process::id(),
                    "ready":true,"version":"999999.0.0"}),
        )
        .unwrap();
        // Defers to the running claimant: no second collector is launched, so
        // the claim record is left exactly as the claimant wrote it.
        start(dir.path()).unwrap();
        let claim = fs::read(dir.path().join("runtime.json")).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&claim).unwrap()["startup_id"],
            "live"
        );
        // Once the claimant lets go, its record is just a record.
        FileExt::unlock(&lock).unwrap();
        assert!(!collector::newer_build_live(dir.path()));
    }

    #[test]
    fn an_install_with_a_newer_config_format_is_listed_by_identity() {
        let (dir, _) = fixture(SharingMode::All);
        let path = dir.path().join("config.json");
        let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        config["version"] = json!(super::super::CONFIG_VERSION + 1);
        config.as_object_mut().unwrap().remove("job_id");
        save_json(&path, &config).unwrap();
        let value = listed_install(dir.path()).unwrap();
        assert_eq!(value["site_url"], "https://agentrelay.com");
        assert_eq!(value["account_id"], "account");
        assert_eq!(value["workspace_id"], "workspace");
        assert_eq!(value["upgrade_required"], true);
        assert_eq!(value["paused"], Value::Null);

        // A config in this build's own format that fails to read is damage,
        // not an install.
        config["version"] = json!(super::super::CONFIG_VERSION);
        save_json(&path, &config).unwrap();
        assert!(listed_install(dir.path()).is_none());
    }

    /// A session whose only evidence is a tool call or a connector
    /// observation is one the status counts, so it is one a user can select.
    #[test]
    fn a_session_known_only_from_tool_calls_or_observations_can_be_included() {
        let (dir, config) = fixture(SharingMode::Selected);
        let conn = db(dir.path()).unwrap();
        conn.execute("INSERT INTO tool_calls(source,session_id,tool_use_id,name,args_json) VALUES ('claude','tool-only','tool','Edit','{}')", []).unwrap();
        conn.execute("INSERT INTO session_observations(source,session_id,location,connector_id,connector_instance,raw_locator,source_stamp,updated_ms) VALUES ('codex','observed-only','remote','fixture','account','fixture://observed','v1',1)", []).unwrap();
        let before = status_value(dir.path()).unwrap();
        let keys = ["claude:tool-only", "codex:observed-only"];
        let config = apply(dir.path(), config, None, &keys, true);
        for key in keys {
            let identity = parse_key(key).unwrap();
            assert!(
                delivery::job_session_included(&conn, &config.job_id, &identity).unwrap(),
                "{key}"
            );
        }
        let after = status_value(dir.path()).unwrap();
        assert_eq!(after["sessions"]["total"], before["sessions"]["total"]);
        assert_eq!(after["sessions"]["shared"], 2);

        // Evidence under an empty session id or an empty source names no
        // session: it is neither counted nor selectable.
        conn.execute("INSERT INTO tool_calls(source,session_id,tool_use_id,name,args_json) VALUES ('claude','','orphan','Edit','{}'),('','sourceless','orphan','Edit','{}')", []).unwrap();
        for key in [":sourceless", "claude:"] {
            // The key parser refuses an empty half before the store is asked;
            // the store refuses it too.
            assert!(parse_key(key).is_err());
        }
        for identity in [
            SessionIdentity {
                source: "".into(),
                session_id: "sourceless".into(),
            },
            SessionIdentity {
                source: "claude".into(),
                session_id: "".into(),
            },
        ] {
            assert!(!delivery::has_session(&conn, &identity).unwrap());
            assert!(validate_identities(&conn, &[identity]).is_err());
        }
        assert!(delivery::session_identities(&conn)
            .unwrap()
            .iter()
            .all(|identity| !identity.source.is_empty() && !identity.session_id.is_empty()));
        assert_eq!(
            status_value(dir.path()).unwrap()["sessions"]["total"],
            after["sessions"]["total"]
        );
    }

    #[test]
    fn selected_status_counts_only_known_members_not_globally_excluded() {
        for fresh in [true, false] {
            let (dir, mut config) = fixture(if fresh {
                SharingMode::All
            } else {
                SharingMode::Selected
            });
            let conn = db(dir.path()).unwrap();
            if fresh {
                let old = delivery::status(&conn, &config.job_id).unwrap();
                delivery::cancel_job(&conn, &config.job_id).unwrap();
                config.job_id = delivery::create_session_job(&conn, &old.config, collector::now())
                    .unwrap()
                    .job_id;
                config.sharing_mode = Some(SharingMode::Selected);
                config.include_existing = false;
                save_json(&dir.path().join("config.json"), &config).unwrap();
            }
            config = apply(dir.path(), config, None, &["claude:old"], true);
            conn.execute(
                "INSERT INTO sessions(source,session_id) VALUES ('codex','private-discovery')",
                [],
            )
            .unwrap();
            delivery::set_job_session(
                &conn,
                &config.job_id,
                &parse_key("claude:not-in-catalog").unwrap(),
                true,
            )
            .unwrap();
            assert_eq!(
                status_value(dir.path()).unwrap()["sessions"],
                json!({"total":3,"shared":1,"excluded":2})
            );
            let rows = session_rows(dir.path(), &config, 500).unwrap();
            assert_eq!(rows.iter().filter(|r| r["included"] == true).count(), 1);
            delivery::set_session_excluded(&conn, &parse_key("claude:old").unwrap(), true).unwrap();
            assert_eq!(
                status_value(dir.path()).unwrap()["sessions"],
                json!({"total":3,"shared":0,"excluded":3})
            );
            assert!(session_rows(dir.path(), &config, 500)
                .unwrap()
                .iter()
                .all(|r| r["included"] == false));
        }
    }

    #[test]
    fn status_keeps_exclusion_counts_for_all_new_and_legacy_jobs() {
        for mode in [SharingMode::All, SharingMode::New, SharingMode::Selected] {
            let (dir, config) = fixture(mode);
            let conn = db(dir.path()).unwrap();
            assert!(!delivery::is_session_job(&conn, &config.job_id).unwrap());
            let shared = if mode == SharingMode::All { 2 } else { 0 };
            assert_eq!(
                status_value(dir.path()).unwrap()["sessions"],
                json!({"total":2,"shared":shared,"excluded":2-shared})
            );
        }
    }

    #[test]
    fn scoped_control_does_not_rebuild_catalog_exclusions_or_other_backfills() {
        for count in [100, 10_000, 50_000] {
            let (dir, mut config) = fixture(SharingMode::Selected);
            let conn = db(dir.path()).unwrap();
            let old = delivery::status(&conn, &config.job_id).unwrap();
            delivery::cancel_job(&conn, &config.job_id).unwrap();
            conn.execute("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?1) INSERT INTO sessions(source,session_id) SELECT 'codex','unrelated-'||x FROM n",[count]).unwrap();
            conn.execute(
                "INSERT INTO sessions(source,session_id) VALUES ('claude','last')",
                [],
            )
            .unwrap();
            config.job_id = delivery::create_session_job(&conn, &old.config, collector::now())
                .unwrap()
                .job_id;
            save_json(&dir.path().join("config.json"), &config).unwrap();
            let started = std::time::Instant::now();
            config = apply(dir.path(), config, None, &["claude:old"], true);
            let a = delivery::status(&conn, &config.job_id).unwrap();
            let pending = delivery::prepare_batch(&conn, &config.job_id, collector::now())
                .unwrap()
                .batch_id
                .unwrap();
            config = apply(dir.path(), config, None, &["claude:last"], true);
            assert_eq!(config.job_id, a.job_id);
            assert_eq!(
                delivery::prepare_batch(&conn, &config.job_id, collector::now())
                    .unwrap()
                    .batch_id,
                Some(pending)
            );
            let before = conn
                .query_row("SELECT count(*) FROM delivery_exclusions", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap();
            change(dir.path(), None, &["claude:old".into()], true).unwrap();
            assert_eq!(
                delivery::job_sessions(&conn, &config.job_id).unwrap().len(),
                2
            );
            assert_eq!(
                conn.query_row("SELECT count(*) FROM delivery_exclusions", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                before
            );
            assert_eq!(before, 1); // only the fixture's legacy unselected codex row
            eprintln!("probe-selected unrelated={count} two_inclusions_repeat_ms={:.3} exclusions={before}",started.elapsed().as_secs_f64()*1000.);
        }
    }

    #[test]
    fn repeated_include_rebaselines_a_globally_excluded_member() {
        let (dir, config) = fixture(SharingMode::Selected);
        let config = apply(dir.path(), config, None, &["claude:old"], true);
        let conn = db(dir.path()).unwrap();
        let identity = parse_key("claude:old").unwrap();
        let member = || {
            conn.query_row("SELECT id,cursor,bootstrap_done FROM delivery_session_members WHERE job_id=? AND source='claude' AND session_id='old'", [&config.job_id], |r| Ok((r.get::<_,String>(0)?, r.get::<_,i64>(1)?, r.get::<_,bool>(2)?))).unwrap()
        };
        acknowledge_everything(&conn, &config.job_id);
        let (original, _, backfilled) = member();
        assert!(backfilled);
        delivery::set_session_excluded(&conn, &identity, true).unwrap();
        change(dir.path(), None, &["claude:old".into()], true).unwrap();
        assert!(delivery::job_session_included(&conn, &config.job_id, &identity).unwrap());
        assert!(!excluded(&conn).unwrap().contains(&identity));
        // A new membership whose backfill starts from the feed's start.
        let (rebaselined, cursor, backfilled) = member();
        assert_ne!(rebaselined, original);
        assert_eq!(cursor, 0);
        assert!(!backfilled);
        assert!(!dir.path().join("sharing-change.json").exists());
    }

    #[test]
    fn partial_member_intent_replay_keeps_same_job_and_selected_privacy() {
        let (dir, config) = fixture(SharingMode::Selected);
        let config = apply(dir.path(), config, None, &["claude:old"], true);
        let conn = db(dir.path()).unwrap();
        let plan = make_plan(
            &conn,
            dir.path(),
            config.clone(),
            None,
            &[parse_key("codex:recent").unwrap()],
            true,
        )
        .unwrap();
        save_json(&dir.path().join("sharing-change.json"), &plan).unwrap();
        delivery::set_session_excluded(&conn, &parse_key("codex:recent").unwrap(), false).unwrap();
        delivery::set_job_session(
            &conn,
            &config.job_id,
            &parse_key("codex:recent").unwrap(),
            true,
        )
        .unwrap();
        change(dir.path(), None, &["codex:recent".into()], true).unwrap();
        assert_eq!(read_config(dir.path()).unwrap().job_id, config.job_id);
        assert_eq!(selected(dir.path()).unwrap().len(), 2);
        assert_eq!(
            delivery::job_sessions(&conn, &config.job_id).unwrap().len(),
            2
        );
        assert!(!dir.path().join("sharing-change.json").exists());
    }
    #[test]
    fn paused_capture_contention_is_not_an_offline_failure() {
        let (dir, config) = fixture(SharingMode::Selected);
        let conn = db(dir.path()).unwrap();
        delivery::pause_job(&conn, &config.job_id).unwrap();
        let sync_lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.path().join("history.db.sync.lock"))
            .unwrap();
        sync_lock.lock_exclusive().unwrap();
        collector::cycle(dir.path(), &config).unwrap();
        assert_eq!(
            delivery::status(&conn, &config.job_id).unwrap().state,
            "paused"
        );
    }

    #[test]
    fn bridge_validation_errors_are_safe_and_actionable() {
        for key in ["private-input", ":id", "codex:"] {
            let error = parse_key(key).unwrap_err();
            let safe = error.downcast_ref::<super::super::UserError>().unwrap();
            assert!(safe.to_string().contains("SOURCE:ID"));
            assert!(!safe.to_string().contains("private-input"));
        }
        let (dir, _) = fixture(SharingMode::Selected);
        let error = change(dir.path(), None, &["codex:private-missing".into()], true).unwrap_err();
        let safe = error.downcast_ref::<super::super::UserError>().unwrap();
        assert!(safe.to_string().contains("Unknown session"));
        assert!(!safe.to_string().contains("private-missing"));
        save_json(&dir.path().join("sharing-change.json"), &json!({})).unwrap();
        let error = pause(dir.path(), true).unwrap_err();
        assert!(error
            .downcast_ref::<super::super::UserError>()
            .unwrap()
            .to_string()
            .contains("Run start"));
    }

    #[test]
    fn every_desktop_command_accepts_json_and_target_flags() {
        let target = ["--account", "account", "--workspace", "workspace", "--json"];
        for name in [
            "start",
            "status",
            "pause",
            "resume",
            "retry",
            "disconnect",
            "compact",
        ] {
            assert!(
                super::super::Cli::try_parse_from([vec!["probe", name], target.to_vec()].concat())
                    .is_ok(),
                "{name}"
            );
        }
        for action in ["include", "exclude"] {
            assert!(super::super::Cli::try_parse_from(
                [
                    vec!["probe", "sessions", action, "--session", "codex:a:b"],
                    target.to_vec()
                ]
                .concat()
            )
            .is_ok());
        }
        assert!(super::super::Cli::try_parse_from(
            [
                vec!["probe", "sessions", "list", "--limit", "1000"],
                target.to_vec()
            ]
            .concat()
        )
        .is_ok());
        assert!(super::super::Cli::try_parse_from(
            [
                vec!["probe", "sharing", "set", "--mode", "selected"],
                target.to_vec()
            ]
            .concat()
        )
        .is_ok());
        assert!(super::super::Cli::try_parse_from(["probe", "installs", "--json"]).is_ok());
        assert!(super::super::Cli::try_parse_from(["probe", "reclaim", "--json"]).is_ok());
        for other in ["--include-existing", "--new-sessions-only"] {
            assert!(super::super::Cli::try_parse_from([
                "probe",
                "cloud",
                "install",
                "--selected-sessions-only",
                other
            ])
            .is_err());
        }
    }
    #[test]
    fn selected_mode_withholds_new_discoveries_but_keeps_explicit_choices() {
        let (dir, config) = fixture(SharingMode::Selected);
        let config = apply(dir.path(), config, None, &["claude:old"], true);
        let conn = db(dir.path()).unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id) VALUES ('codex','later')",
            [],
        )
        .unwrap();
        enforce_selection(dir.path(), &config).unwrap();
        let withheld = excluded(&conn).unwrap();
        assert!(!delivery::job_session_included(
            &conn,
            &config.job_id,
            &parse_key("codex:later").unwrap()
        )
        .unwrap());
        assert!(!withheld.contains(&parse_key("claude:old").unwrap()));
        assert_eq!(
            selected(dir.path()).unwrap(),
            vec![parse_key("claude:old").unwrap()]
        );
    }

    /// relayhistory 0.49 replaced OpenClaw's per-window sessions
    /// (`main:<window>`) with one per conversation (`main:main`). Here the
    /// sweep has already run: the window rows retired and the conversations
    /// carry one marker per window.
    fn openclaw_after_upgrade_sweep(conn: &Connection) {
        conn.execute(
            "DELETE FROM sessions WHERE source='openclaw' AND session_id<>'main:kept'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id) VALUES ('openclaw','main:main'),('openclaw','main:cron:job')",
            [],
        )
        .unwrap();
        for (conversation, window) in [
            ("main:main", "w1"),
            ("main:main", "w2"),
            ("main:main", "kept"),
            ("main:cron:job", "c1"),
            ("main:cron:job", "c2"),
        ] {
            conn.execute(
                "INSERT INTO session_markers(source,session_id,marker_uid,kind) VALUES ('openclaw',?,?,'session_metadata')",
                rusqlite::params![conversation, format!("session:{window}")],
            )
            .unwrap();
        }
    }

    #[test]
    fn openclaw_conversations_inherit_their_windows_choices_in_selected_mode() {
        let (dir, config) = fixture(SharingMode::Selected);
        let conn = db(dir.path()).unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id) VALUES ('openclaw','main:w1'),('openclaw','main:w2'),('openclaw','main:c1'),('openclaw','main:c2'),('openclaw','main:kept')",
            [],
        )
        .unwrap();
        // w1 selected; w2 and c1 withheld by the selected-mode baseline;
        // c2 deleted from the cloud; `main:kept` (a legacy transcript still
        // recorded on its own) selected.
        let config = apply(
            dir.path(),
            config,
            None,
            &["openclaw:main:w1", "openclaw:main:kept"],
            true,
        );
        for window in ["main:w2", "main:c1", "main:c2"] {
            delivery::set_session_excluded(
                &conn,
                &parse_key(&format!("openclaw:{window}")).unwrap(),
                true,
            )
            .unwrap();
        }
        let deleted = HashMap::from([(
            "openclaw:main:c2".to_string(),
            vec![parse_key("openclaw:main:c2").unwrap()],
        )]);
        save_json(&dir.path().join("deleted-uploads.json"), &deleted).unwrap();
        openclaw_after_upgrade_sweep(&conn);

        super::openclaw_upgrade::migrate_with(dir.path(), true, || Ok(())).unwrap();
        enforce_selection(dir.path(), &config).unwrap();

        let id = |key: &str| parse_key(key).unwrap();
        let included =
            |key: &str| delivery::job_session_included(&conn, &config.job_id, &id(key)).unwrap();
        let withheld = excluded(&conn).unwrap();
        // The selected window's conversation is shared despite the baseline
        // that withheld its other window.
        assert!(included("openclaw:main:main"));
        assert!(!withheld.contains(&id("openclaw:main:main")));
        assert!(selected(dir.path())
            .unwrap()
            .contains(&id("openclaw:main:main")));
        // A deleted window withholds its whole conversation.
        assert!(!included("openclaw:main:cron:job"));
        assert!(withheld.contains(&id("openclaw:main:cron:job")));
        assert!(deleted_uploads(dir.path()).unwrap()["openclaw:main:c2"]
            .contains(&id("openclaw:main:cron:job")));
        // The old IDs stay members, so their deletion records are sent, and
        // targeted capture passes over them; a recorded ID keeps its own.
        assert!(included("openclaw:main:w1"));
        assert!(included("openclaw:main:kept"));
        let members = ["w1", "c2", "kept", "main"].map(|w| id(&format!("openclaw:main:{w}")));
        assert_eq!(
            super::openclaw_upgrade::hydratable(dir.path(), members.to_vec()),
            vec![id("openclaw:main:kept"), id("openclaw:main:main")]
        );
        // Once per install: a later pass neither sweeps nor changes anything.
        super::openclaw_upgrade::migrate_with(dir.path(), true, || panic!("swept again")).unwrap();
    }

    #[test]
    fn openclaw_upgrade_withholds_an_excluded_windows_conversation_and_outlasts_a_broken_store() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id) VALUES ('openclaw','main:w2')",
            [],
        )
        .unwrap();
        let config = apply(dir.path(), config, None, &["openclaw:main:w2"], false);
        openclaw_after_upgrade_sweep(&conn);
        let broken = || Err(anyhow::anyhow!("unreadable OpenClaw store"));
        for _ in 1..3 {
            assert!(super::openclaw_upgrade::migrate_with(dir.path(), false, broken).is_err());
            assert!(!excluded(&conn)
                .unwrap()
                .contains(&parse_key("openclaw:main:main").unwrap()));
        }
        // The third failure carries over from what the store already holds.
        super::openclaw_upgrade::migrate_with(dir.path(), false, broken).unwrap();
        enforce_selection(dir.path(), &config).unwrap();
        let withheld = excluded(&conn).unwrap();
        assert!(withheld.contains(&parse_key("openclaw:main:main").unwrap()));
        assert!(withheld.contains(&parse_key("openclaw:main:w2").unwrap()));
        assert!(!withheld.contains(&parse_key("openclaw:main:cron:job").unwrap()));
    }

    #[test]
    fn a_preselected_grok_subagent_without_a_parent_stops_uploading_when_identified() {
        let Some(home) = crate::live::tests::isolated_home(
            "bridge::tests::a_preselected_grok_subagent_without_a_parent_stops_uploading_when_identified",
        ) else {
            return;
        };
        let (dir, config) = fixture(SharingMode::Selected);
        let conn = db(dir.path()).unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id,first_prompt,last_activity_ms) \
             VALUES('grok','root','Parent work',20),('grok','child','Agent work',30)",
            [],
        )
        .unwrap();
        let child = parse_key("grok:child").unwrap();
        let root = parse_key("grok:root").unwrap();
        let config = apply(dir.path(), config, None, &["grok:child"], true);
        assert!(!delivery::native_grok_subagent(&conn, &child).unwrap());
        assert_eq!(selected(dir.path()).unwrap(), [child.clone()]);
        assert_eq!(
            delivery::job_selected_sessions(&conn, &config.job_id).unwrap(),
            [child.clone()]
        );
        // A batch prepared before the summary arrived must be fenced too.
        assert!(
            delivery::prepare_batch(&conn, &config.job_id, collector::now())
                .unwrap()
                .batch_id
                .is_some()
        );

        let provider_session = home.join(".grok/sessions/%2Fwork%2Fapp/child");
        fs::create_dir_all(&provider_session).unwrap();
        fs::write(
            provider_session.join("summary.json"),
            serde_json::json!({
                "info": {"id": "child", "cwd": "/work/app"},
                "session_kind": "subagent",
                "created_at": "2026-10-11T09:00:00.000Z",
                "updated_at": "2026-10-11T09:08:00.000Z"
            })
            .to_string(),
        )
        .unwrap();
        fs::write(provider_session.join("chat_history.jsonl"), "").unwrap();

        // Every selected-mode delivery calls this before claiming a batch.
        enforce_selection(dir.path(), &config).unwrap();
        assert!(delivery::native_grok_subagent(&conn, &child).unwrap());
        let rows = session_rows(dir.path(), &config, 500).unwrap();
        assert!(rows.iter().any(|row| row["session_id"] == "root"));
        assert!(!rows.iter().any(|row| row["session_id"] == "child"));
        assert!(selected(dir.path()).unwrap().is_empty());
        assert!(delivery::job_selected_sessions(&conn, &config.job_id)
            .unwrap()
            .is_empty());
        assert!(delivery::job_sessions(&conn, &config.job_id)
            .unwrap()
            .is_empty());
        assert!(
            delivery::claim_batch(&conn, &config.job_id, "worker", 30_000, &collector::now,)
                .unwrap()
                .is_none()
        );
        let error = make_plan(
            &conn,
            dir.path(),
            config.clone(),
            None,
            &[child.clone()],
            true,
        )
        .err()
        .unwrap()
        .to_string();
        assert!(error.contains("Grok subagent"), "{error}");

        // If a parent is later observed and selected, the child can still
        // travel with that parent, never as a separate selection.
        conn.execute(
            "INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) \
             VALUES('grok','root','child-edge','child','delegated','observed','test',1,1)",
            [],
        )
        .unwrap();
        let config = apply(dir.path(), config, None, &["grok:root"], true);
        assert_eq!(selected(dir.path()).unwrap(), [root.clone()]);
        assert_eq!(
            delivery::job_selected_sessions(&conn, &config.job_id).unwrap(),
            [root]
        );
        assert!(delivery::job_delegated_sessions(&conn, &config.job_id)
            .unwrap()
            .contains(&child));
    }

    #[test]
    fn unreadable_grok_summary_blocks_delivery_until_a_retry_classifies_the_child() {
        let Some(home) = crate::live::tests::isolated_home(
            "bridge::tests::unreadable_grok_summary_blocks_delivery_until_a_retry_classifies_the_child",
        ) else {
            return;
        };
        let (dir, config) = fixture(SharingMode::Selected);
        let conn = db(dir.path()).unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id,first_prompt,last_activity_ms) VALUES('grok','child','Agent work',30)",
            [],
        )
        .unwrap();
        let child = parse_key("grok:child").unwrap();
        let config = apply(dir.path(), config, None, &["grok:child"], true);
        assert!(
            delivery::prepare_batch(&conn, &config.job_id, collector::now())
                .unwrap()
                .batch_id
                .is_some()
        );

        let provider_session = home.join(".grok/sessions/%2Fwork%2Fapp/child");
        fs::create_dir_all(&provider_session).unwrap();
        fs::write(provider_session.join("summary.json"), "{broken").unwrap();
        fs::write(provider_session.join("chat_history.jsonl"), "").unwrap();
        conn.execute(
            "UPDATE sessions SET raw_path=?1 WHERE source='grok' AND session_id='child'",
            [provider_session
                .join("chat_history.jsonl")
                .to_string_lossy()
                .as_ref()],
        )
        .unwrap();
        let error = enforce_selection(dir.path(), &config)
            .unwrap_err()
            .to_string();
        assert!(error.contains("unreadable"), "{error}");
        assert_eq!(selected(dir.path()).unwrap(), [child.clone()]);
        assert!(delivery::job_session_included(&conn, &config.job_id, &child).unwrap());

        fs::write(
            provider_session.join("summary.json"),
            serde_json::json!({
                "info": {"id": "child", "cwd": "/work/app"},
                "session_kind": "subagent",
                "created_at": "2026-10-11T09:00:00.000Z",
                "updated_at": "2026-10-11T09:08:00.000Z"
            })
            .to_string(),
        )
        .unwrap();
        enforce_selection(dir.path(), &config).unwrap();
        assert!(selected(dir.path()).unwrap().is_empty());
        assert!(!delivery::job_session_included(&conn, &config.job_id, &child).unwrap());
        assert!(
            delivery::claim_batch(&conn, &config.job_id, "worker", 30_000, &collector::now,)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn unrelated_broken_grok_summary_does_not_block_a_selected_root() {
        let Some(home) = crate::live::tests::isolated_home(
            "bridge::tests::unrelated_broken_grok_summary_does_not_block_a_selected_root",
        ) else {
            return;
        };
        let (dir, config) = fixture(SharingMode::Selected);
        let root_session = home.join(".grok/sessions/%2Fwork%2Fapp/root");
        fs::create_dir_all(&root_session).unwrap();
        fs::write(
            root_session.join("summary.json"),
            serde_json::json!({
                "info": {"id": "root", "cwd": "/work/app"},
                "created_at": "2026-10-11T09:00:00.000Z",
                "updated_at": "2026-10-11T09:08:00.000Z"
            })
            .to_string(),
        )
        .unwrap();
        fs::write(root_session.join("chat_history.jsonl"), "").unwrap();
        super::super::history::discover_sources(
            &dir.path().join("history.db"),
            None,
            Some(vec![ai_hist::Source::Grok]),
            || false,
        )
        .unwrap();
        let conn = db(dir.path()).unwrap();
        let root = parse_key("grok:root").unwrap();
        assert_eq!(
            super::super::history::raw_paths(
                &super::super::history::open_read(&dir.path().join("history.db")).unwrap(),
                &[ai_hist::SessionRef::id(ai_hist::Source::Grok, "root")]
            )
            .unwrap(),
            [Some(root_session.join("chat_history.jsonl"))]
        );
        let config = apply(dir.path(), config, None, &["grok:root"], true);
        let broken = home.join(".grok/sessions/%2Fwork%2Fapp/unrelated");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join("summary.json"), "{broken").unwrap();
        fs::write(broken.join("chat_history.jsonl"), "").unwrap();

        enforce_selection(dir.path(), &config).unwrap();
        assert_eq!(selected(dir.path()).unwrap(), [root.clone()]);
        assert!(delivery::job_session_included(&conn, &config.job_id, &root).unwrap());
    }
    #[test]
    fn drain_rechecks_selected_mode_after_a_failed_capture() {
        let (dir, config) = fixture(SharingMode::Selected);
        let conn = db(dir.path()).unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id) VALUES ('codex','discovered')",
            [],
        )
        .unwrap();
        assert!(!excluded(&conn)
            .unwrap()
            .contains(&parse_key("codex:discovered").unwrap()));
        // No destination credentials are installed in this fixture. Selection
        // must be enforced before the drain reaches any transport setup.
        let _ = collector::deliver_captured(dir.path(), &config, false);
        assert!(delivery::is_session_job(&conn, &config.job_id).unwrap());
        assert!(!delivery::job_session_included(
            &conn,
            &config.job_id,
            &parse_key("codex:discovered").unwrap()
        )
        .unwrap());
    }
    #[test]
    fn including_a_session_adopts_in_place_and_preserves_pause() {
        let (dir, config) = fixture(SharingMode::Selected);
        let old = config.job_id.clone();
        let conn = db(dir.path()).unwrap();
        delivery::pause_job(&conn, &old).unwrap();
        let config = apply(dir.path(), config, None, &["claude:old"], true);
        assert_eq!(config.job_id, old);
        assert!(delivery::is_session_job(&conn, &old).unwrap());
        assert_eq!(
            delivery::status(&conn, &config.job_id).unwrap().state,
            "paused"
        );
        // Paused delivery must not try to load credentials or contact a service.
        collector::deliver_captured(dir.path(), &config, false).unwrap();
        let rows = session_rows(dir.path(), &config, 500).unwrap();
        assert_eq!(
            rows.iter().find(|r| r["session_id"] == "old").unwrap()["included"],
            true
        );
    }
    #[test]
    fn mode_changes_and_exclusions_survive_restart() {
        let (dir, config) = fixture(SharingMode::All);
        let config = apply(dir.path(), config, Some(SharingMode::New), &[], true);
        assert_eq!(excluded(&db(dir.path()).unwrap()).unwrap().len(), 2);
        let config = apply(
            dir.path(),
            config,
            None,
            &["claude:old", "codex:recent"],
            true,
        );
        assert!(excluded(&db(dir.path()).unwrap()).unwrap().is_empty());
        let config = apply(dir.path(), config, None, &["claude:old"], false);
        let config = apply(dir.path(), config, Some(SharingMode::Selected), &[], true);
        assert_eq!(
            selected(dir.path()).unwrap(),
            vec![parse_key("codex:recent").unwrap()]
        );
        assert_eq!(excluded(&db(dir.path()).unwrap()).unwrap().len(), 1);
        let config = apply(dir.path(), config, Some(SharingMode::All), &[], true);
        assert!(excluded(&db(dir.path()).unwrap()).unwrap().is_empty());
        assert_eq!(mode(&config), SharingMode::All);
    }
    #[test]
    fn interrupted_regeneration_replays_without_widening_selection() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        let plan = make_plan(
            &conn,
            dir.path(),
            config.clone(),
            Some(SharingMode::Selected),
            &[],
            true,
        )
        .unwrap();
        save_json(&dir.path().join("sharing-change.json"), &plan).unwrap();
        delivery::cancel_job(&conn, &config.job_id).unwrap();
        // Simulate interruption after cancellation, and again after new-job
        // creation/config commit but before removing the durable intent.
        recover(dir.path()).unwrap();
        save_json(&dir.path().join("sharing-change.json"), &plan).unwrap();
        recover(dir.path()).unwrap();
        let config = read_config(dir.path()).unwrap();
        assert_eq!(mode(&config), SharingMode::Selected);
        assert_eq!(excluded(&conn).unwrap().len(), 2);
        assert_eq!(
            delivery::list_jobs(&conn)
                .unwrap()
                .iter()
                .filter(|j| j.state != "cancelled")
                .count(),
            1
        );
        assert!(!dir.path().join("sharing-change.json").exists());
    }
    #[test]
    fn restart_replays_pending_change_before_child_launch() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        let plan = make_plan(
            &conn,
            dir.path(),
            config.clone(),
            Some(SharingMode::Selected),
            &[],
            true,
        )
        .unwrap();
        save_json(&dir.path().join("sharing-change.json"), &plan).unwrap();
        delivery::cancel_job(&conn, &config.job_id).unwrap();

        assert!(prepare_restart(dir.path()).unwrap());

        assert!(!dir.path().join("sharing-change.json").exists());
        let recovered = read_config(dir.path()).unwrap();
        assert_eq!(mode(&recovered), SharingMode::Selected);
        assert_eq!(excluded(&conn).unwrap().len(), 2);
        assert_eq!(
            delivery::status(&conn, &recovered.job_id).unwrap().state,
            "active"
        );
    }
    #[test]
    fn unknown_selection_is_rejected_before_any_generation_change() {
        let (dir, config) = fixture(SharingMode::Selected);
        let conn = db(dir.path()).unwrap();
        let collector_lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.path().join("collector.lock"))
            .unwrap();
        collector_lock.lock_exclusive().unwrap();
        assert!(collector::running(dir.path()).unwrap());
        let error = change(dir.path(), None, &["claude:missing".into()], true).unwrap_err();
        assert!(error.to_string().contains("Unknown session"));
        assert!(!dir.path().join("stop.json").exists());
        assert!(!dir.path().join("sharing-change.json").exists());
        assert_eq!(
            delivery::status(&conn, &config.job_id).unwrap().state,
            "active"
        );
    }
    #[test]
    fn changing_a_stopped_install_does_not_start_a_collector() {
        let (dir, _) = fixture(SharingMode::Selected);
        assert!(!collector::running(dir.path()).unwrap());
        change(dir.path(), None, &["claude:old".into()], true).unwrap();
        assert!(!collector::running(dir.path()).unwrap());
        assert!(!dir.path().join("runtime.json").exists());
    }
    #[test]
    fn leased_batch_wins_over_pending_for_the_same_session() {
        let id = parse_key("claude:old").unwrap();
        for order in [[false, true], [true, false]] {
            let mut pending = HashMap::new();
            for leased in order {
                mark_pending(&mut pending, id.clone(), leased);
            }
            assert_eq!(pending.get(&id), Some(&true));
        }
    }
    #[test]
    fn queued_status_identifies_actual_pending_batch_sessions() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = delivery::open_db(&dir.path().join("history.db")).unwrap();
        for _ in 0..50 {
            if delivery::prepare_batch(&conn, &config.job_id, collector::now())
                .unwrap()
                .batch_id
                .is_some()
            {
                break;
            }
        }
        let rows = session_rows(dir.path(), &config, 500).unwrap();
        assert!(rows.iter().any(|r| r["status"] == "queued"));
        let claim = delivery::claim_batch(
            &conn,
            &config.job_id,
            "desktop-test",
            60_000,
            &collector::now,
        )
        .unwrap();
        assert!(claim.is_some());
        assert!(session_rows(dir.path(), &config, 500)
            .unwrap()
            .iter()
            .any(|r| r["status"] == "uploading"));
        let keys = [
            parse_key("claude:old").unwrap(),
            parse_key("codex:recent").unwrap(),
        ];
        let keyed = session_rows_selected_within(
            dir.path(),
            &config,
            200,
            delivery::SESSION_STATUS_BUDGET,
            Some(&keys),
        )
        .unwrap();
        assert_eq!(
            keyed,
            session_rows(dir.path(), &config, 500).unwrap(),
            "candidate enrichment preserves leased-batch semantics"
        );
        assert_eq!(
            session_rows(dir.path(), &config, 1).unwrap()[0]["session_id"],
            "recent"
        );
    }

    #[test]
    fn keyed_enrichment_reads_only_candidates_and_never_deserializes_pending_payloads() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = delivery::open_db(&dir.path().join("history.db")).unwrap();
        conn.execute_batch("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
            INSERT INTO sessions(source,session_id,first_prompt,last_activity_ms) SELECT 'codex','archive-'||x,'Unrelated historical metadata',100+x FROM n;").unwrap();
        for _ in 0..50 {
            if delivery::prepare_batch(&conn, &config.job_id, collector::now())
                .unwrap()
                .batch_id
                .is_some()
            {
                break;
            }
        }
        let keys = [parse_key("claude:old").unwrap()];
        let rows = session_rows_selected_within(
            dir.path(),
            &config,
            1,
            delivery::SESSION_STATUS_BUDGET,
            Some(&keys),
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0]["session_id"], "old",
            "candidate predates ten thousand unrelated rows"
        );
        assert_eq!(rows[0]["status"], "queued");
        conn.execute_batch(
            "DROP TRIGGER delivery_pending_sessions_update;
            UPDATE delivery_batches SET payload='malformed retained payload';",
        )
        .unwrap();
        assert!(
            pending_batches(&conn, &config.job_id).is_err(),
            "old all-batch deserialization cannot answer this fixture"
        );
        for _ in 0..3 {
            let rows = session_rows_selected_within(
                dir.path(),
                &config,
                1,
                delivery::SESSION_STATUS_BUDGET,
                Some(&keys),
            )
            .unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["session_id"], "old");
            assert_eq!(rows[0]["status"], "queued");
        }
        conn.execute("UPDATE sessions SET title='Candidate changed' WHERE source='claude' AND session_id='old'", []).unwrap();
        let rows = session_rows_selected_within(
            dir.path(),
            &config,
            1,
            delivery::SESSION_STATUS_BUDGET,
            Some(&keys),
        )
        .unwrap();
        assert_eq!(rows[0]["title"], "Candidate changed");
    }

    #[test]
    fn keyed_enrichment_preserves_all_new_and_selected_policy() {
        let keys = [
            parse_key("claude:old").unwrap(),
            parse_key("codex:recent").unwrap(),
        ];
        for sharing in [SharingMode::All, SharingMode::New, SharingMode::Selected] {
            let (directory, config) = fixture(sharing);
            delivery::open_db(&directory.path().join("history.db")).unwrap();
            let keyed = session_rows_selected_within(
                directory.path(),
                &config,
                200,
                delivery::SESSION_STATUS_BUDGET,
                Some(&keys),
            )
            .unwrap();
            assert_eq!(keyed, session_rows(directory.path(), &config, 500).unwrap());
        }
    }
    #[test]
    fn catalog_first_paint_does_not_read_transcripts() {
        let (dir, config) = fixture(SharingMode::All);
        let transcript = dir.path().join("changed.jsonl");
        fs::write(
            &transcript,
            "{\"type\":\"turn_context\",\"payload\":{\"model\":\"new-model\"}}\n",
        )
        .unwrap();
        db(dir.path())
            .unwrap()
            .execute(
                "UPDATE sessions SET raw_path=?1 WHERE session_id='recent'",
                [transcript.to_string_lossy().as_ref()],
            )
            .unwrap();
        let rows = catalog_session_rows(dir.path(), &config, 2).unwrap();
        let row = rows
            .iter()
            .find(|row| row["session_id"] == "recent")
            .unwrap();
        assert_eq!(row["last_activity_ms"], 20);
        assert_ne!(row["models"], json!(["new-model"]));
        assert_eq!(row["status"], "checking");
        assert_eq!(rows.len(), 2);
        // Enrichment sees the file changes; the first paint stays with the
        // durable catalog even when those files are slow or inaccessible.
        let enriched = session_rows(dir.path(), &config, 2).unwrap();
        let row = enriched
            .iter()
            .find(|row| row["session_id"] == "recent")
            .unwrap();
        assert_eq!(row["models"], json!(["new-model"]));
    }

    #[test]
    fn transcript_mtime_reorders_the_page_and_is_the_displayed_activity() {
        let (dir, config) = fixture(SharingMode::All);
        let transcript = dir.path().join("old-transcript.jsonl");
        fs::write(&transcript, b"").unwrap();
        let modified = UNIX_EPOCH + Duration::from_secs(3);
        fs::File::open(&transcript)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        db(dir.path())
            .unwrap()
            .execute(
                "UPDATE sessions SET raw_path=?1 WHERE source='claude' AND session_id='old'",
                [transcript.to_string_lossy().as_ref()],
            )
            .unwrap();

        // `old` is outside the catalog's requested first row (10 < 20), but
        // its transcript is newer. It must enter that page and carry the same
        // effective timestamp used to put it there.
        let rows = session_rows(dir.path(), &config, 1).unwrap();
        assert_eq!(rows[0]["session_id"], "old");
        assert_eq!(rows[0]["last_activity_ms"], 3_000);
    }
    #[test]
    fn session_rows_include_current_model_and_reasoning_without_uploading() {
        let (dir, config) = fixture(SharingMode::Selected);
        let transcript = dir.path().join("codex.jsonl");
        fs::write(
            &transcript,
            "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-6\",\"effort\":\"high\"}}\n",
        )
        .unwrap();
        db(dir.path())
            .unwrap()
            .execute(
                "UPDATE sessions SET raw_path=?1 WHERE source='codex' AND session_id='recent'",
                [transcript.to_string_lossy().as_ref()],
            )
            .unwrap();
        let rows = session_rows(dir.path(), &config, 10).unwrap();
        let row = rows.iter().find(|r| r["session_id"] == "recent").unwrap();
        assert_eq!(row["models"], json!(["gpt-6"]));
        assert_eq!(row["reasoning_effort"], "high");
        assert_eq!(row["included"], false);
        fs::write(&transcript, "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-6-mini\",\"effort\":\"low\"}}\n").unwrap();
        let rows = session_rows(dir.path(), &config, 10).unwrap();
        let row = rows.iter().find(|r| r["session_id"] == "recent").unwrap();
        assert_eq!(row["models"], json!(["gpt-6-mini"]));
        assert_eq!(row["reasoning_effort"], "low");
    }
    #[test]
    fn transcript_metadata_wait_is_bounded() {
        let (dir, _) = fixture(SharingMode::All);
        let store = super::super::history::open_read(&dir.path().join("history.db")).unwrap();
        let mut session = super::super::history::catalog(&store, ai_hist::SessionScope::All, 1)
            .unwrap()
            .remove(0);
        session.raw_path = Some(dir.path().join("held-transcript.jsonl"));
        let catalog_activity = session.last_activity_ms;
        let mut ranked = vec![RankedSession {
            metadata: SessionMetadata::default(),
            session,
            last_activity_ms: catalog_activity,
            is_agent: false,
        }];
        // Retaining each response sender simulates metadata workers that never
        // return. The request must keep the catalog value and hit its deadline.
        let mut held = Vec::new();
        let started = Instant::now();
        refresh_last_activity_with(&mut ranked, Duration::from_millis(20), |job| {
            held.push(job);
            Ok(())
        });
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(ranked[0].last_activity_ms, catalog_activity);
    }
    #[test]
    fn subagents_are_not_listed_and_headless_sessions_sort_last() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        conn.execute(
            "UPDATE sessions SET originator='codex_exec' WHERE source='codex' AND session_id='recent'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id,first_prompt,last_activity_ms) VALUES('claude','child','Delegated work',30)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) \
             VALUES('claude','old','child-edge','child','delegated','observed','test',1,1)",
            [],
        )
        .unwrap();

        let rows = session_rows(dir.path(), &config, 4).unwrap();
        let listed: Vec<_> = rows.iter().map(|row| row["session_id"].clone()).collect();
        assert_eq!(
            listed,
            ["old", "recent"],
            "a subagent is part of its session"
        );
        assert_eq!(rows[0]["is_agent"], false);
        assert_eq!(rows[1]["is_agent"], true);
    }

    #[test]
    fn a_conductor_session_is_a_persons_session() {
        let workspace = Some("/Users/me/conductor/workspaces/app/caracas");
        assert!(!headless_session(Some("codex_sdk_ts"), workspace));
        assert!(headless_session(
            Some("codex_sdk_ts"),
            Some("/Users/me/src/app")
        ));
        assert!(headless_session(Some("codex_sdk_ts"), None));
        assert!(!headless_session(Some("codex_cli_rs"), workspace));
    }

    /// A subagent is shared as part of the session that delegated to it: it
    /// joins the job in the same change that selects its session (its old
    /// exclusion lifted), its records are admitted, it is never selected apart
    /// from it, and it leaves in the same change that deselects its session.
    #[test]
    fn a_subagent_is_shared_as_part_of_its_session() {
        let (dir, config) = fixture(SharingMode::Selected);
        let conn = db(dir.path()).unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id,first_prompt,last_activity_ms) VALUES('claude','child','Delegated work',30)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) \
             VALUES('claude','old','child-edge','child','delegated','observed','test',1,1), \
                   ('claude','child','grandchild-edge','grandchild','delegated','observed','test',1,1)",
            [],
        )
        .unwrap();
        let identity = |session: &str| SessionIdentity {
            source: "claude".into(),
            session_id: session.into(),
        };
        // Withheld by an earlier baseline, as every identity then was.
        delivery::set_session_excluded(&conn, &identity("child"), true).unwrap();

        // Selecting a subagent on its own is refused, with its session named.
        let keys = vec![parse_key("claude:child").unwrap()];
        let refused = match make_plan(&conn, dir.path(), config.clone(), None, &keys, true) {
            Ok(_) => panic!("a subagent was selected on its own"),
            Err(error) => error.to_string(),
        };
        assert!(refused.contains("subagent"), "{refused}");
        assert!(
            delivery::set_job_session(&conn, &config.job_id, &identity("child"), true).is_err()
        );

        let config = apply(dir.path(), config, None, &["claude:old"], true);
        let job_id = config.job_id.clone();
        let members = |conn: &Connection| {
            let mut members = delivery::job_sessions(conn, &job_id).unwrap();
            members.sort_by(|a, b| a.session_id.cmp(&b.session_id));
            members
        };
        assert_eq!(
            members(&conn),
            [identity("child"), identity("grandchild"), identity("old")],
            "the subagents joined in the change that selected their session"
        );
        assert!(!excluded(&conn).unwrap().contains(&identity("child")));
        assert_eq!(
            delivery::job_selected_sessions(&conn, &config.job_id).unwrap(),
            [identity("old")]
        );
        assert!(!delivery::sync_delegated_members(&conn, &config.job_id).unwrap());
        // The subagent's records, and the edge naming it, are uploaded with it.
        delivery::prepare_batch(&conn, &config.job_id, collector::now())
            .unwrap()
            .batch_id
            .unwrap();
        let pending = |needle: &str| -> bool {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM delivery_batches WHERE state='pending' AND instr(payload, ?1) > 0)",
                [needle],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert!(
            pending("\"session_id\":\"child\""),
            "the subagent's record was withheld"
        );
        assert!(
            pending("\"kind\":\"relationship\""),
            "the edge to the subagent was withheld"
        );
        acknowledge_everything(&conn, &config.job_id);
        assert_eq!(status_of(dir.path(), &config, "old"), "uploaded");
        // The session is not uploaded while its subagent's work is not.
        conn.execute(
            "UPDATE sessions SET first_prompt='More delegated work' WHERE session_id='child'",
            [],
        )
        .unwrap();
        delivery::prepare_batch(&conn, &config.job_id, collector::now())
            .unwrap()
            .batch_id
            .unwrap();
        assert!(!pending("\"session_id\":\"old\""));
        assert_eq!(status_of(dir.path(), &config, "old"), "queued");
        acknowledge_everything(&conn, &config.job_id);
        assert_eq!(status_of(dir.path(), &config, "old"), "uploaded");

        // Deselecting the session takes its subagents with it, in the same change.
        apply(dir.path(), config, None, &["claude:old"], false);
        assert!(members(&conn).is_empty());
    }

    /// A session of its own that is also part of a selected one (a remote
    /// session's local transcript) is selected in its own right once chosen:
    /// it stays selected, and hydrated on its own, when its parent leaves.
    #[test]
    fn a_session_chosen_in_its_own_right_outlives_its_parent() {
        let (dir, config) = fixture(SharingMode::Selected);
        let conn = db(dir.path()).unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id,first_prompt,last_activity_ms) VALUES('claude','local','Local transcript',30)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) \
             VALUES('claude','old','materialized','local','materialized_local','observed','test',1,1)",
            [],
        )
        .unwrap();
        let identity = |session: &str| SessionIdentity {
            source: "claude".into(),
            session_id: session.into(),
        };
        let config = apply(dir.path(), config, None, &["claude:old"], true);
        assert_eq!(
            delivery::job_selected_sessions(&conn, &config.job_id).unwrap(),
            [identity("old")],
            "it came in as part of its parent"
        );
        let config = apply(dir.path(), config, None, &["claude:local"], true);
        let mut selected = delivery::job_selected_sessions(&conn, &config.job_id).unwrap();
        selected.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        assert_eq!(selected, [identity("local"), identity("old")]);
        let config = apply(dir.path(), config, None, &["claude:old"], false);
        assert_eq!(
            delivery::job_sessions(&conn, &config.job_id).unwrap(),
            [identity("local")]
        );
    }

    /// Stale subagent selections cannot keep one another in the job: none of
    /// them is a root, so nothing below them comes in through them.
    #[test]
    fn stale_subagent_selections_do_not_keep_each_other() {
        let (dir, config) = fixture(SharingMode::Selected);
        let conn = db(dir.path()).unwrap();
        for session in ["first", "second"] {
            conn.execute(
                "INSERT INTO sessions(source,session_id,first_prompt,last_activity_ms) VALUES('claude',?1,'Delegated work',30)",
                [session],
            )
            .unwrap();
        }
        let config = apply(
            dir.path(),
            config,
            None,
            &["claude:first", "claude:second"],
            true,
        );
        conn.execute(
            "INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) \
             VALUES('claude','old','a','first','delegated','observed','test',1,1), \
                   ('claude','first','b','second','delegated','observed','test',1,1), \
                   ('claude','second','c','below','delegated','observed','test',1,1)",
            [],
        )
        .unwrap();
        delivery::sync_delegated_members(&conn, &config.job_id).unwrap();
        assert!(delivery::job_sessions(&conn, &config.job_id)
            .unwrap()
            .is_empty());
    }

    /// A session selected before it was known to be a subagent comes and
    /// goes with its session once it is known: delegated while its session
    /// is selected, removed while it is not, and dropped from the selection
    /// manifest so a later change does not trip over it.
    #[test]
    fn a_subagent_selected_before_it_was_known_follows_its_session() {
        let (dir, config) = fixture(SharingMode::Selected);
        let conn = db(dir.path()).unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id,first_prompt,last_activity_ms) VALUES('claude','child','Delegated work',30)",
            [],
        )
        .unwrap();
        let identity = |session: &str| SessionIdentity {
            source: "claude".into(),
            session_id: session.into(),
        };
        let config = apply(dir.path(), config, None, &["claude:child"], true);
        assert_eq!(
            delivery::job_selected_sessions(&conn, &config.job_id).unwrap(),
            [identity("child")]
        );
        // The delegation is recorded only now, with work it delegated in turn.
        conn.execute(
            "INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) \
             VALUES('claude','old','child-edge','child','delegated','observed','test',1,1), \
                   ('claude','child','grandchild-edge','grandchild','delegated','observed','test',1,1)",
            [],
        )
        .unwrap();
        // Its session is not selected: it is no longer shared on its own, and
        // nothing it delegated comes in through it.
        assert!(delivery::sync_delegated_members(&conn, &config.job_id).unwrap());
        assert!(delivery::job_sessions(&conn, &config.job_id)
            .unwrap()
            .is_empty());
        // A later change drops it from the manifest instead of failing on it.
        let config = apply(dir.path(), config, None, &["claude:old"], true);
        assert_eq!(selected(dir.path()).unwrap(), [identity("old")]);
        assert_eq!(
            delivery::job_selected_sessions(&conn, &config.job_id).unwrap(),
            [identity("old")]
        );
        assert!(delivery::job_session_included(&conn, &config.job_id, &identity("child")).unwrap());
    }
    fn status_of(dir: &Path, config: &Config, session_id: &str) -> Value {
        session_rows(dir, config, 500)
            .unwrap()
            .into_iter()
            .find(|r| r["session_id"] == session_id)
            .unwrap()["status"]
            .clone()
    }
    #[test]
    fn a_delivered_session_is_uploaded_while_the_job_has_a_backlog() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        assert_eq!(status_of(dir.path(), &config, "old"), "uploaded");
        conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES('claude','old','later',1,'user','text','synthetic transcript line')",[]).unwrap();
        assert!(
            delivery::status(&conn, &config.job_id)
                .unwrap()
                .unqueued_changes
                > 0
        );
        // Only the session the unexamined change belongs to waits.
        assert_eq!(status_of(dir.path(), &config, "old"), "shared");
        assert_eq!(status_of(dir.path(), &config, "recent"), "uploaded");
        acknowledge_everything(&conn, &config.job_id);
        assert_eq!(status_of(dir.path(), &config, "old"), "uploaded");
    }
    #[test]
    fn a_member_is_uploaded_only_once_its_backfill_is_acknowledged() {
        let (dir, config) = fixture(SharingMode::Selected);
        let config = apply(dir.path(), config, None, &["claude:old"], true);
        assert_eq!(status_of(dir.path(), &config, "old"), "shared");
        assert_eq!(status_of(dir.path(), &config, "recent"), "not_shared");
        let conn = db(dir.path()).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        assert_eq!(status_of(dir.path(), &config, "old"), "uploaded");
        conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES('claude','old','later',1,'user','text','synthetic transcript line')",[]).unwrap();
        assert_eq!(status_of(dir.path(), &config, "old"), "shared");
    }
    #[test]
    fn a_batch_prepared_after_the_positions_were_read_keeps_its_session_waiting() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES('claude','old','later',1,'user','text','synthetic transcript line')",[]).unwrap();
        let old = parse_key("claude:old").unwrap();
        let positions = delivery::upload_positions(&conn, &config.job_id).unwrap();
        // The collector prepares the change between the listing's reads: the
        // job moves past it and the pending batch was read before it existed.
        while delivery::prepare_batch(&conn, &config.job_id, collector::now())
            .unwrap()
            .batch_id
            .is_none()
        {}
        let unsent =
            delivery::unsent_sessions(&conn, &positions, std::slice::from_ref(&old)).unwrap();
        assert!(unsent.contains(&old));
    }
    #[test]
    fn a_member_added_after_the_positions_were_read_waits() {
        let (dir, config) = fixture(SharingMode::Selected);
        let config = apply(dir.path(), config, None, &["claude:old"], true);
        let conn = db(dir.path()).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        let positions = delivery::upload_positions(&conn, &config.job_id).unwrap();
        let recent = parse_key("codex:recent").unwrap();
        assert!(!positions.member(&recent));
        apply(dir.path(), config, None, &["codex:recent"], true);
        let unsent =
            delivery::unsent_sessions(&conn, &positions, std::slice::from_ref(&recent)).unwrap();
        assert!(unsent.contains(&recent));
    }
    fn status_within(dir: &Path, config: &Config, session_id: &str, budget: Duration) -> Value {
        session_rows_within(dir, config, 500, budget)
            .unwrap()
            .into_iter()
            .find(|r| r["session_id"] == session_id)
            .unwrap()["status"]
            .clone()
    }
    fn add_event(conn: &Connection, session_id: &str, uid: &str) {
        conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES('claude',?1,?2,1,'user','text','synthetic transcript line')", rusqlite::params![session_id, uid]).unwrap();
    }
    #[test]
    fn a_listing_out_of_time_says_checking_rather_than_waiting() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        // The job has not reached this change, so deciding either session
        // needs a read; with no time for it neither is claimed to wait.
        add_event(&conn, "old", "later");
        assert_eq!(
            status_within(dir.path(), &config, "old", Duration::ZERO),
            "checking"
        );
        assert_eq!(
            status_within(dir.path(), &config, "recent", Duration::ZERO),
            "checking"
        );
        // Given time, only the session with the unsent change waits.
        assert_eq!(status_of(dir.path(), &config, "old"), "shared");
        assert_eq!(status_of(dir.path(), &config, "recent"), "uploaded");
    }
    #[test]
    fn a_proven_upload_is_not_read_again_until_its_session_changes() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        add_event(&conn, "old", "later");
        // Prove "recent" uploaded while the job is still behind on "old".
        assert_eq!(status_of(dir.path(), &config, "recent"), "uploaded");
        // With no time to read anything, the proof alone answers for the
        // session nothing has changed in since.
        assert_eq!(
            status_within(dir.path(), &config, "recent", Duration::ZERO),
            "uploaded"
        );
        assert_eq!(
            status_within(dir.path(), &config, "old", Duration::ZERO),
            "checking"
        );
        // A new change to the proven session withdraws its proof.
        conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES('codex','recent','later',1,'user','text','synthetic transcript line')",[]).unwrap();
        assert_eq!(
            status_within(dir.path(), &config, "recent", Duration::ZERO),
            "checking"
        );
        assert_eq!(status_of(dir.path(), &config, "recent"), "shared");
        acknowledge_everything(&conn, &config.job_id);
        assert_eq!(status_of(dir.path(), &config, "recent"), "uploaded");
    }
    #[test]
    fn a_proof_does_not_survive_a_change_in_what_the_job_sends() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        add_event(&conn, "old", "later");
        assert_eq!(status_of(dir.path(), &config, "recent"), "uploaded");
        let cache_path = dir.path().join(STATUS_CACHE);
        let proven = fs::read(&cache_path).unwrap();
        let unchanged = |dir: &Path| status_within(dir, &config, "recent", Duration::ZERO);
        assert_eq!(unchanged(dir.path()), "uploaded");
        // An exclusion changes what the job may send.
        conn.execute(
            "INSERT INTO delivery_exclusions(source,session_id) VALUES('claude','elsewhere')",
            [],
        )
        .unwrap();
        assert_eq!(unchanged(dir.path()), "checking");
        conn.execute(
            "DELETE FROM delivery_exclusions WHERE session_id='elsewhere'",
            [],
        )
        .unwrap();
        // A proof from a position the job has since moved back from.
        fs::write(&cache_path, &proven).unwrap();
        assert_eq!(unchanged(dir.path()), "uploaded");
        let mut moved: Value = serde_json::from_slice(&proven).unwrap();
        moved["cursor"] = json!(i64::MAX);
        fs::write(&cache_path, serde_json::to_vec(&moved).unwrap()).unwrap();
        assert_eq!(unchanged(dir.path()), "checking");
        // A proof numbered in another feed epoch.
        let mut other: Value = serde_json::from_slice(&proven).unwrap();
        other["feed_epoch"] = json!(other["feed_epoch"].as_u64().unwrap().wrapping_add(1));
        fs::write(&cache_path, serde_json::to_vec(&other).unwrap()).unwrap();
        assert_eq!(unchanged(dir.path()), "checking");
        // A proof for another job: a restarted job sends everything again.
        fs::write(&cache_path, &proven).unwrap();
        delivery::cancel_job(&conn, &config.job_id).unwrap();
        let job = DeliveryJobConfig {
            destination_id: "relayhistory".into(),
            instance_id: "teams-probe".into(),
            account_id: agent_relay_probe::destination::account_id("org", Some("workspace")),
            mapping_version: agent_relay_probe::destination::MAPPING_VERSION.into(),
            selection: collector::selection(true),
            limits: Default::default(),
        };
        let job = delivery::create_job(&conn, &job, collector::now()).unwrap();
        let restarted = Config {
            job_id: job.job_id,
            ..config.clone()
        };
        assert_eq!(
            status_within(dir.path(), &restarted, "recent", Duration::ZERO),
            "checking"
        );
    }
    #[test]
    fn a_cache_that_cannot_be_read_only_costs_a_read() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        fs::write(dir.path().join(STATUS_CACHE), b"not json").unwrap();
        assert_eq!(status_of(dir.path(), &config, "recent"), "uploaded");
    }
    /// Acknowledge the job's one unresolved batch.
    fn acknowledge_pending(conn: &Connection, job_id: &str) {
        let now = collector::now();
        let claim = delivery::claim_batch(conn, job_id, "test", 30_000, &|| now)
            .unwrap()
            .unwrap();
        delivery::store_prepared_payload(
            conn,
            &claim.lease,
            &claim.batch.mapping_version,
            "application/json",
            "{}",
            &|| now,
        )
        .unwrap();
        let ack = delivery::DeliveryAcknowledgment {
            batch_id: claim.batch.batch_id.clone(),
            accepted_revision_ids: claim
                .batch
                .records
                .iter()
                .map(|record| record.revision_id.clone())
                .collect(),
            unsupported_revision_ids: vec![],
            suppressed_revision_ids: vec![],
            rejected_revision_ids: vec![],
            isolation_frontier: vec![],
            acceptance_level: delivery::AcceptanceLevel::Durable,
        };
        delivery::acknowledge(conn, &claim.lease, &ack, &|| now).unwrap();
    }
    #[test]
    fn a_pending_edge_keeps_its_child_member_queued() {
        let (dir, config) = fixture(SharingMode::Selected);
        let config = apply(dir.path(), config, None, &["claude:old"], true);
        let conn = db(dir.path()).unwrap();
        conn.execute("INSERT INTO sessions(source,session_id,first_prompt,last_activity_ms) VALUES ('claude','child','Spawned',30)", []).unwrap();
        conn.execute("INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) VALUES('claude','old','edge','child','delegation','observed','fixture',1,1)",[]).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        let config = apply(dir.path(), config, None, &["claude:child"], true);
        let limit = |records: i64| {
            conn.execute(
                "UPDATE delivery_jobs SET config_json=json_set(config_json,'$.limits.max_batch_records',?) WHERE id=?",
                rusqlite::params![records, config.job_id],
            )
            .unwrap();
        };
        let edge_pending = || -> bool {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM delivery_batches WHERE state='pending' AND payload LIKE '%\"kind\":\"relationship\"%')",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        // The child's own catalog record fills a one-record batch, which is
        // acknowledged. The next preparation finishes its own changes, then
        // queues the edge that names it (stored under the parent) alone and
        // finishes its backfill.
        limit(1);
        delivery::prepare_batch(&conn, &config.job_id, collector::now())
            .unwrap()
            .batch_id
            .unwrap();
        assert!(!edge_pending());
        acknowledge_pending(&conn, &config.job_id);
        limit(100);
        delivery::prepare_batch(&conn, &config.job_id, collector::now())
            .unwrap()
            .batch_id
            .unwrap();
        assert!(edge_pending());
        let backfilled: bool = conn
            .query_row(
                "SELECT bootstrap_done FROM delivery_session_members WHERE session_id='child'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(backfilled);
        // The child's own records are all acknowledged; only the edge waits.
        assert_eq!(status_of(dir.path(), &config, "child"), "queued");
        acknowledge_everything(&conn, &config.job_id);
        assert_eq!(status_of(dir.path(), &config, "child"), "uploaded");
    }
    #[test]
    fn a_new_edge_keeps_its_child_waiting_before_it_is_prepared() {
        let (dir, config) = fixture(SharingMode::All);
        let conn = db(dir.path()).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        assert_eq!(status_of(dir.path(), &config, "recent"), "uploaded");
        // A new edge is stored under its parent, but names the child.
        conn.execute("INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) VALUES('codex','other','edge','recent','delegation','observed','fixture',1,1)",[]).unwrap();
        assert_eq!(status_of(dir.path(), &config, "recent"), "shared");
        acknowledge_everything(&conn, &config.job_id);
        assert_eq!(status_of(dir.path(), &config, "recent"), "uploaded");
    }
    #[test]
    fn an_edge_from_a_nonmember_parent_does_not_hold_back_its_child() {
        let (dir, config) = fixture(SharingMode::Selected);
        let config = apply(dir.path(), config, None, &["claude:old"], true);
        let conn = db(dir.path()).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        assert_eq!(status_of(dir.path(), &config, "old"), "uploaded");
        // The parent is no member, so the job never sends this edge.
        conn.execute("INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) VALUES('claude','outsider','edge','old','delegation','observed','fixture',1,1)",[]).unwrap();
        assert_eq!(status_of(dir.path(), &config, "old"), "uploaded");
    }
    #[test]
    fn a_parent_does_not_wait_on_a_backfilling_child_it_was_added_after() {
        let (dir, config) = fixture(SharingMode::Selected);
        let conn = db(dir.path()).unwrap();
        conn.execute("INSERT INTO sessions(source,session_id,first_prompt,last_activity_ms) VALUES ('claude','child','Spawned',30)", []).unwrap();
        conn.execute("INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) VALUES('claude','old','edge','child','delegation','observed','fixture',1,1)",[]).unwrap();
        // The child joins first, then the parent: the parent's backfill owns
        // the edge, and nothing the child still backfills can send it.
        let config = apply(dir.path(), config, None, &["claude:child"], true);
        let config = apply(dir.path(), config, None, &["claude:old"], true);
        conn.execute(
            "UPDATE delivery_session_members SET bootstrap_done=1 WHERE session_id='old'",
            [],
        )
        .unwrap();
        assert_eq!(status_of(dir.path(), &config, "child"), "shared");
        assert_eq!(status_of(dir.path(), &config, "old"), "uploaded");
    }
    #[test]
    fn a_parent_does_not_wait_for_an_edge_a_finished_child_backfill_sent() {
        let (dir, config) = fixture(SharingMode::Selected);
        let config = apply(dir.path(), config, None, &["claude:old"], true);
        let conn = db(dir.path()).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        // The edge is written past the parent's cutoff, and the child joins
        // after it: the child's backfill owns and sends the edge.
        conn.execute("INSERT INTO sessions(source,session_id,first_prompt,last_activity_ms) VALUES ('claude','child','Spawned',30)", []).unwrap();
        conn.execute("INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) VALUES('claude','old','edge','child','delegation','observed','fixture',1,1)",[]).unwrap();
        let config = apply(dir.path(), config, None, &["claude:child"], true);
        // Hold the job's own position behind the edge while the child's
        // backfill sends and acknowledges it.
        let behind: i64 = conn
            .query_row(
                "SELECT journal_cursor FROM delivery_jobs WHERE id=?",
                [&config.job_id],
                |r| r.get(0),
            )
            .unwrap();
        acknowledge_everything(&conn, &config.job_id);
        conn.execute(
            "UPDATE delivery_jobs SET journal_cursor=? WHERE id=?",
            rusqlite::params![behind.min(1), config.job_id],
        )
        .unwrap();
        assert_eq!(status_of(dir.path(), &config, "child"), "uploaded");
        assert_eq!(status_of(dir.path(), &config, "old"), "uploaded");
    }
    #[test]
    fn a_child_does_not_wait_for_an_edge_a_finished_parent_backfill_sent() {
        let (dir, config) = fixture(SharingMode::Selected);
        let conn = db(dir.path()).unwrap();
        conn.execute("INSERT INTO sessions(source,session_id,first_prompt,last_activity_ms) VALUES ('claude','child','Spawned',30)", []).unwrap();
        let config = apply(dir.path(), config, None, &["claude:child"], true);
        acknowledge_everything(&conn, &config.job_id);
        // The edge is written past the child's cutoff and the parent joins
        // after it: the parent's backfill owns and sends the edge.
        conn.execute("INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) VALUES('claude','old','edge','child','delegation','observed','fixture',1,1)",[]).unwrap();
        let config = apply(dir.path(), config, None, &["claude:old"], true);
        acknowledge_everything(&conn, &config.job_id);
        // Hold the job's own position behind the edge.
        conn.execute(
            "UPDATE delivery_jobs SET journal_cursor=1 WHERE id=?",
            [&config.job_id],
        )
        .unwrap();
        assert_eq!(status_of(dir.path(), &config, "old"), "uploaded");
        assert_eq!(status_of(dir.path(), &config, "child"), "uploaded");
    }
    #[test]
    fn a_drain_pages_past_withheld_edges_to_what_it_sends() {
        let (dir, config) = fixture(SharingMode::Selected);
        let config = apply(dir.path(), config, None, &["claude:old"], true);
        let conn = db(dir.path()).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        // More withheld edges (to non-member children) than one drain page:
        // the drain reads every page, reaches the end, and nothing waits.
        for index in 0..40 {
            conn.execute("INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) VALUES('claude','old',?1,?2,'delegation','observed','fixture',1,1)",rusqlite::params![format!("edge-{index}"), format!("outsider-{index}")]).unwrap();
        }
        assert_eq!(status_of(dir.path(), &config, "old"), "uploaded");
        // A change the job sends, after all of them: the drain pages on to it.
        conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES('claude','old','later',1,'user','text','synthetic transcript line')",[]).unwrap();
        assert_eq!(status_of(dir.path(), &config, "old"), "shared");
    }
    #[test]
    fn an_edge_to_or_from_an_excluded_session_does_not_hold_back_a_new_one() {
        // New-only sharing excludes the sessions that existed at setup.
        let (dir, config) = fixture(SharingMode::New);
        let conn = db(dir.path()).unwrap();
        conn.execute("INSERT INTO sessions(source,session_id,first_prompt,last_activity_ms) VALUES ('claude','fresh','New work',40)", []).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        assert_eq!(status_of(dir.path(), &config, "old"), "not_shared");
        assert_eq!(status_of(dir.path(), &config, "fresh"), "uploaded");
        // Stored under the new session, naming an excluded child.
        conn.execute("INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) VALUES('claude','fresh','down','old','delegation','observed','fixture',1,1)",[]).unwrap();
        assert_eq!(status_of(dir.path(), &config, "fresh"), "uploaded");
        // Stored under an excluded parent, naming the new session.
        conn.execute("INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) VALUES('claude','old','up','fresh','delegation','observed','fixture',1,1)",[]).unwrap();
        assert_eq!(status_of(dir.path(), &config, "fresh"), "uploaded");
    }
    #[test]
    fn a_parent_waits_while_a_backfilling_child_member_may_send_its_edge() {
        let (dir, config) = fixture(SharingMode::Selected);
        let config = apply(dir.path(), config, None, &["claude:old"], true);
        let conn = db(dir.path()).unwrap();
        conn.execute("INSERT INTO sessions(source,session_id,first_prompt,last_activity_ms) VALUES ('claude','child','Spawned',30)", []).unwrap();
        conn.execute("INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) VALUES('claude','old','edge','child','delegation','observed','fixture',1,1)",[]).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        assert_eq!(status_of(dir.path(), &config, "old"), "uploaded");
        // The child joins later: its backfill sends the edge stored under the
        // parent, so the parent is not uploaded until that backfill finishes.
        let config = apply(dir.path(), config, None, &["claude:child"], true);
        assert_eq!(status_of(dir.path(), &config, "old"), "shared");
        acknowledge_everything(&conn, &config.job_id);
        assert_eq!(status_of(dir.path(), &config, "old"), "uploaded");
        assert_eq!(status_of(dir.path(), &config, "child"), "uploaded");
    }
    #[test]
    fn legacy_config_retains_its_sharing_choice() {
        let (_, config) = fixture(SharingMode::New);
        let mut value = serde_json::to_value(config).unwrap();
        value.as_object_mut().unwrap().remove("sharing_mode");
        assert_eq!(
            mode(&serde_json::from_value(value).unwrap()),
            SharingMode::New
        );
    }

    /// A store an older build wrote: one read index missing, which a
    /// read-only open refuses and a writable open adds back.
    fn make_stale(dir: &Path) {
        Connection::open(dir.join("history.db"))
            .unwrap()
            .execute_batch("DROP INDEX idx_tool_calls_page_v2;")
            .unwrap();
    }
    fn migrated(dir: &Path) -> bool {
        Connection::open(dir.join("history.db"))
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='idx_tool_calls_page_v2')",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }

    /// The desktop polls status and the session list under a timeout that a
    /// migration of a large store outlasts. Killed, it rolls back and holds
    /// off the collector, so neither migrates: status says local history is
    /// upgrading and the list asks to wait for it.
    #[test]
    fn polled_reads_leave_the_upgrade_to_the_collector() {
        let (dir, config) = fixture(SharingMode::All);
        make_stale(dir.path());

        let status = status_value(dir.path()).unwrap();
        assert_eq!(status["last_cycle"]["ok"], false);
        assert_eq!(status["last_cycle"]["error_class"], "upgrading");
        assert_eq!(status["last_cycle"]["message"], UPGRADING);
        assert_eq!(status["sessions"]["total"], 0);
        assert!(!migrated(dir.path()));

        let error = session_rows(dir.path(), &config, 10).unwrap_err();
        assert!(delivery::is_upgrade_pending(&error), "{error:#}");
        assert!(!migrated(dir.path()));

        // Only the collector lock's holder migrates.
        drop(db(dir.path()).unwrap());
        assert!(migrated(dir.path()));
        let status = status_value(dir.path()).unwrap();
        assert_ne!(status["last_cycle"]["error_class"], "upgrading");
        assert_eq!(status["sessions"]["total"], 2);
        assert_eq!(session_rows(dir.path(), &config, 10).unwrap().len(), 2);
    }

    /// A failed upgrade leaves the store waiting for it, and the live run's
    /// report names the cause: status shows that, not an upgrade in progress
    /// that will never finish on its own.
    #[test]
    fn a_failed_upgrade_reports_its_cause() {
        let (dir, _config) = fixture(SharingMode::All);
        make_stale(dir.path());
        save_json(
            &dir.path().join("runtime.json"),
            &json!({"startup_id":"run","pid":1,"ready":true}),
        )
        .unwrap();
        save_json(
            &dir.path().join("cycle.json"),
            &json!({"startup_id":"run","ok":false,"error_class":"disk_full","message":"full"}),
        )
        .unwrap();
        assert_eq!(
            status_value(dir.path()).unwrap()["last_cycle"]["error_class"],
            "disk_full"
        );
        // Another run's failure is not this upgrade's.
        save_json(
            &dir.path().join("runtime.json"),
            &json!({"startup_id":"next","pid":1,"ready":true}),
        )
        .unwrap();
        assert_eq!(
            status_value(dir.path()).unwrap()["last_cycle"]["error_class"],
            "upgrading"
        );
    }

    /// A store no one can open fails every read, status's included, while the
    /// collector keeps running and reports why: status answers with that report.
    #[test]
    fn status_answers_with_the_collectors_report_when_the_store_cannot_open() {
        let (dir, _config) = fixture(SharingMode::All);
        let store = dir.path().join("history.db");
        for suffix in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{suffix}", store.display()));
        }
        fs::create_dir(&store).unwrap();
        assert!(status_value(dir.path()).is_err());

        save_json(
            &dir.path().join("runtime.json"),
            &json!({"startup_id":"run","pid":1,"ready":true}),
        )
        .unwrap();
        save_json(
            &dir.path().join("cycle.json"),
            &json!({"startup_id":"run","ok":false,"error_class":"database_unavailable","message":"x"}),
        )
        .unwrap();
        let status = status_value(dir.path()).unwrap();
        assert_eq!(status["last_cycle"]["error_class"], "database_unavailable");
        assert_eq!(status["account_email"], "person@example.com");
        assert!(status.get("delivery").is_none());

        // A store that opens but fails a later read falls back the same way.
        fs::remove_dir(&store).unwrap();
        drop(db(dir.path()).unwrap());
        Connection::open(&store)
            .unwrap()
            .execute_batch("DROP TABLE change_feed_store;")
            .unwrap();
        let status = status_value(dir.path()).unwrap();
        assert_eq!(status["last_cycle"]["error_class"], "database_unavailable");
        fs::remove_file(dir.path().join("cycle.json")).unwrap();
        assert!(status_value(dir.path()).is_err(), "a later read must fail");
    }

    /// Pause, resume and compaction run beside the collector and under the
    /// desktop's timeouts, so they refuse a store waiting for its upgrade
    /// rather than start it, in words the desktop can show.
    #[test]
    fn control_actions_refuse_a_store_waiting_for_its_upgrade() {
        let (dir, _config) = fixture(SharingMode::All);
        make_stale(dir.path());
        let error = control_db(dir.path()).unwrap_err();
        assert_eq!(error.to_string(), UPGRADING);
        assert!(!migrated(dir.path()));

        // A store from before the change feed is refused the same way.
        drop(db(dir.path()).unwrap());
        Connection::open(dir.path().join("history.db"))
            .unwrap()
            .execute_batch(
                "DELETE FROM schema_migrations WHERE name = 'change_feed_v2'; \
                 DELETE FROM change_feed_store;",
            )
            .unwrap();
        // The open itself accepts it; only the feed says it predates its schema.
        super::super::history::open_read(&dir.path().join("history.db")).unwrap();
        let error = delivery::open_control_db(&dir.path().join("history.db")).unwrap_err();
        assert!(delivery::is_upgrade_pending(&error), "{error:#}");
    }

    /// A store that predates only the change feed opens and lists sessions as
    /// before, so status and the session list ask the feed too: otherwise they
    /// show the last verdict, or sessions as uploaded, through the upgrade.
    #[test]
    fn polled_reads_see_a_store_waiting_only_for_the_feed() {
        let (dir, config) = fixture(SharingMode::All);
        Connection::open(dir.path().join("history.db"))
            .unwrap()
            .execute_batch(
                "DELETE FROM schema_migrations WHERE name = 'change_feed_v2'; \
                 DELETE FROM change_feed_store;",
            )
            .unwrap();
        let status = status_value(dir.path()).unwrap();
        assert_eq!(status["last_cycle"]["error_class"], "upgrading");
        let error = session_rows(dir.path(), &config, 10).unwrap_err();
        assert!(delivery::is_upgrade_pending(&error), "{error:#}");

        drop(db(dir.path()).unwrap());
        assert_ne!(
            status_value(dir.path()).unwrap()["last_cycle"]["error_class"],
            "upgrading"
        );
        assert_eq!(session_rows(dir.path(), &config, 10).unwrap().len(), 2);
    }

    /// A collector keeps the build that launched it: a record from an older
    /// build, or from before builds were recorded, is outdated. A newer
    /// build's collector is not, so it is never replaced by a downgrade.
    #[test]
    fn a_collector_from_an_older_build_is_outdated() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = dir.path().join("runtime.json");
        assert!(!collector::outdated(dir.path()));
        save_json(&runtime, &json!({"startup_id":"1-1","pid":1,"ready":true})).unwrap();
        assert!(collector::outdated(dir.path()));
        save_json(
            &runtime,
            &json!({"startup_id":"1-1","pid":1,"ready":true,"version":"0.0.1"}),
        )
        .unwrap();
        assert!(collector::outdated(dir.path()));
        save_json(
            &runtime,
            &json!({"startup_id":"1-1","pid":1,"ready":true,"version":agent_relay_probe::VERSION}),
        )
        .unwrap();
        assert!(!collector::outdated(dir.path()));
        assert!(!collector::newer_build(dir.path()));
        save_json(
            &runtime,
            &json!({"startup_id":"1-1","pid":1,"ready":true,"version":"999999.0.0"}),
        )
        .unwrap();
        assert!(!collector::outdated(dir.path()));
        assert!(collector::newer_build(dir.path()));
    }

    #[test]
    fn replacement_handoff_holds_ownership_until_it_can_start_the_new_build() {
        let dir = tempfile::tempdir().unwrap();
        let collector_lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.path().join("collector.lock"))
            .unwrap();
        collector_lock.lock_exclusive().unwrap();
        save_json(
            &dir.path().join("runtime.json"),
            &json!({"startup_id":"old-run","version":"older-build"}),
        )
        .unwrap();
        save_json(
            &dir.path().join("stop.json"),
            &json!({"startup_id":"old-run"}),
        )
        .unwrap();
        let path = dir.path().to_owned();
        let (started, receive) = std::sync::mpsc::channel();
        let helper = std::thread::spawn(move || {
            complete_replacement_with(&path, "old-run", &|_| {
                started.send(()).unwrap();
                Ok(())
            })
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !collector::replacement_in_progress(dir.path()) {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(receive.try_recv().is_err());
        FileExt::unlock(&collector_lock).unwrap();
        receive.recv_timeout(Duration::from_secs(5)).unwrap();
        helper.join().unwrap().unwrap();
    }

    #[test]
    fn reconnect_prepares_no_acknowledged_history_and_only_sends_new_changes() {
        let (dir, config) = fixture(SharingMode::Selected);
        let config = apply(dir.path(), config, None, &["claude:old"], true);
        let conn = db(dir.path()).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        let before = delivery::status(&conn, &config.job_id).unwrap();
        retain_signed_out_install(dir.path()).unwrap();
        let restored = super::super::saved_config(dir.path()).unwrap().unwrap();
        assert_eq!(restored.job_id, config.job_id);
        save_json(&dir.path().join("config.json"), &restored).unwrap();
        enforce_selection(dir.path(), &restored).unwrap();
        let prepared = delivery::prepare_batch(&conn, &restored.job_id, collector::now()).unwrap();
        assert_eq!(
            prepared.batch_id, None,
            "reconnect must not prepare already acknowledged history"
        );
        assert!(prepared.bootstrap_complete);
        assert_eq!(status_of(dir.path(), &restored, "old"), "uploaded");
        assert_eq!(status_of(dir.path(), &restored, "recent"), "not_shared");
        assert_eq!(
            delivery::status(&conn, &restored.job_id)
                .unwrap()
                .acknowledged_records,
            before.acknowledged_records
        );
        conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES('claude','old','after-reconnect',30,'user','text','New work after signing back in')",[]).unwrap();
        let prepared = delivery::prepare_batch(&conn, &restored.job_id, collector::now()).unwrap();
        assert!(prepared.batch_id.is_some(), "new changes still upload");
        acknowledge_everything(&conn, &restored.job_id);
    }

    #[test]
    fn sign_out_preserves_workspace_delivery_and_reconnect_resumes_the_same_job() {
        let root = tempfile::tempdir().unwrap();
        let (kept, _) = fixture(SharingMode::All);
        let (gone, config) = fixture(SharingMode::Selected);
        fs::rename(kept.path(), root.path().join("kept")).unwrap();
        fs::rename(gone.path(), root.path().join("gone")).unwrap();
        let directory = root.path().join("gone");
        let identity = parse_key("claude:old").unwrap();
        save_json(&directory.join("selected.json"), &vec![identity.clone()]).unwrap();
        enforce_selection(&directory, &config).unwrap();
        let conn = db(&directory).unwrap();
        delivery::set_job_session(&conn, &config.job_id, &identity, true).unwrap();
        conn.execute(
            "UPDATE delivery_session_members SET cursor=42,bootstrap_done=1 WHERE job_id=?",
            [&config.job_id],
        )
        .unwrap();
        conn.execute(
            "UPDATE delivery_jobs SET acknowledged_cursor=42,acknowledged_records=10 WHERE id=?",
            [&config.job_id],
        )
        .unwrap();
        conn.execute("INSERT INTO delivery_batches(id,job_id,state,records,bytes,journal_end,created_ms) VALUES ('sent',?1,'acknowledged',1,10,42,0),('queued',?1,'pending',1,10,43,0)", [&config.job_id]).unwrap();
        fs::create_dir_all(directory.join("stages")).unwrap();
        fs::write(directory.join("stages/credential.auth.json"), "secret").unwrap();
        assert_eq!(
            installs_value(root.path()).unwrap()["installs"]
                .as_array()
                .unwrap()
                .len(),
            2
        );

        retain_signed_out_install(&directory).unwrap();
        retain_signed_out_install(&directory).unwrap(); // crash/retry safe
        assert!(read_config(&directory).is_err());
        assert!(!directory.join("stages").exists());
        assert_eq!(
            installs_value(root.path()).unwrap()["installs"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(selected(&directory).unwrap(), vec![identity]);
        let restored = super::super::saved_config(&directory).unwrap().unwrap();
        assert_eq!(restored.job_id, config.job_id);
        assert_eq!(restored.workspace_id, config.workspace_id);
        assert_eq!(mode(&restored), SharingMode::Selected);
        save_json(&directory.join("config.json"), &restored).unwrap();
        enforce_selection(&directory, &restored).unwrap();
        let progress: (i64, bool) = conn
            .query_row(
                "SELECT cursor,bootstrap_done FROM delivery_session_members WHERE job_id=?",
                [&restored.job_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(progress, (42, true));
        let counts: (i64, i64) = conn
            .query_row(
                "SELECT acknowledged_cursor,acknowledged_records FROM delivery_jobs WHERE id=?",
                [&restored.job_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(counts, (42, 10));
        let batches: Vec<(String, String)> = conn
            .prepare("SELECT id,state FROM delivery_batches ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            batches,
            vec![
                ("queued".into(), "pending".into()),
                ("sent".into(), "acknowledged".into())
            ]
        );
        assert_eq!(delivery::list_jobs(&conn).unwrap().len(), 1);
    }
}
