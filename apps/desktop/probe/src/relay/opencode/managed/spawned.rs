//! Agent Relay's plugin in a spawned agent's `opencode serve`.
//!
//! A spawned OpenCode replies over the relay-send socket only through the
//! managed route's proof (`managed::caller`): its shell carries the
//! plugin's session tag, and the plugin attests that this exact server
//! loaded the tagging hook. So every server a spawn starts loads the
//! plugin, whether or not the person installed it in OpenCode's global
//! `plugins/`.
//!
//! The plugin is written to `<runtime>/plugin/agent-relay-spawn.js`, a
//! directory only this user can enter, and named to that one server through
//! `OPENCODE_CONFIG_CONTENT`: OpenCode merges that inline configuration over
//! the person's global and project configuration and appends its `plugin`
//! list to theirs, so their own configuration and plugins still load.
//! Nothing is written to OpenCode's own directories. An inline
//! configuration the person already set is kept and the plugin appended to
//! it. A current copy of the plugin in the global `plugins/` is already
//! loaded, so none is added; any other copy still claims the process once
//! (`claimInstance` in `agent-relay.js`).

use crate::relay::existing_session::platform::{DirBuilderExt, OpenOptionsExt};
use crate::relay::opencode::{private_dir, OpenCodeConfig};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

/// OpenCode's inline configuration, merged over every file it reads.
pub const CONFIG_CONTENT: &str = "OPENCODE_CONFIG_CONTENT";

/// A name of its own, so OpenCode, which keeps one plugin per file name,
/// never drops a file of the person's for it.
const FILE: &str = "agent-relay-spawn.js";

/// The plugin's entry point: an object, which OpenCode 1 loaders that read
/// `server` and V2's `setup` accept.
const EXPORT: &str = r#"export default { id: "agent-relay", setup: setupV2, server: AgentRelay };"#;

/// The private copy's entry point: also callable, as older OpenCode 1
/// loaders call every export with the plugin's input, and an object there
/// fails to load. Only this copy has it, so the global one keeps its exact
/// bytes and every copy the same `PLUGIN_VERSION`.
const CALLABLE_EXPORT: &str = r#"export default Object.assign((input) => AgentRelay(input), { id: "agent-relay", setup: setupV2, server: AgentRelay });"#;

impl OpenCodeConfig {
    /// The plugin's private copy for spawned servers.
    pub fn spawn_plugin_file(&self) -> PathBuf {
        self.runtime.join("plugin").join(FILE)
    }

    /// The private copy as written: the plugin with a callable entry point.
    pub fn spawn_plugin_source(&self) -> String {
        self.plugin_source().replace(EXPORT, CALLABLE_EXPORT)
    }
}

/// Makes the server `environment` starts load the plugin: unchanged when
/// the global `plugins/` (under the environment's own `XDG_CONFIG_HOME`)
/// holds the current plugin; otherwise the private copy is written and
/// appended to the environment's inline configuration. An inline
/// configuration that is not a JSON object is the person's to keep, so it
/// is left as it is and the server starts without the plugin.
pub fn load_plugin(
    config: &OpenCodeConfig,
    uid: u32,
    environment: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    let source = config.plugin_source();
    let global = environment
        .get("XDG_CONFIG_HOME")
        .map(|value| value.trim())
        .filter(|value| value.starts_with('/'))
        .map(|value| Path::new(value).join("opencode"))
        .unwrap_or_else(|| config.config_dir.clone());
    let global = OpenCodeConfig {
        config_dir: global,
        ..config.clone()
    };
    if std::fs::read(global.plugin_file()).is_ok_and(|contents| contents == source.as_bytes()) {
        return Ok(());
    }
    let mut inline = match environment.get(CONFIG_CONTENT) {
        Some(content) if !content.trim().is_empty() => {
            match serde_json::from_str::<Value>(content) {
                Ok(Value::Object(inline)) => inline,
                _ => return Err(format!("{CONFIG_CONTENT} is not a JSON object")),
            }
        }
        _ => Map::new(),
    };
    let file = write_private_copy(config, uid, &config.spawn_plugin_source())?;
    let url = url::Url::from_file_path(&file)
        .map_err(|()| format!("{} is not an absolute path", file.display()))?
        .to_string();
    let plugins = inline
        .entry("plugin")
        .or_insert_with(|| Value::Array(Vec::new()));
    let Value::Array(plugins) = plugins else {
        return Err(format!(
            "{CONFIG_CONTENT} has a plugin entry that is not a list"
        ));
    };
    if !plugins.iter().any(|plugin| plugin.as_str() == Some(&url)) {
        plugins.push(Value::String(url));
    }
    environment.insert(CONFIG_CONTENT.into(), Value::Object(inline).to_string());
    Ok(())
}

/// Writes the plugin to its private file unless it is already there.
fn write_private_copy(config: &OpenCodeConfig, uid: u32, source: &str) -> Result<PathBuf, String> {
    let directory = config.runtime.join("plugin");
    let file = directory.join(FILE);
    for folder in [&config.runtime, &directory] {
        match std::fs::DirBuilder::new().mode(0o700).create(folder) {
            Err(error) if error.kind() != std::io::ErrorKind::AlreadyExists => {
                return Err(format!("could not make {}: {error}", folder.display()))
            }
            _ => {}
        }
        if !private_dir(folder, uid) {
            return Err(format!("{} is not private to this user", folder.display()));
        }
    }
    let current = std::fs::symlink_metadata(&file).is_ok_and(|metadata| metadata.is_file())
        && std::fs::read(&file).is_ok_and(|contents| contents == source.as_bytes());
    if current {
        return Ok(file);
    }
    let temporary = directory.join(format!(
        ".{FILE}.{}.tmp",
        crate::relay::store::random_hex(12)
    ));
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .and_then(|mut handle| handle.write_all(source.as_bytes()))
        .and_then(|()| std::fs::rename(&temporary, &file));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("could not write {}: {error}", file.display()));
    }
    Ok(file)
}

// File modes and uids throughout; spawned OpenCode is not available on
// Windows.
#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    fn config(root: &Path) -> OpenCodeConfig {
        OpenCodeConfig {
            config_dir: root.join("config").join("opencode"),
            data_dir: root.join("data").join("opencode"),
            runtime: root.join("rt"),
        }
    }

    fn uid() -> u32 {
        unsafe { libc::getuid() }
    }

    fn plugins(environment: &BTreeMap<String, String>) -> Vec<String> {
        let inline: Value = serde_json::from_str(&environment[CONFIG_CONTENT]).unwrap();
        inline["plugin"]
            .as_array()
            .unwrap()
            .iter()
            .map(|plugin| plugin.as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn a_spawned_server_loads_a_private_copy_and_nothing_global_is_written() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let mut environment = BTreeMap::from([("PATH".to_string(), "/bin".to_string())]);
        load_plugin(&config, uid(), &mut environment).unwrap();

        let file = config.spawn_plugin_file();
        assert_eq!(file, root.path().join("rt/plugin/agent-relay-spawn.js"));
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            config.spawn_plugin_source()
        );
        assert_eq!(std::fs::metadata(&file).unwrap().mode() & 0o777, 0o600);
        for folder in [&config.runtime, &root.path().join("rt/plugin")] {
            assert_eq!(std::fs::metadata(folder).unwrap().mode() & 0o777, 0o700);
        }
        assert_eq!(
            plugins(&environment),
            [url::Url::from_file_path(&file).unwrap().to_string()]
        );
        assert_eq!(environment["PATH"], "/bin");
        assert!(
            !root.path().join("config").exists(),
            "OpenCode's own config is untouched"
        );

        // Started again, the copy and the configuration stay as they are.
        load_plugin(&config, uid(), &mut environment).unwrap();
        assert_eq!(plugins(&environment).len(), 1);
    }

    #[test]
    fn the_private_copy_is_callable_by_every_opencode_1_loader() {
        let config = config(Path::new("/r"));
        let global = config.plugin_source();
        let private = config.spawn_plugin_source();
        assert_eq!(global.matches(EXPORT).count(), 1);
        assert_eq!(private.matches(CALLABLE_EXPORT).count(), 1);
        assert!(!private.contains(EXPORT));
        assert_eq!(private.lines().count(), global.lines().count());
        assert!(private.contains(&format!(
            "const VERSION = {};",
            crate::relay::opencode::PLUGIN_VERSION
        )));
    }

    #[test]
    fn the_persons_inline_configuration_is_kept() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let theirs = r#"{"model":"x/y","plugin":["their-plugin@1"],"mcp":{"a":{"type":"local"}}}"#;
        let mut environment = BTreeMap::from([(CONFIG_CONTENT.to_string(), theirs.to_string())]);
        load_plugin(&config, uid(), &mut environment).unwrap();
        let inline: Value = serde_json::from_str(&environment[CONFIG_CONTENT]).unwrap();
        assert_eq!(inline["model"], "x/y");
        assert_eq!(inline["mcp"]["a"]["type"], "local");
        let plugins = plugins(&environment);
        assert_eq!(plugins[0], "their-plugin@1");
        assert!(
            plugins[1].starts_with("file://")
                && plugins[1].ends_with("/rt/plugin/agent-relay-spawn.js")
        );

        // Not an object: theirs is kept and no plugin is added.
        let mut environment =
            BTreeMap::from([(CONFIG_CONTENT.to_string(), "// jsonc\n{}".to_string())]);
        assert!(load_plugin(&config, uid(), &mut environment).is_err());
        assert_eq!(environment[CONFIG_CONTENT], "// jsonc\n{}");
    }

    #[test]
    fn a_current_global_copy_is_not_loaded_twice() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        std::fs::create_dir_all(config.config_dir.join("plugins")).unwrap();
        std::fs::write(config.plugin_file(), config.plugin_source()).unwrap();
        let mut environment = BTreeMap::new();
        load_plugin(&config, uid(), &mut environment).unwrap();
        assert!(!environment.contains_key(CONFIG_CONTENT));
        assert!(!config.spawn_plugin_file().exists());

        // An older global copy is not this build's: the private one loads.
        std::fs::write(config.plugin_file(), "// AGENT_RELAY_OPENCODE_PLUGIN=1\n").unwrap();
        load_plugin(&config, uid(), &mut environment).unwrap();
        assert_eq!(plugins(&environment).len(), 1);
    }

    #[test]
    fn the_global_copy_is_looked_for_where_the_server_will_look() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let elsewhere = root.path().join("xdg");
        std::fs::create_dir_all(elsewhere.join("opencode/plugins")).unwrap();
        std::fs::write(
            elsewhere.join("opencode/plugins/agent-relay.js"),
            config.plugin_source(),
        )
        .unwrap();
        let mut environment = BTreeMap::from([(
            "XDG_CONFIG_HOME".to_string(),
            elsewhere.to_string_lossy().into_owned(),
        )]);
        load_plugin(&config, uid(), &mut environment).unwrap();
        assert!(!environment.contains_key(CONFIG_CONTENT));

        // The core's own global copy does not count for a server that
        // reads another configuration directory.
        let mut environment = BTreeMap::from([(
            "XDG_CONFIG_HOME".to_string(),
            root.path().join("empty").to_string_lossy().into_owned(),
        )]);
        load_plugin(&config, uid(), &mut environment).unwrap();
        assert_eq!(plugins(&environment).len(), 1);
    }

    #[test]
    fn a_runtime_others_can_enter_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        std::fs::create_dir_all(&config.runtime).unwrap();
        std::fs::set_permissions(&config.runtime, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut environment = BTreeMap::new();
        assert!(load_plugin(&config, uid(), &mut environment).is_err());
        assert!(!environment.contains_key(CONFIG_CONTENT));
        assert!(!config.spawn_plugin_file().exists());
    }
}
