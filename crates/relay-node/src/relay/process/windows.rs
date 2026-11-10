//! The process table on Windows.
//!
//! - **pid, parent, start**: `OpenProcess` plus `NtQueryInformationProcess`
//!   and its exit status for a process this one can open (an exited process
//!   that another handle keeps open is not a process: `process` is `None`);
//!   for one it cannot open (another account's, an elevated one), the
//!   kernel's whole process list (`NtQuerySystemInformation`), read at most
//!   once per `TABLE_TTL` and shared by every pid. Never a sysinfo refresh
//!   per pid: on Windows sysinfo snapshots every process and thread of the
//!   computer to refresh one, which made a scan that asks about every pid
//!   cost the process count times that snapshot. Windows never reparents:
//!   a parent that exited leaves its pid free for reuse, so a "parent" that
//!   started after its child is a stranger and is reported as no parent
//!   (0), which ends every ancestry walk there.
//! - **owner**: `peer::process_uid`, the uid the process token's user SID
//!   maps to (the scheme `peer::current_uid` uses for this person); a
//!   process whose token cannot be read reports `u32::MAX`, which matches
//!   no one.
//! - **executable**: `QueryFullProcessImageNameW`, the kernel's image path.
//! - **arguments, environment, folder**: sysinfo, which reads them from the
//!   process's PEB (this user's processes only), for every process in one
//!   refresh per `TABLE_TTL`. They can be up to `TABLE_TTL` old (a folder may
//!   lag a `cd` by that much). A pid the table predates (or one reused since,
//!   told by its start time) is read on its own, so a process that has just
//!   started, this one's caller included, is always read exactly.
//! - **open files**: the system handle table, read at most once per
//!   `TABLE_TTL` (a handle opened within it is not seen yet; a handle value
//!   closed since fails to duplicate and is skipped, or names a file the
//!   process has open now), each of the process's handles
//!   duplicated into this one; only disk files are named (`GetFileType`
//!   first, so a pipe, whose name query can block, is never asked), and
//!   their creation time is read from the duplicated handle, so a path
//!   replaced since cannot change it. The walk runs on a thread of its own
//!   and is abandoned after `OPEN_FILES_TIMEOUT`.
//! - **TCP listeners**: `GetExtendedTcpTable`.
//! - **terminal**: see `has_terminal`.
//! - **zombie**: an exited process whose object another handle keeps:
//!   `process` is `None`, `zombie` is true and `process_gone` is false.

use super::*;
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::OsStringExt;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use windows_sys::Wdk::System::SystemInformation::NtQuerySystemInformation;
use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
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

/// The exit status a running process reports.
const STATUS_PENDING: i32 = 0x103;

/// `SystemProcessInformation`, the kernel's list of every process.
const SYSTEM_PROCESS_INFORMATION: i32 = 5;

/// How long a whole-computer table (processes, their facts, open handles)
/// answers before it is read again.
const TABLE_TTL: Duration = Duration::from_secs(1);

type KernelList = HashMap<u32, (u32, Option<u64>)>;
type HandleTable = HashMap<u32, Vec<usize>>;

/// What sysinfo reads from a process's PEB.
#[derive(Clone, Default)]
struct Facts {
    start_secs: u64,
    arguments: Vec<String>,
    environment: Option<Vec<String>>,
    cwd: Option<PathBuf>,
}

/// The whole-computer tables, each rebuilt at most once per `TABLE_TTL`:
/// `kernel`, parent and start of every process; `facts`, their arguments,
/// environments and folders; `handles`, every open handle value by pid.
#[derive(Default)]
pub struct Cache {
    kernel: Mutex<Option<(Instant, KernelList)>>,
    facts: Mutex<Option<(Instant, HashMap<u32, Facts>)>>,
    handles: Mutex<Option<(Instant, HandleTable)>>,
}

/// `read` of the table in `slot`, rebuilt first when missing or stale. A
/// failed rebuild leaves the slot empty, so the next call tries again.
fn with_table<T, R>(
    slot: &Mutex<Option<(Instant, T)>>,
    build: impl FnOnce() -> Option<T>,
    read: impl FnOnce(&T) -> R,
) -> Option<R> {
    let mut slot = slot.lock().unwrap_or_else(|error| error.into_inner());
    if slot
        .as_ref()
        .is_none_or(|(taken, _)| taken.elapsed() >= TABLE_TTL)
    {
        *slot = build().map(|table| (Instant::now(), table));
    }
    slot.as_ref().map(|(_, table)| read(table))
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
    creation_micros_of(&Owned::process(pid, PROCESS_QUERY_LIMITED_INFORMATION)?)
}

/// When the process `process` opens was created, in microseconds since the
/// Unix epoch.
fn creation_micros_of(process: &Owned) -> Option<u64> {
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

/// `PROCESS_BASIC_INFORMATION`, declared here so its PEB pointer, never
/// read, needs no `Win32_System_Kernel` feature.
#[repr(C)]
#[allow(dead_code)]
struct BasicInformation {
    exit_status: i32,
    peb: *mut std::ffi::c_void,
    affinity_mask: usize,
    base_priority: i32,
    unique_process_id: usize,
    inherited_from_unique_process_id: usize,
}

/// What the kernel records of the process `process` opens: its exit status
/// and the pid its creator had (possibly reused since: `process` checks
/// start times).
fn basic_information(process: &Owned) -> Option<BasicInformation> {
    // SAFETY: plain integers and null pointers; every field is overwritten
    // by the kernel on success and unread on failure.
    let mut info: BasicInformation = unsafe { std::mem::zeroed() };
    // SAFETY: a live process handle and an out buffer of the stated size.
    let status = unsafe {
        NtQueryInformationProcess(
            process.0,
            ProcessBasicInformation,
            (&mut info as *mut BasicInformation).cast(),
            std::mem::size_of::<BasicInformation>() as u32,
            std::ptr::null_mut(),
        )
    };
    (status >= 0).then_some(info)
}

/// The leading fields of `SYSTEM_PROCESS_INFORMATION`'s image name.
#[repr(C)]
#[allow(dead_code)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

/// The leading fields of `SYSTEM_PROCESS_INFORMATION`, which is all that is
/// read; the entry is longer, `next_entry_offset` leads to the next one.
#[repr(C)]
#[allow(dead_code)]
struct ProcessEntry {
    next_entry_offset: u32,
    number_of_threads: u32,
    working_set_private_size: i64,
    hard_fault_count: u32,
    number_of_threads_high_watermark: u32,
    cycle_time: u64,
    create_time: i64,
    user_time: i64,
    kernel_time: i64,
    image_name: UnicodeString,
    base_priority: i32,
    unique_process_id: usize,
    inherited_from_unique_process_id: usize,
}

#[cfg(target_pointer_width = "64")]
const _: () = assert!(std::mem::offset_of!(ProcessEntry, inherited_from_unique_process_id) == 88);

/// The largest process list read; past it the read gives up.
const MAX_PROCESS_LIST: usize = 64 << 20;

/// Every process of the computer: pid to its parent pid and creation time
/// (microseconds since the Unix epoch), in one kernel call.
fn kernel_process_list() -> Option<KernelList> {
    let mut size: usize = 1 << 20;
    loop {
        let mut buffer = vec![0u64; size / 8];
        let mut needed = 0u32;
        // SAFETY: the buffer holds `size` bytes, aligned for the list.
        let status = unsafe {
            NtQuerySystemInformation(
                SYSTEM_PROCESS_INFORMATION,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * 8) as u32,
                &mut needed,
            )
        };
        if status == STATUS_INFO_LENGTH_MISMATCH {
            size = (size * 2).max(needed as usize + (256 << 10));
            if size > MAX_PROCESS_LIST {
                return None;
            }
            continue;
        }
        if status < 0 {
            return None;
        }
        let byte_len = buffer.len() * 8;
        let base = buffer.as_ptr() as *const u8;
        let mut list = KernelList::new();
        let mut offset = 0usize;
        while offset + std::mem::size_of::<ProcessEntry>() <= byte_len {
            // SAFETY: the entry lies inside the buffer the kernel filled
            // (checked above); the read makes no alignment assumption.
            let entry =
                unsafe { std::ptr::read_unaligned(base.add(offset) as *const ProcessEntry) };
            if let (Ok(pid), Ok(parent)) = (
                u32::try_from(entry.unique_process_id),
                u32::try_from(entry.inherited_from_unique_process_id),
            ) {
                if pid != 0 {
                    let created = (entry.create_time as u64)
                        .checked_sub(FILETIME_UNIX_EPOCH)
                        .map(|ticks| ticks / 10);
                    list.insert(pid, (parent, created));
                }
            }
            if entry.next_entry_offset == 0 {
                break;
            }
            offset += entry.next_entry_offset as usize;
        }
        return Some(list);
    }
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

/// The handle values every process holds, by pid, from the system handle
/// table.
fn handle_table() -> Option<HandleTable> {
    let mut size: usize = 4 << 20;
    loop {
        let mut buffer = vec![0u64; size / 8];
        let mut needed = 0u32;
        // SAFETY: the buffer holds `size` bytes, aligned for the table.
        let status = unsafe {
            NtQuerySystemInformation(
                SYSTEM_EXTENDED_HANDLE_INFORMATION,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * 8) as u32,
                &mut needed,
            )
        };
        if status == STATUS_INFO_LENGTH_MISMATCH {
            size = (size * 2).max(needed as usize + (1 << 20));
            if size > MAX_HANDLE_TABLE {
                return None;
            }
            continue;
        }
        if status < 0 {
            return None;
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
        let mut table = HandleTable::new();
        for entry in entries {
            if let Ok(pid) = u32::try_from(entry.process) {
                table.entry(pid).or_default().push(entry.handle);
            }
        }
        return Some(table);
    }
}

/// The disk files `pid` has open among `handles` (the values the handle
/// table gave for it), with the creation time of each.
fn open_disk_files(pid: u32, handles: Vec<usize>) -> Vec<OpenedFile> {
    let Some(process) = Owned::process(pid, PROCESS_DUP_HANDLE) else {
        return Vec::new();
    };
    // SAFETY: the pseudo-handle of this process needs no closing.
    let me = unsafe { GetCurrentProcess() };
    handles
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

/// What sysinfo read of one process, as `Facts`; `None` for a process
/// without a start time (sysinfo lists it but read nothing).
fn facts_of(process: &sysinfo::Process) -> Option<Facts> {
    let start_secs = process.start_time();
    (start_secs != 0).then(|| Facts {
        start_secs,
        arguments: process.cmd().iter().map(lossy).collect(),
        environment: (!process.environ().is_empty())
            .then(|| process.environ().iter().map(lossy).collect()),
        cwd: process.cwd().map(Path::to_path_buf),
    })
}

fn facts_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_cmd(UpdateKind::Always)
        .with_environ(UpdateKind::Always)
        .with_cwd(UpdateKind::Always)
}

/// The facts of every process, from one sysinfo refresh. The `System` is
/// dropped before returning: it holds a process handle per process, which
/// the cache must not keep.
fn build_facts() -> HashMap<u32, Facts> {
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, facts_kind());
    system
        .processes()
        .iter()
        .filter_map(|(pid, process)| Some((pid.as_u32(), facts_of(process)?)))
        .collect()
}

/// The facts of one process, from a refresh of that pid alone.
fn one_pid_facts(pid: u32) -> Option<Facts> {
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, facts_kind());
    facts_of(system.process(pid)?)
}

impl SystemProcesses {
    /// The kernel list's entry for `pid`: parent and creation time.
    fn kernel_entry(&self, pid: u32) -> Option<(u32, Option<u64>)> {
        with_table(&self.windows.kernel, kernel_process_list, |list| {
            list.get(&pid).copied()
        })
        .flatten()
    }

    /// When `pid` started, in microseconds since the epoch: the process's
    /// own creation time, else the kernel list's.
    fn start_micros(&self, pid: u32) -> Option<u64> {
        creation_micros(pid).or_else(|| self.kernel_entry(pid)?.1)
    }

    /// `read` of `pid`'s facts, at most `TABLE_TTL` old, for a process this
    /// one can open (one it cannot has an unreadable PEB anyway). A pid the
    /// table predates, or reused since (its start seconds differ), is read
    /// on its own.
    fn facts<T>(&self, pid: i32, read: impl FnOnce(&Facts) -> T) -> Option<T> {
        let raw = u32::try_from(pid).ok().filter(|pid| *pid > 0)?;
        let start_secs = creation_micros(raw)? / 1_000_000;
        let mut read = Some(read);
        let cached = with_table(
            &self.windows.facts,
            || Some(build_facts()),
            |table| {
                table
                    .get(&raw)
                    .filter(|facts| facts.start_secs == start_secs)
                    .and_then(|facts| read.take().map(|read| read(facts)))
            },
        )
        .flatten();
        if cached.is_some() {
            return cached;
        }
        let facts = one_pid_facts(raw).filter(|facts| facts.start_secs == start_secs)?;
        let result = (read.take()?)(&facts);
        let mut slot = self
            .windows
            .facts
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some((_, table)) = slot.as_mut() {
            table.insert(raw, facts);
        }
        Some(result)
    }
}

impl ProcessTable for SystemProcesses {
    fn process(&self, pid: i32) -> Option<ProcessInfo> {
        let raw = u32::try_from(pid).ok().filter(|pid| *pid > 0)?;
        let (parent, start, uid) =
            if let Some(handle) = Owned::process(raw, PROCESS_QUERY_LIMITED_INFORMATION) {
                let info = basic_information(&handle)?;
                // An exited process some handle keeps is not a process.
                if info.exit_status != STATUS_PENDING {
                    return None;
                }
                let start = creation_micros_of(&handle)?;
                let parent = u32::try_from(info.inherited_from_unique_process_id).unwrap_or(0);
                // Read while `handle` is held: the pid cannot be reused
                // between the reads.
                let uid = crate::relay::peer::process_uid(raw).unwrap_or(u32::MAX);
                (parent, start, uid)
            } else {
                let (parent, start) = self.kernel_entry(raw)?;
                let uid = crate::relay::peer::process_uid(raw).unwrap_or(u32::MAX);
                (parent, start?, uid)
            };
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

    fn command_line(&self, pid: i32) -> CommandLine {
        self.facts(pid, |facts| CommandLine {
            arguments: facts.arguments.clone(),
            environment: facts.environment.clone(),
        })
        .unwrap_or_default()
    }

    fn arguments(&self, pid: i32) -> Vec<String> {
        self.facts(pid, |facts| facts.arguments.clone())
            .unwrap_or_default()
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
        let handles = with_table(&self.windows.handles, handle_table, |table| {
            table.get(&raw).cloned().unwrap_or_default()
        })
        .unwrap_or_default();
        if handles.is_empty() {
            return Vec::new();
        }
        let (send, receive) = mpsc::channel();
        let started = std::thread::Builder::new()
            .name("process-open-files".into())
            .spawn(move || {
                let _ = send.send(open_disk_files(raw, handles));
            });
        if started.is_err() {
            return Vec::new();
        }
        receive.recv_timeout(OPEN_FILES_TIMEOUT).unwrap_or_default()
    }

    fn cwd(&self, pid: i32) -> Option<PathBuf> {
        self.facts(pid, |facts| facts.cwd.clone()).flatten()
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

    /// A `ping.exe` child that is killed and reaped when dropped.
    struct Pinger(std::process::Child);

    impl Pinger {
        fn start() -> Pinger {
            Pinger(
                std::process::Command::new("ping.exe")
                    .args(["-n", "30", "127.0.0.1"])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .unwrap(),
            )
        }

        fn pid(&self) -> i32 {
            self.0.id() as i32
        }
    }

    impl Drop for Pinger {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn a_running_child_names_this_process_as_its_parent() {
        let child = Pinger::start();
        let table = SystemProcesses::default();
        let parent = table.process(child.pid()).map(|info| info.parent);
        assert_eq!(parent, Some(std::process::id() as i32));
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
        assert!(table.process(pid).is_none());
        drop(child);
    }

    #[test]
    fn the_kernel_list_agrees_with_this_process_handle() {
        let me = std::process::id();
        let list = kernel_process_list().unwrap();
        let (parent, created) = *list.get(&me).expect("this process is listed");
        assert_eq!(created, creation_micros(me));
        let handle = Owned::process(me, PROCESS_QUERY_LIMITED_INFORMATION).unwrap();
        let info = basic_information(&handle).unwrap();
        assert_eq!(
            u32::try_from(info.inherited_from_unique_process_id).ok(),
            Some(parent)
        );
    }

    #[test]
    fn facts_of_this_process_and_of_a_new_child() {
        let table = SystemProcesses::default();
        let me = std::process::id() as i32;
        assert!(!table.arguments(me).is_empty());
        let environment = table.command_line(me).environment.unwrap();
        assert!(environment
            .iter()
            .any(|entry| entry.to_ascii_uppercase().starts_with("PATH=")));
        assert!(table.cwd(me).is_some());
        // Started after the cached table was read: read on its own.
        let child = Pinger::start();
        assert!(table
            .arguments(child.pid())
            .iter()
            .any(|argument| argument == "127.0.0.1"));
    }

    #[test]
    fn open_files_sees_a_file_held_by_this_process() {
        let name = format!("relay-open-files-{}.tmp", std::process::id());
        let path = std::env::temp_dir().join(&name);
        let file = std::fs::File::create(&path).unwrap();
        let table = SystemProcesses::default();
        let open = table.open_files(std::process::id() as i32);
        drop(file);
        let _ = std::fs::remove_file(&path);
        assert!(open.iter().any(|open| open
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|found| found.eq_ignore_ascii_case(&name))));
    }
}
