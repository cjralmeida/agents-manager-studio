import { useState } from 'react';
import { type PreviewBuild, useCheckPreview, usePreview, useProjectVariables, useStartPreview, useStopPreview } from '../../api/previews';
import type { Project } from '../../api/workspaces';
import { timeAgo } from '../../lib/time';
import { Badge } from '../Badge';
import { Button } from '../Button';

const short = (build: PreviewBuild) => build.commit.slice(0, 7);

const kindLabels: Record<PreviewBuild['kind'], string> = { static: 'site estático', dockerfile: 'Dockerfile', compose: 'docker compose' };

/** "docker compose · web:8080" */
const howItRuns = (build: PreviewBuild) =>
  `${kindLabels[build.kind]}${build.kind === 'static' || !build.target ? '' : ` · ${build.kind === 'dockerfile' ? `porta ${build.target}` : build.target}`}`;

/**
 * "Rodar" of a project: serves its latest stable version (the newest commit of the base branch that installed,
 * built and passed its tests) at http://<projeto>.localhost, and swaps it when a newer one passes.
 */
export function ProjectRunCell({
  project,
  variablesOpen,
  onToggleVariables,
}: {
  project: Project;
  variablesOpen: boolean;
  onToggleVariables: () => void;
}) {
  const enabled = project.isGitRepo && !project.isMissing && Boolean(project.gitRemoteUrl);
  const preview = usePreview(project.id, enabled);
  const start = useStartPreview(project.id);
  const stop = useStopPreview(project.id);
  const check = useCheckPreview(project.id);
  const [showLog, setShowLog] = useState(false);
  const variables = useProjectVariables(project.id, enabled);

  if (!enabled) return <span className="text-xs text-muted">{project.gitRemoteUrl ? '' : 'Precisa de repositório remoto'}</span>;
  const state = preview.data;
  if (!state) return <span className="text-xs text-muted">{preview.error ? preview.error.message : '...'}</span>;

  const checking = state.checking || state.latest?.status === 'RUNNING';
  const newerFailed = state.latest?.status === 'FAILED' && state.latest.id !== state.stable?.id;
  const busy = start.isPending || stop.isPending || check.isPending;
  const error = start.error ?? stop.error ?? check.error;

  return (
    <div className="min-w-56 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {state.running ? (
          <>
            <a href={state.url} target="_blank" rel="noreferrer" className="text-xs font-medium text-accent hover:underline">
              Abrir ↗
            </a>
            <Button size="sm" onClick={() => stop.mutate()} disabled={busy}>
              Parar
            </Button>
          </>
        ) : (
          <Button size="sm" variant="primary" onClick={() => start.mutate()} disabled={busy || (state.wantsUp && !state.stable)}>
            {state.wantsUp && !state.stable ? 'Preparando...' : 'Rodar'}
          </Button>
        )}
        <Button size="sm" onClick={() => check.mutate()} disabled={busy || checking} title="Verifica de novo o commit mais novo da branch base">
          {checking ? 'Verificando...' : 'Verificar agora'}
        </Button>
        <Button size="sm" onClick={onToggleVariables} aria-expanded={variablesOpen} title="Variáveis de ambiente do projeto no Rodar">
          Variáveis{variables.data?.length ? ` (${variables.data.length})` : ''}
        </Button>
      </div>

      {state.running && state.served && (
        <p className="text-xs text-muted">
          <Badge tone="success">Rodando</Badge> <span className="font-mono">{short(state.served)}</span> · {state.served.commitMessage}
          <span className="block text-[11px]">{howItRuns(state.served)}</span>
        </p>
      )}
      {!state.running && state.stable && (
        <p className="text-xs text-muted">
          Versão estável: <span className="font-mono">{short(state.stable)}</span> · verificada {timeAgo(state.stable.finishedAt ?? state.stable.startedAt)}
        </p>
      )}
      {!state.stable && !checking && !newerFailed && <p className="text-xs text-muted">Nenhuma versão verificada ainda.</p>}
      {checking && <p className="text-xs text-purple-300">Instalando, compilando e testando o commit mais novo...</p>}
      {newerFailed && state.latest && (
        <div className="text-xs">
          <p className="text-amber-300">
            {state.stable ? 'A versão mais nova' : 'A versão'} <span className="font-mono">{short(state.latest)}</span> falhou
            {state.stable ? '; segue rodando a última estável.' : '.'}{' '}
            <button type="button" className="underline" onClick={() => setShowLog((value) => !value)}>
              {showLog ? 'Esconder motivo' : 'Ver motivo'}
            </button>
          </p>
          {showLog && (
            <pre className="mt-1 max-h-48 max-w-md overflow-auto rounded border border-border bg-surface p-2 text-[11px] whitespace-pre-wrap text-gray-300">
              {state.latest.log}
            </pre>
          )}
        </div>
      )}
      {state.error && <p className="text-xs text-red-300">{state.error}</p>}
      {error && <p className="text-xs text-red-300">{error.message}</p>}
    </div>
  );
}
