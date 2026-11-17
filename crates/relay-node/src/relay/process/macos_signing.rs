//! macOS code-signature checks for the process table, cached per file.

use std::os::unix::fs::MetadataExt;
use std::path::Path;

/// One file's identity: replacing or changing the file changes it.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Identity {
    device: u64,
    inode: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}

fn identity(path: &Path) -> Option<Identity> {
    let m = std::fs::metadata(path).ok()?;
    Some(Identity {
        device: m.dev(),
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

    pub(super) fn trusted_vscode(&self, path: &Path) -> bool {
        installed_app_file(path) && self.0.trusted(path, identity, verify_vscode_signature)
    }

    pub(super) fn trusted_copilot(&self, path: &Path) -> bool {
        let uid = crate::relay::peer::current_uid();
        std::fs::metadata(path)
            .is_ok_and(|m| (m.uid() == 0 || m.uid() == uid) && m.mode() & 0o022 == 0)
            && self
                .0
                .trusted(path, identity, |path| verify_signature(path, GITHUB))
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

fn verify_vscode_signature(path: &Path) -> bool {
    verify_signature(
        path,
        "anchor apple generic and certificate leaf[subject.OU] = \"UBF8T346G9\"",
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

const MICROSOFT: &str = "anchor apple generic and certificate leaf[subject.OU] = \"UBF8T346G9\"";
const GITHUB: &str = "anchor apple generic and certificate leaf[subject.OU] = \"VEKTX9H2N7\"";

pub(super) fn trusted_copilot_process(pid: i32) -> bool {
    trusted_process(pid, GITHUB)
}

pub(super) fn trusted_copilot_bundle(bundle: &Path) -> bool {
    trusted_bundle(bundle, GITHUB, "com.github.githubapp")
}

/// Keep the checked bundle and main executable fixed across live-process and
/// sealed-resource validation. The caller also re-reads the kernel image path:
/// macOS updates that path when a running application's bundle is renamed.
pub(super) fn stable_copilot_bundle(
    bundle: &Path,
    executable: &Path,
    verify: impl FnOnce() -> bool,
) -> bool {
    let (Some(bundle_before), Some(image_before)) = (identity(bundle), identity(executable)) else {
        return false;
    };
    verify()
        && identity(bundle) == Some(bundle_before)
        && identity(executable) == Some(image_before)
}

/// Bind validation to the live process, not a signed file replacing its path.
pub(super) fn trusted_vscode_process(pid: i32) -> bool {
    trusted_process(pid, MICROSOFT)
}

fn trusted_process(pid: i32, requirement: &str) -> bool {
    use security_framework::os::macos::code_signing::{
        Flags, GuestAttributes, SecCode, SecRequirement,
    };
    let Ok(requirement) = requirement.parse::<SecRequirement>() else {
        return false;
    };
    let mut attributes = GuestAttributes::new();
    attributes.set_pid(pid);
    SecCode::copy_guest_with_attribues(None, &attributes, Flags::NONE)
        .and_then(|code| code.check_validity(Flags::STRICT_VALIDATE, &requirement))
        .is_ok()
}

/// Check sealed application resources as well as the runtime executable. This
/// intentionally bypasses the executable cache: resources have separate inodes.
pub(super) fn trusted_vscode_bundle(bundle: &Path) -> bool {
    trusted_bundle(bundle, MICROSOFT, "com.microsoft.VSCode")
}

fn trusted_bundle(bundle: &Path, signer: &str, identifier: &str) -> bool {
    use security_framework::os::macos::code_signing::{Flags, SecRequirement, SecStaticCode};
    if !installed_app_file(bundle) {
        return false;
    }
    let Some(url) = core_foundation::url::CFURL::from_path(bundle, true) else {
        return false;
    };
    let Ok(code) = SecStaticCode::from_path(&url, Flags::NONE) else {
        return false;
    };
    let Ok(requirement) =
        format!("{signer} and identifier \"{identifier}\"").parse::<SecRequirement>()
    else {
        return false;
    };
    code.check_validity(
        Flags::STRICT_VALIDATE | Flags::CHECK_NESTED_CODE | Flags::CHECK_ALL_ARCHITECTURES,
        &requirement,
    )
    .is_ok()
}

/// The helper is a copy of this program. Validate both live code objects
/// against this program's designated requirement; a matching basename or an
/// unrelated signed executable is insufficient.
pub(super) fn trusted_relay_helper(pid: i32) -> bool {
    static REQUIREMENT: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    REQUIREMENT
        .get_or_init(own_requirement)
        .as_deref()
        .is_some_and(|r| trusted_process(pid, r))
}

fn own_requirement() -> Option<String> {
    use core_foundation::base::{CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    use security_framework::os::macos::code_signing::{Flags, SecCode, SecRequirement};

    // security-framework 3 does not yet wrap these public Security APIs. Ask
    // the running code object for its requirement rather than parsing codesign
    // output from an executable path (which can have changed since launch).
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecCodeCopyDesignatedRequirement(
            code: CFTypeRef,
            flags: u32,
            requirement: *mut CFTypeRef,
        ) -> i32;
        fn SecRequirementCopyString(
            requirement: CFTypeRef,
            flags: u32,
            text: *mut CFStringRef,
        ) -> i32;
    }

    let code = SecCode::for_self(Flags::NONE).ok()?;
    let mut raw = std::ptr::null();
    // SAFETY: code is a live SecCode object; raw is an initialized out-pointer.
    // The Copy API returns an owned requirement, adopted below only on success.
    if unsafe { SecCodeCopyDesignatedRequirement(code.as_CFTypeRef(), 0, &mut raw) } != 0
        || raw.is_null()
    {
        return None;
    }
    let requirement = unsafe { SecRequirement::wrap_under_create_rule(raw as _) };
    code.check_validity(Flags::STRICT_VALIDATE, &requirement)
        .ok()?;
    let mut text = std::ptr::null();
    // SAFETY: requirement is a valid owned object; text receives a retained
    // CFString and is adopted only after a successful non-null return.
    if unsafe { SecRequirementCopyString(requirement.as_CFTypeRef(), 0, &mut text) } != 0
        || text.is_null()
    {
        return None;
    }
    Some(unsafe { CFString::wrap_under_create_rule(text) }.to_string())
}

#[cfg(test)]
#[test]
fn the_running_helper_can_derive_and_validate_its_own_designated_requirement() {
    // arm64 test binaries are normally ad-hoc signed by the linker; an
    // unsigned x86_64 test binary must remain unavailable, rather than making
    // the test suite depend on an installed signing identity.
    let signed = std::process::Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict"])
        .arg(std::env::current_exe().unwrap())
        .output()
        .unwrap()
        .status
        .success();
    assert_eq!(own_requirement().is_some(), signed);
    assert_eq!(trusted_relay_helper(std::process::id() as i32), signed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn copilot_host_binding_rejects_bundle_or_image_replacement_during_validation() {
        for replace_bundle in [true, false] {
            let temp = tempfile::tempdir().unwrap();
            let bundle = temp.path().join("GitHub Copilot.app");
            let executable = bundle.join("Contents/MacOS/github");
            std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
            std::fs::write(&executable, b"fixture image").unwrap();
            assert!(stable_copilot_bundle(&bundle, &executable, || true));
            assert!(!stable_copilot_bundle(&bundle, &executable, || {
                if replace_bundle {
                    std::fs::rename(&bundle, temp.path().join("previous.app")).unwrap();
                    std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
                } else {
                    std::fs::rename(&executable, executable.with_extension("previous")).unwrap();
                }
                std::fs::write(&executable, b"fixture image").unwrap();
                true
            }));
        }
    }

    #[test]
    fn copilot_host_binding_rejects_a_renamed_bundle_restored_before_return() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = temp.path().join("GitHub Copilot.app");
        let executable = bundle.join("Contents/MacOS/github");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, b"fixture image").unwrap();
        assert!(!stable_copilot_bundle(&bundle, &executable, || {
            let moved = temp.path().join("previous.app");
            std::fs::rename(&bundle, &moved).unwrap();
            std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
            std::fs::write(&executable, b"replacement image").unwrap();
            std::fs::remove_dir_all(&bundle).unwrap();
            std::fs::rename(&moved, &bundle).unwrap();
            true
        }));
    }

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
