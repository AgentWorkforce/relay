/**
 * SearchInput Component
 *
 * Search query input with debounce for channel message search.
 * Supports workspace-wide and channel-scoped search.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { SearchInputProps } from './types';

const DEFAULT_DEBOUNCE_MS = 300;

export function SearchInput({
  initialQuery = '',
  placeholder = 'Search messages...',
  debounceMs = DEFAULT_DEBOUNCE_MS,
  isSearching = false,
  onSearch,
  onClear,
  channelId,
}: SearchInputProps) {
  const [value, setValue] = useState(initialQuery);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced search handler
  const debouncedSearch = useCallback((query: string) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      onSearch(query);
    }, debounceMs);
  }, [onSearch, debounceMs]);

  // Handle input change
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setValue(newValue);

    if (newValue.trim()) {
      debouncedSearch(newValue.trim());
    } else {
      // Clear immediately when empty
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      onClear?.();
    }
  }, [debouncedSearch, onClear]);

  // Handle clear button
  const handleClear = useCallback(() => {
    setValue('');
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    onClear?.();
    inputRef.current?.focus();
  }, [onClear]);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleClear();
    } else if (e.key === 'Enter') {
      // Trigger search immediately on Enter
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      if (value.trim()) {
        onSearch(value.trim());
      }
    }
  }, [handleClear, onSearch, value]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  return (
    <div className="relative">
      {/* Search icon */}
      <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
        <SearchIcon className="w-4 h-4 text-text-muted" />
      </div>

      {/* Input field */}
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="w-full pl-10 pr-10 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent-cyan/50 placeholder:text-text-muted"
      />

      {/* Clear/Loading indicator */}
      <div className="absolute right-3 top-1/2 -translate-y-1/2">
        {isSearching ? (
          <LoadingSpinner className="w-4 h-4 text-accent-cyan" />
        ) : value ? (
          <button
            onClick={handleClear}
            className="p-0.5 rounded text-text-muted hover:text-text-primary transition-colors"
            title="Clear search"
          >
            <CloseIcon className="w-4 h-4" />
          </button>
        ) : null}
      </div>

      {/* Channel scope indicator */}
      {channelId && (
        <div className="absolute -top-6 left-0 text-xs text-text-muted">
          Searching in #{channelId.replace('#', '')}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Icons
// =============================================================================

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function LoadingSpinner({ className }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

export default SearchInput;
