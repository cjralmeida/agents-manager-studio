import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import {
  applyBoardStructure,
  createBoard,
  createTask,
  detectBoards,
  getBoard,
  getBoardLink,
  getBoardStructure,
  getTemplateStructure,
  linkBoard,
  moveItem,
  previewBoardStructure,
  setItemField,
  unlinkBoard,
  updateBoardSettings,
  updateStatusMap,
} from './service.js';
import { STATUS_ROLES } from './types.js';

const workspaceParams = z.object({ id: z.uuid() });
const itemParams = workspaceParams.extend({ itemId: z.string().min(1).max(200) });

const boardQuery = z.object({ refresh: z.stringbool().default(false) }).strict();

const linkBody = z.object({ url: z.url().max(500) }).strict();

const color = z.enum(['GRAY', 'BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'RED', 'PINK', 'PURPLE']);
const structureOption = z
  .object({ id: z.string().min(1).max(200).nullable(), name: z.string().max(200), color, description: z.string().max(500).default('') })
  .strict();
const structure = z
  .object({
    columns: z.array(structureOption).max(60),
    fields: z
      .array(z.object({ id: z.string().min(1).max(200).nullable(), name: z.string().max(200), options: z.array(structureOption).max(60) }).strict())
      .max(30),
  })
  .strict();

const createBody = z
  .object({
    provider: z.enum(['GITHUB', 'GITLAB']),
    host: z.string().trim().min(1).max(200),
    owner: z.string().trim().min(1).max(300),
    title: z.string().trim().min(1).max(100),
    /** Null follows the Studio template. */
    structure: structure.nullable().default(null),
  })
  .strict();

const templateQuery = z.object({ provider: z.enum(['GITHUB', 'GITLAB']) }).strict();
const previewBody = z.object({ structure }).strict();
/** For each removed column holding cards, the column they move to. */
const applyBody = z.object({ structure, columnMoves: z.record(z.string(), z.string()).default({}) }).strict();

const statusMapBody = z.object(Object.fromEntries(STATUS_ROLES.map((role) => [role, z.string().min(1).optional()]))).strict();

/** 1 to 15 minutes between automatic reads of the board. */
const settingsBody = z.object({ refreshIntervalSec: z.number().int().min(60).max(900) }).strict();

const taskBody = z
  .object({
    title: z.string().trim().min(1).max(250),
    body: z.string().max(60_000).default(''),
    repository: z.string().trim().min(1).max(300).nullable(),
    columnId: z.string().min(1).nullable(),
    fields: z.record(z.string(), z.string()).default({}),
  })
  .strict();

const moveBody = z.object({ columnId: z.string().min(1) }).strict();

const fieldBody = z.object({ fieldId: z.string().min(1), optionId: z.string().min(1).nullable() }).strict();

export async function boardRoutes(app: FastifyInstance) {
  app.get('/board-template/structure', async (request) => getTemplateStructure(parseInput(templateQuery, request.query).provider));

  /** Columns and fields of the linked board, to edit them in the Studio. */
  app.get('/workspaces/:id/board/structure', async (request) => getBoardStructure(parseInput(workspaceParams, request.params).id));

  app.post('/workspaces/:id/board/structure/preview', async (request) => {
    const { id } = parseInput(workspaceParams, request.params);
    return previewBoardStructure(id, parseInput(previewBody, request.body).structure);
  });

  app.put('/workspaces/:id/board/structure', async (request) => {
    const { id } = parseInput(workspaceParams, request.params);
    const body = parseInput(applyBody, request.body);
    return applyBoardStructure(id, body.structure, body.columnMoves);
  });

  app.get('/workspaces/:id/board-link', async (request) => getBoardLink(parseInput(workspaceParams, request.params).id));

  app.get('/workspaces/:id/board/detect', async (request) => detectBoards(parseInput(workspaceParams, request.params).id));

  app.post('/workspaces/:id/board/link', async (request) => {
    const { id } = parseInput(workspaceParams, request.params);
    return linkBoard(id, parseInput(linkBody, request.body).url);
  });

  app.post('/workspaces/:id/board/create', async (request) => {
    const { id } = parseInput(workspaceParams, request.params);
    return createBoard(id, parseInput(createBody, request.body));
  });

  app.delete('/workspaces/:id/board/link', async (request, reply) => {
    await unlinkBoard(parseInput(workspaceParams, request.params).id);
    return reply.code(204).send();
  });

  app.put('/workspaces/:id/board/status-map', async (request) => {
    const { id } = parseInput(workspaceParams, request.params);
    return updateStatusMap(id, parseInput(statusMapBody, request.body));
  });

  app.put('/workspaces/:id/board/settings', async (request) => {
    const { id } = parseInput(workspaceParams, request.params);
    return updateBoardSettings(id, parseInput(settingsBody, request.body));
  });

  app.get('/workspaces/:id/board', async (request) => {
    const { id } = parseInput(workspaceParams, request.params);
    return getBoard(id, parseInput(boardQuery, request.query).refresh);
  });

  app.post('/workspaces/:id/board/items', async (request, reply) => {
    const { id } = parseInput(workspaceParams, request.params);
    return reply.code(201).send(await createTask(id, parseInput(taskBody, request.body)));
  });

  app.post('/workspaces/:id/board/items/:itemId/move', async (request, reply) => {
    const { id, itemId } = parseInput(itemParams, request.params);
    await moveItem(id, itemId, parseInput(moveBody, request.body).columnId);
    return reply.code(204).send();
  });

  app.post('/workspaces/:id/board/items/:itemId/field', async (request, reply) => {
    const { id, itemId } = parseInput(itemParams, request.params);
    const { fieldId, optionId } = parseInput(fieldBody, request.body);
    await setItemField(id, itemId, fieldId, optionId);
    return reply.code(204).send();
  });
}
