import type { AgentProfile } from '../../api/agentProfiles';
import type { AgentStep, DeployStep, WorkflowStep, WorkflowTrigger } from '../../api/workflows';

export const newStepId = () => Math.random().toString(36).slice(2, 8);

export const agentStep = (profileId: string): AgentStep => ({
  id: newStepId(),
  name: '',
  kind: 'agent',
  profileId,
  agents: 1,
  forEachTask: false,
  maxParallel: 1,
  continueFromPrevious: false,
  fromTaskPullRequest: false,
  model: null,
  instructions: '',
  onFailure: null,
});

export const deployStep = (): DeployStep => ({ id: newStepId(), name: 'Deploy em homologação', kind: 'deploy', agents: 1, environment: 'HOMOLOGACAO' });

export const boardTrigger: Extract<WorkflowTrigger, { type: 'board_task' }> = {
  type: 'board_task',
  columnId: null,
  fieldFilters: {},
  repositories: [],
  onlyUnassigned: true,
  moveWhenDone: 'done',
};

export const featureTrigger: WorkflowTrigger = { type: 'feature_in_homologation', repositories: [] };
export const frontendTrigger: WorkflowTrigger = { type: 'frontend_in_homologation', repositories: [] };

export const decisionTrigger: WorkflowTrigger = { type: 'task_awaiting_decision', repositories: [] };

/** The name shown for a step: its own, or its agent's. */
export function stepLabel(step: WorkflowStep, profiles: AgentProfile[]) {
  if (step.name.trim()) return step.name;
  if (step.kind === 'deploy') return 'Deploy';
  return profiles.find((profile) => profile.id === step.profileId)?.name ?? 'Passo';
}

/**
 * Keeps the step options consistent after the order changes: the first step has no previous one to continue from or
 * to fan out from, and "on failure" can only send back to an earlier agent step.
 */
export function normalizeSteps(steps: WorkflowStep[]): WorkflowStep[] {
  return steps.map((step, index) => {
    if (step.kind !== 'agent') return step;
    const earlier = new Set(steps.slice(0, index).filter((entry) => entry.kind === 'agent').map((entry) => entry.id));
    return {
      ...step,
      forEachTask: index === 0 ? false : step.forEachTask,
      continueFromPrevious: index === 0 ? false : step.continueFromPrevious,
      onFailure: step.onFailure && earlier.has(step.onFailure.retryStepId) ? step.onFailure : null,
    };
  });
}
