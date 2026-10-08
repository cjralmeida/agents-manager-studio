import { useStudioSettings } from '../../api/studioSettings';
import { ErrorText } from '../form';

/** The central folder: where workspaces live and where new ones are created. */
export function ProjectsRootSection() {
  const settings = useStudioSettings();
  const root = settings.data?.projectsRoot;

  return (
    <section>
      <h2 className="text-base font-semibold">Pasta central</h2>
      <p className="mt-1 text-sm text-muted">
        Cada pasta dentro dela é um workspace, e os workspaces novos são criados aqui. O Studio só escreve nesta pasta.
      </p>
      <ErrorText error={settings.error} />
      {root && (
        <div className="mt-4 space-y-3 rounded-lg border border-border bg-panel p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Pasta atual:</span>
            <code className="rounded bg-surface px-2 py-0.5 font-mono text-xs">{root.hostPath}</code>
          </div>
          {root.excluded.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted">Pastas ignoradas:</span>
              {root.excluded.map((name) => (
                <code key={name} className="rounded bg-surface px-2 py-0.5 font-mono text-xs">
                  {name}
                </code>
              ))}
            </div>
          )}
          <div className="text-xs text-muted">
            <p>Para trocar a pasta central:</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              <li>
                Mude <code className="font-mono">PROJECTS_HOST_DIR</code> (e, se quiser, <code className="font-mono">SCAN_EXCLUDE</code>) no
                arquivo <code className="font-mono">.env</code> do Studio.
              </li>
              <li>
                Rode <code className="font-mono">docker compose up -d</code> para remontar a pasta no server.
              </li>
              <li>Clique em "Reler diretório" na página Workspaces.</li>
            </ol>
          </div>
        </div>
      )}
    </section>
  );
}
