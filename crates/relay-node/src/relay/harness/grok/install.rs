//! Which Grok this computer runs, and whether it is recent enough to spawn.

use super::MIN_VERSION;
use crate::relay::existing_session::platform;
use std::path::{Path, PathBuf};

/// Why Grok is installed but cannot be spawned here.
pub fn too_old(version: (u32, u32, u32)) -> String {
    let (major, minor, patch) = version;
    let (min_major, min_minor, min_patch) = MIN_VERSION;
    format!(
        "Grok here is version {major}.{minor}.{patch}, older than {min_major}.{min_minor}.{min_patch}, the first that spawned Grok agents run on. Update it with `grok update`, then try again."
    )
}

/// The version of the Grok at `executable`, from the file Grok's installer
/// names for it (`~/.grok/bin/grok` links to
/// `~/.grok/downloads/grok-1.0.46-macos-aarch64`); `None` for a Grok
/// installed some other way. Files only: Grok is never run to ask.
pub fn version_of(executable: &Path) -> Option<(u32, u32, u32)> {
    let resolved = std::fs::canonicalize(executable).ok()?;
    let name = resolved.file_name()?.to_str()?;
    let version = name.strip_prefix("grok-")?.split('-').next()?;
    let mut parts = version.split('.').map(|part| part.parse::<u32>().ok());
    let found = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(found)
}

/// The `grok` this computer runs: `bin/grok` in Grok's home, where Grok
/// installs itself, else the first on `PATH`.
pub fn find_executable(path: Option<&str>, grok_home: &Path) -> Option<PathBuf> {
    std::iter::once(grok_home.join("bin/grok"))
        .chain(
            path.unwrap_or_default()
                .split(':')
                .filter(|dir| dir.starts_with('/'))
                .map(|dir| Path::new(dir).join("grok")),
        )
        .find(|candidate| {
            std::fs::metadata(candidate).is_ok_and(|metadata| {
                metadata.is_file()
                    && platform::PermissionsExt::mode(&metadata.permissions()) & 0o111 != 0
            })
        })
}
