import { Link } from 'react-router';
import { type StepRun, type WorkflowRun, useCancelRun } from '../../api/workflows';
import { timeAgo } from '../../lib/time';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText } from '../form';

type Tone = Parameters<typeof Badge>[0]['tone'];

const runStatus: Record<WorkflowRun['status'], { label: string; tone: Tone }> = {
  RUNNING: { label: 'Em andamento', tone: 'info' },
  COMPLETED: { label: 'Concluído', tone: 'success' },
  FAILED: { label: 'Falhou', tone: 'danger' },
  CANCELLED: { label: 'Cancelado', tone: 'neutral' },
};

function cellTone(step: StepRun): string {
  if (step.agentStatus === 'WAITING_INPUT') return 'glow-question border-amber-400/70 bg-amber-400/10 text-amber-200';
  switch (step.status) {
    case 'SUCCEEDED':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200';
    case 'FAILED':
      return 'border-red-500/40 bg-red-500/10 text-red-200';
    case 'RUNNING':
      return 'border-accent/50 bg-accent/10 text-accent';
    default:
      return 'border-border text-muted';
  }
}

function cellLabel(step: StepRun) {
  if (step.agentStatus === 'WAITING_INPUT') return 'Pergunta';
  if (step.status === 'RUNNING') return step.deploymentId ? 'Publicando' : 'Trabalhando';
  return { SUCCEEDED: 'Ok', FAILED: 'Falhou', RETRIED: 'Devolvido', CANCELLED: 'Cancelado' }[step.status];
}

/** One run: a row per lane (the main flow, then one per created task) and a column per step. */
export function WorkflowRunCard({ workspaceId, run }: { workspaceId: string; run: WorkflowRun }) {
  const cancel = useCancelRun(workspaceId);
  const status = runStatus[run.status];

  const createdTasks = run.steps.flatMap((step) => step.output?.createdTasks ?? []);
  const lanes = ['main', ...new Set(run.steps.map((step) => step.lane).filter((lane) => lane !== 'main'))];
  const laneLabel = (lane: string) => (lane === 'main' ? 'Fluxo' : (createdTasks.find((task) => task.id === lane)?.title ?? 'Tarefa'));
  const latest = (stepId: string, lane: string) =>
    run.steps.filter((step) => step.stepId === stepId && step.lane === lane).sort((a, b) => b.attempt - a.attempt)[0];
  const errors = run.steps.filter((step) => step.status === 'FAILED' && step.error && latest(step.stepId, step.lane)?.id === step.id);

  return (
    <article className={`rounded-lg border bg-panel p-4 ${run.status === 'RUNNING' ? 'glow-working' : 'border-border'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{run.title}</h3>
          <p className="mt-0.5 text-xs text-muted">
            {run.workflowName} · iniciado {timeAgo(run.startedAt)}
            {run.finishedAt && ` · terminou ${timeAgo(run.finishedAt)}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          {run.status === 'RUNNING' && (
            <Button
              size="sm"
              variant="danger"
              onClick={() => window.confirm('Cancelar esta execução e os agentes em andamento?') && cancel.mutate(run.id)}
              disabled={cancel.isPending}
            >
              Cancelar
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-separate border-spacing-1 text-xs">
          <thead>
            <tr>
              <th className="w-48 text-left font-medium text-muted" />
              {run.definition.map((step, index) => (
                <th key={step.id} className="text-left font-medium text-muted">
                  {index + 1}. {step.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lanes.map((lane) => (
              <tr key={lane}>
                <td className="max-w-48 truncate pr-2 text-muted" title={laneLabel(lane)}>
                  {laneLabel(lane)}
                </td>
                {run.definition.map((definition) => {
                  const step = latest(definition.id, lane);
                  if (!step) return <td key={definition.id} />;
                  const content = (
                    <span className={`flex items-center justify-between gap-1 rounded border px-2 py-1 ${cellTone(step)}`}>
                      <span>{cellLabel(step)}</span>
                      {step.attempt > 1 && <span title="Tentativas">×{step.attempt}</span>}
                    </span>
                  );
                  return (
                    <td key={definition.id} className="min-w-28" title={step.error ?? step.output?.summary ?? undefined}>
                      {step.agentId ? (
                        <Link to={`/agents/${step.agentId}`} className="block hover:opacity-80">
                          {content}
                        </Link>
                      ) : (
                        content
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {errors.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-red-300">
          {errors.map((step) => (
            <li key={step.id}>
              {run.definition.find((definition) => definition.id === step.stepId)?.name}
              {step.lane !== 'main' && ` (${laneLabel(step.lane)})`}: {step.error}
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={cancel.error} />
    </article>
  );
}
