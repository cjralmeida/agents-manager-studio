import { AgentAccountsSection } from '../components/settings/AgentAccountsSection';
import { GitAccountsSection } from '../components/settings/GitAccountsSection';
import { SkillsSection } from '../components/settings/SkillsSection';

export function SettingsPage() {
  return (
    <div className="max-w-5xl space-y-10">
      <h1 className="text-xl font-semibold">Configurações</h1>
      <GitAccountsSection />
      <AgentAccountsSection />
      <SkillsSection />
    </div>
  );
}
