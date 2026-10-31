use super::*;
use std::path::Path;
impl Uploader {
    pub async fn sessions_change(&self, include: bool, keys: &[String]) -> Result<Value, RpcError> {
        let keys = if include {
            keys.to_vec()
        } else {
            capturable_exclusions(keys)?
        };
        if keys.is_empty() {
            return Ok(json!({"updated":0}));
        }
        let install = self.install().ok_or_else(not_connected)?;
        if !include {
            Self::exclusion_ready(install.directory.as_deref())?;
        }
        self.sessions_change_for(&install.target, include, &keys)
            .await
    }

    fn exclusion_ready(directory: Option<&str>) -> Result<(), RpcError> {
        let ready = match directory {
            Some(directory) => ["history.db", "config.json"]
                .into_iter()
                .map(|name| Path::new(&directory).join(name).try_exists())
                .collect::<std::io::Result<Vec<_>>>()
                .map_err(|_| {
                    RpcError::new(
                        ErrorKind::UploaderFailed,
                        "Could not inspect session history.",
                    )
                })?
                .into_iter()
                .all(|exists| exists),
            None => false,
        };
        if !ready {
            return Err(RpcError::new(
                ErrorKind::Busy,
                "Session history is preparing. The exclusion will be retried.",
            ));
        }
        Ok(())
    }

    /// `sessions_change` on `target` itself, whatever is attached now, so
    /// keys read from one install never reach another.
    pub async fn sessions_change_for(
        &self,
        target: &Target,
        include: bool,
        keys: &[String],
    ) -> Result<Value, RpcError> {
        if keys.is_empty() {
            return Ok(json!({ "updated": 0 }));
        }
        if keys.iter().any(|key| !key.contains(':') || key.len() > 512) {
            return Err(RpcError::invalid_params(
                "Session keys are \"source:session_id\".",
            ));
        }
        let _changing = self.changing();
        self.runner
            .run(command::sessions_change(include, target, keys), None)
            .await?;
        Ok(json!({ "updated": keys.len() }))
    }
}

fn capturable_exclusions(keys: &[String]) -> Result<Vec<String>, RpcError> {
    #[cfg_attr(not(feature = "history"), allow(unused_mut))]
    let mut retained = vec![];
    for key in keys {
        let Some((source, id)) = key.split_once(':') else {
            return Err(RpcError::invalid_params(
                "Session keys are source:session_id.",
            ));
        };
        if source.is_empty() || id.is_empty() || key.len() > 512 || id.contains('\0') {
            return Err(RpcError::invalid_params(
                "Session keys are source:session_id.",
            ));
        }
        // Only a source the history capture can ingest needs an exclusion;
        // without the `history` feature nothing is captured.
        #[cfg(feature = "history")]
        if ai_hist::Source::parse(source).is_some_and(|s| s.as_str() == source) {
            retained.push(key.clone());
        }
    }
    Ok(retained)
}
#[cfg(all(test, feature = "history"))]
mod tests {
    use super::*;
    #[test]
    fn only_sdk_capture_sources_require_upload_exclusion() {
        assert_eq!(
            capturable_exclusions(&["codex:future".into(), "relay-only-fixture:future".into()])
                .unwrap(),
            ["codex:future"]
        );
        for invalid in ["missing-separator", ":missing-source", "codex:"] {
            assert!(capturable_exclusions(&[invalid.into()]).is_err());
        }
    }
    #[tokio::test]
    async fn missing_history_defers_denies_and_relay_only_identity_needs_no_uploader() {
        let root = tempfile::tempdir().unwrap();
        let uploader = Uploader::new(Arc::new(
            ProcessRunner::new(root.path().join("must-not-run")).with_env("HOME", root.path()),
        ));
        assert_eq!(
            uploader
                .sessions_change(false, &["relay-only-fixture:future".into()])
                .await
                .unwrap()["updated"],
            0
        );
        uploader.attach(Install::from_json(
            &json!({"site_url":"https://agentrelay.com","directory":root.path().to_str().unwrap()}),
        ));
        let keys = vec!["codex:future".into()];
        assert_eq!(
            uploader
                .sessions_change(false, &keys)
                .await
                .unwrap_err()
                .data
                .kind,
            ErrorKind::Busy
        );
        std::fs::write(root.path().join("config.json"), b"{}").unwrap();
        assert_eq!(
            uploader
                .sessions_change(false, &keys)
                .await
                .unwrap_err()
                .data
                .kind,
            ErrorKind::Busy
        );
        std::fs::write(root.path().join("history.db"), b"").unwrap();
        assert!(
            Uploader::exclusion_ready(uploader.install().unwrap().directory.as_deref()).is_ok()
        );
    }
}
