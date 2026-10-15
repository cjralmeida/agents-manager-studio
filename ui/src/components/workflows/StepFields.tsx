import type { AgentProfile } from '../../api/agentProfiles';
import { type DeployEnvironment, environmentLabels } from '../../api/render';
import type { AgentStep, WorkflowStep } from '../../api/workflows';
import { Field, Select, TextInput } from '../form';
import { agentStep, stepLabel } from './workflowModel';

interface StepFieldsProps {
  step: WorkflowStep;
  index: number;
  steps: WorkflowStep[];
  profiles: AgentProfile[];
  onChange: (step: WorkflowStep) => void;
}

export function StepFields({ step, index, steps, profiles, onChange }: StepFieldsProps) {
  const earlierAgents = steps.slice(0, index).filter((entry): entry is AgentStep => entry.kind === 'agent');
  const patch = (changes: Partial<AgentStep> | Partial<WorkflowStep>) => onChange({ ...step, ...changes } as WorkflowStep);

  return (
    <div className="space-y-3">
      <Field label="Tipo">
        <Select
          value={step.kind}
          onChange={(event) =>
            onChange(
              event.target.value === 'deploy'
                ? { id: step.id, name: step.name, kind: 'deploy', agents: 1, environment: 'HOMOLOGACAO' }
                : { ...agentStep(profiles[0]?.id ?? ''), id: step.id, name: step.name },
            )
          }
        >
          <option value="agent">Agente</option>
          <option value="deploy">Deploy (Render)</option>
        </Select>
      </Field>

      {step.kind === 'agent' ? (
        <Field label="Agente">
          <Select value={step.profileId} onChange={(event) => patch({ profileId: event.target.value })}>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <Field label="Ambiente">
          <Select value={step.environment} onChange={(event) => patch({ environment: event.target.value as DeployEnvironment })}>
            {(Object.keys(environmentLabels) as DeployEnvironment[]).map((environment) => (
              <option key={environment} value={environment}>
                {environmentLabels[environment]}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field label="Nome do passo">
        <TextInput value={step.name} onChange={(event) => patch({ name: event.target.value })} placeholder="Usa o nome do agente" />
      </Field>

      <Field
        label="Agentes nesta etapa"
        hint={
          step.kind === 'deploy'
            ? 'Quantos deploys ao mesmo tempo. Um HOM só aguenta 1.'
            : 'Quantos agentes trabalham nesta etapa ao mesmo tempo. Quando um termina, pega a próxima tarefa que espera aqui.'
        }
      >
        <Select value={step.agents} onChange={(event) => patch({ agents: Number(event.target.value) })}>
          {[1, 2, 3, 4, 5].map((count) => (
            <option key={count} value={count}>
              {count === 1 ? '1 agente' : `${count} agentes`}
            </option>
          ))}
        </Select>
      </Field>

      {step.kind === 'agent' && (
        <>
          <div className="space-y-2 text-sm">
            <label className="flex items-start gap-2" title="Uma execução deste passo para cada tarefa que o passo anterior criou no quadro">
              <input
                type="checkbox"
                className="mt-1"
                checked={step.forEachTask}
                onChange={(event) => patch({ forEachTask: event.target.checked })}
                disabled={index === 0}
              />
              Para cada tarefa criada pelo passo anterior
            </label>
            {step.forEachTask && (
              <Select className="py-0.5" value={step.maxParallel} onChange={(event) => patch({ maxParallel: Number(event.target.value) })}>
                {[1, 2, 3, 4, 5].map((count) => (
                  <option key={count} value={count}>
                    {count === 1 ? '1 por vez (recomendado)' : `${count} ao mesmo tempo`}
                  </option>
                ))}
              </Select>
            )}
            <label className="flex items-start gap-2" title="Começa da cópia e da branch do agente anterior (ex.: testar o que o executor fez)">
              <input
                type="checkbox"
                className="mt-1"
                checked={step.continueFromPrevious}
                onChange={(event) => patch({ continueFromPrevious: event.target.checked, ...(event.target.checked && { fromTaskPullRequest: false }) })}
                disabled={index === 0}
              />
              Continuar do trabalho do passo anterior
            </label>
            <label className="flex items-start gap-2" title="Começa do PR/MR aberto que cita a tarefa (feito fora do Studio)">
              <input
                type="checkbox"
                className="mt-1"
                checked={step.fromTaskPullRequest}
                onChange={(event) => patch({ fromTaskPullRequest: event.target.checked, ...(event.target.checked && { continueFromPrevious: false }) })}
              />
              Publicar o PR/MR da tarefa (feito fora do Studio)
            </label>
          </div>

          <Field label="Modelo">
            <Select value={step.model ?? ''} onChange={(event) => patch({ model: (event.target.value || null) as AgentStep['model'] })}>
              <option value="">O do agente</option>
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
              <option value="haiku">Haiku</option>
            </Select>
          </Field>

          <Field label="Se falhar">
            <Select
              value={step.onFailure?.retryStepId ?? ''}
              onChange={(event) =>
                patch({ onFailure: event.target.value ? { retryStepId: event.target.value, maxAttempts: step.onFailure?.maxAttempts ?? 2 } : null })
              }
            >
              <option value="">O workflow para</option>
              {earlierAgents.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  Devolver para "{stepLabel(entry, profiles)}"
                </option>
              ))}
            </Select>
          </Field>
          {step.onFailure && (
            <Select value={step.onFailure.maxAttempts} onChange={(event) => patch({ onFailure: { ...step.onFailure!, maxAttempts: Number(event.target.value) } })}>
              {[1, 2, 3, 4, 5].map((count) => (
                <option key={count} value={count}>
                  Até {count} tentativa(s)
                </option>
              ))}
            </Select>
          )}

          <Field label="Instruções extras">
            <textarea
              value={step.instructions}
              onChange={(event) => patch({ instructions: event.target.value })}
              rows={4}
              placeholder="Opcional: o que este passo deve fazer além do papel do agente"
              className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
            />
          </Field>
        </>
      )}
    </div>
  );
}
