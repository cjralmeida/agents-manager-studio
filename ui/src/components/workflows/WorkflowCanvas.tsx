import {
  Background,
  BaseEdge,
  Controls,
  type Edge,
  type EdgeProps,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  applyNodeChanges,
  getBezierPath,
  getSmoothStepPath,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useState } from 'react';
import type { AgentProfile } from '../../api/agentProfiles';
import type { Board } from '../../api/boards';
import { environmentLabels } from '../../api/render';
import type { WorkflowStep, WorkflowTrigger } from '../../api/workflows';
import { stepLabel } from './workflowModel';

const GAP = 280;
const ROW_Y = 0;

type TriggerNode = Node<{ title: string; detail: string; selected: boolean }, 'trigger'>;
type StepNode = Node<
  { step: WorkflowStep; index: number; title: string; agentName: string | null; model: string | null; running: boolean; selected: boolean },
  'step'
>;
type AddNode = Node<{ onAdd: () => void }, 'add'>;
type CanvasNode = TriggerNode | StepNode | AddNode;

type InsertEdge = Edge<{ label: string | null; onInsert: () => void }, 'insert'>;
type FailureEdge = Edge<{ label: string; depth: number }, 'failure'>;

interface WorkflowCanvasProps {
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  profiles: AgentProfile[];
  board: Board | null;
  selectedId: string;
  /** Comma separated ids of the steps running now. */
  runningStepIds: string;
  onSelect: (id: string) => void;
  onInsert: (index: number) => void;
  onReorder: (orderedIds: string[]) => void;
  onRemove: (stepIds: string[]) => void;
}

function triggerText(trigger: WorkflowTrigger, board: Board | null) {
  if (trigger.type === 'manual') {
    const days = trigger.schedule?.weekdays.map((day) => ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][day]).join(', ');
    return { title: 'Mensagem sua', detail: trigger.schedule ? `Você inicia, ou sozinho (${days} às ${trigger.schedule.at})` : 'Você inicia com uma conversa' };
  }
  if (trigger.type === 'feature_in_homologation') return { title: 'Funcionalidade em homologação', detail: 'Todas as tarefas chegaram lá' };
  if (trigger.type === 'frontend_in_homologation') return { title: 'Tela em homologação', detail: 'Frontend e o backend dela chegaram lá' };
  if (trigger.type === 'task_awaiting_decision') return { title: 'Tarefa aguardando decisão', detail: 'Backlog, campo Decisão marcado' };
  const filters = board
    ? board.fields.flatMap((field) =>
        (trigger.fieldFilters[field.id] ?? []).map((optionId) => field.options.find((option) => option.id === optionId)?.name).filter(Boolean),
      )
    : [];
  const column = board?.columns.find((entry) => entry.id === trigger.columnId)?.name ?? 'A fazer';
  return { title: 'Tarefa no quadro', detail: `${column}${filters.length ? ` · ${filters.join(', ')}` : ''}` };
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  const { trigger, steps, profiles, board, selectedId, runningStepIds, onSelect, onInsert, onReorder, onRemove } = props;

  const layout = useMemo<CanvasNode[]>(() => {
    const running = new Set(runningStepIds.split(','));
    const triggerInfo = triggerText(trigger, board);
    return [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: ROW_Y }, deletable: false, draggable: false, data: { ...triggerInfo, selected: selectedId === 'trigger' } },
      ...steps.map<StepNode>((step, index) => ({
        id: step.id,
        type: 'step',
        position: { x: GAP * (index + 1), y: ROW_Y },
        data: {
          step,
          index,
          title: stepLabel(step, profiles),
          agentName: step.kind === 'agent' ? (profiles.find((profile) => profile.id === step.profileId)?.name ?? 'agente removido') : null,
          model: step.kind === 'agent' ? step.model : null,
          running: running.has(step.id),
          selected: selectedId === step.id,
        },
      })),
      { id: 'add', type: 'add', position: { x: GAP * (steps.length + 1), y: ROW_Y + 22 }, deletable: false, draggable: false, data: { onAdd: () => onInsert(steps.length) } },
    ];
  }, [trigger, board, steps, profiles, selectedId, runningStepIds, onInsert]);

  // Positions are owned here only while dragging; any change to the steps lays the row out again.
  const [nodes, setNodes] = useState<CanvasNode[]>(layout);
  // Keeps the measured sizes, so the canvas does not need to measure the nodes again.
  useEffect(() => setNodes((current) => layout.map((node) => ({ ...node, measured: current.find((entry) => entry.id === node.id)?.measured }) as CanvasNode)), [layout]);

  const edges = useMemo<(InsertEdge | FailureEdge | Edge)[]>(() => {
    const chain = ['trigger', ...steps.map((step) => step.id)];
    const sequence = steps.map<InsertEdge>((step, index) => ({
      id: `seq-${chain[index]}-${step.id}`,
      source: chain[index]!,
      target: step.id,
      sourceHandle: 'out',
      targetHandle: 'in',
      type: 'insert',
      markerEnd: { type: MarkerType.ArrowClosed },
      data: {
        label:
          step.kind === 'agent' && step.forEachTask
            ? 'para cada tarefa'
            : step.kind === 'agent' && step.continueFromPrevious
              ? 'mesma cópia'
              : step.kind === 'agent' && step.fromTaskPullRequest
                ? 'PR da tarefa'
                : null,
        onInsert: () => onInsert(index),
      },
    }));
    const failures = steps.flatMap<FailureEdge>((step, index) =>
      step.kind === 'agent' && step.onFailure
        ? [
            {
              id: `fail-${step.id}`,
              source: step.id,
              target: step.onFailure.retryStepId,
              sourceHandle: 'fail',
              targetHandle: 'retry',
              type: 'failure',
              markerEnd: { type: MarkerType.ArrowClosed, color: '#f59e0b' },
              data: { label: `falhou · até ${step.onFailure.maxAttempts}×`, depth: 50 + (index % 3) * 26 },
            },
          ]
        : [],
    );
    const tail: Edge = {
      id: 'tail',
      source: chain[chain.length - 1]!,
      target: 'add',
      sourceHandle: 'out',
      targetHandle: 'in',
      style: { strokeDasharray: '4 4' },
    };
    return [...sequence, ...failures, tail];
  }, [steps, onInsert]);

  const handleNodesChange = (changes: NodeChange<CanvasNode>[]) => {
    const removed = changes.flatMap((change) => (change.type === 'remove' && change.id !== 'trigger' && change.id !== 'add' ? [change.id] : []));
    if (removed.length) onRemove(removed);
    setNodes((current) => applyNodeChanges(changes.filter((change) => change.type !== 'remove'), current));
  };

  return (
    <div className="workflow-canvas h-full min-h-[420px] w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onNodeClick={(_, node) => node.id !== 'add' && onSelect(node.id)}
        onNodeDragStop={() => {
          const ordered = nodes
            .filter((node): node is StepNode => node.type === 'step')
            .sort((a, b) => a.position.x - b.position.x)
            .map((node) => node.id);
          if (ordered.join() !== steps.map((step) => step.id).join()) onReorder(ordered);
          else setNodes(layout);
        }}
        nodesConnectable={false}
        deleteKeyCode={['Delete', 'Backspace']}
        onInit={(instance) => requestAnimationFrame(() => void instance.fitView({ padding: 0.2, maxZoom: 1 }))}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

// ---------------------------------------------------------------- nodes

const handleClass = '!h-2 !w-2 !border-0 !bg-muted';

function TriggerNodeView({ data }: NodeProps<TriggerNode>) {
  return (
    <div className={`w-56 rounded-xl border bg-panel px-3 py-2.5 shadow-sm ${data.selected ? 'border-accent ring-2 ring-accent/40' : 'border-border'}`}>
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-400/15 text-amber-300" aria-hidden>
          ⚡
        </span>
        <div className="min-w-0">
          <p className="text-[10px] font-medium tracking-wider text-muted uppercase">Gatilho</p>
          <p className="truncate text-sm font-semibold">{data.title}</p>
        </div>
      </div>
      <p className="mt-1.5 truncate text-xs text-muted" title={data.detail}>
        {data.detail}
      </p>
      <Handle id="out" type="source" position={Position.Right} className={handleClass} />
    </div>
  );
}

function StepNodeView({ data }: NodeProps<StepNode>) {
  const { step } = data;
  const isAgent = step.kind === 'agent';
  return (
    <div
      // A steady purple ring marks a working step (the animated border of the rest of the Studio is not used in the canvas).
      className={`w-56 rounded-xl border bg-panel px-3 py-2.5 shadow-sm ${
        data.selected ? 'border-accent ring-2 ring-accent/40' : data.running ? 'border-purple-400/60 ring-2 ring-purple-500/30' : 'border-border'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-semibold ${
            isAgent ? 'bg-accent/15 text-accent' : 'bg-emerald-400/15 text-emerald-300'
          }`}
          aria-hidden
        >
          {isAgent ? data.index + 1 : '⇪'}
        </span>
        <div className="min-w-0">
          <p className="text-[10px] font-medium tracking-wider text-muted uppercase">{isAgent ? 'Agente' : 'Deploy'}</p>
          <p className="truncate text-sm font-semibold" title={data.title}>
            {data.title}
          </p>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-muted">
        {isAgent ? <span className="truncate">{data.agentName}</span> : <span>{environmentLabels[step.environment]}</span>}
        {data.model && <span className="rounded border border-border px-1">{data.model}</span>}
        {data.running && (
          <span className="flex items-center gap-1 text-purple-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-purple-400" aria-hidden />
            trabalhando
          </span>
        )}
      </div>
      <Handle id="in" type="target" position={Position.Left} className={handleClass} />
      <Handle id="out" type="source" position={Position.Right} className={handleClass} />
      {/* Anchors of the "on failure, send back" arrows; invisible, the arrow shows them. */}
      <Handle id="fail" type="source" position={Position.Bottom} style={{ left: '70%' }} className="!opacity-0" />
      <Handle id="retry" type="target" position={Position.Bottom} style={{ left: '30%' }} className="!opacity-0" />
    </div>
  );
}

function AddNodeView({ data }: NodeProps<AddNode>) {
  return (
    <button
      type="button"
      onClick={data.onAdd}
      className="nodrag flex h-10 w-10 items-center justify-center rounded-full border border-dashed border-muted text-lg text-muted hover:border-accent hover:text-accent"
      title="Adicionar passo no fim"
    >
      +
      <Handle id="in" type="target" position={Position.Left} className="!opacity-0" />
    </button>
  );
}

const nodeTypes = { trigger: TriggerNodeView, step: StepNodeView, add: AddNodeView };

// ---------------------------------------------------------------- edges

function InsertEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<InsertEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan absolute flex flex-col items-center gap-1"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all' }}
        >
          {data?.label && <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-muted">{data.label}</span>}
          <button
            type="button"
            onClick={data?.onInsert}
            className="flex h-5 w-5 items-center justify-center rounded-full border border-border bg-panel text-xs text-muted hover:border-accent hover:text-accent"
            title="Inserir passo aqui"
          >
            +
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

function FailureEdgeView({ id, sourceX, sourceY, targetX, targetY, markerEnd, data }: EdgeProps<FailureEdge>) {
  const depth = data?.depth ?? 50;
  const [path, labelX] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition: Position.Bottom,
    targetX,
    targetY,
    targetPosition: Position.Bottom,
    offset: depth,
    borderRadius: 10,
  });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke: '#f59e0b', strokeDasharray: '6 4', opacity: 0.8 }} />
      <EdgeLabelRenderer>
        <span
          className="absolute rounded bg-surface px-1.5 py-0.5 text-[10px] text-amber-300"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${Math.max(sourceY, targetY) + depth}px)` }}
        >
          {data?.label}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes = { insert: InsertEdgeView, failure: FailureEdgeView };
