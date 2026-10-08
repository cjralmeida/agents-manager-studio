import type { ContainerStats } from '../../lib/docker.js';

/** CPU use since the previous sample, where 100% is one full core (like `docker stats`). */
export function cpuPercent(stats: ContainerStats) {
  // Without a previous sample (e.g. a container that just started) there is nothing to compare.
  if (!stats.precpu_stats.system_cpu_usage) return 0;
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta = (stats.cpu_stats.system_cpu_usage ?? 0) - (stats.precpu_stats.system_cpu_usage ?? 0);
  const cpus = stats.cpu_stats.online_cpus ?? 1;
  if (cpuDelta <= 0 || systemDelta <= 0) return 0;
  return (cpuDelta / systemDelta) * cpus * 100;
}

/** Memory in use without the page cache, matching `docker stats`. */
export function memoryUsed(stats: ContainerStats) {
  const usage = stats.memory_stats.usage ?? 0;
  const cache = stats.memory_stats.stats?.inactive_file ?? stats.memory_stats.stats?.cache ?? 0;
  return Math.max(0, usage - cache);
}

export interface LaunchLimits {
  memoryPercent: number;
  cpuPercent: number;
}

export interface UsageTotals {
  /** Share of the Docker VM memory used by containers. */
  memoryPercent: number;
  /** Share of all CPUs (100% = every core busy). */
  cpuPercent: number;
}

/** Reasons to ask for confirmation before starting another agent; empty when usage is fine. */
export function launchWarnings(totals: UsageTotals, limits: LaunchLimits) {
  const warnings: string[] = [];
  if (totals.memoryPercent >= limits.memoryPercent) {
    warnings.push(`Memória do Docker em ${Math.round(totals.memoryPercent)}% (limite ${limits.memoryPercent}%).`);
  }
  if (totals.cpuPercent >= limits.cpuPercent) {
    warnings.push(`CPU do Docker em ${Math.round(totals.cpuPercent)}% (limite ${limits.cpuPercent}%).`);
  }
  return warnings;
}
