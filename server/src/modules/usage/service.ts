import { prisma } from '../../db.js';
import { visibleWorkspaceFilter } from '../view-profiles/service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { mergeTotals, normalizePlanUsage, type PlanUsage, type RateLimitInfo, type UsageTotals, usageDeltas } from './calc.js';

const DAY_MS = 86_400_000;
const TIME_ZONE = process.env.TZ || 'America/Sao_Paulo';

/** Turns a cumulative usage report of the agent session into AgentUsage rows. */
export async function recordAgentUsage(agentId: string, totals: UsageTotals) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { workspaceId: true, usageTotals: true } });
  if (!agent) return;
  const previous = (agent.usageTotals ?? {}) as unknown as UsageTotals;
  const deltas = usageDeltas(previous, totals);

  await prisma.$transaction([
    prisma.agentUsage.createMany({ data: deltas.map((delta) => ({ agentId, workspaceId: agent.workspaceId, ...delta })) }),
    prisma.agent.update({
      where: { id: agentId },
      data: {
        usageTotals: mergeTotals(previous, totals) as unknown as Prisma.InputJsonValue,
        costUsd: { increment: deltas.reduce((sum, delta) => sum + delta.costUsd, 0) },
      },
    }),
  ]);
}

export async function recordPlanUsage(agentAccountId: string, info: RateLimitInfo) {
  const usage = normalizePlanUsage(info);
  if (usage.windows.length === 0) return;
  await prisma.agentAccount.update({
    where: { id: agentAccountId },
    data: { planUsage: usage as unknown as Prisma.InputJsonValue, planUsageAt: new Date() },
  });
}

/** Plan limits reported while an agent runs belong to the Claude account of its workspace. */
export async function recordPlanUsageForAgent(agentId: string, info: RateLimitInfo) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { workspace: { select: { settings: { select: { agentAccountId: true } } } } },
  });
  const accountId = agent?.workspace.settings?.agentAccountId;
  if (accountId) await recordPlanUsage(accountId, info);
}

// ---------------------------------------------------------------- summary

function startOfToday() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

const usageSum = {
  costUsd: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheCreationTokens: true,
} as const;

type Sum = { [K in keyof typeof usageSum]?: number | null };

function toTotals(sum: Sum | undefined) {
  return {
    costUsd: sum?.costUsd ?? 0,
    inputTokens: sum?.inputTokens ?? 0,
    outputTokens: sum?.outputTokens ?? 0,
    cacheReadTokens: sum?.cacheReadTokens ?? 0,
    cacheCreationTokens: sum?.cacheCreationTokens ?? 0,
  };
}

/** Without a workspace, usage of every workspace of the user; with one, only its agents. */
export async function getUsageSummary(ownerId: string, workspaceId?: string) {
  const since30 = new Date(Date.now() - 30 * DAY_MS);
  const since14 = new Date(startOfToday().getTime() - 13 * DAY_MS);
  // Without a workspace: the workspaces the active view profile shows.
  const workspaceIds = workspaceId
    ? [workspaceId]
    : (await prisma.workspace.findMany({ where: { ownerId, ...(await visibleWorkspaceFilter(ownerId)) }, select: { id: true } })).map((entry) => entry.id);
  const scope = { workspaceId: { in: workspaceIds } };
  const periodTotals = async (since: Date) =>
    toTotals((await prisma.agentUsage.aggregate({ where: { ...scope, createdAt: { gte: since } }, _sum: usageSum }))._sum);

  // Plan limits belong to the Claude account; a workspace shows only the account it uses.
  const settings = workspaceId ? await prisma.workspaceSettings.findUnique({ where: { workspaceId } }) : null;
  const accountFilter = workspaceId ? { id: { in: settings?.agentAccountId ? [settings.agentAccountId] : [] } } : { ownerId };

  const [accounts, today, week, month, byWorkspace, byModel, byAgent, daily] = await Promise.all([
    prisma.agentAccount.findMany({
      where: accountFilter,
      orderBy: { label: 'asc' },
      select: { id: true, label: true, planUsage: true, planUsageAt: true },
    }),
    periodTotals(startOfToday()),
    periodTotals(new Date(Date.now() - 7 * DAY_MS)),
    periodTotals(since30),
    prisma.agentUsage.groupBy({ by: ['workspaceId'], where: { ...scope, createdAt: { gte: since30 } }, _sum: usageSum }),
    prisma.agentUsage.groupBy({ by: ['model'], where: { ...scope, createdAt: { gte: since30 } }, _sum: usageSum }),
    prisma.agentUsage.groupBy({
      by: ['agentId'],
      // Usage of deleted agents still counts in the totals, but not in this ranking.
      where: { ...scope, createdAt: { gte: since30 }, NOT: { agentId: null } },
      _sum: usageSum,
      orderBy: { _sum: { costUsd: 'desc' } },
      take: 5,
    }),
    prisma.$queryRaw<{ day: string; cost: number; tokens: bigint }[]>`
      SELECT to_char(created_at AT TIME ZONE ${TIME_ZONE}, 'YYYY-MM-DD') AS day,
             SUM(cost_usd)::float AS cost,
             SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens
      FROM agent_usage
      WHERE created_at >= ${since14}
        AND ${workspaceIds.length > 0 ? Prisma.sql`workspace_id IN (${Prisma.join(workspaceIds.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.sql`false`}
      GROUP BY 1 ORDER BY 1`,
  ]);

  const [workspaces, agents] = await Promise.all([
    prisma.workspace.findMany({ where: { id: { in: byWorkspace.map((row) => row.workspaceId) } }, select: { id: true, name: true } }),
    prisma.agent.findMany({
      where: { id: { in: byAgent.flatMap((row) => (row.agentId ? [row.agentId] : [])) } },
      select: { id: true, title: true, workspace: { select: { name: true } } },
    }),
  ]);
  const byCost = <T extends { costUsd: number }>(rows: T[]) => rows.sort((a, b) => b.costUsd - a.costUsd);

  return {
    accounts: accounts.map((account) => ({
      id: account.id,
      label: account.label,
      plan: (account.planUsage as PlanUsage | null) ?? null,
      planUpdatedAt: account.planUsageAt,
    })),
    periods: { today, week, month },
    byWorkspace: byCost(
      byWorkspace.map((row) => ({
        workspaceId: row.workspaceId,
        name: workspaces.find((workspace) => workspace.id === row.workspaceId)?.name ?? '—',
        ...toTotals(row._sum),
      })),
    ),
    byModel: byCost(byModel.map((row) => ({ model: row.model, ...toTotals(row._sum) }))),
    topAgents: byAgent.map((row) => {
      const agent = agents.find((entry) => entry.id === row.agentId);
      return { agentId: row.agentId, title: agent?.title ?? '—', workspaceName: agent?.workspace.name ?? null, ...toTotals(row._sum) };
    }),
    daily: daily.map((row) => ({ day: row.day, costUsd: row.cost, tokens: Number(row.tokens) })),
  };
}
