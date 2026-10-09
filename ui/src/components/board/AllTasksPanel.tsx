import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { type Agent, useAgents } from '../../api/agents';
import { type OverviewItem, useAllTasks, useMoveOverviewTask } from '../../api/boards';
import { ErrorText, TextInput } from '../form';
import { MultiSelect } from '../MultiSelect';
import { ViewToggle, usePersistedView } from '../ViewToggle';
import { matchesSearch } from './boardUtils';
import { KanbanView } from './KanbanView';
import { TaskTable } from './TaskTable';

/** Agent of each task, keyed like the overview items ("<workspaceId>:<item id>"). */
function agentsByOverviewItem(agents: Agent[]) {
  const map = new Map<string, Agent>();
  for (const agent of agents) {
    if (!agent.taskItemId) continue;
    const key = `${agent.workspaceId}:${agent.taskItemId}`;
    const current = map.get(key);
    if (!current || (current.status === 'CANCELLED' && agent.status !== 'CANCELLED')) map.set(key, agent);
  }
  return map;
}

/** Tasks of every workspace on the model's columns; a card opens on its workspace board. */
export function AllTasksPanel() {
  const overview = useAllTasks();
  const agents = useAgents();
  const move = useMoveOverviewTask();
  const navigate = useNavigate();
  const [view, setView] = usePersistedView('all-tasks');
  const [search, setSearch] = useState('');
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([]);

  const agentMap = useMemo(() => agentsByOverviewItem(agents.data ?? []), [agents.data]);

  if (overview.error) return <ErrorText error={overview.error} />;
  if (!overview.data) return <p className="text-sm text-muted">Lendo os quadros dos workspaces...</p>;
  const data = overview.data;

  const workspaces = [...new Map(data.items.map((item) => [item.workspaceId, item.workspaceName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const items = data.items.filter((item) => (workspaceIds.length === 0 || workspaceIds.includes(item.workspaceId)) && matchesSearch(item, search));
  const layout = { columns: data.columns, fields: data.fields, link: { statusMap: data.statusMap } };
  const open = (item: OverviewItem) => navigate(`/workspaces/${item.workspaceId}?tab=board&task=${encodeURIComponent(item.itemId)}`);
  const label = (item: OverviewItem) => (item.alsoIn.length > 0 ? `${item.workspaceName} +${item.alsoIn.length}` : item.workspaceName);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {items.length} tarefa(s) de {workspaces.length} workspace(s). Arraste entre colunas para mover no quadro do workspace.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-56">
            <MultiSelect
              options={workspaces.map(([id, name]) => ({ value: id, label: name }))}
              selected={workspaceIds}
              onChange={setWorkspaceIds}
              placeholder="Todos os workspaces"
            />
          </div>
          <TextInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar tarefa, #número, @pessoa" className="w-60" />
          <ViewToggle view={view} onChange={setView} cardsLabel="Quadro" />
        </div>
      </header>

      {data.excluded.length > 0 && (
        <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
          {data.excluded.map((entry) => (
            <p key={entry.workspaceId}>
              <Link to={`/workspaces/${entry.workspaceId}?tab=board`} className="font-medium hover:underline">
                {entry.workspaceName}
              </Link>{' '}
              fora desta visão: {entry.reason}
            </p>
          ))}
        </div>
      )}
      <ErrorText error={move.error} />

      {view === 'cards' ? (
        <KanbanView
          board={layout}
          items={items}
          agents={agentMap}
          onOpen={open}
          onMove={(item, columnId) => move.mutate({ item, columnId })}
          label={label}
        />
      ) : (
        <TaskTable board={layout} items={items} agents={agentMap} onOpen={open} label={{ title: 'Workspace', value: label }} />
      )}
    </div>
  );
}
