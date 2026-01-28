/**
 * RepoContextHeader Component
 *
 * Slack-style repo indicator in the header with quick switcher dropdown.
 * Shows current repo/project and allows switching between connected projects.
 */

import React, { useState, useRef, useEffect } from 'react';
import type { Project } from '../../types';

export interface RepoContextHeaderProps {
  /** All connected projects */
  projects: Project[];
  /** Recently accessed projects (subset of projects) */
  recentProjects?: Project[];
  /** Currently active project */
  currentProject: Project | null;
  /** Callback when user selects a project */
  onProjectChange: (project: Project) => void;
}

export function RepoContextHeader({
  projects,
  recentProjects = [],
  currentProject,
  onProjectChange,
}: RepoContextHeaderProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const hasMultipleProjects = projects.length > 1;

  // Get IDs of recent projects for filtering
  const recentIds = new Set(recentProjects.map((p) => p.id));

  // Projects not in recent list
  const otherProjects = projects.filter((p) => !recentIds.has(p.id));

  // Combined list for keyboard navigation: recent first, then others
  const allItems = [...recentProjects, ...otherProjects];

  // Format project name for display (extract org/repo from path)
  const formatProjectName = (project: Project | null): string => {
    if (!project) return 'No project';

    if (project.name) return project.name;

    // Extract last two path segments for "org/repo" format
    const segments = project.path.split('/').filter(Boolean);
    if (segments.length >= 2) {
      return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    }
    return segments[segments.length - 1] || project.id;
  };

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isOpen) return;

      switch (event.key) {
        case 'Escape':
          setIsOpen(false);
          setFocusedIndex(-1);
          break;
        case 'ArrowDown':
          event.preventDefault();
          setFocusedIndex((prev) => {
            const next = prev < allItems.length - 1 ? prev + 1 : 0;
            buttonRefs.current[next]?.focus();
            return next;
          });
          break;
        case 'ArrowUp':
          event.preventDefault();
          setFocusedIndex((prev) => {
            const next = prev > 0 ? prev - 1 : allItems.length - 1;
            buttonRefs.current[next]?.focus();
            return next;
          });
          break;
        case 'Enter':
          if (focusedIndex >= 0 && focusedIndex < allItems.length) {
            onProjectChange(allItems[focusedIndex]);
            setIsOpen(false);
            setFocusedIndex(-1);
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, focusedIndex, allItems, onProjectChange]);

  // Reset focus when dropdown opens
  useEffect(() => {
    if (isOpen) {
      // Focus current project or first item
      const currentIndex = allItems.findIndex((p) => p.id === currentProject?.id);
      setFocusedIndex(currentIndex >= 0 ? currentIndex : 0);
    } else {
      setFocusedIndex(-1);
    }
  }, [isOpen, allItems, currentProject]);

  // Don't render if no projects
  if (projects.length === 0) return null;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 border ${
          hasMultipleProjects
            ? 'bg-bg-tertiary/80 border-border-subtle hover:bg-bg-elevated hover:border-border-medium cursor-pointer'
            : 'bg-transparent border-transparent cursor-default'
        }`}
        onClick={() => hasMultipleProjects && setIsOpen(!isOpen)}
        disabled={!hasMultipleProjects}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
      >
        <RepoIcon />
        <span className="text-text-primary truncate max-w-[200px]">
          {formatProjectName(currentProject)}
        </span>
        {hasMultipleProjects && (
          <ChevronIcon isOpen={isOpen} />
        )}
      </button>

      {/* Dropdown */}
      {isOpen && hasMultipleProjects && (
        <div className="absolute top-[calc(100%+4px)] left-0 min-w-[280px] bg-bg-primary border border-border-subtle rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.4)] z-[1000] overflow-hidden">
          {/* Header */}
          <div className="px-3 py-2 border-b border-border-subtle">
            <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
              Switch Project
            </span>
          </div>

          <div className="max-h-[300px] overflow-y-auto" role="listbox">
            {/* Recent Projects Section */}
            {recentProjects.length > 0 && (
              <>
                <div className="px-3 py-1.5 bg-bg-tertiary/50">
                  <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider flex items-center gap-1.5">
                    <ClockIcon />
                    Recent
                  </span>
                </div>
                <div className="py-1">
                  {recentProjects.map((project, index) => (
                    <ProjectItem
                      key={project.id}
                      project={project}
                      index={index}
                      isActive={currentProject?.id === project.id}
                      isFocused={focusedIndex === index}
                      formatProjectName={formatProjectName}
                      buttonRefs={buttonRefs}
                      onSelect={() => {
                        onProjectChange(project);
                        setIsOpen(false);
                      }}
                    />
                  ))}
                </div>
              </>
            )}

            {/* All Projects Section */}
            {otherProjects.length > 0 && (
              <>
                <div className="px-3 py-1.5 bg-bg-tertiary/50">
                  <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">
                    {recentProjects.length > 0 ? 'All Projects' : 'Projects'}
                  </span>
                </div>
                <div className="py-1">
                  {otherProjects.map((project, index) => {
                    const globalIndex = recentProjects.length + index;
                    return (
                      <ProjectItem
                        key={project.id}
                        project={project}
                        index={globalIndex}
                        isActive={currentProject?.id === project.id}
                        isFocused={focusedIndex === globalIndex}
                        formatProjectName={formatProjectName}
                        buttonRefs={buttonRefs}
                        onSelect={() => {
                          onProjectChange(project);
                          setIsOpen(false);
                        }}
                      />
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface ProjectItemProps {
  project: Project;
  index: number;
  isActive: boolean;
  isFocused: boolean;
  formatProjectName: (project: Project) => string;
  buttonRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
  onSelect: () => void;
}

function ProjectItem({
  project,
  index,
  isActive,
  isFocused,
  formatProjectName,
  buttonRefs,
  onSelect,
}: ProjectItemProps) {
  const displayName = formatProjectName(project);
  const agentCount = project.agents?.length || 0;

  return (
    <button
      ref={(el) => { buttonRefs.current[index] = el; }}
      className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors border-none cursor-pointer ${
        isActive
          ? 'bg-accent-cyan/10 text-accent-cyan'
          : isFocused
            ? 'bg-bg-hover text-text-primary'
            : 'bg-transparent text-text-primary hover:bg-bg-hover'
      }`}
      onClick={onSelect}
      role="option"
      aria-selected={isActive}
      tabIndex={isFocused ? 0 : -1}
    >
      <RepoIcon className={isActive ? 'text-accent-cyan' : 'text-text-muted'} />

      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">
          {displayName}
        </div>
        <div className="text-xs text-text-muted truncate">
          {project.path}
        </div>
      </div>

      {/* Agent count badge */}
      <span className={`text-xs px-2 py-0.5 rounded-full ${
        isActive
          ? 'bg-accent-cyan/20 text-accent-cyan'
          : 'bg-bg-tertiary text-text-muted'
      }`}>
        {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
      </span>

      {/* Lead indicator */}
      {project.lead?.connected && (
        <span className="w-2 h-2 rounded-full bg-success animate-pulse" title={`Lead: ${project.lead.name}`} />
      )}

      {/* Checkmark for active */}
      {isActive && (
        <CheckIcon />
      )}
    </button>
  );
}

function ClockIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function RepoIcon({ className = 'text-text-muted' }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ChevronIcon({ isOpen }: { isOpen: boolean }) {
  return (
    <svg
      className={`text-text-muted transition-transform duration-150 ${isOpen ? 'rotate-180' : ''}`}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-accent-cyan"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
