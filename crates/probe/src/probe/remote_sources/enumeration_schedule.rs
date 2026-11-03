use super::*;

/// Whether listing is due for `host`: the interval passed, or a connector
/// the last listing could not use because Claude Code was not signed in or
/// its folder was not shared can be used now. A person who signs in, or
/// shares the folder, then sees their cloud sessions on the next pass
/// instead of after the interval. Only those two reasons: an expired or
/// refused login can still look usable before it is read, so a previous
/// Keychain refusal is retried early only after a quiet read now succeeds.
pub(super) fn due_for(host: &Host, db: &Path) -> bool {
    due(db)
        || last_enumeration(db).connectors.iter().any(|connector| {
            if connector.state != "unavailable" || reach(host, &connector.connector) != Reach::Ready
            {
                return false;
            }
            match connector.reason.as_deref() {
                Some(claude_cloud::NOT_SIGNED_IN | claude_cloud::FOLDER_NOT_SHARED) => true,
                Some(reason)
                    if connector.connector == CLAUDE_WEB_CONNECTOR
                        && claude_cloud::keychain_not_ready(reason) =>
                {
                    match claude_cloud::choose(host.home, host.keychain.source(), now_ms()) {
                        claude_cloud::Login::File => true,
                        claude_cloud::Login::Keychain => host.keychain.access_recovered(),
                        _ => false,
                    }
                }
                _ => false,
            }
        })
}
