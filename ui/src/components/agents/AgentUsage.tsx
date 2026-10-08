import type { Agent } from '../../api/agents';
import { type ContainerUsage, formatBytes } from '../../api/system';
import { formatTokens, formatUsd, totalTokens } from '../../api/usage';

const number = new Intl.NumberFormat('pt-BR');

/** Full breakdown for the tooltip, so the card itself shows only the short line. */
function usageTooltip(agent: Agent, live: ContainerUsage | undefined) {
  const { usage } = agent;
  const lines = [
    `Sessão do agente (${agent.model})`,
    `Entrada: ${number.format(usage.inputTokens)} tokens`,
    `Saída: ${number.format(usage.outputTokens)} tokens`,
    `Cache lido: ${number.format(usage.cacheReadTokens)} tokens`,
    `Cache gravado: ${number.format(usage.cacheCreationTokens)} tokens`,
    `Custo estimado: ${formatUsd(usage.costUsd)} (preço de API; coberto pelo plano Max)`,
  ];
  if (live) lines.push('', `Container agora: ${live.cpuPercent.toFixed(1)}% CPU · ${formatBytes(live.memoryUsed)}`);
  return lines.join('\n');
}

/**
 * One short muted line: estimated cost and tokens of the agent session, plus the memory of its
 * container while it runs (with a pulsing dot). Details stay in the tooltip.
 */
export function AgentUsageLine({ agent, live }: { agent: Agent; live?: ContainerUsage }) {
  const tokens = totalTokens(agent.usage);
  if (tokens === 0 && !live) return <span className="text-[11px] text-muted">—</span>;

  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] whitespace-nowrap text-muted tabular-nums" title={usageTooltip(agent, live)}>
      {live && <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" aria-label="Container rodando" />}
      <span>≈ {formatUsd(agent.usage.costUsd)}</span>
      <span>· {formatTokens(tokens)} tok</span>
      {live && <span>· {formatBytes(live.memoryUsed)}</span>}
    </span>
  );
}
