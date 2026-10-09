import { HttpError } from '../../lib/errors.js';

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

type Args = Record<string, unknown>;

export interface EnvVarChange {
  key: string;
  value?: string;
  generate?: boolean;
}

/** Validates the variables an agent asks to set; throws a message the agent can act on. */
export function parseEnvVars(input: unknown): EnvVarChange[] {
  if (!Array.isArray(input) || input.length === 0) throw new HttpError(400, 'Informe ao menos uma variável em "vars".');
  if (input.length > 50) throw new HttpError(400, 'No máximo 50 variáveis por chamada.');
  const keys = new Set<string>();
  return input.map((entry: Args) => {
    const key = typeof entry?.key === 'string' ? entry.key.trim() : '';
    if (!ENV_KEY.test(key)) throw new HttpError(400, `Nome de variável inválido: "${key}". Use letras, números e _, sem começar por número.`);
    if (keys.has(key)) throw new HttpError(400, `A variável ${key} aparece mais de uma vez.`);
    keys.add(key);
    if (entry.generate === true) return { key, generate: true };
    if (typeof entry.value !== 'string' || entry.value === '') {
      throw new HttpError(400, `Informe o valor de ${key}, ou "generate": true para o Render gerar um segredo aleatório.`);
    }
    if (entry.value.length > 10_000) throw new HttpError(400, `O valor de ${key} é grande demais.`);
    return { key, value: entry.value };
  });
}
