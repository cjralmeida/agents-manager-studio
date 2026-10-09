import { type FormEvent, type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import {
  type BoardCandidate,
  type CreateOption,
  boardColors,
  boardProviderLabels,
  useBoardModel,
  useCreateBoard,
  useCreateLocalBoard,
  useDetectBoards,
  useLinkBoard,
} from '../../api/boards';
import type { WorkspaceDetail } from '../../api/workspaces';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ConnectorIcon } from '../connectors/ConnectorIcon';
import { ErrorText, Field, Select, TextInput } from '../form';
import { Logo } from '../Logo';

/** Shown while the workspace has no board: three ways to get one, all following the Studio board model. */
export function BoardSetup({ workspace }: { workspace: WorkspaceDetail }) {
  const detection = useDetectBoards(workspace.id, true);
  const connectorsTab = `/workspaces/${workspace.id}?tab=connectors`;
  // "No git account for github.com" and the like: shown inside the git options, not as loose warnings.
  const missingAccounts = detection.data?.warnings ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-8 py-2">
      <Hero />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <LocalOption workspaceId={workspace.id} />
        <CreateOption
          workspaceId={workspace.id}
          loading={detection.isPending}
          options={detection.data?.createOptions ?? []}
          defaultTitle={detection.data?.defaultTitle ?? workspace.name}
          missingAccounts={missingAccounts}
          connectorsTab={connectorsTab}
        />
        <LinkOption
          workspaceId={workspace.id}
          loading={detection.isPending}
          candidates={detection.data?.candidates ?? []}
          missingAccounts={missingAccounts}
          connectorsTab={connectorsTab}
        />
      </div>
      <ErrorText error={detection.error} />
    </div>
  );
}

/** Title, what a board is for, and a small preview drawn with the model's columns. */
function Hero() {
  const model = useBoardModel();
  const columns = model.data?.model.columns ?? [];

  return (
    <header className="flex flex-col items-center text-center">
      <div className="flex items-end gap-1.5" aria-hidden="true">
        {(columns.length > 0 ? columns.slice(0, 5) : Array.from({ length: 4 }, () => null)).map((column, index) => (
          <div
            key={column?.id ?? index}
            className="flex w-14 flex-col gap-1 rounded-md border border-border bg-panel p-1.5"
            style={{ borderTopColor: column ? boardColors[column.color] : undefined, borderTopWidth: 3 }}
          >
            {Array.from({ length: 3 - (index % 3) }, (_, card) => (
              <span key={card} className="h-2 rounded-sm bg-border" style={{ width: `${100 - card * 18}%` }} />
            ))}
          </div>
        ))}
      </div>
      <h2 className="mt-5 text-xl font-semibold text-balance">Este workspace ainda não tem um quadro de tarefas</h2>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Escolha onde as tarefas vão ficar. Em qualquer opção o quadro segue o{' '}
        <Link to="/board?tab=model" className="text-accent hover:underline">
          modelo do Studio
        </Link>
        , aparece no Quadro de tarefas geral e os agentes e workflows trabalham com ele do mesmo jeito.
      </p>
      {columns.length > 0 && (
        <div className="mt-3 flex flex-wrap justify-center gap-1.5">
          {columns.map((column) => (
            <span key={column.id} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted">
              <span className="size-2 rounded-full" style={{ backgroundColor: boardColors[column.color] }} />
              {column.name}
            </span>
          ))}
        </div>
      )}
    </header>
  );
}

function OptionCard({
  icon,
  title,
  badge,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col rounded-xl border border-border bg-panel p-5">
      <div className="flex items-center gap-3">
        {icon}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{title}</h3>
            {badge}
          </div>
        </div>
      </div>
      <p className="mt-3 text-sm text-muted">{description}</p>
      <div className="mt-4 flex flex-1 flex-col">{children}</div>
    </section>
  );
}

function NeedsAccount({ missingAccounts, connectorsTab, text }: { missingAccounts: string[]; connectorsTab: string; text: string }) {
  const hosts = missingAccounts.map((warning) => /para (\S+) está/.exec(warning)?.[1]).filter(Boolean);
  return (
    <div className="mt-auto rounded-lg border border-dashed border-border p-3 text-xs text-muted">
      <p>{text}</p>
      {hosts.length > 0 && <p className="mt-1">Sem conta ativa para: {hosts.join(', ')}.</p>}
      <Link to={connectorsTab} className="mt-2 inline-block text-accent hover:underline">
        Ativar contas na aba Conectores →
      </Link>
    </div>
  );
}

function LocalOption({ workspaceId }: { workspaceId: string }) {
  const create = useCreateLocalBoard(workspaceId);
  return (
    <OptionCard
      icon={<Logo size={36} />}
      title="Só no Studio"
      badge={<Badge tone="success">Pronto na hora</Badge>}
      description="As tarefas ficam guardadas no Studio, sem GitHub nem GitLab. Bom para começar ou para workspaces sem repositório remoto."
    >
      <ul className="space-y-1.5 text-xs text-muted">
        <li>✓ Não precisa de conta git</li>
        <li>✓ Tarefas ligadas a um projeto do workspace, ou a nenhum</li>
        <li>✓ Sempre igual ao modelo</li>
      </ul>
      <div className="mt-auto pt-4">
        <Button variant="primary" className="w-full" onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? 'Criando...' : 'Criar quadro do Studio'}
        </Button>
        <ErrorText error={create.error} />
      </div>
    </OptionCard>
  );
}

const optionKey = (option: CreateOption) => `${option.provider}|${option.host}|${option.owner}`;

function ProviderIcons() {
  return (
    <span className="flex -space-x-2">
      <ConnectorIcon id="github" size={36} />
      <ConnectorIcon id="gitlab" size={36} />
    </span>
  );
}

function CreateOption({
  workspaceId,
  loading,
  options,
  defaultTitle,
  missingAccounts,
  connectorsTab,
}: {
  workspaceId: string;
  loading: boolean;
  options: CreateOption[];
  defaultTitle: string;
  missingAccounts: string[];
  connectorsTab: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState(defaultTitle);
  const create = useCreateBoard(workspaceId);
  const option = options.find((entry) => optionKey(entry) === selected) ?? options[0];

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!option) return;
    const where = `${option.owner} no ${boardProviderLabels[option.provider]}`;
    if (window.confirm(`Criar o quadro "${title}" em ${where}? Ele ficará visível para quem tem acesso a ${option.owner}.`)) {
      create.mutate({ ...option, title });
    }
  };

  return (
    <OptionCard
      icon={<ProviderIcons />}
      title="Criar no GitHub ou GitLab"
      description="Um GitHub Project ou um board de grupo do GitLab, já com as colunas e campos do modelo. As tarefas viram issues dos repositórios."
    >
      {loading && <p className="text-xs text-muted">Procurando onde dá para criar...</p>}
      {!loading && !option && (
        <NeedsAccount
          missingAccounts={missingAccounts}
          connectorsTab={connectorsTab}
          text="Para criar, o workspace precisa de um projeto com repositório no GitHub ou GitLab e da conta git desse host ativa."
        />
      )}
      {option && (
        <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-3">
          <Field label="Onde criar">
            <Select value={optionKey(option)} onChange={(event) => setSelected(event.target.value)}>
              {options.map((entry) => (
                <option key={optionKey(entry)} value={optionKey(entry)}>
                  {boardProviderLabels[entry.provider]} · {entry.owner}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Nome do quadro">
            <TextInput value={title} onChange={(event) => setTitle(event.target.value)} required />
          </Field>
          <div className="mt-auto pt-1">
            <Button type="submit" variant="primary" className="w-full" disabled={create.isPending || !title.trim()}>
              {create.isPending ? 'Criando...' : 'Criar quadro'}
            </Button>
            <ErrorText error={create.error} />
          </div>
        </form>
      )}
    </OptionCard>
  );
}

function LinkIcon() {
  return (
    <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-border text-muted ring-1 ring-white/10" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
        <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
      </svg>
    </span>
  );
}

function LinkOption({
  workspaceId,
  loading,
  candidates,
  missingAccounts,
  connectorsTab,
}: {
  workspaceId: string;
  loading: boolean;
  candidates: BoardCandidate[];
  missingAccounts: string[];
  connectorsTab: string;
}) {
  const [url, setUrl] = useState('');
  const link = useLinkBoard(workspaceId);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    link.mutate(url.trim());
  };

  return (
    <OptionCard
      icon={<LinkIcon />}
      title="Vincular um quadro existente"
      description="Use um quadro que já existe no GitHub ou GitLab. Depois de vincular, o Studio ajuda a convertê-lo para o modelo."
    >
      {loading && <p className="text-xs text-muted">Procurando quadros dos repositórios...</p>}
      {candidates.length > 0 && (
        <ul className="mb-3 divide-y divide-border rounded-lg border border-border">
          {candidates.map((candidate) => (
            <li key={candidate.externalId} className="flex items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <a href={candidate.url} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium hover:text-accent">
                  {candidate.title} ↗
                </a>
                <span className="text-xs text-muted">
                  {boardProviderLabels[candidate.provider]} · {candidate.ownerPath}
                  {candidate.matchesTemplate ? ' · estilo Studio' : ''}
                </span>
              </div>
              <Button size="sm" onClick={() => link.mutate(candidate.url)} disabled={link.isPending}>
                Vincular
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!loading && candidates.length === 0 && missingAccounts.length > 0 && (
        <NeedsAccount
          missingAccounts={missingAccounts}
          connectorsTab={connectorsTab}
          text="Com as contas git ativas, o Studio procura sozinho os quadros dos repositórios deste workspace."
        />
      )}
      <form onSubmit={handleSubmit} className={`flex flex-col gap-2 ${candidates.length === 0 && missingAccounts.length > 0 ? 'mt-3' : 'mt-auto'}`}>
        <Field label="Ou cole a URL do quadro">
          <TextInput value={url} onChange={(event) => setUrl(event.target.value)} placeholder="github.com/orgs/…/projects/N ou gitlab.com/groups/…/-/boards/N" />
        </Field>
        <Button type="submit" className="w-full" disabled={link.isPending || !url.trim()}>
          {link.isPending ? 'Vinculando...' : 'Vincular pela URL'}
        </Button>
        <ErrorText error={link.error} />
      </form>
    </OptionCard>
  );
}
