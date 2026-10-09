import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { config } from '../../config.js';
import { createContainer, removeContainer, startContainer, stopContainer } from '../../lib/docker.js';
import { ORBI_GUIDE } from '../assistant/guide.js';
import { workdirHostPath } from './workdir.js';

export const AGENT_LABEL = 'agents-manager-studio.agent-id';

export function agentVolumeName(agentId: string) {
  return `ams-agent-${agentId}`;
}

export function hashSecret(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}

export interface RuntimeAgent {
  id: string;
  kind: 'TASK' | 'ASSISTANT';
  model: string;
  workdir: string;
  branch: string;
  baseBranch: string;
  sessionId: string | null;
  projectId: string | null;
  output: 'PULL_REQUEST' | 'RESULT';
  autoConclude: boolean;
  instructions: string;
  tools: string[];
}

/** Studio tools the runner exposes: the enabled groups, plus result reporting for agents that deliver a result. */
export function runnerTools(agent: Pick<RuntimeAgent, 'tools' | 'output'>) {
  return [...new Set([...agent.tools, ...(agent.output === 'RESULT' ? ['result'] : [])])];
}

function systemPromptAppend(agent: RuntimeAgent) {
  // Órbi has its own guide (always the current version, also for resumed conversations).
  if (agent.kind === 'ASSISTANT') return ORBI_GUIDE;
  const tools = runnerTools(agent);
  const lines = ['Você é um agente gerenciado pelo Agents Manager Studio.'];

  if (agent.projectId) {
    lines.push(`- Você trabalha em /workspace, uma cópia isolada do projeto na branch "${agent.branch}", criada a partir de "${agent.baseBranch}".`);
    lines.push('- NÃO faça commit, push, nem crie ou troque de branch.');
  } else {
    lines.push('- Você não trabalha em um repositório: /workspace é uma pasta de trabalho temporária.');
  }

  if (agent.output === 'RESULT') {
    lines.push('- Sua entrega não é código. Ao terminar, chame a ferramenta studio_report_result com o status (success ou failure) e um resumo claro do resultado.');
  } else if (agent.autoConclude) {
    lines.push('- Quando você terminar, o Studio faz o commit e abre o PR/MR automaticamente com as suas alterações.');
  } else {
    lines.push('- O usuário revisa o diff no Studio e conclui por lá.');
  }

  if (tools.includes('board')) {
    lines.push('- Use as ferramentas studio_board_* para consultar, criar e atualizar tarefas no quadro de tarefas do workspace.');
  }
  lines.push(
    '- O ambiente tem Node.js 24, Python 3 (pip e venv) e git, sem sudo. Instale dependências no projeto (npm install, ou python -m venv .venv) e rode os testes antes de terminar. Não versione a pasta .venv.',
    '- Quando precisar de uma decisão do usuário, use a ferramenta AskUserQuestion em vez de supor.',
    '- Ao terminar, resuma o que foi feito.',
    '- Responda em português.',
  );
  if (agent.instructions.trim()) lines.push('', 'Seu papel neste workspace:', agent.instructions.trim());
  return lines.join('\n');
}

/** Each enabled skill is mounted read-only under ~/.claude/skills; names are made unique. */
function skillBinds(skillIds: string[]) {
  const used = new Set<string>();
  return skillIds.map((id) => {
    let name = path.posix.basename(id);
    while (used.has(name)) name = `${name}-${used.size}`;
    used.add(name);
    return `${config.skillsHostDir}/${id}:/home/node/.claude/skills/${name}:ro`;
  });
}

export interface StartAgentInput {
  agent: RuntimeAgent;
  claudeToken: string;
  skillIds: string[];
  /** Extra variables, e.g. the URLs of the throwaway test database and Redis. */
  env?: Record<string, string>;
}

/** Starts the runner container; the returned secret hash authenticates its calls to the server. */
export async function startAgentContainer({ agent, claudeToken, skillIds, env = {} }: StartAgentInput) {
  const secret = randomBytes(24).toString('base64url');
  const shortId = agent.id.slice(-8);

  const containerId = await createContainer({
    image: config.agentRunnerImage,
    name: `ams-agent-${shortId}-${Date.now().toString(36)}`,
    cmd: ['node', '/opt/runner/src/runner.mjs'],
    network: config.agentNetwork,
    labels: { [AGENT_LABEL]: agent.id },
    binds: [
      `${workdirHostPath(agent.workdir)}:/workspace`,
      `${agentVolumeName(agent.id)}:/home/node/.claude`,
      ...skillBinds(skillIds),
    ],
    env: {
      AGENT_ID: agent.id,
      AGENT_SECRET: secret,
      SERVER_URL: config.serverInternalUrl,
      MODEL: agent.model,
      IDLE_TIMEOUT_MS: String(config.agentIdleTimeoutMs),
      SYSTEM_PROMPT_APPEND: systemPromptAppend(agent),
      STUDIO_TOOLS: runnerTools(agent).join(','),
      CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
      ...(agent.sessionId && { RESUME_SESSION_ID: agent.sessionId }),
      ...env,
    },
  });

  try {
    await startContainer(containerId);
  } catch (error) {
    await removeContainer(containerId).catch(() => undefined);
    throw error;
  }
  return { containerId, secretHash: hashSecret(secret) };
}

export async function stopAgentContainer(containerId: string) {
  await stopContainer(containerId, 15);
  await removeContainer(containerId);
}
