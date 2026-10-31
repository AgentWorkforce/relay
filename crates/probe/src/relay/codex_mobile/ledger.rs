//! Immutable consumed-request tombstones. A partial/corrupt existing record
//! also refuses another action; no repair or pruning may make it replayable.
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub(crate) fn digest(parts: &[&[u8]]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part);
    }
    format!("{:x}", hash.finalize())
}
fn path(root: &Path, key: &str) -> PathBuf {
    root.join(&key[..2]).join(format!("{key}.consumed"))
}
fn valid(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit())
}
pub(super) fn consumed(root: &Path, key: &str) -> bool {
    if !valid(key) {
        return true;
    }
    match fs::symlink_metadata(root) {
        Ok(metadata) if !metadata.is_dir() => return true,
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return true,
        _ => {}
    }
    !fs::symlink_metadata(path(root, key)).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
}
pub(super) fn consume(root: &Path, key: &str) -> bool {
    if !valid(key) {
        return false;
    }
    let path = path(root, key);
    let Some(parent) = path.parent() else {
        return false;
    };
    if crate::relay::outbox::create_private_dir(root).is_err()
        || crate::relay::outbox::create_private_dir(parent).is_err()
    {
        return false;
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    crate::platform::fs::private(&mut options);
    let Ok(mut file) = crate::platform::fs::no_follow(&mut options).open(&path) else {
        return false;
    };
    // create_new is the cross-process claim. Never remove it on a failed fsync:
    // uncertainty must stay consumed rather than allow a second provider write.
    file.write_all(format!("codex-mobile-decision-v1\n{key}\n").as_bytes())
        .is_ok()
        && file.sync_all().is_ok()
        && sync_directory(parent)
        && sync_directory(root)
        && root.parent().is_some_and(sync_directory)
}
#[cfg(unix)]
fn sync_directory(path: &Path) -> bool {
    fs::File::open(path).and_then(|f| f.sync_all()).is_ok()
}
#[cfg(windows)]
fn sync_directory(_: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn consumed_is_atomic_and_survives_restart_and_corruption() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("ledger");
        let key = digest(&[b"scope", b"request"]);
        assert!(!consumed(&root, &key));
        assert!(consume(&root, &key));
        assert!(consumed(&root, &key));
        assert!(!consume(&root, &key));
        fs::write(path(&root, &key), b"partial").unwrap();
        assert!(consumed(&root, &key));
        assert!(!consume(&root, &key));
    }
    #[test]
    fn unavailable_or_nonregular_journal_never_permits_action() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("ledger");
        fs::write(&root, b"not a directory").unwrap();
        let key = digest(&[b"request"]);
        assert!(!consume(&root, &key));
        assert!(consumed(&root, &key));
    }
    #[cfg(unix)]
    #[test]
    fn dangling_tombstone_cannot_be_reclaimed() {
        let home = tempfile::tempdir().unwrap();
        let key = digest(&[b"request"]);
        let record = path(home.path(), &key);
        fs::create_dir_all(record.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(home.path().join("absent"), record).unwrap();
        assert!(consumed(home.path(), &key));
        assert!(!consume(home.path(), &key));
    }
}

#[cfg(all(test, windows))]
#[test]
fn windows_without_verified_durability_cannot_consume() {
    let home = tempfile::tempdir().unwrap();
    let key = digest(&[b"request"]);
    assert!(!consume(home.path(), &key));
    assert!(consumed(home.path(), &key));
}
