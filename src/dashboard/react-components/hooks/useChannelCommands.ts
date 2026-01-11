/**
 * useChannelCommands Hook
 *
 * Provides channel-related commands for the CommandPalette.
 * Integrates /create-channel, /join-channel, /leave-channel, /channels commands.
 */

import { useMemo, useCallback, createElement } from 'react';
import type { Command } from '../CommandPalette';
import { api } from '../../lib/api';

export interface ChannelInfo {
  id: string;
  name: string;
  memberCount?: number;
}

export interface UseChannelCommandsOptions {
  /** List of channels user has joined */
  joinedChannels: string[];
  /** Callback when user wants to browse channels */
  onBrowseChannels: () => void;
  /** Callback when user wants to create a channel */
  onCreateChannel: () => void;
  /** Callback when a channel is joined */
  onChannelJoined?: (channelName: string) => void;
  /** Callback when a channel is left */
  onChannelLeft?: (channelName: string) => void;
}

export interface UseChannelCommandsReturn {
  /** Commands to add to CommandPalette */
  commands: Command[];
  /** Autocomplete suggestions for channel names */
  getChannelSuggestions: (query: string) => Promise<ChannelInfo[]>;
}

export function useChannelCommands(
  options: UseChannelCommandsOptions
): UseChannelCommandsReturn {
  const {
    joinedChannels,
    onBrowseChannels,
    onCreateChannel,
    onChannelJoined,
    onChannelLeft,
  } = options;

  // Get channel suggestions for autocomplete
  const getChannelSuggestions = useCallback(async (query: string): Promise<ChannelInfo[]> => {
    try {
      const params = new URLSearchParams({
        search: query,
        limit: '10',
      });

      const result = await api.get<{
        channels: Array<{ id: string; name: string; memberCount: number }>;
      }>(`/api/channels/browse?${params.toString()}`);

      return result.channels || [];
    } catch (err) {
      console.error('[useChannelCommands] Failed to get suggestions:', err);
      return [];
    }
  }, []);

  // Join channel action
  const joinChannel = useCallback(async (channelName: string) => {
    try {
      // Normalize channel name
      const normalized = channelName.startsWith('#') ? channelName.slice(1) : channelName;

      await api.post(`/api/channels/${normalized}/join`);
      onChannelJoined?.(`#${normalized}`);
    } catch (err) {
      console.error('[useChannelCommands] Failed to join channel:', err);
    }
  }, [onChannelJoined]);

  // Leave channel action
  const leaveChannel = useCallback(async (channelName: string) => {
    try {
      // Normalize channel name
      const normalized = channelName.startsWith('#') ? channelName.slice(1) : channelName;

      await api.post(`/api/channels/${normalized}/leave`);
      onChannelLeft?.(`#${normalized}`);
    } catch (err) {
      console.error('[useChannelCommands] Failed to leave channel:', err);
    }
  }, [onChannelLeft]);

  // Build commands
  const commands = useMemo((): Command[] => {
    const channelCommands: Command[] = [
      {
        id: 'browse-channels',
        label: 'Browse Channels',
        description: 'Discover and join public channels',
        category: 'channels',
        icon: createElement('span', { className: 'text-sm' }, '#'),
        shortcut: '/channels',
        action: onBrowseChannels,
      },
      {
        id: 'create-channel',
        label: 'Create Channel',
        description: 'Start a new channel',
        category: 'channels',
        icon: createElement('span', { className: 'text-sm' }, '+'),
        shortcut: '/create-channel',
        action: onCreateChannel,
      },
    ];

    // Add leave commands for joined channels
    for (const channel of joinedChannels) {
      const displayName = channel.startsWith('#') ? channel : `#${channel}`;
      channelCommands.push({
        id: `leave-${channel}`,
        label: `Leave ${displayName}`,
        description: 'Leave this channel',
        category: 'channels',
        icon: createElement('span', { className: 'text-sm' }, '⊗'),
        action: () => leaveChannel(channel),
      });
    }

    return channelCommands;
  }, [joinedChannels, onBrowseChannels, onCreateChannel, leaveChannel]);

  return {
    commands,
    getChannelSuggestions,
  };
}

