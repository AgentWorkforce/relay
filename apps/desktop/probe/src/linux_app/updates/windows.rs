//! Software updates and the launcher entry on Windows.
//!
//! A per-user install (`%LOCALAPPDATA%\Programs\AgentRelay\<version>\<tree>`)
//! updates itself from the release's `AgentRelay-<version>-Windows-<arch>.zip`:
//! download, verify the published SHA-256, unpack beside the running
//! version, point the logon task at it (restarting it if it runs), and
//! relaunch.
//!
//! Its launcher entry is a Start menu shortcut,
//! `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Agent Relay.lnk`,
//! written by PowerShell through `WScript.Shell` (no COM bindings in the
//! app), and the `agentrelay://` link handler under
//! `HKEY_CURRENT_USER\Software\Classes\agentrelay`, which runs
//! `"<agent-relay-desktop.exe>" "%1"`.

use super::{
    verified_download, CommandOutput, Host, Release, UpdateError, ESCAPES, NOT_A_BUILD, TOO_LARGE,
};
use crate::linux_app::install::{self, windows as tree, InstallKind};
use crate::linux_app::service::windows as task;
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// `CREATE_NO_WINDOW`: a console program started from the window opens no
/// console.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// The environment variable that tells a relaunched app to wait for the
/// process it replaces to end, so it does not hand itself to that instance.
pub const WAIT_FOR_PID: &str = "AGENT_RELAY_WAIT_FOR_PID";
/// A release unpacks to a few hundred megabytes; anything far larger is not
/// one.
pub const MAX_UNPACKED: u64 = 2 * 1024 * 1024 * 1024;
const MAX_MEMBERS: usize = 50_000;
const SCHTASKS_TIMEOUT: Duration = Duration::from_secs(30);
const POWERSHELL_TIMEOUT: Duration = Duration::from_secs(30);

/// The registry values the launcher entry reads and writes, under
/// `HKEY_CURRENT_USER`; tests stand in their own.
pub struct Registry<'a> {
    pub read: &'a dyn Fn(&str, &str) -> Option<String>,
    pub write: &'a dyn Fn(&str, &str, &str) -> io::Result<()>,
}

impl Registry<'static> {
    pub fn system() -> Registry<'static> {
        Registry {
            read: &|key, name| {
                tree::registry::read_string(tree::registry::Root::CurrentUser, key, name)
            },
            write: &|key, name, data| tree::registry::write_string(key, name, data),
        }
    }
}

/// A member's place in the archive: plain names only. Refuses an absolute
/// path, `..`, a drive or stream (`:`), and names Windows would rewrite
/// (trailing dots or spaces) or cannot hold. `None` for the archive's root.
fn member(name: &str) -> Result<Option<PathBuf>, UpdateError> {
    let escapes = || UpdateError::new(ESCAPES);
    if name.starts_with(['/', '\\']) {
        return Err(escapes());
    }
    let mut path = PathBuf::new();
    for part in name.split(['/', '\\']) {
        match part {
            "" | "." => continue,
            ".." => return Err(escapes()),
            _ => {}
        }
        if part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c < ' ' || matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*'))
        {
            return Err(escapes());
        }
        path.push(part);
    }
    Ok((!path.as_os_str().is_empty()).then_some(path))
}

/// Unpacks the zip in `data` into `into`, at most `limit` bytes. Symbolic
/// links and members outside the archive are refused, never skipped.
fn extract(data: &[u8], into: &Path, limit: u64) -> Result<(), UpdateError> {
    let not_a_build = |_| UpdateError::new(NOT_A_BUILD);
    let mut archive = zip::ZipArchive::new(io::Cursor::new(data)).map_err(not_a_build)?;
    if archive.len() > MAX_MEMBERS {
        return Err(UpdateError::new(NOT_A_BUILD));
    }
    let mut total: u64 = 0;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(not_a_build)?;
        if file.is_symlink() {
            return Err(UpdateError::new(ESCAPES));
        }
        let Some(relative) = member(file.name())? else {
            continue;
        };
        let path = into.join(relative);
        if file.is_dir() {
            fs::create_dir_all(&path).map_err(UpdateError::io(&path))?;
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(UpdateError::io(parent))?;
        }
        let remaining = limit - total;
        if file.size() > remaining {
            return Err(UpdateError::new(TOO_LARGE));
        }
        // A second member of the same name is not a build's.
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| UpdateError::new(NOT_A_BUILD))?;
        let copied = io::copy(&mut file.by_ref().take(remaining + 1), &mut out)
            .map_err(UpdateError::io(&path))?;
        if copied > remaining {
            return Err(UpdateError::new(TOO_LARGE));
        }
        total += copied;
    }
    Ok(())
}

/// The update failed after the files were in place.
fn not_restarted(release: &Release, command: &[&str], detail: &str) -> UpdateError {
    let detail = match detail.trim().trim_end_matches('.') {
        "" => ".".to_owned(),
        detail => format!(": {detail}."),
    };
    UpdateError::new(format!(
        "Version {} is installed, but `{}` failed{detail} Agent Relay was not restarted.",
        release.version,
        command.join(" ")
    ))
}

fn said(done: io::Result<CommandOutput>) -> Result<(), String> {
    match done {
        Ok(done) if done.code == Some(0) => Ok(()),
        Ok(done) => Err([done.stderr, done.stdout]
            .into_iter()
            .map(|text| text.trim().to_owned())
            .find(|text| !text.is_empty())
            .unwrap_or_default()),
        Err(error) => Err(error.to_string()),
    }
}

/// Moves the logon task, if there is one, to `app`, keeping whether it is
/// on; a running task restarts on the new version. A task the person never
/// turned on stays off.
fn repoint_task(app: &Path, release: &Release, host: &Host<'_>) -> Result<(), UpdateError> {
    let call = |argv: &[&str]| (host.run)(argv, SCHTASKS_TIMEOUT);
    let user = task::current_user(host.env).unwrap_or_default();
    let task = task::name(Some(&user));
    let definition = match task::query(&call, &task) {
        Ok(Some(definition)) => definition,
        // No task yet: the new version registers it when it starts.
        Ok(None) => return Ok(()),
        // Without Task Scheduler there is no task to run the new version.
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(not_restarted(
                release,
                &["schtasks", "/Query", "/TN", &task],
                &error.to_string(),
            ))
        }
    };
    let running = task::running(&call, &task).unwrap_or(false);
    let end = ["schtasks", "/End", "/TN", &task];
    if running {
        said(call(&end[..])).map_err(|detail| not_restarted(release, &end, &detail))?;
    }
    if let Err(detail) = task::register(&call, &task, app, &user, definition.enabled) {
        // A task that is off can wait: the new version registers it on
        // its start (`ensure_launcher`), so the update stands. One that
        // was running has been ended and has nothing right to run.
        if !running {
            return Ok(());
        }
        return Err(not_restarted(
            release,
            &["schtasks", "/Create", "/TN", &task, "/XML"],
            &detail,
        ));
    }
    let run = ["schtasks", "/Run", "/TN", &task];
    if running {
        said(call(&run[..])).map_err(|detail| not_restarted(release, &run, &detail))?;
    }
    Ok(())
}

/// Installs `release`'s zip under `root` (one directory per version) beside
/// the running version and moves the logon task to it. Returns the new
/// `bin\agent-relay-desktop.exe`. The running version stays on disk, so a failed
/// relaunch can go back to it.
pub fn install_zip(
    release: &Release,
    root: &Path,
    host: &Host<'_>,
) -> Result<PathBuf, UpdateError> {
    install_zip_within(release, root, host, MAX_UNPACKED)
}

fn install_zip_within(
    release: &Release,
    root: &Path,
    host: &Host<'_>,
    limit: u64,
) -> Result<PathBuf, UpdateError> {
    let data = verified_download(
        &release.tarball_url,
        &release.tarball_checksum_url,
        host.fetch,
    )?;
    let destination = root.join(&release.version);
    fs::create_dir_all(root).map_err(UpdateError::io(root))?;
    // Unpacked on the install's own volume, so the tree moves into place
    // with a rename.
    let scratch = tempfile::Builder::new()
        .prefix(".agent-relay-update-")
        .tempdir_in(root)
        .map_err(UpdateError::io(root))?;
    let unpacked = scratch.path().join("unpacked");
    fs::create_dir(&unpacked).map_err(UpdateError::io(&unpacked))?;
    extract(&data, &unpacked, limit)?;
    let trees: Vec<PathBuf> = fs::read_dir(&unpacked)
        .map_err(UpdateError::io(&unpacked))?
        .filter_map(|item| item.ok().map(|item| item.path()))
        .filter(|path| path.join(install::APP).is_file())
        .collect();
    let [unpacked_tree] = &trees[..] else {
        return Err(UpdateError::new(NOT_A_BUILD));
    };
    if destination.exists() {
        fs::remove_dir_all(&destination).map_err(UpdateError::io(&destination))?;
    }
    fs::create_dir_all(&destination).map_err(UpdateError::io(&destination))?;
    let tree = destination.join(unpacked_tree.file_name().unwrap_or_default());
    fs::rename(unpacked_tree, &tree).map_err(UpdateError::io(&tree))?;
    drop(scratch);
    let app = tree.join(install::APP);

    // The launcher entry is a convenience; the update itself stands.
    let _ = install_launcher(&tree, host);
    repoint_task(&app, release, host)?;
    // Launch at login, when it is on, starts the new version from now on.
    let env: BTreeMap<String, String> = [crate::relay::login_item::RUN_VALUE_ENV]
        .into_iter()
        .filter_map(|key| {
            (host.env)(key).map(|value| (key.to_owned(), value.to_string_lossy().into_owned()))
        })
        .collect();
    let _ = crate::relay::login_item::follow_update(&env, &app);
    Ok(app)
}

/// Starts `launcher`, the new version's app, which waits for this process
/// to end; the caller then quits.
pub fn relaunch(launcher: &Path, arguments: &[String]) -> io::Result<()> {
    Command::new(launcher)
        .args(arguments)
        .env(WAIT_FOR_PID, std::process::id().to_string())
        .spawn()
        .map(drop)
}

/// `value` as a PowerShell single-quoted string.
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// The PowerShell that writes the Start menu shortcut at `shortcut` to run
/// `app`. It exits 3, writing nothing, when a shortcut there runs something
/// outside `root` (someone else's). A desktop shortcut the Setup program
/// made, one running something under `root`, follows `app` too; none is
/// added.
pub fn shortcut_script(shortcut: &Path, app: &Path, root: &Path) -> String {
    let bin = app.parent().unwrap_or(app);
    let mut root = root.display().to_string().to_lowercase();
    if !root.ends_with('\\') {
        root.push('\\');
    }
    format!(
        "$ErrorActionPreference = 'Stop'\n\
         $path = {shortcut}\n\
         $shell = New-Object -ComObject WScript.Shell\n\
         if (Test-Path -LiteralPath $path) {{\n\
         \x20 $target = $shell.CreateShortcut($path).TargetPath\n\
         \x20 if ($target -and -not $target.ToLower().StartsWith({root})) {{ exit 3 }}\n\
         }}\n\
         [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($path))\n\
         $link = $shell.CreateShortcut($path)\n\
         $link.TargetPath = {app}\n\
         $link.WorkingDirectory = {bin}\n\
         $link.IconLocation = {icon}\n\
         $link.Description = 'Agent Relay'\n\
         $link.Save()\n\
         try {{\n\
         \x20 $desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Agent Relay.lnk'\n\
         \x20 if (Test-Path -LiteralPath $desktop) {{\n\
         \x20   $link = $shell.CreateShortcut($desktop)\n\
         \x20   if ($link.TargetPath -and $link.TargetPath.ToLower().StartsWith({root})) {{\n\
         \x20     $link.TargetPath = {app}\n\
         \x20     $link.WorkingDirectory = {bin}\n\
         \x20     $link.IconLocation = {icon}\n\
         \x20     $link.Save()\n\
         \x20   }}\n\
         \x20 }}\n\
         }} catch {{ }}\n",
        shortcut = ps_quote(&shortcut.display().to_string()),
        root = ps_quote(&root),
        app = ps_quote(&app.display().to_string()),
        bin = ps_quote(&bin.display().to_string()),
        icon = ps_quote(&format!("{},0", app.display())),
    )
}

/// `powershell.exe` running `script`, passed encoded so no quoting of the
/// command line can change it.
pub fn powershell(script: &str) -> Vec<String> {
    use base64::Engine;
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
    ]
    .into_iter()
    .map(str::to_owned)
    .chain([base64::engine::general_purpose::STANDARD.encode(utf16)])
    .collect()
}

/// `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Agent Relay.lnk`.
pub fn shortcut_path(host: &Host<'_>) -> PathBuf {
    tree::app_data(host.env, &host.home).join(tree::SHORTCUT)
}

/// Whether the `agentrelay://` handler is this app's to rewrite: missing,
/// or running an Agent Relay per-user install.
fn protocol_is_ours(registry: &Registry<'_>) -> bool {
    let key = format!(r"{}\shell\open\command", tree::PROTOCOL_KEY);
    match (registry.read)(&key, "") {
        None => true,
        Some(command) => tree::command_program(&command)
            .is_none_or(|program| tree::per_user_root_of(Path::new(program)).is_some()),
    }
}

/// Points the Setup program's entry in Installed apps at `tree_path`, a
/// per-user install's `<root>\<version>\<tree>`: its version, folder and
/// icon, so the entry names the version an update installed. Nothing when
/// there is no entry (a zip install). True when it was written.
fn follow_uninstall_entry(tree_path: &Path, registry: &Registry<'_>) -> io::Result<bool> {
    let key = tree::UNINSTALL_KEY;
    let Some(version) = tree_path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
    else {
        return Ok(false);
    };
    if (registry.read)(key, "UninstallString").is_none() {
        return Ok(false);
    }
    let location = format!(r"{}\", tree_path.display());
    let icon = tree_path.join(install::APP).display().to_string();
    for (name, data) in [
        ("DisplayVersion", version),
        ("InstallLocation", &location),
        ("DisplayIcon", &icon),
    ] {
        if (registry.read)(key, name).as_deref() != Some(data) {
            (registry.write)(key, name, data)?;
        }
    }
    Ok(true)
}

/// Lists a per-user install in the Start menu and makes `agentrelay://`
/// links open it: the shortcut, the link handler, the name Windows shows
/// over its notifications and, after the Setup program, its Installed apps
/// entry. A shortcut or handler someone else wrote is left
/// alone. Returns the shortcut, or `None` when it was not written. Trees
/// outside a per-user install root change nothing.
pub fn install_launcher(tree_path: &Path, host: &Host<'_>) -> io::Result<Option<PathBuf>> {
    install_launcher_in(tree_path, host, &Registry::system())
}

fn install_launcher_in(
    tree_path: &Path,
    host: &Host<'_>,
    registry: &Registry<'_>,
) -> io::Result<Option<PathBuf>> {
    let app = tree_path.join(install::APP);
    let Some(root) = tree::per_user_root_of(&app) else {
        return Ok(None);
    };
    if !app.is_file() {
        return Ok(None);
    }
    if protocol_is_ours(registry) {
        for (key, name, data) in tree::protocol_entries(&app) {
            (registry.write)(&key, &name, &data)?;
        }
    }
    let _ = (registry.write)(tree::APP_USER_MODEL_KEY, "DisplayName", "Agent Relay");
    let _ = follow_uninstall_entry(tree_path, registry);
    let shortcut = shortcut_path(host);
    let argv = powershell(&shortcut_script(&shortcut, &app, &root));
    let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
    let done = (host.run)(&argv, POWERSHELL_TIMEOUT)?;
    match done.code {
        Some(0) => Ok(Some(shortcut)),
        Some(3) => Ok(None),
        _ => Err(io::Error::other(
            [done.stderr, done.stdout]
                .into_iter()
                .map(|text| text.trim().to_owned())
                .find(|text| !text.is_empty())
                .unwrap_or_else(|| "PowerShell could not write the shortcut".into()),
        )),
    }
}

/// Keeps the Start menu shortcut, the link handler and the logon task on
/// the running per-user install, so they follow updates. Cheap when nothing
/// moved: the handler already runs this app and the shortcut exists. A
/// build from a checkout changes nothing.
pub fn ensure_launcher(exe: &Path, host: &Host<'_>) -> io::Result<Option<PathBuf>> {
    ensure_launcher_in(exe, host, &Registry::system())
}

fn ensure_launcher_in(
    exe: &Path,
    host: &Host<'_>,
    registry: &Registry<'_>,
) -> io::Result<Option<PathBuf>> {
    if install::install_kind(exe) != InstallKind::Tarball {
        return Ok(None);
    }
    let Some(tree_path) = install::install_tree(exe) else {
        return Ok(None);
    };
    // The logon task follows the install too, whatever the shortcut and the
    // handler say (`--install-launcher` writes those but no task);
    // registered off, it waits for the person to turn it on.
    if let Some(user) = task::current_user(host.env) {
        let call = |argv: &[&str]| (host.run)(argv, SCHTASKS_TIMEOUT);
        let _ = task::ensure(&call, &task::name(Some(&user)), exe, &user);
    }
    let shortcut = shortcut_path(host);
    let command = (registry.read)(&format!(r"{}\shell\open\command", tree::PROTOCOL_KEY), "");
    let current = command
        .as_deref()
        .and_then(tree::command_program)
        .is_some_and(|program| Path::new(program) == exe);
    if current && shortcut.exists() {
        return Ok(Some(shortcut));
    }
    install_launcher_in(tree_path, host, registry)
}

/// `agent-relay-desktop --install-launcher`: lists a per-user install in the Start
/// menu. Returns the exit code and the line to print (stdout on 0, stderr
/// otherwise).
pub fn install_launcher_command(exe: &Path, host: &Host<'_>) -> (i32, String) {
    if install::install_kind(exe) != InstallKind::Tarball {
        return (
            2,
            r"Only a per-user install (%LOCALAPPDATA%\Programs\AgentRelay) needs this.".to_owned(),
        );
    }
    let written = install::install_tree(exe).map(|tree_path| install_launcher(tree_path, host));
    match written {
        Some(Ok(Some(shortcut))) => (0, shortcut.display().to_string()),
        _ => (
            1,
            "Agent Relay could not write its Start menu shortcut; one written by someone else is kept."
                .to_owned(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::super::{architecture, parse_release_for, FetchError, Platform, UNVERIFIED};
    use super::*;
    use sha2::{Digest, Sha256};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::io::Write;

    const VERSION: &str = "2026.10.9";

    fn release_json(version: &str) -> serde_json::Value {
        let base = format!(
            "https://github.com/AgentWorkforce/relay-desktop-releases/releases/download/v{version}"
        );
        let mut assets = Vec::new();
        for (platform, arch, suffix) in [
            ("Windows", "x64", "zip"),
            ("Windows", "x64", "zip.sha256"),
            ("Windows", "arm64", "zip"),
            ("Windows", "arm64", "zip.sha256"),
            ("Linux", "x64", "tar.gz"),
            ("Linux", "x64", "tar.gz.sha256"),
            ("Linux", "x64", "deb"),
            ("Linux", "x64", "deb.sha256"),
        ] {
            let name = format!("AgentRelay-{version}-{platform}-{arch}.{suffix}");
            assets.push(
                serde_json::json!({"name": name, "browser_download_url": format!("{base}/{name}")}),
            );
        }
        serde_json::json!({"tag_name": format!("v{version}"), "draft": false, "prerelease": false,
                           "html_url": "https://github.com/r", "assets": assets})
    }

    fn release() -> Release {
        Release {
            version: VERSION.into(),
            tarball_url: "https://github.com/x/AgentRelay.zip".into(),
            tarball_checksum_url: "https://github.com/x/AgentRelay.zip.sha256".into(),
            deb_url: None,
            deb_checksum_url: None,
            page_url: String::new(),
        }
    }

    /// A zip of `(name, data)` files; a name ending in `/` is a folder.
    fn zip_of(members: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for (name, data) in members {
            if name.ends_with('/') {
                writer.add_directory(*name, options).unwrap();
            } else {
                writer.start_file(*name, options).unwrap();
                writer.write_all(data).unwrap();
            }
        }
        writer.finish().unwrap().into_inner()
    }

    fn build() -> Vec<u8> {
        zip_of(&[
            ("AgentRelay-Windows-arm64/", b""),
            (
                "AgentRelay-Windows-arm64/bin/agent-relay-desktop.exe",
                b"MZ app",
            ),
            (
                "AgentRelay-Windows-arm64/bin/agent-relay-probe.exe",
                b"MZ core",
            ),
            ("AgentRelay-Windows-arm64/bin/libgtk-4-1.dll", b"MZ gtk"),
            (
                "AgentRelay-Windows-arm64/share/glib-2.0/schemas/gschemas.compiled",
                b"s",
            ),
        ])
    }

    /// Serves `archive` and its checksum (or `digest`); records commands and
    /// answers them with `answer`.
    struct Fakes {
        home: PathBuf,
        archive: Vec<u8>,
        digest: Option<String>,
        commands: RefCell<Vec<Vec<String>>>,
        answer: fn(&[&str]) -> io::Result<CommandOutput>,
        /// The Run value this test owns: never the person's, and never
        /// another test's, since tests run in parallel.
        run_value: String,
    }

    fn unique_run_value() -> String {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        format!(
            "AgentRelayUpdateTest{}_{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn ok(stdout: &str) -> io::Result<CommandOutput> {
        Ok(CommandOutput {
            code: Some(0),
            stdout: stdout.into(),
            stderr: String::new(),
        })
    }

    impl Fakes {
        fn new(home: &Path, archive: Vec<u8>) -> Fakes {
            Fakes {
                home: home.to_path_buf(),
                archive,
                digest: None,
                commands: RefCell::default(),
                run_value: unique_run_value(),
                // No logon task.
                answer: |argv| {
                    Ok(CommandOutput {
                        code: Some(if argv[1] == "/Query" { 1 } else { 0 }),
                        ..CommandOutput::default()
                    })
                },
            }
        }

        fn with<T>(&self, body: impl FnOnce(&Host<'_>) -> T) -> T {
            let fetch = |url: &str| -> Result<Vec<u8>, FetchError> {
                if url.ends_with(".sha256") {
                    let digest = self.digest.clone().unwrap_or_else(|| {
                        Sha256::digest(&self.archive)
                            .iter()
                            .map(|byte| format!("{byte:02x}"))
                            .collect()
                    });
                    return Ok(format!("{digest}  AgentRelay.zip\n").into_bytes());
                }
                Ok(self.archive.clone())
            };
            let run = |argv: &[&str], _: Duration| {
                self.commands
                    .borrow_mut()
                    .push(argv.iter().map(|a| a.to_string()).collect());
                (self.answer)(argv)
            };
            let env = |name: &str| -> Option<OsString> {
                match name {
                    "USERNAME" => Some("a".into()),
                    "USERDOMAIN" => Some("PC".into()),
                    // A Run value of this test's own, never the person's.
                    "AGENT_RELAY_LOGIN_RUN_VALUE" => Some(self.run_value.clone().into()),
                    _ => None,
                }
            };
            body(&Host {
                home: self.home.clone(),
                env: &env,
                fetch: &fetch,
                run: &run,
            })
        }

        fn ran(&self, start: &[&str]) -> bool {
            self.commands
                .borrow()
                .iter()
                .any(|command| command.len() >= start.len() && command[..start.len()] == *start)
        }
    }

    #[test]
    fn the_release_names_the_zip_for_this_architecture() {
        let data = release_json(VERSION).to_string().into_bytes();
        let arm = parse_release_for(&data, "arm64", Platform::Windows).unwrap();
        assert!(arm
            .tarball_url
            .ends_with("AgentRelay-2026.10.9-Windows-arm64.zip"));
        assert!(arm
            .tarball_checksum_url
            .ends_with("AgentRelay-2026.10.9-Windows-arm64.zip.sha256"));
        assert_eq!(arm.deb_url, None);
        let x64 = parse_release_for(&data, "x64", Platform::Windows).unwrap();
        assert!(x64.tarball_url.ends_with("Windows-x64.zip"));
        let linux = parse_release_for(&data, "x64", Platform::Linux).unwrap();
        assert!(linux.tarball_url.ends_with("Linux-x64.tar.gz"));
        assert!(linux.deb_url.is_some());
        assert_eq!(
            parse_release_for(&data, "riscv64", Platform::Windows)
                .unwrap_err()
                .to_string(),
            "The latest release does not include a compatible update."
        );
        assert_eq!(architecture("aarch64"), Ok("arm64"));
        assert_eq!(architecture("x86_64"), Ok("x64"));
        assert_eq!(
            architecture("x86").unwrap_err().to_string(),
            "Agent Relay has no Windows build for x86."
        );
    }

    #[test]
    fn a_verified_zip_is_installed_beside_the_running_version() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("root");
        let fakes = Fakes::new(home.path(), build());
        let app = fakes
            .with(|host| install_zip(&release(), &root, host))
            .unwrap();
        assert_eq!(
            app,
            root.join(VERSION)
                .join("AgentRelay-Windows-arm64")
                .join(install::APP)
        );
        assert_eq!(fs::read(&app).unwrap(), b"MZ app");
        assert!(app.with_file_name("libgtk-4-1.dll").is_file());
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|item| item.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, [OsString::from(VERSION)]);
        // Outside a per-user root, nothing is listed in the Start menu, and
        // without a task none is touched.
        assert!(!fakes.ran(&["powershell.exe"]));
        assert!(!fakes.ran(&["schtasks", "/Create"]));
    }

    #[test]
    fn a_zip_that_does_not_match_its_checksum_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let mut fakes = Fakes::new(home.path(), build());
        fakes.digest = Some("0".repeat(64));
        let root = home.path().join("root");
        let error = fakes
            .with(|host| install_zip(&release(), &root, host))
            .unwrap_err();
        assert_eq!(error.to_string(), UNVERIFIED);
        assert!(!root.join(VERSION).exists());
    }

    #[test]
    fn a_zip_that_escapes_its_folder_is_refused() {
        for name in [
            "../evil.exe",
            "AgentRelay-Windows-arm64/../../evil.exe",
            r"AgentRelay-Windows-arm64\..\..\evil.exe",
            "/evil.exe",
            r"\evil.exe",
            "C:/evil.exe",
            "AgentRelay-Windows-arm64/bin/agent-relay-desktop.exe:stream",
            "AgentRelay-Windows-arm64/bin/agent-relay-desktop.exe.",
        ] {
            let into = tempfile::tempdir().unwrap();
            let archive = zip_of(&[
                (
                    "AgentRelay-Windows-arm64/bin/agent-relay-desktop.exe",
                    b"MZ",
                ),
                (name, b"x"),
            ]);
            assert_eq!(
                extract(&archive, into.path(), MAX_UNPACKED)
                    .unwrap_err()
                    .to_string(),
                ESCAPES,
                "{name}"
            );
        }
        let mut writer = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        writer
            .add_symlink(
                "AgentRelay-Windows-arm64/link",
                "C:/Windows",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        let linked = writer.finish().unwrap().into_inner();
        let into = tempfile::tempdir().unwrap();
        assert_eq!(
            extract(&linked, into.path(), MAX_UNPACKED)
                .unwrap_err()
                .to_string(),
            ESCAPES
        );
        assert_eq!(member("./a/./b").unwrap(), Some(PathBuf::from(r"a\b")));
        assert_eq!(member("./").unwrap(), None);
    }

    #[test]
    fn a_zip_larger_than_any_release_is_refused() {
        let into = tempfile::tempdir().unwrap();
        let archive = zip_of(&[(
            "AgentRelay-Windows-arm64/bin/agent-relay-desktop.exe",
            &[0; 64],
        )]);
        assert_eq!(
            extract(&archive, into.path(), 63).unwrap_err().to_string(),
            TOO_LARGE
        );
        assert!(extract(&archive, tempfile::tempdir().unwrap().path(), 64).is_ok());
        let home = tempfile::tempdir().unwrap();
        let fakes = Fakes::new(home.path(), archive);
        let error = fakes
            .with(|host| install_zip_within(&release(), &home.path().join("root"), host, 10))
            .unwrap_err();
        assert_eq!(error.to_string(), TOO_LARGE);
    }

    #[test]
    fn a_zip_without_exactly_one_build_is_refused() {
        for archive in [
            zip_of(&[("readme.txt", b"hi")]),
            zip_of(&[
                ("A/bin/agent-relay-desktop.exe", b"MZ"),
                ("B/bin/agent-relay-desktop.exe", b"MZ"),
            ]),
            b"not a zip".to_vec(),
        ] {
            let home = tempfile::tempdir().unwrap();
            let fakes = Fakes::new(home.path(), archive);
            let error = fakes
                .with(|host| install_zip(&release(), &home.path().join("root"), host))
                .unwrap_err();
            assert_eq!(error.to_string(), NOT_A_BUILD);
        }
    }

    #[test]
    fn a_running_logon_task_restarts_on_the_new_version() {
        let home = tempfile::tempdir().unwrap();
        let mut fakes = Fakes::new(home.path(), build());
        fakes.answer = |argv| {
            match (argv[1], argv.get(4).copied()) {
            ("/Query", Some("/XML")) => ok("<Task><Settings><Enabled>true</Enabled></Settings><Actions><Exec><Command>C:\\old\\agent-relay.exe</Command></Exec></Actions></Task>"),
            ("/Query", _) => ok("\"PC\",\"\\Agent Relay\",\"N/A\",\"Running\",\"x\",\"y\",\"267009\",\"z\"\r\n"),
            _ => ok(""),
        }
        };
        let root = home.path().join("root");
        fakes
            .with(|host| install_zip(&release(), &root, host))
            .unwrap();
        let commands: Vec<String> = fakes
            .commands
            .borrow()
            .iter()
            .map(|command| command[1].clone())
            .filter(|subcommand| subcommand != "/Query")
            .collect();
        assert_eq!(commands, ["/End", "/Create", "/Run"]);

        // A task that is off is moved, not started.
        let mut off = Fakes::new(home.path(), build());
        off.answer = |argv| match (argv[1], argv.get(4).copied()) {
            ("/Query", Some("/XML")) => {
                ok("<Task><Settings><Enabled>false</Enabled></Settings></Task>")
            }
            ("/Query", _) => ok(
                "\"PC\",\"\\Agent Relay\",\"N/A\",\"Disabled\",\"x\",\"y\",\"267011\",\"z\"\r\n",
            ),
            _ => ok(""),
        };
        off.with(|host| install_zip(&release(), &root, host))
            .unwrap();
        assert!(off.ran(&["schtasks", "/Create"]));
        assert!(!off.ran(&["schtasks", "/Run"]));
        assert!(!off.ran(&["schtasks", "/End"]));
    }

    #[test]
    fn an_update_moves_launch_at_login_to_the_new_version() {
        use crate::linux_app::install::windows::registry;
        use crate::relay::login_item;
        const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
        let home = tempfile::tempdir().unwrap();
        let mut fakes = Fakes::new(home.path(), build());
        let value = fakes.run_value.clone();
        let env: BTreeMap<String, String> =
            [(login_item::RUN_VALUE_ENV.to_owned(), value.clone())].into();
        // Launch at login is on, pointing at the old version.
        let old = home.path().join(r"old\bin\agent-relay.exe");
        registry::write_string(
            RUN_KEY,
            &value,
            &format!("\"{}\" --background", old.display()),
        )
        .unwrap();
        let app = fakes
            .with(|host| install_zip(&release(), &home.path().join("root"), host))
            .unwrap();
        let moved = registry::read_string(registry::Root::CurrentUser, RUN_KEY, &value);
        login_item::remove_gui_autostart(home.path(), &env).unwrap();
        assert_eq!(
            moved.as_deref(),
            Some(format!("\"{}\" --background", app.display()).as_str())
        );
        // Off stays off: a second update with no value writes none.
        fakes.answer = |_| ok("");
        let _ = fakes.with(|host| install_zip(&release(), &home.path().join("root2"), host));
        assert_eq!(
            registry::read_string(registry::Root::CurrentUser, RUN_KEY, &value),
            None
        );
    }

    #[test]
    fn a_task_that_is_off_and_cannot_be_moved_does_not_fail_the_update() {
        let home = tempfile::tempdir().unwrap();
        let mut fakes = Fakes::new(home.path(), build());
        fakes.answer = |argv| {
            match (argv[1], argv.get(4).copied()) {
            ("/Query", Some("/XML")) => ok("<Task><Settings><Enabled>false</Enabled></Settings></Task>"),
            ("/Query", _) => ok("\"PC\",\"\\Agent Relay\",\"N/A\",\"Disabled\",\"x\",\"y\",\"267011\",\"z\"\r\n"),
            ("/Create", _) => Ok(CommandOutput {
                code: Some(1),
                stdout: String::new(),
                stderr: "ERROR: The process cannot access the file because it is being used by another process.\r\n".into(),
            }),
            _ => ok(""),
        }
        };
        let app = fakes
            .with(|host| install_zip(&release(), &home.path().join("root"), host))
            .unwrap();
        assert!(app.ends_with(r"bin\agent-relay-desktop.exe"));
    }

    #[test]
    fn a_failed_task_restart_fails_the_update() {
        let home = tempfile::tempdir().unwrap();
        let mut fakes = Fakes::new(home.path(), build());
        fakes.answer = |argv| match (argv[1], argv.get(4).copied()) {
            ("/Query", Some("/XML")) => ok("<Task></Task>"),
            ("/Query", _) => {
                ok("\"PC\",\"\\Agent Relay\",\"N/A\",\"Running\",\"x\",\"y\",\"267009\",\"z\"\r\n")
            }
            ("/Run", _) => Ok(CommandOutput {
                code: Some(1),
                stdout: String::new(),
                stderr: "ERROR: Access is denied.\r\n".into(),
            }),
            _ => ok(""),
        };
        let error = fakes
            .with(|host| install_zip(&release(), &home.path().join("root"), host))
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Version 2026.10.9 is installed, but `schtasks /Run /TN Agent Relay (a)` failed: ERROR: Access is denied. Agent Relay was not restarted."
        );
    }

    #[test]
    fn the_shortcut_script_quotes_paths_and_keeps_someone_elses_shortcut() {
        let script = shortcut_script(
            Path::new(
                r"C:\Users\o'neil\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Agent Relay.lnk",
            ),
            Path::new(
                r"C:\Users\o'neil\AppData\Local\Programs\AgentRelay\1.0.0\T\bin\agent-relay-desktop.exe",
            ),
            Path::new(r"C:\Users\o'neil\AppData\Local\Programs\AgentRelay"),
        );
        assert!(script.contains(r"$path = 'C:\Users\o''neil\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Agent Relay.lnk'"));
        assert!(script.contains(
            r"StartsWith('c:\users\o''neil\appdata\local\programs\agentrelay\')) { exit 3 }"
        ));
        assert!(script.contains(r"$link.TargetPath = 'C:\Users\o''neil\AppData\Local\Programs\AgentRelay\1.0.0\T\bin\agent-relay-desktop.exe'"));
        assert!(script.contains(r"$link.WorkingDirectory = 'C:\Users\o''neil\AppData\Local\Programs\AgentRelay\1.0.0\T\bin'"));
        // A desktop shortcut follows only when it is the install's own.
        assert!(script.contains(
            r"if ($link.TargetPath -and $link.TargetPath.ToLower().StartsWith('c:\users\o''neil\appdata\local\programs\agentrelay\')) {"
        ));
        let argv = powershell("exit 0");
        assert_eq!(argv[argv.len() - 2], "-EncodedCommand");
        // "exit 0" in UTF-16LE, base64.
        assert_eq!(argv[argv.len() - 1], "ZQB4AGkAdAAgADAA");
    }

    /// A fake `HKEY_CURRENT_USER`.
    #[derive(Default)]
    struct Hive(RefCell<HashMap<(String, String), String>>);

    impl Hive {
        fn with<T>(&self, body: impl FnOnce(&Registry<'_>) -> T) -> T {
            let read = |key: &str, name: &str| {
                self.0
                    .borrow()
                    .get(&(key.to_owned(), name.to_owned()))
                    .cloned()
            };
            let write = |key: &str, name: &str, data: &str| {
                self.0
                    .borrow_mut()
                    .insert((key.to_owned(), name.to_owned()), data.to_owned());
                Ok::<(), io::Error>(())
            };
            body(&Registry {
                read: &read,
                write: &write,
            })
        }

        fn command(&self) -> Option<String> {
            self.0
                .borrow()
                .get(&(
                    r"Software\Classes\agentrelay\shell\open\command".to_owned(),
                    String::new(),
                ))
                .cloned()
        }
    }

    #[test]
    fn a_per_user_install_registers_its_links_and_shortcut() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(r"AppData\Local\Programs\AgentRelay");
        let tree_path = root.join(r"1.0.0\AgentRelay-Windows-arm64");
        let app = tree_path.join(install::APP);
        fs::create_dir_all(app.parent().unwrap()).unwrap();
        fs::write(&app, "MZ").unwrap();
        let mut fakes = Fakes::new(home.path(), Vec::new());
        fakes.answer = |argv| {
            Ok(CommandOutput {
                code: Some(if argv[1] == "/Query" { 1 } else { 0 }),
                ..CommandOutput::default()
            })
        };
        let hive = Hive::default();
        let shortcut = fakes
            .with(|host| hive.with(|registry| ensure_launcher_in(&app, host, registry)))
            .unwrap();
        assert_eq!(
            shortcut,
            Some(home.path().join(r"AppData\Roaming").join(tree::SHORTCUT))
        );
        assert_eq!(
            hive.command(),
            Some(format!("\"{}\" \"%1\"", app.display()))
        );
        assert!(fakes.ran(&["powershell.exe"]));
        // The logon task is registered, off.
        assert!(fakes.ran(&["schtasks", "/Create", "/TN", "Agent Relay (a)"]));

        // `--install-launcher` wrote the shortcut and the handler but no
        // task: the next start registers the task all the same.
        let shortcut = shortcut.unwrap();
        fs::create_dir_all(shortcut.parent().unwrap()).unwrap();
        fs::write(&shortcut, "lnk").unwrap();
        let later = Fakes::new(home.path(), Vec::new());
        assert_eq!(
            later
                .with(|host| hive.with(|registry| ensure_launcher_in(&app, host, registry)))
                .unwrap(),
            Some(shortcut.clone())
        );
        assert!(!later.ran(&["powershell.exe"]));
        assert!(later.ran(&["schtasks", "/Create", "/TN", "Agent Relay (a)"]));

        // A zip install has no Installed apps entry, and none is made.
        assert!(!hive
            .0
            .borrow()
            .keys()
            .any(|(key, _)| key == tree::UNINSTALL_KEY));

        // Someone else's handler is kept.
        let theirs = Hive::default();
        theirs.0.borrow_mut().insert(
            (
                r"Software\Classes\agentrelay\shell\open\command".into(),
                String::new(),
            ),
            r#""C:\Tools\other.exe" "%1""#.into(),
        );
        fakes
            .with(|host| theirs.with(|registry| install_launcher_in(&tree_path, host, registry)))
            .unwrap();
        assert_eq!(
            theirs.command(),
            Some(r#""C:\Tools\other.exe" "%1""#.into())
        );

        // ...and the Setup program's entry follows the version installed.
        let setup = Hive::default();
        let entry = |name: &str, data: &str| {
            setup.0.borrow_mut().insert(
                (tree::UNINSTALL_KEY.to_owned(), name.to_owned()),
                data.to_owned(),
            );
        };
        entry("UninstallString", r#""C:\x\AgentRelay\unins000.exe""#);
        entry("DisplayVersion", "0.9.0");
        fakes
            .with(|host| setup.with(|registry| install_launcher_in(&tree_path, host, registry)))
            .unwrap();
        let read = |name: &str| {
            setup
                .0
                .borrow()
                .get(&(tree::UNINSTALL_KEY.to_owned(), name.to_owned()))
                .cloned()
        };
        assert_eq!(read("DisplayVersion").as_deref(), Some("1.0.0"));
        assert_eq!(
            read("InstallLocation"),
            Some(format!(r"{}\", tree_path.display()))
        );
        assert_eq!(read("DisplayIcon"), Some(app.display().to_string()));

        // PowerShell's exit 3: the shortcut is someone else's.
        let mut kept = Fakes::new(home.path(), Vec::new());
        kept.answer = |_| {
            Ok(CommandOutput {
                code: Some(3),
                ..CommandOutput::default()
            })
        };
        let hive = Hive::default();
        assert_eq!(
            kept.with(|host| hive.with(|registry| install_launcher_in(&tree_path, host, registry)))
                .unwrap(),
            None
        );

        // A build from a checkout lists nothing.
        let build = home
            .path()
            .join(r"src\target\debug\agent-relay-desktop.exe");
        assert_eq!(
            fakes
                .with(|host| hive.with(|registry| ensure_launcher_in(&build, host, registry)))
                .unwrap(),
            None
        );
        assert_eq!(
            fakes.with(|host| install_launcher_command(&build, host)).0,
            2
        );
    }
}
