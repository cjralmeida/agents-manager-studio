import { prisma } from '../../db.js';
import { HttpError } from '../../lib/errors.js';

/**
 * Aprendizado: reviewers (code-guardian, hom-ranger, play-tester) log each defect that blocked a task, by category,
 * with the stage whose agents should learn from it and the lesson to follow. The lessons go into the prompt of the
 * agents of that stage, so a mistake already found and fixed is not made again. When a category reaches several
 * different tasks, it is fixed once in the base by a transversal task (created in the Backlog for the user to approve).
 * Expected errors are never logged: only "expected X, got Y" against a rule, a criterion or the contract.
 */

export const QUALITY_STATUSES = ['aberta', 'transversal', 'resolvida', 'nao_defeito'] as const;
export type QualityStatus = (typeof QUALITY_STATUSES)[number];

/** Stages of the work, each with the agents that learn from its lessons. */
export const LEARNING_PHASES = ['especificacao', 'codificacao', 'assets', 'testes', 'publicacao'] as const;
export type LearningPhase = (typeof LEARNING_PHASES)[number];

const phaseLabels: Record<LearningPhase, string> = {
  especificacao: 'especificação',
  codificacao: 'codificação',
  assets: 'arte e áudio',
  testes: 'testes',
  publicacao: 'publicação',
};

/** The stages each role skill works in; a tester also gets the coding lessons, to check the delivery against them. */
const SKILL_PHASES: Record<string, LearningPhase[]> = {
  'spec-architect': ['especificacao'],
  'task-forge': ['especificacao'],
  'backlog-steward': ['especificacao'],
  'game-scout': ['especificacao'],
  'game-designer': ['especificacao'],
  'game-planner': ['especificacao'],
  'game-advisor': ['especificacao'],
  'roadmap-planner': ['especificacao'],
  'backend-builder': ['codificacao'],
  'frontend-builder': ['codificacao'],
  'game-builder': ['codificacao'],
  'pixel-forge': ['assets'],
  'audio-forge': ['assets'],
  'code-guardian': ['codificacao', 'testes'],
  'frontend-guardian': ['codificacao', 'testes'],
  'hom-api-ranger': ['testes', 'codificacao'],
  'hom-ranger': ['testes', 'codificacao'],
  'hom-screen-ranger': ['testes', 'codificacao'],
  'play-tester': ['testes', 'codificacao'],
  'hom-launcher': ['publicacao', 'codificacao'], // coding lessons for the pre-check of PR/MRs made outside the Studio
};

/** Lessons in a prompt: the most frequent first, enough to be read. */
const MAX_LESSONS = 30;

/** Different tasks with the same defect that call for a fix in the base. */
export const TRANSVERSAL_THRESHOLD = 3;

const normalize = (name: string) => name.trim().replace(/\s+/g, ' ');

export async function listQuality(workspaceId: string) {
  const categories = await prisma.qualityCategory.findMany({
    where: { workspaceId },
    include: { occurrences: { orderBy: { createdAt: 'desc' } } },
    orderBy: { updatedAt: 'desc' },
  });
  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    status: category.status as QualityStatus,
    transversalRef: category.transversalRef,
    phase: category.phase as LearningPhase,
    lesson: category.lesson,
    tasks: new Set(category.occurrences.map((occurrence) => occurrence.taskRef.toLowerCase())).size,
    updatedAt: category.updatedAt,
    occurrences: category.occurrences.map((occurrence) => ({
      id: occurrence.id,
      taskRef: occurrence.taskRef,
      expected: occurrence.expected,
      obtained: occurrence.obtained,
      reviewer: occurrence.reviewer,
      agentId: occurrence.agentId,
      createdAt: occurrence.createdAt,
    })),
  }));
}

/** What the reviewer should do after logging: nothing, open a transversal task, or add to the open one. */
function nextStep(status: string, transversalRef: string | null, tasks: number) {
  if (status === 'nao_defeito') return 'Esta categoria foi julgada como erro esperado (não é defeito): confira se a sua falha é mesmo um defeito.';
  if (status === 'transversal' && transversalRef) return `Já existe a tarefa transversal ${transversalRef}: acrescente esta ocorrência nela.`;
  if (status === 'resolvida' && transversalRef) return `A categoria tinha sido resolvida por ${transversalRef} e voltou: acrescente a ocorrência nela como reabertura.`;
  if (tasks >= TRANSVERSAL_THRESHOLD) {
    return `A categoria chegou a ${tasks} tarefas diferentes: procure uma tarefa transversal aberta do mesmo padrão; se não houver, crie-a no Backlog com Decisão = "Aguardando decisão" e registre a referência com quality_update (status "transversal").`;
  }
  return `Registrado (${tasks} de ${TRANSVERSAL_THRESHOLD} tarefas para pedir a correção na base). A categoria fica resolvida sozinha quando as tarefas em que apareceu forem entregues corrigidas; se a lição não cobre bem o que você viu, ajuste-a com quality_update.`;
}

export async function logOccurrence(
  workspaceId: string,
  input: {
    category: string;
    task: string;
    expected: string;
    obtained: string;
    phase?: LearningPhase;
    lesson?: string | null;
    reviewer?: string | null;
    agentId?: string | null;
  },
) {
  const name = normalize(input.category);
  if (!name || !input.task.trim() || !input.expected.trim() || !input.obtained.trim()) {
    throw new HttpError(400, 'Informe a categoria, a tarefa, o esperado e o obtido.');
  }
  if (input.phase && !LEARNING_PHASES.includes(input.phase)) throw new HttpError(400, `Etapa inválida. Use: ${LEARNING_PHASES.join(', ')}.`);
  const lesson = input.lesson?.trim() || null;
  // Every category teaches: a new one comes with its lesson (the correction to follow), so that when the problem is
  // fixed — by the task itself or a transversal one — it is resolved with the lesson already there.
  const exists = await prisma.qualityCategory.count({ where: { workspaceId, name } });
  if (!exists && !lesson) {
    throw new HttpError(400, 'Categoria nova: informe a lição (lesson) com a correção a seguir, para os agentes não repetirem o erro.');
  }
  const category = await prisma.qualityCategory.upsert({
    where: { workspaceId_name: { workspaceId, name } },
    create: { workspaceId, name, ...(input.phase && { phase: input.phase }), lesson },
    update: { updatedAt: new Date() },
  });
  await prisma.qualityOccurrence.create({
    data: {
      categoryId: category.id,
      taskRef: input.task.trim(),
      expected: input.expected.trim(),
      obtained: input.obtained.trim(),
      reviewer: input.reviewer ?? null,
      agentId: input.agentId ?? null,
    },
  });
  // A lesson already written (maybe edited by the user) is kept; a new one only fills an empty category. A category
  // resolved where it appeared (no transversal task) opens again: the defect is back.
  const reopen = category.status === 'resolvida' && !category.transversalRef;
  if ((lesson && !category.lesson) || reopen) {
    await prisma.qualityCategory.update({
      where: { id: category.id },
      data: { ...(lesson && !category.lesson && { lesson }), ...(reopen && { status: 'aberta' }) },
    });
    if (reopen) category.status = 'aberta';
  }
  const occurrences = await prisma.qualityOccurrence.findMany({ where: { categoryId: category.id }, select: { taskRef: true } });
  const tasks = new Set(occurrences.map((occurrence) => occurrence.taskRef.toLowerCase())).size;
  return { category: name, status: category.status, transversalRef: category.transversalRef, tasks, next: nextStep(category.status, category.transversalRef, tasks) };
}

export async function updateCategory(
  workspaceId: string,
  input: { category?: string; id?: string; status?: QualityStatus; transversalRef?: string | null; name?: string; phase?: LearningPhase; lesson?: string | null },
) {
  const category = input.id
    ? await prisma.qualityCategory.findFirst({ where: { id: input.id, workspaceId } })
    : await prisma.qualityCategory.findUnique({ where: { workspaceId_name: { workspaceId, name: normalize(input.category ?? '') } } });
  if (!category) throw new HttpError(404, `Categoria "${input.category ?? input.id}" não existe no registro. Use quality_list para ver as categorias.`);
  if (input.status && !QUALITY_STATUSES.includes(input.status)) throw new HttpError(400, `Situação inválida. Use: ${QUALITY_STATUSES.join(', ')}.`);
  if (input.phase && !LEARNING_PHASES.includes(input.phase)) throw new HttpError(400, `Etapa inválida. Use: ${LEARNING_PHASES.join(', ')}.`);
  const updated = await prisma.qualityCategory.update({
    where: { id: category.id },
    data: {
      ...(input.status && { status: input.status }),
      ...(input.transversalRef !== undefined && { transversalRef: input.transversalRef?.trim() || null }),
      ...(input.name && { name: normalize(input.name) }),
      ...(input.phase && { phase: input.phase }),
      ...(input.lesson !== undefined && { lesson: input.lesson?.trim() || null }),
    },
  });
  return { id: updated.id, name: updated.name, status: updated.status, transversalRef: updated.transversalRef, phase: updated.phase, lesson: updated.lesson };
}

/**
 * Joins categories that are the same defect under different names (each reviewer names it its own way, so none
 * reaches the transversal threshold): the occurrences move to one category with the given name, stage and lesson.
 * Its status is the most advanced of them (a transversal task in progress wins over "aberta").
 */
export async function mergeCategories(
  workspaceId: string,
  input: { categoryIds: string[]; name: string; phase?: LearningPhase; lesson?: string | null },
) {
  const name = normalize(input.name);
  if (!name) throw new HttpError(400, 'Informe o nome da categoria.');
  const sources = await prisma.qualityCategory.findMany({ where: { workspaceId, id: { in: input.categoryIds } } });
  if (sources.length !== new Set(input.categoryIds).size) throw new HttpError(404, 'Categoria não encontrada neste workspace.');
  const rank = { nao_defeito: 0, aberta: 1, resolvida: 2, transversal: 3 } as Record<string, number>;
  const lead = [...sources].sort((a, b) => (rank[b.status] ?? 0) - (rank[a.status] ?? 0))[0];
  return prisma.$transaction(async (tx) => {
    const existing = await tx.qualityCategory.findUnique({ where: { workspaceId_name: { workspaceId, name } } });
    const target =
      existing ??
      (await tx.qualityCategory.create({
        data: { workspaceId, name, status: lead?.status ?? 'aberta', transversalRef: lead?.transversalRef ?? null, phase: input.phase ?? lead?.phase },
      }));
    const others = sources.filter((source) => source.id !== target.id).map((source) => source.id);
    await tx.qualityOccurrence.updateMany({ where: { categoryId: { in: others } }, data: { categoryId: target.id } });
    await tx.qualityCategory.deleteMany({ where: { id: { in: others } } });
    return tx.qualityCategory.update({
      where: { id: target.id },
      data: {
        ...(input.phase && { phase: input.phase }),
        lesson: input.lesson?.trim() || target.lesson || sources.find((source) => source.lesson)?.lesson || null,
      },
    });
  });
}

/** The stages an agent profile works in, from the role skill its name or instructions mention. */
export function phasesOfProfile(profile: { name: string; instructions: string; output: string } | null, hasProject: boolean): LearningPhase[] {
  const text = profile ? `${profile.name} ${profile.instructions}` : '';
  const phases = Object.entries(SKILL_PHASES)
    .filter(([skill]) => new RegExp(`(^|[^\\w-])${skill}($|[^\\w-])`).test(text))
    .flatMap(([, list]) => list);
  if (phases.length > 0) return [...new Set(phases)];
  return profile?.output === 'PULL_REQUEST' && hasProject ? ['codificacao'] : [];
}

/** The repository a task reference names ("group/repo#12" or "repo#12"), lower case; null for a free title. */
export function refRepository(taskRef: string) {
  const match = /^([\w./-]+)#\d+$/.exec(taskRef.trim());
  return match ? match[1]!.split('/').pop()!.toLowerCase() : null;
}

/**
 * How close a lesson is to the agent's project: 0 when it failed there, 1 when its tasks are of no known project,
 * 2 when it only failed in the workspace's other projects (a backend lesson for a frontend agent, and the reverse).
 */
export function lessonOrigin(taskRefs: string[], project: { name: string; others: string[] }) {
  const repositories = new Set(taskRefs.map(refRepository).filter((repository): repository is string => repository !== null));
  if (repositories.has(project.name.toLowerCase())) return 0;
  const others = new Set(project.others.map((name) => name.toLowerCase()));
  return [...repositories].some((repository) => others.has(repository)) ? 2 : 1;
}

/**
 * The lessons of the workspace for an agent working in these stages, for its prompt (null: none). A category without
 * a written lesson is taught by its name and its last "expected × obtained". Categories judged not to be defects are
 * left out; resolved ones stay, so the fix is not undone. With the agent's project, its own lessons come first and
 * those only seen in the workspace's other projects last, so the cap keeps what the agent can repeat.
 */
export async function learningsPrompt(workspaceId: string, phases: LearningPhase[], project?: { name: string; others: string[] }) {
  if (phases.length === 0) return null;
  const categories = await prisma.qualityCategory.findMany({
    where: { workspaceId, phase: { in: phases }, status: { not: 'nao_defeito' } },
    include: { occurrences: { orderBy: { createdAt: 'desc' }, select: { taskRef: true, expected: true, obtained: true } } },
  });
  if (categories.length === 0) return null;
  const ranked = categories
    .map((category) => ({
      category,
      tasks: new Set(category.occurrences.map((occurrence) => occurrence.taskRef.toLowerCase())).size,
      origin: project ? lessonOrigin(category.occurrences.map((occurrence) => occurrence.taskRef), project) : 0,
    }))
    .sort((a, b) => a.origin - b.origin || b.tasks - a.tasks || b.category.updatedAt.getTime() - a.category.updatedAt.getTime())
    .slice(0, MAX_LESSONS);

  const several = phases.length > 1;
  const lines = [
    `Aprendizado deste workspace: erros que já reprovaram entregas e foram corrigidos. Não os repita${several ? ' e confira se a entrega que você recebe não os repete' : ''}.`,
  ];
  for (const phase of phases) {
    const entries = ranked.filter((entry) => entry.category.phase === phase);
    if (entries.length === 0) continue;
    if (several) lines.push(phase === phases[0] ? `- Na sua etapa (${phaseLabels[phase]}):` : `- Na etapa de ${phaseLabels[phase]} (confira na entrega):`);
    for (const { category, tasks } of entries) {
      const last = category.occurrences[0];
      const lesson =
        category.lesson ?? (last ? `${category.name} — esperado: ${last.expected.slice(0, 160)}; obtido: ${last.obtained.slice(0, 160)}` : category.name);
      lines.push(`${several ? '  ' : ''}- ${lesson}${tasks > 1 ? ` (${tasks} tarefas)` : ''}`);
    }
  }
  return lines.join('\n');
}
