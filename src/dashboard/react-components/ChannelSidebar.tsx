/**
 * ChannelSidebar Component
 *
 * Displays joined channels and allows channel management.
 * Slack-like interface for channel navigation.
 */

import React, { useState, useCallback } from 'react';
import type { ChannelMessage } from './hooks/useChannels';

export interface ChannelSidebarProps {
  /** List of joined channels */
  channels: string[];
  /** Currently selected channel */
  selectedChannel?: string;
  /** Callback when channel is selected */
  onSelectChannel: (channel: string) => void;
  /** Callback to join a channel */
  onJoinChannel: (channel: string) => void;
  /** Callback to leave a channel */
  onLeaveChannel: (channel: string) => void;
  /** Unread message counts per channel */
  unreadCounts?: Record<string, number>;
  /** Whether connected to server */
  isConnected?: boolean;
}

const DEFAULT_CHANNELS = ['#general', '#random', '#help'];

export function ChannelSidebar({
  channels,
  selectedChannel,
  onSelectChannel,
  onJoinChannel,
  onLeaveChannel,
  unreadCounts = {},
  isConnected = true,
}: ChannelSidebarProps) {
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');

  const handleJoinChannel = useCallback(() => {
    if (!newChannelName.trim()) return;

    let channelName = newChannelName.trim();
    // Auto-prefix with # if missing
    if (!channelName.startsWith('#') && !channelName.startsWith('dm:')) {
      channelName = `#${channelName}`;
    }

    onJoinChannel(channelName);
    setNewChannelName('');
    setShowJoinModal(false);
  }, [newChannelName, onJoinChannel]);

  const handleLeaveChannel = useCallback((e: React.MouseEvent, channel: string) => {
    e.stopPropagation();
    onLeaveChannel(channel);
  }, [onLeaveChannel]);

  // Separate public channels and DMs
  const publicChannels = channels.filter(c => c.startsWith('#'));
  const dmChannels = channels.filter(c => c.startsWith('dm:'));

  return (
    <div className="channel-sidebar" style={{
      width: '240px',
      backgroundColor: 'var(--bg-secondary, #1e1e2e)',
      borderRight: '1px solid var(--border-color, #313244)',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
    }}>
      {/* Header */}
      <div style={{
        padding: '16px',
        borderBottom: '1px solid var(--border-color, #313244)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary, #cdd6f4)' }}>
            Channels
          </span>
          <span style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: isConnected ? '#a6e3a1' : '#f38ba8',
          }} />
        </div>
        <button
          onClick={() => setShowJoinModal(true)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-secondary, #a6adc8)',
            cursor: 'pointer',
            padding: '4px 8px',
            borderRadius: '4px',
            fontSize: '16px',
          }}
          title="Join or create channel"
        >
          +
        </button>
      </div>

      {/* Channel List */}
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
        {/* Public Channels */}
        <div style={{ marginBottom: '16px' }}>
          <div style={{
            padding: '4px 16px',
            fontSize: '11px',
            fontWeight: 600,
            color: 'var(--text-secondary, #a6adc8)',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
          }}>
            Channels
          </div>
          {publicChannels.length === 0 ? (
            <div style={{
              padding: '8px 16px',
              fontSize: '13px',
              color: 'var(--text-muted, #6c7086)',
              fontStyle: 'italic',
            }}>
              No channels joined
            </div>
          ) : (
            publicChannels.map(channel => (
              <ChannelItem
                key={channel}
                channel={channel}
                isSelected={selectedChannel === channel}
                unreadCount={unreadCounts[channel] || 0}
                onSelect={() => onSelectChannel(channel)}
                onLeave={(e) => handleLeaveChannel(e, channel)}
              />
            ))
          )}
        </div>

        {/* Direct Messages */}
        <div>
          <div style={{
            padding: '4px 16px',
            fontSize: '11px',
            fontWeight: 600,
            color: 'var(--text-secondary, #a6adc8)',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
          }}>
            Direct Messages
          </div>
          {dmChannels.length === 0 ? (
            <div style={{
              padding: '8px 16px',
              fontSize: '13px',
              color: 'var(--text-muted, #6c7086)',
              fontStyle: 'italic',
            }}>
              No conversations
            </div>
          ) : (
            dmChannels.map(channel => (
              <ChannelItem
                key={channel}
                channel={channel}
                displayName={formatDmName(channel)}
                isSelected={selectedChannel === channel}
                unreadCount={unreadCounts[channel] || 0}
                onSelect={() => onSelectChannel(channel)}
                onLeave={(e) => handleLeaveChannel(e, channel)}
                isDm
              />
            ))
          )}
        </div>
      </div>

      {/* Quick Join Suggestions */}
      {channels.length === 0 && (
        <div style={{
          padding: '16px',
          borderTop: '1px solid var(--border-color, #313244)',
        }}>
          <div style={{
            fontSize: '12px',
            color: 'var(--text-secondary, #a6adc8)',
            marginBottom: '8px',
          }}>
            Suggested channels:
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {DEFAULT_CHANNELS.map(channel => (
              <button
                key={channel}
                onClick={() => onJoinChannel(channel)}
                style={{
                  padding: '4px 8px',
                  fontSize: '12px',
                  backgroundColor: 'var(--bg-tertiary, #313244)',
                  border: 'none',
                  borderRadius: '4px',
                  color: 'var(--text-primary, #cdd6f4)',
                  cursor: 'pointer',
                }}
              >
                {channel}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Join Modal */}
      {showJoinModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
        }} onClick={() => setShowJoinModal(false)}>
          <div style={{
            backgroundColor: 'var(--bg-secondary, #1e1e2e)',
            borderRadius: '8px',
            padding: '24px',
            width: '320px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
          }} onClick={e => e.stopPropagation()}>
            <h3 style={{
              margin: '0 0 16px 0',
              fontSize: '16px',
              fontWeight: 600,
              color: 'var(--text-primary, #cdd6f4)',
            }}>
              Join Channel
            </h3>
            <input
              type="text"
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
              placeholder="Channel name (e.g., general)"
              style={{
                width: '100%',
                padding: '10px 12px',
                backgroundColor: 'var(--bg-primary, #11111b)',
                border: '1px solid var(--border-color, #313244)',
                borderRadius: '6px',
                color: 'var(--text-primary, #cdd6f4)',
                fontSize: '14px',
                marginBottom: '16px',
                outline: 'none',
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleJoinChannel()}
              autoFocus
            />
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowJoinModal(false)}
                style={{
                  padding: '8px 16px',
                  backgroundColor: 'transparent',
                  border: '1px solid var(--border-color, #313244)',
                  borderRadius: '6px',
                  color: 'var(--text-primary, #cdd6f4)',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleJoinChannel}
                disabled={!newChannelName.trim()}
                style={{
                  padding: '8px 16px',
                  backgroundColor: 'var(--accent-color, #89b4fa)',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#11111b',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: 500,
                  opacity: newChannelName.trim() ? 1 : 0.5,
                }}
              >
                Join
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface ChannelItemProps {
  channel: string;
  displayName?: string;
  isSelected: boolean;
  unreadCount: number;
  onSelect: () => void;
  onLeave: (e: React.MouseEvent) => void;
  isDm?: boolean;
}

function ChannelItem({ channel, displayName, isSelected, unreadCount, onSelect, onLeave, isDm }: ChannelItemProps) {
  const [showLeave, setShowLeave] = useState(false);

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setShowLeave(true)}
      onMouseLeave={() => setShowLeave(false)}
      style={{
        padding: '6px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        cursor: 'pointer',
        backgroundColor: isSelected ? 'var(--bg-tertiary, #313244)' : 'transparent',
        color: unreadCount > 0
          ? 'var(--text-primary, #cdd6f4)'
          : 'var(--text-secondary, #a6adc8)',
        fontWeight: unreadCount > 0 ? 600 : 400,
        fontSize: '14px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
        <span style={{ flexShrink: 0 }}>
          {isDm ? '@' : '#'}
        </span>
        <span style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {displayName || channel.replace(/^#/, '')}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {unreadCount > 0 && (
          <span style={{
            backgroundColor: 'var(--accent-color, #89b4fa)',
            color: '#11111b',
            fontSize: '11px',
            fontWeight: 600,
            padding: '2px 6px',
            borderRadius: '10px',
            minWidth: '18px',
            textAlign: 'center',
          }}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
        {showLeave && (
          <button
            onClick={onLeave}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted, #6c7086)',
              cursor: 'pointer',
              padding: '2px',
              fontSize: '12px',
              lineHeight: 1,
            }}
            title="Leave channel"
          >
            x
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Format DM channel name for display.
 * dm:alice:bob -> "alice, bob" (excluding current user if known)
 */
function formatDmName(channel: string): string {
  if (!channel.startsWith('dm:')) return channel;
  const parts = channel.split(':').slice(1);
  return parts.join(', ');
}

export default ChannelSidebar;
