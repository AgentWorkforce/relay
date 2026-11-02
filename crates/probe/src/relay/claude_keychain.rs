//! Claude Code's claude.ai login in the macOS login Keychain: a generic
//! password, service `Claude Code-credentials`, account the login user name.
//! Claude Code created the item, so macOS asks the person before another app
//! reads it. That prompt belongs to a moment the person chose: turning
//! Claude Code cloud sessions on, or opening one. Every other read is quiet:
//! it fails at once instead of asking.
//!
//! Reads are one at a time per process, because a quiet read turns the
//! Keychain's user interaction off for the whole process while it runs.

/// The Keychain service Claude Code keeps its claude.ai login under.
pub const SERVICE: &str = "Claude Code-credentials";

/// A Keychain read failed. The OSStatus is safe to report and is the only
/// detail retained; the item, account and secret never cross this boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReadError {
    pub code: Option<i32>,
}

impl ReadError {
    pub const fn unknown() -> Self {
        Self { code: None }
    }
}

#[cfg(target_os = "macos")]
static READING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Claude Code files its item under the login user name.
#[cfg(target_os = "macos")]
fn account() -> Option<String> {
    if let Some(user) = std::env::var("USER").ok().filter(|u| !u.is_empty()) {
        return Some(user);
    }
    nix::unistd::User::from_uid(nix::unistd::getuid())
        .ok()
        .flatten()
        .map(|user| user.name)
}

/// Whether the item exists, by its attributes only: never reads the secret,
/// so it never prompts.
#[cfg(target_os = "macos")]
pub fn present() -> bool {
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
    let Some(account) = account() else {
        return false;
    };
    ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(SERVICE)
        .account(&account)
        .load_attributes(true)
        .limit(Limit::Max(1))
        .search()
        .is_ok_and(|found| !found.is_empty())
}

/// The item's secret: Claude Code's credentials JSON. A quiet read
/// (`interactive` false) never shows macOS's prompt; it returns an error unless
/// the person already chose Always Allow. An interactive read waits until the
/// person answers the prompt.
#[cfg(target_os = "macos")]
pub fn read(interactive: bool) -> Result<Vec<u8>, ReadError> {
    use security_framework::os::macos::keychain::SecKeychain;
    let account = account().ok_or_else(ReadError::unknown)?;
    let _one = READING.lock().unwrap_or_else(|e| e.into_inner());
    // `kSecUseAuthenticationUI` does not cover another app's item's access
    // list; turning user interaction off does.
    let _quiet = if interactive {
        None
    } else {
        Some(
            SecKeychain::disable_user_interaction().map_err(|error| ReadError {
                code: Some(error.code()),
            })?,
        )
    };
    security_framework::passwords::generic_password(
        security_framework::passwords::PasswordOptions::new_generic_password(SERVICE, &account),
    )
    .map_err(|error| ReadError {
        code: Some(error.code()),
    })
}

/// Asks macOS for access to the item now, on a thread of its own, when it
/// exists and a quiet read is refused: the person just turned Claude Code
/// cloud sessions on and is at the screen to answer. At most one ask is
/// pending; `wanted` is checked again just before the prompt, so a person
/// who turned the setting back off meanwhile is not asked. The secret is
/// dropped unused; only the person's answer matters.
#[cfg(target_os = "macos")]
pub fn ask_access(wanted: fn() -> bool) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static ASKING: AtomicBool = AtomicBool::new(false);
    /// Lets the next ask start when dropped, also when the ask panicked or
    /// its thread never started.
    struct Asking;
    impl Drop for Asking {
        fn drop(&mut self) {
            ASKING.store(false, Ordering::Release);
        }
    }
    if ASKING.swap(true, Ordering::AcqRel) {
        return;
    }
    let asking = Asking;
    let _ = std::thread::Builder::new()
        .name("claude-keychain-ask".into())
        .spawn(move || {
            let _asking = asking;
            if present() && read(false).map(|mut secret| secret.fill(0)).is_err() && wanted() {
                if let Ok(mut secret) = read(true) {
                    secret.fill(0);
                }
            }
        });
}

/// No Keychain off macOS: Claude Code keeps its login in its credentials
/// file there.
#[cfg(not(target_os = "macos"))]
pub fn ask_access(_wanted: fn() -> bool) {}
