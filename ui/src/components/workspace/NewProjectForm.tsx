import { type FormEvent, useState } from 'react';
import { useCreateProject, useRepositoryOwners } from '../../api/workspaces';
import { Button } from '../Button';
import { ErrorText, Field, Select, TextInput } from '../form';

/** Same rule as the server (create-project.ts): providers only take letters, digits, ".", "_" and "-". */
function repositorySlug(folder: string) {
  return folder
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

const kindLabels = { user: 'pessoal', org: 'organização', group: 'grupo' } as const;

/** New project folder with git (README and first commit), optionally with a new GitHub/GitLab repository. */
export function NewProjectForm({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const owners = useRepositoryOwners(workspaceId);
  const create = useCreateProject(workspaceId);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  /** "accountId|owner", or empty for a local repository only. */
  const [target, setTarget] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');

  const [accountId, owner] = target ? (target.split('|') as [string, string]) : [null, null];
  const account = owners.data?.accounts.find((entry) => entry.accountId === accountId);
  const slug = repositorySlug(name);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      {
        name: name.trim(),
        ...(description.trim() && { description: description.trim() }),
        remote: accountId && owner ? { accountId, owner, visibility } : null,
      },
      {
        onSuccess: () => {
          setName('');
          setDescription('');
        },
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-border bg-panel p-4">
      <h3 className="text-sm font-medium">Novo projeto</h3>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Nome da pasta">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: api-pedidos" required />
        </Field>
        <Field label="Descrição (opcional)" hint="Vai para o README e para o repositório remoto.">
          <TextInput value={description} onChange={(event) => setDescription(event.target.value)} maxLength={300} />
        </Field>
        <Field label="Repositório remoto" hint={owners.isLoading ? 'Carregando contas...' : undefined}>
          <Select value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="">Nenhum (só git local)</option>
            {owners.data?.accounts.map((entry) => (
              <optgroup key={entry.accountId} label={`${entry.provider === 'GITHUB' ? 'GitHub' : 'GitLab'} · ${entry.label} (${entry.host})`}>
                {entry.owners.map((option) => (
                  <option key={option.path} value={`${entry.accountId}|${option.path}`}>
                    {option.path} ({kindLabels[option.kind]})
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        {target && (
          <Field label="Visibilidade">
            <Select value={visibility} onChange={(event) => setVisibility(event.target.value as 'private' | 'public')}>
              <option value="private">Privado</option>
              <option value="public">Público</option>
            </Select>
          </Field>
        )}
      </div>

      {owners.data?.accounts.length === 0 && (
        <p className="text-xs text-muted">Para criar também no GitHub ou GitLab, ative uma conta git na aba Conectores do workspace.</p>
      )}
      {owners.data?.warnings.map((warning) => (
        <p key={warning} className="text-xs text-amber-300">
          {warning}
        </p>
      ))}

      {name.trim() && (
        <p className="text-xs text-muted">
          Cria a pasta <code className="font-mono">{name.trim()}</code> com git (branch main, README e o primeiro commit)
          {account && owner ? (
            <>
              {' '}
              e o repositório {visibility === 'private' ? 'privado' : 'público'}{' '}
              <code className="font-mono">
                {account.host}/{owner}/{slug || '…'}
              </code>
              , já ligado como origin e com o push feito.
            </>
          ) : (
            ', sem repositório remoto.'
          )}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={create.isPending || !name.trim()}>
          {create.isPending ? 'Criando...' : 'Criar projeto'}
        </Button>
        <Button onClick={onClose}>Fechar</Button>
      </div>
      <ErrorText error={create.error} />
      {create.data && (
        <p className="text-sm text-emerald-300">
          Projeto {create.data.folder} criado.
          {create.data.remoteUrl && (
            <>
              {' '}
              Repositório:{' '}
              <a href={create.data.remoteUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                {create.data.remotePath}
              </a>
            </>
          )}
        </p>
      )}
      {create.data?.remoteVisibility && create.variables?.remote && create.data.remoteVisibility !== create.variables.remote.visibility && (
        <p className="text-xs text-amber-300">
          O repositório ficou {create.data.remoteVisibility === 'private' ? 'privado' : 'público'}: o grupo onde ele foi criado não permite outra
          visibilidade.
        </p>
      )}
      {create.data?.warnings.map((warning) => (
        <p key={warning} className="text-xs text-amber-300">
          Visualização do projeto no quadro não criada — {warning}
        </p>
      ))}
    </form>
  );
}
