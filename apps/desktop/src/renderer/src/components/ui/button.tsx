/**
 * Source: shadcn/ui — Button (new-york-v4, MIT) https://ui.shadcn.com
 * Adapted for The Insectoids: our design tokens (honey, surface, line), 40 px minimum targets
 * (App 07 accessibility), and a visible focus ring on every variant.
 */
import { type VariantProps, cva } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-[10px] text-sm font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-honey focus-visible:ring-offset-2 focus-visible:ring-offset-ground disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
  {
    variants: {
      variant: {
        default: 'bg-honey text-honey-ink hover:bg-honey/90',
        outline: 'border border-line bg-surface text-text hover:bg-surface-2',
        ghost: 'text-muted hover:bg-surface-2 hover:text-text',
        link: 'min-h-0 text-honey-text underline-offset-4 hover:underline',
      },
      size: {
        default: 'px-4',
        sm: 'px-3 text-[13px]',
        lg: 'min-h-11 px-6 text-[15px]',
        icon: 'size-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

function Button({ className, variant = 'default', size = 'default', asChild = false, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      data-size={size}
      data-slot="button"
      data-variant={variant}
      // Buttons never submit forms by accident.
      {...(asChild ? {} : { type: type ?? 'button' })}
      {...props}
    />
  );
}

export { Button, buttonVariants };
