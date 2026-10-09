/** Variable names agents may receive: shell-friendly and never one the runner itself relies on. */
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED = /^(PATH|HOME|USER|SHELL|PWD|LANG|TERM|MODEL|SERVER_URL|(NODE|AGENT|CLAUDE|ANTHROPIC|STUDIO|TEST|LD|PLAYWRIGHT|JAVA|MAVEN|GO|PIP|IDLE|RESUME|SYSTEM)_.*)$/i;

/** Why a name cannot be used, or null when it can. */
export function variableKeyError(key: string) {
  if (!KEY.test(key)) return 'Use letras, números e _, sem começar por número (até 64 caracteres).';
  if (RESERVED.test(key)) return `"${key}" é reservado pelo Studio ou pelo ambiente dos agentes.`;
  return null;
}

/** Content of the file agents load with `set -a; . /run/studio/variables.env; set +a`. */
export function renderEnvFile(variables: { key: string; value: string }[]) {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const lines = variables.map((variable) => `${variable.key}=${quote(variable.value)}`);
  return `# Variáveis do workspace no Agents Manager Studio. Não imprima os valores.\n${lines.join('\n')}\n`;
}
