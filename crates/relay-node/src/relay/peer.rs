//! Operating-system identity of a process connected to a local socket.
//!
//! The bridge admits only clients the kernel reports as this user. A client's
//! claim about itself is never consulted: Linux reads `SO_PEERCRED`, macOS
//! reads the uid with `getpeereid` and the pid with `LOCAL_PEERPID`.
//!
//! Windows has no uids. There a "uid" is a stable 32-bit value derived from
//! the user's SID ([`uid_for_sid`]): [`current_uid`] is this user's, and
//! [`process_uid`] maps any process into the same space, so `uid ==
//! current_uid()` keeps meaning "this user" everywhere. The named pipe's
//! DACL is what admits a client (`relay::transport`).

use std::io;
#[cfg(unix)]
use std::os::fd::AsRawFd;

/// The connecting process as the kernel reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PeerCredentials {
    pub uid: u32,
    /// `None` where the platform does not report it.
    pub pid: Option<i32>,
}

/// Reads the peer credentials of a connected Unix stream socket.
#[cfg(unix)]
pub fn peer_credentials(socket: &impl AsRawFd) -> io::Result<PeerCredentials> {
    imp::peer_credentials(socket.as_raw_fd())
}

/// This process's effective uid, the only uid the bridge admits.
#[cfg(unix)]
pub fn current_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

/// This user's uid: the value [`uid_for_sid`] gives this process's user
/// SID, the same in every process the user runs.
#[cfg(windows)]
pub fn current_uid() -> u32 {
    static UID: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    // A process can always read its own token; `u32::MAX` stands in only if
    // it somehow cannot, and then no other process matches it.
    *UID.get_or_init(|| {
        current_user_sid()
            .map(|sid| uid_for_sid(&sid))
            .unwrap_or(u32::MAX)
    })
}

/// This process's user SID in string form (`S-1-5-21-...`).
#[cfg(windows)]
pub fn current_user_sid() -> io::Result<String> {
    static SID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    if let Some(sid) = SID.get() {
        return Ok(sid.clone());
    }
    let sid = windows::current_user_sid()?;
    Ok(SID.get_or_init(|| sid).clone())
}

/// The uid of the user process `pid` runs as.
#[cfg(windows)]
pub fn process_uid(pid: u32) -> io::Result<u32> {
    windows::process_user_sid(pid).map(|sid| uid_for_sid(&sid))
}

/// The uid a SID maps to: the first four bytes of the SHA-256 of its
/// upper-case string form. Defined everywhere so it is tested everywhere.
pub fn uid_for_sid(sid: &str) -> u32 {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(sid.to_ascii_uppercase().as_bytes());
    u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]])
}

#[cfg(any(target_os = "linux", target_os = "android"))]
mod imp {
    use super::PeerCredentials;
    use std::{io, mem, os::fd::RawFd};

    pub fn peer_credentials(fd: RawFd) -> io::Result<PeerCredentials> {
        let mut credentials: libc::ucred = unsafe { mem::zeroed() };
        let mut length = mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: `credentials` and `length` are valid for the duration of the
        // call and sized for SO_PEERCRED.
        let result = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut length,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(PeerCredentials {
            uid: credentials.uid,
            pid: (credentials.pid > 0).then_some(credentials.pid),
        })
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod imp {
    use super::PeerCredentials;
    use std::{io, mem, os::fd::RawFd};

    pub fn peer_credentials(fd: RawFd) -> io::Result<PeerCredentials> {
        let mut uid: libc::uid_t = 0;
        let mut gid: libc::gid_t = 0;
        // SAFETY: both out-pointers are valid for the call.
        if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let mut pid: libc::pid_t = 0;
        let mut length = mem::size_of::<libc::pid_t>() as libc::socklen_t;
        // SAFETY: `pid` and `length` are valid and sized for LOCAL_PEERPID.
        let result = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_LOCAL,
                libc::LOCAL_PEERPID,
                (&mut pid as *mut libc::pid_t).cast(),
                &mut length,
            )
        };
        Ok(PeerCredentials {
            uid,
            pid: (result == 0 && pid > 0).then_some(pid),
        })
    }
}

#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    ))
))]
mod imp {
    use super::PeerCredentials;
    use std::{io, os::fd::RawFd};

    pub fn peer_credentials(_fd: RawFd) -> io::Result<PeerCredentials> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "peer credentials are unavailable on this platform",
        ))
    }
}

/// Token queries: the user SID of this process or another.
#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::io;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// Closes a handle this module opened.
    struct Owned(HANDLE);

    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: the handle was opened here and is closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    pub fn current_user_sid() -> io::Result<String> {
        // SAFETY: GetCurrentProcess returns a pseudo-handle that is always
        // valid and needs no closing.
        token_user_sid(unsafe { GetCurrentProcess() })
    }

    pub fn process_user_sid(pid: u32) -> io::Result<String> {
        // SAFETY: OpenProcess has no memory preconditions; null is failure.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let process = Owned(process);
        token_user_sid(process.0)
    }

    fn token_user_sid(process: HANDLE) -> io::Result<String> {
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: `process` is a valid process handle and `token` a valid
        // out-pointer.
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = Owned(token);
        let mut needed = 0u32;
        // SAFETY: a size query; a null buffer of length 0 only sets `needed`.
        unsafe { GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
        if needed == 0 {
            return Err(io::Error::last_os_error());
        }
        // u64s, so the TOKEN_USER the buffer receives is aligned.
        let mut buffer = vec![0u64; (needed as usize + 7) / 8];
        // SAFETY: `buffer` holds at least `needed` bytes and outlives the
        // call.
        let filled = unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                buffer.as_mut_ptr().cast::<c_void>(),
                needed,
                &mut needed,
            )
        };
        if filled == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the call filled the aligned buffer with a TOKEN_USER whose
        // SID points into the same buffer, which outlives its use below.
        let sid = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
        let mut text: *mut u16 = std::ptr::null_mut();
        // SAFETY: `sid` is valid while `buffer` lives; on success `text`
        // receives a LocalAlloc'd NUL-terminated string, freed below.
        if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `text` is NUL-terminated; it is read once, then freed once.
        let string = unsafe {
            let length = (0..).take_while(|&index| *text.add(index) != 0).count();
            let string = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
            LocalFree(text as _);
            string
        };
        Ok(string)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_socket_pair_reports_this_user_and_process() {
        use std::os::unix::net::UnixStream;
        let (left, _right) = UnixStream::pair().unwrap();
        let credentials = peer_credentials(&left).unwrap();
        assert_eq!(credentials.uid, current_uid());
        assert_eq!(credentials.pid, Some(std::process::id() as i32));
    }

    #[test]
    fn a_sid_maps_to_one_uid_whatever_its_case() {
        let sid = "S-1-5-21-1004336348-1177238915-682003330-512";
        assert_eq!(uid_for_sid(sid), uid_for_sid(&sid.to_lowercase()));
        assert_ne!(uid_for_sid(sid), uid_for_sid("S-1-5-18"));
    }

    #[cfg(windows)]
    #[test]
    fn this_process_is_this_user() {
        assert!(current_user_sid().unwrap().starts_with("S-1-"));
        assert_eq!(process_uid(std::process::id()).unwrap(), current_uid());
    }
}
