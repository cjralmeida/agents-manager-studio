import { z } from 'zod';
import { HttpError } from './errors.js';

z.config(z.locales.pt());

export function parseInput<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    throw new HttpError(400, 'Dados inválidos.', fields);
  }
  return result.data;
}
