/**
 * ThinkingIndicator Component
 *
 * Displays an animated indicator when an agent is processing/thinking.
 * Shows a pulsing animation similar to "typing..." indicators in chat apps.
 */

import React, { useEffect, useState } from 'react';

export interface ThinkingIndicatorProps {
  /** Whether the agent is currently processing */
  isProcessing: boolean;
  /** When processing started (for elapsed time display) */
  processingStartedAt?: number;
  /** Size variant */
  size?: 'small' | 'medium' | 'large';
  /** Show elapsed time */
  showElapsed?: boolean;
  /** Show label text */
  showLabel?: boolean;
}

export function ThinkingIndicator({
  isProcessing,
  processingStartedAt,
  size = 'medium',
  showElapsed = false,
  showLabel = false,
}: ThinkingIndicatorProps) {
  const [elapsedMs, setElapsedMs] = useState(0);

  // Update elapsed time every second when processing
  useEffect(() => {
    if (!isProcessing || !processingStartedAt) {
      setElapsedMs(0);
      return;
    }

    const updateElapsed = () => {
      setElapsedMs(Date.now() - processingStartedAt);
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [isProcessing, processingStartedAt]);

  if (!isProcessing) {
    return null;
  }

  const formatElapsed = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  };

  const dotSizeClasses: Record<string, string> = {
    small: 'w-1 h-1',
    medium: 'w-1.5 h-1.5',
    large: 'w-2 h-2',
  };

  const gapClasses: Record<string, string> = {
    small: 'gap-0.5',
    medium: 'gap-1',
    large: 'gap-1.5',
  };

  return (
    <span
      className="inline-flex items-center gap-1.5 text-accent-purple"
      title="Processing..."
    >
      <span className={`inline-flex items-center ${gapClasses[size]}`}>
        <span
          className={`${dotSizeClasses[size]} rounded-full bg-accent-purple animate-bounce`}
          style={{ animationDelay: '0ms', animationDuration: '800ms' }}
        />
        <span
          className={`${dotSizeClasses[size]} rounded-full bg-accent-purple animate-bounce`}
          style={{ animationDelay: '150ms', animationDuration: '800ms' }}
        />
        <span
          className={`${dotSizeClasses[size]} rounded-full bg-accent-purple animate-bounce`}
          style={{ animationDelay: '300ms', animationDuration: '800ms' }}
        />
      </span>
      {showLabel && (
        <span className="text-xs font-medium text-accent-purple">thinking</span>
      )}
      {showElapsed && elapsedMs > 0 && (
        <span className="text-xs text-accent-purple/70">{formatElapsed(elapsedMs)}</span>
      )}
    </span>
  );
}

/**
 * Inline thinking indicator for compact views
 */
export function ThinkingDot({ isProcessing }: { isProcessing: boolean }) {
  if (!isProcessing) return null;

  return (
    <span className="thinking-dot-inline" title="Processing...">
      <span className="thinking-dot-pulse" />
    </span>
  );
}

/**
 * CSS styles for the thinking indicator
 */
export const thinkingIndicatorStyles = `
.thinking-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.thinking-dots {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.thinking-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6366f1;
  animation: thinking-bounce 1.4s ease-in-out infinite;
}

.thinking-dot:nth-child(1) {
  animation-delay: 0s;
}

.thinking-dot:nth-child(2) {
  animation-delay: 0.2s;
}

.thinking-dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes thinking-bounce {
  0%, 60%, 100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

.thinking-elapsed {
  font-size: 10px;
  color: #6366f1;
  margin-left: 4px;
}

/* Size variants */
.thinking-indicator-small .thinking-dot {
  width: 4px;
  height: 4px;
}

.thinking-indicator-small .thinking-dots {
  gap: 2px;
}

.thinking-indicator-large .thinking-dot {
  width: 8px;
  height: 8px;
}

.thinking-indicator-large .thinking-dots {
  gap: 4px;
}

@keyframes thinking-bounce-large {
  0%, 60%, 100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-6px);
    opacity: 1;
  }
}

.thinking-indicator-large .thinking-dot {
  animation: thinking-bounce-large 1.4s ease-in-out infinite;
}

/* Inline dot for compact views */
.thinking-dot-inline {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
}

.thinking-dot-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6366f1;
  animation: thinking-pulse 1.5s ease-in-out infinite;
}

@keyframes thinking-pulse {
  0% {
    transform: scale(0.8);
    opacity: 0.5;
  }
  50% {
    transform: scale(1.1);
    opacity: 1;
  }
  100% {
    transform: scale(0.8);
    opacity: 0.5;
  }
}
`;
