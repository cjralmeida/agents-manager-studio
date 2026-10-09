import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import {
  type AgentProfile,
  type AgentProfileInput,
  type AgentOutput,
  type ProfileTool,
  outputLabels,
  toolLabels,
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
import { ErrorText, Field, Select, TextInput } from '../form';
import { MultiSelect } from '../MultiSelect';

const modelLabels: Record<AgentModel, string> = { sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' };

const empty: AgentProfileInput = {
  name: '',
  description: '',
  instructions: '',
  model: 'sonnet',
  projectIds: [],
  output: 'PULL_REQUEST',
  tools: [],
  autoConclude: false,
  autoMerge: false,
};

/** Fixed agents of the workspace: each has a role and can be run by hand or used in workflows. */
export function AgentProfilesTab({ workspace }: { workspace: WorkspaceDetail }) {
  const profiles = useAgentProfiles(workspace.id);
  const [editing, setEditing] = useState<AgentProfile | 'new' | null>(null);
  const [running, setRunning] = useState<AgentProfile | null>(null);
  const create = useCreateAgentProfile(workspace.id);
  const update = useUpdateAgentProfile(workspace.id);

  if (profiles.error) return <ErrorText error={profiles.error} />;
  if (!profiles.data) return <p className="text-sm text-muted">Carregando...</p>;

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted">
          Agentes fixos do workspace, cada um com um papel: documentar, planejar tarefas, executar, testar. Você pode
          executá-los aqui e, depois, encadeá-los num workflow.
        </p>
        {editing === null && (
          <Button variant="primary" onClick={() => setEditing('new')}>
            Novo agente
          </Button>
        )}
      </div>

      {editing !== null && (
        <ProfileForm
          key={editing === 'new' ? 'new' : editing.id}
          workspace={workspace}
          initial={editing === 'new' ? undefined : editing}
          pending={create.isPending || update.isPending}
          error={create.error ?? update.error}
          onCancel={() => setEditing(null)}
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

  const handleDelete = () => {
    if (window.confirm(`Excluir o agente "${profile.name}"? As execuções que ele já fez continuam existindo.`)) remove.mutate(profile.id);
  };

  return (
    <article className="flex flex-col rounded-lg border border-border bg-panel p-4">
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
        {profile.tools.includes('render') && <Badge>Render</Badge>}
        {profile.autoConclude && <Badge tone="success">conclui sozinho</Badge>}
        {profile.autoMerge && <Badge tone="success">merge automático</Badge>}
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

interface ProfileFormProps {
  workspace: WorkspaceDetail;
  initial?: AgentProfile;
  pending: boolean;
  error: Error | null;
  onSubmit: (input: AgentProfileInput) => void;
  onCancel: () => void;
}

function ProfileForm({ workspace, initial, pending, error, onSubmit, onCancel }: ProfileFormProps) {
  const [form, setForm] = useState<AgentProfileInput>(initial ?? empty);
  const set = <K extends keyof AgentProfileInput>(key: K, value: AgentProfileInput[K]) => setForm((current) => ({ ...current, [key]: value }));
  const gitProjects = workspace.projects.filter((project) => project.isGitRepo && !project.isMissing);
  const withoutRepository = form.projectIds.length === 0;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({ ...form, output: withoutRepository ? 'RESULT' : form.output });
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-panel p-4">
      <h3 className="text-sm font-medium">{initial ? `Editar "${initial.name}"` : 'Novo agente do workspace'}</h3>

      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Nome">
          <TextInput value={form.name} onChange={(event) => set('name', event.target.value)} placeholder="Ex.: Documentador" required />
        </Field>
        <div className="md:col-span-2">
          <Field label="Descrição curta">
            <TextInput value={form.description} onChange={(event) => set('description', event.target.value)} placeholder="Ex.: Escreve a documentação no repositório de docs" />
          </Field>
        </div>
      </div>

      <div className="mt-3">
        <Field label="Papel e instruções" hint="Vão para o prompt de sistema de toda execução deste agente.">
          <textarea
            value={form.instructions}
            onChange={(event) => set('instructions', event.target.value)}
            rows={6}
            placeholder="Ex.: Você documenta funcionalidades. Escreva em Markdown na pasta docs/, uma página por funcionalidade..."
            className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
          />
        </Field>
      </div>

      <div className="mt-4 max-w-2xl space-y-1">
        <span className="text-xs font-medium text-muted">Projetos em que trabalha</span>
        <MultiSelect
          options={gitProjects.map((project) => ({ value: project.id, label: project.name }))}
          selected={form.projectIds}
          onChange={(next) => set('projectIds', next)}
          placeholder="Nenhum (sem repositório)"
        />
        <p className="text-xs text-muted">
          {withoutRepository ? 'Nenhum marcado: o agente trabalha sem repositório e entrega um resultado.' : 'Ao executar, você escolhe um destes projetos.'}
        </p>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Field label="Modelo">
          <Select value={form.model} onChange={(event) => set('model', event.target.value as AgentModel)}>
            <option value="sonnet">Sonnet (padrão)</option>
            <option value="opus">Opus (tarefas difíceis)</option>
            <option value="haiku">Haiku (rápido e econômico)</option>
          </Select>
        </Field>
        <Field label="Entrega">
          <Select value={withoutRepository ? 'RESULT' : form.output} onChange={(event) => set('output', event.target.value as AgentOutput)} disabled={withoutRepository}>
            {(Object.keys(outputLabels) as AgentOutput[]).map((output) => (
              <option key={output} value={output}>
                {outputLabels[output]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Ferramentas">
          <MultiSelect
            options={(Object.keys(toolLabels) as ProfileTool[]).map((tool) => ({ value: tool, label: toolLabels[tool] }))}
            selected={form.tools}
            onChange={(next) => set('tools', next as ProfileTool[])}
            placeholder="Nenhuma"
          />
        </Field>
        <div className="flex flex-col justify-end gap-2 pb-1">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.autoConclude} onChange={(event) => set('autoConclude', event.target.checked)} />
            Concluir sozinho (sem revisão)
          </label>
          {!withoutRepository && form.output === 'PULL_REQUEST' && (
            <label className="flex items-center gap-2 text-sm" title="Se o merge falhar, o PR/MR fica aberto e o passo do workflow falha.">
              <input type="checkbox" checked={form.autoMerge} onChange={(event) => set('autoMerge', event.target.checked)} />
              Fazer o merge do PR/MR ao concluir
            </label>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending || !form.name.trim()}>
          {pending ? 'Salvando...' : 'Salvar agente'}
        </Button>
        <Button onClick={onCancel}>Cancelar</Button>
        <ErrorText error={error} />
      </div>
    </form>
  );
}
