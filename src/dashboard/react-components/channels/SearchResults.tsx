/**
 * SearchResults Component
 *
 * Displays search results with highlighted snippets and pagination.
 * Supports clicking to navigate to specific messages.
 */

import React, { useMemo, useCallback } from 'react';
import type { SearchResultsProps, SearchResult } from './types';

export function SearchResults({
  results,
  total,
  query,
  isLoading = false,
  hasMore = false,
  error,
  onLoadMore,
  onResultClick,
}: SearchResultsProps) {
  // Format relative time
  const formatTime = useCallback((timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }, []);

  // Error state
  if (error) {
    return (
      <div className="p-6 text-center">
        <ErrorIcon className="w-8 h-8 text-red-400 mx-auto mb-2" />
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  // Loading state (initial)
  if (isLoading && results.length === 0) {
    return (
      <div className="p-6 text-center">
        <LoadingSpinner className="w-6 h-6 text-accent-cyan mx-auto mb-2" />
        <p className="text-sm text-text-muted">Searching...</p>
      </div>
    );
  }

  // Empty state
  if (!isLoading && results.length === 0 && query) {
    return (
      <div className="p-6 text-center">
        <SearchIcon className="w-8 h-8 text-text-muted mx-auto mb-2" />
        <p className="text-sm text-text-muted">No results found for "{query}"</p>
        <p className="text-xs text-text-muted mt-1">Try different keywords</p>
      </div>
    );
  }

  // No query state
  if (results.length === 0 && !query) {
    return (
      <div className="p-6 text-center">
        <SearchIcon className="w-8 h-8 text-text-muted mx-auto mb-2" />
        <p className="text-sm text-text-muted">Enter a search term to find messages</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Results count */}
      <div className="px-4 py-2 border-b border-border-subtle bg-bg-secondary/50">
        <p className="text-xs text-text-muted">
          {total === 1 ? '1 result' : `${total} results`} for "{query}"
        </p>
      </div>

      {/* Results list */}
      <div className="flex-1 overflow-y-auto">
        {results.map((result) => (
          <SearchResultItem
            key={result.id}
            result={result}
            query={query}
            formatTime={formatTime}
            onClick={onResultClick}
          />
        ))}

        {/* Load more button */}
        {hasMore && (
          <div className="p-4 text-center border-t border-border-subtle">
            <button
              onClick={onLoadMore}
              disabled={isLoading}
              className="px-4 py-2 text-sm text-accent-cyan hover:text-accent-cyan/80 disabled:opacity-50 transition-colors"
            >
              {isLoading ? (
                <span className="flex items-center gap-2 justify-center">
                  <LoadingSpinner className="w-4 h-4" />
                  Loading more...
                </span>
              ) : (
                `Load more results`
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Search Result Item
// =============================================================================

interface SearchResultItemProps {
  result: SearchResult;
  query: string;
  formatTime: (timestamp: string) => string;
  onClick?: (result: SearchResult) => void;
}

function SearchResultItem({ result, query, formatTime, onClick }: SearchResultItemProps) {
  const handleClick = useCallback(() => {
    onClick?.(result);
  }, [onClick, result]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.(result);
    }
  }, [onClick, result]);

  return (
    <div
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      className="p-4 border-b border-border-subtle hover:bg-bg-hover cursor-pointer transition-colors focus:outline-none focus:bg-bg-hover"
    >
      {/* Header: channel + timestamp */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-accent-cyan">
            #{result.channelName}
          </span>
          <span className="text-xs text-text-muted">•</span>
          <span className="text-xs text-text-muted">
            {result.from}
          </span>
        </div>
        <span className="text-xs text-text-muted">
          {formatTime(result.timestamp)}
        </span>
      </div>

      {/* Highlighted snippet */}
      <div className="text-sm text-text-secondary">
        <HighlightedSnippet text={result.snippet} query={query} />
      </div>
    </div>
  );
}

// =============================================================================
// Highlighted Snippet Component
// =============================================================================

interface HighlightedSnippetProps {
  text: string;
  query: string;
}

function HighlightedSnippet({ text, query }: HighlightedSnippetProps) {
  const parts = useMemo(() => {
    if (!query.trim()) {
      return [{ text, highlight: false }];
    }

    // Check if text already contains <b> tags from backend highlighting
    if (text.includes('<b>') && text.includes('</b>')) {
      // Parse backend-highlighted text
      const segments: { text: string; highlight: boolean }[] = [];
      let remaining = text;

      while (remaining.length > 0) {
        const startTag = remaining.indexOf('<b>');

        if (startTag === -1) {
          // No more highlights
          segments.push({ text: remaining, highlight: false });
          break;
        }

        // Add text before highlight
        if (startTag > 0) {
          segments.push({ text: remaining.slice(0, startTag), highlight: false });
        }

        // Find end tag
        const endTag = remaining.indexOf('</b>', startTag);
        if (endTag === -1) {
          // Malformed, add rest as plain text
          segments.push({ text: remaining.slice(startTag), highlight: false });
          break;
        }

        // Add highlighted text
        segments.push({
          text: remaining.slice(startTag + 3, endTag),
          highlight: true,
        });

        remaining = remaining.slice(endTag + 4);
      }

      return segments;
    }

    // Manual highlighting based on query terms
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const pattern = new RegExp(`(${words.map(escapeRegex).join('|')})`, 'gi');
    const segments: { text: string; highlight: boolean }[] = [];

    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      // Add text before match
      if (match.index > lastIndex) {
        segments.push({
          text: text.slice(lastIndex, match.index),
          highlight: false,
        });
      }

      // Add matched text
      segments.push({
        text: match[0],
        highlight: true,
      });

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      segments.push({
        text: text.slice(lastIndex),
        highlight: false,
      });
    }

    return segments.length > 0 ? segments : [{ text, highlight: false }];
  }, [text, query]);

  return (
    <span>
      {parts.map((part, i) =>
        part.highlight ? (
          <mark
            key={i}
            className="bg-accent-cyan/20 text-text-primary px-0.5 rounded"
          >
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </span>
  );
}

// Escape special regex characters
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function ErrorIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
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

export default SearchResults;
