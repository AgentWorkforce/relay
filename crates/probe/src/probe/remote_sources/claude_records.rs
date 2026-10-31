use super::*;

/// Claude's teleport records name the session by the id Claude Code gave
/// it inside the cloud container, a UUID, not the `cse_…` id claude.ai
/// lists and serves them under; relayhistory refuses records naming
/// another session. A session resumed in a new container gets a new UUID,
/// so one cloud session's records can name several. Records fetched for a
/// session that name only container UUIDs are that session's: they take
/// its listed id, as do records already naming it among them. Records
/// naming another claude.ai session are left as they are, and refused.
pub(super) fn adopt_cloud_session_id(
    evidence: ai_hist::sources::AcquiredEvidence,
    session_id: &str,
) -> ai_hist::sources::AcquiredEvidence {
    let ai_hist::sources::AcquiredEvidence::ClaudeFull {
        mut records,
        source_stamp,
        source_bytes,
    } = evidence
    else {
        return evidence;
    };
    let named: BTreeSet<String> = records
        .iter()
        .filter_map(|record| record.get("sessionId").or_else(|| record.get("session_id")))
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    if named
        .iter()
        .all(|id| id == session_id || container_session_id(id))
        && named.iter().any(|id| id != session_id)
    {
        for record in &mut records {
            if let Some(object) = record.as_object_mut() {
                // Either spelling names the session; it takes the listed id
                // in the spelling the parser reads.
                let named =
                    object.remove("session_id").is_some() | object.contains_key("sessionId");
                if named {
                    object.insert("sessionId".into(), Value::String(session_id.into()));
                }
            }
        }
    }
    ai_hist::sources::AcquiredEvidence::ClaudeFull {
        records,
        source_stamp,
        source_bytes,
    }
}

/// A Claude Code session id as the container's CLI names it: a UUID.
pub(super) fn container_session_id(id: &str) -> bool {
    id.len() == 36
        && id.char_indices().all(|(at, c)| match at {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}
