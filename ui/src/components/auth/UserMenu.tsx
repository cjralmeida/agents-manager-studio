import { type FormEvent, useEffect, useRef, useState } from 'react';
import { type AuthUser, type Theme, useChangePassword, useLogout, useUpdateProfile } from '../../api/auth';
import { applyTheme, themeLabels } from '../../lib/theme';
import { Button } from '../Button';
import { ErrorText, Field, TextInput } from '../form';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');

/** Bottom of the sidebar: who is signed in, theme, password and sign out. */
export function UserMenu({ user }: { user: AuthUser }) {
  const [open, setOpen] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const logout = useLogout();
  const profile = useUpdateProfile();

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const setTheme = (theme: Theme) => {
    applyTheme(theme);
    profile.mutate({ theme });
  };

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-border/50"
        aria-expanded={open}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/20 text-xs font-semibold text-accent">
          {initials(user.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{user.name}</span>
          <span className="block truncate text-xs text-muted">{user.email}</span>
        </span>
      </button>

      {open && (
        <div className="absolute right-0 bottom-full left-0 z-40 mb-2 rounded-lg border border-border bg-panel p-2 shadow-xl">
          <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wider text-muted uppercase">Tema</p>
          <div className="flex rounded-md border border-border p-0.5">
            {(Object.keys(themeLabels) as Theme[]).map((theme) => (
              <button
                key={theme}
                type="button"
                onClick={() => setTheme(theme)}
                className={`flex-1 rounded px-2 py-1 text-xs font-medium ${user.theme === theme ? 'bg-border text-white' : 'text-muted hover:text-white'}`}
              >
                {themeLabels[theme]}
              </button>
            ))}
          </div>
          <div className="mt-2 border-t border-border pt-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setChangingPassword(true);
              }}
              className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-border/60"
            >
              Alterar senha
            </button>
            <button
              type="button"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
              className="w-full rounded px-2 py-1.5 text-left text-sm text-red-300 hover:bg-border/60"
            >
              Sair
            </button>
          </div>
        </div>
      )}

      {changingPassword && <ChangePasswordDialog onClose={() => setChangingPassword(false)} />}
    </div>
  );
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const change = useChangePassword();
  const mismatch = confirm.length > 0 && next !== confirm;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    change.mutate({ currentPassword: current, newPassword: next });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <form onSubmit={handleSubmit} onClick={(event) => event.stopPropagation()} className="w-full max-w-sm rounded-xl border border-border bg-panel p-5 shadow-2xl">
        <h2 className="text-base font-semibold">Alterar senha</h2>
        {change.isSuccess ? (
          <div className="mt-3 space-y-4">
            <p className="text-sm text-emerald-300">Senha alterada. As outras sessões abertas foram encerradas.</p>
            <Button variant="primary" onClick={onClose}>
              Fechar
            </Button>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <Field label="Senha atual">
              <TextInput type="password" value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" autoFocus required />
            </Field>
            <Field label="Nova senha" hint="Pelo menos 10 caracteres.">
              <TextInput type="password" value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" minLength={10} required />
            </Field>
            <Field label="Repita a nova senha">
              <TextInput type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" required />
            </Field>
            {mismatch && <p className="text-xs text-amber-300">As senhas não conferem.</p>}
            <ErrorText error={change.error} />
            <div className="flex justify-end gap-2 pt-1">
              <Button onClick={onClose}>Cancelar</Button>
              <Button type="submit" variant="primary" disabled={change.isPending || !current || next.length < 10 || next !== confirm}>
                {change.isPending ? 'Salvando...' : 'Alterar senha'}
              </Button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
