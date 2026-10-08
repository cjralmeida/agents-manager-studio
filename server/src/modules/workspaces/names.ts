/** Names Windows refuses for files and folders, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

/**
 * Checks a new workspace (folder) name; returns the problem in Portuguese, or null when it is valid.
 * `excluded` are the folders the scan ignores (e.g. "Pessoais"), compared without case.
 */
export function workspaceNameProblem(name: string, excluded: string[]) {
  const trimmed = name.trim();
  if (!trimmed) return 'Informe o nome do workspace.';
  if (trimmed.length > 80) return 'Use no máximo 80 caracteres.';
  if (INVALID_CHARS.test(trimmed)) return 'O nome não pode ter os caracteres < > : " / \\ | ? *.';
  if (trimmed === '.' || trimmed === '..' || trimmed.startsWith('.')) return 'O nome não pode começar com ponto.';
  if (/[. ]$/.test(trimmed)) return 'O nome não pode terminar com ponto ou espaço.';
  if (RESERVED.test(trimmed)) return `"${trimmed}" é um nome reservado do Windows.`;
  if (excluded.includes(trimmed.toLowerCase())) return `"${trimmed}" está na lista de pastas ignoradas pelo Studio.`;
  return null;
}
