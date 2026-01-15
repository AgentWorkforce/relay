import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { Sidebar, type SidebarProps, type SidebarChannel } from './Sidebar';

function getButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll('button'));
  return (buttons.find((btn) => btn.textContent?.includes(text)) ?? null) as HTMLButtonElement | null;
}

describe('Sidebar channel archive controls', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const baseChannels: SidebarChannel[] = [
    { id: '#alpha', name: 'alpha', unreadCount: 0 },
  ];

  const baseArchived: SidebarChannel[] = [
    { id: '#archived', name: 'archived', unreadCount: 0 },
  ];

  const baseProps: SidebarProps = {
    agents: [],
    bridgeAgents: [],
    projects: [],
    viewMode: 'channels',
    isFleetAvailable: false,
    isConnected: true,
    channels: baseChannels,
    archivedChannels: baseArchived,
    onChannelSelect: vi.fn(),
    onCreateChannel: vi.fn(),
    onInviteToChannel: vi.fn(),
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    localStorage.clear();
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container.remove();
  });

  const renderSidebar = (props: Partial<SidebarProps> = {}) => {
    const merged = { ...baseProps, ...props };
    act(() => {
      root = createRoot(container);
      root.render(<Sidebar {...merged} />);
    });
    return merged;
  };

  it('invokes onArchiveChannel from the channel actions menu', () => {
    const onArchiveChannel = vi.fn();
    renderSidebar({ onArchiveChannel });

    act(() => {
      getButtonByText(container, 'Channels')?.click();
    });

    const actionsButton = container.querySelector('[title="Channel actions"]') as HTMLButtonElement | null;
    expect(actionsButton).toBeTruthy();

    act(() => {
      actionsButton?.click();
    });

    const archiveButton = getButtonByText(container, 'Archive');
    expect(archiveButton).toBeTruthy();

    act(() => {
      archiveButton?.click();
    });

    expect(onArchiveChannel).toHaveBeenCalledWith(expect.objectContaining({ id: '#alpha' }));
  });

  it('shows archived channels and unarchives via callback', () => {
    const onUnarchiveChannel = vi.fn();
    renderSidebar({ onUnarchiveChannel });

    act(() => {
      getButtonByText(container, 'Channels')?.click();
      getButtonByText(container, 'Archived')?.click();
    });

    const unarchiveButton = getButtonByText(container, 'Unarchive');
    expect(unarchiveButton).toBeTruthy();

    act(() => {
      unarchiveButton?.click();
    });

    expect(onUnarchiveChannel).toHaveBeenCalledWith(expect.objectContaining({ id: '#archived' }));
  });
});
