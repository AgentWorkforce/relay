# Agent Relay Cloud - Terms of Service Compliance Guide

## Overview

This document outlines how Agent Relay Cloud handles AI provider credentials in team environments and provides guidance for ensuring compliance with upstream provider terms of service (Anthropic, OpenAI, Google, etc.).

## Table of Contents

1. [Credential Architecture](#credential-architecture)
2. [Team Access Model](#team-access-model)
3. [Compliance Concerns](#compliance-concerns)
4. [Recommended Practices](#recommended-practices)
5. [Provider-Specific Guidance](#provider-specific-guidance)
6. [User Responsibilities](#user-responsibilities)
7. [Implementation Checklist](#implementation-checklist)

---

## Credential Architecture

### BYOK (Bring Your Own Keys) Model

Agent Relay Cloud uses a **Bring Your Own Keys** model where:

- Each user authenticates with their own AI provider accounts
- Credentials are workspace-scoped (not shared across workspaces)
- Tokens are stored encrypted and isolated per-user
- CLI tools authenticate directly on workspace instances

```
┌─────────────────────────────────────────────────────────────────┐
│                    CREDENTIAL ISOLATION                          │
│                                                                  │
│  User A                          User B                         │
│  ├─ Claude Account (A)           ├─ Claude Account (B)          │
│  ├─ Workspace 1                  ├─ Workspace 3                 │
│  │   └─ Uses A's credentials     │   └─ Uses B's credentials    │
│  └─ Workspace 2                  └─ Workspace 4                 │
│      └─ Uses A's credentials         └─ Uses B's credentials    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Workspace-Scoped Credentials

Each workspace maintains its own credential set:

```typescript
// From src/cloud/db/schema.ts
credentials = {
  userId: string;       // Owner of the credential
  workspaceId: string;  // Workspace where credential is valid
  provider: string;     // 'anthropic', 'openai', etc.
  // Tokens stored on workspace instance, not centrally
}
```

---

## Team Access Model

### Current Implementation

When team members are added to a workspace:

1. **Workspace Owner** provisions the workspace and connects AI providers
2. **Team Members** are invited with roles (admin, member, viewer)
3. **Agents** in the workspace use the workspace's configured credentials
4. **Messages** from any team member can interact with workspace agents

### The Compliance Gap

```
┌─────────────────────────────────────────────────────────────────┐
│                    CURRENT FLOW (Risk)                           │
│                                                                  │
│  Team Member (no Claude account)                                │
│       │                                                         │
│       ▼                                                         │
│  Sends message to Agent                                         │
│       │                                                         │
│       ▼                                                         │
│  Agent uses OWNER'S Claude credentials ← Potential ToS Issue    │
│       │                                                         │
│       ▼                                                         │
│  Response returned to Team Member                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Issue**: Team members effectively receive Claude API responses without having their own Claude account or agreement with Anthropic.

---

## Compliance Concerns

### 1. Credential Sharing

| Provider | ToS Concern | Risk Level |
|----------|-------------|------------|
| Anthropic (Claude) | API access should not be shared with unauthorized third parties | Medium-High |
| OpenAI (GPT/Codex) | Similar restrictions on sharing API access | Medium-High |
| Google (Gemini) | OAuth tokens are user-specific | Medium |

### 2. Indirect API Access

When User A interacts with an agent using User B's credentials:
- User A receives AI-generated content without their own provider agreement
- Usage is billed to User B's account
- Rate limits apply to User B's quota

### 3. Monetization Implications

If Agent Relay charges for team features that enable this pattern:
- Could be construed as reselling or sublicensing API access
- May require explicit provider partnership agreements

### 4. Data Processing Concerns

- User A's messages are processed by an AI using User B's API key
- Data retention and processing policies apply per User B's agreement
- User A may not have agreed to the provider's data processing terms

---

## Recommended Practices

### Option A: Per-User Credential Requirement (Recommended)

**Require each team member to connect their own AI provider accounts.**

```
┌─────────────────────────────────────────────────────────────────┐
│                    RECOMMENDED FLOW                              │
│                                                                  │
│  Team Member                                                    │
│       │                                                         │
│       ├─── Must connect own Claude account ✓                    │
│       │                                                         │
│       ▼                                                         │
│  Sends message to Agent                                         │
│       │                                                         │
│       ▼                                                         │
│  Agent uses TEAM MEMBER'S credentials ✓                         │
│       │                                                         │
│       ▼                                                         │
│  Response returned (compliant)                                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Benefits:**
- Each user has their own agreement with the AI provider
- Usage is correctly attributed and billed
- Clear compliance with provider ToS
- Rate limits apply per-user as intended

### Option B: Enterprise Agreement Model

For organizations that need centralized billing:

1. Obtain an enterprise agreement from the AI provider that explicitly permits multi-user access
2. Document the agreement and user scope
3. Implement audit logging for compliance
4. Ensure all users agree to the provider's acceptable use policies

### Option C: Explicit Delegation with Disclosure

If per-user credentials are not feasible:

1. Workspace owner explicitly acknowledges they are sharing access
2. Team members acknowledge they are using delegated access
3. Clear disclosure that usage counts against owner's quota
4. Recommendation to review provider ToS before enabling

---

## Provider-Specific Guidance

### Anthropic (Claude)

**Relevant Terms:**
- API access is granted to the account holder
- Sharing API keys with third parties is generally prohibited
- Enterprise plans may have different provisions

**Recommendation:**
- Contact Anthropic for team/enterprise use cases
- Consider Claude for Enterprise or Teams offerings
- Ensure each team member has their own Claude account

**Resources:**
- [Anthropic Terms of Service](https://www.anthropic.com/terms)
- [Anthropic Usage Policy](https://www.anthropic.com/usage-policy)

### OpenAI (GPT/Codex)

**Relevant Terms:**
- API keys should not be shared
- Each user should have their own account for usage tracking
- Enterprise plans available for organizations

**Recommendation:**
- Use OpenAI Enterprise for team deployments
- Implement per-user API key management

### Google (Gemini)

**Relevant Terms:**
- OAuth tokens are user-specific
- API access tied to individual Google Cloud projects
- Workspace/Enterprise plans available

**Recommendation:**
- Use Google Workspace integration for team access
- Consider Google Cloud organization-level billing

---

## User Responsibilities

### Workspace Owners

By creating a workspace and inviting team members, you acknowledge:

1. **Credential Responsibility**: You are responsible for how your AI provider credentials are used within your workspace

2. **Team Member Verification**: You should ensure team members understand and agree to:
   - The AI provider's terms of service
   - The AI provider's acceptable use policy
   - Your organization's usage policies

3. **Usage Monitoring**: You are responsible for monitoring usage against your provider quotas

4. **Compliance**: You are responsible for ensuring your use of team features complies with your AI provider agreements

### Team Members

By joining a workspace, you acknowledge:

1. **Provider Terms**: You should review and understand the AI provider's terms of service

2. **Credential Preference**: You are encouraged to connect your own AI provider accounts

3. **Acceptable Use**: You agree to use AI capabilities in accordance with the provider's acceptable use policy

4. **Data Processing**: Your messages may be processed by AI providers according to their data processing terms

---

## Implementation Checklist

### Phase 1: Disclosure (Immediate)

- [ ] Add ToS compliance notice to team invitation flow
- [ ] Add provider terms links to workspace settings
- [ ] Update privacy policy to address team AI usage
- [ ] Add compliance acknowledgment to team member onboarding

### Phase 2: Per-User Credentials (Short-term)

- [ ] Implement per-user credential requirement for AI interactions
- [ ] Add "Connect your Claude account" prompt for team members
- [ ] Fall back to workspace credentials only if team member has none
- [ ] Add credential source indicator in UI

### Phase 3: Credential Routing (Medium-term)

- [ ] Route agent API calls through the requesting user's credentials
- [ ] Implement credential selection logic based on message sender
- [ ] Add audit logging for credential usage
- [ ] Implement per-user rate limiting within workspaces

### Phase 4: Enterprise Features (Long-term)

- [ ] Support organization-level credential pools
- [ ] Implement admin-managed credential distribution
- [ ] Add compliance reporting and audit trails
- [ ] Support provider enterprise agreement documentation

---

## Technical Implementation Notes

### Credential Routing Architecture

```typescript
// Proposed: Route API calls through requesting user's credentials
interface AgentCallContext {
  workspaceId: string;
  agentName: string;
  requestingUserId: string;  // Who sent the message
  credentialSource: 'user' | 'workspace' | 'organization';
}

async function getCredentialsForCall(context: AgentCallContext): Promise<Credentials> {
  // Priority 1: Use requesting user's own credentials
  const userCredentials = await db.credentials.findByUserAndWorkspace(
    context.requestingUserId,
    context.workspaceId
  );
  if (userCredentials) {
    return { credentials: userCredentials, source: 'user' };
  }

  // Priority 2: Check if workspace allows fallback (with disclosure)
  const workspace = await db.workspaces.findById(context.workspaceId);
  if (workspace.config.allowCredentialFallback) {
    const ownerCredentials = await db.credentials.findByUserAndWorkspace(
      workspace.userId,
      context.workspaceId
    );
    return { credentials: ownerCredentials, source: 'workspace' };
  }

  // Priority 3: Require user to connect their own account
  throw new CredentialRequiredError(
    'Please connect your AI provider account to interact with agents'
  );
}
```

### Audit Logging

```typescript
// Log credential usage for compliance
interface CredentialUsageLog {
  timestamp: Date;
  workspaceId: string;
  requestingUserId: string;
  credentialOwnerId: string;
  provider: string;
  action: 'agent_message' | 'agent_spawn' | 'tool_call';
  credentialSource: 'user' | 'workspace' | 'organization';
}
```

---

## Conclusion

Agent Relay Cloud's team features create potential ToS compliance concerns when team members interact with AI agents using another user's credentials. The recommended approach is to:

1. **Require per-user AI provider authentication** for team members
2. **Route API calls through the requesting user's credentials**
3. **Provide clear disclosure** when workspace credentials are used as fallback
4. **Maintain audit logs** of credential usage for compliance

For enterprise deployments, we recommend contacting AI providers directly to establish appropriate agreements for multi-user access patterns.

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-01-21 | Agent Relay Team | Initial draft |

---

## Contact

For questions about this compliance guide:
- GitHub Issues: https://github.com/AgentWorkforce/relay/issues
- Email: compliance@agent-relay.com (placeholder)
