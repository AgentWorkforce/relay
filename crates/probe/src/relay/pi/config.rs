//! Which harness loads the extension, where it lives, and installing it.
use super::{atomic_write, private_fs, SessionKind};
use std::fs;
use std::path::{Path, PathBuf};

const SOURCE: &str = include_str!("agent-relay.mjs");
/// The first line of our extension, telling it from a person's file.
const EXTENSION_MARK: &str = "// AGENT_RELAY_PI_EXTENSION=";

/// The harnesses that load the bundled extension.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flavor {
    Pi,
    Omp,
}

impl Flavor {
    pub fn of(kind: SessionKind) -> Option<Flavor> {
        match kind {
            SessionKind::Pi => Some(Flavor::Pi),
            SessionKind::Omp => Some(Flavor::Omp),
            _ => None,
        }
    }
    pub fn kind(self) -> SessionKind {
        match self {
            Flavor::Pi => SessionKind::Pi,
            Flavor::Omp => SessionKind::Omp,
        }
    }
    /// The harness's own name, as people see it.
    pub fn name(self) -> &'static str {
        match self {
            Flavor::Pi => "Pi",
            Flavor::Omp => "Oh My Pi",
        }
    }
    /// What connects a session that was already open when the extension arrived.
    pub fn reconnect(self) -> &'static str {
        match self {
            Flavor::Pi => "Run /reload in the Pi session.",
            Flavor::Omp => "Exit this Oh My Pi session and run omp --continue in its folder.",
        }
    }
}

#[derive(Clone, Debug)]
pub struct PiConfig {
    pub flavor: Flavor,
    pub agent_dir: PathBuf,
    pub runtime: PathBuf,
    pub enabled: bool,
}

impl PiConfig {
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> Self {
        Self {
            flavor: Flavor::Pi,
            agent_dir: env("PI_CODING_AGENT_DIR")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .unwrap_or_else(|| home.join(".pi/agent")),
            runtime: home.join(".agentworkforce/desktop/pi"),
            // The extension checks file owners with `process.getuid`, which
            // Node does not have on Windows, so Pi sessions are off there.
            enabled: !cfg!(windows) && env("AGENT_RELAY_ENABLE_PI").as_deref() != Some("0"),
        }
    }

    /// omp keeps its agent directory at `~/<PI_CONFIG_DIR or .omp>/agent`.
    /// `PI_CODING_AGENT_DIR` is not read: Pi shares that name, and the
    /// relay's environment cannot say which harness it meant.
    pub fn omp_from_env(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> Self {
        let root = env("PI_CONFIG_DIR")
            .filter(|name| !name.is_empty() && Path::new(name).is_relative())
            .unwrap_or_else(|| ".omp".into());
        Self {
            flavor: Flavor::Omp,
            agent_dir: home.join(root).join("agent"),
            runtime: home.join(".agentworkforce/desktop/omp"),
            // Bun has no `process.getuid` on Windows either.
            enabled: !cfg!(windows) && env("AGENT_RELAY_ENABLE_OMP").as_deref() != Some("0"),
        }
    }

    pub(super) fn name(&self) -> &'static str {
        self.flavor.name()
    }

    pub fn extension_source(&self) -> String {
        let runtime = serde_json::Value::String(self.runtime.to_string_lossy().into_owned());
        let harness = match self.flavor {
            Flavor::Pi => "\"pi\"",
            Flavor::Omp => "\"omp\"",
        };
        SOURCE
            .replace("__RUNTIME__", &runtime.to_string())
            .replace("__HARNESS__", harness)
    }

    /// Whether the harness has run here (its agent folder exists) and its
    /// sessions are on: where the extension can go.
    pub fn installed(&self) -> bool {
        self.enabled && self.agent_dir.is_dir()
    }

    /// Where the extension goes in the harness's global extensions.
    pub fn extension_file(&self) -> PathBuf {
        self.agent_dir.join("extensions/agent-relay.js")
    }

    /// The marker turning the extension off leaves, in the core's own data
    /// beside the runtime rather than in the harness's folder.
    pub fn off_marker(&self) -> PathBuf {
        self.runtime.with_file_name(match self.flavor {
            Flavor::Pi => "pi-extension.off",
            Flavor::Omp => "omp-extension.off",
        })
    }

    /// The marker telling the extension that an open session joins the relay
    /// by itself (`auto_activate` and `pi_auto_activate`, which `relay init`
    /// turns on), so its banner does not ask the person to enable the session
    /// by hand. Core data beside the runtime.
    pub fn auto_join_marker(&self) -> PathBuf {
        self.runtime.with_file_name("pi-auto-join")
    }

    /// Keeps [`Self::auto_join_marker`] in step with whether Pi sessions
    /// join by themselves. Only the banner wording reads it, so a failure is
    /// ignored; nothing is written where Pi has not run or Pi sessions are
    /// off.
    pub fn sync_auto_join(&self, auto_join: bool) {
        let marker = self.auto_join_marker();
        // Turned off (`pi_extension`, or Pi sessions off altogether with
        // `AGENT_RELAY_ENABLE_PI=0`), a loaded extension's session is not
        // joined, so its banner must not promise otherwise.
        if !auto_join || !self.enabled || self.turned_off() {
            let _ = fs::remove_file(&marker);
            return;
        }
        if !self.installed() || marker.exists() {
            return;
        }
        if let Some(parent) = marker.parent() {
            if private_fs::create_private_dir_all(parent).is_err() {
                return;
            }
        }
        let _ = fs::write(
            &marker,
            "Open Pi sessions join Agent Relay automatically (auto_activate and pi_auto_activate).
",
        );
    }

    /// Whether `pi_extension` was turned off: Pi sessions are then neither
    /// listed nor delivered to, even one that loaded the extension earlier.
    pub fn turned_off(&self) -> bool {
        self.off_marker().exists()
    }

    /// Whether our extension for this harness (not a person's file of that
    /// name, nor the other harness's copy in a shared agent directory) is in
    /// place.
    pub fn extension_installed(&self) -> bool {
        fs::symlink_metadata(self.extension_file()).is_ok_and(|m| m.is_file())
            && fs::read_to_string(self.extension_file()).is_ok_and(|text| {
                text.starts_with(EXTENSION_MARK) && Self::installed_for(&text) == self.flavor
            })
    }

    /// Removes our extension for this harness; a person's file at that name,
    /// the other harness's copy, or none, is left.
    pub fn remove(&self) -> Result<(), String> {
        if !self.extension_installed() {
            return Ok(());
        }
        fs::remove_file(self.extension_file())
            .map_err(|e| format!("Could not remove the {} extension: {e}", self.name()))
    }

    /// The harness whose copy of the bundled extension `source` is. Copies
    /// from before omp support name no harness and are Pi's.
    fn installed_for(source: &str) -> Flavor {
        if source.contains("\nconst harness = \"omp\";\n") {
            Flavor::Omp
        } else {
            Flavor::Pi
        }
    }

    /// Preserve a person's extension at this name. Refresh only our own copy:
    /// when Pi and omp share an agent directory (`PI_CONFIG_DIR=.pi`, or
    /// paths that resolve to one folder), the copy already there keeps its
    /// harness and runtime, and the other harness's install is refused.
    pub fn install(&self) -> Result<(), String> {
        if !self.installed() {
            return Ok(());
        }
        let path = self.extension_file();
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            let existing = fs::read_to_string(&path).unwrap_or_default();
            if !metadata.is_file() || !existing.starts_with(EXTENSION_MARK) {
                return Err(format!(
                    "A different {} extension already uses agent-relay.js.",
                    self.name()
                ));
            }
            let owner = Self::installed_for(&existing);
            if owner != self.flavor {
                let variable = match self.flavor {
                    Flavor::Pi => "PI_CODING_AGENT_DIR",
                    Flavor::Omp => "PI_CONFIG_DIR",
                };
                return Err(format!(
                    "{} shares its agent directory with {}, whose Agent Relay extension already uses agent-relay.js. Give {} an agent directory of its own with {variable}.",
                    self.name(),
                    owner.name(),
                    self.name(),
                ));
            }
        }
        let source = self.extension_source();
        if fs::read_to_string(&path).ok().as_deref() == Some(&source) {
            return Ok(());
        }
        let parent = path
            .parent()
            .ok_or("The extension has no parent directory.")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        atomic_write(&path, source.as_bytes()).map_err(|e| e.to_string())
    }
}
