import type { AgentStatus } from '../../api/agents';
import { Badge } from '../Badge';

type Tone = Parameters<typeof Badge>[0]['tone'];

export const agentStatusLabels: Record<AgentStatus, { label: string; tone: Tone }> = {
  PREPARING: { label: 'Preparando', tone: 'info' },
  RUNNING: { label: 'Trabalhando', tone: 'info' },
  WAITING_INPUT: { label: 'Aguardando você', tone: 'warning' },
  READY_FOR_REVIEW: { label: 'Pronto para revisão', tone: 'success' },
  FINALIZING: { label: 'Enviando', tone: 'info' },
  COMPLETED: { label: 'Concluído', tone: 'success' },
  FAILED: { label: 'Falhou', tone: 'danger' },
  CANCELLED: { label: 'Cancelado', tone: 'neutral' },
};

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  const { label, tone } = agentStatusLabels[status];
  return <Badge tone={tone}>{label}</Badge>;
}
