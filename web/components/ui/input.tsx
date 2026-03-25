import * as React from 'react';

import { cn } from '../../lib/utils';

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--bg-elevated)] px-4 py-2 text-sm text-[var(--fg)] outline-none transition-colors placeholder:text-[var(--fg-faint)] focus-visible:border-[color-mix(in_srgb,var(--primary)_40%,transparent)] focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_8%,transparent)] disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };
