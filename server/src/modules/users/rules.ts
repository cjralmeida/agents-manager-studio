export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Problem with an e-mail address in Portuguese, or null. */
export function emailProblem(email: string) {
  if (!email) return 'Informe o e-mail.';
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'E-mail inválido.';
  return null;
}

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];
