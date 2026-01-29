/**
 * ProvisioningProgress - A visually striking progress indicator for workspace provisioning
 *
 * Design: Terminal-inspired with holographic accents, featuring a vertical stage timeline
 * with animated connections, pulsing indicators, and a typewriter terminal output effect.
 */
import React, { useState, useEffect, useMemo } from 'react';

export interface ProvisioningStage {
  id: string;
  name: string;
  description: string;
  estimatedSeconds: number;
  icon: string;
}

export interface ProvisioningProgressProps {
  /** Current stage ID from backend, or null if unknown */
  currentStage?: string | null;
  /** Whether provisioning has started */
  isProvisioning: boolean;
  /** Workspace name being provisioned */
  workspaceName?: string;
  /** Error message if provisioning failed */
  error?: string | null;
  /** Callback when user wants to cancel */
  onCancel?: () => void;
}

const PROVISIONING_STAGES: ProvisioningStage[] = [
  {
    id: 'creating',
    name: 'Initialize',
    description: 'Creating workspace container',
    estimatedSeconds: 5,
    icon: '◈',
  },
  {
    id: 'networking',
    name: 'Network',
    description: 'Configuring DNS & IP allocation',
    estimatedSeconds: 8,
    icon: '◇',
  },
  {
    id: 'secrets',
    name: 'Secure',
    description: 'Encrypting credentials',
    estimatedSeconds: 3,
    icon: '◆',
  },
  {
    id: 'machine',
    name: 'Deploy',
    description: 'Launching cloud instance',
    estimatedSeconds: 25,
    icon: '▣',
  },
  {
    id: 'booting',
    name: 'Boot',
    description: 'Starting relay services',
    estimatedSeconds: 20,
    icon: '▢',
  },
  {
    id: 'health',
    name: 'Verify',
    description: 'Running health checks',
    estimatedSeconds: 15,
    icon: '◉',
  },
];

// Terminal-style loading messages
const TERMINAL_MESSAGES = [
  '> Establishing secure connection...',
  '> Allocating compute resources...',
  '> Configuring agent protocols...',
  '> Initializing relay daemon...',
  '> Syncing workspace state...',
  '> Warming up inference engine...',
  '> Connecting to neural mesh...',
  '> Deploying agent swarm...',
];

export function ProvisioningProgress({
  currentStage,
  isProvisioning,
  workspaceName,
  error,
  onCancel,
}: ProvisioningProgressProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const [cursorVisible, setCursorVisible] = useState(true);

  // Track elapsed time
  useEffect(() => {
    if (!isProvisioning) {
      setElapsedSeconds(0);
      return;
    }
    const interval = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [isProvisioning]);

  // Cursor blink
  useEffect(() => {
    const interval = setInterval(() => {
      setCursorVisible((prev) => !prev);
    }, 530);
    return () => clearInterval(interval);
  }, []);

  // Add terminal messages over time
  useEffect(() => {
    if (!isProvisioning) {
      setTerminalLines([]);
      return;
    }

    const addMessage = () => {
      const randomMsg = TERMINAL_MESSAGES[Math.floor(Math.random() * TERMINAL_MESSAGES.length)];
      setTerminalLines((prev) => [...prev.slice(-4), randomMsg]);
    };

    addMessage(); // Initial message
    const interval = setInterval(addMessage, 3500);
    return () => clearInterval(interval);
  }, [isProvisioning]);

  // Calculate current stage index
  const currentStageIndex = useMemo(() => {
    if (currentStage) {
      const idx = PROVISIONING_STAGES.findIndex((s) => s.id === currentStage);
      return idx >= 0 ? idx : 0;
    }
    // Estimate based on elapsed time
    let accumulated = 0;
    for (let i = 0; i < PROVISIONING_STAGES.length; i++) {
      accumulated += PROVISIONING_STAGES[i].estimatedSeconds;
      if (elapsedSeconds < accumulated) return i;
    }
    return PROVISIONING_STAGES.length - 1;
  }, [currentStage, elapsedSeconds]);

  // Calculate progress
  const totalEstimatedSeconds = useMemo(
    () => PROVISIONING_STAGES.reduce((sum, s) => sum + s.estimatedSeconds, 0),
    []
  );

  const progressPercent = useMemo(() => {
    return Math.min(95, Math.round((elapsedSeconds / totalEstimatedSeconds) * 100));
  }, [elapsedSeconds, totalEstimatedSeconds]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `0:${secs.toString().padStart(2, '0')}`;
  };

  if (error) {
    return (
      <div className="prov-container prov-error">
        <div className="error-glitch">
          <span className="error-icon">✕</span>
        </div>
        <h3 className="error-title">PROVISIONING FAILED</h3>
        <p className="error-message">{error}</p>
        {onCancel && (
          <button onClick={onCancel} className="retry-btn">
            <span>RETRY</span>
          </button>
        )}
        <style>{errorStyles}</style>
      </div>
    );
  }

  return (
    <div className="prov-container">
      {/* Ambient background effects */}
      <div className="ambient-glow" />
      <div className="scan-line" />

      {/* Header */}
      <header className="prov-header">
        <div className="header-badge">PROVISIONING</div>
        <h1 className="header-title">
          {workspaceName || 'Workspace'}
        </h1>
        <div className="header-meta">
          <span className="meta-time">{formatTime(elapsedSeconds)}</span>
          <span className="meta-sep">•</span>
          <span className="meta-percent">{progressPercent}%</span>
        </div>
      </header>

      {/* Progress bar */}
      <div className="progress-track">
        <div
          className="progress-fill"
          style={{ width: `${progressPercent}%` }}
        />
        <div
          className="progress-glow"
          style={{ left: `${progressPercent}%` }}
        />
      </div>

      {/* Stage timeline */}
      <div className="stages-timeline">
        {PROVISIONING_STAGES.map((stage, index) => {
          const isCompleted = index < currentStageIndex;
          const isCurrent = index === currentStageIndex;
          const isPending = index > currentStageIndex;

          return (
            <div
              key={stage.id}
              className={`stage-row ${isCompleted ? 'completed' : ''} ${isCurrent ? 'current' : ''} ${isPending ? 'pending' : ''}`}
            >
              {/* Connector */}
              {index > 0 && (
                <div className={`stage-connector ${isCompleted ? 'active' : ''}`}>
                  <div className="connector-line" />
                  {isCompleted && <div className="connector-pulse" />}
                </div>
              )}

              {/* Node */}
              <div className="stage-node">
                <span className="node-icon">{stage.icon}</span>
                {isCurrent && <div className="node-ring" />}
              </div>

              {/* Content */}
              <div className="stage-content">
                <span className="stage-name">{stage.name}</span>
                {isCurrent && (
                  <span className="stage-desc">{stage.description}</span>
                )}
              </div>

              {/* Status */}
              <div className="stage-status">
                {isCompleted && <span className="status-done">DONE</span>}
                {isCurrent && <span className="status-active">ACTIVE</span>}
                {isPending && <span className="status-wait">~{stage.estimatedSeconds}s</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Terminal output */}
      <div className="terminal-window">
        <div className="terminal-header">
          <span className="terminal-dot red" />
          <span className="terminal-dot yellow" />
          <span className="terminal-dot green" />
          <span className="terminal-title">agent-relay</span>
        </div>
        <div className="terminal-body">
          {terminalLines.map((line, i) => (
            <div key={i} className="terminal-line" style={{ animationDelay: `${i * 0.1}s` }}>
              {line}
            </div>
          ))}
          <div className="terminal-cursor">
            <span className="cursor-prompt">$</span>
            <span className={`cursor-block ${cursorVisible ? 'visible' : ''}`}>_</span>
          </div>
        </div>
      </div>

      {/* Cancel button */}
      {onCancel && (
        <button onClick={onCancel} className="cancel-btn">
          Cancel
        </button>
      )}

      <style>{mainStyles}</style>
    </div>
  );
}

const mainStyles = `
  .prov-container {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 24px;
    padding: 40px 32px;
    background: linear-gradient(145deg, rgba(10, 15, 25, 0.95) 0%, rgba(5, 10, 18, 0.98) 100%);
    border: 1px solid rgba(6, 182, 212, 0.15);
    border-radius: 16px;
    overflow: hidden;
    font-family: 'SF Mono', 'JetBrains Mono', 'Fira Code', monospace;
  }

  /* Ambient effects */
  .ambient-glow {
    position: absolute;
    top: -100px;
    left: 50%;
    transform: translateX(-50%);
    width: 300px;
    height: 200px;
    background: radial-gradient(ellipse, rgba(6, 182, 212, 0.12) 0%, transparent 70%);
    pointer-events: none;
  }

  .scan-line {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent, rgba(6, 182, 212, 0.4), transparent);
    animation: scanMove 3s ease-in-out infinite;
    pointer-events: none;
  }

  @keyframes scanMove {
    0%, 100% { top: 0; opacity: 0.5; }
    50% { top: 100%; opacity: 0.2; }
  }

  /* Header */
  .prov-header {
    text-align: center;
    position: relative;
    z-index: 1;
  }

  .header-badge {
    display: inline-block;
    padding: 4px 12px;
    background: rgba(6, 182, 212, 0.1);
    border: 1px solid rgba(6, 182, 212, 0.3);
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 2px;
    color: #06b6d4;
    margin-bottom: 12px;
  }

  .header-title {
    font-size: 22px;
    font-weight: 600;
    color: #f1f5f9;
    margin: 0 0 8px 0;
    letter-spacing: -0.5px;
  }

  .header-meta {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-size: 13px;
    color: #64748b;
  }

  .meta-time {
    font-variant-numeric: tabular-nums;
  }

  .meta-percent {
    color: #06b6d4;
    font-weight: 500;
  }

  .meta-sep {
    opacity: 0.3;
  }

  /* Progress bar */
  .progress-track {
    position: relative;
    height: 4px;
    background: rgba(100, 116, 139, 0.2);
    border-radius: 2px;
    overflow: visible;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #0891b2, #06b6d4, #22d3ee);
    border-radius: 2px;
    transition: width 0.5s ease;
  }

  .progress-glow {
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 8px;
    height: 8px;
    background: #22d3ee;
    border-radius: 50%;
    box-shadow: 0 0 16px rgba(34, 211, 238, 0.6);
    transition: left 0.5s ease;
  }

  /* Stages */
  .stages-timeline {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 16px 0;
  }

  .stage-row {
    display: grid;
    grid-template-columns: 40px 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    position: relative;
  }

  .stage-connector {
    position: absolute;
    left: 19px;
    top: -10px;
    width: 2px;
    height: 20px;
  }

  .connector-line {
    width: 100%;
    height: 100%;
    background: rgba(100, 116, 139, 0.3);
    transition: background 0.3s ease;
  }

  .stage-connector.active .connector-line {
    background: linear-gradient(180deg, #06b6d4, rgba(6, 182, 212, 0.3));
  }

  .connector-pulse {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: linear-gradient(180deg, rgba(34, 211, 238, 0.8), transparent);
    animation: pulseLine 1.5s ease-out infinite;
  }

  @keyframes pulseLine {
    0% { opacity: 1; transform: translateY(-100%); }
    100% { opacity: 0; transform: translateY(100%); }
  }

  .stage-node {
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }

  .node-icon {
    font-size: 18px;
    color: #475569;
    transition: all 0.3s ease;
  }

  .stage-row.completed .node-icon {
    color: #06b6d4;
  }

  .stage-row.current .node-icon {
    color: #22d3ee;
    text-shadow: 0 0 12px rgba(34, 211, 238, 0.5);
  }

  .node-ring {
    position: absolute;
    inset: 4px;
    border: 2px solid rgba(34, 211, 238, 0.4);
    border-radius: 50%;
    animation: ringPulse 2s ease-in-out infinite;
  }

  @keyframes ringPulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.2); opacity: 0.5; }
  }

  .stage-content {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .stage-name {
    font-size: 13px;
    font-weight: 500;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    transition: color 0.3s ease;
  }

  .stage-row.completed .stage-name {
    color: #475569;
  }

  .stage-row.current .stage-name {
    color: #f1f5f9;
  }

  .stage-desc {
    font-size: 11px;
    color: #64748b;
    animation: fadeSlideIn 0.3s ease;
  }

  @keyframes fadeSlideIn {
    from { opacity: 0; transform: translateX(-8px); }
    to { opacity: 1; transform: translateX(0); }
  }

  .stage-status {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 1px;
  }

  .status-done {
    color: #06b6d4;
  }

  .status-active {
    color: #22d3ee;
    animation: blink 1s ease-in-out infinite;
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .status-wait {
    color: #475569;
    font-variant-numeric: tabular-nums;
  }

  /* Terminal */
  .terminal-window {
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(100, 116, 139, 0.2);
    border-radius: 8px;
    overflow: hidden;
  }

  .terminal-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    background: rgba(30, 41, 59, 0.5);
    border-bottom: 1px solid rgba(100, 116, 139, 0.15);
  }

  .terminal-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  .terminal-dot.red { background: #ef4444; }
  .terminal-dot.yellow { background: #eab308; }
  .terminal-dot.green { background: #22c55e; }

  .terminal-title {
    margin-left: auto;
    font-size: 11px;
    color: #64748b;
  }

  .terminal-body {
    padding: 12px;
    min-height: 100px;
  }

  .terminal-line {
    font-size: 12px;
    color: #94a3b8;
    padding: 2px 0;
    animation: typeIn 0.3s ease;
  }

  @keyframes typeIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .terminal-cursor {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 8px;
  }

  .cursor-prompt {
    color: #06b6d4;
    font-weight: 600;
  }

  .cursor-block {
    color: #22d3ee;
    opacity: 0;
    transition: opacity 0.1s;
  }

  .cursor-block.visible {
    opacity: 1;
  }

  /* Cancel button */
  .cancel-btn {
    align-self: center;
    padding: 8px 20px;
    background: transparent;
    border: 1px solid rgba(100, 116, 139, 0.3);
    border-radius: 6px;
    color: #64748b;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .cancel-btn:hover {
    border-color: rgba(239, 68, 68, 0.5);
    color: #ef4444;
  }
`;

const errorStyles = `
  .prov-container.prov-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    padding: 48px 32px;
    background: linear-gradient(145deg, rgba(25, 10, 10, 0.95) 0%, rgba(15, 5, 8, 0.98) 100%);
    border: 1px solid rgba(239, 68, 68, 0.2);
    border-radius: 16px;
    text-align: center;
    font-family: 'SF Mono', 'JetBrains Mono', monospace;
  }

  .error-glitch {
    position: relative;
    width: 64px;
    height: 64px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 12px;
  }

  .error-icon {
    font-size: 28px;
    color: #ef4444;
    animation: glitch 0.3s ease infinite;
  }

  @keyframes glitch {
    0%, 100% { transform: translate(0); }
    25% { transform: translate(-2px, 1px); }
    50% { transform: translate(2px, -1px); }
    75% { transform: translate(-1px, -1px); }
  }

  .error-title {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 2px;
    color: #ef4444;
    margin: 0;
  }

  .error-message {
    font-size: 13px;
    color: #94a3b8;
    max-width: 350px;
    margin: 0;
    line-height: 1.5;
  }

  .retry-btn {
    margin-top: 8px;
    padding: 10px 28px;
    background: linear-gradient(135deg, rgba(239, 68, 68, 0.2) 0%, rgba(220, 38, 38, 0.2) 100%);
    border: 1px solid rgba(239, 68, 68, 0.4);
    border-radius: 6px;
    color: #ef4444;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 1px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .retry-btn:hover {
    background: linear-gradient(135deg, rgba(239, 68, 68, 0.3) 0%, rgba(220, 38, 38, 0.3) 100%);
    border-color: rgba(239, 68, 68, 0.6);
    transform: translateY(-1px);
  }
`;

export default ProvisioningProgress;
