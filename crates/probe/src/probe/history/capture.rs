//! Recent-first scheduling and targeted hydration through the history SDK.
use super::*;

pub(super) fn prioritize(
    db: &Path,
    store: &SessionStore,
    stop: &Stop,
    observer: &dyn Fn(CaptureProgress),
) -> Result<()> {
    // Initial full capture must not follow provider or filename order. Shallow
    // discovery is cheap and already newest-first; hydrate its uncaptured rows
    // in that same global order before the compatibility sweep below.
    if let Err(error) = capture_uncaptured_newest_first(db, store, stop, observer) {
        if stop.stopped() {
            return Err(cancelled());
        }
        eprintln!(
            "{}",
            serde_json::json!({
                "operation": "capture", "stage": "recent_history",
                "error_class": crate::probe::collector::capture_error_class(&error)
            })
        );
    }
    if stop.stopped() {
        return Err(cancelled());
    }
    Ok(())
}

/// Descending activity naturally visits the last 24 hours, the rest of the
/// week, then older history. Drain the catalog snapshot before writing so a
/// long backfill does not pin the WAL. Full rows survive interruption and are
/// skipped on resume. The normal sweep still captures sessionless evidence and
/// retries providers whose targeted hydration is unavailable.
fn capture_uncaptured_newest_first(
    db: &Path,
    store: &SessionStore,
    stop: &Stop,
    observer: &dyn Fn(CaptureProgress),
) -> Result<()> {
    let token = stop.token();
    discover(db, None, move || token.is_stopped())?;
    let pending = store
        .sessions(CatalogQuery::default())
        .filter_map(|row| match row {
            // A transcript deleted from disk can never hydrate; retrying it
            // every cycle held back the sessions still being written.
            Ok(row)
                if row.discovery_state == DiscoveryState::Shallow
                    && !transcript_gone(row.raw_path.as_deref()) =>
            {
                Some(Ok((row.source, row.session_id)))
            }
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<Vec<_>, _>>()?;
    for (index, (source, session_id)) in pending.iter().enumerate() {
        if stop.stopped() {
            return Err(cancelled());
        }
        // One broken transcript must not keep other recent sessions waiting.
        if let Err(error) = hydrate_with_stop(db, *source, session_id, stop) {
            if stop.stopped() {
                return Err(cancelled());
            }
            eprintln!(
                "{}",
                serde_json::json!({
                    "operation": "capture", "stage": "recent_history", "source": source.as_str(),
                    "error_class": crate::probe::collector::capture_error_class(&error)
                })
            );
        }
        observer(CaptureProgress {
            source: "history".into(),
            processed_files: index + 1,
            total_files: Some(pending.len()),
        });
    }
    Ok(())
}

/// A local transcript path the catalog still lists after the file is gone. A
/// remote session's `raw_path` is a URL, not an absolute path, so it never
/// matches. Only a transcript the filesystem says is not there counts: one
/// that cannot be read (a permission error) is still retried and reported.
fn transcript_gone(raw_path: Option<&Path>) -> bool {
    raw_path.is_some_and(|path| {
        path.is_absolute()
            && std::fs::symlink_metadata(path)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_missing_local_transcript_counts_as_gone() {
        let dir = std::env::temp_dir().join(format!("transcript-gone-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let present = dir.join("present.jsonl");
        std::fs::write(&present, "").unwrap();
        assert!(!transcript_gone(Some(&present)));
        assert!(transcript_gone(Some(&dir.join("deleted.jsonl"))));
        assert!(!transcript_gone(Some(Path::new(
            "https://claude.ai/code/cse_01abc"
        ))));
        assert!(!transcript_gone(None));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

pub(super) fn hydrate_with_stop(
    db: &Path,
    source: Source,
    session_id: &str,
    stop: &Stop,
) -> Result<()> {
    let store = open(db)?;
    hydrate_store(store, source, session_id, stop, |roots| {
        Ok(extra_claude_roots(roots))
    })
}

/// Retained selected capture supplies the validated base and extra roots.
pub(super) fn hydrate_store(
    store: SessionStore,
    source: Source,
    session_id: &str,
    stop: &Stop,
    extra: impl FnOnce(&ProviderRoots) -> Result<Vec<ProviderRoots>>,
) -> Result<()> {
    let mut options = HydrateOptions::default();
    options.include_related = true;
    options.stop = Some(stop.token());
    let session = SessionRef::id(source, session_id);
    // A session observed only remotely has no local provider to hydrate
    // from; its connector acquires the evidence and lands it through
    // source intake, fenced by the observation's revision.
    if crate::probe::remote_sources::remote_only(&store, source, session_id)? {
        let stop_remote = || stop.stopped();
        let hydrated = crate::probe::remote_sources::hydrate(
            &store,
            store.roots().home.as_path(),
            source.as_str(),
            session_id,
            stop_remote,
        )?;
        if stop.stopped() {
            return Err(ai_hist::Error::Cancelled("remote capture cancelled".into()).into());
        }
        return match hydrated {
            Some(_) => Ok(()),
            None => Err(ai_hist::Error::ConnectorNotConfigured(format!(
                "no remote source connector can hydrate {session_id}; its provider is not signed in"
            ))
            .into()),
        };
    }
    let error = match store.hydrate(&session, options.clone()) {
        Ok(_) => return Ok(()),
        Err(error) => error,
    };
    // A Claude session in another config folder is read only by a store
    // over that folder, which is where its transcript is accepted from.
    if source == Source::Claude && !stop.stopped() {
        for extra in extra(store.roots())? {
            if open_with(store.db_path(), extra)?
                .hydrate(&session, options.clone())
                .is_ok()
            {
                return Ok(());
            }
        }
    }
    Err(error.into())
}
