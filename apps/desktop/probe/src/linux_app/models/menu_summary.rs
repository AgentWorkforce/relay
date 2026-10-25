//! The tray's summary counts, the Mac's `MenuSummaryFilter`.
use super::{LocalSessionQuery, LocalSessionRow, SessionUploadState};

/// A count in the tray's summary. Each is a session search, so choosing it
/// opens the session list showing exactly the sessions it counted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuSummaryFilter {
    Receiving,
    LocalOnly,
    Uploaded,
    NotUploaded,
}

impl MenuSummaryFilter {
    pub fn title(self) -> &'static str {
        match self {
            MenuSummaryFilter::Receiving => "Receiving messages",
            MenuSummaryFilter::LocalOnly => "Local only",
            MenuSummaryFilter::Uploaded => "Uploaded",
            MenuSummaryFilter::NotUploaded => "Not uploaded",
        }
    }

    pub fn search(self) -> &'static str {
        match self {
            MenuSummaryFilter::Receiving => "is:active is:on-relay",
            MenuSummaryFilter::LocalOnly => "is:active is:off-relay",
            MenuSummaryFilter::Uploaded => "upload:uploaded",
            MenuSummaryFilter::NotUploaded => "-upload:uploaded",
        }
    }

    /// How many `rows` the session list shows for this filter.
    pub fn count(
        self,
        rows: &[LocalSessionRow],
        upload_state: impl Fn(&LocalSessionRow) -> Option<SessionUploadState>,
    ) -> usize {
        let query = LocalSessionQuery::new(self.search());
        rows.iter()
            .filter(|row| query.matches(row, upload_state(row)))
            .count()
    }
}
