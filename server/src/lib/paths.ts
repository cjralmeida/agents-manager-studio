import path from 'node:path';
import { config } from '../config.js';

const isWindowsHost = /^[A-Za-z]:[\\/]/.test(config.projectsHostDir);
const hostPath = isWindowsHost ? path.win32 : path.posix;

/** Path inside the container, under the mounted projects root. */
export function toContainerPath(...segments: string[]) {
  return path.posix.join(config.projectsDir, ...segments);
}

/** Same location on the host machine (e.g. D:\Projetos\GlobalFarm), used for display and docker mounts. */
export function toHostPath(...segments: string[]) {
  return hostPath.join(config.projectsHostDir, ...segments);
}
