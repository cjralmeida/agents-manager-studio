import { NavLink, Outlet } from 'react-router';

const navItems = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/workspaces', label: 'Workspaces', end: false },
  { to: '/settings', label: 'Configurações', end: false },
];

export function Layout() {
  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-panel">
        <div className="px-4 py-5 text-sm font-semibold tracking-wide">Agents Manager Studio</div>
        <nav className="flex flex-col gap-1 px-2">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm ${isActive ? 'bg-border text-white' : 'text-muted hover:bg-border/50'}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
