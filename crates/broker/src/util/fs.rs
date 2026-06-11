use std::path::Path;

use anyhow::{Context, Result};

/// Serialize `value` as pretty JSON and atomically replace `path` via a
/// temp-file-rename in the same directory. Used for broker state snapshots
/// (pending deliveries, dead letters, dedup cache) so a crash mid-write can
/// never leave a truncated file behind.
pub(crate) fn write_json_atomic<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    let json = serde_json::to_string_pretty(value)?;
    let dir = path.parent().unwrap_or(path);
    let mut tmp = tempfile::NamedTempFile::new_in(dir)
        .with_context(|| format!("failed creating temp file in {}", dir.display()))?;
    std::io::Write::write_all(&mut tmp, json.as_bytes())?;
    tmp.persist(path)
        .with_context(|| format!("failed persisting {}", path.display()))?;
    Ok(())
}
