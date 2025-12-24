/**
 * Bridge Dashboard Application Entry Point
 */

import { subscribe, state, setProjects, setMessages, setConnected, setWebSocket, setSelectedProject, getUptimeString, getConnectedProjects, getAllAgents, getProject } from './state.js';
import type { BridgeDOMElements } from './types.js';
import { escapeHtml, formatTime } from '../utils.js';

let elements: BridgeDOMElements;

/**
 * Initialize DOM element references
 */
function initElements(): BridgeDOMElements {
  return {
    statusDot: document.getElementById('status-dot')!,
    projectList: document.getElementById('project-list')!,
    cardsGrid: document.getElementById('cards-grid')!,
    emptyState: document.getElementById('empty-state')!,
    messagesList: document.getElementById('messages-list')!,
    searchBar: document.getElementById('search-bar')!,
    paletteOverlay: document.getElementById('command-palette-overlay')!,
    paletteSearch: document.getElementById('palette-search') as HTMLInputElement,
    paletteResults: document.getElementById('palette-results')!,
    paletteProjectsSection: document.getElementById('palette-projects-section')!,
    paletteAgentsSection: document.getElementById('palette-agents-section')!,
    channelName: document.getElementById('channel-name')!,
    statAgents: document.getElementById('stat-agents')!,
    statMessages: document.getElementById('stat-messages')!,
    composerProject: document.getElementById('composer-project') as HTMLSelectElement,
    composerAgent: document.getElementById('composer-agent') as HTMLSelectElement,
    composerMessage: document.getElementById('composer-message') as HTMLInputElement,
    composerSend: document.getElementById('composer-send') as HTMLButtonElement,
    composerStatus: document.getElementById('composer-status')!,
    uptime: document.getElementById('uptime')!,
  };
}

/**
 * Update connection status indicator
 */
function updateConnectionStatus(): void {
  elements.statusDot.classList.toggle('offline', !state.isConnected);
}

/**
 * Render sidebar projects list
 */
function renderSidebarProjects(): void {
  const { projects, selectedProjectId } = state;

  if (!projects || projects.length === 0) {
    elements.projectList.innerHTML = '<li class="project-item" style="cursor: default; color: var(--text-muted);">No projects</li>';
    document.getElementById('project-count')!.textContent = '0';
    return;
  }

  document.getElementById('project-count')!.textContent = String(projects.length);

  elements.projectList.innerHTML = projects.map((p) => `
    <li class="project-item ${p.connected ? 'connected' : ''} ${selectedProjectId === p.id ? 'active' : ''}" data-project-id="${escapeHtml(p.id)}">
      <span class="project-status-dot"></span>
      <span class="project-name">${escapeHtml(p.name || p.id)}</span>
      <button class="project-dashboard-btn" data-dashboard-project="${escapeHtml(p.id)}" title="Open project dashboard">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <line x1="3" y1="9" x2="21" y2="9"/>
          <line x1="9" y1="21" x2="9" y2="9"/>
        </svg>
      </button>
    </li>
  `).join('');
}

/**
 * Render project cards grid
 */
function renderProjectCards(): void {
  const { projects, selectedProjectId } = state;

  if (!projects || projects.length === 0) {
    elements.cardsGrid.innerHTML = '';
    elements.cardsGrid.appendChild(elements.emptyState);
    elements.emptyState.style.display = 'flex';
    return;
  }

  elements.emptyState.style.display = 'none';

  elements.cardsGrid.innerHTML = projects.map((p) => {
    const agents = p.agents || [];
    const agentsHtml = agents.length > 0
      ? agents.map((a) => `
          <div class="agent-item">
            <span class="agent-status-dot"></span>
            <span class="agent-name">${escapeHtml(a.name)}</span>
            <span class="agent-cli">${escapeHtml(a.cli || '')}</span>
          </div>
        `).join('')
      : '<div class="no-agents">No agents connected</div>';

    const isSelected = selectedProjectId === p.id;
    return `
      <div class="project-card ${p.connected ? '' : 'offline'} ${isSelected ? 'selected' : ''}" data-project-id="${escapeHtml(p.id)}">
        <div class="card-header">
          <div class="card-title-group">
            <div class="card-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
            </div>
            <div>
              <div class="card-title">${escapeHtml(p.name || p.id)}</div>
              <div class="card-path">${escapeHtml(p.path || '')}</div>
            </div>
          </div>
          <div class="card-status ${p.connected ? 'online' : p.reconnecting ? 'reconnecting' : 'offline'}">
            <span class="dot"></span>
            <span>${p.connected ? 'Online' : p.reconnecting ? 'Reconnecting...' : 'Offline'}</span>
          </div>
        </div>

        <div class="agents-section">
          <div class="agents-header">
            <span class="agents-label">Agents</span>
            <span class="agents-count">${agents.length} active</span>
          </div>
          <div class="agents-list">
            ${agentsHtml}
          </div>
        </div>

        <div class="card-actions">
          <button class="card-action-btn" data-message-lead="${escapeHtml(p.id)}" ${!p.connected ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            Message Lead
          </button>
          <button class="card-action-btn primary" data-open-dashboard="${escapeHtml(p.id)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <line x1="3" y1="9" x2="21" y2="9"/>
              <line x1="9" y1="21" x2="9" y2="9"/>
            </svg>
            Open Dashboard
          </button>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Render messages list
 */
function renderMessages(): void {
  const { messages } = state;

  if (!messages || messages.length === 0) {
    elements.messagesList.innerHTML = '<div class="messages-empty"><p>No messages yet</p></div>';
    return;
  }

  elements.messagesList.innerHTML = messages.slice(-50).reverse().map((m) => `
    <div class="message-item">
      <div class="message-route">
        <span class="route-tag">${escapeHtml(m.sourceProject || 'local')}</span>
        <span class="route-agent">${escapeHtml(m.from)}</span>
        <span class="route-arrow">→</span>
        <span class="route-agent">${escapeHtml(m.to || '*')}</span>
        <span class="route-time">${formatTime(m.timestamp)}</span>
      </div>
      <div class="message-body">${escapeHtml(m.body || m.content || '')}</div>
    </div>
  `).join('');
}

/**
 * Update stats display
 */
function updateStats(): void {
  const allAgents = getAllAgents();
  elements.statAgents.textContent = String(allAgents.length);
  elements.statMessages.textContent = String(state.messages.length);
}

/**
 * Update composer project options
 */
function updateComposerProjects(): void {
  const connectedProjects = getConnectedProjects();
  const currentValue = elements.composerProject.value;

  elements.composerProject.innerHTML = '<option value="">Select a project...</option>' +
    connectedProjects.map((p) =>
      `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`
    ).join('');

  // Restore selection if still valid
  if (currentValue && connectedProjects.some((p) => p.id === currentValue)) {
    elements.composerProject.value = currentValue;
  } else if (state.selectedProjectId && connectedProjects.some((p) => p.id === state.selectedProjectId)) {
    elements.composerProject.value = state.selectedProjectId;
    updateComposerAgents();
  }
}

/**
 * Update composer agent options
 */
function updateComposerAgents(): void {
  const projectId = elements.composerProject.value;
  if (!projectId) {
    elements.composerAgent.innerHTML = '<option value="">Select agent...</option>';
    elements.composerAgent.disabled = true;
    elements.composerMessage.disabled = true;
    elements.composerSend.disabled = true;
    return;
  }

  const currentAgent = elements.composerAgent.value;
  const project = getProject(projectId);
  const agents = project?.agents || [];

  elements.composerAgent.innerHTML = '<option value="">Select agent...</option>' +
    '<option value="*">* (Broadcast to all)</option>' +
    '<option value="lead">Lead</option>' +
    agents.map((a) =>
      `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`
    ).join('');

  elements.composerAgent.disabled = false;

  // Restore agent selection if still valid
  if (currentAgent) {
    const validAgents = ['*', 'lead', ...agents.map((a) => a.name)];
    if (validAgents.includes(currentAgent)) {
      elements.composerAgent.value = currentAgent;
    }
  }
}

/**
 * Update composer state based on selections
 */
function updateComposerState(): void {
  const hasProject = !!elements.composerProject.value;
  const hasAgent = !!elements.composerAgent.value;
  const hasMessage = elements.composerMessage.value.trim().length > 0;

  elements.composerMessage.disabled = !hasProject || !hasAgent;
  elements.composerSend.disabled = !hasProject || !hasAgent || !hasMessage;
}

/**
 * Send message via bridge API
 */
async function sendBridgeMessage(): Promise<void> {
  const projectId = elements.composerProject.value;
  const to = elements.composerAgent.value;
  const message = elements.composerMessage.value.trim();

  if (!projectId || !to || !message) return;

  elements.composerSend.disabled = true;
  elements.composerStatus.textContent = 'Sending...';
  elements.composerStatus.className = 'composer-status';

  try {
    const response = await fetch('/api/bridge/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, to, message }),
    });

    const result = await response.json();

    if (response.ok && result.success) {
      elements.composerStatus.textContent = 'Message sent!';
      elements.composerStatus.className = 'composer-status success';
      elements.composerMessage.value = '';
      setTimeout(() => {
        elements.composerStatus.textContent = '';
        elements.composerStatus.className = 'composer-status';
      }, 2000);
    } else {
      throw new Error(result.error || 'Failed to send');
    }
  } catch (err) {
    elements.composerStatus.textContent = (err as Error).message || 'Failed to send message';
    elements.composerStatus.className = 'composer-status error';
  }

  updateComposerState();
}

/**
 * Update header for project selection
 */
function updateHeader(): void {
  const { selectedProjectId } = state;

  if (selectedProjectId) {
    const project = getProject(selectedProjectId);
    if (project) {
      elements.channelName.innerHTML = `
        <span class="back-link" id="back-to-all">← All Projects</span>
        <span class="project-title">${escapeHtml(project.name || project.id)}</span>
      `;
    }
  } else {
    elements.channelName.textContent = 'All Projects';
  }
}

/**
 * Select a project
 */
function selectProject(projectId: string | null): void {
  setSelectedProject(projectId);

  if (projectId) {
    elements.composerProject.value = projectId;
    updateComposerAgents();
    updateComposerState();
  }

  // Update card selection visually
  document.querySelectorAll('.project-card').forEach((card) => {
    card.classList.toggle('selected', (card as HTMLElement).dataset.projectId === projectId);
  });
}

/**
 * Open command palette
 */
function openPalette(): void {
  elements.paletteOverlay.classList.add('visible');
  elements.paletteSearch.value = '';
  elements.paletteSearch.focus();
  updatePaletteResults();
}

/**
 * Close command palette
 */
function closePalette(): void {
  elements.paletteOverlay.classList.remove('visible');
}

/**
 * Update palette search results
 */
function updatePaletteResults(): void {
  const query = elements.paletteSearch.value.toLowerCase();
  const { projects } = state;

  // Update projects section
  const filteredProjects = query
    ? projects.filter((p) => (p.name || p.id).toLowerCase().includes(query))
    : projects;

  if (filteredProjects.length > 0) {
    elements.paletteProjectsSection.innerHTML = `
      <div class="palette-section-title">Open Project Dashboard</div>
      ${filteredProjects.map((p) => `
        <div class="palette-item" data-project="${escapeHtml(p.id)}" data-action="open-dashboard">
          <div class="palette-item-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <line x1="3" y1="9" x2="21" y2="9"/>
              <line x1="9" y1="21" x2="9" y2="9"/>
            </svg>
          </div>
          <div class="palette-item-content">
            <div class="palette-item-title">${escapeHtml(p.name || p.id)}</div>
            <div class="palette-item-subtitle">${p.connected ? 'Online' : 'Offline'} · ${(p.agents || []).length} agents · Click to open dashboard</div>
          </div>
          <div class="palette-item-shortcut">
            <kbd>⏎</kbd>
          </div>
        </div>
      `).join('')}
    `;
  } else {
    elements.paletteProjectsSection.innerHTML = '<div class="palette-section-title">Open Project Dashboard</div>';
  }

  // Update agents section
  const allAgents = getAllAgents();
  const filteredAgents = query
    ? allAgents.filter((a) => a.name.toLowerCase().includes(query))
    : allAgents;

  if (filteredAgents.length > 0) {
    elements.paletteAgentsSection.innerHTML = `
      <div class="palette-section-title">Message Agent</div>
      ${filteredAgents.map((a) => `
        <div class="palette-item" data-agent="${escapeHtml(a.name)}" data-project="${escapeHtml(a.projectId)}">
          <div class="palette-item-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
          </div>
          <div class="palette-item-content">
            <div class="palette-item-title">${escapeHtml(a.name)}</div>
            <div class="palette-item-subtitle">${escapeHtml(a.projectName)} · ${escapeHtml(a.cli || 'unknown')}</div>
          </div>
        </div>
      `).join('')}
    `;
  } else {
    elements.paletteAgentsSection.innerHTML = '<div class="palette-section-title">Message Agent</div>';
  }
}

/**
 * Set up event listeners
 */
function setupEventListeners(): void {
  // Search bar opens palette
  elements.searchBar.addEventListener('click', openPalette);

  // Palette overlay click closes
  elements.paletteOverlay.addEventListener('click', (e) => {
    if (e.target === elements.paletteOverlay) closePalette();
  });

  // Palette search filtering
  elements.paletteSearch.addEventListener('input', updatePaletteResults);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Cmd/Ctrl + K to open palette
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      if (elements.paletteOverlay.classList.contains('visible')) {
        closePalette();
      } else {
        openPalette();
      }
    }
    // Escape to close
    if (e.key === 'Escape' && elements.paletteOverlay.classList.contains('visible')) {
      closePalette();
    }
  });

  // Palette item clicks
  elements.paletteResults.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('.palette-item') as HTMLElement | null;
    if (!item) return;

    const command = item.dataset.command;
    const projectId = item.dataset.project;
    const agentName = item.dataset.agent;
    const action = item.dataset.action;

    if (command === 'broadcast') {
      closePalette();
      elements.composerMessage.focus();
      elements.composerStatus.textContent = 'Select a project and agent to send a message';
    } else if (command === 'refresh') {
      closePalette();
      location.reload();
    } else if (command === 'go-dashboard') {
      closePalette();
      window.location.href = '/';
    } else if (action === 'open-dashboard' && projectId) {
      closePalette();
      window.location.href = `/project/${encodeURIComponent(projectId)}`;
    } else if (agentName && projectId) {
      closePalette();
      elements.composerProject.value = projectId;
      updateComposerAgents();
      setTimeout(() => {
        elements.composerAgent.value = agentName;
        updateComposerState();
        elements.composerMessage.focus();
      }, 50);
    } else if (projectId) {
      closePalette();
      selectProject(projectId);
      const card = document.querySelector(`.project-card[data-project-id="${projectId}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  // Project card clicks
  elements.cardsGrid.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Handle "Open Dashboard" button
    const dashboardBtn = target.closest('[data-open-dashboard]') as HTMLElement | null;
    if (dashboardBtn) {
      e.stopPropagation();
      const projectId = dashboardBtn.dataset.openDashboard;
      if (projectId) {
        window.location.href = `/project/${encodeURIComponent(projectId)}`;
      }
      return;
    }

    // Handle "Message Lead" button
    const messageLeadBtn = target.closest('[data-message-lead]') as HTMLButtonElement | null;
    if (messageLeadBtn && !messageLeadBtn.disabled) {
      e.stopPropagation();
      const projectId = messageLeadBtn.dataset.messageLead;
      if (projectId) {
        elements.composerProject.value = projectId;
        updateComposerAgents();
        setTimeout(() => {
          elements.composerAgent.value = 'lead';
          updateComposerState();
          elements.composerMessage.focus();
        }, 50);
      }
      return;
    }

    const card = target.closest('.project-card') as HTMLElement | null;
    if (card) {
      selectProject(card.dataset.projectId || null);
    }
  });

  // Sidebar project clicks
  elements.projectList.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Check if dashboard button was clicked
    const dashboardBtn = target.closest('.project-dashboard-btn') as HTMLElement | null;
    if (dashboardBtn) {
      e.stopPropagation();
      const projectId = dashboardBtn.dataset.dashboardProject;
      if (projectId) {
        window.location.href = `/project/${encodeURIComponent(projectId)}`;
      }
      return;
    }

    const item = target.closest('.project-item') as HTMLElement | null;
    if (item) {
      selectProject(item.dataset.projectId || null);
    }
  });

  // Header back link
  elements.channelName.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.id === 'back-to-all' || target.classList.contains('back-link')) {
      selectProject(null);
    }
  });

  // Composer events
  elements.composerProject.addEventListener('change', () => {
    updateComposerAgents();
    updateComposerState();
  });

  elements.composerAgent.addEventListener('change', updateComposerState);
  elements.composerMessage.addEventListener('input', updateComposerState);

  elements.composerSend.addEventListener('click', sendBridgeMessage);
  elements.composerMessage.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !elements.composerSend.disabled) {
      e.preventDefault();
      sendBridgeMessage();
    }
  });
}

/**
 * Connect to WebSocket
 */
function connect(): void {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws/bridge`);

  ws.onopen = () => {
    setConnected(true);
    setWebSocket(ws);
  };

  ws.onclose = () => {
    setConnected(false);
    setWebSocket(null);
    setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    setConnected(false);
  };

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      setProjects(data.projects || []);
      setMessages(data.messages || []);
    } catch (err) {
      console.error('[bridge] Parse error:', err);
    }
  };
}

/**
 * Initialize the bridge application
 */
export function initBridgeApp(): void {
  elements = initElements();

  // Subscribe to state changes
  subscribe(() => {
    updateConnectionStatus();
    renderSidebarProjects();
    renderProjectCards();
    renderMessages();
    updateStats();
    updateComposerProjects();
    updateHeader();
    if (elements.composerProject.value) {
      updateComposerAgents();
      updateComposerState();
    }
  });

  // Set up event listeners
  setupEventListeners();

  // Connect to WebSocket
  connect();

  // Update uptime periodically
  setInterval(() => {
    elements.uptime.textContent = `Uptime: ${getUptimeString()}`;
  }, 1000);
}

// Auto-initialize when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBridgeApp);
  } else {
    initBridgeApp();
  }
}
