import { type FormEvent, useEffect, useState } from 'react';
import {
  type BoardCandidate,
  type BoardStructure,
  type CreateOption,
  boardColors,
  boardProviderLabels,
  useCreateBoard,
  useDetectBoards,
  useLinkBoard,
  useTemplateStructure,
} from '../../api/boards';
import type { WorkspaceDetail } from '../../api/workspaces';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, Field, Select, TextInput } from '../form';
import { BoardStructureEditor } from './BoardStructureEditor';

/** Shown while the workspace has no board: detected boards, link by URL, or create one from the template. */
export function BoardSetup({ workspace }: { workspace: WorkspaceDetail }) {
  const detection = useDetectBoards(workspace.id, true);
  const link = useLinkBoard(workspace.id);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h2 className="text-base font-semibold">Vincular um quadro de tarefas</h2>
        <p className="mt-1 text-sm text-muted">
          O quadro fica no provedor (GitHub Projects ou board de grupo do GitLab), e o Studio mostra e movimenta as
          tarefas. As contas usadas são as contas git deste workspace.
        </p>
      </div>

      <section className="rounded-lg border border-border bg-panel p-4">
        <h3 className="text-sm font-medium">Quadros encontrados</h3>
        {detection.isPending && <p className="mt-2 text-sm text-muted">Procurando nos repositórios do workspace...</p>}
        <ErrorText error={detection.error} />
        {detection.data?.warnings.map((warning) => (
          <p key={warning} className="mt-2 text-xs text-amber-300">
            {warning}
          </p>
        ))}
        {detection.data && detection.data.candidates.length === 0 && (
          <p className="mt-2 text-sm text-muted">Nenhum quadro encontrado para os repositórios deste workspace.</p>
        )}
        <ul className="mt-2 divide-y divide-border">
          {detection.data?.candidates.map((candidate) => (
            <CandidateRow
              key={candidate.externalId}
              candidate={candidate}
              linking={link.isPending && link.variables === candidate.url}
              onLink={() => link.mutate(candidate.url)}
            />
          ))}
        </ul>
        <ErrorText error={link.error} />
      </section>

      <LinkByUrl workspaceId={workspace.id} />

      {detection.data && detection.data.createOptions.length > 0 && (
        <CreateBoardForm
          workspaceId={workspace.id}
          options={detection.data.createOptions}
          defaultTitle={detection.data.defaultTitle}
        />
      )}
    </div>
  );
}

function CandidateRow({ candidate, linking, onLink }: { candidate: BoardCandidate; linking: boolean; onLink: () => void }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Badge tone="info">{boardProviderLabels[candidate.provider]}</Badge>
          <a href={candidate.url} target="_blank" rel="noreferrer" className="truncate text-sm font-medium hover:text-accent">
            {candidate.title} ↗
          </a>
          {candidate.matchesTemplate && <Badge tone="success">estilo Studio</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-muted">{candidate.ownerPath}</p>
      </div>
      <Button size="sm" variant="primary" onClick={onLink} disabled={linking}>
        {linking ? 'Vinculando...' : 'Vincular'}
      </Button>
    </li>
  );
}

function LinkByUrl({ workspaceId }: { workspaceId: string }) {
  const [url, setUrl] = useState('');
  const link = useLinkBoard(workspaceId);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    link.mutate(url.trim());
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-panel p-4">
      <h3 className="text-sm font-medium">Vincular pela URL</h3>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="min-w-80 flex-1">
          <TextInput
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://github.com/orgs/<org>/projects/<n> ou https://gitlab.com/groups/<grupo>/-/boards/<id>"
            required
          />
        </div>
        <Button type="submit" variant="primary" disabled={link.isPending || !url.trim()}>
          {link.isPending ? 'Vinculando...' : 'Vincular'}
        </Button>
      </div>
      <div className="mt-2">
        <ErrorText error={link.error} />
      </div>
    </form>
  );
}

const optionKey = (option: CreateOption) => `${option.provider}|${option.host}|${option.owner}`;

function CreateBoardForm({
  workspaceId,
  options,
  defaultTitle,
}: {
  workspaceId: string;
  options: CreateOption[];
  defaultTitle: string;
}) {
  const [selected, setSelected] = useState(optionKey(options[0]!));
  const [title, setTitle] = useState(defaultTitle);
  /** Null keeps the Studio template; set when the user customizes it. */
  const [structure, setStructure] = useState<BoardStructure | null>(null);
  const create = useCreateBoard(workspaceId);
  const option = options.find((entry) => optionKey(entry) === selected) ?? options[0]!;
  const template = useTemplateStructure(option.provider);

  // GitHub and GitLab templates differ (GitLab has fixed columns), so switching provider starts over.
  useEffect(() => setStructure(null), [option.provider]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const where = `${option.owner} no ${boardProviderLabels[option.provider]}`;
    if (window.confirm(`Criar o quadro "${title}" em ${where}? Ele ficará visível para quem tem acesso a ${option.owner}.`)) {
      create.mutate({ ...option, title, structure });
    }
  };
  const shown = structure ?? template.data?.structure;

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-panel p-4">
      <h3 className="text-sm font-medium">Criar um quadro</h3>
      <p className="mt-1 text-xs text-muted">
        Por padrão segue o modelo do Studio. No GitHub, usa o projeto-modelo das Configurações quando houver (e aplica a
        estrutura personalizada por cima); no GitLab, cria os labels e o board no grupo.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <Field label="Onde criar">
          <Select value={selected} onChange={(event) => setSelected(event.target.value)}>
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
        <Button type="submit" variant="primary" disabled={create.isPending || !title.trim()}>
          {create.isPending ? 'Criando...' : 'Criar quadro'}
        </Button>
      </div>
      <div className="mt-2">
        <ErrorText error={create.error} />
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted">
            Estrutura: {structure ? 'personalizada' : 'modelo padrão do Studio'}
          </span>
          {structure ? (
            <Button size="sm" onClick={() => setStructure(null)}>
              Voltar ao modelo padrão
            </Button>
          ) : (
            <Button size="sm" onClick={() => template.data && setStructure(template.data.structure)} disabled={!template.data}>
              Personalizar
            </Button>
          )}
        </div>
        {!structure && shown && (
          <div className="mt-2 space-y-1 text-xs text-muted">
            <p className="flex flex-wrap items-center gap-1.5">
              Colunas:
              {[...(template.data?.fixedColumns ? ['A fazer'] : []), ...shown.columns.map((column) => column.name), ...(template.data?.fixedColumns ? ['Concluído'] : [])].map(
                (name) => {
                  const column = shown.columns.find((entry) => entry.name === name);
                  return (
                    <span key={name} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5">
                      <span className="size-2 rounded-full" style={{ backgroundColor: boardColors[column?.color ?? 'GRAY'] }} />
                      {name}
                    </span>
                  );
                },
              )}
            </p>
            <p>Campos: {shown.fields.map((field) => `${field.name} (${field.options.length})`).join(', ')}</p>
          </div>
        )}
        {structure && (
          <div className="mt-3">
            <BoardStructureEditor value={structure} onChange={setStructure} fixedColumns={template.data?.fixedColumns ?? false} />
          </div>
        )}
      </div>
    </form>
  );
}
