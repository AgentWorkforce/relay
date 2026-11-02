//! Writing several Claude logins as one change: a login that fails puts back
//! every login already written.

use serde_json::Value;
use std::path::{Path, PathBuf};

/// Stores each planned file. The snapshot is what to put back. A later
/// snapshot or store that fails restores every file already stored. A
/// restore failure is appended to that error.
pub(super) fn store_planned(
    planned: &[(PathBuf, Value)],
    mut snapshot: impl FnMut(&Path) -> Result<Option<Vec<u8>>, String>,
    mut store: impl FnMut(&Path, &Value) -> Result<(), String>,
    mut restore: impl FnMut(&Path, &Option<Vec<u8>>) -> Result<(), String>,
) -> Result<(), String> {
    let mut written = Vec::new();
    for (path, value) in planned {
        let previous = match snapshot(path) {
            Ok(previous) => previous,
            Err(error) => return Err(restore_written(&written, error, &mut restore)),
        };
        if let Err(error) = store(path, value) {
            return Err(restore_written(&written, error, &mut restore));
        }
        written.push((path.clone(), previous));
    }
    Ok(())
}

fn restore_written(
    written: &[(PathBuf, Option<Vec<u8>>)],
    error: String,
    restore: &mut impl FnMut(&Path, &Option<Vec<u8>>) -> Result<(), String>,
) -> String {
    // Every written file is put back, even after one fails to be.
    let mut first_failure = None;
    for (path, previous) in written.iter().rev() {
        if let Err(restore_error) = restore(path, previous) {
            first_failure.get_or_insert(restore_error);
        }
    }
    match first_failure {
        Some(restore_error) => {
            format!("{error} Restoring the other logins failed: {restore_error}")
        }
        None => error,
    }
}
