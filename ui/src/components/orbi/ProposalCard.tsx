import { useState } from 'react';
import { useAgentProfiles } from '../../api/agentProfiles';
import { type Proposal, proposalKindLabels, useDecideProposal } from '../../api/assistant';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText } from '../form';

type Json = Record<string, unknown>;

const modelLabels: Record<string, string> = { sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' };

/** The essentials of what will change, readable at a glance; the raw payload is behind "Ver detalhes". */
function Preview({ proposal, profileName }: { proposal: Proposal; profileName: (id: string) => string }) {
  const payload = proposal.payload;

  if ((proposal.kind === 'create_workflow' || proposal.kind === 'update_workflow') && Array.isArray(payload.steps)) {
    const trigger = payload.trigger as Json | undefined;
    return (
      <div className="space-y-2 text-xs">
        {trigger && (
          <p className="text-muted">
            {trigger.type === 'manual'
              ? 'Começa com uma mensagem sua.'
              : trigger.type === 'feature_in_homologation'
                ? 'Começa quando todas as tarefas de uma funcionalidade estão em homologação.'
                : trigger.type === 'task_awaiting_decision'
                  ? 'Começa quando uma tarefa fica aguardando decisão.'
                  : 'Começa quando aparece uma tarefa no quadro que bate com os filtros.'}
          </p>
        )}
        <ol className="flex flex-wrap items-center gap-1">
          {(payload.steps as Json[]).map((step, index) => (
            <li key={String(step.id ?? index)} className="flex items-center gap-1">
              {index > 0 && <span className="text-muted">→</span>}
              <span className="rounded-full border border-border px-2 py-0.5" title={step.kind === 'agent' ? profileName(String(step.profileId)) : undefined}>
                {String(step.name)}
                {step.forEachTask ? ' (cada tarefa)' : ''}
                {step.onFailure ? ' ↺' : ''}
              </span>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  if (proposal.kind === 'create_agent' || proposal.kind === 'update_agent') {
    const details = [
      payload.model ? modelLabels[String(payload.model)] : null,
      Array.isArray(payload.projectIds) ? (payload.projectIds.length === 0 ? 'sem repositório' : `${payload.projectIds.length} projeto(s)`) : null,
      payload.output === 'RESULT' ? 'entrega resultado' : payload.output === 'PULL_REQUEST' ? 'entrega PR/MR' : null,
      Array.isArray(payload.tools) && payload.tools.includes('board') ? 'quadro' : null,
      Array.isArray(payload.tools) && payload.tools.includes('render') ? 'Render' : null,
      payload.autoConclude ? 'conclui sozinho' : null,
    ].filter(Boolean);
    return (
      <div className="space-y-1 text-xs">
        {payload.name ? <p className="font-medium">{String(payload.name)}</p> : null}
        {details.length > 0 && <p className="text-muted">{details.join(' · ')}</p>}
        {payload.instructions ? <p className="line-clamp-3 whitespace-pre-line text-gray-300">{String(payload.instructions)}</p> : null}
      </div>
    );
  }

  if (proposal.kind === 'create_task') {
    const fields = payload.fields as Record<string, string> | undefined;
    return (
      <div className="space-y-1 text-xs">
        <p className="font-medium">{String(payload.title)}</p>
        {fields && <p className="text-muted">{Object.entries(fields).map(([field, option]) => `${field}: ${option}`).join(' · ')}</p>}
      </div>
    );
  }

  if (proposal.kind === 'start_workflow' && payload.message) {
    return <p className="line-clamp-3 text-xs text-gray-300">"{String(payload.message)}"</p>;
  }

  if (proposal.kind === 'update_workspace_settings') {
    const parts = [
      'agentAccountId' in payload ? (payload.agentAccountId ? 'conta Claude' : 'sem conta Claude') : null,
      Array.isArray(payload.gitAccountIds) ? `${payload.gitAccountIds.length} conta(s) git` : null,
      'renderAccountId' in payload ? (payload.renderAccountId ? 'conta do Render' : 'sem Render') : null,
      'clickupAccountId' in payload ? (payload.clickupAccountId ? 'conta do ClickUp' : 'sem ClickUp') : null,
      Array.isArray(payload.enabledSkillIds) ? `skills: ${(payload.enabledSkillIds as string[]).join(', ') || 'nenhuma'}` : null,
    ].filter(Boolean);
    return <p className="text-xs text-muted">{parts.join(' · ')}</p>;
  }

  if (proposal.kind === 'create_board') {
    const provider = payload.provider === 'GITHUB' ? 'GitHub' : 'GitLab';
    return (
      <p className="text-xs text-muted">
        "{String(payload.title)}" em {provider} · {String(payload.owner)}, com as colunas e campos do modelo
      </p>
    );
  }

  if (proposal.kind === 'link_board') return <p className="truncate text-xs text-muted">{String(payload.url)}</p>;

  if (proposal.kind === 'set_render_service') {
    const environment = payload.environment === 'PRODUCAO' ? 'produção' : 'homologação';
    return <p className="text-xs text-muted">{payload.serviceId ? `Serviço ${String(payload.serviceId)} em ${environment}` : `Sem serviço em ${environment}`}</p>;
  }
  return null;
}

/** A change Órbi proposes; nothing happens until the user applies it. */
export function ProposalCard({ proposal, workspaceId }: { proposal: Proposal; workspaceId: string }) {
  const [showDetails, setShowDetails] = useState(false);
  const decide = useDecideProposal(proposal.agentId);
  const profiles = useAgentProfiles(workspaceId);
  const profileName = (id: string) => profiles.data?.find((profile) => profile.id === id)?.name ?? id;

  const status = {
    PENDING: null,
    APPLIED: <Badge tone="success">Aplicada</Badge>,
    DISCARDED: <Badge>Descartada</Badge>,
    FAILED: <Badge tone="danger">Falhou</Badge>,
  }[proposal.status];

  return (
    <div className={`rounded-lg border p-3 ${proposal.status === 'PENDING' ? 'border-accent/60 bg-accent/5' : 'border-border bg-panel'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-wider text-accent uppercase">{proposalKindLabels[proposal.kind] ?? proposal.kind}</p>
          <p className="mt-0.5 text-sm">{proposal.summary}</p>
        </div>
        {status}
      </div>
      <div className="mt-2">
        <Preview proposal={proposal} profileName={profileName} />
      </div>
      {proposal.error && <p className="mt-2 text-xs text-red-300">{proposal.error}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {proposal.status === 'PENDING' && (
          <>
            <Button size="sm" variant="primary" onClick={() => decide.mutate({ id: proposal.id, decision: 'apply' })} disabled={decide.isPending}>
              {decide.isPending ? 'Aplicando...' : 'Aplicar'}
            </Button>
            <Button size="sm" onClick={() => decide.mutate({ id: proposal.id, decision: 'discard' })} disabled={decide.isPending}>
              Descartar
            </Button>
          </>
        )}
        <button type="button" onClick={() => setShowDetails((value) => !value)} className="text-xs text-muted hover:text-white">
          {showDetails ? 'Ocultar detalhes' : 'Ver detalhes'}
        </button>
      </div>
      {showDetails && (
        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-surface p-2 font-mono text-[11px] text-gray-300">
          {JSON.stringify(proposal.payload, null, 2)}
        </pre>
      )}
      <ErrorText error={decide.error} />
    </div>
  );
}
