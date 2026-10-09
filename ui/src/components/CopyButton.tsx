import { useState } from 'react';
import { Button } from './Button';

/** Copies a text (e.g. a command) and confirms for a moment. */
export function CopyButton({ text, label = 'Copiar', onCopied }: { text: string; label?: string; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      onCopied?.();
      setTimeout(() => setCopied(false), 2_000);
    });
  };

  return (
    <Button size="sm" onClick={copy}>
      {copied ? 'Copiado ✓' : label}
    </Button>
  );
}

/** A command in a box, ready to copy. */
export function CommandBox({ command, onCopied }: { command: string; onCopied?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-surface p-2">
      <code className="min-w-0 flex-1 font-mono text-xs break-all">{command}</code>
      <CopyButton text={command} onCopied={onCopied} />
    </div>
  );
}
