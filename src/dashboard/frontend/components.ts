/**
 * Dashboard UI Components
 */

import type { Agent, Message, DOMElements, ChannelType } from './types.js';
import { state, getFilteredMessages, setCurrentChannel, setCurrentThread, getThreadMessages, getThreadReplyCount } from './state.js';
import {
  escapeHtml,
  formatTime,
  formatDate,
  getAvatarColor,
  getInitials,
  formatMessageBody,
  isAgentOnline,
} from './utils.js';

let elements: DOMElements;
let paletteSelectedIndex = -1;

/**
 * Initialize DOM element references
 */
export function initElements(): DOMElements {
  elements = {
    connectionDot: document.getElementById('connection-dot')!,
    channelsList: document.getElementById('channels-list')!,
    agentsList: document.getElementById('agents-list')!,
    messagesList: document.getElementById('messages-list')!,
    currentChannelName: document.getElementById('current-channel-name')!,
    channelTopic: document.getElementById('channel-topic')!,
    onlineCount: document.getElementById('online-count')!,
    messageInput: document.getElementById('message-input') as HTMLTextAreaElement,
    sendBtn: document.getElementById('send-btn') as HTMLButtonElement,
    boldBtn: document.getElementById('bold-btn') as HTMLButtonElement,
    emojiBtn: document.getElementById('emoji-btn') as HTMLButtonElement,
    searchTrigger: document.getElementById('search-trigger')!,
    commandPaletteOverlay: document.getElementById('command-palette-overlay')!,
    paletteSearch: document.getElementById('palette-search') as HTMLInputElement,
    paletteResults: document.getElementById('palette-results')!,
    paletteChannelsSection: document.getElementById('palette-channels-section')!,
    paletteAgentsSection: document.getElementById('palette-agents-section')!,
    paletteMessagesSection: document.getElementById('palette-messages-section')!,
    typingIndicator: document.getElementById('typing-indicator')!,
    threadPanelOverlay: document.getElementById('thread-panel-overlay')!,
    threadPanelId: document.getElementById('thread-panel-id')!,
    threadPanelClose: document.getElementById('thread-panel-close') as HTMLButtonElement,
    threadMessages: document.getElementById('thread-messages')!,
    threadMessageInput: document.getElementById('thread-message-input') as HTMLTextAreaElement,
    threadSendBtn: document.getElementById('thread-send-btn') as HTMLButtonElement,
    mentionAutocomplete: document.getElementById('mention-autocomplete')!,
    mentionAutocompleteList: document.getElementById('mention-autocomplete-list')!,
    // Spawn modal elements
    spawnAgentBtn: document.getElementById('spawn-agent-btn') as HTMLButtonElement,
    spawnModalOverlay: document.getElementById('spawn-modal-overlay')!,
    spawnModalClose: document.getElementById('spawn-modal-close') as HTMLButtonElement,
    spawnAgentName: document.getElementById('spawn-agent-name') as HTMLInputElement,
    spawnAgentCli: document.getElementById('spawn-agent-cli') as HTMLSelectElement,
    spawnAgentModel: document.getElementById('spawn-agent-model') as HTMLInputElement,
    spawnAgentTask: document.getElementById('spawn-agent-task') as HTMLTextAreaElement,
    spawnModalCancel: document.getElementById('spawn-modal-cancel') as HTMLButtonElement,
    spawnModalSubmit: document.getElementById('spawn-modal-submit') as HTMLButtonElement,
  };
  return elements;
}

/**
 * Get DOM elements
 */
export function getElements(): DOMElements {
  return elements;
}

/**
 * Update connection status indicator
 */
export function updateConnectionStatus(): void {
  if (state.isConnected) {
    elements.connectionDot.classList.remove('offline');
  } else {
    elements.connectionDot.classList.add('offline');
  }
}

/**
 * Render agents list in sidebar
 */
export function renderAgents(): void {
  console.log('[UI] renderAgents called, agents:', state.agents.length, state.agents.map(a => a.name));
  const html = state.agents
    .map((agent) => {
      const online = isAgentOnline(agent.lastSeen || agent.lastActive);
      const presenceClass = online ? 'online' : '';
      const isActive = state.currentChannel === agent.name;
      const needsAttentionClass = agent.needsAttention ? 'needs-attention' : '';

      return `
      <li class="channel-item ${isActive ? 'active' : ''} ${needsAttentionClass}" data-agent="${escapeHtml(agent.name)}">
        <div class="agent-avatar" style="background: ${getAvatarColor(agent.name)}">
          ${getInitials(agent.name)}
          <span class="presence-indicator ${presenceClass}"></span>
        </div>
        <span class="channel-name">${escapeHtml(agent.name)}</span>
        ${agent.needsAttention ? '<span class="attention-badge">Needs Input</span>' : ''}
        <div class="agent-actions">
          <button class="agent-action-btn kill-btn agent-kill-btn" data-agent="${escapeHtml(agent.name)}" title="Kill agent">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </li>
    `;
    })
    .join('');

  elements.agentsList.innerHTML =
    html ||
    '<li class="channel-item" style="color: var(--text-muted); cursor: default;">No agents connected</li>';

  // Add click handlers
  elements.agentsList.querySelectorAll<HTMLElement>('.channel-item[data-agent]').forEach((item) => {
    item.addEventListener('click', (e) => {
      // Don't navigate if clicking on action buttons
      if ((e.target as HTMLElement).closest('.agent-actions')) {
        return;
      }
      const agentName = item.dataset.agent;
      if (agentName) {
        selectChannel(agentName);
      }
    });
  });

  // Update command palette agents
  updatePaletteAgents();

  // Attach kill handlers (dynamically imported to avoid circular dependency)
  import('./app.js').then(({ attachKillHandlers }) => {
    attachKillHandlers();
  }).catch(() => {
    // Ignore if app.js not yet ready
  });
}

/**
 * Render messages list
 */
export function renderMessages(): void {
  const filtered = getFilteredMessages();

  if (filtered.length === 0) {
    elements.messagesList.innerHTML = `
      <div class="empty-state">
        <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <div class="empty-state-title">No messages yet</div>
        <div class="empty-state-text">
          ${
            state.currentChannel === 'general'
              ? 'Messages between agents will appear here'
              : `Messages with ${state.currentChannel} will appear here`
          }
        </div>
      </div>
    `;
    return;
  }

  let html = '';
  let lastDate: string | null = null;

  filtered.forEach((msg) => {
    const msgDate = new Date(msg.timestamp).toDateString();

    // Add date divider if needed
    if (msgDate !== lastDate) {
      html += `
        <div class="date-divider">
          <span class="date-divider-text">${formatDate(msg.timestamp)}</span>
        </div>
      `;
      lastDate = msgDate;
    }

    const isBroadcast = msg.to === '*';
    const avatarColor = getAvatarColor(msg.from);
    const replyCount = getThreadReplyCount(msg.id);

    // Format: @From → @To: message (like Slack)
    // For cross-project messages, show project badge before agent name
    const recipientDisplay = isBroadcast
      ? '@everyone'
      : msg.project
        ? `<span class="project-badge">${escapeHtml(msg.project)}</span>@${escapeHtml(msg.to)}`
        : `@${escapeHtml(msg.to)}`;

    html += `
      <div class="message ${isBroadcast ? 'broadcast' : ''}" data-id="${escapeHtml(msg.id)}">
        <div class="message-avatar" style="background: ${avatarColor}">
          ${getInitials(msg.from)}
        </div>
        <div class="message-content">
          <div class="message-header">
            <span class="message-sender">@${escapeHtml(msg.from)}</span>
            <span class="message-recipient">
              → <span class="target">${recipientDisplay}</span>
            </span>
            <span class="message-timestamp">${formatTime(msg.timestamp)}</span>
          </div>
          <div class="message-body">${formatMessageBody(msg.content)}</div>
          ${
            msg.thread
              ? `
            <div class="thread-indicator" data-thread="${escapeHtml(msg.thread)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              Thread: ${escapeHtml(msg.thread)}
            </div>
          `
              : ''
          }
          ${
            replyCount > 0
              ? `
            <div class="reply-count-badge" data-thread="${escapeHtml(msg.id)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}
            </div>
          `
              : ''
          }
        </div>
        <div class="message-actions">
          <button class="message-action-btn" data-action="reply" title="Reply in thread">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
          <button class="message-action-btn" title="Add reaction">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
              <line x1="9" y1="9" x2="9.01" y2="9"/>
              <line x1="15" y1="9" x2="15.01" y2="9"/>
            </svg>
          </button>
        </div>
      </div>
    `;
  });

  elements.messagesList.innerHTML = html;

  // Note: Auto-scroll removed - interferes with manual scrolling through history

  // Attach thread click handlers
  attachThreadHandlers();
}

/**
 * Select a channel and update UI
 */
export function selectChannel(channel: ChannelType): void {
  setCurrentChannel(channel);

  // Update sidebar active states
  elements.channelsList.querySelectorAll<HTMLElement>('.channel-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.channel === channel);
  });
  elements.agentsList.querySelectorAll<HTMLElement>('.channel-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.agent === channel);
  });

  // Update header
  const prefixEl = document.querySelector('.channel-header-name .prefix');
  if (channel === 'general') {
    elements.currentChannelName.innerHTML = 'general';
    elements.channelTopic.textContent = 'All agent communications';
    if (prefixEl) prefixEl.textContent = '#';
  } else {
    elements.currentChannelName.innerHTML = escapeHtml(channel);
    const agent = state.agents.find((a) => a.name === channel);
    elements.channelTopic.textContent = agent?.status || 'Direct messages';
    if (prefixEl) prefixEl.textContent = '@';
  }

  // Update composer placeholder with @mention format
  elements.messageInput.placeholder =
    channel === 'general'
      ? '@AgentName message... (or @* to broadcast)'
      : `@${channel} your message here...`;

  // Re-render messages
  renderMessages();
}

/**
 * Update online count display
 */
export function updateOnlineCount(): void {
  const online = state.agents.filter((a) => isAgentOnline(a.lastSeen || a.lastActive)).length;
  elements.onlineCount.textContent = `${online} online`;
}

/**
 * Update agents in command palette
 */
export function updatePaletteAgents(): void {
  const html = state.agents
    .map((agent) => {
      const online = isAgentOnline(agent.lastSeen || agent.lastActive);
      return `
      <div class="palette-item" data-jump-agent="${escapeHtml(agent.name)}">
        <div class="palette-item-icon">
          <div class="agent-avatar" style="background: ${getAvatarColor(agent.name)}; width: 20px; height: 20px; font-size: 9px;">
            ${getInitials(agent.name)}
            <span class="presence-indicator ${online ? 'online' : ''}"></span>
          </div>
        </div>
        <div class="palette-item-content">
          <div class="palette-item-title">${escapeHtml(agent.name)}</div>
          <div class="palette-item-subtitle">${online ? 'Online' : 'Offline'}</div>
        </div>
      </div>
    `;
    })
    .join('');

  const section = elements.paletteAgentsSection;
  const items = section.querySelectorAll('.palette-item');
  items.forEach((item) => item.remove());
  section.insertAdjacentHTML('beforeend', html);

  // Add click handlers
  section.querySelectorAll<HTMLElement>('.palette-item[data-jump-agent]').forEach((item) => {
    item.addEventListener('click', () => {
      const agentName = item.dataset.jumpAgent;
      if (agentName) {
        selectChannel(agentName);
        closeCommandPalette();
      }
    });
  });
}

/**
 * Initialize channel click handlers in command palette
 */
export function initPaletteChannels(): void {
  elements.paletteChannelsSection
    .querySelectorAll<HTMLElement>('.palette-item[data-jump-channel]')
    .forEach((item) => {
      item.addEventListener('click', () => {
        const channelName = item.dataset.jumpChannel;
        if (channelName) {
          selectChannel(channelName);
          closeCommandPalette();
        }
      });
    });
}

/**
 * Open command palette
 */
export function openCommandPalette(): void {
  elements.commandPaletteOverlay.classList.add('visible');
  elements.paletteSearch.value = '';
  elements.paletteSearch.focus();
  paletteSelectedIndex = -1;
  filterPaletteResults('');
}

/**
 * Get all visible palette items
 */
export function getVisiblePaletteItems(): HTMLElement[] {
  const allItems = Array.from(
    elements.paletteResults.querySelectorAll<HTMLElement>('.palette-item')
  );
  return allItems.filter((item) => item.style.display !== 'none');
}

/**
 * Update the selected palette item visually
 */
export function updatePaletteSelection(): void {
  const items = getVisiblePaletteItems();

  // Remove selection from all items
  items.forEach((item) => item.classList.remove('selected'));

  // Add selection to current item
  if (paletteSelectedIndex >= 0 && paletteSelectedIndex < items.length) {
    const selectedItem = items[paletteSelectedIndex];
    selectedItem.classList.add('selected');

    // Scroll into view if needed
    selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/**
 * Handle keyboard navigation in command palette
 */
export function handlePaletteKeydown(e: KeyboardEvent): void {
  const items = getVisiblePaletteItems();

  if (items.length === 0) return;

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      paletteSelectedIndex = paletteSelectedIndex < items.length - 1
        ? paletteSelectedIndex + 1
        : 0;
      updatePaletteSelection();
      break;

    case 'ArrowUp':
      e.preventDefault();
      paletteSelectedIndex = paletteSelectedIndex > 0
        ? paletteSelectedIndex - 1
        : items.length - 1;
      updatePaletteSelection();
      break;

    case 'Enter':
      e.preventDefault();
      if (paletteSelectedIndex >= 0 && paletteSelectedIndex < items.length) {
        executePaletteItem(items[paletteSelectedIndex]);
      }
      break;
  }
}

/**
 * Execute the action for a palette item
 */
export function executePaletteItem(item: HTMLElement): void {
  // Check for command
  const command = item.dataset.command;
  if (command) {
    if (command === 'broadcast') {
      // Pre-fill message input with @* for broadcast
      elements.messageInput.value = '@* ';
      elements.messageInput.focus();
    } else if (command === 'clear') {
      elements.messagesList.innerHTML = '';
    }
    closeCommandPalette();
    return;
  }

  // Check for channel jump
  const channel = item.dataset.jumpChannel;
  if (channel) {
    selectChannel(channel);
    closeCommandPalette();
    return;
  }

  // Check for agent jump
  const agent = item.dataset.jumpAgent;
  if (agent) {
    selectChannel(agent);
    closeCommandPalette();
    return;
  }

  // Check for message jump
  const messageId = item.dataset.jumpMessage;
  if (messageId) {
    // Find and scroll to the message
    const messageEl = elements.messagesList.querySelector(`[data-id="${messageId}"]`);
    if (messageEl) {
      messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      messageEl.classList.add('highlighted');
      setTimeout(() => messageEl.classList.remove('highlighted'), 2000);
    }
    closeCommandPalette();
    return;
  }
}

/**
 * Close command palette
 */
export function closeCommandPalette(): void {
  elements.commandPaletteOverlay.classList.remove('visible');
}

/**
 * Filter command palette results based on query
 */
export function filterPaletteResults(query: string): void {
  const q = query.toLowerCase();

  // Reset selection when filtering
  paletteSelectedIndex = -1;

  // Filter command items
  document.querySelectorAll<HTMLElement>('.palette-item[data-command]').forEach((item) => {
    const titleEl = item.querySelector('.palette-item-title');
    const title = titleEl?.textContent?.toLowerCase() || '';
    item.style.display = title.includes(q) ? 'flex' : 'none';
  });

  // Filter channel items
  document.querySelectorAll<HTMLElement>('.palette-item[data-jump-channel]').forEach((item) => {
    const titleEl = item.querySelector('.palette-item-title');
    const title = titleEl?.textContent?.toLowerCase() || '';
    item.style.display = title.includes(q) ? 'flex' : 'none';
  });

  // Filter agent items
  document.querySelectorAll<HTMLElement>('.palette-item[data-jump-agent]').forEach((item) => {
    const name = item.dataset.jumpAgent?.toLowerCase() || '';
    item.style.display = name.includes(q) ? 'flex' : 'none';
  });

  // Show message search if query is long enough
  if (q.length >= 2) {
    const matches = state.messages.filter((m) => m.content.toLowerCase().includes(q)).slice(0, 5);

    if (matches.length > 0) {
      elements.paletteMessagesSection.style.display = 'block';
      const items = matches
        .map(
          (m) => `
        <div class="palette-item" data-jump-message="${escapeHtml(m.id)}">
          <div class="palette-item-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <div class="palette-item-content">
            <div class="palette-item-title">${escapeHtml(m.from)}</div>
            <div class="palette-item-subtitle">${escapeHtml(m.content.substring(0, 60))}${m.content.length > 60 ? '...' : ''}</div>
          </div>
        </div>
      `
        )
        .join('');

      const existingItems = elements.paletteMessagesSection.querySelectorAll('.palette-item');
      existingItems.forEach((item) => item.remove());
      elements.paletteMessagesSection.insertAdjacentHTML('beforeend', items);
    } else {
      elements.paletteMessagesSection.style.display = 'none';
    }
  } else {
    elements.paletteMessagesSection.style.display = 'none';
  }
}

/**
 * Open thread panel for a specific thread
 */
export function openThreadPanel(threadId: string): void {
  setCurrentThread(threadId);
  elements.threadPanelId.textContent = threadId;
  elements.threadPanelOverlay.classList.add('visible');
  elements.threadMessageInput.value = '';
  renderThreadMessages(threadId);
  elements.threadMessageInput.focus();
}

/**
 * Close thread panel
 */
export function closeThreadPanel(): void {
  setCurrentThread(null);
  elements.threadPanelOverlay.classList.remove('visible');
}

/**
 * Render messages in thread panel
 */
export function renderThreadMessages(threadId: string): void {
  const messages = getThreadMessages(threadId);

  if (messages.length === 0) {
    elements.threadMessages.innerHTML = `
      <div class="thread-empty">
        <p>No messages in this thread yet.</p>
        <p style="font-size: 12px; margin-top: 8px;">Start the conversation below!</p>
      </div>
    `;
    return;
  }

  const html = messages
    .map((msg) => `
      <div class="thread-message">
        <div class="thread-message-header">
          <div class="thread-message-avatar" style="background: ${getAvatarColor(msg.from)}">
            ${getInitials(msg.from)}
          </div>
          <span class="thread-message-sender">${escapeHtml(msg.from)}</span>
          <span class="thread-message-time">${formatTime(msg.timestamp)}</span>
        </div>
        <div class="thread-message-body">${formatMessageBody(msg.content)}</div>
      </div>
    `)
    .join('');

  elements.threadMessages.innerHTML = html;

  // Scroll to bottom
  elements.threadMessages.scrollTop = elements.threadMessages.scrollHeight;
}

/**
 * Attach thread click handlers to messages (call after renderMessages)
 */
export function attachThreadHandlers(): void {
  // Thread indicator clicks
  elements.messagesList.querySelectorAll<HTMLElement>('.thread-indicator').forEach((el) => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const threadId = el.dataset.thread;
      if (threadId) {
        openThreadPanel(threadId);
      }
    });
  });

  // Reply count badge clicks
  elements.messagesList.querySelectorAll<HTMLElement>('.reply-count-badge').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const threadId = el.dataset.thread;
      if (threadId) {
        openThreadPanel(threadId);
      }
    });
  });

  // Reply in thread button clicks
  elements.messagesList.querySelectorAll<HTMLElement>('.message-action-btn[data-action="reply"]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const messageId = el.closest('.message')?.getAttribute('data-id');
      if (messageId) {
        // Use message ID as thread ID for new threads
        openThreadPanel(messageId);
      }
    });
  });
}

/**
 * @-Mention Autocomplete State
 */
let mentionSelectedIndex = 0;
let mentionFilteredAgents: typeof state.agents = [];

/**
 * Show mention autocomplete dropdown with filtered agents
 */
export function showMentionAutocomplete(filter: string): void {
  const filterLower = filter.toLowerCase();

  // Filter agents by name, include broadcast option
  mentionFilteredAgents = state.agents.filter(agent =>
    agent.name.toLowerCase().includes(filterLower)
  );

  // Reset selection
  mentionSelectedIndex = 0;

  // Build HTML for agent list
  let html = '';

  // Add broadcast option if filter matches
  if ('*'.includes(filterLower) || 'everyone'.includes(filterLower) || 'all'.includes(filterLower) || 'broadcast'.includes(filterLower)) {
    html += `
      <div class="mention-autocomplete-item ${mentionSelectedIndex === 0 && mentionFilteredAgents.length === 0 ? 'selected' : ''}" data-mention="*">
        <div class="agent-avatar" style="background: var(--accent-yellow);">*</div>
        <span class="mention-autocomplete-name">@everyone</span>
        <span class="mention-autocomplete-role">Broadcast to all</span>
      </div>
    `;
  }

  // Add agents
  mentionFilteredAgents.forEach((agent, index) => {
    const isSelected = index === mentionSelectedIndex;
    html += `
      <div class="mention-autocomplete-item ${isSelected ? 'selected' : ''}" data-mention="${escapeHtml(agent.name)}">
        <div class="agent-avatar" style="background: ${getAvatarColor(agent.name)}">
          ${getInitials(agent.name)}
        </div>
        <span class="mention-autocomplete-name">@${escapeHtml(agent.name)}</span>
        <span class="mention-autocomplete-role">${escapeHtml(agent.role || 'Agent')}</span>
      </div>
    `;
  });

  if (html === '') {
    html = '<div class="mention-autocomplete-item" style="color: var(--text-muted); cursor: default;">No matching agents</div>';
  }

  elements.mentionAutocompleteList.innerHTML = html;
  elements.mentionAutocomplete.classList.add('visible');

  // Add click handlers to items
  elements.mentionAutocompleteList.querySelectorAll<HTMLElement>('.mention-autocomplete-item[data-mention]').forEach((item) => {
    item.addEventListener('click', () => {
      const mention = item.dataset.mention;
      if (mention) {
        completeMention(mention);
      }
    });
  });
}

/**
 * Hide mention autocomplete dropdown
 */
export function hideMentionAutocomplete(): void {
  elements.mentionAutocomplete.classList.remove('visible');
  mentionFilteredAgents = [];
  mentionSelectedIndex = 0;
}

/**
 * Check if mention autocomplete is visible
 */
export function isMentionAutocompleteVisible(): boolean {
  return elements.mentionAutocomplete.classList.contains('visible');
}

/**
 * Navigate mention autocomplete selection
 */
export function navigateMentionAutocomplete(direction: 'up' | 'down'): void {
  const items = elements.mentionAutocompleteList.querySelectorAll<HTMLElement>('.mention-autocomplete-item[data-mention]');
  if (items.length === 0) return;

  // Remove current selection
  items[mentionSelectedIndex]?.classList.remove('selected');

  // Update index
  if (direction === 'down') {
    mentionSelectedIndex = (mentionSelectedIndex + 1) % items.length;
  } else {
    mentionSelectedIndex = (mentionSelectedIndex - 1 + items.length) % items.length;
  }

  // Add new selection
  items[mentionSelectedIndex]?.classList.add('selected');
  items[mentionSelectedIndex]?.scrollIntoView({ block: 'nearest' });
}

/**
 * Complete the current mention selection
 */
export function completeMention(mention?: string): void {
  const items = elements.mentionAutocompleteList.querySelectorAll<HTMLElement>('.mention-autocomplete-item[data-mention]');

  // Use provided mention or get from selected item
  let selectedMention = mention;
  if (!selectedMention && items.length > 0) {
    selectedMention = items[mentionSelectedIndex]?.dataset.mention;
  }

  if (!selectedMention) {
    hideMentionAutocomplete();
    return;
  }

  // Replace the @... text with the completed mention
  const input = elements.messageInput;
  const value = input.value;

  // Find the @ position (should be at start or after whitespace)
  const atMatch = value.match(/^@\S*/);
  if (atMatch) {
    // Replace the @partial with @CompletedName
    const completedText = `@${selectedMention} `;
    input.value = completedText + value.substring(atMatch[0].length);
    input.selectionStart = input.selectionEnd = completedText.length;
  }

  hideMentionAutocomplete();
  input.focus();
}

/**
 * Get the current @mention being typed (if any)
 */
export function getCurrentMentionQuery(): string | null {
  const input = elements.messageInput;
  const value = input.value;
  const cursorPos = input.selectionStart;

  // Check if cursor is within an @mention at the start
  const atMatch = value.match(/^@(\S*)/);
  if (atMatch && cursorPos <= atMatch[0].length) {
    return atMatch[1]; // Return the text after @
  }

  return null;
}

// Track spawned agents
let spawnedAgents: string[] = [];

/**
 * Open the spawn agent modal
 */
export function openSpawnModal(): void {
  elements.spawnModalOverlay.classList.add('visible');
  elements.spawnAgentName.value = '';
  elements.spawnAgentCli.value = 'claude';
  elements.spawnAgentModel.value = '';
  elements.spawnAgentTask.value = '';
  elements.spawnAgentName.focus();
}

/**
 * Close the spawn agent modal
 */
export function closeSpawnModal(): void {
  elements.spawnModalOverlay.classList.remove('visible');
}

/**
 * Spawn a new agent via the API
 */
export async function spawnAgent(): Promise<{ success: boolean; error?: string }> {
  const name = elements.spawnAgentName.value.trim();
  const cli = elements.spawnAgentCli.value || 'claude';
  const model = elements.spawnAgentModel.value.trim();
  const task = elements.spawnAgentTask.value.trim();

  if (!name) {
    return { success: false, error: 'Agent name is required' };
  }

  elements.spawnModalSubmit.disabled = true;

  try {
    const response = await fetch('/api/spawn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, cli, model, task }),
    });

    const result = await response.json();

    if (response.ok && result.success) {
      // Refresh spawned agents list
      await fetchSpawnedAgents();

      // Close modal after brief delay
      setTimeout(() => {
        closeSpawnModal();
      }, 500);

      return { success: true };
    } else {
      throw new Error(result.error || 'Failed to spawn agent');
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  } finally {
    elements.spawnModalSubmit.disabled = false;
  }
}

/**
 * Fetch list of spawned agents from API
 */
export async function fetchSpawnedAgents(): Promise<void> {
  try {
    const response = await fetch('/api/spawned');
    const result = await response.json();

    if (result.success && Array.isArray(result.agents)) {
      spawnedAgents = result.agents.map((a: any) => a.name);
      // Re-render agents to show spawned status
      renderAgents();
    }
  } catch (err) {
    console.error('[UI] Failed to fetch spawned agents:', err);
  }
}

/**
 * Check if an agent is spawned
 */
export function isSpawnedAgent(name: string): boolean {
  return spawnedAgents.includes(name);
}
