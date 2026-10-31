//! Owner-only files and folders, and the file facts Unix keeps in a mode.
//!
//! Unix gets its modes and `O_NOFOLLOW`. Windows has no mode bits: a file
//! created inside the person's profile (`%USERPROFILE%`, `%LOCALAPPDATA%`)
//! inherits an access list that admits only them, SYSTEM and
//! administrators, which is what `0600`/`0700` promise on Unix. So on
//! Windows the private variants create files and folders plainly, report
//! no mode, and never rewrite an access list.

use std::fs::{DirBuilder, FileType, Metadata, OpenOptions};
use std::io;
use std::path::Path;

/// `options` creating files with `mode` (Unix); unchanged on Windows.
pub fn with_mode(options: &mut OpenOptions, mode: u32) -> &mut OpenOptions {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode)
    }
    #[cfg(windows)]
    {
        let _ = mode;
        options
    }
}

/// `options` creating files readable and writable by this user only.
pub fn private(options: &mut OpenOptions) -> &mut OpenOptions {
    with_mode(options, 0o600)
}

/// `options` refusing to open through a symbolic link at the last path
/// component (`O_NOFOLLOW`). Windows opens through it: creating a symbolic
/// link there takes Developer Mode or an administrator, and another
/// account cannot plant one inside this person's profile.
pub fn no_follow(options: &mut OpenOptions) -> &mut OpenOptions {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW)
    }
    #[cfg(windows)]
    {
        options
    }
}

/// `builder` creating folders with `mode` (Unix); unchanged on Windows.
pub fn dir_with_mode(builder: &mut DirBuilder, mode: u32) -> &mut DirBuilder {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(mode)
    }
    #[cfg(windows)]
    {
        let _ = mode;
        builder
    }
}

/// `builder` creating folders only this user can enter.
pub fn private_dir(builder: &mut DirBuilder) -> &mut DirBuilder {
    dir_with_mode(builder, 0o700)
}

/// Creates `path` and its missing parents as private folders.
pub fn create_private_dir_all(path: &Path) -> io::Result<()> {
    private_dir(DirBuilder::new().recursive(true)).create(path)
}

/// Sets `path`'s permission bits (Unix). Windows keeps the inherited access
/// list and succeeds.
pub fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }
    #[cfg(windows)]
    {
        let _ = (path, mode);
        Ok(())
    }
}

/// The permission bits (`0o7777`) of `metadata`; `None` on Windows, which
/// has none.
pub fn mode_of(metadata: &Metadata) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Some(metadata.permissions().mode() & 0o7777)
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        None
    }
}

/// Whether `metadata` is private to its owner: no group or other bits in
/// `mask` on Unix (`0o077` for "nobody else", `0o022` for "nobody else may
/// write"). Always on Windows, where profile files are private by their
/// inherited access list (see the module comment).
pub fn private_to_owner(metadata: &Metadata, mask: u32) -> bool {
    mode_of(metadata).is_none_or(|mode| mode & mask == 0)
}

/// Whether this process's user owns the file. Windows answers yes: the
/// callers only ask about files inside this person's own profile, which
/// another account cannot write (see the module comment).
pub fn owned_by_current_user(metadata: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions and cannot fail.
        metadata.uid() == unsafe { libc::geteuid() }
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        true
    }
}

/// Whether the file's owner is root or this user (Unix). Yes on Windows, as
/// for `owned_by_current_user`.
pub fn owned_by_root_or_current_user(metadata: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        metadata.uid() == 0 || owned_by_current_user(metadata)
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        true
    }
}

/// The file's inode (Unix). `None` on Windows: std's file index is not
/// stable there, so callers fall back to the path and size they also keep.
pub fn inode(metadata: &Metadata) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(metadata.ino())
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        None
    }
}

/// Whether `file_type` is a named pipe (FIFO). Never on Windows, whose
/// named pipes are not files on a disk.
pub fn is_fifo(file_type: &FileType) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        file_type.is_fifo()
    }
    #[cfg(windows)]
    {
        let _ = file_type;
        false
    }
}

/// Makes `link` a symbolic link to `original`. On Windows that needs
/// Developer Mode or an administrator, and fails with the OS error without.
pub fn symlink(original: &Path, link: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(original, link)
    }
    #[cfg(windows)]
    {
        if original.is_dir() {
            std::os::windows::fs::symlink_dir(original, link)
        } else {
            std::os::windows::fs::symlink_file(original, link)
        }
    }
}

/// Flushes a folder's entries (a rename or a new file in it) to disk. A
/// folder cannot be opened for flushing on Windows, whose file system
/// journals its entries, so it succeeds there.
pub fn sync_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(path)?.sync_all()
    }
    #[cfg(windows)]
    {
        let _ = path;
        Ok(())
    }
}

/// Whether `error`, from a `try_lock_shared` or `try_lock_exclusive` call,
/// says another handle holds the lock. Unix answers `EWOULDBLOCK`, which is
/// `ErrorKind::WouldBlock`; Windows answers `ERROR_LOCK_VIOLATION`, which
/// std leaves uncategorized, so matching the kind alone turns every held
/// lock there into a failure.
pub fn lock_held(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock
        || (error.raw_os_error().is_some()
            && error.raw_os_error() == fs2::lock_contended_error().raw_os_error())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lock_another_handle_holds_is_held_on_every_platform() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("collector.lock");
        let open = || {
            OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(&path)
                .unwrap()
        };
        let holder = open();
        fs2::FileExt::lock_exclusive(&holder).unwrap();
        let error = fs2::FileExt::try_lock_exclusive(&open()).unwrap_err();
        assert!(lock_held(&error), "{error:?}");
        fs2::FileExt::unlock(&holder).unwrap();
        fs2::FileExt::try_lock_exclusive(&open()).unwrap();
    }

    #[test]
    fn other_errors_are_not_a_held_lock() {
        assert!(!lock_held(&io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refused"
        )));
        assert!(!lock_held(&io::Error::from_raw_os_error(2)));
    }
}
