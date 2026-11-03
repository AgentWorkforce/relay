//! Launch at login on Linux: the XDG autostart entry
//! `$XDG_CONFIG_HOME/autostart/agent-relay.desktop` (default
//! `~/.config/autostart/…`), which starts the app with `--background`.
//!
//! On Windows it is the value `AgentRelay` under
//! `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run`,
//! `"<app exe>" --background`, which needs no administrator (see `windows`).
//!
//! On macOS launch at login is `SMAppService`, a platform API the app owns,
//! so `login_item.set` is refused there.

use crate::install;
use crate::relay::protocol::{ErrorKind, RpcError};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const ENTRY_FILE: &str = "agent-relay.desktop";
/// The Linux app's name; `agent-relay` is the npm CLI's.
#[cfg_attr(windows, allow(dead_code))]
const LAUNCHER: &str = "agent-relay-desktop";
/// Launchers an entry this module wrote may run: the app, and the
/// `agent-relay` name releases up to v2026.10.57 installed it under.
#[cfg_attr(windows, allow(dead_code))]
const OWNED_LAUNCHERS: [&str; 2] = [LAUNCHER, "agent-relay"];

/// Windows: the environment variable naming another Run value than the
/// app's, so tests never touch the person's own login item.
pub const RUN_VALUE_ENV: &str = "AGENT_RELAY_LOGIN_RUN_VALUE";

/// The autostart entry's path.
pub fn entry_path(home: &Path, env: &BTreeMap<String, String>) -> PathBuf {
    env.get("XDG_CONFIG_HOME")
        .map(|value| value.trim())
        .filter(|value| Path::new(value).is_absolute())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"))
        .join("autostart")
        .join(ENTRY_FILE)
}

/// Whether the app starts at login: an entry exists and is not hidden (on
/// Windows: the Run value is set).
pub fn enabled(home: &Path, env: &BTreeMap<String, String>) -> bool {
    #[cfg(windows)]
    {
        let _ = home;
        windows::enabled(env)
    }
    #[cfg(not(windows))]
    {
        autostart_enabled(home, env)
    }
}

/// Whether the XDG autostart entry exists and is not hidden.
#[cfg_attr(windows, allow(dead_code))]
fn autostart_enabled(home: &Path, env: &BTreeMap<String, String>) -> bool {
    std::fs::read(entry_path(home, env))
        .map(|bytes| !String::from_utf8_lossy(&bytes).contains("Hidden=true"))
        .unwrap_or(false)
}

/// The bridge method `login_item.status`: whether the app starts at login.
pub fn status(home: &Path, env: &BTreeMap<String, String>) -> Result<bool, RpcError> {
    if cfg!(target_os = "macos") {
        return Err(RpcError::new(
            ErrorKind::Refused,
            "Launch at login is managed by the macOS app.",
        ));
    }
    Ok(enabled(home, env))
}

/// The bridge method `login_item.set`.
pub fn set(home: &Path, env: &BTreeMap<String, String>, enabled: bool) -> Result<(), RpcError> {
    if cfg!(target_os = "macos") {
        return Err(RpcError::new(
            ErrorKind::Refused,
            "Launch at login is managed by the macOS app.",
        ));
    }
    let launcher = if enabled {
        resolve_launcher(env, std::env::current_exe().ok().as_deref())
    } else {
        PathBuf::new()
    };
    #[cfg(windows)]
    let applied = {
        let _ = home;
        windows::apply(env, enabled, &launcher)
    };
    #[cfg(not(windows))]
    let applied = apply(home, env, enabled, &launcher);
    applied.map_err(|_| RpcError::new(ErrorKind::Internal, "Launch at login could not be changed."))
}

/// Writes or removes the entry. Removing a missing entry succeeds.
#[cfg_attr(windows, allow(dead_code))]
fn apply(
    home: &Path,
    env: &BTreeMap<String, String>,
    enabled: bool,
    launcher: &Path,
) -> std::io::Result<()> {
    let path = entry_path(home, env);
    if !enabled {
        return match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        };
    }
    let exec = exec_line(launcher);
    std::fs::create_dir_all(path.parent().expect("autostart directory"))?;
    std::fs::write(
        &path,
        format!(
            "[Desktop Entry]\nType=Application\nName=Agent Relay\n\
             Comment=Upload coding sessions to Agent Relay\n{exec}\n\
             Icon=agent-relay\nTerminal=false\nStartupNotify=false\nX-GNOME-Autostart-enabled=true\n"
        ),
    )
}

/// The entry's `Exec=` line: `launcher`, quoted when it has whitespace, with
/// `--background`.
#[cfg_attr(windows, allow(dead_code))]
fn exec_line(launcher: &Path) -> String {
    let mut launch = launcher.display().to_string();
    if launch.chars().any(char::is_whitespace) {
        launch = format!("\"{}\"", launch.replace('\\', "\\\\").replace('"', "\\\""));
    }
    format!("Exec={launch} --background")
}

/// The desktop's `agent-relay-desktop` app: the one in this probe's install
/// tree (`/usr/bin/agent-relay-desktop` beside
/// `/usr/lib/agent-relay/agent-relay-probe`), else the first executable on
/// `PATH`, else the bare name.
#[cfg(not(windows))]
fn resolve_launcher(env: &BTreeMap<String, String>, probe: Option<&Path>) -> PathBuf {
    let on_path = env.get("PATH").into_iter().flat_map(|path| {
        std::env::split_paths(path)
            .filter(|dir| dir.is_absolute())
            .map(|dir| dir.join(LAUNCHER))
            .collect::<Vec<_>>()
    });
    let packaged = probe
        .and_then(install::probe_tree)
        .map(|tree| tree.join(install::APP));
    packaged
        .into_iter()
        .chain(on_path)
        .find(|candidate| is_executable(candidate))
        .unwrap_or_else(|| PathBuf::from(LAUNCHER))
}

/// The Windows app, `agent-relay.exe`: the one in this probe's install tree
/// (`<tree>\bin\agent-relay.exe` beside `<tree>\bin\agent-relay-probe.exe`),
/// else the one beside the probe (a development build), else the first on
/// `PATH`, else the bare name. Only an `.exe` is taken: the npm
/// `agent-relay.cmd` CLI has the same name and does not take `--background`.
#[cfg(windows)]
fn resolve_launcher(env: &BTreeMap<String, String>, probe: Option<&Path>) -> PathBuf {
    const EXE: &str = "agent-relay.exe";
    let on_path = env.get("PATH").into_iter().flat_map(|path| {
        std::env::split_paths(path)
            .filter(|dir| dir.is_absolute())
            .map(|dir| dir.join(EXE))
            .collect::<Vec<_>>()
    });
    let packaged = probe
        .and_then(install::probe_tree)
        .map(|tree| tree.join(install::APP));
    let beside = probe.and_then(Path::parent).map(|dir| dir.join(EXE));
    packaged
        .into_iter()
        .chain(beside)
        .chain(on_path)
        .find(|candidate| is_executable(candidate))
        .unwrap_or_else(|| PathBuf::from(EXE))
}

fn is_executable(path: &Path) -> bool {
    crate::platform::exe::is_executable(path)
}

/// An app-owned launch-at-login entry follows `launcher`, the running or
/// newly installed app, so the next sign-in starts it: after an update, and
/// on Linux after a package upgrade moved the app. An entry that is off or
/// someone else's is left alone. True when it moved.
pub fn follow_update(
    home: &Path,
    env: &BTreeMap<String, String>,
    launcher: &Path,
) -> std::io::Result<bool> {
    #[cfg(windows)]
    {
        let _ = home;
        windows::follow(env, launcher)
    }
    #[cfg(not(windows))]
    {
        follow_autostart_entry(home, env, launcher)
    }
}

/// `follow_update` for `launcher` when it runs from an install (the system
/// package or a per-user one); a source build never takes the entry over.
#[cfg(not(windows))]
pub fn follow_installed_app(
    home: &Path,
    env: &dyn Fn(&str) -> Option<std::ffi::OsString>,
    launcher: &Path,
) -> std::io::Result<bool> {
    if install::install_kind(launcher) == install::InstallKind::Source {
        return Ok(false);
    }
    let env = env("XDG_CONFIG_HOME")
        .map(|value| {
            (
                "XDG_CONFIG_HOME".to_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .into_iter()
        .collect();
    follow_autostart_entry(home, &env, launcher)
}

/// `follow_update` for the XDG entry.
#[cfg_attr(windows, allow(dead_code))]
fn follow_autostart_entry(
    home: &Path,
    env: &BTreeMap<String, String>,
    launcher: &Path,
) -> std::io::Result<bool> {
    let Some((text, program)) = owned_autostart_entry(home, env)? else {
        return Ok(false);
    };
    if text.contains("Hidden=true") || Path::new(&program) == launcher {
        return Ok(false);
    }
    // Only the command changes: the rest of the entry, such as a desktop's
    // `X-GNOME-Autostart-enabled=false`, is the person's choice and stays.
    let exec = exec_line(launcher);
    let mut moved = text
        .lines()
        .map(|line| {
            if line.trim_start().starts_with("Exec=") {
                exec.as_str()
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    moved.push('\n');
    std::fs::write(entry_path(home, env), moved)?;
    Ok(true)
}

/// Removes an app-owned GUI startup entry during explicit cleanup.
/// Starting the headless service must never call this: the GUI and uploads
/// share the person's Open at login choice. Foreign entries are preserved.
pub fn remove_gui_autostart(home: &Path, env: &BTreeMap<String, String>) -> std::io::Result<bool> {
    #[cfg(windows)]
    {
        let _ = home;
        windows::remove_owned(env)
    }
    #[cfg(not(windows))]
    {
        remove_autostart_entry(home, env)
    }
}

/// `remove_gui_autostart` for the XDG entry.
#[cfg_attr(windows, allow(dead_code))]
fn remove_autostart_entry(home: &Path, env: &BTreeMap<String, String>) -> std::io::Result<bool> {
    if owned_autostart_entry(home, env)?.is_none() {
        return Ok(false);
    }
    std::fs::remove_file(entry_path(home, env))?;
    Ok(true)
}

/// The XDG entry's text and the program it runs, when this module wrote it.
#[cfg_attr(windows, allow(dead_code))]
fn owned_autostart_entry(
    home: &Path,
    env: &BTreeMap<String, String>,
) -> std::io::Result<Option<(String, String)>> {
    let text = match std::fs::read(entry_path(home, env)) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let fields: BTreeMap<&str, &str> = text
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim(), value.trim()))
        .collect();
    let Some(command) = split_command(fields.get("Exec").copied().unwrap_or_default()) else {
        return Ok(None);
    };
    let owned = fields.get("Type") == Some(&"Application")
        && fields.get("Name") == Some(&"Agent Relay")
        && fields.get("Icon") == Some(&"agent-relay")
        && command.first().is_some_and(|program| {
            OWNED_LAUNCHERS
                .iter()
                .any(|name| Path::new(program).file_name() == Some(name.as_ref()))
        })
        && command[1..]
            .iter()
            .any(|argument| argument == "--background");
    let program = command.into_iter().next().unwrap_or_default();
    Ok(owned.then_some((text, program)))
}

/// POSIX shell word splitting (quotes and backslashes, no expansion); `None`
/// for an unterminated quote or escape.
#[cfg_attr(windows, allow(dead_code))]
fn split_command(text: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word: Option<String> = None;
    let mut chars = text.chars();
    while let Some(character) = chars.next() {
        match character {
            c if c.is_whitespace() => words.extend(word.take()),
            '\'' => {
                let current = word.get_or_insert_with(String::new);
                loop {
                    match chars.next()? {
                        '\'' => break,
                        c => current.push(c),
                    }
                }
            }
            '"' => {
                let current = word.get_or_insert_with(String::new);
                loop {
                    match chars.next()? {
                        '"' => break,
                        '\\' => match chars.next()? {
                            c @ ('"' | '\\' | '$' | '`') => current.push(c),
                            '\n' => {}
                            c => {
                                current.push('\\');
                                current.push(c);
                            }
                        },
                        c => current.push(c),
                    }
                }
            }
            '\\' => {
                let next = chars.next()?;
                if next != '\n' {
                    word.get_or_insert_with(String::new).push(next);
                }
            }
            c => word.get_or_insert_with(String::new).push(c),
        }
    }
    words.extend(word);
    Some(words)
}

/// Launch at login on Windows: a string value under the per-user Run key,
/// which Explorer starts at sign-in. Task Manager's Startup apps toggle
/// keeps its own switch (`Explorer\StartupApproved\Run`); a value it turned
/// off still reads as set here.
#[cfg(windows)]
mod windows {
    use super::*;
    use crate::install::windows::{command_program, registry};
    use std::io;

    pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    /// The value's name.
    pub const VALUE: &str = "AgentRelay";
    /// Names another value instead of `VALUE`, so tests never touch the
    /// person's own login item.
    pub const VALUE_OVERRIDE: &str = super::RUN_VALUE_ENV;

    fn value_name(env: &BTreeMap<String, String>) -> &str {
        env.get(VALUE_OVERRIDE)
            .map(String::as_str)
            .filter(|name| !name.is_empty())
            .unwrap_or(VALUE)
    }

    /// The command the Run value holds: `"<launcher>" --background`.
    pub fn command(launcher: &Path) -> String {
        format!("\"{}\" --background", launcher.display())
    }

    /// Whether `command` is one `command` wrote: it runs an
    /// `agent-relay.exe` with `--background`.
    pub fn owned(command: &str) -> bool {
        command_program(command).is_some_and(|program| {
            Path::new(program)
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("agent-relay.exe"))
        }) && command
            .split_whitespace()
            .any(|word| word == "--background")
    }

    pub fn enabled(env: &BTreeMap<String, String>) -> bool {
        registry::read_string(registry::Root::CurrentUser, RUN_KEY, value_name(env))
            .is_some_and(|command| !command.trim().is_empty())
    }

    /// Sets or removes the value. Removing a missing value succeeds.
    pub fn apply(env: &BTreeMap<String, String>, enabled: bool, launcher: &Path) -> io::Result<()> {
        if enabled {
            registry::write_string(RUN_KEY, value_name(env), &command(launcher))
        } else {
            remove(value_name(env))
        }
    }

    /// Points an existing value of this module's at `launcher`, so an
    /// update keeps starting the new version at sign-in. A value that is
    /// off (absent) or someone else's is left alone. True when it moved.
    pub fn follow(env: &BTreeMap<String, String>, launcher: &Path) -> io::Result<bool> {
        let name = value_name(env);
        match registry::read_string(registry::Root::CurrentUser, RUN_KEY, name) {
            Some(current) if owned(&current) && current != command(launcher) => {
                registry::write_string(RUN_KEY, name, &command(launcher)).map(|()| true)
            }
            _ => Ok(false),
        }
    }

    /// Removes the value when it is this module's. True when it was.
    pub fn remove_owned(env: &BTreeMap<String, String>) -> io::Result<bool> {
        let name = value_name(env);
        match registry::read_string(registry::Root::CurrentUser, RUN_KEY, name) {
            Some(command) if owned(&command) => remove(name).map(|()| true),
            _ => Ok(false),
        }
    }

    fn remove(name: &str) -> io::Result<()> {
        use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
        use windows_sys::Win32::System::Registry::{RegDeleteKeyValueW, HKEY_CURRENT_USER};
        let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let (key, name) = (wide(RUN_KEY), wide(name));
        // SAFETY: two NUL-terminated UTF-16 strings alive for the call.
        let status = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) };
        match status {
            ERROR_SUCCESS | ERROR_FILE_NOT_FOUND => Ok(()),
            status => Err(io::Error::from_raw_os_error(status as i32)),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_run_value_quotes_the_app_and_asks_for_the_background() {
            let exe = Path::new(
                r"C:\Users\a\AppData\Local\Programs\AgentRelay\1.0.0\bin\agent-relay.exe",
            );
            let command = command(exe);
            assert_eq!(
                command,
                "\"C:\\Users\\a\\AppData\\Local\\Programs\\AgentRelay\\1.0.0\\bin\\agent-relay.exe\" \
                 --background"
            );
            assert!(owned(&command));
            assert!(!owned(r#""C:\Tools\other.exe" --background"#));
            assert!(!owned(r#""C:\x\agent-relay.exe""#));
        }

        #[test]
        fn the_run_value_round_trips_under_a_test_name() {
            let env = BTreeMap::from([(
                VALUE_OVERRIDE.to_string(),
                format!("AgentRelayTest{}", std::process::id()),
            )]);
            let exe = Path::new(r"C:\Program Files\Agent Relay\bin\agent-relay.exe");
            assert!(!enabled(&env));
            apply(&env, true, exe).unwrap();
            assert!(enabled(&env));
            assert_eq!(
                registry::read_string(registry::Root::CurrentUser, RUN_KEY, value_name(&env)),
                Some(command(exe))
            );
            assert!(remove_owned(&env).unwrap());
            assert!(!enabled(&env));
            assert!(!remove_owned(&env).unwrap());
            apply(&env, false, Path::new("")).unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(config: &Path) -> BTreeMap<String, String> {
        BTreeMap::from([("XDG_CONFIG_HOME".into(), config.display().to_string())])
    }

    #[test]
    fn autostart_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let env = env(&dir.path().join("config"));
        assert!(!autostart_enabled(dir.path(), &env));
        apply(
            dir.path(),
            &env,
            true,
            Path::new("/opt/agent relay/bin/agent-relay-desktop"),
        )
        .unwrap();
        assert!(autostart_enabled(dir.path(), &env));
        let path = entry_path(dir.path(), &env);
        assert_eq!(
            path,
            dir.path().join("config/autostart/agent-relay.desktop")
        );
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("Exec=\"/opt/agent relay/bin/agent-relay-desktop\" --background\n"));
        apply(dir.path(), &env, false, Path::new("")).unwrap();
        assert!(!path.exists());
        apply(dir.path(), &env, false, Path::new("")).unwrap();
    }

    #[test]
    fn config_home_defaults_under_home_and_ignores_relative_values() {
        let home = Path::new("/home/person");
        let relative = BTreeMap::from([("XDG_CONFIG_HOME".to_string(), "config".to_string())]);
        assert_eq!(
            entry_path(home, &relative),
            home.join(".config/autostart/agent-relay.desktop")
        );
    }

    #[test]
    fn hidden_entry_is_not_enabled() {
        let dir = tempfile::tempdir().unwrap();
        let env = env(dir.path());
        let path = entry_path(dir.path(), &env);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "[Desktop Entry]\nHidden=true\n").unwrap();
        assert!(!autostart_enabled(dir.path(), &env));
    }

    #[test]
    #[cfg(unix)]
    fn packaged_autostart_uses_usr_bin_launcher() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let probe = root.join("usr/lib/agent-relay/agent-relay-probe");
        let launcher = root.join("usr/bin/agent-relay-desktop");
        for file in [&probe, &launcher] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, "").unwrap();
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let empty_path =
            BTreeMap::from([("PATH".into(), root.join("empty").display().to_string())]);
        assert_eq!(resolve_launcher(&empty_path, Some(&probe)), launcher);

        let on_path = root.join("bin");
        std::fs::create_dir_all(&on_path).unwrap();
        let first = on_path.join("agent-relay-desktop");
        std::fs::write(&first, "").unwrap();
        std::fs::set_permissions(&first, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = BTreeMap::from([("PATH".into(), on_path.display().to_string())]);
        // The package's launcher wins over another `agent-relay-desktop` on PATH.
        assert_eq!(resolve_launcher(&path, Some(&probe)), launcher);
        assert_eq!(resolve_launcher(&path, None), first);
        assert_eq!(
            resolve_launcher(&BTreeMap::new(), None),
            PathBuf::from("agent-relay-desktop")
        );
        // The npm `agent-relay` CLI on PATH is never taken for the app.
        let cli = root.join("cli");
        std::fs::create_dir_all(&cli).unwrap();
        std::fs::write(cli.join("agent-relay"), "").unwrap();
        std::fs::set_permissions(
            cli.join("agent-relay"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let cli_path = BTreeMap::from([("PATH".into(), cli.display().to_string())]);
        assert_eq!(
            resolve_launcher(&cli_path, None),
            PathBuf::from("agent-relay-desktop")
        );
    }

    #[test]
    #[cfg(unix)]
    fn an_owned_entry_follows_the_app_when_it_moves() {
        let dir = tempfile::tempdir().unwrap();
        let env = env(dir.path());
        let path = entry_path(dir.path(), &env);
        let app = Path::new("/usr/bin/agent-relay-desktop");
        assert!(!follow_update(dir.path(), &env, app).unwrap());
        // An entry an earlier release wrote, naming the app `agent-relay`.
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            "[Desktop Entry]\nType=Application\nName=Agent Relay\n\
             Exec=/usr/bin/agent-relay --background\nIcon=agent-relay\n",
        )
        .unwrap();
        assert!(follow_update(dir.path(), &env, app).unwrap());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("Exec=/usr/bin/agent-relay-desktop --background\n"));
        assert!(!follow_update(dir.path(), &env, app).unwrap());

        // An entry the desktop turned off moves, and stays off.
        let disabled = format!(
            "{}X-GNOME-Autostart-enabled=false\n",
            text.replace("X-GNOME-Autostart-enabled=true\n", "")
                .replace("agent-relay-desktop", "agent-relay")
        );
        std::fs::write(&path, &disabled).unwrap();
        assert!(follow_update(dir.path(), &env, app).unwrap());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            disabled.replace("/usr/bin/agent-relay ", "/usr/bin/agent-relay-desktop ")
        );

        // An entry that is off, or someone else's, stays as it is.
        let hidden = format!("{text}Hidden=true\n");
        std::fs::write(&path, &hidden).unwrap();
        assert!(
            !follow_update(dir.path(), &env, Path::new("/opt/new/agent-relay-desktop")).unwrap()
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), hidden);
        let theirs = "[Desktop Entry]\nType=Application\nName=Agent Relay\n\
                      Exec=/opt/custom-launcher --background\nIcon=agent-relay\n";
        std::fs::write(&path, theirs).unwrap();
        assert!(!follow_update(dir.path(), &env, app).unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), theirs);
    }

    #[test]
    fn headless_cleanup_removes_only_the_owned_background_entry() {
        let dir = tempfile::tempdir().unwrap();
        let env = env(dir.path());
        assert!(!remove_autostart_entry(dir.path(), &env).unwrap());
        apply(
            dir.path(),
            &env,
            true,
            Path::new("/opt/agent relay/bin/agent-relay-desktop"),
        )
        .unwrap();
        assert!(remove_autostart_entry(dir.path(), &env).unwrap());
        let path = entry_path(dir.path(), &env);
        assert!(!path.exists());
        // An entry an earlier release wrote, naming the app `agent-relay`.
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            "[Desktop Entry]\nType=Application\nName=Agent Relay\n\
             Exec=/usr/bin/agent-relay --background\nIcon=agent-relay\n",
        )
        .unwrap();
        assert!(remove_autostart_entry(dir.path(), &env).unwrap());
        assert!(!path.exists());

        std::fs::write(
            &path,
            "[Desktop Entry]\nType=Application\nName=Agent Relay\n\
             Exec=/opt/custom-launcher --background\nIcon=agent-relay\n",
        )
        .unwrap();
        assert!(!remove_autostart_entry(dir.path(), &env).unwrap());
        assert!(path.exists());
        std::fs::write(
            &path,
            "[Desktop Entry]\nType=Application\nName=Agent Relay\n\
             Exec=\"/opt/agent relay/bin/agent-relay --background\nIcon=agent-relay\n",
        )
        .unwrap();
        assert!(!remove_autostart_entry(dir.path(), &env).unwrap());
        assert!(path.exists());
    }

    #[test]
    fn set_and_status_are_refused_on_macos_only() {
        let dir = tempfile::tempdir().unwrap();
        let env = BTreeMap::from([
            (
                "XDG_CONFIG_HOME".to_string(),
                dir.path().display().to_string(),
            ),
            (
                "PATH".to_string(),
                dir.path().join("empty").display().to_string(),
            ),
            // Windows: a Run value of the test's own, never the person's.
            (
                "AGENT_RELAY_LOGIN_RUN_VALUE".to_string(),
                format!("AgentRelayTestSet{}", std::process::id()),
            ),
        ]);
        let result = set(dir.path(), &env, true);
        if cfg!(target_os = "macos") {
            let error = result.unwrap_err();
            assert_eq!(error.data.kind, ErrorKind::Refused);
            assert_eq!(
                error.message,
                "Launch at login is managed by the macOS app."
            );
            assert!(!entry_path(dir.path(), &env).exists());
            assert_eq!(
                status(dir.path(), &env).unwrap_err().data.kind,
                ErrorKind::Refused
            );
        } else {
            result.unwrap();
            assert!(status(dir.path(), &env).unwrap());
            set(dir.path(), &env, false).unwrap();
            assert!(!status(dir.path(), &env).unwrap());
        }
    }

    #[test]
    fn command_splitting_follows_the_shell() {
        assert_eq!(
            split_command(r#""/opt/a \"b\"/agent-relay" --background 'x y' z\ w"#).unwrap(),
            ["/opt/a \"b\"/agent-relay", "--background", "x y", "z w"]
        );
        assert!(split_command("\"open").is_none());
        assert_eq!(split_command("").unwrap(), Vec::<String>::new());
    }
}
