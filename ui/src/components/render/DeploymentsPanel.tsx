import { Link } from 'react-router';
import { environmentLabels, useDeployments } from '../../api/render';
import { timeAgo } from '../../lib/time';
import { Badge } from '../Badge';
import { ErrorText } from '../form';

/** Latest deploys of the workspace, refreshed faster while one is running. */
export function DeploymentsPanel({ workspaceId }: { workspaceId: string }) {
  const deployments = useDeployments(workspaceId);
  if (deployments.error) return <ErrorText error={deployments.error} />;
  if (!deployments.data) return <p className="text-sm text-muted">Carregando...</p>;
  if (deployments.data.length === 0) return <p className="text-xs text-muted">Nenhum deploy ainda.</p>;

  return (
    <ul className="divide-y divide-border/60">
      {deployments.data.slice(0, 6).map((deployment) => (
        <li key={deployment.id} className={`py-1.5 text-xs ${deployment.isFinished ? '' : 'glow-working-row -mx-2 rounded-md px-2'}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium">{deployment.serviceName}</span>
            <Badge tone={deployment.isSuccess ? 'success' : deployment.isFinished ? 'danger' : 'info'}>{deployment.statusLabel}</Badge>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2 text-muted">
            <span>
              {environmentLabels[deployment.environment]}
              {deployment.agentId && (
                <>
                  {' · '}
                  <Link to={`/agents/${deployment.agentId}`} className="hover:text-accent">
                    agente
                  </Link>
                </>
              )}
              {deployment.prUrl && (
                <>
                  {' · '}
                  <a href={deployment.prUrl} target="_blank" rel="noreferrer" className="hover:text-accent">
                    PR/MR
                  </a>
                </>
              )}
            </span>
            <span className="shrink-0">{timeAgo(deployment.startedAt)}</span>
          </div>
          {deployment.error && <p className="mt-0.5 text-red-300">{deployment.error}</p>}
        </li>
      ))}
    </ul>
  );
}
