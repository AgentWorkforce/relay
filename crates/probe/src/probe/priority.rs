//! Priority requests for local history capture and upload work.
//!
//! On macOS the capture thread and the detached collector's main caller
//! explicitly request utility QoS, below interactive work. Inventory and remote
//! polling request background QoS separately. We do not apply Darwin background
//! policy to the whole collector. Requested class does not describe effective
//! scheduling or a launchd role, and spawned threads must choose their own policy.
//! Linux retains nice 19 for the capture caller and the detached main caller
//! (later Linux threads inherit it); Windows retains its thread and process
//! background modes. Failed requests log content-free JSON and never stop capture.
use serde_json::json;

/// Lower the calling thread to background priority. `thread` names it in
/// the log line written when that fails.
pub(super) fn background(thread: &'static str) {
    #[cfg(target_os = "macos")]
    let result = lower(libc::qos_class_t::QOS_CLASS_BACKGROUND);
    #[cfg(not(target_os = "macos"))]
    let result = lower();
    if let Err(error) = result {
        eprintln!(
            "{}",
            json!({"operation":"capture","stage":"thread_priority","thread":thread,"outcome":"unchanged","errno":error.raw_os_error()})
        );
    }
}

/// Set capture priority on its own thread, including cold slices.
pub(super) fn capture() {
    #[cfg(target_os = "macos")]
    utility("capture");
    #[cfg(not(target_os = "macos"))]
    background("capture");
}

/// Choose the detached collector caller's policy before starting workers.
/// macOS requests utility only for this caller, without process backgrounding.
/// Other platforms retain their existing detached-process priority behavior.
pub(super) fn collector() {
    #[cfg(target_os = "macos")]
    utility("collector");
    #[cfg(not(target_os = "macos"))]
    if let Err(error) = lower_process() {
        eprintln!(
            "{}",
            json!({"operation":"capture","stage":"process_priority","outcome":"unchanged","errno":error.raw_os_error()})
        );
    }
}

#[cfg(target_os = "macos")]
fn utility(thread: &'static str) {
    if let Err(error) = lower(libc::qos_class_t::QOS_CLASS_UTILITY) {
        eprintln!(
            "{}",
            json!({"operation":"capture","stage":"thread_priority","thread":thread,"outcome":"unchanged","errno":error.raw_os_error()})
        );
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
fn lower(class: libc::qos_class_t) -> std::io::Result<()> {
    // SAFETY: changes only the calling thread's QoS class; no pointers.
    let status = unsafe { libc::pthread_set_qos_class_self_np(class, 0) };
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

    /// Linux retains nice 19 for the detached caller and its later threads.
    /// The owned child leaves the test process's priority unchanged.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_collector_lowers_every_linux_thread_it_starts() {
        const CHILD: &str = "AGENT_RELAY_PRIORITY_TEST_CHILD";
        let name = "a_collector_lowers_every_linux_thread_it_starts";
        if std::env::var_os(CHILD).is_some() {
            collector();
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

    #[cfg(target_os = "linux")]
    fn process_lowered() -> bool {
        current() == BACKGROUND
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn capture_requests_utility_without_backgrounding_the_process() {
        utility_in_owned_child(
            "capture_requests_utility_without_backgrounding_the_process",
            capture,
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn collector_requests_utility_without_backgrounding_the_process() {
        utility_in_owned_child(
            "collector_requests_utility_without_backgrounding_the_process",
            collector,
        );
    }

    #[cfg(target_os = "macos")]
    fn utility_in_owned_child(name: &str, policy: fn()) {
        const CHILD: &str = "AGENT_RELAY_UTILITY_TEST_CHILD";
        let before = (requested(), process_background());
        if std::env::var(CHILD).as_deref() == Ok(name) {
            assert_eq!(
                before.1, 0,
                "the owned fixture starts without Darwin background"
            );
            let caller_before = requested();
            let observed = std::thread::spawn(move || {
                policy();
                assert_eq!(process_background(), 0, "no process background request");
                requested()
            })
            .join()
            .unwrap();
            assert_eq!(observed, (libc::qos_class_t::QOS_CLASS_UTILITY as u32, 0));
            assert_eq!(requested(), caller_before, "the other caller keeps its QoS");
            assert_eq!(process_background(), 0);
            return;
        }
        let module = module_path!().split_once("::").unwrap().1;
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([&format!("{module}::{name}"), "--exact", "--nocapture"])
            .env(CHILD, name)
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
        assert_eq!(
            (requested(), process_background()),
            before,
            "parent policy is unchanged"
        );
    }

    #[cfg(target_os = "macos")]
    fn process_background() -> i32 {
        // SAFETY: errno belongs to this thread; getpriority only reads process policy.
        unsafe {
            *libc::__error() = 0;
            let value = libc::getpriority(libc::PRIO_DARWIN_PROCESS, 0);
            assert_eq!(
                *libc::__error(),
                0,
                "Darwin process policy getter succeeded"
            );
            value
        }
    }

    #[cfg(target_os = "macos")]
    const BACKGROUND: u32 = libc::qos_class_t::QOS_CLASS_BACKGROUND as u32;
    #[cfg(target_os = "macos")]
    fn current() -> u32 {
        requested().0
    }
    #[cfg(target_os = "macos")]
    fn requested() -> (u32, i32) {
        let mut class = libc::qos_class_t::QOS_CLASS_UNSPECIFIED;
        let mut relative = 0;
        // SAFETY: reads the calling thread's QoS into locals.
        let status = unsafe {
            libc::pthread_get_qos_class_np(libc::pthread_self(), &mut class, &mut relative)
        };
        assert_eq!(status, 0, "requested QoS getter succeeded");
        (class as u32, relative)
    }

    #[cfg(target_os = "linux")]
    const BACKGROUND: i32 = 19;
    #[cfg(target_os = "linux")]
    fn current() -> i32 {
        // SAFETY: plain syscalls with integer arguments.
        unsafe { libc::getpriority(libc::PRIO_PROCESS, libc::gettid() as libc::id_t) }
    }
}
