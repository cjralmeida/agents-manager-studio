import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import {
  type AgentProfile,
  useAgentProfiles,
  useCreateAgentProfile,
  useDeleteAgentProfile,
  useUpdateAgentProfile,
} from '../../api/agentProfiles';
import type { AgentModel } from '../../api/agents';
import type { WorkspaceDetail } from '../../api/workspaces';
import { plural } from '../../lib/time';
import { NewAgentForm } from '../agents/NewAgentForm';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText } from '../form';
import { ProfileDialog } from './ProfileDialog';

const modelLabels: Record<AgentModel, string> = { sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' };

/** Fixed agents of the workspace: each has a role and can be run by hand or used in workflows. */
export function AgentProfilesTab({ workspace }: { workspace: WorkspaceDetail }) {
  const profiles = useAgentProfiles(workspace.id);
  const [editing, setEditing] = useState<AgentProfile | 'new' | null>(null);
  const [running, setRunning] = useState<AgentProfile | null>(null);
  const create = useCreateAgentProfile(workspace.id);
  const update = useUpdateAgentProfile(workspace.id);
  const closeEditor = useCallback(() => setEditing(null), []);

  if (profiles.error) return <ErrorText error={profiles.error} />;
  if (!profiles.data) return <p className="text-sm text-muted">Carregando...</p>;

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted">
          Agentes fixos do workspace, cada um com um papel: documentar, planejar tarefas, executar, testar. Você pode
          executá-los aqui e, depois, encadeá-los num workflow.
        </p>
        <Button variant="primary" onClick={() => setEditing('new')}>
          Novo agente
        </Button>
      </div>

      {editing !== null && (
        <ProfileDialog
          key={editing === 'new' ? 'new' : editing.id}
          workspace={workspace}
          initial={editing === 'new' ? undefined : editing}
          pending={create.isPending || update.isPending}
          error={create.error ?? update.error}
          onClose={closeEditor}
          onSubmit={(input) => {
            const done = { onSuccess: () => setEditing(null) };
            if (editing === 'new') create.mutate(input, done);
            else update.mutate({ id: editing.id, ...input }, done);
          }}
        />
      )}

      {running && (
        <NewAgentForm
          key={running.id}
          workspaceId={workspace.id}
          projects={workspace.projects}
          initial={{ profileId: running.id }}
          onCancel={() => setRunning(null)}
        />
      )}

      {profiles.data.length === 0 && editing === null && (
        <p className="text-sm text-muted">Nenhum agente fixo ainda. Crie, por exemplo, um "Documentador" ou um "Testador".</p>
      )}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {profiles.data.map((profile) => (
          <ProfileCard
            key={profile.id}
            workspace={workspace}
            profile={profile}
            onEdit={() => setEditing(profile)}
            onRun={() => setRunning(profile)}
          />
        ))}
      </div>
    </div>
  );
}

function ProfileCard({ workspace, profile, onEdit, onRun }: { workspace: WorkspaceDetail; profile: AgentProfile; onEdit: () => void; onRun: () => void }) {
  const remove = useDeleteAgentProfile(workspace.id);
  const projectNames = profile.projectIds.map((id) => workspace.projects.find((project) => project.id === id)?.name ?? '?');
  const contextNames = profile.contextProjectIds.map((id) => workspace.projects.find((project) => project.id === id)?.name ?? '?');

  const handleDelete = () => {
    if (window.confirm(`Excluir o agente "${profile.name}"? As execuções que ele já fez continuam existindo.`)) remove.mutate(profile.id);
  };

  return (
    <article className={`flex flex-col rounded-lg border bg-panel p-4 ${profile.workingAgents > 0 ? 'glow-working' : 'border-border'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{profile.name}</h3>
          {profile.description && <p className="mt-0.5 text-xs text-muted">{profile.description}</p>}
        </div>
        <Badge tone="info">{modelLabels[profile.model]}</Badge>
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        {projectNames.length === 0 ? <Badge>sem repositório</Badge> : projectNames.map((name) => <Badge key={name}>{name}</Badge>)}
        <Badge>{profile.output === 'RESULT' ? 'entrega resultado' : 'entrega PR/MR'}</Badge>
        {profile.tools.includes('board') && <Badge>quadro</Badge>}
        {profile.tools.includes('hom') && <Badge>HOM</Badge>}
        {profile.tools.includes('hom_read') && <Badge>HOM leitura</Badge>}
        {profile.tools.includes('clickup_read') && <Badge>ClickUp leitura</Badge>}
        {profile.tools.includes('pixellab') && <Badge>PixelLab</Badge>}
        {profile.tools.includes('roadmap') && <Badge>roadmap</Badge>}
        {profile.autoConclude && <Badge tone="success">conclui sozinho</Badge>}
        {profile.autoMerge && <Badge tone="success">merge automático</Badge>}
        <Badge>tamanho {profile.resourceSize ?? profile.roleSize}</Badge>
        {contextNames.length > 0 && <Badge>lê: {contextNames.join(', ')}</Badge>}
      </div>
      {profile.instructions && <p className="mt-3 line-clamp-3 text-xs whitespace-pre-line text-gray-300">{profile.instructions}</p>}
      <p className="mt-auto pt-3 text-[11px] text-muted">
        {profile.workingAgents} trabalhando · {plural(profile.totalAgents, 'execução', 'execuções')}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={onRun} disabled={workspace.isMissing}>
          Executar
        </Button>
        <Link
          to={`/workspaces/${workspace.id}/agents/${profile.id}`}
          className="rounded-md border border-border bg-panel px-2 py-1 text-xs font-medium text-gray-200 hover:bg-border"
        >
          Abrir
        </Link>
        <Button size="sm" onClick={onEdit}>
          Editar
        </Button>
        <Button size="sm" variant="danger" onClick={handleDelete} disabled={remove.isPending}>
          Excluir
        </Button>
      </div>
      <ErrorText error={remove.error} />
    </article>
  );
}
