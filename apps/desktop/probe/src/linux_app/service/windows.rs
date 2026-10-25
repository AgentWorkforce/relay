//! The background service on Windows: a per-user Task Scheduler task,
//! [`TASK`], that runs `agent-relay-desktop.exe --headless` when this person logs
//! in. `schtasks.exe` creates and changes a task for the signed-in user
//! without administrator rights.
//!
//! The task is defined from XML ([`task_xml`]) rather than `schtasks /SC
//! ONLOGON` flags, which would stop the core after 72 hours and on battery.
//! Its state is read in two ways that do not depend on the display
//! language: the definition (`/Query /XML`) says whether the task exists and
//! is enabled; the verbose listing's Last Result (`/FO CSV /V`) is
//! `267009` (`SCHED_S_TASK_RUNNING`) while it runs.
//!
//! A per-user install registers the task, turned off, the first time it
//! runs ([`ensure`]), as the Linux per-user install writes its systemd unit;
//! the person turns it on in Settings.

use super::{wording, ServiceStart, ServiceState, UserService};
use crate::linux_app::updates::{self, CommandOutput};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The task's base name. Task names are machine-wide, so each account's
/// task is [`name`], in the Task Scheduler library's root folder.
pub const TASK: &str = "Agent Relay";

/// This account's task name: `Agent Relay (alice)` for `PC\alice`. One task
/// per account, so two people sharing a PC never control each other's.
/// Without a user name (no `USERNAME`), the base name alone.
pub fn name(user: Option<&str>) -> String {
    match user
        .and_then(|user| user.rsplit('\\').next())
        .filter(|account| !account.is_empty())
    {
        Some(account) => format!("{TASK} ({account})"),
        None => TASK.to_owned(),
    }
}
/// `SCHED_S_TASK_RUNNING`, a running task's Last Result.
const RUNNING_RESULT: &str = "267009";
const TIMEOUT: Duration = Duration::from_secs(15);

/// Runs one `schtasks` command.
pub type Call<'a> = &'a dyn Fn(&[&str]) -> io::Result<CommandOutput>;

/// What the task's definition says.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Definition {
    pub enabled: bool,
    /// The program its action runs.
    pub command: Option<String>,
    pub arguments: Option<String>,
}

/// The text between `<tag>` and `</tag>`, the first time `tag` appears
/// after `from`.
fn element<'a>(xml: &'a str, tag: &str, from: usize) -> Option<(&'a str, usize)> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.get(from..)?.find(&open)? + from + open.len();
    let end = xml.get(start..)?.find(&close)? + start;
    Some((&xml[start..end], end + close.len()))
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The definition `schtasks /Query /XML` printed. A task is enabled unless
/// its `<Settings>` say otherwise; triggers' own `<Enabled>` are not the
/// task's.
pub fn parse_task_xml(text: &str) -> Definition {
    // `updates::run` decodes UTF-16 output; NULs left by any other reader
    // of the pipe are dropped here as well.
    let xml: String = text.chars().filter(|c| *c != '\0').collect();
    let settings = element(&xml, "Settings", 0).map(|(settings, _)| settings);
    let enabled = settings
        .and_then(|settings| element(settings, "Enabled", 0))
        .map(|(value, _)| value.trim() != "false")
        .unwrap_or(true);
    let exec = element(&xml, "Exec", 0).map(|(exec, _)| exec);
    let field = |tag: &str| {
        exec.and_then(|exec| element(exec, tag, 0))
            .map(|(value, _)| unescape(value.trim()).trim_matches('"').to_owned())
            .filter(|value| !value.is_empty())
    };
    Definition {
        enabled,
        command: field("Command"),
        arguments: field("Arguments"),
    }
}

/// The first `count` fields of a CSV line, quotes removed. Later fields are
/// not read: `schtasks` does not escape quotes inside Task To Run.
fn csv_fields(line: &str, count: usize) -> Vec<String> {
    let mut fields = Vec::new();
    let mut rest = line.trim_start_matches('\u{feff}');
    while fields.len() < count && !rest.is_empty() {
        if let Some(quoted) = rest.strip_prefix('"') {
            let end = quoted
                .find("\",")
                .unwrap_or_else(|| quoted.strip_suffix('"').map_or(quoted.len(), str::len));
            fields.push(quoted[..end].to_owned());
            rest = quoted.get(end + 2..).unwrap_or("");
        } else {
            let end = rest.find(',').unwrap_or(rest.len());
            fields.push(rest[..end].to_owned());
            rest = rest.get(end + 1..).unwrap_or("");
        }
    }
    fields
}

/// Whether `schtasks /Query /FO CSV /V /NH` shows the task running: its
/// Last Result is `SCHED_S_TASK_RUNNING`, or its Status reads Running.
pub fn parse_running(text: &str) -> bool {
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .any(|line| {
            let fields = csv_fields(line.trim(), 7);
            fields
                .get(6)
                .is_some_and(|result| result.trim() == RUNNING_RESULT)
                || fields
                    .get(3)
                    .is_some_and(|status| status.trim().eq_ignore_ascii_case("Running"))
        })
}

/// The task: at `user`'s logon, run `exe --headless` with no time limit,
/// on battery too, restarting after a failure, one instance at a time.
pub fn task_xml(exe: &Path, user: &str, enabled: bool) -> String {
    let user = escape(user);
    let exe = escape(&exe.display().to_string());
    let directory = exe
        .rsplit_once('\\')
        .map(|(directory, _)| directory.to_owned())
        .unwrap_or_default();
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Agent Relay</Author>
    <Description>Keeps your agents connected and uploads running while Agent Relay is closed, and starts at login.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>{enabled}</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"{exe}"</Command>
      <Arguments>--headless</Arguments>
      <WorkingDirectory>{directory}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"#
    )
}

/// `DOMAIN\user` for the signed-in person, from the environment.
pub fn current_user(env: &dyn Fn(&str) -> Option<std::ffi::OsString>) -> Option<String> {
    let name = env("USERNAME")?.to_string_lossy().into_owned();
    if name.is_empty() {
        return None;
    }
    Some(
        match env("USERDOMAIN").map(|d| d.to_string_lossy().into_owned()) {
            Some(domain) if !domain.is_empty() => format!(r"{domain}\{name}"),
            _ => name,
        },
    )
}

/// The task's definition; `None` when it does not exist.
pub fn query(run: Call<'_>, task: &str) -> io::Result<Option<Definition>> {
    let shown = run(&["schtasks", "/Query", "/TN", task, "/XML"])?;
    Ok((shown.code == Some(0)).then(|| parse_task_xml(&shown.stdout)))
}

/// Whether the task is running now.
pub fn running(run: Call<'_>, task: &str) -> io::Result<bool> {
    let listed = run(&["schtasks", "/Query", "/TN", task, "/FO", "CSV", "/V", "/NH"])?;
    Ok(listed.code == Some(0) && parse_running(&listed.stdout))
}

/// The failure as a sentence: what `schtasks` said, else `fallback`.
fn report(done: io::Result<CommandOutput>, fallback: &str) -> Result<(), String> {
    let done = done.map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => "Task Scheduler is not available on this computer.".to_string(),
        _ => fallback.to_string(),
    })?;
    if done.code == Some(0) {
        return Ok(());
    }
    let detail = if done.stderr.trim().is_empty() {
        done.stdout.trim()
    } else {
        done.stderr.trim()
    };
    let detail = detail.strip_prefix("ERROR:").unwrap_or(detail).trim();
    Err(if detail.is_empty() {
        fallback.to_string()
    } else {
        detail.to_string()
    })
}

/// Defines (or redefines) the task to run `exe`, on or off.
pub fn register(
    run: Call<'_>,
    task: &str,
    exe: &Path,
    user: &str,
    enabled: bool,
) -> Result<(), String> {
    let fallback = wording::ENABLE_FAILED;
    // `schtasks /XML` reads UTF-16 with its byte-order mark.
    let mut file = tempfile::Builder::new()
        .prefix("agent-relay-task-")
        .suffix(".xml")
        .tempfile()
        .map_err(|_| fallback.to_string())?;
    let mut data = vec![0xff, 0xfe];
    for unit in task_xml(exe, user, enabled).encode_utf16() {
        data.extend_from_slice(&unit.to_le_bytes());
    }
    file.write_all(&data)
        .and_then(|_| file.flush())
        .map_err(|_| fallback.to_string())?;
    // Closed before `schtasks` opens it: a file this process still holds
    // open is one Windows refuses it ("being used by another process").
    // The path is removed when it goes out of scope.
    let path = file.into_temp_path();
    let path_text = path.to_string_lossy().into_owned();
    report(
        run(&[
            "schtasks",
            "/Create",
            "/TN",
            task,
            "/XML",
            path_text.as_str(),
            "/F",
        ]),
        fallback,
    )
}

/// Points an existing task at `exe`, keeping whether it is on; registers it
/// turned off when it is missing. True when the definition changed.
pub fn ensure(run: Call<'_>, task: &str, exe: &Path, user: &str) -> Result<bool, String> {
    let definition = query(run, task).map_err(|_| wording::ENABLE_FAILED.to_string())?;
    let target = exe.display().to_string();
    match definition {
        Some(definition)
            if definition
                .command
                .as_deref()
                .is_some_and(|command| command.eq_ignore_ascii_case(&target))
                && definition.arguments.as_deref() == Some("--headless") =>
        {
            Ok(false)
        }
        Some(definition) => register(run, task, exe, user, definition.enabled).map(|_| true),
        None => register(run, task, exe, user, false).map(|_| true),
    }
}

/// `agent-relay-desktop.exe --headless` at logon, through `schtasks`.
pub struct LogonTask {
    runner: Box<super::Runner>,
    task: String,
    /// The app the task runs, when it must be defined anew.
    exe: Option<PathBuf>,
    user: Option<String>,
}

impl Default for LogonTask {
    fn default() -> LogonTask {
        let user = current_user(&|name| std::env::var_os(name));
        LogonTask::new(
            Box::new(|argv| updates::run(argv, TIMEOUT)),
            &name(user.as_deref()),
            crate::linux_app::install::current_exe().ok(),
            user,
        )
    }
}

impl LogonTask {
    pub fn new(
        runner: Box<super::Runner>,
        task: &str,
        exe: Option<PathBuf>,
        user: Option<String>,
    ) -> LogonTask {
        LogonTask {
            runner,
            task: task.to_string(),
            exe,
            user,
        }
    }

    fn call(&self) -> impl Fn(&[&str]) -> io::Result<CommandOutput> + '_ {
        move |argv| (self.runner)(argv)
    }

    fn schtasks(&self, arguments: &[&str]) -> io::Result<CommandOutput> {
        let mut argv = vec!["schtasks"];
        argv.extend_from_slice(arguments);
        (self.runner)(&argv)
    }

    /// The task's state; an error only when `schtasks` did not answer.
    fn read_state(&self) -> io::Result<ServiceState> {
        let call = self.call();
        let Some(definition) = query(&call, &self.task)? else {
            return Ok(ServiceState::default());
        };
        Ok(ServiceState {
            installed: true,
            enabled: definition.enabled,
            active: running(&call, &self.task)?,
        })
    }
}

impl UserService for LogonTask {
    fn state(&self) -> ServiceState {
        self.read_state().unwrap_or_default()
    }

    fn start(&self) -> ServiceStart {
        let state = match self.read_state() {
            Ok(state) => state,
            Err(error) if error.kind() == io::ErrorKind::TimedOut => {
                return ServiceStart::Unconfirmed
            }
            Err(_) => return ServiceStart::NotEnabled,
        };
        if !state.installed || !state.enabled {
            return ServiceStart::NotEnabled;
        }
        if state.active {
            return ServiceStart::Started;
        }
        // `/Run` only asks Task Scheduler to start it; a refusal is no proof
        // that it will not.
        match self.schtasks(&["/Run", "/TN", &self.task]) {
            Ok(started) if started.code == Some(0) => ServiceStart::Started,
            _ => ServiceStart::Unconfirmed,
        }
    }

    fn enable(&self) -> Result<(), String> {
        let call = self.call();
        let exists = query(&call, &self.task)
            .map_err(|error| match error.kind() {
                io::ErrorKind::NotFound => {
                    "Task Scheduler is not available on this computer.".to_string()
                }
                _ => wording::ENABLE_FAILED.to_string(),
            })?
            .is_some();
        if exists {
            report(
                self.schtasks(&["/Change", "/TN", &self.task, "/ENABLE"]),
                wording::ENABLE_FAILED,
            )?;
        } else {
            let (Some(exe), Some(user)) = (&self.exe, &self.user) else {
                return Err(wording::ENABLE_FAILED.to_string());
            };
            register(&call, &self.task, exe, user, true)?;
        }
        report(
            self.schtasks(&["/Run", "/TN", &self.task]),
            wording::ENABLE_FAILED,
        )
    }

    fn stop(&self) -> Result<(), String> {
        report(
            self.schtasks(&["/End", "/TN", &self.task]),
            "Task Scheduler could not stop the service.",
        )
    }

    fn disable(&self) -> Result<(), String> {
        report(
            self.schtasks(&["/Change", "/TN", &self.task, "/DISABLE"]),
            wording::DISABLE_FAILED,
        )?;
        let call = self.call();
        if running(&call, &self.task).unwrap_or(true) {
            report(
                self.schtasks(&["/End", "/TN", &self.task]),
                wording::DISABLE_FAILED,
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const XML_ON: &str = "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\r\r\n<Task version=\"1.2\">\r\r\n<Triggers><LogonTrigger><Enabled>false</Enabled></LogonTrigger></Triggers>\r\r\n<Settings><Enabled>true</Enabled></Settings>\r\r\n<Actions Context=\"Author\"><Exec><Command>\"C:\\Users\\a\\AppData\\Local\\Programs\\AgentRelay\\1.0.0\\AgentRelay-Windows-arm64\\bin\\agent-relay-desktop.exe\"</Command><Arguments>--headless</Arguments></Exec></Actions></Task>";
    const EXE: &str = r"C:\Users\a\AppData\Local\Programs\AgentRelay\1.0.0\AgentRelay-Windows-arm64\bin\agent-relay-desktop.exe";
    const RUNNING: &str = "\"PC\",\"\\Agent Relay\",\"N/A\",\"Running\",\"Interactive only\",\"10/20/2026 9:00:00 AM\",\"267009\",\"Agent Relay\",\"\"C:\\x\\agent-relay-desktop.exe\" --headless\",\"N/A\"\r\n";
    // A German listing: the status is translated, the result is not.
    const RUNNING_GERMAN: &str = "\"PC\",\"\\Agent Relay\",\"Nicht zutreffend\",\"Wird ausgeführt\",\"Nur interaktiv\",\"20.10.2026 09:00:00\",\"267009\",\"Agent Relay\"\r\n";
    const READY: &str = "\"PC\",\"\\Agent Relay\",\"N/A\",\"Ready\",\"Interactive only\",\"11/30/1999 12:00:00 AM\",\"267011\",\"Agent Relay\"\r\n";

    type Calls = Arc<Mutex<Vec<Vec<String>>>>;

    /// A `schtasks` answering each subcommand (`/Query` with `/XML` or
    /// `/FO`) from `answers` (exit code, stdout), and every command it ran.
    fn task(answers: &[(&str, i32, &str)]) -> (LogonTask, Calls) {
        let calls: Calls = Arc::default();
        let answers: Vec<(String, i32, String)> = answers
            .iter()
            .map(|(command, code, out)| (command.to_string(), *code, out.to_string()))
            .collect();
        let seen = calls.clone();
        let runner = move |argv: &[&str]| {
            seen.lock()
                .unwrap()
                .push(argv.iter().map(|a| a.to_string()).collect());
            let key = match argv[1] {
                "/Query" => argv[4],
                other => other,
            };
            let (code, stdout) = answers
                .iter()
                .find(|(command, _, _)| command == key)
                .map(|(_, code, out)| (*code, out.clone()))
                .unwrap_or((0, String::new()));
            Ok(CommandOutput {
                code: Some(code),
                stdout,
                stderr: String::new(),
            })
        };
        (
            LogonTask::new(
                Box::new(runner),
                TASK,
                Some(PathBuf::from(EXE)),
                Some(r"PC\a".into()),
            ),
            calls,
        )
    }

    fn ran(calls: &Calls, command: &[&str]) -> bool {
        calls.lock().unwrap().iter().any(|call| call == command)
    }

    #[test]
    fn each_account_has_a_task_of_its_own() {
        assert_eq!(name(Some(r"PC\alice")), "Agent Relay (alice)");
        assert_eq!(name(Some("alice")), "Agent Relay (alice)");
        assert_eq!(name(Some(r"PC\")), "Agent Relay");
        assert_eq!(name(None), "Agent Relay");
    }

    #[test]
    fn the_definition_says_whether_the_task_is_on_and_what_it_runs() {
        let definition = parse_task_xml(XML_ON);
        assert!(definition.enabled, "a trigger's Enabled is not the task's");
        assert_eq!(definition.command.as_deref(), Some(EXE));
        assert_eq!(definition.arguments.as_deref(), Some("--headless"));
        let off = XML_ON.replace(
            "<Settings><Enabled>true</Enabled>",
            "<Settings><Enabled>false</Enabled>",
        );
        assert!(!parse_task_xml(&off).enabled);
        let utf16: String = XML_ON.chars().flat_map(|c| [c, '\0']).collect();
        assert_eq!(parse_task_xml(&utf16), definition);
        assert!(parse_task_xml("<Task><Settings></Settings></Task>").enabled);
    }

    #[test]
    fn running_is_read_from_the_last_result_in_any_language() {
        assert!(parse_running(RUNNING));
        assert!(parse_running(RUNNING_GERMAN));
        assert!(!parse_running(READY));
        assert!(!parse_running(""));
        assert_eq!(
            csv_fields("\"a\",\"b,c\",d,\"e\"", 4),
            ["a", "b,c", "d", "e"]
        );
    }

    #[test]
    fn the_task_runs_the_app_headless_at_this_users_logon_without_limits() {
        let xml = task_xml(
            Path::new(r"C:\Users\a&b\bin\agent-relay-desktop.exe"),
            r"PC\a&b",
            false,
        );
        assert!(xml.contains("<UserId>PC\\a&amp;b</UserId>"));
        assert!(
            xml.contains("<Command>\"C:\\Users\\a&amp;b\\bin\\agent-relay-desktop.exe\"</Command>")
        );
        assert!(xml.contains("<Arguments>--headless</Arguments>"));
        assert!(xml.contains("<WorkingDirectory>C:\\Users\\a&amp;b\\bin</WorkingDirectory>"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(xml.contains("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"));
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        let parsed = parse_task_xml(&xml);
        assert!(!parsed.enabled);
        assert_eq!(
            parsed.command.as_deref(),
            Some(r"C:\Users\a&b\bin\agent-relay-desktop.exe")
        );
        assert_eq!(
            current_user(&|name| match name {
                "USERNAME" => Some("a".into()),
                "USERDOMAIN" => Some("PC".into()),
                _ => None,
            }),
            Some(r"PC\a".into())
        );
    }

    #[test]
    fn state_reads_the_definition_and_the_listing() {
        let (service, _) = task(&[("/XML", 0, XML_ON), ("/FO", 0, RUNNING)]);
        let state = service.state();
        assert!(state.installed && state.enabled && state.active);
        assert_eq!(state.label(), "Running · starts at login");
        assert_eq!(service.start(), ServiceStart::Started);

        let (ready, calls) = task(&[("/XML", 0, XML_ON), ("/FO", 0, READY)]);
        assert_eq!(ready.state().label(), "Stopped · starts at login");
        assert_eq!(ready.start(), ServiceStart::Started);
        assert!(ran(&calls, &["schtasks", "/Run", "/TN", TASK]));

        // A task nobody turned on is never started by opening the app: its
        // headless mode applies the agent-led defaults.
        let off = XML_ON.replace(
            "<Settings><Enabled>true</Enabled>",
            "<Settings><Enabled>false</Enabled>",
        );
        let (disabled, calls) = task(&[("/XML", 0, &off), ("/FO", 0, READY)]);
        assert_eq!(disabled.state().label(), "Off");
        assert_eq!(disabled.start(), ServiceStart::NotEnabled);
        assert!(!ran(&calls, &["schtasks", "/Run", "/TN", TASK]));

        let (missing, _) = task(&[("/XML", 1, "")]);
        assert_eq!(missing.state(), ServiceState::default());
        assert_eq!(missing.state().label(), "Not installed");
        assert_eq!(missing.start(), ServiceStart::NotEnabled);
    }

    #[test]
    fn a_start_task_scheduler_refuses_is_unconfirmed() {
        let (refused, _) = task(&[("/XML", 0, XML_ON), ("/FO", 0, READY), ("/Run", 1, "")]);
        assert_eq!(refused.start(), ServiceStart::Unconfirmed);
        let slow = LogonTask::new(
            Box::new(|_: &[&str]| Err(io::Error::from(io::ErrorKind::TimedOut))),
            TASK,
            None,
            None,
        );
        assert_eq!(slow.start(), ServiceStart::Unconfirmed);
    }

    #[test]
    fn enable_turns_the_task_on_and_starts_it_and_disable_stops_it() {
        let (service, calls) = task(&[("/XML", 0, XML_ON), ("/FO", 0, RUNNING)]);
        assert_eq!(service.enable(), Ok(()));
        assert!(ran(
            &calls,
            &["schtasks", "/Change", "/TN", TASK, "/ENABLE"]
        ));
        assert!(ran(&calls, &["schtasks", "/Run", "/TN", TASK]));
        assert_eq!(service.disable(), Ok(()));
        assert!(ran(
            &calls,
            &["schtasks", "/Change", "/TN", TASK, "/DISABLE"]
        ));
        assert!(ran(&calls, &["schtasks", "/End", "/TN", TASK]));

        // A missing task is defined from XML, turned on.
        let (missing, calls) = task(&[("/XML", 1, "")]);
        assert_eq!(missing.enable(), Ok(()));
        assert!(calls.lock().unwrap().iter().any(|call| call[1] == "/Create"
            && call[3] == TASK
            && call[4] == "/XML"
            && call[6] == "/F"));

        let (failing, _) = task(&[("/XML", 0, XML_ON), ("/Change", 1, "")]);
        assert_eq!(failing.enable(), Err(wording::ENABLE_FAILED.into()));
        assert_eq!(failing.disable(), Err(wording::DISABLE_FAILED.into()));
        let (said, _) = task(&[("/End", 1, "ERROR: The task is not running.")]);
        assert_eq!(said.stop(), Err("The task is not running.".into()));
    }

    #[test]
    fn without_schtasks_nothing_is_installed() {
        let service = LogonTask::new(
            Box::new(|_: &[&str]| Err(io::Error::from(io::ErrorKind::NotFound))),
            TASK,
            None,
            None,
        );
        assert_eq!(service.state(), ServiceState::default());
        assert_eq!(service.start(), ServiceStart::NotEnabled);
        assert_eq!(
            service.enable(),
            Err("Task Scheduler is not available on this computer.".into())
        );
    }

    #[test]
    fn ensure_registers_a_missing_task_off_and_repoints_a_moved_one() {
        let calls: Calls = Arc::default();
        let answer = |xml: Option<&'static str>| {
            let seen = calls.clone();
            move |argv: &[&str]| -> io::Result<CommandOutput> {
                seen.lock()
                    .unwrap()
                    .push(argv.iter().map(|a| a.to_string()).collect());
                if argv[1] == "/Create" {
                    // The file is UTF-16 with its mark, as schtasks reads it.
                    let data = std::fs::read(argv[5]).unwrap();
                    assert_eq!(&data[..2], &[0xff, 0xfe]);
                }
                Ok(CommandOutput {
                    code: Some(if argv[1] == "/Query" && xml.is_none() {
                        1
                    } else {
                        0
                    }),
                    stdout: xml.unwrap_or_default().to_string(),
                    stderr: String::new(),
                })
            }
        };
        let current = answer(Some(XML_ON));
        assert_eq!(ensure(&current, TASK, Path::new(EXE), r"PC\a"), Ok(false));
        let moved = answer(Some(XML_ON));
        assert_eq!(
            ensure(
                &moved,
                TASK,
                Path::new(r"C:\elsewhere\agent-relay-desktop.exe"),
                r"PC\a"
            ),
            Ok(true)
        );
        let missing = answer(None);
        assert_eq!(ensure(&missing, TASK, Path::new(EXE), r"PC\a"), Ok(true));
        let creates = calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call[1] == "/Create")
            .count();
        assert_eq!(creates, 2);
    }

    /// `schtasks` opens the definition itself, so the file must be closed
    /// (and complete) by the time it runs; it is gone afterwards.
    #[test]
    fn the_definition_file_is_closed_before_schtasks_reads_it_and_removed_after() {
        use std::os::windows::fs::OpenOptionsExt;
        let seen: Arc<Mutex<Option<(PathBuf, Vec<u8>)>>> = Arc::default();
        let read = seen.clone();
        let run = move |argv: &[&str]| {
            assert_eq!(&argv[..2], ["schtasks", "/Create"]);
            let path = PathBuf::from(argv[5]);
            // Exclusive, as Windows refuses a file another handle holds.
            let data = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&path)
                .and_then(|mut file| {
                    let mut data = Vec::new();
                    std::io::Read::read_to_end(&mut file, &mut data).map(|_| data)
                })
                .expect("schtasks can open the definition on its own");
            *read.lock().unwrap() = Some((path, data));
            Ok(CommandOutput {
                code: Some(0),
                stdout: String::new(),
                stderr: String::new(),
            })
        };
        register(&run, TASK, Path::new(EXE), r"PC\a", false).unwrap();
        let (path, data) = seen.lock().unwrap().take().unwrap();
        assert_eq!(&data[..2], [0xff, 0xfe]);
        let units: Vec<u16> = data[2..]
            .chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        assert_eq!(
            String::from_utf16(&units).unwrap(),
            task_xml(Path::new(EXE), r"PC\a", false)
        );
        assert!(!path.exists(), "the definition file is removed afterwards");
    }
}
