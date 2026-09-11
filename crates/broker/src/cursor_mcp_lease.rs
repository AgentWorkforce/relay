//! Crash-recoverable leases for a generated Cursor `.cursor/mcp.json`.

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::ids::WorkerName;

#[derive(Debug, Clone)]
enum PreExisting {
    Absent { created_dir: bool },
    Present { contents: Vec<u8>, mode: u32 },
}

struct LeaseState {
    pre_existing: PreExisting,
    holders: HashSet<WorkerName>,
    lock: LeaseLock,
    /// The exact `.cursor` directory captured while acquiring `lock`. Keeping
    /// this descriptor alive is essential: the pathname may be renamed and
    /// replaced while a worker is running, but all generated-file I/O and
    /// cleanup must continue to address the original directory.
    cursor_dir: Option<fs::File>,
    #[cfg(windows)]
    cursor_identity: (u32, u64),
    #[cfg(windows)]
    generated_identity: std::sync::Mutex<Option<(u32, u64)>>,
}

/// A kernel-held lock on the requested cwd. Locking the existing cwd rather
/// than a lock file inside `.cursor` avoids leaving stale lock files/directories
/// behind and makes separate broker processes fail closed before they can
/// overwrite one another's placeholder config.
struct LeaseLock {
    #[cfg(unix)]
    _file: fs::File,
    #[cfg(not(unix))]
    _file: fs::File,
    #[cfg(windows)]
    root: PathBuf,
    #[cfg(windows)]
    root_identity: (u32, u64),
}

enum CursorAcquireError {
    Lock(io::Error),
    Cursor { lock: LeaseLock, error: io::Error },
}

#[cfg(unix)]
impl LeaseLock {
    fn root_fd(&self) -> std::os::unix::io::RawFd {
        use std::os::unix::io::AsRawFd;
        self._file.as_raw_fd()
    }

    fn open_cursor_dir(&self, create: bool) -> io::Result<(fs::File, bool)> {
        self.open_cursor_dir_with(create, |root_fd, cursor, mode| {
            let result = unsafe { libc::mkdirat(root_fd, cursor.as_ptr(), mode) };
            if result == 0 {
                return Ok(true);
            }
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::AlreadyExists {
                Ok(false)
            } else {
                Err(error)
            }
        })
    }

    fn open_cursor_dir_with<F>(&self, create: bool, mkdir: F) -> io::Result<(fs::File, bool)>
    where
        F: FnOnce(std::os::unix::io::RawFd, &std::ffi::CStr, libc::mode_t) -> io::Result<bool>,
    {
        let cursor = std::ffi::CString::new(".cursor").expect("literal has no NUL");
        match openat_dir(self.root_fd(), &cursor) {
            Ok(file) => Ok((file, false)),
            Err(error) if error.kind() == io::ErrorKind::NotFound && create => {
                let created = mkdir(self.root_fd(), &cursor, 0o700)?;
                // EEXIST means another creator won the race. Do not mark its
                // directory as ours, or cleanup could remove an unrelated
                // .cursor directory when this lease is released.
                Ok((openat_dir(self.root_fd(), &cursor)?, created))
            }
            Err(error) => Err(error),
        }
    }
}

impl LeaseLock {
    fn acquire(root: &Path, _lock_path: Option<&Path>) -> io::Result<Self> {
        #[cfg(unix)]
        {
            let file = open_dir_nofollow(root)?;
            file.try_lock().map_err(|error| match error {
                fs::TryLockError::WouldBlock => io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "another broker owns the Cursor MCP cwd lease",
                ),
                fs::TryLockError::Error(error) => error,
            })?;
            Ok(Self { _file: file })
        }
        #[cfg(not(unix))]
        {
            let lock_path = _lock_path
                .map(PathBuf::from)
                .unwrap_or_else(|| root.join(".cursor-mcp-lease.lock"));
            #[cfg(windows)]
            let file = windows_lock_file(&lock_path)?;
            #[cfg(not(windows))]
            let file = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .open(&lock_path)?;
            file.try_lock().map_err(|error| match error {
                fs::TryLockError::WouldBlock => io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "another broker owns the Cursor MCP cwd lease",
                ),
                fs::TryLockError::Error(error) => error,
            })?;
            Ok(Self {
                _file: file,
                #[cfg(windows)]
                root: root.to_path_buf(),
                #[cfg(windows)]
                root_identity: windows_directory_identity(root)?,
            })
        }
    }

    fn acquire_with_cursor(
        root: &Path,
        create_cursor: bool,
        lock_path: Option<&Path>,
    ) -> Result<(Self, Option<fs::File>, bool), CursorAcquireError> {
        let lock = Self::acquire(root, lock_path).map_err(CursorAcquireError::Lock)?;
        #[cfg(unix)]
        {
            match lock.open_cursor_dir(create_cursor) {
                Ok((cursor, created)) => Ok((lock, Some(cursor), created)),
                Err(error) if !create_cursor && error.kind() == io::ErrorKind::NotFound => {
                    // Recovery must retain the cwd lock even when the
                    // journaled `.cursor` directory has disappeared. The
                    // caller will keep the journal entry and finalize while
                    // still holding this lock.
                    Ok((lock, None, false))
                }
                Err(error) => Err(CursorAcquireError::Cursor { lock, error }),
            }
        }
        #[cfg(not(unix))]
        {
            let _ = create_cursor;
            Ok((lock, None, false))
        }
    }
}

#[cfg(windows)]
fn windows_lock_file(path: &Path) -> io::Result<fs::File> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, OwnedHandle};

    let before = windows_path_identity(path).ok();
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *const std::ffi::c_void,
            disposition: u32,
            flags: u32,
            template: *mut std::ffi::c_void,
        ) -> *mut std::ffi::c_void;
    }
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const FILE_SHARE_READ: u32 = 1;
    const FILE_SHARE_WRITE: u32 = 2;
    const OPEN_ALWAYS: u32 = 4;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_ALWAYS,
            FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == (-1isize) as *mut std::ffi::c_void {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { fs::File::from(OwnedHandle::from_raw_handle(handle)) };
    let after = windows_handle_identity(&file)?;
    if let Some(before) = before {
        if before != after {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "Cursor MCP lock file was replaced",
            ));
        }
    }
    Ok(file)
}

#[cfg(windows)]
fn windows_path_identity(path: &Path) -> io::Result<(u32, u64)> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, OwnedHandle};

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *const std::ffi::c_void,
            disposition: u32,
            flags: u32,
            template: *mut std::ffi::c_void,
        ) -> *mut std::ffi::c_void;
    }
    const GENERIC_READ: u32 = 0x8000_0000;
    const FILE_SHARE_READ: u32 = 1;
    const FILE_SHARE_WRITE: u32 = 2;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == (-1isize) as *mut std::ffi::c_void {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { fs::File::from(OwnedHandle::from_raw_handle(handle)) };
    windows_handle_identity(&file)
}

#[cfg(windows)]
fn windows_child_file(path: &Path, write: bool, delete: bool) -> io::Result<fs::File> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, OwnedHandle};

    let expected = windows_path_identity(path)?;

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *const std::ffi::c_void,
            disposition: u32,
            flags: u32,
            template: *mut std::ffi::c_void,
        ) -> *mut std::ffi::c_void;
    }
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const DELETE: u32 = 0x0001_0000;
    const FILE_SHARE_READ: u32 = 1;
    const FILE_SHARE_WRITE: u32 = 2;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            if write {
                GENERIC_READ | GENERIC_WRITE
            } else {
                GENERIC_READ
            } | if delete { DELETE } else { 0 },
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == (-1isize) as *mut std::ffi::c_void {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { fs::File::from(OwnedHandle::from_raw_handle(handle)) };
    let opened = windows_handle_identity(&file)?;
    if opened != expected {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "Cursor MCP child was replaced while opening",
        ));
    }
    Ok(file)
}

#[cfg(windows)]
fn windows_handle_identity(file: &fs::File) -> io::Result<(u32, u64)> {
    let (identity, attributes) = windows_handle_metadata(file)?;
    if attributes & 0x10 != 0 || attributes & 0x400 != 0 {
        return Err(invalid_path(
            "Cursor MCP child handle is not a regular non-reparse file",
        ));
    }
    Ok(identity)
}

#[cfg(windows)]
fn windows_handle_metadata(file: &fs::File) -> io::Result<((u32, u64), u32)> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct Information {
        attributes: u32,
        creation: [u32; 2],
        access: [u32; 2],
        write: [u32; 2],
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(file: *mut std::ffi::c_void, info: *mut Information) -> i32;
    }
    let mut info = std::mem::MaybeUninit::<Information>::uninit();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    Ok((
        (
            info.volume,
            (u64::from(info.index_high) << 32) | u64::from(info.index_low),
        ),
        info.attributes,
    ))
}

#[cfg(windows)]
fn windows_delete_file(file: fs::File) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct Disposition {
        delete: u8,
    }
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn SetFileInformationByHandle(
            file: *mut std::ffi::c_void,
            class: u32,
            info: *const Disposition,
            size: u32,
        ) -> i32;
    }
    let disposition = Disposition { delete: 1 };
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            4,
            &disposition,
            std::mem::size_of::<Disposition>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
fn windows_directory_identity(path: &Path) -> io::Result<(u32, u64)> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *const std::ffi::c_void,
            disposition: u32,
            flags: u32,
            template: *mut std::ffi::c_void,
        ) -> *mut std::ffi::c_void;
    }
    const GENERIC_READ: u32 = 0x8000_0000;
    const FILE_SHARE_READ: u32 = 1;
    const FILE_SHARE_WRITE: u32 = 2;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == (-1isize) as *mut std::ffi::c_void {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { fs::File::from(OwnedHandle::from_raw_handle(handle)) };
    let (identity, attributes) = windows_handle_metadata(&file)?;
    if attributes & 0x10 == 0 || attributes & 0x400 != 0 {
        return Err(invalid_path(format!(
            "Cursor worker cwd is not a non-reparse directory: {}",
            path.display()
        )));
    }
    Ok(identity)
}

#[cfg(windows)]
struct WindowsDirectoryGuard(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
fn windows_directory_guard(path: &Path) -> io::Result<WindowsDirectoryGuard> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, OwnedHandle};

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *const std::ffi::c_void,
            disposition: u32,
            flags: u32,
            template: *mut std::ffi::c_void,
        ) -> *mut std::ffi::c_void;
    }
    const GENERIC_READ: u32 = 0x8000_0000;
    const FILE_SHARE_READ: u32 = 1;
    const FILE_SHARE_WRITE: u32 = 2;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == (-1isize) as *mut std::ffi::c_void {
        return Err(io::Error::last_os_error());
    }
    Ok(WindowsDirectoryGuard(unsafe {
        OwnedHandle::from_raw_handle(handle)
    }))
}

#[cfg(windows)]
impl LeaseLock {
    fn validate_root(&self) -> io::Result<()> {
        let canonical = canonical_root(&self.root)?;
        if canonical != self.root || windows_directory_identity(&canonical)? != self.root_identity {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "Cursor worker cwd was replaced during lease",
            ));
        }
        Ok(())
    }
}

#[cfg(windows)]
fn validate_windows_cursor_identity(
    lock: &LeaseLock,
    path: &Path,
    expected: (u32, u64),
) -> io::Result<()> {
    lock.validate_root()?;
    let cursor = path
        .parent()
        .ok_or_else(|| invalid_path("Cursor MCP path has no parent"))?;
    if cursor != lock.root.join(".cursor") || windows_directory_identity(cursor)? != expected {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "Cursor .cursor directory was replaced during lease",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn validate_windows_restore_path(
    lock: &LeaseLock,
    path: &Path,
    expected: Option<(u32, u64)>,
) -> io::Result<()> {
    lock.validate_root()?;
    let cursor = path
        .parent()
        .ok_or_else(|| invalid_path("Cursor MCP path has no parent"))?;
    let actual = windows_directory_identity(cursor).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("Cursor .cursor directory cannot be validated during cleanup: {error}"),
        )
    })?;
    if cursor != lock.root.join(".cursor") || expected.is_some_and(|identity| identity != actual) {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "Cursor .cursor directory was replaced during cleanup",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn open_dir_nofollow(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::FromRawFd;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| invalid_path("directory path contains NUL"))?;
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let fd = unsafe { libc::open(path.as_ptr(), flags) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn openat_dir(parent: std::os::unix::io::RawFd, name: &std::ffi::CStr) -> io::Result<fs::File> {
    use std::os::unix::io::FromRawFd;
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let fd = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { fs::File::from_raw_fd(fd) })
}

#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    entries: Vec<JournalEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JournalEntry {
    path: PathBuf,
    pre_existing: JournalPreExisting,
    #[cfg(windows)]
    #[serde(default)]
    generated_identity: Option<(u32, u64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum JournalPreExisting {
    Absent { created_dir: bool },
    Present { contents_base64: String, mode: u32 },
}

#[cfg(windows)]
#[repr(C)]
struct WindowsDataBlob {
    cb_data: u32,
    pb_data: *mut u8,
}

#[cfg(windows)]
#[link(name = "Crypt32")]
unsafe extern "system" {
    fn CryptProtectData(
        data_in: *const WindowsDataBlob,
        description: *const u16,
        entropy: *const WindowsDataBlob,
        reserved: *mut std::ffi::c_void,
        prompt: *mut std::ffi::c_void,
        flags: u32,
        data_out: *mut WindowsDataBlob,
    ) -> i32;
    fn CryptUnprotectData(
        data_in: *const WindowsDataBlob,
        description: *mut *mut u16,
        entropy: *const WindowsDataBlob,
        reserved: *mut std::ffi::c_void,
        prompt: *mut std::ffi::c_void,
        flags: u32,
        data_out: *mut WindowsDataBlob,
    ) -> i32;
}

#[cfg(windows)]
#[link(name = "Kernel32")]
unsafe extern "system" {
    fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

#[cfg(windows)]
fn protect_journal_bytes(bytes: &[u8]) -> io::Result<Vec<u8>> {
    let input = WindowsDataBlob {
        cb_data: bytes.len().try_into().map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Cursor MCP journal entry is too large",
            )
        })?,
        pb_data: bytes.as_ptr() as *mut u8,
    };
    let mut output = WindowsDataBlob {
        cb_data: 0,
        pb_data: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize) }.to_vec();
    unsafe { LocalFree(output.pb_data as *mut std::ffi::c_void) };
    let mut versioned = b"relay-dpapi-v1:".to_vec();
    versioned.extend(result);
    Ok(versioned)
}

#[cfg(windows)]
fn unprotect_journal_bytes(bytes: &[u8]) -> io::Result<Vec<u8>> {
    const PREFIX: &[u8] = b"relay-dpapi-v1:";
    if !bytes.starts_with(PREFIX) {
        // Journals written before Windows encryption used ordinary base64
        // bytes. Treat those as a supported legacy format and immediately
        // rewrite them through the versioned DPAPI path on the next persist;
        // never attempt DPAPI on an unversioned payload.
        return Ok(bytes.to_vec());
    }
    let bytes = &bytes[PREFIX.len()..];
    let input = WindowsDataBlob {
        cb_data: bytes.len().try_into().map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Cursor MCP journal entry is too large",
            )
        })?,
        pb_data: bytes.as_ptr() as *mut u8,
    };
    let mut output = WindowsDataBlob {
        cb_data: 0,
        pb_data: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize) }.to_vec();
    unsafe { LocalFree(output.pb_data as *mut std::ffi::c_void) };
    Ok(result)
}

/// Tracks leases and a recovery journal. The journal contains pre-existing
/// bytes and mode, which may themselves be sensitive user data; it is written
/// 0600 on Unix and protected with the current user's DPAPI on Windows. The
/// generated Relay values are always `${env:...}` placeholders, never secrets.
#[derive(Default)]
pub(crate) struct CursorMcpLeaseRegistry {
    leases: HashMap<PathBuf, LeaseState>,
    path_by_worker: HashMap<WorkerName, PathBuf>,
    journal_path: Option<PathBuf>,
    deferred_journal: HashMap<PathBuf, JournalEntry>,
    journal_owned_paths: HashSet<PathBuf>,
}

fn invalid_path(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn canonical_root(root: &Path) -> io::Result<PathBuf> {
    let metadata = fs::symlink_metadata(root)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_path(format!(
            "Cursor worker cwd is not a non-symlink directory: {}",
            root.display()
        )));
    }
    root.canonicalize()
}

fn validate_cursor_dir(root: &Path) -> io::Result<bool> {
    let cursor_dir = root.join(".cursor");
    match fs::symlink_metadata(&cursor_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(invalid_path(".cursor must not be a symlink"))
        }
        Ok(metadata) if !metadata.is_dir() => {
            Err(invalid_path(".cursor exists but is not a directory"))
        }
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn validate_target(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(invalid_path(".cursor/mcp.json must not be a symlink"))
        }
        Ok(metadata) if !metadata.is_file() => Err(invalid_path(
            ".cursor/mcp.json exists but is not a regular file",
        )),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

pub(crate) fn validate_cursor_root(root: &Path) -> io::Result<()> {
    let canonical = canonical_root(root)?;
    let cursor_exists = validate_cursor_dir(&canonical)?;
    let path = canonical.join(".cursor").join("mcp.json");
    if cursor_exists {
        let _ = validate_target(&path)?;
    }
    Ok(())
}

fn lease_path(root: &Path) -> io::Result<(PathBuf, PathBuf)> {
    let canonical = canonical_root(root)?;
    let cursor_exists = validate_cursor_dir(&canonical)?;
    let key = canonical.join(".cursor").join("mcp.json");
    if cursor_exists {
        let _ = validate_target(&key)?;
    }
    Ok((key, canonical))
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    open_write_nofollow(path)?.set_permissions(fs::Permissions::from_mode(mode & 0o777))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_dir(path: &Path) -> io::Result<()> {
    fs::File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_dir(_path: &Path) -> io::Result<()> {
    Ok(())
}

fn sync_file(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        open_read_nofollow(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        fs::File::open(path)?.sync_all()
    }
}

fn sync_entry_parent(path: &Path) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid_path("durable entry has no parent"))?;
    sync_dir(parent)?;
    if let Some(grandparent) = parent.parent() {
        sync_dir(grandparent)?;
    }
    Ok(())
}

fn validate_credential_parent(parent: &Path) -> io::Result<()> {
    match fs::symlink_metadata(parent) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(invalid_path("credential parent must not be a symlink"));
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(invalid_path("credential parent must be a directory"));
        }
        Ok(_) => {}
        Err(error) => return Err(error),
    }
    Ok(())
}

#[cfg(unix)]
fn open_read_nofollow(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

#[cfg(unix)]
fn open_write_nofollow(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

#[cfg(unix)]
fn open_cursor_target(cursor: &fs::File) -> io::Result<Option<fs::File>> {
    use std::os::unix::io::{AsRawFd, FromRawFd};
    let name = std::ffi::CString::new("mcp.json").expect("literal has no NUL");
    let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let fd = unsafe { libc::openat(cursor.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::NotFound {
            Ok(None)
        } else if error.raw_os_error() == Some(libc::ELOOP) {
            Err(invalid_path(".cursor/mcp.json must not be a symlink"))
        } else {
            Err(error)
        };
    }
    let file = unsafe { fs::File::from_raw_fd(fd) };
    if !file.metadata()?.is_file() {
        return Err(invalid_path(".cursor/mcp.json must be a regular file"));
    }
    Ok(Some(file))
}

#[cfg(unix)]
fn read_cursor_target(cursor: &fs::File) -> io::Result<Option<(Vec<u8>, u32)>> {
    use std::os::unix::fs::PermissionsExt;
    let Some(mut file) = open_cursor_target(cursor)? else {
        return Ok(None);
    };
    let mut contents = Vec::new();
    file.read_to_end(&mut contents)?;
    let mode = file.metadata()?.permissions().mode() & 0o777;
    Ok(Some((contents, mode)))
}

#[cfg(unix)]
fn write_cursor_target(cursor: &fs::File, contents: &[u8]) -> io::Result<()> {
    use std::os::unix::io::{AsRawFd, FromRawFd};
    let temp_name = format!(".mcp.json.{}.tmp", Uuid::new_v4().simple());
    let temp = std::ffi::CString::new(temp_name.as_str()).expect("UUID has no NUL");
    let target = std::ffi::CString::new("mcp.json").expect("literal has no NUL");
    let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let fd = unsafe { libc::openat(cursor.as_raw_fd(), temp.as_ptr(), flags, 0o600) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut file = unsafe { fs::File::from_raw_fd(fd) };
    let result = (|| {
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        let result = unsafe {
            libc::renameat(
                cursor.as_raw_fd(),
                temp.as_ptr(),
                cursor.as_raw_fd(),
                target.as_ptr(),
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        let target_file = open_cursor_target(cursor)?.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "renamed Cursor MCP target disappeared",
            )
        })?;
        target_file.sync_all()?;
        cursor.sync_all()
    })();
    if result.is_err() {
        let _ = unsafe { libc::unlinkat(cursor.as_raw_fd(), temp.as_ptr(), 0) };
    }
    result
}

#[cfg(unix)]
fn remove_cursor_target(cursor: &fs::File) -> io::Result<bool> {
    use std::os::unix::io::AsRawFd;
    let name = std::ffi::CString::new("mcp.json").expect("literal has no NUL");
    let _ = open_cursor_target(cursor)?;
    let result = unsafe { libc::unlinkat(cursor.as_raw_fd(), name.as_ptr(), 0) };
    if result == 0 {
        cursor.sync_all()?;
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.kind() == io::ErrorKind::NotFound {
        Ok(false)
    } else {
        Err(error)
    }
}

#[cfg(unix)]
fn remove_cursor_dir(lock: &LeaseLock, cursor: &fs::File) -> io::Result<()> {
    use std::os::unix::io::AsRawFd;
    let name = std::ffi::CString::new(".cursor").expect("literal has no NUL");
    let mut cursor_stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(cursor.as_raw_fd(), cursor_stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let cursor_stat = unsafe { cursor_stat.assume_init() };
    let mut entry_stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        libc::fstatat(
            lock.root_fd(),
            name.as_ptr(),
            entry_stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::NotFound {
            // The directory was already removed — cleanup is idempotently
            // complete.  Another process or a prior retry may have removed
            // it between the credential-file write and journal persistence.
            return Ok(());
        }
        return Err(error);
    }
    let entry_stat = unsafe { entry_stat.assume_init() };
    if cursor_stat.st_dev != entry_stat.st_dev || cursor_stat.st_ino != entry_stat.st_ino {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "refusing to remove a replacement .cursor directory",
        ));
    }
    let result = unsafe { libc::unlinkat(lock.root_fd(), name.as_ptr(), libc::AT_REMOVEDIR) };
    if result == 0 {
        lock._file.sync_all()?;
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.kind() == io::ErrorKind::NotFound {
        Ok(())
    } else {
        Err(error)
    }
}

/// Write a generated credential-bearing config safely for the platform. Unix
/// uses an owner-only temporary file and atomic rename. Windows uses a pinned
/// parent and child handle: existing files are updated in place to preserve
/// their security descriptor, while new files use a secured temporary file.
pub(crate) fn write_credential_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    write_credential_file_with_identity(path, contents).map(|_| ())
}

fn write_credential_file_with_identity(
    path: &Path,
    contents: &[u8],
) -> io::Result<Option<(u32, u64)>> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "credential path has no parent")
    })?;
    if !parent.exists() {
        fs::create_dir_all(parent)?;
    }
    validate_credential_parent(parent)?;
    let _ = validate_target(path)?;
    #[cfg(windows)]
    let _parent_guard = windows_directory_guard(parent)?;
    #[cfg(windows)]
    if validate_target(path)? {
        // Preserve the user's security descriptor for an existing config.
        // Replacing it with a temporary file would silently change ACLs and
        // make exact restoration impossible. The child handle and identity
        // check bind this mutation to the file validated above.
        let mut file = windows_child_file(path, true, false)?;
        file.set_len(0)?;
        file.write_all(contents)?;
        file.sync_all()?;
        return Ok(Some(windows_handle_identity(&file)?));
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("mcp.json");
    let temporary = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4().simple()));

    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        #[cfg(windows)]
        secure_windows_file(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        validate_credential_parent(parent)?;
        // The generated path was absent when this lease was acquired. Never
        // remove a file that appeared while the temporary file was written:
        // on Windows that pathname race could otherwise delete an unrelated
        // replacement. A rename failure is fail-closed and leaves the
        // replacement untouched.
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        set_mode(path, 0o600)?;
        sync_file(path)?;
        sync_entry_parent(path)?;
        #[cfg(windows)]
        let identity = Some(windows_handle_identity(&windows_child_file(
            path, false, false,
        )?)?);
        #[cfg(not(windows))]
        let identity = None;
        Ok(identity)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(windows)]
fn secure_windows_file(path: &Path) -> io::Result<()> {
    use std::process::Command;

    let system32 = windows_system_directory()?;
    let whoami_path = system32.join("whoami.exe");
    let icacls_path = system32.join("icacls.exe");

    // `icacls` is part of supported Windows installations.  Resolve the SID
    // rather than trusting a username, then remove inherited permissions and
    // grant access only to the current user and SYSTEM.  Fail closed if
    // either utility is unavailable; an unprotected generated config must
    // not be published because it may contain restored user configuration.
    let whoami = Command::new(&whoami_path)
        .args(["/user", "/fo", "csv", "/nh"])
        .output()?;
    let whoami_stdout = String::from_utf8_lossy(&whoami.stdout).into_owned();
    let whoami_stderr = String::from_utf8_lossy(&whoami.stderr).into_owned();
    if !whoami.status.success() {
        tracing::error!(
            whoami = %whoami_path.display(),
            exit = ?whoami.status,
            stdout = %whoami_stdout,
            stderr = %whoami_stderr,
            "whoami failed to resolve Windows user SID"
        );
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "unable to resolve current Windows user SID",
        ));
    }
    let sid = whoami_stdout
        .trim()
        .split(',')
        .next_back()
        .map(str::trim)
        .map(|sid| sid.trim_matches('"'))
        .filter(|sid| sid.starts_with("S-"))
        .ok_or_else(|| {
            tracing::error!(
                whoami = %whoami_path.display(),
                stdout = %whoami_stdout,
                "whoami did not return a SID in the expected CSV format"
            );
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "whoami did not return a Windows user SID",
            )
        })?;
    // Step 1 – Grant the current user and SYSTEM full control.  This is the
    // critical security property: without it anyone on the box could read the
    // credential file.
    let grant_out = Command::new(&icacls_path)
        .arg(path)
        .args(["/grant:r", &format!("{sid}:F"), "SYSTEM:F"])
        .output()?;
    let grant_stdout = String::from_utf8_lossy(&grant_out.stdout).into_owned();
    let grant_stderr = String::from_utf8_lossy(&grant_out.stderr).into_owned();
    if !grant_out.status.success() {
        tracing::error!(
            icacls = %icacls_path.display(),
            path = %path.display(),
            sid = %sid,
            exit = ?grant_out.status,
            stdout = %grant_stdout,
            stderr = %grant_stderr,
            "icacls /grant:r failed to secure generated Cursor config"
        );
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "unable to apply owner-only Windows ACL to generated Cursor config: \
                 icacls exit {:?}, stderr: {}",
                grant_out.status,
                grant_stderr.trim(),
            ),
        ));
    }
    // Step 2 – Strip inherited ACEs (best-effort).  On locked-down hosts
    // (e.g. GitHub Actions runners) /inheritance:r may fail because the
    // parent DACL denies the modification, but the explicit grant above
    // already enforces owner-only access.
    let inh_out = Command::new(&icacls_path)
        .arg(path)
        .args(["/inheritance:r"])
        .output();
    if let Ok(result) = inh_out {
        if !result.status.success() {
            tracing::warn!(
                path = %path.display(),
                exit = ?result.status,
                stderr = %String::from_utf8_lossy(&result.stderr),
                "icacls /inheritance:r failed; owner-only ACL still enforced via explicit grant"
            );
        }
    }
    Ok(())
}

#[cfg(windows)]
fn windows_system_directory() -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, length: u32) -> u32;
    }
    let mut buffer = vec![0u16; 260];
    loop {
        let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        if (length as usize) < buffer.len() {
            let path = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length as usize]));
            if !path.is_absolute() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Windows system directory is not absolute",
                ));
            }
            return Ok(path);
        }
        buffer.resize(buffer.len().saturating_mul(2), 0);
    }
}

#[cfg(not(unix))]
fn restore_file(path: &Path, contents: &[u8], mode: u32) -> io::Result<()> {
    let _ = validate_target(path)?;
    write_credential_file(path, contents)?;
    set_mode(path, mode)?;
    sync_file(path)?;
    sync_entry_parent(path)?;
    Ok(())
}

impl PreExisting {
    fn journal(&self) -> io::Result<JournalPreExisting> {
        Ok(match self {
            Self::Absent { created_dir } => JournalPreExisting::Absent {
                created_dir: *created_dir,
            },
            Self::Present { contents, mode } => {
                #[cfg(windows)]
                let contents = protect_journal_bytes(contents)?;
                #[cfg(not(windows))]
                let contents = contents.clone();
                JournalPreExisting::Present {
                    contents_base64: base64::engine::general_purpose::STANDARD.encode(contents),
                    mode: *mode,
                }
            }
        })
    }

    fn from_journal(value: JournalPreExisting) -> io::Result<Self> {
        match value {
            JournalPreExisting::Absent { created_dir } => Ok(Self::Absent { created_dir }),
            JournalPreExisting::Present {
                contents_base64,
                mode,
            } => {
                let contents = base64::engine::general_purpose::STANDARD
                    .decode(contents_base64.as_bytes())
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                #[cfg(windows)]
                let contents = unprotect_journal_bytes(&contents)?;
                Ok(Self::Present { contents, mode })
            }
        }
    }
}

impl CursorMcpLeaseRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Construct a registry and recover any leases left by a crashed broker.
    /// Recovery is safe because the journal never stores generated credentials.
    pub(crate) fn with_journal(path: PathBuf) -> Self {
        let mut registry = Self {
            journal_path: Some(path),
            ..Self::default()
        };
        if let Err(error) = registry.recover_journal() {
            tracing::error!(error = %error, "failed to recover Cursor MCP lease journal; retaining it for a later retry");
        }
        registry
    }

    fn lock_path(&self, root: &Path) -> io::Result<PathBuf> {
        let journal_dir = self
            .journal_path
            .as_ref()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| std::env::temp_dir().join("agent-relay-cursor-mcp"));
        fs::create_dir_all(&journal_dir)?;
        let digest = Sha256::digest(root.as_os_str().to_string_lossy().as_bytes());
        Ok(journal_dir.join(format!(".cursor-mcp-lease-{:x}.lock", digest)))
    }

    pub(crate) fn acquire(&mut self, root: &Path, worker: &WorkerName) -> io::Result<PathBuf> {
        let (key, canonical) = lease_path(root)?;
        if let Some(existing) = self.path_by_worker.get(worker) {
            if existing == &key
                && self
                    .leases
                    .get(&key)
                    .is_some_and(|state| state.holders.contains(worker))
            {
                return Ok(key);
            }
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("worker '{}' has pending Cursor MCP cleanup", worker),
            ));
        }
        if self.leases.contains_key(&key) {
            let was_new_holder = self
                .leases
                .get_mut(&key)
                .expect("lease checked above")
                .holders
                .insert(worker.clone());
            if !was_new_holder {
                return Ok(key);
            }
            self.path_by_worker.insert(worker.clone(), key.clone());
            if let Err(error) = self.persist_journal() {
                if let Some(state) = self.leases.get_mut(&key) {
                    state.holders.remove(worker);
                }
                self.path_by_worker.remove(worker);
                return Err(error);
            }
            return Ok(key);
        }

        // Re-check after taking the kernel lock using descriptor-relative
        // operations. A hostile process can rename `.cursor` after a pathname
        // check, but it cannot redirect the descriptor captured here. Keep
        // that descriptor in LeaseState for the full lease lifetime.
        let lock_path = self.lock_path(&canonical)?;
        let (lock, cursor_dir, created_dir) =
            match LeaseLock::acquire_with_cursor(&canonical, true, Some(&lock_path)) {
                Ok(value) => value,
                Err(CursorAcquireError::Lock(error))
                | Err(CursorAcquireError::Cursor { error, .. }) => return Err(error),
            };
        #[cfg(unix)]
        let pre_existing = if let Some(cursor) = cursor_dir.as_ref() {
            if let Some((contents, mode)) = read_cursor_target(cursor)? {
                PreExisting::Present { contents, mode }
            } else {
                PreExisting::Absent { created_dir }
            }
        } else {
            unreachable!("Unix lease must retain a Cursor directory descriptor")
        };
        #[cfg(not(unix))]
        let (created_dir, pre_existing) = {
            let cursor = canonical.join(".cursor");
            let created_dir = match validate_cursor_dir(&canonical)? {
                true => false,
                false => match fs::create_dir(&cursor) {
                    Ok(()) => true,
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => false,
                    Err(error) => return Err(error),
                },
            };
            #[cfg(windows)]
            let _cursor_guard = windows_directory_guard(&cursor)?;
            #[cfg(windows)]
            let _cursor_identity = windows_directory_identity(&cursor)?;
            let pre_existing = if validate_target(&key)? {
                PreExisting::Present {
                    contents: {
                        #[cfg(windows)]
                        {
                            let mut file = windows_child_file(&key, false, false)?;
                            let mut contents = Vec::new();
                            file.read_to_end(&mut contents)?;
                            contents
                        }
                        #[cfg(not(windows))]
                        fs::read(&key)?
                    },
                    mode: 0o600,
                }
            } else {
                PreExisting::Absent { created_dir }
            };
            (created_dir, pre_existing)
        };

        #[cfg(windows)]
        let cursor_identity = windows_directory_identity(&canonical.join(".cursor"))?;

        let mut holders = HashSet::new();
        holders.insert(worker.clone());
        self.leases.insert(
            key.clone(),
            LeaseState {
                pre_existing,
                holders,
                lock,
                cursor_dir,
                #[cfg(windows)]
                cursor_identity,
                #[cfg(windows)]
                generated_identity: std::sync::Mutex::new(None),
            },
        );
        self.path_by_worker.insert(worker.clone(), key.clone());
        let deferred = self.deferred_journal.remove(&key);
        let newly_owned = self.journal_owned_paths.insert(key.clone());
        if let Err(error) = self.persist_journal() {
            self.leases.remove(&key);
            self.path_by_worker.remove(worker);
            if newly_owned {
                self.journal_owned_paths.remove(&key);
            }
            if let Some(entry) = deferred {
                self.deferred_journal.insert(key, entry);
            }
            return Err(error);
        }
        Ok(key)
    }

    fn state_for_worker(&self, worker: &WorkerName) -> io::Result<&LeaseState> {
        let path = self.path_by_worker.get(worker).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("no Cursor MCP lease for worker '{worker}'"),
            )
        })?;
        let state = self.leases.get(path).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("Cursor MCP lease state missing for worker '{worker}'"),
            )
        })?;
        if !state.holders.contains(worker) {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                format!("worker '{worker}' has pending Cursor MCP cleanup"),
            ));
        }
        Ok(state)
    }

    /// Read the currently leased config through the root and `.cursor`
    /// descriptors captured by `acquire`. Never reopen either directory by
    /// pathname: a caller can rename the requested cwd after acquisition
    /// without redirecting this operation to an attacker-controlled tree.
    pub(crate) fn read_worker_cursor_file(
        &self,
        worker: &WorkerName,
    ) -> io::Result<Option<Vec<u8>>> {
        let state = self.state_for_worker(worker)?;
        #[cfg(unix)]
        {
            let cursor = state.cursor_dir.as_ref().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Cursor MCP lease has no pinned directory descriptor",
                )
            })?;
            Ok(read_cursor_target(cursor)?.map(|(contents, _)| contents))
        }
        #[cfg(not(unix))]
        {
            let path = self.path_by_worker.get(worker).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("no Cursor MCP lease for worker '{worker}'"),
                )
            })?;
            #[cfg(windows)]
            let _parent_guard = windows_directory_guard(
                path.parent()
                    .ok_or_else(|| invalid_path("Cursor MCP path has no parent"))?,
            )?;
            #[cfg(windows)]
            validate_windows_cursor_identity(&state.lock, path, state.cursor_identity)?;
            if validate_target(path)? {
                #[cfg(windows)]
                {
                    let mut file = windows_child_file(path, false, false)?;
                    let mut contents = Vec::new();
                    file.read_to_end(&mut contents)?;
                    Ok(Some(contents))
                }
                #[cfg(not(windows))]
                Ok(Some(fs::read(path)?))
            } else {
                Ok(None)
            }
        }
    }

    /// Atomically write a leased Cursor config using only descriptors owned by
    /// this registry. The worker registry calls this after successful lease
    /// acquisition and before any child process is spawned.
    pub(crate) fn write_worker_cursor_file(
        &self,
        worker: &WorkerName,
        contents: &[u8],
    ) -> io::Result<()> {
        let state = self.state_for_worker(worker)?;
        #[cfg(unix)]
        {
            let cursor = state.cursor_dir.as_ref().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Cursor MCP lease has no pinned directory descriptor",
                )
            })?;
            write_cursor_target(cursor, contents)
        }
        #[cfg(not(unix))]
        {
            let path = self.path_by_worker.get(worker).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("no Cursor MCP lease for worker '{worker}'"),
                )
            })?;
            #[cfg(windows)]
            let _parent_guard = windows_directory_guard(
                path.parent()
                    .ok_or_else(|| invalid_path("Cursor MCP path has no parent"))?,
            )?;
            #[cfg(windows)]
            validate_windows_cursor_identity(&state.lock, path, state.cursor_identity)?;
            let generated_identity = write_credential_file_with_identity(path, contents)?;
            #[cfg(windows)]
            {
                *state.generated_identity.lock().map_err(|_| {
                    io::Error::other("Cursor MCP generated identity lock poisoned")
                })? = generated_identity;
                // Persist the journal immediately so the generated identity is
                // durable before any crash can occur.  Without this, a crash
                // between identity capture and journal write would orphan the
                // credential file with no recoverable identity for cleanup.
                if let Err(error) = self.persist_journal() {
                    // Journal persistence failed — remove the credential file to
                    // avoid leaving a secret on disk with no recoverable identity.
                    let _ = fs::remove_file(path);
                    return Err(error);
                }
            }
            Ok(())
        }
    }

    pub(crate) fn release_worker(&mut self, worker: &WorkerName) -> io::Result<()> {
        let Some(path) = self.path_by_worker.get(worker).cloned() else {
            return Ok(());
        };
        self.release_path(&path, worker)
    }

    pub(crate) fn has_pending_cleanup(&self, worker: &WorkerName) -> bool {
        let Some(path) = self.path_by_worker.get(worker) else {
            return false;
        };
        self.leases
            .get(path)
            .is_some_and(|state| !state.holders.contains(worker))
    }

    /// Retry only ownership entries whose final restore previously failed.
    /// Active holders are deliberately untouched; maintenance calls this on
    /// every reap tick so an in-process I/O failure is not stranded forever.
    pub(crate) fn retry_pending_cleanups(&mut self) {
        let workers: Vec<WorkerName> = self
            .path_by_worker
            .keys()
            .filter(|worker| self.has_pending_cleanup(worker))
            .cloned()
            .collect();
        for worker in workers {
            if let Err(error) = self.release_worker(&worker) {
                tracing::warn!(worker = %worker, %error, "Cursor MCP cleanup retry deferred");
            }
        }
    }

    fn release_path(&mut self, path: &Path, worker: &WorkerName) -> io::Result<()> {
        let Some(state) = self.leases.get_mut(path) else {
            self.path_by_worker.remove(worker);
            return Ok(());
        };
        state.holders.remove(worker);
        if !state.holders.is_empty() {
            self.path_by_worker.remove(worker);
            return self.persist_journal();
        }

        let pre_existing = match &state.pre_existing {
            PreExisting::Absent { created_dir } => PreExisting::Absent {
                created_dir: *created_dir,
            },
            PreExisting::Present { contents, mode } => PreExisting::Present {
                contents: contents.clone(),
                mode: *mode,
            },
        };
        Self::restore(
            path,
            &pre_existing,
            &state.lock,
            state.cursor_dir.as_ref(),
            #[cfg(windows)]
            Some(state.cursor_identity),
            #[cfg(windows)]
            *state
                .generated_identity
                .lock()
                .map_err(|_| io::Error::other("Cursor MCP generated identity lock poisoned"))?,
        )?;
        let state = self.leases.remove(path).expect("lease checked above");
        self.path_by_worker.remove(worker);
        if let Err(error) = self.persist_journal() {
            // The file is restored, but journal removal was not durable. Keep
            // ownership in memory so the periodic retry can finish the
            // transaction instead of relying only on a future broker restart.
            self.leases.insert(path.to_path_buf(), state);
            self.path_by_worker
                .insert(worker.clone(), path.to_path_buf());
            return Err(error);
        }
        Ok(())
    }

    fn restore(
        _path: &Path,
        pre_existing: &PreExisting,
        lock: &LeaseLock,
        pinned_cursor: Option<&fs::File>,
        #[cfg(windows)] expected_cursor_identity: Option<(u32, u64)>,
        #[cfg(windows)] generated_identity: Option<(u32, u64)>,
    ) -> io::Result<()> {
        #[cfg(unix)]
        {
            let cursor = pinned_cursor;
            match pre_existing {
                PreExisting::Absent { created_dir } => {
                    if let Some(cursor) = cursor {
                        let _ = remove_cursor_target(cursor)?;
                        if *created_dir {
                            remove_cursor_dir(lock, cursor)?;
                        }
                    }
                }
                PreExisting::Present { contents, mode } => {
                    let cursor = cursor.ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::NotFound,
                            "Cursor directory disappeared during restore",
                        )
                    })?;
                    write_cursor_target(cursor, contents)?;
                    let target = open_cursor_target(cursor)?.ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::NotFound,
                            "Cursor MCP target disappeared after restore",
                        )
                    })?;
                    use std::os::unix::fs::PermissionsExt;
                    target.set_permissions(fs::Permissions::from_mode(*mode & 0o777))?;
                    target.sync_all()?;
                    cursor.sync_all()?;
                }
            }
            Ok(())
        }
        #[cfg(not(unix))]
        {
            #[cfg(windows)]
            let _parent_guard = windows_directory_guard(
                _path
                    .parent()
                    .ok_or_else(|| invalid_path("Cursor MCP path has no parent"))?,
            )?;
            #[cfg(windows)]
            validate_windows_restore_path(lock, _path, expected_cursor_identity)?;
            match pre_existing {
                PreExisting::Absent { created_dir } => {
                    #[cfg(windows)]
                    let generated = match windows_child_file(_path, true, true) {
                        Ok(file) => Some(file),
                        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                        Err(error) => return Err(error),
                    };
                    #[cfg(windows)]
                    if let Some(generated) = generated.as_ref() {
                        let expected = generated_identity.ok_or_else(|| {
                            io::Error::new(
                                io::ErrorKind::InvalidData,
                                "legacy Cursor MCP journal lacks generated identity",
                            )
                        })?;
                        if windows_handle_identity(generated)? != expected {
                            return Err(io::Error::new(
                                io::ErrorKind::WouldBlock,
                                "generated Cursor MCP file was replaced",
                            ));
                        }
                    } else if generated_identity.is_some() {
                        // The exact generated object is already gone; cleanup
                        // is idempotently complete. Never infer ownership of a
                        // replacement when the journal has no live handle.
                    }
                    #[cfg(not(windows))]
                    match fs::symlink_metadata(_path) {
                        Ok(metadata) if metadata.file_type().is_symlink() => {
                            return Err(invalid_path(
                                "refusing to remove a symlink at generated Cursor MCP path",
                            ));
                        }
                        Ok(metadata) if !metadata.is_file() => {
                            return Err(invalid_path(
                                "refusing to remove a non-regular generated Cursor MCP path",
                            ));
                        }
                        Ok(_) => {}
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error),
                    }
                    #[cfg(windows)]
                    let removed = {
                        if let Some(generated) = generated {
                            windows_delete_file(generated)?;
                            true
                        } else {
                            false
                        }
                    };
                    #[cfg(not(windows))]
                    let removed = match fs::remove_file(_path) {
                        Ok(()) => true,
                        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
                        Err(error) => return Err(error),
                    };
                    if removed {
                        sync_entry_parent(_path)?;
                    }
                    if *created_dir {
                        if let Some(dir) = _path.parent() {
                            if fs::remove_dir(dir).is_ok() {
                                sync_entry_parent(dir)?;
                            }
                        }
                    }
                }
                PreExisting::Present { contents, mode } => {
                    #[cfg(windows)]
                    {
                        let expected = generated_identity.ok_or_else(|| {
                            io::Error::new(
                                io::ErrorKind::InvalidData,
                                "legacy Cursor MCP journal lacks generated identity",
                            )
                        })?;
                        let mut generated =
                            windows_child_file(_path, true, false).map_err(|error| {
                                if error.kind() == io::ErrorKind::NotFound {
                                    io::Error::new(
                                        io::ErrorKind::WouldBlock,
                                        "generated Cursor MCP file disappeared before restore",
                                    )
                                } else {
                                    error
                                }
                            })?;
                        if windows_handle_identity(&generated)? != expected {
                            return Err(io::Error::new(
                                io::ErrorKind::WouldBlock,
                                "generated Cursor MCP file was replaced",
                            ));
                        }
                        generated.set_len(0)?;
                        generated.write_all(contents)?;
                        generated.sync_all()?;
                    }
                    #[cfg(not(windows))]
                    restore_file(_path, contents, *mode)?;
                }
            }
            #[cfg(windows)]
            validate_windows_restore_path(lock, _path, expected_cursor_identity)?;
            Ok(())
        }
    }

    fn journal_entries(&self) -> io::Result<Vec<JournalEntry>> {
        self.leases
            .iter()
            .map(|(path, state)| {
                Ok(JournalEntry {
                    path: path.clone(),
                    pre_existing: state.pre_existing.journal()?,
                    #[cfg(windows)]
                    generated_identity: *state.generated_identity.lock().map_err(|_| {
                        io::Error::other("Cursor MCP generated identity lock poisoned")
                    })?,
                })
            })
            .collect()
    }

    /// A deferred entry may have been resolved by another broker while this
    /// registry was waiting on the cwd lock. Reconcile only when the exact
    /// pre-existing state is now observable; otherwise retain the work.
    fn deferred_entry_resolved(entry: &JournalEntry) -> io::Result<bool> {
        let pre_existing = PreExisting::from_journal(entry.pre_existing.clone())?;
        match pre_existing {
            PreExisting::Absent { .. } => match fs::symlink_metadata(&entry.path) {
                Ok(_) => Ok(false),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
                Err(error) => Err(error),
            },
            PreExisting::Present { contents, .. } => {
                if !validate_target(&entry.path)? {
                    return Ok(false);
                }
                Ok(fs::read(&entry.path).is_ok_and(|actual| actual == contents))
            }
        }
    }

    fn persist_journal(&self) -> io::Result<()> {
        let Some(path) = &self.journal_path else {
            return Ok(());
        };
        // Different cwd leases can share one state directory. Serialize the
        // journal read/merge/write transaction with a stable kernel lock so a
        // broker for one cwd cannot overwrite another broker's entry.
        let lock_path = path.with_file_name(".cursor-mcp-leases.lock");
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(lock_path)?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(fs::TryLockError::WouldBlock) => {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "another broker is updating the Cursor MCP lease journal",
                ));
            }
            Err(fs::TryLockError::Error(error)) => return Err(error),
        }
        let mut merged: HashMap<PathBuf, JournalEntry> = match fs::read(path) {
            Ok(body) => match serde_json::from_slice::<Journal>(&body) {
                Ok(journal) => journal
                    .entries
                    .into_iter()
                    .map(|entry| (entry.path.clone(), entry))
                    .collect(),
                Err(error) => return Err(io::Error::new(io::ErrorKind::InvalidData, error)),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => HashMap::new(),
            Err(error) => return Err(error),
        };
        let active = self.journal_entries()?;
        let active_paths: HashSet<PathBuf> =
            active.iter().map(|entry| entry.path.clone()).collect();
        for owned in &self.journal_owned_paths {
            if !active_paths.contains(owned) && !self.deferred_journal.contains_key(owned) {
                merged.remove(owned);
            }
        }
        for entry in self.deferred_journal.values() {
            if !merged.contains_key(&entry.path) && Self::deferred_entry_resolved(entry)? {
                continue;
            }
            merged.insert(entry.path.clone(), entry.clone());
        }
        for entry in active {
            merged.insert(entry.path.clone(), entry);
        }
        if merged.is_empty() {
            match fs::remove_file(path) {
                Ok(()) => sync_entry_parent(path),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error),
            }
        } else {
            let body = serde_json::to_vec_pretty(&Journal {
                entries: merged.into_values().collect(),
            })
            .map_err(|error| io::Error::other(error.to_string()))?;
            write_credential_file(path, &body)
        }
    }

    fn recover_journal(&mut self) -> io::Result<()> {
        self.recover_journal_with_hook(|| {})
    }

    fn recover_journal_with_hook<F>(&mut self, mut before_finalize: F) -> io::Result<()>
    where
        F: FnMut(),
    {
        let Some(path) = self.journal_path.clone() else {
            return Ok(());
        };
        let body = match fs::read(&path) {
            Ok(body) => body,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let journal: Journal = serde_json::from_slice(&body)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        self.journal_owned_paths
            .extend(journal.entries.iter().map(|entry| entry.path.clone()));
        let mut remaining = Vec::new();
        // Keep every successfully acquired cwd lock until the journal
        // transaction is finalized. Dropping a lock immediately after restore
        // leaves a window where another broker can create a new live journal
        // that this recovery pass would then unlink or replace.
        let mut held_locks = Vec::new();
        for entry in journal.entries {
            let path = entry.path.clone();
            #[cfg(windows)]
            let generated_identity = entry.generated_identity;
            let pre_existing = match PreExisting::from_journal(entry.pre_existing.clone()) {
                Ok(pre_existing) => pre_existing,
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "Cursor MCP lease recovery skipped an undecodable entry");
                    remaining.push(entry);
                    continue;
                }
            };
            if !path.is_absolute() {
                tracing::warn!(path = %path.display(), "Cursor MCP lease recovery skipped a non-absolute path");
                remaining.push(JournalEntry {
                    path,
                    pre_existing: pre_existing.journal()?,
                    #[cfg(windows)]
                    generated_identity,
                });
                continue;
            }
            let root = match path.parent().and_then(Path::parent) {
                Some(root) => root,
                None => {
                    tracing::warn!(path = %path.display(), "Cursor MCP lease recovery skipped an invalid path");
                    remaining.push(JournalEntry {
                        path,
                        pre_existing: pre_existing.journal()?,
                        #[cfg(windows)]
                        generated_identity,
                    });
                    continue;
                }
            };
            let expected_path = root.join(".cursor").join("mcp.json");
            if path != expected_path {
                tracing::warn!(path = %path.display(), "Cursor MCP lease recovery skipped a non-canonical path");
                remaining.push(JournalEntry {
                    path,
                    pre_existing: pre_existing.journal()?,
                    #[cfg(windows)]
                    generated_identity,
                });
                continue;
            }
            let canonical = match canonical_root(root) {
                Ok(canonical) => canonical,
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "Cursor MCP lease recovery skipped an unsafe cwd");
                    remaining.push(JournalEntry {
                        path,
                        pre_existing: pre_existing.journal()?,
                        #[cfg(windows)]
                        generated_identity,
                    });
                    continue;
                }
            };
            if path != canonical.join(".cursor").join("mcp.json") {
                tracing::warn!(path = %path.display(), "Cursor MCP lease recovery skipped a non-canonical path");
                remaining.push(JournalEntry {
                    path,
                    pre_existing: pre_existing.journal()?,
                    #[cfg(windows)]
                    generated_identity,
                });
                continue;
            }
            let lock_path = self.lock_path(root)?;
            let (lock, cursor_dir, _) = match LeaseLock::acquire_with_cursor(
                root,
                false,
                Some(&lock_path),
            ) {
                Ok(value) => value,
                Err(CursorAcquireError::Lock(error)) => {
                    tracing::warn!(path = %path.display(), %error, "Cursor MCP lease recovery deferred because another broker owns the cwd");
                    remaining.push(JournalEntry {
                        path,
                        pre_existing: pre_existing.journal()?,
                        #[cfg(windows)]
                        generated_identity,
                    });
                    continue;
                }
                Err(CursorAcquireError::Cursor { lock, error }) => {
                    tracing::warn!(path = %path.display(), %error, "Cursor MCP lease recovery deferred because .cursor could not be opened safely");
                    remaining.push(JournalEntry {
                        path,
                        pre_existing: pre_existing.journal()?,
                        #[cfg(windows)]
                        generated_identity,
                    });
                    held_locks.push(lock);
                    continue;
                }
            };
            if let Err(error) = validate_cursor_root(root) {
                tracing::warn!(path = %path.display(), %error, "Cursor MCP lease recovery rejected an unsafe path");
                remaining.push(JournalEntry {
                    path,
                    pre_existing: pre_existing.journal()?,
                    #[cfg(windows)]
                    generated_identity,
                });
                held_locks.push(lock);
                continue;
            }
            #[cfg(windows)]
            let expected_cursor_identity = match windows_directory_identity(
                path.parent().unwrap_or(root),
            ) {
                Ok(identity) => Some(identity),
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "Cursor MCP lease recovery deferred because .cursor identity is unavailable");
                    remaining.push(JournalEntry {
                        path,
                        pre_existing: pre_existing.journal()?,
                        generated_identity,
                    });
                    held_locks.push(lock);
                    continue;
                }
            };
            if let Err(error) = Self::restore(
                &path,
                &pre_existing,
                &lock,
                cursor_dir.as_ref(),
                #[cfg(windows)]
                expected_cursor_identity,
                #[cfg(windows)]
                generated_identity,
            ) {
                tracing::warn!(path = %path.display(), error = %error, "Cursor MCP lease recovery deferred");
                remaining.push(JournalEntry {
                    path,
                    pre_existing: pre_existing.journal()?,
                    #[cfg(windows)]
                    generated_identity,
                });
                held_locks.push(lock);
            } else {
                held_locks.push(lock);
            }
        }
        before_finalize();
        self.deferred_journal = remaining
            .into_iter()
            .map(|entry| (entry.path.clone(), entry))
            .collect();
        self.persist_journal()?;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.leases.is_empty() && self.path_by_worker.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn read(path: &Path) -> Vec<u8> {
        fs::read(path).unwrap()
    }

    #[test]
    fn clean_cwd_creates_then_removes_on_release() {
        let dir = tempdir().unwrap();
        let worker = WorkerName::new("w1");
        let mut registry = CursorMcpLeaseRegistry::new();
        let path = registry.acquire(dir.path(), &worker).unwrap();
        registry.write_worker_cursor_file(&worker, b"{} ").unwrap();
        registry.release_worker(&worker).unwrap();
        assert!(!path.exists());
        assert!(!path.parent().unwrap().exists());
        assert!(
            !dir.path().join(".cursor-mcp-lease.lock").exists(),
            "one-shot registry must not leave a lock in the worker cwd"
        );
        assert!(registry.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn raced_cursor_directory_creator_is_not_marked_for_cleanup() {
        let dir = tempdir().unwrap();
        let lock = LeaseLock::acquire(dir.path(), None).unwrap();
        let (cursor, created) = lock
            .open_cursor_dir_with(true, |root_fd, name, mode| {
                // Deterministically model another creator winning between our
                // failed openat and mkdirat: create the directory, then report
                // the equivalent EEXIST result to the caller.
                let result = unsafe { libc::mkdirat(root_fd, name.as_ptr(), mode) };
                assert_eq!(result, 0);
                Ok(false)
            })
            .unwrap();
        drop(cursor);
        assert!(!created);
        assert!(dir.path().join(".cursor").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn pre_existing_exact_config_and_mode_are_restored() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let cursor_dir = dir.path().join(".cursor");
        fs::create_dir_all(&cursor_dir).unwrap();
        let path = cursor_dir.join("mcp.json");
        let original = br#"{ "mcpServers": { "filesystem": {} } }"#;
        fs::write(&path, original).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let mut registry = CursorMcpLeaseRegistry::new();
        let worker = WorkerName::new("w1");
        registry.acquire(dir.path(), &worker).unwrap();
        registry
            .write_worker_cursor_file(&worker, b"generated")
            .unwrap();
        registry.release_worker(&worker).unwrap();
        assert_eq!(read(&path), original);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }

    #[test]
    fn two_workers_share_one_lease_and_restore_after_last_release() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".cursor").join("mcp.json");
        let mut registry = CursorMcpLeaseRegistry::new();
        let w1 = WorkerName::new("w1");
        let w2 = WorkerName::new("w2");
        registry.acquire(dir.path(), &w1).unwrap();
        registry
            .write_worker_cursor_file(&w1, b"generated")
            .unwrap();
        registry.acquire(dir.path(), &w2).unwrap();
        registry.release_worker(&w1).unwrap();
        assert!(path.exists());
        registry.release_worker(&w2).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn journal_recovers_after_registry_restart() {
        let dir = tempdir().unwrap();
        let journal = dir.path().join("journal.json");
        let cursor = dir.path().join(".cursor");
        fs::create_dir_all(&cursor).unwrap();
        let path = cursor.join("mcp.json");
        let original = b"user config";
        fs::write(&path, original).unwrap();
        {
            let mut registry = CursorMcpLeaseRegistry::with_journal(journal.clone());
            let worker = WorkerName::new("w1");
            registry.acquire(dir.path(), &worker).unwrap();
            registry
                .write_worker_cursor_file(&worker, b"placeholders only")
                .unwrap();
        }
        let recovered = CursorMcpLeaseRegistry::with_journal(journal.clone());
        assert!(recovered.is_empty());
        assert_eq!(read(&path), original);
        assert!(!journal.exists());
    }

    #[test]
    fn failed_restore_keeps_lease_for_a_later_retry() {
        let dir = tempdir().unwrap();
        let mut registry = CursorMcpLeaseRegistry::new();
        let worker = WorkerName::new("w1");
        let path = registry.acquire(dir.path(), &worker).unwrap();
        registry
            .write_worker_cursor_file(&worker, b"generated")
            .unwrap();
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();

        assert!(registry.release_worker(&worker).is_err());
        assert!(!registry.is_empty(), "failed cleanup must remain retryable");

        fs::remove_dir(&path).unwrap();
        registry.release_worker(&worker).unwrap();
        assert!(registry.is_empty());
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn separate_registries_fail_closed_while_another_process_holds_cwd_lock() {
        let dir = tempdir().unwrap();
        let worker_one = WorkerName::new("w1");
        let worker_two = WorkerName::new("w2");
        let mut first = CursorMcpLeaseRegistry::new();
        let mut second = CursorMcpLeaseRegistry::new();

        first.acquire(dir.path(), &worker_one).unwrap();
        let error = second.acquire(dir.path(), &worker_two).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);

        first.release_worker(&worker_one).unwrap();
        second.acquire(dir.path(), &worker_two).unwrap();
        second.release_worker(&worker_two).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_cursor_paths_are_rejected_before_capture_or_write() {
        use std::os::unix::fs::symlink;

        let cwd = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let worker = WorkerName::new("hostile");
        let outside_file = outside.path().join("mcp.json");
        fs::write(&outside_file, b"outside bytes").unwrap();
        symlink(outside.path(), cwd.path().join(".cursor")).unwrap();

        let mut registry = CursorMcpLeaseRegistry::new();
        assert!(registry.acquire(cwd.path(), &worker).is_err());
        assert_eq!(read(&outside_file), b"outside bytes");

        fs::remove_file(cwd.path().join(".cursor")).unwrap();
        fs::create_dir(cwd.path().join(".cursor")).unwrap();
        symlink(&outside_file, cwd.path().join(".cursor/mcp.json")).unwrap();
        assert!(registry.acquire(cwd.path(), &worker).is_err());
        assert_eq!(read(&outside_file), b"outside bytes");
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_relative_write_survives_hostile_cursor_parent_swap() {
        use std::os::unix::fs::symlink;
        use std::os::unix::io::AsRawFd;

        let cwd = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let outside_file = outside.path().join("mcp.json");
        fs::write(&outside_file, b"outside bytes").unwrap();
        fs::create_dir(cwd.path().join(".cursor")).unwrap();
        let root_file = open_dir_nofollow(cwd.path()).unwrap();
        let cursor_name = std::ffi::CString::new(".cursor").unwrap();
        let cursor = openat_dir(root_file.as_raw_fd(), &cursor_name).unwrap();

        fs::rename(cwd.path().join(".cursor"), cwd.path().join(".cursor-moved")).unwrap();
        symlink(outside.path(), cwd.path().join(".cursor")).unwrap();
        write_cursor_target(&cursor, b"inside bytes").unwrap();

        assert_eq!(
            read(&cwd.path().join(".cursor-moved/mcp.json")),
            b"inside bytes"
        );
        assert_eq!(read(&outside_file), b"outside bytes");
    }

    #[cfg(unix)]
    #[test]
    fn production_worker_cursor_io_survives_hostile_root_replacement() {
        use std::os::unix::fs::symlink;

        let parent = tempdir().unwrap();
        let root = parent.path().join("cwd");
        let moved_root = parent.path().join("cwd-moved");
        let outside = tempdir().unwrap();
        fs::create_dir(&root).unwrap();
        let worker = WorkerName::new("descriptor-worker");
        let mut registry = CursorMcpLeaseRegistry::new();
        registry.acquire(&root, &worker).unwrap();
        registry
            .write_worker_cursor_file(&worker, b"inside bytes")
            .unwrap();

        fs::rename(&root, &moved_root).unwrap();
        symlink(outside.path(), &root).unwrap();

        assert_eq!(
            registry.read_worker_cursor_file(&worker).unwrap().unwrap(),
            b"inside bytes"
        );
        registry
            .write_worker_cursor_file(&worker, b"updated inside bytes")
            .unwrap();
        assert_eq!(
            read(&moved_root.join(".cursor/mcp.json")),
            b"updated inside bytes"
        );
        assert!(!outside.path().join(".cursor/mcp.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn pinned_cursor_survives_rename_and_replacement_during_cleanup() {
        let parent = tempdir().unwrap();
        let root = parent.path().join("cwd");
        fs::create_dir(&root).unwrap();
        let worker = WorkerName::new("cursor-replaced");
        let mut registry = CursorMcpLeaseRegistry::new();
        registry.acquire(&root, &worker).unwrap();
        registry
            .write_worker_cursor_file(&worker, b"generated in pinned dir")
            .unwrap();

        let moved = root.join(".cursor-original");
        fs::rename(root.join(".cursor"), &moved).unwrap();
        fs::create_dir(root.join(".cursor")).unwrap();
        fs::write(root.join(".cursor/mcp.json"), b"replacement untouched").unwrap();

        assert_eq!(
            registry.read_worker_cursor_file(&worker).unwrap().unwrap(),
            b"generated in pinned dir"
        );
        registry
            .write_worker_cursor_file(&worker, b"updated in pinned dir")
            .unwrap();
        assert_eq!(read(&moved.join("mcp.json")), b"updated in pinned dir");
        assert_eq!(
            read(&root.join(".cursor/mcp.json")),
            b"replacement untouched"
        );

        let error = registry.release_worker(&worker).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        assert_eq!(
            read(&root.join(".cursor/mcp.json")),
            b"replacement untouched"
        );
        assert!(
            !moved.join("mcp.json").exists(),
            "pinned target was removed"
        );
        assert!(root.join(".cursor").is_dir(), "replacement was not removed");

        fs::remove_file(root.join(".cursor/mcp.json")).unwrap();
        fs::remove_dir(root.join(".cursor")).unwrap();
        fs::rename(&moved, root.join(".cursor")).unwrap();
        registry.release_worker(&worker).unwrap();
        assert!(!root.join(".cursor").exists());
        assert!(registry.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn journal_recovery_retains_cwd_lock_until_journal_finalization() {
        let dir = tempdir().unwrap();
        let journal = dir.path().join("journal.json");
        let root = dir.path().canonicalize().unwrap();
        let path = root.join(".cursor/mcp.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"original").unwrap();
        {
            let mut registry = CursorMcpLeaseRegistry::with_journal(journal.clone());
            let worker = WorkerName::new("w1");
            registry.acquire(dir.path(), &worker).unwrap();
            registry
                .write_worker_cursor_file(&worker, b"generated")
                .unwrap();
        }

        let mut recovery = CursorMcpLeaseRegistry {
            leases: HashMap::new(),
            path_by_worker: HashMap::new(),
            journal_path: Some(journal.clone()),
            ..Default::default()
        };
        let mut second = CursorMcpLeaseRegistry::new();
        recovery
            .recover_journal_with_hook(|| {
                let error = second
                    .acquire(dir.path(), &WorkerName::new("racing"))
                    .unwrap_err();
                assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
            })
            .unwrap();
        assert!(!journal.exists());
        assert_eq!(read(&path), b"original");
    }

    #[cfg(unix)]
    #[test]
    fn journal_recovery_error_path_retains_cwd_lock_until_journal_rewrite() {
        let dir = tempdir().unwrap();
        let journal = dir.path().join("journal.json");
        let root = dir.path().canonicalize().unwrap();
        let path = root.join(".cursor/mcp.json");
        let body = serde_json::to_vec(&Journal {
            entries: vec![JournalEntry {
                path: path.clone(),
                pre_existing: JournalPreExisting::Present {
                    contents_base64: base64::engine::general_purpose::STANDARD.encode(b"original"),
                    mode: 0o600,
                },
            }],
        })
        .unwrap();
        fs::write(&journal, body).unwrap();

        let mut recovery = CursorMcpLeaseRegistry {
            leases: HashMap::new(),
            path_by_worker: HashMap::new(),
            journal_path: Some(journal.clone()),
            ..Default::default()
        };
        let mut racing = CursorMcpLeaseRegistry::new();
        recovery
            .recover_journal_with_hook(|| {
                let error = racing
                    .acquire(&root, &WorkerName::new("racing-error"))
                    .unwrap_err();
                assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
            })
            .unwrap();
        assert!(journal.exists(), "failed restore remains journaled");
    }

    #[cfg(unix)]
    #[test]
    fn journal_recovery_defers_invalid_cursor_and_keeps_root_locked_until_finalize() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let journal = dir.path().join("journal.json");
        let root = dir.path().canonicalize().unwrap();
        let outside = tempdir().unwrap();
        let outside_file = outside.path().join("mcp.json");
        fs::write(&outside_file, b"outside bytes").unwrap();
        fs::create_dir_all(root.join(".cursor")).unwrap();
        let path = root.join(".cursor/mcp.json");
        fs::write(&path, b"original").unwrap();
        let body = serde_json::to_vec(&Journal {
            entries: vec![JournalEntry {
                path: path.clone(),
                pre_existing: JournalPreExisting::Present {
                    contents_base64: base64::engine::general_purpose::STANDARD.encode(b"original"),
                    mode: 0o600,
                },
            }],
        })
        .unwrap();
        fs::write(&journal, body).unwrap();

        let mut recovery = CursorMcpLeaseRegistry {
            leases: HashMap::new(),
            path_by_worker: HashMap::new(),
            journal_path: Some(journal.clone()),
            ..Default::default()
        };
        let cursor_path = root.join(".cursor");
        fs::remove_dir_all(&cursor_path).unwrap();
        symlink(outside.path(), &cursor_path).unwrap();

        recovery
            .recover_journal_with_hook(|| {
                match LeaseLock::acquire(&root, None) {
                    Err(error) => assert_eq!(error.kind(), io::ErrorKind::WouldBlock),
                    Ok(_) => panic!("root lock should stay held until journal finalization"),
                }
                assert_eq!(read(&outside_file), b"outside bytes");
            })
            .unwrap();

        assert!(
            journal.exists(),
            "invalid cursor entry must remain journaled"
        );
        assert_eq!(read(&path), b"outside bytes");
        assert_eq!(read(&outside_file), b"outside bytes");
    }

    #[cfg(unix)]
    #[test]
    fn journal_recovery_defers_regular_cursor_and_keeps_root_locked() {
        let dir = tempdir().unwrap();
        let journal = dir.path().join("journal.json");
        let root = dir.path().canonicalize().unwrap();
        let cursor_path = root.join(".cursor");
        fs::write(&cursor_path, b"not a directory").unwrap();
        let path = cursor_path.join("mcp.json");
        let body = serde_json::to_vec(&Journal {
            entries: vec![JournalEntry {
                path: path.clone(),
                pre_existing: JournalPreExisting::Absent { created_dir: false },
            }],
        })
        .unwrap();
        fs::write(&journal, body).unwrap();

        let mut recovery = CursorMcpLeaseRegistry {
            leases: HashMap::new(),
            path_by_worker: HashMap::new(),
            journal_path: Some(journal.clone()),
            ..Default::default()
        };
        recovery
            .recover_journal_with_hook(|| match LeaseLock::acquire(&root, None) {
                Err(error) => assert_eq!(error.kind(), io::ErrorKind::WouldBlock),
                Ok(_) => panic!("root lock should stay held until journal finalization"),
            })
            .unwrap();
        assert!(
            journal.exists(),
            "invalid cursor entry must remain journaled"
        );
    }

    #[cfg(unix)]
    #[test]
    fn deferred_journal_entry_survives_unrelated_acquire_and_release() {
        let dir = tempdir().unwrap();
        let journal = dir.path().join("journal.json");
        let deferred_root = dir.path().join("deferred");
        fs::create_dir_all(&deferred_root).unwrap();
        fs::write(deferred_root.join(".cursor"), b"not a directory").unwrap();
        let deferred_path = deferred_root.join(".cursor/mcp.json");
        fs::write(
            &journal,
            serde_json::to_vec(&Journal {
                entries: vec![JournalEntry {
                    path: deferred_path.clone(),
                    pre_existing: JournalPreExisting::Absent { created_dir: false },
                }],
            })
            .unwrap(),
        )
        .unwrap();

        let mut registry = CursorMcpLeaseRegistry::with_journal(journal.clone());
        let unrelated_root = dir.path().join("unrelated");
        fs::create_dir(&unrelated_root).unwrap();
        let worker = WorkerName::new("unrelated");
        registry.acquire(&unrelated_root, &worker).unwrap();
        registry.release_worker(&worker).unwrap();

        let journal: Journal = serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
        assert_eq!(journal.entries.len(), 1);
        assert_eq!(journal.entries[0].path, deferred_path);
    }

    #[cfg(unix)]
    #[test]
    fn reacquiring_deferred_path_clears_stale_entry_after_release() {
        let dir = tempdir().unwrap();
        let journal = dir.path().join("journal.json");
        let root = dir.path().join("reacquired");
        fs::create_dir_all(root.join(".cursor")).unwrap();
        let root = root.canonicalize().unwrap();
        let path = root.join(".cursor/mcp.json");
        let stale = JournalEntry {
            path: path.clone(),
            pre_existing: JournalPreExisting::Absent { created_dir: false },
        };
        fs::write(
            &journal,
            serde_json::to_vec(&Journal {
                entries: vec![stale.clone()],
            })
            .unwrap(),
        )
        .unwrap();
        let mut registry = CursorMcpLeaseRegistry::with_journal(journal.clone());
        // Model a deferred entry whose cwd is now available again.
        registry.deferred_journal.insert(path.clone(), stale);
        registry.journal_owned_paths.insert(path.clone());
        let worker = WorkerName::new("reacquired");
        registry.acquire(&root, &worker).unwrap();
        registry
            .write_worker_cursor_file(&worker, b"fresh placeholders")
            .unwrap();
        registry.release_worker(&worker).unwrap();
        assert!(
            !journal.exists(),
            "stale entry must not replay after release: {:?}",
            fs::read(&journal).ok()
        );
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn second_registry_does_not_resurrect_resolved_deferred_entry() {
        let dir = tempdir().unwrap();
        let journal = dir.path().join("journal.json");
        let root = dir.path().join("resolved");
        fs::create_dir_all(root.join(".cursor")).unwrap();
        let path = root.canonicalize().unwrap().join(".cursor/mcp.json");
        let entry = JournalEntry {
            path: path.clone(),
            pre_existing: JournalPreExisting::Absent { created_dir: false },
        };
        let mut first = CursorMcpLeaseRegistry {
            journal_path: Some(journal.clone()),
            ..Default::default()
        };
        first.deferred_journal.insert(path.clone(), entry.clone());
        first.journal_owned_paths.insert(path.clone());
        first.persist_journal().unwrap();

        let mut second = CursorMcpLeaseRegistry {
            journal_path: Some(journal.clone()),
            ..Default::default()
        };
        second.deferred_journal.insert(path.clone(), entry);
        second.journal_owned_paths.insert(path);

        first.deferred_journal.clear();
        first.persist_journal().unwrap();
        second.persist_journal().unwrap();
        assert!(!journal.exists(), "resolved work must not be resurrected");
    }

    #[cfg(unix)]
    #[test]
    fn recovery_persist_failure_keeps_deferred_work_for_later_acquire() {
        let dir = tempdir().unwrap();
        let journal = dir.path().join("journal.json");
        let root = dir.path().join("blocked");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(".cursor"), b"not a directory").unwrap();
        let path = root.join(".cursor/mcp.json");
        fs::write(
            &journal,
            serde_json::to_vec(&Journal {
                entries: vec![JournalEntry {
                    path: path.clone(),
                    pre_existing: JournalPreExisting::Absent { created_dir: false },
                }],
            })
            .unwrap(),
        )
        .unwrap();
        let mut recovery = CursorMcpLeaseRegistry {
            journal_path: Some(journal.clone()),
            ..Default::default()
        };
        let lock_path = journal.with_file_name(".cursor-mcp-leases.lock");
        let mut held_lock = None;
        let error = recovery
            .recover_journal_with_hook(|| {
                let lock = fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(&lock_path)
                    .unwrap();
                lock.try_lock().unwrap();
                held_lock = Some(lock);
            })
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        assert!(recovery.deferred_journal.contains_key(&path));
        drop(held_lock);

        let unrelated = dir.path().join("unrelated");
        fs::create_dir(&unrelated).unwrap();
        let worker = WorkerName::new("unrelated");
        recovery.acquire(&unrelated, &worker).unwrap();
        recovery.release_worker(&worker).unwrap();
        assert!(
            journal.exists(),
            "deferred work must survive later persistence"
        );
    }

    #[cfg(unix)]
    #[test]
    fn journal_recovery_defers_invalid_child_and_keeps_root_locked() {
        let dir = tempdir().unwrap();
        let journal = dir.path().join("journal.json");
        let root = dir.path().canonicalize().unwrap();
        let cursor_path = root.join(".cursor");
        fs::create_dir(&cursor_path).unwrap();
        let path = cursor_path.join("mcp.json");
        fs::create_dir(&path).unwrap();
        let body = serde_json::to_vec(&Journal {
            entries: vec![JournalEntry {
                path: path.clone(),
                pre_existing: JournalPreExisting::Absent { created_dir: false },
            }],
        })
        .unwrap();
        fs::write(&journal, body).unwrap();

        let mut recovery = CursorMcpLeaseRegistry {
            leases: HashMap::new(),
            path_by_worker: HashMap::new(),
            journal_path: Some(journal.clone()),
            ..Default::default()
        };
        recovery
            .recover_journal_with_hook(|| match LeaseLock::acquire(&root, None) {
                Err(error) => assert_eq!(error.kind(), io::ErrorKind::WouldBlock),
                Ok(_) => panic!("root lock should stay held until journal finalization"),
            })
            .unwrap();
        assert!(
            journal.exists(),
            "invalid child entry must remain journaled"
        );
    }

    #[cfg(unix)]
    #[test]
    fn journal_recovery_skips_bad_entry_and_restores_later_entries() {
        let dir = tempdir().unwrap();
        let journal = dir.path().join("journal.json");
        let root = dir.path().canonicalize().unwrap();
        let first = root.join(".cursor/mcp.json");
        let second_root = dir.path().join("other");
        fs::create_dir(&second_root).unwrap();
        let second = second_root.join(".cursor/mcp.json");
        fs::create_dir_all(first.parent().unwrap()).unwrap();
        fs::create_dir_all(second.parent().unwrap()).unwrap();
        fs::write(&first, b"first-original").unwrap();
        fs::write(&second, b"second-original").unwrap();
        let body = serde_json::to_vec(&Journal {
            entries: vec![
                JournalEntry {
                    path: first.clone(),
                    pre_existing: JournalPreExisting::Present {
                        contents_base64: "!!!not-base64!!!".into(),
                        mode: 0o600,
                    },
                },
                JournalEntry {
                    path: second.clone(),
                    pre_existing: JournalPreExisting::Present {
                        contents_base64: base64::engine::general_purpose::STANDARD
                            .encode(b"second-original"),
                        mode: 0o600,
                    },
                },
            ],
        })
        .unwrap();
        fs::write(&journal, body).unwrap();

        let mut recovery = CursorMcpLeaseRegistry {
            leases: HashMap::new(),
            path_by_worker: HashMap::new(),
            journal_path: Some(journal.clone()),
            ..Default::default()
        };
        recovery.recover_journal().unwrap();
        assert_eq!(read(&first), b"first-original");
        assert_eq!(read(&second), b"second-original");
        assert!(journal.exists(), "bad entry must remain journaled");
    }

    #[cfg(not(unix))]
    #[test]
    fn windows_lease_lock_is_reusable_after_owner_exit() {
        let dir = tempdir().unwrap();
        let first = LeaseLock::acquire(dir.path(), None).unwrap();
        let error = match LeaseLock::acquire(dir.path(), None) {
            Ok(_) => panic!("second broker must not acquire a held cwd lease"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        drop(first);

        // The stable lock file remains on disk, but the kernel lock is released
        // with the owning handle. A later broker can recover after a clean exit
        // and the same mechanism also releases on process termination.
        let _second = LeaseLock::acquire(dir.path(), None).unwrap();
    }

    #[test]
    fn absent_file_cleanup_retry_is_idempotent_after_directory_removal() {
        let dir = tempdir().unwrap();
        let worker = WorkerName::new("w1");
        let mut registry = CursorMcpLeaseRegistry::new();
        let path = registry.acquire(dir.path(), &worker).unwrap();
        registry.write_worker_cursor_file(&worker, b"{}").unwrap();
        assert!(path.exists());
        assert!(path.parent().unwrap().exists());

        // Simulate an external process or a prior retry removing the .cursor
        // directory between the credential-file write and journal persistence.
        fs::remove_dir_all(path.parent().unwrap()).unwrap();

        // Release must succeed even though the directory is already gone.
        registry.release_worker(&worker).unwrap();
        assert!(registry.is_empty());
        assert!(!path.exists());
        assert!(
            !path.parent().unwrap().exists(),
            ".cursor directory must not be recreated"
        );
    }

    #[cfg(windows)]
    #[test]
    fn credential_file_removed_on_journal_persist_failure() {
        let dir = tempdir().unwrap();
        let journal = dir.path().join("journal.json");
        let mut registry = CursorMcpLeaseRegistry::with_journal(journal.clone());
        let worker = WorkerName::new("w1");
        let path = registry.acquire(dir.path(), &worker).unwrap();

        // Hold the journal lock file so persist_journal() fails with
        // WouldBlock — the same failure mode as another broker updating.
        let lock_path = journal.with_file_name(".cursor-mcp-leases.lock");
        let _held_lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .unwrap();
        _held_lock.try_lock().unwrap();

        // write_worker_cursor_file writes the credential file, then attempts
        // persist_journal which fails.  The new code must remove the
        // credential file to avoid leaving a secret on disk without a
        // recoverable journal identity.
        let error = registry
            .write_worker_cursor_file(&worker, b"secret placeholders")
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        assert!(
            !path.exists(),
            "credential file must be removed when journal persistence fails"
        );
    }

    #[cfg(unix)]
    #[test]
    fn absent_file_release_journal_failure_retains_lease_for_retry() {
        let dir = tempdir().unwrap();
        let journal = dir.path().join("journal.json");
        let mut registry = CursorMcpLeaseRegistry::with_journal(journal.clone());
        let worker = WorkerName::new("w1");
        let path = registry.acquire(dir.path(), &worker).unwrap();
        registry.write_worker_cursor_file(&worker, b"{}").unwrap();
        assert!(path.exists(), "cursor file must exist after write");
        assert!(
            path.parent().unwrap().exists(),
            ".cursor directory must exist"
        );

        // Hold the journal lock to force persist_journal() failure on release.
        let lock_path = journal.with_file_name(".cursor-mcp-leases.lock");
        let held_lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .unwrap();
        held_lock.try_lock().unwrap();

        // Release removes the file and directory (Absent path) but journal
        // persistence fails.  The lease must remain in-memory for retry.
        let error = registry.release_worker(&worker).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        assert!(
            !registry.is_empty(),
            "failed journal persist must retain lease"
        );
        // The file and directory must still be cleaned up on-disk.
        assert!(
            !path.exists(),
            "generated file must be removed even if journal fails"
        );
        assert!(
            !path.parent().unwrap().exists(),
            ".cursor directory must be removed even if journal fails"
        );

        // Drop the lock and retry — the retry should succeed and clean up
        // the in-memory lease.
        drop(held_lock);
        registry.retry_pending_cleanups();
        assert!(
            registry.is_empty(),
            "retry after lock release must clear lease"
        );
        assert!(
            !journal.exists(),
            "journal must be cleaned up after successful retry"
        );
    }
}
