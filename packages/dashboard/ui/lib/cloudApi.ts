/**
 * Cloud API Client
 *
 * Handles authenticated requests to the Agent Relay Cloud API.
 * Includes automatic session expiration detection and handling.
 */

import { setCsrfToken as setApiCsrfToken } from './api';

// Session error codes from the backend
export type SessionErrorCode = 'SESSION_EXPIRED' | 'USER_NOT_FOUND' | 'SESSION_ERROR';

export interface SessionError {
  error: string;
  code: SessionErrorCode;
  message: string;
}

export interface SessionStatus {
  authenticated: boolean;
  code?: SessionErrorCode;
  message?: string;
  user?: {
    id: string;
    githubUsername: string;
    email?: string;
    avatarUrl?: string;
    plan: string;
  };
}

export interface CloudUser {
  id: string;
  githubUsername: string;
  email?: string;
  avatarUrl?: string;
  plan: string;
  connectedProviders: Array<{
    provider: string;
    email?: string;
    connectedAt: string;
  }>;
  pendingInvites: number;
  onboardingCompleted: boolean;
  displayName?: string;
}

export type SessionExpiredCallback = (error: SessionError) => void;

// Global session expiration listeners
const sessionExpiredListeners = new Set<SessionExpiredCallback>();

// Global CSRF token storage
let csrfToken: string | null = null;

/**
 * Get the current CSRF token
 */
export function getCsrfToken(): string | null {
  return csrfToken;
}

/**
 * Capture CSRF token from response headers
 * Also syncs with the api.ts library for dashboard requests
 */
function captureCsrfToken(response: Response): void {
  const token = response.headers.get('X-CSRF-Token');
  if (token) {
    csrfToken = token;
    // Sync with api.ts for dashboard-to-workspace requests
    setApiCsrfToken(token);
  }
}

/**
 * Register a callback for when session expires
 */
export function onSessionExpired(callback: SessionExpiredCallback): () => void {
  sessionExpiredListeners.add(callback);
  return () => sessionExpiredListeners.delete(callback);
}

/**
 * Notify all listeners that session has expired
 */
function notifySessionExpired(error: SessionError): void {
  for (const listener of sessionExpiredListeners) {
    try {
      listener(error);
    } catch (e) {
      console.error('[cloudApi] Session expired listener error:', e);
    }
  }
}

/**
 * Check if response indicates session expiration
 */
function isSessionError(response: Response, data: unknown): data is SessionError {
  if (response.status === 401) {
    return true;
  }
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    return obj.code === 'SESSION_EXPIRED' || obj.code === 'USER_NOT_FOUND';
  }
  return false;
}

/**
 * Make an authenticated request to the cloud API
 */
async function cloudFetch<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ success: true; data: T } | { success: false; error: string; sessionExpired?: boolean }> {
  try {
    // Build headers, including CSRF token for non-GET requests
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    // Include CSRF token for state-changing requests
    if (options.method && options.method !== 'GET' && csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }

    const response = await fetch(endpoint, {
      ...options,
      credentials: 'include', // Include cookies for session
      headers,
    });

    // Capture CSRF token from response
    captureCsrfToken(response);

    const data = await response.json();

    if (isSessionError(response, data)) {
      const error: SessionError = {
        error: (data as SessionError).error || 'Session expired',
        code: (data as SessionError).code || 'SESSION_EXPIRED',
        message: (data as SessionError).message || 'Your session has expired. Please log in again.',
      };
      notifySessionExpired(error);
      return { success: false, error: error.message, sessionExpired: true };
    }

    if (!response.ok) {
      return {
        success: false,
        error: (data as { error?: string }).error || `Request failed with status ${response.status}`
      };
    }

    return { success: true, data: data as T };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Network error'
    };
  }
}

/**
 * Cloud API methods
 */
// ===== Nango Auth Types =====

export interface NangoLoginSession {
  sessionToken: string;
  tempUserId: string;
}

export interface NangoLoginStatus {
  ready: boolean;
  user?: {
    id: string;
    githubUsername: string;
    email?: string;
    avatarUrl?: string;
    plan: string;
  };
}

export interface NangoRepoSession {
  sessionToken: string;
}

export interface NangoRepoStatus {
  ready: boolean;
  pendingApproval?: boolean;
  message?: string;
  repos?: Array<{
    id: string;
    fullName: string;
    isPrivate: boolean;
    defaultBranch: string;
  }>;
}

export const cloudApi = {
  // ===== Nango Auth =====

  /**
   * Get a Nango connect session for GitHub login
   */
  async getNangoLoginSession(): Promise<{ success: true; data: NangoLoginSession } | { success: false; error: string }> {
    try {
      const response = await fetch('/api/auth/nango/login-session', {
        credentials: 'include',
      });
      // Capture CSRF token from response
      captureCsrfToken(response);
      const data = await response.json();
      if (!response.ok) {
        return { success: false, error: data.error || 'Failed to create login session' };
      }
      return { success: true, data: data as NangoLoginSession };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  },

  /**
   * Poll for login completion after Nango connect UI
   */
  async checkNangoLoginStatus(connectionId: string): Promise<{ success: true; data: NangoLoginStatus } | { success: false; error: string }> {
    try {
      const response = await fetch(`/api/auth/nango/login-status/${encodeURIComponent(connectionId)}`, {
        credentials: 'include',
      });
      // Capture CSRF token from response
      captureCsrfToken(response);
      const data = await response.json();
      if (!response.ok) {
        return { success: false, error: data.error || 'Failed to check login status' };
      }
      return { success: true, data: data as NangoLoginStatus };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  },

  /**
   * Get a Nango connect session for GitHub App OAuth (repo access)
   */
  async getNangoRepoSession(): Promise<{ success: true; data: NangoRepoSession } | { success: false; error: string; sessionExpired?: boolean }> {
    return cloudFetch<NangoRepoSession>('/api/auth/nango/repo-session');
  },

  /**
   * Poll for repo sync completion after GitHub App OAuth
   */
  async checkNangoRepoStatus(connectionId: string): Promise<{ success: true; data: NangoRepoStatus } | { success: false; error: string; sessionExpired?: boolean }> {
    return cloudFetch<NangoRepoStatus>(`/api/auth/nango/repo-status/${encodeURIComponent(connectionId)}`);
  },

  /**
   * Check current session status
   */
  async checkSession(): Promise<SessionStatus> {
    try {
      const response = await fetch('/api/auth/session', {
        credentials: 'include',
      });
      // Capture CSRF token from response
      captureCsrfToken(response);
      const data = await response.json();
      return data as SessionStatus;
    } catch {
      return {
        authenticated: false,
        code: 'SESSION_ERROR',
        message: 'Failed to check session status',
      };
    }
  },

  /**
   * Get current user profile
   */
  async getMe() {
    return cloudFetch<CloudUser>('/api/auth/me');
  },

  /**
   * Logout current user
   */
  async logout(): Promise<{ success: boolean; error?: string }> {
    try {
      const headers: Record<string, string> = {};
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers,
      });
      const data = await response.json();
      return data as { success: boolean; error?: string };
    } catch {
      return { success: false, error: 'Network error' };
    }
  },

  // ===== Workspace API =====

  /**
   * Get user's workspaces
   */
  async getWorkspaces() {
    return cloudFetch<{ workspaces: Array<{
      id: string;
      name: string;
      slug: string;
      repositories: number;
      members: number;
      plan: string;
    }> }>('/api/workspaces');
  },

  /**
   * Get workspace by ID
   */
  async getWorkspace(id: string) {
    return cloudFetch<{
      id: string;
      name: string;
      slug: string;
      config: Record<string, unknown>;
      createdAt: string;
    }>(`/api/workspaces/${encodeURIComponent(id)}`);
  },

  /**
   * Create workspace
   */
  async createWorkspace(data: { name: string; slug?: string }) {
    return cloudFetch<{ id: string; name: string; slug: string }>('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  /**
   * Get primary workspace with live status
   */
  async getPrimaryWorkspace() {
    return cloudFetch<{
      exists: boolean;
      message?: string;
      workspace?: {
        id: string;
        name: string;
        status: string;
        publicUrl?: string;
        isStopped: boolean;
        isRunning: boolean;
        isProvisioning: boolean;
        hasError: boolean;
        config: {
          providers: string[];
          repositories: string[];
        };
      };
      statusMessage: string;
      actionNeeded?: 'wakeup' | 'check_error' | null;
    }>('/api/workspaces/primary');
  },

  /**
   * Get workspace summary (all workspaces with status)
   */
  async getWorkspaceSummary() {
    return cloudFetch<{
      workspaces: Array<{
        id: string;
        name: string;
        status: string;
        publicUrl?: string;
        isStopped: boolean;
        isRunning: boolean;
        isProvisioning: boolean;
        hasError: boolean;
      }>;
      summary: {
        total: number;
        running: number;
        stopped: number;
        provisioning: number;
        error: number;
      };
      overallStatus: 'ready' | 'provisioning' | 'stopped' | 'none' | 'error';
    }>('/api/workspaces/summary');
  },

  /**
   * Get all accessible workspaces (owned + member + contributor via GitHub repos)
   * This is the preferred method for the workspace selector dropdown
   */
  async getAccessibleWorkspaces() {
    return cloudFetch<{
      workspaces: Array<{
        id: string;
        name: string;
        status: string;
        publicUrl?: string;
        providers?: string[];
        repositories?: string[];
        accessType: 'owner' | 'member' | 'contributor';
        permission: 'admin' | 'write' | 'read';
        createdAt: string;
      }>;
      summary: {
        owned: number;
        member: number;
        contributor: number;
        total: number;
      };
    }>('/api/workspaces/accessible');
  },

  /**
   * Get workspace status (live polling from compute provider)
   */
  async getWorkspaceStatus(id: string) {
    return cloudFetch<{ status: string }>(`/api/workspaces/${encodeURIComponent(id)}/status`);
  },

  /**
   * Wake up a stopped workspace
   */
  async wakeupWorkspace(id: string) {
    return cloudFetch<{
      status: string;
      wasRestarted: boolean;
      message: string;
      estimatedStartTime?: number;
      publicUrl?: string;
    }>(`/api/workspaces/${encodeURIComponent(id)}/wakeup`, {
      method: 'POST',
    });
  },

  /**
   * Restart a workspace
   */
  async restartWorkspace(id: string) {
    return cloudFetch<{ success: boolean; message: string }>(
      `/api/workspaces/${encodeURIComponent(id)}/restart`,
      { method: 'POST' }
    );
  },

  // ===== Provider API =====

  /**
   * Get connected providers for a workspace
   * @param workspaceId - Workspace to get providers for
   */
  async getProviders(workspaceId: string) {
    return cloudFetch<{ providers: Array<{
      id: string;
      name: string;
      displayName: string;
      description: string;
      color: string;
      authStrategy: string;
      cliCommand?: string;
      isConnected: boolean;
      connectedAs?: string;
      connectedAt?: string;
    }> }>(`/api/providers?workspaceId=${encodeURIComponent(workspaceId)}`);
  },

  /**
   * Disconnect a provider from a workspace
   * @param provider - Provider ID to disconnect
   * @param workspaceId - Workspace to disconnect from
   */
  async disconnectProvider(provider: string, workspaceId: string) {
    return cloudFetch<{ success: boolean }>(`/api/providers/${encodeURIComponent(provider)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
    });
  },

  // ===== Team API =====

  /**
   * Get workspace members
   */
  async getWorkspaceMembers(workspaceId: string) {
    return cloudFetch<{ members: Array<{
      id: string;
      userId: string;
      role: string;
      isPending: boolean;
      user?: {
        githubUsername: string;
        email?: string;
        avatarUrl?: string;
      };
    }> }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`);
  },

  /**
   * Get repo collaborators (users with GitHub access who aren't workspace members)
   */
  async getRepoCollaborators(workspaceId: string) {
    return cloudFetch<{
      collaborators: Array<{
        id: number;
        login: string;
        avatarUrl: string;
        permission: 'admin' | 'write' | 'read' | 'none';
        repos: string[];
      }>;
      totalRepos: number;
      message?: string;
    }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/repo-collaborators`);
  },

  /**
   * Invite user to workspace
   */
  async inviteMember(workspaceId: string, githubUsername: string, role = 'member') {
    return cloudFetch<{ success: boolean; member: unknown }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/members`,
      {
        method: 'POST',
        body: JSON.stringify({ githubUsername, role }),
      }
    );
  },

  /**
   * Get pending invites for current user
   */
  async getPendingInvites() {
    return cloudFetch<{ invites: Array<{
      id: string;
      workspaceId: string;
      workspaceName: string;
      role: string;
      invitedAt: string;
      invitedBy: string;
    }> }>('/api/invites');
  },

  /**
   * Accept workspace invite
   */
  async acceptInvite(inviteId: string) {
    return cloudFetch<{ success: boolean; workspaceId: string }>(
      `/api/invites/${encodeURIComponent(inviteId)}/accept`,
      { method: 'POST' }
    );
  },

  /**
   * Decline workspace invite
   */
  async declineInvite(inviteId: string) {
    return cloudFetch<{ success: boolean }>(
      `/api/invites/${encodeURIComponent(inviteId)}/decline`,
      { method: 'POST' }
    );
  },

  /**
   * Update member role
   */
  async updateMemberRole(workspaceId: string, memberId: string, role: string) {
    return cloudFetch<{ success: boolean; role: string }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }
    );
  },

  /**
   * Remove member from workspace
   */
  async removeMember(workspaceId: string, memberId: string) {
    return cloudFetch<{ success: boolean }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}`,
      { method: 'DELETE' }
    );
  },

  // ===== Billing API =====

  /**
   * Get all billing plans
   */
  async getBillingPlans() {
    return cloudFetch<{
      plans: Array<{
        tier: string;
        name: string;
        description: string;
        price: { monthly: number; yearly: number };
        features: string[];
        limits: Record<string, number>;
        recommended?: boolean;
      }>;
      publishableKey: string;
    }>('/api/billing/plans');
  },

  /**
   * Get current subscription status
   */
  async getSubscription() {
    return cloudFetch<{
      tier: string;
      subscription: {
        id: string;
        tier: string;
        status: string;
        currentPeriodStart: string;
        currentPeriodEnd: string;
        cancelAtPeriodEnd: boolean;
        interval: 'month' | 'year';
      } | null;
      customer: {
        id: string;
        email: string;
        name?: string;
        paymentMethods: Array<{
          id: string;
          type: string;
          last4?: string;
          brand?: string;
          isDefault: boolean;
        }>;
        invoices: Array<{
          id: string;
          number: string;
          amount: number;
          status: string;
          date: string;
          pdfUrl?: string;
        }>;
      } | null;
    }>('/api/billing/subscription');
  },

  /**
   * Create checkout session for new subscription
   */
  async createCheckoutSession(tier: string, interval: 'month' | 'year' = 'month') {
    return cloudFetch<{
      sessionId: string;
      checkoutUrl: string;
    }>('/api/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ tier, interval }),
    });
  },

  /**
   * Create billing portal session
   */
  async createBillingPortal() {
    return cloudFetch<{
      sessionId: string;
      portalUrl: string;
    }>('/api/billing/portal', {
      method: 'POST',
    });
  },

  /**
   * Change subscription tier
   */
  async changeSubscription(tier: string, interval: 'month' | 'year' = 'month') {
    return cloudFetch<{
      subscription: {
        tier: string;
        status: string;
      };
    }>('/api/billing/change', {
      method: 'POST',
      body: JSON.stringify({ tier, interval }),
    });
  },

  /**
   * Cancel subscription at period end
   */
  async cancelSubscription() {
    return cloudFetch<{
      subscription: { cancelAtPeriodEnd: boolean; currentPeriodEnd: string };
      message: string;
    }>('/api/billing/cancel', {
      method: 'POST',
    });
  },

  /**
   * Resume cancelled subscription
   */
  async resumeSubscription() {
    return cloudFetch<{
      subscription: { cancelAtPeriodEnd: boolean };
      message: string;
    }>('/api/billing/resume', {
      method: 'POST',
    });
  },

  /**
   * Get invoices
   */
  async getInvoices() {
    return cloudFetch<{
      invoices: Array<{
        id: string;
        number: string;
        amount: number;
        status: string;
        date: string;
        pdfUrl?: string;
      }>;
    }>('/api/billing/invoices');
  },

  // ===== Workspace Management API =====

  /**
   * Stop workspace
   */
  async stopWorkspace(id: string) {
    return cloudFetch<{ success: boolean; message: string }>(
      `/api/workspaces/${encodeURIComponent(id)}/stop`,
      { method: 'POST' }
    );
  },

  /**
   * Delete workspace
   */
  async deleteWorkspace(id: string) {
    return cloudFetch<{ success: boolean; message: string }>(
      `/api/workspaces/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    );
  },

  /**
   * Add repositories to workspace
   */
  async addReposToWorkspace(workspaceId: string, repositoryIds: string[]) {
    return cloudFetch<{ success: boolean; message: string }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repos`,
      {
        method: 'POST',
        body: JSON.stringify({ repositoryIds }),
      }
    );
  },

  /**
   * Set custom domain for workspace
   */
  async setCustomDomain(workspaceId: string, domain: string) {
    return cloudFetch<{
      success: boolean;
      domain: string;
      status: string;
      instructions: {
        type: string;
        name: string;
        value: string;
        ttl: number;
      };
      verifyEndpoint: string;
      message: string;
    }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/domain`, {
      method: 'POST',
      body: JSON.stringify({ domain }),
    });
  },

  /**
   * Verify custom domain
   */
  async verifyCustomDomain(workspaceId: string) {
    return cloudFetch<{
      success: boolean;
      status: string;
      domain?: string;
      message?: string;
      error?: string;
    }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/domain/verify`, {
      method: 'POST',
    });
  },

  /**
   * Remove custom domain
   */
  async removeCustomDomain(workspaceId: string) {
    return cloudFetch<{ success: boolean; message: string }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/domain`,
      { method: 'DELETE' }
    );
  },

  /**
   * Get detailed workspace info
   */
  async getWorkspaceDetails(id: string) {
    return cloudFetch<{
      id: string;
      name: string;
      status: string;
      publicUrl?: string;
      computeProvider: string;
      config: {
        providers: string[];
        repositories: string[];
        supervisorEnabled?: boolean;
        maxAgents?: number;
      };
      customDomain?: string;
      customDomainStatus?: string;
      errorMessage?: string;
      repositories: Array<{
        id: string;
        fullName: string;
        syncStatus: string;
        lastSyncedAt?: string;
      }>;
      createdAt: string;
      updatedAt: string;
    }>(`/api/workspaces/${encodeURIComponent(id)}`);
  },

  // ===== GitHub App API =====

  /**
   * Get user's connected repositories
   */
  async getRepos() {
    return cloudFetch<{ repositories: Array<{
      id: string;
      fullName: string;
      isPrivate: boolean;
      defaultBranch: string;
      syncStatus: string;
      hasNangoConnection: boolean;
      lastSyncedAt?: string;
    }> }>('/api/github-app/repos');
  },

  /**
   * Sync a repository to its workspace
   * Triggers clone/pull on the workspace container
   */
  async syncRepo(repoId: string) {
    return cloudFetch<{
      message: string;
      syncStatus: string;
      result?: unknown;
    }>(`/api/repos/${encodeURIComponent(repoId)}/sync`, {
      method: 'POST',
    });
  },
};
