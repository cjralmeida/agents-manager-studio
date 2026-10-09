import { z } from 'zod';

/**
 * How a workflow starts:
 * - "manual": a conversation started in the Studio (the message goes to the first step);
 * - "board_task": a task appears on the board matching the filters;
 * - "feature_in_homologation": every open task of a feature ("[FUNC-NNN]" in the title) reached the homologation
 *   column, so the whole feature can be tested there.
 */
export const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }).strict(),
  z
    .object({
      type: z.literal('board_task'),
      /** Column watched; null uses the board's "todo" column. */
      columnId: z.string().min(1).max(200).nullable().default(null),
      fieldFilters: z.record(z.string().min(1).max(200), z.array(z.string().min(1).max(200)).max(50)).default({}),
      repositories: z.array(z.string().trim().min(1).max(300)).max(100).default([]),
      onlyUnassigned: z.boolean().default(true),
      /** Column the task goes to when the run's last step succeeds. */
      moveWhenDone: z.enum(['done', 'homologation']).default('done'),
    })
    .strict(),
  z
    .object({
      type: z.literal('feature_in_homologation'),
      repositories: z.array(z.string().trim().min(1).max(300)).max(100).default([]),
    })
    .strict(),
]);
export type WorkflowTrigger = z.infer<typeof triggerSchema>;

export const stepSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: z.string().min(1).max(40),
      name: z.string().trim().min(1).max(80),
      kind: z.literal('agent'),
      profileId: z.uuid(),
      /** Runs once per task the previous step created on the board (one lane per task). */
      forEachTask: z.boolean().default(false),
      /**
       * Tasks handled at the same time when running per task. One at a time (default) lets each task
       * start from what the previous one already merged, avoiding conflicts between them.
       */
      maxParallel: z.number().int().min(1).max(5).default(1),
      /** Starts from the previous agent's copy and branch (e.g. a tester checking the executor's work). */
      continueFromPrevious: z.boolean().default(false),
      /** Starts from the open PR/MR that cites the run's task (work done outside the Studio), e.g. to publish it. */
      fromTaskPullRequest: z.boolean().default(false),
      /** Extra instructions for this step, on top of the agent's role. */
      instructions: z.string().max(10_000).default(''),
      /** When this step fails, sends the report back to an earlier step and runs again from there. */
      onFailure: z
        .object({ retryStepId: z.string().min(1).max(40), maxAttempts: z.number().int().min(1).max(5) })
        .nullable()
        .default(null),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(40),
      name: z.string().trim().min(1).max(80),
      kind: z.literal('deploy'),
      /** Deploys always start in homologation. */
      environment: z.enum(['HOMOLOGACAO', 'PRODUCAO']).default('HOMOLOGACAO'),
    })
    .strict(),
]);
export type WorkflowStep = z.infer<typeof stepSchema>;
export type AgentStep = Extract<WorkflowStep, { kind: 'agent' }>;

/** A workflow as the form (and Órbi's proposals) describe it. */
export const workflowSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(''),
    isEnabled: z.boolean().default(true),
    trigger: triggerSchema,
    steps: z.array(stepSchema).min(1).max(12),
    maxConcurrentRuns: z.number().int().min(1).max(5).default(1),
  })
  .strict();

/** What validation needs to know about the workspace agents used by the steps. */
export interface ProfileFacts {
  id: string;
  name: string;
  hasRepository: boolean;
  deliversCode: boolean;
  usesBoard: boolean;
}

/** Rules that make a chain runnable; returns problems in Portuguese (empty when valid). */
export function validateSteps(steps: WorkflowStep[], profiles: ProfileFacts[]) {
  const problems: string[] = [];
  if (steps.length === 0) problems.push('Adicione ao menos um passo.');
  const ids = steps.map((step) => step.id);
  if (new Set(ids).size !== ids.length) problems.push('Os passos precisam de ids diferentes.');

  const fanOuts = steps.filter((step) => step.kind === 'agent' && step.forEachTask);
  if (fanOuts.length > 1) problems.push('Só um passo pode rodar "para cada tarefa criada".');

  steps.forEach((step, index) => {
    const label = `Passo ${index + 1} (${step.name})`;
    const previous = steps[index - 1];
    const previousProfile = previous?.kind === 'agent' ? profiles.find((profile) => profile.id === previous.profileId) : undefined;

    if (step.kind === 'deploy') {
      const codeStep = steps
        .slice(0, index)
        .some((earlier) => earlier.kind === 'agent' && profiles.find((profile) => profile.id === earlier.profileId)?.deliversCode);
      if (!codeStep) problems.push(`${label}: o deploy precisa de um passo anterior com agente que entrega código (PR/MR).`);
      return;
    }

    const profile = profiles.find((entry) => entry.id === step.profileId);
    if (!profile) {
      problems.push(`${label}: agente do workspace não encontrado.`);
      return;
    }
    if (step.forEachTask && (!previousProfile || !previousProfile.usesBoard)) {
      problems.push(`${label}: "para cada tarefa criada" precisa de um passo anterior com agente que usa o quadro.`);
    }
    if (step.fromTaskPullRequest && step.continueFromPrevious) {
      problems.push(`${label}: escolha entre "continuar do passo anterior" e "publicar o PR/MR da tarefa".`);
    }
    if (step.fromTaskPullRequest && !profile.hasRepository) {
      problems.push(`${label}: o agente "${profile.name}" precisa trabalhar em repositório para publicar o PR/MR da tarefa.`);
    }
    if (step.continueFromPrevious && (!previousProfile || !previousProfile.hasRepository)) {
      problems.push(`${label}: "continuar do passo anterior" precisa de um agente anterior que trabalhe em repositório.`);
    }
    if (step.continueFromPrevious && !profile.hasRepository) {
      problems.push(`${label}: o agente "${profile.name}" não trabalha em repositório, então não pode continuar o trabalho anterior.`);
    }
    if (step.onFailure) {
      const targetIndex = ids.indexOf(step.onFailure.retryStepId);
      const target = steps[targetIndex];
      if (targetIndex === -1 || targetIndex >= index || target?.kind !== 'agent') {
        problems.push(`${label}: ao falhar, só é possível devolver para um passo de agente anterior.`);
      }
    }
  });
  return problems;
}

/** Index of the step that fans out into one lane per created task, or -1. */
export function fanOutIndex(steps: WorkflowStep[]) {
  return steps.findIndex((step) => step.kind === 'agent' && step.forEachTask);
}

/** Lane a step runs in for a given task lane: steps before the fan-out run once, in "main". */
export function laneFor(steps: WorkflowStep[], stepIndex: number, lane: string) {
  const fanOut = fanOutIndex(steps);
  return fanOut === -1 || stepIndex < fanOut ? 'main' : lane;
}
