use super::*;
use crate::relay::contract::account::{SessionFacetParams, SessionFacetsPage};

#[derive(serde::Serialize, serde::Deserialize)]
struct FacetCursor {
    epoch: u64,
    revision: u64,
    field: String,
    value: String,
}

fn values(row: Option<&LocalSessionRow>) -> [(String, String); 2] {
    [
        (
            "harness".into(),
            row.map(|r| r.source().to_owned()).unwrap_or_default(),
        ),
        (
            "project".into(),
            row.map(LocalSessionRow::project).unwrap_or_default(),
        ),
    ]
}
impl Index {
    pub(super) fn adjust_facets(
        &mut self,
        old: Option<&LocalSessionRow>,
        new: Option<&LocalSessionRow>,
    ) -> Result<(), RpcError> {
        for (old, new) in values(old).into_iter().zip(values(new)) {
            if old == new {
                continue;
            }
            for ((field, value), delta) in [(old, -1), (new, 1)] {
                if value.is_empty() {
                    continue;
                }
                let count: i64 = self
                    .db
                    .query_row(
                        "SELECT count FROM facets WHERE field=? AND value=?",
                        params![field, value],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|_| failed())?
                    .unwrap_or(0);
                if count + delta <= 0 {
                    self.db
                        .execute(
                            "DELETE FROM facets WHERE field=? AND value=?",
                            params![field, value],
                        )
                        .map_err(|_| failed())?;
                } else {
                    self.db.execute("INSERT INTO facets(field,value,count) VALUES(?,?,?) ON CONFLICT(field,value) DO UPDATE SET count=excluded.count", params![field,value,count+delta]).map_err(|_| failed())?;
                }
                if count == 0 || count + delta == 0 {
                    self.facet_revision += 1;
                }
            }
        }
        Ok(())
    }

    pub fn facets(&self, request: &SessionFacetParams) -> Result<SessionFacetsPage, RpcError> {
        let cursor: Option<FacetCursor> = request
            .cursor
            .as_ref()
            .map(|s| {
                serde_json::from_str(s)
                    .map_err(|_| RpcError::invalid_params("Invalid session filter cursor."))
            })
            .transpose()?;
        if cursor
            .as_ref()
            .is_some_and(|c| c.epoch != self.epoch || c.revision != self.facet_revision)
        {
            return Err(stale());
        }
        let (field, value) = cursor.map(|c| (c.field, c.value)).unwrap_or_default();
        let limit = request.limit.unwrap_or(PAGE_ROWS).clamp(1, PAGE_ROWS);
        let mut stmt = self.db.prepare("SELECT field,value FROM facets WHERE (field,value)>(?,?) ORDER BY field,value LIMIT ?").map_err(|_| failed())?;
        let rows = stmt
            .query_map(params![field, value, limit + 1], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|_| failed())?;
        let mut token = std::collections::hash_map::DefaultHasher::new();
        (self.epoch, self.facet_revision).hash(&mut token);
        let revision = (token.finish() & i64::MAX as u64).max(1);
        let mut result = SessionFacetsPage {
            harnesses: vec![],
            projects: vec![],
            revision,
            next_cursor: None,
        };
        let mut previous = None;
        for (index, row) in rows.enumerate() {
            let (field, value) = row.map_err(|_| failed())?;
            if index == limit {
                result.next_cursor = previous;
                break;
            }
            let cursor = serde_json::to_string(&FacetCursor {
                epoch: self.epoch,
                revision: self.facet_revision,
                field: field.clone(),
                value: value.clone(),
            })
            .map_err(|_| failed())?;
            let mut proposed = result.clone();
            if field == "harness" {
                proposed.harnesses.push(value);
            } else {
                proposed.projects.push(value);
            }
            proposed.next_cursor = Some(cursor.clone());
            if serde_json::to_vec(&proposed).map_err(|_| failed())?.len() > 64 * 1024 {
                if index == 0 {
                    return Err(RpcError::invalid_params(
                        "A session filter value is too large.",
                    ));
                }
                result.next_cursor = previous;
                break;
            }
            result.harnesses = proposed.harnesses;
            result.projects = proposed.projects;
            previous = Some(cursor);
        }
        Ok(result)
    }
}
