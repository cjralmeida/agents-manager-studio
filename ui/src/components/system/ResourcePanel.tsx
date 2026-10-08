import { Fragment } from 'react';
import { Link } from 'react-router';
import { type ContainerKind, type ContainerUsage, formatBytes, useDiskUsage, useResourceUsage } from '../../api/system';
import { ErrorText } from '../form';

const kindLabels: Record<ContainerKind, string> = { agent: 'Agentes', studio: 'Serviços do Studio' };

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

  const { docker, totals, limits, containers } = usage.data;
  // Shared services (server, database, proxy...) are not attributed to a single workspace.
  const kinds = workspaceId ? (['agent'] as const) : (['agent', 'studio'] as const);
  const groups = kinds.map((kind) => ({ kind, items: containers.filter((container) => container.kind === kind) }));

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <UsageBar
          label="Memória"
          percent={totals.memoryPercent}
          limit={limits.memoryPercent}
          detail={`${formatBytes(totals.memoryUsed)} de ${formatBytes(docker.memoryTotal)}`}
        />
        <UsageBar label="CPU" percent={totals.cpuPercent} limit={limits.cpuPercent} detail={`${docker.cpus} núcleos`} />
      </div>
      {usage.data.launchWarnings.length > 0 && (
        <p className="rounded-md bg-amber-400/10 px-2.5 py-1.5 text-xs text-amber-200">
          Consumo alto no Studio: novos agentes pedem confirmação.
        </p>
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
          </dl>
        </div>
      )}
      <p className="text-[11px] text-muted">
        {workspaceId
          ? 'Só os agentes deste workspace; os serviços do Studio são compartilhados e ficam no Dashboard geral.'
          : 'Considera só os serviços do Studio e os agentes.'}{' '}
        Percentuais sobre a VM do Docker ({docker.os}, Docker {docker.version}).
      </p>
    </div>
  );
}
