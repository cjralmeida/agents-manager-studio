import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { type Agent, type AgentStatus, useAgents } from '../api/agents';

const MUTED_KEY = 'ams.notifications.muted';
const APP_TITLE = 'Agents Manager Studio';

/** Status changes worth a browser notification. */
const MESSAGES: Partial<Record<AgentStatus, (agent: Agent) => { title: string; body: string }>> = {
  WAITING_INPUT: (agent) => ({
    title: `Pergunta de ${agent.title}`,
    body: agent.pendingQuestion?.[0]?.question ?? 'O agente está aguardando a sua resposta.',
  }),
  READY_FOR_REVIEW: (agent) => ({ title: `Pronto para revisão: ${agent.title}`, body: `${agent.projectName ?? ''} — revise o diff e conclua.` }),
  COMPLETED: (agent) => ({ title: `PR/MR aberto: ${agent.title}`, body: agent.prUrl ?? 'Alterações enviadas.' }),
  FAILED: (agent) => ({ title: `Agente falhou: ${agent.title}`, body: agent.errorMessage ?? 'Veja os detalhes no Studio.' }),
};

const supported = () => typeof window !== 'undefined' && 'Notification' in window;

function readMuted() {
  try {
    return localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Permission state plus a per-browser mute switch. */
export function useNotificationSettings() {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    supported() ? Notification.permission : 'unsupported',
  );
  const [muted, setMutedState] = useState(readMuted);

  const request = async () => {
    if (!supported()) return;
    setPermission(await Notification.requestPermission());
  };
  const setMuted = (value: boolean) => {
    setMutedState(value);
    try {
      localStorage.setItem(MUTED_KEY, value ? '1' : '0');
    } catch {
      // Preference only.
    }
  };
  return { permission, muted, request, setMuted, enabled: permission === 'granted' && !muted };
}

/**
 * Watches all agents: notifies status changes while the Studio is not in focus, and shows the
 * number of agents waiting for the user in the tab title. Returns that number.
 */
export function useAgentNotifications(enabled: boolean) {
  const agents = useAgents();
  const navigate = useNavigate();
  const previous = useRef<Map<string, AgentStatus> | null>(null);
  const waiting = agents.data?.filter((agent) => agent.status === 'WAITING_INPUT').length ?? 0;

  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) ${APP_TITLE}` : APP_TITLE;
  }, [waiting]);

  useEffect(() => {
    if (!agents.data) return;
    const current = new Map(agents.data.map((agent) => [agent.id, agent.status]));
    const before = previous.current;
    previous.current = current;
    // The first load only records the statuses.
    if (!before || !enabled || !supported()) return;

    const inFocus = document.visibilityState === 'visible' && document.hasFocus();
    if (inFocus) return;

    for (const agent of agents.data) {
      const message = MESSAGES[agent.status];
      if (!message || before.get(agent.id) === agent.status) continue;
      const { title, body } = message(agent);
      const notification = new Notification(title, { body, tag: `${agent.id}:${agent.status}`, icon: '/icon-192.png' });
      notification.onclick = () => {
        window.focus();
        navigate(`/agents/${agent.id}`);
        notification.close();
      };
    }
  }, [agents.data, enabled, navigate]);

  return waiting;
}
