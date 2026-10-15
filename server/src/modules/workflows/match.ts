import { createHash } from 'node:crypto';
import { decisionMark, dependencyRefs, itemRef } from '../boards/dependencies.js';
import type { BoardField, BoardItem } from '../boards/types.js';

/** What a board-triggered workflow looks for on the board. */
export interface TaskRule {
  /** Field id -> accepted option ids; empty lists are ignored. */
  fieldFilters: Record<string, string[]>;
  /** Accepted repository paths; empty accepts all. */
  repositories: string[];
  /** Column watched (already resolved to the board's "todo" column when not set). */
  columnId: string | null;
  onlyUnassigned: boolean;
}

export function matchesRule(item: BoardItem, rule: TaskRule) {
  if (!rule.columnId || item.columnId !== rule.columnId || item.isClosed) return false;
  // Agents work on a repository, so drafts without one are left to people.
  if (!item.repository) return false;
  if (rule.onlyUnassigned && item.assignees.length > 0) return false;
  if (rule.repositories.length > 0 && !rule.repositories.some((path) => path.toLowerCase() === item.repository!.toLowerCase())) {
    return false;
  }
  return Object.entries(rule.fieldFilters).every(
    ([fieldId, options]) => options.length === 0 || (item.fields[fieldId] !== undefined && options.includes(item.fields[fieldId])),
  );
}

/** Position of the item priority in the "Prioridade/Priority" field (P0 first); unset goes last. */
export function priorityRank(item: BoardItem, fields: BoardField[]) {
  const field = fields.find((entry) => /priori/i.test(entry.name));
  const optionId = field ? item.fields[field.id] : undefined;
  const index = field && optionId ? field.options.findIndex((option) => option.id === optionId) : -1;
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/** Matching tasks, highest priority first, then the oldest. */
export function pickTasks(items: BoardItem[], fields: BoardField[], rule: TaskRule) {
  return items
    .filter((item) => matchesRule(item, rule))
    .sort((a, b) => priorityRank(a, fields) - priorityRank(b, fields) || a.updatedAt.localeCompare(b.updatedAt));
}

/** Message describing a task for an agent; the server appends the board README after it. */
export function taskPrompt(item: BoardItem, instructions: string) {
  const ref = item.repository && item.number ? `${item.repository}#${item.number}` : 'do quadro';
  const link = [item.url, `id no quadro: ${item.id}`].filter(Boolean).join(' — ');
  const parts = [`Resolva a tarefa ${ref}: ${item.title}`, link, '', item.body.trim()];
  if (instructions.trim()) parts.push('', '---', 'Instruções extras:', instructions.trim());
  return parts.join('\n').trim();
}

/**
 * Open tasks in the "blocked" column (Backlog) that wait for a decision. On a board with the decision field, the
 * tasks marked with it; without the field, the ones without a "Depende de:" line (those only wait for their
 * dependencies, which the Studio releases).
 */
export function awaitingDecision(items: BoardItem[], blockedColumnId: string, repositories: string[], fields: BoardField[] = []) {
  const mark = decisionMark(fields);
  return items.filter(
    (item) =>
      item.columnId === blockedColumnId &&
      !item.isClosed &&
      Boolean(item.repository) &&
      (mark ? item.fields[mark.fieldId] === mark.optionId : dependencyRefs(item.body).length === 0) &&
      (repositories.length === 0 || repositories.some((path) => path.toLowerCase() === item.repository!.toLowerCase())),
  );
}

/** Message for an agent that studies a task waiting for a decision and decides it with the user. */
export function decisionPrompt(item: BoardItem, fields: BoardField[] = []) {
  const ref = item.repository && item.number ? `${item.repository}#${item.number}` : 'do quadro';
  const link = [item.url, `id no quadro: ${item.id}`].filter(Boolean).join(' — ');
  const mark = decisionMark(fields);
  return [
    `A tarefa ${ref} está no Backlog esperando uma decisão: ${item.title}`,
    link,
    'Estude a tarefa e decida com o usuário; só mova o card depois da decisão dele.',
    'Pergunte SEMPRE pela ferramenta AskUserQuestion (o quadro de respostas do Studio, com opções e a recomendada marcada), nunca em texto: o seu trabalho termina quando o turno termina, e uma pergunta escrita no texto encerra a decisão sem resposta.',
    ...(mark
      ? [
          `Depois da decisão, limpe o campo "${mark.field}" (board_update_task com fields {"${mark.field}": ""}) e mova o card para onde a decisão levar ("A fazer" se pode ser feita; fica no Backlog se ainda espera outras tarefas, com a linha "Depende de:").`,
        ]
      : []),
    '',
    item.body.trim(),
  ].join('\n');
}

const FEATURE_ID = /\[(FUNC-\d+)\]/i;

/** "FUNC-012" from a task titled "[FUNC-012] Backend — ...", or null. */
export function featureIdOf(title: string) {
  return FEATURE_ID.exec(title)?.[1]?.toUpperCase() ?? null;
}

export interface ReadyFeature {
  featureId: string;
  /** Open tasks of the feature, all in the homologation column. */
  tasks: BoardItem[];
  /** Changes when tasks or their descriptions change (e.g. a report appended), so a feature is not tested twice as is. */
  signature: string;
}

/** Features whose open tasks (not done nor closed) are all in homologation; tasks of other repositories are ignored. */
export function featuresReady(
  items: BoardItem[],
  input: { homologationColumnId: string; doneColumnId: string | null; repositories: string[] },
): ReadyFeature[] {
  const accepts = (item: BoardItem) =>
    input.repositories.length === 0 || input.repositories.some((path) => path.toLowerCase() === (item.repository ?? '').toLowerCase());
  const groups = new Map<string, BoardItem[]>();
  for (const item of items) {
    const featureId = featureIdOf(item.title);
    if (!featureId || item.isClosed || item.columnId === input.doneColumnId || !accepts(item)) continue;
    groups.set(featureId, [...(groups.get(featureId) ?? []), item]);
  }
  return [...groups.entries()]
    .filter(([, tasks]) => tasks.every((task) => task.columnId === input.homologationColumnId))
    .map(([featureId, tasks]) => {
      const sorted = [...tasks].sort((a, b) => a.id.localeCompare(b.id));
      const signature = createHash('sha256')
        .update(sorted.map((task) => `${task.id}\n${task.body}`).join('\n---\n'))
        .digest('hex')
        .slice(0, 32);
      return { featureId, tasks: sorted, signature };
    })
    .sort((a, b) => a.featureId.localeCompare(b.featureId));
}

const taskSection = (task: BoardItem) =>
  [`## ${task.title}`, `Tarefa: ${itemRef(task) ?? task.id} (id ${task.id})${task.url ? ` — ${task.url}` : ''}`, '', task.body.trim()].join('\n');

/**
 * Open tasks (not done nor closed) that depend on the given one with "Depende de:", e.g. the screens that use an API.
 * A backend task only goes to done once the screens that use it were tested too.
 */
export function pendingDependents(items: BoardItem[], task: BoardItem, doneColumnId: string | null, except: string[] = []) {
  const ref = itemRef(task)?.toLowerCase();
  if (!ref) return [];
  return items.filter(
    (item) =>
      !item.isClosed &&
      item.columnId !== doneColumnId &&
      !except.includes(item.id) &&
      dependencyRefs(item.body).some((dependency) => dependency.toLowerCase() === ref),
  );
}

/** Lines telling the tester which tasks wait for screens still to be tested (they stay in homologation). */
function waitingLines(waiting: { task: BoardItem; dependents: BoardItem[] }[]) {
  return waiting.map(
    ({ task, dependents }) =>
      `- ${itemRef(task) ?? task.id} (${task.title}) fica em homologação mesmo aprovada: ainda falta testar ${dependents.map((item) => itemRef(item) ?? item.title).join(', ')}, que depende(m) dela.`,
  );
}

/**
 * Screens (tasks of other repositories) that use the given tasks ("Depende de:") and are already published: in
 * homologation or done. Testing a backend through them shows what the user really gets.
 */
export function screensUsing(items: BoardItem[], tasks: BoardItem[], input: { homologationColumnId: string; doneColumnId: string | null }) {
  const refs = new Set(tasks.flatMap((task) => (itemRef(task) ? [itemRef(task)!.toLowerCase()] : [])));
  const ids = new Set(tasks.map((task) => task.id));
  const repositories = new Set(tasks.map((task) => (task.repository ?? '').toLowerCase()));
  return items.filter(
    (item) =>
      !ids.has(item.id) &&
      !repositories.has((item.repository ?? '').toLowerCase()) &&
      ((item.columnId === input.homologationColumnId && !item.isClosed) || item.columnId === input.doneColumnId) &&
      dependencyRefs(item.body).some((ref) => refs.has(ref.toLowerCase())),
  );
}

/** Message for the agent that tests a whole feature: every task with its full description, and the screens using it. */
export function featurePrompt(feature: ReadyFeature, items: BoardItem[] = [], doneColumnId: string | null = null, screens: BoardItem[] = []) {
  const ids = [...feature.tasks, ...screens].map((task) => task.id);
  const waiting = feature.tasks
    .map((task) => ({ task, dependents: pendingDependents(items, task, doneColumnId, ids) }))
    .filter((entry) => entry.dependents.length > 0);
  const inHomologation = screens.filter((screen) => screen.columnId !== doneColumnId).map((screen) => itemRef(screen) ?? screen.id);
  return [
    `Teste em homologação a funcionalidade ${feature.featureId} inteira. Todas as tarefas dela estão em homologação:`,
    ...feature.tasks.map(taskSection),
    ...(screens.length > 0
      ? [
          [
            '# Telas que usam estas tarefas (já publicadas: em homologação ou concluídas)',
            'Teste o backend também por estas telas, como o usuário usa: os critérios delas que passam pelas rotas acima, as jornadas e o tráfego da tela contra o contrato. Uma tela concluída que quebrou com o backend novo também é falha.',
          ].join('\n'),
          ...screens.map((screen) => `${taskSection(screen)}\n\n(Coluna atual: ${screen.columnId === doneColumnId ? 'Concluído' : 'Em homologação'})`),
        ]
      : []),
    [
      '## Ao terminar',
      '- Reprovado: decida de quem é cada falha pela rede (API errada → tarefa de backend; API certa e tela errada → tarefa da tela; as duas no mesmo ponto → as duas, cada uma com a sua parte). Escreva o "Relatório de HOM" em cada tarefa com falha e devolva-a para "A fazer", inclusive uma tela que estava em "Concluído". As sem falha ficam onde estão.',
      `- Aprovado: mova para "Concluído" as tarefas de backend${waiting.length > 0 ? ' que não aparecem abaixo' : ''}${inHomologation.length > 0 ? ` e as telas em homologação testadas aqui (${inHomologation.join(', ')})` : ''}.`,
      ...(waiting.length > 0
        ? ['- Estas tarefas são usadas por telas que ainda não foram publicadas (o teste da tela as conclui depois):', ...waitingLines(waiting)]
        : []),
    ].join('\n'),
  ].join('\n\n');
}

export interface ReadyFrontendTask {
  task: BoardItem;
  /** Tasks it depends on that are still in homologation (the backend it uses), tested together with it. */
  backend: BoardItem[];
}

/**
 * Frontend tasks in homologation whose "Depende de:" tasks are all delivered, highest priority first (then the lowest
 * number, the order they were planned in). A backend dependency counts as delivered in homologation or done (closed
 * counts as done): the screen is tested against the published API, together with it. A dependency that is itself a
 * frontend task (of the watched repositories) must be approved first: the screen that builds on another waits for it.
 * Tasks of other repositories are ignored.
 */
export function frontendTasksReady(
  items: BoardItem[],
  input: { homologationColumnId: string; doneColumnId: string | null; repositories: string[] },
  fields: BoardField[] = [],
): ReadyFrontendTask[] {
  const byRef = new Map(items.flatMap((item) => (itemRef(item) ? [[itemRef(item)!.toLowerCase(), item] as const] : [])));
  const accepts = (item: BoardItem) =>
    input.repositories.length === 0 || input.repositories.some((path) => path.toLowerCase() === (item.repository ?? '').toLowerCase());
  const done = (item: BoardItem) => item.isClosed || item.columnId === input.doneColumnId;
  const ready: ReadyFrontendTask[] = [];
  for (const task of items) {
    if (task.isClosed || task.columnId !== input.homologationColumnId || !accepts(task)) continue;
    const dependencies = dependencyRefs(task.body).map((ref) => byRef.get(ref.toLowerCase()));
    const delivered = dependencies.every(
      (dependency) => dependency && (done(dependency) || (!accepts(dependency) && dependency.columnId === input.homologationColumnId)),
    );
    if (!delivered) continue;
    const backend = dependencies.filter((dependency): dependency is BoardItem => !done(dependency!) && dependency!.columnId === input.homologationColumnId);
    ready.push({ task, backend });
  }
  return ready.sort(
    (a, b) => priorityRank(a.task, fields) - priorityRank(b.task, fields) || (a.task.number ?? Number.MAX_SAFE_INTEGER) - (b.task.number ?? Number.MAX_SAFE_INTEGER),
  );
}

/** Message for the tester of one frontend task: the task, the tasks it uses still in homologation, what to move. */
export function frontendPrompt(ready: ReadyFrontendTask, items: BoardItem[], doneColumnId: string | null) {
  const { task, backend } = ready;
  const withDependents = backend.map((entry) => ({ task: entry, dependents: pendingDependents(items, entry, doneColumnId, [task.id]) }));
  const concluding = withDependents.filter((entry) => entry.dependents.length === 0).map((entry) => itemRef(entry.task) ?? entry.task.id);
  return [
    `Teste em homologação a tarefa de frontend ${itemRef(task) ?? task.id}: ${task.title}. Ela e as tarefas de que depende já estão publicadas em homologação (ou concluídas).`,
    'Teste a tela de verdade, ligada à API publicada: os critérios desta tarefa e, pela tela e pela API, os das tarefas de backend abaixo que ela usa.',
    taskSection(task),
    ...(backend.length > 0 ? ['# Tarefas de backend que esta tela usa (em homologação)', ...backend.map(taskSection)] : []),
    [
      '## Ao terminar',
      `- Aprovado: o Studio move ${itemRef(task) ?? 'a tarefa'} para "Concluído" quando você terminar com sucesso.${concluding.length > 0 ? ` Mova você mesmo para "Concluído" também: ${concluding.join(', ')}.` : ''}`,
      ...waitingLines(withDependents.filter((entry) => entry.dependents.length > 0)),
      '- Reprovado: escreva o "Relatório de HOM" em cada tarefa com falha (a tela ou a API, conforme a rede mostrar) e devolva-a para "A fazer"; as sem falha ficam em homologação.',
    ].join('\n'),
  ].join('\n\n');
}
