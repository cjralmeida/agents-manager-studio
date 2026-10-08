import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export interface Health {
  status: 'ok' | 'degraded';
  components: { database: 'up' | 'down' };
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<Health>('/health'),
    refetchInterval: 10_000,
  });
}
