'use client';

import { useState, type FormEvent } from 'react';

import s from './waitlist.module.css';

const WAITLIST_ENDPOINT = process.env.NEXT_PUBLIC_WAITLIST_API_URL?.trim() || 'https://agentrelay.com/cloud/api/waitlist';

export function WaitlistForm() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [submittedEmail, setSubmittedEmail] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    setState('loading');

    try {
      const res = await fetch(WAITLIST_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), source: 'relay-web' }),
      });

      if (res.ok) {
        setSubmittedEmail(email.trim());
        setState('success');
        setEmail('');
      } else {
        setState('error');
      }
    } catch {
      setState('error');
    }
  }

  if (state === 'success') {
    return (
      <div className={s.successCard}>
        <div className={s.successIcon}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        </div>
        <h3 className={s.successTitle}>You&apos;re on the list!</h3>
        <p className={s.successText}>
          We&apos;ll send updates about new features, SDK releases, and early access
          to <strong>{submittedEmail}</strong>
        </p>
      </div>
    );
  }

  return (
    <form className={s.form} onSubmit={handleSubmit}>
      <input
        type="email"
        placeholder="Email address"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        className={s.input}
        disabled={state === 'loading'}
      />
      <button type="submit" className={s.button} disabled={state === 'loading'}>
        {state === 'loading' ? 'Joining...' : 'Join Waitlist'}
      </button>
      {state === 'error' && (
        <p className={s.error}>Something went wrong. Please try again.</p>
      )}
    </form>
  );
}
