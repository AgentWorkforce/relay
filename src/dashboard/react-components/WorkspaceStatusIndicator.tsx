/**
 * Workspace Status Indicator
 *
 * Shows workspace status in the dashboard with visual indicators:
 * - Running (green): Workspace is active and ready
 * - Stopped (amber): Workspace is idle, can be woken up
 * - Provisioning (cyan): Workspace is being created
 * - Error (red): Workspace has an issue
 * - None (gray): No workspace exists
 */

import React, { useCallback, useState } from 'react';
import { useWorkspaceStatus } from './hooks/useWorkspaceStatus';

export interface WorkspaceStatusIndicatorProps {
  /** Show expanded view with details (default: false) */
  expanded?: boolean;
  /** Auto-wakeup when workspace is stopped (default: false) */
  autoWakeup?: boolean;
  /** Callback when wakeup is triggered */
  onWakeup?: () => void;
  /** Callback when status changes */
  onStatusChange?: (status: string) => void;
  /** Custom class name */
  className?: string;
}

export function WorkspaceStatusIndicator({
  expanded = false,
  autoWakeup = false,
  onWakeup,
  onStatusChange,
  className = '',
}: WorkspaceStatusIndicatorProps) {
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');

  const {
    workspace,
    exists,
    isLoading,
    isWakingUp,
    statusMessage,
    actionNeeded,
    wakeup,
  } = useWorkspaceStatus({
    autoWakeup,
    onStatusChange: (status, wasRestarted) => {
      onStatusChange?.(status);
      if (wasRestarted) {
        setToastMessage('Workspace is starting up...');
        setShowToast(true);
        setTimeout(() => setShowToast(false), 5000);
      } else if (status === 'running') {
        setToastMessage('Workspace is ready!');
        setShowToast(true);
        setTimeout(() => setShowToast(false), 3000);
      }
    },
  });

  const handleWakeup = useCallback(async () => {
    const result = await wakeup();
    if (result.success) {
      onWakeup?.();
      setToastMessage(result.message);
      setShowToast(true);
      setTimeout(() => setShowToast(false), 5000);
    }
  }, [wakeup, onWakeup]);

  // Get status color and icon
  const getStatusConfig = () => {
    if (!exists) {
      return {
        color: 'text-text-muted',
        bgColor: 'bg-bg-tertiary',
        borderColor: 'border-border-subtle',
        icon: <NoWorkspaceIcon />,
        label: 'No workspace',
        pulseColor: null,
      };
    }

    if (isLoading && !workspace) {
      return {
        color: 'text-text-muted',
        bgColor: 'bg-bg-tertiary',
        borderColor: 'border-border-subtle',
        icon: <LoadingIcon />,
        label: 'Loading...',
        pulseColor: null,
      };
    }

    if (workspace?.isRunning) {
      return {
        color: 'text-success',
        bgColor: 'bg-success/10',
        borderColor: 'border-success/30',
        icon: <RunningIcon />,
        label: 'Running',
        pulseColor: 'bg-success',
      };
    }

    if (workspace?.isStopped) {
      return {
        color: 'text-amber-400',
        bgColor: 'bg-amber-400/10',
        borderColor: 'border-amber-400/30',
        icon: <StoppedIcon />,
        label: 'Stopped',
        pulseColor: null,
      };
    }

    if (workspace?.isProvisioning || isWakingUp) {
      return {
        color: 'text-accent-cyan',
        bgColor: 'bg-accent-cyan/10',
        borderColor: 'border-accent-cyan/30',
        icon: <ProvisioningIcon />,
        label: isWakingUp ? 'Starting...' : 'Provisioning',
        pulseColor: 'bg-accent-cyan',
      };
    }

    if (workspace?.hasError) {
      return {
        color: 'text-error',
        bgColor: 'bg-error/10',
        borderColor: 'border-error/30',
        icon: <ErrorIcon />,
        label: 'Error',
        pulseColor: null,
      };
    }

    return {
      color: 'text-text-muted',
      bgColor: 'bg-bg-tertiary',
      borderColor: 'border-border-subtle',
      icon: <NoWorkspaceIcon />,
      label: 'Unknown',
      pulseColor: null,
    };
  };

  const config = getStatusConfig();

  // Compact indicator (for header)
  if (!expanded) {
    return (
      <div className={`relative ${className}`}>
        <div
          className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border ${config.bgColor} ${config.borderColor} cursor-default`}
          title={statusMessage || config.label}
        >
          <span className={config.color}>{config.icon}</span>
          <span className={`text-xs font-medium ${config.color}`}>
            {config.label}
          </span>
          {config.pulseColor && (
            <span
              className={`w-2 h-2 rounded-full ${config.pulseColor} animate-pulse`}
            />
          )}
        </div>

        {/* Wakeup button for stopped state */}
        {actionNeeded === 'wakeup' && !isWakingUp && (
          <button
            onClick={handleWakeup}
            className="ml-2 px-2 py-1 text-xs font-medium text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded hover:bg-amber-400/20 transition-colors"
          >
            Wake up
          </button>
        )}

        {/* Toast notification */}
        {showToast && (
          <div className="absolute top-full mt-2 left-0 z-50 px-3 py-2 bg-bg-card border border-border-medium rounded-lg shadow-lg text-sm text-text-primary whitespace-nowrap animate-in fade-in slide-in-from-top-2">
            {toastMessage}
          </div>
        )}
      </div>
    );
  }

  // Expanded view (for sidebar or dedicated panel)
  return (
    <div
      className={`rounded-lg border ${config.borderColor} ${config.bgColor} p-4 ${className}`}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={config.color}>{config.icon}</span>
          <span className={`text-sm font-semibold ${config.color}`}>
            Workspace Status
          </span>
        </div>
        {config.pulseColor && (
          <span
            className={`w-2.5 h-2.5 rounded-full ${config.pulseColor} animate-pulse`}
          />
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-muted">Name</span>
          <span className="text-sm text-text-primary font-medium truncate max-w-[150px]">
            {workspace?.name || 'None'}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-text-muted">Status</span>
          <span className={`text-sm font-medium ${config.color}`}>
            {config.label}
          </span>
        </div>

        {statusMessage && (
          <p className="text-xs text-text-muted mt-2">{statusMessage}</p>
        )}

        {/* Action buttons */}
        {actionNeeded === 'wakeup' && !isWakingUp && (
          <button
            onClick={handleWakeup}
            className="w-full mt-3 px-3 py-2 text-sm font-medium text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-lg hover:bg-amber-400/20 transition-colors"
          >
            Wake up workspace
          </button>
        )}

        {actionNeeded === 'check_error' && (
          <a
            href={`/workspaces/${workspace?.id}`}
            className="block w-full mt-3 px-3 py-2 text-sm font-medium text-center text-error bg-error/10 border border-error/30 rounded-lg hover:bg-error/20 transition-colors no-underline"
          >
            View error details
          </a>
        )}
      </div>

      {/* Toast notification */}
      {showToast && (
        <div className="mt-3 px-3 py-2 bg-bg-card border border-border-medium rounded-lg text-sm text-text-primary animate-in fade-in">
          {toastMessage}
        </div>
      )}
    </div>
  );
}

// Icons
function RunningIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

function StoppedIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="6" y="6" width="12" height="12" />
    </svg>
  );
}

function ProvisioningIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="animate-spin"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

function NoWorkspaceIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

function LoadingIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="animate-spin"
    >
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" />
    </svg>
  );
}
