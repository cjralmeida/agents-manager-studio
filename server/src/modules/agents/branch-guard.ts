import { HttpError } from '../../lib/errors.js';

/**
 * Agents only touch the branches the user allowed: with a base branch set on the project (e.g. "refactor/api"),
 * every PR/MR, merge and push of an agent must target it, and nothing else (production, "hom", "master"...).
 * Pure checks, so they are unit tested; the callers fetch what to compare.
 */

export interface GuardedProject {
  name: string;
  /** Null: the project has no base branch set, so only the agent's own branch rule applies. */
  baseBranch: string | null;
}

/** The branch an agent's work starts from and opens its PR/MR into. */
export function assertWorkBase(project: GuardedProject, baseBranch: string) {
  if (project.baseBranch && baseBranch !== project.baseBranch) {
    throw new HttpError(
      422,
      `O projeto ${project.name} só aceita trabalho de agentes na branch "${project.baseBranch}", não em "${baseBranch}".`,
    );
  }
}

/** Where an agent's commits are pushed: its own branch (or the branch of the PR it publishes), never the base. */
export function assertPushBranch(project: GuardedProject, agent: { branch: string; baseBranch: string }) {
  assertWorkBase(project, agent.baseBranch);
  const protectedBranches = new Set([agent.baseBranch, project.baseBranch].filter(Boolean));
  if (protectedBranches.has(agent.branch)) {
    throw new HttpError(422, `O Studio não envia commits direto para "${agent.branch}" no projeto ${project.name}: só por PR/MR.`);
  }
}

/** The real target of a PR/MR (read from the provider) before merging it. */
export function assertMergeTarget(project: GuardedProject, expectedBase: string, actualTarget: string, prLabel: string) {
  assertWorkBase(project, expectedBase);
  if (actualTarget !== expectedBase) {
    throw new HttpError(
      422,
      `${prLabel} aponta para "${actualTarget}", mas o projeto ${project.name} só aceita merge em "${expectedBase}". Nada foi mesclado.`,
    );
  }
}
