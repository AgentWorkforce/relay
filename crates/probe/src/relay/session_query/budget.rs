use super::*;

#[derive(Default)]
pub(super) struct PageBudget {
    upload_bytes: usize,
    local_bytes: usize,
    archived_bytes: usize,
}
impl PageBudget {
    fn sizes(row: Option<&LocalSessionRow>) -> Result<(usize, usize, usize, usize), RpcError> {
        let upload = row.and_then(|r| r.upload.as_ref());
        let local = row.and_then(|r| r.relay.as_ref());
        Ok((
            upload
                .map(serde_json::to_vec)
                .transpose()
                .map_err(|_| failed())?
                .map_or(0, |v| v.len()),
            local
                .map(serde_json::to_vec)
                .transpose()
                .map_err(|_| failed())?
                .map_or(0, |v| v.len()),
            usize::from(upload.is_some()),
            usize::from(local.is_some()),
        ))
    }
    pub(super) fn fits(
        &self,
        page: &SessionQueryPage,
        row: Option<&LocalSessionRow>,
        cursor: Option<&str>,
        archived: Option<&str>,
    ) -> Result<bool, RpcError> {
        let (upload, local, uploads, locals) = Self::sizes(row)?;
        let envelope = SessionQueryPage {
            archived_keys: Some(vec![]),
            unchanged: false,
            verification_pending: false,
            sessions: vec![],
            local_sessions: vec![],
            next_cursor: cursor.map(str::to_owned),
            revision: i64::MAX as u64,
            candidates_scanned: PAGE_ROWS,
        };
        let base = serde_json::to_vec(&envelope).map_err(|_| failed())?.len();
        let key_bytes = archived
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|_| failed())?
            .map_or(0, |v| v.len());
        Ok(base
            + self.upload_bytes
            + self.local_bytes
            + self.archived_bytes
            + key_bytes
            + (page.archived_keys.as_ref().map_or(0, Vec::len) + usize::from(archived.is_some()))
                .saturating_sub(1)
            + upload
            + local
            + (page.sessions.len() + uploads).saturating_sub(1)
            + (page.local_sessions.len() + locals).saturating_sub(1)
            <= PAGE_BYTES)
    }
    pub(super) fn push(
        &mut self,
        page: &mut SessionQueryPage,
        mut row: LocalSessionRow,
        cursor: Option<&str>,
        archived: Option<&str>,
    ) -> Result<bool, RpcError> {
        if !self.fits(page, Some(&row), cursor, archived)? {
            if !page.sessions.is_empty() || !page.local_sessions.is_empty() {
                return Ok(false);
            }
            // A provider's optional inline image can exceed an entire page.
            // Keep the row and native shape/color fallback within the same
            // exact serialized envelope; every other oversize error remains.
            omit_inline_avatar(&mut row);
            if !self.fits(page, Some(&row), cursor, archived)? {
                return Err(RpcError::invalid_params("A session row is too large."));
            }
        }
        let (upload, local, _, _) = Self::sizes(Some(&row))?;
        self.upload_bytes += upload;
        self.local_bytes += local;
        if let Some(key) = archived {
            self.archived_bytes += serde_json::to_vec(key).map_err(|_| failed())?.len();
            page.archived_keys
                .get_or_insert_with(Vec::new)
                .push(key.into());
        }
        if let Some(upload) = row.upload {
            page.sessions.push(upload);
        }
        if let Some(local) = row.relay {
            page.local_sessions.push(local);
        }
        Ok(true)
    }
}

pub(super) fn continuation_cursor(
    more: bool,
    index: usize,
    candidates: usize,
    cursor: &str,
) -> Option<&str> {
    (more || index + 1 < candidates).then_some(cursor)
}

fn omit_inline_avatar(row: &mut LocalSessionRow) {
    let Some(upload) = row.upload.as_mut() else {
        return;
    };
    let Some(avatar) = upload.avatar.as_mut() else {
        return;
    };
    if avatar.image_data_url.take().is_none() {
        return;
    }
    if avatar.shape.is_none() && avatar.color.is_none() {
        upload.avatar = None;
    }
}
