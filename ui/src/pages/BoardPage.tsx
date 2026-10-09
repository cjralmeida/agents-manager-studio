import { AllTasksPanel } from '../components/board/AllTasksPanel';
import { BoardModelPanel } from '../components/board/BoardModelPanel';
import { Tabs, useTabParam } from '../components/Tabs';

const tabs = [
  { id: 'tasks', label: 'Tarefas' },
  { id: 'model', label: 'Modelo' },
] as const;

/** Tasks of every workspace and the board model they all follow. */
export function BoardPage() {
  const [activeTab, setActiveTab] = useTabParam(tabs);

  return (
    <div>
      <h1 className="text-xl font-semibold">Quadro de tarefas</h1>
      <p className="mt-1 text-sm text-muted">O modelo vale para os quadros de todos os workspaces, no GitHub, no GitLab ou só no Studio.</p>
      <div className="mt-4">
        <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
      </div>
      <div className="mt-6">{activeTab === 'tasks' ? <AllTasksPanel /> : <BoardModelPanel />}</div>
    </div>
  );
}
