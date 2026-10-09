import { Link } from 'react-router';
import { type WorkflowRun, useActiveRuns, useWorkflowRuns } from '../../api/workflows';
import { ErrorText } from '../form';
import { WorkflowRunCard } from '../workflows/WorkflowRunCard';

/** Running workflow runs: of one workspace, or of every workspace the user sees. */
export function useActiveWorkflowRuns(workspaceId?: string) {
  const workspaceRuns = useWorkflowRuns(workspaceId ?? '', Boolean(workspaceId));
  const allRuns = useActiveRuns(!workspaceId);
  const query = workspaceId ? workspaceRuns : allRuns;
  const runs = (query.data ?? []).filter((run: WorkflowRun) => run.status === 'RUNNING');
  return { runs, error: query.error, isPending: query.isPending };
}

/** The dashboard's "Workflows" tab: what the workflows are doing right now. */
export function ActiveWorkflows({ workspaceId }: { workspaceId?: string }) {
  const { runs, error, isPending } = useActiveWorkflowRuns(workspaceId);

  if (error) return <ErrorText error={error} />;
  if (isPending) return <p className="text-sm text-muted">Carregando...</p>;
  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
        Nenhum workflow rodando agora.
        {workspaceId && (
          <>
            {' '}
            <Link to={`/workspaces/${workspaceId}?tab=workflows`} className="text-accent hover:underline">
              Ver os workflows do workspace
            </Link>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {runs.map((run) => (
        <div key={run.id} className="space-y-1">
          {run.workspaceName && (
            <Link to={`/workspaces/${run.workspaceId}?tab=workflows`} className="text-xs text-muted hover:text-accent">
              {run.workspaceName}
            </Link>
          )}
          <WorkflowRunCard workspaceId={run.workspaceId} run={run} />
        </div>
      ))}
    </div>
  );
}
