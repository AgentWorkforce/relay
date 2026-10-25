//! `agent-relay-desktop`, the Linux and Windows app.
//!
//! `--headless` runs the relay core itself (`agent-relay-probe relay serve
//! --headless`), as the systemd user unit or the Windows logon task does.
//! `--install-launcher` lists a per-user install in the desktop's app
//! launcher (the Start menu on Windows) and exits. Anything else opens the
//! window (built with the `gtk` feature); `--background` starts it in the
//! tray, and `agentrelay://` links open in it.
//!
//! On Windows this is a GUI program, so opening the app shows no console.
//! `--headless` started from a terminal attaches to that terminal's console
//! for its output and Ctrl+C, but the terminal does not wait for a GUI
//! program: run `agent-relay-probe.exe relay serve --headless` (or `start
//! /wait agent-relay-desktop --headless`) to keep the prompt until the core ends.
#![cfg_attr(windows, windows_subsystem = "windows")]

use agent_relay_probe::linux_app::{install, updates};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::process::{Command, ExitCode};

fn main() -> ExitCode {
    agent_relay_probe::platform::adopt_profile_home();
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.iter().any(|argument| argument == "--headless") {
        return headless(&arguments);
    }
    #[cfg(windows)]
    windows::wait_for_replaced_app();
    if arguments
        .iter()
        .any(|argument| argument == "--install-launcher")
    {
        #[cfg(windows)]
        windows::attach_console();
        return install_launcher();
    }
    // The launcher entry follows the running per-user install; it is a
    // convenience and never stops the app.
    if let (Ok(exe), Ok(host)) = (install::current_exe(), updates::Host::system()) {
        let _ = updates::ensure_launcher(&exe, &host);
    }
    window()
}

#[cfg(feature = "gtk")]
fn window() -> ExitCode {
    agent_relay_probe::linux_app::ui::run()
}

#[cfg(not(feature = "gtk"))]
fn window() -> ExitCode {
    #[cfg(windows)]
    windows::attach_console();
    eprintln!("This build of Agent Relay has no window. Run `agent-relay-desktop --headless` to run the relay core.");
    ExitCode::FAILURE
}

/// Replaces this process with the core, so the unit or terminal that runs
/// `agent-relay-desktop --headless` supervises the core itself. Windows has no
/// `exec`: there the core runs as a child this process waits for, ended
/// with it.
fn headless(arguments: &[String]) -> ExitCode {
    #[cfg(windows)]
    let console = windows::attach_console();
    if let Some(unexpected) = arguments.iter().find(|argument| *argument != "--headless") {
        eprintln!("Unknown headless option: {unexpected}");
        return ExitCode::from(2);
    }
    let Some(probe) = install::current_bundled_probe() else {
        eprintln!("Agent Relay could not find its helper program. Reinstall the app or set RELAY_DESKTOP_PROBE.");
        return ExitCode::FAILURE;
    };
    let mut command = Command::new(&probe);
    command.args(["relay", "serve", "--headless"]);
    #[cfg(unix)]
    let error = command.exec();
    #[cfg(windows)]
    let error = match windows::run_and_wait(command, console) {
        Ok(code) => return code,
        Err(error) => error,
    };
    let text = error.to_string();
    let reason = text.split(" (os error").next().unwrap_or(&text);
    eprintln!("Agent Relay could not start its helper program: {reason}.");
    ExitCode::FAILURE
}

fn install_launcher() -> ExitCode {
    let (exe, host) = match (install::current_exe(), updates::Host::system()) {
        (Ok(exe), Ok(host)) => (exe, host),
        (Err(error), _) | (_, Err(error)) => {
            eprintln!("Agent Relay could not find where it is installed: {error}.");
            return ExitCode::FAILURE;
        }
    };
    let (code, message) = updates::install_launcher_command(&exe, &host);
    if code == 0 {
        println!("{message}");
    } else {
        eprintln!("{message}");
    }
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

#[cfg(windows)]
mod windows {
    use agent_relay_probe::linux_app::updates::windows::{CREATE_NO_WINDOW, WAIT_FOR_PID};
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, ExitCode};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Console::{
        AttachConsole, SetConsoleCtrlHandler, ATTACH_PARENT_PROCESS,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    /// Attaches to the console of the terminal that started this program,
    /// if any, so its messages show there. True when attached.
    pub fn attach_console() -> bool {
        // SAFETY: no pointers; fails harmlessly without a parent console.
        unsafe { AttachConsole(ATTACH_PARENT_PROCESS) != 0 }
    }

    /// An app started by the updater waits (up to 30 seconds) for the
    /// version it replaces to quit, so it does not hand itself to that
    /// instance as a second window would.
    pub fn wait_for_replaced_app() {
        let Some(pid) = std::env::var(WAIT_FOR_PID)
            .ok()
            .and_then(|pid| pid.trim().parse::<u32>().ok())
        else {
            return;
        };
        std::env::remove_var(WAIT_FOR_PID);
        // SAFETY: a handle opened here and closed below.
        unsafe {
            let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if !process.is_null() {
                WaitForSingleObject(process, 30_000);
                CloseHandle(process);
            }
        }
    }

    /// A job that ends every process in it when this process ends, however
    /// it ends (Task Scheduler's End terminates it outright). A process the
    /// core starts to outlive it (Codex's app server, a spawned agent's
    /// host: `relay::detach`) asks to break away, which the job allows, so
    /// an update or restart of the core leaves that work running.
    fn kill_on_close_job() -> Option<HANDLE> {
        // SAFETY: plain Win32 calls on a job created here.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            let set = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set == 0 {
                CloseHandle(job);
                return None;
            }
            Some(job)
        }
    }

    /// Runs the core and waits for it, ending with its exit code. With a
    /// terminal's console, the core writes there and Ctrl+C reaches it
    /// (this process ignores it and waits for the core to stop); without
    /// one (the logon task), the core opens no console window.
    pub fn run_and_wait(mut command: Command, console: bool) -> io::Result<ExitCode> {
        if !console {
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let job = kill_on_close_job();
        let mut child = command.spawn()?;
        if console {
            // Only after the core started: a child inherits this process's
            // Ctrl+C setting, and the core must still see Ctrl+C to stop.
            // SAFETY: ignores Ctrl+C in this process only.
            unsafe { SetConsoleCtrlHandler(None, 1) };
        }
        if let Some(job) = job {
            // SAFETY: both handles are open; the job stays open (and the core
            // in it) until this process ends.
            unsafe { AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) };
        }
        let status = child.wait()?;
        Ok(match status.code() {
            Some(0) => ExitCode::SUCCESS,
            Some(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
            None => ExitCode::FAILURE,
        })
    }
}
