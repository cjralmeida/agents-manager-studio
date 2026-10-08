import { useState } from 'react';
import { type Skill, skillSourceLabels, useSkills } from '../../api/skills';
import { type WorkspaceDetail, useWorkspaces } from '../../api/workspaces';
import {
  type WorkspaceSettings,
  useCopyWorkspaceSettings,
  useUpdateWorkspaceSettings,
  useWorkspaceSettings,
} from '../../api/workspaceSettings';
import { Badge } from '../Badge';
import { BoardBehaviorSection } from '../board/BoardLinkSection';
import { Button } from '../Button';
import { ErrorText } from '../form';
import { groupSkills } from '../settings/SkillsSection';

/** What belongs only to the workspace: skills, how the board is handled, copying the setup. Tools live in Conectores. */
export function WorkspaceSettingsTab({ workspace }: { workspace: WorkspaceDetail }) {
  const settings = useWorkspaceSettings(workspace.id);
  const skills = useSkills();

  const error = settings.error ?? skills.error;
  if (error) return <ErrorText error={error} />;
  if (!settings.data || !skills.data) return <p className="text-sm text-muted">Carregando...</p>;

  return (
    <div className="max-w-5xl space-y-8">
      <SkillsForm
        // Remount with fresh state whenever the saved settings change.
        key={settings.dataUpdatedAt}
        workspace={workspace}
        initial={settings.data}
        skills={skills.data}
      />
      <BoardBehaviorSection workspaceId={workspace.id} />
      <CopySettingsPanel workspaceId={workspace.id} disabled={false} />
    </div>
  );
}

function toggle(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function sameItems(a: string[], b: string[]) {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function SkillsForm({ workspace, initial, skills }: { workspace: WorkspaceDetail; initial: WorkspaceSettings; skills: Skill[] }) {
  const [enabledSkillIds, setEnabledSkillIds] = useState(initial.enabledSkillIds);
  const update = useUpdateWorkspaceSettings(workspace.id);
  const isDirty = !sameItems(enabledSkillIds, initial.enabledSkillIds);

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-base font-semibold">Skills</h2>
      <p className="mt-1 text-xs text-muted">Disponíveis para os agentes deste workspace, além das que já vêm no Claude Code.</p>
      {groupSkills(skills).map(([source, items]) => (
        <div key={source} className="mt-3">
          <h3 className="text-xs font-medium tracking-wider text-muted uppercase">{skillSourceLabels[source]}</h3>
          <ul className="mt-2 grid grid-cols-1 gap-1 lg:grid-cols-2">
            {items.map((skill) => (
              <li key={skill.id}>
                <label className="flex items-start gap-2 text-sm" title={skill.description}>
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={enabledSkillIds.includes(skill.id)}
                    onChange={() => setEnabledSkillIds(toggle(enabledSkillIds, skill.id))}
                  />
                  <span>
                    {skill.name}
                    <span className="line-clamp-1 text-xs text-muted">{skill.description}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" onClick={() => update.mutate({ ...initial, enabledSkillIds })} disabled={!isDirty || update.isPending}>
          {update.isPending ? 'Salvando...' : 'Salvar skills'}
        </Button>
        {isDirty && <span className="text-xs text-amber-300">Alterações não salvas</span>}
        <ErrorText error={update.error} />
      </div>
    </section>
  );
}

function CopySettingsPanel({ workspaceId, disabled }: { workspaceId: string; disabled: boolean }) {
  const workspaces = useWorkspaces(true);
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const copy = useCopyWorkspaceSettings(workspaceId);

  const targets = workspaces.data?.filter((workspace) => workspace.id !== workspaceId && !workspace.isMissing) ?? [];

  const handleCopy = () => {
    const names = targets.filter((workspace) => targetIds.includes(workspace.id)).map((workspace) => workspace.name);
    if (window.confirm(`Substituir a configuração de: ${names.join(', ')}?`)) {
      copy.mutate(targetIds, { onSuccess: () => setTargetIds([]) });
    }
  };

  return (
    <section className="rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium">Copiar configuração</h3>
      <p className="mt-1 text-xs text-muted">
        A conta Claude, as contas git (aba Conectores) e as skills substituem as dos workspaces selecionados. O quadro e o
        Render são próprios de cada workspace e não são copiados.
      </p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {targets.map((workspace) => (
          <label key={workspace.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={targetIds.includes(workspace.id)}
              onChange={() => setTargetIds(toggle(targetIds, workspace.id))}
            />
            {workspace.name}
            {workspace.isIgnored && <Badge>Ignorado</Badge>}
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={handleCopy} disabled={disabled || targetIds.length === 0 || copy.isPending}>
          Copiar para {targetIds.length || ''} workspace(s)
        </Button>
        {disabled && <span className="text-xs text-muted">Salve antes de copiar.</span>}
        {copy.isSuccess && (
          <span className="text-xs text-emerald-300">Copiado para {copy.data.copiedTo} workspace(s).</span>
        )}
        <ErrorText error={copy.error} />
      </div>
    </section>
  );
}
