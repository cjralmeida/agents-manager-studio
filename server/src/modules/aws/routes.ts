import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { serviceBody } from './schema.js';
import {
  createAwsAccount,
  deleteAwsAccount,
  getAwsSettings,
  listAwsAccounts,
  retryAwsSetup,
  listAwsTargets,
  setAwsService,
  setWorkspaceAwsAccount,
  updateAwsAccount,
  verifyAwsAccount,
} from './service.js';

const idParams = z.object({ id: z.uuid() });
const environment = z.enum(['HOMOLOGACAO', 'PRODUCAO']);
const noSpaces = (min: number, max: number) => z.string().transform((value) => value.replace(/\s+/g, '')).pipe(z.string().min(min).max(max));
const region = z.string().trim().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'Região inválida (ex.: sa-east-1).');

const accountBody = z.object({ label: z.string().trim().min(1).max(80), region, accessKeyId: noSpaces(16, 128), secretAccessKey: noSpaces(20, 200) }).strict();
const accountUpdateBody = z
  .object({ label: z.string().trim().min(1).max(80).optional(), region: region.optional(), accessKeyId: noSpaces(16, 128).optional(), secretAccessKey: noSpaces(20, 200).optional() })
  .strict();
const workspaceAccountBody = z.object({ accountId: z.uuid().nullable() }).strict();
const serviceParams = z.object({ id: z.uuid(), serviceId: z.uuid() });

export async function awsRoutes(app: FastifyInstance) {
  // Global AWS accounts (Conectores page); workspaces pick one.
  app.get('/aws-accounts', async (request) => listAwsAccounts(request.user.id));

  app.post('/aws-accounts', async (request, reply) => reply.code(201).send(await createAwsAccount(request.user.id, parseInput(accountBody, request.body))));

  app.patch('/aws-accounts/:id', async (request) => updateAwsAccount(parseInput(idParams, request.params).id, parseInput(accountUpdateBody, request.body)));

  app.post('/aws-accounts/:id/verify', async (request) => verifyAwsAccount(parseInput(idParams, request.params).id));

  app.delete('/aws-accounts/:id', async (request, reply) => {
    await deleteAwsAccount(parseInput(idParams, request.params).id);
    return reply.code(204).send();
  });

  // Per workspace: the chosen account and where each project runs.
  app.get('/workspaces/:id/aws', async (request) => getAwsSettings(parseInput(idParams, request.params).id));

  app.put('/workspaces/:id/aws/account', async (request) =>
    setWorkspaceAwsAccount(parseInput(idParams, request.params).id, parseInput(workspaceAccountBody, request.body).accountId),
  );

  app.get('/workspaces/:id/aws/targets', async (request) => listAwsTargets(parseInput(idParams, request.params).id));

  app.put('/workspaces/:id/aws/services', async (request) => setAwsService(parseInput(idParams, request.params).id, parseInput(serviceBody, request.body)));

  // Runs the setup again (e.g. after the DNS records were created by hand, or the IAM policy was updated).
  app.post('/workspaces/:id/aws/services/:serviceId/setup', async (request) => {
    const { id, serviceId } = parseInput(serviceParams, request.params);
    return retryAwsSetup(id, serviceId);
  });
}
