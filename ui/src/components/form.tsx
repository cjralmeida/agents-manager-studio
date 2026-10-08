import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

const controlClasses =
  'w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent';

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${controlClasses} ${className}`} {...props} />;
}

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${controlClasses} ${className}`} {...props} />;
}

export function ErrorText({ error }: { error: Error | null }) {
  return error ? <p className="text-sm text-red-300">{error.message}</p> : null;
}
