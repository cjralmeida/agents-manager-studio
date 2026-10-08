import { type FormEvent, useState } from 'react';
import {
  type AgentAccount,
  useAgentAccounts,
  useCreateAgentAccount,
  useDeleteAgentAccount,
  useUpdateAgentAccount,
  useVerifyAgentAccount,
} from '../../api/accounts';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, Field, TextInput } from '../form';

export function AgentAccountsSection() {
  const accounts = useAgentAccounts();

  return (
    <section>
      <h2 className="text-base font-semibold">Contas de agente</h2>
      <p className="mt-1 text-sm text-muted">
        Sua assinatura Claude (Pro/Max) usada pelos agentes, sem API key nem cobrança por uso. Rode{' '}
        <code className="text-gray-300">claude setup-token</code> no terminal, faça login com a conta do plano e cole o
        token gerado (<code className="text-gray-300">sk-ant-oat01-…</code>). O uso dos agentes conta no limite do plano.
      </p>

      <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
        {accounts.data?.map((account) => <AgentAccountItem key={account.id} account={account} />)}
        {accounts.data?.length === 0 && <li className="px-4 py-3 text-sm text-muted">Nenhuma conta cadastrada.</li>}
      </ul>

      <NewAgentAccountForm />
    </section>
  );
}

function AgentAccountItem({ account }: { account: AgentAccount }) {
  const [editing, setEditing] = useState(false);
  const remove = useDeleteAgentAccount();
  const verify = useVerifyAgentAccount();

  const handleRemove = () => {
    const usage = account.workspaceCount > 0 ? ` ${account.workspaceCount} workspace(s) ficarão sem conta de agente.` : '';
    if (window.confirm(`Remover a conta "${account.label}"?${usage}`)) remove.mutate(account.id);
  };

  if (editing) return <EditAgentAccountItem account={account} onDone={() => setEditing(false)} />;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
      <div className="flex items-center gap-2">
        <Badge tone="info">Claude</Badge>
        <span className="font-medium">{account.label}</span>
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
        {verify.isSuccess && <p className="text-xs text-emerald-300">Token válido: o Claude respondeu.</p>}
        {verify.error && <p className="text-xs text-red-300">{verify.error.message}</p>}
      </div>
    </li>
  );
}

function EditAgentAccountItem({ account, onDone }: { account: AgentAccount; onDone: () => void }) {
  const [label, setLabel] = useState(account.label);
  const [token, setToken] = useState('');
  const update = useUpdateAgentAccount();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ id: account.id, label, ...(token && { token }) }, { onSuccess: onDone });
  };

  return (
    <li className="px-4 py-3">
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <Field label="Nome">
          <TextInput value={label} onChange={(event) => setLabel(event.target.value)} required />
        </Field>
        <Field label="Novo token (opcional)">
          <TextInput
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Deixe vazio para manter"
            autoComplete="off"
          />
        </Field>
        <Button type="submit" variant="primary" disabled={update.isPending}>
          Salvar
        </Button>
        <Button onClick={onDone}>Cancelar</Button>
        <ErrorText error={update.error} />
      </form>
    </li>
  );
}

function NewAgentAccountForm() {
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const create = useCreateAgentAccount();

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
      <h3 className="text-sm font-medium">Adicionar conta Claude</h3>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Nome">
          <TextInput value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Ex.: Claude Max" required />
        </Field>
        <Field label="Token da assinatura (claude setup-token)">
          <TextInput
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="sk-ant-oat01-..."
            autoComplete="off"
            required
          />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={create.isPending}>
          Adicionar
        </Button>
        <ErrorText error={create.error} />
      </div>
    </form>
  );
}
