import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger';

const variantClasses: Record<Variant, string> = {
  primary: 'bg-accent text-surface hover:bg-accent/90',
  secondary: 'border border-border bg-panel text-gray-200 hover:bg-border',
  danger: 'border border-red-500/40 text-red-300 hover:bg-red-500/10',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
}

export function Button({ variant = 'secondary', size = 'md', className = '', ...props }: ButtonProps) {
  const sizeClasses = size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm';
  return (
    <button
      type="button"
      className={`rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${sizeClasses} ${variantClasses[variant]} ${className}`}
      {...props}
    />
  );
}
