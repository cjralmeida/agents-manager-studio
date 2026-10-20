import { useLayoutEffect, useRef, useState } from 'react';
import { isWorking, useAgent, useAgents } from '../api/agents';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useMe } from '../api/auth';
import { useCapacitySuggestions } from '../api/capacity';
import { useOrbiPending } from '../api/orbi';
import { useWorkspaces } from '../api/workspaces';
import { useLiveUpdates } from '../lib/live';
import { useAgentNotifications, useNotificationSettings } from '../lib/notifications';
import { UserMenu } from './auth/UserMenu';
import { Logo } from './Logo';
import { OrbiPanel } from './orbi/OrbiPanel';

const navItems = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/orbi', label: 'Órbi', end: false },
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
  // Boards (and what depends on them) refresh as soon as the server sees a change.
  useLiveUpdates(Boolean(me.data));
  const workspaces = useWorkspaces();
  const agents = useAgents();
  /** Workspaces with an agent working / waiting for the user, to light up their menu entries. */
  const activeIds = new Set(agents.data?.filter(isWorking).map((agent) => agent.workspaceId));
  const waitingIds = new Set(agents.data?.filter((agent) => agent.status === 'WAITING_INPUT').map((agent) => agent.workspaceId));
  const items = me.data?.role === 'ADMIN' ? [...navItems, { to: '/users', label: 'Usuários', end: false }] : navItems;
  const activeWorkspaces = workspaces.data?.filter((workspace) => !workspace.isMissing) ?? [];
  const notifications = useNotificationSettings();
  const waiting = useAgentNotifications(notifications.enabled);
  const [orbiOpen, setOrbiOpen] = useState(false);
  /** Workspaces where the Gestor de Capacidade waits for a decision. */
  const capacityIds = new Set(useCapacitySuggestions().data?.map((suggestion) => suggestion.workspaceId));
  const [orbiConversation, setOrbiConversation] = useState<string | null>(null);
  /** Flags Órbi left for the user, counted on its menu entry. */
  const orbiFlags = useOrbiPending().data?.flags.length ?? 0;
  // Each page opens at its top (the content area keeps its scroll otherwise, e.g. coming back from a long
  // conversation); links to a part of a page (#pergunta) scroll there themselves.
  const { pathname, hash } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  // Before the pages' own effects, so a conversation still scrolls down to its last message after this.
  useLayoutEffect(() => {
    if (!hash) mainRef.current?.scrollTo({ top: 0 });
  }, [pathname, hash]);

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-border bg-panel">
        <NavLink to="/" className="flex items-center gap-2.5 px-4 py-5 text-sm font-semibold tracking-wide">
          <Logo size={28} alert={waiting > 0} working={activeIds.size > 0} />
          <span className="leading-tight">Agents Manager Studio</span>
        </NavLink>
        <nav className="flex flex-col gap-1 px-2">
          {items.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass}>
              {item.label}
              {item.to === '/orbi' && orbiFlags > 0 && (
                <span className="rounded-full bg-amber-400 px-1.5 text-xs font-semibold text-surface" title={`${orbiFlags} aviso(s) do Órbi para você`}>
                  {orbiFlags}
                </span>
              )}
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
              <NavLink
                key={workspace.id}
                to={`/workspaces/${workspace.id}`}
                className={(state) =>
                  `${navLinkClass(state)} ${waitingIds.has(workspace.id) ? 'glow-question' : activeIds.has(workspace.id) ? 'glow-working-row' : ''}`
                }
                title={waitingIds.has(workspace.id) ? 'Agente aguardando você' : activeIds.has(workspace.id) ? 'Agentes trabalhando' : undefined}
              >
                <span className="truncate">{workspace.name}</span>
                {capacityIds.has(workspace.id) && (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-accent" title="O Gestor de Capacidade tem uma sugestão para este workspace" />
                )}
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
      <main ref={mainRef} className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>


      {pathname === '/orbi' ? null : orbiOpen ? (
        <OrbiPanel onClose={() => setOrbiOpen(false)} onConversation={setOrbiConversation} />
      ) : orbiConversation ? (
        <OrbiFollowedButton conversationId={orbiConversation} onOpen={() => setOrbiOpen(true)} />
      ) : (
        <OrbiButton answering={false} onOpen={() => setOrbiOpen(true)} />
      )}
    </div>
  );
}

/** The Órbi button, lit while the last open conversation is still answering. */
function OrbiFollowedButton({ conversationId, onOpen }: { conversationId: string; onOpen: () => void }) {
  const conversation = useAgent(conversationId);
  const status = conversation.data?.status;
  return <OrbiButton answering={status === 'RUNNING' || status === 'PREPARING'} onOpen={onOpen} />;
}

function OrbiButton({ answering, onOpen }: { answering: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`fixed right-5 bottom-5 z-30 flex items-center gap-2 rounded-full border bg-panel py-1.5 pr-4 pl-1.5 text-sm font-medium shadow-lg transition-colors hover:border-accent/60 ${
        answering ? 'glow-working' : 'border-border'
      }`}
      title={answering ? 'O Órbi está respondendo' : 'Abrir o Órbi, o assistente do Studio'}
    >
      <Logo size={30} />
      Órbi
    </button>
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
