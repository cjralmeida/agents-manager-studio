import { Link } from 'react-router';
import { useSetActiveViewProfile, useViewProfiles } from '../api/viewProfiles';

/** Name of the active view profile ("Visão geral" when it shows every workspace). */
export function useActiveViewProfileName() {
  const profiles = useViewProfiles();
  const active = profiles.data?.profiles.find((profile) => profile.id === profiles.data?.activeId);
  return active?.name ?? 'Visão geral';
}

/** Inside the user menu: which workspaces the Studio shows, "Visão geral" (all) or one of the user's profiles. */
export function ViewProfileOptions({ onPicked }: { onPicked: () => void }) {
  const profiles = useViewProfiles();
  const setActive = useSetActiveViewProfile();
  if (!profiles.data) return null;
  const activeId = profiles.data.activeId;
  const choices = [{ id: null, name: 'Visão geral', detail: 'Todos os workspaces' }, ...profiles.data.profiles.map((profile) => ({ ...profile, detail: null }))];

  return (
    <div>
      <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wider text-muted uppercase">Perfil</p>
      <div className="flex flex-col gap-0.5" role="radiogroup" aria-label="Perfil de visualização">
        {choices.map((choice) => {
          const selected = choice.id === activeId;
          return (
            <button
              key={choice.id ?? 'all'}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={setActive.isPending}
              onClick={() => {
                if (!selected) setActive.mutate(choice.id, { onSuccess: onPicked });
              }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${selected ? 'bg-border text-white' : 'hover:bg-border/60'}`}
            >
              <span className={`size-2 shrink-0 rounded-full ${selected ? 'bg-accent' : 'border border-muted'}`} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{choice.name}</span>
              {choice.detail && <span className="shrink-0 text-xs text-muted">{choice.detail}</span>}
            </button>
          );
        })}
      </div>
      <Link to="/settings?tab=profiles" onClick={onPicked} className="mt-1 block px-2 py-1 text-xs text-muted hover:text-accent">
        {profiles.data.profiles.length === 0 ? 'Criar perfis de visualização' : 'Gerenciar perfis'}
      </Link>
    </div>
  );
}

/** Under the user card: executions waiting for an answer in workspaces the active profile hides. */
export function HiddenWaitingNotice() {
  const profiles = useViewProfiles();
  const setActive = useSetActiveViewProfile();
  const count = profiles.data?.hiddenWaiting ?? 0;
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={() => setActive.mutate(null)}
      className="block w-full rounded px-2 pt-1 text-left text-[11px] text-amber-300 hover:underline"
      title="Agentes de workspaces fora deste perfil esperam uma resposta sua; clique para ver todos"
    >
      {count} aguardando você em outros workspaces
    </button>
  );
}
