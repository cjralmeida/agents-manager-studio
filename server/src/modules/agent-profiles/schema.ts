import { z } from 'zod';
import { AGENT_MODELS } from '../agents/service.js';

/** Studio tool groups a workspace agent can use. */
export const PROFILE_TOOLS = ['board', 'render', 'render_read', 'clickup_read', 'projects', 'pixellab', 'test_env'] as const;

/** A workspace agent as the form (and Órbi's proposals) describe it. */
export const profileSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(300).default(''),
    instructions: z.string().max(20_000).default(''),
    model: z.enum(AGENT_MODELS).default('sonnet'),
    projectIds: z.array(z.uuid()).max(50).default([]),
    /** Projects it can only read, mounted read-only as they are on disk (e.g. code to document). */
    contextProjectIds: z.array(z.uuid()).max(20).default([]),
    /** Works on the project the workflow is on (e.g. one an earlier step created), not on fixed projects. */
    anyProject: z.boolean().default(false),
    output: z.enum(['PULL_REQUEST', 'RESULT']).default('PULL_REQUEST'),
    tools: z.array(z.enum(PROFILE_TOOLS)).default([]),
    autoConclude: z.boolean().default(false),
    /** Merge the PR/MR as soon as it is opened (only for agents that deliver code). */
    autoMerge: z.boolean().default(false),
  })
  .strict();
