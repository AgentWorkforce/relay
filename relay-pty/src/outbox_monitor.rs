//! Outbox monitor for detecting stale relay message files.
//!
//! Watches the outbox directory for files that have been written but never
//! triggered with `->relay-file:ID`. This indicates the agent intended to
//! send a message but forgot to output the trigger.
//!
//! Emits `StaleOutboxFile` events when files exceed the configured timeout.

use crate::protocol::StaleOutboxFile;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, info, warn};

/// Configuration for the outbox monitor
#[derive(Debug, Clone)]
pub struct OutboxMonitorConfig {
    /// Agent name (for event metadata)
    pub agent_name: String,
    /// Path to the outbox directory
    pub outbox_path: PathBuf,
    /// Timeout in seconds before a file is considered stale
    pub stale_timeout_secs: u64,
    /// How often to check for stale files (seconds)
    pub check_interval_secs: u64,
}

impl Default for OutboxMonitorConfig {
    fn default() -> Self {
        Self {
            agent_name: "agent".to_string(),
            outbox_path: PathBuf::from("/tmp/relay-outbox"),
            stale_timeout_secs: 60,
            check_interval_secs: 10,
        }
    }
}

/// Tracked file in the outbox
#[derive(Debug, Clone)]
struct TrackedFile {
    /// When we first saw this file
    first_seen: Instant,
    /// Full path to the file
    path: PathBuf,
    /// Whether we've already emitted a stale event for this file
    stale_emitted: bool,
}

/// Outbox monitor that detects stale relay message files
pub struct OutboxMonitor {
    config: OutboxMonitorConfig,
    /// Tracked files: filename -> TrackedFile
    tracked: Arc<Mutex<HashMap<String, TrackedFile>>>,
    /// Channel to receive file system events
    fs_rx: Option<mpsc::UnboundedReceiver<notify::Result<Event>>>,
    /// The watcher (kept alive to continue watching)
    _watcher: Option<RecommendedWatcher>,
}

impl OutboxMonitor {
    /// Create a new outbox monitor
    pub fn new(config: OutboxMonitorConfig) -> Self {
        Self {
            config,
            tracked: Arc::new(Mutex::new(HashMap::new())),
            fs_rx: None,
            _watcher: None,
        }
    }

    /// Start the file watcher (sync part - creates watcher)
    pub fn start(&mut self) -> Result<(), notify::Error> {
        let outbox_path = &self.config.outbox_path;

        // Create outbox directory if it doesn't exist
        if !outbox_path.exists() {
            if let Err(e) = std::fs::create_dir_all(outbox_path) {
                warn!("Failed to create outbox directory {:?}: {}", outbox_path, e);
            }
        }

        // Create channel for file system events
        let (tx, rx) = mpsc::unbounded_channel();
        self.fs_rx = Some(rx);

        // Create watcher
        let tx_clone = tx.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            let _ = tx_clone.send(res);
        })?;

        // Watch the outbox directory
        watcher.watch(outbox_path.as_ref(), RecursiveMode::NonRecursive)?;
        self._watcher = Some(watcher);

        info!(
            "Outbox monitor started, watching {:?} (stale timeout: {}s)",
            outbox_path, self.config.stale_timeout_secs
        );

        Ok(())
    }

    /// Initialize tracking for existing files (async part - call after start)
    pub async fn init(&self) {
        self.scan_existing_files().await;
    }

    /// Scan for existing files in the outbox directory (called during start)
    async fn scan_existing_files(&self) {
        let outbox_path = &self.config.outbox_path;
        if let Ok(entries) = std::fs::read_dir(outbox_path) {
            let now = Instant::now();
            let mut tracked = self.tracked.lock().await;

            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(filename) = path.file_name() {
                        let filename = filename.to_string_lossy().to_string();
                        // Skip hidden files and temp files
                        if !filename.starts_with('.') && !filename.ends_with(".tmp") {
                            debug!("Found existing file in outbox: {}", filename);
                            tracked.insert(
                                filename,
                                TrackedFile {
                                    first_seen: now,
                                    path: path.clone(),
                                    stale_emitted: false,
                                },
                            );
                        }
                    }
                }
            }
        }
    }

    /// Process file system events (call this in your event loop)
    pub async fn process_events(&mut self) {
        // Collect events first to avoid borrow conflict
        let events: Vec<Event> = if let Some(ref mut rx) = self.fs_rx {
            let mut collected = Vec::new();
            while let Ok(event_result) = rx.try_recv() {
                match event_result {
                    Ok(event) => collected.push(event),
                    Err(e) => warn!("File watcher error: {}", e),
                }
            }
            collected
        } else {
            Vec::new()
        };

        // Now process collected events
        for event in events {
            self.handle_event(event).await;
        }
    }

    /// Handle a file system event
    async fn handle_event(&self, event: Event) {
        let mut tracked = self.tracked.lock().await;

        for path in event.paths {
            let filename = match path.file_name() {
                Some(f) => f.to_string_lossy().to_string(),
                None => continue,
            };

            // Skip hidden files and temp files
            if filename.starts_with('.') || filename.ends_with(".tmp") {
                continue;
            }

            match event.kind {
                EventKind::Create(_) | EventKind::Modify(_) => {
                    // New or modified file - start tracking if not already
                    tracked.entry(filename).or_insert_with(|| {
                        debug!("Tracking new outbox file: {}", path.display());
                        TrackedFile {
                            first_seen: Instant::now(),
                            path: path.clone(),
                            stale_emitted: false,
                        }
                    });
                }
                EventKind::Remove(_) => {
                    // File was deleted (processed) - stop tracking
                    if tracked.remove(&filename).is_some() {
                        debug!("Outbox file processed and removed: {}", filename);
                    }
                }
                _ => {}
            }
        }
    }

    /// Check for stale files and return events for any found
    pub async fn check_stale(&mut self) -> Vec<StaleOutboxFile> {
        // First process any pending file system events
        self.process_events().await;

        let mut stale_events = Vec::new();
        let stale_threshold = Duration::from_secs(self.config.stale_timeout_secs);
        let mut tracked = self.tracked.lock().await;

        // Find stale files
        for (filename, file) in tracked.iter_mut() {
            let age = file.first_seen.elapsed();

            // Check if file still exists (might have been deleted outside our watch)
            if !file.path.exists() {
                continue;
            }

            if age >= stale_threshold && !file.stale_emitted {
                let age_secs = age.as_secs();
                info!(
                    "Detected stale outbox file: {} (age: {}s)",
                    filename, age_secs
                );

                stale_events.push(StaleOutboxFile::new(
                    filename.clone(),
                    file.path.to_string_lossy().to_string(),
                    age_secs,
                    self.config.agent_name.clone(),
                ));

                // Mark as emitted to avoid duplicate events
                file.stale_emitted = true;
            }
        }

        // Clean up files that no longer exist
        tracked.retain(|_, file| file.path.exists());

        stale_events
    }

    /// Notify that a file was processed (triggered with ->relay-file:)
    /// This removes it from tracking so we don't emit stale events for it.
    pub async fn file_processed(&self, filename: &str) {
        let mut tracked = self.tracked.lock().await;
        if tracked.remove(filename).is_some() {
            debug!("Outbox file marked as processed: {}", filename);
        }
    }

    /// Get the number of currently tracked files
    pub async fn tracked_count(&self) -> usize {
        self.tracked.lock().await.len()
    }
}

/// Create an outbox monitor from the given path and timeout
pub fn create_outbox_monitor(
    agent_name: String,
    outbox_path: &Path,
    stale_timeout_secs: u64,
) -> OutboxMonitor {
    OutboxMonitor::new(OutboxMonitorConfig {
        agent_name,
        outbox_path: outbox_path.to_path_buf(),
        stale_timeout_secs,
        check_interval_secs: 10,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_detect_stale_file() {
        let temp_dir = TempDir::new().unwrap();
        let outbox_path = temp_dir.path().to_path_buf();

        let mut monitor = OutboxMonitor::new(OutboxMonitorConfig {
            agent_name: "TestAgent".to_string(),
            outbox_path: outbox_path.clone(),
            stale_timeout_secs: 1, // Very short for testing
            check_interval_secs: 1,
        });

        monitor.start().unwrap();
        monitor.init().await;

        // Create a file in the outbox
        let test_file = outbox_path.join("test-msg");
        std::fs::write(&test_file, "TO: Bob\n\nHello").unwrap();

        // Give the watcher time to detect it
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Process events
        monitor.process_events().await;

        // File should be tracked but not stale yet
        let stale = monitor.check_stale().await;
        assert!(stale.is_empty());

        // Wait for file to become stale
        tokio::time::sleep(Duration::from_secs(2)).await;

        // Now it should be stale
        let stale = monitor.check_stale().await;
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].file, "test-msg");
        assert_eq!(stale[0].agent, "TestAgent");
        assert!(stale[0].age_seconds >= 1);

        // Should not emit again (already emitted)
        let stale = monitor.check_stale().await;
        assert!(stale.is_empty());
    }

    #[tokio::test]
    async fn test_file_processed_removes_tracking() {
        let temp_dir = TempDir::new().unwrap();
        let outbox_path = temp_dir.path().to_path_buf();

        let mut monitor = OutboxMonitor::new(OutboxMonitorConfig {
            agent_name: "TestAgent".to_string(),
            outbox_path: outbox_path.clone(),
            stale_timeout_secs: 1,
            check_interval_secs: 1,
        });

        monitor.start().unwrap();
        monitor.init().await;

        // Create a file
        let test_file = outbox_path.join("msg-001");
        std::fs::write(&test_file, "TO: Bob\n\nHi").unwrap();

        tokio::time::sleep(Duration::from_millis(100)).await;
        monitor.process_events().await;

        // Mark as processed
        monitor.file_processed("msg-001").await;

        // Wait and check - should not be stale
        tokio::time::sleep(Duration::from_secs(2)).await;
        let stale = monitor.check_stale().await;
        assert!(stale.is_empty());
    }

    #[tokio::test]
    async fn test_deleted_file_not_tracked() {
        let temp_dir = TempDir::new().unwrap();
        let outbox_path = temp_dir.path().to_path_buf();

        let mut monitor = OutboxMonitor::new(OutboxMonitorConfig {
            agent_name: "TestAgent".to_string(),
            outbox_path: outbox_path.clone(),
            stale_timeout_secs: 1,
            check_interval_secs: 1,
        });

        monitor.start().unwrap();
        monitor.init().await;

        // Create and immediately delete a file
        let test_file = outbox_path.join("ephemeral");
        std::fs::write(&test_file, "TO: Bob\n\nHi").unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        std::fs::remove_file(&test_file).unwrap();

        tokio::time::sleep(Duration::from_secs(2)).await;
        let stale = monitor.check_stale().await;
        assert!(stale.is_empty());
    }

    #[tokio::test]
    async fn test_hidden_files_ignored() {
        let temp_dir = TempDir::new().unwrap();
        let outbox_path = temp_dir.path().to_path_buf();

        let mut monitor = OutboxMonitor::new(OutboxMonitorConfig {
            agent_name: "TestAgent".to_string(),
            outbox_path: outbox_path.clone(),
            stale_timeout_secs: 1,
            check_interval_secs: 1,
        });

        monitor.start().unwrap();
        monitor.init().await;

        // Create hidden file
        let hidden_file = outbox_path.join(".hidden");
        std::fs::write(&hidden_file, "should be ignored").unwrap();

        // Create temp file
        let tmp_file = outbox_path.join("something.tmp");
        std::fs::write(&tmp_file, "also ignored").unwrap();

        tokio::time::sleep(Duration::from_secs(2)).await;
        let stale = monitor.check_stale().await;
        assert!(stale.is_empty());
    }
}
