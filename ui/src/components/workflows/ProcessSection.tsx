import { type FormEvent, type ReactNode, useState } from 'react';
import type { AgentProfile } from '../../api/agentProfiles';
import type { Board } from '../../api/boards';
import { type ProcessInput, type WorkflowProcess, useDeleteProcess } from '../../api/processes';
import type { Workflow } from '../../api/workflows';
import { Button } from '../Button';
import { ErrorText, Field, TextInput } from '../form';
import { ProcessCanvas } from './ProcessCanvas';

/** A process: its canvas (or the workflow cards) and its actions. */
export function ProcessSection({
  process,
  workflows,
  profiles,
  board,
  onEdit,
  onOpenWorkflow,
  renderCards,
}: {
  process: WorkflowProcess;
  workflows: Workflow[];
  profiles: AgentProfile[];
  board: Board | null;
  onEdit: () => void;
  onOpenWorkflow: (workflow: Workflow) => void;
  renderCards: (workflows: Workflow[]) => ReactNode;
}) {
  const [view, setView] = useState<'canvas' | 'cards'>('canvas');
  const remove = useDeleteProcess(process.workspaceId);
  const running = workflows.reduce((sum, workflow) => sum + workflow.runningRuns, 0);

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-wider text-accent uppercase">Processo</p>
          <h2 className="text-base font-semibold">{process.name}</h2>
          {process.description && <p className="mt-0.5 max-w-3xl text-xs text-muted">{process.description}</p>}
          <p className="mt-1 text-[11px] text-muted">
            {workflows.length === 1 ? '1 workflow' : `${workflows.length} workflows`} · {running > 0 ? `${running} execução(ões) em andamento` : 'nada em andamento'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="flex rounded-md border border-border text-xs" role="group" aria-label="Visualização">
            {(['canvas', 'cards'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setView(option)}
                aria-pressed={view === option}
                className={`px-2.5 py-1 ${view === option ? 'bg-border text-white' : 'text-muted hover:text-white'}`}
              >
                {option === 'canvas' ? 'Canvas' : 'Cartões'}
              </button>
            ))}
          </div>
          <Button size="sm" onClick={onEdit}>
            Editar
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => window.confirm(`Excluir o processo "${process.name}"? Os workflows continuam, fora de qualquer processo.`) && remove.mutate(process.id)}
            disabled={remove.isPending}
          >
            Excluir
          </Button>
        </div>
      </div>
      {workflows.length === 0 ? (
        <p className="text-sm text-muted">Nenhum workflow neste processo. Use Editar para escolher os workflows.</p>
      ) : view === 'canvas' ? (
        <>
          <ProcessCanvas workflows={workflows} profiles={profiles} board={board} onOpenWorkflow={onOpenWorkflow} />
          <p className="text-[11px] text-muted">
            Os workflows passam o trabalho um para o outro pelo quadro. Clique num workflow para abrir e editar; as setas tracejadas devolvem tarefas a uma
            coluna anterior.
          </p>
        </>
      ) : (
        renderCards(workflows)
      )}
      <ErrorText error={remove.error} />
    </section>
  );
}

/** Name, goal and the workflows of a process; a workflow belongs to one process at a time. */
export function ProcessForm({
  initial,
  workflows,
  processes,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial?: WorkflowProcess;
  workflows: Workflow[];
  processes: WorkflowProcess[];
  pending: boolean;
  error: Error | null;
  onSubmit: (input: ProcessInput) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [selected, setSelected] = useState<string[]>(initial?.workflowIds ?? []);
  const otherProcess = (workflow: Workflow) =>
    workflow.processId && workflow.processId !== initial?.id ? processes.find((process) => process.id === workflow.processId)?.name : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({ name: name.trim(), description: description.trim(), workflowIds: selected });
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-accent/40 bg-panel p-4">
      <h2 className="text-sm font-semibold">{initial ? `Editar processo "${initial.name}"` : 'Novo processo'}</h2>
      <p className="max-w-3xl text-xs text-muted">
        Um processo junta os workflows que, juntos, cumprem um objetivo (ex.: Criação de jogo). Ele só organiza e mostra tudo num canvas: cada workflow
        continua com o próprio gatilho.
      </p>
      <Field label="Nome">
        <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Criação de jogo" maxLength={100} required />
      </Field>
      <Field label="Objetivo">
        <TextInput
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Ex.: da ideia ao jogo pronto: documento, arte, código e decisões"
          maxLength={2000}
        />
      </Field>
      <fieldset className="space-y-1">
        <legend className="mb-1 text-xs font-medium text-gray-300">Workflows</legend>
        {workflows.length === 0 && <p className="text-xs text-muted">Nenhum workflow neste workspace.</p>}
        {workflows.map((workflow) => {
          const elsewhere = otherProcess(workflow);
          return (
            <label key={workflow.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(workflow.id)}
                onChange={(event) =>
                  setSelected((current) => (event.target.checked ? [...current, workflow.id] : current.filter((id) => id !== workflow.id)))
                }
              />
              {workflow.name}
              {elsewhere && <span className="text-xs text-muted">{selected.includes(workflow.id) ? `(sai de "${elsewhere}")` : `(em "${elsewhere}")`}</span>}
            </label>
          );
        })}
      </fieldset>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending || !name.trim()}>
          {pending ? 'Salvando...' : 'Salvar'}
        </Button>
        <Button onClick={onCancel}>Cancelar</Button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}
