//! Test stubs for worker.rs module extraction from main.rs.
//!
//! worker.rs public API:
//!   - WorkerRegistry::new(event_tx, worker_env, logs_dir, broker_start) -> Self
//!   - WorkerRegistry::spawn(spec, parent, workspace_id, ...) -> Result<()>
//!   - WorkerRegistry::release(name) -> Result<()>
//!   - WorkerRegistry::send_to_worker(name, frame) -> Result<()>
//!   - WorkerRegistry::deliver(name, delivery) -> Result<()>
//!   - WorkerRegistry::shutdown_all() -> Result<()>
//!   - WorkerRegistry::reap_exited() -> Result<Vec<(String, Option<i32>, Option<String>)>>
//!   - WorkerRegistry::list() -> Vec<Value>
//!   - WorkerRegistry::has_worker(name) -> bool
//!   - WorkerRegistry::routing_workers() -> Vec<RoutingWorker>
//!
//! Extracted types: WorkerRegistry, WorkerHandle, WorkerEvent
//! Dependencies: tokio, supervisor, metrics, routing, AgentSpec
//! Visibility: pub(crate) for all types; WorkerEvent is Clone

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    // TODO: uncomment once worker.rs is extracted
    // use crate::worker::{WorkerRegistry, WorkerEvent};

    #[test]
    fn worker_registry_starts_empty() {
        // let (tx, _rx) = tokio::sync::mpsc::channel(16);
        // let reg = WorkerRegistry::new(tx, vec![], PathBuf::from("/tmp"), Instant::now());
        // assert!(!reg.has_any_worker());
        // assert!(reg.list().is_empty());
    }

    #[test]
    fn has_worker_returns_false_for_unknown() {
        // let (tx, _rx) = tokio::sync::mpsc::channel(16);
        // let reg = WorkerRegistry::new(tx, vec![], PathBuf::from("/tmp"), Instant::now());
        // assert!(!reg.has_worker("nonexistent"));
    }

    #[test]
    fn worker_log_path_rejects_path_traversal() {
        // "../etc/passwd" and names with \ or \0 must return None
        // let reg = WorkerRegistry::new(tx, vec![], PathBuf::from("/tmp"), Instant::now());
        // assert!(reg.worker_log_path("../etc/passwd").is_none());
        // assert!(reg.worker_log_path("valid-name").is_some());
    }

    #[test]
    fn env_value_lookup() {
        // let env = vec![("KEY".into(), "val".into())];
        // let reg = WorkerRegistry::new(tx, env, PathBuf::from("/tmp"), Instant::now());
        // assert_eq!(reg.env_value("KEY"), Some("val"));
        // assert_eq!(reg.env_value("MISSING"), None);
    }

    #[tokio::test]
    async fn spawn_duplicate_name_errors() {
        // Spawning two workers with the same name should error on the second
        // reg.spawn(spec("dup"), None, ...).await.unwrap();
        // assert!(reg.spawn(spec("dup"), None, ...).await.is_err());
    }

    #[test]
    fn routing_workers_reflects_registered_workers() {
        // After spawn, routing_workers() should include the new worker
        // let workers = reg.routing_workers();
        // assert!(workers.iter().any(|w| w.name == "test-agent"));
    }
}
