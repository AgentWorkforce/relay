use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

static DM_DROPS_TOTAL: AtomicU64 = AtomicU64::new(0);

pub(crate) const DM_PARTICIPANT_CACHE_TTL: Duration = Duration::from_secs(30);
const MAX_DM_CACHE_ENTRIES: usize = 8192;

pub(crate) async fn resolve_dm_participants_cached(
    http: &relay_broker::relaycast_ws::RelaycastHttpClient,
    cache: &mut HashMap<String, (Instant, Vec<String>)>,
    workspace_id: &str,
    conversation_id: &str,
) -> Vec<String> {
    let workspace_id = workspace_id.trim();
    let conversation_id = conversation_id.trim();
    if conversation_id.is_empty() {
        return vec![];
    }
    let cache_key = format!("{workspace_id}:{conversation_id}");

    if let Some((fetched_at, participants)) = cache.get(&cache_key) {
        if fetched_at.elapsed() < DM_PARTICIPANT_CACHE_TTL {
            return participants.clone();
        }
    }

    match http.get_dm_participants(conversation_id).await {
        Ok(fetched) => {
            let fetched: Vec<String> = fetched;
            if cache.len() >= MAX_DM_CACHE_ENTRIES {
                if let Some(oldest_key) = cache
                    .iter()
                    .min_by_key(|(_, (ts, _))| *ts)
                    .map(|(k, _)| k.clone())
                {
                    cache.remove(&oldest_key);
                }
            }
            cache.insert(cache_key, (Instant::now(), fetched.clone()));
            fetched
        }
        Err(error) => {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dm_cache_ttl_constant_is_reasonable() {
        assert!(DM_PARTICIPANT_CACHE_TTL.as_secs() > 0);
        assert!(DM_PARTICIPANT_CACHE_TTL.as_secs() <= 300);
    }

    #[test]
    fn dm_cache_eviction_cap_is_set() {
        assert_eq!(MAX_DM_CACHE_ENTRIES, 8192);
    }
}
