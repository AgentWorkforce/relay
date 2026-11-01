//! macOS code-signature checks for the process table, cached per file.

use std::os::unix::fs::MetadataExt;
use std::path::Path;

/// One file's identity: replacing or changing the file changes it.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Identity {
    inode: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}

fn identity(path: &Path) -> Option<Identity> {
    let m = std::fs::metadata(path).ok()?;
    Some(Identity {
        inode: m.ino(),
        mtime: (m.mtime(), m.mtime_nsec()),
        ctime: (m.ctime(), m.ctime_nsec()),
    })
}

/// Code-signature validation is slow; its result is kept while the path
/// names the same unchanged file.
#[derive(Default)]
pub struct SignatureCache(super::signature_cache::Cache<Identity>);

impl SignatureCache {
    pub(super) fn trusted(&self, path: &Path) -> bool {
        self.0.trusted(path, identity, verify_codex_signature)
    }

    /// Cursor's own: an installed app file (`installed_app_file`) validly
    /// signed by Cursor's developer.
    pub(super) fn trusted_cursor(&self, path: &Path) -> bool {
        installed_app_file(path) && self.0.trusted(path, identity, verify_cursor_signature)
    }
}

/// Whether `path` sits where an installed app does: under `/Applications`
/// or `~/Applications` (the home Agent Relay keeps this user's files in),
/// owned by root or this user and writable by no one else. A signed copy of
/// Cursor's helper anywhere else is not Cursor's install.
fn installed_app_file(path: &Path) -> bool {
    let uid = crate::relay::peer::current_uid();
    let rooted = path.starts_with("/Applications")
        || crate::relay::paths::home()
            .is_ok_and(|home| path.starts_with(home.join("Applications")));
    rooted
        && std::fs::metadata(path)
            .is_ok_and(|m| (m.uid() == 0 || m.uid() == uid) && m.mode() & 0o022 == 0)
}

/// OpenAI's Codex: identifier `codex`, team `2DC432GLL2`, strictly
/// valid.
fn verify_codex_signature(path: &Path) -> bool {
    verify_signature(
        path,
        "anchor apple generic and identifier \"codex\" and certificate leaf[subject.OU] = \"2DC432GLL2\"",
    )
}

/// Cursor (Anysphere): team `VDXQ22DGB9`, strictly valid. Its helpers
/// keep Electron's identifiers, so the team alone names it.
fn verify_cursor_signature(path: &Path) -> bool {
    verify_signature(
        path,
        "anchor apple generic and certificate leaf[subject.OU] = \"VDXQ22DGB9\"",
    )
}

fn verify_signature(path: &Path, requirement: &str) -> bool {
    use security_framework::os::macos::code_signing::{Flags, SecRequirement, SecStaticCode};
    let Some(url) = core_foundation_url(path) else {
        return false;
    };
    let Ok(code) = SecStaticCode::from_path(&url, Flags::NONE) else {
        return false;
    };
    let Ok(requirement) = requirement.parse::<SecRequirement>() else {
        return false;
    };
    code.check_validity(Flags::STRICT_VALIDATE, &requirement)
        .is_ok()
}

fn core_foundation_url(path: &Path) -> Option<core_foundation::url::CFURL> {
    core_foundation::url::CFURL::from_path(path, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn a_file_outside_the_app_folders_is_never_installed() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Cursor Helper (Plugin)");
        std::fs::write(&file, b"").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!installed_app_file(&file));
        assert!(!installed_app_file(Path::new(
            "/Applications-copy/Cursor.app/Contents/MacOS/Cursor"
        )));
    }
}
