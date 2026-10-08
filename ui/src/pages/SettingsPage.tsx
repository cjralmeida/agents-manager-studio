import { AgentAccountsSection } from '../components/settings/AgentAccountsSection';
import { GitAccountsSection } from '../components/settings/GitAccountsSection';
import { SkillsSection } from '../components/settings/SkillsSection';
import { Tabs, useTabParam } from '../components/Tabs';

const tabs = [
  { id: 'ai', label: 'Inteligência artificial' },
  { id: 'git', label: 'Git' },
] as const;

export function SettingsPage() {
  const [activeTab, setActiveTab] = useTabParam(tabs);

  return (
    <div className="max-w-5xl">
      <h1 className="text-xl font-semibold">Configurações</h1>
      <div className="mt-4">
        <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
      </div>
      <div className="mt-6 space-y-10">
        {activeTab === 'ai' ? (
          <>
            <AgentAccountsSection />
            <SkillsSection />
          </>
        ) : (
          <GitAccountsSection />
        )}
      </div>
    </div>
  );
}
