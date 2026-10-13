import type { AgentProfile } from '../../api/agentProfiles';
import { type Agent, isWorking } from '../../api/agents';
import type { ContainerUsage } from '../../api/system';
import { totalTokens } from '../../api/usage';

export type AgentState = 'waiting' | 'working' | 'review' | 'failed' | 'idle';

/** One workspace agent with what its executions are doing; "Avulsos" groups executions without an agent. */
export interface AgentSummary {
  key: string;
  workspaceId: string;
  profile: AgentProfile | null;
  name: string;
  workspaceName: string | null;
  executions: Agent[];
  state: AgentState;
  working: number;
  /** Execution waiting for an answer, shown on the card. */
  waiting: Agent | undefined;
  latest: Agent | undefined;
  costUsd: number;
  tokens: number;
  /** Memory of the containers running right now. */
  liveMemory: number;
  lastActivityAt: string | null;
}

/** Page key of the executions without a workspace agent. */
export const UNASSIGNED_KEY = 'avulsos';

function summarize(
  key: string,
  workspaceId: string,
  profile: AgentProfile | null,
  name: string,
  workspaceName: string | null,
  executions: Agent[],
  live: Map<string, ContainerUsage>,
): AgentSummary {
  const sorted = [...executions].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const waiting = sorted.find((agent) => agent.status === 'WAITING_INPUT');
  const working = sorted.filter(isWorking).length;
  const latest = sorted[0];
  const state: AgentState = waiting
    ? 'waiting'
    : working > 0
      ? 'working'
      : latest?.status === 'READY_FOR_REVIEW'
        ? 'review'
        : latest?.status === 'FAILED'
          ? 'failed'
          : 'idle';
  return {
    key,
    workspaceId,
    profile,
    name,
    workspaceName,
    executions: sorted,
    state,
    working,
    waiting,
    latest,
    costUsd: executions.reduce((total, agent) => total + agent.usage.costUsd, 0),
    tokens: executions.reduce((total, agent) => total + totalTokens(agent.usage), 0),
    liveMemory: executions.reduce((total, agent) => total + (live.get(agent.id)?.memoryUsed ?? 0), 0),
    lastActivityAt: latest?.lastActivityAt ?? null,
  };
}

const STATE_ORDER: Record<AgentState, number> = { waiting: 0, working: 1, review: 2, failed: 3, idle: 4 };

/** Link to the page of an agent (or of the "avulsos" of a workspace). */
export const agentPagePath = (summary: Pick<AgentSummary, 'workspaceId' | 'profile'>) =>
  `/workspaces/${summary.workspaceId}/agents/${summary.profile?.id ?? UNASSIGNED_KEY}`;

/** One summary per workspace agent (plus one per workspace for executions without an agent), the ones needing you first. */
export function summarizeAgents(profiles: AgentProfile[], executions: Agent[], live: Map<string, ContainerUsage>) {
  const summaries = profiles.map((profile) =>
    summarize(
      profile.id,
      profile.workspaceId,
      profile,
      profile.name,
      profile.workspaceName,
      executions.filter((agent) => agent.profileId === profile.id),
      live,
    ),
  );
  const unassigned = executions.filter((agent) => !agent.profileId || !profiles.some((profile) => profile.id === agent.profileId));
  const byWorkspace = new Map<string, Agent[]>();
  for (const agent of unassigned) byWorkspace.set(agent.workspaceId, [...(byWorkspace.get(agent.workspaceId) ?? []), agent]);
  for (const [workspaceId, list] of byWorkspace) {
    summaries.push(summarize(`${UNASSIGNED_KEY}:${workspaceId}`, workspaceId, null, 'Agentes avulsos', list[0]?.workspaceName ?? null, list, live));
  }
  return summaries.sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''),
  );
}
