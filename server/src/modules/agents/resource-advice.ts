import { prisma } from '../../db.js';
import {
  type AgentSize,
  type AgentSizeName,
  type ResourceSettings,
  SIZE_NAMES,
  agentSizeName,
  budgetOf,
  getResourceSettings,
  machineSize,
  runningSizes,
} from './resources.js';

/**
 * Configurações → Recursos: the sizes and budget next to what the agents really used, and the Gestor de Capacidade's
 * suggestions (reservation, limit, size of a role), which the user applies with one click.
 */

/** Agents of the last days with enough samples are the evidence. */
const WINDOW_DAYS = 14;
const MIN_SAMPLES = 5;
/** Fewer agents than this per size (or role) is too little to suggest anything. */
const MIN_AGENTS_SIZE = 5;
const MIN_AGENTS_ROLE = 3;
const STEP_MB = 256;

export interface UsageStats {
  agents: number;
  /** 90th percentile and highest of the agents' memory peaks (MB). */
  p90PeakMemoryMb: number;
  maxPeakMemoryMb: number;
  /** CPU, 100 = one core: 90th percentile of the averages and of the peaks. */
  p90AvgCpuPercent: number;
  p90PeakCpuPercent: number;
  /** Agents moved one size up after running out of memory. */
  ooms: number;
}

export interface Measured {
  sizeName: string | null;
  resourceSize: string | null;
  peakMemoryMb: number | null;
  peakCpuPercent: number | null;
  cpuPercentSum: number;
  usageSamples: number;
}

export type Suggestion =
  | { kind: 'reserve'; size: AgentSizeName; from: number; to: number; reason: string }
  | { kind: 'memory'; size: AgentSizeName; from: number; to: number; reason: string }
  | { kind: 'profile'; profileId: string; profile: string; workspace: string; from: AgentSizeName; to: AgentSizeName; reason: string };

export function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export function usageStats(agents: Measured[]): UsageStats {
  const peaks = agents.map((agent) => agent.peakMemoryMb ?? 0);
  return {
    agents: agents.length,
    p90PeakMemoryMb: Math.round(percentile(peaks, 90)),
    maxPeakMemoryMb: Math.max(0, ...peaks),
    p90AvgCpuPercent: Math.round(percentile(agents.map((agent) => agent.cpuPercentSum / Math.max(1, agent.usageSamples)), 90)),
    p90PeakCpuPercent: Math.round(percentile(agents.map((agent) => agent.peakCpuPercent ?? 0), 90)),
    ooms: agents.filter((agent) => agent.resourceSize !== null).length,
  };
}

const roundUp = (mb: number) => Math.ceil(mb / STEP_MB) * STEP_MB;
const gb = (mb: number) => `${(mb / 1024).toFixed(1).replace('.0', '')} GB`;

/** The reservation of a size follows the usual peak (90% of the agents, plus 10%); the limit grows when it is hit. */
export function sizeSuggestions(name: AgentSizeName, size: AgentSize, stats: UsageStats): Suggestion[] {
  if (stats.agents < MIN_AGENTS_SIZE) return [];
  const suggestions: Suggestion[] = [];
  const reserve = Math.min(size.memoryMb, Math.max(STEP_MB, roundUp(stats.p90PeakMemoryMb * 1.1)));
  if (Math.abs(reserve - size.reserveMb) >= STEP_MB) {
    suggestions.push({
      kind: 'reserve',
      size: name,
      from: size.reserveMb,
      to: reserve,
      reason: `9 em cada 10 agentes ${name} usaram até ${gb(stats.p90PeakMemoryMb)} no pico (${stats.agents} agentes).`,
    });
  }
  if (stats.ooms > 0 || stats.maxPeakMemoryMb >= size.memoryMb * 0.9) {
    suggestions.push({
      kind: 'memory',
      size: name,
      from: size.memoryMb,
      to: size.memoryMb + 1024,
      reason:
        stats.ooms > 0
          ? `${stats.ooms} agente(s) ${name} ficaram sem memória e foram para o tamanho acima.`
          : `Um agente ${name} chegou a ${gb(stats.maxPeakMemoryMb)}, perto do limite de ${gb(size.memoryMb)}.`,
    });
  }
  return suggestions;
}

/**
 * A role whose usual peak does not fit its size's reservation goes one size up; one that fits the size below (memory
 * and average CPU) goes one down.
 */
export function roleSuggestion(current: AgentSizeName, sizes: Record<AgentSizeName, AgentSize>, stats: UsageStats): AgentSizeName | null {
  if (stats.agents < MIN_AGENTS_ROLE) return null;
  const index = SIZE_NAMES.indexOf(current);
  const larger = SIZE_NAMES[index + 1];
  const smaller = index > 0 ? SIZE_NAMES[index - 1] : undefined;
  if (larger && larger !== 'GG' && (stats.ooms > 0 || stats.p90PeakMemoryMb > sizes[current].memoryMb * 0.8)) return larger;
  if (smaller && stats.ooms === 0 && stats.maxPeakMemoryMb < sizes[smaller].reserveMb && stats.p90AvgCpuPercent < sizes[smaller].cpus * 50) return smaller;
  return null;
}

export async function resourceOverview() {
  const [settings, machine, running] = await Promise.all([getResourceSettings(), machineSize(), runningSizes()]);
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60_000);
  const measured = await prisma.agent.findMany({
    where: { kind: 'TASK', createdAt: { gte: since }, usageSamples: { gte: MIN_SAMPLES }, sizeName: { not: null } },
    select: { profileId: true, sizeName: true, resourceSize: true, peakMemoryMb: true, peakCpuPercent: true, cpuPercentSum: true, usageSamples: true },
  });
  const profiles = await prisma.agentProfile.findMany({
    select: { id: true, name: true, instructions: true, resourceSize: true, workspace: { select: { name: true } } },
  });

  const sizes = SIZE_NAMES.map((name) => {
    const stats = usageStats(measured.filter((agent) => agent.sizeName === name));
    return { ...settings.sizes[name], name, usage: stats, suggestions: sizeSuggestions(name, settings.sizes[name], stats) };
  });

  const roleSuggestions = profiles.flatMap((profile): Suggestion[] => {
    const effective = agentSizeName({ kind: 'TASK' }, profile);
    const stats = usageStats(measured.filter((agent) => agent.profileId === profile.id));
    const to = roleSuggestion(effective, settings.sizes, stats);
    if (!to) return [];
    const reason =
      SIZE_NAMES.indexOf(to) > SIZE_NAMES.indexOf(effective)
        ? `Pico usual de ${gb(stats.p90PeakMemoryMb)}${stats.ooms ? ` e ${stats.ooms} falta(s) de memória` : ''}: não cabe bem no ${effective}.`
        : `Nunca passou de ${gb(stats.maxPeakMemoryMb)} nem de ${stats.p90AvgCpuPercent}% de CPU em média: cabe no ${to}.`;
    return [{ kind: 'profile', profileId: profile.id, profile: profile.name, workspace: profile.workspace.name, from: effective, to, reason }];
  });

  return {
    settings,
    machine,
    budget: machine && budgetOf(machine, settings),
    reserved: { agents: running.length, cpus: running.reduce((sum, size) => sum + size.cpus, 0), memoryMb: running.reduce((sum, size) => sum + size.reserveMb, 0) },
    sizes,
    suggestions: [...sizes.flatMap((size) => size.suggestions), ...roleSuggestions],
    windowDays: WINDOW_DAYS,
  };
}

/** Sizes must grow from P to GG and each reservation fit its limit. */
export function settingsProblem(settings: ResourceSettings): string | null {
  for (const name of SIZE_NAMES) {
    const size = settings.sizes[name];
    if (size.reserveMb > size.memoryMb) return `No tamanho ${name}, a reserva não pode passar do limite de memória.`;
  }
  for (let index = 1; index < SIZE_NAMES.length; index++) {
    const smaller = settings.sizes[SIZE_NAMES[index - 1]!];
    const size = settings.sizes[SIZE_NAMES[index]!];
    if (size.memoryMb < smaller.memoryMb || size.cpus < smaller.cpus) return `O tamanho ${size.name} não pode ser menor que o ${smaller.name}.`;
  }
  return null;
}
