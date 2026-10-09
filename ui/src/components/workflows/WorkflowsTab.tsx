import { type FormEvent, useState } from 'react';
import { type AgentProfile, useAgentProfiles } from '../../api/agentProfiles';
import { type Board, useBoard, useBoardSources } from '../../api/boards';
import { environmentLabels } from '../../api/render';
import {
  type Workflow,
  useCreateWorkflow,
  useDeleteWorkflow,
  useStartWorkflow,
  useUpdateWorkflow,
  useWorkflowRuns,
  useWorkflows,
} from '../../api/workflows';
import type { WorkspaceDetail } from '../../api/workspaces';
import { plural, timeAgo } from '../../lib/time';
import { Badge } from '../Badge';
import { OptionChip } from '../board/OptionChip';
import { Button } from '../Button';
import { ErrorText } from '../form';
import { WorkflowForm } from './WorkflowForm';
import { WorkflowRunCard } from './WorkflowRunCard';

export function WorkflowsTab({ workspace }: { workspace: WorkspaceDetail }) {
  const workflows = useWorkflows(workspace.id);
  const runs = useWorkflowRuns(workspace.id);
  const profiles = useAgentProfiles(workspace.id);
  const sources = useBoardSources(workspace.id);
  const hasBoard = (sources.data?.length ?? 0) > 0;
  const board = useBoard(workspace.id, hasBoard);
  const [editing, setEditing] = useState<Workflow | 'new' | null>(null);
  const create = useCreateWorkflow(workspace.id);
  const update = useUpdateWorkflow(workspace.id);

  const error = workflows.error ?? profiles.error ?? runs.error;
  if (error) return <ErrorText error={error} />;
  if (!workflows.data || !profiles.data || sources.isPending) return <p className="text-sm text-muted">Carregando...</p>;
  const boardData = hasBoard ? (board.data ?? null) : null;

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted">
          Um workflow encadeia agentes do workspace e deploys: cada passo recebe o resultado do anterior. Tudo segue
          sozinho; só as perguntas dos agentes esperam a sua resposta. Os workflows continuam de onde pararam quando o
          Studio reinicia.
        </p>
        {editing === null && (
          <Button variant="primary" onClick={() => setEditing('new')}>
            Novo workflow
          </Button>
        )}
      </div>

      {editing !== null && (
        <WorkflowForm
          key={editing === 'new' ? 'new' : editing.id}
          profiles={profiles.data}
          board={boardData}
          initial={editing === 'new' ? undefined : editing}
          pending={create.isPending || update.isPending}
          error={create.error ?? update.error}
          onCancel={() => setEditing(null)}
          onSubmit={(input) => {
            const done = { onSuccess: () => setEditing(null) };
            if (editing === 'new') create.mutate(input, done);
            else update.mutate({ id: editing.id, ...input }, done);
          }}
        />
      )}

      {workflows.data.length === 0 && editing === null && <p className="text-sm text-muted">Nenhum workflow neste workspace ainda.</p>}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {workflows.data.map((workflow) => (
          <WorkflowCard
            key={workflow.id}
            workspace={workspace}
            workflow={workflow}
            profiles={profiles.data}
            board={boardData}
            onEdit={() => setEditing(workflow)}
          />
        ))}
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Execuções</h2>
        {runs.data?.length === 0 && <p className="text-sm text-muted">Nenhuma execução ainda.</p>}
        {runs.data?.map((run) => <WorkflowRunCard key={run.id} workspaceId={workspace.id} run={run} />)}
      </section>
    </div>
  );
}

function WorkflowCard({
  workspace,
  workflow,
  profiles,
  board,
  onEdit,
}: {
  workspace: WorkspaceDetail;
  workflow: Workflow;
  profiles: AgentProfile[];
  board: Board | null;
  onEdit: () => void;
}) {
  const update = useUpdateWorkflow(workspace.id);
  const remove = useDeleteWorkflow(workspace.id);
  const start = useStartWorkflow(workspace.id);
  const [message, setMessage] = useState('');
  const [starting, setStarting] = useState(false);
  const isManual = workflow.trigger.type === 'manual';

  const filters =
    workflow.trigger.type === 'board_task' && board
      ? board.fields.flatMap((field) =>
          ((workflow.trigger as Extract<Workflow['trigger'], { type: 'board_task' }>).fieldFilters[field.id] ?? []).flatMap((optionId) => {
            const option = field.options.find((entry) => entry.id === optionId);
            return option ? [{ field, option }] : [];
          }),
        )
      : [];

  const handleStart = (event: FormEvent) => {
    event.preventDefault();
    start.mutate(
      { id: workflow.id, message },
      {
        onSuccess: () => {
          setMessage('');
          setStarting(false);
        },
      },
    );
  };

  return (
    <article
      className={`rounded-lg border bg-panel p-4 ${workflow.runningRuns > 0 ? 'glow-working' : 'border-border'} ${workflow.isEnabled ? '' : 'opacity-70'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{workflow.name}</h3>
          {workflow.description && <p className="mt-0.5 text-xs text-muted">{workflow.description}</p>}
        </div>
        {workflow.isEnabled ? <Badge tone="success">Ativo</Badge> : <Badge>Desativado</Badge>}
      </div>

      <p className="mt-3 text-xs text-muted">
        {isManual
          ? 'Começa com uma mensagem sua.'
          : workflow.trigger.type === 'feature_in_homologation'
            ? 'Começa quando todas as tarefas de uma funcionalidade estão em homologação.'
            : 'Começa quando aparece uma tarefa no quadro:'}
      </p>
      {filters.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {filters.map(({ field, option }) => (
            <OptionChip key={`${field.id}:${option.id}`} option={option} title={`${field.name}: ${option.name}`} />
          ))}
        </div>
      )}

      <ol className="mt-3 flex flex-wrap items-center gap-1 text-xs">
        {workflow.steps.map((step, index) => (
          <li key={step.id} className="flex items-center gap-1">
            {index > 0 && <span className="text-muted">→</span>}
            <span className="rounded-full border border-border px-2 py-0.5" title={step.kind === 'agent' ? profiles.find((profile) => profile.id === step.profileId)?.name : undefined}>
              {step.name}
              {step.kind === 'agent' && step.forEachTask && ' (cada tarefa)'}
              {step.kind === 'deploy' && ` · ${environmentLabels[step.environment]}`}
            </span>
          </li>
        ))}
      </ol>

      {workflow.statusMessage && <p className="mt-3 text-xs text-gray-300">{workflow.statusMessage}</p>}
      <p className="mt-1 text-[11px] text-muted">
        {workflow.runningRuns} em andamento · {plural(workflow.totalRuns, 'execução', 'execuções')}
        {workflow.lastCheckedAt && ` · verificado ${timeAgo(workflow.lastCheckedAt)}`}
      </p>

      {starting && isManual && (
        <form onSubmit={handleStart} className="mt-3 space-y-2">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={4}
            autoFocus
            placeholder="O que você quer? Ex.: documentar e implementar a exportação de relatórios em CSV..."
            className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={start.isPending || !message.trim()}>
              {start.isPending ? 'Iniciando...' : 'Iniciar'}
            </Button>
            <Button size="sm" onClick={() => setStarting(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {!starting && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => (isManual ? setStarting(true) : start.mutate({ id: workflow.id }))}
            disabled={!workflow.isEnabled || start.isPending}
          >
            {isManual ? 'Iniciar' : start.isPending ? 'Verificando...' : 'Verificar quadro agora'}
          </Button>
        )}
        <Button size="sm" onClick={() => update.mutate({ id: workflow.id, isEnabled: !workflow.isEnabled })} disabled={update.isPending}>
          {workflow.isEnabled ? 'Desativar' : 'Ativar'}
        </Button>
        <Button size="sm" onClick={onEdit}>
          Editar
        </Button>
        <Button
          size="sm"
          variant="danger"
          onClick={() => window.confirm(`Excluir o workflow "${workflow.name}" e o histórico de execuções?`) && remove.mutate(workflow.id)}
          disabled={remove.isPending}
        >
          Excluir
        </Button>
      </div>
      <ErrorText error={start.error ?? update.error ?? remove.error} />
    </article>
  );
}
