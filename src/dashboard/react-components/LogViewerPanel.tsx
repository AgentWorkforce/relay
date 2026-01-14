/**
 * LogViewerPanel Component
 *
 * A full-screen or sidebar panel wrapper for the LogViewer.
 * Provides a modal-like overlay for dedicated log viewing.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { LogViewer } from './LogViewer';
import { getAgentColor, getAgentInitials } from '../lib/colors';
import { api } from '../lib/api';
import type { Agent } from '../types';

export type PanelPosition = 'right' | 'bottom' | 'fullscreen';

export interface LogViewerPanelProps {
  /** Agent to show logs for */
  agent: Agent;
  /** Panel position/style */
  position?: PanelPosition;
  /** Whether the panel is open */
  isOpen: boolean;
  /** Callback when panel should close */
  onClose: () => void;
  /** Callback when user wants to switch to a different agent */
  onAgentChange?: (agent: Agent) => void;
  /** List of available agents (for agent switcher) */
  availableAgents?: Agent[];
}

export function LogViewerPanel({
  agent,
  position = 'right',
  isOpen,
  onClose,
  onAgentChange,
  availableAgents = [],
}: LogViewerPanelProps) {
  const colors = getAgentColor(agent.name);
  const [isInterrupting, setIsInterrupting] = useState(false);

  // Handle interrupt button click
  const handleInterrupt = useCallback(async () => {
    if (isInterrupting) return;

    setIsInterrupting(true);
    try {
      const result = await api.interruptAgent(agent.name);
      if (!result.success) {
        console.error('Failed to interrupt agent:', result.error);
      }
    } catch (err) {
      console.error('Error interrupting agent:', err);
    } finally {
      // Brief delay to show the button was pressed
      setTimeout(() => setIsInterrupting(false), 500);
    }
  }, [agent.name, isInterrupting]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Prevent body scroll when panel is open (fix mobile scroll capture)
  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    const previousOverscroll = document.body.style.overscrollBehavior;

    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';

    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscroll;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const getPanelStyles = (): React.CSSProperties => {
    const base: React.CSSProperties = {
      position: 'fixed',
      zIndex: 1100,
      background: 'linear-gradient(180deg, #0d0f14 0%, #0a0c10 100%)',
    };

    switch (position) {
      case 'right':
        return {
          ...base,
          top: 0,
          right: 0,
          bottom: 0,
          width: '600px',
          maxWidth: '100vw',
          borderLeft: '1px solid #21262d',
          boxShadow: '-20px 0 60px rgba(0, 0, 0, 0.5)',
        };
      case 'bottom':
        return {
          ...base,
          left: 0,
          right: 0,
          bottom: 0,
          height: '400px',
          maxHeight: '60vh',
          borderTop: '1px solid #21262d',
          boxShadow: '0 -20px 60px rgba(0, 0, 0, 0.5)',
        };
      case 'fullscreen':
        return {
          ...base,
          inset: 0,
        };
    }
  };

  const getAnimationClass = () => {
    switch (position) {
      case 'right':
        return 'animate-slide-in-right';
      case 'bottom':
        return 'animate-slide-in-bottom';
      case 'fullscreen':
        return 'animate-fade-in';
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 z-[1099] animate-fade-in"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className={`flex flex-col ${getAnimationClass()}`}
        style={getPanelStyles()}
      >
        {/* Header with agent info - two row layout */}
        <div
          className="flex flex-col gap-3 border-b border-[#21262d] px-4 py-3 sm:px-5 sm:py-4"
          style={{
            background: 'linear-gradient(180deg, #161b22 0%, #0d1117 100%)',
          }}
        >
          {/* Row 1: Avatar, Agent Name, Status */}
          <div className="flex items-center gap-3">
            {/* Agent avatar with shine effect */}
            <div
              className="relative shrink-0 rounded-xl flex items-center justify-center font-bold overflow-hidden w-9 h-9 text-sm sm:w-11 sm:h-11"
              style={{
                backgroundColor: colors.primary,
                color: colors.text,
                boxShadow: `0 0 20px ${colors.primary}50, inset 0 1px 0 rgba(255,255,255,0.2)`,
              }}
            >
              {/* Shine overlay */}
              <div
                className="absolute inset-0 opacity-30"
                style={{
                  background: 'linear-gradient(135deg, rgba(255,255,255,0.35) 0%, transparent 50%)',
                }}
              />
              <span className="relative z-10">{getAgentInitials(agent.name)}</span>
            </div>

            {/* Agent name and status */}
            <div className="flex flex-col min-w-0 flex-1">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h2
                  className="text-base sm:text-lg font-semibold m-0"
                  style={{ color: colors.primary }}
                  title={agent.name}
                >
                  {agent.name}
                </h2>
                <span
                  className={`px-2 py-0.5 rounded-md text-[10px] uppercase tracking-wider font-medium shrink-0 ${
                    agent.status === 'online'
                      ? 'bg-[#3fb950]/15 text-[#3fb950]'
                      : agent.status === 'busy'
                      ? 'bg-[#d29922]/15 text-[#d29922]'
                      : 'bg-[#484f58]/15 text-[#484f58]'
                  }`}
                  style={{
                    boxShadow: agent.status === 'online' ? '0 0 8px rgba(63,185,80,0.2)' : 'none',
                  }}
                >
                  {agent.status}
                </span>
              </div>
              {agent.currentTask && (
                <span
                  className="text-xs sm:text-sm text-[#8b949e] truncate mt-0.5"
                  title={agent.currentTask}
                >
                  {agent.currentTask}
                </span>
              )}
            </div>
          </div>

          {/* Row 2: All control buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Agent switcher dropdown */}
            {availableAgents.length > 1 && onAgentChange && (
              <AgentSwitcher
                agents={availableAgents}
                currentAgent={agent}
                onSelect={onAgentChange}
              />
            )}

            {/* Position toggle buttons */}
            <div className="flex items-center gap-1 bg-[#21262d]/80 rounded-lg p-1 border border-[#30363d]/50">
              <button
                className={`p-1.5 rounded-md transition-all duration-200 ${
                  position === 'right'
                    ? 'bg-accent-cyan/15 text-accent-cyan shadow-[0_0_8px_rgba(0,217,255,0.15)]'
                    : 'text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#30363d]'
                }`}
                title="Sidebar view"
              >
                <SidebarIcon />
              </button>
              <button
                className={`p-1.5 rounded-md transition-all duration-200 ${
                  position === 'bottom'
                    ? 'bg-accent-cyan/15 text-accent-cyan shadow-[0_0_8px_rgba(0,217,255,0.15)]'
                    : 'text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#30363d]'
                }`}
                title="Bottom panel"
              >
                <BottomPanelIcon />
              </button>
              <button
                className={`p-1.5 rounded-md transition-all duration-200 ${
                  position === 'fullscreen'
                    ? 'bg-accent-cyan/15 text-accent-cyan shadow-[0_0_8px_rgba(0,217,255,0.15)]'
                    : 'text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#30363d]'
                }`}
                title="Fullscreen"
              >
                <FullscreenIcon />
              </button>
            </div>

            {/* Spacer to push interrupt and close to the right */}
            <div className="flex-1" />

            {/* Interrupt button - send ESC to break agent out of stuck loops */}
            <button
              className={`p-2 rounded-lg transition-all duration-200 ${
                isInterrupting
                  ? 'bg-[#d29922]/20 text-[#d29922] animate-pulse'
                  : 'text-[#8b949e] hover:text-[#d29922] hover:bg-[#d29922]/10 hover:shadow-[0_0_8px_rgba(210,153,34,0.2)]'
              }`}
              onClick={handleInterrupt}
              disabled={isInterrupting}
              title="Send ESC to agent - interrupt current operation"
            >
              <InterruptIcon />
            </button>

            {/* Close button */}
            <button
              className="p-2 rounded-lg text-[#8b949e] hover:text-[#f85149] hover:bg-[#f85149]/10 transition-all duration-200 hover:shadow-[0_0_8px_rgba(248,81,73,0.2)]"
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Log viewer */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <LogViewer
            agentName={agent.name}
            mode="panel"
            showHeader={false}
            maxHeight="100%"
            className="h-full rounded-none border-none"
          />
        </div>
      </div>

      {/* Custom keyframes for animations */}
      <style>{`
        @keyframes slideInRight {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }

        @keyframes slideInBottom {
          from {
            transform: translateY(100%);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }

        .animate-slide-in-right {
          animation: slideInRight 0.3s cubic-bezier(0.32, 0.72, 0, 1);
        }

        .animate-slide-in-bottom {
          animation: slideInBottom 0.3s cubic-bezier(0.32, 0.72, 0, 1);
        }
      `}</style>
    </>
  );
}

// Agent switcher dropdown
interface AgentSwitcherProps {
  agents: Agent[];
  currentAgent: Agent;
  onSelect: (agent: Agent) => void;
}

function AgentSwitcher({ agents, currentAgent, onSelect }: AgentSwitcherProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        className="flex items-center gap-2 px-3 py-1.5 bg-[#21262d] hover:bg-[#30363d] rounded-lg text-sm text-[#c9d1d9] transition-colors"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span>Switch agent</span>
        <ChevronDownIcon />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-64 bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl overflow-hidden z-10">
          <div className="max-h-64 overflow-y-auto">
            {agents.map((agent) => {
              const colors = getAgentColor(agent.name);
              const isCurrent = agent.name === currentAgent.name;

              return (
                <button
                  key={agent.name}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                    isCurrent
                      ? 'bg-[#238636]/20'
                      : 'hover:bg-[#21262d]'
                  }`}
                  onClick={() => {
                    onSelect(agent);
                    setIsOpen(false);
                  }}
                >
                  <div
                    className="w-8 h-8 rounded flex items-center justify-center text-xs font-semibold shrink-0"
                    style={{
                      backgroundColor: colors.primary,
                      color: colors.text,
                    }}
                  >
                    {getAgentInitials(agent.name)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-[#c9d1d9] truncate">
                      {agent.name}
                    </div>
                    <div className="text-xs text-[#8b949e]">{agent.status}</div>
                  </div>
                  {isCurrent && (
                    <CheckIcon />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Icons
function InterruptIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {/* ESC key icon - represents sending escape sequence */}
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <text x="12" y="15" textAnchor="middle" fill="currentColor" stroke="none" fontSize="8" fontWeight="600" fontFamily="system-ui">ESC</text>
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function SidebarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  );
}

function BottomPanelIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="15" x2="21" y2="15" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3fb950" strokeWidth="2">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export default LogViewerPanel;
