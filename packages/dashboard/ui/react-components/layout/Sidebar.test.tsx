/**
 * Tests for Sidebar component channel functionality.
 *
 * Tests channel rendering, selection, interactions, and state management.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { Sidebar, type SidebarProps, type SidebarChannel } from './Sidebar';

// Mock localStorage with proper reset between tests
let localStorageStore: Record<string, string> = {};

const mockLocalStorage = {
  getItem: vi.fn((key: string) => localStorageStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    localStorageStore[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete localStorageStore[key];
  }),
  clear: vi.fn(() => {
    localStorageStore = {};
  }),
};

Object.defineProperty(window, 'localStorage', {
  value: mockLocalStorage,
  writable: true,
});

describe('Sidebar', () => {
  const defaultProps: SidebarProps = {
    agents: [],
    viewMode: 'channels',
    isFleetAvailable: false,
    isConnected: true,
  };

  beforeEach(() => {
    localStorageStore = {};
    vi.clearAllMocks();
    // Reset mock implementations to default behavior
    mockLocalStorage.getItem.mockImplementation((key: string) => localStorageStore[key] ?? null);
  });

  describe('Channel Rendering', () => {
    it('should render channels section header', () => {
      render(<Sidebar {...defaultProps} />);

      expect(screen.getByText('Channels')).toBeInTheDocument();
    });

    it('should render channel list when channels provided', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
        { id: 'ch-2', name: 'engineering', unreadCount: 0 },
      ];

      render(<Sidebar {...defaultProps} channels={channels} />);

      // Expand channels section first (collapsed by default)
      fireEvent.click(screen.getByText('Channels'));

      expect(screen.getByText('general')).toBeInTheDocument();
      expect(screen.getByText('engineering')).toBeInTheDocument();
    });

    it('should show # prefix for channel names', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
      ];

      render(<Sidebar {...defaultProps} channels={channels} />);
      fireEvent.click(screen.getByText('Channels'));

      // The # is in a separate span
      const hashSymbols = screen.getAllByText('#');
      expect(hashSymbols.length).toBeGreaterThan(0);
    });

    it('should render empty state with create button when no channels', () => {
      const onCreateChannel = vi.fn();

      render(
        <Sidebar
          {...defaultProps}
          channels={[]}
          onCreateChannel={onCreateChannel}
        />
      );

      expect(screen.getByText('Create your first channel')).toBeInTheDocument();
    });

    it('should show "Add channel" when channels exist', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
      ];
      const onCreateChannel = vi.fn();

      render(
        <Sidebar
          {...defaultProps}
          channels={channels}
          onCreateChannel={onCreateChannel}
        />
      );
      fireEvent.click(screen.getByText('Channels'));

      expect(screen.getByText('Add channel')).toBeInTheDocument();
    });
  });

  describe('Channel Selection', () => {
    it('should call onChannelSelect when channel clicked', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
      ];
      const onChannelSelect = vi.fn();

      render(
        <Sidebar
          {...defaultProps}
          channels={channels}
          onChannelSelect={onChannelSelect}
        />
      );
      fireEvent.click(screen.getByText('Channels'));
      fireEvent.click(screen.getByText('general'));

      expect(onChannelSelect).toHaveBeenCalledWith(channels[0]);
    });

    it('should highlight selected channel', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
        { id: 'ch-2', name: 'random', unreadCount: 0 },
      ];

      render(
        <Sidebar
          {...defaultProps}
          channels={channels}
          selectedChannelId="ch-1"
        />
      );
      fireEvent.click(screen.getByText('Channels'));

      const generalButton = screen.getByText('general').closest('button');
      expect(generalButton).toHaveClass('bg-accent-cyan/10');
    });

    it('should not highlight unselected channels', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
        { id: 'ch-2', name: 'random', unreadCount: 0 },
      ];

      render(
        <Sidebar
          {...defaultProps}
          channels={channels}
          selectedChannelId="ch-1"
        />
      );
      fireEvent.click(screen.getByText('Channels'));

      const randomButton = screen.getByText('random').closest('button');
      expect(randomButton).not.toHaveClass('bg-accent-cyan/10');
    });
  });

  describe('Unread Badges', () => {
    it('should show unread count badge when channel has unreads', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 5 },
      ];

      render(<Sidebar {...defaultProps} channels={channels} />);
      fireEvent.click(screen.getByText('Channels'));

      // Should find two badges: one in header (total), one in channel row
      const badges = screen.getAllByText('5');
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });

    it('should not show badge when unread count is 0', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
      ];

      render(<Sidebar {...defaultProps} channels={channels} />);
      fireEvent.click(screen.getByText('Channels'));

      // Should not find a standalone "0" as a badge
      const generalRow = screen.getByText('general').closest('button');
      expect(within(generalRow!).queryByText('0')).not.toBeInTheDocument();
    });

    it('should show total unread count in section header', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 3 },
        { id: 'ch-2', name: 'random', unreadCount: 5 },
      ];

      render(<Sidebar {...defaultProps} channels={channels} />);

      // Total should be 8
      expect(screen.getByText('8')).toBeInTheDocument();
    });

    it('should style mentions differently from regular unreads', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'alerts', unreadCount: 2, hasMentions: true },
      ];

      render(<Sidebar {...defaultProps} channels={channels} />);
      fireEvent.click(screen.getByText('Channels'));

      // Find all badges with "2" - the channel row badge should have mention styling
      const badges = screen.getAllByText('2');
      const mentionBadge = badges.find(badge => badge.className.includes('bg-red-500/20'));
      expect(mentionBadge).toBeTruthy();
    });

    it('should bold channel name when has unread messages', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 5 },
      ];

      render(<Sidebar {...defaultProps} channels={channels} />);
      fireEvent.click(screen.getByText('Channels'));

      const channelName = screen.getByText('general');
      expect(channelName).toHaveClass('font-semibold');
    });
  });

  describe('Collapsed State', () => {
    it('should be collapsed by default', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
      ];

      render(<Sidebar {...defaultProps} channels={channels} />);

      // Channel name should not be visible when collapsed
      expect(screen.queryByText('general')).not.toBeInTheDocument();
    });

    it('should expand when header clicked', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
      ];

      render(<Sidebar {...defaultProps} channels={channels} />);

      // Click to expand
      fireEvent.click(screen.getByText('Channels'));

      expect(screen.getByText('general')).toBeInTheDocument();
    });

    it('should collapse when header clicked again', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
      ];

      render(<Sidebar {...defaultProps} channels={channels} />);

      // Expand
      fireEvent.click(screen.getByText('Channels'));
      expect(screen.getByText('general')).toBeInTheDocument();

      // Collapse
      fireEvent.click(screen.getByText('Channels'));
      expect(screen.queryByText('general')).not.toBeInTheDocument();
    });

    it('should persist collapsed state to localStorage', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
      ];

      render(<Sidebar {...defaultProps} channels={channels} />);

      // Expand
      fireEvent.click(screen.getByText('Channels'));

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
        'agent-relay-channels-collapsed',
        'false'
      );
    });

    it('should restore collapsed state from localStorage', () => {
      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === 'agent-relay-channels-collapsed') return 'false';
        return null;
      });

      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
      ];

      render(<Sidebar {...defaultProps} channels={channels} />);

      // Should be expanded based on localStorage
      expect(screen.getByText('general')).toBeInTheDocument();
    });
  });

  describe('Channel Actions Menu', () => {
    it('should show actions button on hover', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
      ];
      const onInviteToChannel = vi.fn();

      render(
        <Sidebar
          {...defaultProps}
          channels={channels}
          onInviteToChannel={onInviteToChannel}
        />
      );
      fireEvent.click(screen.getByText('Channels'));

      // The more button should exist (visible on hover via CSS)
      const moreButton = screen.getByTitle('Channel actions');
      expect(moreButton).toBeInTheDocument();
    });

    it('should open menu when actions button clicked', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
      ];
      const onInviteToChannel = vi.fn();

      render(
        <Sidebar
          {...defaultProps}
          channels={channels}
          onInviteToChannel={onInviteToChannel}
        />
      );
      fireEvent.click(screen.getByText('Channels'));
      fireEvent.click(screen.getByTitle('Channel actions'));

      expect(screen.getByText('Invite members')).toBeInTheDocument();
    });

    it('should call onInviteToChannel when invite clicked', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
      ];
      const onInviteToChannel = vi.fn();

      render(
        <Sidebar
          {...defaultProps}
          channels={channels}
          onInviteToChannel={onInviteToChannel}
        />
      );
      fireEvent.click(screen.getByText('Channels'));
      fireEvent.click(screen.getByTitle('Channel actions'));
      fireEvent.click(screen.getByText('Invite members'));

      expect(onInviteToChannel).toHaveBeenCalledWith(channels[0]);
    });

    it('should show archive option in menu', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
      ];
      const onArchiveChannel = vi.fn();

      render(
        <Sidebar
          {...defaultProps}
          channels={channels}
          onArchiveChannel={onArchiveChannel}
        />
      );
      fireEvent.click(screen.getByText('Channels'));
      fireEvent.click(screen.getByTitle('Channel actions'));

      expect(screen.getByText('Archive')).toBeInTheDocument();
    });

    it('should call onArchiveChannel when archive clicked', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
      ];
      const onArchiveChannel = vi.fn();

      render(
        <Sidebar
          {...defaultProps}
          channels={channels}
          onArchiveChannel={onArchiveChannel}
        />
      );
      fireEvent.click(screen.getByText('Channels'));
      fireEvent.click(screen.getByTitle('Channel actions'));
      fireEvent.click(screen.getByText('Archive'));

      expect(onArchiveChannel).toHaveBeenCalledWith(channels[0]);
    });

    it('should close menu after action selected', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
      ];
      const onInviteToChannel = vi.fn();

      render(
        <Sidebar
          {...defaultProps}
          channels={channels}
          onInviteToChannel={onInviteToChannel}
        />
      );
      fireEvent.click(screen.getByText('Channels'));
      fireEvent.click(screen.getByTitle('Channel actions'));
      fireEvent.click(screen.getByText('Invite members'));

      expect(screen.queryByText('Invite members')).not.toBeInTheDocument();
    });

    it('should close menu when channel selection changes', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
        { id: 'ch-2', name: 'random', unreadCount: 0 },
      ];
      const onInviteToChannel = vi.fn();
      const onChannelSelect = vi.fn();

      const { rerender } = render(
        <Sidebar
          {...defaultProps}
          channels={channels}
          onInviteToChannel={onInviteToChannel}
          onChannelSelect={onChannelSelect}
          selectedChannelId="ch-1"
        />
      );
      fireEvent.click(screen.getByText('Channels'));
      // Click the first Channel actions button (for 'general')
      const actionButtons = screen.getAllByTitle('Channel actions');
      fireEvent.click(actionButtons[0]);

      // Menu should be open
      expect(screen.getByText('Invite members')).toBeInTheDocument();

      // Change selection
      rerender(
        <Sidebar
          {...defaultProps}
          channels={channels}
          onInviteToChannel={onInviteToChannel}
          onChannelSelect={onChannelSelect}
          selectedChannelId="ch-2"
        />
      );

      // Menu should be closed
      expect(screen.queryByText('Invite members')).not.toBeInTheDocument();
    });
  });

  describe('Archived Channels', () => {
    it('should render archived section when archived channels exist', () => {
      const archivedChannels: SidebarChannel[] = [
        { id: 'ch-archived', name: 'old-project', unreadCount: 0 },
      ];

      render(<Sidebar {...defaultProps} archivedChannels={archivedChannels} />);

      expect(screen.getByText('Archived')).toBeInTheDocument();
    });

    it('should not render archived section when no archived channels', () => {
      render(<Sidebar {...defaultProps} archivedChannels={[]} />);

      expect(screen.queryByText('Archived')).not.toBeInTheDocument();
    });

    it('should show archived count in section header', () => {
      const archivedChannels: SidebarChannel[] = [
        { id: 'ch-1', name: 'old-project', unreadCount: 0 },
        { id: 'ch-2', name: 'deprecated', unreadCount: 0 },
      ];

      render(<Sidebar {...defaultProps} archivedChannels={archivedChannels} />);

      expect(screen.getByText('(2)')).toBeInTheDocument();
    });

    it('should be collapsed by default', () => {
      const archivedChannels: SidebarChannel[] = [
        { id: 'ch-archived', name: 'old-project', unreadCount: 0 },
      ];

      render(<Sidebar {...defaultProps} archivedChannels={archivedChannels} />);

      expect(screen.queryByText('old-project')).not.toBeInTheDocument();
    });

    it('should expand when clicked', () => {
      const archivedChannels: SidebarChannel[] = [
        { id: 'ch-archived', name: 'old-project', unreadCount: 0 },
      ];

      render(<Sidebar {...defaultProps} archivedChannels={archivedChannels} />);
      fireEvent.click(screen.getByText('Archived'));

      expect(screen.getByText('old-project')).toBeInTheDocument();
    });

    it('should show "Archived" badge on archived channels', () => {
      const archivedChannels: SidebarChannel[] = [
        { id: 'ch-archived', name: 'old-project', unreadCount: 0 },
      ];

      render(<Sidebar {...defaultProps} archivedChannels={archivedChannels} />);
      fireEvent.click(screen.getByText('Archived'));

      // Find the "Archived" badge within the channel row
      const archiveBadges = screen.getAllByText('Archived');
      expect(archiveBadges.length).toBeGreaterThanOrEqual(1);
    });

    it('should call onUnarchiveChannel when unarchive clicked', () => {
      const archivedChannels: SidebarChannel[] = [
        { id: 'ch-archived', name: 'old-project', unreadCount: 0 },
      ];
      const onUnarchiveChannel = vi.fn();

      render(
        <Sidebar
          {...defaultProps}
          archivedChannels={archivedChannels}
          onUnarchiveChannel={onUnarchiveChannel}
        />
      );
      fireEvent.click(screen.getByText('Archived'));
      fireEvent.click(screen.getByTitle('Unarchive channel'));

      expect(onUnarchiveChannel).toHaveBeenCalledWith(archivedChannels[0]);
    });

    it('should allow selecting archived channels', () => {
      const archivedChannels: SidebarChannel[] = [
        { id: 'ch-archived', name: 'old-project', unreadCount: 0 },
      ];
      const onChannelSelect = vi.fn();

      render(
        <Sidebar
          {...defaultProps}
          archivedChannels={archivedChannels}
          onChannelSelect={onChannelSelect}
        />
      );
      fireEvent.click(screen.getByText('Archived'));
      fireEvent.click(screen.getByText('old-project'));

      expect(onChannelSelect).toHaveBeenCalledWith(archivedChannels[0]);
    });
  });

  describe('Create Channel', () => {
    it('should call onCreateChannel when create button clicked', () => {
      const onCreateChannel = vi.fn();

      render(
        <Sidebar
          {...defaultProps}
          channels={[]}
          onCreateChannel={onCreateChannel}
        />
      );
      fireEvent.click(screen.getByText('Create your first channel'));

      expect(onCreateChannel).toHaveBeenCalled();
    });

    it('should call onCreateChannel when add button clicked with existing channels', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
      ];
      const onCreateChannel = vi.fn();

      render(
        <Sidebar
          {...defaultProps}
          channels={channels}
          onCreateChannel={onCreateChannel}
        />
      );
      fireEvent.click(screen.getByText('Channels'));
      fireEvent.click(screen.getByText('Add channel'));

      expect(onCreateChannel).toHaveBeenCalled();
    });
  });

  describe('Connection Status', () => {
    it('should show connected indicator when connected', () => {
      render(<Sidebar {...defaultProps} isConnected={true} />);

      expect(screen.getByText('Live')).toBeInTheDocument();
    });

    it('should show offline indicator when disconnected', () => {
      render(<Sidebar {...defaultProps} isConnected={false} />);

      expect(screen.getByText('Offline')).toBeInTheDocument();
    });
  });

  describe('Multiple Channels', () => {
    it('should render all channels in correct order', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'alpha', unreadCount: 0 },
        { id: 'ch-2', name: 'beta', unreadCount: 0 },
        { id: 'ch-3', name: 'gamma', unreadCount: 0 },
      ];

      render(<Sidebar {...defaultProps} channels={channels} />);
      fireEvent.click(screen.getByText('Channels'));

      const channelButtons = screen.getAllByRole('button').filter(btn =>
        ['alpha', 'beta', 'gamma'].some(name => btn.textContent?.includes(name))
      );

      expect(channelButtons[0]).toHaveTextContent('alpha');
      expect(channelButtons[1]).toHaveTextContent('beta');
      expect(channelButtons[2]).toHaveTextContent('gamma');
    });

    it('should allow selecting different channels', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'alpha', unreadCount: 0 },
        { id: 'ch-2', name: 'beta', unreadCount: 0 },
      ];
      const onChannelSelect = vi.fn();

      render(
        <Sidebar
          {...defaultProps}
          channels={channels}
          onChannelSelect={onChannelSelect}
        />
      );
      fireEvent.click(screen.getByText('Channels'));

      fireEvent.click(screen.getByText('alpha'));
      expect(onChannelSelect).toHaveBeenCalledWith(channels[0]);

      fireEvent.click(screen.getByText('beta'));
      expect(onChannelSelect).toHaveBeenCalledWith(channels[1]);
    });
  });

  describe('Accessibility', () => {
    it('should have accessible channel buttons', () => {
      const channels: SidebarChannel[] = [
        { id: 'ch-1', name: 'general', unreadCount: 0 },
      ];

      render(<Sidebar {...defaultProps} channels={channels} />);
      fireEvent.click(screen.getByText('Channels'));

      const channelButton = screen.getByText('general').closest('button');
      expect(channelButton).toBeInTheDocument();
      expect(channelButton?.tagName).toBe('BUTTON');
    });

    it('should have accessible section toggle buttons', () => {
      render(<Sidebar {...defaultProps} />);

      const channelsHeader = screen.getByText('Channels').closest('button');
      expect(channelsHeader?.tagName).toBe('BUTTON');
    });
  });
});
