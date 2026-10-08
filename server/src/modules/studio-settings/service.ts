import { prisma } from '../../db.js';
import { HttpError } from '../../lib/errors.js';
import { parseBoardUrl } from '../boards/board-url.js';

export interface StudioSettings {
  /** GitHub project copied when the Studio creates a board; empty uses the built-in template. */
  githubBoardTemplateUrl: string | null;
}

const DEFAULTS: StudioSettings = { githubBoardTemplateUrl: null };

export async function getStudioSettings(): Promise<StudioSettings> {
  const rows = await prisma.studioSetting.findMany();
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return { ...DEFAULTS, ...(stored as Partial<StudioSettings>) };
}

export async function updateStudioSettings(input: StudioSettings) {
  const url = input.githubBoardTemplateUrl?.trim() || null;
  if (url && parseBoardUrl(url)?.provider !== 'GITHUB') {
    throw new HttpError(422, 'Informe a URL de um projeto do GitHub (ex.: https://github.com/orgs/<org>/projects/<n>).');
  }
  if (url) {
    await prisma.studioSetting.upsert({
      where: { key: 'githubBoardTemplateUrl' },
      create: { key: 'githubBoardTemplateUrl', value: url },
      update: { value: url },
    });
  } else {
    await prisma.studioSetting.deleteMany({ where: { key: 'githubBoardTemplateUrl' } });
  }
  return getStudioSettings();
}
