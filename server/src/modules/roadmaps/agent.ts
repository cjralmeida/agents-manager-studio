import type { Project } from '../../generated/prisma/client.js';
import { HttpError } from '../../lib/errors.js';
import { secrets } from '../../lib/secrets.js';
import { type RemoteInfo, parseRemote, remoteHostname } from '../agents/remote.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { parseRoadmap } from './parse.js';
import { forgetRoadmapText, systemRoadmapTexts, workspaceRoadmaps } from './service.js';
import { roadmapSettings } from './settings.js';
import { findSystem } from './systems.js';

/**
 * roadmap_get, for the roadmap planner (and Órbi): a system's current roadmap with its forecast, the pace measured from
 * the history of each of its projects (tasks per working day, cost and agent hours per task, by area), the working
 * calendar and the pauses. Without a name, the list of systems, their projects and which ones have a roadmap.
 */
export async function roadmapForAgent(workspaceId: string, name: string | null) {
  if (!name) {
    const all = await workspaceRoadmaps(workspaceId);
    return {
      systems: all.map((system) => ({
        name: system.systemName,
        projects: system.projects.map((project) => project.projectName),
        file: `${system.docsProjectName}/${system.file}`,
        hasRoadmap: system.roadmap !== null,
        deliveries: system.roadmap?.length ?? 0,
      })),
      hint: 'Passe "project" (o nome do sistema ou de um projeto dele) para ver o roadmap, o ritmo e a previsão.',
    };
  }
  const system = await findSystem(workspaceId, name);
  const [[view], settings, texts] = await Promise.all([workspaceRoadmaps(workspaceId, true, system.id), roadmapSettings(workspaceId), systemRoadmapTexts(workspaceId, system)]);
  const pace = (metrics: NonNullable<typeof view>['metrics']) =>
    metrics && {
      tasksDone: metrics.tasksDone,
      tasksPerWorkingDay: metrics.tasksPerDay,
      costPerTaskUsd: metrics.costPerTask,
      agentHoursPerTask: metrics.agentHoursPerTask,
      byArea: metrics.byArea,
      error: metrics.error,
    };
  return {
    system: view!.systemName,
    file: `${view!.docsProjectName}/${view!.file}`,
    calendar: settings.calendar,
    autoPauseHours: settings.autoPauseHours,
    window: view!.metrics?.window ?? null,
    hoursPerWorkingDay: view!.metrics?.hoursPerWorkingDay ?? null,
    productiveHours: view!.metrics?.productiveHours ?? null,
    pausedHours: view!.metrics?.pauses.pausedHours ?? null,
    /** The system's pace (its projects side by side) and each project's: plan each project's tasks at its own pace. */
    pace: pace(view!.metrics),
    projects: view!.projects.map((project) => ({ name: project.projectName, pace: pace(project.metrics), lastDays: project.metrics?.daily.slice(-14) ?? [] })),
    roadmap:
      view!.roadmap?.map((delivery) => ({
        number: delivery.number,
        name: delivery.name,
        status: delivery.status,
        progress: delivery.progress,
        byProject: delivery.lanes,
        start: delivery.start,
        deadline: delivery.deadline,
        estimatedTasks: delivery.estimatedTasks,
        days: delivery.days.map((day) => ({ date: day.date, goal: day.goal, status: day.status })),
        actual: delivery.actual,
        forecast: delivery.forecast,
      })) ?? null,
    forecastEnd: view!.forecastEnd,
    remainingCostUsd: view!.remainingCost,
    orphanTasks: view!.orphanTasks.map((task) => `${task.projectName ?? ''}#${task.number} ${task.title}`),
    /** The file as it is now: rewrite it from this, keeping what roadmap_write must not lose. */
    content: texts.content,
    ...(texts.legacy.length > 0 && {
      legacyRoadmaps: texts.legacy,
      legacyHint: `O sistema ainda não tem roadmap, mas os projetos dele tinham um cada (o formato antigo). Junte-os num roadmap só do sistema (mesmas entregas, tarefas dos dois projetos) e grave com roadmap_write; os arquivos antigos deixam de ser lidos.`,
    }),
  };
}

/**
 * roadmap_write: commits a system's roadmap.md to its docs home (straight on the base branch, where the Studio reads
 * it), with "[skip ci] [skip-cd]" so no pipeline or Amplify build runs for a documentation change. The planner needs no
 * copy of the repository.
 */
export async function writeRoadmap(workspaceId: string, name: string, content: string, summary: string | null) {
  const system = await findSystem(workspaceId, name);
  const project = system.docsProject;
  const file = system.roadmapFile;
  const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
  if (!remote) throw new HttpError(422, `O projeto ${project.name} (documentação de ${system.name}) não tem repositório remoto.`);
  if (content.length > 200_000) throw new HttpError(422, 'Roadmap grande demais (máx. 200 mil caracteres).');
  const deliveries = parseRoadmap(content);
  if (deliveries.length === 0) throw new HttpError(422, 'Nenhuma entrega reconhecida: use títulos "## Entrega N — Nome".');

  const account = await findWorkspaceGitAccount(workspaceId, [remoteHostname(remote), remote.host]);
  const token = secrets.decrypt(account.tokenEncrypted);
  const message = `docs(roadmap): ${summary?.trim() || `roadmap de ${system.name} atualizado`} [skip ci] [skip-cd]`;
  const branch = project.baseBranch ?? (await defaultBranch(project, remote, account.provider, token));
  if (account.provider === 'GITHUB') {
    const url = `${githubApi(remote)}/repos/${remote.path}/contents/${file}`;
    const headers = { ...githubHeaders(token), 'Content-Type': 'application/json' };
    const current = await call(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
    const sha = current.status === 200 ? (current.body as { sha?: string }).sha : undefined;
    const saved = await call(url, { method: 'PUT', headers, body: JSON.stringify({ message, branch, content: Buffer.from(content).toString('base64'), ...(sha && { sha }) }) });
    if (saved.status !== 200 && saved.status !== 201) throw new HttpError(502, `GitHub: ${(saved.body as { message?: string }).message ?? `erro ${saved.status}`}`);
  } else {
    const url = `${gitlabProject(remote)}/repository/files/${encodeURIComponent(file)}`;
    const headers = { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' };
    const exists = (await call(`${url}?ref=${encodeURIComponent(branch)}`, { headers })).status === 200;
    const saved = await call(url, { method: exists ? 'PUT' : 'POST', headers, body: JSON.stringify({ branch, content, commit_message: message }) });
    if (saved.status !== 200 && saved.status !== 201) throw new HttpError(502, `GitLab: ${JSON.stringify((saved.body as { message?: unknown }).message ?? `erro ${saved.status}`)}`);
  }
  forgetRoadmapText(project.id);
  return { system: system.name, project: project.name, branch, file, deliveries: deliveries.length };
}

const githubApi = (remote: RemoteInfo) => (remote.host === 'github.com' ? 'https://api.github.com' : `https://${remote.host}/api/v3`);
const githubHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agents-manager-studio' });
const gitlabProject = (remote: RemoteInfo) => `https://${remote.host}/api/v4/projects/${encodeURIComponent(remote.path)}`;

/** The repository's default branch, for a docs home without a base branch set in the Studio. */
async function defaultBranch(project: Project, remote: RemoteInfo, provider: string, token: string) {
  const response =
    provider === 'GITHUB'
      ? await call(`${githubApi(remote)}/repos/${remote.path}`, { headers: githubHeaders(token) })
      : await call(gitlabProject(remote), { headers: { 'PRIVATE-TOKEN': token } });
  const branch = (response.body as { default_branch?: string }).default_branch;
  if (!branch) throw new HttpError(422, `Não foi possível saber a branch principal de ${project.name}: defina a branch base do projeto.`);
  return branch;
}

async function call(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!response) throw new HttpError(502, `Não foi possível conectar a ${new URL(url).host}.`);
  return { status: response.status, body: (await response.json().catch(() => ({}))) as unknown };
}
