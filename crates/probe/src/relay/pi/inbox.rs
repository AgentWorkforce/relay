//! Private inbox publication and serialization shared with mode reservations.
use crate::platform::fs as private_fs;
use fs2::FileExt;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;

pub(super) fn delivery_lock(directory: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(false);
    let lock = private_fs::no_follow(private_fs::private(&mut options))
        .open(directory.join("delivery.lock"))?;
    lock.lock_exclusive()?;
    Ok(lock)
}

pub(super) fn atomic_write_guarded(
    path: &Path,
    bytes: &[u8],
    admit: &dyn Fn() -> bool,
) -> std::io::Result<bool> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Pi record has no parent directory",
        )
    })?;
    let tmp = path.with_extension(format!("{}.tmp", crate::relay::store::random_hex(16)));
    let mut file =
        private_fs::private(OpenOptions::new().write(true).create_new(true)).open(&tmp)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        if !admit() {
            return Ok(false);
        }
        fs::rename(&tmp, path)?;
        private_fs::sync_dir(parent)?;
        Ok(true)
    })();
    if !matches!(result, Ok(true)) {
        let _ = fs::remove_file(tmp);
    }
    result
}
