import { prisma } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';

/** Per-user settings (board model, GitHub board template), stored as JSON by key. */
export async function getUserSetting<T>(userId: string, key: string): Promise<T | null> {
  const row = await prisma.userSetting.findUnique({ where: { userId_key: { userId, key } } });
  return (row?.value as T | undefined) ?? null;
}

export async function setUserSetting(userId: string, key: string, value: unknown) {
  const json = value as Prisma.InputJsonValue;
  await prisma.userSetting.upsert({ where: { userId_key: { userId, key } }, create: { userId, key, value: json }, update: { value: json } });
}

export async function deleteUserSetting(userId: string, key: string) {
  await prisma.userSetting.deleteMany({ where: { userId, key } });
}
