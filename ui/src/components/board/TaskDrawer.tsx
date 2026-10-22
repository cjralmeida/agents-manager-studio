import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Agent } from '../../api/agents';
import { type Board, type BoardItem, boardProviderLabels, useMoveTask, useSetTaskField, useTaskComments } from '../../api/boards';
import type { WorkspaceDetail } from '../../api/workspaces';
import { AgentStatusBadge } from '../agents/AgentStatusBadge';
import { NewAgentForm } from '../agents/NewAgentForm';
import { Button } from '../Button';
import { ErrorText, Field, Select } from '../form';
import { agentPromptFor, itemRef } from './boardUtils';
import { TaskMarkdown } from './TaskMarkdown';

interface TaskDrawerProps {
  workspace: WorkspaceDetail;
  board: Board;
  item: BoardItem;
  agent: Agent | undefined;
  onClose: () => void;
  /** An active workflow run is processing the task. */
  inWorkflow?: boolean;
}

export function TaskDrawer({ workspace, board, item, agent, onClose, inWorkflow = false }: TaskDrawerProps) {
  const [launching, setLaunching] = useState(false);
  const move = useMoveTask(workspace.id);
  const setField = useSetTaskField(workspace.id);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const blocked = board.statusMap.blocked !== undefined && item.columnId === board.statusMap.blocked;
  const source = board.sources.find((entry) => entry.id === item.sourceId);
  const agentActive = agent && agent.status !== 'CANCELLED' && agent.status !== 'FAILED' && agent.status !== 'COMPLETED';

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={onClose}>
      <aside
        className={`flex h-full w-full max-w-2xl flex-col overflow-y-auto border-l bg-surface p-5 shadow-2xl ${
          inWorkflow || (agent && ['PREPARING', 'RUNNING', 'FINALIZING'].includes(agent.status)) ? 'glow-working' : 'border-border'
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-mono text-xs text-muted">{itemRef(item) || 'Tarefa'}</p>
            <h2 className="mt-1 text-lg leading-snug font-semibold">{item.title}</h2>
          </div>
          <div className="flex shrink-0 gap-2">
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-border bg-panel px-2 py-1 text-xs font-medium text-gray-200 hover:bg-border"
              >
                Abrir no {source ? boardProviderLabels[source.provider] : 'provedor'} ↗
              </a>
            )}
            <Button size="sm" onClick={onClose}>
              Fechar
            </Button>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <Field label="Status">
            <Select
              value={item.columnId ?? ''}
              onChange={(event) => move.mutate({ itemId: item.id, columnId: event.target.value })}
            >
              {!item.columnId && <option value="">Sem status</option>}
              {board.columns.map((column) => (
                <option key={column.id} value={column.id}>
                  {column.name}
                </option>
              ))}
            </Select>
          </Field>
          {board.fields.map((field) => (
            <Field key={field.id} label={field.name}>
              <Select
                value={item.fields[field.id] ?? ''}
                onChange={(event) =>
                  setField.mutate({ itemId: item.id, fieldId: field.id, optionId: event.target.value || null })
                }
              >
                <option value="">—</option>
                {field.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </div>
        <ErrorText error={move.error ?? setField.error} />

        <dl className="mt-4 space-y-1 text-sm">
          {item.repository && (
            <div className="flex gap-2">
              <dt className="text-muted">Repositório:</dt>
              <dd className="font-mono text-xs leading-5">{item.repository}</dd>
            </div>
          )}
          {item.assignees.length > 0 && (
            <div className="flex gap-2">
              <dt className="text-muted">Responsáveis:</dt>
              <dd>{item.assignees.map((login) => `@${login}`).join(', ')}</dd>
            </div>
          )}
          {item.pullRequests.map((pr) => (
            <div key={pr.url} className="flex gap-2">
              <dt className="text-muted">PR:</dt>
              <dd>
                <a href={pr.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  #{pr.number}
                </a>{' '}
                <span className="text-xs text-muted">({pr.state.toLowerCase()})</span>
              </dd>
            </div>
          ))}
        </dl>

        <section className="mt-5 rounded-lg border border-border bg-panel p-4">
          <h3 className="text-sm font-semibold">Agente</h3>
          {agent && (
            <div className="mt-2 flex items-center justify-between gap-3">
              <Link to={`/agents/${agent.id}`} className="truncate text-sm font-medium hover:text-accent">
                {agent.title}
              </Link>
              <AgentStatusBadge status={agent.status} paused={agent.paused} />
            </div>
          )}
          {blocked ? (
            <p className="mt-2 text-sm text-muted">Tarefa aguardando aprovação: agentes não executam itens desta coluna.</p>
          ) : launching ? (
            <div className="mt-3">
              <NewAgentForm
                workspaceId={workspace.id}
                projects={workspace.projects}
                onCancel={() => setLaunching(false)}
                initial={{ projectId: item.projectId, title: item.title, prompt: agentPromptFor(item) }}
                taskItemId={item.id}
              />
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-3">
              <Button variant="primary" onClick={() => setLaunching(true)} disabled={workspace.isMissing}>
                {agent ? 'Lançar outro agente' : 'Resolver com agente'}
              </Button>
              {agentActive && <span className="text-xs text-muted">Já existe um agente ativo nesta tarefa.</span>}
              {!item.projectId && !item.isDraft && (
                <span className="text-xs text-amber-300">O repositório da tarefa não é um projeto deste workspace.</span>
              )}
            </div>
          )}
        </section>

        <section className="mt-5">
          <h3 className="text-sm font-semibold">Descrição</h3>
          {item.body.trim() ? (
            <div className="mt-2">
              <TaskMarkdown text={item.body} />
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">Sem descrição.</p>
          )}
        </section>

        <TaskComments workspaceId={workspace.id} itemId={item.id} />
      </aside>
    </div>
  );
}

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/** The task's comments (signed by the agents: approvals, rejections, HOM reports, decisions), oldest first. */
function TaskComments({ workspaceId, itemId }: { workspaceId: string; itemId: string }) {
  const comments = useTaskComments(workspaceId, itemId);
  const list = comments.data ?? [];
  return (
    <section className="mt-6">
      <h3 className="text-sm font-semibold">Comentários{list.length > 0 && <span className="ml-1 font-normal text-muted">({list.length})</span>}</h3>
      {comments.isPending ? (
        <p className="mt-2 text-sm text-muted">Carregando…</p>
      ) : comments.error ? (
        <ErrorText error={comments.error} />
      ) : list.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Sem comentários.</p>
      ) : (
        <ol className="mt-2 space-y-3">
          {list.map((comment) => (
            <li key={`${comment.at}-${comment.author}`} className="rounded-lg border border-border bg-panel/60 p-3">
              <p className="text-xs text-muted">
                @{comment.author} · {dateTime.format(new Date(comment.at))}
              </p>
              <div className="mt-1">
                <TaskMarkdown text={comment.body} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
