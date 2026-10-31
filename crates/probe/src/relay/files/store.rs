//! What this computer keeps of the files sessions are sent, under
//! `<app data>/attachments/<file_id>/<name>`: each file only this user can
//! read (`0600` in `0700` folders, never executable), marked as downloaded
//! (macOS quarantine, Windows' internet zone), within a total and a
//! per-sender quota, and removed [`KEEP_DAYS`] days after it was saved.
//!
//! A file over a quota is not saved; its message still names it, with the
//! reason and the command that fetches it once older files are removed.

use crate::relay::delivery::policy::Delivery;
use crate::relay::state::now_ms;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MB: u64 = 1024 * 1024;
/// The most received files kept on this computer, together.
pub const KEEP_TOTAL_BYTES: u64 = 500 * MB;
/// The most kept from one sender.
pub const KEEP_PER_SENDER_BYTES: u64 = 100 * MB;
/// The most taken from one sender in an hour.
pub const SENDER_HOURLY_BYTES: u64 = 50 * MB;
/// How long a received file is kept.
pub const KEEP_DAYS: i64 = 7;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const HOUR_MS: i64 = 60 * 60 * 1000;
/// Beside the saved file: who sent it. Saved names never start with a dot
/// ([`super::sanitize_filename`]), so this cannot be one.
const SENDER_FILE: &str = ".sender";

/// One quota check and save at a time, so two files arriving together
/// cannot both take the last of a quota.
static SAVING: Mutex<()> = Mutex::new(());

/// Who sent a file: `id` is kept and counted, `name` is shown.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sender {
    pub id: String,
    pub name: String,
}

impl Sender {
    /// Who sent `delivery`: Relaycast's immutable sender id, else its name.
    pub fn of(delivery: &Delivery) -> Option<Sender> {
        let name = delivery.sender.clone();
        let id = delivery.sender_id.clone().or_else(|| name.clone())?;
        Some(Sender {
            name: name.unwrap_or_else(|| id.clone()),
            id,
        })
    }
}

/// One file kept under the root.
#[derive(Debug)]
struct Kept {
    path: PathBuf,
    bytes: u64,
    saved_ms: i64,
    sender: Option<String>,
}

/// When a file was saved: its creation time, which the rename into place
/// keeps and an edit does not change; its last change where the file
/// system keeps no creation time.
fn saved_ms(meta: &std::fs::Metadata) -> i64 {
    meta.created()
        .or_else(|_| meta.modified())
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

/// The `<file_id>` folders under `root`.
fn folders(root: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect()
}

/// The saved files in `folder` (not links, not who sent them).
fn files_in(folder: &Path) -> Vec<(PathBuf, std::fs::Metadata)> {
    std::fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|file| file.file_name() != SENDER_FILE)
        .filter_map(|file| {
            let meta = std::fs::symlink_metadata(file.path()).ok()?;
            meta.is_file().then(|| (file.path(), meta))
        })
        .collect()
}

/// Every file kept under `root`, each dated by when it was saved.
fn kept(root: &Path) -> Vec<Kept> {
    folders(root)
        .into_iter()
        .flat_map(|folder| {
            let sender = std::fs::read_to_string(folder.join(SENDER_FILE)).ok();
            files_in(&folder).into_iter().map(move |(path, meta)| Kept {
                path,
                bytes: meta.len(),
                saved_ms: saved_ms(&meta),
                sender: sender.clone(),
            })
        })
        .collect()
}

/// Removes every file under `root` saved more than [`KEEP_DAYS`] days
/// before `now_ms`, and every folder left holding no file.
pub fn sweep(root: &Path, now_ms: i64) {
    let _saving = SAVING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    sweep_locked(root, now_ms);
}

fn sweep_locked(root: &Path, now_ms: i64) {
    for folder in folders(root) {
        for (path, meta) in files_in(&folder) {
            if now_ms - saved_ms(&meta) > KEEP_DAYS * DAY_MS {
                let _ = std::fs::remove_file(path);
            }
        }
        if files_in(&folder).is_empty() {
            let _ = std::fs::remove_dir_all(&folder);
        }
    }
}

/// Whether `bytes` more from `sender`, saved at `path`, fit the quotas,
/// given what is `kept` at `now_ms`; else why not, for the session. The file
/// already at `path` is replaced, so it does not count; another copy under
/// the same id (saved under another name) stays, and does.
fn admit(
    kept: &[Kept],
    path: &Path,
    sender: Option<&Sender>,
    bytes: u64,
    now_ms: i64,
) -> Result<(), String> {
    let others = || kept.iter().filter(|k| k.path != path);
    let later = format!("fetch it again once older files are removed (after {KEEP_DAYS} days)");
    if others().map(|k| k.bytes).sum::<u64>() + bytes > KEEP_TOTAL_BYTES {
        return Err(format!(
            "this computer keeps at most {} MB of received files and has that much now; {later}",
            KEEP_TOTAL_BYTES / MB
        ));
    }
    let Some(sender) = sender else {
        return Ok(());
    };
    let theirs = || others().filter(|k| k.sender.as_deref() == Some(sender.id.as_str()));
    if theirs().map(|k| k.bytes).sum::<u64>() + bytes > KEEP_PER_SENDER_BYTES {
        return Err(format!(
            "this computer keeps at most {} MB of files from {}; {later}",
            KEEP_PER_SENDER_BYTES / MB,
            sender.name
        ));
    }
    let this_hour: u64 = theirs()
        .filter(|k| now_ms - k.saved_ms < HOUR_MS)
        .map(|k| k.bytes)
        .sum();
    if this_hour + bytes > SENDER_HOURLY_BYTES {
        return Err(format!(
            "this computer takes at most {} MB of files an hour from {}; fetch it again in an hour",
            SENDER_HOURLY_BYTES / MB,
            sender.name
        ));
    }
    Ok(())
}

/// Whether a file of `bytes` from `sender` would be taken at `path` now:
/// checked before it is downloaded, when its size is known.
pub fn would_take(
    root: &Path,
    path: &Path,
    sender: Option<&Sender>,
    bytes: u64,
) -> Result<(), String> {
    let _saving = SAVING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = now_ms();
    sweep_locked(root, now);
    admit(&kept(root), path, sender, bytes, now)
}

/// Saves `bytes` at `path` (`<root>/<file_id>/<name>`) from `sender`, whole
/// or not at all, within the quotas, after removing expired files.
pub fn save(root: &Path, path: &Path, sender: Option<&Sender>, bytes: &[u8]) -> Result<(), String> {
    let _saving = SAVING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = now_ms();
    sweep_locked(root, now);
    admit(&kept(root), path, sender, bytes.len() as u64, now)?;
    let directory = path.parent().unwrap_or(root);
    write_private(root, directory, path, bytes)?;
    if let Some(sender) = sender {
        let _ = std::fs::write(directory.join(SENDER_FILE), &sender.id);
    }
    Ok(())
}

/// Through a private temporary file beside `path`, marked as downloaded,
/// renamed into place.
fn write_private(root: &Path, directory: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    let failed = |_| "could not save it on this computer".to_string();
    crate::platform::fs::create_private_dir_all(directory).map_err(failed)?;
    for folder in [root, directory] {
        crate::platform::fs::set_mode(folder, 0o700).map_err(failed)?;
    }
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(failed)?;
    file.write_all(bytes).map_err(failed)?;
    file.flush().map_err(failed)?;
    crate::platform::fs::set_mode(file.path(), 0o600).map_err(failed)?;
    // Unmarked, it would open without the warning a download gets.
    mark_downloaded(file.path())
        .map_err(|_| "could not mark it as downloaded on this computer".to_string())?;
    file.persist(path)
        .map_err(|_| "could not save it on this computer".to_string())?;
    Ok(())
}

/// What the operating system warns about before opening: macOS quarantine,
/// Windows' internet zone. Linux has no such mark.
fn mark_downloaded(path: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let value = format!("0081;{:x};Agent Relay;", now_ms() / 1000);
        xattr::set(path, "com.apple.quarantine", value.as_bytes())
    }
    #[cfg(windows)]
    {
        let mut stream = path.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        std::fs::write(PathBuf::from(stream), "[ZoneTransfer]\r\nZoneId=3\r\n")
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = path;
        Ok(())
    }
}

/// Sweeps the attachments under `app_data_dir` now and every hour, until
/// the core stops.
pub async fn sweeper(app_data_dir: PathBuf) {
    let root = app_data_dir.join(super::ATTACHMENTS_DIR);
    let mut every = tokio::time::interval(std::time::Duration::from_secs(60 * 60));
    loop {
        every.tick().await;
        let root = root.clone();
        let _ = tokio::task::spawn_blocking(move || sweep(&root, now_ms())).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sender(id: &str) -> Sender {
        Sender {
            id: id.into(),
            name: format!("@{id}"),
        }
    }

    fn kept_file(path: &str, mb: u64, saved_ms: i64, from: Option<&str>) -> Kept {
        Kept {
            path: path.into(),
            bytes: mb * MB,
            saved_ms,
            sender: from.map(str::to_string),
        }
    }

    #[test]
    fn quotas_hold_in_total_per_sender_and_per_hour() {
        let now = 10 * DAY_MS;
        let old = now - 2 * HOUR_MS;
        let alice = sender("alice");
        let new = Path::new("new/shot.png");
        let full = vec![kept_file("a/attachment", 480, old, None)];
        let error = admit(&full, new, Some(&alice), 25 * MB, now).unwrap_err();
        assert!(
            error.contains("at most 500 MB of received files"),
            "{error}"
        );
        // A file saved again replaces its old copy, but not another copy
        // under the same id.
        assert!(admit(&full, Path::new("a/attachment"), Some(&alice), 25 * MB, now).is_ok());
        assert!(admit(&full, Path::new("a/shot.png"), Some(&alice), 25 * MB, now).is_err());

        let hers = vec![
            kept_file("a/x", 90, old, Some("alice")),
            kept_file("b/y", 90, old, Some("bob")),
        ];
        let error = admit(&hers, new, Some(&alice), 20 * MB, now).unwrap_err();
        assert!(
            error.contains("at most 100 MB of files from @alice"),
            "{error}"
        );
        assert!(admit(&hers, new, Some(&sender("carol")), 20 * MB, now).is_ok());
        assert!(admit(&hers, new, None, 20 * MB, now).is_ok());

        let recent = vec![kept_file("a/x", 40, now - 1000, Some("alice"))];
        let error = admit(&recent, new, Some(&alice), 20 * MB, now).unwrap_err();
        assert!(
            error.contains("50 MB of files an hour from @alice"),
            "{error}"
        );
        assert!(admit(&recent, new, Some(&alice), 20 * MB, now + HOUR_MS).is_ok());
        // Each copy keeps its own time: an old one does not count this hour.
        let copies = vec![
            kept_file("a/attachment", 25, old, Some("alice")),
            kept_file("a/shot.png", 25, now - 1000, Some("alice")),
        ];
        assert!(admit(&copies, new, Some(&alice), 20 * MB, now).is_ok());
    }

    #[test]
    fn a_saved_file_is_private_and_counted_against_its_sender() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("attachments");
        let path = root.join("file_1").join("shot.png");
        let alice = sender("alice");
        save(&root, &path, Some(&alice), b"PNG").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"PNG");
        #[cfg(unix)]
        {
            let mode =
                |p: &Path| crate::platform::fs::mode_of(&std::fs::metadata(p).unwrap()).unwrap();
            assert_eq!(mode(&path), 0o600);
            assert_eq!(mode(path.parent().unwrap()), 0o700);
            assert_eq!(mode(&root), 0o700);
        }
        #[cfg(target_os = "macos")]
        {
            let mark = xattr::get(&path, "com.apple.quarantine").unwrap().unwrap();
            assert!(String::from_utf8(mark).unwrap().starts_with("0081;"));
        }
        let kept = kept(&root);
        assert_eq!(kept.len(), 1);
        assert_eq!(
            (kept[0].bytes, kept[0].sender.as_deref()),
            (3, Some("alice"))
        );
    }

    #[test]
    fn files_older_than_a_week_and_empty_folders_are_removed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        save(root, &root.join("kept/a.txt"), None, b"a").unwrap();
        // An empty file is a file: kept, like any other.
        save(root, &root.join("blank/b.txt"), None, b"").unwrap();
        std::fs::create_dir_all(root.join("empty")).unwrap();
        sweep(root, now_ms());
        assert!(!root.join("empty").exists());
        assert!(root.join("kept/a.txt").exists());
        assert!(root.join("blank/b.txt").exists());
        // An edit does not restart a file's week.
        std::fs::write(root.join("kept/a.txt"), b"edited").unwrap();
        sweep(root, now_ms() + 8 * DAY_MS);
        assert!(!root.join("kept").exists());
        assert!(!root.join("blank").exists());
    }
}
