use super::*;

#[derive(Debug)]
pub(crate) struct RuntimePaths {
    pub(super) persist: bool,
    pub(super) state: PathBuf,
    pub(super) pending: PathBuf,
    /// Held for process lifetime to prevent concurrent broker instances (persist mode only).
    #[allow(dead_code)]
    pub(super) _lock: Option<std::fs::File>,
}

/// Returns the continuity directory path derived from the state file path.
/// State path is always `{cwd}/.agentworkforce/relay/state.json`, so parent is `{cwd}/.agentworkforce/relay/`.
pub(crate) fn continuity_dir(state_path: &Path) -> PathBuf {
    state_path
        .parent()
        .expect("state_path always has a parent (.agentworkforce/relay/)")
        .join("continuity")
}

/// Create ephemeral runtime paths in the system temp directory.
///
/// Unlike `ensure_runtime_paths`, this function:
/// - Writes nothing to the project directory
/// - Uses a unique temp directory per broker instance so concurrent
///   ephemeral brokers cannot collide on state files
///
/// The temp directory is NOT removed on exit — the OS cleans it up on reboot.
/// State and pending-delivery files are still written there so they don't
/// interfere with the project tree; they're just ephemeral.
/// Ephemeral mode: no lock file, no PID file, no temp directory.
/// The broker lifecycle is tied to the parent process via stdin — when the
/// parent (SDK client) exits, stdin gets EOF and the broker shuts down.
/// Single-instance enforcement is unnecessary here because each SDK client
/// manages its own child process.
pub(crate) fn ensure_ephemeral_paths(_cwd: &Path, broker_name: &str) -> Result<RuntimePaths> {
    let safe_name: String = broker_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let safe_name = if safe_name.is_empty() {
        "broker".to_string()
    } else {
        safe_name
    };
    let root = std::env::temp_dir().join(format!(
        "agent-relay-ephemeral-{}-{}-{}",
        std::process::id(),
        safe_name,
        Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&root)
        .with_context(|| format!("failed to create ephemeral temp dir {}", root.display()))?;

    Ok(RuntimePaths {
        persist: false,
        state: root.join("state.json"),
        pending: root.join("pending.json"),
        _lock: None,
    })
}

pub(crate) fn ensure_runtime_paths(
    cwd: &Path,
    broker_name: &str,
    state_dir: Option<&Path>,
) -> Result<RuntimePaths> {
    let root = state_dir
        .map(PathBuf::from)
        .unwrap_or_else(|| cwd.join(".agentworkforce/relay"));
    std::fs::create_dir_all(&root)
        .with_context(|| format!("failed to create runtime dir {}", root.display()))?;

    // Sanitise name for use in filenames — keep only alphanumeric and hyphens
    let safe_name: String = broker_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();

    // Lock and PID files are per-broker-name so concurrent workflows can coexist.
    let lock_path = root.join(format!("broker-{safe_name}.lock"));
    let lock_file = std::fs::File::create(&lock_path)
        .with_context(|| format!("failed to create lock file {}", lock_path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let fd = lock_file.as_raw_fd();
        let rc = unsafe { nix::libc::flock(fd, nix::libc::LOCK_EX | nix::libc::LOCK_NB) };
        if rc != 0 {
            // Lock acquisition failed — check if the holder is still alive
            // by reading the PID from connection.json.
            let connection_path = root.join("connection.json");
            let old_pid = std::fs::read_to_string(&connection_path)
                .ok()
                .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
                .and_then(|v| v.get("pid").and_then(|p| p.as_u64()))
                .map(|p| p as u32);
            if let Some(old_pid) = old_pid {
                if !broker::is_pid_alive(old_pid) {
                    tracing::warn!(
                        old_pid = old_pid,
                        "stale broker lock detected (PID {} is dead), recovering",
                        old_pid
                    );
                    // The old process is dead — remove stale PID file and retry lock.
                    // We drop and re-create the lock file to clear the stale flock.
                    drop(lock_file);
                    let lock_file = std::fs::File::create(&lock_path).with_context(|| {
                        format!(
                            "failed to re-create lock file after stale recovery {}",
                            lock_path.display()
                        )
                    })?;
                    let fd = lock_file.as_raw_fd();
                    let rc =
                        unsafe { nix::libc::flock(fd, nix::libc::LOCK_EX | nix::libc::LOCK_NB) };
                    if rc != 0 {
                        anyhow::bail!(
                            "another broker instance is already running in this directory ({})",
                            root.display()
                        );
                    }
                    // Successfully recovered — PID is written via connection.json at API start
                    return Ok(RuntimePaths {
                        persist: true,
                        state: root.join(format!("state-{safe_name}.json")),
                        pending: root.join(format!("pending-{safe_name}.json")),
                        _lock: Some(lock_file),
                    });
                } else {
                    anyhow::bail!(
                            "another broker instance is already running in this directory (pid: {}, {})",
                            old_pid,
                            root.display()
                        );
                }
            }
            // PID file missing or unreadable while lock is held — treat as stale.
            // This happens when the user deletes .agentworkforce/relay/ while an old broker
            // is still alive, or during the shutdown race (PID deleted before flock
            // released).
            tracing::warn!(
                "broker lock held but no valid PID file found, treating as stale and recovering"
            );
            drop(lock_file);
            let lock_file = std::fs::File::create(&lock_path).with_context(|| {
                format!(
                    "failed to re-create lock file after stale recovery {}",
                    lock_path.display()
                )
            })?;
            let fd = lock_file.as_raw_fd();
            let rc = unsafe { nix::libc::flock(fd, nix::libc::LOCK_EX | nix::libc::LOCK_NB) };
            if rc != 0 {
                anyhow::bail!(
                    "another broker instance is already running in this directory ({})",
                    root.display()
                );
            }
            return Ok(RuntimePaths {
                persist: true,
                state: root.join(format!("state-{safe_name}.json")),
                pending: root.join(format!("pending-{safe_name}.json")),
                _lock: Some(lock_file),
            });
        }
    }

    // PID is written via connection.json at API start

    Ok(RuntimePaths {
        persist: true,
        state: root.join(format!("state-{safe_name}.json")),
        pending: root.join(format!("pending-{safe_name}.json")),
        _lock: Some(lock_file),
    })
}

pub(crate) fn derive_ws_base_url_from_http(http_base: &str) -> String {
    let trimmed = http_base.trim();
    if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        trimmed.to_string()
    }
}
