use super::*;

pub(crate) struct Index {
    pub(super) db: Connection,
    pub(super) revision: u64,
    pub(super) live: HashSet<String>,
    pub(super) epoch: u64,
    pub(super) floor: u64,
    pub(super) retired: usize,
    pub(super) archived: std::sync::Arc<std::collections::BTreeSet<String>>,
    #[cfg(test)]
    pub(super) archive_inputs_examined: usize,
    #[cfg(test)]
    pub(super) candidate_selections: std::cell::Cell<usize>,
    pub(super) facet_revision: u64,
    pub(super) presentation: crate::relay::contract::account::SessionQueryPresentation,
}
impl Index {
    pub(crate) fn epoch(&self) -> u64 {
        self.epoch
    }
    pub(crate) fn revision(&self) -> u64 {
        self.revision
    }
    pub(super) fn observe_execution(
        &mut self,
        key: &str,
        observation: &ExecutionObservation,
    ) -> Result<bool, RpcError> {
        let Some(mut row) = self.get(key)? else {
            return Ok(false);
        };
        let Some(upload) = row.upload.as_mut() else {
            return Ok(false);
        };
        upload.models = Some(vec![observation.model.clone()]);
        upload.reasoning_effort = observation.reasoning_effort.clone();
        self.put(row)?;
        Ok(true)
    }
    pub fn new() -> Result<Self, RpcError> {
        let db = Connection::open_in_memory().map_err(|_| failed())?;
        let mut schema = "CREATE TABLE rows(key TEXT NOT NULL, payload TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER,archived INTEGER NOT NULL".to_owned();
        for column in SORTS {
            for direction in ["asc", "desc"] {
                schema.push_str(&format!(",order_{column}_{direction} TEXT NOT NULL"));
            }
        }
        schema.push_str("); CREATE UNIQUE INDEX current_key ON rows(key) WHERE valid_to IS NULL; CREATE INDEX retired ON rows(valid_to); CREATE VIRTUAL TABLE search USING fts5(text, tokenize='trigram case_sensitive 1');");
        schema.push_str(" CREATE TABLE facets(field TEXT,value TEXT,count INTEGER NOT NULL,PRIMARY KEY(field,value));");
        db.execute_batch(&schema).map_err(|_| failed())?;
        for column in SORTS {
            for direction in ["asc", "desc"] {
                db.execute_batch(&format!(
                    "CREATE INDEX sort_{column}_{direction} ON rows(order_{column}_{direction})"
                ))
                .map_err(|_| failed())?;
            }
        }
        let epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        Ok(Self {
            db,
            revision: 1,
            live: HashSet::new(),
            epoch,
            floor: 0,
            retired: 0,
            archived: Default::default(),
            #[cfg(test)]
            archive_inputs_examined: 0,
            #[cfg(test)]
            candidate_selections: std::cell::Cell::new(0),
            facet_revision: 1,
            presentation: Default::default(),
        })
    }

    pub(super) fn get(&self, key: &str) -> Result<Option<LocalSessionRow>, RpcError> {
        self.db
            .query_row(
                "SELECT payload FROM rows WHERE key=? AND valid_to IS NULL",
                [key],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| failed())?
            .map(|s| serde_json::from_str(&s).map_err(|_| failed()))
            .transpose()
    }
    pub(super) fn remove(&mut self, key: &str) -> Result<(), RpcError> {
        let previous = self.get(key)?;
        self.adjust_facets(previous.as_ref(), None)?;
        self.retire(key)
    }
    fn retire(&mut self, key: &str) -> Result<(), RpcError> {
        self.revision += 1;
        self.retired += self
            .db
            .execute(
                "UPDATE rows SET valid_to=? WHERE key=? AND valid_to IS NULL",
                params![self.revision, key],
            )
            .map_err(|_| failed())?;
        // Retain recent versions so unrelated incoming changes do not invalidate
        // an open cursor. Expire old cursors explicitly when the bounded history fills.
        if self.retired > 10000 {
            let cutoff: Option<u64> = self.db.query_row("SELECT valid_to FROM rows WHERE valid_to IS NOT NULL ORDER BY valid_to DESC LIMIT 1 OFFSET 9000", [], |r| r.get(0)).optional().map_err(|_| failed())?;
            if let Some(cutoff) = cutoff {
                self.db
                .execute(
                    "DELETE FROM search WHERE rowid IN (SELECT rowid FROM rows WHERE valid_to<=?)",
                    [cutoff],
                )
                .map_err(|_| failed())?;
                self.db
                    .execute("DELETE FROM rows WHERE valid_to<=?", [cutoff])
                    .map_err(|_| failed())?;
                self.floor = cutoff;
                self.retired = self
                    .db
                    .query_row(
                        "SELECT COUNT(*) FROM rows WHERE valid_to IS NOT NULL",
                        [],
                        |r| r.get(0),
                    )
                    .map_err(|_| failed())?;
            }
        }
        Ok(())
    }
    pub fn put(&mut self, row: LocalSessionRow) -> Result<(), RpcError> {
        self.put_with_context(row, false)
    }
    fn put_with_context(&mut self, row: LocalSessionRow, changed: bool) -> Result<(), RpcError> {
        let key = row.key();
        let payload = serde_json::to_string(&row).map_err(|_| failed())?;
        let previous = self.get(&key)?;
        if !changed && previous.as_ref() == Some(&row) {
            return Ok(());
        }
        self.adjust_facets(previous.as_ref(), Some(&row))?;
        self.retire(&key)?;
        let normalize = |s: String| (!s.is_empty() && s != "—").then(|| s.to_lowercase());
        let number = |n: Option<i64>| n.map(|n| format!("{:020}", n as i128 - i64::MIN as i128));
        let status = if self.archived.contains(&key) {
            "archived"
        } else {
            match row.relay.as_ref() {
                Some(local) if local.running != Some(false) => {
                    if local.live
                        && !local
                            .registration
                            .as_ref()
                            .is_some_and(|r| self.presentation.idle_names.contains(&r.name))
                    {
                        "active"
                    } else {
                        "idle"
                    }
                }
                _ => "finished",
            }
        };
        let on_relay = row.relay.as_ref().map(|s| {
            self.presentation
                .relay_states
                .get(&key)
                .copied()
                .unwrap_or(s.registration.is_some())
        });
        let included = row.upload.as_ref().map(|s| {
            self.presentation
                .upload_states
                .get(&key)
                .copied()
                .unwrap_or(s.included)
        });
        let reasoning = normalize(row.reasoning().into()).map(|value| {
            let rank = [
                "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
            ]
            .iter()
            .position(|v| *v == value)
            .unwrap_or(99);
            format!("{rank:02} {value}")
        });
        let fields = [
            normalize(row.title()),
            normalize(row.project()),
            Some(status.into()),
            number(row.updated()),
            on_relay.map(|v| if v { "1" } else { "0" }.into()),
            included.map(|v| if v { "1" } else { "0" }.into()),
            Some(row.source().to_lowercase()),
            normalize(row.model_name()),
            reasoning,
            number(row.created_at()),
            normalize(row.directory()),
            Some(row.session_id().to_lowercase()),
        ];
        let text = format!(
            "{} {} {} {} {} {}",
            row.title(),
            row.source(),
            row.project(),
            row.directory(),
            key,
            row.agent_names()
        )
        .to_lowercase();
        let mut values: Vec<rusqlite::types::Value> = vec![
            key.clone().into(),
            payload.into(),
            (self.revision as i64).into(),
            rusqlite::types::Value::Null,
            self.archived.contains(&key).into(),
        ];
        for field in fields {
            for ascending in [true, false] {
                values.push(order_key(field.as_deref(), &key, ascending).into());
            }
        }
        let placeholders = vec!["?"; values.len()].join(",");
        self.db
            .execute(
                &format!("INSERT INTO rows VALUES({placeholders})"),
                rusqlite::params_from_iter(values),
            )
            .map_err(|_| failed())?;
        self.db
            .execute(
                "INSERT INTO search(rowid,text) VALUES(?,?)",
                params![self.db.last_insert_rowid(), text],
            )
            .map_err(|_| failed())?;
        Ok(())
    }
    pub fn live(
        &mut self,
        rows: Vec<LocalSession>,
        archived: std::sync::Arc<std::collections::BTreeSet<String>>,
        presentation: crate::relay::contract::account::SessionQueryPresentation,
    ) -> Result<(), RpcError> {
        let changed_overrides: HashSet<String> = self
            .presentation
            .relay_states
            .keys()
            .chain(presentation.relay_states.keys())
            .chain(self.presentation.upload_states.keys())
            .chain(presentation.upload_states.keys())
            .cloned()
            .collect();
        let changed_overrides: HashSet<_> = changed_overrides
            .into_iter()
            .filter(|key| {
                self.presentation.relay_states.get(key) != presentation.relay_states.get(key)
                    || self.presentation.upload_states.get(key)
                        != presentation.upload_states.get(key)
            })
            .collect();
        let idle_changed = self.presentation.idle_names != presentation.idle_names;
        self.presentation = presentation;
        let changed_archive: HashSet<_> = if std::sync::Arc::ptr_eq(&self.archived, &archived) {
            HashSet::new()
        } else {
            #[cfg(test)]
            {
                self.archive_inputs_examined += self.archived.len() + archived.len();
            }
            self.archived
                .symmetric_difference(&archived)
                .cloned()
                .collect()
        };
        self.archived = archived;
        let mut live = HashMap::new();
        for row in rows {
            let key = row.target.upload_key().unwrap_or_else(|| row.target.key());
            let kept = live.entry(key).or_insert(row.clone());
            if row.live {
                *kept = row;
            }
        }
        let old = std::mem::take(&mut self.live);
        for key in old
            .iter()
            .chain(live.keys())
            .chain(changed_archive.iter())
            .chain(changed_overrides.iter())
            .collect::<HashSet<_>>()
        {
            let previous = self.get(key)?;
            let upload = previous.as_ref().and_then(|r| r.upload.clone());
            let relay = live.get(key).cloned();
            if upload.is_some() || relay.is_some() {
                let changed = changed_overrides.contains(key)
                    || changed_archive.contains(key)
                    || (idle_changed && relay.is_some());
                self.put_with_context(LocalSessionRow { upload, relay }, changed)?;
            } else {
                self.remove(key)?;
            }
        }
        self.live = live.into_keys().collect();
        Ok(())
    }

    fn cursor(&self, request: &SessionQueryParams) -> Result<(u64, Option<Cursor>, u64), RpcError> {
        if request.sort == "reasoning" {
            return Err(RpcError::invalid_params("Reasoning sort is unavailable because local history does not record session reasoning effort."));
        }
        if request.query.len() > 4096 || request.hidden.len() > 100_000 {
            return Err(RpcError::invalid_params("The session query is too large."));
        }
        let mut fingerprint = std::collections::hash_map::DefaultHasher::new();
        (
            &request.query,
            &request.sort,
            request.ascending,
            &request.hidden,
            request.presentation.as_ref().map(|p| &p.preparing),
        )
            .hash(&mut fingerprint);
        let fingerprint = fingerprint.finish();
        let cursor: Option<Cursor> = request
            .cursor
            .as_ref()
            .map(|s| {
                serde_json::from_str(s)
                    .map_err(|_| RpcError::invalid_params("Invalid session cursor."))
            })
            .transpose()?;
        if cursor.as_ref().is_some_and(|c| {
            c.epoch != self.epoch
                || c.revision < self.floor
                || c.revision > self.revision
                || c.query != fingerprint
        }) {
            return Err(stale());
        }
        let snapshot = cursor.as_ref().map_or(self.revision, |c| c.revision);
        Ok((fingerprint, cursor, snapshot))
    }
    pub fn candidates(&self, request: &SessionQueryParams) -> Result<Candidates, RpcError> {
        #[cfg(test)]
        self.candidate_selections
            .set(self.candidate_selections.get() + 1);
        let (fingerprint, cursor, snapshot) = self.cursor(request)?;
        use sha2::{Digest, Sha256};
        let proof_cache_key = cursor
            .as_ref()
            .and_then(|c| c.proof_cache_key.clone())
            .unwrap_or_else(|| {
                format!(
                    "{:x}",
                    Sha256::digest(
                        format!(
                            "{}:{snapshot}:{fingerprint}:{}",
                            self.epoch,
                            request.cursor.as_deref().unwrap_or_default()
                        )
                        .as_bytes()
                    )
                )
            });
        let column = SORTS
            .iter()
            .copied()
            .find(|s| *s == request.sort)
            .unwrap_or("updated");
        let direction = if request.ascending { "asc" } else { "desc" };
        let order = format!("order_{column}_{direction}");
        let mut predicates = vec![format!(
            "valid_from<={snapshot} AND (valid_to IS NULL OR valid_to>{snapshot})"
        )];
        let mut values = Vec::<rusqlite::types::Value>::new();
        // A required substring supplies indexed candidates. The shared parser
        // still checks every exact predicate, including exclusions and OR groups.
        let parsed = LocalSessionQuery::new(&request.query);
        if let Some(term) = parsed.terms.iter().find(|t| {
            !t.excluded
                && matches!(
                    t.field.as_deref(),
                    None | Some("title" | "path" | "id" | "agent")
                )
                && t.value.chars().count() >= 3
                && !t.value.starts_with('@')
        }) {
            predicates.push("rowid IN (SELECT rowid FROM search WHERE search MATCH ?)".to_string());
            values.push(format!("\"{}\"", term.value.to_lowercase().replace('"', "\"\"")).into());
        }
        if let Some(cursor) = cursor {
            predicates.push(format!("{order}>?"));
            values.push(cursor.value.unwrap_or_default().into());
        }
        let predicate = if predicates.is_empty() {
            "1".into()
        } else {
            predicates.join(" AND ")
        };
        let limit = request.limit.unwrap_or(PAGE_ROWS).clamp(1, PAGE_ROWS);
        let sql = page_sql(column, direction, &predicate, limit + 1);
        let mut stmt = self.db.prepare(&sql).map_err(|_| failed())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, bool>(3)?,
                ))
            })
            .map_err(|_| failed())?;
        let mut result = Candidates {
            live_epoch: self.epoch,
            live_revision: self.revision,
            proof_cache_key,
            rows: vec![],
            snapshot_archived: HashSet::new(),
            cursors: vec![],
            more: false,
            revision: snapshot,
            start_cursor: request.cursor.clone().unwrap_or(
                serde_json::to_string(&Cursor {
                    epoch: self.epoch,
                    revision: snapshot,
                    query: fingerprint,
                    value: Some(String::new()),
                    key: String::new(),
                    proof_cache_key: None,
                })
                .map_err(|_| failed())?,
            ),
        };
        for row in rows {
            let (key, payload, value, archived) = row.map_err(|_| failed())?;
            if result.rows.len() == limit {
                result.more = true;
                break;
            }
            if archived {
                result.snapshot_archived.insert(key.clone());
            }
            let row: LocalSessionRow = serde_json::from_str(&payload).map_err(|_| failed())?;
            result.rows.push(row);
            result.cursors.push(
                serde_json::to_string(&Cursor {
                    epoch: self.epoch,
                    revision: snapshot,
                    query: fingerprint,
                    value,
                    key,
                    proof_cache_key: None,
                })
                .map_err(|_| failed())?,
            );
        }
        Ok(result)
    }
}
