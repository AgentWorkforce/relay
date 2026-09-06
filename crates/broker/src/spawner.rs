use std::{collections::HashMap, fs, path::Path, process::Stdio, time::Duration};

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

use crate::relaycast::configure_agent_relay_mcp_with_token;
use anyhow::{Context, Result};
use tokio::{
    process::{Child, Command},
    time::{sleep, timeout},
};

#[cfg(windows)]
pub(crate) const CREATE_SUSPENDED: u32 = 0x0000_0004;

#[cfg(unix)]
use nix::{
    errno::Errno,
    sys::signal::{kill, Signal},
    unistd::Pid,
};

use crate::cli::command_parse::parse_cli_command;
use crate::types::CommitAttestation;

pub(crate) const RELAY_ATTEST_JTI: &str = "RELAY_ATTEST_JTI";
pub(crate) const RELAY_ATTEST_AGENT_ID: &str = "RELAY_ATTEST_AGENT_ID";
pub(crate) const RELAY_ATTEST_SPONSOR_ID: &str = "RELAY_ATTEST_SPONSOR_ID";
/// The ai-hist session UUID for the spawned agent's Claude Code or Codex
/// session. Active worker spawns derive it from the harness session the broker
/// resolves; legacy wrap spawns may receive it through `CommitAttestation`.
/// The hook stamps it as a `Session-Id:` git trailer.
pub(crate) const RELAY_ATTEST_SESSION_ID: &str = "RELAY_ATTEST_SESSION_ID";

/// Windows process-tree ownership. Closing the job handle terminates every
/// descendant, including one that outlives the wrapper or ignores CTRL events.
#[cfg(windows)]
#[derive(Debug)]
pub(crate) struct ProcessTreeOwner(OwnedHandle);

#[cfg(windows)]
impl ProcessTreeOwner {
    /// Immediately terminate every process currently assigned to this job.
    /// This is used for asynchronous writer failures where waiting for the
    /// normal reap path would leave descendants alive in the meantime.
    pub(crate) fn terminate(&self) -> Result<()> {
        use std::ffi::c_void;

        type Handle = *mut c_void;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
        }

        let terminated = unsafe { TerminateJobObject(self.0.as_raw_handle() as Handle, 1) };
        if terminated == 0 {
            return Err(std::io::Error::last_os_error()).context("TerminateJobObject failed");
        }
        Ok(())
    }
}

#[cfg(windows)]
pub(crate) fn attach_process_tree(child: &Child) -> Result<ProcessTreeOwner> {
    use std::{ffi::c_void, mem::size_of, ptr::null};

    type Handle = *mut c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn SetInformationJobObject(
            job: Handle,
            info_class: u32,
            info: *const c_void,
            info_len: u32,
        ) -> i32;
    }

    #[repr(C)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        min_working_set_size: usize,
        max_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }
    #[repr(C)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION and
    // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE from Win32 Job Objects.
    const EXTENDED_LIMIT_INFORMATION: u32 = 9;
    const KILL_ON_JOB_CLOSE: u32 = 0x2000;
    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() {
        return Err(std::io::Error::last_os_error()).context("CreateJobObjectW failed");
    }
    let owner = unsafe { OwnedHandle::from_raw_handle(job.cast()) };
    let limits = ExtendedLimitInformation {
        basic: BasicLimitInformation {
            per_process_user_time_limit: 0,
            per_job_user_time_limit: 0,
            limit_flags: KILL_ON_JOB_CLOSE,
            min_working_set_size: 0,
            max_working_set_size: 0,
            active_process_limit: 0,
            affinity: 0,
            priority_class: 0,
            scheduling_class: 0,
        },
        io: IoCounters {
            read_operation_count: 0,
            write_operation_count: 0,
            other_operation_count: 0,
            read_transfer_count: 0,
            write_transfer_count: 0,
            other_transfer_count: 0,
        },
        process_memory_limit: 0,
        job_memory_limit: 0,
        peak_process_memory_used: 0,
        peak_job_memory_used: 0,
    };
    let configured = unsafe {
        SetInformationJobObject(
            owner.as_raw_handle() as Handle,
            EXTENDED_LIMIT_INFORMATION,
            (&limits as *const ExtendedLimitInformation).cast(),
            size_of::<ExtendedLimitInformation>() as u32,
        )
    };
    if configured == 0 {
        return Err(std::io::Error::last_os_error())
            .context("SetInformationJobObject(KILL_ON_JOB_CLOSE) failed");
    }
    let process = child
        .raw_handle()
        .ok_or_else(|| anyhow::anyhow!("spawned child has no process handle"))?;
    let assigned =
        unsafe { AssignProcessToJobObject(owner.as_raw_handle() as Handle, process as Handle) };
    if assigned == 0 {
        return Err(std::io::Error::last_os_error()).context("AssignProcessToJobObject failed");
    }
    Ok(ProcessTreeOwner(owner))
}

#[cfg(windows)]
pub(crate) fn resume_process(child: &Child) -> Result<()> {
    use std::ffi::c_void;

    type Handle = *mut c_void;
    #[link(name = "ntdll")]
    unsafe extern "system" {
        // NtResumeProcess resumes the primary process thread created with
        // CREATE_SUSPENDED. The Job Object is assigned before this call, so a
        // wrapper cannot create an unowned descendant during attachment.
        fn NtResumeProcess(process: Handle) -> i32;
    }

    let process = child
        .raw_handle()
        .ok_or_else(|| anyhow::anyhow!("spawned child has no process handle"))?;
    let status = unsafe { NtResumeProcess(process as Handle) };
    if status != 0 {
        return Err(anyhow::anyhow!(
            "NtResumeProcess failed with status 0x{status:08x}"
        ));
    }
    Ok(())
}
const RELAY_ATTEST_GIT_CONFIG_COUNT: &str = "RELAY_ATTEST_GIT_CONFIG_COUNT";
const RELAY_ATTEST_GIT_CONFIG_INDEX: &str = "RELAY_ATTEST_GIT_CONFIG_INDEX";
const RELAY_ATTEST_BROKER_HOOK_PATH: &str = "RELAY_ATTEST_BROKER_HOOK_PATH";

/// Standard client-side git hooks (see githooks(5)). `core.hooksPath` is a
/// single directory that replaces git's entire hook lookup, not just
/// `prepare-commit-msg` — so the broker must install a forwarder under every
/// name a repository might use, or an installed `pre-commit`/`commit-msg`/etc.
/// hook silently stops firing for every attested spawn.
const GIT_HOOK_NAMES: &[&str] = &[
    "applypatch-msg",
    "pre-applypatch",
    "post-applypatch",
    "pre-commit",
    "pre-merge-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "pre-rebase",
    "post-checkout",
    "post-merge",
    "pre-push",
    "pre-auto-gc",
    "post-rewrite",
    "post-index-change",
    "sendemail-validate",
    "p4-changelist",
    "p4-prepare-changelist",
    "p4-post-changelist",
    "p4-pre-submit",
];

const BROKER_GIT_HOOK: &str = r#"#!/bin/sh
# Installed by the broker through core.hooksPath. One copy of this script is
# installed under every standard hook name so core.hooksPath replacing git's
# hook lookup doesn't silently drop hooks besides prepare-commit-msg; it
# forwards to the repository's own same-named hook after acting.

hook_name="$(basename "$0")"

if [ "$hook_name" = "prepare-commit-msg" ]; then
  message_file="$1"
  if { [ -n "$RELAY_ATTEST_AGENT_ID" ] && [ -n "$RELAY_ATTEST_SPONSOR_ID" ] && [ -n "$RELAY_ATTEST_JTI" ]; } || \
     [ -n "$RELAY_ATTEST_SESSION_ID" ]; then
    printf '\n' >> "$message_file"
    if [ -n "$RELAY_ATTEST_AGENT_ID" ] && [ -n "$RELAY_ATTEST_SPONSOR_ID" ] && [ -n "$RELAY_ATTEST_JTI" ]; then
      printf 'Agent-Id: %s\nSponsor-Id: %s\nRelay-Attestation: %s\n' \
        "$RELAY_ATTEST_AGENT_ID" \
        "$RELAY_ATTEST_SPONSOR_ID" \
        "$RELAY_ATTEST_JTI" >> "$message_file"
    fi
    if [ -n "$RELAY_ATTEST_SESSION_ID" ]; then
      printf 'Session-Id: %s\n' "$RELAY_ATTEST_SESSION_ID" >> "$message_file"
    fi
  fi
fi

# Resolve hooks with the broker's temporary core.hooksPath setting removed.
# This retains both an inherited GIT_CONFIG_* hooks path and a repository's
# configured/default hooks directory, then chains to the same-named hook
# there if one exists.
original_count="${RELAY_ATTEST_GIT_CONFIG_COUNT:-0}"
broker_index="${RELAY_ATTEST_GIT_CONFIG_INDEX:-}"
case "$original_count" in
  ''|*[!0-9]*) exit 0 ;;
esac
export GIT_CONFIG_COUNT="$original_count"
if [ -n "$broker_index" ]; then
  unset "GIT_CONFIG_KEY_$broker_index" "GIT_CONFIG_VALUE_$broker_index"
fi
configured_hooks_path="$(git config --get core.hooksPath 2>/dev/null || true)"
if [ -n "$configured_hooks_path" ]; then
  case "$configured_hooks_path" in
    /*) existing_hooks_dir="$configured_hooks_path" ;;
    "~/"*) existing_hooks_dir="$HOME${configured_hooks_path#\~}" ;;
    *) repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
       existing_hooks_dir="$repo_root/$configured_hooks_path" ;;
  esac
else
  git_common_dir="$(git rev-parse --git-common-dir 2>/dev/null)" || exit 0
  existing_hooks_dir="$git_common_dir/hooks"
fi
if [ -n "$RELAY_ATTEST_BROKER_HOOK_PATH" ] && [ "$existing_hooks_dir" = "$RELAY_ATTEST_BROKER_HOOK_PATH" ]; then
  exit 0
fi
repo_hook="$existing_hooks_dir/$hook_name"
# Guard against self-exec even if RELAY_ATTEST_BROKER_HOOK_PATH is unset or
# stale (e.g. core.hooksPath was persisted into the repository's own config
# by a prior spawn instead of only supplied through env): comparing against
# $0 — this script's own invoked path — is authoritative and needs no
# externally supplied value, so a misconfigured guard can never turn into an
# infinite self-exec. Use -ef (same file, by device+inode) rather than a
# string compare so a relative/symlinked alias of the broker's own directory
# still resolves to "same file" instead of exec'ing (and double-stamping) it.
if [ -x "$repo_hook" ] && ! [ "$repo_hook" -ef "$0" ]; then
  exec "$repo_hook" "$@"
fi
"#;

/// Add the public commit-attribution environment supplied by a dispatcher.
///
/// No metadata, or incomplete metadata, leaves the spawn environment exactly
/// as it was. Spawn paths add the hook after creating their private hooks
/// directory.
pub fn with_commit_attestation_env(
    mut env_vars: Vec<(String, String)>,
    attestation: Option<&CommitAttestation>,
) -> Vec<(String, String)> {
    let Some(attestation) = attestation else {
        return env_vars;
    };

    if !is_valid_attestation_value(&attestation.jti)
        || !is_valid_attestation_value(&attestation.agent_id)
        || !is_valid_attestation_value(&attestation.sponsor_id)
    {
        return env_vars;
    }

    env_vars.extend([
        (RELAY_ATTEST_JTI.to_string(), attestation.jti.clone()),
        (
            RELAY_ATTEST_AGENT_ID.to_string(),
            attestation.agent_id.clone(),
        ),
        (
            RELAY_ATTEST_SPONSOR_ID.to_string(),
            attestation.sponsor_id.clone(),
        ),
    ]);

    // Always strip any pre-existing RELAY_ATTEST_SESSION_ID before deciding
    // whether to set it. Without this, a child spawned without session_ref
    // would inherit an ancestor's session variable and stamp commits with the
    // wrong session — corrupting the audit chain. The strip is safe even when
    // no prior value is present (retain is a no-op then).
    env_vars.retain(|(k, _)| k != RELAY_ATTEST_SESSION_ID);

    // Re-inject session provenance when the dispatcher has a stable session
    // reference for the child agent. Invalid values (empty / control chars)
    // are silently skipped — the session reference is advisory for auditors
    // and its absence never blocks a commit.
    if let Some(session_ref) = attestation.session_ref.as_deref() {
        if is_valid_attestation_value(session_ref) {
            env_vars.push((RELAY_ATTEST_SESSION_ID.to_string(), session_ref.to_string()));
        }
    }

    env_vars
}

pub(crate) fn attestation_env_present(env_vars: &[(String, String)]) -> bool {
    [
        RELAY_ATTEST_JTI,
        RELAY_ATTEST_AGENT_ID,
        RELAY_ATTEST_SPONSOR_ID,
    ]
    .iter()
    .all(|expected| {
        env_vars
            .iter()
            .rev()
            .find(|(key, _)| key == expected)
            .is_some_and(|(_, value)| is_valid_attestation_value(value))
    })
}

pub(crate) fn is_valid_attestation_value(value: &str) -> bool {
    !value.trim().is_empty() && !value.chars().any(|character| character.is_control())
}

/// Install the broker's forwarding hook under every name in [`GIT_HOOK_NAMES`]
/// so pointing `core.hooksPath` at `hooks_dir` doesn't drop any hook type the
/// target repository relies on.
pub(crate) fn write_broker_git_hooks(hooks_dir: &Path) -> Result<()> {
    fs::create_dir_all(hooks_dir).context("creating broker git hooks directory")?;
    for name in GIT_HOOK_NAMES {
        let hook_path = hooks_dir.join(name);
        fs::write(&hook_path, BROKER_GIT_HOOK)
            .with_context(|| format!("writing broker {name} hook"))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = fs::metadata(&hook_path)
                .with_context(|| format!("reading broker {name} hook permissions"))?
                .permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(&hook_path, permissions)
                .with_context(|| format!("making broker {name} hook executable"))?;
        }
    }

    Ok(())
}

/// Lazily create (or reuse) a broker git-hooks directory cached in `slot`.
/// Shared by `Spawner` and `WorkerRegistry`, which differ only in which
/// struct owns the cached `TempDir` handle.
pub(crate) fn resolve_commit_hooks_dir(slot: &mut Option<tempfile::TempDir>) -> Result<&Path> {
    if slot.is_none() {
        let hooks_dir = tempfile::Builder::new()
            .prefix("agent-relay-git-hooks-")
            .tempdir()
            .context("creating broker git hooks directory")?;
        write_broker_git_hooks(hooks_dir.path())?;
        *slot = Some(hooks_dir);
    }

    Ok(slot
        .as_ref()
        .expect("commit hooks directory is initialized")
        .path())
}

fn git_config_count(env_vars: &[(String, String)]) -> usize {
    let inherited_count = std::env::var("GIT_CONFIG_COUNT").ok();
    git_config_count_with_inherited(env_vars, inherited_count.as_deref())
}

fn git_config_count_with_inherited(
    env_vars: &[(String, String)],
    inherited_count: Option<&str>,
) -> usize {
    let inherited_count = inherited_count.and_then(|value| value.parse().ok());
    if let Some((_, value)) = env_vars
        .iter()
        .rev()
        .find(|(key, _)| key == "GIT_CONFIG_COUNT")
    {
        return value.parse().ok().or(inherited_count).unwrap_or(0);
    }

    inherited_count.unwrap_or(0)
}

pub(crate) fn add_broker_hooks_path(env_vars: &mut Vec<(String, String)>, hooks_dir: &Path) {
    let count = git_config_count(env_vars);
    env_vars.push((RELAY_ATTEST_GIT_CONFIG_COUNT.to_string(), count.to_string()));
    env_vars.push((RELAY_ATTEST_GIT_CONFIG_INDEX.to_string(), count.to_string()));
    env_vars.push((
        RELAY_ATTEST_BROKER_HOOK_PATH.to_string(),
        hooks_dir.to_string_lossy().into_owned(),
    ));
    env_vars.push(("GIT_CONFIG_COUNT".to_string(), (count + 1).to_string()));
    env_vars.push((
        format!("GIT_CONFIG_KEY_{count}"),
        "core.hooksPath".to_string(),
    ));
    env_vars.push((
        format!("GIT_CONFIG_VALUE_{count}"),
        hooks_dir.to_string_lossy().into_owned(),
    ));
}

#[derive(Debug)]
struct ManagedChild {
    parent: Option<String>,
    child: Child,
    #[cfg(windows)]
    process_tree: ProcessTreeOwner,
}

#[derive(Debug, Default)]
pub struct Spawner {
    children: HashMap<String, ManagedChild>,
    commit_hooks_dir: Option<tempfile::TempDir>,
}

impl Spawner {
    pub fn new() -> Self {
        Self {
            children: HashMap::new(),
            commit_hooks_dir: None,
        }
    }

    fn commit_hooks_dir(&mut self) -> Result<&Path> {
        resolve_commit_hooks_dir(&mut self.commit_hooks_dir)
    }

    pub async fn spawn_wrap_with_token(
        &mut self,
        child_name: &str,
        cli: &str,
        extra_args: &[String],
        env_vars: &[(String, String)],
        parent: Option<&str>,
        agent_token: Option<&str>,
    ) -> Result<u32> {
        if self.children.contains_key(child_name) {
            anyhow::bail!("child {child_name} already exists");
        }

        let exe = std::env::current_exe().unwrap_or_else(|_| "agent-relay-broker".into());
        let mut cmd = Command::new(exe);
        let (resolved_cli, inline_cli_args) =
            parse_cli_command(cli).with_context(|| format!("invalid CLI command '{cli}'"))?;
        let mut combined_args = inline_cli_args;
        combined_args.extend(extra_args.to_vec());

        // Wrap mode: `agent-relay-broker wrap <cli> <args...>`
        cmd.arg("wrap").arg(&resolved_cli);

        // Inject MCP config for CLIs that support dynamic MCP configuration.
        // Pass the original CLI name (not resolved_cli) so CLI-specific config
        // logic is triggered correctly (e.g. "cursor" → cursor-specific MCP path).
        // resolved_cli may differ (parse_cli_command maps "cursor" → "agent").
        let api_key = env_vars
            .iter()
            .find(|(k, _)| k == "RELAY_API_KEY")
            .map(|(_, v)| v.as_str());
        let base_url = env_vars
            .iter()
            .find(|(k, _)| k == "RELAY_BASE_URL")
            .map(|(_, v)| v.as_str());
        let workspaces_json = env_vars
            .iter()
            .find(|(k, _)| k == "RELAY_WORKSPACES_JSON")
            .map(|(_, v)| v.as_str());
        let default_workspace = env_vars
            .iter()
            .find(|(k, _)| k == "RELAY_DEFAULT_WORKSPACE")
            .map(|(_, v)| v.as_str());
        let cwd = std::env::current_dir().unwrap_or_default();
        let mcp_args = configure_agent_relay_mcp_with_token(
            cli,
            child_name,
            api_key,
            base_url,
            &combined_args,
            &cwd,
            agent_token,
            workspaces_json,
            default_workspace,
        )
        .await?;
        for arg in &mcp_args {
            cmd.arg(arg);
        }

        for arg in &combined_args {
            cmd.arg(arg);
        }

        cmd.stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());

        let mut child_env = env_vars.to_vec();
        if attestation_env_present(&child_env) {
            match self.commit_hooks_dir() {
                Ok(hooks_dir) => add_broker_hooks_path(&mut child_env, hooks_dir),
                Err(error) => {
                    tracing::warn!(
                        target = "broker::spawn",
                        worker = %child_name,
                        error = %error,
                        "git attribution hook could not be installed; spawning without commit trailers"
                    );
                }
            }
        }
        for (key, value) in &child_env {
            cmd.env(key, value);
        }
        // Inject pre-registered agent token when available so the MCP server
        // starts already authenticated (same as main.rs WorkerRegistry::spawn).
        if let Some(token) = agent_token {
            cmd.env("RELAY_AGENT_TOKEN", token);
        }
        // Disable Claude Code auto-suggestions to prevent accidental acceptance
        // when relay messages are injected into the PTY.
        cmd.env("CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION", "false");
        // Disable Claude Code auto-updater — it fails in sandboxes and can crash the process.
        cmd.env("DISABLE_AUTOUPDATER", "1");

        #[cfg(unix)]
        unsafe {
            cmd.pre_exec(|| {
                if nix::libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }

        #[cfg(windows)]
        cmd.creation_flags(CREATE_SUSPENDED);

        let child = cmd.spawn().context("failed to spawn wrap-mode child")?;
        let pid = child.id().context("spawned child missing pid")?;
        #[cfg(windows)]
        let process_tree = match attach_process_tree(&child) {
            Ok(owner) => owner,
            Err(error) => {
                let mut child = child;
                cleanup_attach_failure(&mut child).await;
                return Err(error).context("failed to establish wrap process-tree ownership");
            }
        };
        #[cfg(windows)]
        if let Err(error) = resume_process(&child) {
            let _ = process_tree.terminate();
            let mut child = child;
            let _ = child.start_kill();
            let _ = timeout(Duration::from_secs(1), child.wait()).await;
            return Err(error).context("failed to resume wrap-mode child");
        }

        self.children.insert(
            child_name.to_string(),
            ManagedChild {
                parent: parent.map(ToOwned::to_owned),
                #[cfg(windows)]
                process_tree,
                child,
            },
        );
        Ok(pid)
    }

    pub fn owner_of(&self, child_name: &str) -> Option<&str> {
        self.children
            .get(child_name)
            .and_then(|managed| managed.parent.as_deref())
    }

    pub async fn release(&mut self, name: &str, timeout_duration: Duration) -> Result<()> {
        let mut managed = self
            .children
            .remove(name)
            .with_context(|| format!("unknown child {name}"))?;

        terminate_child(&mut managed.child, timeout_duration).await
    }

    pub async fn reap_exited(&mut self) -> Result<Vec<String>> {
        let names: Vec<String> = self.children.keys().cloned().collect();
        let mut exited = Vec::new();

        for name in names {
            let remove = if let Some(child) = self.children.get_mut(&name) {
                child.child.try_wait()?.is_some()
            } else {
                false
            };
            if remove {
                self.children.remove(&name);
                exited.push(name);
            }
        }

        Ok(exited)
    }

    pub async fn shutdown_all(&mut self, timeout_duration: Duration) {
        let names: Vec<String> = self.children.keys().cloned().collect();
        for name in names {
            if let Err(error) = self.release(&name, timeout_duration).await {
                tracing::warn!(target = "relay_broker::spawner", child = %name, error = %error, "failed releasing child during shutdown");
            }
        }
    }
}

pub async fn terminate_child(child: &mut Child, timeout_duration: Duration) -> Result<()> {
    let pid = child.id();
    #[cfg(unix)]
    {
        if let Some(pid) = pid {
            // Worker wrappers are session leaders (see WorkerRegistry::spawn),
            // so signal the whole process group. The direct signal is retained
            // only for the initial graceful request to legacy children; all
            // post-wait liveness and force-kill decisions use the group identity
            // or the still-owned Child handle, never a reusable raw PID.
            signal_process_group(pid, Signal::SIGTERM);
        }
    }

    // Do not let a fast-exiting wrapper shorten the descendant grace period.
    // Its PID can be reaped while a child remains in the private group, so the
    // group probe below is independent of the wrapper's wait result.
    let deadline = tokio::time::Instant::now() + timeout_duration;
    let _ = timeout(timeout_duration, child.wait()).await;
    while tokio::time::Instant::now() < deadline {
        #[cfg(unix)]
        if match pid {
            Some(pid) => !process_group_alive(pid),
            None => true,
        } {
            break;
        }
        #[cfg(windows)]
        if child.try_wait()?.is_some() {
            // A Job Object retained by the owning worker handle will tear down
            // descendants when it is dropped; do not spend the remaining grace
            // interval sleeping after the wrapper has already exited.
            break;
        }

        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        sleep(remaining.min(Duration::from_millis(50))).await;
    }

    #[cfg(unix)]
    if let Some(pid) = pid {
        if process_group_alive(pid) {
            // The worker owns this process group (setsid), so the negative PID
            // remains the safe identity even after the wrapper has exited.
            let _ = kill(Pid::from_raw(-(pid as i32)), Signal::SIGKILL);
        } else if child.try_wait()?.is_none() {
            // Legacy non-session workers have no safe descendant identity. If
            // the wrapper itself is still owned and live, use Child's handle;
            // never send a later signal to a bare PID that could be reused.
            child
                .start_kill()
                .context("failed to kill legacy worker wrapper")?;
        }
    }

    #[cfg(windows)]
    if let Some(pid) = pid {
        // The attached Job Object is the ownership boundary for descendants.
        // Only use taskkill while Child still proves that this PID is live;
        // after wait resolves, the raw PID may have been reused. In that case
        // dropping ProcessTreeOwner below terminates the complete tree.
        if child.try_wait()?.is_none() {
            if !terminate_process_tree(pid).await {
                child
                    .start_kill()
                    .context("failed to kill worker wrapper after taskkill failure")?;
            }
        }
    }

    // Reaping must be bounded too: an uninterruptible wrapper must not stall
    // the broker's runtime loop forever after the grace deadline.
    let reap_timeout = timeout_duration.min(Duration::from_secs(2));
    match timeout(reap_timeout, child.wait()).await {
        Ok(result) => {
            result.context("failed waiting for terminated worker")?;
        }
        Err(_) => anyhow::bail!(
            "worker process did not exit within {} ms after termination",
            reap_timeout.as_millis()
        ),
    }

    Ok(())
}

/// Request immediate teardown after an owned worker control channel fails.
///
/// This is intentionally synchronous: writer failures are delivered on the
/// broker's event loop, so waiting for a grace interval there would pause all
/// API and Relaycast work. The normal reap sweep still owns the Child and
/// collects its exit status; this function only initiates the ownership-safe
/// termination request.
pub(crate) fn request_child_termination(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        signal_process_group(pid, Signal::SIGTERM);
        signal_process_group(pid, Signal::SIGKILL);
    }

    #[cfg(windows)]
    {
        let _ = child.start_kill();
    }
}

#[cfg(windows)]
pub(crate) async fn terminate_process_tree(pid: u32) -> bool {
    let taskkill = std::env::var_os("SystemRoot")
        .map(|root| {
            std::path::PathBuf::from(root)
                .join("System32")
                .join("taskkill.exe")
        })
        .unwrap_or_else(|| std::path::PathBuf::from("taskkill.exe"));
    matches!(
        timeout(
        Duration::from_secs(1),
        tokio::process::Command::new(taskkill)
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            // If the one-second bound fires, terminate taskkill itself before
            // its PID-only command can outlive this ownership decision.
            .kill_on_drop(true)
            .status(),
        )
        .await,
        Ok(Ok(status)) if status.success()
    )
}

#[cfg(windows)]
pub(crate) async fn cleanup_attach_failure(child: &mut Child) {
    // Assignment can fail after the wrapper has started its own children. Use
    // the OS tree operation only while Child proves that the wrapper is still
    // live; after wait resolves, a raw PID may have been reused. Child's
    // process handle remains safe for the wrapper itself in either case.
    let wrapper_live = child
        .try_wait()
        .map(|status| status.is_none())
        .unwrap_or(false);
    if wrapper_live {
        if let Some(pid) = child.id() {
            if !terminate_process_tree(pid).await {
                let _ = child.start_kill();
            }
        } else {
            let _ = child.start_kill();
        }
    } else {
        let _ = child.start_kill();
    }
    let _ = timeout(Duration::from_secs(1), child.wait()).await;
}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: Signal) {
    // A negative PID addresses the process group whose id is `pid`. It is a
    // no-op error for legacy children that are not group leaders; the direct
    // signal below is only the initial graceful legacy fallback.
    let _ = kill(Pid::from_raw(-(pid as i32)), signal);
    let _ = kill(Pid::from_raw(pid as i32), signal);
}

#[cfg(unix)]
fn process_group_alive(pid: u32) -> bool {
    // A negative PID addresses the private worker group. Do not probe the raw
    // wrapper PID here: after child.wait() it can be reused for an unrelated
    // process, while the group identity remains tied to this worker session.
    match kill(Pid::from_raw(-(pid as i32)), None) {
        Ok(()) | Err(Errno::EPERM) => true,
        Err(Errno::ESRCH) => false,
        Err(_) => true,
    }
}

pub fn spawn_env_vars(
    name: &str,
    api_key: &str,
    base_url: Option<&str>,
    channels: &str,
    workspaces_json: Option<&str>,
    default_workspace: Option<&str>,
    harness: Option<&str>,
) -> Vec<(String, String)> {
    let mut env = vec![
        ("RELAY_AGENT_NAME".to_string(), name.to_string()),
        ("AGENT_RELAY_WORKSPACE_KEY".to_string(), api_key.to_string()),
        ("RELAY_WORKSPACE_KEY".to_string(), api_key.to_string()),
        ("RELAY_API_KEY".to_string(), api_key.to_string()),
        ("RELAY_CHANNELS".to_string(), channels.to_string()),
        ("RELAY_STRICT_AGENT_NAME".to_string(), "1".to_string()),
    ];
    // Pass RELAY_BASE_URL to the child only when an override is configured; when
    // unset, the child inherits the SDK default.
    if let Some(base_url) = base_url.map(str::trim).filter(|value| !value.is_empty()) {
        env.push(("RELAY_BASE_URL".to_string(), base_url.to_string()));
    }
    // Per-worker attribution: tell the spawned agent's JS SDK its origin_actor
    // path (`agent-relay-cli/agent/<harness>`) via env, so its relaycast
    // telemetry is attributed to the harness it runs rather than "unknown".
    // See cloud/plans/origin-actor.md.
    if let Some(harness) = harness {
        env.push((
            "AGENT_RELAY_ORIGIN_ACTOR".to_string(),
            crate::telemetry::agent_origin_actor(harness, None),
        ));
    }
    if let Some(workspaces_json) = workspaces_json
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        env.push((
            "RELAY_WORKSPACES_JSON".to_string(),
            workspaces_json.to_string(),
        ));
    }
    if let Some(default_workspace) = default_workspace
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        // `default_workspace` is the relaycast workspace id; do NOT stamp it
        // as RELAYFILE_WORKSPACE. Relaycast and relayfile workspace ids are
        // independent — callers set RELAYFILE_WORKSPACE explicitly through
        // their own spawn env when they want spawned agents to talk to a
        // specific relayfile workspace.
        env.push((
            "RELAY_DEFAULT_WORKSPACE".to_string(),
            default_workspace.to_string(),
        ));
        env.push((
            "RELAY_WORKSPACE_ID".to_string(),
            default_workspace.to_string(),
        ));
    }
    env
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, process::Command as StdCommand, time::Duration};

    #[cfg(unix)]
    use nix::{
        errno::Errno,
        sys::signal::kill,
        unistd::{getsid, Pid},
    };
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use tempfile::{tempdir, TempDir};
    use tokio::process::Command;

    use crate::types::CommitAttestation;

    use super::{
        add_broker_hooks_path, attestation_env_present, git_config_count_with_inherited,
        spawn_env_vars, terminate_child, with_commit_attestation_env, write_broker_git_hooks,
        Spawner, RELAY_ATTEST_AGENT_ID, RELAY_ATTEST_JTI, RELAY_ATTEST_SESSION_ID,
        RELAY_ATTEST_SPONSOR_ID,
    };

    fn git(repo: &Path, args: &[&str], env: &[(String, String)]) -> std::process::Output {
        StdCommand::new("git")
            .current_dir(repo)
            .args(args)
            .envs(env.iter().map(|(key, value)| (key, value)))
            .output()
            .expect("git should run")
    }

    fn fixture_repository() -> TempDir {
        let repo = tempdir().expect("fixture repository directory");
        assert!(git(repo.path(), &["init", "--quiet"], &[]).status.success());
        assert!(
            git(repo.path(), &["config", "user.name", "Relay Test"], &[])
                .status
                .success()
        );
        assert!(git(
            repo.path(),
            &["config", "user.email", "relay@example.test"],
            &[]
        )
        .status
        .success());
        fs::write(repo.path().join("worker.txt"), "fixture\n").expect("write fixture file");
        assert!(git(repo.path(), &["add", "worker.txt"], &[])
            .status
            .success());
        repo
    }

    fn commit_message(repo: &Path) -> String {
        let output = git(repo, &["log", "-1", "--format=%B"], &[]);
        assert!(output.status.success());
        String::from_utf8(output.stdout).expect("UTF-8 commit message")
    }

    fn attestation() -> CommitAttestation {
        CommitAttestation {
            jti: "jti-public-123".to_string(),
            agent_id: "agent_worker_42".to_string(),
            sponsor_id: "user_owner_7".to_string(),
            session_ref: None,
        }
    }

    fn attestation_with_session(session: &str) -> CommitAttestation {
        CommitAttestation {
            jti: "jti-public-123".to_string(),
            agent_id: "agent_worker_42".to_string(),
            sponsor_id: "user_owner_7".to_string(),
            session_ref: Some(session.to_string()),
        }
    }

    fn broker_hook_env(attestation: &CommitAttestation, hooks_dir: &Path) -> Vec<(String, String)> {
        let mut env = with_commit_attestation_env(Vec::new(), Some(attestation));
        add_broker_hooks_path(&mut env, hooks_dir);
        env
    }

    #[test]
    fn spawn_env_vars_sets_origin_actor_path_when_harness_present() {
        let env = spawn_env_vars(
            "a",
            "rk_live_x",
            Some("https://gw"),
            "#c",
            None,
            None,
            Some("codex"),
        );
        let origin_actor = env
            .iter()
            .find(|(k, _)| k == "AGENT_RELAY_ORIGIN_ACTOR")
            .map(|(_, v)| v.as_str());
        assert_eq!(origin_actor, Some("agent-relay-cli/agent/codex"));
    }

    #[test]
    fn spawn_env_vars_omits_origin_actor_when_absent() {
        let env = spawn_env_vars("a", "rk_live_x", Some("https://gw"), "#c", None, None, None);
        assert!(env.iter().all(|(k, _)| k != "AGENT_RELAY_ORIGIN_ACTOR"));
    }

    #[test]
    fn absent_attestation_metadata_is_a_complete_no_op() {
        let original = vec![("RELAY_AGENT_NAME".to_string(), "worker".to_string())];
        assert_eq!(
            with_commit_attestation_env(original.clone(), None),
            original
        );

        let repo = fixture_repository();
        let commit = git(repo.path(), &["commit", "-m", "no attestation"], &[]);
        assert!(
            commit.status.success(),
            "git commit must succeed without hook setup"
        );
        let message = commit_message(repo.path());
        assert!(!message.contains("Agent-Id:"));
        assert!(!message.contains("Sponsor-Id:"));
        assert!(!message.contains("Relay-Attestation:"));
    }

    #[test]
    fn broker_hook_appends_all_attestation_trailers_verbatim() {
        let repo = fixture_repository();
        let hooks_dir = tempdir().expect("broker hooks directory");
        write_broker_git_hooks(hooks_dir.path()).expect("write broker hook");
        let values = attestation();
        let env = broker_hook_env(&values, hooks_dir.path());

        let commit = git(repo.path(), &["commit", "-m", "with attestation"], &env);
        assert!(
            commit.status.success(),
            "git commit must succeed with broker hook"
        );
        let message = commit_message(repo.path());
        assert!(message.contains("Agent-Id: agent_worker_42"));
        assert!(message.contains("Sponsor-Id: user_owner_7"));
        assert!(message.contains("Relay-Attestation: jti-public-123"));
        // No session_ref in plain attestation — Session-Id trailer must be absent.
        assert!(!message.contains("Session-Id:"));
    }

    #[test]
    fn broker_hook_appends_session_id_trailer_when_session_ref_present() {
        let repo = fixture_repository();
        let hooks_dir = tempdir().expect("broker hooks directory");
        write_broker_git_hooks(hooks_dir.path()).expect("write broker hook");
        let session = "ai-hist:claudecode-abc123";
        let attest = attestation_with_session(session);
        let env = broker_hook_env(&attest, hooks_dir.path());

        let commit = git(repo.path(), &["commit", "-m", "with session"], &env);
        assert!(
            commit.status.success(),
            "git commit must succeed with session_ref in broker hook"
        );
        let message = commit_message(repo.path());
        assert!(message.contains("Relay-Attestation: jti-public-123"));
        assert!(message.contains(&format!("Session-Id: {session}")));
    }

    #[test]
    fn broker_hook_appends_session_id_without_ledger_attestation() {
        let repo = fixture_repository();
        let hooks_dir = tempdir().expect("broker hooks directory");
        write_broker_git_hooks(hooks_dir.path()).expect("write broker hook");
        let session = "session-http-spawn-1528";
        let mut env = vec![(RELAY_ATTEST_SESSION_ID.to_string(), session.to_string())];
        add_broker_hooks_path(&mut env, hooks_dir.path());

        let commit = git(repo.path(), &["commit", "-m", "session only"], &env);
        assert!(
            commit.status.success(),
            "git commit must succeed with session-only broker hook"
        );
        let message = commit_message(repo.path());
        assert!(message.contains(&format!("Session-Id: {session}")));
        assert!(!message.contains("Agent-Id:"));
        assert!(!message.contains("Sponsor-Id:"));
        assert!(!message.contains("Relay-Attestation:"));
    }

    #[test]
    #[cfg(unix)]
    fn broker_hook_chain_execs_the_repository_prepare_commit_msg_hook() {
        let repo = fixture_repository();
        let repository_hook = repo.path().join(".git/hooks/prepare-commit-msg");
        fs::write(
            &repository_hook,
            "#!/bin/sh\nprintf '\\nRepository-Hook: preserved\\n' >> \"$1\"\n",
        )
        .expect("write repository hook");
        let mut permissions = fs::metadata(&repository_hook)
            .expect("repository hook metadata")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&repository_hook, permissions)
            .expect("make repository hook executable");

        let hooks_dir = tempdir().expect("broker hooks directory");
        write_broker_git_hooks(hooks_dir.path()).expect("write broker hook");
        let env = broker_hook_env(&attestation(), hooks_dir.path());
        let commit = git(repo.path(), &["commit", "-m", "preserve local hook"], &env);
        assert!(
            commit.status.success(),
            "git commit must succeed with both hooks"
        );

        let message = commit_message(repo.path());
        assert!(message.contains("Agent-Id: agent_worker_42"));
        assert!(message.contains("Sponsor-Id: user_owner_7"));
        assert!(message.contains("Relay-Attestation: jti-public-123"));
        assert!(
            message.contains("Repository-Hook: preserved"),
            "commit message: {message}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn broker_hook_chain_execs_the_repositorys_pre_commit_hook() {
        // Regression test: core.hooksPath replaces git's entire hook lookup,
        // not just prepare-commit-msg. Before installing forwarders for every
        // hook name, pointing core.hooksPath at the broker's directory made
        // git stop seeing a repository's pre-commit hook entirely, silently
        // granting every attested spawn the same bypass `git commit -n` gives.
        let repo = fixture_repository();
        let repository_hook = repo.path().join(".git/hooks/pre-commit");
        fs::write(
            &repository_hook,
            "#!/bin/sh\nprintf 'pre-commit rejected\\n' >&2\nexit 1\n",
        )
        .expect("write repository pre-commit hook");
        let mut permissions = fs::metadata(&repository_hook)
            .expect("repository pre-commit hook metadata")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&repository_hook, permissions)
            .expect("make repository pre-commit hook executable");

        let hooks_dir = tempdir().expect("broker hooks directory");
        write_broker_git_hooks(hooks_dir.path()).expect("write broker hooks");
        let env = broker_hook_env(&attestation(), hooks_dir.path());
        let commit = git(repo.path(), &["commit", "-m", "should be rejected"], &env);
        assert!(
            !commit.status.success(),
            "the repository's pre-commit hook must still reject the commit while the broker's \
             core.hooksPath is active for attestation"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn broker_hook_never_self_execs_when_hookspath_resolves_to_its_own_directory() {
        // Regression test for a self-recursion hang: if core.hooksPath ever
        // resolves back to the broker's own hooks directory while
        // RELAY_ATTEST_BROKER_HOOK_PATH is absent (e.g. a prior run persisted
        // hooksPath into the repository's real .git/config instead of only
        // supplying it via the ephemeral GIT_CONFIG_* env override), the
        // forwarder must not exec itself — that recurses forever. Bounded by
        // a timeout so a regression fails this test instead of hanging CI.
        let repo = fixture_repository();
        let hooks_dir = tempdir().expect("broker hooks directory");
        write_broker_git_hooks(hooks_dir.path()).expect("write broker hooks");
        assert!(git(
            repo.path(),
            &[
                "config",
                "core.hooksPath",
                &hooks_dir.path().to_string_lossy(),
            ],
            &[],
        )
        .status
        .success());

        // kill_on_drop(true) makes the timeout an actual bound: unlike
        // spawn_blocking (which tokio cannot cancel), dropping this future on
        // timeout kills the still-running git process instead of leaking a
        // recursive hook chain into the background.
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            Command::new("git")
                .current_dir(repo.path())
                .args(["commit", "--allow-empty", "-m", "self-loop guard"])
                .kill_on_drop(true)
                .output(),
        )
        .await;

        let commit = result
            .expect("broker hook must not hang when core.hooksPath resolves to its own directory")
            .expect("git command must not fail to run");
        assert!(
            commit.status.success(),
            "commit must still succeed even when the hook chain can't safely forward: {}",
            String::from_utf8_lossy(&commit.stderr)
        );
    }

    #[test]
    #[cfg(unix)]
    fn broker_hook_chain_execs_a_repository_configured_hooks_path() {
        let repo = fixture_repository();
        let repository_hooks_dir = repo.path().join(".repository-hooks");
        fs::create_dir_all(&repository_hooks_dir).expect("create repository hooks directory");
        assert!(git(
            repo.path(),
            &["config", "core.hooksPath", ".repository-hooks"],
            &[],
        )
        .status
        .success());
        let repository_hook = repository_hooks_dir.join("prepare-commit-msg");
        fs::write(
            &repository_hook,
            "#!/bin/sh\nprintf '\\nConfigured-Hook: preserved\\n' >> \"$1\"\n",
        )
        .expect("write configured repository hook");
        let mut permissions = fs::metadata(&repository_hook)
            .expect("configured repository hook metadata")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&repository_hook, permissions)
            .expect("make configured repository hook executable");

        let hooks_dir = tempdir().expect("broker hooks directory");
        write_broker_git_hooks(hooks_dir.path()).expect("write broker hook");
        let env = broker_hook_env(&attestation(), hooks_dir.path());
        let commit = git(
            repo.path(),
            &["commit", "-m", "preserve configured hook"],
            &env,
        );
        assert!(
            commit.status.success(),
            "git commit must succeed with a configured hooks path"
        );
        let message = commit_message(repo.path());
        assert!(message.contains("Relay-Attestation: jti-public-123"));
        assert!(message.contains("Configured-Hook: preserved"));
    }

    #[test]
    #[cfg(unix)]
    fn broker_hook_chain_execs_a_home_relative_configured_hooks_path() {
        let repo = fixture_repository();
        assert!(git(
            repo.path(),
            &["config", "core.hooksPath", "~/repository-hooks"],
            &[],
        )
        .status
        .success());
        let home_dir = tempdir().expect("home directory");
        let repository_hooks_dir = home_dir.path().join("repository-hooks");
        fs::create_dir_all(&repository_hooks_dir).expect("create repository hooks directory");
        let repository_hook = repository_hooks_dir.join("prepare-commit-msg");
        fs::write(
            &repository_hook,
            "#!/bin/sh\nprintf '\\nHome-Hook: preserved\\n' >> \"$1\"\n",
        )
        .expect("write home-relative repository hook");
        let mut permissions = fs::metadata(&repository_hook)
            .expect("home-relative repository hook metadata")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&repository_hook, permissions)
            .expect("make home-relative repository hook executable");

        let hooks_dir = tempdir().expect("broker hooks directory");
        write_broker_git_hooks(hooks_dir.path()).expect("write broker hook");
        let mut env = broker_hook_env(&attestation(), hooks_dir.path());
        env.push((
            "HOME".to_string(),
            home_dir.path().to_string_lossy().into_owned(),
        ));
        let commit = git(
            repo.path(),
            &["commit", "-m", "preserve home-relative hook"],
            &env,
        );
        assert!(
            commit.status.success(),
            "git commit must succeed with a home-relative hooks path"
        );
        let message = commit_message(repo.path());
        assert!(message.contains("Relay-Attestation: jti-public-123"));
        assert!(
            message.contains("Home-Hook: preserved"),
            "commit message: {message}"
        );
    }

    #[test]
    fn broker_hook_preserves_existing_git_config_environment() {
        let hooks_dir = tempdir().expect("broker hooks directory");
        let mut env = vec![
            ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
            (
                "GIT_CONFIG_KEY_0".to_string(),
                "advice.detachedHead".to_string(),
            ),
            ("GIT_CONFIG_VALUE_0".to_string(), "false".to_string()),
        ];
        add_broker_hooks_path(&mut env, hooks_dir.path());

        assert!(env.contains(&("GIT_CONFIG_COUNT".to_string(), "2".to_string())));
        assert!(env.contains(&("GIT_CONFIG_KEY_1".to_string(), "core.hooksPath".to_string())));
        assert!(env.contains(&(
            "GIT_CONFIG_VALUE_1".to_string(),
            hooks_dir.path().to_string_lossy().into_owned(),
        )));
    }

    #[test]
    fn write_broker_git_hooks_reports_an_unwritable_target_instead_of_panicking() {
        // A regular file blocking the target path makes create_dir_all fail
        // deterministically. Callers (Spawner::commit_hooks_dir,
        // WorkerRegistry::commit_hooks_dir) must surface this as an Err they
        // can downgrade to a warning rather than a spawn-time panic.
        let parent = tempdir().expect("parent directory");
        let blocking_file = parent.path().join("not-a-directory");
        fs::write(&blocking_file, b"blocking").expect("write blocking file");
        let unwritable_target = blocking_file.join("hooks");

        let result = write_broker_git_hooks(&unwritable_target);
        assert!(
            result.is_err(),
            "writing hooks under a file (not a directory) must fail"
        );
    }

    #[test]
    fn git_config_count_uses_an_inherited_value_when_worker_env_has_no_override() {
        assert_eq!(git_config_count_with_inherited(&[], Some("2")), 2);

        let worker_override = vec![("GIT_CONFIG_COUNT".to_string(), "1".to_string())];
        assert_eq!(
            git_config_count_with_inherited(&worker_override, Some("2")),
            1
        );
        let malformed_worker_override =
            vec![("GIT_CONFIG_COUNT".to_string(), "invalid".to_string())];
        assert_eq!(
            git_config_count_with_inherited(&malformed_worker_override, Some("2")),
            2
        );
        assert_eq!(git_config_count_with_inherited(&[], Some("invalid")), 0);
    }

    #[test]
    fn complete_attestation_metadata_maps_to_the_three_worker_environment_variables() {
        let env = with_commit_attestation_env(Vec::new(), Some(&attestation()));
        assert!(env.contains(&(RELAY_ATTEST_JTI.to_string(), "jti-public-123".to_string())));
        assert!(env.contains(&(
            RELAY_ATTEST_AGENT_ID.to_string(),
            "agent_worker_42".to_string(),
        )));
        assert!(env.contains(&(
            RELAY_ATTEST_SPONSOR_ID.to_string(),
            "user_owner_7".to_string(),
        )));
        // Without session_ref the session-id env var must be absent.
        assert!(env.iter().all(|(k, _)| k != RELAY_ATTEST_SESSION_ID));
    }

    #[test]
    fn session_ref_in_attestation_is_injected_as_relay_attest_session_id() {
        let session = "ai-hist:claudecode-abc123";
        let env = with_commit_attestation_env(Vec::new(), Some(&attestation_with_session(session)));
        assert!(env.contains(&(RELAY_ATTEST_SESSION_ID.to_string(), session.to_string())));
        // Core three vars must still be present.
        assert!(env.contains(&(RELAY_ATTEST_JTI.to_string(), "jti-public-123".to_string())));
    }

    #[test]
    fn absent_session_ref_does_not_inject_session_id_env_var() {
        let env = with_commit_attestation_env(Vec::new(), Some(&attestation()));
        assert!(env.iter().all(|(k, _)| k != RELAY_ATTEST_SESSION_ID));
    }

    #[test]
    fn invalid_session_ref_is_silently_skipped() {
        for invalid in ["", "   ", "session\ninjection", "session\0null"] {
            let attest = CommitAttestation {
                jti: "jti-public-123".to_string(),
                agent_id: "agent_worker_42".to_string(),
                sponsor_id: "user_owner_7".to_string(),
                session_ref: Some(invalid.to_string()),
            };
            let env = with_commit_attestation_env(Vec::new(), Some(&attest));
            assert!(
                env.iter().all(|(k, _)| k != RELAY_ATTEST_SESSION_ID),
                "invalid session_ref {invalid:?} must not set RELAY_ATTEST_SESSION_ID"
            );
            // Core three vars are still added — session_ref validity is checked separately.
            assert!(env.contains(&(RELAY_ATTEST_JTI.to_string(), "jti-public-123".to_string())));
        }
    }

    #[test]
    fn stale_session_id_is_stripped_when_attestation_has_no_session_ref() {
        // Simulate a pre-existing RELAY_ATTEST_SESSION_ID from a parent agent.
        let stale_env = vec![
            ("RELAY_AGENT_NAME".to_string(), "worker".to_string()),
            (
                RELAY_ATTEST_SESSION_ID.to_string(),
                "stale-parent-session".to_string(),
            ),
        ];
        // Attestation without session_ref must strip the stale value.
        let env = with_commit_attestation_env(stale_env.clone(), Some(&attestation()));
        assert!(
            env.iter().all(|(k, _)| k != RELAY_ATTEST_SESSION_ID),
            "stale RELAY_ATTEST_SESSION_ID must be cleared when session_ref is absent"
        );
        // Core vars must still be present.
        assert!(env.contains(&(RELAY_ATTEST_JTI.to_string(), "jti-public-123".to_string())));
    }

    #[test]
    fn stale_session_id_is_stripped_when_attestation_has_invalid_session_ref() {
        let stale_env = vec![
            ("RELAY_AGENT_NAME".to_string(), "worker".to_string()),
            (
                RELAY_ATTEST_SESSION_ID.to_string(),
                "stale-parent-session".to_string(),
            ),
        ];
        let invalid_attest = CommitAttestation {
            jti: "jti-public-123".to_string(),
            agent_id: "agent_worker_42".to_string(),
            sponsor_id: "user_owner_7".to_string(),
            session_ref: Some("bad\nvalue".to_string()),
        };
        let env = with_commit_attestation_env(stale_env, Some(&invalid_attest));
        assert!(
            env.iter().all(|(k, _)| k != RELAY_ATTEST_SESSION_ID),
            "stale RELAY_ATTEST_SESSION_ID must be cleared even when session_ref is invalid"
        );
    }

    #[test]
    fn valid_session_ref_overwrites_stale_session_id() {
        let stale_env = vec![
            ("RELAY_AGENT_NAME".to_string(), "worker".to_string()),
            (
                RELAY_ATTEST_SESSION_ID.to_string(),
                "stale-parent-session".to_string(),
            ),
        ];
        let new_session = "ai-hist:claudecode-fresh-xyz";
        let env =
            with_commit_attestation_env(stale_env, Some(&attestation_with_session(new_session)));
        let session_vals: Vec<_> = env
            .iter()
            .filter(|(k, _)| k == RELAY_ATTEST_SESSION_ID)
            .collect();
        assert_eq!(
            session_vals.len(),
            1,
            "exactly one RELAY_ATTEST_SESSION_ID must be set"
        );
        assert_eq!(
            session_vals[0].1, new_session,
            "stale value must be replaced by fresh session"
        );
    }

    #[test]
    fn invalid_attestation_metadata_is_not_exported_or_hook_enabled() {
        for invalid_value in [
            "",
            "   ",
            "jti\nsecond-trailer",
            "jti\rsecond-trailer",
            "jti\0",
            "jti\twith-tab",
            "jti\u{000b}with-vertical-tab",
            "jti\u{000c}with-form-feed",
        ] {
            let original = vec![("RELAY_AGENT_NAME".to_string(), "worker".to_string())];
            let invalid = CommitAttestation {
                jti: invalid_value.to_string(),
                agent_id: "agent_worker_42".to_string(),
                sponsor_id: "user_owner_7".to_string(),
                session_ref: None,
            };
            assert_eq!(
                with_commit_attestation_env(original.clone(), Some(&invalid)),
                original,
                "invalid jti must leave the environment unchanged"
            );
        }

        let invalid_environment = vec![
            (
                RELAY_ATTEST_JTI.to_string(),
                "jti\nsecond-trailer".to_string(),
            ),
            (
                RELAY_ATTEST_AGENT_ID.to_string(),
                "agent_worker_42".to_string(),
            ),
            (
                RELAY_ATTEST_SPONSOR_ID.to_string(),
                "user_owner_7".to_string(),
            ),
        ];
        assert!(!attestation_env_present(&invalid_environment));
    }

    #[test]
    #[cfg(unix)]
    fn broker_hook_chain_execs_an_inherited_core_hooks_path() {
        let repo = fixture_repository();
        let inherited_hooks_dir = tempdir().expect("inherited hooks directory");
        let inherited_hook = inherited_hooks_dir.path().join("prepare-commit-msg");
        fs::write(
            &inherited_hook,
            "#!/bin/sh\nprintf '\\nInherited-Hook: preserved\\n' >> \"$1\"\n",
        )
        .expect("write inherited hook");
        let mut permissions = fs::metadata(&inherited_hook)
            .expect("inherited hook metadata")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&inherited_hook, permissions).expect("make inherited hook executable");

        let broker_hooks_dir = tempdir().expect("broker hooks directory");
        write_broker_git_hooks(broker_hooks_dir.path()).expect("write broker hook");
        let mut env = vec![
            ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
            ("GIT_CONFIG_KEY_0".to_string(), "core.hooksPath".to_string()),
            (
                "GIT_CONFIG_VALUE_0".to_string(),
                inherited_hooks_dir.path().to_string_lossy().into_owned(),
            ),
        ];
        env = with_commit_attestation_env(env, Some(&attestation()));
        add_broker_hooks_path(&mut env, broker_hooks_dir.path());

        let commit = git(
            repo.path(),
            &["commit", "-m", "preserve inherited hook"],
            &env,
        );
        assert!(
            commit.status.success(),
            "git commit must succeed with the inherited hooks path"
        );
        let message = commit_message(repo.path());
        assert!(message.contains("Relay-Attestation: jti-public-123"));
        assert!(
            message.contains("Inherited-Hook: preserved"),
            "commit message: {message}"
        );
    }

    #[tokio::test]
    async fn release_terminates_child_process() {
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        terminate_child(&mut child, Duration::from_millis(200))
            .await
            .unwrap();
        assert!(child.try_wait().unwrap().is_some());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn release_terminates_the_worker_process_group() {
        // A broker worker is a wrapper that can own a real harness child. The
        // wrapper must be a session leader so release cannot strand that child
        // after killing only the wrapper PID.
        let mut child = Command::new("sh");
        // Let the wrapper exit immediately while a nested descendant ignores
        // SIGTERM. This specifically proves group liveness is checked after
        // child.wait() resolves, then force-killed at the bounded deadline.
        child.args([
            "-c",
            "sh -c \"trap '' TERM HUP; while :; do sleep 1; done\" & exit 0",
        ]);
        unsafe {
            child.pre_exec(|| {
                if nix::libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut child = child.spawn().unwrap();
        let pid = child.id().expect("worker has a pid");

        terminate_child(&mut child, Duration::from_millis(100))
            .await
            .unwrap();

        assert!(child.try_wait().unwrap().is_some());
        // The process-group probe is the important assertion: a direct PID
        // kill would leave the background `sleep` alive in the worker group.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        while tokio::time::Instant::now() < deadline {
            if matches!(kill(Pid::from_raw(-(pid as i32)), None), Err(Errno::ESRCH)) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(matches!(
            kill(Pid::from_raw(-(pid as i32)), None),
            Err(Errno::ESRCH)
        ));
    }

    #[tokio::test]
    async fn reap_removes_exited_children() {
        let mut spawner = Spawner::new();
        let mut child = Command::new("sleep").arg("0").spawn().unwrap();
        let _ = child.wait().await;

        spawner.children.insert(
            "test".into(),
            super::ManagedChild {
                parent: None,
                #[cfg(windows)]
                process_tree: super::attach_process_tree(&child).unwrap(),
                child,
            },
        );

        let exited = spawner.reap_exited().await.unwrap();
        assert_eq!(exited, vec!["test".to_string()]);
    }

    #[tokio::test]
    async fn spawn_wrap_creates_child_and_tracks_owner() {
        let mut spawner = Spawner::new();
        let env_vars = vec![("RELAY_AGENT_NAME".to_string(), "TestChild".to_string())];
        let pid = spawner
            .spawn_wrap_with_token(
                "TestChild",
                "sleep",
                &["30".to_string()],
                &env_vars,
                Some("Parent"),
                None,
            )
            .await
            .unwrap();
        assert!(pid > 0);
        assert_eq!(spawner.owner_of("TestChild"), Some("Parent"));

        spawner
            .release("TestChild", Duration::from_millis(200))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn spawn_wrap_rejects_duplicate_name() {
        let mut spawner = Spawner::new();
        let env_vars = vec![("RELAY_AGENT_NAME".to_string(), "Dup".to_string())];
        spawner
            .spawn_wrap_with_token("Dup", "sleep", &["30".to_string()], &env_vars, None, None)
            .await
            .unwrap();
        let result = spawner
            .spawn_wrap_with_token("Dup", "sleep", &["30".to_string()], &env_vars, None, None)
            .await;
        assert!(result.is_err());
        spawner.shutdown_all(Duration::from_millis(200)).await;
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn spawn_wrap_workers_are_session_leaders() {
        let mut spawner = Spawner::new();
        let env_vars = vec![("RELAY_AGENT_NAME".to_string(), "ReattachWorker".to_string())];
        let pid = spawner
            .spawn_wrap_with_token(
                "ReattachWorker",
                "sleep",
                &["30".to_string()],
                &env_vars,
                None,
                None,
            )
            .await
            .unwrap();

        let worker_sid = getsid(Some(Pid::from_raw(pid as i32))).unwrap();
        let current_sid = getsid(None).unwrap();
        let expected_sid = Pid::from_raw(pid as i32);

        assert_eq!(worker_sid, expected_sid);
        assert_ne!(worker_sid, current_sid);

        spawner
            .release("ReattachWorker", Duration::from_millis(200))
            .await
            .unwrap();
    }
}
