//! The pinned CodexBar helper, run for one lane at a time: a sterile
//! config, only the environment that lane needs, bounded output and time.

use super::{
    normalize_helper_json, QuotaConfig, QuotaLane, QuotaReading, UnknownReason, CODEXBAR_VERSION,
};
use chrono::{DateTime, Utc};
use futures_util::future::join_all;
use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const HELPER_TIMEOUT: Duration = Duration::from_secs(35);
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

pub(super) fn sterile_config(
    lane: Option<QuotaLane>,
) -> Result<Option<(tempfile::TempDir, PathBuf)>, UnknownReason> {
    // Ignore any ambient CodexBar config that may contain another provider's
    // secrets. Muse and Claude also need cookies explicitly disabled even when
    // their selected source is OAuth.
    if let Some(lane) = lane {
        let mut builder = tempfile::Builder::new();
        builder.prefix("agent-relay-quota-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(std::fs::Permissions::from_mode(0o700));
        }
        let dir = builder
            .tempdir()
            .map_err(|_| UnknownReason::HelperUnavailable)?;
        let path = dir.path().join("config.json");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .map_err(|_| UnknownReason::HelperUnavailable)?;
        let config = format!(
            r#"{{"version":1,"providers":[{{"id":"{}","enabled":true,"source":"{}","cookieSource":"off"}}]}}"#,
            lane.provider(),
            lane.source_mode()
        );
        file.write_all(config.as_bytes())
            .map_err(|_| UnknownReason::HelperUnavailable)?;
        Ok(Some((dir, path)))
    } else {
        Ok(None)
    }
}

fn helper_env_keys(lane: Option<QuotaLane>) -> Vec<&'static str> {
    let Some(lane) = lane else { return Vec::new() };
    let mut keys = vec!["HOME", "PATH", "TMPDIR", "USER", "LOGNAME"];
    match lane {
        QuotaLane::ClaudeOAuth => {
            keys.extend(["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"]);
        }
        QuotaLane::CodexOAuth | QuotaLane::CodexRpc => {
            keys.extend(["CODEX_HOME", "XDG_DATA_HOME"]);
        }
        QuotaLane::OpenCodeGoApi => keys.push("OPENCODE_API_KEY"),
        QuotaLane::GrokRpc => keys.push("GROK_HOME"),
        QuotaLane::MuseCodeOAuth => keys.push("MUSE_AUTH_PATH"),
    }
    keys
}

pub(super) fn forward_helper_env<F>(command: &mut Command, lane: Option<QuotaLane>, mut lookup: F)
where
    F: FnMut(&str) -> Option<OsString>,
{
    command.env_clear();
    for key in helper_env_keys(lane) {
        if let Some(value) = lookup(key) {
            command.env(key, value);
        }
    }
}

async fn helper_output(
    path: &PathBuf,
    args: &[&str],
    lane: Option<QuotaLane>,
) -> Result<Vec<u8>, UnknownReason> {
    let isolated_config = sterile_config(lane)?;
    let mut command = Command::new(path);
    forward_helper_env(&mut command, lane, |key| std::env::var_os(key));
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some((_, path)) = isolated_config.as_ref() {
        command.env("CODEXBAR_CONFIG", path);
    }
    let run = async {
        let mut child = command
            .spawn()
            .map_err(|_| UnknownReason::HelperUnavailable)?;
        let stdout = child
            .stdout
            .take()
            .ok_or(UnknownReason::HelperUnavailable)?;
        let mut output = Vec::new();
        stdout
            .take((MAX_OUTPUT_BYTES + 1) as u64)
            .read_to_end(&mut output)
            .await
            .map_err(|_| UnknownReason::FetchFailed)?;
        if output.len() > MAX_OUTPUT_BYTES {
            return Err(UnknownReason::InvalidOutput);
        }
        let status = child.wait().await.map_err(|_| UnknownReason::FetchFailed)?;
        if !status.success() {
            return Err(UnknownReason::FetchFailed);
        }
        Ok(output)
    };
    tokio::time::timeout(HELPER_TIMEOUT, run)
        .await
        .map_err(|_| UnknownReason::Timeout)?
}

async fn helper_version_matches(path: &PathBuf) -> bool {
    let Ok(output) = helper_output(path, &["--version"], None).await else {
        return false;
    };
    String::from_utf8_lossy(&output)
        .split_whitespace()
        .any(|part| part.trim_start_matches('v') == CODEXBAR_VERSION)
}

/// Probe only explicitly enabled lanes. No helper is launched when all are off.
/// Errors are sanitized; helper stderr and raw JSON are never logged or returned.
pub async fn collect(config: &QuotaConfig, now: DateTime<Utc>) -> Vec<QuotaReading> {
    if config.enabled_lanes.is_empty() {
        return Vec::new();
    }
    if !helper_version_matches(&config.helper_path).await {
        return config
            .enabled_lanes
            .iter()
            .copied()
            .map(|lane| QuotaReading::unknown(lane, UnknownReason::HelperVersion))
            .collect();
    }
    join_all(config.enabled_lanes.iter().copied().map(|lane| {
        let path = config.helper_path.clone();
        async move {
            let args = [
                "usage",
                "--provider",
                lane.provider(),
                "--source",
                lane.source_mode(),
                "--format",
                "json",
                "--no-color",
            ];
            match helper_output(&path, &args, Some(lane)).await {
                Ok(bytes) => normalize_helper_json(lane, &bytes, now),
                Err(reason) => QuotaReading::unknown(lane, reason),
            }
        }
    }))
    .await
}
