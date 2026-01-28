/**
 * MessageInput Component
 *
 * Rich text input for sending messages with:
 * - @-mention autocomplete
 * - Multi-line support (Shift+Enter)
 * - Typing indicator
 * - Clipboard image pasting (Ctrl/Cmd+V)
 * - File attachment via button
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { api } from '../../lib/api';
import type { MessageInputProps } from './types';

const TYPING_DEBOUNCE_MS = 1000;

/**
 * Pending attachment state during upload
 */
interface PendingAttachment {
  id: string;
  file: File;
  preview: string;
  isUploading: boolean;
  uploadedId?: string;
  error?: string;
}

export function MessageInput({
  channelId,
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
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  // Process image files (used by both paste and file input)
  const processImageFiles = useCallback(async (imageFiles: File[]) => {
    for (const file of imageFiles) {
      const id = crypto.randomUUID();
      const preview = URL.createObjectURL(file);

      // Add to pending attachments
      setAttachments(prev => [...prev, {
        id,
        file,
        preview,
        isUploading: true,
      }]);

      // Upload the file
      try {
        const result = await api.uploadAttachment(file);
        if (result.success && result.data) {
          setAttachments(prev => prev.map(a =>
            a.id === id
              ? { ...a, isUploading: false, uploadedId: result.data!.attachment.id }
              : a
          ));
        } else {
          setAttachments(prev => prev.map(a =>
            a.id === id
              ? { ...a, isUploading: false, error: result.error || 'Upload failed' }
              : a
          ));
        }
      } catch {
        setAttachments(prev => prev.map(a =>
          a.id === id
            ? { ...a, isUploading: false, error: 'Upload failed' }
            : a
        ));
      }
    }
  }, []);

  // Handle clipboard paste for images
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return;

    let imageFiles: File[] = [];

    // Method 1: Check clipboardData.files (works for file pastes)
    if (clipboardData.files && clipboardData.files.length > 0) {
      imageFiles = Array.from(clipboardData.files).filter(file =>
        file.type.startsWith('image/')
      );
    }

    // Method 2: Check clipboardData.items (works for screenshots/copied images)
    if (imageFiles.length === 0 && clipboardData.items) {
      const items = Array.from(clipboardData.items);
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            imageFiles.push(file);
          }
        }
      }
    }

    // Process any found images
    if (imageFiles.length > 0) {
      e.preventDefault();
      processImageFiles(imageFiles);
    }
  }, [processImageFiles]);

  // Handle file selection from file input
  const handleFileSelect = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;

    const imageFiles = Array.from(files).filter(file =>
      file.type.startsWith('image/')
    );

    if (imageFiles.length > 0) {
      processImageFiles(imageFiles);
    }
  }, [processImageFiles]);

  // Remove an attachment
  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => {
      const attachment = prev.find(a => a.id === id);
      if (attachment) {
        URL.revokeObjectURL(attachment.preview);
      }
      return prev.filter(a => a.id !== id);
    });
  }, []);

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

  // Handle send
  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    const hasAttachmentContent = attachments.length > 0;

    if ((!trimmed && !hasAttachmentContent) || disabled) return;

    // Check if any attachments are still uploading
    const stillUploading = attachments.some(a => a.isUploading);
    if (stillUploading) return;

    // Get uploaded attachment IDs
    const attachmentIds = attachments
      .filter(a => a.uploadedId)
      .map(a => a.uploadedId!);

    // If no message but has attachments, send with default text
    const content = trimmed || (attachmentIds.length > 0 ? '[Screenshot attached]' : '');
    if (!content) return;

    onSend(content, attachmentIds.length > 0 ? attachmentIds : undefined);
    setValue('');
    handleTyping(false);

    // Clean up attachment previews
    attachments.forEach(a => URL.revokeObjectURL(a.preview));
    setAttachments([]);

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, disabled, onSend, handleTyping, attachments]);

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
  }, [showMentions, filteredMentions, selectedMentionIndex, insertMention, handleSend]);

  // Check if we can send
  const canSend = (value.trim() || attachments.length > 0) &&
    !disabled &&
    !attachments.some(a => a.isUploading);

  return (
    <div className="relative flex-shrink-0 border-t border-border-subtle bg-bg-primary">
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

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="px-4 pt-3">
          <div className="flex flex-wrap gap-2 p-2 bg-bg-tertiary rounded-lg border border-border-subtle">
            {attachments.map(attachment => (
              <div key={attachment.id} className="relative group">
                <img
                  src={attachment.preview}
                  alt={attachment.file.name}
                  className={`h-16 w-auto rounded-lg object-cover ${attachment.isUploading ? 'opacity-50' : ''} ${attachment.error ? 'border-2 border-red-500' : ''}`}
                />
                {attachment.isUploading && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <svg className="animate-spin h-5 w-5 text-accent-cyan" viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" strokeDasharray="32" strokeLinecap="round" />
                    </svg>
                  </div>
                )}
                {attachment.error && (
                  <div className="absolute bottom-0 left-0 right-0 bg-red-600/90 text-white text-[10px] px-1 py-0.5 truncate">
                    {attachment.error}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removeAttachment(attachment.id)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-bg-tertiary border border-border-subtle rounded-full flex items-center justify-center text-text-muted hover:text-red-500 hover:border-red-500 transition-colors opacity-0 group-hover:opacity-100"
                  title="Remove"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Input area */}
      <div className="p-4">
        <div className="flex items-end gap-3">
          {/* Attachment button */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => handleFileSelect(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
            title="Attach image (or paste from clipboard)"
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
              onPaste={handlePaste}
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
            disabled={!canSend}
            className={`
              p-2.5 rounded-lg transition-colors flex-shrink-0
              ${canSend
                ? 'bg-accent-cyan text-bg-deep hover:bg-accent-cyan/90'
                : 'bg-bg-tertiary text-text-muted cursor-not-allowed'}
            `}
            title={attachments.some(a => a.isUploading) ? 'Uploading...' : 'Send message'}
          >
            <SendIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Helper text */}
        <p className="mt-2 text-xs text-text-muted">
          <kbd className="px-1 py-0.5 bg-bg-tertiary rounded text-[10px]">Enter</kbd> to send,{' '}
          <kbd className="px-1 py-0.5 bg-bg-tertiary rounded text-[10px]">Shift+Enter</kbd> for new line,{' '}
          <kbd className="px-1 py-0.5 bg-bg-tertiary rounded text-[10px]">@</kbd> to mention,{' '}
          <kbd className="px-1 py-0.5 bg-bg-tertiary rounded text-[10px]">Ctrl+V</kbd> to paste images
        </p>
      </div>
    </div>
  );
}

// =============================================================================
// Icons
// =============================================================================

function AttachIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
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
