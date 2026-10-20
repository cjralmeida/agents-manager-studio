import { z } from 'zod';
import { INSTANCE_TYPES } from './service.js';

const environment = z.enum(['HOMOLOGACAO', 'PRODUCAO']);
const url = z.string().trim().url().max(300);
const branch = z.string().trim().min(1).max(200);
/** Where a project runs on AWS in an environment: the Deploys tab and Órbi's set_aws_service proposal. */
export const serviceBody = z.discriminatedUnion('kind', [
  z.object({
    projectId: z.uuid(),
    environment,
    kind: z.literal('ec2'),
    url,
    branch,
    instanceId: z.string().trim().regex(/^(i|mi)-[0-9a-f]+$/, 'Id de instância inválido.').optional(),
    newInstanceType: z.enum(INSTANCE_TYPES).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    healthPath: z.string().trim().startsWith('/').max(200).optional(),
    dockerfile: z.string().trim().max(200).optional(),
  }),
  z.object({
    projectId: z.uuid(),
    environment,
    kind: z.literal('amplify'),
    url: url.optional(),
    branch,
    appId: z.string().trim().min(1).max(100).optional(),
    outputDir: z.string().trim().regex(/^[\w.\/-]+$/, 'Pasta inválida.').max(100).optional(),
  }),
  z.object({ projectId: z.uuid(), environment, kind: z.null() }),
]);
