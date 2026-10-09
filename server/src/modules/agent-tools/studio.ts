import { prisma } from '../../db.js';
import { HttpError } from '../../lib/errors.js';
import { listAgentProfiles } from '../agent-profiles/service.js';
import { getAgent, listAgentEvents, listAgents } from '../agents/service.js';
import { PROPOSAL_KINDS, type ProposalKind, createProposal } from '../assistant/proposals.js';
import { listAgentAccounts } from '../agent-accounts/service.js';
import { boardContext, detectBoards, hasBoard } from '../boards/service.js';
import { listGitAccounts } from '../git-accounts/service.js';
import { getRenderSettings, listAvailableServices, listRenderAccounts } from '../render/service.js';
import { listSkills } from '../skills/service.js';
import { getWorkspaceSettings } from '../workspace-settings/service.js';
import { getUsageSummary } from '../usage/service.js';
import { listRuns, listWorkflows } from '../workflows/service.js';

type Args = Record<string, unknown>;

const limitOf = (value: unknown, fallback: number, max: number) => Math.min(Math.max(Number(value) || fallback, 1), max);

/** Everything Órbi needs to know about the workspace to propose agents and workflows with valid ids and names. */
async function context(workspaceId: string) {
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    include: { projects: { where: { missingAt: null }, orderBy: { name: 'asc' } }, settings: true },
  });
  const [linked, profiles, workflows, render, settings, claudeAccounts, gitAccounts, renderAccounts, skills] = await Promise.all([
    hasBoard(workspaceId),
    listAgentProfiles(workspaceId),
    listWorkflows(workspaceId),
    getRenderSettings(workspaceId),
    getWorkspaceSettings(workspaceId),
    listAgentAccounts(workspace.ownerId),
    listGitAccounts(workspace.ownerId),
    listRenderAccounts(workspace.ownerId),
    listSkills(),
  ]);
  const board = linked ? await boardContext(workspaceId).catch(() => null) : null;
  const projectName = (id: string) => workspace.projects.find((project) => project.id === id)?.name ?? id;

  return {
    workspace: { id: workspace.id, name: workspace.name, hasClaudeAccount: Boolean(workspace.settings?.agentAccountId) },
    // What update_workspace_settings changes, and the user's accounts and skills it can choose from.
    settings,
    accounts: {
      claude: claudeAccounts.map((account) => ({ id: account.id, label: account.label })),
      git: gitAccounts.map((account) => ({ id: account.id, provider: account.provider, host: account.host, username: account.username, label: account.label })),
      render: renderAccounts.map((account) => ({ id: account.id, label: account.label, owner: account.ownerName })),
    },
    skills: skills.map((skill) => ({ id: skill.id, name: skill.name })),
    projects: workspace.projects.map((project) => ({
      id: project.id,
      name: project.name,
      hasGit: project.isGitRepo,
      provider: project.gitProvider,
      remote: project.gitRemoteUrl,
    })),
    board: board
      ? {
            // One board joining these sources; columns and fields are the board model's.
            sources: board.sources.map((source) => ({ provider: source.provider, title: source.title, url: source.url, onBoard: !board.excluded.some((entry) => entry.sourceId === source.id) })),
            refreshMinutes: Math.round((board.sources[0]?.refreshIntervalSec ?? 120) / 60),
            // Ids are what workflow triggers use; names are what board tools and create_task use.
            columns: board.snapshot.columns.map((column) => ({ id: column.id, name: column.name })),
            columnRoles: board.statusMap,
            fields: board.snapshot.fields.map((field) => ({
              id: field.id,
              name: field.name,
              options: field.options.map((option) => ({ id: option.id, name: option.name })),
            })),
            repositories: board.repos.filter((repo) => repo.sourceId).map((repo) => repo.path),
          }
        : null,
    render: {
      connected: Boolean(render.connection),
      account: render.connection?.label ?? null,
      services: render.services.map((service: { projectId: string; environment: string; serviceName: string }) => ({
        projectId: service.projectId,
        project: projectName(service.projectId),
        environment: service.environment,
        service: service.serviceName,
      })),
    },
    agents: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      description: profile.description,
      instructions: profile.instructions,
      model: profile.model,
      projectIds: profile.projectIds,
      projects: profile.projectIds.map(projectName),
      output: profile.output,
      tools: profile.tools,
      autoConclude: profile.autoConclude,
      autoMerge: profile.autoMerge,
      executions: profile.totalAgents,
    })),
    workflows: workflows.map(({ id, name, description, isEnabled, trigger, steps, maxConcurrentRuns, statusMessage, totalRuns }) => ({
      id,
      name,
      description,
      isEnabled,
      trigger,
      steps,
      maxConcurrentRuns,
      statusMessage,
      totalRuns,
    })),
  };
}

/** Órbi's tools: reading is free; changes only become proposals the user applies. */
export async function runStudioTool(agentId: string, workspaceId: string, name: string, args: Args) {
  switch (name) {
    case 'studio_context':
      return context(workspaceId);

    case 'studio_list_runs': {
      const runs = await listRuns(workspaceId, typeof args.workflowId === 'string' ? args.workflowId : undefined);
      return runs.slice(0, limitOf(args.limit, 10, 30)).map((run) => ({
        id: run.id,
        workflow: run.workflowName,
        title: run.title,
        status: run.status,
        error: run.error,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        steps: run.steps.map((step) => ({
          step: run.definition.find((definition) => definition.id === step.stepId)?.name ?? step.stepId,
          lane: step.lane,
          attempt: step.attempt,
          status: step.status,
          executionId: step.agentId,
          error: step.error,
          summary: (step.output as { summary?: string } | null)?.summary ?? null,
        })),
      }));
    }

    case 'studio_list_executions': {
      const { ownerId } = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { ownerId: true } });
      const executions = await listAgents(ownerId, { workspaceId, ...(typeof args.agentId === 'string' && { profileId: args.agentId }) });
      return executions
        .filter((agent) => typeof args.status !== 'string' || agent.status === args.status)
        .slice(0, limitOf(args.limit, 15, 50))
        .map((agent) => ({
          id: agent.id,
          title: agent.title,
          agent: agent.profileName,
          status: agent.status,
          workflow: agent.workflowName,
          project: agent.projectName,
          prUrl: agent.prUrl,
          error: agent.errorMessage,
          costUsd: agent.usage.costUsd,
          createdAt: agent.createdAt,
        }));
    }

    case 'studio_get_execution': {
      const agent = await getAgent(String(args.id));
      if (agent.workspaceId !== workspaceId) throw new HttpError(404, 'Execução não encontrada neste workspace.');
      const events = await listAgentEvents(agent.id, 0);
      return {
        id: agent.id,
        title: agent.title,
        agent: agent.profileName,
        status: agent.status,
        project: agent.projectName,
        branch: agent.branch,
        prUrl: agent.prUrl,
        error: agent.errorMessage,
        result: agent.result,
        // The tail of the timeline is what explains how it ended.
        timeline: events.slice(-40).map((event) => ({ type: event.type, at: event.createdAt, data: event.data })),
      };
    }

    case 'studio_usage':
      return getUsageSummary(workspaceId);

    case 'studio_board_options': {
      const found = await detectBoards(workspaceId);
      return {
        // Boards of the workspace repositories not linked yet (link_board with the url).
        existing: found.candidates.map((candidate) => ({
          provider: candidate.provider,
          title: candidate.title,
          url: candidate.url,
          owner: candidate.ownerPath,
          looksLikeStudioModel: candidate.matchesTemplate,
        })),
        // Where a new board can be created (create_board with provider, host and owner).
        createIn: found.createOptions,
        warnings: found.warnings,
      };
    }

    case 'studio_render_services':
      return (await listAvailableServices(workspaceId)).map((service) => ({
        id: service.id,
        name: service.name,
        type: service.type,
        repo: service.repo,
        branch: service.branch,
        url: service.url,
      }));

    case 'studio_propose': {
      const kind = String(args.kind) as ProposalKind;
      if (!PROPOSAL_KINDS.includes(kind)) throw new HttpError(400, `Tipo de proposta desconhecido. Use: ${PROPOSAL_KINDS.join(', ')}.`);
      const summary = typeof args.summary === 'string' && args.summary.trim() ? args.summary.trim() : kind;
      return createProposal(agentId, kind, summary, args.payload ?? {});
    }
  }
  throw new HttpError(400, `Ferramenta desconhecida: ${name}.`);
}
