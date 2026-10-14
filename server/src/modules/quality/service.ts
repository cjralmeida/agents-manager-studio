import { prisma } from '../../db.js';
import { HttpError } from '../../lib/errors.js';

/**
 * Recurring defects: reviewers (code-guardian, hom-ranger, play-tester) log each defect that blocked a task, by
 * category. When a category reaches several different tasks, it is fixed once in the base by a transversal task
 * (created in the Backlog for the user to approve). Expected errors are never logged: only "expected X, got Y" against
 * a rule, a criterion or the contract.
 */

export const QUALITY_STATUSES = ['aberta', 'transversal', 'resolvida', 'nao_defeito'] as const;
export type QualityStatus = (typeof QUALITY_STATUSES)[number];

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
  return `Registrado (${tasks} de ${TRANSVERSAL_THRESHOLD} tarefas para pedir a correção na base).`;
}

export async function logOccurrence(
  workspaceId: string,
  input: { category: string; task: string; expected: string; obtained: string; reviewer?: string | null; agentId?: string | null },
) {
  const name = normalize(input.category);
  if (!name || !input.task.trim() || !input.expected.trim() || !input.obtained.trim()) {
    throw new HttpError(400, 'Informe a categoria, a tarefa, o esperado e o obtido.');
  }
  const category = await prisma.qualityCategory.upsert({
    where: { workspaceId_name: { workspaceId, name } },
    create: { workspaceId, name },
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
  const occurrences = await prisma.qualityOccurrence.findMany({ where: { categoryId: category.id }, select: { taskRef: true } });
  const tasks = new Set(occurrences.map((occurrence) => occurrence.taskRef.toLowerCase())).size;
  return { category: name, status: category.status, transversalRef: category.transversalRef, tasks, next: nextStep(category.status, category.transversalRef, tasks) };
}

export async function updateCategory(workspaceId: string, input: { category?: string; id?: string; status?: QualityStatus; transversalRef?: string | null; name?: string }) {
  const category = input.id
    ? await prisma.qualityCategory.findFirst({ where: { id: input.id, workspaceId } })
    : await prisma.qualityCategory.findUnique({ where: { workspaceId_name: { workspaceId, name: normalize(input.category ?? '') } } });
  if (!category) throw new HttpError(404, `Categoria "${input.category ?? input.id}" não existe no registro. Use quality_list para ver as categorias.`);
  if (input.status && !QUALITY_STATUSES.includes(input.status)) throw new HttpError(400, `Situação inválida. Use: ${QUALITY_STATUSES.join(', ')}.`);
  const updated = await prisma.qualityCategory.update({
    where: { id: category.id },
    data: {
      ...(input.status && { status: input.status }),
      ...(input.transversalRef !== undefined && { transversalRef: input.transversalRef?.trim() || null }),
      ...(input.name && { name: normalize(input.name) }),
    },
  });
  return { id: updated.id, name: updated.name, status: updated.status, transversalRef: updated.transversalRef };
}
