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
//! The copy is used only when it is safe to: the folder is the core's
//! private data folder (made by `create_private_dir_all`, owned by this
//! person, never a link or junction), and the copy is a regular file of
//! exactly this probe's contents, checked again on every start. Anything
//! else there, and any failure, leaves the hook naming the running probe as
//! before. Nothing here widens who may run or replace the copy.

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
    {
        return Err(io::Error::other(
            "the copy's folder is not a private folder of this person's",
        ));
    }
    let copy = dir.join(name);
    match fs::symlink_metadata(&copy) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(io::Error::other(
                "something other than the copy is in its place",
            ));
        }
        Ok(_) if same_contents(probe, &copy).unwrap_or(false) => return Ok(copy),
        Ok(_) | Err(_) => {}
    }
    replace(probe, &copy)?;
    if !same_contents(probe, &copy)? {
        return Err(io::Error::other("the copy does not match the probe"));
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(dir: &Path, contents: &[u8]) -> PathBuf {
        let path = dir.join("agent-relay-probe.exe");
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn a_copy_is_made_and_kept_at_one_path_across_updates() {
        let temp = tempfile::tempdir().unwrap();
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
        let temp = tempfile::tempdir().unwrap();
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
        let temp = tempfile::tempdir().unwrap();
        let source = probe(temp.path(), b"build");
        let data = temp.path().join("bin");
        fs::create_dir_all(data.join("agent-relay-probe.exe")).unwrap();
        assert!(keep_copy(&source, &data).is_err());
        assert!(data.join("agent-relay-probe.exe").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_copys_place_is_never_followed_or_replaced() {
        let temp = tempfile::tempdir().unwrap();
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
        let temp = tempfile::tempdir().unwrap();
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
        let temp = tempfile::tempdir().unwrap();
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
        let temp = tempfile::tempdir().unwrap();
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
}
