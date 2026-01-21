# Per-Workspace Custom Utility Installation

## Overview

This design enables workspace owners to install custom utilities, packages, and tools that are available to all agents running in their workspace. The solution leverages the existing JSONB `config` field for schema-less configuration without requiring database migrations.

## Goals

1. **Zero-migration design** - Use existing JSONB config field
2. **Support multiple installation types** - NPM packages, system packages, custom scripts
3. **Persistence across restarts** - Utilities survive workspace restarts
4. **Post-provisioning installation** - Install utilities without reprovisioning
5. **Environment variable injection** - Custom env vars available to all agents
6. **Security-conscious** - Validate inputs, isolate execution

## Architecture

### 1. Schema Extension

Extend `WorkspaceConfig` interface in `src/cloud/db/schema.ts`:

```typescript
export interface WorkspaceConfig {
  // ... existing fields ...
  providers?: string[];
  repositories?: string[];
  supervisorEnabled?: boolean;
  maxAgents?: number;
  resourceTier?: 'small' | 'medium' | 'large' | 'xlarge';
  agentPolicy?: WorkspaceAgentPolicy;

  // NEW: Custom utilities configuration
  customUtilities?: CustomUtilitiesConfig;
}

export interface CustomUtilitiesConfig {
  /** Schema version for backward compatibility */
  version: 1;

  /** NPM packages to install globally */
  npmPackages?: NpmPackageSpec[];

  /** System packages (apt) to install */
  systemPackages?: SystemPackageSpec[];

  /** Custom environment variables */
  environmentVariables?: EnvironmentVariableSpec[];

  /** Custom setup scripts to run */
  setupScripts?: SetupScriptSpec[];

  /** Installation status tracking */
  installationStatus?: InstallationStatus;
}

export interface NpmPackageSpec {
  /** Package name (e.g., "typescript", "@anthropic/sdk") */
  name: string;
  /** Version constraint (e.g., "^5.0.0", "latest") */
  version?: string;
  /** Install globally (default: true for CLI tools, false for libs) */
  global?: boolean;
}

export interface SystemPackageSpec {
  /** Package name as known to apt (e.g., "jq", "redis-tools") */
  name: string;
  /** Alternative package name if different from 'name' */
  aptPackage?: string;
  /** Version constraint (note: apt version pinning is limited) */
  version?: string;
}

export interface EnvironmentVariableSpec {
  /** Variable name */
  name: string;
  /** Variable value (plaintext for non-secrets, vault reference for secrets) */
  value: string;
  /** If true, value is stored encrypted in Vault, not in workspace config */
  isSecret?: boolean;
  /** Description shown in UI */
  description?: string;
}

export interface SetupScriptSpec {
  /** Script identifier for logging/tracking */
  name: string;
  /** Script content (base64 encoded for safety). Either content or sourceUrl required. */
  content?: string;
  /** URL to fetch script from (alternative to base64 content). Must be HTTPS. */
  sourceUrl?: string;
  /** Run as root (default: false, runs as workspace user) */
  runAsRoot?: boolean;
  /** Run order (lower runs first, default: 100) */
  order?: number;
  /** Execution timeout in milliseconds (default: 300000 = 5 minutes) */
  timeoutMs?: number;
  /** Dependencies that must be installed first (e.g., ["apt:curl", "npm:typescript"]) */
  dependsOn?: string[];
}

export interface InstallationStatus {
  /** Overall status */
  status: 'pending' | 'installing' | 'installed' | 'failed';
  /** Last installation attempt timestamp */
  lastAttempt?: string;
  /** Per-item installation status */
  items?: Record<string, {
    status: 'pending' | 'installed' | 'failed';
    error?: string;
    installedAt?: string;
  }>;
}
```

### 2. Installation Tiers

#### Tier 1: Provisioning-time Installation

During workspace provisioning, utilities are installed before the daemon starts.

**Flow:**
1. Cloud server provisions workspace with `customUtilities` in config
2. `CUSTOM_UTILITIES` env var is passed to container (JSON-encoded config)
3. `entrypoint.sh` runs utility installation before daemon startup
4. Status is written to `/data/utilities/status.json`

**entrypoint.sh additions:**
```bash
# ============================================================================
# Custom Utilities Installation
# ============================================================================

install_custom_utilities() {
  if [[ -z "${CUSTOM_UTILITIES:-}" ]]; then
    return 0
  fi

  log "Installing custom utilities..."
  local status_file="/data/utilities/status.json"
  mkdir -p /data/utilities

  # Initialize status
  echo '{"status":"installing","lastAttempt":"'$(date -Iseconds)'","items":{}}' > "$status_file"

  # Parse and install NPM packages
  local npm_packages=$(echo "$CUSTOM_UTILITIES" | jq -r '.npmPackages[]? | "\(.name)@\(.version // "latest")"')
  for pkg in $npm_packages; do
    log "Installing npm package: $pkg"
    if npm install -g "$pkg" 2>&1; then
      update_status "$status_file" "npm:$pkg" "installed"
    else
      update_status "$status_file" "npm:$pkg" "failed" "npm install failed"
    fi
  done

  # Parse and install system packages
  local sys_packages=$(echo "$CUSTOM_UTILITIES" | jq -r '.systemPackages[]? | .aptPackage // .name')
  if [[ -n "$sys_packages" ]]; then
    apt-get update -qq
    for pkg in $sys_packages; do
      log "Installing system package: $pkg"
      if apt-get install -y -qq "$pkg" 2>&1; then
        update_status "$status_file" "apt:$pkg" "installed"
      else
        update_status "$status_file" "apt:$pkg" "failed" "apt install failed"
      fi
    done
  fi

  # Set environment variables (resolve vault references at runtime)
  local env_vars=$(echo "$CUSTOM_UTILITIES" | jq -r '.environmentVariables[]? | "export \(.name)=\"\(.value)\""')
  if [[ -n "$env_vars" ]]; then
    echo "# Custom workspace environment variables" >> /etc/profile.d/workspace-env.sh
    # Note: vault: prefixed values are resolved by the daemon at agent spawn time
    echo "$env_vars" >> /etc/profile.d/workspace-env.sh
  fi

  # Run setup scripts (sorted by order, respecting dependencies)
  local scripts=$(echo "$CUSTOM_UTILITIES" | jq -r '.setupScripts | sort_by(.order // 100)[]? | @base64')
  for script_b64 in $scripts; do
    local script=$(echo "$script_b64" | base64 -d)
    local script_name=$(echo "$script" | jq -r '.name')
    local script_content=$(echo "$script" | jq -r '.content // empty')
    local script_url=$(echo "$script" | jq -r '.sourceUrl // empty')
    local run_as_root=$(echo "$script" | jq -r '.runAsRoot // false')

    log "Running setup script: $script_name"
    local script_file="/tmp/setup-${script_name}.sh"

    # Get script content from URL or base64
    if [[ -n "$script_url" ]]; then
      log "Fetching script from: $script_url"
      curl -fsSL "$script_url" > "$script_file" || {
        update_status "$status_file" "script:$script_name" "failed" "Failed to fetch script from URL"
        continue
      }
    elif [[ -n "$script_content" ]]; then
      echo "$script_content" | base64 -d > "$script_file"
    else
      update_status "$status_file" "script:$script_name" "failed" "No content or sourceUrl provided"
      continue
    fi
    chmod +x "$script_file"

    if [[ "$run_as_root" == "true" ]]; then
      if bash "$script_file" 2>&1; then
        update_status "$status_file" "script:$script_name" "installed"
      else
        update_status "$status_file" "script:$script_name" "failed" "script execution failed"
      fi
    else
      if sudo -u workspace bash "$script_file" 2>&1; then
        update_status "$status_file" "script:$script_name" "installed"
      else
        update_status "$status_file" "script:$script_name" "failed" "script execution failed"
      fi
    fi
    rm -f "$script_file"
  done

  # Update final status
  if jq -e '.items | to_entries | map(select(.value.status == "failed")) | length == 0' "$status_file" > /dev/null; then
    jq '.status = "installed"' "$status_file" > "$status_file.tmp" && mv "$status_file.tmp" "$status_file"
    log "Custom utilities installed successfully"
  else
    jq '.status = "failed"' "$status_file" > "$status_file.tmp" && mv "$status_file.tmp" "$status_file"
    log "WARNING: Some utilities failed to install"
  fi
}

update_status() {
  local file="$1" key="$2" status="$3" error="${4:-}"
  local ts=$(date -Iseconds)
  if [[ -n "$error" ]]; then
    jq --arg k "$key" --arg s "$status" --arg e "$error" --arg t "$ts" \
      '.items[$k] = {status: $s, error: $e, installedAt: $t}' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  else
    jq --arg k "$key" --arg s "$status" --arg t "$ts" \
      '.items[$k] = {status: $s, installedAt: $t}' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  fi
}
```

#### Tier 2: Post-provisioning Installation

Install utilities in a running workspace without reprovisioning.

**New API Endpoints:**

```typescript
// src/cloud/api/workspaces.ts

// GET /api/workspaces/:id/utilities
// Returns current utility configuration and installation status
router.get('/:id/utilities', requireWorkspaceAccess, async (req, res) => {
  const workspace = await getWorkspace(req.params.id);
  const utilities = workspace.config.customUtilities || { version: 1 };

  // Fetch live status from workspace if running
  if (workspace.status === 'running' && workspace.publicUrl) {
    try {
      const statusRes = await fetch(`${workspace.publicUrl}/api/utilities/status`, {
        headers: { Authorization: `Bearer ${workspace.token}` }
      });
      const liveStatus = await statusRes.json();
      utilities.installationStatus = liveStatus;
    } catch (e) {
      // Use stored status if workspace unreachable
    }
  }

  res.json(utilities);
});

// POST /api/workspaces/:id/utilities
// Install or update utilities
router.post('/:id/utilities', requireWorkspaceAccess, async (req, res) => {
  const { npmPackages, systemPackages, environmentVariables, setupScripts } = req.body;
  const workspace = await getWorkspace(req.params.id);

  // Validate input
  const validation = validateUtilitiesConfig(req.body);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.errors });
  }

  // Merge with existing config
  const newConfig = {
    ...workspace.config,
    customUtilities: {
      version: 1,
      npmPackages: mergePackages(workspace.config.customUtilities?.npmPackages, npmPackages),
      systemPackages: mergePackages(workspace.config.customUtilities?.systemPackages, systemPackages),
      environmentVariables: { ...workspace.config.customUtilities?.environmentVariables, ...environmentVariables },
      setupScripts: mergeScripts(workspace.config.customUtilities?.setupScripts, setupScripts),
      installationStatus: { status: 'pending' }
    }
  };

  // Update database
  await updateWorkspaceConfig(workspace.id, newConfig);

  // Trigger installation if workspace is running
  if (workspace.status === 'running' && workspace.publicUrl) {
    const installRes = await fetch(`${workspace.publicUrl}/api/utilities/install`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${workspace.token}`
      },
      body: JSON.stringify(newConfig.customUtilities)
    });

    if (!installRes.ok) {
      return res.status(500).json({ error: 'Failed to trigger installation' });
    }

    const job = await installRes.json();
    return res.json({
      message: 'Installation started',
      jobId: job.id,
      config: newConfig.customUtilities
    });
  }

  res.json({
    message: 'Configuration saved (will install on next workspace start)',
    config: newConfig.customUtilities
  });
});

// DELETE /api/workspaces/:id/utilities/:type/:name
// Remove a specific utility
router.delete('/:id/utilities/:type/:name', requireWorkspaceAccess, async (req, res) => {
  const { type, name } = req.params;
  const workspace = await getWorkspace(req.params.id);

  // Remove from config
  const utilities = workspace.config.customUtilities || { version: 1 };

  switch (type) {
    case 'npm':
      utilities.npmPackages = utilities.npmPackages?.filter(p => p.name !== name);
      break;
    case 'apt':
      utilities.systemPackages = utilities.systemPackages?.filter(p => p.name !== name);
      break;
    case 'env':
      delete utilities.environmentVariables?.[name];
      break;
    case 'script':
      utilities.setupScripts = utilities.setupScripts?.filter(s => s.name !== name);
      break;
  }

  await updateWorkspaceConfig(workspace.id, { ...workspace.config, customUtilities: utilities });

  // Trigger uninstall if workspace is running
  if (workspace.status === 'running' && workspace.publicUrl) {
    await fetch(`${workspace.publicUrl}/api/utilities/uninstall`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${workspace.token}`
      },
      body: JSON.stringify({ type, name })
    });
  }

  res.json({ message: 'Utility removed' });
});
```

**Workspace Daemon Endpoints:**

```typescript
// src/daemon/api/utilities.ts (new file)

// GET /api/utilities/status
// Returns installation status from /data/utilities/status.json
router.get('/status', async (req, res) => {
  try {
    const status = await fs.readFile('/data/utilities/status.json', 'utf-8');
    res.json(JSON.parse(status));
  } catch (e) {
    res.json({ status: 'not_configured', items: {} });
  }
});

// POST /api/utilities/install
// Installs utilities in the running workspace
router.post('/install', requireWorkspaceToken, async (req, res) => {
  const config = req.body as CustomUtilitiesConfig;

  // Create job for tracking
  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    status: 'running',
    startedAt: new Date().toISOString(),
    config
  };

  // Store job state
  await fs.writeFile(`/data/utilities/jobs/${jobId}.json`, JSON.stringify(job));

  // Run installation in background
  installUtilitiesAsync(jobId, config).catch(err => {
    logger.error('Utility installation failed', { jobId, error: err.message });
  });

  res.json({ id: jobId, status: 'running' });
});

// GET /api/utilities/jobs/:id
// Get job status
router.get('/jobs/:id', async (req, res) => {
  try {
    const job = await fs.readFile(`/data/utilities/jobs/${req.params.id}.json`, 'utf-8');
    res.json(JSON.parse(job));
  } catch (e) {
    res.status(404).json({ error: 'Job not found' });
  }
});

async function installUtilitiesAsync(jobId: string, config: CustomUtilitiesConfig): Promise<void> {
  const statusFile = '/data/utilities/status.json';
  const jobFile = `/data/utilities/jobs/${jobId}.json`;

  // Initialize status
  await fs.writeFile(statusFile, JSON.stringify({
    status: 'installing',
    lastAttempt: new Date().toISOString(),
    items: {}
  }));

  // Install NPM packages
  for (const pkg of config.npmPackages || []) {
    const pkgSpec = `${pkg.name}@${pkg.version || 'latest'}`;
    const key = `npm:${pkg.name}`;

    try {
      await execAsync(`npm install -g ${pkgSpec}`);
      await updateItemStatus(statusFile, key, 'installed');
    } catch (err) {
      await updateItemStatus(statusFile, key, 'failed', err.message);
    }
  }

  // Install system packages
  if (config.systemPackages?.length) {
    await execAsync('apt-get update -qq');
    for (const pkg of config.systemPackages) {
      const aptPkg = pkg.aptPackage || pkg.name;
      const key = `apt:${pkg.name}`;

      try {
        await execAsync(`apt-get install -y -qq ${aptPkg}`);
        await updateItemStatus(statusFile, key, 'installed');
      } catch (err) {
        await updateItemStatus(statusFile, key, 'failed', err.message);
      }
    }
  }

  // Set environment variables
  if (config.environmentVariables && Object.keys(config.environmentVariables).length) {
    const envLines = Object.entries(config.environmentVariables)
      .map(([k, v]) => `export ${k}="${v}"`)
      .join('\n');
    await fs.appendFile('/etc/profile.d/workspace-env.sh', `\n# Custom utilities\n${envLines}\n`);
  }

  // Run setup scripts (respecting dependencies)
  const scripts = [...(config.setupScripts || [])].sort((a, b) => (a.order || 100) - (b.order || 100));
  for (const script of scripts) {
    const key = `script:${script.name}`;
    const scriptFile = `/tmp/setup-${script.name}-${jobId}.sh`;

    try {
      // Check dependencies are installed
      for (const dep of script.dependsOn || []) {
        const depStatus = finalStatus.items?.[dep];
        if (!depStatus || depStatus.status !== 'installed') {
          throw new Error(`Dependency not installed: ${dep}`);
        }
      }

      // Get script content from URL or base64
      let content: string;
      if (script.sourceUrl) {
        const res = await fetch(script.sourceUrl);
        if (!res.ok) throw new Error(`Failed to fetch script: ${res.status}`);
        content = await res.text();
      } else if (script.content) {
        content = Buffer.from(script.content, 'base64').toString('utf-8');
      } else {
        throw new Error('No content or sourceUrl provided');
      }

      await fs.writeFile(scriptFile, content, { mode: 0o755 });
      const cmd = script.runAsRoot ? `bash ${scriptFile}` : `sudo -u workspace bash ${scriptFile}`;
      await execAsync(cmd);
      await updateItemStatus(statusFile, key, 'installed');
    } catch (err) {
      await updateItemStatus(statusFile, key, 'failed', err.message);
    } finally {
      await fs.unlink(scriptFile).catch(() => {});
    }
  }

  // Finalize status
  const finalStatus = JSON.parse(await fs.readFile(statusFile, 'utf-8'));
  const failedItems = Object.values(finalStatus.items).filter((i: any) => i.status === 'failed');
  finalStatus.status = failedItems.length === 0 ? 'installed' : 'failed';
  await fs.writeFile(statusFile, JSON.stringify(finalStatus, null, 2));

  // Update job
  const job = JSON.parse(await fs.readFile(jobFile, 'utf-8'));
  job.status = finalStatus.status === 'installed' ? 'completed' : 'failed';
  job.completedAt = new Date().toISOString();
  await fs.writeFile(jobFile, JSON.stringify(job, null, 2));
}
```

### 3. Storage Layout

```
/data/
├── utilities/
│   ├── status.json          # Installation status tracking
│   ├── jobs/                 # Post-provisioning job history
│   │   └── {jobId}.json
│   └── scripts/              # Archived setup scripts
├── bin/                      # Custom binaries (added to PATH)
├── repos/                    # Repository checkouts
└── users/                    # Per-user home directories
```

### 4. CLI Integration

**New commands for `agent-relay workspace utilities`:**

```bash
# List installed utilities
agent-relay workspace utilities list --workspace <id>

# Install NPM package
agent-relay workspace utilities install npm typescript@5.0.0 --workspace <id>

# Install system package
agent-relay workspace utilities install apt jq --workspace <id>

# Set environment variable
agent-relay workspace utilities env set API_KEY=secret123 --workspace <id>

# Run setup script
agent-relay workspace utilities script run ./setup.sh --workspace <id>

# Check installation status
agent-relay workspace utilities status --workspace <id>
```

### 5. Dashboard UI

New "Utilities" tab in workspace settings:

```
┌─────────────────────────────────────────────────────────────────┐
│ Workspace Settings > Utilities                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ NPM Packages                                            [+ Add] │
│ ┌───────────────────────────────────────────────────────────┐  │
│ │ typescript@5.3.3         ✓ Installed         [Remove]     │  │
│ │ @anthropic/sdk@latest    ✓ Installed         [Remove]     │  │
│ │ prettier@3.0.0           ⏳ Installing...                  │  │
│ └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│ System Packages                                         [+ Add] │
│ ┌───────────────────────────────────────────────────────────┐  │
│ │ jq                       ✓ Installed         [Remove]     │  │
│ │ redis-tools              ✓ Installed         [Remove]     │  │
│ └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│ Environment Variables                                   [+ Add] │
│ ┌───────────────────────────────────────────────────────────┐  │
│ │ CUSTOM_FLAG = "enabled"                      [Edit] [Del] │  │
│ │ API_TIMEOUT = "30000"                        [Edit] [Del] │  │
│ └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│ Setup Scripts                                           [+ Add] │
│ ┌───────────────────────────────────────────────────────────┐  │
│ │ configure-git.sh         ✓ Ran successfully  [View] [Del] │  │
│ └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│ [Save & Install]                                                │
└─────────────────────────────────────────────────────────────────┘
```

## Security Considerations

### Input Validation

```typescript
function validateUtilitiesConfig(config: CustomUtilitiesConfig): ValidationResult {
  const errors: string[] = [];

  // NPM packages: validate package names (no shell injection)
  for (const pkg of config.npmPackages || []) {
    if (!/^(@[\w-]+\/)?[\w.-]+$/.test(pkg.name)) {
      errors.push(`Invalid NPM package name: ${pkg.name}`);
    }
    if (pkg.version && !/^[\w^~<>=.*-]+$/.test(pkg.version)) {
      errors.push(`Invalid version constraint: ${pkg.version}`);
    }
  }

  // System packages: validate against allowlist (strict, additions via support request)
  const allowedAptPackages = new Set([
    // Build tools
    'build-essential', 'git', 'make', 'cmake',
    // CLI utilities
    'curl', 'wget', 'jq', 'htop', 'tree', 'vim', 'nano', 'unzip', 'zip',
    // Database clients
    'redis-tools', 'postgresql-client', 'mysql-client',
    // Languages
    'python3', 'python3-pip', 'python3-venv', 'ruby', 'golang-go',
    // Fly.io deployment
    'wireguard-tools',
  ]);

  for (const pkg of config.systemPackages || []) {
    const aptPkg = pkg.aptPackage || pkg.name;
    if (!allowedAptPackages.has(aptPkg)) {
      errors.push(`System package not in allowlist: ${aptPkg}`);
    }
  }

  // Environment variables: no sensitive key names
  const forbiddenEnvKeys = ['PATH', 'HOME', 'USER', 'SHELL', 'LD_PRELOAD', 'LD_LIBRARY_PATH'];
  for (const key of Object.keys(config.environmentVariables || {})) {
    if (forbiddenEnvKeys.includes(key)) {
      errors.push(`Cannot override protected environment variable: ${key}`);
    }
  }

  // Setup scripts: size limit
  for (const script of config.setupScripts || []) {
    const decoded = Buffer.from(script.content, 'base64');
    if (decoded.length > 1024 * 100) { // 100KB limit
      errors.push(`Script ${script.name} exceeds 100KB limit`);
    }
  }

  return { valid: errors.length === 0, errors };
}
```

### Execution Isolation

- Setup scripts run as `workspace` user by default (not root)
- Scripts run in isolated `/tmp` directory
- Network access controlled by container policy
- Resource limits enforced via cgroups

### Rate Limiting

- Maximum 10 installation requests per hour per workspace
- Maximum 5 concurrent installation jobs per user

### Secret Storage (Environment Variables)

Environment variables marked as `isSecret: true` are stored differently:

1. **Non-secrets**: Stored directly in workspace config JSONB (visible in API responses)
2. **Secrets**: Stored in Vault, workspace config only contains reference

```typescript
// Secret storage flow
async function setEnvironmentVariable(workspaceId: string, spec: EnvironmentVariableSpec) {
  if (spec.isSecret) {
    // Store in Vault, get reference
    const vaultPath = `workspaces/${workspaceId}/env/${spec.name}`;
    await vault.write(vaultPath, { value: spec.value });

    // Store reference in config (not the actual value)
    return { name: spec.name, value: `vault:${vaultPath}`, isSecret: true };
  } else {
    // Store directly in config
    return spec;
  }
}

// At runtime, resolve vault references
async function resolveEnvironmentVariables(specs: EnvironmentVariableSpec[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const spec of specs) {
    if (spec.value.startsWith('vault:')) {
      const vaultPath = spec.value.replace('vault:', '');
      const secret = await vault.read(vaultPath);
      result[spec.name] = secret.value;
    } else {
      result[spec.name] = spec.value;
    }
  }
  return result;
}
```

**UI Behavior:**
- Secrets show `***hidden***` in dashboard
- "Reveal" button requires re-authentication
- Audit log tracks secret access

## Implementation Phases

### Phase 1: Schema & Config (No Migration)
- [ ] Add `CustomUtilitiesConfig` interface to `schema.ts`
- [ ] Add validation functions
- [ ] Unit tests for config validation

### Phase 2: Provisioning Integration
- [ ] Modify `entrypoint.sh` to handle `CUSTOM_UTILITIES` env var
- [ ] Pass utilities config during provisioning
- [ ] Status file persistence at `/data/utilities/status.json`

### Phase 3: Post-Provisioning API
- [ ] Add workspace daemon endpoints (`/api/utilities/*`)
- [ ] Add cloud API proxy endpoints (`/api/workspaces/:id/utilities`)
- [ ] Job tracking and async installation

### Phase 4: CLI & Dashboard
- [ ] `agent-relay workspace utilities` commands
- [ ] Dashboard Utilities settings tab
- [ ] Real-time installation status updates

## Testing Strategy

1. **Unit tests**: Config validation, merge functions
2. **Integration tests**: API endpoints, daemon communication
3. **E2E tests**: Full provisioning with utilities, post-provisioning install
4. **Manual verification**: Dashboard UI, CLI commands

## Decisions (Resolved)

1. **Package allowlist scope**: Start strict with common packages (build-essential, curl, wget, git, jq, htop, tree, vim, nano, redis-tools, postgresql-client, mysql-client, python3, python3-pip, ruby, golang-go).

   **Allowlist expansion process:**
   - Dashboard shows "Request Package" button for unlisted packages
   - Creates support ticket with package name, use case, and security review request
   - Approved packages added to allowlist in next release
   - High-demand packages (>5 requests) prioritized for review

2. **Script execution timeout**: 5 minutes default, configurable per-script via `timeoutMs` field in `SetupScriptSpec`.

3. **Utility templates**: Implement starter templates with one-click install:
   - **Python dev**: python3, python3-pip, virtualenv, black, mypy
   - **Node dev**: node (latest LTS), npm globals (typescript, eslint, prettier)
   - **Fly CLI**: See template below

### Fly CLI Template (Built-in)

Since `flyctl` is not available via apt, provide a pre-built template:

```json
{
  "name": "Fly CLI",
  "description": "Fly.io deployment CLI with wireguard support",
  "systemPackages": [
    { "name": "wireguard-tools" }
  ],
  "setupScripts": [{
    "name": "install-flyctl",
    "sourceUrl": "https://fly.io/install.sh",
    "runAsRoot": false,
    "order": 10
  }],
  "environmentVariables": [{
    "name": "FLY_API_TOKEN",
    "value": "",
    "isSecret": true,
    "description": "Your Fly.io API token (get from fly tokens create)"
  }]
}
```

This template:
1. Installs wireguard-tools via apt (in allowlist)
2. Runs official Fly install script from URL (no base64 needed)
3. Prompts user for API token (stored securely in Vault)

4. **Billing implications**: Deferred - not counted toward usage metrics initially.

## Reprovisioning & Recovery

When a workspace is reprovisioned (e.g., after machine failure or manual reprovisioning):

1. **Config is source of truth**: `customUtilities` in workspace config drives reinstallation
2. **Automatic reinstall**: `entrypoint.sh` reads `CUSTOM_UTILITIES` env var and reinstalls all utilities
3. **Idempotent installation**: Scripts should be written to handle re-runs gracefully
4. **Status reset**: Installation status resets to track new installation

**User expectation**: After reprovisioning, all configured utilities are automatically available without manual intervention.

## Amendments Log

### 2026-01-21: Secret Storage & Script URLs

Added based on security review:

1. **EnvironmentVariableSpec interface**: Added `isSecret` flag for Vault integration
2. **Vault storage for secrets**: Secrets stored encrypted, config only has references
3. **sourceUrl for scripts**: Alternative to base64 content, supports fetching from HTTPS URLs
4. **dependsOn for scripts**: Cross-type dependency declaration (e.g., script depends on apt package)
5. **Fly CLI template**: Pre-built template with proper install flow
6. **Allowlist expansion UI**: Self-service package request button in dashboard
7. **System package versions**: Added optional `version` field (with caveat about apt limitations)

## Next Steps

- [x] Design document created
- [x] Security review amendments (2026-01-21)
- [ ] DashboardUI review for implementation priority
- [ ] Create implementation beads/tasks if approved
- [ ] Phase 1-4 implementation

---

*Design approved by Lead on 2026-01-15*
*Amended with security improvements on 2026-01-21*
