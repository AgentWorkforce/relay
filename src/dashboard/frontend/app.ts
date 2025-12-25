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
 * Detect if we're viewing a project dashboard from bridge context
 */
function detectProjectContext(): { projectId: string | null; fromBridge: boolean } {
  const pathname = window.location.pathname;
  const match = pathname.match(/^\/project\/([^/]+)$/);

  if (match) {
    return { projectId: decodeURIComponent(match[1]), fromBridge: true };
  }

  return { projectId: null, fromBridge: false };
}

/**
 * Update the UI for project context (when accessed from bridge)
 */
async function setupProjectContext(projectId: string): Promise<void> {
  // Update workspace name to show project
  const workspaceName = document.querySelector('.workspace-name');
  if (workspaceName) {
    // Fetch project info
    try {
      const response = await fetch(`/api/project/${encodeURIComponent(projectId)}`);
      if (response.ok) {
        const project = await response.json();
        const nameSpan = workspaceName.querySelector(':not(.status-dot)');
        if (nameSpan && nameSpan.nodeType === Node.TEXT_NODE) {
          nameSpan.textContent = project.name || projectId;
        } else {
          // Replace text content after status-dot
          const textNodes = Array.from(workspaceName.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);
          textNodes.forEach(n => n.textContent = '');
          workspaceName.appendChild(document.createTextNode(' ' + (project.name || projectId)));
        }
      }
    } catch {
      // Fallback - just show project ID
    }
  }

  // Update bridge nav link to show "Back to Bridge" with back arrow
  const bridgeLinkText = document.getElementById('bridge-link-text');
  const bridgeNavLink = document.getElementById('bridge-nav-link');
  if (bridgeLinkText) {
    bridgeLinkText.textContent = '← Back to Bridge';
  }
  if (bridgeNavLink) {
    bridgeNavLink.classList.add('back-to-bridge');
  }

  // Add a subtle indicator that we're in project view
  document.body.classList.add('project-view');
}

/**
 * Initialize the dashboard application
 */
export function initApp(): void {
  const elements = initElements();

  // Check if we're in project context (from bridge)
  const { projectId, fromBridge } = detectProjectContext();
  if (fromBridge && projectId) {
    setupProjectContext(projectId);
  }

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

      if (command === 'bridge') {
        // Navigate to bridge view
        window.location.href = '/bridge';
      } else if (command === 'broadcast') {
        // Pre-fill message input with @* for broadcast
        elements.messageInput.value = '@* ';
        elements.messageInput.focus();
      } else if (command === 'clear') {
        elements.messagesList.innerHTML = '';
      }

      closeCommandPalette();
    });
  });

  // Add Cmd/Ctrl+B shortcut for bridge navigation
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
      e.preventDefault();
      window.location.href = '/bridge';
    }
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

/**
 * Spawn Agent Modal Management
 */
interface SpawnModalElements {
  overlay: HTMLElement | null;
  closeBtn: HTMLElement | null;
  cancelBtn: HTMLElement | null;
  submitBtn: HTMLElement | null;
  nameInput: HTMLInputElement | null;
  cliSelect: HTMLSelectElement | null;
  modelInput: HTMLInputElement | null;
  taskInput: HTMLTextAreaElement | null;
}

function getSpawnModalElements(): SpawnModalElements {
  return {
    overlay: document.getElementById('spawn-modal-overlay'),
    closeBtn: document.getElementById('spawn-modal-close'),
    cancelBtn: document.getElementById('spawn-modal-cancel'),
    submitBtn: document.getElementById('spawn-modal-submit'),
    nameInput: document.getElementById('spawn-agent-name') as HTMLInputElement,
    cliSelect: document.getElementById('spawn-agent-cli') as HTMLSelectElement,
    modelInput: document.getElementById('spawn-agent-model') as HTMLInputElement,
    taskInput: document.getElementById('spawn-agent-task') as HTMLTextAreaElement,
  };
}

function openSpawnModal(): void {
  const modal = getSpawnModalElements();
  if (modal.overlay) {
    modal.overlay.classList.add('visible');
    modal.nameInput?.focus();
  }
}

function closeSpawnModal(): void {
  const modal = getSpawnModalElements();
  if (modal.overlay) {
    modal.overlay.classList.remove('visible');
    // Clear form
    if (modal.nameInput) modal.nameInput.value = '';
    if (modal.cliSelect) modal.cliSelect.value = 'claude';
    if (modal.modelInput) modal.modelInput.value = '';
    if (modal.taskInput) modal.taskInput.value = '';
  }
}

async function handleSpawnAgent(): Promise<void> {
  const modal = getSpawnModalElements();

  const name = modal.nameInput?.value.trim();
  const cli = modal.cliSelect?.value;
  const model = modal.modelInput?.value.trim();
  const task = modal.taskInput?.value.trim();

  if (!name) {
    alert('Please enter an agent name');
    return;
  }

  if (!cli) {
    alert('Please select a CLI tool');
    return;
  }

  // Disable submit button
  if (modal.submitBtn) {
    modal.submitBtn.textContent = 'Spawning...';
    (modal.submitBtn as HTMLButtonElement).disabled = true;
  }

  try {
    const response = await fetch('/api/agent/spawn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        cli,
        model: model || undefined,
        task: task || undefined,
      }),
    });

    const result = await response.json();

    if (response.ok && result.success) {
      closeSpawnModal();
      // Agent will appear in the list when it connects to the relay
    } else {
      alert(result.error || 'Failed to spawn agent');
    }
  } catch (err) {
    console.error('Failed to spawn agent:', err);
    alert('Failed to spawn agent. Check console for details.');
  } finally {
    if (modal.submitBtn) {
      modal.submitBtn.textContent = 'Spawn Agent';
      (modal.submitBtn as HTMLButtonElement).disabled = false;
    }
  }
}

/**
 * Kill an agent
 */
async function killAgent(agentName: string): Promise<void> {
  if (!confirm(`Are you sure you want to kill agent "${agentName}"?`)) {
    return;
  }

  try {
    const response = await fetch('/api/agent/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: agentName }),
    });

    const result = await response.json();

    if (!response.ok) {
      alert(result.error || 'Failed to kill agent');
    }
    // Agent will disappear from the list when it disconnects
  } catch (err) {
    console.error('Failed to kill agent:', err);
    alert('Failed to kill agent. Check console for details.');
  }
}

/**
 * Set up spawn modal event listeners
 */
function setupSpawnModalListeners(): void {
  const modal = getSpawnModalElements();

  // Spawn button in sidebar
  const spawnBtn = document.getElementById('spawn-agent-btn');
  if (spawnBtn) {
    spawnBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSpawnModal();
    });
  }

  // Modal close buttons
  modal.closeBtn?.addEventListener('click', closeSpawnModal);
  modal.cancelBtn?.addEventListener('click', closeSpawnModal);

  // Modal submit
  modal.submitBtn?.addEventListener('click', handleSpawnAgent);

  // Close on overlay click
  modal.overlay?.addEventListener('click', (e) => {
    if (e.target === modal.overlay) {
      closeSpawnModal();
    }
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.overlay?.classList.contains('visible')) {
      closeSpawnModal();
    }
  });

  // Enter to submit (when name input is focused)
  modal.nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      handleSpawnAgent();
    }
  });
}

/**
 * Attach kill handlers to agent list items
 * Called after agents are rendered
 */
export function attachKillHandlers(): void {
  document.querySelectorAll<HTMLElement>('.agent-kill-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const agentName = btn.dataset.agent;
      if (agentName) {
        killAgent(agentName);
      }
    });
  });
}

// Auto-initialize when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initApp();
      setupSpawnModalListeners();
    });
  } else {
    initApp();
    setupSpawnModalListeners();
  }
}
