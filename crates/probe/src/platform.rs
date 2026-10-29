//! The few operating-system facts the core needs that Unix and Windows
//! spell differently: owner-only files, stopping and grouping processes,
//! and finding a command the way a shell would.
//!
//! Callers stay free of `cfg` soup: each function here has a Unix and a
//! Windows body with the same meaning, and where Windows has no counterpart
//! the doc comment says what the Windows body does instead.

pub mod exe;
pub mod fs;
#[cfg(windows)]
pub mod pipe;
pub mod process;

use std::path::PathBuf;

/// The person's home folder: `HOME` on Unix; on Windows the profile,
/// `USERPROFILE`, where Claude Code and Codex keep their files, and `HOME`
/// only without one (MSYS2 and Git Bash set `HOME` to a home of their own).
pub fn home_dir() -> Option<PathBuf> {
    let read = |key: &str| std::env::var_os(key).filter(|value| !value.is_empty());
    #[cfg(windows)]
    let home = read("USERPROFILE")
        .map(PathBuf::from)
        .or_else(windows_profile)
        .or_else(|| read("HOME").map(PathBuf::from));
    #[cfg(not(windows))]
    let home = read("HOME").map(PathBuf::from);
    home
}

/// This account's profile folder as Windows knows it, whatever the
/// environment says: an MSYS2 login shell blanks `USERPROFILE`.
#[cfg(windows)]
fn windows_profile() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Security::TOKEN_QUERY;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows_sys::Win32::UI::Shell::GetUserProfileDirectoryW;
    let mut token = std::ptr::null_mut();
    // SAFETY: the current process handle needs no closing; the token is
    // closed below; the buffer is sized by the length the first call sets.
    unsafe {
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut length: u32 = 0;
        GetUserProfileDirectoryW(token, std::ptr::null_mut(), &mut length);
        let mut buffer = vec![0u16; length as usize];
        let ok = GetUserProfileDirectoryW(token, buffer.as_mut_ptr(), &mut length);
        CloseHandle(token);
        if ok == 0 || length == 0 {
            return None;
        }
        let path = std::ffi::OsString::from_wide(&buffer[..length as usize - 1]);
        (!path.is_empty()).then(|| PathBuf::from(path))
    }
}

/// On Windows, makes `HOME` (and an unset `USERPROFILE`) the profile for
/// this process and its children when a shell set them otherwise: MSYS2 and
/// Git Bash give `HOME` a home of their own, and RelayHistory and other
/// libraries read `HOME` first, which would send the session collector to a
/// home with no Claude Code or Codex sessions in it. Called first thing by
/// both executables; nothing on Unix.
pub fn adopt_profile_home() {
    #[cfg(windows)]
    {
        let Some(profile) = home_dir() else {
            return;
        };
        for key in ["HOME", "USERPROFILE"] {
            if std::env::var_os(key).is_none_or(|value| value != profile.as_os_str()) {
                std::env::set_var(key, &profile);
            }
        }
    }
}

/// This person's login name: the password database's entry for this uid on
/// Unix, `USERNAME` on Windows. `None` when it cannot be told.
pub fn user_name() -> Option<String> {
    #[cfg(unix)]
    {
        nix::unistd::User::from_uid(nix::unistd::getuid())
            .ok()
            .flatten()
            .map(|user| user.name)
            .filter(|name| !name.is_empty())
    }
    #[cfg(windows)]
    {
        std::env::var("USERNAME")
            .ok()
            .filter(|name| !name.is_empty())
    }
}
