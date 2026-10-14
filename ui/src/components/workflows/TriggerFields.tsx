import type { Board } from '../../api/boards';
import type { WorkflowTrigger } from '../../api/workflows';
import { MultiSelect } from '../MultiSelect';
import { Field, Select } from '../form';
import { boardTrigger, decisionTrigger, featureTrigger, frontendTrigger } from './workflowModel';

interface TriggerFieldsProps {
  trigger: WorkflowTrigger;
  board: Board | null;
  maxConcurrentRuns: number;
  onChange: (trigger: WorkflowTrigger) => void;
  onMaxConcurrentRunsChange: (count: number) => void;
}

export function TriggerFields({ trigger, board, maxConcurrentRuns, onChange, onMaxConcurrentRunsChange }: TriggerFieldsProps) {
  const repositories =
    board && board.repositories.length > 1 && trigger.type !== 'manual' ? (
      <Field label="Repositório">
        <MultiSelect
          options={board.repositories.map((repo) => ({ value: repo.path, label: repo.projectName }))}
          placeholder="Qualquer"
          selected={trigger.repositories}
          onChange={(next) => onChange({ ...trigger, repositories: next })}
        />
      </Field>
    ) : null;

  return (
    <div className="space-y-3">
      <Field label="Começa quando">
        <Select
          value={trigger.type}
          onChange={(event) =>
            onChange(
              event.target.value === 'manual'
                ? { type: 'manual' }
                : event.target.value === 'board_task'
                  ? boardTrigger
                  : event.target.value === 'task_awaiting_decision'
                    ? decisionTrigger
                    : event.target.value === 'frontend_in_homologation'
                      ? frontendTrigger
                      : featureTrigger,
            )
          }
        >
          <option value="manual">Você inicia com uma mensagem</option>
          <option value="board_task" disabled={!board}>
            Aparece uma tarefa no quadro{board ? '' : ' (vincule um quadro)'}
          </option>
          <option value="feature_in_homologation" disabled={!board}>
            Uma funcionalidade inteira chega em homologação{board ? '' : ' (vincule um quadro)'}
          </option>
          <option value="frontend_in_homologation" disabled={!board}>
            Uma tarefa de frontend chega em homologação com o backend dela{board ? '' : ' (vincule um quadro)'}
          </option>
          <option value="task_awaiting_decision" disabled={!board}>
            Uma tarefa fica aguardando decisão{board ? '' : ' (vincule um quadro)'}
          </option>
        </Select>
      </Field>

      {trigger.type === 'feature_in_homologation' && board && (
        <>
          <p className="text-xs text-muted">
            Junta as tarefas pelo código no título (ex.: "[FUNC-012] ..."). Quando todas as abertas estão na coluna de homologação, o primeiro
            passo recebe todas elas.
          </p>
          {repositories}
        </>
      )}

      {trigger.type === 'frontend_in_homologation' && board && (
        <>
          <p className="text-xs text-muted">
            Cada tarefa de frontend (dos repositórios escolhidos) na coluna de homologação cujas tarefas de "Depende de:" estão em
            homologação ou concluídas. O agente testa a tela com o backend que ela usa; aprovada, a tarefa vai para "Concluído" e o
            backend também, quando nenhuma outra tela que o usa falta testar. O mesmo agente segue de uma tarefa para a próxima.
          </p>
          {repositories}
        </>
      )}

      {trigger.type === 'task_awaiting_decision' && board && (
        <>
          <p className="text-xs text-muted">
            Cada tarefa em "Aguardando aprovação" que espera uma decisão (as com "Depende de:" ficam de fora: o Studio as libera sozinho).
            O agente estuda a tarefa, decide com você e move o card; o workflow não move nada. Uma tarefa só é estudada de novo depois
            de alterada.
          </p>
          {repositories}
        </>
      )}

      {trigger.type === 'board_task' && board && (
        <>
          <Field label="Coluna vigiada">
            <Select value={trigger.columnId ?? ''} onChange={(event) => onChange({ ...trigger, columnId: event.target.value || null })}>
              <option value="">Coluna "A fazer" do quadro</option>
              {board.columns.map((column) => (
                <option key={column.id} value={column.id}>
                  {column.name}
                </option>
              ))}
            </Select>
          </Field>
          {board.fields.map((field) => (
            <Field key={field.id} label={field.name}>
              <MultiSelect
                options={field.options.map((option) => ({ value: option.id, label: option.name, color: option.color }))}
                placeholder="Qualquer"
                selected={trigger.fieldFilters[field.id] ?? []}
                onChange={(next) => onChange({ ...trigger, fieldFilters: { ...trigger.fieldFilters, [field.id]: next } })}
              />
            </Field>
          ))}
          {repositories}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={trigger.onlyUnassigned} onChange={(event) => onChange({ ...trigger, onlyUnassigned: event.target.checked })} />
            Só tarefas sem responsável
          </label>
          <Field label="Ao terminar, a tarefa vai para">
            <Select value={trigger.moveWhenDone} onChange={(event) => onChange({ ...trigger, moveWhenDone: event.target.value as 'done' | 'homologation' })}>
              <option value="done">Concluído</option>
              <option value="homologation">Em homologação</option>
            </Select>
          </Field>
          <Field label="Execuções ao mesmo tempo">
            <Select value={maxConcurrentRuns} onChange={(event) => onMaxConcurrentRunsChange(Number(event.target.value))}>
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
  );
}
