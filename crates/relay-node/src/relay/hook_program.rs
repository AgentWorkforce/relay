//! The program Agent Relay's Codex hook runs, at a path that outlives an
//! update on Windows.
//!
//! Codex trusts a hook by a hash of its `hooks.json` entry, command
//! included. Windows installs each release in a folder of its own
//! (`%LOCALAPPDATA%\Programs\AgentRelay\<version>\…`), so a hook naming the
//! running probe changed with every update, and Codex asked the person to
//! review all of Agent Relay's hooks again; until they did, every turn ran
//! an untrusted hook (relay#2239). Trusting it again through Codex's
//! app-server needs a Codex that answers, which the Store app's bundled one
//! does not.
//!
//! So on Windows the hook runs a copy of the probe kept in the core's own
//! data folder (`<app data>\bin\agent-relay-probe.exe`), brought up to date
//! at each core start before the hook is refreshed. The command never
//! changes, so the trust Codex recorded stays.
//!
//! The copy is used only when no one else can replace it. Before anything
//! is written, the folder and every folder above it are read from their
//! Windows access lists: none may be a link or junction, each must be owned
//! by this person, SYSTEM, Administrators or TrustedInstaller, and no one
//! else may be allowed to write into the folder or to delete, rename or
//! re-permission it or anything above it. The copy itself must be a regular
//! file of exactly this probe's contents with the same owners and no one
//! else allowed to change it, checked again on every start. An access list
//! that cannot be read, or that holds an entry this check cannot judge,
//! counts as shared. In any of those cases, and on any failure, the hook
//! names the installed probe as before. Nothing here changes an access list
//! or widens who may run or replace the copy.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

/// The folder under the core's data folder that holds the copy.
pub const DIR: &str = "bin";

/// The program the Codex hook names for `probe`, the running executable:
/// on Windows a copy of it in `app_data_dir`, kept up to date; elsewhere,
/// and whenever the copy cannot be kept safely, `probe` itself.
pub fn stable(probe: &Path, app_data_dir: &Path) -> PathBuf {
    if !cfg!(windows) {
        return probe.to_path_buf();
    }
    match keep_copy(probe, &app_data_dir.join(DIR)) {
        Ok(copy) => copy,
        Err(error) => {
            crate::relay::diagnostics::write(format_args!(
                "relay: the Codex hook names the installed probe; its stable copy could not be \
kept: {error}"
            ));
            probe.to_path_buf()
        }
    }
}

/// Keeps a copy of `probe` in `dir` under the probe's own file name and
/// returns its path. An up-to-date copy is left alone; a stale one is
/// replaced without ever leaving the path empty for longer than a rename.
pub fn keep_copy(probe: &Path, dir: &Path) -> io::Result<PathBuf> {
    let name = probe
        .file_name()
        .ok_or_else(|| io::Error::other("the probe has no file name"))?;
    crate::platform::fs::create_private_dir_all(dir)?;
    let folder = fs::symlink_metadata(dir)?;
    if !folder.is_dir()
        || folder.file_type().is_symlink()
        || !crate::platform::fs::owned_by_current_user(&folder)
        || !crate::platform::fs::private_to_owner(&folder, 0o022)
    {
        return Err(io::Error::other(
            "the copy's folder is not a private folder of this person's",
        ));
    }
    #[cfg(windows)]
    windows::private_folder(dir)?;
    let copy = dir.join(name);
    match fs::symlink_metadata(&copy) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(io::Error::other(
                "something other than the copy is in its place",
            ));
        }
        Ok(_) if same_contents(probe, &copy).unwrap_or(false) => {
            #[cfg(windows)]
            windows::private_file(&copy)?;
            return Ok(copy);
        }
        Ok(_) | Err(_) => {}
    }
    replace(probe, &copy)?;
    if !same_contents(probe, &copy)? {
        return Err(io::Error::other("the copy does not match the probe"));
    }
    #[cfg(windows)]
    windows::private_file(&copy)?;
    Ok(copy)
}

/// Writes `probe` to `copy` through a staged file. Windows refuses to
/// overwrite or delete a program that is running (a hook may be), but lets
/// it be renamed, so a copy in place is moved aside first and removed when
/// it can be.
fn replace(probe: &Path, copy: &Path) -> io::Result<()> {
    let staged = sibling(copy, ".new");
    let _ = fs::remove_file(&staged);
    fs::copy(probe, &staged)?;
    let aside = sibling(copy, ".old");
    if fs::symlink_metadata(copy).is_ok() {
        let _ = fs::remove_file(&aside);
        if let Err(error) = fs::rename(copy, &aside) {
            let _ = fs::remove_file(&staged);
            return Err(error);
        }
    }
    if let Err(error) = fs::rename(&staged, copy) {
        // Put the earlier copy back, so the hook still has a program.
        let _ = fs::rename(&aside, copy);
        let _ = fs::remove_file(&staged);
        return Err(error);
    }
    // Still running in a hook, it stays until the next start.
    let _ = fs::remove_file(&aside);
    Ok(())
}

/// `path` with `suffix` added to its file name.
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Whether `left` and `right` hold the same bytes: sizes first, so a stale
/// copy is found without reading it, then both files once side by side.
fn same_contents(left: &Path, right: &Path) -> io::Result<bool> {
    let (mut left, mut right) = (fs::File::open(left)?, fs::File::open(right)?);
    if left.metadata()?.len() != right.metadata()?.len() {
        return Ok(false);
    }
    let (mut a, mut b) = (vec![0u8; 256 * 1024], vec![0u8; 256 * 1024]);
    loop {
        let count = read_full(&mut left, &mut a)?;
        if read_full(&mut right, &mut b[..count.max(1)])? != count || a[..count] != b[..count] {
            return Ok(false);
        }
        if count == 0 {
            return Ok(true);
        }
    }
}

/// Fills `buffer` from `file` as far as the file goes; the count read.
fn read_full(file: &mut fs::File, buffer: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..])? {
            0 => break,
            count => filled += count,
        }
    }
    Ok(filled)
}

/// Whether a folder or file on Windows can be changed by no one but this
/// person and the system's own accounts, read from its access list.
#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;
    use std::path::Path;
    use windows_sys::Win32::Foundation::{LocalFree, ERROR_SUCCESS};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        GetAce, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    };

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    const INHERIT_ONLY_ACE: u8 = 0x08;
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    /// The denying entry types: skipping one only overstates what others
    /// may do, so the check stays on the safe side.
    const DENIED_ACE_TYPES: [u8; 4] = [1, 6, 10, 12];

    const FILE_WRITE_DATA: u32 = 0x2; // adding a file, on a folder
    const FILE_APPEND_DATA: u32 = 0x4; // adding a folder, on a folder
    const FILE_DELETE_CHILD: u32 = 0x40;
    const DELETE: u32 = 0x1_0000;
    const WRITE_DAC: u32 = 0x4_0000;
    const WRITE_OWNER: u32 = 0x8_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const GENERIC_ALL: u32 = 0x1000_0000;

    /// What no one else may do to the copy or the folder holding it:
    /// write, add, delete, rename or re-permission.
    const LEAF_RISK: u32 = FILE_WRITE_DATA
        | FILE_APPEND_DATA
        | FILE_DELETE_CHILD
        | DELETE
        | WRITE_DAC
        | WRITE_OWNER
        | GENERIC_WRITE
        | GENERIC_ALL;
    /// What no one else may do to a folder above it: delete, rename or
    /// re-permission it or its children. Adding entries is allowed, as
    /// `C:\` and `C:\Users` allow it to every signed-in person.
    const ANCESTOR_RISK: u32 = FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_ALL;

    /// SYSTEM, Administrators and TrustedInstaller, which can change any
    /// file anyway; CREATOR OWNER and OWNER RIGHTS, which stand for the
    /// owner, who is checked to be trusted first.
    const SYSTEM_SIDS: [&str; 5] = [
        "S-1-5-18",
        "S-1-5-32-544",
        "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
        "S-1-3-0",
        "S-1-3-4",
    ];

    /// `dir` and every folder above it: see the module comment.
    pub fn private_folder(dir: &Path) -> io::Result<()> {
        let user = crate::relay::peer::current_user_sid()?;
        let dir = std::path::absolute(dir)?;
        for (index, folder) in dir.ancestors().enumerate() {
            let leaf = index == 0;
            let risk = if leaf { LEAF_RISK } else { ANCESTOR_RISK };
            check(folder, &user, risk, leaf)?;
        }
        Ok(())
    }

    /// The copy itself.
    pub fn private_file(file: &Path) -> io::Result<()> {
        let user = crate::relay::peer::current_user_sid()?;
        check(&std::path::absolute(file)?, &user, LEAF_RISK, false)
    }

    fn shared(path: &Path, why: &str) -> io::Error {
        io::Error::other(format!("{} {why}", path.display()))
    }

    /// One folder or file. `inherited_too` also judges the entries that only
    /// pass to what is created inside, as the copy is.
    fn check(path: &Path, user: &str, risk: u32, inherited_too: bool) -> io::Result<()> {
        let metadata = std::fs::symlink_metadata(path)?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(shared(path, "is a link or junction"));
        }
        let trusted = |sid: &str| {
            sid.eq_ignore_ascii_case(user)
                || SYSTEM_SIDS
                    .iter()
                    .any(|known| sid.eq_ignore_ascii_case(known))
        };
        let security = Security::read(path)?;
        if !trusted(&security.owner()?) {
            return Err(shared(path, "is owned by someone else"));
        }
        let Some(dacl) = security.dacl() else {
            return Err(shared(path, "has no access list, so anyone may change it"));
        };
        // SAFETY: `dacl` is the valid ACL inside the descriptor `security`
        // holds; it is only read while `security` lives.
        let count = unsafe { (*dacl).AceCount };
        for index in 0..u32::from(count) {
            let mut ace: *mut c_void = std::ptr::null_mut();
            // SAFETY: `index` is below the ACL's count; `ace` receives a
            // pointer into the same ACL.
            if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: every ACE starts with an ACE_HEADER.
            let header = unsafe { std::ptr::read_unaligned(ace.cast::<ACE_HEADER>()) };
            if DENIED_ACE_TYPES.contains(&header.AceType) {
                continue;
            }
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE {
                return Err(shared(path, "has an access entry this check cannot judge"));
            }
            if !inherited_too && header.AceFlags & INHERIT_ONLY_ACE != 0 {
                continue;
            }
            // SAFETY: an ACCESS_ALLOWED_ACE, whose SID starts at SidStart
            // and lies within the ACE.
            let (mask, sid) = unsafe {
                let allowed = ace.cast::<ACCESS_ALLOWED_ACE>();
                (
                    std::ptr::read_unaligned(std::ptr::addr_of!((*allowed).Mask)),
                    std::ptr::addr_of_mut!((*allowed).SidStart).cast::<c_void>(),
                )
            };
            if mask & risk != 0 && !trusted(&sid_string(sid)?) {
                return Err(shared(path, "lets someone else change or replace it"));
            }
        }
        Ok(())
    }

    /// A security descriptor read from a path, freed on drop.
    struct Security {
        descriptor: PSECURITY_DESCRIPTOR,
        owner: PSID,
        dacl: *mut ACL,
    }

    impl Security {
        fn read(path: &Path) -> io::Result<Security> {
            let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let mut security = Security {
                descriptor: std::ptr::null_mut(),
                owner: std::ptr::null_mut(),
                dacl: std::ptr::null_mut(),
            };
            // SAFETY: `wide` is NUL-terminated and outlives the call; on
            // success `descriptor` is LocalAlloc'd (freed in Drop) and the
            // owner and DACL point into it.
            let status = unsafe {
                GetNamedSecurityInfoW(
                    wide.as_ptr(),
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    &mut security.owner,
                    std::ptr::null_mut(),
                    &mut security.dacl,
                    std::ptr::null_mut(),
                    &mut security.descriptor,
                )
            };
            if status != ERROR_SUCCESS {
                return Err(io::Error::from_raw_os_error(status as i32));
            }
            Ok(security)
        }

        fn owner(&self) -> io::Result<String> {
            if self.owner.is_null() {
                return Err(io::Error::other("the access list names no owner"));
            }
            sid_string(self.owner)
        }

        fn dacl(&self) -> Option<*mut ACL> {
            (!self.dacl.is_null()).then_some(self.dacl)
        }
    }

    impl Drop for Security {
        fn drop(&mut self) {
            // SAFETY: allocated by GetNamedSecurityInfoW and freed once.
            unsafe { LocalFree(self.descriptor) };
        }
    }

    fn sid_string(sid: PSID) -> io::Result<String> {
        let mut text: *mut u16 = std::ptr::null_mut();
        // SAFETY: `sid` is valid for the call; on success `text` is a
        // LocalAlloc'd NUL-terminated string, read once and freed once.
        unsafe {
            if ConvertSidToStringSidW(sid, &mut text) == 0 {
                return Err(io::Error::last_os_error());
            }
            let length = (0..).take_while(|&index| *text.add(index) != 0).count();
            let string = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
            LocalFree(text.cast());
            Ok(string)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(dir: &Path, contents: &[u8]) -> PathBuf {
        let path = dir.join("agent-relay-probe.exe");
        fs::write(&path, contents).unwrap();
        path
    }

    /// A folder to work in that no one else may change. On Windows that is
    /// not `%TEMP%`, which a sandbox (Codex's `CodexSandboxUsers`) may be
    /// allowed to modify, so the folder is made in the profile and given an
    /// access list of its own.
    fn temp() -> tempfile::TempDir {
        #[cfg(windows)]
        {
            let home = crate::platform::home_dir().unwrap();
            let dir = tempfile::Builder::new()
                .prefix(".agent-relay-hook-test-")
                .tempdir_in(home)
                .unwrap();
            access_lists::set(dir.path(), access_lists::PRIVATE);
            dir
        }
        #[cfg(not(windows))]
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn a_copy_is_made_and_kept_at_one_path_across_updates() {
        let temp = temp();
        let old_release = temp.path().join("2026.11.21");
        let new_release = temp.path().join("2026.11.28");
        fs::create_dir_all(&old_release).unwrap();
        fs::create_dir_all(&new_release).unwrap();
        let data = temp.path().join("app-data").join(DIR);

        let first = keep_copy(&probe(&old_release, b"old build"), &data).unwrap();
        assert_eq!(first, data.join("agent-relay-probe.exe"));
        assert_eq!(fs::read(&first).unwrap(), b"old build");

        let second = keep_copy(&probe(&new_release, b"new build"), &data).unwrap();
        assert_eq!(second, first, "the hook's command does not change");
        assert_eq!(fs::read(&second).unwrap(), b"new build");
        assert!(!sibling(&second, ".old").exists());
        assert!(!sibling(&second, ".new").exists());
    }

    #[test]
    fn an_up_to_date_copy_is_left_alone() {
        let temp = temp();
        let source = probe(temp.path(), b"build");
        let data = temp.path().join("bin");
        let copy = keep_copy(&source, &data).unwrap();
        let before = fs::metadata(&copy).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        keep_copy(&source, &data).unwrap();
        assert_eq!(fs::metadata(&copy).unwrap().modified().unwrap(), before);
    }

    #[test]
    fn a_folder_in_the_copys_place_is_never_replaced() {
        let temp = temp();
        let source = probe(temp.path(), b"build");
        let data = temp.path().join("bin");
        fs::create_dir_all(data.join("agent-relay-probe.exe")).unwrap();
        assert!(keep_copy(&source, &data).is_err());
        assert!(data.join("agent-relay-probe.exe").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_copys_place_is_never_followed_or_replaced() {
        let temp = temp();
        let source = probe(temp.path(), b"build");
        let elsewhere = temp.path().join("elsewhere");
        fs::write(&elsewhere, b"someone else's").unwrap();
        let data = temp.path().join("bin");
        fs::create_dir_all(&data).unwrap();
        std::os::unix::fs::symlink(&elsewhere, data.join("agent-relay-probe.exe")).unwrap();
        assert!(keep_copy(&source, &data).is_err());
        assert_eq!(fs::read(&elsewhere).unwrap(), b"someone else's");
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_folder_is_refused() {
        let temp = temp();
        let source = probe(temp.path(), b"build");
        let real = temp.path().join("real");
        fs::create_dir_all(&real).unwrap();
        let data = temp.path().join("bin");
        std::os::unix::fs::symlink(&real, &data).unwrap();
        assert!(keep_copy(&source, &data).is_err());
        assert!(!real.join("agent-relay-probe.exe").exists());
    }

    #[test]
    fn off_windows_the_hook_names_the_probe() {
        if cfg!(windows) {
            return;
        }
        let temp = temp();
        let source = probe(temp.path(), b"build");
        assert_eq!(stable(&source, &temp.path().join("data")), source);
        assert!(!temp.path().join("data").exists());
    }

    #[cfg(windows)]
    #[test]
    fn a_running_copy_is_moved_aside_and_replaced() {
        // Windows will not overwrite an open program but lets it be renamed;
        // an open handle without delete sharing stands in for a running hook.
        use std::os::windows::fs::OpenOptionsExt;
        let temp = temp();
        let data = temp.path().join("bin");
        let old = temp.path().join("old");
        fs::create_dir_all(&old).unwrap();
        let copy = keep_copy(&probe(&old, b"old build"), &data).unwrap();
        let _running = fs::OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x4) // FILE_SHARE_READ | FILE_SHARE_DELETE
            .open(&copy)
            .unwrap();
        let new = temp.path().join("new");
        fs::create_dir_all(&new).unwrap();
        let replaced = keep_copy(&probe(&new, b"new build"), &data).unwrap();
        assert_eq!(replaced, copy);
        assert_eq!(fs::read(&replaced).unwrap(), b"new build");
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_others_may_write_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let temp = temp();
        let source = probe(temp.path(), b"build");
        let data = temp.path().join("bin");
        fs::create_dir_all(&data).unwrap();
        fs::set_permissions(&data, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(keep_copy(&source, &data).is_err());
        assert!(!data.join("agent-relay-probe.exe").exists());
    }

    /// Access lists set from SDDL, as an administrator or another program
    /// might leave them; `{me}` stands for this person's SID.
    #[cfg(windows)]
    mod access_lists {
        use super::*;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        };
        use windows_sys::Win32::Security::{SetFileSecurityW, DACL_SECURITY_INFORMATION};

        const PROTECTED_DACL_SECURITY_INFORMATION: u32 = 0x8000_0000;

        /// Only this person and SYSTEM, passed to what is created inside.
        pub(super) const PRIVATE: &str = "D:P(A;OICI;FA;;;{me})(A;OICI;FA;;;SY)";

        pub(super) fn set(path: &Path, sddl: &str) {
            let me = crate::relay::peer::current_user_sid().unwrap();
            let sddl: Vec<u16> = sddl
                .replace("{me}", &me)
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let mut descriptor = std::ptr::null_mut();
            // SAFETY: both strings are NUL-terminated and outlive the calls;
            // the descriptor is LocalAlloc'd by the conversion and freed once.
            unsafe {
                assert_ne!(
                    ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        sddl.as_ptr(),
                        SDDL_REVISION_1,
                        &mut descriptor,
                        std::ptr::null_mut(),
                    ),
                    0,
                    "{}",
                    io::Error::last_os_error()
                );
                let set = SetFileSecurityW(
                    wide.as_ptr(),
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    descriptor,
                );
                let error = io::Error::last_os_error();
                LocalFree(descriptor);
                assert_ne!(set, 0, "{error}");
            }
        }

        /// A probe, and a data folder whose `bin` folder exists with `sddl`.
        fn shared_bin(temp: &Path, sddl: &str) -> (PathBuf, PathBuf) {
            let source = probe(temp, b"build");
            let data = temp.join("app-data");
            fs::create_dir_all(data.join(DIR)).unwrap();
            set(&data.join(DIR), sddl);
            (source, data)
        }

        #[test]
        fn a_private_folder_takes_the_copy() {
            let temp = temp();
            let (source, data) = shared_bin(temp.path(), PRIVATE);
            let copy = stable(&source, &data);
            assert_eq!(copy, data.join(DIR).join("agent-relay-probe.exe"));
            assert_eq!(fs::read(&copy).unwrap(), b"build");
        }

        #[test]
        fn a_folder_others_may_write_is_refused_before_anything_is_written() {
            let temp = temp();
            // Built-in Users may modify.
            let (source, data) = shared_bin(
                temp.path(),
                "D:P(A;OICI;FA;;;{me})(A;OICI;FA;;;SY)(A;OICI;0x1301bf;;;BU)",
            );
            assert_eq!(
                stable(&source, &data),
                source,
                "the hook names the installed probe"
            );
            assert!(fs::read_dir(data.join(DIR)).unwrap().next().is_none());
        }

        #[test]
        fn a_copy_in_a_folder_that_became_shared_is_neither_used_nor_touched() {
            let temp = temp();
            let (source, data) = shared_bin(temp.path(), PRIVATE);
            let copy = stable(&source, &data);
            assert_ne!(copy, source);
            // Everyone may now add and delete files there.
            set(&data.join(DIR), "D:P(A;OICI;FA;;;{me})(A;;0x47;;;WD)");
            let newer = probe(&temp.path().join("new").tap_create(), b"new build");
            assert_eq!(stable(&newer, &data), newer);
            assert_eq!(stable(&source, &data), source, "even while up to date");
            assert_eq!(fs::read(&copy).unwrap(), b"build");
        }

        #[test]
        fn a_folder_above_that_lets_others_delete_or_rename_is_refused() {
            let temp = temp();
            let (source, data) = shared_bin(temp.path(), PRIVATE);
            // Users may delete the data folder's children (so rename `bin`)
            // without any right on `bin` itself.
            set(
                &data,
                "D:P(A;;FA;;;{me})(A;;FA;;;SY)(A;;0x1200a9;;;BU)(A;;0x40;;;BU)",
            );
            assert_eq!(stable(&source, &data), source);
            assert!(!data.join(DIR).join("agent-relay-probe.exe").exists());
        }

        #[test]
        fn a_copy_others_may_replace_is_refused() {
            let temp = temp();
            let (source, data) = shared_bin(temp.path(), PRIVATE);
            let copy = stable(&source, &data);
            set(&copy, "D:P(A;;FA;;;{me})(A;;0x120116;;;BU)"); // Users may write it
            assert_eq!(stable(&source, &data), source);
        }

        #[test]
        fn an_access_list_that_cannot_be_judged_counts_as_shared() {
            let temp = temp();
            // A conditional entry: who it admits depends on claims this
            // check does not evaluate, even though it grants only reading.
            let (source, data) = shared_bin(
                temp.path(),
                "D:P(A;OICI;FA;;;{me})(XA;OICI;FR;;;WD;(Member_of {SID(BA)}))",
            );
            assert_eq!(stable(&source, &data), source);
            // No access list at all lets anyone do anything.
            let (source, data) = shared_bin(
                &temp.path().join("other").tap_create(),
                "D:NO_ACCESS_CONTROL",
            );
            assert_eq!(stable(&source, &data), source);
            assert!(!data.join(DIR).join("agent-relay-probe.exe").exists());
        }

        trait TapCreate {
            fn tap_create(self) -> Self;
        }

        impl TapCreate for PathBuf {
            fn tap_create(self) -> Self {
                fs::create_dir_all(&self).unwrap();
                self
            }
        }
    }
}
