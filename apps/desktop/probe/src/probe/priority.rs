//! Background priority for the work that reads and uploads local history.
//!
//! A capture sweep, an inventory pass or an upload is catch-up work nobody
//! waits on interactively, while the provider writing the transcript it reads
//! is the user's foreground work. The detached collector (`run`) is therefore
//! a background process as a whole: on macOS a Darwin background process,
//! whose CPU, disk and network use are throttled; on Linux nice 19, set on
//! its main thread before any other starts, so every thread inherits it.
//! Within a process that stays at normal priority (a foreground `start`, the
//! relay core, which also starts the person's agents), the capture and
//! inventory threads alone drop to background: on macOS the background QoS
//! class, which also throttles the thread's disk I/O; on Linux nice 19 for
//! the calling thread. Threads they start inherit it. Windows uses its
//! background modes: the whole process for `run`, the calling thread alone
//! elsewhere (threads it starts do not inherit it there). Failing to lower the
//! priority is logged once as a content-free JSON line and never stops
//! capture.
use serde_json::json;

/// Lower the calling thread to background priority. `thread` names it in
/// the log line written when that fails.
pub(super) fn background(thread: &'static str) {
    if let Err(error) = lower() {
        eprintln!(
            "{}",
            json!({"operation":"capture","stage":"thread_priority","thread":thread,"outcome":"unchanged","errno":error.raw_os_error()})
        );
    }
}

/// Make the whole process a background process. Call it from the main
/// thread before any other thread starts: on Linux the threads started later
/// inherit the main thread's priority.
pub(super) fn background_process() {
    if let Err(error) = lower_process() {
        eprintln!(
            "{}",
            json!({"operation":"capture","stage":"process_priority","outcome":"unchanged","errno":error.raw_os_error()})
        );
    }
}

#[cfg(target_os = "macos")]
fn lower_process() -> std::io::Result<()> {
    // SAFETY: changes only this process's scheduling policy; no pointers.
    let status = unsafe { libc::setpriority(libc::PRIO_DARWIN_PROCESS, 0, libc::PRIO_DARWIN_BG) };
    if status == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn lower_process() -> std::io::Result<()> {
    lower()
}

/// Windows: the process's background mode, which lowers the CPU, disk I/O
/// and memory priority of every thread it has and starts.
#[cfg(windows)]
fn lower_process() -> std::io::Result<()> {
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, SetPriorityClass, PROCESS_MODE_BACKGROUND_BEGIN,
    };
    // SAFETY: changes only this process's scheduling, through its pseudo-handle.
    if unsafe { SetPriorityClass(GetCurrentProcess(), PROCESS_MODE_BACKGROUND_BEGIN) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
fn lower() -> std::io::Result<()> {
    // SAFETY: changes only the calling thread's QoS class; no pointers.
    let status =
        unsafe { libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0) };
    if status == 0 {
        Ok(())
    } else {
        Err(std::io::Error::from_raw_os_error(status))
    }
}

#[cfg(target_os = "linux")]
fn lower() -> std::io::Result<()> {
    // On Linux a nice value belongs to the thread its id names, so this
    // lowers the calling thread and the threads it starts, not the process.
    // SAFETY: plain syscalls with integer arguments.
    let status = unsafe {
        let thread = libc::gettid();
        libc::setpriority(libc::PRIO_PROCESS, thread as libc::id_t, 19)
    };
    if status == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Windows: the calling thread's background mode (lower CPU, disk I/O and
/// memory priority). Unlike Linux, threads it starts later do not inherit
/// it; they run at normal priority unless they lower themselves.
#[cfg(windows)]
fn lower() -> std::io::Result<()> {
    use windows_sys::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN,
    };
    // SAFETY: changes only the calling thread, through its pseudo-handle.
    if unsafe { SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn lower() -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod tests {
    use super::*;

    /// The calling thread, and only it, runs at background priority.
    #[test]
    fn a_background_thread_is_lowered_and_others_are_not() {
        let before = current();
        let lowered = std::thread::spawn(|| {
            background("test");
            current()
        })
        .join()
        .unwrap();
        assert_eq!(lowered, BACKGROUND);
        assert_eq!(current(), before, "the calling thread alone is lowered");
        assert_ne!(before, BACKGROUND);
    }

    /// A background process runs every thread, including ones it starts
    /// later, at background priority. It runs in a child process so the test
    /// process keeps its own priority.
    #[test]
    fn a_background_process_lowers_every_thread_it_starts() {
        const CHILD: &str = "AGENT_RELAY_PRIORITY_TEST_CHILD";
        let name = "a_background_process_lowers_every_thread_it_starts";
        if std::env::var_os(CHILD).is_some() {
            background_process();
            assert!(process_lowered());
            assert!(std::thread::spawn(process_lowered).join().unwrap());
            return;
        }
        // The harness names a test by its path without the crate.
        let module = module_path!().split_once("::").unwrap().1;
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([&format!("{module}::{name}"), "--exact", "--nocapture"])
            .env(CHILD, "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "{stdout}{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            stdout.contains("1 passed"),
            "the child ran the test: {stdout}"
        );
        assert!(!process_lowered(), "the test process keeps its priority");
    }

    /// macOS: the process's Darwin background policy, which governs every
    /// thread whatever its QoS class. Linux: the calling thread's nice value.
    #[cfg(target_os = "macos")]
    fn process_lowered() -> bool {
        // SAFETY: reads this process's scheduling policy.
        unsafe { libc::getpriority(libc::PRIO_DARWIN_PROCESS, 0) != 0 }
    }
    #[cfg(target_os = "linux")]
    fn process_lowered() -> bool {
        current() == BACKGROUND
    }

    #[cfg(target_os = "macos")]
    const BACKGROUND: u32 = libc::qos_class_t::QOS_CLASS_BACKGROUND as u32;
    #[cfg(target_os = "macos")]
    fn current() -> u32 {
        let mut class = libc::qos_class_t::QOS_CLASS_UNSPECIFIED;
        let mut relative = 0;
        // SAFETY: reads the calling thread's QoS into locals.
        unsafe {
            libc::pthread_get_qos_class_np(libc::pthread_self(), &mut class, &mut relative);
        }
        class as u32
    }

    #[cfg(target_os = "linux")]
    const BACKGROUND: i32 = 19;
    #[cfg(target_os = "linux")]
    fn current() -> i32 {
        // SAFETY: plain syscalls with integer arguments.
        unsafe { libc::getpriority(libc::PRIO_PROCESS, libc::gettid() as libc::id_t) }
    }
}
