/**
 * Dashboard Application Entry Point
 */

import { subscribe, state } from './state.js';
import { connect, sendMessage } from './websocket.js';
import {
  initElements,
  getElements,
  updateConnectionStatus,
  renderAgents,
  renderMessages,
  selectChannel,
  updateOnlineCount,
  openCommandPalette,
  closeCommandPalette,
  filterPaletteResults,
  handlePaletteKeydown,
  initPaletteChannels,
  closeThreadPanel,
  renderThreadMessages,
  showMentionAutocomplete,
  hideMentionAutocomplete,
  isMentionAutocompleteVisible,
  navigateMentionAutocomplete,
  completeMention,
  getCurrentMentionQuery,
  openSpawnModal,
  closeSpawnModal,
  spawnAgent,
  fetchSpawnedAgents,
} from './components.js';
import { state } from './state.js';

/**
 * Initialize the dashboard application
 */
export function initApp(): void {
  const elements = initElements();

  // Subscribe to state changes
  subscribe(() => {
    updateConnectionStatus();
    renderAgents();
    renderMessages();
    updateOnlineCount();
  });

  // Set up event listeners
  setupEventListeners(elements);

  // Connect to WebSocket
  connect();

  // Fetch initial spawned agents list
  fetchSpawnedAgents();
}

/**
 * Set up all event listeners
 */
function setupEventListeners(elements: ReturnType<typeof getElements>): void {
  // Channel clicks
  elements.channelsList.querySelectorAll<HTMLElement>('.channel-item').forEach((item) => {
    item.addEventListener('click', () => {
      const channel = item.dataset.channel;
      if (channel) {
        selectChannel(channel);
      }
    });
  });

  // Send button
  elements.sendBtn.addEventListener('click', handleSend);

  // Keyboard shortcuts for composer
  elements.messageInput.addEventListener('keydown', (e: KeyboardEvent) => {
    // Handle mention autocomplete keys first
    if (isMentionAutocompleteVisible()) {
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        completeMention();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        navigateMentionAutocomplete('up');
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        navigateMentionAutocomplete('down');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideMentionAutocomplete();
        return;
      }
    }

    // Enter to send (Slack-style), Shift+Enter for newline
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    // Shift+Enter allows default behavior (inserts newline)
  });

  // Auto-resize textarea and handle @-mention autocomplete
  elements.messageInput.addEventListener('input', () => {
    elements.messageInput.style.height = 'auto';
    elements.messageInput.style.height =
      Math.min(elements.messageInput.scrollHeight, 200) + 'px';

    // Check for @-mention at start of input
    const query = getCurrentMentionQuery();
    if (query !== null) {
      showMentionAutocomplete(query);
    } else {
      hideMentionAutocomplete();
    }
  });

  // Hide mention autocomplete when input loses focus (with delay to allow clicks)
  elements.messageInput.addEventListener('blur', () => {
    setTimeout(() => {
      hideMentionAutocomplete();
    }, 150);
  });

  // Bold button - wrap selected text with ** or insert **bold**
  elements.boldBtn.addEventListener('click', () => {
    const input = elements.messageInput;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const text = input.value;

    if (start === end) {
      // No selection - insert **bold** placeholder
      const before = text.substring(0, start);
      const after = text.substring(end);
      input.value = before + '**bold**' + after;
      input.selectionStart = start + 2;
      input.selectionEnd = start + 6;
    } else {
      // Wrap selection with **
      const before = text.substring(0, start);
      const selected = text.substring(start, end);
      const after = text.substring(end);
      input.value = before + '**' + selected + '**' + after;
      input.selectionStart = start;
      input.selectionEnd = end + 4;
    }
    input.focus();
  });

  // Emoji button - insert common emojis via simple picker
  elements.emojiBtn.addEventListener('click', () => {
    const emojis = ['👍', '👎', '✅', '❌', '🎉', '🔥', '💡', '⚠️', '📝', '🚀'];
    const emoji = emojis[Math.floor(Math.random() * emojis.length)];
    const input = elements.messageInput;
    const start = input.selectionStart;
    const text = input.value;
    input.value = text.substring(0, start) + emoji + text.substring(start);
    input.selectionStart = input.selectionEnd = start + emoji.length;
    input.focus();
  });

  // Command palette
  elements.searchTrigger.addEventListener('click', openCommandPalette);

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      if (elements.commandPaletteOverlay.classList.contains('visible')) {
        closeCommandPalette();
      } else {
        openCommandPalette();
      }
    }

    if (e.key === 'Escape') {
      closeCommandPalette();
    }
  });

  elements.commandPaletteOverlay.addEventListener('click', (e: MouseEvent) => {
    if (e.target === elements.commandPaletteOverlay) {
      closeCommandPalette();
    }
  });

  elements.paletteSearch.addEventListener('input', (e: Event) => {
    const target = e.target as HTMLInputElement;
    filterPaletteResults(target.value);
  });

  elements.paletteSearch.addEventListener('keydown', handlePaletteKeydown);

  // Command execution
  document.querySelectorAll<HTMLElement>('.palette-item[data-command]').forEach((item) => {
    item.addEventListener('click', () => {
      const command = item.dataset.command;

      if (command === 'broadcast') {
        // Pre-fill message input with @* for broadcast
        elements.messageInput.value = '@* ';
        elements.messageInput.focus();
      } else if (command === 'clear') {
        elements.messagesList.innerHTML = '';
      }

      closeCommandPalette();
    });
  });

  // Initialize palette channel click handlers
  initPaletteChannels();

  // Thread panel close button
  elements.threadPanelClose.addEventListener('click', closeThreadPanel);

  // Thread panel send button
  elements.threadSendBtn.addEventListener('click', handleThreadSend);

  // Thread message input keyboard shortcuts (Slack-style)
  elements.threadMessageInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleThreadSend();
    }
    // Shift+Enter allows default behavior (inserts newline)
  });

  // Close thread panel on Escape
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && elements.threadPanelOverlay.classList.contains('visible')) {
      closeThreadPanel();
    }
  });

  // Spawn modal event listeners
  elements.spawnBtn.addEventListener('click', openSpawnModal);

  elements.spawnModalClose.addEventListener('click', closeSpawnModal);

  // Cancel button in spawn modal
  document.getElementById('spawn-cancel-btn')?.addEventListener('click', closeSpawnModal);

  // Close spawn modal on overlay click
  elements.spawnModalOverlay.addEventListener('click', (e: MouseEvent) => {
    if (e.target === elements.spawnModalOverlay) {
      closeSpawnModal();
    }
  });

  // Close spawn modal on Escape
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && elements.spawnModalOverlay.classList.contains('visible')) {
      closeSpawnModal();
    }
  });

  // Submit spawn form
  elements.spawnSubmitBtn.addEventListener('click', spawnAgent);

  // Enter key in spawn name input triggers submit
  elements.spawnNameInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      spawnAgent();
    }
  });
}

/**
 * Parse @mention from message text
 * Formats: "@AgentName message" or "@* message" for broadcast
 * Returns { to, message } or null if no valid mention found
 */
function parseMention(text: string): { to: string; message: string } | null {
  const trimmed = text.trim();

  // Match @mention at the start of the message
  // @* for broadcast, @AgentName for direct message
  const match = trimmed.match(/^@(\*|[^\s]+)\s+(.+)$/s);

  if (!match) {
    return null;
  }

  return {
    to: match[1],
    message: match[2].trim(),
  };
}

/**
 * Handle send button click
 */
async function handleSend(): Promise<void> {
  const elements = getElements();
  const rawMessage = elements.messageInput.value.trim();

  if (!rawMessage) {
    return;
  }

  let to: string;
  let message: string;

  // Check if we're in a DM (not general channel)
  const isInDM = state.currentChannel !== 'general';

  // Parse @mention from the message
  const parsed = parseMention(rawMessage);

  if (parsed) {
    // Message has explicit @mention - use it
    to = parsed.to;
    message = parsed.message;
  } else if (isInDM) {
    // In DM context - send to current channel without requiring @
    to = state.currentChannel;
    message = rawMessage;
  } else {
    // In general channel without @mention - require it
    alert('Message must start with @recipient (e.g., "@Lead hello" or "@* broadcast")');
    return;
  }

  elements.sendBtn.disabled = true;

  const result = await sendMessage(to, message);

  if (result.success) {
    elements.messageInput.value = '';
    elements.messageInput.style.height = 'auto';
  } else {
    alert(result.error);
  }

  elements.sendBtn.disabled = false;
}

/**
 * Handle thread panel send button click
 */
async function handleThreadSend(): Promise<void> {
  const elements = getElements();
  const message = elements.threadMessageInput.value.trim();
  const threadId = state.currentThread;

  if (!message || !threadId) {
    return;
  }

  // For thread replies, send to broadcast or use original recipient
  // For now, send as broadcast with thread ID
  elements.threadSendBtn.disabled = true;

  const result = await sendMessage('*', message, threadId);

  if (result.success) {
    elements.threadMessageInput.value = '';
    // Re-render thread messages to show the new message
    renderThreadMessages(threadId);
  } else {
    alert(result.error);
  }

  elements.threadSendBtn.disabled = false;
}

// Auto-initialize when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
}
