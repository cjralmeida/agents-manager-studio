import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export type SkillSource = 'PERSONAL' | 'ACCOUNT';

export interface Skill {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
}

export const skillSourceLabels: Record<SkillSource, string> = {
  PERSONAL: 'Pessoais',
  ACCOUNT: 'Da conta (claude.ai)',
};

export function useSkills() {
  return useQuery({ queryKey: ['skills'], queryFn: () => api.get<Skill[]>('/skills') });
}
