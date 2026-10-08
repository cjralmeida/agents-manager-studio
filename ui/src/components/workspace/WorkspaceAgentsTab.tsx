import { useState } from 'react';
import { useAgents } from '../../api/agents';
import type { WorkspaceDetail } from '../../api/workspaces';
import { AgentList } from '../agents/AgentList';
import { NewAgentForm } from '../agents/NewAgentForm';
import { Button } from '../Button';
import { ErrorText } from '../form';

export function WorkspaceAgentsTab({ workspace }: { workspace: WorkspaceDetail }) {
  const agents = useAgents(workspace.id);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-4">
      {creating ? (
        <NewAgentForm projects={workspace.projects} onCancel={() => setCreating(false)} />
      ) : (
        <Button variant="primary" onClick={() => setCreating(true)} disabled={workspace.isMissing}>
          Novo agente
        </Button>
      )}
      <ErrorText error={agents.error} />
      {agents.data && <AgentList agents={agents.data} />}
    </div>
  );
}
