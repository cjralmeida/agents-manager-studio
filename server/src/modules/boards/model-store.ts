import { prisma } from '../../db.js';
import { getUserSetting, setUserSetting } from '../users/settings.js';
import { type BoardModel, defaultModel } from './model.js';

const KEY = 'boardModel';

/** The user's board model; created from the template the first time it is read. */
export async function getModel(userId: string): Promise<BoardModel> {
  const stored = await getUserSetting<BoardModel>(userId, KEY);
  if (stored) return stored;
  const model = defaultModel();
  await saveModel(userId, model);
  return model;
}

export async function saveModel(userId: string, model: BoardModel) {
  await setUserSetting(userId, KEY, model);
}

/** Boards follow the model of their workspace's owner. */
export async function getWorkspaceModel(workspaceId: string) {
  const { ownerId } = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { ownerId: true } });
  return getModel(ownerId);
}
