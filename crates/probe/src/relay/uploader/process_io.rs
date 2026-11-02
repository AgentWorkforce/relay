//! Bounded child-process output and waits for uploader commands.
use super::*;

/// A pipe being read in the background: at most `limit` bytes are kept,
/// the rest discarded so the writer never blocks.
pub(super) struct Capture {
    kept: Arc<Mutex<Vec<u8>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Capture {
    pub(super) fn start(
        reader: Option<impl AsyncRead + Unpin + Send + 'static>,
        limit: usize,
    ) -> Capture {
        let kept = Arc::new(Mutex::new(Vec::new()));
        let sink = kept.clone();
        let task = tokio::spawn(async move {
            let Some(mut reader) = reader else { return };
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        let mut kept = sink.lock().unwrap();
                        let room = limit.saturating_sub(kept.len());
                        kept.extend_from_slice(&buffer[..count.min(room)]);
                    }
                }
            }
        });
        Capture { kept, task }
    }

    /// What was read, once the pipe closed or a second passed: a
    /// descendant that inherited the pipe (the detached collector) can keep
    /// it open long after the command itself exited.
    pub(super) async fn finish(self) -> String {
        let mut task = self.task;
        let _ = tokio::time::timeout(Duration::from_secs(1), &mut task).await;
        task.abort();
        let kept = self.kept.lock().unwrap();
        String::from_utf8_lossy(&kept).into_owned()
    }
}

/// Waits for `child`; past `timeout`, asks it to stop, then kills it.
pub(super) async fn wait_bounded(
    child: &mut tokio::process::Child,
    timeout: Option<Duration>,
) -> Option<std::process::ExitStatus> {
    let waited = match timeout {
        Some(timeout) => tokio::time::timeout(timeout, child.wait()).await.ok(),
        None => Some(child.wait().await),
    };
    if let Some(status) = waited {
        return status.ok();
    }
    if let Some(pid) = child.id() {
        signal(pid, libc::SIGTERM);
    }
    if tokio::time::timeout(Duration::from_secs(1), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
    None
}
