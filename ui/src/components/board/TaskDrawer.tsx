import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { Agent } from '../../api/agents';
import {
  type Board,
  type BoardItem,
  type ChecklistCheck,
  type TaskComment,
  boardProviderLabels,
  useMoveTask,
  useSetTaskField,
  useTaskChecklist,
  useTaskComments,
  useToggleChecklist,
} from '../../api/boards';
import type { WorkspaceDetail } from '../../api/workspaces';
import { AgentStatusBadge } from '../agents/AgentStatusBadge';
import { NewAgentForm } from '../agents/NewAgentForm';
import { Button } from '../Button';
import { ErrorText, Field, Select } from '../form';
import { type ChecklistSection, type DependencyLink, agentPromptFor, itemRef, parseChecklist, reworkOrigin, taskRelations } from './boardUtils';
import { TaskMarkdown } from './TaskMarkdown';
import { Avatar, AvatarStack, PriorityFlag } from './taskVisuals';

interface TaskDrawerProps {
  workspace: WorkspaceDetail;
  board: Board;
  item: BoardItem;
  agent: Agent | undefined;
  onClose: () => void;
  /** Open another task in the view (used by the dependency/blocking links). */
  onOpenItem?: (item: BoardItem) => void;
  /** An active workflow run is processing the task. */
  inWorkflow?: boolean;
}

export function TaskDrawer({ workspace, board, item, agent, onClose, onOpenItem, inWorkflow = false }: TaskDrawerProps) {
  const [launching, setLaunching] = useState(false);
  const move = useMoveTask(workspace.id);
  const setField = useSetTaskField(workspace.id);
  const comments = useTaskComments(workspace.id, item.id);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const blocked = board.statusMap.blocked !== undefined && item.columnId === board.statusMap.blocked;
  const source = board.sources.find((entry) => entry.id === item.sourceId);
  const agentActive = agent && agent.status !== 'CANCELLED' && agent.status !== 'FAILED' && agent.status !== 'COMPLETED';
  const working = inWorkflow || (agent !== undefined && ['PREPARING', 'RUNNING', 'FINALIZING'].includes(agent.status));

  const rework = reworkOrigin(item, board.statusMap);
  const checklist = useMemo(() => parseChecklist(item.body), [item.body]);
  const relations = useMemo(() => taskRelations(item, board.items), [item, board.items]);
  const isDone = (entry: BoardItem) => entry.isClosed || (!!board.statusMap.done && entry.columnId === board.statusMap.done);
  const pendingDeps = relations.dependsOn.filter((dep) => dep.item && !isDone(dep.item)).length;

  const values = board.fields.flatMap((field) => {
    const option = field.options.find((entry) => entry.id === item.fields[field.id]);
    return option ? [{ field, option }] : [];
  });
  const priority = values.find(({ field }) => /priorid|priority/i.test(field.name));
  const awaiting = values.find(({ field, option }) => /decis/i.test(field.name) && /aguard/i.test(option.name));
  const columnOf = (id: string | null) => board.columns.find((column) => column.id === id);

  return (
    <div className={`fixed inset-0 z-40 flex flex-col overflow-hidden bg-surface lg:flex-row ${working ? 'glow-working' : ''}`}>
      {/* Priority accent, consistent with the cards */}
      <span
        className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5"
        style={{ backgroundColor: priority?.option.color ?? 'var(--color-accent)', opacity: priority ? 0.9 : 0.3 }}
      />

      {/* Main column: everything about the task */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
          <div className="flex min-w-0 items-center gap-2 text-sm text-muted">
            <span className="font-mono text-xs">{itemRef(item) || 'Tarefa'}</span>
            {source && <span className="truncate text-xs">· {source.title}</span>}
          </div>
          <div className="flex shrink-0 gap-2">
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-border bg-panel px-2.5 py-1 text-xs font-medium text-gray-200 hover:bg-border"
              >
                Abrir no {source ? boardProviderLabels[source.provider] : 'provedor'} ↗
              </a>
            )}
            <Button size="sm" onClick={onClose}>
              Fechar ✕
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-6 py-6">
            <div className="flex items-center gap-2">
              {priority ? <PriorityFlag option={priority.option} /> : <span className="text-xs text-muted">Sem prioridade</span>}
              {rework && (
                <span className="inline-flex items-center gap-1 rounded-full border border-orange-400/50 bg-orange-500/10 px-2 py-0.5 text-[11px] font-semibold text-orange-200">
                  ↩ Correção · {rework}
                </span>
              )}
            </div>
            <h2 className="mt-2 text-2xl leading-tight font-semibold">{item.title}</h2>

            {rework && (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-orange-400/50 bg-orange-500/10 px-3 py-2.5 text-sm text-orange-200">
                <span aria-hidden="true" className="mt-0.5">↩</span>
                <p>
                  <span className="font-semibold">Correção — voltou {rework === 'HOM' ? 'da homologação (HOM)' : 'do teste'}.</span>{' '}
                  Esta tarefa foi refeita por falhar no teste; os agentes pegam correções antes de tarefas novas. O relatório está na
                  descrição.
                </p>
              </div>
            )}
            {blocked && (
              <div className="mt-4 rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-200">
                <span className="font-semibold">Bloqueada</span> — está em “{columnOf(item.columnId)?.name ?? 'bloqueio'}”; os agentes não
                executam itens desta coluna até liberar.
              </div>
            )}
            {!blocked && awaiting && (
              <div className="mt-4 rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-200">
                <span className="font-semibold">Aguardando decisão</span> — precisa de uma escolha antes de um agente pegar.
              </div>
            )}
            {!blocked && pendingDeps > 0 && (
              <div className="mt-4 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-200">
                <span className="font-semibold">Em espera</span> — depende de {pendingDeps} tarefa{pendingDeps > 1 ? 's' : ''} ainda não
                concluída{pendingDeps > 1 ? 's' : ''}.
              </div>
            )}

            <div className="mt-5 grid grid-cols-2 gap-3 rounded-lg border border-border bg-panel/40 p-4 lg:grid-cols-3">
              <Field label="Status">
                <Select value={item.columnId ?? ''} onChange={(event) => move.mutate({ itemId: item.id, columnId: event.target.value })}>
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
                    onChange={(event) => setField.mutate({ itemId: item.id, fieldId: field.id, optionId: event.target.value || null })}
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

            <dl className="mt-4 space-y-2 text-sm">
              {item.repository && (
                <div className="flex items-center gap-2">
                  <dt className="w-28 shrink-0 text-muted">Repositório</dt>
                  <dd className="truncate font-mono text-xs">{item.repository}</dd>
                </div>
              )}
              <div className="flex items-center gap-2">
                <dt className="w-28 shrink-0 text-muted">Responsáveis</dt>
                <dd className="flex min-w-0 items-center gap-2">
                  {item.assignees.length > 0 ? (
                    <>
                      <AvatarStack logins={item.assignees} size={22} />
                      <span className="truncate text-xs text-muted">{item.assignees.map((login) => `@${login}`).join(', ')}</span>
                    </>
                  ) : (
                    <span className="text-xs text-muted">Ninguém</span>
                  )}
                </dd>
              </div>
              {item.pullRequests.length > 0 && (
                <div className="flex items-start gap-2">
                  <dt className="w-28 shrink-0 text-muted">Pull requests</dt>
                  <dd className="flex flex-wrap gap-1.5">
                    {item.pullRequests.map((pr) => (
                      <a
                        key={pr.url}
                        href={pr.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-full border border-border bg-panel px-2 py-0.5 text-xs text-accent hover:border-accent/60"
                      >
                        <svg viewBox="0 0 16 16" className="size-3" fill="currentColor" aria-hidden="true">
                          <path d="M4.5 2a2 2 0 0 0-.75 3.85v4.3a2 2 0 1 0 1.5 0V8.6c.4.26.87.4 1.37.4H9.1a2 2 0 0 0 1.9-1.37A2 2 0 1 0 9.6 5.1 2 2 0 0 0 7.87 6.5H6.62c-.3 0-.6-.09-.87-.25V5.85A2 2 0 0 0 4.5 2Z" />
                        </svg>
                        #{pr.number}
                        <span className="text-muted">· {pr.state.toLowerCase()}</span>
                      </a>
                    ))}
                  </dd>
                </div>
              )}
            </dl>

            {(relations.dependsOn.length > 0 || relations.blocks.length > 0) && (
              <section className="mt-5 rounded-lg border border-border bg-panel p-4">
                <h3 className="text-sm font-semibold">Relações e dependências</h3>
                {relations.dependsOn.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium tracking-wide text-muted uppercase">⏳ Espera · depende de</p>
                    <ul className="mt-1.5 space-y-1.5">
                      {relations.dependsOn.map((dep, index) => (
                        <LinkedTask key={`${dep.raw}-${index}`} link={dep} done={!!dep.item && isDone(dep.item)} column={columnOf(dep.item?.columnId ?? null)} onOpen={onOpenItem} />
                      ))}
                    </ul>
                  </div>
                )}
                {relations.blocks.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium tracking-wide text-muted uppercase">⛔ Trava · outras esperam esta</p>
                    <ul className="mt-1.5 space-y-1.5">
                      {relations.blocks.map((blockedItem) => (
                        <LinkedTask
                          key={blockedItem.id}
                          link={{ raw: itemRef(blockedItem), item: blockedItem }}
                          done={isDone(blockedItem)}
                          column={columnOf(blockedItem.columnId)}
                          onOpen={onOpenItem}
                        />
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )}

            {checklist.length > 0 && <TaskChecklist workspaceId={workspace.id} itemId={item.id} sections={checklist} />}

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

            {/* Comments stack under the content on narrow screens */}
            <div className="mt-6 border-t border-border pt-4 lg:hidden">
              <CommentsPanel query={comments} />
            </div>
          </div>
        </div>
      </main>

      {/* Activity column, ClickUp-style, on wide screens */}
      <aside className="hidden min-h-0 shrink-0 flex-col border-l border-border bg-panel/30 lg:flex lg:w-[380px] xl:w-[420px]">
        <div className="border-b border-border px-5 py-3">
          <h3 className="text-sm font-semibold">
            Atividade
            {(comments.data?.length ?? 0) > 0 && <span className="ml-1 font-normal text-muted">({comments.data?.length})</span>}
          </h3>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <CommentsPanel query={comments} />
        </div>
      </aside>
    </div>
  );
}

/** A clickable reference to another board task, ClickUp-style, with a status dot and badge. */
function LinkedTask({
  link,
  done,
  column,
  onOpen,
}: {
  link: DependencyLink;
  done: boolean;
  column: { name: string; color: string } | undefined;
  onOpen?: (item: BoardItem) => void;
}) {
  if (!link.item) {
    return (
      <li className="flex items-center gap-2 rounded-md border border-border/50 bg-surface px-2.5 py-1.5 text-sm">
        <span className="font-mono text-xs text-muted">{link.raw}</span>
        <span className="text-xs text-muted">· não encontrada no quadro</span>
      </li>
    );
  }
  const target = link.item;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen?.(target)}
        disabled={!onOpen}
        className="flex w-full items-center gap-2 rounded-md border border-border/70 bg-surface px-2.5 py-1.5 text-left text-sm transition-colors hover:border-accent/60 hover:bg-panel disabled:cursor-default disabled:hover:border-border/70 disabled:hover:bg-surface"
      >
        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: column?.color ?? 'var(--color-muted)' }} />
        <span className="shrink-0 font-mono text-xs text-muted">{itemRef(target)}</span>
        <span className="min-w-0 flex-1 truncate">{target.title}</span>
        {done ? (
          <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">Concluída</span>
        ) : (
          <span className="shrink-0 rounded-full bg-border px-1.5 py-0.5 text-[10px] font-medium text-muted">{column?.name ?? 'Pendente'}</span>
        )}
      </button>
    </li>
  );
}

/** CA / DoD checklists parsed from the body, ticked as the task advances, with a badge for who ticked each line. */
function TaskChecklist({ workspaceId, itemId, sections }: { workspaceId: string; itemId: string; sections: ChecklistSection[] }) {
  const checklist = useTaskChecklist(workspaceId, itemId);
  const toggle = useToggleChecklist(workspaceId, itemId);
  const byKey = new Map((checklist.data ?? []).map((check) => [check.code, check]));

  return (
    <section className="mt-5 space-y-4">
      {sections.map((section) => {
        const done = section.items.filter((entry) => byKey.has(entry.key)).length;
        const pct = section.items.length ? Math.round((done / section.items.length) * 100) : 0;
        return (
          <div key={section.kind} className="rounded-lg border border-border bg-panel p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">{section.title}</h3>
              <span className="text-xs font-medium text-muted">
                {done}/{section.items.length}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
            <ul className="mt-3 space-y-0.5">
              {section.items.map((entry) => {
                const check = byKey.get(entry.key);
                const checked = !!check;
                return (
                  <li key={entry.key}>
                    <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-surface">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={toggle.isPending}
                        onChange={() => toggle.mutate({ code: entry.key, checked: !checked })}
                        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-emerald-500"
                      />
                      <span className="min-w-0 flex-1">
                        {entry.code && (
                          <span className="mr-1.5 rounded bg-border px-1 py-0.5 align-middle font-mono text-[10px] font-semibold text-muted">
                            {entry.code}
                          </span>
                        )}
                        <span className={`align-middle text-sm ${checked ? 'text-muted line-through' : 'text-fg'}`}>{entry.label}</span>
                      </span>
                      {check && <ChecklistMedal check={check} />}
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <ErrorText error={toggle.error} />
    </section>
  );
}

/** A little badge in front of a ticked line: who marked it (user or agent) and when. */
function ChecklistMedal({ check }: { check: ChecklistCheck }) {
  const who = check.checkedByKind === 'agent' ? `${check.checkedBy} (agente)` : check.checkedBy;
  return (
    <span className="relative mt-0.5 shrink-0" title={`Marcado por ${who} · ${dateTime.format(new Date(check.checkedAt))}`}>
      <Avatar login={check.checkedBy} size={20} />
      {check.checkedByKind === 'agent' && (
        <span className="absolute -right-1 -bottom-1 rounded-full bg-panel px-px text-[8px] leading-none ring-1 ring-border">🤖</span>
      )}
    </span>
  );
}

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

type CommentsQuery = ReturnType<typeof useTaskComments>;

/** The task's comments (signed by the agents: approvals, rejections, HOM reports, decisions), oldest first. */
function CommentsPanel({ query }: { query: CommentsQuery }) {
  const list: TaskComment[] = query.data ?? [];
  if (query.isPending) return <p className="text-sm text-muted">Carregando…</p>;
  if (query.error) return <ErrorText error={query.error} />;
  if (list.length === 0) return <p className="text-sm text-muted">Sem atividade ainda. Aprovações, reprovações e relatórios dos agentes aparecem aqui.</p>;
  return (
    <ol className="space-y-3">
      {list.map((comment) => (
        <li key={`${comment.at}-${comment.author}`} className="rounded-lg border border-border bg-panel/60 p-3">
          <div className="flex items-center gap-2 text-xs text-muted">
            <Avatar login={comment.author} size={18} />
            <span className="font-medium text-fg">@{comment.author}</span>
            <span>· {dateTime.format(new Date(comment.at))}</span>
          </div>
          <div className="mt-1.5">
            <TaskMarkdown text={comment.body} />
          </div>
        </li>
      ))}
    </ol>
  );
}
