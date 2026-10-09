import { Link } from 'react-router';
import { useMe } from '../api/auth';
import { ProjectsRootSection } from '../components/settings/ProjectsRootSection';
import { SkillsSection } from '../components/settings/SkillsSection';
import { ViewProfilesSection } from '../components/settings/ViewProfilesSection';
import { Tabs, useTabParam } from '../components/Tabs';

const tabs = [
  { id: 'general', label: 'Geral' },
  { id: 'skills', label: 'Skills' },
  { id: 'profiles', label: 'Perfis de visualização' },
] as const;

export function SettingsPage() {
  const [activeTab, setActiveTab] = useTabParam(tabs);
  const me = useMe();
  const isAdmin = me.data?.role === 'ADMIN';

  return (
    <div className="max-w-5xl">
      <h1 className="text-xl font-semibold">Configurações</h1>
      <p className="mt-1 text-sm text-muted">
        As contas do Claude, GitHub, GitLab e Render ficam em{' '}
        <Link to="/connectors" className="text-accent hover:underline">
          Conectores
        </Link>
        .
      </p>
      <div className="mt-4">
        <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
      </div>
      <div className="mt-6 space-y-10">
        {activeTab === 'skills' ? (
          <SkillsSection />
        ) : activeTab === 'profiles' ? (
          <ViewProfilesSection />
        ) : isAdmin ? (
          <ProjectsRootSection />
        ) : (
          <p className="text-sm text-muted">A pasta central é a mesma para todos os usuários e só administradores podem trocá-la.</p>
        )}
      </div>
    </div>
  );
}
