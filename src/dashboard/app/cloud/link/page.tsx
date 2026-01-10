'use client';

/**
 * Agent Relay Cloud - Link Machine Page
 *
 * Flow:
 * 1. User runs `agent-relay cloud link` in terminal
 * 2. CLI opens this page with ?code=<temp>&machine=<id>&name=<name>
 * 3. User confirms machine details and clicks "Link Machine"
 * 4. Server generates API key via POST /api/daemons/link
 * 5. User copies API key back to terminal
 */

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

type LinkState = 'loading' | 'auth-required' | 'ready' | 'linking' | 'success' | 'error';

interface MachineInfo {
  code: string;
  machineId: string;
  machineName: string;
}

interface Workspace {
  id: string;
  name: string;
  status: string;
}

interface LinkResult {
  apiKey: string;
  daemonId: string;
  workspaceId: string | null;
}

// Loading fallback for Suspense
function CloudLinkLoading() {
  return (
    <div className="relative min-h-screen flex items-center justify-center p-8 bg-bg-deep overflow-hidden">
      <div className="bg-gradient-to-br from-bg-secondary to-bg-primary border border-accent-cyan/15 rounded-2xl p-12 shadow-xl backdrop-blur-xl">
        <div className="w-12 h-12 mx-auto mb-6 border-3 border-accent-cyan/20 border-t-accent-cyan rounded-full animate-spin" />
        <p className="text-center text-text-secondary">Loading...</p>
      </div>
    </div>
  );
}

// Main content component that uses useSearchParams
function CloudLinkContent() {
  const searchParams = useSearchParams();
  const [state, setState] = useState<LinkState>('loading');
  const [machineInfo, setMachineInfo] = useState<MachineInfo | null>(null);
  const [linkResult, setLinkResult] = useState<LinkResult | null>(null);
  const [error, setError] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);

  // Extract machine info from URL params
  useEffect(() => {
    const code = searchParams.get('code');
    const machineId = searchParams.get('machine');
    const machineName = searchParams.get('name');

    if (!code || !machineId || !machineName) {
      setState('error');
      setError('Invalid link URL. Please run agent-relay cloud link again.');
      return;
    }

    setMachineInfo({ code, machineId, machineName });
    checkAuth();
  }, [searchParams]);

  const checkAuth = async () => {
    try {
      const data = await api.get<{ authenticated?: boolean; user?: { id: string } }>('/api/auth/session');
      if (data.authenticated && data.user?.id) {
        // Fetch user's workspaces
        const workspacesData = await api.get<{ workspaces: Workspace[] }>('/api/workspaces');
        setWorkspaces(workspacesData.workspaces || []);
        // Auto-select first workspace if only one exists
        if (workspacesData.workspaces?.length === 1) {
          setSelectedWorkspaceId(workspacesData.workspaces[0].id);
        }
        setState('ready');
      } else {
        setState('auth-required');
      }
    } catch (err) {
      console.error('Auth check failed:', err);
      setState('auth-required');
    }
  };

  const handleLink = async () => {
    if (!machineInfo) return;

    // Require workspace selection if workspaces exist
    if (workspaces.length > 0 && !selectedWorkspaceId) {
      setError('Please select a workspace');
      return;
    }

    setState('linking');
    setError('');

    try {
      const result = await api.post<{ apiKey: string; daemonId: string; workspaceId: string | null }>('/api/daemons/link', {
        machineId: machineInfo.machineId,
        name: machineInfo.machineName,
        workspaceId: selectedWorkspaceId,
        metadata: {
          linkedVia: 'cli',
          userAgent: navigator.userAgent,
        },
      });

      setLinkResult({
        apiKey: result.apiKey,
        daemonId: result.daemonId,
        workspaceId: result.workspaceId,
      });
      setState('success');
    } catch (err: any) {
      console.error('Link failed:', err);
      setError(err.message || 'Failed to link machine. Please try again.');
      setState('error');
    }
  };

  const handleCopy = useCallback(async () => {
    if (!linkResult?.apiKey) return;

    try {
      await navigator.clipboard.writeText(linkResult.apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  }, [linkResult?.apiKey]);

  const handleLogin = () => {
    const returnUrl = window.location.href;
    window.location.href = `/login?return=${encodeURIComponent(returnUrl)}`;
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center p-8 bg-bg-deep overflow-hidden">
      {/* Animated background */}
      <div className="fixed inset-0 pointer-events-none">
        {/* Grid */}
        <div
          className="absolute inset-0 opacity-30"
          style={{
            backgroundImage: 'linear-gradient(rgba(0, 217, 255, 0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 217, 255, 0.03) 1px, transparent 1px)',
            backgroundSize: '80px 80px',
            maskImage: 'radial-gradient(ellipse 70% 50% at 50% 50%, black 20%, transparent 80%)',
            animation: 'grid-drift 20s linear infinite',
          }}
        />

        {/* Glow */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-accent-cyan/10 rounded-full blur-3xl animate-pulse-glow" />

        {/* Particles */}
        <div className="absolute inset-0">
          {[...Array(20)].map((_, i) => (
            <div
              key={i}
              className="absolute w-0.5 h-0.5 bg-accent-cyan rounded-full shadow-glow-cyan opacity-0"
              style={{
                left: `${Math.random() * 100}%`,
                top: `${Math.random() * 100}%`,
                animation: `particle-float ${3 + Math.random() * 4}s ease-in-out infinite`,
                animationDelay: `${Math.random() * 5}s`,
              }}
            />
          ))}
        </div>
      </div>

      {/* Main content */}
      <div className="relative z-10 w-full max-width-[600px] animate-slide-up">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-flex mb-6 text-accent-cyan animate-pulse">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" className="drop-shadow-glow-cyan">
              <path d="M16 4L28 11V21L16 28L4 21V11L16 4Z" stroke="currentColor" strokeWidth="2" />
              <circle cx="16" cy="16" r="4" fill="currentColor" />
            </svg>
          </div>
          <h1 className="font-display text-4xl font-bold mb-3 bg-gradient-to-r from-text-primary to-accent-cyan bg-clip-text text-transparent">
            Link Machine
          </h1>
          <p className="text-xl text-text-secondary">
            Connect this machine to Agent Relay Cloud
          </p>
        </div>

        {/* Loading state */}
        {state === 'loading' && (
          <div className="bg-gradient-to-br from-bg-secondary to-bg-primary border border-accent-cyan/15 rounded-2xl p-12 shadow-xl backdrop-blur-xl">
            <div className="w-12 h-12 mx-auto mb-6 border-3 border-accent-cyan/20 border-t-accent-cyan rounded-full animate-spin" />
            <p className="text-center text-text-secondary">Verifying session...</p>
          </div>
        )}

        {/* Auth required */}
        {state === 'auth-required' && (
          <div className="bg-gradient-to-br from-bg-secondary to-bg-primary border border-accent-cyan/15 rounded-2xl p-12 shadow-xl backdrop-blur-xl">
            <div className="text-center">
              <div className="text-5xl mb-6 animate-bounce">🔐</div>
              <h2 className="font-display text-2xl font-semibold mb-4 text-text-primary">
                Authentication Required
              </h2>
              <p className="text-text-secondary mb-8 leading-relaxed">
                Sign in to link this machine to your Agent Relay account.
              </p>
              <button
                onClick={handleLogin}
                className="w-full flex items-center justify-center gap-3 px-8 py-4 bg-gradient-to-r from-accent-cyan to-accent-cyan/80 hover:from-accent-cyan/90 hover:to-accent-cyan/70 text-text-inverse font-display font-semibold text-lg rounded-xl shadow-glow-cyan transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl"
              >
                Sign In with GitHub
              </button>
            </div>
          </div>
        )}

        {/* Ready to link */}
        {state === 'ready' && machineInfo && (
          <div className="bg-gradient-to-br from-bg-secondary to-bg-primary border border-accent-cyan/15 rounded-2xl p-12 shadow-xl backdrop-blur-xl">
            {/* Machine details */}
            <div className="bg-black/30 border border-border-subtle rounded-xl p-6 mb-8">
              <div className="flex justify-between items-center py-3 border-b border-border-subtle">
                <span className="text-sm font-medium text-text-secondary">Machine Name</span>
                <span className="text-base font-medium text-text-primary">{machineInfo.machineName}</span>
              </div>
              <div className="flex justify-between items-center pt-3">
                <span className="text-sm font-medium text-text-secondary">Machine ID</span>
                <span className="font-mono text-sm text-accent-cyan">{machineInfo.machineId}</span>
              </div>
            </div>

            {/* Workspace selector */}
            {workspaces.length > 0 && (
              <div className="mb-8">
                <label className="block text-sm font-medium text-text-secondary mb-3">
                  Select Workspace
                </label>
                <p className="text-sm text-text-muted mb-4">
                  Local agents from this machine will appear in the selected workspace&apos;s dashboard.
                </p>
                <div className="space-y-2">
                  {workspaces.map((workspace) => (
                    <button
                      key={workspace.id}
                      onClick={() => setSelectedWorkspaceId(workspace.id)}
                      className={`w-full flex items-center gap-3 p-4 rounded-xl border transition-all ${
                        selectedWorkspaceId === workspace.id
                          ? 'bg-accent-cyan/10 border-accent-cyan/50 shadow-glow-cyan'
                          : 'bg-black/20 border-border-subtle hover:border-accent-cyan/30'
                      }`}
                    >
                      <div className={`w-3 h-3 rounded-full ${
                        workspace.status === 'running' ? 'bg-success' : 'bg-gray-500'
                      }`} />
                      <span className="text-text-primary font-medium">{workspace.name}</span>
                      {selectedWorkspaceId === workspace.id && (
                        <span className="ml-auto text-accent-cyan">✓</span>
                      )}
                    </button>
                  ))}
                </div>
                {error && !error.includes('Failed') && (
                  <p className="mt-2 text-sm text-error">{error}</p>
                )}
              </div>
            )}

            {/* No workspaces warning */}
            {workspaces.length === 0 && (
              <div className="flex gap-4 bg-accent-cyan/8 border border-accent-cyan/20 rounded-xl p-5 mb-8">
                <div className="text-2xl flex-shrink-0">📁</div>
                <div>
                  <p className="text-text-primary text-[15px] leading-relaxed mb-2">
                    No workspaces found. Create a workspace first to link this machine.
                  </p>
                  <a
                    href="/app"
                    className="text-accent-cyan hover:underline text-sm"
                  >
                    Go to Dashboard →
                  </a>
                </div>
              </div>
            )}

            {/* Warning */}
            <div className="flex gap-4 bg-warning/8 border border-warning/20 rounded-xl p-5 mb-8">
              <div className="text-2xl flex-shrink-0 animate-kill-pulse">⚠️</div>
              <p className="text-text-primary text-[15px] leading-relaxed">
                This will generate an API key that grants full access to your Agent Relay account.
                Keep it secure and never share it publicly.
              </p>
            </div>

            {/* Link button */}
            <button
              onClick={handleLink}
              disabled={workspaces.length === 0}
              className={`w-full flex items-center justify-center gap-3 px-8 py-4 font-display font-semibold text-lg rounded-xl transition-all duration-200 ${
                workspaces.length === 0
                  ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                  : 'bg-gradient-to-r from-accent-cyan to-success hover:from-accent-cyan/90 hover:to-success/90 text-text-inverse shadow-glow-cyan hover:-translate-y-0.5 hover:shadow-2xl animate-pulse-glow'
              }`}
            >
              <span className="text-xl">🔗</span>
              <span>Link This Machine</span>
            </button>
          </div>
        )}

        {/* Linking in progress */}
        {state === 'linking' && (
          <div className="bg-gradient-to-br from-bg-secondary to-bg-primary border border-accent-cyan/15 rounded-2xl p-12 shadow-xl backdrop-blur-xl">
            <div className="relative w-30 h-30 mx-auto mb-8">
              <div className="absolute inset-0 border-3 border-accent-cyan rounded-full animate-ping opacity-75" />
              <div className="absolute inset-10 bg-accent-cyan rounded-full shadow-glow-cyan animate-pulse" />
            </div>
            <p className="text-center text-lg text-text-secondary">Generating API key...</p>
          </div>
        )}

        {/* Success - show API key */}
        {state === 'success' && linkResult && (
          <div className="bg-gradient-to-br from-bg-secondary to-success/5 border border-success/30 rounded-2xl p-12 shadow-xl backdrop-blur-xl">
            {/* Success header */}
            <div className="text-center mb-10">
              <div className="inline-flex items-center justify-center w-16 h-16 mb-6 bg-gradient-to-r from-success to-accent-cyan text-text-inverse text-3xl font-bold rounded-full shadow-glow-green animate-bounce">
                ✓
              </div>
              <h2 className="font-display text-2xl font-semibold mb-3 text-text-primary">
                Machine Linked Successfully
              </h2>
              <p className="text-text-secondary">
                Copy this API key and paste it into your terminal
              </p>
              {linkResult.workspaceId && (
                <p className="mt-2 text-sm text-accent-cyan">
                  Linked to workspace: {workspaces.find(w => w.id === linkResult.workspaceId)?.name || 'Unknown'}
                </p>
              )}
            </div>

            {/* API key box */}
            <div className="mb-10">
              <div className="font-mono text-xs font-semibold uppercase tracking-wide text-accent-cyan mb-3">
                API Key
              </div>
              <div className="relative flex items-center gap-4 bg-black/50 border-2 border-accent-cyan/30 rounded-xl p-5 shadow-glow-cyan">
                <code className="flex-1 font-mono text-[15px] text-success break-all select-all drop-shadow-glow-green">
                  {linkResult.apiKey}
                </code>
                <button
                  onClick={handleCopy}
                  className={`flex-shrink-0 w-11 h-11 flex items-center justify-center rounded-lg text-xl transition-all duration-200 ${
                    copied
                      ? 'bg-success/20 border border-success/50 text-success'
                      : 'bg-accent-cyan/15 border border-accent-cyan/30 text-accent-cyan hover:bg-accent-cyan/25 hover:border-accent-cyan/50 hover:scale-105'
                  }`}
                  title="Copy to clipboard"
                >
                  {copied ? '✓' : '📋'}
                </button>
              </div>
            </div>

            {/* Instructions */}
            <div className="bg-black/30 border border-border-subtle rounded-xl p-6 mb-6">
              <h3 className="font-display text-lg font-semibold mb-4 text-text-primary">
                Next Steps:
              </h3>
              <ol className="space-y-2 text-text-secondary leading-relaxed pl-5">
                <li>Copy the API key above</li>
                <li>Return to your terminal</li>
                <li>Paste the key when prompted</li>
                <li>Your machine is now linked to Agent Relay Cloud</li>
              </ol>
            </div>

            {/* Important note */}
            <div className="p-5 bg-warning/8 border border-warning/20 rounded-xl text-text-primary text-[15px] leading-relaxed">
              <strong className="text-warning font-semibold">Important:</strong> This key will only be shown once. Store it securely
              if you need it later. You can regenerate a new key by running{' '}
              <code className="font-mono text-sm px-1.5 py-0.5 bg-black/30 rounded text-accent-cyan">
                agent-relay cloud link
              </code>{' '}
              again.
            </div>
          </div>
        )}

        {/* Error state */}
        {state === 'error' && (
          <div className="bg-gradient-to-br from-bg-secondary to-error/5 border border-error/30 rounded-2xl p-12 shadow-xl backdrop-blur-xl text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 mb-6 bg-error/15 text-error text-3xl font-bold rounded-full border-2 border-error/30">
              ✕
            </div>
            <h2 className="font-display text-2xl font-semibold mb-4 text-text-primary">
              Link Failed
            </h2>
            <p className="text-error mb-8 leading-relaxed">
              {error}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="w-full px-8 py-4 bg-bg-hover hover:bg-bg-active border border-border-light hover:border-border-medium text-text-primary font-display font-semibold text-lg rounded-xl transition-all duration-200"
            >
              Try Again
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="mt-8 text-center">
          <a
            href="/app"
            className="inline-flex items-center gap-2 text-text-secondary hover:text-accent-cyan transition-colors duration-200"
          >
            <span>←</span>
            <span>Back to Dashboard</span>
          </a>
        </div>
      </div>

      <style jsx>{`
        @keyframes grid-drift {
          0% { transform: translate(0, 0); }
          100% { transform: translate(80px, 80px); }
        }

        @keyframes particle-float {
          0% { opacity: 0; transform: translateY(0); }
          10% { opacity: 0.6; }
          90% { opacity: 0.6; }
          100% { opacity: 0; transform: translateY(-100px); }
        }
      `}</style>
    </div>
  );
}

// Export page wrapped in Suspense for static generation
export default function CloudLinkPage() {
  return (
    <Suspense fallback={<CloudLinkLoading />}>
      <CloudLinkContent />
    </Suspense>
  );
}
