/**
 * NotificationToast Component
 *
 * Toast notifications for alerts, messages, and system events.
 * Supports multiple toast types and auto-dismiss.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { getAgentColor, getAgentInitials } from '../lib/colors';

export interface Toast {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error' | 'message';
  title: string;
  message?: string;
  agentName?: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export interface NotificationToastProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  maxVisible?: number;
}

export function NotificationToast({
  toasts,
  onDismiss,
  position = 'top-right',
  maxVisible = 5,
}: NotificationToastProps) {
  const visibleToasts = toasts.slice(0, maxVisible);

  return (
    <div className={`toast-container toast-${position}`}>
      {visibleToasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

interface ToastItemProps {
  toast: Toast;
  onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const [isExiting, setIsExiting] = useState(false);

  const handleDismiss = useCallback(() => {
    setIsExiting(true);
    setTimeout(() => onDismiss(toast.id), 200);
  }, [toast.id, onDismiss]);

  // Auto-dismiss
  useEffect(() => {
    if (toast.duration === 0) return;

    const duration = toast.duration || 5000;
    const timer = setTimeout(handleDismiss, duration);
    return () => clearTimeout(timer);
  }, [toast.duration, handleDismiss]);

  const colors = toast.agentName ? getAgentColor(toast.agentName) : null;
  const Icon = getToastIcon(toast.type);

  return (
    <div
      className={`toast toast-${toast.type} ${isExiting ? 'toast-exit' : ''}`}
      role="alert"
    >
      <div className="toast-icon-wrapper">
        {toast.agentName ? (
          <div
            className="toast-agent-avatar"
            style={{ backgroundColor: colors?.primary, color: colors?.text }}
          >
            {getAgentInitials(toast.agentName)}
          </div>
        ) : (
          <div className={`toast-icon toast-icon-${toast.type}`}>
            <Icon />
          </div>
        )}
      </div>

      <div className="toast-content">
        <div className="toast-header">
          <span className="toast-title">{toast.title}</span>
          {toast.agentName && <span className="toast-agent">@{toast.agentName}</span>}
        </div>
        {toast.message && <p className="toast-message">{toast.message}</p>}
        {toast.action && (
          <button
            className="toast-action"
            onClick={() => {
              toast.action?.onClick();
              handleDismiss();
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>

      <button className="toast-close" onClick={handleDismiss} aria-label="Dismiss">
        <CloseIcon />
      </button>

      {toast.duration !== 0 && (
        <div
          className="toast-progress"
          style={{ animationDuration: `${toast.duration || 5000}ms` }}
        />
      )}
    </div>
  );
}

// Hook for managing toasts
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { ...toast, id }]);
    return id;
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    setToasts([]);
  }, []);

  // Convenience methods
  const info = useCallback(
    (title: string, message?: string) => addToast({ type: 'info', title, message }),
    [addToast]
  );

  const success = useCallback(
    (title: string, message?: string) => addToast({ type: 'success', title, message }),
    [addToast]
  );

  const warning = useCallback(
    (title: string, message?: string) => addToast({ type: 'warning', title, message }),
    [addToast]
  );

  const error = useCallback(
    (title: string, message?: string) => addToast({ type: 'error', title, message }),
    [addToast]
  );

  const message = useCallback(
    (agentName: string, content: string, action?: Toast['action']) =>
      addToast({ type: 'message', title: 'New Message', message: content, agentName, action }),
    [addToast]
  );

  return {
    toasts,
    addToast,
    dismissToast,
    clearToasts,
    info,
    success,
    warning,
    error,
    message,
  };
}

// Helper function
function getToastIcon(type: Toast['type']) {
  switch (type) {
    case 'success':
      return CheckIcon;
    case 'warning':
      return WarningIcon;
    case 'error':
      return ErrorIcon;
    case 'message':
      return MessageIcon;
    default:
      return InfoIcon;
  }
}

// Icon components
function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

function MessageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/**
 * CSS styles for the notification toast
 */
export const notificationToastStyles = `
.toast-container {
  position: fixed;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.toast-top-right {
  top: 16px;
  right: 16px;
}

.toast-top-left {
  top: 16px;
  left: 16px;
}

.toast-bottom-right {
  bottom: 16px;
  right: 16px;
}

.toast-bottom-left {
  bottom: 16px;
  left: 16px;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 360px;
  padding: 14px 16px;
  background: #ffffff;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  pointer-events: auto;
  animation: toastEnter 0.2s ease;
  position: relative;
  overflow: hidden;
}

.toast-exit {
  animation: toastExit 0.2s ease forwards;
}

.toast-icon-wrapper {
  flex-shrink: 0;
}

.toast-icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.toast-icon-info {
  background: #dbeafe;
  color: #2563eb;
}

.toast-icon-success {
  background: #dcfce7;
  color: #16a34a;
}

.toast-icon-warning {
  background: #fef3c7;
  color: #d97706;
}

.toast-icon-error {
  background: #fee2e2;
  color: #dc2626;
}

.toast-icon-message {
  background: #f3e8ff;
  color: #7c3aed;
}

.toast-agent-avatar {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
}

.toast-content {
  flex: 1;
  min-width: 0;
}

.toast-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toast-title {
  font-size: 14px;
  font-weight: 600;
  color: #1a1a1a;
}

.toast-agent {
  font-size: 12px;
  color: #888;
}

.toast-message {
  margin: 4px 0 0;
  font-size: 13px;
  color: #555;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.toast-action {
  margin-top: 8px;
  padding: 6px 12px;
  background: #f5f5f5;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  color: #333;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}

.toast-action:hover {
  background: #e8e8e8;
}

.toast-close {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: #888;
  cursor: pointer;
  transition: all 0.15s;
}

.toast-close:hover {
  background: #f5f5f5;
  color: #333;
}

.toast-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 3px;
  background: currentColor;
  opacity: 0.3;
  animation: toastProgress linear forwards;
}

.toast-info .toast-progress {
  color: #2563eb;
}

.toast-success .toast-progress {
  color: #16a34a;
}

.toast-warning .toast-progress {
  color: #d97706;
}

.toast-error .toast-progress {
  color: #dc2626;
}

.toast-message .toast-progress {
  color: #7c3aed;
}

@keyframes toastEnter {
  from {
    opacity: 0;
    transform: translateX(100%);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes toastExit {
  from {
    opacity: 1;
    transform: translateX(0);
  }
  to {
    opacity: 0;
    transform: translateX(100%);
  }
}

@keyframes toastProgress {
  from {
    width: 100%;
  }
  to {
    width: 0%;
  }
}
`;
