//! Routes that hand a session what it was sent but did not get whole: an
//! attachment that could not be fetched in time, and a message it was given
//! as a pointer (`message_pointer`).
//!
//! ```text
//! POST /attachments/fetch?file_id=<id>     save the file, answer its path
//! GET  /messages?ref=<12 hex>              the message's full text
//! ```

use super::{Outbound, OutboundError};
use crate::relay::files;
use crate::relay::message_pointer::{self, DeliveredTexts};
use crate::relay::state::now_ms;
use serde_json::{json, Value};

/// The probe a session runs for socket commands, reply hints and pointers'
/// `relay read` alike: this build's own executable, which every install has
/// without a skill, PATH change or link (the app bundle's helper on macOS,
/// the package's on Linux).
pub(crate) fn probe_executable() -> Option<std::path::PathBuf> {
    std::env::current_exe().ok()
}

impl Outbound {
    /// Saves a file the calling session was sent, as its own agent, and
    /// answers with where it is: the recovery route for an attachment that
    /// could not be fetched before its message was put into the session.
    pub async fn fetch_attachment(
        &self,
        pid: i32,
        uid: u32,
        query: &[(String, String)],
    ) -> Result<Value, OutboundError> {
        let file_id = query
            .iter()
            .rev()
            .find(|(k, _)| k == "file_id")
            .map(|(_, v)| v.as_str())
            .filter(|id| crate::relay::delivery::policy::is_plain_id(id))
            .ok_or_else(|| {
                OutboundError::new(
                    400,
                    "invalid_file_id",
                    "Name the file: ?file_id=<id> from the message's attachment.",
                )
            })?;
        let (session, registration, token) = self.authorize(pid, uid).await?;
        self.admit(&session.target.key())?;
        let source = files::RelaycastFiles::new(&registration.base_url, &token);
        let root = self.core.config.app_data_dir.join(files::ATTACHMENTS_DIR);
        let attachment = files::fetch_by_id(&source, &root, file_id, files::FETCH_TIMEOUT)
            .await
            .map_err(|reason| {
                OutboundError::new(
                    502,
                    "attachment_fetch_failed",
                    format!("Could not fetch {file_id}: {reason}."),
                )
            })?;
        let path = match &attachment.local {
            Some(Ok(path)) => path.display().to_string(),
            _ => String::new(),
        };
        Ok(json!({
            "file_id": attachment.file_id,
            "filename": attachment.filename,
            "content_type": attachment.content_type,
            "size_bytes": attachment.size_bytes,
            "path": path,
        }))
    }

    /// `GET /messages?ref=…`: the full text of a message the calling session
    /// was handed as a pointer. Only that session can read it.
    pub async fn read_message(
        &self,
        pid: i32,
        uid: u32,
        query: &[(String, String)],
    ) -> Result<Value, OutboundError> {
        let (session, _, _) = self.authorize(pid, uid).await?;
        let kept = DeliveredTexts::under(&self.core.config.app_data_dir);
        message_pointer::answer(&kept, &session.target.key(), query, now_ms())
            .map_err(|(status, code, message)| OutboundError::new(status, code, message))
    }
}
