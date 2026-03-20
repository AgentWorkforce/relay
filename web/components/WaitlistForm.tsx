'use client';

import { useState, type FormEvent } from 'react';

import s from './waitlist.module.css';

export function WaitlistForm() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    setState('loading');

    try {
      // Replace with your actual waitlist API endpoint
      const res = await fetch('https://agent-relay.com/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (res.ok) {
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
      <div className={s.successMessage}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        <span>You&apos;re on the list. We&apos;ll be in touch.</span>
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
