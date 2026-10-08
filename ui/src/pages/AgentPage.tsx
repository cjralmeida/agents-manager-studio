import { Link, useNavigate, useParams } from 'react-router';
import { useAgent, useAgentAction, useDeleteAgent } from '../api/agents';
import { formatTokens, formatUsd, totalTokens } from '../api/usage';
import { AgentStatusBadge } from '../components/agents/AgentStatusBadge';
import { AgentResultPanel } from '../components/agents/AgentResultPanel';
import { Conversation } from '../components/agents/Conversation';
import { DiffView } from '../components/agents/DiffView';
import { Button } from '../components/Button';
import { ErrorText } from '../components/form';
import { Tabs, useTabParam } from '../components/Tabs';

const tabs = [
  { id: 'conversation', label: 'Conversa' },
  { id: 'changes', label: 'Alterações' },
] as const;

const modelLabels: Record<string, string> = { sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' };

export function AgentPage() {
  const { agentId = '' } = useParams();
  const agent = useAgent(agentId);
  const finalize = useAgentAction(agentId, 'finalize');
  const cancel = useAgentAction(agentId, 'cancel');
  const remove = useDeleteAgent();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useTabParam(tabs);

  if (agent.isPending) return <p className="text-sm text-muted">Carregando...</p>;
  if (agent.error) return <ErrorText error={agent.error} />;
  const { data } = agent;

  const deliversCode = data.output === 'PULL_REQUEST' && data.hasRepository;
  const handleFinalize = () => {
    if (!deliversCode) return finalize.mutate();
    if (window.confirm('Fazer commit, push da branch e abrir o PR/MR com as alterações atuais?')) finalize.mutate();
  };
  const handleCancel = () => {
    if (window.confirm('Cancelar o agente? A cópia do projeto é mantida até você excluir.')) cancel.mutate();
  };
  const handleDelete = () => {
    if (window.confirm('Excluir o agente, a conversa e a cópia do projeto? Alterações não enviadas serão perdidas.')) {
      remove.mutate(data.id, { onSuccess: () => navigate(`/workspaces/${data.workspaceId}`) });
    }
  };

  const canCancel = ['PREPARING', 'RUNNING', 'WAITING_INPUT', 'READY_FOR_REVIEW'].includes(data.status);

  return (
    <section className="max-w-5xl">
      <Link to={`/workspaces/${data.workspaceId}`} className="text-sm text-muted hover:text-white">
        ← {data.workspaceName}
      </Link>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold">{data.title}</h1>
            <AgentStatusBadge status={data.status} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {data.profileName && <span className="text-gray-200">{data.profileName} · </span>}
            {data.hasRepository ? (
              <>
                {data.projectName} · {modelLabels[data.model] ?? data.model} · <span className="font-mono">{data.branch}</span>{' '}
                (de {data.baseBranch})
              </>
            ) : (
              <>sem repositório · {modelLabels[data.model] ?? data.model}</>
            )}
            {data.autoConclude && ' · conclui sozinho'}
          </p>
          <p className="mt-0.5 font-mono text-xs text-muted">{data.workdirHostPath}</p>
          {totalTokens(data.usage) > 0 && (
            <p className="mt-0.5 text-xs text-muted" title="Custo estimado a preço de API; no plano Max não é cobrado à parte.">
              Consumo: {formatTokens(totalTokens(data.usage))} tokens · ≈ {formatUsd(data.usage.costUsd)}
            </p>
          )}
          {data.prUrl && (
            <a href={data.prUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-sm text-accent hover:underline">
              Abrir PR/MR ↗
            </a>
          )}
        </div>
        <div className="flex gap-2">
          {data.status === 'READY_FOR_REVIEW' && (
            <Button variant="primary" onClick={handleFinalize} disabled={finalize.isPending}>
              {!deliversCode ? 'Concluir' : data.prUrl ? 'Enviar alterações' : 'Concluir (commit + PR)'}
            </Button>
          )}
          {canCancel && (
            <Button onClick={handleCancel} disabled={cancel.isPending}>
              Cancelar
            </Button>
          )}
          {data.status !== 'FINALIZING' && (
            <Button variant="danger" onClick={handleDelete} disabled={remove.isPending}>
              Excluir
            </Button>
          )}
        </div>
      </header>

      <div className="mt-2 space-y-1">
        <ErrorText error={finalize.error ?? cancel.error ?? remove.error} />
        {data.errorMessage && <p className="text-sm text-red-300">{data.errorMessage}</p>}
      </div>

      <AgentResultPanel agent={data} />

      <div className="mt-6">
        <Tabs tabs={data.hasRepository ? tabs : tabs.slice(0, 1)} active={activeTab} onChange={setActiveTab} />
      </div>
      <div className="mt-4">
        {activeTab === 'changes' && data.hasRepository ? <DiffView agentId={data.id} /> : <Conversation agent={data} />}
      </div>
    </section>
  );
}
