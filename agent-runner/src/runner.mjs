// Agent runner: drives Claude Code (Agent SDK) inside the agent container and talks to the Studio server.
// - Pulls user messages and answers from the server inbox (long-poll).
// - Streams progress (text, tool calls, questions, turn ends) back as events.
// - Exits with code 0 after IDLE_TIMEOUT_MS without work; the server resumes the session later.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { startBrowserView } from './browser-view.mjs';
import { createStudioTools } from './studio-tools.mjs';

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing environment variable ${name}`);
  return value;
};

const AGENT_ID = env('AGENT_ID');
const SECRET = env('AGENT_SECRET');
const SERVER_URL = env('SERVER_URL');
const MODEL = env('MODEL', 'sonnet');
const IDLE_TIMEOUT_MS = Number(env('IDLE_TIMEOUT_MS', '600000'));
const RESUME_SESSION_ID = process.env.RESUME_SESSION_ID || undefined;
const SYSTEM_PROMPT_APPEND = process.env.SYSTEM_PROMPT_APPEND || '';
/** Studio tool groups enabled for this agent (e.g. "board,result"). */
const STUDIO_TOOLS = (process.env.STUDIO_TOOLS || '').split(',').filter(Boolean);
// PixelLab's hosted MCP server, for agents with the "pixellab" tool. The token stays in the runner: it is removed from
// the environment before the agent's process starts.
const PIXELLAB_TOKEN = process.env.PIXELLAB_TOKEN || '';
const PIXELLAB_MCP_URL = process.env.PIXELLAB_MCP_URL || 'https://api.pixellab.ai/mcp';
delete process.env.PIXELLAB_TOKEN;
const WORKDIR = '/workspace';

const log = (msg, extra = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }));

// ------------------------------------------------------------------ server API

async function api(path, init = {}) {
  const response = await fetch(`${SERVER_URL}/api/internal/agents/${AGENT_ID}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json', ...init.headers },
  });
  if (!response.ok) throw new Error(`Server answered ${response.status} for ${path}`);
  return response.status === 204 ? null : response.json();
}

/**
 * Events are sent in order. Failures are retried for a few minutes, long enough for the Studio server to restart:
 * a lost event leaves a hole in the timeline, and a lost question leaves the agent waiting for an answer nobody sees.
 */
const EVENT_RETRY_MS = 4 * 60_000;
let eventChain = Promise.resolve();
function emit(type, data = {}) {
  eventChain = eventChain.then(async () => {
    const giveUpAt = Date.now() + EVENT_RETRY_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        await api('/events', { method: 'POST', body: JSON.stringify({ events: [{ type, data }] }) });
        return;
      } catch (error) {
        log('Event delivery failed', { type, attempt, error: String(error) });
        if (Date.now() >= giveUpAt) return;
        await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 1000, 10_000)));
      }
    }
  });
  return eventChain;
}

// ------------------------------------------------------------------ prompt stream

/** Async queue used as the SDK prompt: user messages are pushed whenever they arrive. */
function createPromptStream() {
  const pending = [];
  let wake = null;
  let closed = false;
  return {
    push(text) {
      pending.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (pending.length > 0) {
          yield pending.shift();
          continue;
        }
        if (closed) return;
        await new Promise((resolve) => (wake = resolve));
        wake = null;
      }
    },
  };
}

const prompt = createPromptStream();
let busy = false; // a turn is in progress
let pendingQuestion = null; // { resolve } while waiting for the user's answer
let lastActivity = Date.now();
let stopping = false;

function touch() {
  lastActivity = Date.now();
}

function formatAnswers(answers) {
  return ['Respostas às suas perguntas:', ...Object.entries(answers).map(([q, a]) => `- ${q}\n  ${a}`)].join('\n');
}

async function pollInbox() {
  while (!stopping) {
    try {
      const items = await api('/inbox?timeoutMs=20000');
      for (const item of items) {
        touch();
        if (item.kind === 'MESSAGE') {
          busy = true;
          prompt.push(item.payload.text);
        } else if (item.kind === 'ANSWER') {
          if (pendingQuestion) {
            pendingQuestion.resolve(item.payload.answers);
            pendingQuestion = null;
          } else {
            // The question was asked by a previous container: deliver the answer as a message.
            busy = true;
            prompt.push(formatAnswers(item.payload.answers));
          }
        }
      }
    } catch (error) {
      log('Inbox poll failed', { error: String(error) });
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log('Shutting down', { reason });
  prompt.close();
  // If the SDK is waiting on a question, unblock it so the process can end.
  pendingQuestion?.resolve(null);
  // The SDK can keep the process alive after that (seen on an idle pause while a question waited): the container then
  // stays up without reading the inbox, and the server never starts a new one for the answer. Exit no matter what.
  setTimeout(() => {
    log('Forced exit', { reason });
    process.exit(0);
  }, 30_000);
}

// Idle: no turn running (or only waiting for the user's answer) for too long.
setInterval(() => {
  if (!stopping && (!busy || pendingQuestion) && Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
    void emit('sleeping');
    shutdown('idle');
  }
}, 5000).unref();

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ------------------------------------------------------------------ Claude Code

/** Studio tools as the user reads them in the timeline. */
const STUDIO_TOOL_LABELS = {
  report_result: (input) => `Resultado: ${input.status} — ${input.summary ?? ''}`,
  board_list_tasks: (input) => `Quadro: listar tarefas${input.column ? ` em "${input.column}"` : ''}`,
  board_get_task: () => 'Quadro: ler tarefa',
  board_create_task: (input) => `Quadro: criar tarefa "${input.title ?? ''}"`,
  board_update_task: (input) => `Quadro: atualizar tarefa${input.column ? ` → "${input.column}"` : ''}`,
  board_comment_task: (input) => `Quadro: comentar (${input.kind})`,
  hom_service: () => 'Lendo o serviço de homologação',
  hom_set_env_vars: (input) => `Homologação: variáveis ${(input.vars ?? []).map((entry) => entry.key).join(', ')}`,
  hom_publish: () => 'Publicando em homologação (commit, merge e deploy)',
  hom_publish_status: () => 'Acompanhando a publicação em homologação',
  hom_logs: (input) => `Homologação: logs (${input.type ?? 'build'}${input.project ? `, ${input.project}` : ''})`,
  hom_environments: () => 'URLs de homologação',
  project_owners: () => 'Projetos: onde criar',
  project_create: (input) => `Projetos: criar "${input.name ?? ''}"`,
  project_use: (input) => `Projetos: usar "${input.name ?? ''}"`,
  quality_list: () => 'Qualidade: lendo o registro de defeitos',
  roadmap_get: () => 'Lendo o roadmap e o ritmo do projeto',
  roadmap_write: () => 'Gravando o roadmap',
  test_env_start: (input) => `Ambiente de teste: subir ${input.project ?? ''}`,
  test_env_status: () => 'Ambiente de teste: situação',
  test_env_stop: () => 'Ambiente de teste: derrubar',
  test_user_acquire: (input) => `Usuários de teste: reservar${input.kind ? ` (${input.kind})` : ''}`,
  test_user_release: (input) => `Usuários de teste: devolver ${input.prefix ?? 'todos'}`,
  test_user_list: () => 'Usuários de teste: quem está usando',
  quality_log: (input) => `Qualidade: registrar "${input.category ?? ''}" em ${input.task ?? ''}`,
  quality_update: (input) => `Qualidade: "${input.category ?? ''}" → ${input.status ?? ''}`,
  clickup_hierarchy: () => 'ClickUp: estrutura',
  clickup_list_tasks: (input) => `ClickUp: tarefas da lista ${input.listId ?? ''}${input.page ? ` (página ${input.page})` : ''}`,
  clickup_get_task: (input) => `ClickUp: tarefa ${input.taskId ?? ''}`,
  hom_metrics: (input) => `Homologação: memória e CPU${input.project ? ` de ${input.project}` : ''} (${input.minutes ?? 60} min)`,
  hom_events: (input) => `Homologação: eventos${input.project ? ` de ${input.project}` : ''}`,
  studio_context: () => 'Lendo o workspace',
  studio_list_runs: () => 'Lendo execuções de workflows',
  studio_list_executions: () => 'Lendo execuções de agentes',
  studio_get_execution: () => 'Lendo uma execução',
  studio_usage: () => 'Lendo o consumo',
  studio_board_options: () => 'Procurando quadros',
  studio_render_services: () => 'Lendo os serviços do Render',
  studio_aws_targets: () => 'Lendo as instâncias e apps da AWS',
  studio_propose: (input) => `Proposta: ${input.summary ?? input.kind ?? ''}`,
  studio_overview: () => 'Visão geral dos workspaces',
  studio_focus: (input) => `Foco em ${input.workspace ?? ''}`,
  studio_pending: () => 'Vendo o que está pendente',
  studio_agent: () => 'Lendo uma execução',
  studio_view_file: (input) => `Vendo ${String(input.path ?? input.url ?? '').split('/').pop()}`,
  studio_answer: (input) => `Respondendo um agente: ${(input.answers ?? []).join(' · ')}`,
  studio_message: () => 'Mensagem para um agente',
  studio_set_workflow: (input) => `Workflow: ${input.enabled === undefined ? '' : input.enabled ? 'ligar' : 'desligar'}${input.maxConcurrentRuns ? ` ${input.maxConcurrentRuns} ao mesmo tempo` : ''}`,
  studio_pause: (input) => `Pausando ${input.workspace ?? ''}`,
  studio_resume: (input) => `Retomando ${input.workspace ?? ''}`,
  studio_capacity: (input) => `Capacidade: ${input.decision === 'discard' ? 'descartar' : 'aplicar'}`,
  studio_conflict_back: () => 'Devolvendo um conflito ao agente',
  studio_flag: (input) => `Aviso para o usuário: ${input.summary ?? ''}`,
  studio_resources: () => 'Lendo os recursos do computador',
  studio_resolve_flag: () => 'Marcando a pendência como resolvida',
  studio_task_pull_request: (input) => `PR/MR da tarefa ${input.id ?? ''}`,
};

function summarizeTool(name, input = {}) {
  const studioLabel = STUDIO_TOOL_LABELS[name.replace(/^mcp__studio__/, '')];
  if (name.startsWith('mcp__studio__') && studioLabel) return studioLabel(input).slice(0, 300);
  const value =
    input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? input.query ?? '';
  return String(value).slice(0, 300);
}

async function canUseTool(toolName, input) {
  if (toolName !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };

  await emit('question', { questions: input.questions });
  const answers = await new Promise((resolve) => (pendingQuestion = { resolve }));
  touch();
  if (!answers) return { behavior: 'deny', message: 'O usuário ainda não respondeu; a sessão foi pausada.', interrupt: true };
  return { behavior: 'allow', updatedInput: { ...input, answers } };
}

function pickUsage(modelUsage = {}) {
  const models = {};
  for (const [model, usage] of Object.entries(modelUsage)) {
    models[model] = {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
      costUSD: usage.costUSD ?? 0,
    };
  }
  return models;
}

async function main() {
  log('Runner started', { model: MODEL, resume: Boolean(RESUME_SESSION_ID) });
  void pollInbox();
  startBrowserView(api, log);

  const studio = createStudioTools(
    (name, args) => api(`/tools/${name}`, { method: 'POST', body: JSON.stringify(args ?? {}) }),
    STUDIO_TOOLS,
  );

  const session = query({
    prompt,
    options: {
      cwd: WORKDIR,
      model: MODEL,
      resume: RESUME_SESSION_ID,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      canUseTool,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_PROMPT_APPEND },
      mcpServers: {
        ...(studio && { studio }),
        ...(PIXELLAB_TOKEN && { pixellab: { type: 'http', url: PIXELLAB_MCP_URL, headers: { Authorization: `Bearer ${PIXELLAB_TOKEN}` } } }),
      },
    },
  });

  for await (const message of session) {
    touch();
    if (message.type === 'system' && message.subtype === 'init') {
      await emit('session', { sessionId: message.session_id });
    } else if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text.trim()) await emit('assistant_text', { text: block.text });
        // Questions are reported by canUseTool; tool discovery is noise for the user.
        if (block.type === 'tool_use' && !['AskUserQuestion', 'ToolSearch'].includes(block.name)) {
          await emit('tool_use', { name: block.name, summary: summarizeTool(block.name, block.input) });
        }
      }
    } else if (message.type === 'rate_limit_event') {
      // Plan limits (5-hour and weekly windows) for the usage dashboard.
      await emit('rate_limit', message.rate_limit_info ?? {});
    } else if (message.type === 'result') {
      busy = false;
      // Running totals per model for the session; the server turns them into per-turn usage.
      await emit('usage', { models: pickUsage(message.modelUsage) });
      // A turn cut short by our own shutdown (idle pause) is not an error for the user.
      if (stopping) continue;
      await emit('turn_end', {
        isError: Boolean(message.is_error),
        text: String(message.result ?? '').slice(0, 2000),
        durationMs: message.duration_ms,
      });
    }
  }

  await eventChain;
  log('Session ended');
  process.exit(0);
}

main().catch(async (error) => {
  log(stopping ? 'Session interrupted by shutdown' : 'Runner crashed', { error: String(error?.stack ?? error) });
  await eventChain;
  // During a requested shutdown the SDK may throw while unwinding; that is a clean stop.
  process.exit(stopping ? 0 : 1);
});
