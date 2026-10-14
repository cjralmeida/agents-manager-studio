import { Fragment } from 'react';
import { Link } from 'react-router';
import { type ContainerKind, type ContainerUsage, formatBytes, useDiskUsage, useResourceUsage } from '../../api/system';
import { ErrorText } from '../form';
import { TestEnvsPanel } from './TestEnvsPanel';

const kindLabels: Record<ContainerKind, string> = { agent: 'Agentes', studio: 'Serviços do Studio' };
/** Above this gap between Docker's disk file and its data, compacting is worth it. */
const COMPACT_WARNING_BYTES = 15 * 1024 ** 3;

/** Usage bar with a marker at the launch limit; turns amber/red as it gets close to it. */
function UsageBar({ label, percent, limit, detail }: { label: string; percent: number; limit: number; detail: string }) {
  const tone = percent >= limit ? 'bg-red-400' : percent >= limit * 0.8 ? 'bg-amber-400' : 'bg-emerald-400';
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span>
          {Math.round(percent)}% <span className="text-muted">· {detail}</span>
        </span>
      </div>
      <div className="relative mt-1 h-2 rounded-full bg-border">
        <div className={`h-2 rounded-full ${tone} transition-all`} style={{ width: `${Math.min(100, percent)}%` }} />
        <div
          className="absolute -top-0.5 h-3 w-px bg-white/60"
          style={{ left: `${limit}%` }}
          title={`Acima de ${limit}% o lançamento pede confirmação`}
        />
      </div>
    </div>
  );
}

function ContainerRow({ container }: { container: ContainerUsage }) {
  const name = container.agentId ? (
    <Link to={`/agents/${container.agentId}`} className="truncate hover:text-accent">
      {container.label}
    </Link>
  ) : (
    <span className="truncate" title={container.name}>
      {container.label}
    </span>
  );
  return (
    <li className="flex items-center justify-between gap-2 py-1 text-xs">
      {name}
      <span className="shrink-0 text-muted tabular-nums">
        {container.cpuPercent.toFixed(1)}% · {formatBytes(container.memoryUsed)}
      </span>
    </li>
  );
}

/** Without a workspace: the whole Studio; with one, only the agents of that workspace and their disk. */
export function ResourcePanel({ workspaceId }: { workspaceId?: string }) {
  const usage = useResourceUsage(workspaceId);
  const disk = useDiskUsage(workspaceId);

  if (usage.error) return <ErrorText error={usage.error} />;
  if (!usage.data) return <p className="text-sm text-muted">Medindo o consumo do Docker...</p>;

  const { docker, host, totals, limits, containers } = usage.data;
  // Shared services (server, database, proxy...) are not attributed to a single workspace.
  const kinds = workspaceId ? (['agent'] as const) : (['agent', 'studio'] as const);
  const groups = kinds.map((kind) => ({ kind, items: containers.filter((container) => container.kind === kind) }));

  return (
    <div className="space-y-4">
      {host && !workspaceId && (
        <div className="space-y-3">
          <h3 className="text-xs font-medium tracking-wider text-muted uppercase">Computador</h3>
          <UsageBar
            label="Memória"
            percent={host.memoryPercent}
            limit={limits.memoryPercent}
            detail={`${formatBytes(host.memoryUsed)} de ${formatBytes(host.memoryTotal)}`}
          />
          <UsageBar label="CPU" percent={host.cpuPercent} limit={limits.cpuPercent} detail="todos os núcleos" />
          {host.disks.map((disk) => {
            const used = disk.total > 0 ? ((disk.total - disk.free) / disk.total) * 100 : 0;
            return (
              <UsageBar
                key={disk.drive}
                label={`Disco ${disk.drive}${disk.agents ? ' (cópias dos agentes)' : ''}`}
                percent={used}
                limit={100}
                detail={`${formatBytes(disk.free)} livres de ${formatBytes(disk.total)}`}
              />
            );
          })}
        </div>
      )}
      {!workspaceId && <TestEnvsPanel />}
      <div className="space-y-3">
        {host && !workspaceId && <h3 className="text-xs font-medium tracking-wider text-muted uppercase">Docker</h3>}
        <UsageBar
          label="Memória"
          percent={totals.memoryPercent}
          limit={limits.memoryPercent}
          detail={`${formatBytes(totals.memoryUsed)} de ${formatBytes(docker.memoryTotal)}`}
        />
        <UsageBar label="CPU" percent={totals.cpuPercent} limit={limits.cpuPercent} detail={`${docker.cpus} núcleos`} />
      </div>
      {usage.data.launchWarnings.length > 0 && (
        <div className="rounded-md bg-amber-400/10 px-2.5 py-1.5 text-xs text-amber-200">
          <p>Consumo alto: novos agentes esperam (workflows) ou pedem confirmação.</p>
          <ul className="mt-1 list-disc pl-4">
            {usage.data.launchWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {groups.map((group) => (
        <div key={group.kind}>
          <h3 className="text-xs font-medium tracking-wider text-muted uppercase">
            {kindLabels[group.kind]} ({group.items.length})
          </h3>
          {group.items.length === 0 ? (
            <p className="py-1 text-xs text-muted">Nenhum agente rodando.</p>
          ) : (
            <ul className="mt-1 divide-y divide-border/60">
              {group.items.map((container) => (
                <ContainerRow key={container.id} container={container} />
              ))}
            </ul>
          )}
        </div>
      ))}

      {disk.data && (
        <div>
          <h3 className="text-xs font-medium tracking-wider text-muted uppercase">
            {workspaceId ? 'Disco do workspace' : 'Disco do Studio'}
          </h3>
          <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
            {disk.data.items.map((item) => (
              <Fragment key={item.label}>
                <dt className="text-muted">{item.label}</dt>
                <dd className="text-right tabular-nums">{formatBytes(item.bytes)}</dd>
              </Fragment>
            ))}
            {!workspaceId && disk.data.dockerDisk && (
              <>
                <dt className="text-muted" title={disk.data.dockerDisk.path}>
                  Disco virtual do Docker
                </dt>
                <dd className="text-right tabular-nums">
                  {formatBytes(disk.data.dockerDisk.fileBytes)} <span className="text-muted">({formatBytes(disk.data.dockerDisk.dataBytes)} em uso)</span>
                </dd>
              </>
            )}
          </dl>
          {!workspaceId && disk.data.dockerDisk && disk.data.dockerDisk.fileBytes - disk.data.dockerDisk.dataBytes > COMPACT_WARNING_BYTES && (
            <p className="mt-2 rounded-md bg-amber-400/10 px-2.5 py-1.5 text-xs text-amber-200">
              O disco virtual do Docker ocupa {formatBytes(disk.data.dockerDisk.fileBytes)} no Windows, mas guarda só{' '}
              {formatBytes(disk.data.dockerDisk.dataBytes)}. Compactá-lo (com o Docker parado) devolveria cerca de{' '}
              {formatBytes(disk.data.dockerDisk.fileBytes - disk.data.dockerDisk.dataBytes)} ao disco.
            </p>
          )}
        </div>
      )}
      <p className="text-[11px] text-muted">
        {workspaceId
          ? 'Só os agentes deste workspace; os serviços do Studio são compartilhados e ficam no Dashboard geral.'
          : 'Considera só os serviços do Studio e os agentes.'}{' '}
        {host
          ? `Os limites de lançamento usam o computador inteiro (medido no Windows pelo studio.ps1); "Docker" é só a VM (${docker.os}, Docker ${docker.version}).`
          : `Percentuais sobre a VM do Docker (${docker.os}, Docker ${docker.version}). Rode o studio.ps1 no Windows para medir o computador inteiro.`}
      </p>
    </div>
  );
}
