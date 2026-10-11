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

/**
 * Schema for a partial update: every field optional and without its default. A plain `.partial()` still fills the
 * defaults of the fields left out, so an update of one field would reset the others (e.g. an agent's tools).
 */
export function patchSchema<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>) {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [key, z.optional((field instanceof z.ZodDefault ? field.unwrap() : field) as z.ZodType)]),
  );
  return z.object(shape).strict() as unknown as ReturnType<z.ZodObject<Shape>['partial']>;
}
