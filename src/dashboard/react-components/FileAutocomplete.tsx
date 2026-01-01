/**
 * FileAutocomplete Component
 *
 * Provides @-file autocomplete for the message composer.
 * Shows a dropdown list of files when typing @ followed by a path pattern.
 * Triggered by @path/to/file or @filename patterns containing / or .
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';

export interface FileAutocompleteProps {
  /** Current input value */
  inputValue: string;
  /** Cursor position in input */
  cursorPosition: number;
  /** Called when a file is selected */
  onSelect: (filePath: string, newValue: string) => void;
  /** Called when autocomplete should be hidden */
  onClose: () => void;
  /** Whether the autocomplete is visible */
  isVisible: boolean;
  /** API base URL for fetching files */
  apiBase?: string;
}

interface FileOption {
  path: string;
  name: string;
  isDirectory: boolean;
}

/**
 * Check if the input has an @-file path being typed at the cursor position.
 * Returns the query if it looks like a file path.
 * Works for @ at any position in the text, not just the start.
 *
 * Trigger conditions (to avoid conflict with agent mentions):
 * - Contains `/` (path separator) - e.g., @src/components
 * - Contains `.` with more characters after (file extension) - e.g., @package.json
 * - Starts with `./` or `../` (relative path) - e.g., @./src
 *
 * Does NOT trigger for:
 * - Simple names like @Alice (could be an agent name)
 * - Names with trailing dot like @config. (user still typing)
 */
export function getFileQuery(value: string, cursorPos: number): string | null {
  // Search backwards from cursor to find @
  const textBeforeCursor = value.substring(0, cursorPos);

  // Find the last @ before cursor that starts a mention
  // A mention starts after whitespace, at start of string, or after certain punctuation
  const mentionMatch = textBeforeCursor.match(/(?:^|[\s(])@(\S*)$/);
  if (mentionMatch) {
    const query = mentionMatch[1];

    // Trigger file autocomplete only for unambiguous file patterns:
    // 1. Contains path separator: @src/components, @./file
    if (query.includes('/')) {
      return query;
    }

    // 2. Has file extension (dot followed by 1-10 chars): @file.ts, @package.json
    // But not just a trailing dot (user still typing)
    if (/\.[a-zA-Z0-9]{1,10}$/.test(query)) {
      return query;
    }
  }
  return null;
}

/**
 * Complete a file path in the input value at the cursor position.
 */
export function completeFileInValue(
  value: string,
  filePath: string,
  cursorPos: number
): string {
  const textBeforeCursor = value.substring(0, cursorPos);
  const textAfterCursor = value.substring(cursorPos);

  // Find the @ and partial text before cursor
  const mentionMatch = textBeforeCursor.match(/(?:^|[\s(])@(\S*)$/);
  if (mentionMatch) {
    // Calculate where the @ starts (accounting for whitespace/punctuation before it)
    const matchStart = mentionMatch.index || 0;
    const prefixChar = mentionMatch[0].charAt(0);
    const atStart = prefixChar === '@' ? matchStart : matchStart + 1;

    // Build the new value
    const beforeMention = value.substring(0, atStart);
    const completedFile = `@${filePath} `;
    return beforeMention + completedFile + textAfterCursor;
  }
  return value;
}

// Cache for file search results
const fileCache = new Map<string, { files: FileOption[]; timestamp: number }>();
const CACHE_TTL_MS = 30000; // 30 seconds cache

export function FileAutocomplete({
  inputValue,
  cursorPosition,
  onSelect,
  onClose,
  isVisible,
  apiBase = '',
}: FileAutocompleteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [files, setFiles] = useState<FileOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Get the current file query
  const query = useMemo(
    () => getFileQuery(inputValue, cursorPosition),
    [inputValue, cursorPosition]
  );

  // Fetch files when query changes
  useEffect(() => {
    if (!isVisible || query === null) {
      setFiles([]);
      return;
    }

    // Check cache first
    const cacheKey = query || '__root__';
    const cached = fileCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      setFiles(cached.files);
      setError(null);
      return;
    }

    // Cancel previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const fetchFiles = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const searchQuery = query || '';
        const response = await fetch(
          `${apiBase}/api/files?q=${encodeURIComponent(searchQuery)}&limit=15`,
          { signal: controller.signal }
        );

        if (!response.ok) {
          throw new Error('Failed to fetch files');
        }

        const data = await response.json();
        const fileList: FileOption[] = (data.files || []).map((f: { path: string; name: string; isDirectory?: boolean }) => ({
          path: f.path,
          name: f.name,
          isDirectory: f.isDirectory || false,
        }));

        // Update cache
        fileCache.set(cacheKey, { files: fileList, timestamp: Date.now() });
        setFiles(fileList);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError('Failed to load files');
        setFiles([]);
      } finally {
        setIsLoading(false);
      }
    };

    // Debounce the search
    const timeoutId = setTimeout(fetchFiles, 150);
    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [isVisible, query, apiBase]);

  // Reset selection when files change
  useEffect(() => {
    setSelectedIndex(0);
  }, [files.length]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('[data-selected="true"]');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isVisible || files.length === 0) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % files.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + files.length) % files.length);
          break;
        case 'Enter':
        case 'Tab':
          e.preventDefault();
          const selected = files[selectedIndex];
          if (selected) {
            const newValue = completeFileInValue(inputValue, selected.path, cursorPosition);
            onSelect(selected.path, newValue);
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [isVisible, files, selectedIndex, inputValue, cursorPosition, onSelect, onClose]
  );

  // Register keyboard listener
  useEffect(() => {
    if (isVisible) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isVisible, handleKeyDown]);

  // Handle click on option
  const handleClick = useCallback(
    (file: FileOption) => {
      const newValue = completeFileInValue(inputValue, file.path, cursorPosition);
      onSelect(file.path, newValue);
    },
    [inputValue, cursorPosition, onSelect]
  );

  if (!isVisible || (files.length === 0 && !isLoading && !error)) {
    return null;
  }

  return (
    <div
      className="absolute bottom-full left-0 right-0 max-h-[240px] overflow-y-auto bg-[#1a1d21] border border-white/10 rounded-lg shadow-[0_-4px_20px_rgba(0,0,0,0.4)] z-[100] mb-1"
      ref={listRef}
    >
      {/* Header */}
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-[#8d8d8e] border-b border-white/5 flex items-center gap-2">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <polyline points="13 2 13 9 20 9" />
        </svg>
        Files {query && <span className="text-[#6b6b6c]">matching "{query}"</span>}
      </div>

      {/* Loading state */}
      {isLoading && files.length === 0 && (
        <div className="px-3 py-4 text-sm text-[#8d8d8e] text-center">
          <svg className="animate-spin mx-auto mb-2" width="16" height="16" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" strokeDasharray="32" strokeLinecap="round" />
          </svg>
          Searching files...
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="px-3 py-4 text-sm text-red-400 text-center">
          {error}
        </div>
      )}

      {/* File list */}
      {files.map((file, index) => (
        <div
          key={file.path}
          data-selected={index === selectedIndex}
          className={`flex items-center gap-2.5 py-2 px-3 cursor-pointer transition-colors duration-150 ${
            index === selectedIndex ? 'bg-white/[0.08]' : 'hover:bg-white/[0.08]'
          }`}
          onClick={() => handleClick(file)}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          {/* File/Folder icon */}
          <div
            className="w-7 h-7 rounded-md flex items-center justify-center text-[#8d8d8e]"
            style={{ background: file.isDirectory ? 'rgba(251, 191, 36, 0.15)' : 'rgba(96, 165, 250, 0.15)' }}
          >
            {file.isDirectory ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2">
                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                <polyline points="13 2 13 9 20 9" />
              </svg>
            )}
          </div>
          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
            <span className="text-sm font-medium text-[#d1d2d3] truncate">{file.name}</span>
            <span className="text-xs text-[#6b6b6c] truncate">{file.path}</span>
          </div>
        </div>
      ))}

      {/* Empty state (no results after search) */}
      {!isLoading && !error && files.length === 0 && query && (
        <div className="px-3 py-4 text-sm text-[#8d8d8e] text-center">
          No files found matching "{query}"
        </div>
      )}
    </div>
  );
}

/**
 * Hook to manage file autocomplete state
 */
export function useFileAutocomplete() {
  const [isVisible, setIsVisible] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);

  const handleInputChange = useCallback((value: string, cursorPos: number) => {
    setInputValue(value);
    setCursorPosition(cursorPos);

    // Show autocomplete if typing @file pattern
    const query = getFileQuery(value, cursorPos);
    setIsVisible(query !== null);
  }, []);

  const handleSelect = useCallback((filePath: string, newValue: string) => {
    setInputValue(newValue);
    setCursorPosition(newValue.indexOf(' ') + 1);
    setIsVisible(false);
  }, []);

  const handleClose = useCallback(() => {
    setIsVisible(false);
  }, []);

  return {
    isVisible,
    inputValue,
    cursorPosition,
    setInputValue: handleInputChange,
    handleSelect,
    handleClose,
  };
}
