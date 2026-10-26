//! Stable identity across ordinary writes and path replacement on all hosts.
#[cfg(unix)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DatabaseIdentity {
    device: u64,
    inode: u64,
}

#[cfg(not(unix))]
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DatabaseIdentity(same_file::Handle);

impl DatabaseIdentity {
    #[cfg(unix)]
    pub(crate) fn open_or_create(path: &std::path::Path) -> std::io::Result<Self> {
        match Self::read(path) {
            Ok(identity) => return Ok(identity),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        #[cfg(test)]
        tests::creation_hook("missing");
        let target = creation_target(path)?;
        let parent = target.parent().filter(|p| !p.as_os_str().is_empty());
        // Close the private 0600 file BEFORE publishing its inode at the DB
        // pathname. A raw close after SQLite opens it would release every
        // POSIX lock this process holds on that database, even on other FDs.
        let temporary =
            tempfile::NamedTempFile::new_in(parent.unwrap_or(std::path::Path::new(".")))?
                .into_temp_path();
        match temporary.persist_noclobber(&target) {
            Ok(()) => {}
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.error),
        }
        #[cfg(test)]
        tests::creation_hook("published");
        Self::read(path)
    }

    #[cfg(not(unix))]
    pub(crate) fn open_or_create(path: &std::path::Path) -> std::io::Result<Self> {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        same_file::Handle::from_file(file).map(Self)
    }

    #[cfg(unix)]
    pub(crate) fn read(path: &std::path::Path) -> std::io::Result<Self> {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata(path)?;
        // Existing SQLite FDs keep their inode alive. This snapshot does not
        // pin an otherwise unopened inode or promise identity across reuse.
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }

    #[cfg(not(unix))]
    pub(crate) fn read(path: &std::path::Path) -> std::io::Result<Self> {
        same_file::Handle::from_path(path).map(Self)
    }
}

/// Follow a dangling final symlink as the old create-open did. Parents still
/// resolve through the filesystem; publication never replaces a symlink.
#[cfg(unix)]
fn creation_target(path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    let mut target = path.to_owned();
    for _ in 0..40 {
        match std::fs::read_link(&target) {
            Ok(link) => {
                target = if link.is_absolute() {
                    link
                } else {
                    target
                        .parent()
                        .unwrap_or(std::path::Path::new("."))
                        .join(link)
                };
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidInput
                ) =>
            {
                return Ok(target)
            }
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::other("too many database symlinks"))
}

#[cfg(all(test, unix))]
mod tests;

/// Local history predates the schema this build reads, and the migration is
/// waiting for the collector. On a large store it runs for minutes, so only
/// the collector lock's holder, which no caller's timeout can kill, runs it:
/// a killed migration rolls back, and every other process that tried it would
/// hold the writer lock just long enough to starve the one that could finish.
#[derive(Debug)]
pub struct UpgradePending;
impl std::fmt::Display for UpgradePending {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("local history is waiting for the collector to upgrade it")
    }
}
impl std::error::Error for UpgradePending {}
/// Whether `error` is local history waiting for its upgrade: [`UpgradePending`]
/// or the store refusing a read the upgrade has not reached yet.
pub fn is_upgrade_pending(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.is::<UpgradePending>()
            || cause
                .downcast_ref::<ai_hist::Error>()
                .is_some_and(ai_hist::Error::is_stale_schema)
    })
}
