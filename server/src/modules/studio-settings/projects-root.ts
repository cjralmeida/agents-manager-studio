/**
 * Rules for a new central folder. The Windows helper (studio.ps1, Test-ProjectsDir) applies the same ones and
 * also checks that the folder exists, which the server cannot see.
 */

const SYSTEM_FOLDER = /^[a-z]:\/(windows|program files|program files \(x86\)|programdata)(\/|$)/i;
const USERS_ROOT = /^[a-z]:\/users(\/[^/]+)?$/i;
/** Characters that could break out of the quoted PowerShell argument. */
const UNSAFE = /["'`$;|&<>*?\u0000-\u001f]/;
const INVALID_NAME = /[<>:"/\\|?*'`$;&\u0000-\u001f]/;

export type FolderCheck = { path: string; problem: null } | { path: null; problem: string };

/** Normalizes "D:\Projetos\" to "D:/Projetos" and refuses drive roots and system folders. */
export function checkProjectsDir(input: string): FolderCheck {
  const path = input.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  if (!/^[a-z]:\/.+/i.test(path)) return { path: null, problem: 'Informe o caminho completo de uma pasta do Windows, como D:/Projetos.' };
  if (UNSAFE.test(path)) return { path: null, problem: 'O caminho não pode ter aspas nem os caracteres ` $ ; | & < > * ?.' };
  if (SYSTEM_FOLDER.test(path) || USERS_ROOT.test(path)) return { path: null, problem: 'Escolha uma pasta de projetos, não uma pasta do sistema.' };
  return { path, problem: null };
}

/** Folder names the scan ignores; returns the cleaned list or the problem. */
export function checkExcludeNames(names: string[]): { names: string[]; problem: string | null } {
  const cleaned = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  const invalid = cleaned.find((name) => INVALID_NAME.test(name) || name.length > 80);
  if (invalid) return { names: [], problem: `"${invalid}" não é um nome de pasta válido.` };
  if (cleaned.length > 30) return { names: [], problem: 'Use no máximo 30 pastas ignoradas.' };
  return { names: cleaned, problem: null };
}

/** Same paths, ignoring case and slash direction (Windows). */
export function sameFolder(a: string, b: string) {
  const normalize = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

/** One-shot command for when the helper is not running (PowerShell, from any folder). */
export function manualCommand(input: { studioDir: string | null; dev: boolean; path: string; exclude: string[] }) {
  const script = input.studioDir ? `'${input.studioDir.replaceAll("'", "''")}\\studio.ps1'` : '.\\studio.ps1';
  const exclude = input.exclude.length > 0 ? ` -Exclude '${input.exclude.join(',')}'` : ' -NoExclude';
  return `powershell -NoProfile -ExecutionPolicy Bypass -File ${script} -ProjectsDir '${input.path}'${exclude}${input.dev ? ' -Dev' : ''}`;
}
