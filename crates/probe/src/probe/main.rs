//! Standalone Cloud collector. Reuses ai-hist capture/queue and the optional transport.
// Machine-readable commands must never mix progress prose into stdout.
macro_rules! humanln {
    ($($arg:tt)*) => { if !crate::bridge::json_mode() { println!($($arg)*); } };
}
mod bridge;
mod cloud_commands;
mod collector;
mod connect;
mod control;
mod flush;
mod history;
mod install_sharing;
mod inventory;
mod live;
mod priority;
mod progress;
mod reclaim;
mod relay_commands;
use relay_commands::RelayCommands;
mod remote_sources;
mod session_metadata;
mod session_reset;
mod transcript;
mod transcript_display;

use agent_relay_probe::{cloud, destination, migration, relay};
use anyhow::{ensure, Context, Result};
use clap::{Args, Parser, Subcommand};
use cloud_commands::Install;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

#[derive(Parser)]
#[command(
    name = "agent-relay-probe",
    version = agent_relay_probe::VERSION,
    propagate_version = true,
    about = "Connect coding sessions to Agent Relay Cloud"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
    #[arg(long, global = true)]
    json: bool,
}
#[derive(Subcommand)]
enum Commands {
    /// Temporary agent-to-agent rooms, without npm or a desktop GUI.
    Connect {
        #[command(subcommand)]
        command: connect::Command,
    },
    Cloud {
        #[command(subcommand)]
        command: cloud_commands::CloudCommands,
    },
    #[command(hide = true)]
    Run {
        #[arg(long)]
        directory: PathBuf,
        #[arg(long)]
        startup_id: String,
    },
    #[command(hide = true)]
    CompleteReplacement {
        #[arg(long)]
        directory: PathBuf,
        #[arg(long)]
        startup_id: String,
    },
    Stop(Target),
    Status(Target),
    Installs,
    /// Release what decommissioned installs no longer need. `installs` is a
    /// pure read; this is the one command that opens a decommissioned store.
    Reclaim,
    Start(Target),
    #[command(flatten)]
    Control(control::Control),
    Disconnect(Target),
    /// List receiver-proven delivery conflicts retained for repair.
    Conflicts(Target),
    Sessions {
        #[command(subcommand)]
        command: bridge::SessionCommand,
    },
    Sharing {
        #[command(subcommand)]
        command: bridge::SharingCommand,
    },
    /// The relay core: the desktop's long-running runtime and its bridge.
    Relay {
        #[command(subcommand)]
        command: RelayCommands,
    },
    /// Local history for hosts other than the desktop.
    #[command(hide = true)]
    History {
        #[command(subcommand)]
        command: HistoryCommands,
    },
}
#[derive(Subcommand)]
enum HistoryCommands {
    /// Capture every local session and upload it with a push-only
    /// RelayHistory session, until the queue is empty or the deadline passes.
    Flush(flush::Flush),
}
#[derive(Args, Clone)]
struct Target {
    #[arg(long, default_value = "https://agentrelay.com")]
    site_url: String,
    #[arg(long)]
    account: String,
    #[arg(long)]
    workspace: String,
}
/// The `config.json` format this build reads and writes.
const CONFIG_VERSION: u32 = 1;
#[derive(Clone, Serialize, Deserialize)]
struct Config {
    version: u32,
    site_url: String,
    account_id: String,
    #[serde(default)]
    account_email: Option<String>,
    #[serde(default)]
    account_name: Option<String>,
    #[serde(default)]
    account_avatar_url: Option<String>,
    org_id: String,
    workspace_id: String,
    #[serde(default)]
    workspace_name: Option<String>,
    history_url: String,
    delivery_account: String,
    job_id: String,
    include_existing: bool,
    #[serde(default)]
    sharing_mode: Option<bridge::SharingMode>,
    #[serde(default)]
    acknowledge_uninspected_schedules: bool,
}
#[derive(Debug)]
struct UserError(&'static str);
impl std::fmt::Display for UserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for UserError {}
fn user_error(message: &'static str) -> anyhow::Error {
    UserError(message).into()
}
/// Dispatch probe commands and report only explicitly safe user-facing errors.
fn main() {
    // `history flush` captures and uploads the home it is given, which a
    // sandbox sets on purpose: it keeps that home. Every other command is
    // the desktop's, and reads the profile Claude Code and Codex write to.
    if !flush::requested_on_argv() {
        agent_relay_probe::platform::adopt_profile_home();
    }
    flush::refuse_token_on_argv();
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error)
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) =>
        {
            error.exit()
        }
        Err(error) if flush::requested_on_argv() => {
            let _ = error.print();
            flush::invalid_arguments()
        }
        Err(error) => error.exit(),
    };
    bridge::set_json(cli.json);
    if let Err(error) = run(cli) {
        // Provider errors can contain bodies, credentials or history; never print them.
        if let Some(safe) = error.downcast_ref::<UserError>() {
            eprintln!("{safe}");
        } else if let Some(safe) = error.downcast_ref::<relay::daemon::SafeError>() {
            eprintln!("{safe}");
        } else if let Some(safe) = error.downcast_ref::<cloud::CloudAuthError>() {
            eprintln!("{safe}");
        } else if let Some(safe) = collector::local_failure_message(&error) {
            eprintln!("{safe}");
        } else {
            eprintln!("Probe could not finish. Check your connection and run setup again. Credentials and session content were not logged.");
        }
        std::process::exit(1);
    }
}
fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Commands::Connect { command } => connect::run(command),
        Commands::Cloud { command } => cloud_commands::run(command),
        Commands::Run {
            directory,
            startup_id,
        } => {
            // Choose the collector caller's policy before starting its workers.
            // Capture, inventory and remote polling set their own thread policy.
            priority::collector();
            collector::run_background(&directory, &startup_id)
        }
        Commands::CompleteReplacement {
            directory,
            startup_id,
        } => bridge::complete_replacement(&directory, &startup_id),
        Commands::Stop(target) => collector::stop(&target.directory()?),
        Commands::Status(target) if bridge::json_mode() => bridge::status(&target.directory()?),
        Commands::Status(target) => {
            let directory = target.directory()?;
            collector::print_status(&directory)?;
            bridge::print_sharing_line(&directory);
            Ok(())
        }
        Commands::Installs => bridge::installs(),
        Commands::Reclaim => reclaim::reclaim(),
        Commands::Start(target) => bridge::start(&target.directory()?),
        Commands::Control(command) => command.run(),
        Commands::Disconnect(target) => bridge::disconnect(&target.directory()?),
        Commands::Conflicts(target) => conflicts(&target.directory()?),
        Commands::Sessions { command } => bridge::sessions(command),
        Commands::Sharing { command } => bridge::sharing(command),
        Commands::History {
            command: HistoryCommands::Flush(options),
        } => flush::run(options),
        Commands::Relay { command } => relay_commands::run(command),
    }
}

fn conflicts(directory: &Path) -> Result<()> {
    let conn = agent_relay_probe::delivery::open_db_readonly(&directory.join("history.db"))?;
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_quarantine')",
        [], |row| row.get(0))?;
    let mut records = Vec::new();
    if exists {
        let mut statement = conn.prepare("SELECT record_id,revision_id,created_ms FROM delivery_quarantine ORDER BY created_ms,parent_batch_id,revision_id LIMIT 500")?;
        let rows = statement.query_map([], |row| {
            Ok(serde_json::json!({
                "recordId":row.get::<_, String>(0)?, "revisionId":row.get::<_, String>(1)?,
                "quarantinedAtMs":row.get::<_, i64>(2)?
            }))
        })?;
        for row in rows {
            records.push(row?);
        }
    }
    if bridge::json_mode() {
        println!("{}", serde_json::json!({"conflicts":records}));
    } else if records.is_empty() {
        println!("No quarantined delivery conflicts.");
    } else {
        for record in &records {
            println!(
                "record {} revision {}",
                record["recordId"].as_str().unwrap_or(""),
                record["revisionId"].as_str().unwrap_or("")
            );
        }
    }
    Ok(())
}
impl Target {
    fn directory(&self) -> Result<PathBuf> {
        let site = cloud::site_origin(&self.site_url)?;
        validate_id(&self.account)?;
        validate_id(&self.workspace)?;
        directory(&site, &self.account, &self.workspace)
    }
}
fn validate_id(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
        "invalid identifier"
    );
    Ok(())
}
/// `HOME`, and on Windows `USERPROFILE` when `HOME` is unset.
fn home() -> Result<PathBuf> {
    agent_relay_probe::platform::home_dir().context("HOME unavailable")
}
fn directory(site: &str, account: &str, workspace: &str) -> Result<PathBuf> {
    let key = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(site, account, workspace))?)
    );
    Ok(home()?.join(".agentworkforce/probe").join(key))
}
fn private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn save_json(path: &Path, value: &impl Serialize) -> Result<()> {
    write_json(path, value, |file| file.sync_all())
}
/// [`save_json`] for the status the collector rewrites on every pass:
/// `progress.json`, `cycle.json` and `capture-diagnostic.json`. They are
/// flushed through the filesystem before they replace the old file, as the
/// store's own SQLite commits are, but not through the drive's write cache.
/// On macOS `File::sync_all` is `F_FULLFSYNC`, a flush of the whole drive
/// cache that takes about 5 ms and holds up every other write to the volume
/// while it runs, the capture and delivery commits beside it included; two
/// or three a pass were most of the delivery loop's time outside the drain.
/// Elsewhere `sync_all` is already `fsync`. A power loss can lose the last
/// such write, which the next pass replaces; readers already treat a missing
/// or unreadable status file as no report.
fn save_status_json(path: &Path, value: &impl Serialize) -> Result<()> {
    write_json(path, value, flush_to_filesystem)
}
/// Write `value` to a private temporary file beside `path`, make it durable
/// with `flush`, and rename it into place.
fn write_json(
    path: &Path,
    value: &impl Serialize,
    flush: impl FnOnce(&fs::File) -> io::Result<()>,
) -> Result<()> {
    private_directory(path.parent().context("missing parent")?)?;
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    let mut writer = io::BufWriter::new(&mut temporary);
    serde_json::to_writer(&mut writer, value)?;
    writer.flush()?;
    drop(writer);
    flush(temporary.as_file())?;
    temporary.persist(path).map_err(|e| e.error)?;
    Ok(())
}
#[cfg(target_os = "macos")]
fn flush_to_filesystem(file: &fs::File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: `fsync` only reads the descriptor, which `file` keeps open.
    if unsafe { libc::fsync(file.as_raw_fd()) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
#[cfg(not(target_os = "macos"))]
fn flush_to_filesystem(file: &fs::File) -> io::Result<()> {
    file.sync_all()
}
fn read_config(directory: &Path) -> Result<Config> {
    read_config_file(&directory.join("config.json"))
}

// Only explicit authenticated setup may restore a signed-out installation.
fn saved_config(directory: &Path) -> Result<Option<Config>> {
    for name in ["config.json", "signed-out.json"] {
        let path = directory.join(name);
        if path.exists() {
            return read_config_file(&path).map(Some);
        }
    }
    Ok(None)
}

fn read_config_file(path: &Path) -> Result<Config> {
    let config: Config = serde_json::from_slice(&fs::read(path)?)?;
    ensure!(
        config.version == CONFIG_VERSION
            && cloud::site_origin(&config.site_url)? == config.site_url,
        "invalid config"
    );
    ensure!(
        cloud::history_origin(&config.history_url, &config.site_url)? == config.history_url,
        "invalid history origin"
    );
    validate_id(&config.account_id)?;
    validate_id(&config.workspace_id)?;
    ensure!(
        config.delivery_account
            == destination::account_id(&config.org_id, Some(&config.workspace_id)),
        "invalid account"
    );
    Ok(config)
}
fn lock(directory: &Path) -> Result<fs::File> {
    private_directory(directory)?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("collector.lock"))?;
    file.try_lock_exclusive()
        .map_err(|_| user_error("This workspace’s uploader is already running."))?;
    Ok(file)
}
/// Install-time user messaging only: the same rule is enforced per dispatch
/// inside the receiver, where an actionable sentence would have nobody to read
/// it. Both must agree, so neither is allowed to drift into a softer check.
fn check_legacy_schedules(acknowledge_uninspected_schedules: bool) -> Result<()> {
    legacy_schedule_verdict(migration::status().state, acknowledge_uninspected_schedules)
}
/// [`check_legacy_schedules`] for a scheduler `state` already inspected.
fn legacy_schedule_verdict(state: &str, acknowledge_uninspected_schedules: bool) -> Result<()> {
    if state == "active" {
        return Err(user_error("An older managed history uploader is active. Stop it explicitly before enabling this probe."));
    }
    if state == "unknown" && !acknowledge_uninspected_schedules {
        return Err(user_error("Could not inspect older upload schedules. Check them, then retry with --acknowledge-uninspected-schedules."));
    }
    Ok(())
}
fn validate_setup_mode(options: &Install, json: bool) -> Result<()> {
    ensure!(
        !json || (!options.foreground && !options.once),
        user_error("JSON setup requires background mode. Omit --once and --foreground.")
    );
    ensure!(
        !json
            || options.include_existing
            || options.new_sessions_only
            || options.selected_sessions_only,
        user_error("JSON setup requires an explicit sharing choice: --include-existing, --new-sessions-only, or --selected-sessions-only.")
    );
    Ok(())
}
fn install(options: Install) -> Result<()> {
    validate_setup_mode(&options, bridge::json_mode())?;
    let site = cloud::site_origin(&options.site_url)?;
    let api_url = cloud::cloud_api_url(Some(&format!("{site}/cloud")))?;
    for id in [options.account.as_deref(), options.workspace.as_deref()]
        .into_iter()
        .flatten()
    {
        validate_id(id)?;
    }
    check_legacy_schedules(options.acknowledge_uninspected_schedules)?;
    humanln!("Connecting to Agent Relay Cloud…");
    // Setup is always run by a person at a keyboard, but its stdin may be a
    // pipe (the composed local harness runs it that way), so the approval URL
    // is printed rather than gated on a terminal.
    let authenticated = cloud::cloud_bearer(
        &api_url,
        cloud::CloudBearerOptions {
            force_login: options.force_login,
            interactive: true,
            client_name: "Agent Relay Session Recorder",
            announce: &mut |approval: &cloud::DeviceApproval| {
                if bridge::json_mode() {
                    bridge::emit(serde_json::json!({
                        "event":"approval",
                        "verification_uri":approval.verification_uri,
                        "verification_uri_complete":approval.verification_uri_complete,
                        "user_code":approval.user_code,
                        "expires_at":approval.expires_at,
                        "interval":approval.interval
                    }));
                }
                humanln!(
                    "Open this URL to authorize your computer:\n{}",
                    approval
                        .verification_uri_complete
                        .as_ref()
                        .unwrap_or(&approval.verification_uri)
                );
                if let Some(code) = &approval.user_code {
                    humanln!("Code: {code}");
                }
            },
        },
    )?;
    let who = cloud::whoami(&api_url, &authenticated)?;
    if options
        .account
        .as_ref()
        .is_some_and(|id| id != &who.user_id)
    {
        return Err(user_error("This is a different Cloud account. Retry with --force-login and the account from your dashboard."));
    }
    let workspace = options
        .workspace
        .clone()
        .or(who.workspace_id.clone())
        .ok_or_else(|| user_error("Create a workspace in your dashboard before connecting."))?;
    validate_id(&who.user_id)?;
    validate_id(&workspace)?;
    let directory = directory(&site, &who.user_id, &workspace)?;
    let _control = bridge::setup_lock(&directory, bridge::SETUP_WAIT)?;
    with_collector(
        &directory,
        options.foreground,
        &bridge::start_stopped,
        || {
            connect(
                &options,
                site,
                api_url,
                authenticated,
                who,
                workspace,
                directory.clone(),
            )
        },
    )
}

/// The sharing choice setup applies: a saved install's own, else the one
/// requested (`None` asks interactively). A different explicit choice for a
/// saved install is refused, since changing it replaces its delivery
/// generation, unless `keep_saved` says the request is only the default for a
/// new install, as the desktop apps' sign-in does.
fn setup_sharing(
    saved: Option<bridge::SharingMode>,
    requested: Option<bridge::SharingMode>,
    keep_saved: bool,
) -> Result<Option<bridge::SharingMode>> {
    match (saved, requested) {
        (Some(saved), Some(requested)) if saved != requested && !keep_saved => Err(user_error(
            "A saved sharing choice exists. Changing selection requires explicitly replacing its delivery generation.",
        )),
        (Some(saved), _) => Ok(Some(saved)),
        (None, requested) => Ok(requested),
    }
}

/// Setup's work on `directory` once it owns the install's collector.
fn connect(
    options: &Install,
    site: String,
    api_url: String,
    authenticated: String,
    who: cloud::CloudIdentity,
    workspace: String,
    directory: PathBuf,
) -> Result<()> {
    let guard = lock(&directory)?;
    let workspace_name = (who.workspace_id.as_deref() == Some(workspace.as_str()))
        .then(|| who.workspace_name.clone())
        .flatten();
    bridge::recover(&directory)?;
    let existing = saved_config(&directory)?;
    let requested = if options.include_existing {
        Some(bridge::SharingMode::All)
    } else if options.new_sessions_only {
        Some(bridge::SharingMode::New)
    } else if options.selected_sessions_only {
        Some(bridge::SharingMode::Selected)
    } else {
        None
    };
    let saved = existing.as_ref().map(bridge::mode);
    let sharing_mode = match setup_sharing(saved, requested, options.keep_saved_sharing)? {
        Some(choice) => choice,
        None => match install_sharing::choose_import()? {
            Some(choice) => choice,
            None => {
                humanln!("Setup cancelled. No sessions shared.");
                return Ok(());
            }
        },
    };
    let include_existing = sharing_mode == bridge::SharingMode::All;
    // Cloud authentication is the desktop login boundary. Report it before
    // provisioning the optional RelayHistory upload session so a History or
    // RelayAuth outage cannot turn a successful Agent Relay login into a
    // signed-out state. The desktop keeps consuming this process and reports
    // any later failure as degraded upload setup.
    if bridge::json_mode() {
        bridge::emit(
            serde_json::json!({"event":"authenticated", "account_id":who.user_id,
            "account_email":who.email, "account_name":who.name,
            "account_avatar_url":who.avatar_url,
            "workspace_id":workspace, "directory":directory}),
        );
    }
    // The workspace bridge, not this binary, selects the RelayHistory stage and
    // the scope it grants; the shared implementation checks both.
    let session = cloud::workspace_session(
        &api_url,
        &authenticated,
        &workspace,
        "sync",
        "Probe setup pending",
    )?;
    let history_url = session.base_url.clone();
    let org_id = session.org_id.clone().context("missing org")?;
    let account = destination::account_id(&org_id, Some(&workspace));
    if existing
        .as_ref()
        .is_some_and(|c| c.delivery_account != account || c.history_url != history_url)
    {
        return Err(user_error(
            "Saved history belongs to a different destination. It was not replaced.",
        ));
    }
    std::env::set_var("RELAYHISTORY_HOME", &directory);
    cloud::save_auth(&session)?;
    if bridge::json_mode() {
        bridge::emit(
            serde_json::json!({"event":"connected", "account_id":who.user_id,
            "account_email":who.email, "account_name":who.name,
            "account_avatar_url":who.avatar_url,
            "workspace_id":workspace, "org_id":org_id, "directory":directory}),
        );
    }
    let db_path = directory.join("history.db");
    if sharing_mode != bridge::SharingMode::Selected {
        humanln!("Preparing local session capture…");
        collector::capture(&directory, &history_url)?;
    } else {
        humanln!("Listing local sessions…");
        collector::catalog_for_setup(&directory);
    }
    let conn = agent_relay_probe::delivery::open_db(&db_path)?;
    let config = match existing {
        Some(mut config) => {
            config.workspace_name = workspace_name.or(config.workspace_name);
            config.account_email = who.email;
            config.account_name = who.name;
            config.account_avatar_url = who.avatar_url;
            config.acknowledge_uninspected_schedules = options.acknowledge_uninspected_schedules;
            save_json(&directory.join("config.json"), &config)?;
            let job = agent_relay_probe::delivery::status(&conn, &config.job_id)?;
            ensure!(
                job.config.account_id == account,
                "invalid saved delivery account"
            );
            if job.state == "blocked" && options.force_login {
                agent_relay_probe::delivery::retry_job(&conn, &config.job_id)?;
            }
            config
        }
        None => {
            let job_config = agent_relay_probe::delivery::DeliveryJobConfig {
                destination_id: "relayhistory".into(),
                instance_id: "teams-probe".into(),
                account_id: account.clone(),
                mapping_version: destination::MAPPING_VERSION.into(),
                selection: collector::selection(include_existing),
                limits: Default::default(),
            };
            // A generation outlives an interrupted setup: create_job commits
            // before config.json is written. Adopt that job instead of recording
            // a second baseline behind a generation nothing can reach.
            let adopted = agent_relay_probe::delivery::list_jobs(&conn)?
                .into_iter()
                .find(|job| {
                    job.state != "cancelled"
                        && job.config.destination_id == job_config.destination_id
                        && job.config.instance_id == job_config.instance_id
                        && job.config.account_id == job_config.account_id
                });
            let job_id = match adopted {
                Some(job) => {
                    if job.config.selection != job_config.selection {
                        return Err(user_error("A delivery generation with a different sharing choice already exists. Cancel it explicitly before reconnecting."));
                    }
                    // Every field of a generation is immutable, not only the
                    // identity: an older mapping version or different limits
                    // would be rejected at dispatch, so refuse them up front.
                    if job.config != job_config {
                        return Err(user_error("A delivery generation with a different mapping version or limits already exists. Cancel it explicitly before reconnecting."));
                    }
                    job.job_id
                }
                None => {
                    // No generation to inherit a baseline from, so the exclusion
                    // table has to be brought in line with this choice first.
                    if sharing_mode == bridge::SharingMode::Selected {
                        agent_relay_probe::delivery::create_session_job(
                            &conn,
                            &job_config,
                            collector::now(),
                        )?
                        .job_id
                    } else {
                        collector::record_baseline(&conn, include_existing)?;
                        agent_relay_probe::delivery::create_job(
                            &conn,
                            &job_config,
                            collector::now(),
                        )?
                        .job_id
                    }
                }
            };
            let config = Config {
                version: CONFIG_VERSION,
                site_url: site,
                account_id: who.user_id,
                account_email: who.email,
                account_name: who.name,
                account_avatar_url: who.avatar_url,
                org_id,
                workspace_id: workspace,
                workspace_name,
                history_url,
                delivery_account: account,
                job_id,
                include_existing,
                sharing_mode: Some(sharing_mode),
                acknowledge_uninspected_schedules: options.acknowledge_uninspected_schedules,
            };
            save_json(&directory.join("config.json"), &config)?;
            config
        }
    };
    drop(conn);
    bridge::enforce_selection(&directory, &config)?;
    if directory.join("signed-out.json").exists() {
        fs::remove_file(directory.join("signed-out.json"))?;
    }
    // Desktop setup becomes ready after capture/credentials; the supervised
    // collector handles delivery and offline retries without blocking login.
    if options.once || !bridge::json_mode() {
        collector::finish_setup(&directory, &config, options.once)?;
    }
    if options.once {
        humanln!("One capture/delivery cycle completed.");
        return Ok(());
    }
    drop(guard);
    if options.foreground {
        collector::run_background(
            &directory,
            &format!("{}-{}", std::process::id(), collector::now()),
        )
    } else {
        collector::start_background(&directory)?;
        if bridge::json_mode() {
            bridge::emit(serde_json::json!({"event":"ready", "running":true}));
        }
        Ok(())
    }
}

/// Runs setup on `directory` as the owner of its collector. A reconnect finds
/// the collector it set up still running, and setup needs the collector lock,
/// so it stops that collector; setup starts this build's collector when it
/// completes. Whatever setup's outcome, the workspace keeps a collector if it
/// had one, except after a foreground run a person ended, and a collector that
/// cannot be restarted is the error reported.
fn with_collector(
    directory: &Path,
    foreground: bool,
    start: &dyn Fn(&Path) -> Result<()>,
    setup: impl FnOnce() -> Result<()>,
) -> Result<()> {
    // A newer build last ran this collector, running or not, and may have
    // upgraded its store past what this build reads.
    if collector::newer_build(directory) {
        return Err(user_error(collector::UPDATE_REQUIRED));
    }
    let took_over = collector::running(directory)?;
    if took_over {
        humanln!("Stopping the running uploader…");
        collector::stop_for_change(directory)?;
    }
    let result = setup();
    let restart = took_over && !(foreground && result.is_ok()) && !collector::running(directory)?;
    // A failed restart leaves the workspace without the collector it had,
    // which outranks the setup failure a retry reports again.
    if restart {
        start(directory)?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    /// A fresh install takes the choice asked for. Signing in again from an
    /// app (`--keep-saved-sharing` with its default, `selected`) reconnects an
    /// install whose owner chose `new` or `all` and keeps that choice; an
    /// explicit different choice on the command line is still refused.
    #[test]
    fn a_reconnect_keeps_the_saved_sharing_choice_when_asked_to() {
        use bridge::SharingMode::{All, New, Selected};
        assert_eq!(
            setup_sharing(None, Some(Selected), true).unwrap(),
            Some(Selected)
        );
        assert_eq!(setup_sharing(None, None, false).unwrap(), None);
        for saved in [New, All, Selected] {
            assert_eq!(
                setup_sharing(Some(saved), Some(Selected), true).unwrap(),
                Some(saved),
                "{saved:?}"
            );
            assert_eq!(
                setup_sharing(Some(saved), None, false).unwrap(),
                Some(saved)
            );
        }
        for saved in [New, All] {
            let error = setup_sharing(Some(saved), Some(Selected), false).unwrap_err();
            assert!(error
                .downcast_ref::<UserError>()
                .unwrap()
                .to_string()
                .contains("saved sharing choice"));
        }
        assert_eq!(
            setup_sharing(Some(New), Some(New), false).unwrap(),
            Some(New)
        );
        let cli = Cli::try_parse_from([
            "probe",
            "cloud",
            "install",
            "--selected-sessions-only",
            "--keep-saved-sharing",
        ])
        .unwrap();
        let Commands::Cloud {
            command: cloud_commands::CloudCommands::Install(options),
        } = cli.command
        else {
            panic!("install expected")
        };
        assert!(options.keep_saved_sharing && options.selected_sessions_only);
    }
    #[test]
    fn rotate_key_flags_parse() {
        let cli = Cli::try_parse_from([
            "probe",
            "cloud",
            "rotate-key",
            "--workspace",
            "a1b2c3d4-0000-4000-8000-000000000000",
            "--grace-ms",
            "0",
        ])
        .unwrap();
        let Commands::Cloud {
            command: cloud_commands::CloudCommands::RotateKey(options),
        } = cli.command
        else {
            panic!("rotate-key expected")
        };
        assert_eq!(options.grace_ms, 0);
        assert_eq!(
            options.workspace.as_deref(),
            Some("a1b2c3d4-0000-4000-8000-000000000000")
        );
        // The default is a continuity grace, not a silent compromise action.
        let cli = Cli::try_parse_from(["probe", "cloud", "rotate-key"]).unwrap();
        let Commands::Cloud {
            command: cloud_commands::CloudCommands::RotateKey(options),
        } = cli.command
        else {
            panic!("rotate-key expected")
        };
        assert_eq!(options.grace_ms, 60_000);
        assert!(options.workspace.is_none());
    }
    #[test]
    fn conflicting_sharing_choices_are_rejected() {
        assert!(Cli::try_parse_from([
            "probe",
            "cloud",
            "install",
            "--include-existing",
            "--new-sessions-only"
        ])
        .is_err());
    }
    #[test]
    fn json_setup_reports_specific_safe_validation_errors() {
        for (extra, expected) in [
            (vec!["--once", "--include-existing"], "background mode"),
            (
                vec!["--foreground", "--selected-sessions-only"],
                "background mode",
            ),
            (vec![], "explicit sharing choice"),
        ] {
            let cli =
                Cli::try_parse_from([vec!["probe", "cloud", "install", "--json"], extra].concat())
                    .unwrap();
            let Commands::Cloud {
                command: cloud_commands::CloudCommands::Install(options),
            } = cli.command
            else {
                panic!("install expected")
            };
            let error = validate_setup_mode(&options, cli.json).unwrap_err();
            assert!(error
                .downcast_ref::<UserError>()
                .unwrap()
                .to_string()
                .contains(expected));
        }
    }

    /// A collector that holds the collector lock until its own stop request
    /// arrives, as a live run does, without running anything.
    fn fake_collector(directory: &Path, version: &str) -> std::thread::JoinHandle<()> {
        let lock = lock(directory).unwrap();
        save_json(
            &directory.join("runtime.json"),
            &serde_json::json!({"startup_id":"live","ready":true,"version":version}),
        )
        .unwrap();
        let directory = directory.to_owned();
        std::thread::spawn(move || {
            while !collector::stop_requested(&directory, "live") {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            drop(lock);
        })
    }

    #[test]
    fn setup_takes_over_a_live_collector_and_restarts_it_when_setup_fails() {
        let directory = tempfile::tempdir().unwrap();
        let collector = fake_collector(directory.path(), agent_relay_probe::VERSION);
        let started = std::cell::Cell::new(0);
        let error = with_collector(
            directory.path(),
            false,
            &|_| {
                started.set(started.get() + 1);
                Ok(())
            },
            || {
                // Setup owns the collector lock once the live run has stopped.
                let _guard = lock(directory.path())?;
                Err(user_error("setup failed"))
            },
        )
        .unwrap_err();
        collector.join().unwrap();
        assert_eq!(error.to_string(), "setup failed");
        assert_eq!(started.get(), 1);
    }

    #[test]
    fn a_collector_that_cannot_be_restarted_is_the_reported_failure() {
        let directory = tempfile::tempdir().unwrap();
        let collector = fake_collector(directory.path(), agent_relay_probe::VERSION);
        let error = with_collector(
            directory.path(),
            false,
            &|_| Err(user_error("restart failed")),
            || Err(user_error("setup failed")),
        )
        .unwrap_err();
        collector.join().unwrap();
        assert_eq!(error.to_string(), "restart failed");
    }

    #[test]
    fn setup_that_starts_its_own_collector_is_not_restarted() {
        let directory = tempfile::tempdir().unwrap();
        let collector = fake_collector(directory.path(), "0.0.1");
        let started = std::cell::Cell::new(0);
        let mut replacement = None;
        with_collector(
            directory.path(),
            false,
            &|_| {
                started.set(started.get() + 1);
                Ok(())
            },
            || {
                replacement = Some(lock(directory.path())?);
                Ok(())
            },
        )
        .unwrap();
        collector.join().unwrap();
        assert_eq!(started.get(), 0);
        assert!(replacement.is_some());
    }

    #[test]
    fn setup_without_a_live_collector_starts_nothing_on_failure() {
        let directory = tempfile::tempdir().unwrap();
        let error = with_collector(
            directory.path(),
            false,
            &|_| panic!("nothing was running"),
            || Err(user_error("setup failed")),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "setup failed");
    }

    #[test]
    fn setup_leaves_a_newer_builds_collector_running() {
        let directory = tempfile::tempdir().unwrap();
        let _held = lock(directory.path()).unwrap();
        save_json(
            &directory.path().join("runtime.json"),
            &serde_json::json!({"startup_id":"live","ready":true,"version":"999999.0.0"}),
        )
        .unwrap();
        let error = with_collector(
            directory.path(),
            false,
            &|_| panic!("the newer collector keeps running"),
            || panic!("an older build does not set up a newer build's install"),
        )
        .unwrap_err();
        assert!(error.to_string().contains("Update Agent Relay"));
        assert!(!directory.path().join("stop.json").exists());
        assert!(collector::running(directory.path()).unwrap());
    }

    #[test]
    fn setup_does_not_start_over_a_stopped_collector_a_newer_build_ran() {
        let directory = tempfile::tempdir().unwrap();
        save_json(
            &directory.path().join("runtime.json"),
            &serde_json::json!({"startup_id":"stopped","ready":true,"version":"999999.0.0"}),
        )
        .unwrap();
        let error = with_collector(
            directory.path(),
            false,
            &|_| panic!("an older build does not start a newer build's install"),
            || panic!("an older build does not set up a newer build's install"),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), collector::UPDATE_REQUIRED);
    }

    #[test]
    fn stop_requests_only_match_their_run_identity() {
        let directory = tempfile::tempdir().unwrap();
        save_json(
            &directory.path().join("stop.json"),
            &serde_json::json!({"startup_id":"previous"}),
        )
        .unwrap();
        assert!(!collector::stop_requested(directory.path(), "current"));
        assert!(collector::stop_requested(directory.path(), "previous"));
    }
    #[test]
    #[cfg(unix)]
    fn replacing_config_keeps_private_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        save_json(&path, &serde_json::json!({"version":1})).unwrap();
        save_json(&path, &serde_json::json!({"version":2})).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(directory.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap()
                ["version"],
            2
        );
    }
}
