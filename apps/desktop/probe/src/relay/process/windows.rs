//! The process table on Windows.
//!
//! - **pid, parent, start**: the kernel (`K32EnumProcesses`,
//!   `GetProcessTimes`) and sysinfo's parent pid. Windows never reparents:
//!   a parent that exited leaves its pid free for reuse, so a "parent" that
//!   started after its child is a stranger and is reported as no parent
//!   (0), which ends every ancestry walk there.
//! - **owner**: `peer::process_uid`, the uid the process token's user SID
//!   maps to (the scheme `peer::current_uid` uses for this person); a
//!   process whose token cannot be read reports `u32::MAX`, which matches
//!   no one.
//! - **executable**: `QueryFullProcessImageNameW`, the kernel's image path.
//! - **arguments, environment, folder**: sysinfo, which reads them from the
//!   process's PEB (this user's processes only).
//! - **open files**: the system handle table, each of the process's handles
//!   duplicated into this one; only disk files are named (`GetFileType`
//!   first, so a pipe, whose name query can block, is never asked), and
//!   their creation time is read from the duplicated handle, so a path
//!   replaced since cannot change it. The walk runs on a thread of its own
//!   and is abandoned after `OPEN_FILES_TIMEOUT`.
//! - **TCP listeners**: `GetExtendedTcpTable`.
//! - **terminal**: see `has_terminal`.

use super::*;
use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::OsStringExt;
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, FILETIME, HANDLE,
};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID, MIB_TCPROW_OWNER_PID,
    MIB_TCPTABLE_OWNER_PID, MIB_TCP_STATE_LISTEN, TCP_TABLE_OWNER_PID_LISTENER,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileTime, GetFileType, GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, FILE_TYPE_DISK,
    VOLUME_NAME_DOS,
};
use windows_sys::Win32::System::ProcessStatus::K32EnumProcesses;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetExitCodeProcess, GetProcessTimes, OpenProcess,
    QueryFullProcessImageNameW, PROCESS_DUP_HANDLE, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

/// How long one walk of a process's open handles may take.
const OPEN_FILES_TIMEOUT: Duration = Duration::from_secs(5);

/// `GetExitCodeProcess`'s answer for a process that has not exited.
const STILL_ACTIVE: u32 = windows_sys::Win32::Foundation::STILL_ACTIVE as u32;

/// `OpenProcess`'s error for a pid no process has.
const ERROR_INVALID_PARAMETER: i32 = windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER as i32;

/// 100-nanosecond intervals from 1601-01-01 (a `FILETIME`'s origin) to the
/// Unix epoch.
const FILETIME_UNIX_EPOCH: u64 = 116_444_736_000_000_000;

/// The sysinfo table, kept between reads so each read refreshes only the
/// process it asks about.
#[derive(Default)]
pub struct Cache {
    system: Mutex<Option<System>>,
}

/// A handle this module opened, closed on drop.
struct Owned(HANDLE);

impl Owned {
    fn process(pid: u32, access: u32) -> Option<Owned> {
        // SAFETY: plain integers in; the handle is checked before use.
        let handle = unsafe { OpenProcess(access, 0, pid) };
        (!handle.is_null()).then_some(Owned(handle))
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: a handle this value owns, closed once.
        unsafe { CloseHandle(self.0) };
    }
}

fn filetime_ticks(time: &FILETIME) -> u64 {
    (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
}

fn empty_filetime() -> FILETIME {
    FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    }
}

/// When `pid` was created, in microseconds since the Unix epoch.
fn creation_micros(pid: u32) -> Option<u64> {
    let process = Owned::process(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
    let (mut created, mut exited, mut kernel, mut user) = (
        empty_filetime(),
        empty_filetime(),
        empty_filetime(),
        empty_filetime(),
    );
    // SAFETY: four valid out pointers and a live process handle.
    let read =
        unsafe { GetProcessTimes(process.0, &mut created, &mut exited, &mut kernel, &mut user) };
    if read == 0 {
        return None;
    }
    filetime_ticks(&created)
        .checked_sub(FILETIME_UNIX_EPOCH)
        .map(|ticks| ticks / 10)
}

fn lossy<S: AsRef<OsStr> + ?Sized>(value: &S) -> String {
    value.as_ref().to_string_lossy().into_owned()
}

/// `\\?\C:\…` as `C:\…` and `\\?\UNC\server\…` as `\\server\…`, the forms
/// every other path in the core has.
fn without_verbatim_prefix(path: String) -> PathBuf {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    PathBuf::from(
        path.strip_prefix(r"\\?\")
            .map(str::to_string)
            .unwrap_or(path),
    )
}

/// The path a disk-file handle names now.
fn final_path(handle: HANDLE) -> Option<PathBuf> {
    let mut buffer = vec![0u16; 1024];
    for _ in 0..2 {
        // SAFETY: the buffer holds `buffer.len()` UTF-16 units.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                handle,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        } as usize;
        if length == 0 {
            return None;
        }
        if length < buffer.len() {
            let path = OsString::from_wide(&buffer[..length]);
            return Some(without_verbatim_prefix(lossy(&path)));
        }
        buffer.resize(length + 1, 0);
    }
    None
}

/// The creation time of the file a handle holds, in nanoseconds since the
/// Unix epoch.
fn creation_ns(handle: HANDLE) -> Option<i128> {
    let mut created = empty_filetime();
    // SAFETY: one valid out pointer; the others are optional and null.
    let read = unsafe {
        GetFileTime(
            handle,
            &mut created,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if read == 0 {
        return None;
    }
    filetime_ticks(&created)
        .checked_sub(FILETIME_UNIX_EPOCH)
        .map(|ticks| i128::from(ticks) * 100)
}

/// `SystemExtendedHandleInformation`, the handle table with full-width
/// pids and handle values.
const SYSTEM_EXTENDED_HANDLE_INFORMATION: i32 = 64;
const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;
/// The largest handle table read; past it the walk gives up.
const MAX_HANDLE_TABLE: usize = 512 << 20;

/// `SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX`. Only the pid and handle value are
/// read; the rest is there for the layout.
#[repr(C)]
#[allow(dead_code)]
struct HandleEntry {
    object: usize,
    process: usize,
    handle: usize,
    granted_access: u32,
    back_trace_index: u16,
    object_type_index: u16,
    attributes: u32,
    reserved: u32,
}

/// The header of `SYSTEM_HANDLE_INFORMATION_EX`; the entries follow it.
#[repr(C)]
#[allow(dead_code)]
struct HandleTableHeader {
    count: usize,
    reserved: usize,
}

/// The handle values `pid` holds, from the system handle table.
fn handles_of(pid: u32) -> Vec<usize> {
    let mut size: usize = 4 << 20;
    loop {
        let mut buffer = vec![0u64; size / 8];
        let mut needed = 0u32;
        // SAFETY: the buffer holds `size` bytes, aligned for the table.
        let status = unsafe {
            windows_sys::Wdk::System::SystemInformation::NtQuerySystemInformation(
                SYSTEM_EXTENDED_HANDLE_INFORMATION,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * 8) as u32,
                &mut needed,
            )
        };
        if status == STATUS_INFO_LENGTH_MISMATCH {
            size = (size * 2).max(needed as usize + (1 << 20));
            if size > MAX_HANDLE_TABLE {
                return Vec::new();
            }
            continue;
        }
        if status < 0 {
            return Vec::new();
        }
        let header = std::mem::size_of::<HandleTableHeader>();
        let room = (buffer.len() * 8).saturating_sub(header) / std::mem::size_of::<HandleEntry>();
        // SAFETY: the kernel wrote a header and `count` entries, bounded by
        // what the buffer can hold; entries start 8-byte aligned.
        let entries = unsafe {
            let count = (*(buffer.as_ptr() as *const HandleTableHeader))
                .count
                .min(room);
            let first = (buffer.as_ptr() as *const u8).add(header) as *const HandleEntry;
            std::slice::from_raw_parts(first, count)
        };
        return entries
            .iter()
            .filter(|entry| entry.process == pid as usize)
            .map(|entry| entry.handle)
            .collect();
    }
}

/// The disk files `pid` has open, with the creation time of each.
fn open_disk_files(pid: u32) -> Vec<OpenedFile> {
    let Some(process) = Owned::process(pid, PROCESS_DUP_HANDLE) else {
        return Vec::new();
    };
    // SAFETY: the pseudo-handle of this process needs no closing.
    let me = unsafe { GetCurrentProcess() };
    handles_of(pid)
        .into_iter()
        .filter_map(|handle| {
            let mut copy: HANDLE = std::ptr::null_mut();
            // SAFETY: duplicating a handle value of a process opened for it
            // into this one; failure (a handle type that cannot be
            // duplicated, a handle closed meanwhile) is checked.
            let duplicated = unsafe {
                DuplicateHandle(
                    process.0,
                    handle as HANDLE,
                    me,
                    &mut copy,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                )
            };
            if duplicated == 0 || copy.is_null() {
                return None;
            }
            let copy = Owned(copy);
            // SAFETY: a live handle this function owns. `GetFileType` is
            // answered without the file's lock, so it never blocks.
            if unsafe { GetFileType(copy.0) } != FILE_TYPE_DISK {
                return None;
            }
            let path = final_path(copy.0)?;
            Some(OpenedFile {
                birth_ns: creation_ns(copy.0),
                path,
            })
        })
        .collect()
}

/// The listening TCP sockets of `family` (`AF_INET` or `AF_INET6`) as the
/// raw table `GetExtendedTcpTable` returns.
fn listener_table(family: u16) -> Option<Vec<u64>> {
    let mut size = 0u32;
    for _ in 0..4 {
        let mut buffer = vec![0u64; (size as usize).div_ceil(8).max(1)];
        let mut room = (buffer.len() * 8) as u32;
        // SAFETY: the buffer holds `room` bytes, aligned for the table.
        let status = unsafe {
            GetExtendedTcpTable(
                buffer.as_mut_ptr().cast(),
                &mut room,
                0,
                u32::from(family),
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if status == 0 {
            return Some(buffer);
        }
        // ERROR_INSUFFICIENT_BUFFER: `room` now says how much it needs.
        if status != 122 {
            return None;
        }
        size = room + 1024;
    }
    None
}

impl SystemProcesses {
    /// `read` of sysinfo's view of `pid`, its basic facts and `kind`
    /// refreshed now (each read asks only for what it uses: the PEB reads
    /// cost a handle and memory reads).
    fn with_info<T>(
        &self,
        pid: i32,
        kind: ProcessRefreshKind,
        read: impl FnOnce(&sysinfo::Process) -> T,
    ) -> Option<T> {
        let pid = Pid::from_u32(u32::try_from(pid).ok().filter(|pid| *pid > 0)?);
        let mut system = self
            .windows
            .system
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let system = system.get_or_insert_with(System::new);
        system.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, kind);
        system.process(pid).map(read)
    }

    /// When `pid` started, in microseconds since the epoch: the kernel's
    /// creation time, else sysinfo's whole seconds.
    fn start_micros(&self, pid: u32) -> Option<u64> {
        creation_micros(pid).or_else(|| {
            self.with_info(pid as i32, ProcessRefreshKind::nothing(), |process| {
                process.start_time().saturating_mul(1_000_000)
            })
        })
    }
}

impl ProcessTable for SystemProcesses {
    fn process(&self, pid: i32) -> Option<ProcessInfo> {
        let raw = u32::try_from(pid).ok().filter(|pid| *pid > 0)?;
        let start = self.start_micros(raw)?;
        let parent = self
            .with_info(pid, ProcessRefreshKind::nothing(), |process| {
                process.parent().map(|parent| parent.as_u32())
            })?
            .unwrap_or(0);
        // A parent pid reused by a process that started later is not the
        // parent; neither is one whose start cannot be read.
        let parent = match parent {
            0 => 0,
            parent => match self.start_micros(parent) {
                Some(born) if born <= start && parent != raw => parent as i32,
                _ => 0,
            },
        };
        // A process whose token cannot be read matches no one.
        let uid = crate::relay::peer::process_uid(raw).unwrap_or(u32::MAX);
        Some(ProcessInfo {
            pid,
            parent,
            uid,
            start,
        })
    }

    fn process_gone(&self, pid: i32) -> bool {
        let Some(raw) = u32::try_from(pid).ok().filter(|pid| *pid > 0) else {
            return true;
        };
        match Owned::process(raw, PROCESS_QUERY_LIMITED_INFORMATION) {
            Some(_) => false,
            None => std::io::Error::last_os_error().raw_os_error() == Some(ERROR_INVALID_PARAMETER),
        }
    }

    /// An exited process whose object another handle keeps: its pid and
    /// start time stay until the last handle closes, like a Unix zombie.
    fn zombie(&self, pid: i32) -> bool {
        let Some(raw) = u32::try_from(pid).ok().filter(|pid| *pid > 0) else {
            return false;
        };
        let Some(process) = Owned::process(raw, PROCESS_QUERY_LIMITED_INFORMATION) else {
            return false;
        };
        let mut code = 0u32;
        // SAFETY: a live process handle and a valid out pointer.
        let read = unsafe { GetExitCodeProcess(process.0, &mut code) };
        read != 0 && code != STILL_ACTIVE
    }

    fn all_pids(&self) -> Vec<i32> {
        let mut pids = vec![0u32; 4096];
        loop {
            let mut used = 0u32;
            let bytes = (pids.len() * std::mem::size_of::<u32>()) as u32;
            // SAFETY: the buffer holds `bytes` bytes of pids.
            if unsafe { K32EnumProcesses(pids.as_mut_ptr(), bytes, &mut used) } == 0 {
                return Vec::new();
            }
            if used < bytes {
                pids.truncate(used as usize / std::mem::size_of::<u32>());
                return pids
                    .into_iter()
                    .filter(|pid| *pid > 0)
                    .filter_map(|pid| i32::try_from(pid).ok())
                    .collect();
            }
            // A full buffer may have been cut short; ask again with more.
            pids = vec![0u32; pids.len() * 2];
        }
    }

    fn executable(&self, pid: i32) -> Option<PathBuf> {
        let raw = u32::try_from(pid).ok().filter(|pid| *pid > 0)?;
        let process = Owned::process(raw, PROCESS_QUERY_LIMITED_INFORMATION)?;
        let mut buffer = vec![0u16; 32_768];
        let mut length = buffer.len() as u32;
        // SAFETY: the buffer holds `length` UTF-16 units.
        let read = unsafe {
            QueryFullProcessImageNameW(
                process.0,
                PROCESS_NAME_WIN32,
                buffer.as_mut_ptr(),
                &mut length,
            )
        };
        if read == 0 || length == 0 {
            return None;
        }
        let path = OsString::from_wide(&buffer[..length as usize]);
        Some(without_verbatim_prefix(lossy(&path)))
    }

    /// A Codex binary: `codex.exe` (the npm package's native binary, the
    /// standalone install and the desktop app's all have that name) that is
    /// a regular file. Unlike Linux, ownership and modes are not checked:
    /// Windows has no mode bits, and a binary inside this person's profile
    /// or Program Files is writable only by them or an administrator.
    fn is_trusted_codex(&self, executable: &Path) -> bool {
        executable
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.eq_ignore_ascii_case("codex.exe"))
            && std::fs::metadata(executable).is_ok_and(|metadata| metadata.is_file())
    }

    fn arguments(&self, pid: i32) -> Vec<String> {
        let kind = ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always);
        self.with_info(pid, kind, |process| {
            process.cmd().iter().map(|arg| lossy(arg)).collect()
        })
        .unwrap_or_default()
    }

    fn environment_readable(&self, pid: i32) -> bool {
        let kind = ProcessRefreshKind::nothing().with_environ(UpdateKind::Always);
        self.with_info(pid, kind, |process| !process.environ().is_empty())
            .unwrap_or(false)
    }

    /// One variable; Windows names are matched in any case, as Windows does.
    fn environment_var(&self, pid: i32, key: &str) -> Option<String> {
        let kind = ProcessRefreshKind::nothing().with_environ(UpdateKind::Always);
        self.with_info(pid, kind, |process| {
            process.environ().iter().find_map(|entry| {
                let entry = lossy(entry);
                let (name, value) = entry.split_once('=')?;
                name.eq_ignore_ascii_case(key).then(|| value.to_string())
            })
        })
        .flatten()
    }

    fn open_files(&self, pid: i32) -> Vec<PathBuf> {
        self.opened_files(pid)
            .into_iter()
            .map(|file| file.path)
            .collect()
    }

    fn opened_files(&self, pid: i32) -> Vec<OpenedFile> {
        let Some(raw) = u32::try_from(pid).ok().filter(|pid| *pid > 0) else {
            return Vec::new();
        };
        let (send, receive) = mpsc::channel();
        let started = std::thread::Builder::new()
            .name("process-open-files".into())
            .spawn(move || {
                let _ = send.send(open_disk_files(raw));
            });
        if started.is_err() {
            return Vec::new();
        }
        receive.recv_timeout(OPEN_FILES_TIMEOUT).unwrap_or_default()
    }

    fn cwd(&self, pid: i32) -> Option<PathBuf> {
        let kind = ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always);
        self.with_info(pid, kind, |process| process.cwd().map(Path::to_path_buf))
            .flatten()
    }

    fn owns_tcp_listener(&self, pid: i32, host: &str, port: u16) -> bool {
        let Ok(pid) = u32::try_from(pid) else {
            return false;
        };
        // The table keeps ports in network byte order in the low 16 bits.
        let port_of = |raw: u32| u16::from_be((raw & 0xffff) as u16);
        match host {
            "127.0.0.1" => {
                let Some(buffer) = listener_table(2) else {
                    return false;
                };
                let loopback = u32::from_ne_bytes([127, 0, 0, 1]);
                // SAFETY: a table GetExtendedTcpTable wrote; the row count
                // is bounded by the buffer.
                let rows = unsafe {
                    let table = buffer.as_ptr() as *const MIB_TCPTABLE_OWNER_PID;
                    let room = (buffer.len() * 8).saturating_sub(std::mem::size_of::<u32>())
                        / std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
                    let count = ((*table).dwNumEntries as usize).min(room);
                    std::slice::from_raw_parts(
                        std::ptr::addr_of!((*table).table).cast::<MIB_TCPROW_OWNER_PID>(),
                        count,
                    )
                };
                rows.iter().any(|row| {
                    row.dwOwningPid == pid
                        && row.dwState == MIB_TCP_STATE_LISTEN as u32
                        && row.dwLocalAddr == loopback
                        && port_of(row.dwLocalPort) == port
                })
            }
            "::1" => {
                let Some(buffer) = listener_table(23) else {
                    return false;
                };
                let mut loopback = [0u8; 16];
                loopback[15] = 1;
                // SAFETY: as above, for the IPv6 table.
                let rows = unsafe {
                    let table = buffer.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID;
                    let room = (buffer.len() * 8).saturating_sub(std::mem::size_of::<u32>())
                        / std::mem::size_of::<MIB_TCP6ROW_OWNER_PID>();
                    let count = ((*table).dwNumEntries as usize).min(room);
                    std::slice::from_raw_parts(
                        std::ptr::addr_of!((*table).table).cast::<MIB_TCP6ROW_OWNER_PID>(),
                        count,
                    )
                };
                rows.iter().any(|row| {
                    row.dwOwningPid == pid
                        && row.dwState == MIB_TCP_STATE_LISTEN as u32
                        && row.ucLocalAddr == loopback
                        && port_of(row.dwLocalPort) == port
                })
            }
            _ => false,
        }
    }

    /// Any running process. Windows cannot tell from outside whether another
    /// process's input is a console or a pipe (its console is reachable
    /// only by attaching to it, which a background core with threads cannot
    /// do safely), so the command line decides alone: `claude -p`,
    /// `--print` and the structured JSON pipes are excluded before this is
    /// asked (`claude::is_interactive_process`), and Agent SDK sessions by
    /// their `sdk-` name.
    fn has_terminal(&self, pid: i32) -> bool {
        u32::try_from(pid)
            .ok()
            .filter(|pid| *pid > 0)
            .is_some_and(|pid| creation_micros(pid).is_some())
    }

    fn start_clock(&self) -> StartClock {
        StartClock::Windows
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_paths_lose_their_prefix() {
        assert_eq!(
            without_verbatim_prefix(r"\\?\C:\Users\a\.codex\x.lock".into()),
            PathBuf::from(r"C:\Users\a\.codex\x.lock")
        );
        assert_eq!(
            without_verbatim_prefix(r"\\?\UNC\server\share\x".into()),
            PathBuf::from(r"\\server\share\x")
        );
        assert_eq!(
            without_verbatim_prefix(r"C:\plain".into()),
            PathBuf::from(r"C:\plain")
        );
    }

    #[test]
    fn this_process_runs_as_this_person_and_is_not_gone() {
        let table = SystemProcesses::default();
        let me = std::process::id() as i32;
        assert_eq!(
            table.process(me).map(|info| info.uid),
            Some(crate::relay::peer::current_uid())
        );
        assert!(!table.process_gone(me));
        assert!(!table.zombie(me));
        assert!(table.has_terminal(me));
        // The System Idle Process's pid 0 is never a process here.
        assert!(table.process(0).is_none());
    }

    #[test]
    fn an_exited_child_is_a_zombie_until_its_handle_closes() {
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        child.wait().unwrap();
        // `child` still holds its process handle.
        let table = SystemProcesses::default();
        assert!(table.zombie(pid));
        assert!(!table.process_gone(pid));
        drop(child);
    }
}
