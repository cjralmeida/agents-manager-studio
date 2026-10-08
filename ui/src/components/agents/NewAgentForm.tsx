import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { type AgentModel, useLaunchAgent } from '../../api/agents';
import type { Project } from '../../api/workspaces';
import { Button } from '../Button';
import { ErrorText, Field, Select, TextInput } from '../form';

const models: { value: AgentModel; label: string }[] = [
  { value: 'sonnet', label: 'Sonnet (padrão)' },
  { value: 'opus', label: 'Opus (tarefas difíceis)' },
  { value: 'haiku', label: 'Haiku (rápido e econômico)' },
];

export function NewAgentForm({ projects, onCancel }: { projects: Project[]; onCancel: () => void }) {
  const available = projects.filter((project) => project.isGitRepo && !project.isMissing);
  const [projectId, setProjectId] = useState(available[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<AgentModel>('sonnet');
  const [baseBranch, setBaseBranch] = useState('');
  const launch = useLaunchAgent();
  const navigate = useNavigate();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    launch.mutate(
      { projectId, prompt, model, ...(title.trim() && { title }), ...(baseBranch.trim() && { baseBranch }) },
      { onSuccess: (agent) => navigate(`/agents/${agent.id}`) },
    );
  };

  if (available.length === 0) {
    return <p className="text-sm text-muted">Nenhum projeto com git neste workspace.</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-panel p-4">
      <h3 className="text-sm font-medium">Novo agente</h3>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Projeto">
          <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {available.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Modelo">
          <Select value={model} onChange={(event) => setModel(event.target.value as AgentModel)}>
            {models.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Branch base" hint="Vazio usa a branch atual do projeto.">
          <TextInput value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} placeholder="branch atual" />
        </Field>
      </div>
      <div className="mt-3 space-y-3">
        <Field label="Título (opcional)">
          <TextInput value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Usa a primeira linha da tarefa" />
        </Field>
        <Field
          label="Tarefa"
          hint="O agente trabalha numa cópia isolada da última versão commitada; alterações não commitadas no seu projeto não entram."
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
      <div className="mt-3 flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={launch.isPending || !prompt.trim()}>
          {launch.isPending ? 'Lançando...' : 'Lançar agente'}
        </Button>
        <Button onClick={onCancel}>Cancelar</Button>
        <ErrorText error={launch.error} />
      </div>
    </form>
  );
}
