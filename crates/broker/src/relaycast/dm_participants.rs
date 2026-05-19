pub(crate) use ::relaycast::DmParticipantsCache;

use super::RelaycastHttpClient;

pub async fn resolve_dm_participants_cached(
    http: &RelaycastHttpClient,
    cache: &mut DmParticipantsCache,
    workspace_id: &str,
    conversation_id: &str,
) -> Vec<String> {
    let Some(relay) = http.relay_client() else {
        tracing::warn!(
            conversation_id = %conversation_id,
            "SDK relay client not initialized; cannot resolve DM participants"
        );
        return vec![];
    };

    let participants = cache
        .resolve_or_empty(relay, workspace_id, conversation_id)
        .await;
    if participants.is_empty() {
        tracing::warn!(
            workspace_id = %workspace_id,
            conversation_id = %conversation_id,
            "no participants found for DM conversation; message delivery will fail"
        );
    }
    participants
}
