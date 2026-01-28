/**
 * ChannelAdminPanel Component
 *
 * Admin panel for managing channel settings, members, and agent assignments.
 * Slide-over panel with tabs for Settings and Members.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useChannelAdmin, type ChannelMemberInfo } from './hooks/useChannelAdmin';
import { Pagination } from './Pagination';
import { ConfirmationDialog } from './ConfirmationDialog';

export interface ChannelAdminPanelProps {
  channelId: string;
  channelName: string;
  isOpen: boolean;
  onClose: () => void;
  currentUserId?: string;
  /** List of available agents for assignment */
  availableAgents?: Array<{ name: string; status: string }>;
}

type TabId = 'settings' | 'members';

export function ChannelAdminPanel({
  channelId,
  channelName,
  isOpen,
  onClose,
  currentUserId,
  availableAgents = [],
}: ChannelAdminPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>('settings');
  const [editDescription, setEditDescription] = useState('');
  const [editTopic, setEditTopic] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Confirmation dialog state
  const [removeMemberId, setRemoveMemberId] = useState<string | null>(null);
  const [removeMemberName, setRemoveMemberName] = useState<string>('');
  const [isRemoving, setIsRemoving] = useState(false);

  // Agent assignment state
  const [showAgentSelector, setShowAgentSelector] = useState(false);
  const [assigningAgent, setAssigningAgent] = useState<string | null>(null);

  const {
    settings,
    members,
    isLoadingSettings,
    isLoadingMembers,
    settingsError,
    membersError,
    isAdmin,
    memberPage,
    memberTotalPages,
    memberTotalCount,
    goToMemberPage,
    memberSearchQuery,
    setMemberSearchQuery,
    updateSettings,
    removeMember,
    assignAgent,
    setMemberRole,
    refreshSettings,
    refreshMembers,
  } = useChannelAdmin({
    channelId,
    currentUserId,
    autoFetch: isOpen,
  });

  // Initialize edit fields when settings load
  React.useEffect(() => {
    if (settings) {
      setEditDescription(settings.description || '');
      setEditTopic(settings.topic || '');
    }
  }, [settings]);

  // Handle save settings
  const handleSaveSettings = useCallback(async () => {
    if (!isAdmin) return;

    setIsSaving(true);
    setSaveError(null);

    try {
      const updates: { description?: string; topic?: string } = {};

      if (editDescription !== (settings?.description || '')) {
        updates.description = editDescription.trim() || undefined;
      }
      if (editTopic !== (settings?.topic || '')) {
        updates.topic = editTopic.trim() || undefined;
      }

      if (Object.keys(updates).length > 0) {
        await updateSettings(updates);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  }, [isAdmin, editDescription, editTopic, settings, updateSettings]);

  // Handle remove member confirmation
  const handleRemoveMember = useCallback((member: ChannelMemberInfo) => {
    setRemoveMemberId(member.id);
    setRemoveMemberName(member.displayName || member.name);
  }, []);

  // Confirm remove member
  const confirmRemoveMember = useCallback(async () => {
    if (!removeMemberId) return;

    setIsRemoving(true);
    try {
      await removeMember(removeMemberId);
      setRemoveMemberId(null);
      setRemoveMemberName('');
    } catch (err) {
      console.error('Failed to remove member:', err);
    } finally {
      setIsRemoving(false);
    }
  }, [removeMemberId, removeMember]);

  // Handle agent assignment
  const handleAssignAgent = useCallback(async (agentName: string) => {
    setAssigningAgent(agentName);
    try {
      await assignAgent(agentName);
      setShowAgentSelector(false);
    } catch (err) {
      console.error('Failed to assign agent:', err);
    } finally {
      setAssigningAgent(null);
    }
  }, [assignAgent]);

  // Filter available agents (not already members)
  const unassignedAgents = useMemo(() => {
    const memberNames = new Set(members.filter((m) => m.isAgent).map((m) => m.name.toLowerCase()));
    return availableAgents.filter((a) => !memberNames.has(a.name.toLowerCase()));
  }, [availableAgents, members]);

  // Has unsaved changes
  const hasChanges = useMemo(() => {
    if (!settings) return false;
    return (
      editDescription !== (settings.description || '') ||
      editTopic !== (settings.topic || '')
    );
  }, [settings, editDescription, editTopic]);

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50"
        onClick={onClose}
      />
      <div
        className="fixed right-0 top-0 bottom-0 w-full max-w-lg bg-bg-primary border-l border-border-subtle shadow-2xl z-50 flex flex-col animate-in slide-in-from-right duration-300"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle bg-bg-secondary">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-cyan/20 to-blue-500/20 flex items-center justify-center border border-accent-cyan/30">
              <SettingsIcon />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text-primary m-0">
                #{channelName}
              </h2>
              <p className="text-xs text-text-muted m-0">
                {isAdmin ? 'Channel Settings' : 'Channel Info'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-lg bg-bg-tertiary border border-border-subtle flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-hover transition-all"
            title="Close"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border-subtle">
          <TabButton
            label="Settings"
            isActive={activeTab === 'settings'}
            onClick={() => setActiveTab('settings')}
          />
          <TabButton
            label={`Members (${memberTotalCount})`}
            isActive={activeTab === 'members'}
            onClick={() => setActiveTab('members')}
          />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'settings' ? (
            <SettingsTab
              settings={settings}
              isLoading={isLoadingSettings}
              error={settingsError}
              isAdmin={isAdmin}
              editDescription={editDescription}
              setEditDescription={setEditDescription}
              editTopic={editTopic}
              setEditTopic={setEditTopic}
              hasChanges={hasChanges}
              isSaving={isSaving}
              saveError={saveError}
              onSave={handleSaveSettings}
              onRefresh={refreshSettings}
            />
          ) : (
            <MembersTab
              members={members}
              isLoading={isLoadingMembers}
              error={membersError}
              isAdmin={isAdmin}
              currentUserId={currentUserId}
              searchQuery={memberSearchQuery}
              setSearchQuery={setMemberSearchQuery}
              currentPage={memberPage}
              totalPages={memberTotalPages}
              onPageChange={goToMemberPage}
              onRemoveMember={handleRemoveMember}
              onToggleRole={setMemberRole}
              showAgentSelector={showAgentSelector}
              setShowAgentSelector={setShowAgentSelector}
              unassignedAgents={unassignedAgents}
              assigningAgent={assigningAgent}
              onAssignAgent={handleAssignAgent}
              onRefresh={refreshMembers}
            />
          )}
        </div>
      </div>

      {/* Remove Member Confirmation */}
      <ConfirmationDialog
        isOpen={removeMemberId !== null}
        title="Remove Member"
        message={`Are you sure you want to remove "${removeMemberName}" from #${channelName}? They will need to rejoin to access this channel.`}
        confirmLabel="Remove"
        confirmVariant="danger"
        onConfirm={confirmRemoveMember}
        onCancel={() => {
          setRemoveMemberId(null);
          setRemoveMemberName('');
        }}
        isProcessing={isRemoving}
      />
    </>
  );
}

// Tab Button
interface TabButtonProps {
  label: string;
  isActive: boolean;
  onClick: () => void;
}

function TabButton({ label, isActive, onClick }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`
        flex-1 px-4 py-3 text-sm font-medium transition-colors relative
        ${isActive
          ? 'text-accent-cyan'
          : 'text-text-muted hover:text-text-primary'
        }
      `}
    >
      {label}
      {isActive && (
        <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-cyan" />
      )}
    </button>
  );
}

// Settings Tab
interface SettingsTabProps {
  settings: ReturnType<typeof useChannelAdmin>['settings'];
  isLoading: boolean;
  error: string | null;
  isAdmin: boolean;
  editDescription: string;
  setEditDescription: (value: string) => void;
  editTopic: string;
  setEditTopic: (value: string) => void;
  hasChanges: boolean;
  isSaving: boolean;
  saveError: string | null;
  onSave: () => void;
  onRefresh: () => void;
}

function SettingsTab({
  settings,
  isLoading,
  error,
  isAdmin,
  editDescription,
  setEditDescription,
  editTopic,
  setEditTopic,
  hasChanges,
  isSaving,
  saveError,
  onSave,
  onRefresh,
}: SettingsTabProps) {
  if (isLoading) {
    return (
      <div className="py-12 text-center">
        <LoadingSpinner />
        <p className="text-sm text-text-muted mt-2">Loading settings...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-12 text-center">
        <ErrorIcon />
        <p className="text-sm text-error mt-2">{error}</p>
        <button onClick={onRefresh} className="mt-3 text-sm text-accent-cyan hover:underline">
          Try again
        </button>
      </div>
    );
  }

  if (!settings) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/* Description */}
      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1.5">
          Description
        </label>
        <textarea
          value={editDescription}
          onChange={(e) => setEditDescription(e.target.value)}
          placeholder="What's this channel about?"
          rows={3}
          disabled={!isAdmin}
          className="w-full px-4 py-2.5 bg-bg-tertiary border border-sidebar-border rounded-lg text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-accent-cyan/50 transition-colors resize-none disabled:opacity-60 disabled:cursor-not-allowed"
          maxLength={200}
        />
      </div>

      {/* Topic */}
      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1.5">
          Topic
        </label>
        <input
          type="text"
          value={editTopic}
          onChange={(e) => setEditTopic(e.target.value)}
          placeholder="Current topic of discussion"
          disabled={!isAdmin}
          className="w-full px-4 py-2.5 bg-bg-tertiary border border-sidebar-border rounded-lg text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-accent-cyan/50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          maxLength={100}
        />
      </div>

      {/* Channel Info */}
      <div className="pt-4 border-t border-border-subtle">
        <h4 className="text-sm font-medium text-text-secondary mb-3">Channel Info</h4>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-text-muted">Created</span>
            <span className="text-text-primary">
              {new Date(settings.createdAt).toLocaleDateString()}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-muted">Visibility</span>
            <span className={`${settings.isPrivate ? 'text-warning' : 'text-accent-cyan'}`}>
              {settings.isPrivate ? 'Private' : 'Public'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-muted">Admins</span>
            <span className="text-text-primary">
              {settings.admins.length}
            </span>
          </div>
        </div>
      </div>

      {/* Save Button */}
      {isAdmin && (
        <div className="pt-4">
          {saveError && (
            <div className="mb-3 p-3 bg-error/10 border border-error/20 rounded-lg flex items-center gap-2">
              <ErrorIcon className="w-4 h-4" />
              <p className="text-sm text-error">{saveError}</p>
            </div>
          )}
          <button
            onClick={onSave}
            disabled={!hasChanges || isSaving}
            className="w-full px-4 py-2.5 text-sm font-medium bg-accent-cyan text-bg-deep rounded-lg hover:bg-accent-cyan/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
          >
            {isSaving && <MiniSpinner />}
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      )}

      {!isAdmin && (
        <div className="p-3 bg-warning/10 border border-warning/20 rounded-lg">
          <p className="text-sm text-warning">
            You need admin permissions to edit channel settings.
          </p>
        </div>
      )}
    </div>
  );
}

// Members Tab
interface MembersTabProps {
  members: ChannelMemberInfo[];
  isLoading: boolean;
  error: string | null;
  isAdmin: boolean;
  currentUserId?: string;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onRemoveMember: (member: ChannelMemberInfo) => void;
  onToggleRole: (memberId: string, role: 'admin' | 'member') => Promise<void>;
  showAgentSelector: boolean;
  setShowAgentSelector: (show: boolean) => void;
  unassignedAgents: Array<{ name: string; status: string }>;
  assigningAgent: string | null;
  onAssignAgent: (agentName: string) => void;
  onRefresh: () => void;
}

function MembersTab({
  members,
  isLoading,
  error,
  isAdmin,
  currentUserId,
  searchQuery,
  setSearchQuery,
  currentPage,
  totalPages,
  onPageChange,
  onRemoveMember,
  onToggleRole,
  showAgentSelector,
  setShowAgentSelector,
  unassignedAgents,
  assigningAgent,
  onAssignAgent,
  onRefresh,
}: MembersTabProps) {
  return (
    <div className="space-y-4">
      {/* Search and Actions */}
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search members..."
            className="w-full pl-10 pr-4 py-2 bg-bg-tertiary border border-sidebar-border rounded-lg text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-accent-cyan/50 transition-colors"
          />
        </div>
        {isAdmin && (
          <button
            onClick={() => setShowAgentSelector(!showAgentSelector)}
            className="px-3 py-2 bg-accent-cyan text-bg-deep text-sm font-medium rounded-lg hover:bg-accent-cyan/90 transition-colors flex items-center gap-1"
          >
            <PlusIcon className="w-4 h-4" />
            Add Agent
          </button>
        )}
      </div>

      {/* Agent Selector */}
      {showAgentSelector && isAdmin && (
        <div className="p-3 bg-bg-tertiary rounded-lg border border-sidebar-border">
          <p className="text-xs text-text-muted mb-2">Select an agent to add:</p>
          {unassignedAgents.length === 0 ? (
            <p className="text-sm text-text-muted">All agents are already members</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {unassignedAgents.map((agent) => (
                <button
                  key={agent.name}
                  onClick={() => onAssignAgent(agent.name)}
                  disabled={assigningAgent !== null}
                  className="px-3 py-1.5 text-xs font-medium bg-bg-secondary border border-sidebar-border rounded-md hover:border-accent-cyan/50 disabled:opacity-50 transition-colors flex items-center gap-1"
                >
                  {assigningAgent === agent.name ? (
                    <MiniSpinner />
                  ) : (
                    <span className={`w-2 h-2 rounded-full ${
                      agent.status === 'online' ? 'bg-success' : 'bg-text-muted'
                    }`} />
                  )}
                  {agent.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Members List */}
      {isLoading && members.length === 0 ? (
        <div className="py-12 text-center">
          <LoadingSpinner />
          <p className="text-sm text-text-muted mt-2">Loading members...</p>
        </div>
      ) : error ? (
        <div className="py-12 text-center">
          <ErrorIcon />
          <p className="text-sm text-error mt-2">{error}</p>
          <button onClick={onRefresh} className="mt-3 text-sm text-accent-cyan hover:underline">
            Try again
          </button>
        </div>
      ) : members.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-text-muted">
            {searchQuery ? 'No members found' : 'No members yet'}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {members.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              isAdmin={isAdmin}
              isSelf={member.id === currentUserId}
              onRemove={() => onRemoveMember(member)}
              onToggleRole={() => onToggleRole(member.id, member.role === 'admin' ? 'member' : 'admin')}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="pt-4">
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={onPageChange}
          />
        </div>
      )}
    </div>
  );
}

// Member Row
interface MemberRowProps {
  member: ChannelMemberInfo;
  isAdmin: boolean;
  isSelf: boolean;
  onRemove: () => void;
  onToggleRole: () => void;
}

function MemberRow({ member, isAdmin, isSelf, onRemove, onToggleRole }: MemberRowProps) {
  const [showMenu, setShowMenu] = useState(false);

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg hover:bg-sidebar-border/50 transition-colors group">
      {/* Avatar */}
      <div className="w-9 h-9 rounded-full bg-accent-cyan/20 flex items-center justify-center flex-shrink-0">
        {member.avatarUrl ? (
          <img
            src={member.avatarUrl}
            alt={member.displayName || member.name}
            className="w-9 h-9 rounded-full object-cover"
          />
        ) : (
          <span className="text-sm font-medium text-accent-cyan">
            {(member.displayName || member.name).charAt(0).toUpperCase()}
          </span>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary truncate">
            {member.displayName || member.name}
          </span>
          {member.isAgent && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-accent-cyan/20 text-accent-cyan rounded">
              Agent
            </span>
          )}
          {member.role === 'admin' && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-warning/20 text-warning rounded">
              Admin
            </span>
          )}
        </div>
        <p className="text-xs text-text-muted">
          Joined {new Date(member.joinedAt).toLocaleDateString()}
        </p>
      </div>

      {/* Actions */}
      {isAdmin && !isSelf && (
        <div className="relative">
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-sidebar-border opacity-0 group-hover:opacity-100 transition-all"
          >
            <MoreIcon />
          </button>
          {showMenu && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setShowMenu(false)}
              />
              <div className="absolute right-0 top-full mt-1 w-40 bg-sidebar-bg border border-sidebar-border rounded-lg shadow-lg z-20 py-1">
                <button
                  onClick={() => {
                    onToggleRole();
                    setShowMenu(false);
                  }}
                  className="w-full px-3 py-2 text-sm text-left text-text-primary hover:bg-sidebar-border transition-colors"
                >
                  {member.role === 'admin' ? 'Remove Admin' : 'Make Admin'}
                </button>
                <button
                  onClick={() => {
                    onRemove();
                    setShowMenu(false);
                  }}
                  className="w-full px-3 py-2 text-sm text-left text-error hover:bg-sidebar-border transition-colors"
                >
                  Remove from Channel
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Icons
function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function SearchIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function PlusIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
      <circle cx="5" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

function LoadingSpinner() {
  return (
    <svg className="animate-spin mx-auto text-accent-cyan" width="24" height="24" viewBox="0 0 24 24">
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

function MiniSpinner() {
  return (
    <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24">
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

function ErrorIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={`mx-auto text-error ${className}`} width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
