//! Files on Relaycast messages: what a relayed message carries is saved on
//! this computer so the session it is put into can open it, and what a
//! session sends through the relay-send socket is uploaded first.
//!
//! ```text
//! inbound:  GET /v1/files/{id} (agent token) → {download_url, …} → GET download_url
//!           → <app data>/attachments/<file_id>/<name>
//! outbound: POST /v1/files/upload {filename, content_type, size_bytes} → {file_id, upload_url}
//!           → PUT upload_url (the bytes) → POST /v1/files/{id}/complete
//! ```
//!
//! Neither direction ever logs or reports a token or a signed address: a
//! failure is reported by HTTP status or as a fixed short reason. What an
//! agent may send is confined ([`confine`]); what arrives is kept privately,
//! within quotas, for a week ([`store`]).

use crate::relay::delivery::policy::{Attachment, Delivery};
use crate::relay::sdk_gaps;
use crate::relay::workspace::Secret;
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub mod confine;
pub mod store;

pub use confine::{read_agent_file, AgentFiles};
pub use store::Sender;

/// The largest file saved for a session or sent by one.
pub const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
/// How long a delivery waits for its attachments, all together, before it is
/// put into the session with whatever was saved.
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20);
/// How long one upload's `PUT` may take.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(60);
/// The most files one `POST /send` may carry.
pub const MAX_SEND_FILES: usize = 5;
/// Under the app data directory.
pub const ATTACHMENTS_DIR: &str = "attachments";

/// What Relaycast says about one file: `GET /v1/files/{id}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteFile {
    pub download_url: String,
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub size_bytes: Option<u64>,
    pub status: Option<String>,
}

impl RemoteFile {
    /// Read leniently: `download_url` (or `url`) is required.
    pub fn from_value(data: &Value) -> Option<RemoteFile> {
        let url = ["download_url", "url"]
            .iter()
            .find_map(|key| data[*key].as_str().filter(|u| !u.is_empty()))?;
        let text = |key: &str| {
            data[key]
                .as_str()
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        };
        Some(RemoteFile {
            download_url: url.to_string(),
            filename: text("filename"),
            content_type: text("content_type"),
            size_bytes: data["size_bytes"]
                .as_u64()
                .or_else(|| data["size"].as_u64()),
            status: data["status"].as_str().map(str::to_string),
        })
    }

    /// Whether the uploader has not finished: there is nothing to fetch yet.
    fn is_pending(&self) -> bool {
        matches!(
            self.status.as_deref(),
            Some("pending" | "uploading" | "awaiting_upload")
        )
    }
}

/// Where attachment bytes come from; Relaycast in production.
pub trait FileSource: Send + Sync {
    fn file<'a>(&'a self, file_id: &'a str) -> BoxFuture<'a, Result<RemoteFile, String>>;
    /// The bytes at `url`, refusing more than `max_bytes` and waiting no
    /// longer than the caller's remaining budget.
    fn download<'a>(
        &'a self,
        url: &'a str,
        max_bytes: u64,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<Vec<u8>, String>>;
}

/// Relaycast's file routes with the credential a delivery was read with.
pub struct RelaycastFiles {
    base_url: String,
    token: Secret,
}

impl RelaycastFiles {
    pub fn new(base_url: &str, token: &Secret) -> RelaycastFiles {
        RelaycastFiles {
            base_url: base_url.to_string(),
            token: token.clone(),
        }
    }
}

/// A Relaycast failure in a few words: its status, never its message.
fn relaycast_reason(what: &str, error: &relaycast::RelayError) -> String {
    match error.status() {
        Some(status) => format!("{what} failed (HTTP {status})"),
        None => format!("{what} failed (Agent Relay unreachable)"),
    }
}

impl FileSource for RelaycastFiles {
    fn file<'a>(&'a self, file_id: &'a str) -> BoxFuture<'a, Result<RemoteFile, String>> {
        Box::pin(async move {
            let http = sdk_gaps::http(&self.base_url, &self.token)
                .map_err(|_| "no usable Agent Relay origin".to_string())?;
            let data = sdk_gaps::file_info(&http, file_id)
                .await
                .map_err(|error| relaycast_reason("file lookup", &error))?;
            let mut file = RemoteFile::from_value(&data)
                .ok_or_else(|| "Agent Relay gave no download address".to_string())?;
            // A relative address is on the Relaycast origin itself.
            if file.download_url.starts_with('/') {
                file.download_url = format!(
                    "{}{}",
                    self.base_url.trim_end_matches('/'),
                    file.download_url
                );
            }
            Ok(file)
        })
    }

    fn download<'a>(
        &'a self,
        url: &'a str,
        max_bytes: u64,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<Vec<u8>, String>> {
        let url = url.to_string();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || fetch(&url, max_bytes, timeout))
                .await
                .unwrap_or_else(|_| Err("the download stopped unexpectedly".into()))
        })
    }
}

fn too_large() -> String {
    "larger than 25 MB".into()
}

/// `GET url`, without credentials (a signed address carries its own), up to
/// `max_bytes`.
pub fn fetch(url: &str, max_bytes: u64, timeout: Duration) -> Result<Vec<u8>, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("unsupported download address".into());
    }
    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    let response = match agent.get(url).call() {
        Ok(response) => response,
        Err(ureq::Error::Status(status, _)) => {
            return Err(format!("download refused (HTTP {status})"))
        }
        Err(ureq::Error::Transport(_)) => return Err("could not reach the file host".into()),
    };
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "the download was interrupted".to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err(too_large());
    }
    Ok(bytes)
}

/// A file name safe to create in a directory: its last path component, with
/// control and format characters and whitespace runs reduced to one space,
/// brackets made parentheses (so the injected line shows the real path), no
/// leading dot, at most 200 bytes; `attachment` when nothing is left.
pub fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let mapped: String = base
        .chars()
        .map(|c| match c {
            '[' => '(',
            ']' => ')',
            c if crate::relay::delivery::policy::is_control_or_newline(c) => ' ',
            c => c,
        })
        .collect();
    let spaced = mapped.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut clean = spaced.trim_start_matches(['.', ' ']).trim().to_string();
    const LIMIT: usize = 200;
    if clean.len() > LIMIT {
        let extension = clean
            .rfind('.')
            .map(|dot| clean[dot..].to_string())
            .filter(|ext| ext.len() <= 16)
            .unwrap_or_default();
        let mut stem: String = clean[..clean.len() - extension.len()].to_string();
        while stem.len() + extension.len() > LIMIT {
            stem.pop();
        }
        clean = format!("{}{extension}", stem.trim_end());
    }
    if clean.is_empty() {
        "attachment".into()
    } else {
        clean
    }
}

/// `<root>/<file_id>/<sanitized name>`. The id was checked to be a plain
/// token when the delivery was read.
pub fn attachment_path(root: &Path, attachment: &Attachment) -> PathBuf {
    root.join(&attachment.file_id).join(sanitize_filename(
        attachment.filename.as_deref().unwrap_or_default(),
    ))
}

/// A file already saved there, whole: a regular file (never a link) of the
/// size Relaycast reported. Without a reported size there is nothing to
/// check it against, so it is fetched again.
fn already_saved(path: &Path, size: Option<u64>) -> bool {
    let Some(size) = size else {
        return false;
    };
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() == size)
}

/// How long `POST /attachments/fetch` may take for one file.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(120);

/// Fetches one file a session asks for by id: its name, type and size come
/// from Relaycast, then it is saved like a delivered attachment.
pub async fn fetch_by_id(
    source: &dyn FileSource,
    root: &Path,
    file_id: &str,
    timeout: Duration,
) -> Result<Attachment, String> {
    // The session asking may not be who sent it: only the total quota holds.
    let sender: Option<&Sender> = None;
    let deadline = tokio::time::Instant::now() + timeout;
    let remote = tokio::time::timeout_at(deadline, source.file(file_id))
        .await
        .map_err(|_| "timed out".to_string())??;
    let mut attachment = Attachment {
        file_id: file_id.to_string(),
        filename: remote.filename.clone(),
        content_type: remote.content_type.clone(),
        size_bytes: remote.size_bytes,
        local: None,
        fetch_hint: None,
    };
    let path = attachment_path(root, &attachment);
    let saved = if already_saved(&path, attachment.size_bytes) {
        Ok(path)
    } else {
        tokio::time::timeout_at(
            deadline,
            save_remote(source, root, &attachment, sender, remote, deadline),
        )
        .await
        .unwrap_or_else(|_| Err("timed out".into()))
    };
    attachment.local = Some(saved);
    match &attachment.local {
        Some(Ok(_)) => Ok(attachment),
        Some(Err(reason)) => Err(reason.clone()),
        None => Err("not fetched".into()),
    }
}

/// Saves every attachment not yet tried under `root`, recording on each where
/// it was saved or why not. Bounded by `timeout` all together; never fails.
pub async fn save_attachments(
    source: &dyn FileSource,
    root: &Path,
    sender: Option<&Sender>,
    attachments: &mut [Attachment],
    timeout: Duration,
) {
    let deadline = tokio::time::Instant::now() + timeout;
    for attachment in attachments.iter_mut() {
        if attachment.local.is_some() {
            continue;
        }
        let saved = tokio::time::timeout_at(
            deadline,
            save_one(source, root, sender, attachment, deadline),
        )
        .await;
        attachment.local = Some(saved.unwrap_or_else(|_| Err("timed out".into())));
    }
}

/// [`save_attachments`] for `delivery`'s files, counted against its sender.
pub async fn save_delivery_attachments(
    source: &dyn FileSource,
    root: &Path,
    delivery: &mut Delivery,
    timeout: Duration,
) {
    let sender = Sender::of(delivery);
    save_attachments(
        source,
        root,
        sender.as_ref(),
        &mut delivery.attachments,
        timeout,
    )
    .await;
}

async fn save_one(
    source: &dyn FileSource,
    root: &Path,
    sender: Option<&Sender>,
    attachment: &Attachment,
    deadline: tokio::time::Instant,
) -> Result<PathBuf, String> {
    if attachment
        .size_bytes
        .is_some_and(|size| size > MAX_FILE_BYTES)
    {
        return Err(too_large());
    }
    let path = attachment_path(root, attachment);
    if already_saved(&path, attachment.size_bytes) {
        return Ok(path);
    }
    let remote = source.file(&attachment.file_id).await?;
    save_remote(source, root, attachment, sender, remote, deadline).await
}

async fn save_remote(
    source: &dyn FileSource,
    root: &Path,
    attachment: &Attachment,
    sender: Option<&Sender>,
    remote: RemoteFile,
    deadline: tokio::time::Instant,
) -> Result<PathBuf, String> {
    let path = attachment_path(root, attachment);
    if remote.is_pending() {
        return Err("the upload is not complete".into());
    }
    if remote.size_bytes.is_some_and(|size| size > MAX_FILE_BYTES) {
        return Err(too_large());
    }
    if let Some(size) = remote.size_bytes {
        let (root, at, sender) = (root.to_path_buf(), path.clone(), sender.cloned());
        tokio::task::spawn_blocking(move || store::would_take(&root, &at, sender.as_ref(), size))
            .await
            .unwrap_or(Ok(()))?;
    }
    let bytes = source
        .download(
            &remote.download_url,
            MAX_FILE_BYTES,
            deadline.saturating_duration_since(tokio::time::Instant::now()),
        )
        .await?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(too_large());
    }
    let root = root.to_path_buf();
    let target = path.clone();
    let sender = sender.cloned();
    tokio::task::spawn_blocking(move || store::save(&root, &target, sender.as_ref(), &bytes))
        .await
        .unwrap_or_else(|_| Err("could not save it".into()))?;
    Ok(path)
}

/// A local file a session asked to send, read and checked.
#[derive(Clone, Debug)]
pub struct LocalFile {
    pub path: PathBuf,
    pub filename: String,
    pub content_type: &'static str,
    pub bytes: Vec<u8>,
}

/// The content type a file name suggests.
pub fn content_type_for(name: &str) -> &'static str {
    let extension = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "json" => "application/json",
        "md" => "text/markdown",
        _ => "application/octet-stream",
    }
}

/// Why a local file cannot be sent: a sentence for the session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LocalFileError {
    Invalid(String),
    TooLarge(String),
    /// Somewhere an agent may not send files from ([`confine`]).
    NotAllowed(String),
}

impl LocalFileError {
    pub fn message(&self) -> &str {
        match self {
            LocalFileError::Invalid(message)
            | LocalFileError::TooLarge(message)
            | LocalFileError::NotAllowed(message) => message,
        }
    }
}

/// Reads `path` for sending: an absolute path to a regular, readable file of
/// at most 25 MB, from anywhere. An agent's send reads through
/// [`read_agent_file`] instead.
pub fn read_local_file(path: &str) -> Result<LocalFile, LocalFileError> {
    read_opened_file(path, |_| Ok(()))
}

/// [`read_local_file`], with `opened` judging the file once it is open and
/// before it is read.
fn read_opened_file(
    path: &str,
    opened: impl FnOnce(&std::fs::File) -> Result<(), LocalFileError>,
) -> Result<LocalFile, LocalFileError> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(LocalFileError::Invalid(format!(
            "{} is not an absolute path.",
            path.display()
        )));
    }
    let not_readable = || {
        LocalFileError::Invalid(format!(
            "{} is not a readable regular file.",
            path.display()
        ))
    };
    let meta = std::fs::metadata(&path).map_err(|_| not_readable())?;
    if !meta.is_file() {
        return Err(not_readable());
    }
    let larger = || LocalFileError::TooLarge(format!("{} is larger than 25 MB.", path.display()));
    if meta.len() > MAX_FILE_BYTES {
        return Err(larger());
    }
    let file = std::fs::File::open(&path).map_err(|_| not_readable())?;
    opened(&file)?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| not_readable())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(larger());
    }
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "attachment".into());
    Ok(LocalFile {
        content_type: content_type_for(&filename),
        filename,
        path,
        bytes,
    })
}

/// Why an upload failed, in a few words, and the HTTP status to report.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploadError {
    pub status: u16,
    pub reason: String,
}

/// Uploads `file` as the agent holding `token`; its Relaycast file id.
pub async fn upload(
    base_url: &str,
    token: &Secret,
    file: &LocalFile,
) -> Result<String, UploadError> {
    let relaycast = |what: &str, error: relaycast::RelayError| UploadError {
        status: error
            .status()
            .filter(|status| (400..600).contains(status))
            .unwrap_or(502),
        reason: relaycast_reason(what, &error),
    };
    let http = sdk_gaps::http(base_url, token).map_err(|error| relaycast("upload", error))?;
    let requested = sdk_gaps::request_upload(
        &http,
        &file.filename,
        file.content_type,
        file.bytes.len() as u64,
    )
    .await
    .map_err(|error| relaycast("upload request", error))?;
    let invalid = || UploadError {
        status: 502,
        reason: "Agent Relay gave no upload address".into(),
    };
    let file_id = requested["file_id"]
        .as_str()
        .or_else(|| requested["id"].as_str())
        .filter(|id| !id.is_empty())
        .ok_or_else(invalid)?
        .to_string();
    let url = requested["upload_url"]
        .as_str()
        .filter(|url| url.starts_with("https://") || url.starts_with("http://"))
        .ok_or_else(invalid)?
        .to_string();
    let bytes = file.bytes.clone();
    let content_type = file.content_type;
    tokio::task::spawn_blocking(move || put(&url, content_type, &bytes))
        .await
        .unwrap_or_else(|_| Err("the upload stopped unexpectedly".into()))
        .map_err(|reason| UploadError {
            status: 502,
            reason,
        })?;
    sdk_gaps::complete_upload(&http, &file_id)
        .await
        .map_err(|error| relaycast("completing the upload", error))?;
    Ok(file_id)
}

fn put(url: &str, content_type: &str, bytes: &[u8]) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new().timeout(UPLOAD_TIMEOUT).build();
    match agent
        .put(url)
        .set("Content-Type", content_type)
        .send_bytes(bytes)
    {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(status, _)) => Err(format!("upload refused (HTTP {status})")),
        Err(ureq::Error::Transport(_)) => Err("could not reach the file host".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::delivery::policy::one_line;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeSource {
        files: Mutex<std::collections::HashMap<String, (RemoteFile, Vec<u8>)>>,
        lookups: AtomicUsize,
        downloads: AtomicUsize,
        download_timeouts: Mutex<Vec<Duration>>,
        stall: bool,
    }

    impl FakeSource {
        fn with(file_id: &str, bytes: &[u8], status: Option<&str>) -> FakeSource {
            let source = FakeSource::default();
            source.files.lock().unwrap().insert(
                file_id.into(),
                (
                    RemoteFile {
                        download_url: format!("https://files.example/{file_id}?X-Signature=secret"),
                        filename: Some("shot.png".into()),
                        content_type: Some("image/png".into()),
                        size_bytes: Some(bytes.len() as u64),
                        status: status.map(str::to_string),
                    },
                    bytes.to_vec(),
                ),
            );
            source
        }
    }

    impl FileSource for FakeSource {
        fn file<'a>(&'a self, file_id: &'a str) -> BoxFuture<'a, Result<RemoteFile, String>> {
            Box::pin(async move {
                self.lookups.fetch_add(1, Ordering::SeqCst);
                if self.stall {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                }
                self.files
                    .lock()
                    .unwrap()
                    .get(file_id)
                    .map(|(remote, _)| remote.clone())
                    .ok_or_else(|| "file lookup failed (HTTP 404)".to_string())
            })
        }

        fn download<'a>(
            &'a self,
            url: &'a str,
            max_bytes: u64,
            timeout: Duration,
        ) -> BoxFuture<'a, Result<Vec<u8>, String>> {
            Box::pin(async move {
                self.downloads.fetch_add(1, Ordering::SeqCst);
                self.download_timeouts.lock().unwrap().push(timeout);
                let files = self.files.lock().unwrap();
                let (_, bytes) = files
                    .values()
                    .find(|(remote, _)| remote.download_url == url)
                    .ok_or_else(|| "download refused (HTTP 403)".to_string())?;
                if bytes.len() as u64 > max_bytes {
                    return Err(too_large());
                }
                Ok(bytes.clone())
            })
        }
    }

    fn attachment(file_id: &str, name: &str, size: Option<u64>) -> Attachment {
        Attachment {
            file_id: file_id.into(),
            filename: Some(name.into()),
            content_type: Some("image/png".into()),
            size_bytes: size,
            local: None,
            fetch_hint: None,
        }
    }

    #[test]
    fn file_names_are_reduced_to_a_safe_basename() {
        assert_eq!(sanitize_filename("shot.png"), "shot.png");
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("C:\\Users\\me\\shot.png"), "shot.png");
        assert_eq!(sanitize_filename(".bashrc"), "bashrc");
        assert_eq!(sanitize_filename("..."), "attachment");
        assert_eq!(sanitize_filename(""), "attachment");
        assert_eq!(sanitize_filename("dir/"), "attachment");
        assert_eq!(sanitize_filename("a\nb\u{202E}c\t.png"), "a b c .png");
        assert_eq!(sanitize_filename("my   shot [1].png"), "my shot (1).png");
        let long = format!("{}.png", "x".repeat(400));
        let short = sanitize_filename(&long);
        assert!(short.len() <= 200 && short.ends_with(".png"), "{short}");
        for name in ["a\nb.png", "x [y]  z", "\u{2028}q"] {
            let clean = sanitize_filename(name);
            assert_eq!(one_line(&clean), clean, "{name:?}");
        }
    }

    #[test]
    fn content_types_follow_the_extension() {
        assert_eq!(content_type_for("a.PNG"), "image/png");
        assert_eq!(content_type_for("a.jpeg"), "image/jpeg");
        assert_eq!(content_type_for("a.jpg"), "image/jpeg");
        assert_eq!(content_type_for("a.gif"), "image/gif");
        assert_eq!(content_type_for("a.webp"), "image/webp");
        assert_eq!(content_type_for("a.pdf"), "application/pdf");
        assert_eq!(content_type_for("a.txt"), "text/plain");
        assert_eq!(content_type_for("a.json"), "application/json");
        assert_eq!(content_type_for("a.md"), "text/markdown");
        assert_eq!(content_type_for("a.tar.gz"), "application/octet-stream");
        assert_eq!(content_type_for("Makefile"), "application/octet-stream");
    }

    #[test]
    fn the_remote_file_is_read_leniently() {
        let file = RemoteFile::from_value(&serde_json::json!({"download_url":"https://x/y",
            "filename":"a.png","content_type":"image/png","size_bytes":12,"status":"complete"}))
        .unwrap();
        assert_eq!(file.size_bytes, Some(12));
        assert!(!file.is_pending());
        assert!(RemoteFile::from_value(&serde_json::json!({"filename":"a"})).is_none());
        let pending =
            RemoteFile::from_value(&serde_json::json!({"url":"https://x","status":"pending"}))
                .unwrap();
        assert!(pending.is_pending());
    }

    #[tokio::test]
    async fn a_file_without_a_known_size_is_fetched_again_rather_than_trusted() {
        let root = tempfile::tempdir().unwrap();
        let source = FakeSource::with("file_1", b"PNGDATA", Some("complete"));
        let mut first = vec![attachment("file_1", "shot.png", None)];
        save_attachments(&source, root.path(), None, &mut first, DOWNLOAD_TIMEOUT).await;
        let path = first[0].local.clone().unwrap().unwrap();
        std::fs::write(&path, b"stale").unwrap();
        let mut again = vec![attachment("file_1", "shot.png", None)];
        save_attachments(&source, root.path(), None, &mut again, DOWNLOAD_TIMEOUT).await;
        assert_eq!(source.downloads.load(Ordering::SeqCst), 2);
        assert_eq!(std::fs::read(&path).unwrap(), b"PNGDATA");
    }

    #[tokio::test]
    async fn a_file_is_fetched_by_id_under_the_name_relaycast_gives() {
        let root = tempfile::tempdir().unwrap();
        let source = FakeSource::with("file_1", b"PNGDATA", Some("complete"));
        let fetched = fetch_by_id(&source, root.path(), "file_1", FETCH_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(fetched.filename.as_deref(), Some("shot.png"));
        let path = fetched.local.unwrap().unwrap();
        assert_eq!(path, root.path().join("file_1/shot.png"));
        assert_eq!(std::fs::read(&path).unwrap(), b"PNGDATA");
        assert_eq!(source.lookups.load(Ordering::SeqCst), 1);
        assert!(source.download_timeouts.lock().unwrap()[0] > DOWNLOAD_TIMEOUT);

        let fetched_again = fetch_by_id(&source, root.path(), "file_1", FETCH_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(fetched_again.local.unwrap().unwrap(), path);
        assert_eq!(source.lookups.load(Ordering::SeqCst), 2);
        assert_eq!(source.downloads.load(Ordering::SeqCst), 1);

        let pending = FakeSource::with("file_2", b"x", Some("pending"));
        assert!(fetch_by_id(&pending, root.path(), "file_2", FETCH_TIMEOUT)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn an_attachment_is_saved_once_and_reused() {
        let root = tempfile::tempdir().unwrap();
        let source = FakeSource::with("file_1", b"PNGDATA", Some("complete"));
        let mut attachments = vec![attachment("file_1", "../shot.png", Some(7))];
        save_attachments(
            &source,
            root.path(),
            None,
            &mut attachments,
            DOWNLOAD_TIMEOUT,
        )
        .await;
        let path = attachments[0].local.clone().unwrap().unwrap();
        assert_eq!(path, root.path().join("file_1/shot.png"));
        assert_eq!(std::fs::read(&path).unwrap(), b"PNGDATA");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }

        // A second delivery of the same file reads nothing from Relaycast.
        let mut again = vec![attachment("file_1", "shot.png", Some(7))];
        save_attachments(&source, root.path(), None, &mut again, DOWNLOAD_TIMEOUT).await;
        assert_eq!(again[0].local, Some(Ok(path.clone())));
        assert_eq!(source.lookups.load(Ordering::SeqCst), 1);
        assert_eq!(source.downloads.load(Ordering::SeqCst), 1);

        // A partial file of the wrong size is replaced.
        std::fs::write(&path, b"PNG").unwrap();
        let mut partial = vec![attachment("file_1", "shot.png", Some(7))];
        save_attachments(&source, root.path(), None, &mut partial, DOWNLOAD_TIMEOUT).await;
        assert_eq!(std::fs::read(&path).unwrap(), b"PNGDATA");
        assert_eq!(source.downloads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn failures_are_short_reasons_without_addresses() {
        let root = tempfile::tempdir().unwrap();
        let source = FakeSource::with("file_1", b"x", Some("pending"));
        let mut attachments = vec![
            attachment("file_1", "a.png", None),
            attachment("file_2", "b.png", None),
            attachment("file_3", "c.png", Some(MAX_FILE_BYTES + 1)),
        ];
        save_attachments(
            &source,
            root.path(),
            None,
            &mut attachments,
            DOWNLOAD_TIMEOUT,
        )
        .await;
        let reasons: Vec<String> = attachments
            .iter()
            .map(|a| a.local.clone().unwrap().unwrap_err())
            .collect();
        assert_eq!(
            reasons,
            vec![
                "the upload is not complete",
                "file lookup failed (HTTP 404)",
                "larger than 25 MB"
            ]
        );
        assert!(reasons.iter().all(|r| !r.contains("Signature")));
        // The oversized file was refused before any request.
        assert_eq!(source.lookups.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn an_oversized_download_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let big = vec![0u8; (MAX_FILE_BYTES + 1) as usize];
        let source = FakeSource::default();
        source.files.lock().unwrap().insert(
            "file_big".into(),
            (
                RemoteFile {
                    download_url: "https://files.example/big".into(),
                    filename: None,
                    content_type: None,
                    // Relaycast did not say how big it is.
                    size_bytes: None,
                    status: None,
                },
                big,
            ),
        );
        let mut attachments = vec![attachment("file_big", "big.bin", None)];
        save_attachments(
            &source,
            root.path(),
            None,
            &mut attachments,
            DOWNLOAD_TIMEOUT,
        )
        .await;
        assert_eq!(attachments[0].local, Some(Err("larger than 25 MB".into())));
        assert!(!root.path().join("file_big").exists());
    }

    #[tokio::test]
    async fn a_stalled_lookup_gives_up_at_the_deadline() {
        let root = tempfile::tempdir().unwrap();
        let source = FakeSource {
            stall: true,
            ..FakeSource::default()
        };
        let mut attachments = vec![
            attachment("file_1", "a.png", None),
            attachment("file_2", "b.png", None),
        ];
        let started = std::time::Instant::now();
        save_attachments(
            &source,
            root.path(),
            None,
            &mut attachments,
            Duration::from_millis(100),
        )
        .await;
        assert!(started.elapsed() < Duration::from_secs(5));
        for attachment in &attachments {
            assert_eq!(attachment.local, Some(Err("timed out".into())));
        }
    }

    #[test]
    fn a_local_file_must_be_absolute_regular_and_small_enough() {
        let dir = tempfile::tempdir().unwrap();
        let shot = dir.path().join("shot.png");
        std::fs::write(&shot, b"PNG").unwrap();
        let file = read_local_file(shot.to_str().unwrap()).unwrap();
        assert_eq!(file.filename, "shot.png");
        assert_eq!(file.content_type, "image/png");
        assert_eq!(file.bytes, b"PNG");
        assert!(read_local_file("shot.png")
            .unwrap_err()
            .message()
            .contains("not an absolute path"));
        assert!(read_local_file(dir.path().to_str().unwrap())
            .unwrap_err()
            .message()
            .contains("not a readable regular file"));
        assert!(
            read_local_file(dir.path().join("missing").to_str().unwrap())
                .unwrap_err()
                .message()
                .contains("not a readable regular file")
        );
        let big = dir.path().join("big.bin");
        std::fs::File::create(&big)
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        assert!(matches!(
            read_local_file(big.to_str().unwrap()),
            Err(LocalFileError::TooLarge(message)) if message.contains("larger than 25 MB")
        ));
    }
}
