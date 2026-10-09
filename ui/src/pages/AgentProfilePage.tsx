import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { outputLabels, useAgentProfiles } from '../api/agentProfiles';
import { useAgentExecutions } from '../api/agents';
import { useResourceUsage } from '../api/system';
import { formatTokens, formatUsd } from '../api/usage';
import { useWorkspace } from '../api/workspaces';
import { ExecutionHistory } from '../components/agents/ExecutionHistory';
import { NewAgentForm } from '../components/agents/NewAgentForm';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { agentStateLabels } from '../components/dashboard/AgentsOverview';
import { UNASSIGNED_KEY, summarizeAgents } from '../components/dashboard/agentSummary';
import { ErrorText } from '../components/form';

const modelLabels: Record<string, string> = { sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' };

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-panel px-3 py-2" title={hint}>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** A workspace agent (or the "avulsos" of a workspace): what it is doing now and the history of its executions. */
export function AgentProfilePage() {
  const { workspaceId = '', profileKey = '' } = useParams();
  const isUnassigned = profileKey === UNASSIGNED_KEY;
  const workspace = useWorkspace(workspaceId);
  const profiles = useAgentProfiles(workspaceId);
  const executions = useAgentExecutions({ workspaceId, ...(isUnassigned ? { unassigned: true } : { profileId: profileKey }) });
  const resources = useResourceUsage();
  const [launching, setLaunching] = useState(false);

  const profile = profiles.data?.find((entry) => entry.id === profileKey) ?? null;
  const live = useMemo(
    () => new Map((resources.data?.containers ?? []).flatMap((container) => (container.agentId ? [[container.agentId, container]] : []))),
    [resources.data],
  );
  const summary = useMemo(() => {
    if (!executions.data) return null;
    const all = summarizeAgents(profile ? [profile] : [], executions.data, live);
    return all.find((entry) => (profile ? entry.profile?.id === profile.id : !entry.profile)) ?? null;
  }, [executions.data, live, profile]);

  const error = workspace.error ?? profiles.error ?? executions.error;
  if (error) return <ErrorText error={error} />;
  if (!workspace.data || !profiles.data || !executions.data) return <p className="text-sm text-muted">Carregando...</p>;
  if (!isUnassigned && !profile) return <p className="text-sm text-muted">Agente não encontrado.</p>;

  const list = executions.data;
  const finished = list.filter((agent) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(agent.status));
  const succeeded = finished.filter((agent) => agent.status === 'COMPLETED').length;
  const waiting = list.filter((agent) => agent.status === 'WAITING_INPUT');
  const state = summary ? agentStateLabels[summary.state] : agentStateLabels.idle;
  const projectNames = profile?.projectIds.map((id) => workspace.data.projects.find((project) => project.id === id)?.name ?? '?') ?? [];

  return (
    <section className="max-w-5xl space-y-6">
      <div>
        <Link to={`/workspaces/${workspaceId}`} className="text-sm text-muted hover:text-white">
          ← {workspace.data.name}
        </Link>
        <header
          className={`mt-3 flex flex-wrap items-start justify-between gap-4 rounded-lg border bg-panel p-4 ${
            summary?.state === 'working' ? 'glow-working' : 'border-border'
          }`}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-xl font-semibold">{profile?.name ?? 'Agentes avulsos'}</h1>
              <Badge tone={state.tone}>{state.label}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted">
              {profile ? profile.description || 'Agente do workspace.' : 'Execuções lançadas sem um agente fixo, só com a tarefa.'}
            </p>
            {profile && (
              <div className="mt-2 flex flex-wrap gap-1">
                <Badge tone="info">{modelLabels[profile.model] ?? profile.model}</Badge>
                {projectNames.length === 0 ? <Badge>sem repositório</Badge> : projectNames.map((name) => <Badge key={name}>{name}</Badge>)}
                <Badge>{outputLabels[profile.output]}</Badge>
                {profile.tools.includes('board') && <Badge>quadro</Badge>}
                {profile.tools.includes('render') && <Badge>Render</Badge>}
                {profile.tools.includes('render_read') && <Badge>HOM leitura</Badge>}
                {profile.autoConclude && <Badge tone="success">conclui sozinho</Badge>}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            {!launching && (
              <Button variant="primary" onClick={() => setLaunching(true)} disabled={workspace.data.isMissing}>
                Executar
              </Button>
            )}
            {profile && (
              <Link
                to={`/workspaces/${workspaceId}?tab=agents`}
                className="rounded-md border border-border bg-panel px-3 py-1.5 text-sm font-medium text-gray-200 hover:bg-border"
              >
                Editar
              </Link>
            )}
          </div>
        </header>
      </div>

      {launching && (
        <NewAgentForm
          workspaceId={workspaceId}
          projects={workspace.data.projects}
          initial={profile ? { profileId: profile.id } : undefined}
          onCancel={() => setLaunching(false)}
        />
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Execuções" value={String(list.length)} />
        <Stat label="Em andamento agora" value={String(summary?.working ?? 0)} />
        <Stat
          label="Concluídas com sucesso"
          value={finished.length > 0 ? `${Math.round((succeeded / finished.length) * 100)}%` : '—'}
          hint={`${succeeded} de ${finished.length} execuções terminadas`}
        />
        <Stat
          label="Consumo (estimado)"
          value={summary ? formatUsd(summary.costUsd) : '—'}
          hint={summary ? `${formatTokens(summary.tokens)} tokens, a preço de API` : undefined}
        />
      </div>

      {waiting.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Precisa de você</h2>
          {waiting.map((agent) => (
            <Link
              key={agent.id}
              to={`/agents/${agent.id}`}
              className="glow-question block rounded-lg border border-amber-400/70 bg-amber-400/10 px-3 py-2 hover:bg-amber-400/15"
            >
              <span className="block text-sm font-medium">{agent.title}</span>
              <span className="block text-xs text-amber-200">{agent.pendingQuestion?.[0]?.question ?? 'O agente está aguardando a sua resposta.'}</span>
            </Link>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Histórico de execuções</h2>
        <ExecutionHistory executions={list} />
      </section>
    </section>
  );
}
