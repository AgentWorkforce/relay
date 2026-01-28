/**
 * Billing Result Component
 *
 * Premium success/cancel pages after Stripe checkout.
 * Features celebratory animations, confetti, and polished micro-interactions.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { cloudApi } from '../lib/cloudApi';

interface DeferredWorkspace {
  workspaceId: string;
  workspaceName: string;
  agentCount: number;
}

export interface BillingResultProps {
  type: 'success' | 'canceled';
  sessionId?: string;
  deferredWorkspaces?: DeferredWorkspace[];
  onClose: () => void;
}

interface SubscriptionInfo {
  plan: string;
  status: string;
}

// Confetti particle component
function Confetti() {
  const particles = useMemo(() => {
    return Array.from({ length: 50 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      delay: Math.random() * 0.5,
      duration: 2 + Math.random() * 2,
      size: 4 + Math.random() * 8,
      color: ['#00d9ff', '#00b8d9', '#4ade80', '#facc15', '#f472b6', '#a78bfa'][Math.floor(Math.random() * 6)],
      rotation: Math.random() * 360,
    }));
  }, []);

  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-50">
      {particles.map((p) => (
        <div
          key={p.id}
          className="absolute animate-confetti-fall"
          style={{
            left: `${p.x}%`,
            top: '-20px',
            width: p.size,
            height: p.size * 0.6,
            backgroundColor: p.color,
            transform: `rotate(${p.rotation}deg)`,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            borderRadius: '2px',
          }}
        />
      ))}
      <style>{`
        @keyframes confetti-fall {
          0% {
            transform: translateY(0) rotate(0deg) scale(1);
            opacity: 1;
          }
          100% {
            transform: translateY(100vh) rotate(720deg) scale(0.5);
            opacity: 0;
          }
        }
        .animate-confetti-fall {
          animation: confetti-fall linear forwards;
        }
      `}</style>
    </div>
  );
}

// Animated checkmark with draw effect
function AnimatedCheckmark() {
  return (
    <div className="relative w-20 h-20">
      {/* Glow ring */}
      <div className="absolute inset-0 rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400 opacity-20 animate-pulse-slow" />

      {/* Main circle with gradient border */}
      <div className="absolute inset-1 rounded-full bg-gradient-to-br from-emerald-400 via-emerald-500 to-cyan-500 p-0.5 animate-scale-in">
        <div className="w-full h-full rounded-full bg-bg-primary flex items-center justify-center">
          <svg
            className="w-10 h-10"
            viewBox="0 0 24 24"
            fill="none"
          >
            <path
              d="M5 12l5 5L19 7"
              stroke="url(#check-gradient)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="animate-draw-check"
              style={{
                strokeDasharray: 30,
                strokeDashoffset: 30,
              }}
            />
            <defs>
              <linearGradient id="check-gradient" x1="5" y1="12" x2="19" y2="7">
                <stop stopColor="#34d399" />
                <stop offset="1" stopColor="#22d3ee" />
              </linearGradient>
            </defs>
          </svg>
        </div>
      </div>

      {/* Sparkle particles */}
      <div className="absolute -top-1 -right-1 w-3 h-3 bg-yellow-400 rounded-full animate-sparkle" style={{ animationDelay: '0.5s' }} />
      <div className="absolute top-0 -left-2 w-2 h-2 bg-cyan-400 rounded-full animate-sparkle" style={{ animationDelay: '0.7s' }} />
      <div className="absolute -bottom-1 right-2 w-2 h-2 bg-emerald-400 rounded-full animate-sparkle" style={{ animationDelay: '0.9s' }} />

      <style>{`
        @keyframes scale-in {
          0% { transform: scale(0); opacity: 0; }
          50% { transform: scale(1.1); }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes draw-check {
          to { stroke-dashoffset: 0; }
        }
        @keyframes sparkle {
          0%, 100% { transform: scale(0); opacity: 0; }
          50% { transform: scale(1); opacity: 1; }
        }
        @keyframes pulse-slow {
          0%, 100% { transform: scale(1); opacity: 0.2; }
          50% { transform: scale(1.2); opacity: 0.4; }
        }
        .animate-scale-in {
          animation: scale-in 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
        .animate-draw-check {
          animation: draw-check 0.4s ease-out 0.4s forwards;
        }
        .animate-sparkle {
          animation: sparkle 1s ease-in-out infinite;
        }
        .animate-pulse-slow {
          animation: pulse-slow 2s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}

// Premium loading spinner
function LoadingSpinner() {
  return (
    <div className="relative w-20 h-20">
      {/* Outer rotating ring */}
      <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-accent-cyan border-r-accent-cyan/50 animate-spin" />

      {/* Inner pulsing core */}
      <div className="absolute inset-3 rounded-full bg-gradient-to-br from-accent-cyan/20 to-transparent animate-pulse" />

      {/* Center dot */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="w-3 h-3 rounded-full bg-accent-cyan animate-ping" />
      </div>

      {/* Orbiting particles */}
      <div className="absolute inset-0 animate-spin" style={{ animationDuration: '3s' }}>
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-accent-cyan/80" />
      </div>
      <div className="absolute inset-0 animate-spin" style={{ animationDuration: '4s', animationDirection: 'reverse' }}>
        <div className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-cyan-300/60" />
      </div>
    </div>
  );
}

// Benefit item with staggered animation
function BenefitItem({ children, delay }: { children: React.ReactNode; delay: number }) {
  return (
    <li
      className="flex items-center gap-3 opacity-0 animate-slide-in-left"
      style={{ animationDelay: `${delay}s`, animationFillMode: 'forwards' }}
    >
      <div className="w-5 h-5 rounded-full bg-gradient-to-br from-emerald-400 to-cyan-400 flex items-center justify-center flex-shrink-0">
        <svg className="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <span className="text-text-secondary">{children}</span>
      <style>{`
        @keyframes slide-in-left {
          from {
            opacity: 0;
            transform: translateX(-20px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        .animate-slide-in-left {
          animation: slide-in-left 0.4s ease-out forwards;
        }
      `}</style>
    </li>
  );
}

export function BillingResult({ type, sessionId, onClose }: BillingResultProps) {
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [isLoading, setIsLoading] = useState(type === 'success');
  const [error, setError] = useState<string | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);

  useEffect(() => {
    if (type !== 'success') return;

    const fetchSubscription = async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 1500));

        const result = await cloudApi.getSubscription();
        if (result.success && result.data) {
          setSubscription({
            plan: result.data.subscription?.tier || 'pro',
            status: result.data.subscription?.status || 'active',
          });
          // Trigger confetti after successful load
          setTimeout(() => setShowConfetti(true), 200);
        }
      } catch (err) {
        setError('Could not verify subscription. Please check your billing settings.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchSubscription();
  }, [type, sessionId]);

  const planName = subscription?.plan === 'pro' ? 'Pro' : subscription?.plan === 'team' ? 'Team' : subscription?.plan === 'enterprise' ? 'Enterprise' : 'Premium';

  if (type === 'success') {
    return (
      <div className="min-h-screen bg-bg-deep flex items-center justify-center p-4 overflow-hidden">
        {/* Background gradient orbs */}
        <div className="fixed inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-1/4 -left-32 w-96 h-96 bg-accent-cyan/10 rounded-full blur-3xl animate-float" />
          <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '1s' }} />
        </div>

        {showConfetti && <Confetti />}

        <div
          className="relative max-w-md w-full bg-bg-primary/95 backdrop-blur-xl rounded-3xl border border-border-subtle p-10 text-center shadow-2xl opacity-0 animate-fade-scale-in"
          style={{ animationFillMode: 'forwards' }}
        >
          {/* Decorative top gradient line */}
          <div className="absolute top-0 left-8 right-8 h-1 rounded-full bg-gradient-to-r from-transparent via-accent-cyan to-transparent" />

          {isLoading ? (
            <div className="py-8">
              <div className="flex justify-center mb-8">
                <LoadingSpinner />
              </div>
              <h1 className="text-2xl font-bold text-text-primary mb-3 tracking-tight">
                Processing your upgrade
              </h1>
              <p className="text-text-muted">
                Confirming your subscription...
              </p>
            </div>
          ) : error ? (
            <div className="py-4">
              <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-amber-500/20 flex items-center justify-center">
                <svg className="w-8 h-8 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <h1 className="text-2xl font-bold text-text-primary mb-3">
                Almost there!
              </h1>
              <p className="text-text-muted mb-8">{error}</p>
              <button
                onClick={onClose}
                className="group w-full py-4 px-6 bg-gradient-to-r from-accent-cyan to-cyan-400 text-bg-deep font-bold rounded-2xl transition-all duration-300 hover:shadow-[0_0_30px_rgba(0,217,255,0.4)] hover:scale-[1.02] active:scale-[0.98]"
              >
                Go to Billing Settings
              </button>
            </div>
          ) : (
            <>
              <div className="flex justify-center mb-6">
                <AnimatedCheckmark />
              </div>

              <h1
                className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-text-primary via-accent-cyan to-emerald-400 mb-3 tracking-tight opacity-0 animate-fade-in"
                style={{ animationDelay: '0.3s', animationFillMode: 'forwards' }}
              >
                Welcome to {planName}!
              </h1>

              <p
                className="text-text-muted mb-8 opacity-0 animate-fade-in"
                style={{ animationDelay: '0.5s', animationFillMode: 'forwards' }}
              >
                Your subscription is active. Time to supercharge your workflow.
              </p>

              <div
                className="bg-gradient-to-br from-bg-secondary to-bg-deep rounded-2xl p-5 mb-8 text-left border border-border-subtle/50 opacity-0 animate-fade-in"
                style={{ animationDelay: '0.6s', animationFillMode: 'forwards' }}
              >
                <h3 className="text-xs font-bold text-accent-cyan uppercase tracking-wider mb-4">Your new powers</h3>
                <ul className="space-y-3 text-sm">
                  <BenefitItem delay={0.8}>Expanded workspace & repository limits</BenefitItem>
                  <BenefitItem delay={0.9}>More compute hours for your agents</BenefitItem>
                  <BenefitItem delay={1.0}>Increased concurrent agent capacity</BenefitItem>
                  <BenefitItem delay={1.1}>Priority support & faster responses</BenefitItem>
                </ul>
              </div>

              <button
                onClick={onClose}
                className="group w-full py-4 px-6 bg-gradient-to-r from-accent-cyan via-cyan-400 to-emerald-400 text-bg-deep font-bold rounded-2xl transition-all duration-300 hover:shadow-[0_0_40px_rgba(0,217,255,0.5)] hover:scale-[1.02] active:scale-[0.98] opacity-0 animate-fade-in"
                style={{ animationDelay: '1.2s', animationFillMode: 'forwards' }}
              >
                <span className="flex items-center justify-center gap-2">
                  Launch Dashboard
                  <svg className="w-5 h-5 transition-transform group-hover:translate-x-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </button>
            </>
          )}
        </div>

        <style>{`
          @keyframes fade-scale-in {
            from {
              opacity: 0;
              transform: scale(0.95) translateY(10px);
            }
            to {
              opacity: 1;
              transform: scale(1) translateY(0);
            }
          }
          @keyframes fade-in {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @keyframes float {
            0%, 100% { transform: translateY(0) scale(1); }
            50% { transform: translateY(-20px) scale(1.05); }
          }
          .animate-fade-scale-in {
            animation: fade-scale-in 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
          }
          .animate-fade-in {
            animation: fade-in 0.5s ease-out forwards;
          }
          .animate-float {
            animation: float 6s ease-in-out infinite;
          }
        `}</style>
      </div>
    );
  }

  // Canceled flow
  return (
    <div className="min-h-screen bg-bg-deep flex items-center justify-center p-4">
      {/* Subtle background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/3 left-1/4 w-64 h-64 bg-text-muted/5 rounded-full blur-3xl" />
      </div>

      <div
        className="relative max-w-md w-full bg-bg-primary/95 backdrop-blur-xl rounded-3xl border border-border-subtle p-10 text-center shadow-xl opacity-0 animate-fade-scale-in"
        style={{ animationFillMode: 'forwards' }}
      >
        <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-bg-secondary border border-border-subtle flex items-center justify-center">
          <svg className="w-7 h-7 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <h1 className="text-2xl font-bold text-text-primary mb-3">
          No problem!
        </h1>
        <p className="text-text-muted mb-8 leading-relaxed">
          Checkout was canceled and you haven't been charged.
          You can upgrade anytime when you're ready.
        </p>

        <div className="space-y-3">
          <button
            onClick={onClose}
            className="group w-full py-4 px-6 bg-gradient-to-r from-accent-cyan to-cyan-400 text-bg-deep font-bold rounded-2xl transition-all duration-300 hover:shadow-[0_0_30px_rgba(0,217,255,0.4)] hover:scale-[1.02] active:scale-[0.98]"
          >
            <span className="flex items-center justify-center gap-2">
              Return to Dashboard
              <svg className="w-5 h-5 transition-transform group-hover:translate-x-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </button>
          <button
            onClick={() => {
              window.location.href = '/?settings=billing';
            }}
            className="w-full py-4 px-6 bg-bg-secondary text-text-primary font-semibold rounded-2xl border border-border-subtle transition-all duration-300 hover:border-accent-cyan/50 hover:bg-bg-secondary/80"
          >
            View Plans
          </button>
        </div>
      </div>

      <style>{`
        @keyframes fade-scale-in {
          from {
            opacity: 0;
            transform: scale(0.95) translateY(10px);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }
        .animate-fade-scale-in {
          animation: fade-scale-in 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
      `}</style>
    </div>
  );
}
