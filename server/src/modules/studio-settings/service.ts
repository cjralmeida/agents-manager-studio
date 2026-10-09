import { config } from '../../config.js';
import { HttpError } from '../../lib/errors.js';
import { parseBoardUrl } from '../boards/board-url.js';
import { deleteUserSetting, getUserSetting, setUserSetting } from '../users/settings.js';

export interface StudioSettings {
  /** The user's GitHub project copied when the Studio creates a board; empty uses the built-in template. */
  githubBoardTemplateUrl: string | null;
}

const TEMPLATE_KEY = 'githubBoardTemplateUrl';

/** Set in .env (PROJECTS_HOST_DIR, SCAN_EXCLUDE); changing it remounts the folder, done by the Windows helper (host-helper.ts). */
function projectsRoot() {
  return { hostPath: config.projectsHostDir, excluded: config.scanExclude };
}

/** The central folder (the same for everyone) and the user's own board template. */
export async function getStudioSettings(userId: string) {
  return { githubBoardTemplateUrl: await getUserSetting<string>(userId, TEMPLATE_KEY), projectsRoot: projectsRoot() };
}

export async function updateStudioSettings(userId: string, input: StudioSettings) {
  const url = input.githubBoardTemplateUrl?.trim() || null;
  if (url && parseBoardUrl(url)?.provider !== 'GITHUB') {
    throw new HttpError(422, 'Informe a URL de um projeto do GitHub (ex.: https://github.com/orgs/<org>/projects/<n>).');
  }
  if (url) await setUserSetting(userId, TEMPLATE_KEY, url);
  else await deleteUserSetting(userId, TEMPLATE_KEY);
  return getStudioSettings(userId);
}
