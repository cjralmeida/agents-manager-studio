import { z } from 'zod';
import { prisma } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { prepareTaskByNames } from '../agent-tools/service.js';
import { profileSchema } from '../agent-profiles/schema.js';
import { createAgentProfile, deleteAgentProfile, updateAgentProfile } from '../agent-profiles/service.js';
import { addEvent, sendMessage } from '../agents/service.js';
import { createTask } from '../boards/service.js';
import { workflowSchema } from '../workflows/definition.js';
import { cancelWorkflowRun, createWorkflow, deleteWorkflow, startWorkflow, updateWorkflow, validateWorkflow } from '../workflows/service.js';

export const PROPOSAL_KINDS = [
  'create_agent',
  'update_agent',
  'delete_agent',
  'create_workflow',
  'update_workflow',
  'delete_workflow',
  'start_workflow',
  'cancel_run',
  'create_task',
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

const idPayload = z.object({ id: z.uuid() }).strict();

/** Payload of each kind; the same schemas as the forms, so Órbi cannot propose what the UI would refuse. */
const payloadSchemas: Record<ProposalKind, z.ZodType> = {
  create_agent: profileSchema,
  update_agent: profileSchema.partial().extend({ id: z.uuid() }),
  delete_agent: idPayload,
  create_workflow: workflowSchema,
  update_workflow: workflowSchema.partial().extend({ id: z.uuid() }),
  delete_workflow: idPayload,
  start_workflow: z.object({ workflowId: z.uuid(), message: z.string().trim().max(20_000).optional() }).strict(),
  cancel_run: z.object({ runId: z.uuid() }).strict(),
  create_task: z
    .object({
      title: z.string().trim().min(1).max(250),
      body: z.string().max(60_000).default(''),
      repository: z.string().optional(),
      column: z.string().optional(),
      fields: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
};

function zodProblems(error: z.ZodError) {
  return error.issues.map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`).join('; ');
}

async function ensureInWorkspace(workspaceId: string, kind: ProposalKind, payload: Record<string, unknown>) {
  const id = String(payload.id ?? payload.workflowId ?? payload.runId ?? '');
  if (kind.endsWith('_agent') && kind !== 'create_agent') {
    if (!(await prisma.agentProfile.count({ where: { id, workspaceId } }))) throw new HttpError(422, 'Agente não encontrado neste workspace.');
  }
  if ((kind.endsWith('_workflow') && kind !== 'create_workflow') || kind === 'start_workflow') {
    if (!(await prisma.workflow.count({ where: { id, workspaceId } }))) throw new HttpError(422, 'Workflow não encontrado neste workspace.');
  }
  if (kind === 'cancel_run' && !(await prisma.workflowRun.count({ where: { id, workspaceId, status: 'RUNNING' } }))) {
    throw new HttpError(422, 'Execução de workflow não encontrada ou já terminada.');
  }
}

/** Checks a proposal exactly as applying would, without changing anything. Returns the normalized payload. */
async function validateProposal(workspaceId: string, kind: ProposalKind, payload: unknown) {
  const parsed = payloadSchemas[kind].safeParse(payload);
  if (!parsed.success) throw new HttpError(422, `Proposta inválida: ${zodProblems(parsed.error)}`);
  const data = parsed.data as Record<string, unknown>;
  await ensureInWorkspace(workspaceId, kind, data);

  if (kind === 'create_workflow') await validateWorkflow(workspaceId, data as Parameters<typeof validateWorkflow>[1]);
  if (kind === 'update_workflow' && (data.steps || data.trigger)) {
    const current = await prisma.workflow.findUniqueOrThrow({ where: { id: String(data.id) } });
    await validateWorkflow(workspaceId, {
      steps: (data.steps ?? current.steps) as never,
      trigger: (data.trigger ?? current.trigger) as never,
    });
  }
  if (kind === 'create_task') await prepareTaskByNames(workspaceId, data);
  return data;
}

/** Called by Órbi's studio_propose tool: validates, stores and shows the proposal card in the conversation. */
export async function createProposal(agentId: string, kind: ProposalKind, summary: string, payload: unknown) {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  const data = await validateProposal(agent.workspaceId, kind, payload);
  const proposal = await prisma.assistantProposal.create({
    data: { agentId, workspaceId: agent.workspaceId, kind, summary: summary.slice(0, 500), payload: data as Prisma.InputJsonValue },
  });
  await addEvent(agentId, 'proposal', { proposalId: proposal.id, kind, summary: proposal.summary });
  return { proposalId: proposal.id, status: 'pending', message: 'Proposta mostrada ao usuário; aguarde ele aplicar ou descartar.' };
}

async function apply(workspaceId: string, kind: ProposalKind, payload: Record<string, unknown>) {
  const { id, ...rest } = payload as { id?: string } & Record<string, unknown>;
  switch (kind) {
    case 'create_agent': {
      const profile = await createAgentProfile(workspaceId, payload as never);
      return { agentProfileId: profile.id, name: profile.name };
    }
    case 'update_agent':
      return { agentProfileId: (await updateAgentProfile(id!, rest as never)).id };
    case 'delete_agent':
      await deleteAgentProfile(id!);
      return { deleted: id };
    case 'create_workflow': {
      const workflow = await createWorkflow(workspaceId, payload as never);
      return { workflowId: workflow.id, name: workflow.name };
    }
    case 'update_workflow':
      return { workflowId: (await updateWorkflow(id!, rest as never)).id };
    case 'delete_workflow':
      await deleteWorkflow(id!);
      return { deleted: id };
    case 'start_workflow':
      return startWorkflow(String(payload.workflowId), payload.message as string | undefined);
    case 'cancel_run':
      return { runId: (await cancelWorkflowRun(String(payload.runId))).id };
    case 'create_task': {
      const task = await createTask(workspaceId, await prepareTaskByNames(workspaceId, payload));
      return { taskId: task.id };
    }
  }
}

export async function listProposals(agentId: string) {
  return prisma.assistantProposal.findMany({ where: { agentId }, orderBy: { createdAt: 'asc' } });
}

/** The user's decision; Órbi is told the outcome so the conversation can continue. */
export async function decideProposal(id: string, decision: 'apply' | 'discard') {
  const proposal = await prisma.assistantProposal.findUnique({ where: { id } });
  if (!proposal) throw notFound('Proposta não encontrada.');
  if (proposal.status !== 'PENDING') throw new HttpError(409, 'Esta proposta já foi decidida.');

  if (decision === 'discard') {
    await prisma.assistantProposal.update({ where: { id }, data: { status: 'DISCARDED', decidedAt: new Date() } });
    await sendMessage(proposal.agentId, `[Studio] Descartei a proposta "${proposal.summary}".`).catch(() => undefined);
    return prisma.assistantProposal.findUniqueOrThrow({ where: { id } });
  }

  try {
    const payload = (await validateProposal(proposal.workspaceId, proposal.kind as ProposalKind, proposal.payload)) as Record<string, unknown>;
    const result = await apply(proposal.workspaceId, proposal.kind as ProposalKind, payload);
    await prisma.assistantProposal.update({
      where: { id },
      data: { status: 'APPLIED', result: (result ?? {}) as Prisma.InputJsonValue, decidedAt: new Date() },
    });
    await sendMessage(proposal.agentId, `[Studio] Apliquei a proposta "${proposal.summary}". Resultado: ${JSON.stringify(result ?? {})}`).catch(
      () => undefined,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.assistantProposal.update({ where: { id }, data: { status: 'FAILED', error: message, decidedAt: new Date() } });
    await sendMessage(proposal.agentId, `[Studio] A proposta "${proposal.summary}" falhou ao ser aplicada: ${message}`).catch(() => undefined);
  }
  return prisma.assistantProposal.findUniqueOrThrow({ where: { id } });
}
