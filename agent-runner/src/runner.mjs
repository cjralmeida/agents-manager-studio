// Agent runner: drives Claude Code (Agent SDK) inside the agent container and talks to the Studio server.
// - Pulls user messages and answers from the server inbox (long-poll).
// - Streams progress (text, tool calls, questions, turn ends) back as events.
// - Exits with code 0 after IDLE_TIMEOUT_MS without work; the server resumes the session later.
import { query } from '@anthropic-ai/claude-agent-sdk';

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

/** Events are sent in order; failures are retried a few times so the timeline does not get holes. */
let eventChain = Promise.resolve();
function emit(type, data = {}) {
  eventChain = eventChain.then(async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await api('/events', { method: 'POST', body: JSON.stringify({ events: [{ type, data }] }) });
        return;
      } catch (error) {
        log('Event delivery failed', { type, attempt, error: String(error) });
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
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

function summarizeTool(name, input = {}) {
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

async function main() {
  log('Runner started', { model: MODEL, resume: Boolean(RESUME_SESSION_ID) });
  void pollInbox();

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
    } else if (message.type === 'result') {
      busy = false;
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
