//! Reply identities for managed and ordinary OpenCode processes.
use super::*;
impl LocalSessions {
    /// The OpenCode session of the caller `pid`, held by the nearest
    /// OpenCode process of this user's above it in its plugin record: the
    /// one `claim` names, or with no claim the only session it holds. The
    /// caller must still be the same process afterwards.
    pub(super) fn opencode_caller(&self, pid: i32, claim: Option<&str>) -> Option<Target> {
        let table = &*self.table;
        let uid = self.config.uid;
        let caller = table.process(pid)?;
        // The nearest OpenCode process of this user above the caller.
        let mut current = pid;
        let mut holder = None;
        for _ in 0..MAX_ANCESTRY {
            if current <= 1 {
                break;
            }
            let process = table.process(current)?;
            if process.uid == uid && crate::relay::opencode::is_opencode_process(table, current) {
                holder = Some(current);
                break;
            }
            current = process.parent;
        }
        let holder = holder?;
        if table
            .environment_var(holder, crate::relay::opencode_serve::MARKER)
            .is_some()
        {
            return crate::relay::opencode::managed::caller(
                self.managed.as_deref()?,
                &self.config.opencode,
                table,
                holder,
                claim,
            )
            .filter(|_| table.process(pid) == Some(caller));
        }
        if !self.config.opencode_open {
            return None;
        }
        let held: Vec<String> =
            crate::relay::opencode::open_processes(&self.config.opencode, table, uid)
                .into_iter()
                .filter(|process| process.pid == holder)
                .flat_map(|process| process.sessions)
                .map(|session| session.session_id)
                .collect();
        let session_id = match claim {
            Some(claim) => held.iter().find(|id| *id == claim)?.clone(),
            None => match held.as_slice() {
                [only] => only.clone(),
                _ => return None,
            },
        };
        (table.process(pid) == Some(caller))
            .then(|| Target::new(SessionKind::OpenCodeOpen, session_id))
    }
}
