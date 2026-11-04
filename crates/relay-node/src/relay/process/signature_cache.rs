//! Coalesce expensive verification only while a path names the same binary.
//! No map lock is held during verification, and no trust exists until the
//! verifier succeeds and the file identity is checked again.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

struct Flight<I> {
    identity: I,
    verdict: OnceLock<bool>,
}

pub(super) struct Cache<I> {
    paths: Mutex<HashMap<PathBuf, Arc<Flight<I>>>>,
}
impl<I> Default for Cache<I> {
    fn default() -> Self {
        Self {
            paths: Mutex::new(HashMap::new()),
        }
    }
}
impl<I: Copy + Eq> Cache<I> {
    pub(super) fn trusted(
        &self,
        path: &Path,
        identity: impl Fn(&Path) -> Option<I>,
        verify: impl FnOnce(&Path) -> bool,
    ) -> bool {
        let Some(before) = identity(path) else {
            return false;
        };
        let flight = {
            let mut paths = self
                .paths
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let flight = paths.entry(path.into()).or_insert_with(|| {
                Arc::new(Flight {
                    identity: before,
                    verdict: OnceLock::new(),
                })
            });
            if flight.identity != before {
                *flight = Arc::new(Flight {
                    identity: before,
                    verdict: OnceLock::new(),
                });
            }
            flight.clone()
        };
        let trusted = *flight.verdict.get_or_init(|| {
            let valid = verify(path);
            identity(path) == Some(before) && valid
        });
        // Waiting for another caller must not lend its old verdict to a
        // replaced file. The old flight never overwrites a newer identity.
        trusted && identity(path) == Some(before)
    }
}

#[cfg(test)]
mod tests;
