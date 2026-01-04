# Webhook Integrations - Task Breakdown

Tasks for future iterations of the webhook and integrations system.
Convert to beads tasks with: `bd import docs/tasks/webhook-integrations.tasks.md`

## Phase 1: Linear Full Integration [priority: high]

### linear-outbound-comments
- [ ] Create LinearIntegration service class
- [ ] Implement createComment() with Linear GraphQL API
- [ ] Add Linear API key management to workspace settings
- [ ] Add encryption for stored API keys

Dependencies: none
Estimate: 2 story points

### linear-outbound-state
- [ ] Implement setIssueState() for state transitions
- [ ] Implement getAvailableStates() to fetch team states
- [ ] Add state ID caching with TTL

Dependencies: linear-outbound-comments
Estimate: 1 story point

### linear-outbound-issues
- [ ] Implement createIssue() with full CreateIssueInput
- [ ] Implement updateIssue() for editing
- [ ] Implement assignIssue() for assignment changes
- [ ] Add label operations (add/remove)

Dependencies: linear-outbound-state
Estimate: 3 story points

### linear-webhook-state-change
- [ ] Parse issue state change webhooks
- [ ] Add `issue_state_changed` event type
- [ ] Create rule for auto-responding to state changes

Dependencies: none
Estimate: 1 story point

### linear-webhook-due-dates
- [ ] Parse due date approaching events
- [ ] Add `issue_due_soon` event type with configurable threshold
- [ ] Create reminder rule for approaching due dates

Dependencies: linear-webhook-state-change
Estimate: 1 story point

## Phase 2: Slack Enhanced [priority: high]

### slack-slash-commands
- [ ] Create slash command handler endpoint
- [ ] Parse slash command payloads
- [ ] Add slash_command event type
- [ ] Create agent spawning from slash commands

Dependencies: none
Estimate: 2 story points

### slack-interactive-components
- [ ] Handle button click callbacks
- [ ] Handle modal submission callbacks
- [ ] Add interactive_message event type
- [ ] Implement openModal() and updateModal()

Dependencies: slack-slash-commands
Estimate: 3 story points

### slack-rich-messages
- [ ] Implement postBlocks() with Block Kit
- [ ] Add common block templates (code, error, success)
- [ ] Add file upload support
- [ ] Add scheduled message support

Dependencies: none
Estimate: 2 story points

## Phase 3: GitHub Enhanced [priority: high]

### github-pr-management
- [ ] Parse PR opened/updated webhooks
- [ ] Add pr_opened, pr_updated event types
- [ ] Implement PR review request parsing
- [ ] Add createPR() outbound action

Dependencies: none
Estimate: 3 story points

### github-check-runs
- [ ] Implement createCheckRun() for CI status
- [ ] Implement updateCheckRun() for progress
- [ ] Add annotations support for inline errors
- [ ] Parse deployment status webhooks

Dependencies: github-pr-management
Estimate: 2 story points

### github-issue-management
- [ ] Implement createIssue()
- [ ] Implement addLabels() and removeLabels()
- [ ] Implement assignUsers()
- [ ] Add issue linking support

Dependencies: none
Estimate: 2 story points

## Phase 4: Agent Tools [priority: medium]

### agent-integration-tools
- [ ] Create integration tools accessible to agents
- [ ] Add LinearTool for agent actions
- [ ] Add SlackTool for agent messages
- [ ] Add GitHubTool for agent operations

Dependencies: linear-outbound-issues, slack-rich-messages, github-issue-management
Estimate: 4 story points

### agent-permissions
- [ ] Implement AgentIntegrationPermissions type
- [ ] Add permission checking before actions
- [ ] Create permission UI in spawn modal
- [ ] Add audit logging for all external calls

Dependencies: agent-integration-tools
Estimate: 2 story points

## Phase 5: Additional Integrations [priority: low]

### jira-integration
- [ ] Create Jira webhook parser
- [ ] Implement JiraIntegration service
- [ ] Add Jira responder
- [ ] Add workspace settings for Jira

Dependencies: agent-integration-tools
Estimate: 4 story points

### gitlab-integration
- [ ] Create GitLab webhook parser
- [ ] Implement GitLabIntegration service
- [ ] Add GitLab responder
- [ ] Map GitLab events to normalized format

Dependencies: agent-integration-tools
Estimate: 3 story points

### discord-integration
- [ ] Create Discord webhook parser
- [ ] Implement DiscordIntegration service
- [ ] Add Discord responder
- [ ] Handle Discord-specific message formatting

Dependencies: agent-integration-tools
Estimate: 3 story points

## Testing & Infrastructure

### webhook-load-testing
- [ ] Create load test suite for webhook endpoint
- [ ] Measure p50/p95/p99 latencies
- [ ] Test concurrent webhook handling
- [ ] Add rate limiting if needed

Dependencies: none
Estimate: 2 story points

### integration-mocks
- [ ] Create mock Linear API server for tests
- [ ] Create mock Slack API server for tests
- [ ] Create mock GitHub API server for tests
- [ ] Add E2E test suite with mocks

Dependencies: none
Estimate: 3 story points

### sandbox-testing
- [ ] Set up Linear sandbox workspace
- [ ] Set up Slack test workspace
- [ ] Set up GitHub test repository
- [ ] Create E2E test suite with real APIs

Dependencies: integration-mocks
Estimate: 2 story points
