# Auth Revocation Handling Design

## Problem

Claude (and other AI CLIs) have limited active OAuth sessions. When a user authenticates:
1. **Via relay** → Can revoke their local Claude instance's auth
2. **Locally** → Can revoke the relay workspace agent's auth

Both scenarios need graceful handling.

## Detection Patterns

### Claude CLI Auth Revocation Indicators
```
- "Your session has expired"
- "Please log in again"
- "Authentication required"
- "Unauthorized"
- "session expired"
- "invalid credentials"
- API responses with 401/403
- CLI exit with auth-related error message
```

## Implementation Plan

### 1. Add Auth Error Detection to Parser/Wrapper

**File: `src/wrapper/auth-detection.ts` (new)**
```typescript
export const AUTH_REVOCATION_PATTERNS = [
  /session\s+(has\s+)?expired/i,
  /please\s+log\s*in\s+again/i,
  /authentication\s+required/i,
  /unauthorized/i,
  /invalid\s+credentials/i,
  /not\s+authenticated/i,
  /login\s+required/i,
];

export function detectAuthRevocation(output: string): boolean {
  return AUTH_REVOCATION_PATTERNS.some(pattern => pattern.test(output));
}
```

**File: `src/wrapper/tmux-wrapper.ts` (modify)**
- Import auth detection
- In output processing, check for auth revocation patterns
- When detected, emit 'auth_revoked' event and update status

### 2. Add Agent Status: `auth_revoked`

**File: `src/cloud/db/schema.ts`**
- Document that `status` can be: `active`, `idle`, `ended`, `auth_revoked`

**File: `src/cloud/api/workspaces.ts`**
- Add endpoint to update agent auth status
- Add endpoint to trigger re-authentication

### 3. Relay Protocol Extension

**File: `src/protocol/types.ts`**
Add new envelope type for auth status:
```typescript
export interface AuthStatusPayload {
  agentName: string;
  status: 'revoked' | 'valid';
  provider: string; // 'claude', 'codex', etc.
  message?: string;
}
```

### 4. Dashboard UI

**File: `src/dashboard/react-components/AgentCard.tsx`**
- Show "Auth Required" badge when agent status is `auth_revoked`
- Show "Re-authenticate" button

**File: `src/dashboard/react-components/AuthRevocationNotification.tsx` (new)**
- Toast/banner notification when auth is revoked
- Explains what happened and how to fix

**File: `src/dashboard/react-components/AuthWarningModal.tsx` (new)**
- Warning before authenticating: "This may revoke other active sessions"
- Checkbox: "Don't show again"
- Continue / Cancel buttons

### 5. Re-authentication Flow

When user clicks "Re-authenticate":
1. Opens the existing CLI auth flow (`/api/cli/:provider/start`)
2. On success, agent status updated back to `active`
3. Agent resumes operation (may need to restart or reconnect)

## Files to Create/Modify

### New Files
- `src/wrapper/auth-detection.ts` - Auth error patterns and detection
- `src/dashboard/react-components/AuthRevocationNotification.tsx`
- `src/dashboard/react-components/AuthWarningModal.tsx`

### Modified Files
- `src/wrapper/tmux-wrapper.ts` - Add auth detection in output processing
- `src/wrapper/base-wrapper.ts` - Add auth status events
- `src/protocol/types.ts` - Add AUTH_STATUS envelope type
- `src/daemon/router.ts` - Handle auth status messages
- `src/cloud/api/workspaces.ts` - Add auth status endpoints
- `src/dashboard/react-components/AgentCard.tsx` - Show auth status
- `src/dashboard/react-components/App.tsx` - Handle auth notifications
- `src/cloud/api/onboarding.ts` - Add pre-auth warning flag

## API Endpoints

### POST /api/workspaces/:id/agents/:agentName/reauth
Triggers re-authentication for an agent with revoked auth.

### GET /api/workspaces/:id/agents/:agentName/auth-status
Returns current auth status for an agent.

### POST /api/cli/:provider/start (existing, modify)
Add `skipWarning` parameter to bypass the session limit warning.

## Event Flow

```
1. Agent running in workspace
2. User authenticates Claude locally
3. Cloud auth is revoked
4. Agent CLI outputs "session expired" or similar
5. Wrapper detects pattern → emits AUTH_REVOKED event
6. Daemon receives event → updates agent status
7. Cloud DB updated → status = 'auth_revoked'
8. Dashboard polls/receives status → shows notification
9. User clicks "Re-authenticate"
10. CLI auth flow starts
11. On success → agent status = 'active'
12. Agent resumes (or user restarts agent)
```

## Pre-Auth Warning

Before starting any CLI auth:
1. Check if this is a provider with session limits (Claude, etc.)
2. Show modal: "Authenticating Claude here may sign out other sessions"
3. User confirms → proceed with auth
4. User can check "Don't warn me again" (stored in localStorage)
