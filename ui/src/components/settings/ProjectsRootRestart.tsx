import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { HostHelper, StudioSettings } from '../../api/studioSettings';
import { Button } from '../Button';
import { CommandBox } from '../CopyButton';
import { Logo } from '../Logo';

type Phase = 'waiting' | 'applying' | 'restarting' | 'done' | 'error';

const POLL_MS = 2_000;
/** After this long without the new folder, the screen offers to close. */
const SLOW_MS = 4 * 60_000;

const normalize = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`/api${path}`);
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

export interface RestartTarget {
  hostPath: string;
  excluded: string[];
  /** Set when the helper got the request; null when the user runs the command by hand. */
  requestId: string | null;
  command: string;
}

/**
 * Full-screen wait while the Studio restarts with the new central folder: follows the helper, notices the
 * server going down and coming back, then rescans the workspaces.
 */
export function ProjectsRootRestart({ target, onClose }: { target: RestartTarget; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>('waiting');
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    let stopped = false;
    const startedAt = Date.now();
    const wanted = { path: normalize(target.hostPath), excluded: target.excluded.map((name) => name.toLowerCase()).sort().join(',') };

    const tick = async () => {
      const settings = await fetchJson<StudioSettings>('/studio-settings');
      if (stopped) return;
      if (!settings) {
        setPhase('restarting');
      } else if (normalize(settings.projectsRoot.hostPath) === wanted.path && [...settings.projectsRoot.excluded].sort().join(',') === wanted.excluded) {
        setPhase('done');
        await fetch('/api/workspaces/scan', { method: 'POST' }).catch(() => null);
        await queryClient.invalidateQueries();
        setTimeout(() => !stopped && onClose(), 1_500);
        return;
      } else if (target.requestId) {
        const helper = await fetchJson<HostHelper>('/host-helper');
        const result = helper?.lastResult?.id === target.requestId ? helper.lastResult : null;
        if (result?.status === 'error') {
          setPhase('error');
          setError(result.error);
          return;
        }
        if (result?.status === 'applying') setPhase('applying');
      }
      if (Date.now() - startedAt > SLOW_MS) setSlow(true);
      timer = setTimeout(() => void tick(), POLL_MS);
    };

    let timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [target, queryClient, onClose]);

  const title: Record<Phase, string> = {
    waiting: target.requestId ? 'Enviando o pedido ao ajudante do Windows...' : 'Rode o comando no PowerShell',
    applying: 'Atualizando o .env e recriando o server...',
    restarting: 'O Studio está reiniciando com a nova pasta...',
    done: 'Pronto! Relendo os workspaces...',
    error: 'A pasta central não foi trocada',
  };
  const busy = phase !== 'error' && phase !== 'done' && !(phase === 'waiting' && !target.requestId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface/95 p-6 backdrop-blur-sm">
      <div className="w-full max-w-lg space-y-5 text-center">
        <div className={`mx-auto w-fit ${busy ? 'animate-pulse' : ''}`}>
          <Logo size={64} alert={phase === 'error'} />
        </div>
        <div>
          <h2 className="text-lg font-semibold">{title[phase]}</h2>
          <p className="mt-1 text-sm text-muted">
            Nova pasta central: <code className="font-mono">{target.hostPath}</code>
          </p>
        </div>

        {phase === 'waiting' && !target.requestId && (
          <div className="space-y-2 text-left">
            <p className="text-sm text-muted">O ajudante do Windows não está rodando. Cole este comando no PowerShell; esta tela continua sozinha quando o Studio reiniciar.</p>
            <CommandBox command={target.command} />
          </div>
        )}
        {phase === 'restarting' && <p className="text-sm text-muted">Isso leva alguns segundos (no modo dev, até um minuto).</p>}
        {phase === 'error' && <p className="text-sm text-red-300">{error}</p>}
        {slow && phase !== 'error' && (
          <p className="text-sm text-amber-300">Está demorando mais que o normal. Confira o Docker Desktop e o arquivo host-helper/helper.log.</p>
        )}

        {phase !== 'done' && (
          <Button onClick={onClose} variant={phase === 'error' ? 'primary' : 'secondary'}>
            {phase === 'error' ? 'Voltar' : 'Fechar esta tela'}
          </Button>
        )}
      </div>
    </div>
  );
}
