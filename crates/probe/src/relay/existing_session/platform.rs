//! Unix file, socket and process facilities for the harness routes that
//! exist only on Unix, under one name on every platform.
//!
//! Muse, Devin, Grok's leader routes, Hermes, OpenClaw, OpenCode's plugin
//! and server routes, and Paseo reach their tools over Unix sockets,
//! process groups and file modes. On Unix the names here are std's own
//! extension traits and libc's calls, re-exported, so nothing changes
//! there. On Windows those harnesses are reported unavailable
//! ([`unavailable`]) by their adapters, discovery and settings, so their
//! code is never reached; it still compiles into the core that answers for
//! them. The Windows half therefore has the Unix signatures with the
//! behaviour of a profile Windows already keeps private to its user: file
//! ownership is this user's, modes are private, sockets never connect or
//! bind, and nothing is a socket.

/// Whether the Unix-only harnesses can run on this computer at all.
pub const SUPPORTED: bool = cfg!(unix);

/// What discovery, spawning and Settings say of a harness whose local tools
/// are Unix-only, such as "Muse is not available on Windows.".
pub fn unavailable(label: &str) -> String {
    format!("{label} is not available on Windows.")
}

/// `unavailable(label)` on Windows; `None` where the harness can run.
pub fn unsupported(label: &str) -> Option<String> {
    (!SUPPORTED).then(|| unavailable(label))
}

#[cfg(unix)]
pub use unix::*;
#[cfg(windows)]
pub use windows::*;

#[cfg(unix)]
mod unix {
    pub use std::os::unix::fs::{
        DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt,
    };
    pub use std::os::unix::net::{SocketAddr, UnixListener, UnixStream};
    pub use std::os::unix::process::CommandExt;

    /// `open(2)`'s `O_NOFOLLOW`, for `OpenOptionsExt::custom_flags`.
    pub const O_NOFOLLOW: i32 = libc::O_NOFOLLOW;
    /// `open(2)`'s `O_NONBLOCK`, for `OpenOptionsExt::custom_flags`.
    pub const O_NONBLOCK: i32 = libc::O_NONBLOCK;

    /// This process's real uid.
    pub fn getuid() -> u32 {
        // SAFETY: getuid has no preconditions and cannot fail.
        unsafe { libc::getuid() }
    }

    /// Sets `path`'s permission bits to `mode`.
    pub fn set_mode(path: &std::path::Path, mode: u32) -> std::io::Result<()> {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }
}

#[cfg(windows)]
mod windows {
    use std::fs::{DirBuilder, FileType, Metadata, OpenOptions, Permissions};
    use std::io;
    use std::net::Shutdown;
    use std::path::Path;
    use std::process::Command;
    use std::time::Duration;

    /// Accepted and ignored: Windows opens follow no Unix symlink rule.
    pub const O_NOFOLLOW: i32 = 0;
    /// Accepted and ignored.
    pub const O_NONBLOCK: i32 = 0;

    /// The uid the core runs as (`peer::current_uid`), so the ownership
    /// checks these routes make compare like for like.
    pub fn getuid() -> u32 {
        crate::relay::peer::current_uid()
    }

    /// Windows keeps no Unix mode; a file in the user's profile is already
    /// that user's.
    pub fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
        Ok(())
    }

    /// `std::os::unix::fs::MetadataExt`, as far as these routes read it.
    pub trait MetadataExt {
        /// Always this user's (`getuid`).
        fn uid(&self) -> u32;
        /// A private directory or regular file: `0o40700` or `0o100600`.
        fn mode(&self) -> u32;
        /// Windows has no inode number here: always 0, so identity checks
        /// that compare `(dev, ino)` never tell two files apart.
        fn ino(&self) -> u64;
        /// Always 0, as `ino`.
        fn dev(&self) -> u64;
        /// The last write, in seconds since the epoch, as Unix reports it.
        fn mtime(&self) -> i64;
        /// The nanoseconds past `mtime`.
        fn mtime_nsec(&self) -> i64;
    }

    impl MetadataExt for Metadata {
        fn uid(&self) -> u32 {
            getuid()
        }
        fn mtime(&self) -> i64 {
            self.modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |since| since.as_secs() as i64)
        }
        fn mtime_nsec(&self) -> i64 {
            self.modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |since| i64::from(since.subsec_nanos()))
        }
        fn mode(&self) -> u32 {
            if self.is_dir() {
                0o40700
            } else {
                0o100600
            }
        }
        fn ino(&self) -> u64 {
            0
        }
        fn dev(&self) -> u64 {
            0
        }
    }

    /// `std::os::unix::fs::PermissionsExt::mode` and `set_mode`.
    pub trait PermissionsExt {
        /// `0o700`, or `0o500` when read-only: private, and executable as
        /// Windows decides executability by extension, not mode.
        fn mode(&self) -> u32;
        /// Only the owner-write bit is kept, as the read-only flag.
        fn set_mode(&mut self, mode: u32);
    }

    impl PermissionsExt for Permissions {
        fn mode(&self) -> u32 {
            if self.readonly() {
                0o500
            } else {
                0o700
            }
        }
        fn set_mode(&mut self, mode: u32) {
            self.set_readonly(mode & 0o200 == 0);
        }
    }

    /// `std::os::unix::fs::FileTypeExt::is_socket`: nothing is a Unix
    /// socket here.
    pub trait FileTypeExt {
        fn is_socket(&self) -> bool;
        fn is_fifo(&self) -> bool;
    }

    impl FileTypeExt for FileType {
        fn is_socket(&self) -> bool {
            false
        }
        fn is_fifo(&self) -> bool {
            false
        }
    }

    /// `std::os::unix::fs::OpenOptionsExt`: both are accepted and ignored.
    pub trait OpenOptionsExt {
        fn mode(&mut self, mode: u32) -> &mut Self;
        fn custom_flags(&mut self, flags: i32) -> &mut Self;
    }

    impl OpenOptionsExt for OpenOptions {
        fn mode(&mut self, _mode: u32) -> &mut Self {
            self
        }
        fn custom_flags(&mut self, _flags: i32) -> &mut Self {
            self
        }
    }

    /// `std::os::unix::fs::DirBuilderExt::mode`: accepted and ignored.
    pub trait DirBuilderExt {
        fn mode(&mut self, mode: u32) -> &mut Self;
    }

    impl DirBuilderExt for DirBuilder {
        fn mode(&mut self, _mode: u32) -> &mut Self {
            self
        }
    }

    /// `std::os::unix::process::CommandExt::process_group`: a new console
    /// process group, Windows' nearest counterpart.
    pub trait CommandExt {
        fn process_group(&mut self, pgroup: i32) -> &mut Self;
    }

    impl CommandExt for Command {
        fn process_group(&mut self, _pgroup: i32) -> &mut Self {
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            std::os::windows::process::CommandExt::creation_flags(self, CREATE_NEW_PROCESS_GROUP)
        }
    }

    fn no_unix_sockets() -> io::Error {
        io::Error::new(
            io::ErrorKind::Unsupported,
            "Unix sockets are not available on Windows.",
        )
    }

    /// A Unix socket address; none exists here.
    #[derive(Debug)]
    pub enum SocketAddr {}

    impl SocketAddr {
        pub fn as_pathname(&self) -> Option<&Path> {
            match *self {}
        }
    }

    /// A Unix stream socket, which never connects here: no value exists,
    /// so every method past `connect` is unreachable.
    #[derive(Debug)]
    pub enum UnixStream {}

    impl UnixStream {
        pub fn connect<P: AsRef<Path>>(_path: P) -> io::Result<UnixStream> {
            Err(no_unix_sockets())
        }
        pub fn pair() -> io::Result<(UnixStream, UnixStream)> {
            Err(no_unix_sockets())
        }
        pub fn try_clone(&self) -> io::Result<UnixStream> {
            match *self {}
        }
        pub fn set_read_timeout(&self, _timeout: Option<Duration>) -> io::Result<()> {
            match *self {}
        }
        pub fn set_write_timeout(&self, _timeout: Option<Duration>) -> io::Result<()> {
            match *self {}
        }
        pub fn set_nonblocking(&self, _nonblocking: bool) -> io::Result<()> {
            match *self {}
        }
        pub fn shutdown(&self, _how: Shutdown) -> io::Result<()> {
            match *self {}
        }
        pub fn peer_addr(&self) -> io::Result<SocketAddr> {
            match *self {}
        }
        pub fn local_addr(&self) -> io::Result<SocketAddr> {
            match *self {}
        }
        pub fn take_error(&self) -> io::Result<Option<io::Error>> {
            match *self {}
        }
    }

    impl io::Read for UnixStream {
        fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
            match *self {}
        }
    }

    impl io::Write for UnixStream {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            match *self {}
        }
        fn flush(&mut self) -> io::Result<()> {
            match *self {}
        }
    }

    impl io::Read for &UnixStream {
        fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
            match **self {}
        }
    }

    impl io::Write for &UnixStream {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            match **self {}
        }
        fn flush(&mut self) -> io::Result<()> {
            match **self {}
        }
    }

    /// A Unix listening socket, which never binds here.
    #[derive(Debug)]
    pub enum UnixListener {}

    impl UnixListener {
        pub fn bind<P: AsRef<Path>>(_path: P) -> io::Result<UnixListener> {
            Err(no_unix_sockets())
        }
        pub fn accept(&self) -> io::Result<(UnixStream, SocketAddr)> {
            match *self {}
        }
        pub fn incoming(&self) -> std::iter::Empty<io::Result<UnixStream>> {
            match *self {}
        }
        pub fn set_nonblocking(&self, _nonblocking: bool) -> io::Result<()> {
            match *self {}
        }
        pub fn local_addr(&self) -> io::Result<SocketAddr> {
            match *self {}
        }
        pub fn try_clone(&self) -> io::Result<UnixListener> {
            match *self {}
        }
        pub fn take_error(&self) -> io::Result<Option<io::Error>> {
            match *self {}
        }
    }
}

#[cfg(test)]
#[cfg(windows)]
mod tests {
    use super::*;

    #[test]
    fn a_unix_only_harness_says_it_is_not_available_on_windows() {
        assert!(!SUPPORTED);
        assert_eq!(unavailable("Muse"), "Muse is not available on Windows.");
        assert_eq!(
            unsupported("Devin").as_deref(),
            Some("Devin is not available on Windows.")
        );
    }

    #[test]
    fn unix_sockets_neither_connect_nor_bind() {
        let path = std::env::temp_dir().join("agent-relay-no-unix-socket");
        assert_eq!(
            UnixStream::connect(&path).unwrap_err().kind(),
            std::io::ErrorKind::Unsupported
        );
        assert!(UnixListener::bind(&path).is_err());
    }

    #[test]
    fn files_in_the_profile_are_this_users_and_private() {
        let metadata = std::fs::metadata(std::env::temp_dir()).unwrap();
        assert_eq!(metadata.uid(), getuid());
        assert_eq!(metadata.mode() & 0o077, 0);
        assert!(!metadata.file_type().is_socket());
    }
}
