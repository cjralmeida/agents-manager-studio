import { z } from 'zod';
import { AGENT_MODELS } from '../agents/service.js';

/** Studio tool groups a workspace agent can use. */
export const PROFILE_TOOLS = ['board', 'render'] as const;

/** A workspace agent as the form (and Órbi's proposals) describe it. */
export const profileSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(300).default(''),
    instructions: z.string().max(20_000).default(''),
    model: z.enum(AGENT_MODELS).default('sonnet'),
    projectIds: z.array(z.uuid()).max(50).default([]),
    output: z.enum(['PULL_REQUEST', 'RESULT']).default('PULL_REQUEST'),
    tools: z.array(z.enum(PROFILE_TOOLS)).default([]),
    autoConclude: z.boolean().default(false),
    /** Merge the PR/MR as soon as it is opened (only for agents that deliver code). */
    autoMerge: z.boolean().default(false),
  })
  .strict();
