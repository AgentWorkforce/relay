/**
 * Dashboard Utility Functions
 */

/** Threshold for considering an agent offline (30 seconds) */
export const STALE_THRESHOLD_MS = 30000;

/**
 * Check if an agent is online based on last seen timestamp
 */
export function isAgentOnline(lastSeen: string | undefined): boolean {
  if (!lastSeen) return false;
  const ts = Date.parse(lastSeen);
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts < STALE_THRESHOLD_MS;
}

/**
 * Escape HTML to prevent XSS
 */
export function escapeHtml(text: string | undefined): string {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Format timestamp to locale time string
 */
export function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Format timestamp to human-readable date
 */
export function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  } else if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  } else {
    return date.toLocaleDateString([], {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
  }
}

/**
 * Generate a consistent color for an agent based on their name
 */
export function getAvatarColor(name: string): string {
  const colors = [
    '#e01e5a',
    '#2bac76',
    '#e8a427',
    '#1264a3',
    '#7c3aed',
    '#0d9488',
    '#dc2626',
    '#9333ea',
    '#ea580c',
    '#0891b2',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

/**
 * Get initials from a name (first 2 characters, uppercase)
 */
export function getInitials(name: string): string {
  return name.substring(0, 2).toUpperCase();
}

/**
 * Format message body with basic markdown-like formatting
 */
export function formatMessageBody(content: string | undefined): string {
  if (!content) return '';

  let escaped = escapeHtml(content);

  // Simple code block detection
  escaped = escaped.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');
  escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Convert newlines to <br> for proper multi-line display
  escaped = escaped.replace(/\n/g, '<br>');

  return escaped;
}
