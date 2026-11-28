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
use std::time::{Duration, Instant};

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

/// Opens `path` as a private, non-symlink regular file owned by this user
/// (`0600`, no group or other access on Unix), creating any missing parent
/// directories as private (`0700`) first.
pub fn open_private_lock(path: &Path) -> io::Result<std::fs::File> {
    open_lock(path, false)
}

fn open_lock(path: &Path, migrate_legacy_readonly: bool) -> io::Result<std::fs::File> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        create_private_dir_all(parent)?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    let file = no_follow(private(&mut options)).open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || !owned_by_current_user(&metadata) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("lock file {} is not private", path.display()),
        ));
    }
    if !private_to_owner(&metadata, 0o077) {
        // Legacy locks created under the default umask (e.g. 0644) had no
        // group/other write bits. Tighten the opened descriptor in place so
        // its inode stays the same for concurrent processes holding flock.
        if !migrate_legacy_readonly || !private_to_owner(&metadata, 0o7022) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("lock file {} is not private", path.display()),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        let tightened = file.metadata()?;
        if !private_to_owner(&tightened, 0o077) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("lock file {} is not private", path.display()),
            ));
        }
    }
    Ok(file)
}

fn lock_retrying(mut acquire: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    loop {
        match acquire() {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

/// Acquires an exclusive advisory lock on a private lock file at `path`.
/// The lock is released when the returned `File` is dropped.
pub fn lock_exclusive(path: &Path) -> io::Result<std::fs::File> {
    let file = open_private_lock(path)?;
    lock_retrying(|| fs2::FileExt::lock_exclusive(&file))?;
    Ok(file)
}

/// Acquires an exclusive advisory lock on a private lock file at `path`,
/// waiting with bounded exponential backoff up to `max_wait` so a stalled
/// peer process cannot block callers forever.
pub fn lock_exclusive_bounded(path: &Path, max_wait: Duration) -> io::Result<std::fs::File> {
    let file = open_private_lock(path)?;
    let deadline = Instant::now() + max_wait;
    let mut backoff = Duration::from_millis(5);
    loop {
        match fs2::FileExt::try_lock_exclusive(&file) {
            Ok(()) => return Ok(file),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if lock_held(&error) => {
                let now = Instant::now();
                if now >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!("timed out waiting for exclusive lock {}", path.display()),
                    ));
                }
                std::thread::sleep(backoff.min(deadline - now));
                backoff = (backoff * 2).min(Duration::from_millis(100));
            }
            Err(error) => return Err(error),
        }
    }
}

/// Acquires an exclusive advisory lock on `path`, migrating a pre-existing
/// owner-owned regular lock file that has no group/other write bits (such as
/// a legacy `0644` file created under umask `022`) to `0600` in place via its
/// open descriptor so concurrent processes continue sharing the same inode.
pub fn lock_exclusive_migrating_legacy(path: &Path) -> io::Result<std::fs::File> {
    let file = open_lock(path, true)?;
    lock_retrying(|| fs2::FileExt::lock_exclusive(&file))?;
    Ok(file)
}

/// Acquires a shared advisory lock on a private lock file at `path`.
/// The lock is released when the returned `File` is dropped.
pub fn lock_shared(path: &Path) -> io::Result<std::fs::File> {
    let file = open_private_lock(path)?;
    lock_retrying(|| fs2::FileExt::lock_shared(&file))?;
    Ok(file)
}

/// Attempts to acquire an exclusive advisory lock on a private lock file at
/// `path` without blocking. Returns `Ok(None)` when another handle holds it.
pub fn try_lock_exclusive(path: &Path) -> io::Result<Option<std::fs::File>> {
    let file = open_private_lock(path)?;
    match fs2::FileExt::try_lock_exclusive(&file) {
        Ok(()) => Ok(Some(file)),
        Err(error) if lock_held(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Creates `dir` and any missing parents, private to this user. A `dir`
/// that already exists is used only when it is a real directory (not a
/// symlink) this user owns and no one else can write to; its permissions
/// are never changed, so a planted path cannot be re-permissioned.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        builder.mode(0o700);
        builder.create(dir)?;
        let entry = std::fs::symlink_metadata(dir)?;
        if !entry.is_dir()
            || entry.uid() != crate::relay::peer::current_uid()
            || entry.mode() & 0o022 != 0
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "{} must be a directory only you can write to",
                    dir.display()
                ),
            ));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    builder.create(dir)
}

fn make_private_file(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Replaces `path` with `body` atomically: a reader sees the old file or the
/// new one, never a mix. The file is private to this user.
pub fn write_atomic(path: &Path, body: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    make_private_file(file.path())?;
    std::io::Write::write_all(&mut file, body)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|error| error.error)?;
    // The rename is durable only once the directory is synced; callers rely
    // on it (a recovery intent must outlive a crash). Windows cannot open a
    // directory for syncing.
    #[cfg(unix)]
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}

/// Writes `bytes` to `path` as a 0600 file in 0700 directories, swapped
/// into place.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let failed = |error: std::io::Error| format!("Could not save the file ({error}).");
    let directory = path.parent().ok_or("No directory.")?;
    create_private_dir_all(directory).map_err(failed)?;
    let temporary = directory.join(format!(".{}.tmp", crate::relay::store::random_uuid()));
    let result = (|| {
        let mut file =
            private(std::fs::OpenOptions::new().write(true).create_new(true)).open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(failed)
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

    #[test]
    fn private_lock_helpers_serialize_and_reject_insecure_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("shared.lock");
        let held = lock_exclusive(&path).unwrap();
        assert!(try_lock_exclusive(&path).unwrap().is_none());
        assert_eq!(
            lock_exclusive_bounded(&path, Duration::from_millis(15))
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        drop(held);
        let bounded = lock_exclusive_bounded(&path, Duration::from_millis(50)).unwrap();
        drop(bounded);
        let acquired = try_lock_exclusive(&path).unwrap();
        assert!(acquired.is_some());
        drop(acquired);
        let shared = lock_shared(&path).unwrap();
        assert!(try_lock_exclusive(&path).unwrap().is_none());
        drop(shared);

        #[cfg(unix)]
        {
            let loose = dir.path().join("loose.lock");
            std::fs::write(&loose, b"").unwrap();
            set_mode(&loose, 0o644).unwrap();
            assert_eq!(
                lock_exclusive(&loose).unwrap_err().kind(),
                io::ErrorKind::PermissionDenied
            );
            let link = dir.path().join("link.lock");
            symlink(&path, &link).unwrap();
            assert!(lock_exclusive(&link).is_err());

            // Legacy migration tightens owner-only-writable 0644 files in place
            // without replacing the inode, while rejecting group/world-writable
            // files and symlinks.
            let before_inode = inode(&std::fs::metadata(&loose).unwrap());
            let migrated = lock_exclusive_migrating_legacy(&loose).unwrap();
            let after_meta = migrated.metadata().unwrap();
            assert_eq!(mode_of(&after_meta), Some(0o600));
            assert_eq!(inode(&after_meta), before_inode);
            drop(migrated);

            let group_writable = dir.path().join("group_writable.lock");
            std::fs::write(&group_writable, b"").unwrap();
            set_mode(&group_writable, 0o664).unwrap();
            assert_eq!(
                lock_exclusive_migrating_legacy(&group_writable)
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::PermissionDenied
            );
            assert!(lock_exclusive_migrating_legacy(&link).is_err());
        }
    }
}
