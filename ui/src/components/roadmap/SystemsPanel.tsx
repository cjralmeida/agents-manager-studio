import { useEffect, useState } from 'react';
import { type SystemConfig, useSaveSystems, useSystems } from '../../api/roadmaps';
import type { WorkspaceDetail } from '../../api/workspaces';
import { Button } from '../Button';
import { ErrorText, Field, Select, TextInput } from '../form';

/**
 * The workspace's systems: which projects make one product (e.g. the API and its front) and where its documentation
 * lives — the docs home, a project and a folder in it. The system's roadmap is the roadmap.md in that folder, and every
 * agent working on one of its projects gets the folder to read. A project in no system is a system by itself,
 * documented in its own docs/.
 */
export function SystemsPanel({ workspace, onClose }: { workspace: WorkspaceDetail; onClose: () => void }) {
  const systems = useSystems(workspace.id);
  const save = useSaveSystems(workspace.id);
  const [draft, setDraft] = useState<SystemConfig[] | null>(null);

  useEffect(() => {
    if (systems.data && !draft) setDraft(systems.data.systems);
  }, [systems.data, draft]);

  if (!draft) return <p className="text-sm text-muted">Carregando...</p>;
  const projects = [...workspace.projects].sort((a, b) => a.name.localeCompare(b.name));
  const nameOf = (id: string) => projects.find((project) => project.id === id)?.name ?? '?';
  const update = (index: number, patch: Partial<SystemConfig>) => setDraft(draft.map((system, other) => (other === index ? { ...system, ...patch } : system)));
  const taken = (index: number) => new Set(draft.flatMap((system, other) => (other === index ? [] : system.projectIds)));
  const valid = draft.every((system) => system.name.trim() && system.projectIds.length > 0 && system.docsProjectId && system.docsPath.trim());

  return (
    <section className="space-y-4 rounded-lg border border-border bg-panel p-4" aria-label="Sistemas">
      <div className="flex items-center gap-2">
        <h3 className="mr-auto text-sm font-semibold">Sistemas e documentação</h3>
        <Button size="sm" onClick={onClose}>
          Fechar
        </Button>
      </div>
      <p className="text-xs text-muted">
        Um sistema é um produto feito de um ou mais projetos (ex.: a API e o front). A documentação e o roadmap dele moram num só lugar: uma pasta de um
        projeto (o repositório de documentação, ou o próprio projeto). O roadmap é o <span className="font-mono">roadmap.md</span> dessa pasta, e os agentes de
        cada projeto do sistema recebem a pasta para consultar. Projeto fora de qualquer sistema é um sistema sozinho, documentado no próprio{' '}
        <span className="font-mono">docs/</span>.
      </p>

      {draft.length === 0 && <p className="text-xs text-muted">Nenhum sistema configurado: cada projeto é um sistema sozinho.</p>}
      <ol className="space-y-3">
        {draft.map((system, index) => {
          const unavailable = taken(index);
          return (
            <li key={index} className="space-y-3 rounded-md border border-border p-3">
              <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
                <Field label="Nome do sistema">
                  <TextInput value={system.name} placeholder="Plataforma web" onChange={(event) => update(index, { name: event.target.value })} />
                </Field>
                <Field label="Documentação em">
                  <Select value={system.docsProjectId} onChange={(event) => update(index, { docsProjectId: event.target.value })}>
                    <option value="">Escolha o projeto</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Pasta" hint={`roadmap: ${system.docsPath || '…'}/roadmap.md`}>
                  <TextInput value={system.docsPath} placeholder="docs" onChange={(event) => update(index, { docsPath: event.target.value })} />
                </Field>
                <div className="flex items-end">
                  <Button size="sm" onClick={() => setDraft(draft.filter((_, other) => other !== index))}>
                    Remover
                  </Button>
                </div>
              </div>
              <Field label="Projetos" hint="o primeiro marcado é o principal (#N no roadmap)">
                <div className="flex flex-wrap gap-1">
                  {projects
                    .filter((project) => !unavailable.has(project.id))
                    .map((project) => {
                      const position = system.projectIds.indexOf(project.id);
                      return (
                        <button
                          key={project.id}
                          type="button"
                          aria-pressed={position >= 0}
                          onClick={() =>
                            update(index, {
                              projectIds: position >= 0 ? system.projectIds.filter((id) => id !== project.id) : [...system.projectIds, project.id],
                            })
                          }
                          className={`rounded border px-2 py-1 text-xs ${position >= 0 ? 'border-accent bg-accent/15' : 'border-border text-muted hover:text-white'}`}
                        >
                          {position === 0 && <span className="mr-1 text-accent">★</span>}
                          {project.name}
                        </button>
                      );
                    })}
                </div>
              </Field>
              {system.projectIds.length > 0 && (
                <p className="text-[11px] text-muted">
                  {system.projectIds.map(nameOf).join(' + ')} · roadmap em{' '}
                  <span className="font-mono">
                    {system.docsProjectId ? nameOf(system.docsProjectId) : '?'}/{system.docsPath || '…'}/roadmap.md
                  </span>
                </p>
              )}
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setDraft([...draft, { name: '', projectIds: [], docsProjectId: '', docsPath: 'docs' }])}>
          + Sistema
        </Button>
        <Button variant="primary" size="sm" disabled={save.isPending || !valid} onClick={() => save.mutate(draft.map((system) => ({ ...system, name: system.name.trim(), docsPath: system.docsPath.trim() })))}>
          {save.isPending ? 'Salvando...' : 'Salvar'}
        </Button>
        {save.isSuccess && <span className="text-xs text-emerald-300">Salvo.</span>}
        <ErrorText error={save.error} />
      </div>
    </section>
  );
}
