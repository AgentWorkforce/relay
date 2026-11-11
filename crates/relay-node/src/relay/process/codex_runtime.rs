//! Runtime presence is sufficient for admission, never for caller identity
//! or deciding which chat receives hook output.
use super::*;

#[derive(Clone, Debug)]
pub struct CodexRuntimeProof {
    process: ProcessInfo,
    executable: PathBuf,
    thread: String,
    rollout: PathBuf,
    birth: i128,
    rollout_key: Option<(u64, u64)>,
    lock: PathBuf,
    lock_birth: Option<i128>,
    lock_key: Option<(u64, u64)>,
}

impl CodexRuntimeProof {
    /// Canonical thread id bound to the held rollout and writer lock.
    pub(crate) fn thread(&self) -> &str {
        &self.thread
    }

    /// New desktop builds can leave `has_user_event` unset for a real
    /// composer or Android Remote Control turn. Trust native attribution
    /// from this held root rollout, never a prompt's text or role alone.
    pub(crate) fn has_native_user_turn(&self) -> bool {
        const MAX_SCAN: u64 = 512 * 1024;
        if file_birth_ns(&self.rollout) != Some(self.birth)
            || file_key(&self.rollout) != self.rollout_key
            || rollout_proof(&self.rollout, &self.thread) != Some(RolloutProof::Root)
        {
            return false;
        }
        let Ok(file) = std::fs::File::open(&self.rollout) else {
            return false;
        };
        let mut reader = std::io::BufReader::new(std::io::Read::take(file, MAX_SCAN));
        let mut line = String::new();
        for _ in 0..64 {
            line.clear();
            if reader.read_line(&mut line).ok().is_none_or(|n| n == 0) || !line.ends_with('\n') {
                return false;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                return false;
            };
            if value["type"] != "event_msg" || value["payload"]["type"] != "task_started" {
                continue;
            }
            let payload = &value["payload"];
            let attribution = &payload["turn_attribution"];
            let Some(turn) = payload["turn_id"].as_str() else {
                continue;
            };
            if crate::relay::store::is_uuid(turn)
                && matches!(
                    attribution["turn_trigger"].as_str(),
                    Some("composer" | "remote_android")
                )
                && attribution["turn_id"].as_str() == Some(turn)
                && attribution["root_turn_id"].as_str() == Some(turn)
                && attribution
                    .get("parent_turn_id")
                    .is_some_and(serde_json::Value::is_null)
                && attribution
                    .get("initiating_agent_path")
                    .is_some_and(serde_json::Value::is_null)
            {
                return file_birth_ns(&self.rollout) == Some(self.birth)
                    && file_key(&self.rollout) == self.rollout_key;
            }
        }
        false
    }

    /// Revalidate process incarnation, executable, held lock and rollout.
    pub(crate) fn current(&self, table: &dyn ProcessTable, uid: u32, home: &Path) -> bool {
        let Ok(home) = home.canonicalize() else {
            return false;
        };
        if !self.rollout.starts_with(&home)
            || !lock_in_home(&self.lock, &home)
            || file_key(&self.rollout) != self.rollout_key
            || file_key(&self.lock) != self.lock_key
            || self.process.uid != uid
            || table.process(self.process.pid) != Some(self.process)
            || table.zombie(self.process.pid)
            || table.executable(self.process.pid).as_ref() != Some(&self.executable)
            || !table.is_trusted_codex(&self.executable)
        {
            return false;
        }
        let matches = |files: &[OpenedFile]| {
            files
                .iter()
                .any(|f| f.path == self.lock && f.birth_ns == self.lock_birth)
                && files.iter().any(|f| {
                    f.birth_ns == Some(self.birth)
                        && f.path.canonicalize().ok().as_ref() == Some(&self.rollout)
                })
        };
        let before = table.opened_files(self.process.pid);
        if !matches(&before)
            || file_birth_ns(&self.rollout) != Some(self.birth)
            || rollout_proof(&self.rollout, &self.thread) != Some(RolloutProof::Root)
        {
            return false;
        }
        matches(&table.opened_files(self.process.pid))
            && table.process(self.process.pid) == Some(self.process)
            && file_birth_ns(&self.rollout) == Some(self.birth)
            && file_key(&self.rollout) == self.rollout_key
            && file_key(&self.lock) == self.lock_key
    }
}

/// Enumerate hosts, not shell descendants bearing inherited thread tags.
pub(crate) fn codex_runtime_proofs(
    table: &dyn ProcessTable,
    uid: u32,
    home: &Path,
) -> Vec<CodexRuntimeProof> {
    let Ok(home) = home.canonicalize() else {
        return Vec::new();
    };
    let mut found: BTreeMap<String, CodexRuntimeProof> = BTreeMap::new();
    let mut ambiguous = BTreeSet::new();
    let mut trusted = BTreeMap::new();
    for pid in table.all_pids() {
        let Some(process) = table.process(pid).filter(|p| p.uid == uid) else {
            continue;
        };
        if table.zombie(pid) {
            continue;
        }
        let Some(executable) = table.executable(pid) else {
            continue;
        };
        if !*trusted
            .entry(executable.clone())
            .or_insert_with(|| table.is_trusted_codex(&executable))
        {
            continue;
        }
        let before = table.opened_files(pid);
        let locks: BTreeMap<_, _> = before
            .iter()
            .filter(|f| lock_in_home(&f.path, &home))
            .filter_map(|f| Some((codex_thread_of_lock(&f.path)?, f)))
            .collect();
        if locks.is_empty() {
            continue;
        }
        let mut paths: Vec<_> = before
            .iter()
            .filter_map(|f| {
                let thread = rollout_thread_of_path(&f.path)?;
                let birth = f.birth_ns?;
                (locks.contains_key(&thread)
                    && f.path.canonicalize().ok()?.starts_with(&home)
                    && file_birth_ns(&f.path) == Some(birth))
                .then(|| f.path.clone())
            })
            .collect();
        paths.sort();
        paths.dedup();
        let headers = open_rollout_proofs(&paths);
        let after = table.opened_files(pid);
        if table.process(pid) != Some(process) {
            continue;
        }
        for path in paths {
            let Some(thread) = rollout_thread_of_path(&path) else {
                continue;
            };
            if headers.get(&thread) != Some(&RolloutProof::Root) {
                continue;
            }
            let Some(rollout) = path.canonicalize().ok() else {
                continue;
            };
            let Some(birth) = file_birth_ns(&rollout) else {
                continue;
            };
            let lock = locks[&thread];
            if !after
                .iter()
                .any(|f| f.path == lock.path && f.birth_ns == lock.birth_ns)
                || !after
                    .iter()
                    .any(|f| f.path == path && f.birth_ns == Some(birth))
                || !before
                    .iter()
                    .any(|f| f.path == path && f.birth_ns == Some(birth))
            {
                continue;
            }
            let rollout_key = file_key(&rollout);
            let lock_key = file_key(&lock.path);
            #[cfg(unix)]
            if rollout_key.is_none() || lock_key.is_none() {
                continue;
            }
            let proof = CodexRuntimeProof {
                process,
                executable: executable.clone(),
                thread: thread.clone(),
                rollout_key,
                rollout,
                birth,
                lock: lock.path.clone(),
                lock_birth: lock.birth_ns,
                lock_key,
            };
            if found.insert(thread.clone(), proof).is_some() {
                ambiguous.insert(thread);
            }
        }
    }
    found
        .into_iter()
        .filter(|(id, _)| !ambiguous.contains(id))
        .map(|(_, p)| p)
        .collect()
}

/// A copied profile's lock cannot confer authority on this catalog.
fn lock_in_home(path: &Path, home: &Path) -> bool {
    path.canonicalize()
        .ok()
        .is_some_and(|lock| lock.parent() == Some(home.join("thread-writer-locks").as_path()))
}

/// Unix replacements can share a creation timestamp when they happen
/// rapidly; device and inode bind the exact named file as well. Other
/// platforms retain the existing kernel-held creation-time evidence.
#[cfg(unix)]
fn file_key(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
/// Other platforms retain their existing held-file creation-time proof.
fn file_key(_: &Path) -> Option<(u64, u64)> {
    None
}

/// A SessionStart may nudge global discovery without selecting any chat.
pub(crate) fn trusted_codex_host(table: &dyn ProcessTable, pid: i32, uid: u32) -> bool {
    let mut chain = Vec::new();
    let mut current = pid;
    for _ in 0..MAX_ANCESTRY {
        let Some(process) = table.process(current).filter(|p| p.uid == uid && p.pid > 1) else {
            return false;
        };
        chain.push(process);
        if table
            .executable(current)
            .is_some_and(|exe| table.is_trusted_codex(&exe))
        {
            return chain.iter().all(|p| table.process(p.pid) == Some(*p));
        }
        current = process.parent;
    }
    false
}
