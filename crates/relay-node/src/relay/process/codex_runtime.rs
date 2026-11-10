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
    lock: PathBuf,
    lock_birth: Option<i128>,
}

impl CodexRuntimeProof {
    pub(crate) fn thread(&self) -> &str {
        &self.thread
    }

    pub(crate) fn current(&self, table: &dyn ProcessTable, uid: u32) -> bool {
        if self.process.uid != uid
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
    }
}

/// Enumerate hosts, not shell descendants bearing inherited thread tags.
pub(crate) fn codex_runtime_proofs(table: &dyn ProcessTable, uid: u32) -> Vec<CodexRuntimeProof> {
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
            .filter_map(|f| Some((codex_thread_of_lock(&f.path)?, f)))
            .collect();
        if locks.is_empty() {
            continue;
        }
        let paths: Vec<_> = before
            .iter()
            .filter_map(|f| {
                let thread = rollout_thread_of_path(&f.path)?;
                let birth = f.birth_ns?;
                (locks.contains_key(&thread) && file_birth_ns(&f.path) == Some(birth))
                    .then(|| f.path.clone())
            })
            .collect();
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
            let proof = CodexRuntimeProof {
                process,
                executable: executable.clone(),
                thread: thread.clone(),
                rollout,
                birth,
                lock: lock.path.clone(),
                lock_birth: lock.birth_ns,
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
