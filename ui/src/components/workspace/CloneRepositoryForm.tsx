import { type FormEvent, useState } from 'react';
import { type AccountRepository, useAccountRepositories, useCloneJobs, useStartClone } from '../../api/workspaces';
import { timeAgo } from '../../lib/time';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, Field, TextInput } from '../form';

/** git's default folder: the last segment of the repository path, without ".git". */
function folderFromUrl(url: string) {
  const path = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  return path.split(/[/:]/).at(-1) ?? '';
}

/** Clones a repository into the workspace, picked from the git accounts or typed as a URL. */
export function CloneRepositoryForm({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [mode, setMode] = useState<'accounts' | 'url'>('accounts');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [url, setUrl] = useState('');
  const [folder, setFolder] = useState('');
  const [branch, setBranch] = useState('');
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const repositories = useAccountRepositories(workspaceId, search, mode === 'accounts');
  const start = useStartClone(workspaceId);

  const pick = (repository: AccountRepository) => {
    setUrl(repository.cloneUrl);
    setFolder(repository.name);
    setBranch('');
    setDefaultBranch(repository.defaultBranch);
  };

  const handleSearch = (event: FormEvent) => {
    event.preventDefault();
    setSearch(searchInput.trim());
  };

  const handleClone = (event: FormEvent) => {
    event.preventDefault();
    start.mutate(
      { url: url.trim(), ...(folder.trim() && { folder: folder.trim() }), ...(branch.trim() && { branch: branch.trim() }) },
      {
        onSuccess: () => {
          setUrl('');
          setFolder('');
          setBranch('');
          setDefaultBranch(null);
        },
      },
    );
  };

  return (
    <div className="space-y-4 rounded-lg border border-border bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Clonar repositório</h3>
        <div className="flex rounded-md border border-border p-0.5">
          {(['accounts', 'url'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setMode(option)}
              className={`rounded px-2.5 py-1 text-xs font-medium ${mode === option ? 'bg-border text-white' : 'text-muted hover:text-white'}`}
            >
              {option === 'accounts' ? 'Meus repositórios' : 'Pela URL'}
            </button>
          ))}
        </div>
      </div>

      {mode === 'accounts' && (
        <div className="space-y-2">
          <form onSubmit={handleSearch} className="flex gap-2">
            <TextInput
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Buscar pelo nome do repositório"
            />
            <Button type="submit">Buscar</Button>
          </form>
          <ErrorText error={repositories.error} />
          {repositories.data?.warnings.map((warning) => (
            <p key={warning} className="text-xs text-amber-300">
              {warning}
            </p>
          ))}
          {repositories.isFetching && <p className="text-xs text-muted">Buscando nas contas git do workspace...</p>}
          {repositories.data && repositories.data.repositories.length === 0 && !repositories.isFetching && (
            <p className="text-xs text-muted">Nenhum repositório encontrado.</p>
          )}
          <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {repositories.data?.repositories.map((repository) => (
              <li key={`${repository.host}/${repository.fullName}`}>
                <button
                  type="button"
                  onClick={() => pick(repository)}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-border/30 ${
                    url === repository.cloneUrl ? 'bg-accent/10' : ''
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{repository.fullName}</span>
                    {repository.description && <span className="block truncate text-xs text-muted">{repository.description}</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted">
                    {repository.isPrivate && <Badge>privado</Badge>}
                    <Badge tone="info">{repository.provider === 'GITHUB' ? 'GitHub' : 'GitLab'}</Badge>
                    {repository.updatedAt && timeAgo(repository.updatedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={handleClone} className="space-y-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[2fr_1fr_1fr]">
          <Field label="URL do repositório" hint={mode === 'accounts' ? 'Escolha na lista acima ou cole uma URL.' : 'https ou ssh; repositórios privados usam a conta git do workspace.'}>
            <TextInput
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setDefaultBranch(null);
              }}
              placeholder="https://gitlab.com/grupo/projeto.git"
              required
            />
          </Field>
          <Field label="Pasta">
            <TextInput value={folder} onChange={(event) => setFolder(event.target.value)} placeholder={folderFromUrl(url) || 'nome do repositório'} />
          </Field>
          <Field label="Branch">
            <TextInput value={branch} onChange={(event) => setBranch(event.target.value)} placeholder={defaultBranch ?? 'padrão do repositório'} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={start.isPending || !url.trim()}>
            {start.isPending ? 'Iniciando...' : 'Clonar'}
          </Button>
          <Button onClick={onClose}>Fechar</Button>
          <ErrorText error={start.error} />
        </div>
      </form>

      <CloneJobs workspaceId={workspaceId} />
    </div>
  );
}

function CloneJobs({ workspaceId }: { workspaceId: string }) {
  const jobs = useCloneJobs(workspaceId);
  if (!jobs.data || jobs.data.length === 0) return null;

  return (
    <ul className="space-y-1.5 border-t border-border pt-3 text-xs">
      {jobs.data.map((job) => (
        <li key={job.id} className="flex flex-wrap items-center gap-2">
          {job.status === 'cloning' ? (
            <Badge tone="info">Clonando...</Badge>
          ) : job.status === 'done' ? (
            <Badge tone="success">Clonado</Badge>
          ) : (
            <Badge tone="danger">Falhou</Badge>
          )}
          <span className="font-medium">{job.folder}</span>
          <span className="truncate text-muted">{job.url}</span>
          {job.error && <span className="w-full text-red-300">{job.error}</span>}
        </li>
      ))}
    </ul>
  );
}
