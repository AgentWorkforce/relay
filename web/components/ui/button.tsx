import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold cursor-pointer transition-[transform,background-color,color,border-color] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 shrink-0',
  {
    variants: {
      variant: {
        default: 'border border-transparent bg-[var(--primary-bg)] text-[var(--primary-fg)] hover:bg-[var(--btn-hover)] hover:-translate-y-px',
        secondary: 'border border-transparent bg-[var(--secondary-bg)] text-[var(--secondary-fg)] hover:bg-[var(--secondary-200)] hover:-translate-y-px',
        outline: 'border border-[var(--line)] bg-[var(--bg)] text-[var(--primary)] hover:-translate-y-px',
        inverted: 'border border-transparent bg-[var(--fg)] text-[var(--bg)] hover:-translate-y-px',
        ghost: 'border border-transparent bg-transparent text-[var(--fg-muted)]',
        destructive: 'border border-transparent bg-[#FEE2E2] text-[#DC2626] hover:bg-[#FECACA] hover:-translate-y-px',
      },
      size: {
        default: 'px-5 py-2.5',
        sm: 'px-3.5 py-1.5 text-xs',
        lg: 'px-6 py-3',
        icon: 'size-10 rounded-none p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
