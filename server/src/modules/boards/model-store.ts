import { prisma } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { type BoardModel, defaultModel } from './model.js';

const KEY = 'boardModel';

/** The Studio board model; created from the template the first time it is read. */
export async function getModel(): Promise<BoardModel> {
  const row = await prisma.studioSetting.findUnique({ where: { key: KEY } });
  if (row) return row.value as unknown as BoardModel;
  const model = defaultModel();
  await saveModel(model);
  return model;
}

export async function saveModel(model: BoardModel) {
  const value = model as unknown as Prisma.InputJsonValue;
  await prisma.studioSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}
