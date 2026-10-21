import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { type Agent, type AgentStatus, useAgents } from '../api/agents';
import { type Medal, detailsCard, medalIcon } from './notification-art';

const MUTED_KEY = 'ams.notifications.muted';
const APP_TITLE = 'Agents Manager Studio';

const MEDALS = {
  question: { label: 'Pergunta para você', color: '#8b5cf6', glyph: 'question' },
  review: { label: 'Pronta para revisão', color: '#f59e0b', glyph: 'eye' },
  approved: { label: 'Aprovada', color: '#eab308', glyph: 'check' },
  rejected: { label: 'Reprovada', color: '#e11d48', glyph: 'cross' },
  published: { label: 'Publicada em HOM', color: '#0ea5e9', glyph: 'rocket' },
  done: { label: 'Concluída', color: '#22c55e', glyph: 'check' },
  unfinished: { label: 'Não concluída', color: '#f97316', glyph: 'cross' },
  failed: { label: 'Falhou', color: '#dc2626', glyph: 'bang' },
} satisfies Record<string, Medal>;

/** Statuses worth a browser notification. */
const NOTIFIED: AgentStatus[] = ['WAITING_INPUT', 'READY_FOR_REVIEW', 'COMPLETED', 'FAILED'];

/** "Revisar: [FUNC-029] API — ..." → the step ("Revisar") and the task title. */
function splitTitle(title: string) {
  const match = /^([^:[]{2,40}):\s+(.+)$/.exec(title);
  return match ? { step: match[1]!.trim(), task: match[2]!.trim() } : { step: null, task: title };
}

/** The medal of what happened to the agent: reviews and tests approve or reject, publishing goes to HOM. */
function medalOf(agent: Agent, step: string | null): Medal {
  if (agent.status === 'WAITING_INPUT') return MEDALS.question;
  if (agent.status === 'READY_FOR_REVIEW') return MEDALS.review;
  if (agent.status === 'FAILED') return MEDALS.failed;
  const judges = /revis|test|valid|homolog/i.test(step ?? '') && !/publicar/i.test(step ?? '');
  if (agent.result?.status === 'failure') return judges ? MEDALS.rejected : MEDALS.unfinished;
  if (/publicar/i.test(step ?? '')) return MEDALS.published;
  return judges ? MEDALS.approved : MEDALS.done;
}

function duration(agent: Agent) {
  const minutes = Math.max(1, Math.round((new Date(agent.finishedAt ?? Date.now()).getTime() - new Date(agent.createdAt).getTime()) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** First meaningful line of a text, without Markdown marks. */
function firstLine(text: string | null | undefined) {
  const line = text
    ?.split('\n')
    .map((entry) => entry.replace(/^[#>*\-\s\d.]+/, '').replace(/[*_`]/g, '').trim())
    .find((entry) => entry.length > 3);
  return line ? (line.length > 220 ? `${line.slice(0, 219)}…` : line) : null;
}

/** What a notification says about an agent: the text lines and the pictures. */
function describe(agent: Agent) {
  const { step, task } = splitTitle(agent.title);
  const medal = medalOf(agent, step);
  const summary =
    agent.status === 'WAITING_INPUT'
      ? (agent.pendingQuestion?.[0]?.question ?? 'O agente está aguardando a sua resposta.')
      : agent.status === 'FAILED'
        ? (agent.errorMessage ?? 'Veja os detalhes no Studio.')
        : agent.status === 'READY_FOR_REVIEW'
          ? 'Revise o diff e conclua.'
          : (firstLine(agent.result?.summary) ?? firstLine(agent.result?.details) ?? (agent.prUrl ? `PR/MR: ${agent.prUrl}` : null));
  const facts = [
    agent.workspaceName,
    duration(agent),
    agent.usage.costUsd > 0 ? `US$ ${agent.usage.costUsd.toFixed(2).replace('.', ',')}` : null,
    agent.profileName,
  ].filter((fact): fact is string => Boolean(fact));
  const heading = [step, agent.taskRef?.replace(/^.*\//, '')].filter(Boolean).join(' · ');
  return {
    title: `${medal.label} — ${task}`,
    body: [heading, summary, facts.slice(0, 3).join(' · ')].filter(Boolean).join('\n'),
    icon: medalIcon(medal),
    image: detailsCard({ medal, step, taskRef: agent.taskRef?.replace(/^.*\//, '') ?? null, title: task, summary, facts }),
    // Questions and bad news wait on screen until seen.
    requireInteraction: medal === MEDALS.question || medal === MEDALS.rejected || medal === MEDALS.failed,
  };
}

function show(agent: Agent, onClick: () => void) {
  const { title, ...options } = describe(agent);
  // `image` (the large card) is shown by Chrome but missing from TypeScript's NotificationOptions.
  const notification = new Notification(title, { ...options, tag: `${agent.id}:${agent.status}` } as NotificationOptions);
  notification.onclick = () => {
    window.focus();
    onClick();
    notification.close();
  };
}

/** A sample notification, to see how they look. */
export function previewNotification() {
  const now = Date.now();
  show(
    {
      id: 'preview',
      title: 'Revisar: [FUNC-029] API — registro de insumos (CRUD e exportações)',
      status: 'COMPLETED',
      taskRef: 'realtec-vicosa/globalfarm/globalfarm#107',
      workspaceName: 'GlobalFarm',
      profileName: 'Code Guardian',
      createdAt: new Date(now - 23 * 60_000).toISOString(),
      finishedAt: new Date(now).toISOString(),
      usage: { costUsd: 1.84, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      result: { status: 'success', summary: 'Regras RN-01 a RN-07 cobertas, 94% de linhas e ramos testados, nenhum bloqueio.' },
    } as Agent,
    () => undefined,
  );
}

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
      if (!NOTIFIED.includes(agent.status) || before.get(agent.id) === agent.status) continue;
      show(agent, () => navigate(`/agents/${agent.id}`));
    }
  }, [agents.data, enabled, navigate]);

  return waiting;
}
