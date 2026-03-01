use std::{
    collections::HashMap,
    process::Stdio,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use relay_broker::snippets::configure_relaycast_mcp_with_token;
use tokio::{
    process::{Child, Command},
    time::timeout,
};

use crate::helpers::{normalize_cli_name, parse_cli_command};

#[cfg(unix)]
use nix::{
    sys::signal::{kill, Signal},
    unistd::Pid,
};

#[derive(Debug)]
struct ManagedChild {
    parent: Option<String>,
    cli: String,
    spawned_at: Instant,
    child: Child,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitedChild {
    pub name: String,
    pub cli: String,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub lifetime_seconds: u64,
}

#[derive(Debug, Default)]
pub struct Spawner {
    children: HashMap<String, ManagedChild>,
}

impl Spawner {
    pub fn new() -> Self {
        Self {
            children: HashMap::new(),
        }
    }

    pub async fn spawn_wrap_with_token(
        &mut self,
        child_name: &str,
        cli: &str,
        extra_args: &[String],
        env_vars: &[(&str, &str)],
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
        let api_key = env_vars
            .iter()
            .find(|(k, _)| *k == "RELAY_API_KEY")
            .map(|(_, v)| *v);
        let base_url = env_vars
            .iter()
            .find(|(k, _)| *k == "RELAY_BASE_URL")
            .map(|(_, v)| *v);
        let cwd = std::env::current_dir().unwrap_or_default();
        let mcp_args = configure_relaycast_mcp_with_token(
            &resolved_cli,
            child_name,
            api_key,
            base_url,
            &combined_args,
            &cwd,
            agent_token,
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

        for (key, value) in env_vars {
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

        let child = cmd.spawn().context("failed to spawn wrap-mode child")?;
        let pid = child.id().context("spawned child missing pid")?;

        self.children.insert(
            child_name.to_string(),
            ManagedChild {
                parent: parent.map(ToOwned::to_owned),
                cli: normalize_cli_name(&resolved_cli),
                spawned_at: Instant::now(),
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

    pub fn child_telemetry(&self, child_name: &str) -> Option<(String, u64)> {
        self.children
            .get(child_name)
            .map(|managed| (managed.cli.clone(), managed.spawned_at.elapsed().as_secs()))
    }

    pub async fn release(&mut self, name: &str, timeout_duration: Duration) -> Result<()> {
        let mut managed = self
            .children
            .remove(name)
            .with_context(|| format!("unknown child {name}"))?;

        terminate_child(&mut managed.child, timeout_duration).await
    }

    pub async fn reap_exited(&mut self) -> Result<Vec<ExitedChild>> {
        let names: Vec<String> = self.children.keys().cloned().collect();
        let mut exited = Vec::new();

        for name in names {
            let status = if let Some(child) = self.children.get_mut(&name) {
                child.child.try_wait()?
            } else {
                None
            };
            if let Some(status) = status {
                if let Some(managed) = self.children.remove(&name) {
                    #[cfg(unix)]
                    let signal = {
                        use std::os::unix::process::ExitStatusExt;
                        status.signal().map(|value| value.to_string())
                    };
                    #[cfg(not(unix))]
                    let signal: Option<String> = None;

                    exited.push(ExitedChild {
                        name,
                        cli: managed.cli,
                        exit_code: status.code(),
                        signal,
                        lifetime_seconds: managed.spawned_at.elapsed().as_secs(),
                    });
                }
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
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
        }
    }

    #[cfg(not(unix))]
    {
        let _ = child.kill().await;
    }

    if timeout(timeout_duration, child.wait()).await.is_err() {
        #[cfg(unix)]
        {
            if let Some(pid) = child.id() {
                let _ = kill(Pid::from_raw(pid as i32), Signal::SIGKILL);
            }
        }

        #[cfg(not(unix))]
        {
            let _ = child.kill().await;
        }

        let _ = child.wait().await;
    }

    Ok(())
}

pub fn spawn_env_vars<'a>(
    name: &'a str,
    api_key: &'a str,
    base_url: &'a str,
    channels: &'a str,
) -> [(&'a str, &'a str); 5] {
    [
        ("RELAY_AGENT_NAME", name),
        ("RELAY_API_KEY", api_key),
        ("RELAY_BASE_URL", base_url),
        ("RELAY_CHANNELS", channels),
        ("RELAY_STRICT_AGENT_NAME", "1"),
    ]
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    #[cfg(unix)]
    use nix::unistd::{getsid, Pid};
    use tokio::process::Command;

    use super::{terminate_child, Spawner};

    #[tokio::test]
    async fn release_terminates_child_process() {
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        terminate_child(&mut child, Duration::from_millis(200))
            .await
            .unwrap();
        assert!(child.try_wait().unwrap().is_some());
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
                cli: "sleep".to_string(),
                spawned_at: Instant::now(),
                child,
            },
        );

        let exited = spawner.reap_exited().await.unwrap();
        assert_eq!(exited.len(), 1);
        assert_eq!(exited[0].name, "test");
    }

    #[tokio::test]
    async fn spawn_wrap_creates_child_and_tracks_owner() {
        let mut spawner = Spawner::new();
        let env_vars = [("RELAY_AGENT_NAME", "TestChild")];
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
        let env_vars = [("RELAY_AGENT_NAME", "Dup")];
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
        let env_vars = [("RELAY_AGENT_NAME", "ReattachWorker")];
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
