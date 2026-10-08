import { useState } from 'react';
import { useAgents } from '../../api/agents';
import type { WorkspaceDetail } from '../../api/workspaces';
import { AgentsView } from '../agents/AgentsView';
import { NewAgentForm } from '../agents/NewAgentForm';
import { Button } from '../Button';
import { ErrorText } from '../form';

/** Workspace dashboard: its agents as cards or table, and launching new ones. */
export function WorkspaceAgentsTab({ workspace }: { workspace: WorkspaceDetail }) {
  const agents = useAgents(workspace.id);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-4">
      {creating && <NewAgentForm projects={workspace.projects} onCancel={() => setCreating(false)} />}
      <ErrorText error={agents.error} />
      {agents.data && (
        <AgentsView
          agents={agents.data}
          viewKey="workspace-agents"
          actions={
            !creating && (
              <Button variant="primary" onClick={() => setCreating(true)} disabled={workspace.isMissing}>
                Novo agente
              </Button>
            )
          }
        />
      )}
    </div>
  );
}
