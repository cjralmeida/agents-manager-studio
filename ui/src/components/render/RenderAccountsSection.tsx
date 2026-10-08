import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import {
  type RenderAccount,
  useCreateRenderAccount,
  useDeleteRenderAccount,
  useRenderAccounts,
  useRenderConnections,
  useUpdateRenderAccount,
  useVerifyRenderAccount,
} from '../../api/render';
import { plural } from '../../lib/time';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, Field, TextInput } from '../form';

/** Global Render accounts; each workspace picks one in its Conectores tab. */
export function RenderAccountsSection() {
  const accounts = useRenderAccounts();

  return (
    <section>
      <h2 className="text-base font-semibold">Contas do Render</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Chave de API do Render (Account Settings → API Keys). Fica criptografada e nunca vai para os agentes. Depois de
        adicionar, escolha a conta na aba Conectores de cada workspace e indique o serviço de cada projeto.
      </p>

      <ErrorText error={accounts.error} />
      <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
        {accounts.data?.map((account) => <RenderAccountItem key={account.id} account={account} />)}
        {accounts.data?.length === 0 && <li className="px-4 py-3 text-sm text-muted">Nenhuma conta cadastrada.</li>}
      </ul>

      <NewRenderAccountForm />
      <RenderWorkspaces />
    </section>
  );
}

function RenderAccountItem({ account }: { account: RenderAccount }) {
  const [editing, setEditing] = useState(false);
  const remove = useDeleteRenderAccount();
  const verify = useVerifyRenderAccount();

  const handleRemove = () => {
    const usage = account.workspaceCount > 0 ? ` ${account.workspaceCount} workspace(s) ficarão sem deploy.` : '';
    if (window.confirm(`Remover a conta "${account.label}"?${usage}`)) remove.mutate(account.id);
  };

  if (editing) return <EditRenderAccountItem account={account} onDone={() => setEditing(false)} />;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="info">Render</Badge>
        <span className="font-medium">{account.label}</span>
        <span className="text-xs text-muted">{account.ownerName}</span>
        <span className="font-mono text-xs text-muted">{account.apiKeyHint}</span>
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
        {verify.isSuccess && <p className="text-xs text-emerald-300">Chave válida: {verify.data.ownerName}.</p>}
        {verify.error && <p className="text-xs text-red-300">{verify.error.message}</p>}
        {remove.error && <p className="text-xs text-red-300">{remove.error.message}</p>}
      </div>
    </li>
  );
}

function EditRenderAccountItem({ account, onDone }: { account: RenderAccount; onDone: () => void }) {
  const [label, setLabel] = useState(account.label);
  const [apiKey, setApiKey] = useState('');
  const update = useUpdateRenderAccount();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ id: account.id, label, ...(apiKey.trim() && { apiKey }) }, { onSuccess: onDone });
  };

  return (
    <li className="px-4 py-3">
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <Field label="Nome">
          <TextInput value={label} onChange={(event) => setLabel(event.target.value)} required />
        </Field>
        <Field label="Nova chave (opcional)">
          <TextInput
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Deixe vazio para manter"
            autoComplete="off"
          />
        </Field>
        <Button type="submit" variant="primary" disabled={update.isPending}>
          {update.isPending ? 'Verificando...' : 'Salvar'}
        </Button>
        <Button onClick={onDone}>Cancelar</Button>
        <ErrorText error={update.error} />
      </form>
    </li>
  );
}

function NewRenderAccountForm() {
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const create = useCreateRenderAccount();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { label, apiKey },
      {
        onSuccess: () => {
          setLabel('');
          setApiKey('');
        },
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="mt-4 rounded-lg border border-border bg-panel p-4">
      <h3 className="text-sm font-medium">Adicionar conta do Render</h3>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Nome">
          <TextInput value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Ex.: Render GlobalFarm" required />
        </Field>
        <Field label="Chave de API">
          <TextInput
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="rnd_..."
            autoComplete="off"
            required
          />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={create.isPending || !apiKey.trim()}>
          {create.isPending ? 'Verificando...' : 'Adicionar'}
        </Button>
        <ErrorText error={create.error} />
      </div>
    </form>
  );
}

/** Workspaces that picked a Render account, with a shortcut to their services. */
function RenderWorkspaces() {
  const connections = useRenderConnections();
  if (!connections.data?.length) return null;

  return (
    <div className="mt-6">
      <h3 className="text-sm font-medium">Workspaces que usam o Render</h3>
      <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
        {connections.data.map((connection) => (
          <li key={connection.workspaceId} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
            <span>
              <span className="font-medium">{connection.workspaceName}</span>
              <span className="text-muted">
                {' '}
                · {connection.accountLabel} · {plural(connection.services, 'serviço', 'serviços')}
              </span>
            </span>
            <Link to={`/workspaces/${connection.workspaceId}?tab=connectors`} className="text-xs text-accent hover:underline">
              Abrir
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
