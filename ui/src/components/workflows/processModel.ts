import type { AgentProfile } from '../../api/agentProfiles';
import type { Board, StatusRole } from '../../api/boards';
import type { Workflow } from '../../api/workflows';

/**
 * The canvas of a process: its workflows and the board columns that connect them. Workflows hand work to each other
 * through the board (one creates tasks in "A fazer", another picks them up), so the links come from the triggers:
 * - a workflow started by you whose agent uses the board creates tasks → "A fazer" (and "Aguardando aprovação" when the
 *   process has a decision workflow);
 * - "tarefa no quadro" picks tasks from its column (with its filters) and moves them to "Concluído"/"Homologação";
 * - "aguardando decisão" reads "Aguardando aprovação" and sends the decided tasks to "A fazer";
 * - "funcionalidade em homologação" reads "Homologação" and finishes in "Concluído".
 */

export type ProcessNodeData =
  | { kind: 'workflow'; workflow: Workflow }
  | { kind: 'column'; columnId: string; name: string; color: string | null; tasks: number };

export interface ProcessGraphNode {
  id: string;
  data: ProcessNodeData;
  rank: number;
  row: number;
}

export interface ProcessGraphEdge {
  id: string;
  source: string;
  target: string;
  label: string | null;
  /** Goes back to an earlier column (e.g. decided tasks returning to "A fazer"). */
  back: boolean;
}

const ROLE_NAMES: Record<StatusRole, string> = {
  todo: 'A fazer',
  inProgress: 'Em andamento',
  review: 'Em revisão',
  homologation: 'Homologação',
  done: 'Concluído',
  blocked: 'Aguardando aprovação',
};

export function buildProcessGraph(workflows: Workflow[], profiles: AgentProfile[], board: Board | null) {
  const nodes = new Map<string, ProcessGraphNode>();
  const edges: ProcessGraphEdge[] = [];

  const columnNode = (columnId: string | null | undefined, role: StatusRole) => {
    const id = `column:${columnId ?? role}`;
    if (!nodes.has(id)) {
      const column = board?.columns.find((entry) => entry.id === columnId);
      const tasks = columnId && board ? board.items.filter((item) => item.columnId === columnId && !item.isClosed).length : 0;
      nodes.set(id, { id, rank: 0, row: 0, data: { kind: 'column', columnId: columnId ?? role, name: column?.name ?? ROLE_NAMES[role], color: column?.color ?? null, tasks } });
    }
    return id;
  };
  const feedback = new Set<string>();
  const link = (source: string, target: string, label: string | null, isFeedback = false) => {
    const id = `${source}->${target}`;
    if (isFeedback) feedback.add(id);
    edges.push({ id, source, target, label, back: false });
  };
  const statusMap = board?.statusMap ?? {};
  const usesBoard = (workflow: Workflow) =>
    workflow.steps.some((step) => step.kind === 'agent' && profiles.find((profile) => profile.id === step.profileId)?.tools.includes('board'));
  const hasDecisions = workflows.some((workflow) => workflow.trigger.type === 'task_awaiting_decision');

  for (const workflow of workflows) {
    const id = `workflow:${workflow.id}`;
    nodes.set(id, { id, rank: 0, row: 0, data: { kind: 'workflow', workflow } });
    const trigger = workflow.trigger;
    if (trigger.type === 'manual') {
      if (usesBoard(workflow)) {
        link(id, columnNode(statusMap.todo, 'todo'), 'cria tarefas');
        if (hasDecisions) link(id, columnNode(statusMap.blocked, 'blocked'), 'dúvidas para decidir');
      }
    } else if (trigger.type === 'board_task') {
      const filters = board
        ? board.fields.flatMap((field) =>
            (trigger.fieldFilters[field.id] ?? []).flatMap((optionId) => {
              const option = field.options.find((entry) => entry.id === optionId);
              return option ? [`${field.name}: ${option.name}`] : [];
            }),
          )
        : [];
      link(columnNode(trigger.columnId ?? statusMap.todo, 'todo'), id, filters.join(' · ') || null);
      const doneRole = trigger.moveWhenDone === 'homologation' ? 'homologation' : 'done';
      link(id, columnNode(statusMap[doneRole], doneRole), 'ao terminar');
    } else if (trigger.type === 'task_awaiting_decision') {
      link(columnNode(statusMap.blocked, 'blocked'), id, null);
      link(id, columnNode(statusMap.todo, 'todo'), 'decididas', true);
    } else {
      link(columnNode(statusMap.homologation, 'homologation'), id, 'funcionalidade completa');
      link(id, columnNode(statusMap.done, 'done'), 'aprovada');
    }
  }

  // Left to right in the order work flows. Arrows that send work back do not push columns to the right, and any other
  // loop stops after one pass per node.
  for (let pass = 0; pass < nodes.size; pass++) {
    let changed = false;
    for (const edge of edges) {
      if (feedback.has(edge.id)) continue;
      const source = nodes.get(edge.source)!;
      const target = nodes.get(edge.target)!;
      if (target.rank < source.rank + 1) {
        target.rank = source.rank + 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const edge of edges) edge.back = nodes.get(edge.target)!.rank <= nodes.get(edge.source)!.rank;
  const rows = new Map<number, number>();
  for (const node of nodes.values()) {
    node.row = rows.get(node.rank) ?? 0;
    rows.set(node.rank, node.row + 1);
  }
  return { nodes: [...nodes.values()], edges, rows };
}
