import { type FormEvent, useCallback, useState } from 'react';
import type { AgentProfile } from '../../api/agentProfiles';
import type { Board } from '../../api/boards';
import type { Workflow, WorkflowInput, WorkflowStep, WorkflowTrigger } from '../../api/workflows';
import { Button } from '../Button';
import { ErrorText, TextInput } from '../form';
import { StepFields } from './StepFields';
import { TriggerFields } from './TriggerFields';
import { WorkflowCanvas } from './WorkflowCanvas';
import { agentStep, deployStep, normalizeSteps, stepLabel } from './workflowModel';

interface WorkflowEditorProps {
  profiles: AgentProfile[];
  board: Board | null;
  initial?: Workflow;
  /** Ids of the steps running right now, comma separated (a string, so the canvas only redraws when it changes). */
  runningStepIds: string;
  pending: boolean;
  error: Error | null;
  onSubmit: (input: WorkflowInput) => void;
  onCancel: () => void;
}

/** Workflow editor as a node canvas: the trigger and the steps in a row; the selected node is edited on the side. */
export function WorkflowEditor({ profiles, board, initial, runningStepIds, pending, error, onSubmit, onCancel }: WorkflowEditorProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [isEnabled, setIsEnabled] = useState(initial?.isEnabled ?? true);
  const [trigger, setTrigger] = useState<WorkflowTrigger>(initial?.trigger ?? { type: 'manual' });
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(initial?.maxConcurrentRuns ?? 1);
  const [steps, setSteps] = useState<WorkflowStep[]>(initial?.steps ?? (profiles[0] ? [agentStep(profiles[0].id)] : []));
  const [selectedId, setSelectedId] = useState<string>(initial ? 'trigger' : (steps[0]?.id ?? 'trigger'));

  const update = (next: WorkflowStep[]) => setSteps(normalizeSteps(next));

  const insertAt = useCallback(
    (index: number) => {
      const step = profiles[0] ? agentStep(profiles[0].id) : deployStep();
      setSteps((current) => normalizeSteps([...current.slice(0, index), step, ...current.slice(index)]));
      setSelectedId(step.id);
    },
    [profiles],
  );
  const reorder = useCallback(
    (orderedIds: string[]) =>
      setSteps((current) => normalizeSteps(orderedIds.map((id) => current.find((step) => step.id === id)!).filter(Boolean))),
    [],
  );
  const remove = useCallback(
    (ids: string[]) => {
      setSteps((current) => normalizeSteps(current.filter((step) => !ids.includes(step.id))));
      setSelectedId((current) => (ids.includes(current) ? 'trigger' : current));
    },
    [],
  );

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    // Steps without a name take the name of their agent.
    const named = steps.map((step) => ({ ...step, name: stepLabel(step, profiles) }));
    onSubmit({ name, description, isEnabled, trigger, steps: named, maxConcurrentRuns });
  };

  const selectedIndex = steps.findIndex((step) => step.id === selectedId);
  const selectedStep = steps[selectedIndex];

  return (
    <form onSubmit={handleSubmit} className="overflow-hidden rounded-lg border border-border bg-panel">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <TextInput
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Nome do workflow"
          required
          className="max-w-xs font-medium"
          aria-label="Nome do workflow"
        />
        <TextInput
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Descrição (opcional)"
          className="min-w-48 flex-1"
          aria-label="Descrição"
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isEnabled} onChange={(event) => setIsEnabled(event.target.checked)} />
          Ativo
        </label>
        <Button type="submit" variant="primary" disabled={pending || !name.trim() || steps.length === 0}>
          {pending ? 'Salvando...' : 'Salvar workflow'}
        </Button>
        <Button onClick={onCancel}>Cancelar</Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="h-[30rem] border-b border-border bg-surface lg:h-[36rem] lg:border-r lg:border-b-0">
          <WorkflowCanvas
            trigger={trigger}
            steps={steps}
            profiles={profiles}
            board={board}
            selectedId={selectedId}
            runningStepIds={runningStepIds}
            onSelect={setSelectedId}
            onInsert={insertAt}
            onReorder={reorder}
            onRemove={remove}
          />
        </div>

        <aside className="max-h-[36rem] space-y-4 overflow-y-auto p-4">
          {selectedStep ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">
                  Passo {selectedIndex + 1} · {stepLabel(selectedStep, profiles)}
                </h3>
                <Button size="sm" variant="danger" onClick={() => remove([selectedStep.id])}>
                  Remover
                </Button>
              </div>
              <StepFields
                step={selectedStep}
                index={selectedIndex}
                steps={steps}
                profiles={profiles}
                onChange={(changed) => update(steps.map((step) => (step.id === changed.id ? changed : step)))}
              />
            </>
          ) : (
            <>
              <h3 className="text-sm font-semibold">Gatilho</h3>
              <TriggerFields
                trigger={trigger}
                board={board}
                maxConcurrentRuns={maxConcurrentRuns}
                onChange={setTrigger}
                onMaxConcurrentRunsChange={setMaxConcurrentRuns}
              />
            </>
          )}
          {profiles.length === 0 && <p className="text-sm text-amber-300">Crie agentes na aba Agentes para usá-los nos passos.</p>}
          <p className="border-t border-border pt-3 text-xs text-muted">
            Clique num nó para editar. O + numa conexão insere um passo ali; arraste um nó para mudar a ordem; Delete remove o nó
            selecionado.
          </p>
          <ErrorText error={error} />
        </aside>
      </div>
    </form>
  );
}
