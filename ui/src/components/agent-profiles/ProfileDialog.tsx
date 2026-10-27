import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { type AgentProfile, type AgentProfileInput, type AgentOutput, type ProfileTool, outputLabels, toolLabels } from '../../api/agentProfiles';
import type { AgentModel } from '../../api/agents';
import { SIZE_NAMES, type SizeName } from '../../api/resourceSettings';
import type { WorkspaceDetail } from '../../api/workspaces';
import { Button } from '../Button';
import { ErrorText, Field, Select, TextInput } from '../form';
import { MultiSelect } from '../MultiSelect';

const empty: AgentProfileInput = {
  name: '',
  description: '',
  instructions: '',
  model: 'sonnet',
  projectIds: [],
  contextProjectIds: [],
  anyProject: false,
  output: 'PULL_REQUEST',
  tools: [],
  autoConclude: false,
  autoMerge: false,
  resourceSize: null,
};

const sizeLabels: Record<SizeName, string> = { P: 'P (leve)', M: 'M (front e testes)', G: 'G (backend)', GG: 'GG (o maior)' };

/** The editable fields of a saved agent (the rest is read-only and the server refuses it). */
function pickInput(profile: AgentProfile): AgentProfileInput {
  return Object.fromEntries((Object.keys(empty) as (keyof AgentProfileInput)[]).map((key) => [key, profile[key]])) as AgentProfileInput;
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted">{hint}</p>
      </div>
      {children}
    </section>
  );
}

interface ProfileDialogProps {
  workspace: WorkspaceDetail;
  initial?: AgentProfile;
  pending: boolean;
  error: Error | null;
  onSubmit: (input: AgentProfileInput) => void;
  onClose: () => void;
}

/** Creating or editing a workspace agent, in a window over the list: who it is, where it works, how it delivers. */
export function ProfileDialog({ workspace, initial, pending, error, onSubmit, onClose }: ProfileDialogProps) {
  const [form, setForm] = useState<AgentProfileInput>(initial ? pickInput(initial) : empty);
  const set = <K extends keyof AgentProfileInput>(key: K, value: AgentProfileInput[K]) => setForm((current) => ({ ...current, [key]: value }));
  const gitProjects = workspace.projects.filter((project) => project.isGitRepo && !project.isMissing);
  const withoutRepository = form.projectIds.length === 0 && !form.anyProject;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({ ...form, output: withoutRepository ? 'RESULT' : form.output });
  };

  return (
    // A click outside does not close it: a long form would be lost by accident (Esc and the buttons close it).
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-6">
      <form onSubmit={handleSubmit} className="w-full max-w-3xl rounded-xl border border-border bg-surface shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border p-5">
          <div>
            <h2 className="text-lg font-semibold">{initial ? `Editar "${initial.name}"` : 'Novo agente do workspace'}</h2>
            <p className="mt-1 text-xs text-muted">Um agente fixo com um papel: você o executa à mão ou o usa nas etapas de um workflow.</p>
          </div>
          <Button size="sm" onClick={onClose}>
            Fechar
          </Button>
        </div>

        <div className="space-y-5 p-5">
          <Section title="Quem é" hint="O nome aparece nos workflows; o papel vai para o prompt de sistema de toda execução.">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Field label="Nome">
                <TextInput value={form.name} onChange={(event) => set('name', event.target.value)} placeholder="Ex.: Documentador" required autoFocus />
              </Field>
              <div className="md:col-span-2">
                <Field label="Descrição curta">
                  <TextInput
                    value={form.description}
                    onChange={(event) => set('description', event.target.value)}
                    placeholder="Ex.: Escreve a documentação no repositório de docs"
                  />
                </Field>
              </div>
            </div>
            <Field label="Papel e instruções">
              <textarea
                value={form.instructions}
                onChange={(event) => set('instructions', event.target.value)}
                rows={6}
                placeholder="Ex.: Você documenta funcionalidades. Escreva em Markdown na pasta docs/, uma página por funcionalidade..."
                className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
              />
            </Field>
            <div className="max-w-xs">
              <Field label="Modelo">
                <Select value={form.model} onChange={(event) => set('model', event.target.value as AgentModel)}>
                  <option value="sonnet">Sonnet (padrão)</option>
                  <option value="opus">Opus (tarefas difíceis)</option>
                  <option value="haiku">Haiku (rápido e econômico)</option>
                </Select>
              </Field>
            </div>
          </Section>

          <Section title="Onde trabalha" hint="Os repositórios que ele altera e os que só consulta.">
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted">Projetos em que trabalha</span>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.anyProject} onChange={(event) => set('anyProject', event.target.checked)} />
                No projeto do workflow (qualquer projeto do workspace, ex.: o que um passo anterior criou)
              </label>
              {!form.anyProject && (
                <MultiSelect
                  options={gitProjects.map((project) => ({ value: project.id, label: project.name }))}
                  selected={form.projectIds}
                  onChange={(next) => set('projectIds', next)}
                  placeholder="Nenhum (sem repositório)"
                />
              )}
              <p className="text-xs text-muted">
                {form.anyProject
                  ? 'O workflow passa o projeto; ao executar à mão, você escolhe qualquer projeto do workspace.'
                  : withoutRepository
                    ? 'Nenhum marcado: o agente trabalha sem repositório e entrega um resultado.'
                    : 'Ao executar, você escolhe um destes projetos.'}
              </p>
            </div>
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted">Projetos de consulta (só leitura)</span>
              <MultiSelect
                options={workspace.projects.filter((project) => !project.isMissing).map((project) => ({ value: project.id, label: project.name }))}
                selected={form.contextProjectIds}
                onChange={(next) => set('contextProjectIds', next)}
                placeholder="Nenhum"
              />
              <p className="text-xs text-muted">
                O agente lê a pasta como está no seu disco (inclusive arquivos fora do git), sem poder alterar. Útil para documentar ou planejar a
                partir do código de outros projetos.
              </p>
            </div>
          </Section>

          <Section title="Como entrega" hint="O que ele produz, as ferramentas do Studio que pode usar e o que acontece ao terminar.">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Entrega">
                <Select
                  value={withoutRepository ? 'RESULT' : form.output}
                  onChange={(event) => set('output', event.target.value as AgentOutput)}
                  disabled={withoutRepository}
                >
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
            </div>
            <div className="flex flex-col gap-2">
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
          </Section>

          <Section title="Recursos da máquina" hint="CPU e memória do container de cada execução.">
            <div className="max-w-xs">
              <Field
                label="Tamanho"
                hint={
                  <>
                    Valores de cada tamanho em{' '}
                    <Link to="/settings?tab=resources" className="text-accent hover:underline">
                      Configurações → Recursos
                    </Link>
                    .
                  </>
                }
              >
                <Select value={form.resourceSize ?? ''} onChange={(event) => set('resourceSize', (event.target.value || null) as SizeName | null)}>
                  <option value="">Automático pelo papel{initial ? ` (${initial.roleSize})` : ''}</option>
                  {SIZE_NAMES.map((name) => (
                    <option key={name} value={name}>
                      {sizeLabels[name]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </Section>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border p-5">
          <Button type="submit" variant="primary" disabled={pending || !form.name.trim()}>
            {pending ? 'Salvando...' : 'Salvar agente'}
          </Button>
          <Button onClick={onClose}>Cancelar</Button>
          <ErrorText error={error} />
        </div>
      </form>
    </div>
  );
}
