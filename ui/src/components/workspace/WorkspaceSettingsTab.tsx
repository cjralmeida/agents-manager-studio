import { useState } from 'react';
import { Link } from 'react-router';
import { type AgentAccount, type GitAccount, useAgentAccounts, useGitAccounts } from '../../api/accounts';
import { type Skill, skillSourceLabels, useSkills } from '../../api/skills';
import { type WorkspaceDetail, useWorkspaces } from '../../api/workspaces';
import {
  type WorkspaceSettings,
  useCopyWorkspaceSettings,
  useUpdateWorkspaceSettings,
  useWorkspaceSettings,
} from '../../api/workspaceSettings';
import { remoteHost } from '../../lib/git';
import { BoardLinkSection } from '../board/BoardLinkSection';
import { RenderSection } from '../render/RenderSection';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, Field, Select } from '../form';
import { gitProviderLabels } from '../settings/GitAccountsSection';
import { groupSkills } from '../settings/SkillsSection';

export function WorkspaceSettingsTab({ workspace }: { workspace: WorkspaceDetail }) {
  const settings = useWorkspaceSettings(workspace.id);
  const agentAccounts = useAgentAccounts();
  const gitAccounts = useGitAccounts();
  const skills = useSkills();

  const error = settings.error ?? agentAccounts.error ?? gitAccounts.error ?? skills.error;
  if (error) return <ErrorText error={error} />;
  if (!settings.data || !agentAccounts.data || !gitAccounts.data || !skills.data) {
    return <p className="text-sm text-muted">Carregando...</p>;
  }

  return (
    <div className="space-y-8">
      <SettingsForm
        // Remount with fresh state whenever the saved settings change.
        key={settings.dataUpdatedAt}
        workspace={workspace}
        initial={settings.data}
        agentAccounts={agentAccounts.data}
        gitAccounts={gitAccounts.data}
        skills={skills.data}
      />
      <BoardLinkSection workspaceId={workspace.id} />
      <RenderSection workspace={workspace} />
    </div>
  );
}

interface SettingsFormProps {
  workspace: WorkspaceDetail;
  initial: WorkspaceSettings;
  agentAccounts: AgentAccount[];
  gitAccounts: GitAccount[];
  skills: Skill[];
}

function toggle(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function sameItems(a: string[], b: string[]) {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function SettingsForm({ workspace, initial, agentAccounts, gitAccounts, skills }: SettingsFormProps) {
  const [agentAccountId, setAgentAccountId] = useState(initial.agentAccountId);
  const [gitAccountIds, setGitAccountIds] = useState(initial.gitAccountIds);
  const [enabledSkillIds, setEnabledSkillIds] = useState(initial.enabledSkillIds);
  const update = useUpdateWorkspaceSettings(workspace.id);

  const isDirty =
    agentAccountId !== initial.agentAccountId ||
    !sameItems(gitAccountIds, initial.gitAccountIds) ||
    !sameItems(enabledSkillIds, initial.enabledSkillIds);

  const selectedGitAccounts = gitAccounts.filter((account) => gitAccountIds.includes(account.id));
  const selectedHosts = selectedGitAccounts.map((account) => account.host);
  const duplicatedHost = selectedHosts.find((host, index) => selectedHosts.indexOf(host) !== index);

  const projectHosts = [
    ...new Set(
      workspace.projects
        .filter((project) => !project.isMissing && project.gitRemoteUrl)
        .map((project) => remoteHost(project.gitRemoteUrl ?? ''))
        .filter((host): host is string => host !== null),
    ),
  ].sort();

  const handleSave = () => update.mutate({ agentAccountId, gitAccountIds, enabledSkillIds });

  return (
    <>
      <section className="rounded-lg border border-border bg-panel p-4">
        <h2 className="text-base font-semibold">Inteligência artificial</h2>

        <h3 className="mt-4 text-sm font-medium">Conta de agente</h3>
        <div className="mt-3 max-w-sm">
          <Field label="Claude" hint={agentAccounts.length === 0 && <NoAccountsHint tab="ai" />}>
            <Select value={agentAccountId ?? ''} onChange={(event) => setAgentAccountId(event.target.value || null)}>
              <option value="">Nenhuma</option>
              {agentAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label} ({account.tokenHint})
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <h3 className="mt-6 text-sm font-medium">Skills</h3>
        <p className="mt-1 text-xs text-muted">
          Disponíveis para os agentes deste workspace, além das que já vêm no Claude Code.
        </p>
        {groupSkills(skills).map(([source, items]) => (
          <div key={source} className="mt-3">
            <h4 className="text-xs font-medium tracking-wider text-muted uppercase">{skillSourceLabels[source]}</h4>
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
      </section>

      <section className="rounded-lg border border-border bg-panel p-4">
        <h2 className="text-base font-semibold">Git</h2>

        <h3 className="mt-4 text-sm font-medium">Contas</h3>
        <p className="mt-1 text-xs text-muted">
          O agente usa a conta cujo host é o mesmo do remote do projeto, por isso só uma conta por host.
        </p>

        {projectHosts.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="text-muted">Hosts dos projetos:</span>
            {projectHosts.map((host) => (
              <Badge key={host} tone={selectedHosts.includes(host) ? 'success' : 'warning'}>
                {host} {selectedHosts.includes(host) ? '✓' : '— sem conta'}
              </Badge>
            ))}
          </div>
        )}

        {gitAccounts.length === 0 ? (
          <p className="mt-3 text-sm">
            <NoAccountsHint tab="git" />
          </p>
        ) : (
          <ul className="mt-3 space-y-1">
            {gitAccounts.map((account) => (
              <li key={account.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={gitAccountIds.includes(account.id)}
                    onChange={() => setGitAccountIds(toggle(gitAccountIds, account.id))}
                  />
                  <Badge tone="info">{gitProviderLabels[account.provider]}</Badge>
                  <span>{account.label}</span>
                  <span className="text-xs text-muted">
                    @{account.username} · {account.host}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {duplicatedHost && (
          <p className="mt-2 text-sm text-red-300">Selecione só uma conta para {duplicatedHost}.</p>
        )}
      </section>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={handleSave} disabled={!isDirty || !!duplicatedHost || update.isPending}>
          {update.isPending ? 'Salvando...' : 'Salvar configuração'}
        </Button>
        {isDirty && <span className="text-xs text-amber-300">Alterações não salvas</span>}
        <ErrorText error={update.error} />
      </div>

      <CopySettingsPanel workspaceId={workspace.id} disabled={isDirty} />
    </>
  );
}

function NoAccountsHint({ tab }: { tab: 'ai' | 'git' }) {
  return (
    <>
      Nenhuma conta cadastrada.{' '}
      <Link to={tab === 'ai' ? '/settings' : '/settings?tab=git'} className="text-accent hover:underline">
        Cadastrar em Configurações
      </Link>
    </>
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
        Conta de agente, contas git e skills substituem a configuração dos workspaces selecionados.
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
