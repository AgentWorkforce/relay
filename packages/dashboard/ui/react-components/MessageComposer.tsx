/**
 * MessageComposer - Shared message input component with attachment support
 *
 * Features:
 * - Image paste from clipboard
 * - File upload via button
 * - @-mention autocomplete (optional)
 * - File path autocomplete (optional)
 * - Typing indicator support
 * - Multi-line support (Shift+Enter)
 *
 * Used by both DMs and Channels for consistent messaging experience.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { api } from '../lib/api';
import { MentionAutocomplete, getMentionQuery, type HumanUser } from './MentionAutocomplete';
import { FileAutocomplete, getFileQuery } from './FileAutocomplete';
import type { Agent } from '../types';

/**
 * Pending attachment state during upload
 */
export interface PendingAttachment {
  id: string;
  file: File;
  preview: string;
  isUploading: boolean;
  uploadedId?: string;
  error?: string;
}

/**
 * Props for the MessageComposer component
 */
export interface MessageComposerProps {
  /** Called when user sends a message */
  onSend: (content: string, attachmentIds?: string[]) => Promise<boolean>;
  /** Called when typing state changes */
  onTyping?: (isTyping: boolean) => void;
  /** Whether a send is in progress */
  isSending?: boolean;
  /** Whether input is disabled */
  disabled?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Error message to display */
  error?: string | null;
  /** Agent list for @-mention autocomplete */
  agents?: Agent[];
  /** Human user list for @-mention autocomplete */
  humanUsers?: HumanUser[];
  /** Enable file path autocomplete */
  enableFileAutocomplete?: boolean;
  /** Mention to insert (triggered externally) */
  insertMention?: string;
  /** Called after mention is inserted */
  onMentionInserted?: () => void;
  /** Custom class for the form container */
  className?: string;
}

export function MessageComposer({
  onSend,
  onTyping,
  isSending = false,
  disabled = false,
  placeholder = 'Type a message...',
  error,
  agents = [],
  humanUsers = [],
  enableFileAutocomplete = false,
  insertMention,
  onMentionInserted,
  className = '',
}: MessageComposerProps) {
  const [message, setMessage] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const [showMentions, setShowMentions] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handle insertMention prop - insert @username when triggered from outside
  useEffect(() => {
    if (insertMention && onMentionInserted) {
      const mentionText = `@${insertMention} `;
      const textarea = textareaRef.current;
      if (textarea) {
        const start = textarea.selectionStart || message.length;
        const newMessage = message.slice(0, start) + mentionText + message.slice(start);
        setMessage(newMessage);
        setTimeout(() => {
          textarea.focus();
          const newPos = start + mentionText.length;
          textarea.setSelectionRange(newPos, newPos);
        }, 0);
      } else {
        setMessage(prev => prev + mentionText);
      }
      onMentionInserted();
    }
  }, [insertMention, onMentionInserted, message]);

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
      } catch (err) {
        setAttachments(prev => prev.map(a =>
          a.id === id
            ? { ...a, isUploading: false, error: 'Upload failed' }
            : a
        ));
      }
    }
  }, []);

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

  // Handle paste for clipboard images
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

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart || 0;
    setMessage(value);
    setCursorPosition(cursorPos);

    // Send typing indicator when user has content
    onTyping?.(value.trim().length > 0);

    // Check for file autocomplete first (@ followed by path-like pattern)
    if (enableFileAutocomplete) {
      const fileQuery = getFileQuery(value, cursorPos);
      if (fileQuery !== null) {
        setShowFiles(true);
        setShowMentions(false);
        return;
      }
    }

    // Check for mention autocomplete (@ at start without path patterns)
    if (agents.length > 0 || humanUsers.length > 0) {
      const mentionQuery = getMentionQuery(value, cursorPos);
      if (mentionQuery !== null) {
        setShowMentions(true);
        setShowFiles(false);
        return;
      }
    }

    // Neither - hide both
    setShowMentions(false);
    setShowFiles(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Don't handle Enter/Tab when autocomplete is visible
    if ((showMentions || showFiles) && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab')) {
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && !showMentions && !showFiles) {
      e.preventDefault();
      if ((message.trim() || attachments.length > 0) && !isSending && !disabled) {
        handleSubmit(e as unknown as React.FormEvent);
      }
    }
  };

  const handleMentionSelect = (mention: string, newValue: string) => {
    setMessage(newValue);
    setShowMentions(false);
    setShowFiles(false);
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const pos = newValue.indexOf(' ') + 1;
        textareaRef.current.setSelectionRange(pos, pos);
      }
    }, 0);
  };

  const handleFilePathSelect = (filePath: string, newValue: string) => {
    setMessage(newValue);
    setShowFiles(false);
    setShowMentions(false);
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const pos = newValue.indexOf(' ', 1) + 1;
        textareaRef.current.setSelectionRange(pos, pos);
      }
    }, 0);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const hasMessage = message.trim().length > 0;
    const hasAttachments = attachments.length > 0;
    if ((!hasMessage && !hasAttachments) || isSending || disabled) return;

    // Check if any attachments are still uploading
    const stillUploading = attachments.some(a => a.isUploading);
    if (stillUploading) return;

    // Get uploaded attachment IDs
    const attachmentIds = attachments
      .filter(a => a.uploadedId)
      .map(a => a.uploadedId!);

    // If no message but has attachments, send with default text
    let content = message.trim();
    if (!content && attachmentIds.length > 0) {
      content = '[Screenshot attached]';
    }

    const success = await onSend(
      content,
      attachmentIds.length > 0 ? attachmentIds : undefined
    );

    if (success) {
      // Clean up previews
      attachments.forEach(a => URL.revokeObjectURL(a.preview));
      setMessage('');
      setAttachments([]);
      setShowMentions(false);
      setShowFiles(false);
    }
  };

  // Check if we can send
  const canSend = (message.trim() || attachments.length > 0) &&
    !isSending &&
    !disabled &&
    !attachments.some(a => a.isUploading);

  return (
    <form className={`flex flex-col gap-1.5 sm:gap-2 ${className}`} onSubmit={handleSubmit}>
      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 sm:gap-2 p-1.5 sm:p-2 bg-bg-card rounded-lg border border-border-subtle">
          {attachments.map(attachment => (
            <div key={attachment.id} className="relative group">
              <img
                src={attachment.preview}
                alt={attachment.file.name}
                className={`h-16 w-auto rounded-lg object-cover ${attachment.isUploading ? 'opacity-50' : ''} ${attachment.error ? 'border-2 border-error' : ''}`}
              />
              {attachment.isUploading && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <svg className="animate-spin h-5 w-5 text-accent-cyan" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" strokeDasharray="32" strokeLinecap="round" />
                  </svg>
                </div>
              )}
              {attachment.error && (
                <div className="absolute bottom-0 left-0 right-0 bg-error/90 text-white text-[10px] px-1 py-0.5 truncate">
                  {attachment.error}
                </div>
              )}
              <button
                type="button"
                onClick={() => removeAttachment(attachment.id)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-bg-tertiary border border-border-subtle rounded-full flex items-center justify-center text-text-muted hover:text-error hover:border-error transition-colors opacity-0 group-hover:opacity-100"
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
      )}

      {/* Input row */}
      <div className="flex items-center gap-1.5 sm:gap-3">
        {/* Image upload button */}
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
          className="p-2 sm:p-2.5 bg-bg-card border border-border-subtle rounded-lg sm:rounded-xl text-text-muted hover:text-accent-cyan hover:border-accent-cyan/50 transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
          title="Attach screenshot (or paste from clipboard)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="sm:w-[18px] sm:h-[18px]">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </button>

        <div className="flex-1 relative min-w-0">
          {/* Agent mention autocomplete */}
          {(agents.length > 0 || humanUsers.length > 0) && (
            <MentionAutocomplete
              agents={agents}
              humanUsers={humanUsers}
              inputValue={message}
              cursorPosition={cursorPosition}
              onSelect={handleMentionSelect}
              onClose={() => setShowMentions(false)}
              isVisible={showMentions}
            />
          )}
          {/* File path autocomplete */}
          {enableFileAutocomplete && (
            <FileAutocomplete
              inputValue={message}
              cursorPosition={cursorPosition}
              onSelect={handleFilePathSelect}
              onClose={() => setShowFiles(false)}
              isVisible={showFiles}
            />
          )}
          <textarea
            ref={textareaRef}
            className="w-full py-2 sm:py-3 px-3 sm:px-4 bg-bg-card border border-border-subtle rounded-lg sm:rounded-xl text-sm font-sans text-text-primary outline-none transition-all duration-200 resize-none min-h-[40px] sm:min-h-[44px] max-h-[100px] sm:max-h-[120px] overflow-y-auto focus:border-accent-cyan/50 focus:shadow-[0_0_0_3px_rgba(0,217,255,0.1)] placeholder:text-text-muted disabled:opacity-50 disabled:cursor-not-allowed"
            placeholder={placeholder}
            value={message}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onSelect={(e) => setCursorPosition((e.target as HTMLTextAreaElement).selectionStart || 0)}
            disabled={disabled || isSending}
            rows={1}
          />
        </div>
        <button
          type="submit"
          className="py-2 sm:py-3 px-3 sm:px-5 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold border-none rounded-lg sm:rounded-xl text-xs sm:text-sm cursor-pointer transition-all duration-150 hover:shadow-glow-cyan hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none flex-shrink-0"
          disabled={!canSend}
          title={isSending ? 'Sending...' : attachments.some(a => a.isUploading) ? 'Uploading...' : 'Send message'}
        >
          {isSending ? (
            <span className="hidden sm:inline">Sending...</span>
          ) : attachments.some(a => a.isUploading) ? (
            <span className="hidden sm:inline">Uploading...</span>
          ) : (
            <span className="flex items-center gap-1 sm:gap-2">
              <span className="hidden sm:inline">Send</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
            </span>
          )}
        </button>
        {error && <span className="text-error text-xs ml-2">{error}</span>}
      </div>

      {/* Helper text */}
      <p className="text-xs text-text-muted px-1">
        <kbd className="px-1 py-0.5 bg-bg-tertiary rounded text-[10px]">Enter</kbd> to send,{' '}
        <kbd className="px-1 py-0.5 bg-bg-tertiary rounded text-[10px]">Shift+Enter</kbd> for new line
        {(agents.length > 0 || humanUsers.length > 0) && (
          <>, <kbd className="px-1 py-0.5 bg-bg-tertiary rounded text-[10px]">@</kbd> to mention</>
        )}
      </p>
    </form>
  );
}

export default MessageComposer;
