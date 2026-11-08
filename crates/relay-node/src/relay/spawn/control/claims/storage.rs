//! Race-safe, owner-private release-claim storage.
//!
//! Unix keeps an opened directory descriptor across every read and publish,
//! so replacing the visible directory or claim path cannot redirect an
//! operation after validation. Windows uses the profile ACL policy described
//! by `platform::fs`: creating a reparse point there requires the same user
//! to opt into Developer Mode or administrator privileges.

#[cfg(unix)]
use crate::platform::fs::create_private_dir_all;
use crate::platform::fs::{owned_by_current_user, private_to_owner};
#[cfg(windows)]
use crate::platform::fs::{private_dir, sync_dir};
use std::io;
use std::path::Path;

pub(super) fn read(folder: &Path, name: &str) -> io::Result<Option<Vec<u8>>> {
    platform::read(folder, name)
}

pub(super) fn persist(folder: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    platform::persist(folder, name, bytes)
}

fn valid(metadata: &std::fs::Metadata, directory: bool) -> bool {
    owned_by_current_user(metadata)
        && private_to_owner(metadata, 0o077)
        && if directory {
            metadata.is_dir()
        } else {
            metadata.is_file()
        }
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::ffi::{CString, OsStr};
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    fn cstring(value: &OsStr) -> io::Result<CString> {
        CString::new(value.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in claim path"))
    }

    fn component(name: &str) -> io::Result<CString> {
        if name.is_empty() || name == "." || name == ".." || name.contains('/') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "claim name must be one path component",
            ));
        }
        cstring(OsStr::new(name))
    }

    fn open_directory(folder: &Path, create: bool) -> io::Result<std::fs::File> {
        if create {
            create_private_dir_all(folder)?;
        }
        let folder = cstring(folder.as_os_str())?;
        // SAFETY: `folder` is NUL-terminated and the flags need no extra argument.
        let fd = unsafe {
            libc::open(
                folder.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `open` returned this owned descriptor.
        let directory = unsafe { std::fs::File::from_raw_fd(fd) };
        if !valid(&directory.metadata()?, true) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private release claim directory required",
            ));
        }
        Ok(directory)
    }

    fn open_at(
        directory: &std::fs::File,
        name: &CString,
        flags: i32,
        mode: u32,
    ) -> io::Result<std::fs::File> {
        // SAFETY: `name` is NUL-terminated, `directory` stays open for the
        // call, and the descriptor returned on success becomes owned below.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags, mode) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `openat` returned this owned descriptor.
        Ok(unsafe { std::fs::File::from_raw_fd(fd) })
    }

    fn read_from(directory: &std::fs::File, name: &CString) -> io::Result<Option<Vec<u8>>> {
        let mut file = match open_at(
            directory,
            name,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0,
        ) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if !valid(&file.metadata()?, false) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private release claim file required",
            ));
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(Some(bytes))
    }

    pub(super) fn read(folder: &Path, name: &str) -> io::Result<Option<Vec<u8>>> {
        let directory = match open_directory(folder, false) {
            Ok(directory) => directory,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        read_from(&directory, &component(name)?)
    }

    fn temporary_name() -> io::Result<CString> {
        let mut random = [0_u8; 16];
        getrandom::getrandom(&mut random)
            .map_err(|_| io::Error::other("release claim random source unavailable"))?;
        component(&format!(".claim-{:032x}.tmp", u128::from_ne_bytes(random)))
    }

    fn persist_in(directory: &std::fs::File, name: &CString, bytes: &[u8]) -> io::Result<()> {
        let temporary = temporary_name()?;
        let mut file = open_at(
            directory,
            &temporary,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )?;
        let finish = (|| -> io::Result<()> {
            if !valid(&file.metadata()?, false) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "private release claim file required",
                ));
            }
            file.write_all(bytes)?;
            file.sync_all()?;
            // `linkat` is the portable Unix no-clobber publish: the existing
            // final name wins, and both names are resolved beneath this same
            // already-validated directory descriptor.
            // SAFETY: both names are NUL-terminated and `directory` is open.
            let linked = unsafe {
                libc::linkat(
                    directory.as_raw_fd(),
                    temporary.as_ptr(),
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    0,
                )
            };
            if linked != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        })();
        // SAFETY: `temporary` is a single component beneath the open folder.
        let unlinked = unsafe { libc::unlinkat(directory.as_raw_fd(), temporary.as_ptr(), 0) };
        let cleanup = if unlinked == 0 {
            directory.sync_all()
        } else {
            Err(io::Error::last_os_error())
        };
        match finish {
            Ok(()) => cleanup,
            Err(error) => {
                let _ = cleanup;
                Err(error)
            }
        }
    }

    pub(super) fn persist(folder: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
        let directory = open_directory(folder, true)?;
        persist_in(&directory, &component(name)?, bytes)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::platform::fs::{create_private_dir_all, private};
        use std::fs::OpenOptions;
        use std::os::unix::fs::symlink;

        fn private_file(path: &Path, bytes: &[u8]) {
            let mut file = private(OpenOptions::new().write(true).create_new(true))
                .open(path)
                .unwrap();
            file.write_all(bytes).unwrap();
        }

        #[test]
        fn an_open_claim_directory_cannot_be_redirected_by_a_later_symlink_swap() {
            let root = tempfile::tempdir().unwrap();
            let visible = root.path().join("claims");
            create_private_dir_all(&visible).unwrap();
            let original = root.path().join("original");
            let outside = root.path().join("outside");
            create_private_dir_all(&outside).unwrap();
            private_file(&visible.join("saved.json"), b"inside");
            private_file(&outside.join("saved.json"), b"outside");
            let directory = open_directory(&visible, false).unwrap();
            std::fs::rename(&visible, &original).unwrap();
            symlink(&outside, &visible).unwrap();

            assert_eq!(
                read_from(&directory, &component("saved.json").unwrap())
                    .unwrap()
                    .unwrap(),
                b"inside"
            );
            persist_in(&directory, &component("new.json").unwrap(), b"new-inside").unwrap();
            assert_eq!(
                std::fs::read(original.join("new.json")).unwrap(),
                b"new-inside"
            );
            assert!(!outside.join("new.json").exists());
        }

        #[test]
        fn claim_paths_refuse_symbolic_links() {
            let root = tempfile::tempdir().unwrap();
            let real = root.path().join("real");
            create_private_dir_all(&real).unwrap();
            let linked = root.path().join("linked");
            symlink(&real, &linked).unwrap();
            assert!(read(&linked, "claim.json").is_err());

            private_file(&real.join("target.json"), b"outside");
            symlink(real.join("target.json"), real.join("claim.json")).unwrap();
            assert!(read(&real, "claim.json").is_err());
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::io::{Read, Write};

    fn private(path: &Path, directory: bool) -> io::Result<()> {
        match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Ok(metadata) if valid(&metadata, directory) => Ok(()),
            _ => Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private release claim path required",
            )),
        }
    }

    pub(super) fn read(folder: &Path, name: &str) -> io::Result<Option<Vec<u8>>> {
        private(folder, true)?;
        let path = folder.join(name);
        private(&path, false)?;
        let mut file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if !valid(&file.metadata()?, false) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private release claim file required",
            ));
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(Some(bytes))
    }

    pub(super) fn persist(folder: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
        std::fs::create_dir_all(folder.parent().unwrap_or(Path::new("C:\\nonexistent")))?;
        match private_dir(&mut std::fs::DirBuilder::new()).create(folder) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        private(folder, true)?;
        let mut temporary = tempfile::NamedTempFile::new_in(folder)?;
        temporary.write_all(bytes)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist_noclobber(folder.join(name))
            .map_err(|error| error.error)?;
        sync_dir(folder)
    }
}
