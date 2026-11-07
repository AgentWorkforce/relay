//! The files a session's `POST /send` attaches: named as absolute paths,
//! read from where its agent may send files ([`files::confine`]) and
//! uploaded as its agent before the message is sent.

use super::OutboundError;
use crate::relay::files;
use crate::relay::workspace::Secret;
use serde_json::{Map, Value};

/// The local paths a send's optional `"files"` names: a list of one to
/// [`files::MAX_SEND_FILES`] strings.
pub(super) fn requested_files(request: &Map<String, Value>) -> Result<Vec<String>, OutboundError> {
    let Some(value) = request.get("files") else {
        return Ok(Vec::new());
    };
    let invalid = || {
        OutboundError::new(
            400,
            "invalid_files",
            format!(
                "\"files\" must be a list of 1 to {} absolute file paths.",
                files::MAX_SEND_FILES
            ),
        )
    };
    let list = value.as_array().ok_or_else(invalid)?;
    if list.is_empty() || list.len() > files::MAX_SEND_FILES {
        return Err(invalid());
    }
    list.iter()
        .map(|path| {
            path.as_str()
                .filter(|path| !path.is_empty())
                .map(str::to_string)
                .ok_or_else(invalid)
        })
        .collect()
}

/// A file uploaded for a send.
pub(super) struct Attached {
    pub(super) file_id: String,
    pub(super) filename: String,
    pub(super) content_type: &'static str,
    pub(super) size_bytes: u64,
}

/// Reads and uploads each path, in order, as the agent holding `token`,
/// from where an agent working in `directory` may send files.
pub(super) async fn upload_files(
    base_url: &str,
    token: &Secret,
    paths: Vec<String>,
    (directory, config): (Option<String>, &crate::relay::daemon::Config),
) -> Result<Vec<Attached>, OutboundError> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let (home, app_data) = (config.home.clone(), config.app_data_dir.clone());
    let read = tokio::task::spawn_blocking(move || {
        let confine = files::AgentFiles::new(directory.as_deref(), &home, &app_data);
        paths
            .iter()
            .map(|path| files::read_agent_file(path, &confine))
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|_| OutboundError::new(500, "invalid_files", "The files could not be read."))?;
    let local = read.map_err(|error| match error {
        files::LocalFileError::TooLarge(message) => {
            OutboundError::new(413, "file_too_large", message)
        }
        files::LocalFileError::Invalid(message) => {
            OutboundError::new(400, "invalid_files", message)
        }
        files::LocalFileError::NotAllowed(message) => {
            OutboundError::new(403, "file_not_allowed", message)
        }
    })?;
    let mut attached = Vec::new();
    for file in &local {
        let file_id = files::upload(base_url, token, file)
            .await
            .map_err(|error| {
                OutboundError::new(
                    error.status,
                    "attachment_upload_failed",
                    format!(
                        "Could not upload {}: {}. Nothing was sent.",
                        file.filename, error.reason
                    ),
                )
            })?;
        attached.push(Attached {
            file_id,
            filename: file.filename.clone(),
            content_type: file.content_type,
            size_bytes: file.bytes.len() as u64,
        });
    }
    Ok(attached)
}
