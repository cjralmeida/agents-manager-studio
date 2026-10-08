import { NavLink, Outlet } from 'react-router';
import { useWorkspaces } from '../api/workspaces';

const navItems = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/workspaces', label: 'Workspaces', end: true },
  { to: '/settings', label: 'Configurações', end: false },
];

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `block truncate rounded-md px-3 py-2 text-sm ${isActive ? 'bg-border text-white' : 'text-muted hover:bg-border/50'}`;
}

export function Layout() {
  const workspaces = useWorkspaces();
  const activeWorkspaces = workspaces.data?.filter((workspace) => !workspace.isMissing) ?? [];

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-border bg-panel">
        <div className="px-4 py-5 text-sm font-semibold tracking-wide">Agents Manager Studio</div>
        <nav className="flex flex-col gap-1 px-2">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass}>
              {item.label}
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
      </aside>
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
