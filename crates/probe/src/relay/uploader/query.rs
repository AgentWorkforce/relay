use super::*;
#[cfg(feature = "history")]
use std::hash::{Hash, Hasher};
#[cfg(feature = "history")]
mod observations;

#[cfg(feature = "history")]
fn query_failed() -> RpcError {
    RpcError::new(ErrorKind::Internal, "Session search stopped.")
}

impl Uploader {
    /// Runs in the helper so parsing a large local transcript cannot block delivery.
    pub async fn transcript(
        &self,
        request: crate::relay::contract::transcript::LocalTranscriptParams,
    ) -> Result<Value, RpcError> {
        let mut args = vec![
            "sessions".into(),
            "read".into(),
            "--json".into(),
            "--source".into(),
            request.source,
            "--session-id".into(),
            request.session_id,
        ];
        if let Some(cursor) = request.cursor {
            args.extend([
                "--after-ts".into(),
                cursor.ts_ms.to_string(),
                "--after-id".into(),
                cursor.id.to_string(),
            ]);
        }
        Ok(self.runner.run(args, Some(timeouts::SESSIONS)).await?)
    }

    #[cfg(feature = "history")]
    /// Query pages never increase the legacy listing/background working set.
    pub(crate) async fn sessions_query(
        &self,
        request: crate::relay::contract::account::SessionQueryParams,
        local: Vec<crate::relay::contract::agents::LocalSession>,
        archived: Arc<std::collections::BTreeSet<String>>,
        home: PathBuf,
        relay_home: PathBuf,
        names: &crate::relay::project::Names,
    ) -> Result<crate::relay::contract::account::SessionQueryPage, RpcError> {
        let _refresh = self.query_refresh.lock().await;
        let reader = self.query_reader().await?;
        let generation = self.changes.load(Ordering::SeqCst);
        // Status polling is independent. A cold/held status helper must not
        // delay catalog pages; completed status participates in the page token.
        let status_value = self
            .status_snapshot
            .lock()
            .map_err(|_| query_failed())?
            .as_ref()
            .filter(|(version, _)| *version == generation)
            .map(|(_, value)| value.clone());
        let mut token = std::collections::hash_map::DefaultHasher::new();
        generation.hash(&mut token);
        status_value
            .as_ref()
            .map(serde_json::Value::to_string)
            .hash(&mut token);
        let status_token = token.finish();
        let status = status_value.map(|value| {
            crate::session_model::StatusView::new(
                &crate::relay::contract::account::UploaderStatus::from_probe(&value),
            )
        });
        let install = self.install().ok_or_else(not_connected)?;
        let directory = PathBuf::from(install.directory.ok_or_else(not_connected)?);
        let catalog_path = directory.join("history.db");
        let candidates = self
            .query_candidates(
                &request,
                local,
                archived,
                directory,
                home,
                relay_home,
                names,
                status_token,
                reader.clone(),
            )
            .await?;
        let (candidates, version) = candidates;
        if generation != self.changes.load(Ordering::SeqCst) {
            return Err(RpcError::new(
                ErrorKind::Busy,
                "Session settings changed. Please try again.",
            ));
        }
        if request.known_revision == Some(version.revision) {
            return Ok(crate::relay::contract::account::SessionQueryPage {
                archived_keys: None,
                unchanged: true,
                verification_pending: false,
                sessions: vec![],
                local_sessions: vec![],
                next_cursor: None,
                revision: version.revision,
                candidates_scanned: 0,
            });
        }
        let candidates = candidates.ok_or_else(query_failed)?;
        let enriched = self.enrich_candidates(&candidates, &install.target).await?;
        if generation != self.changes.load(Ordering::SeqCst) {
            return Err(RpcError::new(
                ErrorKind::Busy,
                "Session settings changed. Please try again.",
            ));
        }
        let (candidates, version) = if request.cursor.is_none() {
            self.observed_snapshot(
                &request,
                candidates,
                enriched.observations,
                catalog_path,
                version,
                reader.clone(),
            )
            .await?
        } else {
            // Retained pages deliberately discard execution observations.
            (candidates, version)
        };
        let mut page = candidates.finish(&request, enriched.uploads, status.as_ref())?;
        page.revision = if page.verification_pending
            || page.sessions.iter().any(|row| {
                row.included
                    && row.status == crate::relay::contract::account::UploadShareStatus::Checking
            }) {
            0
        } else {
            version.revision
        };
        if generation != self.changes.load(Ordering::SeqCst) {
            return Err(RpcError::new(
                ErrorKind::Busy,
                "Session settings changed. Please try again.",
            ));
        }
        if !self
            .query_index
            .lock()
            .map_err(|_| query_failed())?
            .as_ref()
            .is_some_and(|(_, _, index)| index.settings_current())
        {
            return Err(RpcError::new(
                ErrorKind::Busy,
                "Session settings changed. Please try again.",
            ));
        }
        Ok(page)
    }

    #[cfg(feature = "history")]
    pub(crate) async fn sessions_facets(
        &self,
        request: crate::relay::contract::account::SessionFacetParams,
    ) -> Result<crate::relay::contract::account::SessionFacetsPage, RpcError> {
        let _refresh = self.query_refresh.lock().await;
        let reader = self.query_reader().await?;
        self.attached()?;
        let slot = self.query_index.clone();
        tokio::task::spawn_blocking(move || {
            let _reader = reader;
            let mut slot = slot.lock().map_err(|_| query_failed())?;
            let catalog = &mut slot
                .as_mut()
                .ok_or_else(|| {
                    RpcError::new(
                        ErrorKind::Busy,
                        "Session filters are preparing. Try again shortly.",
                    )
                })?
                .2;
            if let Err(error) = catalog.refresh() {
                *slot = None;
                return Err(error);
            }
            let result = catalog.index.facets(&request);
            if let Err(error) = catalog.retention_current() {
                *slot = None;
                return Err(error);
            }
            result
        })
        .await
        .map_err(|_| query_failed())?
    }
    #[cfg(feature = "history")]
    async fn query_reader(&self) -> Result<Arc<HistoryReader>, RpcError> {
        let slot = self.query_index.clone();
        self.register_history_reader_cleanup(
            "session-query",
            Arc::new(move || {
                *slot.lock().unwrap_or_else(|e| e.into_inner()) = None;
            }),
        );
        Ok(Arc::new(self.history_reader().await?))
    }
    #[cfg(feature = "history")]
    pub(super) fn clear_query_index(&self) -> Result<(), RpcError> {
        *self.query_index.lock().map_err(|_| query_failed())? = None;
        Ok(())
    }
    #[cfg(feature = "history")]
    async fn query_candidates(
        &self,
        request: &crate::relay::contract::account::SessionQueryParams,
        local: Vec<crate::relay::contract::agents::LocalSession>,
        archived: Arc<std::collections::BTreeSet<String>>,
        directory: PathBuf,
        home: PathBuf,
        relay_home: PathBuf,
        names: &crate::relay::project::Names,
        generation: u64,
        reader: Arc<HistoryReader>,
    ) -> Result<
        (
            Option<crate::relay::session_query::Candidates>,
            crate::relay::session_query::CatalogVersion,
        ),
        RpcError,
    > {
        let path = directory.join("history.db");
        let slot = self.query_index.clone();
        let opening_reader = reader.clone();
        let projects = tokio::task::spawn_blocking(move || {
            let _reader = opening_reader;
            let mut slot = slot.lock().map_err(|_| query_failed())?;
            if slot.as_ref().is_none_or(|(db, _, _)| db != &path) {
                *slot = Some((
                    path.clone(),
                    generation,
                    crate::relay::session_query::CatalogIndex::open(&path, &home, &relay_home)?,
                ));
            }
            let index = &mut slot.as_mut().ok_or_else(query_failed)?.2;
            let refresh = index.refresh().map(|_| index.needed_projects());
            match refresh {
                Ok(projects) => Ok::<_, RpcError>((projects, local, archived)),
                Err(error) => {
                    *slot = None;
                    Err(error)
                }
            }
        })
        .await
        .map_err(|_| RpcError::new(ErrorKind::Internal, "Session search stopped."))??;
        let (projects, local, archived) = projects;
        let resolved = names.list(projects.iter().map(String::as_str)).await;
        let slot = self.query_index.clone();
        let query = request.clone();
        let candidates = tokio::task::spawn_blocking(move || {
            let _reader = reader;
            let mut slot = slot.lock().map_err(|_| query_failed())?;
            let index = &mut slot.as_mut().ok_or_else(query_failed)?.2;
            index.resolve_projects(resolved)?;
            index.index.live(
                local,
                archived,
                query.presentation.clone().unwrap_or_default(),
            )?;
            let version = index.version(&query, generation)?;
            let candidates = if query.known_revision == Some(version.revision) {
                None
            } else {
                Some(index.index.candidates(&query)?)
            };
            Ok::<_, RpcError>((candidates, version))
        })
        .await
        .map_err(|_| RpcError::new(ErrorKind::Internal, "Session search stopped."))??;
        Ok(candidates)
    }

    #[cfg(feature = "history")]
    async fn enrich_candidates(
        &self,
        candidates: &crate::relay::session_query::Candidates,
        target: &Target,
    ) -> Result<observations::Enriched, RpcError> {
        let keys: Vec<_> = candidates
            .rows
            .iter()
            .filter_map(|row| row.upload.as_ref().map(|_| row.key()))
            .collect();
        let enriched = if keys.is_empty() {
            observations::Enriched::default()
        } else {
            let mut args = command::sessions_list(target, crate::relay::session_query::PAGE_ROWS);
            for key in &keys {
                args.extend(["--key".into(), key.clone()]);
            }
            args.extend([
                "--proof-cache-key".into(),
                candidates.proof_cache_key.clone(),
            ]);
            let value = self.runner.run(args, Some(timeouts::SESSIONS)).await?;
            observations::decode(value, &keys)?
        };
        Ok(enriched)
    }
}

/// Without the `history` feature there is no session catalog to search.
#[cfg(not(feature = "history"))]
impl Uploader {
    fn catalog_unavailable() -> RpcError {
        RpcError::history_unavailable()
    }

    pub(crate) async fn sessions_query(
        &self,
        _request: crate::relay::contract::account::SessionQueryParams,
        _local: Vec<crate::relay::contract::agents::LocalSession>,
        _archived: Arc<std::collections::BTreeSet<String>>,
        _home: PathBuf,
        _relay_home: PathBuf,
        _names: &crate::relay::project::Names,
    ) -> Result<crate::relay::contract::account::SessionQueryPage, RpcError> {
        Err(Self::catalog_unavailable())
    }

    pub(crate) async fn sessions_facets(
        &self,
        _request: crate::relay::contract::account::SessionFacetParams,
    ) -> Result<crate::relay::contract::account::SessionFacetsPage, RpcError> {
        Err(Self::catalog_unavailable())
    }

    pub(super) fn clear_query_index(&self) -> Result<(), RpcError> {
        Ok(())
    }
}

#[cfg(all(test, feature = "history"))]
mod tests {
    use super::*;
    use std::future::Future;

    mod retention;
    #[tokio::test]
    async fn cancelled_query_keeps_reset_blocked_until_real_index_work_exits() {
        let root = tempfile::tempdir().unwrap();
        let uploader = Arc::new(Uploader::new(Arc::new(
            ProcessRunner::new(root.path().join("unused")).with_env("HOME", root.path()),
        )));
        let reader = uploader.query_reader().await.unwrap();
        let (opened, ready) = tokio::sync::oneshot::channel();
        let (release, hold) = std::sync::mpsc::channel();
        let worker = tokio::task::spawn_blocking(move || {
            let _reader = reader;
            opened.send(()).unwrap();
            hold.recv().unwrap();
        });
        let awaiting = tokio::spawn(async move { worker.await.unwrap() });
        ready.await.unwrap();
        awaiting.abort();
        assert!(awaiting.await.unwrap_err().is_cancelled());
        let (attempted, attempt) = tokio::sync::oneshot::channel();
        let reset = {
            let uploader = uploader.clone();
            tokio::spawn(async move {
                let mut waiting = Box::pin(uploader.suspend_background_readers());
                let mut attempted = Some(attempted);
                futures_util::future::poll_fn(move |cx| {
                    let polled = waiting.as_mut().poll(cx);
                    if let Some(attempted) = attempted.take() {
                        let _ = attempted.send(polled.is_pending());
                    }
                    polled
                })
                .await
            })
        };
        assert!(
            attempt.await.unwrap(),
            "reset must reach the held reader barrier"
        );
        assert!(!reset.is_finished());
        assert!(tokio::time::timeout(Duration::from_millis(25), async {
            while !reset.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .is_err());
        release.send(()).unwrap();
        let _writer = tokio::time::timeout(Duration::from_secs(5), reset)
            .await
            .unwrap()
            .unwrap();
    }
}
