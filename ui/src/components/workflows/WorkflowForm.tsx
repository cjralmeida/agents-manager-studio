import { type FormEvent, useState } from 'react';
import type { AgentProfile } from '../../api/agentProfiles';
import type { Board } from '../../api/boards';
import { type DeployEnvironment, environmentLabels } from '../../api/render';
import type { AgentStep, Workflow, WorkflowInput, WorkflowStep, WorkflowTrigger } from '../../api/workflows';
import { Button } from '../Button';
import { MultiSelect } from '../MultiSelect';
import { ErrorText, Field, Select, TextInput } from '../form';

const newId = () => Math.random().toString(36).slice(2, 8);

const agentStep = (profileId: string): AgentStep => ({
  id: newId(),
  name: '',
  kind: 'agent',
  profileId,
  forEachTask: false,
  maxParallel: 1,
  continueFromPrevious: false,
  instructions: '',
  onFailure: null,
});

const boardTrigger: Extract<WorkflowTrigger, { type: 'board_task' }> = {
  type: 'board_task',
  columnId: null,
  fieldFilters: {},
  repositories: [],
  onlyUnassigned: true,
};

interface WorkflowFormProps {
  profiles: AgentProfile[];
  board: Board | null;
  initial?: Workflow;
  pending: boolean;
  error: Error | null;
  onSubmit: (input: WorkflowInput) => void;
  onCancel: () => void;
}

export function WorkflowForm({ profiles, board, initial, pending, error, onSubmit, onCancel }: WorkflowFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [isEnabled, setIsEnabled] = useState(initial?.isEnabled ?? true);
  const [trigger, setTrigger] = useState<WorkflowTrigger>(initial?.trigger ?? { type: 'manual' });
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(initial?.maxConcurrentRuns ?? 1);
  const [steps, setSteps] = useState<WorkflowStep[]>(initial?.steps ?? (profiles[0] ? [agentStep(profiles[0].id)] : []));

  const updateStep = (index: number, patch: Partial<AgentStep> | Partial<WorkflowStep>) =>
    setSteps((current) => current.map((step, position) => (position === index ? ({ ...step, ...patch } as WorkflowStep) : step)));
  const move = (index: number, offset: number) =>
    setSteps((current) => {
      const next = [...current];
      const [step] = next.splice(index, 1);
      next.splice(index + offset, 0, step!);
      return next;
    });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    // Steps without a name take the name of their agent.
    const named = steps.map((step) =>
      step.name.trim()
        ? step
        : { ...step, name: step.kind === 'deploy' ? 'Deploy' : (profiles.find((profile) => profile.id === step.profileId)?.name ?? 'Passo') },
    );
    onSubmit({ name, description, isEnabled, trigger, steps: named, maxConcurrentRuns });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-border bg-panel p-4">
      <h3 className="text-sm font-medium">{initial ? `Editar "${initial.name}"` : 'Novo workflow'}</h3>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Nome">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Da documentação ao deploy" required />
        </Field>
        <div className="md:col-span-2">
          <Field label="Descrição">
            <TextInput value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
        </div>
      </div>

      <section className="rounded-md border border-border p-3">
        <h4 className="text-xs font-medium tracking-wider text-muted uppercase">Gatilho</h4>
        <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Começa quando">
            <Select
              value={trigger.type}
              onChange={(event) => setTrigger(event.target.value === 'manual' ? { type: 'manual' } : boardTrigger)}
            >
              <option value="manual">Você inicia com uma mensagem (conversa no Studio)</option>
              <option value="board_task" disabled={!board}>
                Aparece uma tarefa no quadro{board ? '' : ' (vincule um quadro)'}
              </option>
            </Select>
          </Field>
          {trigger.type === 'board_task' && board && (
            <>
              <Field label="Coluna vigiada">
                <Select value={trigger.columnId ?? ''} onChange={(event) => setTrigger({ ...trigger, columnId: event.target.value || null })}>
                  <option value="">Coluna "A fazer" do quadro</option>
                  {board.columns.map((column) => (
                    <option key={column.id} value={column.id}>
                      {column.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Execuções ao mesmo tempo">
                <Select value={maxConcurrentRuns} onChange={(event) => setMaxConcurrentRuns(Number(event.target.value))}>
                  {[1, 2, 3, 4, 5].map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
        </div>
        {trigger.type === 'board_task' && board && (
          <div className="mt-3 space-y-2">
            {board.fields.map((field) => (
              <div key={field.id} className="grid grid-cols-1 gap-1 md:grid-cols-[8rem_1fr] md:items-center">
                <span className="text-xs text-muted">{field.name}</span>
                <MultiSelect
                  options={field.options.map((option) => ({ value: option.id, label: option.name, color: option.color }))}
                  placeholder="Qualquer"
                  selected={trigger.fieldFilters[field.id] ?? []}
                  onChange={(next) => setTrigger({ ...trigger, fieldFilters: { ...trigger.fieldFilters, [field.id]: next } })}
                />
              </div>
            ))}
            {board.repositories.length > 1 && (
              <div className="grid grid-cols-1 gap-1 md:grid-cols-[8rem_1fr] md:items-center">
                <span className="text-xs text-muted">Repositório</span>
                <MultiSelect
                  options={board.repositories.map((repo) => ({ value: repo.path, label: repo.projectName }))}
                  placeholder="Qualquer"
                  selected={trigger.repositories}
                  onChange={(next) => setTrigger({ ...trigger, repositories: next })}
                />
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={trigger.onlyUnassigned}
                onChange={(event) => setTrigger({ ...trigger, onlyUnassigned: event.target.checked })}
              />
              Só tarefas sem responsável
            </label>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="text-xs font-medium tracking-wider text-muted uppercase">Passos</h4>
        {profiles.length === 0 && <p className="text-sm text-amber-300">Crie agentes na aba Agentes para usá-los nos passos.</p>}
        {steps.map((step, index) => (
          <StepEditor
            key={step.id}
            step={step}
            index={index}
            steps={steps}
            profiles={profiles}
            onChange={(patch) => updateStep(index, patch)}
            onKindChange={(kind) =>
              updateStep(index, kind === 'deploy' ? ({ id: step.id, name: step.name, kind: 'deploy', environment: 'HOMOLOGACAO' } as WorkflowStep) : agentStep(profiles[0]?.id ?? ''))
            }
            onMoveUp={index > 0 ? () => move(index, -1) : undefined}
            onMoveDown={index < steps.length - 1 ? () => move(index, 1) : undefined}
            onRemove={() => setSteps((current) => current.filter((_, position) => position !== index))}
          />
        ))}
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setSteps((current) => [...current, agentStep(profiles[0]?.id ?? '')])} disabled={profiles.length === 0}>
            + Passo com agente
          </Button>
          <Button size="sm" onClick={() => setSteps((current) => [...current, { id: newId(), name: 'Deploy em homologação', kind: 'deploy', environment: 'HOMOLOGACAO' }])}>
            + Deploy
          </Button>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isEnabled} onChange={(event) => setIsEnabled(event.target.checked)} />
          Ativo
        </label>
        <Button type="submit" variant="primary" disabled={pending || !name.trim() || steps.length === 0}>
          {pending ? 'Salvando...' : 'Salvar workflow'}
        </Button>
        <Button onClick={onCancel}>Cancelar</Button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

interface StepEditorProps {
  step: WorkflowStep;
  index: number;
  steps: WorkflowStep[];
  profiles: AgentProfile[];
  onChange: (patch: Partial<WorkflowStep>) => void;
  onKindChange: (kind: 'agent' | 'deploy') => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove: () => void;
}

function StepEditor({ step, index, steps, profiles, onChange, onKindChange, onMoveUp, onMoveDown, onRemove }: StepEditorProps) {
  const earlierAgents = steps.slice(0, index).filter((entry): entry is AgentStep => entry.kind === 'agent');

  return (
    <div className="rounded-md border border-border bg-surface/40 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <span className="pb-2 font-mono text-xs text-muted">{index + 1}</span>
        <div className="w-40">
          <Field label="Tipo">
            <Select value={step.kind} onChange={(event) => onKindChange(event.target.value as 'agent' | 'deploy')}>
              <option value="agent">Agente</option>
              <option value="deploy">Deploy (Render)</option>
            </Select>
          </Field>
        </div>
        {step.kind === 'agent' ? (
          <div className="w-52">
            <Field label="Agente">
              <Select value={step.profileId} onChange={(event) => onChange({ profileId: event.target.value })}>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : (
          <div className="w-44">
            <Field label="Ambiente">
              <Select value={step.environment} onChange={(event) => onChange({ environment: event.target.value as DeployEnvironment })}>
                {(Object.keys(environmentLabels) as DeployEnvironment[]).map((environment) => (
                  <option key={environment} value={environment}>
                    {environmentLabels[environment]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <div className="min-w-40 flex-1">
          <Field label="Nome do passo">
            <TextInput value={step.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="Usa o nome do agente" />
          </Field>
        </div>
        <div className="flex gap-1 pb-0.5">
          <Button size="sm" onClick={onMoveUp} disabled={!onMoveUp} title="Subir">
            ↑
          </Button>
          <Button size="sm" onClick={onMoveDown} disabled={!onMoveDown} title="Descer">
            ↓
          </Button>
          <Button size="sm" variant="danger" onClick={onRemove}>
            Remover
          </Button>
        </div>
      </div>

      {step.kind === 'agent' && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <label className="flex items-center gap-2" title="Uma execução deste passo para cada tarefa que o passo anterior criou no quadro">
              <input type="checkbox" checked={step.forEachTask} onChange={(event) => onChange({ forEachTask: event.target.checked })} disabled={index === 0} />
              Para cada tarefa criada pelo passo anterior
            </label>
            {step.forEachTask && (
              <label className="flex items-center gap-2">
                <Select className="w-auto py-0.5" value={step.maxParallel} onChange={(event) => onChange({ maxParallel: Number(event.target.value) })}>
                  {[1, 2, 3, 4, 5].map((count) => (
                    <option key={count} value={count}>
                      {count === 1 ? '1 por vez (recomendado)' : `${count} ao mesmo tempo`}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <label className="flex items-center gap-2" title="Começa da cópia e da branch do agente anterior (ex.: testar o que o executor fez)">
              <input
                type="checkbox"
                checked={step.continueFromPrevious}
                onChange={(event) => onChange({ continueFromPrevious: event.target.checked })}
                disabled={index === 0}
              />
              Continuar do trabalho do passo anterior
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Se falhar:</span>
            <Select
              className="w-auto py-0.5"
              value={step.onFailure?.retryStepId ?? ''}
              onChange={(event) =>
                onChange({ onFailure: event.target.value ? { retryStepId: event.target.value, maxAttempts: step.onFailure?.maxAttempts ?? 2 } : null })
              }
            >
              <option value="">o workflow para nesta tarefa</option>
              {earlierAgents.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  devolver para "{entry.name || profiles.find((profile) => profile.id === entry.profileId)?.name}"
                </option>
              ))}
            </Select>
            {step.onFailure && (
              <Select
                className="w-auto py-0.5"
                value={step.onFailure.maxAttempts}
                onChange={(event) => onChange({ onFailure: { ...step.onFailure!, maxAttempts: Number(event.target.value) } })}
              >
                {[1, 2, 3, 4, 5].map((count) => (
                  <option key={count} value={count}>
                    até {count} tentativa(s)
                  </option>
                ))}
              </Select>
            )}
          </div>
          <textarea
            value={step.instructions}
            onChange={(event) => onChange({ instructions: event.target.value })}
            rows={2}
            placeholder="Instruções extras para este passo (opcional)"
            className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
          />
        </div>
      )}
    </div>
  );
}
