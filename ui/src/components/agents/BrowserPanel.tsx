import { type Agent, LIVE_STATUSES, agentFileUrl, useAgentBrowser, useAgentTestFailures } from '../../api/agents';

/**
 * What the agent sees in its browser (Playwright): live while a browser is open — one picture per page, refreshed
 * from Chromium's screencast while this panel is on screen — and, after a run, the screenshot, video and trace of
 * each failed test. View only: nothing here clicks or navigates.
 */
export function BrowserPanel({ agent }: { agent: Agent }) {
  const isLive = LIVE_STATUSES.includes(agent.status);
  const browser = useAgentBrowser(agent.id, isLive);
  const failures = useAgentTestFailures(agent.id, isLive);
  const pages = browser.data?.live ? browser.data.pages : [];
  const failed = failures.data ?? [];
  if (pages.length === 0 && failed.length === 0) return null;

  return (
    <div className="mt-4 space-y-4">
      {pages.length > 0 && (
        <section className="rounded-lg border border-border bg-panel p-3" aria-label="Navegador ao vivo">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-400" aria-hidden />
            Navegador ao vivo
            <span className="text-xs font-normal text-muted">só para assistir</span>
          </h2>
          <div className={`mt-3 grid gap-3 ${pages.length > 1 ? 'md:grid-cols-2' : ''}`}>
            {pages.map((page) => (
              <figure key={page.id} className="overflow-hidden rounded-md border border-border bg-surface">
                <figcaption className="truncate border-b border-border px-2 py-1 font-mono text-[11px] text-muted" title={page.url}>
                  {page.title ? `${page.title} · ` : ''}
                  {page.url}
                </figcaption>
                {page.frameAt ? (
                  <img src={`/api/agents/${agent.id}/browser/${page.id}?t=${page.frameAt}`} alt={`Tela de ${page.title || page.url}`} className="block w-full" />
                ) : (
                  <p className="p-6 text-center text-xs text-muted">Esperando a primeira imagem...</p>
                )}
              </figure>
            ))}
          </div>
        </section>
      )}

      {failed.length > 0 && (
        <section className="rounded-lg border border-border bg-panel p-3" aria-label="Falhas dos testes">
          <h2 className="text-sm font-semibold">
            Falhas da última execução dos testes <span className="font-normal text-muted">· {failed.length}</span>
          </h2>
          <p className="mt-1 text-xs text-muted">
            O trace mostra passo a passo o que o teste fez (telas, cliques, rede, console): baixe e abra em{' '}
            <a href="https://trace.playwright.dev" target="_blank" rel="noreferrer" className="text-accent hover:underline">
              trace.playwright.dev
            </a>{' '}
            (o arquivo abre no seu navegador, nada é enviado).
          </p>
          <ul className="mt-3 grid gap-3 md:grid-cols-2">
            {failed.map((failure) => (
              <li key={failure.name} className="rounded-md border border-border p-2">
                <p className="truncate text-xs font-medium" title={failure.name}>
                  {failure.name}
                </p>
                <p className="text-[11px] text-muted">{new Date(failure.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
                {failure.screenshots.slice(0, 1).map((shot) => (
                  <a key={shot} href={agentFileUrl(agent.id, shot)} target="_blank" rel="noreferrer">
                    <img src={agentFileUrl(agent.id, shot)} alt={`Tela na falha de ${failure.name}`} loading="lazy" className="mt-2 block max-h-48 w-full rounded border border-border object-contain object-top" />
                  </a>
                ))}
                <div className="mt-2 flex gap-3 text-xs">
                  {failure.trace && (
                    <a href={agentFileUrl(agent.id, failure.trace)} download className="text-accent hover:underline">
                      Baixar trace
                    </a>
                  )}
                  {failure.video && (
                    <a href={agentFileUrl(agent.id, failure.video)} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                      Vídeo
                    </a>
                  )}
                  {failure.screenshots.length > 1 && <span className="text-muted">+{failure.screenshots.length - 1} captura(s)</span>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
