//! Relay-owned Factory Droid runtimes. Native IDs come from Droid's own
//! initialize response; unowned terminal sessions are never adopted.
use crate::relay::harness::droid::{read_record, verified, Record};
use crate::relay::process::ProcessTable;
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{is_uuid, SessionKind, Target};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DroidConfig {
    pub data_dir: PathBuf,
    pub development: bool,
}
impl DroidConfig {
    pub fn from_local(config: &crate::relay::local::LocalConfig) -> Self {
        Self::from_env(&|_| None, &config.devin.home).development(config.devin.development)
    }
    pub fn from_env(_env: &dyn Fn(&str) -> Option<String>, home: &Path) -> Self {
        Self {
            data_dir: home.join(".factory"),
            development: false,
        }
    }
    pub fn development(mut self, development: bool) -> Self {
        self.development = development;
        self
    }
}
pub fn records(config: &DroidConfig, table: &dyn ProcessTable) -> Vec<Record> {
    let runtime = crate::relay::harness::droid::runtime(config);
    let Ok(entries) = std::fs::read_dir(runtime) else {
        return vec![];
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let id = path.file_stem()?.to_str()?;
            if !is_uuid(id) || path.extension()?.to_str()? != "json" {
                return None;
            }
            read_record(&path).filter(|r| r.session_id == id && verified(r, table))
        })
        .collect()
}
pub fn discover(config: &DroidConfig, table: &dyn ProcessTable) -> Vec<DiscoveredSession> {
    records(config, table)
        .into_iter()
        .map(|record| DiscoveredSession {
            target: Target::new(SessionKind::Droid, record.session_id),
            title: "Factory Droid".into(),
            directory: Some(record.directory.display().to_string()),
            updated_at_ms: None,
            host: None,
            live: true,
            holder: None,
        })
        .collect()
}
pub fn is_droid_process(table: &dyn ProcessTable, pid: i32) -> bool {
    table
        .executable(pid)
        .and_then(|p| p.file_name().map(|s| s.to_string_lossy().into_owned()))
        .is_some_and(|name| {
            matches!(name.as_str(), "droid" | "droid.exe")
                || name.strip_prefix("droid-").is_some_and(|version| {
                    version.split('.').count() == 3
                        && version.split('.').all(|part| {
                            !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())
                        })
                })
        })
}
pub fn session(config: &DroidConfig, table: &dyn ProcessTable, pid: i32) -> Option<String> {
    let mut matches = records(config, table)
        .into_iter()
        .filter(|r| r.child.pid == pid);
    let first = matches.next()?;
    matches.next().is_none().then_some(first.session_id)
}
