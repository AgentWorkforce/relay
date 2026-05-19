use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

static DM_DROPS_TOTAL: AtomicU64 = AtomicU64::new(0);

pub const DM_PARTICIPANT_CACHE_TTL: Duration = Duration::from_secs(30);
pub const DM_PARTICIPANT_FAILURE_TTL: Duration = Duration::from_secs(5);
const MAX_DM_CACHE_ENTRIES: usize = 8192;

#[derive(Debug, Clone)]
pub enum DmParticipantsCacheEntry {
    Success {
        fetched_at: Instant,
        participants: Vec<String>,
    },
    Failure {
        failed_at: Instant,
    },
}

impl DmParticipantsCacheEntry {
    fn timestamp(&self) -> Instant {
        match self {
            Self::Success { fetched_at, .. } => *fetched_at,
            Self::Failure { failed_at } => *failed_at,
        }
    }
}

pub type DmParticipantsCache = HashMap<String, DmParticipantsCacheEntry>;

pub async fn resolve_dm_participants_cached(
    http: &super::RelaycastHttpClient,
    cache: &mut DmParticipantsCache,
    workspace_id: &str,
    conversation_id: &str,
) -> Vec<String> {
    let workspace_id = workspace_id.trim();
    let conversation_id = conversation_id.trim();
    if conversation_id.is_empty() {
        return vec![];
    }
    let cache_key = format!("{workspace_id}:{conversation_id}");

    if let Some(entry) = cache.get(&cache_key) {
        match entry {
            DmParticipantsCacheEntry::Success {
                fetched_at,
                participants,
            } if fetched_at.elapsed() < DM_PARTICIPANT_CACHE_TTL => {
                return participants.clone();
            }
            DmParticipantsCacheEntry::Failure { failed_at }
                if failed_at.elapsed() < DM_PARTICIPANT_FAILURE_TTL =>
            {
                return vec![];
            }
            _ => {}
        }
    }

    match http.get_dm_participants(conversation_id).await {
        Ok(fetched) => {
            let fetched: Vec<String> = fetched;
            insert_cache_entry(
                cache,
                cache_key,
                DmParticipantsCacheEntry::Success {
                    fetched_at: Instant::now(),
                    participants: fetched.clone(),
                },
            );
            fetched
        }
        Err(error) => {
            insert_cache_entry(
                cache,
                cache_key,
                DmParticipantsCacheEntry::Failure {
                    failed_at: Instant::now(),
                },
            );
            DM_DROPS_TOTAL.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(
                workspace_id = %workspace_id,
                conversation_id = %conversation_id,
                error = %error,
                dm_drops_total = DM_DROPS_TOTAL.load(Ordering::Relaxed),
                "failed resolving DM participants - DM silently dropped"
            );
            vec![]
        }
    }
}

fn insert_cache_entry(
    cache: &mut DmParticipantsCache,
    cache_key: String,
    entry: DmParticipantsCacheEntry,
) {
    if !cache.contains_key(&cache_key) && cache.len() >= MAX_DM_CACHE_ENTRIES {
        if let Some(oldest_key) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.timestamp())
            .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest_key);
        }
    }
    cache.insert(cache_key, entry);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dm_cache_ttl_constant_is_reasonable() {
        assert!(DM_PARTICIPANT_CACHE_TTL.as_secs() > 0);
        assert!(DM_PARTICIPANT_CACHE_TTL.as_secs() <= 300);
        assert!(DM_PARTICIPANT_FAILURE_TTL.as_secs() > 0);
        assert!(DM_PARTICIPANT_FAILURE_TTL < DM_PARTICIPANT_CACHE_TTL);
    }

    #[test]
    fn dm_cache_eviction_cap_is_set() {
        assert_eq!(MAX_DM_CACHE_ENTRIES, 8192);
    }

    #[test]
    fn dm_cache_entry_timestamp_tracks_failure_and_success_entries() {
        let now = Instant::now();
        let success = DmParticipantsCacheEntry::Success {
            fetched_at: now,
            participants: vec!["alice".to_string()],
        };
        let failure = DmParticipantsCacheEntry::Failure { failed_at: now };

        assert_eq!(success.timestamp(), now);
        assert_eq!(failure.timestamp(), now);
    }
}
