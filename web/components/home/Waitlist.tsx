import { WaitlistForm } from '../WaitlistForm';
import s from '../../app/landing.module.css';

export function Waitlist() {
  return (
    <section className={s.waitlistSection} aria-labelledby="waitlist-title">
      <div className={s.waitlistInner}>
        <div className={s.waitlistCopy}>
          <h2 id="waitlist-title" className={s.waitlistTitle}>
            Be the first to know
          </h2>
          <p className={s.waitlistSubtitle}>
            Join the waitlist for early access when we release new products.
          </p>
        </div>
        <div className={s.waitlistFormPanel}>
          <WaitlistForm />
        </div>
      </div>
    </section>
  );
}
