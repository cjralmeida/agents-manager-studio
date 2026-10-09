import { useState } from 'react';
import { type Skill, skillSourceLabels, useSkills } from '../../api/skills';
import { type WorkspaceDetail, useWorkspaces } from '../../api/workspaces';
import {
  type WorkspaceSettings,
  useCopyWorkspaceSettings,
  useUpdateWorkspaceSettings,
  useWorkspaceSettings,
} from '../../api/workspaceSettings';
import { BoardBehaviorSection } from '../board/BoardLinkSection';
import { AgentVariablesSection } from './AgentVariablesSection';
import { Button } from '../Button';
import { ErrorText } from '../form';
import { MultiSelect } from '../MultiSelect';
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
      <section className="rounded-lg border border-border bg-panel p-4">
        <h2 className="text-base font-semibold">Variáveis dos agentes</h2>
        <p className="mt-1 mb-3 text-xs text-muted">
          Valores que os agentes usam no container, como o login de teste em homologação. Ficam criptografados e não são mostrados de novo.
        </p>
        <AgentVariablesSection workspaceId={workspace.id} />
      </section>
      <BoardBehaviorSection workspaceId={workspace.id} />
      <CopySettingsPanel workspaceId={workspace.id} disabled={false} />
    </div>
  );
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
      <div className="mt-3 max-w-2xl">
        <MultiSelect
          options={groupSkills(skills).flatMap(([source, items]) =>
            items.map((skill) => ({ value: skill.id, label: skill.name, detail: skill.description, group: skillSourceLabels[source] })),
          )}
          selected={enabledSkillIds}
          onChange={setEnabledSkillIds}
          placeholder="Nenhuma skill extra"
        />
      </div>
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
      <div className="mt-3 max-w-md">
        <MultiSelect
          options={targets.map((workspace) => ({ value: workspace.id, label: workspace.name, detail: workspace.isIgnored ? 'ignorado' : undefined }))}
          selected={targetIds}
          onChange={setTargetIds}
          placeholder="Escolha os workspaces"
        />
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
