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
  type NodeProps,
  Position,
  ReactFlow,
  getBezierPath,
  getSmoothStepPath,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';
import type { AgentProfile } from '../../api/agentProfiles';
import type { Board } from '../../api/boards';
import type { Workflow } from '../../api/workflows';
import { buildProcessGraph } from './processModel';

const COLUMN_GAP = 300;
const ROW_GAP = 150;
const WORKFLOW_WIDTH = 240;
const BOARD_WIDTH = 176;

type WorkflowNode = Node<{ workflow: Workflow; profiles: AgentProfile[]; onOpen: (workflow: Workflow) => void }, 'workflow'>;
type ColumnNode = Node<{ name: string; color: string | null; tasks: number }, 'column'>;
type FlowEdge = Edge<{ label: string | null; back: boolean }, 'flow'>;

const triggerLabels: Record<Workflow['trigger']['type'], string> = {
  manual: 'Começa com uma mensagem sua',
  board_task: 'Pega tarefas do quadro',
  task_awaiting_decision: 'Pega tarefas aguardando decisão',
  feature_in_homologation: 'Pega funcionalidades em homologação',
};

interface ProcessCanvasProps {
  workflows: Workflow[];
  profiles: AgentProfile[];
  board: Board | null;
  onOpenWorkflow: (workflow: Workflow) => void;
}

/** The whole process at a glance: its workflows and the board columns that hand work from one to the next. */
export function ProcessCanvas({ workflows, profiles, board, onOpenWorkflow }: ProcessCanvasProps) {
  const { nodes, edges } = useMemo(() => {
    const graph = buildProcessGraph(workflows, profiles, board);
    const nodes = graph.nodes.map<WorkflowNode | ColumnNode>((node) => {
      const count = graph.rows.get(node.rank) ?? 1;
      const y = (node.row - (count - 1) / 2) * ROW_GAP;
      const x = node.rank * COLUMN_GAP;
      return node.data.kind === 'workflow'
        ? { id: node.id, type: 'workflow', position: { x, y }, data: { workflow: node.data.workflow, profiles, onOpen: onOpenWorkflow } }
        : { id: node.id, type: 'column', position: { x: x + (WORKFLOW_WIDTH - BOARD_WIDTH) / 2, y: y + 22 }, data: node.data };
    });
    const edges = graph.edges.map<FlowEdge>((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.back ? 'back-out' : 'out',
      targetHandle: edge.back ? 'back-in' : 'in',
      type: 'flow',
      markerEnd: { type: MarkerType.ArrowClosed, color: edge.back ? '#f59e0b' : undefined },
      data: { label: edge.label, back: edge.back },
    }));
    return { nodes, edges };
  }, [workflows, profiles, board, onOpenWorkflow]);

  return (
    <div className="workflow-canvas h-[460px] w-full rounded-lg border border-border">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesConnectable={false}
        elementsSelectable={false}
        onInit={(instance) => requestAnimationFrame(() => void instance.fitView({ padding: 0.15, maxZoom: 1 }))}
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
const hiddenHandle = '!opacity-0';

function Handles() {
  return (
    <>
      <Handle id="in" type="target" position={Position.Left} className={handleClass} />
      <Handle id="out" type="source" position={Position.Right} className={handleClass} />
      {/* Anchors of the arrows that send work back to an earlier column. */}
      <Handle id="back-out" type="source" position={Position.Bottom} style={{ left: '70%' }} className={hiddenHandle} />
      <Handle id="back-in" type="target" position={Position.Bottom} style={{ left: '30%' }} className={hiddenHandle} />
    </>
  );
}

function WorkflowNodeView({ data }: NodeProps<WorkflowNode>) {
  const { workflow } = data;
  const running = workflow.runningRuns > 0;
  const boardTriggered = workflow.trigger.type !== 'manual';
  return (
    <button
      type="button"
      onClick={() => data.onOpen(workflow)}
      title="Abrir o workflow"
      style={{ width: WORKFLOW_WIDTH }}
      // A steady purple ring marks a working workflow, as in the workflow canvas.
      className={`nodrag rounded-xl border bg-panel px-3 py-2.5 text-left shadow-sm hover:border-accent/60 ${
        running ? 'border-purple-400/60 ring-2 ring-purple-500/30' : 'border-border'
      } ${workflow.isEnabled ? '' : 'opacity-60'}`}
    >
      <p className="text-[10px] font-medium tracking-wider text-muted uppercase">Workflow{workflow.isEnabled ? '' : ' · desativado'}</p>
      <p className="truncate text-sm font-semibold" title={workflow.name}>
        {workflow.name}
      </p>
      <p className="mt-0.5 truncate text-[11px] text-muted">{triggerLabels[workflow.trigger.type]}</p>
      <p className="mt-1.5 truncate text-[11px] text-gray-300" title={workflow.steps.map((step) => step.name).join(' → ')}>
        {workflow.steps.map((step) => step.name).join(' → ')}
      </p>
      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] whitespace-nowrap text-muted">
        {running ? (
          <span className="flex items-center gap-1 text-purple-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-purple-400" aria-hidden />
            {workflow.runningRuns} em andamento
          </span>
        ) : (
          <span>parado</span>
        )}
        {boardTriggered && <span title="Execuções ao mesmo tempo">· máx. {workflow.maxConcurrentRuns}</span>}
      </div>
      <Handles />
    </button>
  );
}

function ColumnNodeView({ data }: NodeProps<ColumnNode>) {
  return (
    <div style={{ width: BOARD_WIDTH }} className="rounded-full border border-dashed border-border bg-surface px-3 py-1.5 text-center">
      <p className="text-[10px] font-medium tracking-wider text-muted uppercase">Quadro</p>
      <p className="flex items-center justify-center gap-1.5 truncate text-xs font-medium">
        {data.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: data.color }} aria-hidden />}
        {data.name}
      </p>
      <p className="text-[10px] text-muted">{data.tasks === 1 ? '1 tarefa' : `${data.tasks} tarefas`}</p>
      <Handles />
    </div>
  );
}

const nodeTypes = { workflow: WorkflowNodeView, column: ColumnNodeView };

// ---------------------------------------------------------------- edges

function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<FlowEdge>) {
  const back = data?.back ?? false;
  const [path, labelX, labelY] = back
    ? getSmoothStepPath({ sourceX, sourceY, sourcePosition: Position.Bottom, targetX, targetY, targetPosition: Position.Bottom, offset: 40, borderRadius: 10 })
    : getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={back ? { stroke: '#f59e0b', strokeDasharray: '6 4', opacity: 0.8 } : undefined} />
      {data?.label && (
        <EdgeLabelRenderer>
          <span
            className={`absolute rounded bg-surface px-1.5 py-0.5 text-[10px] ${back ? 'text-amber-300' : 'text-muted'}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${back ? Math.max(sourceY, targetY) + 40 : labelY}px)` }}
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { flow: FlowEdgeView };
