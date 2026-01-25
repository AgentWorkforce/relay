# User Credential Volumes Specification

## Overview

User Credential Volumes enable users to share their CLI credentials (Claude, Codex, Gemini, etc.) across multiple workspaces while maintaining per-user isolation. Each user gets a dedicated credential volume that can be mounted to any workspace they access.

## Goals

- **Cross-Workspace Sharing**: User authenticates once, credentials available on all their workspaces
- **Per-User Isolation**: User A and User B can each have their own credentials on the same workspace
- **Override Support**: Users can override shared credentials with workspace-specific credentials
- **Multi-User Workspaces**: Multiple users can have their credentials mounted on a shared workspace
- **Backward Compatibility**: Existing workspace-local credentials continue to work

## Current Architecture (Before)

### How Credentials Work Today

1. **Database Layer**: `credentials` table tracks provider connections per-workspace
   - Unique constraint: `(userId, provider, workspaceId)`
   - Each workspace has its own credential records

2. **Storage Layer**: Credentials stored on workspace volume at `/data/users/{userId}/`
   ```
   /data/
   └── users/
       └── {userId}/
           ├── .claude/.credentials.json
           ├── .codex/credentials.json
           └── .gemini/.env
   ```

3. **Problem**: Each workspace has its own isolated Fly.io volume
   - Users must re-authenticate on each new workspace
   - No credential sharing between workspaces

## Proposed Architecture

### New Volume Type: User Credential Volumes

Each user gets a dedicated Fly.io volume for their credentials, separate from workspace data volumes.

```
Workspace Machine Mounts:
├── /data              (workspace_data volume) - repos, workspace-specific data
└── /credentials       (user_credentials volumes) - mounted per-user
    ├── {userId1}/     - User 1's credentials
    │   ├── .claude/
    │   ├── .codex/
    │   └── .gemini/
    └── {userId2}/     - User 2's credentials (if multi-user workspace)
        └── ...
```

### Volume Management

**Dedicated Fly App for Credential Volumes**

Rather than creating volumes per-workspace, credential volumes live in a dedicated Fly app (`relay-credentials-{region}`):

```
relay-credentials-iad/
├── vol_user1_abc123   (User 1's credential volume)
├── vol_user2_def456   (User 2's credential volume)
└── ...
```

**Benefits:**
- Volumes can be attached to any workspace machine in the same region
- Centralized management of user credential storage
- Independent lifecycle from workspaces (deleting workspace doesn't delete credentials)

### Multi-Region Support

Fly.io volumes are region-specific. For users with workspaces in multiple regions:

**Option A: Volume Per Region (Recommended)**
- Create credential volume in each region where user has workspaces
- Sync credentials between regions when user authenticates
- Simpler implementation, slight storage overhead

**Option B: Single Region + Object Storage**
- Store credentials in Tigris (Fly's S3-compatible storage)
- Mount via FUSE or sync on workspace start
- More complex, but single source of truth

**Decision**: Option A (Volume Per Region) for v1, with sync mechanism.

## Database Schema

### New Tables

```sql
-- User credential volumes (one per user per region)
CREATE TABLE user_credential_volumes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fly_volume_id VARCHAR(255) NOT NULL,
  fly_app_name VARCHAR(255) NOT NULL,  -- e.g., 'relay-credentials-iad'
  region VARCHAR(50) NOT NULL,
  size_gb INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
  UNIQUE(user_id, region)
);

CREATE INDEX idx_user_credential_volumes_user_id ON user_credential_volumes(user_id);
CREATE INDEX idx_user_credential_volumes_region ON user_credential_volumes(region);

-- Workspace credential settings (per user per workspace)
CREATE TABLE workspace_credential_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Credential source preference
  use_shared_credentials BOOLEAN NOT NULL DEFAULT true,
  -- When false, use workspace-local credentials at /data/users/{userId}/
  -- When true, use shared credentials at /credentials/{userId}/
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
  UNIQUE(workspace_id, user_id)
);

CREATE INDEX idx_workspace_credential_settings_workspace ON workspace_credential_settings(workspace_id);
CREATE INDEX idx_workspace_credential_settings_user ON workspace_credential_settings(user_id);
```

### Schema Migration

```sql
-- Migration: 0042_user_credential_volumes.sql

-- Create user_credential_volumes table
CREATE TABLE IF NOT EXISTS user_credential_volumes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fly_volume_id VARCHAR(255) NOT NULL,
  fly_app_name VARCHAR(255) NOT NULL,
  region VARCHAR(50) NOT NULL,
  size_gb INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
  UNIQUE(user_id, region)
);

CREATE INDEX IF NOT EXISTS idx_user_credential_volumes_user_id ON user_credential_volumes(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credential_volumes_region ON user_credential_volumes(region);

-- Create workspace_credential_settings table
CREATE TABLE IF NOT EXISTS workspace_credential_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  use_shared_credentials BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
  UNIQUE(workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_credential_settings_workspace ON workspace_credential_settings(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_credential_settings_user ON workspace_credential_settings(user_id);
```

## Implementation Details

### 1. Credential Volume Service

```typescript
// packages/cloud/src/provisioner/credential-volumes.ts

export interface CredentialVolumeConfig {
  flyApiToken: string;
  credentialAppPrefix: string;  // 'relay-credentials'
}

export class CredentialVolumeService {
  private config: CredentialVolumeConfig;
  
  constructor(config: CredentialVolumeConfig) {
    this.config = config;
  }
  
  /**
   * Get or create a credential volume for a user in a specific region.
   * Creates the credential app if it doesn't exist.
   */
  async getOrCreateVolume(
    userId: string,
    region: string
  ): Promise<{ volumeId: string; appName: string }> {
    // Check if volume already exists
    const existing = await db.userCredentialVolumes.findByUserAndRegion(userId, region);
    if (existing) {
      return {
        volumeId: existing.flyVolumeId,
        appName: existing.flyAppName,
      };
    }
    
    // Ensure credential app exists for this region
    const appName = `${this.config.credentialAppPrefix}-${region}`;
    await this.ensureCredentialApp(appName, region);
    
    // Create volume
    const volumeName = `creds-${userId.substring(0, 8)}`;
    const response = await fetchWithRetry(
      `https://api.machines.dev/v1/apps/${appName}/volumes`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.flyApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: volumeName,
          region,
          size_gb: 1,  // 1GB should be plenty for credentials
          auto_backup_enabled: true,
          snapshot_retention: 7,  // Keep 7 days of snapshots
        }),
      }
    );
    
    if (!response.ok) {
      throw new Error(`Failed to create credential volume: ${await response.text()}`);
    }
    
    const volume = await response.json() as { id: string };
    
    // Save to database
    await db.userCredentialVolumes.create({
      userId,
      flyVolumeId: volume.id,
      flyAppName: appName,
      region,
      sizeGb: 1,
    });
    
    return {
      volumeId: volume.id,
      appName,
    };
  }
  
  /**
   * Ensure the credential app exists for a region.
   * Credential apps are lightweight - they just hold volumes.
   */
  private async ensureCredentialApp(appName: string, region: string): Promise<void> {
    // Check if app exists
    const checkResponse = await fetch(
      `https://api.machines.dev/v1/apps/${appName}`,
      {
        headers: { Authorization: `Bearer ${this.config.flyApiToken}` },
      }
    );
    
    if (checkResponse.ok) {
      return;  // App already exists
    }
    
    // Create app
    const orgSlug = process.env.FLY_ORG || 'agent-relay';
    await fetchWithRetry(
      'https://api.machines.dev/v1/apps',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.flyApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          app_name: appName,
          org_slug: orgSlug,
        }),
      }
    );
    
    console.log(`[credential-volumes] Created credential app: ${appName}`);
  }
  
  /**
   * List all credential volumes for a user (across all regions).
   */
  async listUserVolumes(userId: string): Promise<Array<{
    region: string;
    volumeId: string;
    appName: string;
  }>> {
    const volumes = await db.userCredentialVolumes.findByUserId(userId);
    return volumes.map(v => ({
      region: v.region,
      volumeId: v.flyVolumeId,
      appName: v.flyAppName,
    }));
  }
  
  /**
   * Delete a user's credential volume in a specific region.
   */
  async deleteVolume(userId: string, region: string): Promise<void> {
    const volume = await db.userCredentialVolumes.findByUserAndRegion(userId, region);
    if (!volume) {
      return;
    }
    
    // Delete from Fly
    await fetchWithRetry(
      `https://api.machines.dev/v1/apps/${volume.flyAppName}/volumes/${volume.flyVolumeId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.config.flyApiToken}` },
      }
    );
    
    // Delete from database
    await db.userCredentialVolumes.delete(volume.id);
  }
}
```

### 2. Provisioner Changes

Modify `FlyProvisioner` to mount credential volumes:

```typescript
// packages/cloud/src/provisioner/index.ts

interface ProvisionOptions {
  workspace: Workspace;
  credentials: Map<string, string>;
  userCredentialVolumes?: Array<{
    userId: string;
    volumeId: string;
  }>;
}

async provision(options: ProvisionOptions): Promise<ProvisionResult> {
  const { workspace, credentials, userCredentialVolumes = [] } = options;
  
  // ... existing volume creation for workspace data ...
  
  // Build mounts array
  const mounts = [
    {
      volume: workspaceVolume.id,
      path: '/data',
    },
  ];
  
  // Add credential volume mounts
  for (const credVol of userCredentialVolumes) {
    mounts.push({
      volume: credVol.volumeId,
      path: `/credentials/${credVol.userId}`,
    });
  }
  
  // Create machine with all mounts
  const machineConfig = {
    // ... existing config ...
    mounts,
  };
  
  // ... rest of provisioning ...
}
```

### 3. UserDirectoryService Updates

Update to check shared credentials first:

```typescript
// packages/user-directory/src/user-directory.ts

export class UserDirectoryService {
  private baseDir: string;
  private credentialsBaseDir: string;
  
  constructor(baseDir: string, credentialsBaseDir: string = '/credentials') {
    this.baseDir = baseDir;
    this.credentialsBaseDir = credentialsBaseDir;
  }
  
  /**
   * Get the effective credential path for a user/provider.
   * Checks shared credentials first, falls back to workspace-local.
   */
  getEffectiveCredentialPath(
    userId: string,
    provider: string,
    useSharedCredentials: boolean = true
  ): string {
    if (useSharedCredentials) {
      // Check shared credential volume first
      const sharedPath = path.join(
        this.credentialsBaseDir,
        userId,
        this.getProviderDir(provider),
        this.getCredentialFile(provider)
      );
      
      if (fs.existsSync(sharedPath)) {
        return sharedPath;
      }
    }
    
    // Fall back to workspace-local credentials
    return this.getProviderCredentialPath(userId, provider);
  }
  
  /**
   * Get environment variables for spawning an agent.
   * Points HOME to shared credentials if available.
   */
  getUserEnvironment(
    userId: string,
    useSharedCredentials: boolean = true
  ): Record<string, string> {
    // Check if shared credentials exist
    const sharedHome = path.join(this.credentialsBaseDir, userId);
    const useShared = useSharedCredentials && fs.existsSync(sharedHome);
    
    const effectiveHome = useShared ? sharedHome : this.getUserHome(userId);
    
    return {
      HOME: effectiveHome,
      XDG_CONFIG_HOME: path.join(effectiveHome, '.config'),
      AGENT_RELAY_USER_ID: userId,
      AGENT_RELAY_CREDENTIAL_SOURCE: useShared ? 'shared' : 'workspace',
    };
  }
  
  /**
   * Write credentials to the appropriate location.
   * Writes to shared volume if available, otherwise workspace-local.
   */
  writeCredentials(
    userId: string,
    provider: string,
    data: unknown,
    useSharedCredentials: boolean = true
  ): string {
    const targetDir = useSharedCredentials
      ? path.join(this.credentialsBaseDir, userId, this.getProviderDir(provider))
      : this.ensureProviderDir(userId, provider);
    
    this.ensureDirectory(targetDir);
    
    const credPath = path.join(targetDir, this.getCredentialFile(provider));
    
    if (provider === 'gemini' || provider === 'google') {
      // Gemini uses .env format
      fs.writeFileSync(credPath, `GEMINI_API_KEY="${data}"\n`, { mode: 0o600 });
    } else {
      fs.writeFileSync(credPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    }
    
    return credPath;
  }
}
```

### 4. CLI Auth Flow Updates

Update CLI auth to write to shared credentials:

```typescript
// packages/daemon/src/cli-auth.ts

async function completeAuth(
  session: AuthSession,
  userId: string,
  options: { useSharedCredentials?: boolean } = {}
): Promise<void> {
  const { useSharedCredentials = true } = options;
  
  // Get user directory service
  const userDirService = getUserDirectoryService();
  
  // Determine credential target
  const credentialSource = useSharedCredentials ? 'shared' : 'workspace';
  
  // Extract credentials from CLI
  const credentials = await extractCredentials(session.provider, session.sessionId);
  
  if (credentials) {
    // Write to appropriate location
    userDirService.writeCredentials(
      userId,
      session.provider,
      credentials,
      useSharedCredentials
    );
    
    logger.info('Credentials written', {
      provider: session.provider,
      userId,
      source: credentialSource,
    });
  }
}
```

### 5. Credential Sync Between Regions

When user authenticates, sync to all their credential volumes:

```typescript
// packages/cloud/src/provisioner/credential-sync.ts

export class CredentialSyncService {
  private credentialVolumeService: CredentialVolumeService;
  
  /**
   * Sync credentials from source region to all other regions.
   * Called after successful CLI authentication.
   */
  async syncCredentials(
    userId: string,
    provider: string,
    sourceRegion: string
  ): Promise<void> {
    // Get all user's credential volumes
    const volumes = await this.credentialVolumeService.listUserVolumes(userId);
    
    // Filter out source region
    const targetVolumes = volumes.filter(v => v.region !== sourceRegion);
    
    if (targetVolumes.length === 0) {
      return;  // No other regions to sync to
    }
    
    // Read credentials from source
    const sourceCredentials = await this.readCredentialsFromVolume(
      userId,
      provider,
      sourceRegion
    );
    
    if (!sourceCredentials) {
      return;  // No credentials to sync
    }
    
    // Write to all target regions
    await Promise.all(
      targetVolumes.map(v =>
        this.writeCredentialsToVolume(userId, provider, v.region, sourceCredentials)
      )
    );
    
    console.log(`[credential-sync] Synced ${provider} credentials for user ${userId} to ${targetVolumes.length} regions`);
  }
  
  /**
   * Read credentials from a volume.
   * Requires a temporary machine to access the volume.
   */
  private async readCredentialsFromVolume(
    userId: string,
    provider: string,
    region: string
  ): Promise<unknown | null> {
    // Implementation: spin up ephemeral machine, read file, destroy machine
    // Or use Fly's volume snapshot/restore APIs
    // TODO: Implement based on Fly API capabilities
    return null;
  }
  
  /**
   * Write credentials to a volume.
   */
  private async writeCredentialsToVolume(
    userId: string,
    provider: string,
    region: string,
    credentials: unknown
  ): Promise<void> {
    // Implementation: spin up ephemeral machine, write file, destroy machine
    // TODO: Implement based on Fly API capabilities
  }
}
```

### 6. Dashboard UI Changes

Add credential settings to workspace settings panel:

```typescript
// packages/dashboard/ui/react-components/settings/CredentialSettingsPanel.tsx

interface CredentialSettingsProps {
  workspaceId: string;
  userId: string;
}

export function CredentialSettingsPanel({ workspaceId, userId }: CredentialSettingsProps) {
  const [settings, setSettings] = useState<{
    useSharedCredentials: boolean;
    sharedCredentialsAvailable: boolean;
    connectedProviders: string[];
  } | null>(null);
  
  useEffect(() => {
    fetchCredentialSettings(workspaceId, userId).then(setSettings);
  }, [workspaceId, userId]);
  
  const handleToggleShared = async (useShared: boolean) => {
    await updateCredentialSettings(workspaceId, userId, { useSharedCredentials: useShared });
    setSettings(prev => prev ? { ...prev, useSharedCredentials: useShared } : null);
  };
  
  if (!settings) return <LoadingSpinner />;
  
  return (
    <div className="credential-settings">
      <h3>Credential Settings</h3>
      
      <div className="setting-row">
        <label>
          <input
            type="checkbox"
            checked={settings.useSharedCredentials}
            onChange={(e) => handleToggleShared(e.target.checked)}
            disabled={!settings.sharedCredentialsAvailable}
          />
          Use shared credentials across workspaces
        </label>
        {!settings.sharedCredentialsAvailable && (
          <p className="hint">
            Authenticate with a CLI provider to enable shared credentials.
          </p>
        )}
      </div>
      
      {settings.useSharedCredentials && (
        <div className="info-box">
          <p>
            Your CLI credentials are stored in a shared volume and will be
            available on all your workspaces.
          </p>
        </div>
      )}
      
      {!settings.useSharedCredentials && (
        <div className="info-box warning">
          <p>
            Credentials are workspace-specific. You'll need to authenticate
            separately on each workspace.
          </p>
        </div>
      )}
      
      <h4>Connected Providers</h4>
      <ul className="provider-list">
        {settings.connectedProviders.map(provider => (
          <li key={provider}>
            <ProviderIcon provider={provider} />
            <span>{provider}</span>
            <span className="status">Connected</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### 7. API Endpoints

```typescript
// packages/cloud/src/api/credentials.ts

// GET /api/users/:userId/credential-volumes
// List user's credential volumes across regions
credentialsRouter.get('/users/:userId/credential-volumes', requireAuth, async (req, res) => {
  const { userId } = req.params;
  
  // Verify user owns this or is admin
  if (req.user.id !== userId && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  const volumes = await credentialVolumeService.listUserVolumes(userId);
  res.json({ volumes });
});

// POST /api/users/:userId/credential-volumes
// Create credential volume in a region
credentialsRouter.post('/users/:userId/credential-volumes', requireAuth, async (req, res) => {
  const { userId } = req.params;
  const { region } = req.body;
  
  if (req.user.id !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  const volume = await credentialVolumeService.getOrCreateVolume(userId, region);
  res.json({ volume });
});

// GET /api/workspaces/:workspaceId/credential-settings
// Get credential settings for current user on workspace
credentialsRouter.get('/workspaces/:workspaceId/credential-settings', requireAuth, async (req, res) => {
  const { workspaceId } = req.params;
  const userId = req.user.id;
  
  const settings = await db.workspaceCredentialSettings.findByWorkspaceAndUser(
    workspaceId,
    userId
  );
  
  // Check if shared credentials are available
  const workspace = await db.workspaces.findById(workspaceId);
  const volumes = await credentialVolumeService.listUserVolumes(userId);
  const hasVolumeInRegion = volumes.some(v => v.region === workspace.region);
  
  res.json({
    useSharedCredentials: settings?.useSharedCredentials ?? true,
    sharedCredentialsAvailable: hasVolumeInRegion,
  });
});

// PUT /api/workspaces/:workspaceId/credential-settings
// Update credential settings for current user on workspace
credentialsRouter.put('/workspaces/:workspaceId/credential-settings', requireAuth, async (req, res) => {
  const { workspaceId } = req.params;
  const userId = req.user.id;
  const { useSharedCredentials } = req.body;
  
  await db.workspaceCredentialSettings.upsert({
    workspaceId,
    userId,
    useSharedCredentials,
  });
  
  res.json({ success: true });
});
```

## Fly.io Volume Attachment

### Challenge: Cross-App Volume Mounting

Fly.io volumes are scoped to apps. To mount a credential volume from `relay-credentials-iad` to a workspace machine in `relay-workspace-abc123`, we need to use Fly's volume attachment feature.

### Solution: Volume Cloning or Attachment

**Option A: Volume Attachment (If Supported)**
```bash
# Attach volume from credential app to workspace app
fly volumes attach vol_abc123 --app relay-workspace-xyz789
```

**Option B: NFS/Network Mount**
- Run a small NFS server in the credential app
- Mount via NFS from workspace machines
- More complex but more flexible

**Option C: Credential Sync Service**
- On workspace start, sync credentials from credential volume to workspace volume
- Simpler but requires sync on each start

**Decision**: Start with Option C (sync on start) for v1, evaluate volume attachment for v2.

### Sync-on-Start Implementation

```typescript
// packages/daemon/src/credential-sync.ts

/**
 * Sync credentials from cloud to workspace on startup.
 * Called during daemon initialization.
 */
export async function syncCredentialsOnStart(
  userId: string,
  cloudUrl: string,
  daemonToken: string
): Promise<void> {
  try {
    // Fetch credential data from cloud
    const response = await fetch(`${cloudUrl}/api/daemons/credentials/sync`, {
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        'X-User-Id': userId,
      },
    });
    
    if (!response.ok) {
      console.warn('[credential-sync] Failed to fetch credentials from cloud');
      return;
    }
    
    const { credentials } = await response.json() as {
      credentials: Array<{
        provider: string;
        data: unknown;
      }>;
    };
    
    // Write credentials to local storage
    const userDirService = getUserDirectoryService();
    for (const cred of credentials) {
      userDirService.writeCredentials(userId, cred.provider, cred.data, false);
    }
    
    console.log(`[credential-sync] Synced ${credentials.length} credentials for user ${userId}`);
  } catch (err) {
    console.error('[credential-sync] Error syncing credentials:', err);
  }
}
```

## Security Considerations

### Volume Isolation

- Each user's credential volume is only mounted to workspaces they have access to
- Volumes are created with restrictive permissions (0600)
- Credential files are owned by the workspace user

### Token Storage

- Actual OAuth tokens remain in credential files, not in cloud database
- Cloud database only tracks which providers are connected (metadata)
- Tokens never transit through cloud API (except during sync)

### Multi-User Workspace Security

- Each user's credentials are in separate directories (`/credentials/{userId}/`)
- Users cannot access each other's credential directories
- Workspace owner can see which users have credentials mounted (not the actual tokens)

### Credential Sync Security

- Sync uses daemon authentication (machine API key)
- Credentials encrypted in transit (HTTPS)
- Consider adding encryption at rest for credential volumes

## Migration Path

### Phase 1: Database Schema
1. Add `user_credential_volumes` table
2. Add `workspace_credential_settings` table
3. Deploy migration

### Phase 2: Credential Volume Service
1. Implement `CredentialVolumeService`
2. Create credential apps per region
3. Add API endpoints

### Phase 3: Provisioner Integration
1. Update `FlyProvisioner` to support credential volume mounts
2. Implement sync-on-start for existing workspaces
3. Test with new workspace provisioning

### Phase 4: CLI Auth Updates
1. Update CLI auth flow to write to shared credentials
2. Implement credential sync between regions
3. Test cross-workspace credential sharing

### Phase 5: Dashboard UI
1. Add credential settings panel
2. Add toggle for shared vs workspace-specific
3. Show credential status across workspaces

### Phase 6: Migration of Existing Users
1. Offer migration for existing workspace credentials
2. Create credential volumes for active users
3. Sync existing credentials to shared volumes

## Testing Strategy

### Unit Tests

- Credential volume creation/deletion
- Credential path resolution (shared vs workspace-local)
- Settings toggle logic
- Region sync logic

### Integration Tests

- End-to-end credential volume provisioning
- Cross-workspace credential access
- Multi-user workspace scenarios
- Override behavior (workspace-specific credentials)

### Manual Testing

1. Create new user, authenticate Claude CLI
2. Verify credential volume created
3. Create second workspace, verify credentials available
4. Toggle to workspace-specific, re-authenticate
5. Verify override works
6. Toggle back to shared, verify original credentials restored

## Open Questions

1. **Volume Size**: 1GB should be plenty, but should we allow expansion?
   - **Decision**: Start with 1GB, add expansion API if needed

2. **Credential Expiry**: Should we track token expiry and prompt re-auth?
   - **Decision**: Not in v1, add monitoring later

3. **Backup/Restore**: Should users be able to backup/restore credentials?
   - **Decision**: Fly auto-snapshots provide this, expose in UI later

4. **Team Credentials**: Should teams be able to share credentials?
   - **Decision**: Not in v1, significant security implications

5. **Credential Rotation**: How to handle provider token rotation?
   - **Decision**: Re-auth flow handles this, sync propagates new tokens

## Success Criteria

- [ ] Users can authenticate once and use credentials across workspaces
- [ ] Multiple users can have credentials on the same workspace
- [ ] Users can override with workspace-specific credentials
- [ ] Credential volumes are created lazily (on first auth)
- [ ] Credentials sync between regions
- [ ] Dashboard shows credential status
- [ ] Existing workspace credentials continue to work
- [ ] Security: users cannot access each other's credentials

## Appendix: Fly.io API Reference

### Create Volume
```bash
POST https://api.machines.dev/v1/apps/{app_name}/volumes
{
  "name": "creds-user123",
  "region": "iad",
  "size_gb": 1,
  "auto_backup_enabled": true,
  "snapshot_retention": 7
}
```

### List Volumes
```bash
GET https://api.machines.dev/v1/apps/{app_name}/volumes
```

### Delete Volume
```bash
DELETE https://api.machines.dev/v1/apps/{app_name}/volumes/{volume_id}
```

### Create Machine with Multiple Mounts
```bash
POST https://api.machines.dev/v1/apps/{app_name}/machines
{
  "config": {
    "mounts": [
      { "volume": "vol_workspace", "path": "/data" },
      { "volume": "vol_creds", "path": "/credentials/user123" }
    ]
  }
}
```
