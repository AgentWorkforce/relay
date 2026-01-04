/**
 * Cloud API Client
 *
 * Handles authenticated requests to the Agent Relay Cloud API.
 * Includes automatic session expiration detection and handling.
 */

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
}

export type SessionExpiredCallback = (error: SessionError) => void;

// Global session expiration listeners
const sessionExpiredListeners = new Set<SessionExpiredCallback>();

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
    const response = await fetch(endpoint, {
      ...options,
      credentials: 'include', // Include cookies for session
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

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
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
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

  // ===== Provider API =====

  /**
   * Get connected providers
   */
  async getProviders() {
    return cloudFetch<{ providers: Array<{
      provider: string;
      connected: boolean;
      email?: string;
      scopes?: string[];
    }> }>('/api/providers');
  },

  /**
   * Disconnect a provider
   */
  async disconnectProvider(provider: string) {
    return cloudFetch<{ success: boolean }>(`/api/providers/${encodeURIComponent(provider)}`, {
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
};
