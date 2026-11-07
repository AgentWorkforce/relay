//! Stopping processes and keeping a command's children together.
//!
//! Unix stops a process with signals and a command's children with its
//! process group. Windows has neither: a process is stopped with
//! `TerminateProcess` (there is no polite request a non-console process
//! honours, so `terminate` and `kill` are the same there), and a command's
//! children are kept together in a job object assigned right after the
//! command starts.

use std::process::Command;

/// The empty input and discarded output device.
#[cfg(unix)]
pub const NULL_DEVICE: &str = "/dev/null";
/// The empty input and discarded output device.
#[cfg(windows)]
pub const NULL_DEVICE: &str = "NUL";

#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 =
    windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
/// Lets a detached process leave the job the core runs in (a logon task's),
/// so it outlives the core. Windows refuses it when that job forbids
/// breaking away; `detach` then starts the process without it.
#[cfg(windows)]
pub(crate) const CREATE_BREAKAWAY_FROM_JOB: u32 =
    windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB;

/// Asks `pid` to stop (`SIGTERM`). Windows terminates it: see the module
/// comment. Callers name a process they started and still hold.
pub fn terminate(pid: u32) {
    #[cfg(unix)]
    {
        // SAFETY: `kill` takes plain integers and touches no memory.
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    }
    #[cfg(windows)]
    windows::terminate(pid);
}

/// Stops `pid` at once (`SIGKILL`; `TerminateProcess` on Windows).
pub fn kill(pid: u32) {
    #[cfg(unix)]
    {
        // SAFETY: `kill` takes plain integers and touches no memory.
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
    }
    #[cfg(windows)]
    windows::terminate(pid);
}

/// Whether a process `pid` exists now: `kill(pid, 0)` succeeds or is
/// refused for permission on Unix; on Windows it opens (or is refused for
/// permission) and has not exited.
pub fn exists(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    #[cfg(unix)]
    {
        // SAFETY: signal 0 checks for existence and delivers nothing.
        let alive = unsafe { libc::kill(pid, 0) == 0 };
        alive || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        windows::running(pid as u32)
    }
}

/// Makes `command` start in a process group of its own, so the group can be
/// stopped together (`Group`). On Windows: a new console process group and
/// no console window, since a window would flash up for every command the
/// background core runs.
pub fn own_group(command: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
    }
}

/// `own_group`, and on Windows also a start outside the job the core runs
/// in, so what `command` starts outlives the core (Codex's app server,
/// whose threads an update of the core must not interrupt); nothing more on
/// Unix, where `systemd-run` scopes do this. A job that forbids leaving
/// refuses the start with access denied; `own_group` then starts it inside.
pub fn leave_job(command: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        own_group(command)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command
            .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB)
    }
}

/// `own_group` for a tokio command.
pub fn own_group_tokio(command: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(unix)]
    {
        command.process_group(0)
    }
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
    }
}

/// Makes `command` start as the leader of a process session of its own
/// (`setsid(2)`; a child that cannot is not started and the spawn reports
/// the OS error), so a supervisor tearing down the core's session leaves it
/// running. Windows has no sessions: the process gets its own console
/// process group and no console window. A Windows child is not stopped with
/// its parent anyway, unless a job says so (see `CREATE_BREAKAWAY_FROM_JOB`).
pub fn new_session(command: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: this closure runs after fork and before exec, calls only
        // the async-signal-safe `setsid(2)`, and returns an OS error without
        // touching shared state.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            })
        }
    }
    #[cfg(windows)]
    {
        own_group(command)
    }
}

/// Keeps a console window from opening for `command` on Windows, where the
/// background core has none for it to share; nothing on Unix.
pub fn hide_window(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// `hide_window` for a tokio command.
pub fn hide_window_tokio(command: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// A started command and whatever it starts, stopped together.
///
/// Unix: the process group the command leads (`own_group`); while any
/// member lives the group id cannot name another process. Windows: a job
/// object the command is assigned to as soon as it starts; a child it
/// starts in that first instant can escape it. When the job cannot be made,
/// only the command itself is stopped.
pub struct Group {
    #[cfg(unix)]
    leader: i32,
    #[cfg(windows)]
    job: windows::Job,
}

impl Group {
    /// The group of `child`, started with `own_group`.
    pub fn of(child: &std::process::Child) -> Group {
        #[cfg(unix)]
        {
            Group {
                leader: child.id() as i32,
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            Group {
                job: windows::Job::adopt(child.id(), child.as_raw_handle()),
            }
        }
    }

    /// The group of a tokio `child` started with `own_group_tokio`; `None`
    /// once it has been reaped.
    pub fn of_tokio(child: &tokio::process::Child) -> Option<Group> {
        let pid = child.id()?;
        #[cfg(unix)]
        {
            Some(Group { leader: pid as i32 })
        }
        #[cfg(windows)]
        {
            let handle = child.raw_handle()?;
            Some(Group {
                job: windows::Job::adopt(pid, handle),
            })
        }
    }

    /// Asks every member to stop (`SIGTERM` to the group). Windows
    /// terminates the job: see the module comment.
    pub fn terminate(&self) {
        #[cfg(unix)]
        {
            // SAFETY: signalling a process group this core created.
            unsafe { libc::kill(-self.leader, libc::SIGTERM) };
        }
        #[cfg(windows)]
        self.job.terminate();
    }

    /// Stops every member at once.
    pub fn kill(&self) {
        #[cfg(unix)]
        {
            // SAFETY: as in `terminate`.
            unsafe { libc::kill(-self.leader, libc::SIGKILL) };
        }
        #[cfg(windows)]
        self.job.terminate();
    }
}

#[cfg(windows)]
mod windows {
    use std::os::windows::io::RawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_TERMINATE,
    };

    /// `GetExitCodeProcess`'s answer for a process that has not exited.
    const STILL_ACTIVE: u32 = windows_sys::Win32::Foundation::STILL_ACTIVE as u32;

    pub fn terminate(pid: u32) {
        // SAFETY: the handle is checked, used once and closed.
        unsafe {
            let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return;
            }
            TerminateProcess(process, 1);
            CloseHandle(process);
        }
    }

    pub fn running(pid: u32) -> bool {
        // SAFETY: the handle is checked, used once and closed; `code` is a
        // valid out pointer.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                // Opening is refused for a protected process, which exists
                // all the same.
                return std::io::Error::last_os_error().raw_os_error()
                    == Some(windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED as i32);
            }
            let mut code = 0u32;
            let read = GetExitCodeProcess(process, &mut code);
            CloseHandle(process);
            read != 0 && code == STILL_ACTIVE
        }
    }

    /// A job object holding one command and its children. The handle is
    /// kept as an integer so the group can move between threads; it is
    /// this value's alone and closed on drop.
    pub struct Job {
        job: isize,
        leader: u32,
    }

    impl Job {
        pub fn adopt(leader: u32, process: RawHandle) -> Job {
            // SAFETY: a job with default security and no name; `process` is
            // the live handle of a child the caller holds.
            let job = unsafe {
                let job: HANDLE = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    0
                } else if AssignProcessToJobObject(job, process as HANDLE) == 0 {
                    CloseHandle(job);
                    0
                } else {
                    job as isize
                }
            };
            Job { job, leader }
        }

        pub fn terminate(&self) {
            if self.job == 0 {
                terminate(self.leader);
                return;
            }
            // SAFETY: the job handle this value owns.
            unsafe { TerminateJobObject(self.job as HANDLE, 1) };
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            if self.job != 0 {
                // SAFETY: the job handle this value owns, closed once.
                unsafe { CloseHandle(self.job as HANDLE) };
            }
        }
    }
}
