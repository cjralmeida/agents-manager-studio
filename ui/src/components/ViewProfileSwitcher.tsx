import { Link } from 'react-router';
import { useSetActiveViewProfile, useViewProfiles } from '../api/viewProfiles';

/** Which workspaces the Studio shows: "Visão geral" (all) or one of the user's view profiles. */
export function ViewProfileSwitcher() {
  const profiles = useViewProfiles();
  const setActive = useSetActiveViewProfile();
  if (!profiles.data) return null;
  const { activeId, hiddenWaiting } = profiles.data;

  if (profiles.data.profiles.length === 0) {
    return (
      <Link to="/settings?tab=profiles" className="block px-1 text-xs text-muted hover:text-accent" title="Mostre só alguns workspaces, por papel ou área">
        Criar perfis de visualização
      </Link>
    );
  }

  return (
    <div className="space-y-1">
      <label htmlFor="view-profile" className="sr-only">
        Perfil de visualização
      </label>
      <select
        id="view-profile"
        value={activeId ?? ''}
        onChange={(event) => setActive.mutate(event.target.value || null)}
        disabled={setActive.isPending}
        className="w-full truncate rounded-md border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
        title="Perfil de visualização: quais workspaces aparecem no Studio"
      >
        <option value="">Visão geral (todos os workspaces)</option>
        {profiles.data.profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
      {hiddenWaiting > 0 && (
        <button
          type="button"
          onClick={() => setActive.mutate(null)}
          className="block w-full rounded px-1 text-left text-[11px] text-amber-300 hover:underline"
          title="Agentes de workspaces fora deste perfil esperam uma resposta sua"
        >
          {hiddenWaiting} aguardando você em outros workspaces
        </button>
      )}
    </div>
  );
}
