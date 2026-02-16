use std::{collections::HashMap, process::Stdio, time::Duration};

use anyhow::{Context, Result};
use tokio::{
    process::{Child, Command},
    time::timeout,
};

#[cfg(unix)]
use nix::{
    sys::signal::{kill, Signal},
    unistd::Pid,
};

#[derive(Debug)]
struct ManagedChild {
    parent: Option<String>,
    child: Child,
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

    /// Spawn a wrap-mode child: `agent-relay wrap <cli> <args>`.
    /// Identity and connection info are passed via env vars rather than CLI flags.
    pub async fn spawn_wrap(
        &mut self,
        child_name: &str,
        cli: &str,
        extra_args: &[String],
        env_vars: &[(&str, &str)],
        parent: Option<&str>,
    ) -> Result<u32> {
        if self.children.contains_key(child_name) {
            anyhow::bail!("child {child_name} already exists");
        }

        let exe = std::env::current_exe().unwrap_or_else(|_| "agent-relay".into());
        let mut cmd = Command::new(exe);

        // Wrap mode: `agent-relay wrap <cli> <args...>`
        cmd.arg("wrap").arg(cli);
        for arg in extra_args {
            cmd.arg(arg);
        }

        cmd.stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());

        for (key, value) in env_vars {
            cmd.env(key, value);
        }
        // Disable Claude Code auto-suggestions to prevent accidental acceptance
        // when relay messages are injected into the PTY.
        cmd.env("CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION", "false");

        #[cfg(unix)]
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
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

    /// Return a snapshot of all managed children for the HTTP API.
    pub fn list_children(&self) -> Vec<serde_json::Value> {
        self.children
            .iter()
            .map(|(name, managed)| {
                serde_json::json!({
                    "name": name,
                    "pid": managed.child.id(),
                    "source": "spawner",
                })
            })
            .collect()
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

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
                child,
            },
        );

        let exited = spawner.reap_exited().await.unwrap();
        assert_eq!(exited, vec!["test".to_string()]);
    }

    #[tokio::test]
    async fn spawn_wrap_creates_child_and_tracks_owner() {
        let mut spawner = Spawner::new();
        let env_vars = [("RELAY_AGENT_NAME", "TestChild")];
        let pid = spawner
            .spawn_wrap(
                "TestChild",
                "sleep",
                &["30".to_string()],
                &env_vars,
                Some("Parent"),
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
            .spawn_wrap("Dup", "sleep", &["30".to_string()], &env_vars, None)
            .await
            .unwrap();
        let result = spawner
            .spawn_wrap("Dup", "sleep", &["30".to_string()], &env_vars, None)
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
            .spawn_wrap(
                "ReattachWorker",
                "sleep",
                &["30".to_string()],
                &env_vars,
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
