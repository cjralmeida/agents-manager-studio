import { type FormEvent, useState } from 'react';
import { useLogin } from '../../api/auth';
import { Button } from '../Button';
import { ErrorText, Field, TextInput } from '../form';
import { Logo } from '../Logo';

/** Sign-in screen; users are created by an administrator, so there is no sign-up. */
export function LoginPage({ error }: { error: Error | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useLogin();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate({ email: email.trim(), password });
  };

  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden px-4 py-10">
      {/* The orbit of the logo, large and faint, behind the card. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 h-[34rem] w-[60rem] -translate-x-1/2 -translate-y-1/2 -rotate-[28deg] rounded-[50%] border border-accent/15"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 h-[22rem] w-[40rem] -translate-x-1/2 -translate-y-1/2 -rotate-[28deg] rounded-[50%] border border-accent/10"
      />

      <form onSubmit={handleSubmit} className="relative w-full max-w-sm rounded-2xl border border-border bg-panel p-7 shadow-2xl shadow-black/20">
        <div className="flex flex-col items-center text-center">
          <Logo size={56} />
          <h1 className="mt-4 text-lg font-semibold">Agents Manager Studio</h1>
          <p className="mt-1 text-sm text-muted">Entre com a sua conta para continuar.</p>
        </div>

        <div className="mt-6 space-y-4">
          <Field label="E-mail">
            <TextInput type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" autoFocus required />
          </Field>
          <Field label="Senha">
            <TextInput type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
          </Field>
          <Button type="submit" variant="primary" className="w-full py-2" disabled={login.isPending || !email.trim() || !password}>
            {login.isPending ? 'Entrando...' : 'Entrar'}
          </Button>
          <ErrorText error={login.error ?? error} />
        </div>

        <p className="mt-6 text-center text-xs text-muted">Não tem conta? Peça a um administrador do Studio.</p>
      </form>
    </div>
  );
}
