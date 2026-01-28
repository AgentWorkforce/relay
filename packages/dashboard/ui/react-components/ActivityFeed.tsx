/**
 * ActivityFeed Component
 *
 * Displays a unified timeline of workspace events including:
 * - Agent spawned/released
 * - Agent online/offline
 * - User joined/left
 * - Broadcasts
 */

import React, { useMemo } from 'react';
import type { ActivityEvent, ActivityEventType } from '../types';

export interface ActivityFeedProps {
  events: ActivityEvent[];
  maxEvents?: number;
  onEventClick?: (event: ActivityEvent) => void;
}

/**
 * Get icon for activity event type
 */
function getEventIcon(type: ActivityEventType): string {
  switch (type) {
    case 'agent_spawned':
      return '🚀';
    case 'agent_released':
      return '🛑';
    case 'agent_online':
      return '🟢';
    case 'agent_offline':
      return '⚫';
    case 'user_joined':
      return '👋';
    case 'user_left':
      return '👋';
    case 'broadcast':
      return '📢';
    case 'error':
      return '⚠️';
    default:
      return '📌';
  }
}

/**
 * Get color class for activity event type
 */
function getEventColorClass(type: ActivityEventType): string {
  switch (type) {
    case 'agent_spawned':
      return 'text-green-400';
    case 'agent_released':
      return 'text-red-400';
    case 'agent_online':
      return 'text-green-400';
    case 'agent_offline':
      return 'text-gray-400';
    case 'user_joined':
      return 'text-cyan-400';
    case 'user_left':
      return 'text-gray-400';
    case 'broadcast':
      return 'text-yellow-400';
    case 'error':
      return 'text-red-500';
    default:
      return 'text-text-muted';
  }
}

/**
 * Format relative time (e.g., "2m ago", "1h ago")
 */
function formatRelativeTime(timestamp: string): string {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now.getTime() - then.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return then.toLocaleDateString();
}

/**
 * Single activity event item
 */
function ActivityEventItem({
  event,
  onClick,
}: {
  event: ActivityEvent;
  onClick?: () => void;
}) {
  const icon = getEventIcon(event.type);
  const colorClass = getEventColorClass(event.type);

  return (
    <div
      className={`flex items-start gap-3 p-3 rounded-lg hover:bg-bg-hover transition-colors ${onClick ? 'cursor-pointer' : ''}`}
      onClick={onClick}
    >
      {/* Avatar or Icon */}
      <div className="flex-shrink-0 w-8 h-8 flex items-center justify-center">
        {event.actorAvatarUrl ? (
          <img
            src={event.actorAvatarUrl}
            alt={event.actor}
            className="w-8 h-8 rounded-full"
          />
        ) : (
          <span className="text-lg">{icon}</span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`font-medium ${colorClass}`}>{event.actor}</span>
          <span className="text-text-muted text-sm">{event.title}</span>
        </div>
        {event.description && (
          <p className="text-text-muted text-sm mt-1 line-clamp-2">
            {event.description}
          </p>
        )}
        {/* Metadata badges */}
        {event.metadata && Object.keys(event.metadata).length > 0 && (() => {
          const cli = event.metadata.cli;
          const task = event.metadata.task;
          return (
            <div className="flex flex-wrap gap-1 mt-2">
              {cli != null && (
                <span className="px-2 py-0.5 bg-bg-secondary rounded text-xs text-text-muted">
                  {String(cli)}
                </span>
              )}
              {task != null && (
                <span className="px-2 py-0.5 bg-bg-secondary rounded text-xs text-text-muted truncate max-w-[200px]">
                  {String(task)}
                </span>
              )}
            </div>
          );
        })()}
      </div>

      {/* Timestamp */}
      <div className="flex-shrink-0 text-xs text-text-muted">
        {formatRelativeTime(event.timestamp)}
      </div>
    </div>
  );
}

/**
 * Empty state when no events
 */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-8">
      <div className="text-4xl mb-4">📋</div>
      <h3 className="text-lg font-medium text-text-primary mb-2">No activity yet</h3>
      <p className="text-text-muted text-sm max-w-xs">
        Activity will appear here as agents spawn, users join, and broadcasts are sent.
      </p>
    </div>
  );
}

/**
 * Activity Feed - displays timeline of workspace events
 */
export function ActivityFeed({ events, maxEvents = 100, onEventClick }: ActivityFeedProps) {
  // Sort events by timestamp (newest first) and limit
  const sortedEvents = useMemo(() => {
    return [...events]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, maxEvents);
  }, [events, maxEvents]);

  if (sortedEvents.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-border-subtle">
        <h2 className="text-lg font-semibold text-text-primary">Activity</h2>
        <p className="text-sm text-text-muted">
          {sortedEvents.length} event{sortedEvents.length !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Event List */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <div className="space-y-1">
          {sortedEvents.map((event) => (
            <ActivityEventItem
              key={event.id}
              event={event}
              onClick={onEventClick ? () => onEventClick(event) : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
