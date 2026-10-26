//! Mutation requires a readable sharing snapshot; discovery's tolerant default
//! is not permission to install into a login whose choice could not be read.
use super::*;
use crate::relay::claude_dirs::{ClaudeDirs, Recorded};

pub(super) fn shared_roots(
    dirs: &ClaudeDirs,
    default: &Path,
    cache: &Installations,
) -> Result<Vec<PathBuf>, String> {
    let recorded = match dirs.file.as_deref().map(fs::read).transpose() {
        Ok(Some(bytes)) => {
            let recorded = serde_json::from_slice::<Recorded>(&bytes)
                .map_err(|_| "Claude login sharing settings could not be decoded.".to_string())?;
            cache.consent_file(true)?;
            recorded
        }
        Ok(None) => Recorded::default(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            cache.consent_file(false)?;
            Recorded::default()
        }
        Err(error) => {
            return Err(format!(
                "Claude login sharing settings could not be read: {error}"
            ))
        }
    };
    // Check explicit shared paths before watched()'s tolerant is_dir filter.
    // A missing/unreadable folder is uncertainty, not a sharing revocation.
    for root in dirs
        .environment
        .iter()
        .chain(&recorded.added)
        .chain(&recorded.running)
    {
        if recorded.choice(root).shared {
            readable_directory(root)?;
        }
    }
    if let Some(parent) = default.parent() {
        for entry in fs::read_dir(parent).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if (name == ".claude" || name.starts_with(".claude-"))
                && recorded.choice(&entry.path()).shared
            {
                // A non-directory sibling is irrelevant; a metadata failure is not.
                let _ = entry.metadata().map_err(|error| error.to_string())?;
            }
        }
    }
    let roots: Vec<_> = dirs
        .watched_recorded(default, &recorded)
        .into_iter()
        .filter(|dir| dir.shared)
        .map(|dir| dir.path)
        .collect();
    for old in cache.roots().iter().filter(|old| !roots.contains(old)) {
        if recorded.choice(old).shared {
            readable_directory(old)?;
        }
    }
    Ok(roots)
}

fn readable_directory(path: &Path) -> Result<(), String> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(format!(
            "{} is not a Claude login directory.",
            path.display()
        )),
        Err(error) => Err(format!(
            "Claude login {} is unavailable: {error}",
            path.display()
        )),
    }
}
