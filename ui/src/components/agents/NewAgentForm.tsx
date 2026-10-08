import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAgentProfiles } from '../../api/agentProfiles';
import { type AgentModel, type LaunchAgentInput, useLaunchAgent } from '../../api/agents';
import { ApiError } from '../../api/client';
import { highUsageWarnings } from '../../api/system';
import type { Project } from '../../api/workspaces';
import { Button } from '../Button';
import { ErrorText, Field, Select, TextInput } from '../form';

const models: { value: AgentModel; label: string }[] = [
  { value: 'sonnet', label: 'Sonnet (padrão)' },
  { value: 'opus', label: 'Opus (tarefas difíceis)' },
  { value: 'haiku', label: 'Haiku (rápido e econômico)' },
];

interface NewAgentFormProps {
  workspaceId: string;
  projects: Project[];
  onCancel: () => void;
  /** Pre-filled values, e.g. from a board task or a workspace agent. */
  initial?: { projectId?: string | null; title?: string; prompt?: string; profileId?: string };
  /** Board item the agent will solve. */
  taskItemId?: string;
}

export function NewAgentForm({ workspaceId, projects, onCancel, initial, taskItemId }: NewAgentFormProps) {
  const profiles = useAgentProfiles(workspaceId);
  const [profileId, setProfileId] = useState(initial?.profileId ?? '');
  const profile = profiles.data?.find((entry) => entry.id === profileId);

  const gitProjects = projects.filter((project) => project.isGitRepo && !project.isMissing);
  // A workspace agent limits the projects; one without projects works without a repository.
  const available = profile ? gitProjects.filter((project) => profile.projectIds.includes(project.id)) : gitProjects;
  const withoutRepository = profile !== undefined && profile.projectIds.length === 0;

  const [projectId, setProjectId] = useState(initial?.projectId ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [model, setModel] = useState<AgentModel | ''>('');
  const [baseBranch, setBaseBranch] = useState('');
  const launch = useLaunchAgent();
  const navigate = useNavigate();

  const selectedProject = available.find((project) => project.id === projectId) ?? available[0];
  const effectiveModel = model || profile?.model || 'sonnet';

  const submit = (input: LaunchAgentInput) =>
    launch.mutate(input, {
      onSuccess: (agent) => navigate(`/agents/${agent.id}`),
      onError: (error) => {
        // High Docker usage: the server asks for confirmation before starting another container.
        const warnings = error instanceof ApiError ? highUsageWarnings(error.details) : null;
        if (warnings && window.confirm(`${warnings.join('\n')}\n\nLançar o agente mesmo assim?`)) {
          submit({ ...input, confirmHighUsage: true });
        }
      },
    });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit({
      projectId: withoutRepository ? null : (selectedProject?.id ?? null),
      prompt,
      model: effectiveModel,
      ...(profile && { profileId: profile.id }),
      ...(title.trim() && { title }),
      ...(!withoutRepository && baseBranch.trim() && { baseBranch }),
      ...(taskItemId && { taskItemId }),
    });
  };

  const cannotLaunch = !withoutRepository && available.length === 0;

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-panel p-4">
      <h3 className="text-sm font-medium">{taskItemId ? 'Resolver tarefa com agente' : 'Novo agente'}</h3>
      {taskItemId && (
        <p className="mt-1 text-xs text-muted">
          Ao lançar, a tarefa vai para a coluna de andamento e você vira o responsável. As regras do README do quadro
          são enviadas junto. Ao concluir, o PR/MR referencia a issue e a tarefa vai para validação.
        </p>
      )}
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <Field label="Agente do workspace" hint={profile?.description || 'Avulso: só a tarefa, sem papel definido.'}>
          <Select
            value={profileId}
            onChange={(event) => {
              setProfileId(event.target.value);
              setProjectId('');
              setModel('');
            }}
          >
            <option value="">Avulso</option>
            {profiles.data?.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Projeto">
          {withoutRepository ? (
            <p className="py-1.5 text-sm text-muted">Sem repositório</p>
          ) : (
            <Select value={selectedProject?.id ?? ''} onChange={(event) => setProjectId(event.target.value)}>
              {available.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Modelo">
          <Select value={effectiveModel} onChange={(event) => setModel(event.target.value as AgentModel)}>
            {models.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        {!withoutRepository && (
          <Field label="Branch base" hint="Vazio usa a branch atual do projeto.">
            <TextInput value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} placeholder="branch atual" />
          </Field>
        )}
      </div>
      <div className="mt-3 space-y-3">
        <Field label="Título (opcional)">
          <TextInput value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Usa a primeira linha da tarefa" />
        </Field>
        <Field
          label="Tarefa"
          hint={
            withoutRepository
              ? 'O agente trabalha numa pasta vazia e entrega um resultado (e tarefas criadas, se tiver acesso ao quadro).'
              : 'O agente trabalha numa cópia isolada da última versão commitada; alterações não commitadas no seu projeto não entram.'
          }
        >
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={6}
            required
            placeholder="Descreva o que o agente deve fazer..."
            className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
          />
        </Field>
      </div>
      {cannotLaunch && (
        <p className="mt-2 text-sm text-amber-300">
          {profile ? `O agente "${profile.name}" não tem projetos com git disponíveis.` : 'Nenhum projeto com git neste workspace.'}
        </p>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={launch.isPending || !prompt.trim() || cannotLaunch}>
          {launch.isPending ? 'Lançando...' : 'Lançar agente'}
        </Button>
        <Button onClick={onCancel}>Cancelar</Button>
        <ErrorText error={launch.error} />
      </div>
    </form>
  );
}
