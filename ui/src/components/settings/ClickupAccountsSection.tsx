import { type FormEvent, useState } from 'react';
import {
  type ClickupAccount,
  useClickupAccounts,
  useCreateClickupAccount,
  useDeleteClickupAccount,
  useUpdateClickupAccount,
  useVerifyClickupAccount,
} from '../../api/clickup';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, Field, TextInput } from '../form';

/** ClickUp accounts; each workspace picks one in its Conectores tab, and its agents can only read tasks. */
export function ClickupAccountsSection() {
  const accounts = useClickupAccounts();

  return (
    <section>
      <h2 className="text-base font-semibold">Contas do ClickUp</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Token pessoal do ClickUp (Settings → Apps → API Token, começa com <span className="font-mono">pk_</span>). Fica criptografado e nunca vai
        para os agentes: eles só leem tarefas por ferramentas do Studio, sem alterar nada no ClickUp. Depois de adicionar, escolha a conta na aba
        Conectores do workspace e dê aos agentes a ferramenta "ClickUp (leitura)".
      </p>

      <ErrorText error={accounts.error} />
      <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
        {accounts.data?.map((account) => <ClickupAccountItem key={account.id} account={account} />)}
        {accounts.data?.length === 0 && <li className="px-4 py-3 text-sm text-muted">Nenhuma conta cadastrada.</li>}
      </ul>

      <NewClickupAccountForm />
    </section>
  );
}

function ClickupAccountItem({ account }: { account: ClickupAccount }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(account.label);
  const [token, setToken] = useState('');
  const update = useUpdateClickupAccount();
  const remove = useDeleteClickupAccount();
  const verify = useVerifyClickupAccount();

  const handleRemove = () => {
    const usage = account.workspaceCount > 0 ? ` ${account.workspaceCount} workspace(s) ficarão sem ClickUp.` : '';
    if (window.confirm(`Remover a conta "${account.label}"?${usage}`)) remove.mutate(account.id);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      { id: account.id, label, ...(token.trim() && { token }) },
      {
        onSuccess: () => {
          setEditing(false);
          setToken('');
        },
      },
    );
  };

  if (editing) {
    return (
      <li className="px-4 py-3">
        <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
          <Field label="Nome">
            <TextInput id={`clickup-label-${account.id}`} value={label} onChange={(event) => setLabel(event.target.value)} required />
          </Field>
          <Field label="Novo token (opcional)">
            <TextInput
              id={`clickup-token-${account.id}`}
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Deixe vazio para manter"
              autoComplete="off"
            />
          </Field>
          <Button type="submit" variant="primary" disabled={update.isPending}>
            {update.isPending ? 'Verificando...' : 'Salvar'}
          </Button>
          <Button onClick={() => setEditing(false)}>Cancelar</Button>
          <ErrorText error={update.error} />
        </form>
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="info">ClickUp</Badge>
        <span className="font-medium">{account.label}</span>
        <span className="text-xs text-muted">{account.username}</span>
        <span className="font-mono text-xs text-muted">{account.tokenHint}</span>
        <span className="text-xs text-muted">· {account.workspaceCount} workspace(s)</span>
      </div>
      <div className="flex flex-col items-end gap-1">
        <div className="flex gap-2">
          <Button size="sm" onClick={() => verify.mutate(account.id)} disabled={verify.isPending}>
            {verify.isPending ? 'Testando...' : 'Testar'}
          </Button>
          <Button size="sm" onClick={() => setEditing(true)}>
            Editar
          </Button>
          <Button size="sm" variant="danger" onClick={handleRemove} disabled={remove.isPending}>
            Remover
          </Button>
        </div>
        {verify.isSuccess && <p className="text-xs text-emerald-300">Token válido: {verify.data.username}.</p>}
        {verify.error && <p className="text-xs text-red-300">{verify.error.message}</p>}
        {remove.error && <p className="text-xs text-red-300">{remove.error.message}</p>}
      </div>
    </li>
  );
}

function NewClickupAccountForm() {
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const create = useCreateClickupAccount();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { label, token },
      {
        onSuccess: () => {
          setLabel('');
          setToken('');
        },
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="mt-4 rounded-lg border border-border bg-panel p-4">
      <h3 className="text-sm font-medium">Adicionar conta do ClickUp</h3>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Nome">
          <TextInput id="clickup-new-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Ex.: ClickUp GlobalFarm" required />
        </Field>
        <Field label="Token pessoal">
          <TextInput
            id="clickup-new-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="pk_..."
            autoComplete="off"
            required
          />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={create.isPending || !token.trim()}>
          {create.isPending ? 'Verificando...' : 'Adicionar'}
        </Button>
        <ErrorText error={create.error} />
      </div>
    </form>
  );
}
