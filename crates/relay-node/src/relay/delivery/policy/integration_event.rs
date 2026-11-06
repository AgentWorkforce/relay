use crate::relay::store::Integration;
/// A provider event as relayfile posts it into an agent's events channel:
/// `"<Provider> <event type>"` on the first line, then the record, then
/// `Relayfile path: <path>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntegrationEvent {
    pub provider: Option<String>,
    /// e.g. `pull_request.opened`, `issue_comment.created`, `update`.
    pub kind: Option<String>,
    pub path: Option<String>,
}

impl IntegrationEvent {
    /// Read the provider header and final RelayFile path from its canonical message envelope.
    pub fn parse(text: &str) -> IntegrationEvent {
        let lines: Vec<&str> = text.lines().filter(|l| !l.is_empty()).collect();
        let mut head = lines.first().copied().unwrap_or_default().splitn(2, ' ');
        let provider = head.next().filter(|p| !p.is_empty()).map(str::to_string);
        let kind = head.next().map(|k| k.trim().to_string());
        let path = lines
            .iter()
            .rev()
            .find_map(|line| line.strip_prefix("Relayfile path: "))
            .map(|path| path.trim().to_string());
        IntegrationEvent {
            provider,
            kind,
            path,
        }
    }

    /// Why this event is not worth a turn, or `None` when it is. A
    /// whole-repository subscription otherwise delivers every record sync:
    /// index rewrites, generic updates that repeat a typed event, edits to
    /// bot comments, and pushes.
    pub fn noise_reason(&self) -> Option<String> {
        if let Some(path) = self.path.as_deref().filter(|p| p.ends_with("/_index.json")) {
            return Some(format!("index update ({path})"));
        }
        let kind = self.kind.as_deref()?;
        if kind == "update" {
            return Some("record sync that repeats a typed event".into());
        }
        if kind.ends_with(".edited") {
            return Some(format!("edit ({kind})"));
        }
        if kind == "push" {
            return Some("push".into());
        }
        None
    }
}

impl IntegrationEvent {
    /// Match provider and resource before exempting exact events from noise rules.
    fn matches_resource(
        &self,
        held: &Integration,
        path: Option<&str>,
        resource_ref: Option<&str>,
    ) -> bool {
        let legacy_glob = if held.path_glob.is_none() {
            super::relayfile_glob(&held.provider, &held.resource)
        } else {
            None
        };
        self.provider
            .as_deref()
            .is_some_and(|provider| provider.eq_ignore_ascii_case(&held.provider))
            && path.or(self.path.as_deref()).is_some_and(|path| {
                held.path_glob
                    .as_deref()
                    .or(legacy_glob.as_deref())
                    .is_some_and(|glob| {
                        path_matches(glob, path)
                            || (held.provider == "github"
                                && numeric_pull_matches(glob, path, resource_ref))
                    })
            })
    }

    /// Only accepted subscriptions authorize events. Broad subscriptions retain
    /// their established routing; exact filters additionally scope resource/type.
    fn permits(&self, held: &Integration, path: Option<&str>, resource_ref: Option<&str>) -> bool {
        held.ready == Some(true)
            && held.terminal != Some(true)
            && self.matches_resource(held, path, resource_ref)
            && (held.effective_event_types().is_empty()
                || self
                    .kind
                    .as_ref()
                    .is_some_and(|kind| held.effective_event_types().contains(kind)))
    }

    /// A ready exact filter exempts its requested event from generic noise rules.
    pub fn explicitly_requested(
        &self,
        integrations: &[Integration],
        path: Option<&str>,
        resource_ref: Option<&str>,
    ) -> bool {
        integrations.iter().any(|held| {
            !held.effective_event_types().is_empty() && self.permits(held, path, resource_ref)
        })
    }
}

/// Apply saved filters before channel routing. Pending or rejected webhooks
/// cannot authorize events even when remote cleanup fails. RelayFile remains
/// the authority that filters trusted provider events before forwarding them.
pub fn decide_for_agent_with_integrations(
    delivery: &super::Delivery,
    agent_name: &str,
    webhook_channel_id: Option<&str>,
    integration_channel_id: Option<&str>,
    integrations: &[Integration],
) -> super::Decision {
    let own_integration = integration_channel_id.is_some()
        && delivery.channel_id.as_deref() == integration_channel_id;
    let event = IntegrationEvent::parse(delivery.text.as_deref().unwrap_or_default());
    let path = delivery.relayfile_path.as_deref();
    let resource_ref = delivery.relayfile_resource_ref.as_deref();
    let relevant_filter = integrations.iter().any(|held| {
        !held.effective_event_types().is_empty() && event.matches_resource(held, path, resource_ref)
    });
    // An unrelated broad subscription must not authorize a rejected filtered
    // resource, including after cleanup removes its record. Path-bearing events
    // need a ready matching scope when one can be recovered. Pathless messages
    // and legacy records with no recoverable scope retain their old routing.
    let legacy_broad = !relevant_filter
        && integrations.iter().any(|held| {
            held.ready == Some(true)
                && held.terminal != Some(true)
                && held.effective_event_types().is_empty()
                && (path.or(event.path.as_deref()).is_none()
                    || (held.path_glob.is_none()
                        && event
                            .provider
                            .as_deref()
                            .is_some_and(|provider| provider.eq_ignore_ascii_case(&held.provider))
                        && super::relayfile_glob(&held.provider, &held.resource).is_none()))
        });
    let accepted = legacy_broad
        || integrations
            .iter()
            .any(|held| event.permits(held, path, resource_ref));
    if own_integration && !accepted {
        return super::Decision::Skip("event has no matching ready subscription".into());
    }
    super::decide_for_agent_with_requested(
        delivery,
        agent_name,
        webhook_channel_id,
        integration_channel_id,
        event.explicitly_requested(integrations, path, resource_ref),
    )
}

/// The inbound bridge already authenticates numeric PR identity. Keep its
/// canonical-title and stable-reference matching when scoping saved filters.
fn numeric_pull_matches(glob: &str, path: &str, resource_ref: Option<&str>) -> bool {
    let parts: Vec<_> = glob.split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() != 7
        || parts[0] != "github"
        || parts[1] != "repos"
        || parts[4] != "pulls"
        || parts[6] != "**"
        || parts[5].starts_with('0')
        || parts[5].is_empty()
        || !parts[5].bytes().all(|c| c.is_ascii_digit())
    {
        return false;
    }
    let repo = format!("/github/repos/{}/{}/", parts[2], parts[3]);
    let Some(relative) = path.strip_prefix(&repo) else {
        return false;
    };
    let titled = format!("pulls/{}__", parts[5]);
    relative
        .strip_prefix(&titled)
        .is_some_and(|suffix| !suffix.split('/').next().unwrap_or_default().is_empty())
        || resource_ref
            == Some(
                format!(
                    "/github/repos/{}__{}/pulls/by-id/{}.json",
                    parts[2], parts[3], parts[5]
                )
                .as_str(),
            )
}

/// Match a single path component with literal text and `*` wildcards.
fn segment_matches(pattern: &str, value: &str) -> bool {
    let parts: Vec<_> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == value;
    }
    let (head, tail) = (parts[0], parts[parts.len() - 1]);
    if value.len() < head.len() + tail.len() || !value.starts_with(head) || !value.ends_with(tail) {
        return false;
    }
    let mut cursor = head.len();
    let end = value.len() - tail.len();
    for part in &parts[1..parts.len() - 1] {
        let Some(at) = value[cursor..end].find(part) else {
            return false;
        };
        cursor += at + part.len();
    }
    true
}
/// Mirror RelayFile's legacy trailing-prefix cases before segment matching.
fn path_matches(glob: &str, path: &str) -> bool {
    let normalize = |value: &str| {
        format!(
            "/{}",
            value
                .trim()
                .split('/')
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("/")
        )
    };
    let (glob, path) = (normalize(glob), normalize(path));
    if glob == path || glob == "/**" {
        return true;
    }
    let trailing = glob
        .find('*')
        .is_none_or(|at| at == glob.len() - 1 || at == glob.len().saturating_sub(2));
    if trailing {
        if let Some(prefix) = glob.strip_suffix("/**") {
            return path == prefix || path.starts_with(&format!("{prefix}/"));
        }
        if let Some(prefix) = glob.strip_suffix("/*") {
            return path
                .strip_prefix(&format!("{prefix}/"))
                .is_some_and(|suffix| !suffix.contains('/'));
        }
        if let Some(prefix) = glob.strip_suffix('*') {
            return path.starts_with(prefix);
        }
    }
    path_segments_match(&glob, &path)
}

/// Match slash-separated resource globs; `**` spans zero or more components.
fn path_segments_match(glob: &str, path: &str) -> bool {
    let parts: Vec<_> = path.split('/').filter(|part| !part.is_empty()).collect();
    let mut reachable = vec![false; parts.len() + 1];
    reachable[0] = true;
    for pattern in glob.split('/').filter(|part| !part.is_empty()) {
        if pattern == "**" {
            for i in 1..reachable.len() {
                reachable[i] = reachable[i] || reachable[i - 1];
            }
        } else {
            let previous = reachable;
            reachable = vec![false; parts.len() + 1];
            for (i, part) in parts.iter().enumerate() {
                reachable[i + 1] = previous[i] && segment_matches(pattern, part);
            }
        }
    }
    reachable[parts.len()]
}
#[cfg(test)]
mod tests {
    use super::super::{decide_for_agent_with_requested, Decision, Delivery};
    use super::*;
    /// Preserve legacy broad records that have neither a stored nor a derivable
    /// scope, while still rejecting events outside a recoverable legacy scope.
    #[test]
    fn legacy_broad_records_without_recoverable_scopes_keep_prior_routing() {
        let mut legacy = Integration::new("jira", "legacy project subscription", "rw_test");
        legacy.ready = Some(true);
        let event = Delivery {
            channel_id: Some("events".into()),
            text: Some(
                "Jira comment.created\nRelayfile path: /jira/issues/KAN-1/comments/9.json".into(),
            ),
            ..Delivery::default()
        };
        assert_eq!(
            decide_for_agent_with_integrations(
                &event,
                "agent",
                None,
                Some("events"),
                std::slice::from_ref(&legacy)
            ),
            Decision::Inject
        );
        let other_provider = Delivery {
            text: Some("GitHub issue_comment.created\nRelayfile path: /github/repos/acme/api/issues/42/comments/9.json".into()),
            ..event.clone()
        };
        assert!(matches!(
            decide_for_agent_with_integrations(
                &other_provider,
                "agent",
                None,
                Some("events"),
                std::slice::from_ref(&legacy)
            ),
            Decision::Skip(_)
        ));
        legacy.resource = "/jira/projects/**".into();
        assert!(matches!(
            decide_for_agent_with_integrations(&event, "agent", None, Some("events"), &[legacy]),
            Decision::Skip(_)
        ));
    }

    #[test]
    /// Keep local noise exemptions aligned with backend interior and legacy wildcard semantics.
    fn resource_globs_agree_with_backend_segment_and_legacy_prefix_semantics() {
        for (glob, path, expected) in [
            (
                "/jira/issues/*/comments/*.json",
                "/jira/issues/KAN-1/comments/9.json",
                true,
            ),
            (
                "/jira/issues/*/comments/*.json",
                "/jira/issues/KAN-1/comments/nested/9.json",
                false,
            ),
            (
                "/jira/issues/*/comments/*.json",
                "/jira/issues/KAN-1/comments/9.txt",
                false,
            ),
            (
                "/jira/**/comments/*.json",
                "/jira/issues/KAN-1/comments/9.json",
                true,
            ),
            ("/jira/**/comments/*.json", "/jira/comments/9.json", true),
            (
                "/jira/**/**/comments/*.json",
                "/jira/issues/KAN-1/comments/9.json",
                true,
            ),
            ("/jira/issues/KAN-*.json", "/jira/issues/KAN-1.json", true),
            ("/jira/issues/KAN-*.json", "/jira/issues/KAN-1/json", false),
            (
                "/jira/issues/KAN*",
                "/jira/issues/KAN-1/comments/9.json",
                true,
            ),
            (
                "/jira/issues/*",
                "/jira/issues/KAN-1/comments/9.json",
                false,
            ),
            ("/jira/issues/**", "/jira/issues", true),
            ("/jira/issues/**", "/jira/issues-other/9.json", false),
            ("/jira/issues/a[1]+.json", "/jira/issues/a[1]+.json", true),
            ("/jira/issues/a[1]+.json", "/jira/issues/a11.json", false),
        ] {
            assert_eq!(path_matches(glob, path), expected, "{glob} vs {path}");
        }
        let mut held = Integration::new("jira", "/jira/issues/*/comments/*.json", "rw_test");
        held.path_glob = Some(held.resource.clone());
        held.ready = Some(true);
        held.event_types = Some(vec!["comment.created".into()]);
        let event = Delivery {
            channel_id: Some("events".into()),
            text: Some(
                "Jira comment.created\nRelayfile path: /jira/issues/KAN-1/comments/9.json".into(),
            ),
            ..Delivery::default()
        };
        assert_eq!(
            decide_for_agent_with_integrations(&event, "agent", None, Some("events"), &[held]),
            Decision::Inject
        );
    }

    #[test]
    /// PR title changes and stable references retain exact identity without crossing repositories.
    fn numeric_pull_filters_follow_canonical_titles_and_trusted_stable_references() {
        let mut held = Integration::new("github", "acme/api#42", "rw_test");
        held.path_glob = Some("/github/repos/acme/api/pulls/42/**".into());
        held.ready = Some(true);
        held.event_types = Some(vec![
            "issue_comment.edited".into(),
            "pull_request.closed".into(),
        ]);
        for (path, reference, allowed) in [
            (
                "/github/repos/acme/api/pulls/42__Fix-tests/reviews/9.json",
                None,
                true,
            ),
            (
                "/github/repos/acme/api/issues/42__Fix-tests/comments/9.json",
                Some("/github/repos/acme__api/pulls/by-id/42.json"),
                true,
            ),
            (
                "/github/repos/acme/api/issues/42__Fix-tests/comments/9.json",
                Some("/github/repos/acme__api/pulls/by-id/43.json"),
                false,
            ),
            (
                "/github/repos/other/api/issues/42__Fix-tests/comments/9.json",
                Some("/github/repos/acme__api/pulls/by-id/42.json"),
                false,
            ),
            (
                "/github/repos/acme/api/pulls/420__Fix-tests/reviews/9.json",
                None,
                false,
            ),
            (
                "/github/repos/acme/api/pulls/42__/reviews/9.json",
                None,
                false,
            ),
            (
                "/github/repos/acme/api/issues/42/comments/9.json",
                None,
                false,
            ),
        ] {
            let event = Delivery {
                channel_id: Some("events".into()),
                text: Some(format!(
                    "GitHub issue_comment.edited\nRelayfile path: {path}"
                )),
                relayfile_resource_ref: reference.map(str::to_string),
                ..Delivery::default()
            };
            let decision = decide_for_agent_with_integrations(
                &event,
                "agent",
                None,
                Some("events"),
                std::slice::from_ref(&held),
            );
            assert_eq!(
                decision == Decision::Inject,
                allowed,
                "{path} {reference:?}"
            );
        }
        let raw = serde_json::json!({"id":"d", "message_id":"m", "channel_id":"events", "message":{"text":"GitHub issue_comment.edited", "metadata":{"relayfile":{"path":"/github/repos/acme/api/issues/42/comments/9.json", "resource_ref":"/github/repos/acme__api/pulls/by-id/42.json"}}}});
        let decoded = Delivery::from_queue_item(&raw).unwrap();
        assert_eq!(
            decide_for_agent_with_integrations(
                &decoded,
                "agent",
                None,
                Some("events"),
                std::slice::from_ref(&held)
            ),
            Decision::Inject
        );
        held.event_types = Some(vec![]);
        let legacy = Delivery {
            text: Some("GitHub issue_comment.created".into()),
            channel_id: Some("events".into()),
            ..Delivery::default()
        };
        assert_eq!(
            decide_for_agent_with_integrations(&legacy, "agent", None, Some("events"), &[held]),
            Decision::Inject
        );
    }

    #[test]
    /// Pending, terminal and mismatched scopes cannot borrow an unrelated ready authorization.
    fn rejected_and_unmatched_events_cannot_enter_the_shared_channel() {
        let mut held = Integration::new("jira", "/jira/issues/**", "rw_test");
        held.path_glob = Some("/jira/issues/**".into());
        held.event_types = Some(vec!["comment.created".into()]);
        let delivery = Delivery {
            text: Some("Jira issue.created\nRelayfile path: /jira/issues/42.json".into()),
            channel_id: Some("events".into()),
            ..Delivery::default()
        };
        let route = |entry: &Integration, event: &Delivery| {
            decide_for_agent_with_integrations(
                event,
                "agent",
                None,
                Some("events"),
                std::slice::from_ref(entry),
            )
        };
        assert!(matches!(route(&held, &delivery), Decision::Skip(_)));
        // A ready broad resource cannot authorize a different pending filter.
        let mut unrelated_broad = Integration::new("jira", "/jira/projects/**", "rw_test");
        unrelated_broad.ready = Some(true);
        unrelated_broad.path_glob = Some("/jira/projects/**".into());
        assert!(matches!(
            decide_for_agent_with_integrations(
                &delivery,
                "agent",
                None,
                Some("events"),
                &[held.clone(), unrelated_broad.clone()]
            ),
            Decision::Skip(_)
        ));
        assert!(matches!(
            decide_for_agent_with_integrations(
                &delivery,
                "agent",
                None,
                Some("events"),
                &[unrelated_broad]
            ),
            Decision::Skip(_)
        ));
        held.ready = Some(true);
        assert!(matches!(route(&held, &delivery), Decision::Skip(_)));
        let requested = Delivery {
            text: Some("Jira comment.created\nRelayfile path: /jira/issues/42.json".into()),
            ..delivery.clone()
        };
        assert_eq!(route(&held, &requested), Decision::Inject);
        held.terminal = Some(true);
        assert!(matches!(route(&held, &requested), Decision::Skip(_)));
        held.terminal = None;
        let mut broad = held.clone();
        broad.event_types = Some(vec![]);
        broad.path_glob = None;

        assert_eq!(
            decide_for_agent_with_integrations(
                &delivery,
                "agent",
                None,
                Some("events"),
                &[held.clone(), broad]
            ),
            Decision::Inject
        );
        let unrelated = Delivery {
            relayfile_path: Some("/jira/other/42.json".into()),
            ..requested.clone()
        };
        assert!(matches!(route(&held, &unrelated), Decision::Skip(_)));
        let missing = Delivery {
            text: Some("Jira comment.created".into()),
            ..requested
        };
        assert!(matches!(route(&held, &missing), Decision::Skip(_)));
        assert!(matches!(
            decide_for_agent_with_integrations(&delivery, "agent", None, Some("events"), &[]),
            Decision::Skip(_)
        ));
    }
    #[test]
    /// Only requested noisy events from a matching ready resource are injected.
    fn explicit_push_and_edits_bypass_only_the_matching_ready_filter() {
        for kind in ["push", "issue_comment.edited"] {
            let mut held = Integration::new("github", "acme/api", "rw_test");
            held.ready = Some(true);
            held.path_glob = Some("/github/repos/acme/api/**".into());
            held.event_types = Some(vec![kind.into()]);
            let mut delivery = Delivery {
                text: Some(format!(
                    "GitHub {kind}\nRelayfile path: /github/repos/acme/api/issues/42/comments/9.json"
                )),
                channel_id: Some("events".into()),
                ..Delivery::default()
            };
            let event = IntegrationEvent::parse(delivery.text.as_deref().unwrap());
            assert!(event.explicitly_requested(&[held.clone()], None, None));
            assert!(matches!(
                decide_for_agent_with_requested(&delivery, "agent", None, Some("events"), true),
                Decision::Inject
            ));
            assert!(matches!(
                decide_for_agent_with_requested(&delivery, "agent", None, Some("events"), false),
                Decision::Skip(_)
            ));
            assert!(!event.explicitly_requested(
                &[held.clone()],
                Some("/github/repos/other/api/issues/42.json"),
                None
            ));
            held.ready = Some(false);
            assert!(!event.explicitly_requested(&[held.clone()], None, None));
            held.ready = Some(true);
            held.event_types = Some(vec![]);
            assert!(!event.explicitly_requested(&[held], None, None));
            delivery.channel_id = Some("other".into());
            assert!(matches!(
                decide_for_agent_with_requested(&delivery, "agent", None, Some("events"), true),
                Decision::Skip(_)
            ));
        }
    }
}
