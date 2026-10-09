import { useEffect, useState } from 'react';
import { type ViewProfileInput, useSaveViewProfiles, useViewProfiles } from '../../api/viewProfiles';
import { useWorkspaces } from '../../api/workspaces';
import { Button } from '../Button';
import { ErrorText, TextInput } from '../form';
import { MultiSelect } from '../MultiSelect';

/**
 * View profiles: each one shows only some workspaces (menu, dashboard, tasks, executions and usage). "Visão geral"
 * always exists and shows all of them. Nothing stops running in the workspaces a profile hides.
 */
export function ViewProfilesSection() {
  const profiles = useViewProfiles();
  const workspaces = useWorkspaces(false, true);
  const save = useSaveViewProfiles();
  const [draft, setDraft] = useState<ViewProfileInput[] | null>(null);

  useEffect(() => {
    if (profiles.data && draft === null) setDraft(profiles.data.profiles.map(({ id, name, workspaceIds }) => ({ id, name, workspaceIds })));
  }, [profiles.data, draft]);

  const error = profiles.error ?? workspaces.error;
  if (error) return <ErrorText error={error} />;
  if (!draft || !workspaces.data) return <p className="text-sm text-muted">Carregando...</p>;

  const options = workspaces.data.filter((workspace) => !workspace.isMissing).map((workspace) => ({ value: workspace.id, label: workspace.name }));
  const update = (index: number, patch: Partial<ViewProfileInput>) =>
    setDraft(draft.map((profile, position) => (position === index ? { ...profile, ...patch } : profile)));
  const saved = JSON.stringify(profiles.data?.profiles.map(({ id, name, workspaceIds }) => ({ id, name, workspaceIds })));
  const changed = JSON.stringify(draft) !== saved;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Perfis de visualização</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Cada perfil mostra só alguns workspaces no menu, no dashboard, no quadro de tarefas geral, nas execuções e no consumo. Troque de
          perfil no card do seu usuário, no fim do menu. A <strong>Visão geral</strong> sempre mostra todos. Agentes e workflows dos workspaces escondidos continuam
          rodando, e o menu avisa quando algum deles espera uma resposta sua.
        </p>
      </div>

      <ul className="space-y-2">
        <li className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-panel px-3 py-2 text-sm">
          <span className="w-56 font-medium">Visão geral</span>
          <span className="text-muted">Todos os workspaces ({options.length})</span>
        </li>
        {draft.map((profile, index) => (
          <li key={profile.id ?? `new-${index}`} className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-panel px-3 py-2">
            <label className="sr-only" htmlFor={`profile-name-${index}`}>
              Nome do perfil
            </label>
            <TextInput
              id={`profile-name-${index}`}
              value={profile.name}
              onChange={(event) => update(index, { name: event.target.value })}
              placeholder="Ex.: Tech Lead - GlobalRas"
              className="w-56"
              maxLength={60}
            />
            <div className="min-w-56 flex-1">
              <MultiSelect
                options={options}
                selected={profile.workspaceIds}
                onChange={(next) => update(index, { workspaceIds: next })}
                placeholder="Escolha os workspaces"
              />
            </div>
            <Button size="sm" variant="danger" onClick={() => setDraft(draft.filter((_, position) => position !== index))}>
              Remover
            </Button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => setDraft([...draft, { id: null, name: '', workspaceIds: [] }])}>+ Novo perfil</Button>
        <Button
          variant="primary"
          disabled={!changed || save.isPending}
          onClick={() => save.mutate(draft, { onSuccess: (result) => setDraft(result.profiles.map(({ id, name, workspaceIds }) => ({ id, name, workspaceIds }))) })}
        >
          {save.isPending ? 'Salvando...' : 'Salvar perfis'}
        </Button>
        {changed && (
          <Button onClick={() => setDraft(null)} disabled={save.isPending}>
            Descartar mudanças
          </Button>
        )}
        <ErrorText error={save.error} />
      </div>
    </section>
  );
}
