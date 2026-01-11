/**
 * CreateChannelModal Component
 *
 * A modal for creating new channels with name, description, and privacy settings.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { createChannel } from './channels/api';

export interface CreateChannelModalProps {
  isOpen: boolean;
  onClose: () => void;
  onChannelCreated?: (channel: { id: string; name: string }) => void;
}

export function CreateChannelModal({
  isOpen,
  onClose,
  onChannelCreated,
}: CreateChannelModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setName('');
      setDescription('');
      setIsPrivate(false);
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isCreating) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isCreating, onClose]);

  // Normalize channel name
  const normalizedName = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const isValidName = normalizedName.length >= 1 && normalizedName.length <= 50;

  // Handle create
  const handleCreate = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isValidName || isCreating) return;

    setIsCreating(true);
    setError(null);

    try {
      const result = await createChannel('local', {
        name: normalizedName,
        description: description.trim() || undefined,
        visibility: isPrivate ? 'private' : 'public',
      });

      if (result.channel) {
        onChannelCreated?.({ id: result.channel.id, name: result.channel.name });
        onClose();
      } else {
        setError('Failed to create channel');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create channel';
      setError(message);
    } finally {
      setIsCreating(false);
    }
  }, [normalizedName, description, isPrivate, isValidName, isCreating, onChannelCreated, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-start justify-center pt-[15vh] z-[1000] animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isCreating) {
          onClose();
        }
      }}
    >
      <div
        className="bg-sidebar-bg border border-sidebar-border rounded-xl w-[480px] max-w-[90vw] shadow-modal animate-slide-down"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-sidebar-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-cyan/20 to-blue-500/20 flex items-center justify-center border border-accent-cyan/30">
              <PlusIcon />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text-primary m-0">
                Create Channel
              </h2>
              <p className="text-xs text-text-muted m-0">
                Start a new conversation space
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isCreating}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-sidebar-border transition-colors disabled:opacity-50"
            title="Close (Esc)"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleCreate}>
          <div className="p-4 space-y-4">
            {/* Channel Name */}
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">
                Channel Name
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
                  #
                </span>
                <input
                  ref={inputRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="new-channel"
                  className="w-full pl-7 pr-4 py-2.5 bg-bg-tertiary border border-sidebar-border rounded-lg text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-accent-cyan/50 transition-colors"
                  maxLength={50}
                  disabled={isCreating}
                />
              </div>
              {name && name !== normalizedName && (
                <p className="text-xs text-text-muted mt-1">
                  Will be created as: #{normalizedName}
                </p>
              )}
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">
                Description <span className="text-text-muted font-normal">(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What's this channel about?"
                rows={2}
                className="w-full px-4 py-2.5 bg-bg-tertiary border border-sidebar-border rounded-lg text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-accent-cyan/50 transition-colors resize-none"
                maxLength={200}
                disabled={isCreating}
              />
            </div>

            {/* Privacy Toggle */}
            <div className="flex items-center justify-between p-3 bg-bg-tertiary rounded-lg border border-sidebar-border">
              <div className="flex items-center gap-3">
                {isPrivate ? <LockIcon /> : <GlobeIcon />}
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {isPrivate ? 'Private Channel' : 'Public Channel'}
                  </p>
                  <p className="text-xs text-text-muted">
                    {isPrivate
                      ? 'Only invited members can see and join'
                      : 'Anyone can browse and join this channel'
                    }
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsPrivate(!isPrivate)}
                disabled={isCreating}
                className={`
                  w-11 h-6 rounded-full relative transition-colors
                  ${isPrivate ? 'bg-accent-cyan' : 'bg-sidebar-border'}
                `}
              >
                <span
                  className={`
                    absolute top-1 w-4 h-4 bg-white rounded-full transition-transform
                    ${isPrivate ? 'left-6' : 'left-1'}
                  `}
                />
              </button>
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg">
                <ErrorIcon />
                <p className="text-sm text-error">{error}</p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-3 p-4 border-t border-sidebar-border">
            <button
              type="button"
              onClick={onClose}
              disabled={isCreating}
              className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!isValidName || isCreating}
              className="px-4 py-2 text-sm font-medium bg-accent-cyan text-bg-deep rounded-lg hover:bg-accent-cyan/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              {isCreating && <MiniSpinner />}
              {isCreating ? 'Creating...' : 'Create Channel'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Icons
function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
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

function LockIcon() {
  return (
    <svg className="text-warning" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg className="text-accent-cyan" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg className="text-error flex-shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function MiniSpinner() {
  return (
    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24">
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
