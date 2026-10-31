//! Project presentation shared by the Linux session models.

use crate::relay::contract::account::UploadSession;
use std::path::Path;

/// The core-resolved project, or the cwd folder for an older core.
pub fn session_project(session: &UploadSession) -> String {
    let cwd = session
        .project
        .as_deref()
        .or(session.cwd.as_deref())
        .unwrap_or("");
    let trimmed = if cwd.len() > 1 {
        cwd.strip_suffix('/').unwrap_or(cwd)
    } else {
        cwd
    };
    Path::new(trimmed)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}
