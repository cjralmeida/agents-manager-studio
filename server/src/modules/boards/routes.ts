import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation.js';
import { applyConversion, applyModel, getConversion, getModelState, previewConversion, previewModel } from './model-service.js';
import {
  createBoard,
  createTask,
  detectBoards,
  getBoard,
  getBoardLink,
  linkBoard,
  moveItem,
  setItemField,
  unlinkBoard,
  updateBoardSettings,
} from './service.js';
import { STATUS_ROLES } from './types.js';

const workspaceParams = z.object({ id: z.uuid() });
const itemParams = workspaceParams.extend({ itemId: z.string().min(1).max(200) });

const boardQuery = z.object({ refresh: z.stringbool().default(false) }).strict();

const linkBody = z.object({ url: z.url().max(500) }).strict();

const color = z.enum(['GRAY', 'BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'RED', 'PINK', 'PURPLE']);
const modelOption = z
  .object({ id: z.string().min(1).max(200).nullable(), name: z.string().max(200), color, description: z.string().max(500).default('') })
  .strict();
const model = z
  .object({
    columns: z.array(modelOption.extend({ role: z.enum(STATUS_ROLES).nullable().default(null) }).strict()).max(60),
    fields: z
      .array(z.object({ id: z.string().min(1).max(200).nullable(), name: z.string().max(200), options: z.array(modelOption).max(60) }).strict())
      .max(30),
  })
  .strict();

const createBody = z
  .object({
    provider: z.enum(['GITHUB', 'GITLAB']),
    host: z.string().trim().min(1).max(200),
    owner: z.string().trim().min(1).max(300),
    title: z.string().trim().min(1).max(100),
  })
  .strict();

const modelPreviewBody = z.object({ model }).strict();
/** For each removed model column, the model column its cards move to. */
const modelApplyBody = z.object({ model, columnMoves: z.record(z.string(), z.string()).default({}) }).strict();

const id = z.string().min(1).max(200);
const conversionBody = z
  .object({
    mapping: z
      .object({
        columns: z.record(id, id),
        fields: z.record(id, id.nullable()),
        options: z.record(id, z.record(id, id.nullable())),
      })
      .strict(),
  })
  .strict();


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
  /** The Studio board model, the boards that follow it and how many cards use each part. */
  app.get('/board-model', async () => getModelState());

  app.post('/board-model/preview', async (request) => previewModel(parseInput(modelPreviewBody, request.body).model));

  /** Saves the model and applies it to every board that follows it. */
  app.put('/board-model', async (request) => {
    const body = parseInput(modelApplyBody, request.body);
    return applyModel(body.model, body.columnMoves);
  });

  /** The workspace board next to the model, to convert it (or sync it again after a change on the provider). */
  app.get('/workspaces/:id/board/conversion', async (request) => getConversion(parseInput(workspaceParams, request.params).id));

  app.post('/workspaces/:id/board/conversion/preview', async (request) => {
    const { id: workspaceId } = parseInput(workspaceParams, request.params);
    return previewConversion(workspaceId, parseInput(conversionBody, request.body).mapping);
  });

  app.put('/workspaces/:id/board/conversion', async (request) => {
    const { id: workspaceId } = parseInput(workspaceParams, request.params);
    return applyConversion(workspaceId, parseInput(conversionBody, request.body).mapping);
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
