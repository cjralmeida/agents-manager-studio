import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { formatBytes, useDiskMaintenance, useDiskUsage, useResourceUsage } from '../api/system';
import { Button } from '../components/Button';
import { ErrorText } from '../components/form';
import { timeAgo } from '../lib/time';

interface CompactionStatus {
  helperOnline: boolean;
  installCommand: string;
  statusPage: string;
  running: boolean;
  request: { id: string; requestedAt: string; resumePending: boolean; resumedAt: string | null } | null;
  run: {
    id: string;
    status: 'running' | 'done' | 'error';
    step: 'starting' | 'stopping_docker' | 'compacting' | 'starting_docker' | 'starting_studio' | 'finished';
    percent: number | null;
    sizeBefore: number | null;
    sizeAfter: number | null;
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
  } | null;
}

const STEPS: [string, string][] = [
  ['pausing', 'Pausando os workspaces, parando os agentes e limpando'],
  ['stopping_docker', 'Parando o Docker'],
  ['compacting', 'Comprimindo o arquivo do disco (diskpart, como administrador)'],
  ['starting_docker', 'Ligando o Docker'],
  ['starting_studio', 'Ligando o Studio'],
  ['resuming', 'Retomando os workspaces e os agentes'],
];

/**
 * Compacting Docker's disk file (only on request). The Studio pauses everything and asks the Windows helper, which
 * stops Docker — the Studio goes down — so the progress continues on the helper's own page until it is back.
 */
export function CompactionPage() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['system', 'compaction'],
    queryFn: () => api.get<CompactionStatus>('/system/compaction'),
    refetchInterval: 3_000,
    retry: false,
  });
  const disk = useDiskUsage();
  const resources = useResourceUsage();
  const maintenance = useDiskMaintenance();
  const start = useMutation({
    mutationFn: () => api.post<CompactionStatus>('/system/compaction'),
    onSuccess: (data) => queryClient.setQueryData(['system', 'compaction'], data),
  });
  const [confirming, setConfirming] = useState(false);
  const data = status.data;
  const agentsDisk = resources.data?.host?.disks.find((entry) => entry.agents);
  const vhdx = disk.data?.dockerDisk;
  // The Studio stops with Docker: while a compaction runs and it cannot be reached, the helper's page takes over.
  const unreachable = Boolean(status.error) && (data?.running || start.isSuccess);
  useEffect(() => {
    if (unreachable && data?.statusPage) window.location.href = data.statusPage;
  }, [unreachable, data?.statusPage]);

  const stepIndex = (() => {
    if (!data?.request) return -1;
    const run = data.run;
    if (!run || run.step === 'starting') return 0;
    if (run.step === 'finished') return data.request.resumePending ? 5 : STEPS.length;
    return STEPS.findIndex(([id]) => id === run.step);
  })();
  const active = Boolean(data?.running);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Compressão do disco do Docker</h1>
        <p className="mt-1 text-sm text-muted">
          O Docker guarda tudo num arquivo de disco no Windows que cresce e não devolve espaço sozinho. A limpeza automática (todo dia) libera espaço
          dentro dele; a compressão encolhe o arquivo e devolve esse espaço ao Windows. Ela para tudo por uns 40 minutos.
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-3">
        <Stat label="Arquivo do disco do Docker" value={vhdx ? formatBytes(vhdx.fileBytes) : '?'} hint={vhdx ? `${formatBytes(vhdx.dataBytes)} em uso de fato` : undefined} />
        <Stat
          label={`Livre no ${agentsDisk?.drive ?? 'disco'}`}
          value={agentsDisk ? formatBytes(agentsDisk.free) : '?'}
          hint={vhdx ? `a compressão deve devolver uns ${formatBytes(Math.max(0, vhdx.fileBytes - vhdx.dataBytes))}` : undefined}
        />
        <Stat label="Última limpeza automática" value={maintenance.data ? timeAgo(maintenance.data.at) : 'ainda não rodou'} hint={maintenance.data?.error ?? undefined} />
      </section>

      <section className="rounded-xl border border-border bg-panel p-4">
        {!data ? (
          <ErrorText error={status.error} />
        ) : !data.helperOnline && !active ? (
          <div className="space-y-2 text-sm">
            <p className="text-amber-300">O helper do Windows não está rodando. Ele é quem desliga e religa o Docker durante a compressão.</p>
            <p className="text-muted">Rode no PowerShell, na pasta do Studio:</p>
            <code className="block rounded bg-surface px-2 py-1.5 text-xs break-all">{data.installCommand}</code>
          </div>
        ) : active || data.run ? (
          <div className="space-y-3">
            <ol className="space-y-1.5">
              {STEPS.map(([id, label], index) => (
                <li
                  key={id}
                  className={`rounded-lg border px-3 py-2 text-sm ${
                    index < stepIndex ? 'border-emerald-500/40 text-emerald-300' : index === stepIndex && active ? 'border-accent text-white' : 'border-border text-muted'
                  }`}
                >
                  {label}
                  {id === 'compacting' && index === stepIndex && data.run?.percent != null && ` · ${data.run.percent}%`}
                </li>
              ))}
            </ol>
            {data.run?.step === 'compacting' && (
              <div className="h-2 overflow-hidden rounded bg-border">
                <div className="h-full bg-accent transition-all" style={{ width: `${data.run.percent ?? 0}%` }} />
              </div>
            )}
            {data.run && (
              <p className="text-xs text-muted">
                Antes: {data.run.sizeBefore ? formatBytes(data.run.sizeBefore) : '?'}
                {data.run.sizeAfter && ` · depois: ${formatBytes(data.run.sizeAfter)} (${formatBytes((data.run.sizeBefore ?? 0) - data.run.sizeAfter)} devolvidos ao Windows)`}
                {data.run.finishedAt && ` · terminou ${timeAgo(data.run.finishedAt)}`}
              </p>
            )}
            {data.run?.error && <p className="text-sm text-red-300">A compressão não terminou: {data.run.error}. O Docker e o Studio foram religados e os agentes, retomados.</p>}
            {active && (
              <p className="text-xs text-muted">
                Quando o Docker desligar, o Studio sai do ar: esta página leva você para{' '}
                <a href={data.statusPage} className="text-accent hover:underline">
                  {data.statusPage}
                </a>
                , a página do helper, que mostra o andamento até o Studio voltar. O Windows vai pedir permissão de administrador para o diskpart: aprove.
              </p>
            )}
            {!active && (
              <Button size="sm" onClick={() => setConfirming(true)}>
                Comprimir de novo
              </Button>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted">Nenhuma compressão feita por aqui ainda.</p>
        )}

        {data && !active && (data.helperOnline || data.run) && (
          <div className="mt-4 border-t border-border pt-4">
            {!confirming ? (
              !data.run && (
                <Button variant="primary" onClick={() => setConfirming(true)}>
                  Iniciar compressão
                </Button>
              )
            ) : (
              <div className="space-y-2 text-sm">
                <p>
                  Isso pausa todos os workspaces e para os agentes (eles continuam de onde pararam depois), desliga o Docker e o Studio por uns 40 minutos e
                  pede permissão de administrador ao Windows para o diskpart.
                </p>
                <div className="flex gap-2">
                  <Button variant="danger" disabled={start.isPending} onClick={() => start.mutate()}>
                    {start.isPending ? 'Pausando e limpando...' : 'Comprimir agora'}
                  </Button>
                  <Button onClick={() => setConfirming(false)}>Cancelar</Button>
                </div>
                <ErrorText error={start.error} />
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-panel p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}
