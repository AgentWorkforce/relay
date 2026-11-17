//! Which session socket a session command asks when it is not given one.
//!
//! The hints, pointers and hooks a build hands its sessions always name the
//! socket (`--socket`), so nothing here changes what they reach. A person, or
//! an agent the desktop did not start (Cursor, a terminal), runs
//! `agent-relay-probe whoami` bare; that asks, in order:
//!
//! 1. `--socket`, as given.
//! 2. `--dev` or `--profile <id>`: that build's pointer, and only it
//!    (`cli::pointed_socket`).
//! 3. `$AGENT_RELAY_SOCKET`, an absolute path.
//! 4. The build that installed this probe, from where it is:
//!    - a sidecar beside it, `<name>.install.json`, holding
//!      `{"app_data_dir": "<that build's data directory>"}` (the
//!      `~/.local/bin` copy, which several builds share, says nothing of its
//!      own build without one);
//!    - else the app bundle it resolves into (`<App>.app/Contents/…`),
//!      whose `Info.plist` `CFBundleIdentifier` names the data directory;
//!    - else the name it was run as: the alias `agent-relay-probe-dev` or
//!      `agent-relay-probe-<profile id>` (`probe_alias`).
//!
//!    That build's pointer, else its default socket when it exists. A build
//!    found here is never swapped for another: when it is not running, the
//!    error names it and where its socket was looked for.
//! 5. Agent Relay's own: its pointer, else its default socket when it
//!    exists.
//!
//! When none answers, the error names every path looked at.

use crate::relay::app_store;
use crate::relay::cli::{other_builds_hint, pointed_socket};
use crate::relay::daemon::SafeError;
use crate::relay::outbound::{default_socket, pointer_directory, Build};
use anyhow::Result;
use std::path::{Path, PathBuf};

/// The environment variable that names the session socket outright.
pub const SOCKET_ENV: &str = "AGENT_RELAY_SOCKET";

/// The sidecar beside an installed probe naming the build that installed
/// it: `agent-relay-probe.install.json` beside `agent-relay-probe` (and
/// beside `agent-relay-probe.exe`).
pub const INSTALL_SUFFIX: &str = ".install.json";

/// The probe alias's name before a build's suffix (`probe_alias`).
const ALIAS_PREFIX: &str = "agent-relay-probe-";

/// The socket to ask: `explicit` when given, else `named`'s pointer when a
/// build was named, else the first of the defaults this module describes.
pub fn resolve(explicit: Option<&Path>, named: Option<&Build>) -> Result<PathBuf> {
    if let Some(socket) = explicit {
        return Ok(socket.to_path_buf());
    }
    let home = crate::relay::paths::home()?;
    if let Some(build) = named {
        return pointed_socket(&home, build);
    }
    let env = |key: &str| std::env::var(key).ok();
    Lookup {
        home: &home,
        env: &env,
        executable: run_as(),
        uid: crate::relay::peer::current_uid(),
    }
    .socket()
}

/// This probe as it was run, links not followed: `argv[0]` (against the
/// working directory, or found on `PATH` when it is a bare name) when it
/// resolves to the running executable, else `current_exe`. Linux's
/// `current_exe` is `/proc/self/exe`, already resolved, which would lose an
/// alias link's name and the sidecar beside it.
fn run_as() -> Option<PathBuf> {
    let current = std::env::current_exe().ok();
    let invoked = std::env::args_os()
        .next()
        .and_then(|zeroth| invoked_path(Path::new(&zeroth), std::env::var_os("PATH")));
    match (invoked, &current) {
        (Some(invoked), Some(current))
            if std::fs::canonicalize(&invoked).ok() == std::fs::canonicalize(current).ok() =>
        {
            Some(invoked)
        }
        _ => current,
    }
}

/// Where `zeroth` (a program's `argv[0]`) names: a path with a separator,
/// against the working directory, or a bare name, the first match on
/// `path`.
fn invoked_path(zeroth: &Path, path: Option<std::ffi::OsString>) -> Option<PathBuf> {
    if zeroth.as_os_str().is_empty() {
        return None;
    }
    if zeroth.components().count() > 1 || zeroth.is_absolute() {
        return Some(std::env::current_dir().ok()?.join(zeroth));
    }
    std::env::split_paths(&path?)
        .map(|directory| directory.join(zeroth))
        .find(|candidate| candidate.is_file())
}

/// Where a default is looked for. Tests give their own.
pub struct Lookup<'a> {
    pub home: &'a Path,
    pub env: &'a dyn Fn(&str) -> Option<String>,
    /// This probe as it was run (`current_exe`), links not followed.
    pub executable: Option<PathBuf>,
    pub uid: u32,
}

/// The build that installed this probe, and how that was told.
#[derive(Debug, PartialEq, Eq)]
pub struct Installed {
    pub build: Build,
    /// Its data directory, when known: its default socket is under it.
    pub app_data_dir: Option<PathBuf>,
    /// What named it, for the error.
    pub source: String,
}

impl Lookup<'_> {
    /// Steps 3 to 5.
    pub fn socket(&self) -> Result<PathBuf> {
        if let Some(value) = (self.env)(SOCKET_ENV).filter(|value| !value.trim().is_empty()) {
            let path = PathBuf::from(value.trim());
            if !path.is_absolute() {
                return Err(SafeError(format!(
                    "{SOCKET_ENV} must be an absolute path to a session socket, got {}.",
                    path.display()
                ))
                .into());
            }
            return Ok(path);
        }
        if let Some(installed) = self.installed() {
            return self
                .socket_of(&installed.build, installed.app_data_dir.as_deref())
                .map_err(|looked| {
                    let mut message = format!(
                        "{} is not running: this probe belongs to it ({}), and it has no session socket at {}.",
                        installed.build.describe(),
                        installed.source,
                        or_list(&looked)
                    );
                    self.finish(&mut message, &installed.build);
                    SafeError(message).into()
                });
        }
        let stock = Build::Production;
        let data = app_store::default_data_dir(self.env, self.home);
        self.socket_of(&stock, Some(&data)).map_err(|looked| {
            let mut message = format!(
                "No Agent Relay session socket was found at {}.",
                or_list(&looked)
            );
            self.finish(&mut message, &stock);
            SafeError(message).into()
        })
    }

    /// The other running builds, then what to do.
    fn finish(&self, message: &mut String, build: &Build) {
        if let Some(others) = other_builds_hint(&pointer_directory(self.home), build) {
            message.push(' ');
            message.push_str(&others);
        }
        message.push_str(&format!(
            " Start the app, or pass --socket <path> or set {SOCKET_ENV}."
        ));
    }

    /// `build`'s pointer, else its default socket under `app_data_dir` when
    /// that exists; else every path looked at.
    fn socket_of(
        &self,
        build: &Build,
        app_data_dir: Option<&Path>,
    ) -> Result<PathBuf, Vec<PathBuf>> {
        let pointer = pointer_directory(self.home).join(build.pointer_name());
        if let Some(socket) = std::fs::read_to_string(&pointer)
            .ok()
            .map(|text| PathBuf::from(text.trim()))
            .filter(|path| path.is_absolute())
        {
            return Ok(socket);
        }
        let mut looked = vec![pointer];
        if let Some(directory) = app_data_dir {
            let socket = default_socket(self.env, directory, self.uid);
            // A Windows session socket is a named pipe, not a file.
            let live = if cfg!(windows) {
                crate::relay::transport::is_served(&socket)
            } else {
                socket.exists()
            };
            if live {
                return Ok(socket);
            }
            looked.push(socket);
        }
        Err(looked)
    }

    /// Step 4: the build that installed this probe, if its place tells.
    pub fn installed(&self) -> Option<Installed> {
        let run_as = self.executable.as_deref()?;
        let resolved = std::fs::canonicalize(run_as).ok();
        let places: Vec<&Path> = std::iter::once(run_as)
            .chain(resolved.as_deref().filter(|path| *path != run_as))
            .collect();
        for place in &places {
            if let Some(found) = self.sidecar(place) {
                return Some(found);
            }
        }
        for place in &places {
            if let Some(found) = self.bundle(place) {
                return Some(found);
            }
        }
        alias(run_as)
    }

    /// `<name>.install.json` beside `probe`.
    fn sidecar(&self, probe: &Path) -> Option<Installed> {
        let stem = probe.file_stem()?.to_str()?;
        let path = probe.with_file_name(format!("{stem}{INSTALL_SUFFIX}"));
        let text = std::fs::read_to_string(&path).ok()?;
        let value: serde_json::Value = serde_json::from_str(&text).ok()?;
        let directory = PathBuf::from(value["app_data_dir"].as_str()?);
        if !directory.is_absolute() || directory.file_name().is_none() {
            return None;
        }
        Some(Installed {
            build: Build::of(&directory),
            app_data_dir: Some(directory),
            source: format!("named by {}", path.display()),
        })
    }

    /// The app bundle `probe` sits in, named by its `CFBundleIdentifier`.
    fn bundle(&self, probe: &Path) -> Option<Installed> {
        let app = probe.ancestors().skip(1).find(|ancestor| {
            ancestor
                .extension()
                .is_some_and(|extension| extension == "app")
                && probe.starts_with(ancestor.join("Contents"))
        })?;
        let plist = std::fs::read_to_string(app.join("Contents/Info.plist")).ok()?;
        let identifier = bundle_identifier(&plist)?;
        let data = app_store::default_data_dir(self.env, self.home);
        let directory = data.parent()?.join(&identifier);
        Some(Installed {
            build: Build::of(&directory),
            app_data_dir: Some(directory),
            source: format!("installed from {} ({identifier})", app.display()),
        })
    }
}

/// The build a probe alias's name names: `agent-relay-probe-dev` or
/// `agent-relay-probe-<profile id>`. Agent Relay's own alias,
/// `agent-relay-probe`, is also the shared `~/.local/bin` copy's name, so it
/// names no build.
fn alias(run_as: &Path) -> Option<Installed> {
    let name = run_as.file_stem()?.to_str()?;
    let suffix = name.strip_prefix(ALIAS_PREFIX)?;
    let build = match suffix {
        "dev" => Build::Development,
        id => Build::named(false, Some(id)).ok()?,
    };
    Some(Installed {
        build,
        app_data_dir: None,
        source: format!("run as {name}"),
    })
}

/// The top-level `CFBundleIdentifier` of an XML property list, when it is
/// a reverse-DNS name (`com.example.desktop`). A binary list is not read.
pub fn bundle_identifier(plist: &str) -> Option<String> {
    let (_, after) = plist.split_once("<key>CFBundleIdentifier</key>")?;
    let value = after.trim_start().strip_prefix("<string>")?;
    let (value, _) = value.split_once("</string>")?;
    let value = value.trim();
    let reverse_dns = value.split('.').count() >= 2
        && value.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        });
    reverse_dns.then(|| value.to_string())
}

fn or_list(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(" or ")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>Agent Relay</string>
	<key>CFBundleIdentifier</key>
	<string>com.example.desktop</string>
</dict>
</plist>
"#;

    struct Fixture {
        root: tempfile::TempDir,
        env: HashMap<String, String>,
    }

    impl Fixture {
        fn new() -> Fixture {
            let root = tempfile::tempdir().unwrap();
            // A default socket too long for its data directory falls back
            // under `$TMPDIR`, kept inside the fixture.
            let mut env = HashMap::new();
            env.insert(
                "XDG_DATA_HOME".to_string(),
                root.path().join("data").display().to_string(),
            );
            env.insert("TMPDIR".to_string(), root.path().display().to_string());
            Fixture { root, env }
        }

        fn home(&self) -> PathBuf {
            self.root.path().join("h")
        }

        fn lookup<T>(&self, executable: Option<PathBuf>, run: impl FnOnce(&Lookup) -> T) -> T {
            let home = self.home();
            let env = |key: &str| self.env.get(key).cloned();
            run(&Lookup {
                home: &home,
                env: &env,
                executable,
                uid: 501,
            })
        }

        fn data_base(&self) -> PathBuf {
            let env = |key: &str| self.env.get(key).cloned();
            app_store::default_data_dir(&env, &self.home())
                .parent()
                .unwrap()
                .to_path_buf()
        }

        /// The default socket of the build whose data directory is
        /// `name` under the fixture's data folder.
        fn default_socket(&self, name: &str) -> PathBuf {
            let env = |key: &str| self.env.get(key).cloned();
            default_socket(&env, &self.data_base().join(name), 501)
        }

        fn pointer(&self, name: &str, socket: &Path) {
            let directory = pointer_directory(&self.home());
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join(name), format!("{}\n", socket.display())).unwrap();
        }

        fn file(&self, path: &Path, text: &str) -> PathBuf {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
            path.to_path_buf()
        }

        /// A bare probe outside any bundle, with no sidecar.
        fn loose_probe(&self) -> PathBuf {
            self.file(&self.root.path().join("bin/agent-relay-probe"), "")
        }

        /// A probe inside `<App>.app` whose bundle id is `identifier`.
        fn bundled_probe(&self, identifier: &str) -> PathBuf {
            let app = self.root.path().join("Applications/Some App.app");
            self.file(
                &app.join("Contents/Info.plist"),
                &PLIST.replace("com.example.desktop", identifier),
            );
            self.file(&app.join("Contents/Helpers/Some App Helper"), "")
        }

        fn socket(&self, executable: Option<PathBuf>) -> Result<PathBuf, String> {
            self.lookup(executable, |lookup| {
                lookup.socket().map_err(|error| error.to_string())
            })
        }
    }

    #[test]
    fn an_explicit_socket_wins_over_every_default() {
        let socket = resolve(Some(Path::new("/s/relay.sock")), Some(&Build::Development));
        assert_eq!(socket.unwrap(), Path::new("/s/relay.sock"));
    }

    #[test]
    fn the_environment_names_the_socket_before_the_install() {
        let mut fixture = Fixture::new();
        let probe = fixture.bundled_probe("com.example.desktop");
        fixture.pointer("relay-socket", Path::new("/stock/relay.sock"));
        fixture
            .env
            .insert(SOCKET_ENV.into(), " /env/relay.sock \n".into());
        assert_eq!(
            fixture.socket(Some(probe.clone())).unwrap(),
            Path::new("/env/relay.sock")
        );
        fixture
            .env
            .insert(SOCKET_ENV.into(), "relative.sock".into());
        assert_eq!(
            fixture.socket(Some(probe.clone())).unwrap_err(),
            "AGENT_RELAY_SOCKET must be an absolute path to a session socket, got relative.sock."
        );
        // An empty value is not set.
        fixture.env.insert(SOCKET_ENV.into(), " ".into());
        assert_ne!(
            fixture.socket(Some(probe)).ok().as_deref(),
            Some(Path::new(" "))
        );
    }

    #[test]
    fn a_sidecar_names_the_build_that_installed_a_shared_copy() {
        let fixture = Fixture::new();
        let probe = fixture.loose_probe();
        let data = fixture.data_base().join("com.example.desktop");
        let profile = Build::of(&data);
        fixture.file(
            &probe.with_file_name("agent-relay-probe.install.json"),
            &serde_json::json!({ "app_data_dir": data }).to_string(),
        );
        fixture.pointer("relay-socket", Path::new("/stock/relay.sock"));
        // Its pointer answers; the stock one is never used in its place.
        fixture.pointer(&profile.pointer_name(), Path::new("/profile/relay.sock"));
        assert_eq!(
            fixture.socket(Some(probe.clone())).unwrap(),
            Path::new("/profile/relay.sock")
        );
        // Without a pointer, its default socket when it exists.
        std::fs::remove_file(pointer_directory(&fixture.home()).join(profile.pointer_name()))
            .unwrap();
        let socket = fixture.default_socket("com.example.desktop");
        fixture.file(&socket, "");
        assert_eq!(fixture.socket(Some(probe.clone())).unwrap(), socket);
        // A relative directory is not a sidecar.
        fixture.file(
            &probe.with_file_name("agent-relay-probe.install.json"),
            r#"{"app_data_dir": "com.example.desktop"}"#,
        );
        assert_eq!(
            fixture.socket(Some(probe)).unwrap(),
            Path::new("/stock/relay.sock")
        );
    }

    #[test]
    fn a_sidecar_beside_the_resolved_probe_is_read_through_a_link() {
        let fixture = Fixture::new();
        let probe = fixture.loose_probe();
        let data = fixture.data_base().join("com.agentrelay.desktop.acme");
        fixture.file(
            &probe.with_file_name("agent-relay-probe.install.json"),
            &serde_json::json!({ "app_data_dir": data }).to_string(),
        );
        let link = fixture.root.path().join("links/probe");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&probe, &link).unwrap();
        let installed = fixture.lookup(Some(link), |lookup| lookup.installed().unwrap());
        assert_eq!(installed.build, Build::Profile("acme".into()));
    }

    #[test]
    fn a_bundled_probe_belongs_to_its_bundle_id() {
        let fixture = Fixture::new();
        let probe = fixture.bundled_probe("com.agentrelay.desktop.acme");
        fixture.pointer("relay-socket", Path::new("/stock/relay.sock"));
        fixture.pointer("relay-socket.acme", Path::new("/acme/relay.sock"));
        assert_eq!(
            fixture.socket(Some(probe.clone())).unwrap(),
            Path::new("/acme/relay.sock")
        );
        // Reached through the alias link, it is still the bundle's.
        let alias = fixture
            .home()
            .join(".agentworkforce/desktop/bin/agent-relay-probe");
        std::fs::create_dir_all(alias.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&probe, &alias).unwrap();
        assert_eq!(
            fixture.socket(Some(alias)).unwrap(),
            Path::new("/acme/relay.sock")
        );
        // The stock app's bundle is Agent Relay.
        let stock = Fixture::new();
        let probe = stock.bundled_probe("com.agentrelay.desktop");
        stock.pointer("relay-socket", Path::new("/stock/relay.sock"));
        stock.pointer("relay-socket.acme", Path::new("/acme/relay.sock"));
        assert_eq!(
            stock.socket(Some(probe)).unwrap(),
            Path::new("/stock/relay.sock")
        );
    }

    #[test]
    fn a_profile_alias_name_names_its_build() {
        let fixture = Fixture::new();
        let bin = fixture.root.path().join("bin");
        let acme = fixture.file(&bin.join("agent-relay-probe-acme"), "");
        let dev = fixture.file(&bin.join("agent-relay-probe-dev"), "");
        let installed = |path: PathBuf| fixture.lookup(Some(path), |lookup| lookup.installed());
        assert_eq!(
            installed(acme).unwrap().build,
            Build::Profile("acme".into())
        );
        assert_eq!(installed(dev).unwrap().build, Build::Development);
        // Agent Relay's alias name is also the shared copy's: it says nothing.
        assert_eq!(installed(fixture.loose_probe()), None);
        let odd = fixture.file(&bin.join("agent-relay-probe-Not_An_Id"), "");
        assert_eq!(installed(odd), None);
    }

    #[test]
    fn a_probe_that_names_no_build_asks_agent_relay() {
        let fixture = Fixture::new();
        let probe = fixture.loose_probe();
        fixture.pointer("relay-socket", Path::new("/stock/relay.sock"));
        assert_eq!(
            fixture.socket(Some(probe.clone())).unwrap(),
            Path::new("/stock/relay.sock")
        );
        // No pointer: the stock default socket, when it exists.
        std::fs::remove_file(pointer_directory(&fixture.home()).join("relay-socket")).unwrap();
        let socket = fixture.default_socket("com.agentrelay.desktop");
        fixture.file(&socket, "");
        assert_eq!(fixture.socket(Some(probe)).unwrap(), socket);
        // Nor without knowing where this probe is.
        assert_eq!(fixture.socket(None).unwrap(), socket);
    }

    #[test]
    fn nothing_found_names_every_path_looked_at() {
        let fixture = Fixture::new();
        let pointers = pointer_directory(&fixture.home());
        let stock_socket = fixture.default_socket("com.agentrelay.desktop");
        assert_eq!(
            fixture.socket(Some(fixture.loose_probe())).unwrap_err(),
            format!(
                "No Agent Relay session socket was found at {} or {}. Start the app, or pass --socket <path> or set AGENT_RELAY_SOCKET.",
                pointers.join("relay-socket").display(),
                stock_socket.display()
            )
        );
        // A profile build's bundle: its own paths, never the stock pointer,
        // which is named as another running build.
        let probe = fixture.bundled_probe("com.agentrelay.desktop.acme");
        fixture.pointer("relay-socket", Path::new("/stock/relay.sock"));
        let app = fixture.root.path().join("Applications/Some App.app");
        assert_eq!(
            fixture.socket(Some(probe)).unwrap_err(),
            format!(
                "the acme profile build of Agent Relay is not running: this probe belongs to it (installed from {} (com.agentrelay.desktop.acme)), and it has no session socket at {} or {}. Another build has a pointer: Agent Relay (neither --dev nor --profile). Pass that build's flag to go through it. Start the app, or pass --socket <path> or set AGENT_RELAY_SOCKET.",
                app.display(),
                pointers.join("relay-socket.acme").display(),
                fixture
                    .default_socket("com.agentrelay.desktop.acme")
                    .display()
            )
        );
        // An alias name knows no data directory: only the pointer.
        let alias = fixture.file(&fixture.root.path().join("bin/agent-relay-probe-dev"), "");
        assert_eq!(
            fixture.socket(Some(alias)).unwrap_err(),
            format!(
                "Agent Relay Dev is not running: this probe belongs to it (run as agent-relay-probe-dev), and it has no session socket at {}. Another build has a pointer: Agent Relay (neither --dev nor --profile). Pass that build's flag to go through it. Start the app, or pass --socket <path> or set AGENT_RELAY_SOCKET.",
                pointers.join("relay-socket.dev").display()
            )
        );
    }

    #[test]
    fn argv_zero_is_found_where_it_was_run_from() {
        let fixture = Fixture::new();
        let bin = fixture.root.path().join("bin");
        let probe = fixture.file(&bin.join("agent-relay-probe-acme"), "");
        let path = std::env::join_paths([fixture.root.path().join("none"), bin.clone()]).ok();
        assert_eq!(
            invoked_path(Path::new("agent-relay-probe-acme"), path.clone()),
            Some(probe.clone())
        );
        assert_eq!(invoked_path(Path::new("missing"), path), None);
        assert_eq!(invoked_path(&probe, None), Some(probe));
        assert_eq!(
            invoked_path(Path::new("./x/probe"), None),
            Some(std::env::current_dir().unwrap().join("./x/probe"))
        );
        assert_eq!(invoked_path(Path::new(""), None), None);
    }

    #[test]
    fn reads_only_a_reverse_dns_bundle_identifier() {
        assert_eq!(
            bundle_identifier(PLIST).as_deref(),
            Some("com.example.desktop")
        );
        for bad in ["..", "com..x", "com/x.y", "single", ""] {
            assert_eq!(
                bundle_identifier(&PLIST.replace("com.example.desktop", bad)),
                None,
                "{bad}"
            );
        }
        assert_eq!(bundle_identifier("bplist00"), None);
    }
}
