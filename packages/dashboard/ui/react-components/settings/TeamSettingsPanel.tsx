/**
 * Team Settings Panel
 *
 * Manage workspace team members, invitations, and roles.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { cloudApi } from '../../lib/cloudApi';

export interface TeamSettingsPanelProps {
  workspaceId: string;
  currentUserId?: string;
}

interface Member {
  id: string;
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  isPending: boolean;
  user?: {
    githubUsername: string;
    email?: string;
    avatarUrl?: string;
  };
}

interface PendingInvite {
  id: string;
  workspaceId: string;
  workspaceName: string;
  role: string;
  invitedAt: string;
  invitedBy: string;
}

interface RepoCollaborator {
  id: number;
  login: string;
  avatarUrl: string;
  permission: 'admin' | 'write' | 'read' | 'none';
  repos: string[];
}

const ROLE_COLORS: Record<string, string> = {
  owner: 'bg-accent-purple/20 text-accent-purple',
  admin: 'bg-accent-cyan/20 text-accent-cyan',
  member: 'bg-success/20 text-success',
  viewer: 'bg-bg-hover text-text-muted',
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
  owner: 'Full access, can delete workspace and transfer ownership',
  admin: 'Can manage members, settings, and all workspace features',
  member: 'Can use workspace, spawn agents, and send messages',
  viewer: 'Read-only access to workspace activity',
};

export function TeamSettingsPanel({
  workspaceId,
  currentUserId,
}: TeamSettingsPanelProps) {
  const [members, setMembers] = useState<Member[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [repoCollaborators, setRepoCollaborators] = useState<RepoCollaborator[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [collaboratorsLoading, setCollaboratorsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Invite form
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteUsername, setInviteUsername] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member' | 'viewer'>('member');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Role change
  const [changingRoleFor, setChangingRoleFor] = useState<string | null>(null);

  // Load members
  useEffect(() => {
    async function loadMembers() {
      setIsLoading(true);
      setError(null);

      const [membersResult, invitesResult] = await Promise.all([
        cloudApi.getWorkspaceMembers(workspaceId),
        cloudApi.getPendingInvites(),
      ]);

      if (membersResult.success) {
        setMembers(membersResult.data.members as Member[]);
      } else {
        setError(membersResult.error);
      }

      if (invitesResult.success) {
        // Filter to invites for this workspace
        setPendingInvites(
          invitesResult.data.invites.filter((i) => i.workspaceId === workspaceId)
        );
      }

      setIsLoading(false);
    }

    loadMembers();
  }, [workspaceId]);

  // Load repo collaborators (users with GitHub access who aren't workspace members)
  useEffect(() => {
    async function loadCollaborators() {
      setCollaboratorsLoading(true);

      const result = await cloudApi.getRepoCollaborators(workspaceId);

      if (result.success) {
        setRepoCollaborators(result.data.collaborators || []);
      }

      setCollaboratorsLoading(false);
    }

    loadCollaborators();
  }, [workspaceId]);

  // Invite member
  const handleInvite = useCallback(async () => {
    if (!inviteUsername.trim()) {
      setInviteError('Please enter a GitHub username');
      return;
    }

    setInviteLoading(true);
    setInviteError(null);

    const result = await cloudApi.inviteMember(workspaceId, inviteUsername.trim(), inviteRole);

    if (result.success) {
      // Refresh members
      const membersResult = await cloudApi.getWorkspaceMembers(workspaceId);
      if (membersResult.success) {
        setMembers(membersResult.data.members as Member[]);
      }
      setInviteUsername('');
      setShowInviteForm(false);
      setSuccessMessage(`Invitation sent to ${inviteUsername}`);
      setTimeout(() => setSuccessMessage(null), 3000);
    } else {
      setInviteError(result.error);
    }

    setInviteLoading(false);
  }, [workspaceId, inviteUsername, inviteRole]);

  // Update member role
  const handleUpdateRole = useCallback(async (memberId: string, newRole: string) => {
    setChangingRoleFor(memberId);

    const result = await cloudApi.updateMemberRole(workspaceId, memberId, newRole);

    if (result.success) {
      setMembers((prev) =>
        prev.map((m) => (m.id === memberId ? { ...m, role: newRole as Member['role'] } : m))
      );
      setSuccessMessage('Role updated successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
    } else {
      setError(result.error);
    }

    setChangingRoleFor(null);
  }, [workspaceId]);

  // Remove member
  const handleRemoveMember = useCallback(async (member: Member) => {
    const confirmed = window.confirm(
      `Are you sure you want to remove ${member.user?.githubUsername || 'this member'} from the workspace?`
    );
    if (!confirmed) return;

    const result = await cloudApi.removeMember(workspaceId, member.id);

    if (result.success) {
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
      setSuccessMessage('Member removed successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
    } else {
      setError(result.error);
    }
  }, [workspaceId]);

  // Get current user's role
  const currentUserRole = members.find((m) => m.userId === currentUserId)?.role;
  const canManageMembers = currentUserRole === 'owner' || currentUserRole === 'admin';

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner />
        <span className="ml-3 text-text-muted">Loading team members...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide">
            Team Members
          </h3>
          <p className="text-xs text-text-muted mt-1">
            {members.length} member{members.length !== 1 ? 's' : ''}
          </p>
        </div>
        {canManageMembers && (
          <button
            onClick={() => setShowInviteForm(!showInviteForm)}
            className="px-3 md:px-4 py-2 bg-accent-cyan text-bg-deep rounded-lg text-xs md:text-sm font-medium hover:bg-accent-cyan/90 transition-colors flex items-center justify-center gap-2 w-full sm:w-auto"
          >
            <PlusIcon />
            Invite Member
          </button>
        )}
      </div>

      {/* Messages */}
      {error && (
        <div className="p-3 bg-error/10 border border-error/30 rounded-lg text-error text-sm">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-2 text-error/70 hover:text-error"
          >
            &times;
          </button>
        </div>
      )}

      {successMessage && (
        <div className="p-3 bg-success/10 border border-success/30 rounded-lg text-success text-sm">
          {successMessage}
        </div>
      )}

      {/* Invite Form */}
      {showInviteForm && (
        <div className="p-4 bg-bg-tertiary rounded-lg border border-border-subtle space-y-4">
          <h4 className="text-sm font-medium text-text-primary">Invite New Member</h4>

          {inviteError && (
            <div className="p-2 bg-error/10 border border-error/30 rounded text-error text-xs">
              {inviteError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-text-muted mb-1 block">GitHub Username</label>
              <input
                type="text"
                value={inviteUsername}
                onChange={(e) => setInviteUsername(e.target.value)}
                placeholder="username"
                className="w-full px-3 py-2 bg-bg-card border border-border-subtle rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-cyan"
              />
            </div>
            <div>
              <label className="text-xs text-text-muted mb-1 block">Role</label>
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}
                className="w-full px-3 py-2 bg-bg-card border border-border-subtle rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent-cyan"
              >
                <option value="admin">Admin</option>
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
              </select>
            </div>
          </div>

          <p className="text-xs text-text-muted">
            {ROLE_DESCRIPTIONS[inviteRole]}
          </p>

          <div className="flex flex-col sm:flex-row gap-2">
            <button
              onClick={handleInvite}
              disabled={inviteLoading || !inviteUsername.trim()}
              className="px-4 py-2 bg-accent-cyan text-bg-deep rounded-lg text-sm font-medium hover:bg-accent-cyan/90 disabled:opacity-50 transition-colors"
            >
              {inviteLoading ? 'Sending...' : 'Send Invitation'}
            </button>
            <button
              onClick={() => {
                setShowInviteForm(false);
                setInviteUsername('');
                setInviteError(null);
              }}
              className="px-4 py-2 bg-bg-hover text-text-secondary rounded-lg text-sm font-medium hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Members List */}
      <div className="space-y-2">
        {members.map((member) => (
          <div
            key={member.id}
            className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 md:p-4 bg-bg-tertiary rounded-lg"
          >
            <div className="flex items-center gap-3">
              {member.user?.avatarUrl ? (
                <img
                  src={member.user.avatarUrl}
                  alt={member.user.githubUsername}
                  className="w-9 h-9 md:w-10 md:h-10 rounded-full"
                />
              ) : (
                <div className="w-9 h-9 md:w-10 md:h-10 rounded-full bg-accent-cyan/20 flex items-center justify-center text-accent-cyan font-bold text-xs md:text-sm">
                  {member.user?.githubUsername?.[0]?.toUpperCase() || '?'}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-text-primary truncate">
                    {member.user?.githubUsername || 'Unknown User'}
                  </p>
                  {member.isPending && (
                    <span className="text-[10px] px-2 py-0.5 bg-amber-400/20 text-amber-400 rounded-full">
                      Pending
                    </span>
                  )}
                  {member.userId === currentUserId && (
                    <span className="text-xs text-text-muted">(you)</span>
                  )}
                </div>
                {member.user?.email && (
                  <p className="text-xs text-text-muted truncate">{member.user.email}</p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 sm:gap-3 ml-12 sm:ml-0">
              {canManageMembers && member.role !== 'owner' && member.userId !== currentUserId ? (
                <select
                  value={member.role}
                  onChange={(e) => handleUpdateRole(member.id, e.target.value)}
                  disabled={changingRoleFor === member.id}
                  className={`px-2 md:px-3 py-1 md:py-1.5 rounded-full text-[10px] md:text-xs font-medium border-none cursor-pointer ${ROLE_COLORS[member.role]} focus:outline-none`}
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                </select>
              ) : (
                <span className={`px-2 md:px-3 py-1 md:py-1.5 rounded-full text-[10px] md:text-xs font-medium ${ROLE_COLORS[member.role]}`}>
                  {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
                </span>
              )}

              {canManageMembers && member.role !== 'owner' && member.userId !== currentUserId && (
                <button
                  onClick={() => handleRemoveMember(member)}
                  className="p-1.5 text-text-muted hover:text-error rounded transition-colors"
                  title="Remove member"
                >
                  <TrashIcon />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Repo Collaborators (Grandfathered Access via GitHub) */}
      {(repoCollaborators.length > 0 || collaboratorsLoading) && (
        <div className="mt-8">
          <div className="flex items-center gap-2 mb-4">
            <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide">
              Repo Collaborators
            </h3>
            <span className="px-2 py-0.5 bg-accent-purple/10 text-accent-purple text-[10px] rounded-full">
              GitHub Access
            </span>
          </div>
          <p className="text-xs text-text-muted mb-4">
            These users have access via GitHub repo permissions. They can access this workspace without an explicit invite.
          </p>
          {collaboratorsLoading ? (
            <div className="flex items-center gap-2 py-4">
              <LoadingSpinner />
              <span className="text-sm text-text-muted">Loading collaborators...</span>
            </div>
          ) : (
            <div className="space-y-2">
              {repoCollaborators.map((collab) => (
                <div
                  key={collab.id}
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 md:p-4 bg-bg-tertiary rounded-lg border border-accent-purple/20"
                >
                  <div className="flex items-center gap-3">
                    {collab.avatarUrl ? (
                      <img
                        src={collab.avatarUrl}
                        alt={collab.login}
                        className="w-9 h-9 md:w-10 md:h-10 rounded-full"
                      />
                    ) : (
                      <div className="w-9 h-9 md:w-10 md:h-10 rounded-full bg-accent-purple/20 flex items-center justify-center text-accent-purple font-bold text-xs md:text-sm">
                        {collab.login[0]?.toUpperCase() || '?'}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-text-primary truncate">
                          {collab.login}
                        </p>
                        <span className="text-[10px] px-2 py-0.5 bg-accent-purple/10 text-accent-purple rounded-full">
                          via GitHub
                        </span>
                      </div>
                      <p className="text-xs text-text-muted truncate">
                        {collab.repos.length === 1
                          ? `Access via ${collab.repos[0]}`
                          : `Access via ${collab.repos.length} repos`}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 sm:gap-3 ml-12 sm:ml-0">
                    <span className={`px-2 md:px-3 py-1 md:py-1.5 rounded-full text-[10px] md:text-xs font-medium ${
                      collab.permission === 'admin'
                        ? 'bg-accent-cyan/20 text-accent-cyan'
                        : collab.permission === 'write'
                          ? 'bg-success/20 text-success'
                          : 'bg-bg-hover text-text-muted'
                    }`}>
                      {collab.permission === 'admin' ? 'Admin' : collab.permission === 'write' ? 'Write' : 'Read'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Pending Invites for Current User */}
      {pendingInvites.length > 0 && (
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-4">
            Your Pending Invitations
          </h3>
          <div className="space-y-2">
            {pendingInvites.map((invite) => (
              <div
                key={invite.id}
                className="flex items-center justify-between p-4 bg-bg-tertiary rounded-lg border border-accent-cyan/30"
              >
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {invite.workspaceName}
                  </p>
                  <p className="text-xs text-text-muted">
                    Invited by {invite.invitedBy} as {invite.role}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      const result = await cloudApi.acceptInvite(invite.id);
                      if (result.success) {
                        setPendingInvites((prev) => prev.filter((i) => i.id !== invite.id));
                        setSuccessMessage('Invitation accepted!');
                        setTimeout(() => setSuccessMessage(null), 3000);
                      }
                    }}
                    className="px-3 py-1.5 bg-success/20 text-success rounded text-xs font-medium hover:bg-success/30 transition-colors"
                  >
                    Accept
                  </button>
                  <button
                    onClick={async () => {
                      const result = await cloudApi.declineInvite(invite.id);
                      if (result.success) {
                        setPendingInvites((prev) => prev.filter((i) => i.id !== invite.id));
                      }
                    }}
                    className="px-3 py-1.5 bg-bg-hover text-text-muted rounded text-xs font-medium hover:text-text-primary transition-colors"
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Role Permissions Info */}
      <div className="mt-8 p-4 bg-bg-tertiary/50 rounded-lg">
        <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
          Role Permissions
        </h4>
        <div className="space-y-2">
          {Object.entries(ROLE_DESCRIPTIONS).map(([role, description]) => (
            <div key={role} className="flex items-start gap-2">
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${ROLE_COLORS[role]} shrink-0`}>
                {role.charAt(0).toUpperCase() + role.slice(1)}
              </span>
              <p className="text-xs text-text-muted">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Icons
function LoadingSpinner() {
  return (
    <svg className="animate-spin h-5 w-5 text-accent-cyan" viewBox="0 0 24 24">
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeDasharray="32"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
