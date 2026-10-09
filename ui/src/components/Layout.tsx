import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useMe } from '../api/auth';
import { useWorkspaces } from '../api/workspaces';
import { useAgentNotifications, useNotificationSettings } from '../lib/notifications';
import { UserMenu } from './auth/UserMenu';
import { Logo } from './Logo';
import { OrbiPanel } from './orbi/OrbiPanel';
import { ViewProfileSwitcher } from './ViewProfileSwitcher';

const navItems = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/workspaces', label: 'Workspaces', end: true },
  { to: '/board', label: 'Quadro de tarefas', end: false },
  { to: '/connectors', label: 'Conectores', end: false },
  { to: '/settings', label: 'Configurações', end: false },
];

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `flex items-center justify-between gap-2 truncate rounded-md px-3 py-2 text-sm ${isActive ? 'bg-border text-white' : 'text-muted hover:bg-border/50'}`;
}

export function Layout() {
  const me = useMe();
  const workspaces = useWorkspaces();
  const items = me.data?.role === 'ADMIN' ? [...navItems, { to: '/users', label: 'Usuários', end: false }] : navItems;
  const activeWorkspaces = workspaces.data?.filter((workspace) => !workspace.isMissing) ?? [];
  const notifications = useNotificationSettings();
  const waiting = useAgentNotifications(notifications.enabled);
  const [orbiOpen, setOrbiOpen] = useState(false);

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-border bg-panel">
        <NavLink to="/" className="flex items-center gap-2.5 px-4 py-5 text-sm font-semibold tracking-wide">
          <Logo size={28} alert={waiting > 0} />
          <span className="leading-tight">Agents Manager Studio</span>
        </NavLink>
        <div className="px-3 pb-3">
          <ViewProfileSwitcher />
        </div>
        <nav className="flex flex-col gap-1 px-2">
          {items.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass}>
              {item.label}
              {item.to === '/' && waiting > 0 && (
                <span
                  className="rounded-full bg-amber-400 px-1.5 text-xs font-semibold text-surface"
                  title={`${waiting} agente(s) aguardando você`}
                >
                  {waiting}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        {activeWorkspaces.length > 0 && (
          <nav className="mt-6 flex flex-col gap-1 px-2">
            <h2 className="px-3 pb-1 text-xs font-medium tracking-wider text-muted uppercase">Workspaces</h2>
            {activeWorkspaces.map((workspace) => (
              <NavLink key={workspace.id} to={`/workspaces/${workspace.id}`} className={navLinkClass}>
                {workspace.name}
              </NavLink>
            ))}
          </nav>
        )}

        <div className="mt-auto border-t border-border px-4 py-3 text-xs">
          <NotificationControl {...notifications} />
        </div>
        {me.data && (
          <div className="border-t border-border p-2">
            <UserMenu user={me.data} />
          </div>
        )}
      </aside>
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>

      {orbiOpen ? (
        <OrbiPanel onClose={() => setOrbiOpen(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setOrbiOpen(true)}
          className="fixed right-5 bottom-5 z-30 flex items-center gap-2 rounded-full border border-border bg-panel py-1.5 pr-4 pl-1.5 text-sm font-medium shadow-lg transition-colors hover:border-accent/60"
          title="Abrir o Órbi, o assistente do Studio"
        >
          <Logo size={30} />
          Órbi
        </button>
      )}
    </div>
  );
}

function NotificationControl({
  permission,
  muted,
  request,
  setMuted,
}: ReturnType<typeof useNotificationSettings>) {
  if (permission === 'unsupported') return <p className="text-muted">Navegador sem notificações.</p>;
  if (permission === 'denied') {
    return <p className="text-muted">Notificações bloqueadas. Libere nas permissões do site no navegador.</p>;
  }
  if (permission === 'default') {
    return (
      <button type="button" onClick={() => void request()} className="text-accent hover:underline">
        Ativar notificações
      </button>
    );
  }
  return (
    <label className="flex items-center gap-2 text-muted">
      <input type="checkbox" checked={!muted} onChange={(event) => setMuted(!event.target.checked)} />
      Notificações do navegador
    </label>
  );
}
