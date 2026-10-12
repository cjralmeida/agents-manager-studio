import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { getAutoAnswer, setAutoAnswer } from './service.js';

const body = z.object({ minutes: z.number().int().min(5).max(1440).nullable() }).strict();

/** The user's automatic-answer time (null = off). */
export async function autoAnswerRoutes(app: FastifyInstance) {
  app.get('/auto-answer', async (request) => getAutoAnswer(request.user.id));

  app.put('/auto-answer', async (request) => setAutoAnswer(request.user.id, parseInput(body, request.body).minutes));
}
