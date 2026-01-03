/**
 * MessageStatusIndicator Component
 *
 * Shows the delivery status of a message:
 * - Sending/Unread: Animated clock/pending icon
 * - Acked/Read: Checkmark icon (success)
 * - Failed: Exclamation icon (error - NACK or timeout)
 *
 * Used to indicate when a message was received by an agent
 * before they start responding (fills the gap before ThinkingIndicator).
 */

import React from 'react';
import type { MessageStatus } from '../types';

export interface MessageStatusIndicatorProps {
  /** Message delivery status */
  status?: MessageStatus;
  /** Size variant */
  size?: 'small' | 'medium';
}

export function MessageStatusIndicator({
  status,
  size = 'small',
}: MessageStatusIndicatorProps) {
  // Don't show anything if no status
  if (!status) return null;

  const sizeClasses = {
    small: 'w-3.5 h-3.5',
    medium: 'w-4 h-4',
  };

  const sizeClass = sizeClasses[size];

  // Sending/Unread - show pending indicator
  if (status === 'sending' || status === 'unread') {
    return (
      <span
        className={`inline-flex items-center justify-center ${sizeClass} text-text-muted`}
        title="Sending..."
      >
        <SendingIcon className={sizeClass} />
      </span>
    );
  }

  // Acked/Read - show checkmark
  if (status === 'acked' || status === 'read') {
    return (
      <span
        className={`inline-flex items-center justify-center ${sizeClass} text-success`}
        title="Delivered"
      >
        <CheckIcon className={sizeClass} />
      </span>
    );
  }

  // Failed - show error indicator
  if (status === 'failed') {
    return (
      <span
        className={`inline-flex items-center justify-center ${sizeClass} text-error`}
        title="Delivery failed"
      >
        <FailedIcon className={sizeClass} />
      </span>
    );
  }

  return null;
}

function SendingIcon({ className }: { className?: string }) {
  return (
    <svg
      className={`animate-pulse ${className}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      {/* Clock/pending icon */}
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3l2 1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      {/* Single checkmark for delivered */}
      <path d="M3 8l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FailedIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      {/* Exclamation mark in circle for failed delivery */}
      <circle cx="8" cy="8" r="6" />
      <line x1="8" y1="5" x2="8" y2="8" strokeLinecap="round" />
      <circle cx="8" cy="11" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Double checkmark variant for when message has been read
 * (not currently used, but available for future enhancement)
 */
export function DoubleCheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      {/* Double checkmark for read */}
      <path d="M1 8l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 8l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
