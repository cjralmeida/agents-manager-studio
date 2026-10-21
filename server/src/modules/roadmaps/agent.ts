import { prisma } from '../../db.js';
import { HttpError } from '../../lib/errors.js';
import { secrets } from '../../lib/secrets.js';
import { parseRemote, remoteHostname } from '../agents/remote.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';
import { parseRoadmap } from './parse.js';
import { ROADMAP_FILE, forgetRoadmapText, workspaceRoadmaps } from './service.js';
import { roadmapSettings } from './settings.js';

/**
 * roadmap_get, for the roadmap planner (and Órbi): a project's current roadmap with its forecast, the pace measured from
 * its history (tasks per working day, cost and agent hours per task, by area), the working calendar and the pauses.
 * Without a project, the list of projects and which ones have a roadmap.
 */
export async function roadmapForAgent(workspaceId: string, projectName: string | null) {
  const projects = await prisma.project.findMany({ where: { workspaceId, missingAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  if (!projectName) {
    const all = await workspaceRoadmaps(workspaceId);
    return {
      projects: all.map((project) => ({ name: project.projectName, hasRoadmap: project.roadmap !== null, deliveries: project.roadmap?.length ?? 0 })),
      hint: 'Passe "project" para ver o roadmap, o ritmo e a previsão de um projeto.',
    };
  }
  const project = projects.find((entry) => entry.name.toLowerCase() === projectName.toLowerCase());
  if (!project) throw new HttpError(404, `Projeto "${projectName}" não encontrado. Projetos: ${projects.map((entry) => entry.name).join(', ')}.`);
  const [view] = await workspaceRoadmaps(workspaceId, true, project.id);
  const settings = await roadmapSettings(workspaceId);
  const metrics = view!.metrics;
  return {
    project: view!.projectName,
    file: ROADMAP_FILE,
    calendar: settings.calendar,
    autoPauseHours: settings.autoPauseHours,
    pace: metrics && {
      window: metrics.window,
      hoursPerWorkingDay: metrics.hoursPerWorkingDay,
      productiveHours: metrics.productiveHours,
      pausedHours: metrics.pauses.pausedHours,
      tasksDone: metrics.tasksDone,
      tasksPerWorkingDay: metrics.tasksPerDay,
      costPerTaskUsd: metrics.costPerTask,
      agentHoursPerTask: metrics.agentHoursPerTask,
      byArea: metrics.byArea,
      lastDays: metrics.daily.slice(-14),
      error: metrics.error,
    },
    roadmap:
      view!.roadmap?.map((delivery) => ({
        number: delivery.number,
        name: delivery.name,
        status: delivery.status,
        progress: delivery.progress,
        start: delivery.start,
        deadline: delivery.deadline,
        estimatedTasks: delivery.estimatedTasks,
        days: delivery.days.map((day) => ({ date: day.date, goal: day.goal, status: day.status })),
        actual: delivery.actual,
        forecast: delivery.forecast,
      })) ?? null,
    forecastEnd: view!.forecastEnd,
    remainingCostUsd: view!.remainingCost,
    orphanTasks: view!.orphanTasks.map((task) => `#${task.number} ${task.title}`),
  };
}

/**
 * roadmap_write: commits the project's docs/roadmap.md straight to its base branch (where the Studio reads it), with
 * "[skip ci] [skip-cd]" so no pipeline or Amplify build runs for a documentation change. The planner needs no copy of
 * the repository, so one run can plan the backend and the frontend of a system.
 */
export async function writeRoadmap(workspaceId: string, projectName: string, content: string, summary: string | null) {
  const project = await prisma.project.findFirst({ where: { workspaceId, missingAt: null, name: { equals: projectName, mode: 'insensitive' } } });
  if (!project) throw new HttpError(404, `Projeto "${projectName}" não encontrado.`);
  const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
  if (!remote) throw new HttpError(422, `O projeto ${project.name} não tem repositório remoto.`);
  if (!project.baseBranch) throw new HttpError(422, `O projeto ${project.name} não tem branch base definida.`);
  if (content.length > 200_000) throw new HttpError(422, 'Roadmap grande demais (máx. 200 mil caracteres).');
  const deliveries = parseRoadmap(content);
  if (deliveries.length === 0) throw new HttpError(422, 'Nenhuma entrega reconhecida: use títulos "## Entrega N — Nome".');

  const account = await findWorkspaceGitAccount(workspaceId, [remoteHostname(remote), remote.host]);
  const token = secrets.decrypt(account.tokenEncrypted);
  const message = `docs(roadmap): ${summary?.trim() || 'roadmap atualizado'} [skip ci] [skip-cd]`;
  const branch = project.baseBranch;
  if (account.provider === 'GITHUB') {
    const apiBase = remote.host === 'github.com' ? 'https://api.github.com' : `https://${remote.host}/api/v3`;
    const url = `${apiBase}/repos/${remote.path}/contents/${ROADMAP_FILE}`;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agents-manager-studio', 'Content-Type': 'application/json' };
    const current = await call(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
    const sha = current.status === 200 ? (current.body as { sha?: string }).sha : undefined;
    const saved = await call(url, { method: 'PUT', headers, body: JSON.stringify({ message, branch, content: Buffer.from(content).toString('base64'), ...(sha && { sha }) }) });
    if (saved.status !== 200 && saved.status !== 201) throw new HttpError(502, `GitHub: ${(saved.body as { message?: string }).message ?? `erro ${saved.status}`}`);
  } else {
    const url = `https://${remote.host}/api/v4/projects/${encodeURIComponent(remote.path)}/repository/files/${encodeURIComponent(ROADMAP_FILE)}`;
    const headers = { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' };
    const exists = (await call(`${url}?ref=${encodeURIComponent(branch)}`, { headers })).status === 200;
    const saved = await call(url, { method: exists ? 'PUT' : 'POST', headers, body: JSON.stringify({ branch, content, commit_message: message }) });
    if (saved.status !== 200 && saved.status !== 201) throw new HttpError(502, `GitLab: ${JSON.stringify((saved.body as { message?: unknown }).message ?? `erro ${saved.status}`)}`);
  }
  forgetRoadmapText(project.id);
  return { project: project.name, branch, file: ROADMAP_FILE, deliveries: deliveries.length };
}

async function call(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!response) throw new HttpError(502, `Não foi possível conectar a ${new URL(url).host}.`);
  return { status: response.status, body: (await response.json().catch(() => ({}))) as unknown };
}
