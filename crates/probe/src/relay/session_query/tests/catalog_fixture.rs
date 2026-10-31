//! Shared isolated SDK/delivery catalog fixture for query-path regressions.
use super::*;
use crate::delivery::{self, DeliveryJobConfig, DeliveryLimits, ExportSelection};
use ai_hist::{DiscoveryOptions, ProviderRoots, SessionStore, Source, StoreOptions};
use std::path::PathBuf;

pub(crate) struct Fixture {
    pub home: tempfile::TempDir,
    pub catalog: CatalogIndex,
    pub store: SessionStore,
    pub db: Connection,
    pub path: PathBuf,
    pub relay_home: PathBuf,
    pub source_paths: Vec<PathBuf>,
}

impl Fixture {
    pub fn fail_second_observation(&self) {
        self.catalog.index.db.execute_batch(
            "CREATE TRIGGER fail_model_observation BEFORE INSERT ON rows WHEN NEW.key='codex:rw_000001' BEGIN SELECT RAISE(ABORT,'model observation failure'); END;",
        ).unwrap();
    }
    pub fn observation(
        &self,
        id: usize,
        model: &str,
        effort: Option<&str>,
    ) -> (String, ExecutionObservation) {
        (
            format!("codex:rw_{id:06}"),
            ExecutionObservation {
                model: model.into(),
                reasoning_effort: effort.map(str::to_owned),
                source_fingerprint: observation::source_fingerprint(&self.source_paths[id]),
            },
        )
    }
}

pub(crate) fn fixture() -> Fixture {
    let home = tempfile::tempdir().unwrap();
    let directory = home.path().join("install");
    let root = home.path().join(".codex/sessions");
    let relay_home = home.path().join("relay");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    let mut source_paths = vec![];
    for (id, model) in ["a-old", "b-model", "c-model"].iter().enumerate() {
        let path = root.join(format!("rollout-rw_{id:06}.jsonl"));
        std::fs::write(&path, format!("{}\n{}\n{}\n",
            serde_json::json!({"type":"session_meta","timestamp":"2026-10-01T00:00:00Z","payload":{"id":format!("rw_{id:06}"),"cwd":"/work/relay"}}),
            serde_json::json!({"type":"turn_context","payload":{"model":model,"effort":"high"}}),
            serde_json::json!({"type":"event_msg","timestamp":"2026-10-01T00:00:01Z","payload":{"type":"user_message","message":format!("Snapshot session {id}")}})
        )).unwrap();
        source_paths.push(path);
    }
    let path = directory.join("history.db");
    let mut options = StoreOptions::default();
    options.db_path = Some(path.clone());
    options.roots = Some(ProviderRoots::from_home(
        home.path().to_owned(),
        home.path().join("opencode.db"),
    ));
    let store = SessionStore::open(options).unwrap();
    let mut discovery = DiscoveryOptions::default();
    discovery.sources = Some(vec![Source::Codex]);
    discovery.skip_protected_folder_identity = true;
    store.discover(discovery).unwrap();
    let db = delivery::open_db(&path).unwrap();
    let job = delivery::create_job(
        &db,
        &DeliveryJobConfig {
            destination_id: "fixture".into(),
            instance_id: "fixture".into(),
            account_id: "fixture".into(),
            mapping_version: "1".into(),
            selection: ExportSelection {
                all_sources: true,
                kinds: vec!["session".into()],
                ..Default::default()
            },
            limits: DeliveryLimits::default(),
        },
        0,
    )
    .unwrap();
    std::fs::write(
        directory.join("config.json"),
        serde_json::json!({"job_id":job.job_id}).to_string(),
    )
    .unwrap();
    let catalog = CatalogIndex::open(&path, home.path(), &relay_home).unwrap();
    Fixture {
        home,
        catalog,
        store,
        db,
        path,
        relay_home,
        source_paths,
    }
}
