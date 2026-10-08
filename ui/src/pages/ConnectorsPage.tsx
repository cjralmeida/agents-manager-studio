import { Link, useSearchParams } from 'react-router';
import { useAgentAccounts, useGitAccounts } from '../api/accounts';
import { useRenderConnections } from '../api/render';
import { Button } from '../components/Button';
import { type ConnectorId, ConnectorIcon } from '../components/connectors/ConnectorIcon';
import { AgentAccountsSection } from '../components/settings/AgentAccountsSection';
import { BoardTemplateSection } from '../components/settings/BoardTemplateSection';
import { GitAccountsSection } from '../components/settings/GitAccountsSection';
import { plural } from '../lib/time';

interface ConnectorCardInfo {
  id: ConnectorId;
  name: string;
  /** What the Studio and the agents use it for. */
  purpose: string;
  connected: boolean;
  status: string;
}

/** The external tools the Studio and its agents use; each card opens its accounts and options. */
export function ConnectorsPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('c') as ConnectorId | null;
  const agentAccounts = useAgentAccounts();
  const gitAccounts = useGitAccounts();
  const renderConnections = useRenderConnections();

  const gitStatus = (provider: 'GITHUB' | 'GITLAB') => {
    const accounts = gitAccounts.data?.filter((account) => account.provider === provider) ?? [];
    const workspaces = accounts.reduce((total, account) => total + account.workspaceCount, 0);
    return {
      connected: accounts.length > 0,
      status: accounts.length > 0 ? `${plural(accounts.length, 'conta', 'contas')} · em ${plural(workspaces, 'workspace', 'workspaces')}` : 'Não conectado',
    };
  };
  const claudeWorkspaces = agentAccounts.data?.reduce((total, account) => total + account.workspaceCount, 0) ?? 0;
  const renderCount = renderConnections.data?.length ?? 0;

  const cards: ConnectorCardInfo[] = [
    {
      id: 'claude',
      name: 'Claude',
      purpose: 'O modelo que roda os agentes e o Órbi, pela sua assinatura Pro/Max.',
      connected: (agentAccounts.data?.length ?? 0) > 0,
      status:
        (agentAccounts.data?.length ?? 0) > 0
          ? `${plural(agentAccounts.data!.length, 'conta', 'contas')} · em ${plural(claudeWorkspaces, 'workspace', 'workspaces')}`
          : 'Não conectado',
    },
    { id: 'github', name: 'GitHub', purpose: 'Clone, push e pull requests; quadros do GitHub Projects.', ...gitStatus('GITHUB') },
    { id: 'gitlab', name: 'GitLab', purpose: 'Clone, push e merge requests; boards de grupo do GitLab.', ...gitStatus('GITLAB') },
    {
      id: 'render',
      name: 'Render',
      purpose: 'Deploy em homologação e produção a partir dos workflows.',
      connected: renderCount > 0,
      status: renderCount > 0 ? `conectado em ${plural(renderCount, 'workspace', 'workspaces')}` : 'Configurado em cada workspace',
    },
  ];
  const select = (id: ConnectorId) => setParams(id === selected ? {} : { c: id });
  const current = cards.find((card) => card.id === selected);

  return (
    <section className="max-w-6xl">
      <h1 className="text-xl font-semibold">Conectores</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        As ferramentas que o Studio e os agentes usam. Aqui você conecta as contas; em cada workspace, na aba Conectores,
        escolhe quais ficam disponíveis para os agentes dele. Os tokens ficam criptografados e nunca chegam aos agentes.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <button
            key={card.id}
            type="button"
            onClick={() => select(card.id)}
            className={`flex flex-col rounded-xl border bg-panel p-4 text-left transition-colors hover:border-accent/60 ${
              selected === card.id ? 'border-accent' : 'border-border'
            }`}
          >
            <div className="flex items-center gap-3">
              <ConnectorIcon id={card.id} size={44} />
              <div className="min-w-0">
                <h2 className="font-semibold">{card.name}</h2>
                <p className="flex items-center gap-1.5 text-xs text-muted">
                  <span className={`size-1.5 rounded-full ${card.connected ? 'bg-emerald-400' : 'bg-border'}`} />
                  {card.status}
                </p>
              </div>
            </div>
            <p className="mt-3 text-sm text-gray-300">{card.purpose}</p>
            <span className="mt-auto pt-4 text-xs font-medium text-accent">{selected === card.id ? 'Fechar' : card.connected ? 'Gerenciar' : 'Conectar'}</span>
          </button>
        ))}
      </div>

      {current && (
        <div className="mt-6 space-y-8 rounded-xl border border-border bg-surface/40 p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <ConnectorIcon id={current.id} size={36} />
              <h2 className="text-lg font-semibold">{current.name}</h2>
            </div>
            <Button size="sm" onClick={() => setParams({})}>
              Fechar
            </Button>
          </div>
          {current.id === 'claude' && <AgentAccountsSection />}
          {current.id === 'github' && (
            <>
              <GitAccountsSection provider="GITHUB" />
              <BoardTemplateSection />
            </>
          )}
          {current.id === 'gitlab' && <GitAccountsSection provider="GITLAB" />}
          {current.id === 'render' && <RenderConnections />}
        </div>
      )}
    </section>
  );
}

function RenderConnections() {
  const connections = useRenderConnections();
  return (
    <section>
      <p className="max-w-3xl text-sm text-muted">
        A chave do Render é informada em cada workspace (aba Conectores do workspace), junto com o serviço de homologação e
        produção de cada projeto.
      </p>
      {connections.data && connections.data.length === 0 && <p className="mt-3 text-sm text-muted">Nenhum workspace conectado ao Render.</p>}
      <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
        {connections.data?.map((connection) => (
          <li key={connection.workspaceId} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
            <span>
              <span className="font-medium">{connection.workspaceName}</span>
              <span className="text-muted">
                {' '}
                · {connection.ownerName} · {plural(connection.services, 'serviço', 'serviços')}
              </span>
            </span>
            <Link to={`/workspaces/${connection.workspaceId}?tab=connectors`} className="text-xs text-accent hover:underline">
              Abrir
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
