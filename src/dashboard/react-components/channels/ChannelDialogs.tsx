/**
 * Channel Dialogs
 *
 * Confirmation dialogs for channel actions:
 * - Archive channel
 * - Delete channel
 * - Leave channel
 * - Create channel modal
 */

import React, { useState, useCallback } from 'react';
import type { Channel, ChannelVisibility, CreateChannelRequest } from './types';

// =============================================================================
// Archive Channel Dialog
// =============================================================================

export interface ArchiveChannelDialogProps {
  channel: Channel;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isLoading?: boolean;
}

export function ArchiveChannelDialog({
  channel,
  isOpen,
  onClose,
  onConfirm,
  isLoading = false,
}: ArchiveChannelDialogProps) {
  if (!isOpen) return null;

  const isUnarchiving = channel.status === 'archived';

  return (
    <Dialog onClose={onClose}>
      <div className="p-6 max-w-md">
        <div className="flex items-center gap-3 mb-4">
          <div className={`
            w-10 h-10 rounded-full flex items-center justify-center
            ${isUnarchiving ? 'bg-success/10' : 'bg-warning/10'}
          `}>
            {isUnarchiving ? (
              <UnarchiveIcon className="w-5 h-5 text-success" />
            ) : (
              <ArchiveIcon className="w-5 h-5 text-warning" />
            )}
          </div>
          <div>
            <h2 className="text-lg font-semibold text-text-primary">
              {isUnarchiving ? 'Unarchive' : 'Archive'} #{channel.name}?
            </h2>
          </div>
        </div>

        <p className="text-sm text-text-secondary mb-6">
          {isUnarchiving ? (
            <>
              This will restore the channel and make it visible to all members again.
              Messages will be preserved.
            </>
          ) : (
            <>
              Archiving this channel will move it to the Archived section. Members can
              still view message history, but no new messages can be sent. You can
              unarchive it later.
            </>
          )}
        </p>

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-text-secondary bg-bg-tertiary hover:bg-bg-hover rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className={`
              px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2
              ${isUnarchiving
                ? 'bg-success/20 text-success hover:bg-success/30'
                : 'bg-warning/20 text-warning hover:bg-warning/30'}
            `}
          >
            {isLoading && <LoadingSpinner className="w-4 h-4" />}
            {isUnarchiving ? 'Unarchive' : 'Archive'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// =============================================================================
// Delete Channel Dialog
// =============================================================================

export interface DeleteChannelDialogProps {
  channel: Channel;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isLoading?: boolean;
}

export function DeleteChannelDialog({
  channel,
  isOpen,
  onClose,
  onConfirm,
  isLoading = false,
}: DeleteChannelDialogProps) {
  const [confirmText, setConfirmText] = useState('');

  if (!isOpen) return null;

  const canDelete = confirmText === channel.name;

  return (
    <Dialog onClose={onClose}>
      <div className="p-6 max-w-md">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
            <TrashIcon className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-text-primary">
              Delete #{channel.name}?
            </h2>
          </div>
        </div>

        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 mb-4">
          <p className="text-sm text-red-400 font-medium flex items-center gap-2">
            <WarningIcon className="w-4 h-4" />
            This action cannot be undone
          </p>
        </div>

        <p className="text-sm text-text-secondary mb-4">
          Deleting this channel will permanently remove all messages and files.
          All {channel.memberCount} members will lose access.
        </p>

        <div className="mb-6">
          <label className="block text-sm text-text-muted mb-2">
            Type <span className="font-mono text-text-primary">{channel.name}</span> to confirm:
          </label>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={channel.name}
            className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary text-sm focus:outline-none focus:border-red-500/50"
          />
        </div>

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-text-secondary bg-bg-tertiary hover:bg-bg-hover rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canDelete || isLoading}
            className="px-4 py-2 text-sm font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isLoading && <LoadingSpinner className="w-4 h-4" />}
            Delete Channel
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// =============================================================================
// Leave Channel Dialog
// =============================================================================

export interface LeaveChannelDialogProps {
  channel: Channel;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isLoading?: boolean;
}

export function LeaveChannelDialog({
  channel,
  isOpen,
  onClose,
  onConfirm,
  isLoading = false,
}: LeaveChannelDialogProps) {
  if (!isOpen) return null;

  return (
    <Dialog onClose={onClose}>
      <div className="p-6 max-w-md">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-accent-cyan/10 flex items-center justify-center">
            <LeaveIcon className="w-5 h-5 text-accent-cyan" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-text-primary">
              Leave #{channel.name}?
            </h2>
          </div>
        </div>

        <p className="text-sm text-text-secondary mb-6">
          You'll no longer receive messages from this channel. You can rejoin at
          any time if the channel is public.
        </p>

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-text-secondary bg-bg-tertiary hover:bg-bg-hover rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium bg-accent-cyan/20 text-accent-cyan hover:bg-accent-cyan/30 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isLoading && <LoadingSpinner className="w-4 h-4" />}
            Leave Channel
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// =============================================================================
// Create Channel Modal
// =============================================================================

export interface CreateChannelModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (request: CreateChannelRequest) => void;
  isLoading?: boolean;
  existingChannels?: string[];
}

export function CreateChannelModal({
  isOpen,
  onClose,
  onCreate,
  isLoading = false,
  existingChannels = [],
}: CreateChannelModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<ChannelVisibility>('public');

  const handleClose = useCallback(() => {
    setName('');
    setDescription('');
    setVisibility('public');
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    onCreate({
      name: name.trim().toLowerCase().replace(/\s+/g, '-'),
      description: description.trim() || undefined,
      visibility,
    });
  }, [name, description, visibility, onCreate]);

  if (!isOpen) return null;

  // Validate channel name
  const normalizedName = name.trim().toLowerCase().replace(/\s+/g, '-');
  const nameExists = existingChannels.includes(`#${normalizedName}`);
  const isValidName = normalizedName.length >= 2 && normalizedName.length <= 80 && /^[a-z0-9-]+$/.test(normalizedName);
  const canCreate = name.trim() && isValidName && !nameExists;

  return (
    <Dialog onClose={handleClose}>
      <form onSubmit={handleSubmit} className="p-6 w-[400px] max-w-full">
        <h2 className="text-lg font-semibold text-text-primary mb-6">
          Create a channel
        </h2>

        {/* Channel Name */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-text-primary mb-1.5">
            Channel name
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">#</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., engineering"
              className="w-full pl-7 pr-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent-cyan/50"
              autoFocus
            />
          </div>
          {name && !isValidName && (
            <p className="mt-1 text-xs text-red-400">
              Channel names must be 2-80 characters, lowercase letters, numbers, and hyphens only
            </p>
          )}
          {nameExists && (
            <p className="mt-1 text-xs text-red-400">
              A channel with this name already exists
            </p>
          )}
        </div>

        {/* Description */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-text-primary mb-1.5">
            Description <span className="text-text-muted font-normal">(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's this channel about?"
            rows={2}
            className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent-cyan/50 resize-none"
          />
        </div>

        {/* Visibility */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-text-primary mb-2">
            Visibility
          </label>
          <div className="space-y-2">
            <label className={`
              flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors
              ${visibility === 'public'
                ? 'border-accent-cyan/30 bg-accent-cyan/5'
                : 'border-border-subtle hover:bg-bg-hover'}
            `}>
              <input
                type="radio"
                name="visibility"
                value="public"
                checked={visibility === 'public'}
                onChange={() => setVisibility('public')}
                className="mt-1"
              />
              <div>
                <div className="flex items-center gap-2">
                  <HashIcon className="w-4 h-4 text-text-primary" />
                  <span className="text-sm font-medium text-text-primary">Public</span>
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  Anyone can join and view messages
                </p>
              </div>
            </label>

            <label className={`
              flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors
              ${visibility === 'private'
                ? 'border-accent-cyan/30 bg-accent-cyan/5'
                : 'border-border-subtle hover:bg-bg-hover'}
            `}>
              <input
                type="radio"
                name="visibility"
                value="private"
                checked={visibility === 'private'}
                onChange={() => setVisibility('private')}
                className="mt-1"
              />
              <div>
                <div className="flex items-center gap-2">
                  <LockIcon className="w-4 h-4 text-text-primary" />
                  <span className="text-sm font-medium text-text-primary">Private</span>
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  Only invited members can join
                </p>
              </div>
            </label>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={handleClose}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-text-secondary bg-bg-tertiary hover:bg-bg-hover rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canCreate || isLoading}
            className="px-4 py-2 text-sm font-medium bg-accent-cyan text-bg-deep hover:bg-accent-cyan/90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isLoading && <LoadingSpinner className="w-4 h-4" />}
            Create Channel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// =============================================================================
// Base Dialog Component
// =============================================================================

function Dialog({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Content */}
      <div
        className="relative bg-bg-elevated border border-border-subtle rounded-xl shadow-2xl animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

// =============================================================================
// Icons
// =============================================================================

function LoadingSpinner({ className }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function ArchiveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  );
}

function UnarchiveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <path d="M12 12v6" />
      <path d="M9 15l3-3 3 3" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function LeaveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function HashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function UserPlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <line x1="20" y1="8" x2="20" y2="14" />
      <line x1="23" y1="11" x2="17" y2="11" />
    </svg>
  );
}

function UserMinusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <line x1="23" y1="11" x2="17" y2="11" />
    </svg>
  );
}

// =============================================================================
// Channel Settings Modal (Task 10)
// =============================================================================

export interface ChannelSettingsModalProps {
  channel: Channel;
  isOpen: boolean;
  onClose: () => void;
  onSave: (updates: { name?: string; description?: string; isPrivate?: boolean }) => void;
  isLoading?: boolean;
  error?: string;
  existingChannelNames?: string[];
}

export function ChannelSettingsModal({
  channel,
  isOpen,
  onClose,
  onSave,
  isLoading = false,
  error,
  existingChannelNames = [],
}: ChannelSettingsModalProps) {
  const [name, setName] = useState(channel.name);
  const [description, setDescription] = useState(channel.description || '');
  const [isPrivate, setIsPrivate] = useState(channel.visibility === 'private');

  // Reset form when channel changes
  React.useEffect(() => {
    setName(channel.name);
    setDescription(channel.description || '');
    setIsPrivate(channel.visibility === 'private');
  }, [channel]);

  const handleClose = useCallback(() => {
    setName(channel.name);
    setDescription(channel.description || '');
    setIsPrivate(channel.visibility === 'private');
    onClose();
  }, [channel, onClose]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();

    // Build changes object (only include changed fields)
    const changes: { name?: string; description?: string; isPrivate?: boolean } = {};
    const normalizedName = name.trim().toLowerCase().replace(/\s+/g, '-');

    if (normalizedName !== channel.name) {
      changes.name = normalizedName;
    }
    if (description.trim() !== (channel.description || '')) {
      changes.description = description.trim();
    }
    if (isPrivate !== (channel.visibility === 'private')) {
      changes.isPrivate = isPrivate;
    }

    if (Object.keys(changes).length > 0) {
      onSave(changes);
    }
  }, [name, description, isPrivate, channel, onSave]);

  if (!isOpen) return null;

  // Validate channel name
  const normalizedName = name.trim().toLowerCase().replace(/\s+/g, '-');
  const nameChanged = normalizedName !== channel.name;
  const nameExists = nameChanged && existingChannelNames.includes(normalizedName);
  const isValidName = normalizedName.length >= 2 && normalizedName.length <= 80 && /^[a-z0-9-]+$/.test(normalizedName);

  // Check if form has changes
  const hasChanges = nameChanged ||
    description.trim() !== (channel.description || '') ||
    isPrivate !== (channel.visibility === 'private');

  const canSave = hasChanges && isValidName && !nameExists;

  return (
    <Dialog onClose={handleClose}>
      <form onSubmit={handleSubmit} className="p-6 w-[400px] max-w-full">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-full bg-accent-cyan/10 flex items-center justify-center">
            <SettingsIcon className="w-5 h-5 text-accent-cyan" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary">
            Channel Settings
          </h2>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Channel Name */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-text-primary mb-1.5">
            Channel name
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">#</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full pl-7 pr-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent-cyan/50"
            />
          </div>
          {name && !isValidName && (
            <p className="mt-1 text-xs text-red-400">
              Channel names must be 2-80 characters, lowercase letters, numbers, and hyphens only
            </p>
          )}
          {nameExists && (
            <p className="mt-1 text-xs text-red-400">
              A channel with this name already exists
            </p>
          )}
        </div>

        {/* Description */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-text-primary mb-1.5">
            Description <span className="text-text-muted font-normal">(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's this channel about?"
            rows={2}
            className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent-cyan/50 resize-none"
          />
        </div>

        {/* Visibility */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-text-primary mb-2">
            Visibility
          </label>
          <div className="space-y-2">
            <label className="flex items-start gap-3 p-3 bg-bg-tertiary rounded-lg cursor-pointer hover:bg-bg-hover transition-colors">
              <input
                type="radio"
                name="visibility"
                checked={!isPrivate}
                onChange={() => setIsPrivate(false)}
                className="mt-0.5"
              />
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <HashIcon className="w-4 h-4" />
                  Public
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  Anyone in the workspace can view and join
                </p>
              </div>
            </label>
            <label className="flex items-start gap-3 p-3 bg-bg-tertiary rounded-lg cursor-pointer hover:bg-bg-hover transition-colors">
              <input
                type="radio"
                name="visibility"
                checked={isPrivate}
                onChange={() => setIsPrivate(true)}
                className="mt-0.5"
              />
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <LockIcon className="w-4 h-4" />
                  Private
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  Only invited members can view and join
                </p>
              </div>
            </label>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={handleClose}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-text-secondary bg-bg-tertiary hover:bg-bg-hover rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSave || isLoading}
            className="px-4 py-2 text-sm font-medium bg-accent-cyan text-bg-deep hover:bg-accent-cyan/90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isLoading && <LoadingSpinner className="w-4 h-4" />}
            Save Changes
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// =============================================================================
// Member Management Panel (Task 10)
// =============================================================================

export interface MemberManagementPanelProps {
  channel: Channel;
  members: ChannelMember[];
  isOpen: boolean;
  onClose: () => void;
  onAddMember: (memberId: string, memberType: 'user' | 'agent', role: 'admin' | 'member' | 'read_only') => void;
  onRemoveMember: (memberId: string, memberType: 'user' | 'agent') => void;
  onUpdateRole: (memberId: string, memberType: 'user' | 'agent', role: 'admin' | 'member' | 'read_only') => void;
  currentUserId?: string;
  isLoading?: boolean;
  availableUsers?: { id: string; name: string }[];
  availableAgents?: { name: string }[];
}

export function MemberManagementPanel({
  channel,
  members,
  isOpen,
  onClose,
  onAddMember,
  onRemoveMember,
  onUpdateRole,
  currentUserId,
  isLoading = false,
  availableUsers = [],
  availableAgents = [],
}: MemberManagementPanelProps) {
  const [showAddMember, setShowAddMember] = useState(false);
  const [addMemberType, setAddMemberType] = useState<'user' | 'agent'>('user');
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [selectedRole, setSelectedRole] = useState<'admin' | 'member' | 'read_only'>('member');

  if (!isOpen) return null;

  // Separate users and agents
  const userMembers = members.filter(m => m.entityType === 'user');
  const agentMembers = members.filter(m => m.entityType === 'agent');

  // Get current user's role
  const currentMember = members.find(m => m.id === currentUserId);
  const canManageMembers = currentMember?.role === 'owner' || currentMember?.role === 'admin';

  // Count admins to prevent removing the last one
  const adminCount = members.filter(m => m.role === 'owner' || m.role === 'admin').length;

  // Filter out already added members from available lists
  const memberIds = new Set(members.map(m => m.id));
  const filteredUsers = availableUsers.filter(u => !memberIds.has(u.id));
  const filteredAgents = availableAgents.filter(a => !members.some(m => m.displayName === a.name && m.entityType === 'agent'));

  const handleAddMember = () => {
    if (!selectedMemberId) return;
    onAddMember(selectedMemberId, addMemberType, selectedRole);
    setSelectedMemberId('');
    setShowAddMember(false);
  };

  const canRemoveMember = (member: ChannelMember) => {
    // Cannot remove owner
    if (member.role === 'owner') return false;
    // Cannot remove last admin
    if ((member.role === 'admin') && adminCount <= 1) return false;
    // Cannot remove self (use leave channel instead)
    if (member.id === currentUserId) return false;
    return canManageMembers;
  };

  const canChangeRole = (member: ChannelMember) => {
    // Cannot change owner's role
    if (member.role === 'owner') return false;
    // Cannot demote last admin
    if ((member.role === 'admin') && adminCount <= 1) return false;
    return canManageMembers;
  };

  return (
    <Dialog onClose={onClose}>
      <div className="p-6 w-[500px] max-w-full max-h-[80vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-accent-cyan/10 flex items-center justify-center">
              <UserPlusIcon className="w-5 h-5 text-accent-cyan" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text-primary">
                Members
              </h2>
              <p className="text-sm text-text-muted">
                #{channel.name} · {members.length} {members.length === 1 ? 'member' : 'members'}
              </p>
            </div>
          </div>
          {canManageMembers && (
            <button
              onClick={() => setShowAddMember(!showAddMember)}
              className="px-3 py-1.5 text-sm font-medium bg-accent-cyan/20 text-accent-cyan hover:bg-accent-cyan/30 rounded-lg transition-colors"
            >
              {showAddMember ? 'Cancel' : 'Add Member'}
            </button>
          )}
        </div>

        {/* Add Member Form */}
        {showAddMember && canManageMembers && (
          <div className="mb-4 p-4 bg-bg-tertiary rounded-lg border border-border-subtle">
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => setAddMemberType('user')}
                className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                  addMemberType === 'user'
                    ? 'bg-accent-cyan text-bg-deep'
                    : 'bg-bg-hover text-text-secondary hover:text-text-primary'
                }`}
              >
                User
              </button>
              <button
                onClick={() => setAddMemberType('agent')}
                className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                  addMemberType === 'agent'
                    ? 'bg-accent-cyan text-bg-deep'
                    : 'bg-bg-hover text-text-secondary hover:text-text-primary'
                }`}
              >
                Agent
              </button>
            </div>

            <div className="flex gap-2 mb-3">
              <select
                value={selectedMemberId}
                onChange={(e) => setSelectedMemberId(e.target.value)}
                className="flex-1 px-3 py-2 bg-bg-deep border border-border-subtle rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent-cyan/50"
              >
                <option value="">Select {addMemberType}...</option>
                {addMemberType === 'user'
                  ? filteredUsers.map(u => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))
                  : filteredAgents.map(a => (
                      <option key={a.name} value={a.name}>{a.name}</option>
                    ))}
              </select>
              <select
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value as 'admin' | 'member' | 'read_only')}
                className="px-3 py-2 bg-bg-deep border border-border-subtle rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent-cyan/50"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                <option value="read_only">Read Only</option>
              </select>
            </div>

            <button
              onClick={handleAddMember}
              disabled={!selectedMemberId || isLoading}
              className="w-full px-3 py-2 text-sm font-medium bg-accent-cyan text-bg-deep hover:bg-accent-cyan/90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Add {addMemberType === 'user' ? 'User' : 'Agent'}
            </button>
          </div>
        )}

        {/* Members List */}
        <div className="flex-1 overflow-y-auto space-y-4">
          {/* Users */}
          {userMembers.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-text-muted uppercase mb-2">Users ({userMembers.length})</h3>
              <div className="space-y-1">
                {userMembers.map((member) => (
                  <MemberRow
                    key={member.id}
                    member={member}
                    canChangeRole={canChangeRole(member)}
                    canRemove={canRemoveMember(member)}
                    onChangeRole={(role) => onUpdateRole(member.id, 'user', role)}
                    onRemove={() => onRemoveMember(member.id, 'user')}
                    isCurrentUser={member.id === currentUserId}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Agents */}
          {agentMembers.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-text-muted uppercase mb-2">Agents ({agentMembers.length})</h3>
              <div className="space-y-1">
                {agentMembers.map((member) => (
                  <MemberRow
                    key={member.id}
                    member={member}
                    canChangeRole={canChangeRole(member)}
                    canRemove={canRemoveMember(member)}
                    onChangeRole={(role) => onUpdateRole(member.id, 'agent', role)}
                    onRemove={() => onRemoveMember(member.id, 'agent')}
                    isAgent
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-4 pt-4 border-t border-border-subtle">
          <button
            onClick={onClose}
            className="w-full px-4 py-2 text-sm font-medium text-text-secondary bg-bg-tertiary hover:bg-bg-hover rounded-lg transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function MemberRow({
  member,
  canChangeRole,
  canRemove,
  onChangeRole,
  onRemove,
  isCurrentUser,
  isAgent,
}: {
  member: ChannelMember;
  canChangeRole: boolean;
  canRemove: boolean;
  onChangeRole: (role: 'admin' | 'member' | 'read_only') => void;
  onRemove: () => void;
  isCurrentUser?: boolean;
  isAgent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between p-2 rounded-lg hover:bg-bg-tertiary group">
      <div className="flex items-center gap-3">
        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium ${
          isAgent ? 'bg-purple-500/20 text-purple-400' : 'bg-accent-cyan/20 text-accent-cyan'
        }`}>
          {(member.displayName || member.id)[0].toUpperCase()}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary">
              {member.displayName || member.id}
            </span>
            {isCurrentUser && (
              <span className="text-xs text-text-muted">(you)</span>
            )}
            {isAgent && (
              <span className="text-xs px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded">
                Agent
              </span>
            )}
          </div>
          <span className={`text-xs capitalize ${
            member.role === 'owner' ? 'text-yellow-400' :
            member.role === 'admin' ? 'text-accent-cyan' :
            'text-text-muted'
          }`}>
            {member.role}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        {canChangeRole && (
          <select
            value={member.role === 'owner' ? 'admin' : member.role}
            onChange={(e) => onChangeRole(e.target.value as 'admin' | 'member' | 'read_only')}
            className="px-2 py-1 text-xs bg-bg-tertiary border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent-cyan/50"
          >
            <option value="admin">Admin</option>
            <option value="member">Member</option>
            <option value="read_only">Read Only</option>
          </select>
        )}
        {canRemove && (
          <button
            onClick={onRemove}
            className="p-1.5 text-red-400 hover:bg-red-500/20 rounded transition-colors"
            title="Remove member"
          >
            <UserMinusIcon className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

// Type import for Channel and ChannelMember
import type { ChannelMember } from './types';
