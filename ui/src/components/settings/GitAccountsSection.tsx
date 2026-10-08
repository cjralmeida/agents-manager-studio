import { type FormEvent, useState } from 'react';
import {
  type AccountGitProvider,
  type GitAccount,
  useCreateGitAccount,
  useDeleteGitAccount,
  useGitAccounts,
  useUpdateGitAccount,
  useVerifyGitAccount,
} from '../../api/accounts';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, Field, Select, TextInput } from '../form';

export const gitProviderLabels: Record<AccountGitProvider, string> = { GITHUB: 'GitHub', GITLAB: 'GitLab' };

const defaultHosts: Record<AccountGitProvider, string> = { GITHUB: 'github.com', GITLAB: 'gitlab.com' };

const tokenHints: Record<AccountGitProvider, string> = {
  GITHUB: 'Token fine-grained com Contents e Pull requests (leitura e escrita), ou classic com "repo".',
  GITLAB: 'Personal access token com os escopos "api" e "write_repository".',
};

/** Git accounts; with `provider`, only that provider's (used inside its connector). */
export function GitAccountsSection({ provider }: { provider?: AccountGitProvider }) {
  const accounts = useGitAccounts();
  const list = provider ? accounts.data?.filter((account) => account.provider === provider) : accounts.data;

  return (
    <section>
      <h2 className="text-base font-semibold">{provider ? 'Contas' : 'Contas Git'}</h2>
      <p className="mt-1 text-sm text-muted">
        Usadas pelos agentes para push e para abrir PR/MR. O token é verificado no provedor e salvo criptografado.
      </p>

      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-panel text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Conta</th>
              <th className="px-4 py-2 font-medium">Host</th>
              <th className="px-4 py-2 font-medium">Token</th>
              <th className="px-4 py-2 font-medium">Workspaces</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {list?.map((account) => <GitAccountRow key={account.id} account={account} />)}
            {list?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-3 text-muted">
                  Nenhuma conta cadastrada.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <NewGitAccountForm fixedProvider={provider} />
    </section>
  );
}

function GitAccountRow({ account }: { account: GitAccount }) {
  const [editing, setEditing] = useState(false);
  const verify = useVerifyGitAccount();
  const remove = useDeleteGitAccount();

  const handleRemove = () => {
    const usage = account.workspaceCount > 0 ? ` Ela será desvinculada de ${account.workspaceCount} workspace(s).` : '';
    if (window.confirm(`Remover a conta "${account.label}"?${usage}`)) remove.mutate(account.id);
  };

  if (editing) return <EditGitAccountRow account={account} onDone={() => setEditing(false)} />;

  return (
    <tr className="border-t border-border align-top">
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <Badge tone="info">{gitProviderLabels[account.provider]}</Badge>
          <span className="font-medium">{account.label}</span>
        </div>
        <div className="mt-0.5 text-xs text-muted">
          @{account.username}
          {account.authorEmail ? ` · commits como ${account.authorName || account.username} <${account.authorEmail}>` : ''}
        </div>
      </td>
      <td className="px-4 py-2 font-mono text-xs">{account.host}</td>
      <td className="px-4 py-2 font-mono text-xs text-muted">{account.tokenHint}</td>
      <td className="px-4 py-2">{account.workspaceCount}</td>
      <td className="px-4 py-2">
        <div className="flex justify-end gap-2">
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
        {verify.isSuccess && <p className="mt-1 text-right text-xs text-emerald-300">Token válido.</p>}
        {verify.error && <p className="mt-1 text-right text-xs text-red-300">{verify.error.message}</p>}
      </td>
    </tr>
  );
}

function EditGitAccountRow({ account, onDone }: { account: GitAccount; onDone: () => void }) {
  const [label, setLabel] = useState(account.label);
  const [token, setToken] = useState('');
  const [authorName, setAuthorName] = useState(account.authorName ?? '');
  const [authorEmail, setAuthorEmail] = useState(account.authorEmail ?? '');
  const update = useUpdateGitAccount();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ id: account.id, label, authorName, authorEmail, ...(token && { token }) }, { onSuccess: onDone });
  };

  return (
    <tr className="border-t border-border">
      <td colSpan={5} className="px-4 py-3">
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
          <Field label="Autor dos commits">
            <TextInput value={authorName} onChange={(event) => setAuthorName(event.target.value)} placeholder={account.username} />
          </Field>
          <Field label="E-mail dos commits">
            <TextInput
              type="email"
              value={authorEmail}
              onChange={(event) => setAuthorEmail(event.target.value)}
              placeholder="seu e-mail no provedor"
            />
          </Field>
          <Button type="submit" variant="primary" disabled={update.isPending}>
            {update.isPending ? 'Salvando...' : 'Salvar'}
          </Button>
          <Button onClick={onDone}>Cancelar</Button>
          <ErrorText error={update.error} />
        </form>
      </td>
    </tr>
  );
}

function NewGitAccountForm({ fixedProvider }: { fixedProvider?: AccountGitProvider }) {
  const [provider, setProvider] = useState<AccountGitProvider>(fixedProvider ?? 'GITHUB');
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('');
  const [token, setToken] = useState('');
  const create = useCreateGitAccount();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { provider, label, token, ...(host.trim() && { host: host.trim() }) },
      {
        onSuccess: () => {
          setLabel('');
          setHost('');
          setToken('');
        },
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="mt-4 rounded-lg border border-border bg-panel p-4">
      <h3 className="text-sm font-medium">Adicionar conta</h3>
      <div className={`mt-3 grid grid-cols-1 gap-3 ${fixedProvider ? 'md:grid-cols-3' : 'md:grid-cols-4'}`}>
        {!fixedProvider && (
          <Field label="Provedor">
            <Select value={provider} onChange={(event) => setProvider(event.target.value as AccountGitProvider)}>
              <option value="GITHUB">GitHub</option>
              <option value="GITLAB">GitLab</option>
            </Select>
          </Field>
        )}
        <Field label="Nome">
          <TextInput value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Ex.: GitLab GlobalFarm" required />
        </Field>
        <Field label="Host" hint="Só para servidores próprios.">
          <TextInput value={host} onChange={(event) => setHost(event.target.value)} placeholder={defaultHosts[provider]} />
        </Field>
        <Field label="Token">
          <TextInput type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" required />
        </Field>
      </div>
      <p className="mt-2 text-xs text-muted">{tokenHints[provider]}</p>
      <div className="mt-3 flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {create.isPending ? 'Verificando token...' : 'Adicionar'}
        </Button>
        <ErrorText error={create.error} />
      </div>
    </form>
  );
}
