/**
 * Session Expired Modal
 *
 * Displayed when the user's session has expired and they need to log in again.
 * Provides a clear message and easy path to re-authenticate.
 */

import React from 'react';
import type { SessionError } from './hooks/useSession';

export interface SessionExpiredModalProps {
  /** Whether the modal is visible */
  isOpen: boolean;
  /** Session error details */
  error: SessionError | null;
  /** Called when user clicks to log in */
  onLogin: () => void;
  /** Called when modal is dismissed (optional) */
  onDismiss?: () => void;
}

export function SessionExpiredModal({
  isOpen,
  error,
  onLogin,
  onDismiss,
}: SessionExpiredModalProps) {
  if (!isOpen) return null;

  const getMessage = () => {
    if (!error) return 'Your session has expired. Please log in again to continue.';

    switch (error.code) {
      case 'SESSION_EXPIRED':
        return 'Your session has expired. Please log in again to continue.';
      case 'USER_NOT_FOUND':
        return 'Your account was not found. Please log in again.';
      case 'SESSION_ERROR':
        return 'There was a problem with your session. Please log in again.';
      default:
        return error.message || 'Your session has expired. Please log in again.';
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9998]"
        onClick={onDismiss}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        className="fixed inset-0 flex items-center justify-center z-[9999] p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-expired-title"
      >
        <div className="bg-bg-primary rounded-lg shadow-xl max-w-md w-full p-6 animate-in fade-in zoom-in-95 duration-200">
          {/* Icon */}
          <div className="flex justify-center mb-4">
            <div className="w-16 h-16 rounded-full bg-warning/10 flex items-center justify-center">
              <svg
                className="w-8 h-8 text-warning"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
          </div>

          {/* Title */}
          <h2
            id="session-expired-title"
            className="text-xl font-semibold text-text-primary text-center mb-2"
          >
            Session Expired
          </h2>

          {/* Message */}
          <p className="text-text-muted text-center mb-6">
            {getMessage()}
          </p>

          {/* Actions */}
          <div className="flex flex-col gap-3">
            <button
              onClick={onLogin}
              className="w-full py-3 px-4 bg-accent text-white font-medium rounded-lg
                         hover:bg-accent-hover transition-colors duration-200
                         focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2
                         focus:ring-offset-bg-primary"
            >
              Log In Again
            </button>

            {onDismiss && (
              <button
                onClick={onDismiss}
                className="w-full py-3 px-4 text-text-muted hover:text-text-primary
                           font-medium rounded-lg transition-colors duration-200
                           hover:bg-bg-secondary"
              >
                Dismiss
              </button>
            )}
          </div>

          {/* Help text */}
          <p className="text-xs text-text-muted text-center mt-4">
            You'll be redirected to the login page where you can sign in with GitHub.
          </p>
        </div>
      </div>
    </>
  );
}

export default SessionExpiredModal;
