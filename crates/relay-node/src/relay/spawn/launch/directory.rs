//! Whether a spawn's working folder is there and can be read.

use std::path::{Path, PathBuf};

/// Check actual directory access, not just its existence. In particular,
/// macOS can allow `stat` while denying a launchd job access to a removable
/// volume. Bun reports that denial as `Unexpected` and, at launchd's usual
/// soft limit of 256, misleadingly suggests raising the descriptor limit.
/// This does filesystem I/O and must run off the async runtime.
pub(in crate::relay::spawn) fn check_directory(directory: &Path) -> Result<(), DirectoryError> {
    let metadata =
        std::fs::metadata(directory).map_err(|error| directory_error(directory, error))?;
    if !metadata.is_dir() {
        return Err(DirectoryError::Missing(directory.to_path_buf()));
    }
    let mut entries =
        std::fs::read_dir(directory).map_err(|error| directory_error(directory, error))?;
    // Some platforms defer reading the directory until the first entry.
    if let Some(entry) = entries.next() {
        entry.map_err(|error| directory_error(directory, error))?;
    }
    Ok(())
}

/// Why `check_directory` refused a working folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::relay::spawn) enum DirectoryError {
    /// Nothing is there, or it is not a folder.
    Missing(PathBuf),
    /// It is there but could not be read: the whole reason, naming it.
    Unreadable(String),
}

impl std::fmt::Display for DirectoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing(directory) => {
                write!(
                    f,
                    "{} is not a folder on this computer",
                    directory.display()
                )
            }
            Self::Unreadable(reason) => f.write_str(reason),
        }
    }
}

impl std::error::Error for DirectoryError {}

pub(super) fn directory_error(directory: &Path, error: std::io::Error) -> DirectoryError {
    if error.kind() == std::io::ErrorKind::NotFound {
        return DirectoryError::Missing(directory.to_path_buf());
    }
    let reason = format!(
        "Agent Relay could not read the working folder {}: {error}.",
        directory.display()
    );
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        #[cfg(target_os = "macos")]
        return DirectoryError::Unreadable(format!("{reason} Allow Agent Relay to access this folder in System Settings → Privacy & Security → Files and Folders, then retry."));
        #[cfg(not(target_os = "macos"))]
        return DirectoryError::Unreadable(format!("{reason} Give the account running Agent Relay permission to read and search this folder, then retry."));
    }
    DirectoryError::Unreadable(reason)
}
