/**
 * MessageInput Component
 *
 * Rich text input for sending messages with:
 * - @-mention autocomplete
 * - Multi-line support (Shift+Enter)
 * - Typing indicator
 * - File attachment button (UI only)
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { MessageInputProps } from './types';

const TYPING_DEBOUNCE_MS = 1000;

export function MessageInput({
  channelId,
  threadId,
  placeholder = 'Send a message...',
  disabled = false,
  onSend,
  onTyping,
  mentionSuggestions = [],
}: MessageInputProps) {
  const [value, setValue] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const [cursorPosition, setCursorPosition] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const wasTypingRef = useRef(false);

  // Filter mention suggestions based on query
  const filteredMentions = useMemo(() => {
    if (!mentionQuery) return mentionSuggestions.slice(0, 5);
    const query = mentionQuery.toLowerCase();
    return mentionSuggestions
      .filter(name => name.toLowerCase().includes(query))
      .slice(0, 5);
  }, [mentionSuggestions, mentionQuery]);

  // Handle typing indicator
  const handleTyping = useCallback((isTyping: boolean) => {
    if (!onTyping) return;

    if (isTyping && !wasTypingRef.current) {
      wasTypingRef.current = true;
      onTyping(true);
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    if (isTyping) {
      typingTimeoutRef.current = setTimeout(() => {
        wasTypingRef.current = false;
        onTyping(false);
      }, TYPING_DEBOUNCE_MS);
    } else {
      wasTypingRef.current = false;
      onTyping(false);
    }
  }, [onTyping]);

  // Clean up typing indicator on unmount
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      if (wasTypingRef.current && onTyping) {
        onTyping(false);
      }
    };
  }, [onTyping]);

  // Handle value change
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const newPosition = e.target.selectionStart;

    setValue(newValue);
    setCursorPosition(newPosition);
    handleTyping(newValue.length > 0);

    // Check for mention trigger
    const textBeforeCursor = newValue.slice(0, newPosition);
    const mentionMatch = textBeforeCursor.match(/@(\w*)$/);

    if (mentionMatch) {
      setMentionQuery(mentionMatch[1]);
      setShowMentions(true);
      setSelectedMentionIndex(0);
    } else {
      setShowMentions(false);
      setMentionQuery('');
    }

    // Auto-resize textarea
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [handleTyping]);

  // Insert mention at cursor
  const insertMention = useCallback((name: string) => {
    const textBeforeCursor = value.slice(0, cursorPosition);
    const textAfterCursor = value.slice(cursorPosition);

    // Find the @ trigger position
    const mentionMatch = textBeforeCursor.match(/@(\w*)$/);
    if (!mentionMatch) return;

    const beforeMention = textBeforeCursor.slice(0, -mentionMatch[0].length);
    const newValue = `${beforeMention}@${name} ${textAfterCursor}`;

    setValue(newValue);
    setShowMentions(false);
    setMentionQuery('');

    // Focus and set cursor position
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const newPosition = beforeMention.length + name.length + 2; // @ + name + space
        textareaRef.current.setSelectionRange(newPosition, newPosition);
        setCursorPosition(newPosition);
      }
    }, 0);
  }, [value, cursorPosition]);

  // Handle keyboard navigation in mention list
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (showMentions && filteredMentions.length > 0) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedMentionIndex(prev =>
            prev < filteredMentions.length - 1 ? prev + 1 : 0
          );
          return;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedMentionIndex(prev =>
            prev > 0 ? prev - 1 : filteredMentions.length - 1
          );
          return;
        case 'Tab':
        case 'Enter':
          e.preventDefault();
          insertMention(filteredMentions[selectedMentionIndex]);
          return;
        case 'Escape':
          e.preventDefault();
          setShowMentions(false);
          return;
      }
    }

    // Send on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [showMentions, filteredMentions, selectedMentionIndex, insertMention]);

  // Handle send
  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;

    onSend(trimmed);
    setValue('');
    handleTyping(false);

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, disabled, onSend, handleTyping]);

  return (
    <div className="relative flex-shrink-0 border-t border-border-subtle bg-bg-primary">
      {/* Thread indicator */}
      {threadId && (
        <div className="px-4 py-2 bg-bg-secondary/50 border-b border-border-subtle flex items-center gap-2">
          <ThreadIcon className="w-4 h-4 text-accent-cyan" />
          <span className="text-xs text-text-muted">Replying in thread</span>
        </div>
      )}

      {/* Mention autocomplete */}
      {showMentions && filteredMentions.length > 0 && (
        <div className="absolute bottom-full left-4 mb-1 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg py-1 min-w-[200px] max-h-[200px] overflow-y-auto">
          {filteredMentions.map((name, index) => (
            <button
              key={name}
              onClick={() => insertMention(name)}
              className={`
                w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors
                ${index === selectedMentionIndex
                  ? 'bg-accent-cyan/10 text-text-primary'
                  : 'text-text-secondary hover:bg-bg-hover'}
              `}
            >
              <div className="w-6 h-6 rounded-full bg-accent-cyan/20 flex items-center justify-center text-xs font-medium text-accent-cyan">
                {name.charAt(0).toUpperCase()}
              </div>
              <span>{name}</span>
            </button>
          ))}
        </div>
      )}

      {/* Input area */}
      <div className="p-4">
        <div className="flex items-end gap-3">
          {/* Attachment button */}
          <button
            type="button"
            disabled={disabled}
            className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
            title="Attach file"
          >
            <AttachIcon className="w-5 h-5" />
          </button>

          {/* Text input */}
          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={disabled}
              rows={1}
              className="w-full px-4 py-2.5 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary text-sm resize-none focus:outline-none focus:border-accent-cyan/50 disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-text-muted"
              style={{ maxHeight: '200px' }}
            />
          </div>

          {/* Send button */}
          <button
            type="button"
            onClick={handleSend}
            disabled={!value.trim() || disabled}
            className={`
              p-2.5 rounded-lg transition-colors flex-shrink-0
              ${value.trim() && !disabled
                ? 'bg-accent-cyan text-bg-deep hover:bg-accent-cyan/90'
                : 'bg-bg-tertiary text-text-muted cursor-not-allowed'}
            `}
            title="Send message"
          >
            <SendIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Helper text */}
        <p className="mt-2 text-xs text-text-muted">
          <kbd className="px-1 py-0.5 bg-bg-tertiary rounded text-[10px]">Enter</kbd> to send,{' '}
          <kbd className="px-1 py-0.5 bg-bg-tertiary rounded text-[10px]">Shift+Enter</kbd> for new line,{' '}
          <kbd className="px-1 py-0.5 bg-bg-tertiary rounded text-[10px]">@</kbd> to mention
        </p>
      </div>
    </div>
  );
}

// =============================================================================
// Icons
// =============================================================================

function ThreadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M8 9h8" />
      <path d="M8 13h6" />
    </svg>
  );
}

function AttachIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

export default MessageInput;
