//! Cross-process history reset handshake. A writer advertises intent before
//! waiting for readers, so retained daemon caches can release their leases.
use fs2::FileExt;
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::Path,
};

pub const RESET_BUSY: &str = "History is busy with a session reset.";

pub struct Access {
    _file: File,
    _intent: Option<File>,
}

fn file(root: &Path, name: &str) -> io::Result<File> {
    fs::create_dir_all(root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    }
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join(name))
}

/// Existing short-lived helpers may wait; they hold no SQLite handle yet.
pub fn reader(root: &Path) -> io::Result<Access> {
    let intent = file(root, "session-reset-intent.lock")?;
    FileExt::lock_shared(&intent)?;
    let file = file(root, "session-reset.lock")?;
    FileExt::lock_shared(&file)?;
    Ok(Access {
        _file: file,
        _intent: None,
    })
}

/// Persistent caches must not queue behind reset while keeping other handles.
pub fn try_reader(root: &Path) -> io::Result<Access> {
    let intent = file(root, "session-reset-intent.lock")?;
    FileExt::try_lock_shared(&intent)?;
    let file = file(root, "session-reset.lock")?;
    FileExt::try_lock_shared(&file)?;
    Ok(Access {
        _file: file,
        _intent: None,
    })
}

pub fn writer(root: &Path) -> io::Result<Access> {
    let intent = file(root, "session-reset-intent.lock")?;
    intent.lock_exclusive()?;
    let file = file(root, "session-reset.lock")?;
    file.lock_exclusive()?;
    Ok(Access {
        _file: file,
        _intent: Some(intent),
    })
}

pub fn reset_requested(root: &Path) -> io::Result<bool> {
    let intent = match OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("session-reset-intent.lock"))
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    match FileExt::try_lock_shared(&intent) {
        Ok(()) => Ok(false),
        Err(error) if crate::platform::fs::lock_held(&error) => Ok(true),
        Err(error) => Err(error),
    }
}
