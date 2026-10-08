// Phase 3 spike: proves the agent loop we need, inside the container.
//  1. AskUserQuestion is intercepted and answered by the host.
//  2. A follow-up message after a finished turn continues the same session.
//  3. A message sent while the agent is working is picked up.
//  4. (mode "resume") a new process resumes the session from the persisted ~/.claude.
// Usage: node spike.mjs run | node spike.mjs resume <sessionId>
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';

const WORKDIR = '/home/node/.claude/spike-repo';
const MODEL = 'haiku';

const log = (event, data = {}) => console.log(JSON.stringify({ t: new Date().toISOString().slice(11, 19), event, ...data }));

/** Async queue used as the streaming prompt: the host pushes user messages whenever it wants. */
function createInbox() {
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
        if (pending.length) {
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

const canUseTool = async (toolName, input) => {
  if (toolName === 'AskUserQuestion') {
    log('question', { questions: input.questions.map((q) => ({ q: q.question, options: q.options.map((o) => o.label) })) });
    await new Promise((resolve) => setTimeout(resolve, 2000)); // simulates the user thinking
    const answers = Object.fromEntries(input.questions.map((q) => [q.question, q.options[0].label]));
    log('answer', { answers });
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  }
  log('permission-request', { toolName });
  return { behavior: 'allow', updatedInput: input };
};

function describe(message) {
  if (message.type === 'system' && message.subtype === 'init') {
    return { event: 'init', session: message.session_id, model: message.model, permissionMode: message.permissionMode };
  }
  if (message.type === 'assistant') {
    const parts = message.message.content.map((c) =>
      c.type === 'text' ? `text: ${c.text.slice(0, 120)}` : c.type === 'tool_use' ? `tool: ${c.name}` : c.type,
    );
    return { event: 'assistant', parts };
  }
  if (message.type === 'result') {
    return { event: 'result', subtype: message.subtype, isError: message.is_error, turns: message.num_turns, text: message.result?.slice(0, 160) };
  }
  return null;
}

async function run() {
  mkdirSync(WORKDIR, { recursive: true });
  execSync('git init -q && git config user.email spike@local && git config user.name spike', { cwd: WORKDIR });

  const inbox = createInbox();
  inbox.push(
    'Use a ferramenta AskUserQuestion para me perguntar qual linguagem usar, com as opções "Python" e "JavaScript". ' +
      'Depois crie um único arquivo hello na linguagem escolhida que imprime "oi". Não faça mais nada.',
  );

  const session = query({
    prompt: inbox,
    options: {
      cwd: WORKDIR,
      model: MODEL,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      canUseTool,
    },
  });

  let results = 0;
  let sessionId;
  for await (const message of session) {
    if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id;
    const info = describe(message);
    if (info) log(info.event, info);

    if (message.type === 'result') {
      results++;
      if (results === 1) {
        log('files', { files: readdirSync(WORKDIR).filter((f) => f !== '.git') });
        log('host', { action: 'follow-up after finished turn' });
        inbox.push('Agora adicione na primeira linha desse arquivo um comentário com a palavra SPIKE.');
      } else if (results === 2) {
        log('host', { action: 'new task + mid-turn message in 4s' });
        inbox.push('Crie um arquivo notes.txt com a lista de 3 frutas, uma por linha.');
        setTimeout(() => {
          log('host', { action: 'mid-turn message sent' });
          inbox.push('Correção: em vez de frutas, use 3 cores.');
        }, 4000);
      } else if (results >= 3) {
        // The mid-turn message may produce one extra turn; stop after it settles.
        setTimeout(() => inbox.close(), 1000);
      }
    }
  }

  const files = readdirSync(WORKDIR).filter((f) => f !== '.git');
  log('final-files', Object.fromEntries(files.map((f) => [f, readFileSync(`${WORKDIR}/${f}`, 'utf8').slice(0, 200)])));
  log('done', { sessionId });
}

async function resume(sessionId) {
  const session = query({
    prompt: 'Sem usar ferramentas: quais arquivos você criou nesta conversa e que palavra colocou no comentário?',
    options: { cwd: WORKDIR, model: MODEL, resume: sessionId, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true },
  });
  for await (const message of session) {
    const info = describe(message);
    if (info) log(info.event, info);
  }
}

/** A message pushed while the agent is busy (running a slow command) must change its course. */
async function midTurn() {
  mkdirSync(WORKDIR, { recursive: true });
  const inbox = createInbox();
  inbox.push('Rode o comando `sleep 8` no terminal e, só depois que ele terminar, crie o arquivo items.txt com 3 frutas, uma por linha.');
  setTimeout(() => {
    log('host', { action: 'mid-turn correction sent' });
    inbox.push('Correção: no items.txt use 3 cores em vez de frutas.');
  }, 4000);
  setTimeout(() => inbox.close(), 60_000);

  const session = query({
    prompt: inbox,
    options: { cwd: WORKDIR, model: MODEL, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true },
  });
  let results = 0;
  for await (const message of session) {
    const info = describe(message);
    if (info) log(info.event, info);
    if (message.type === 'result' && ++results >= 1) {
      // Give a queued message the chance to start another turn before closing.
      setTimeout(() => inbox.close(), 5000);
    }
  }
  log('items.txt', { content: readFileSync(`${WORKDIR}/items.txt`, 'utf8') });
}

const [mode, arg] = process.argv.slice(2);
if (mode === 'resume') await resume(arg);
else if (mode === 'midturn') await midTurn();
else await run();
