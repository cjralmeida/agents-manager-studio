import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { saveViewProfiles, setActiveViewProfile, viewProfilesResponse } from './service.js';

const profilesBody = z
  .object({
    profiles: z
      .array(z.object({ id: z.uuid().nullable().optional(), name: z.string().max(60), workspaceIds: z.array(z.uuid()).max(200) }).strict())
      .max(30),
  })
  .strict();

const activeBody = z.object({ id: z.uuid().nullable() }).strict();

/** The user's view profiles (which workspaces the Studio shows). */
export async function viewProfileRoutes(app: FastifyInstance) {
  app.get('/view-profiles', async (request) => viewProfilesResponse(request.user.id));

  app.put('/view-profiles', async (request) => saveViewProfiles(request.user.id, parseInput(profilesBody, request.body).profiles));

  app.put('/view-profiles/active', async (request) => setActiveViewProfile(request.user.id, parseInput(activeBody, request.body).id));
}
