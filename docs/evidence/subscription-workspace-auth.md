# Provider subscription workspace authentication and wake proof

The resumed worker had real RELAY_WORKSPACE_KEY and RELAY_AGENT_TOKEN values.
A temporary fetch diagnostic recorded GET https://cast.agentrelay.com/v1/agents
returning 401, followed by "Workspace key required (rk_live\*...)". Removing only
RELAY_AGENT_TOKEN made the same request return 200. This was client credential
selection, not missing worker environment, a masked key, or node configuration.
No credential values were logged. Temporary diagnostics were removed.

Integration subscribe/list/unsubscribe (including owned-binding retirement)
require workspace-owner endpoints. They now use createWorkspaceRelay with the
same selected workspace as inbound-target and subscription-channel provisioning.
Explicit --token is rejected with guidance. General agent messaging and other
agent-scoped operations retain createAgentRelay and its ambient-token rules.

Validation: 154 focused CLI/auth tests and CLI typecheck pass. Regression tests
fail before the fix for ambient agent-token setup and explicit-token rejection.
Running the patched source CLI with the original workspace key AND agent token
successfully subscribed webhook-subscription-closeout-r2 to
/github/repos/AgentWorkforce/relayfile/pulls/515/\*\*. The local Relayfile client
used a 120s request budget for this live proof; the deployed 30s default can
still time out on overloaded control-plane operations (separate from auth).

The earlier same-repository Cloud #3896 probe provides the full provider lane:
GitHub comment 5755994597 -> delivery GUID 89e65110-b580-11f1-8407-405863f40b35
-> Relayfile evt_4923952/rev_5368829 -> Relay message 227668215640440832
-> this live agent's next input turn. GitHub delivered at 05:51:51.082Z with
HTTP 200; Relay received at 05:52:12Z (20.918s). Reader confirmation identifies
this owner at 05:56:16Z. The labeled temporary comment was deleted and its
GitHub API returned 404. The provider-side IDs are stored as strings in
subscription-wake-provider.json to preserve integer precision.

This proves issue_comment.created provider subscription delivery and agent
input injection. It does not prove production check_run.completed, fork checks,
or the separate hosted Babysitter flow-listener lane. No merge or deployment
was performed.
