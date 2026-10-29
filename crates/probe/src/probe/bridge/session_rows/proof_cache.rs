//! Bounded page-local proof progress. The SDK validates its opaque cache basis,
//! feed epoch and job cursor; no provider or proof schema is duplicated here.
use super::*;
use agent_relay_probe::platform::fs as private;
use std::io::{Read, Write};

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 4;

#[derive(Serialize, Deserialize)]
struct Entry {
    scope: String,
    cache: delivery::StatusCache,
}
#[derive(Serialize)]
struct Saved<'a> {
    scope: &'a str,
    cache: &'a delivery::StatusCache,
}

struct Cache {
    directory: std::path::PathBuf,
    path: std::path::PathBuf,
    scope: String,
    _lease: fs::File,
}
impl Cache {
    fn open(directory: &Path, config: &Config, key: &str) -> Result<Self> {
        ensure!(
            key.len() == 64
                && key
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid page proof cache key"
        );
        let directory = directory.join("query-proof-cache");
        private::create_private_dir_all(&directory)?;
        let metadata = fs::symlink_metadata(&directory)?;
        ensure!(
            metadata.is_dir()
                && !metadata.file_type().is_symlink()
                && private::owned_by_current_user(&metadata)
                && private::private_to_owner(&metadata, 0o077),
            "page proof cache is not private"
        );
        let mut options = fs::OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        let lease = private::no_follow(private::private(&mut options))
            .open(directory.join("cache.lock"))?;
        ensure!(
            private::owned_by_current_user(&lease.metadata()?)
                && private::private_to_owner(&lease.metadata()?, 0o077),
            "page proof cache lock is not private"
        );
        FileExt::try_lock_exclusive(&lease)?;
        let scope = serde_json::to_string(&(
            &config.site_url,
            &config.account_id,
            &config.workspace_id,
            &config.job_id,
        ))?;
        Ok(Self {
            path: directory.join(format!("{key}.json")),
            directory,
            scope,
            _lease: lease,
        })
    }
    fn load(&self) -> delivery::StatusCache {
        self.read().unwrap_or_default()
    }
    fn read(&self) -> Result<delivery::StatusCache> {
        let mut options = fs::OpenOptions::new();
        options.read(true);
        let file = private::no_follow(&mut options).open(&self.path)?;
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file()
                && metadata.len() <= MAX_BYTES as u64
                && private::owned_by_current_user(&metadata)
                && private::private_to_owner(&metadata, 0o077),
            "page proof cache is too large or not private"
        );
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= MAX_BYTES,
            "page proof cache grew while reading"
        );
        let entry: Entry = serde_json::from_slice(&bytes)?;
        ensure!(
            entry.scope == self.scope,
            "page proof cache belongs to another account or job"
        );
        Ok(entry.cache)
    }
    fn save(&self, cache: &delivery::StatusCache) -> Result<()> {
        let mut encoded = Limited {
            bytes: vec![],
            limit: MAX_BYTES,
        };
        if serde_json::to_writer(
            &mut encoded,
            &Saved {
                scope: &self.scope,
                cache,
            },
        )
        .is_err()
        {
            let _ = fs::remove_file(&self.path);
            return Ok(()); // Progress cannot fit; unknown remains explicitly pending.
        }
        self.write_private(&self.path, &encoded.bytes)?;
        self.prune()
    }
    fn write_private(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        let mut temporary = tempfile::NamedTempFile::new_in(&self.directory)?;
        private::set_mode(temporary.path(), 0o600)?;
        temporary.write_all(bytes)?;
        temporary.as_file().sync_all()?;
        temporary.persist(path).map_err(|e| e.error)?;
        Ok(())
    }
    fn read_lru(&self) -> Result<Vec<std::path::PathBuf>> {
        let mut options = fs::OpenOptions::new();
        options.read(true);
        let file = private::no_follow(&mut options).open(self.directory.join("lru.json"))?;
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file()
                && metadata.len() <= 1024
                && private::owned_by_current_user(&metadata)
                && private::private_to_owner(&metadata, 0o077),
            "invalid page cache recency file"
        );
        let mut bytes = vec![];
        file.take(1025).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 1024, "page cache recency file grew");
        let names: Vec<String> = serde_json::from_slice(&bytes)?;
        ensure!(
            names.len() <= MAX_ENTRIES
                && names.iter().all(|name| name
                    .strip_suffix(".json")
                    .is_some_and(|prefix| prefix.len() == 64
                        && prefix.bytes().all(|b| b.is_ascii_hexdigit()))),
            "invalid page cache recency entries"
        );
        Ok(names
            .into_iter()
            .map(|name| self.directory.join(name))
            .collect())
    }
    fn prune(&self) -> Result<()> {
        let mut entries = fs::read_dir(&self.directory)?
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let path = entry.path();
                if path.extension()?.to_str()? != "json" {
                    return None;
                }
                let name = path.file_stem()?.to_str()?;
                if name.len() != 64 || !name.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return None;
                }
                let metadata = fs::symlink_metadata(&path).ok()?;
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return None;
                }
                Some((metadata.modified().ok()?, path))
            })
            .collect::<Vec<_>>();
        let prior = self.read_lru().unwrap_or_default();
        // Filesystem clocks may tie. Logical recency keeps the just-written
        // entry and the actual last-used order, even on coarse CI clocks.
        entries.sort_by_key(|(modified, path)| {
            (
                path != &self.path,
                prior.iter().position(|p| p == path).unwrap_or(MAX_ENTRIES),
                std::cmp::Reverse(*modified),
                path.clone(),
            )
        });
        let retained = entries
            .iter()
            .take(MAX_ENTRIES)
            .filter_map(|(_, path)| path.file_name().and_then(|n| n.to_str()).map(str::to_owned))
            .collect::<Vec<_>>();
        for (_, path) in entries.into_iter().skip(MAX_ENTRIES) {
            let _ = fs::remove_file(path);
        }
        self.write_private(
            &self.directory.join("lru.json"),
            &serde_json::to_vec(&retained)?,
        )
    }
}
struct Limited {
    bytes: Vec<u8>,
    limit: usize,
}
impl Write for Limited {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "page proof cache limit reached",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(super) fn states(
    conn: &Connection,
    positions: &delivery::UploadPositions,
    settled: &[SessionIdentity],
    directory: &Path,
    config: &Config,
    budget: Duration,
    key: &str,
) -> Result<delivery::SessionStates> {
    let cache = Cache::open(directory, config, key).ok();
    let prior = cache.as_ref().map(Cache::load).unwrap_or_default();
    let states = delivery::session_states_within(conn, positions, settled, prior, budget)?;
    if let Some(cache) = cache {
        let _ = cache.save(&states.cache);
    }
    Ok(states)
}

#[cfg(test)]
mod tests {
    use super::super::super::tests::{acknowledge_everything, apply, fixture};
    use super::*;

    fn key(n: usize) -> String {
        format!("{n:064x}")
    }
    #[test]
    fn page_cache_keeps_proven_prefix_across_timeout_then_finishes_and_invalidates() {
        prove_page_cache(200);
    }
    #[test]
    #[ignore = "Explicit performance fixture; isolate from realtime watch deadlines"]
    fn large_catalog_cache_benchmark() {
        prove_page_cache(46_000);
    }

    fn prove_page_cache(catalog_size: usize) {
        let (directory, config) = fixture(SharingMode::All);
        let conn = db(directory.path()).unwrap();
        // Representative 46k catalog, with only 200 candidate identities.
        for range in [0..200, 200..catalog_size] {
            conn.execute_batch("BEGIN").unwrap();
            for id in range.clone() {
                conn.execute("INSERT INTO sessions(source,session_id,first_prompt) VALUES('codex',?, 'history')",[format!("rw_{id:06}")]).unwrap();
            }
            conn.execute_batch("COMMIT").unwrap();
            // Only candidates need proof. Unrelated catalog rows stay ahead of
            // the cursor; avoid delivering46k batches just to build this fixture.
            if range.start == 0 {
                acknowledge_everything(&conn, &config.job_id);
            }
        }
        // An unrelated append leaves the head ahead of the acknowledged cursor.
        conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES('claude','old','later',1,'user','text','synthetic')",[]).unwrap();
        let selected = (0..200)
            .map(|id| SessionIdentity {
                source: "codex".into(),
                session_id: format!("rw_{id:06}"),
            })
            .collect::<Vec<_>>();
        let positions = delivery::upload_positions(&conn, &config.job_id).unwrap();
        let cache_key = key(1);
        let started = std::time::Instant::now();
        let first = states(
            &conn,
            &positions,
            &selected[..1],
            directory.path(),
            &config,
            Duration::from_secs(5),
            &cache_key,
        )
        .unwrap();
        assert!(first.unknown.is_empty());
        let partial = states(
            &conn,
            &positions,
            &selected,
            directory.path(),
            &config,
            Duration::ZERO,
            &cache_key,
        )
        .unwrap();
        assert_eq!(partial.unknown.len(), 199);
        assert!(
            !partial.unknown.contains(&selected[0]),
            "Proven prefix must not be recomputed after timeout"
        );
        let finished = states(
            &conn,
            &positions,
            &selected,
            directory.path(),
            &config,
            Duration::from_secs(5),
            &cache_key,
        )
        .unwrap();
        assert!(finished.unknown.is_empty());
        let reused = states(
            &conn,
            &positions,
            &selected,
            directory.path(),
            &config,
            Duration::ZERO,
            &cache_key,
        )
        .unwrap();
        assert!(reused.unknown.is_empty());
        assert!(reused.waiting.is_empty());
        eprintln!(
            "{catalog_size} catalog / 200 candidate cached proof: {:?}",
            started.elapsed()
        );
        assert!(
            !directory.path().join(STATUS_CACHE).exists(),
            "Keyed queries must not parse or write the global proof file"
        );
        // Account scope cannot consume another account's persisted proof.
        let mut account = config.clone();
        account.account_id = "another-account".into();
        assert_eq!(
            states(
                &conn,
                &positions,
                &selected,
                directory.path(),
                &account,
                Duration::ZERO,
                &cache_key
            )
            .unwrap()
            .unknown
            .len(),
            200
        );
        states(
            &conn,
            &positions,
            &selected,
            directory.path(),
            &config,
            Duration::from_secs(5),
            &cache_key,
        )
        .unwrap();
        // The SDK invalidates proofs when policy/selection changes.
        conn.execute(
            "INSERT INTO delivery_exclusions(source,session_id) VALUES('claude','elsewhere')",
            [],
        )
        .unwrap();
        let changed = delivery::upload_positions(&conn, &config.job_id).unwrap();
        assert_eq!(
            states(
                &conn,
                &changed,
                &selected,
                directory.path(),
                &config,
                Duration::ZERO,
                &cache_key
            )
            .unwrap()
            .unknown
            .len(),
            200
        );
        conn.execute(
            "DELETE FROM delivery_exclusions WHERE session_id='elsewhere'",
            [],
        )
        .unwrap();
        let positions = delivery::upload_positions(&conn, &config.job_id).unwrap();
        states(
            &conn,
            &positions,
            &selected,
            directory.path(),
            &config,
            Duration::from_secs(5),
            &cache_key,
        )
        .unwrap();
        conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES('codex','rw_000000','changed',2,'user','text','synthetic')",[]).unwrap();
        assert!(states(
            &conn,
            &positions,
            &selected,
            directory.path(),
            &config,
            Duration::ZERO,
            &cache_key
        )
        .unwrap()
        .unknown
        .contains(&selected[0]));
    }
    #[test]
    fn busy_page_cache_never_waits_or_overwrites_another_requests_progress() {
        let (directory, config) = fixture(SharingMode::All);
        let conn = db(directory.path()).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES('claude','old','later',1,'user','text','synthetic')",[]).unwrap();
        let id = parse_key("codex:recent").unwrap();
        let positions = delivery::upload_positions(&conn, &config.job_id).unwrap();
        let cache_key = key(99);
        assert!(states(
            &conn,
            &positions,
            std::slice::from_ref(&id),
            directory.path(),
            &config,
            Duration::from_secs(5),
            &cache_key
        )
        .unwrap()
        .unknown
        .is_empty());
        let held = Cache::open(directory.path(), &config, &cache_key).unwrap();
        let bytes = fs::read(&held.path).unwrap();
        let (send, received) = std::sync::mpsc::channel();
        let (path, cloned_config, cloned_key, cloned_id) = (
            directory.path().to_path_buf(),
            config.clone(),
            cache_key.clone(),
            id.clone(),
        );
        let request = std::thread::spawn(move || {
            let conn = read_db(&path).unwrap();
            let positions = delivery::upload_positions(&conn, &cloned_config.job_id).unwrap();
            let result = states(
                &conn,
                &positions,
                std::slice::from_ref(&cloned_id),
                &path,
                &cloned_config,
                Duration::ZERO,
                &cloned_key,
            )
            .unwrap();
            send.send(result.unknown.contains(&cloned_id)).unwrap();
        });
        assert!(received
            .recv_timeout(Duration::from_secs(1))
            .expect("A bounded request must finish while another page holds the cache lease"));
        request.join().unwrap();
        assert_eq!(
            fs::read(&held.path).unwrap(),
            bytes,
            "A contended cache miss cannot replace retained progress"
        );
        drop(held);
        assert!(
            states(
                &conn,
                &positions,
                std::slice::from_ref(&id),
                directory.path(),
                &config,
                Duration::ZERO,
                &cache_key
            )
            .unwrap()
            .unknown
            .is_empty(),
            "The previously proven prefix remains available after contention"
        );
    }

    #[test]
    fn delegated_flag_is_snapshot_scoped_and_invalidates_cached_proof_basis() {
        let (directory, config) = fixture(SharingMode::Selected);
        let config = apply(directory.path(), config, None, &["claude:old"], true);
        let conn = db(directory.path()).unwrap();
        acknowledge_everything(&conn, &config.job_id);
        let id = parse_key("claude:old").unwrap();
        let before = delivery::upload_positions(&conn, &config.job_id).unwrap();
        assert!(!before.delegated(&id));
        let proven = states(
            &conn,
            &before,
            std::slice::from_ref(&id),
            directory.path(),
            &config,
            Duration::from_secs(5),
            &key(11),
        )
        .unwrap();
        assert!(proven.waiting.is_empty() && proven.unknown.is_empty());
        conn.execute("UPDATE delivery_session_members SET delegated=1 WHERE job_id=? AND source='claude' AND session_id='old'",[&config.job_id]).unwrap();
        let after = delivery::upload_positions(&conn, &config.job_id).unwrap();
        assert!(!before.delegated(&id));
        assert!(after.delegated(&id));
        assert!(
            states(
                &conn,
                &after,
                std::slice::from_ref(&id),
                directory.path(),
                &config,
                Duration::ZERO,
                &key(11)
            )
            .unwrap()
            .unknown
            .contains(&id),
            "Delegation participates in the exact proof invalidation basis"
        );
    }

    #[test]
    fn bounded_cache_prunes_and_rejects_oversize_or_unsafe_files() {
        let (directory, config) = fixture(SharingMode::All);
        for id in 0..6 {
            Cache::open(directory.path(), &config, &key(id))
                .unwrap()
                .save(&Default::default())
                .unwrap();
            // Deliberately collapse timestamps: recency must not depend on
            // filesystem clock resolution or directory iteration order.
            fs::OpenOptions::new()
                .write(true)
                .open(
                    directory
                        .path()
                        .join("query-proof-cache")
                        .join(format!("{}.json", key(id))),
                )
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(std::time::SystemTime::UNIX_EPOCH))
                .unwrap();
        }
        let folder = directory.path().join("query-proof-cache");
        assert_eq!(
            fs::read_dir(&folder)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|e| e.path().file_stem().is_some_and(|e| e.len() == 64))
                .count(),
            4
        );
        for id in 2..6 {
            assert!(
                folder.join(format!("{}.json", key(id))).exists(),
                "Logical LRU must retain the latest four entries despite tied timestamps"
            );
        }
        let cache = Cache::open(directory.path(), &config, &key(7)).unwrap();
        cache.save(&Default::default()).unwrap();
        assert!(private::private_to_owner(
            &fs::metadata(&cache.path).unwrap(),
            0o077
        ));
        let file = fs::OpenOptions::new()
            .write(true)
            .open(&cache.path)
            .unwrap();
        file.set_len(MAX_BYTES as u64 + 1).unwrap();
        assert!(cache.read().is_err());
        let mut limited = Limited {
            bytes: vec![],
            limit: 8,
        };
        assert!(limited.write_all(b"oversized family").is_err());
        assert!(limited.bytes.is_empty());
        #[cfg(unix)]
        {
            fs::remove_file(&cache.path).unwrap();
            let target = directory.path().join("outside");
            fs::write(&target, b"secret").unwrap();
            std::os::unix::fs::symlink(&target, &cache.path).unwrap();
            assert!(cache.read().is_err());
            assert_eq!(fs::read(&target).unwrap(), b"secret");
        }
    }
}
