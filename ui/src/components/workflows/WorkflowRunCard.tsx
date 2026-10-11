import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { type StepRun, type WorkflowRun, useCancelRun } from '../../api/workflows';
import { formatDuration, timeAgo } from '../../lib/time';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText } from '../form';

type Tone = Parameters<typeof Badge>[0]['tone'];

const runStatus: Record<WorkflowRun['status'], { label: string; tone: Tone; icon: string; color: string }> = {
  RUNNING: { label: 'Em andamento', tone: 'info', icon: '●', color: 'text-purple-300' },
  COMPLETED: { label: 'Concluída', tone: 'success', icon: '✓', color: 'text-emerald-300' },
  FAILED: { label: 'Falhou', tone: 'danger', icon: '✕', color: 'text-red-300' },
  CANCELLED: { label: 'Cancelada', tone: 'neutral', icon: '⊘', color: 'text-muted' },
};

type StepState = 'pending' | 'running' | 'question' | 'done' | 'failed' | 'returned' | 'cancelled';

const stepLook: Record<StepState, { icon: string; dot: string; text: string; label: string }> = {
  pending: { icon: '', dot: 'border-border bg-surface text-muted', text: 'text-muted', label: 'Aguardando' },
  running: { icon: '●', dot: 'border-purple-400/70 bg-purple-500/15 text-purple-300', text: 'text-purple-200', label: 'Trabalhando' },
  question: { icon: '?', dot: 'border-amber-400/80 bg-amber-400/15 text-amber-300', text: 'text-amber-200', label: 'Pergunta para você' },
  done: { icon: '✓', dot: 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300', text: 'text-gray-200', label: 'Ok' },
  failed: { icon: '✕', dot: 'border-red-500/60 bg-red-500/15 text-red-300', text: 'text-red-200', label: 'Falhou' },
  returned: { icon: '↺', dot: 'border-amber-500/60 bg-amber-500/10 text-amber-300', text: 'text-gray-300', label: 'Devolvido' },
  cancelled: { icon: '⊘', dot: 'border-border bg-surface text-muted', text: 'text-muted', label: 'Cancelado' },
};

function stateOf(step: StepRun | undefined): StepState {
  if (!step) return 'pending';
  if (step.agentStatus === 'WAITING_INPUT') return 'question';
  return ({ RUNNING: 'running', SUCCEEDED: 'done', FAILED: 'failed', RETRIED: 'returned', CANCELLED: 'cancelled' } as const)[step.status];
}

const prNumber = (url: string) => url.match(/(\d+)\/?$/)?.[1];

/** The run's lanes: the main flow, then one per task a step created (steps that run "para cada tarefa"). */
function lanesOf(run: WorkflowRun) {
  const createdTasks = run.steps.flatMap((step) => step.output?.createdTasks ?? []);
  const lanes = ['main', ...new Set(run.steps.map((step) => step.lane).filter((lane) => lane !== 'main'))];
  const laneLabel = (lane: string) => createdTasks.find((task) => task.id === lane)?.title ?? 'Tarefa';
  const latest = (stepId: string, lane: string) =>
    run.steps.filter((step) => step.stepId === stepId && step.lane === lane).sort((a, b) => b.attempt - a.attempt)[0];
  const ranIn = (lane: string) => new Set(run.steps.filter((step) => step.lane === lane).map((step) => step.stepId));
  // The main flow shows every step that did not run per task; a task lane shows the steps that ran in it.
  const perTask = new Set(run.steps.filter((step) => step.lane !== 'main').map((step) => step.stepId));
  const stepsOf = (lane: string) => run.definition.filter((definition) => (lane === 'main' ? !perTask.has(definition.id) : ranIn(lane).has(definition.id)));
  return { lanes, laneLabel, latest, stepsOf };
}

/** Last PR/MR the run produced, to link from the summary. */
function runPullRequest(run: WorkflowRun) {
  return [...run.steps].reverse().find((step) => step.output?.prUrl)?.output?.prUrl ?? null;
}

function StepTimeline({ run, lane }: { run: WorkflowRun; lane: string }) {
  const { latest, stepsOf } = lanesOf(run);
  const steps = stepsOf(lane);
  return (
    <ol className="flex flex-wrap items-start gap-y-3">
      {steps.map((definition, index) => {
        const step = latest(definition.id, lane);
        const state = stateOf(step);
        const look = stepLook[state];
        const title = step?.error ?? step?.output?.summary ?? look.label;
        const body = (
          <div className="flex items-start gap-2" title={title}>
            <span
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${look.dot} ${
                state === 'question' ? 'glow-question' : ''
              }`}
              aria-label={look.label}
            >
              {state === 'running' ? <span className="h-2 w-2 animate-pulse rounded-full bg-purple-400" /> : look.icon || index + 1}
            </span>
            <div className="min-w-0">
              <p className={`truncate text-sm font-medium ${look.text}`}>{definition.name}</p>
              <p className="truncate text-[11px] text-muted">
                {step?.agentName ?? (definition.kind === 'deploy' ? 'deploy' : look.label)}
                {step && ` · ${formatDuration(step.startedAt, step.finishedAt)}${step.finishedAt ? '' : '…'}`}
                {step && step.attempt > 1 && ` · ${step.attempt}ª tentativa`}
              </p>
              {step?.output?.prUrl && (
                <a href={step.output.prUrl} target="_blank" rel="noreferrer" className="text-[11px] text-accent hover:underline" onClick={(event) => event.stopPropagation()}>
                  PR #{prNumber(step.output.prUrl)}
                </a>
              )}
            </div>
          </div>
        );
        return (
          <li key={definition.id} className="flex min-w-0 items-start">
            {index > 0 && <span className={`mx-3 mt-3 h-px w-8 shrink-0 sm:w-14 ${step ? 'bg-muted/60' : 'border-t border-dashed border-border'}`} aria-hidden />}
            {step?.agentId ? (
              <Link to={`/agents/${step.agentId}`} className="min-w-0 max-w-56 rounded-md hover:bg-border/40">
                {body}
              </Link>
            ) : (
              <div className="min-w-0 max-w-56">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function RunDetails({ run }: { run: WorkflowRun }) {
  const { lanes, laneLabel, latest } = lanesOf(run);
  const failures = run.steps.filter((step) => step.status === 'FAILED' && step.error && latest(step.stepId, step.lane)?.id === step.id);
  return (
    <div className="space-y-3">
      {lanes.map((lane) => (
        <div key={lane} className="space-y-1.5">
          {lane !== 'main' && <p className="truncate text-[11px] font-medium text-muted">Tarefa: {laneLabel(lane)}</p>}
          <StepTimeline run={run} lane={lane} />
        </div>
      ))}
      {failures.length > 0 && (
        <ul className="space-y-1 rounded-md border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-200">
          {failures.map((step) => (
            <li key={step.id}>
              <span className="font-medium">{run.definition.find((definition) => definition.id === step.stepId)?.name}</span>
              {step.lane !== 'main' && ` (${laneLabel(step.lane)})`}: {step.error}
            </li>
          ))}
        </ul>
      )}
      {run.error && failures.length === 0 && <p className="text-xs text-red-300">{run.error}</p>}
    </div>
  );
}

/** A run in progress: highlighted, with its steps as a timeline (who works on what, for how long). */
export function WorkflowRunCard({ workspaceId, run }: { workspaceId: string; run: WorkflowRun }) {
  const cancel = useCancelRun(workspaceId);
  const status = runStatus[run.status];
  const running = run.status === 'RUNNING';
  return (
    <article className={`rounded-lg border bg-panel p-4 ${running ? 'border-purple-400/50 ring-1 ring-purple-500/20' : 'border-border'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{run.title}</h3>
          <p className="mt-0.5 text-xs text-muted">
            {run.workflowName} · iniciada {timeAgo(run.startedAt)} · {formatDuration(run.startedAt, run.finishedAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          {running && (
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
      <div className="mt-4">
        <RunDetails run={run} />
      </div>
      <ErrorText error={cancel.error} />
    </article>
  );
}

/** Finished runs, one line each; a click opens the steps, summaries and errors. */
export function RunHistory({ runs }: { runs: WorkflowRun[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (runs.length === 0) return <p className="text-sm text-muted">Nenhuma execução terminada ainda.</p>;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-panel text-left text-[11px] tracking-wider text-muted uppercase">
          <tr>
            <th className="w-full px-3 py-2 font-medium">Execução</th>
            <th className="hidden w-px px-3 py-2 font-medium whitespace-nowrap md:table-cell">Workflow</th>
            <th className="hidden w-px px-3 py-2 font-medium whitespace-nowrap sm:table-cell">Passos</th>
            <th className="hidden w-px px-3 py-2 font-medium whitespace-nowrap lg:table-cell">Duração</th>
            <th className="hidden w-px px-3 py-2 font-medium whitespace-nowrap lg:table-cell">PR</th>
            <th className="w-px px-3 py-2 text-right font-medium whitespace-nowrap">Terminou</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const status = runStatus[run.status];
            const expanded = open === run.id;
            const pr = runPullRequest(run);
            const mainSteps = run.definition.map((definition) =>
              stateOf(run.steps.filter((step) => step.stepId === definition.id).sort((a, b) => b.attempt - a.attempt)[0]),
            );
            return (
              <Fragment key={run.id}>
                <tr
                  onClick={() => setOpen(expanded ? null : run.id)}
                  className={`cursor-pointer border-t border-border hover:bg-border/30 ${expanded ? 'bg-border/20' : ''}`}
                  aria-expanded={expanded}
                >
                  <td className="max-w-0 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className={`shrink-0 text-xs ${status.color}`} title={status.label}>
                        {status.icon}
                      </span>
                      <span className="truncate" title={run.title}>
                        {run.title}
                      </span>
                    </div>
                  </td>
                  <td className="hidden px-3 py-2 text-xs whitespace-nowrap text-muted md:table-cell">{run.workflowName}</td>
                  <td className="hidden px-3 py-2 sm:table-cell">
                    <span className="flex gap-0.5">
                      {mainSteps.map((state, index) => (
                        <span
                          key={run.definition[index]!.id}
                          title={`${run.definition[index]!.name}: ${stepLook[state].label}`}
                          className={`flex h-4 w-4 items-center justify-center rounded-full border text-[9px] ${stepLook[state].dot}`}
                        >
                          {stepLook[state].icon}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="hidden px-3 py-2 text-xs whitespace-nowrap text-muted lg:table-cell">{formatDuration(run.startedAt, run.finishedAt)}</td>
                  <td className="hidden px-3 py-2 text-xs whitespace-nowrap lg:table-cell">
                    {pr ? (
                      <a href={pr} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className="text-accent hover:underline">
                        #{prNumber(pr)}
                      </a>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-xs whitespace-nowrap text-muted">{run.finishedAt ? timeAgo(run.finishedAt) : '—'}</td>
                </tr>
                {expanded && (
                  <tr className="bg-border/20">
                    <td colSpan={6} className="px-4 pt-1 pb-4">
                      <RunDetails run={run} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
